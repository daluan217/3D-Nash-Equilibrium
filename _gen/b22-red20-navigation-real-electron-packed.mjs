// RED-DESKTOP-20 angle 3: navigation-family probes against the REAL packaged
// Electron main process (not the electron-window-guard-runner.cjs STUB round
// 19's own unit test uses -- that stub only proves the CODE calls
// setWindowOpenHandler/on('will-navigate'), never that the real Chromium
// event actually fires and is actually intercepted for each trigger shape).
//
// Uses Playwright's `_electron` launcher against electron-main.cjs itself,
// with a throwaway --user-data-dir so nothing touches Daniel's real app data.
import { _electron as electron } from 'playwright';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WT = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22';

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nash-d20-electron-udd-'));
  // The PACKAGED binary, not node_modules/electron: this file's name says
  // "packed" and the dev Electron is unrunnable here anyway (iCloud mangles its
  // signature -> macOS SIGKILLs it, which read as "Process failed to launch").
  // cwd /tmp is the shipping condition: dotenv must not find the repo's .env.
  const app = await electron.launch({
    executablePath: join(WT, 'dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator'),
    args: [`--user-data-dir=${userDataDir}`],
    cwd: '/tmp',
    env: { IS_ELECTRON: 'true', NODE_ENV: 'production', PATH: process.env.PATH, HOME: process.env.HOME },
  });

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(2500); // let the app finish mounting (report/plot init)
  console.log('window URL:', win.url());

  const results = {};

  // --- 1. same-window <a href> click ---
  await win.evaluate(() => {
    const a = document.createElement('a');
    a.id = 'red20-test-link';
    a.href = 'https://example.com/red20-navtest-a-href';
    a.textContent = 'red20 test link';
    document.body.appendChild(a);
  });
  // A real DOM click, not win.click(): a refused navigation leaves the page
  // permanently "navigating", so Playwright's actionability wait times out
  // BEFORE dispatching. This still delivers a trusted-path click to the <a>;
  // the assertion is win.url() below.
  await win.evaluate(() => document.getElementById('red20-test-link').click());
  await win.waitForTimeout(800);
  results.aHrefClick = { urlAfter: win.url() };
  console.log('1. <a href> click -> window URL after:', win.url());

  // --- 2. location.href assignment ---
  await win.evaluate(() => { try { window.location.href = 'https://example.com/red20-navtest-location-href'; } catch (e) { window.__navErr = String(e); } });
  await win.waitForTimeout(800);
  results.locationHref = { urlAfter: win.url() };
  console.log('2. location.href= -> window URL after:', win.url());

  // --- 3. meta refresh ---
  await win.evaluate(() => {
    const m = document.createElement('meta');
    m.httpEquiv = 'refresh';
    m.content = '0;url=https://example.com/red20-navtest-metarefresh';
    document.head.appendChild(m);
  });
  await win.waitForTimeout(1200);
  results.metaRefresh = { urlAfter: win.url() };
  console.log('3. meta refresh -> window URL after:', win.url());

  // --- 4. form GET submission (top-level navigation) ---
  await win.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'GET';
    f.action = 'https://example.com/red20-navtest-form-get';
    f.id = 'red20-test-form';
    document.body.appendChild(f);
  });
  await win.evaluate(() => document.getElementById('red20-test-form').submit());
  await win.waitForTimeout(800);
  results.formGet = { urlAfter: win.url() };
  console.log('4. form GET submit -> window URL after:', win.url());

  // --- 5. target=_blank window.open (should be denied entirely -- count new windows) ---
  const winCountBefore = app.windows().length;
  const openResult = await win.evaluate(() => {
    const w = window.open('https://example.com/red20-navtest-blank', '_blank');
    return { returned: w === null ? 'null' : typeof w };
  });
  await win.waitForTimeout(800);
  const winCountAfter = app.windows().length;
  results.windowOpenBlank = { openResult, winCountBefore, winCountAfter };
  console.log('5. window.open(_blank) ->', JSON.stringify(openResult), `windows: ${winCountBefore} -> ${winCountAfter}`);

  // --- 6. about:blank popup + document.write (classic opener bypass) ---
  const aboutBlankResult = await win.evaluate(() => {
    const w = window.open('about:blank');
    if (w) {
      try {
        w.document.write('<script>location.href="https://example.com/red20-navtest-aboutblank-write"</script>');
        return { opened: true };
      } catch (e) { return { opened: true, writeErr: String(e) }; }
    }
    return { opened: false };
  });
  await win.waitForTimeout(800);
  const winCountAfterAboutBlank = app.windows().length;
  results.aboutBlankPopup = { aboutBlankResult, winCountAfterAboutBlank };
  console.log('6. about:blank popup ->', JSON.stringify(aboutBlankResult), `windows now: ${winCountAfterAboutBlank}`);

  // --- 7. srcdoc iframe with a nested link, click it ---
  await win.evaluate(() => {
    const ifr = document.createElement('iframe');
    ifr.id = 'red20-test-iframe';
    ifr.srcdoc = '<a id="inner" href="https://example.com/red20-navtest-srcdoc">inner link</a>';
    document.body.appendChild(ifr);
  });
  await win.waitForTimeout(500);
  const frame = win.frames().find((f) => f.url().startsWith('about:srcdoc') || f.name() === '');
  let srcdocClickResult = 'no-frame-found';
  try {
    const iframeEl = await win.$('#red20-test-iframe');
    const cframe = await iframeEl.contentFrame();
    if (cframe) {
      await cframe.evaluate(() => document.getElementById('inner').click()); // see note at vector 1
      srcdocClickResult = 'clicked';
    }
  } catch (e) { srcdocClickResult = `error: ${e.message}`; }
  await win.waitForTimeout(800);
  results.srcdocIframeLink = { srcdocClickResult, urlAfter: win.url() };
  console.log('7. srcdoc iframe link click ->', srcdocClickResult, '| main window URL after:', win.url());

  // --- 8. mailto: link click ---
  await win.evaluate(() => {
    const a = document.createElement('a');
    a.id = 'red20-test-mailto';
    a.href = 'mailto:test@example.com';
    a.textContent = 'mailto test';
    document.body.appendChild(a);
  });
  await win.evaluate(() => document.getElementById('red20-test-mailto').click()); // see note at vector 1
  await win.waitForTimeout(800);
  results.mailtoClick = { urlAfter: win.url() };
  console.log('8. mailto: click -> window URL after:', win.url());

  console.log('FULL RESULTS', JSON.stringify(results, null, 2));
  await app.close();
  process.exit(0);
}

main().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });

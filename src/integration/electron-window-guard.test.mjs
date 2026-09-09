/* INTEGRATION — RED-DESKTOP-5/002: no stray blank window during a desktop
 * lock-failure dialog.
 *
 * THE DEFECT: electron-main.cjs's 800ms "slow boot sequence" fallback (and
 * `app.on('activate')`) called `createWindow()` whenever `mainWindow` was
 * still null, with no awareness that a desktop-lock failure was in progress.
 * server.ts's lock-failure path deliberately never binds a port, so that
 * extra window loaded Chromium's own chrome-error://chromewebdata/ — a
 * stray, blank, broken-looking window appearing RIGHT ALONGSIDE the correct
 * native "Startup Blocked" dialog (round4's #88 fix, still correct). This is
 * a regression risk introduced BY #88: keeping the process alive for the
 * dialog is what gives this timer room to fire at all.
 *
 * THE FIX: `global.onDesktopLockFailure` now cancels the fallback timer
 * outright (`clearTimeout`) the moment it is known the server will never
 * bind a port, plus a `lockFailurePending` guard on `app.on('activate')`
 * (no timer to cancel there — a dock-icon click can happen at any time).
 *
 * Runs via src/desktop/electron-window-guard-runner.cjs, a separate process
 * per scenario (fresh top-level execution each time — Node's require cache
 * would otherwise skip electron-main.cjs's side effects on a second
 * in-process require) with `electron` totally stubbed (same style as
 * src/desktop/require-probe.cjs) except for the few calls this test reads:
 * `app.on(event, cb)` capture, `new BrowserWindow()` counting, and
 * `dialog.showMessageBox` (never resolves within the test, matching a real
 * modal dialog staying open).
 *
 *   node src/integration/electron-window-guard.test.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const MAIN_CJS = path.join(serverDir, 'electron-main.cjs');
const RUNNER = path.join(serverDir, 'src/desktop/electron-window-guard-runner.cjs');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function run(mode) {
  const r = spawnSync('node', [RUNNER, MAIN_CJS, mode], { encoding: 'utf8', timeout: 10_000 });
  const m = (r.stdout || '').match(/RUNNER_RESULT (\{.*\})/);
  return { raw: r, parsed: m ? JSON.parse(m[1]) : null };
}

// ══ 1. THE DEFECT FIXTURE: a lock failure, then 'ready' fires (server never
//      started), then past the 800ms fallback window, then 'activate' fires
//      too (a dock-icon click while the dialog is still up). ZERO windows
//      may ever be created — the dialog is the only UI a user should see.
{
  const { raw, parsed } = run('lockfail');
  record('runner completed cleanly', raw.status === 0, `status=${raw.status} stderr=${(raw.stderr || '').slice(0, 300)}`);
  record('the lock-failure dialog was shown', parsed?.dialogShown === 1, `dialogShown=${parsed?.dialogShown}`);
  record('THE DEFECT FIXTURE: no window is ever created after a lock failure (800ms fallback + activate both suppressed)',
    parsed?.windowCount === 0, `windowCount=${parsed?.windowCount}`);
}

// ══ 2. CONTROL: a genuine slow boot with NO lock failure must still show a
//      window after 800ms — the fix must not disable the fallback it was
//      built for, only gate it on a lock failure actually being in progress.
{
  const { raw, parsed } = run('slowboot-normal');
  record('runner completed cleanly (control)', raw.status === 0, `status=${raw.status} stderr=${(raw.stderr || '').slice(0, 300)}`);
  record('CONTROL: no dialog shown (no lock failure occurred)', parsed?.dialogShown === 0, `dialogShown=${parsed?.dialogShown}`);
  record('CONTROL: a genuine slow boot still opens exactly one window after 800ms (fallback still works)',
    parsed?.windowCount === 1, `windowCount=${parsed?.windowCount}`);
}

// ══ 3. DATA CONFLICT: this uses the same no-window startup-blocked path as
//      a lock, but must not tell a person to inspect/delete a lock. The
//      recovery wording is deliberately backup-first and says the app has
//      not selected or merged either valid database.
{
  const { raw, parsed } = run('data-conflict');
  const detail = parsed?.dialogOptions?.detail || '';
  record('data-conflict runner completed cleanly', raw.status === 0,
    `status=${raw.status} stderr=${(raw.stderr || '').slice(0, 300)}`);
  record('DATA CONFLICT: the startup-blocked dialog is shown without creating a window',
    parsed?.dialogShown === 1 && parsed?.windowCount === 0,
    `dialogShown=${parsed?.dialogShown} windowCount=${parsed?.windowCount}`);
  record('DATA CONFLICT: the dialog tells the user to back up both databases before recovery',
    /Back up both database files before resolving the conflict/.test(detail), detail);
  record('DATA CONFLICT: the dialog promises no automatic choice, merge, rename, or deletion',
    /will not choose, merge, rename, or delete either copy/.test(detail), detail);
}

// ══ 4. DATA CONFLICT, SINGLE CANDIDATE: a conflict copy can exist with no
//      primary db.json yet (it synced in before this machine created its
//      own). The wording must never claim "both files" when only one is on
//      disk — CodeRabbit finding on PR #113's first draft.
{
  const { raw, parsed } = run('data-conflict-single');
  const detail = parsed?.dialogOptions?.detail || '';
  record('data-conflict-single runner completed cleanly', raw.status === 0,
    `status=${raw.status} stderr=${(raw.stderr || '').slice(0, 300)}`);
  record('DATA CONFLICT SINGLE: the startup-blocked dialog is shown without creating a window',
    parsed?.dialogShown === 1 && parsed?.windowCount === 0,
    `dialogShown=${parsed?.dialogShown} windowCount=${parsed?.windowCount}`);
  record('DATA CONFLICT SINGLE: the dialog never says "both" or "either" when only one file exists',
    !/\bboth\b/i.test(detail) && !/\beither\b/i.test(detail), detail);
  record('DATA CONFLICT SINGLE: the dialog still promises no automatic choice, merge, rename, or deletion',
    /will not choose, merge, rename, or delete it/.test(detail), detail);
}

// ══ 4. WHERE THE RENDERER MAY SEND THIS APP (STRUCT-DESKTOP-19).
//      Two doors, one policy. `setWindowOpenHandler` sees only window.open /
//      target="_blank"; a plain <a href> or location.href navigates THE MAIN
//      WINDOW, which runs with titleBarStyle 'hidden' — no titlebar, no URL bar,
//      so a remote origin would render full-bleed next to the app's own login
//      form. `shell.openExternal` is the other end: it launches the default
//      handler for whatever it is given (`file://` opens Finder, `smb://` reaches
//      a network share, macOS resolves any registered custom scheme).
//      Reachability today: the only href in src/ is DownloadModal.tsx:87's
//      same-origin `/api/download/dmg`, so this is a hole with no instance rather
//      than a found defect — but two of the three dangerouslySetInnerHTML sites
//      render preset descriptions, and the day a link appears in one the renderer
//      chooses both the scheme and the destination.
//      These probes EXECUTE the real handlers; nothing here is a source scan.
//      Mutations that fail it: (a) delete the will-navigate registration — the
//      five "never navigates this window" checks fail; (b) call
//      shell.openExternal(url) directly in either handler — the hostile probes
//      report opened=true; (c) put http: back in EXTERNAL_URL_SCHEMES — the
//      loopback-port checks and the by-value openedUrls check fail.
{
  const { raw, parsed } = run('openexternal');
  record('runner completed cleanly (openexternal)', raw.status === 0, `status=${raw.status} stderr=${(raw.stderr || '').slice(0, 300)}`);
  record('the window-open handler is installed at all', parsed?.handlerInstalled === true, `handlerInstalled=${parsed?.handlerInstalled}`);
  record('a will-navigate handler is installed on the main window',
    parsed?.navHandlerCount === 1, `navHandlerCount=${parsed?.navHandlerCount}`);
  record('a will-frame-navigate handler is installed too (an iframe is the same door)',
    parsed?.frameNavHandlerCount === 1, `frameNavHandlerCount=${parsed?.frameNavHandlerCount}`);

  // ── door 1: window.open / target="_blank"
  const by = Object.fromEntries((parsed?.probes ?? []).map((x) => [x.url, x]));
  const hostile = [
    'file:///etc/passwd',
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    'smb://attacker.example/share',
    'vscode://file/etc/passwd',
    'not a url at all',
  ];
  for (const url of hostile) {
    record(`a renderer-supplied ${url.split(':')[0]} URL never reaches the operating system`,
      by[url]?.opened === false, JSON.stringify(by[url]));
  }
  record('an http URL is not handed to the OS either (the policy is https-only)',
    by['http://127.0.0.1:9/health']?.opened === false, JSON.stringify(by['http://127.0.0.1:9/health']));
  record('every window.open request is denied in-app — it never becomes a second app window',
    (parsed?.probes ?? []).length === 9 && (parsed?.probes ?? []).every((x) => x.action === 'deny'),
    JSON.stringify((parsed?.probes ?? []).map((x) => x.action)));
  // CONTROL: two different https origins must still open, or this guard would
  // pass just as well on a build that opens nothing at all.
  record('CONTROL: the app\'s own https download link still opens externally',
    by['https://nash-equilibrium-simulator.com/api/download/dmg']?.opened === true,
    JSON.stringify(by['https://nash-equilibrium-simulator.com/api/download/dmg']));
  record('CONTROL: a second, unrelated https origin still opens externally',
    by['https://mathematics-magazine.example/paper']?.opened === true,
    JSON.stringify(by['https://mathematics-magazine.example/paper']));

  // ── door 2: same-window navigation (<a href>, location.href)
  const nav = Object.fromEntries((parsed?.navigation ?? []).map((x) => [x.url, x]));
  const sameOrigin = `${parsed?.loadedUrl}/library`;
  record('CONTROL: a same-origin navigation is NOT prevented (the app still works)',
    nav[sameOrigin]?.prevented === false && nav[sameOrigin]?.opened === false, JSON.stringify(nav[sameOrigin]));
  const offOrigin = [
    ['https://attacker.example/phish', true],
    ['http://127.0.0.1:9/not-this-app', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(document.domain)', false],
    ['not a url at all', false],
  ];
  for (const [url, opensExternally] of offOrigin) {
    record(`a same-window navigation to ${url.slice(0, 34)} never moves this window off the app`,
      nav[url]?.prevented === true, JSON.stringify(nav[url]));
    record(`… and it ${opensExternally ? 'goes to the default browser instead' : 'is not handed to the OS at all'}`,
      nav[url]?.opened === opensExternally, JSON.stringify(nav[url]));
  }

  // ── door 2b: the same navigation inside a frame, in both of Electron's
  //     argument shapes. Electron 31 (this app's) passes ONE Event carrying
  //     `url`; a handler written for (event, details) alone throws here, which
  //     would leave the frame navigation UNprevented.
  const frameBy = Object.fromEntries((parsed?.frameNavigation ?? []).map((x) => [`${x.shape}:${x.url}`, x]));
  for (const shape of ['one-arg', 'two-arg']) {
    record(`CONTROL: a same-origin frame navigation is not prevented (${shape} listener shape)`,
      frameBy[`${shape}:${parsed?.loadedUrl}/embedded`]?.prevented === false
      && !frameBy[`${shape}:${parsed?.loadedUrl}/embedded`]?.threw,
      JSON.stringify(frameBy[`${shape}:${parsed?.loadedUrl}/embedded`]));
    record(`a frame navigation to file:///etc/passwd is prevented and not handed to the OS (${shape} listener shape)`,
      frameBy[`${shape}:file:///etc/passwd`]?.prevented === true
      && frameBy[`${shape}:file:///etc/passwd`]?.opened === false,
      JSON.stringify(frameBy[`${shape}:file:///etc/passwd`]));
  }

  // ── the family, not the instance
  record('every webContents Electron creates gets the same policy (web-contents-created is hooked)',
    parsed?.webContentsCreatedHooked === true && parsed?.createdContentsGuards?.openHandler === true
    && parsed?.createdContentsGuards?.willNavigate === 1 && parsed?.createdContentsGuards?.willFrameNavigate === 1,
    JSON.stringify(parsed?.createdContentsGuards));
  record('hardening the same contents twice does not register the guard twice (one navigation, one action)',
    parsed?.mainNavHandlersAfterRehardening === 1, `count=${parsed?.mainNavHandlersAfterRehardening}`);

  // By value, not by count: names every URL this app asked the OS to open.
  record('exactly these three URLs reached shell.openExternal, in this order',
    JSON.stringify(parsed?.openedUrls) === JSON.stringify([
      'https://nash-equilibrium-simulator.com/api/download/dmg',
      'https://mathematics-magazine.example/paper',
      'https://attacker.example/phish',
    ]), JSON.stringify(parsed?.openedUrls));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

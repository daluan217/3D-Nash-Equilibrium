/* End-to-end smoke suite — the top of the testing pyramid.
 *
 * Runs against the ACTUAL production artifact (dist/ + dist/server.cjs) on a
 * local port, with no LLM keys and no SMTP: the report route takes its
 * documented no-key deterministic path. Every check below guards a defect
 * class that has actually reached a user (each is tagged with where it
 * happened). Run by CI (.github/workflows/test.yml, job `e2e`) and locally:
 *
 *   E2E_BASE=http://localhost:3099 node src/e2e/smoke.mjs
 *
 * Exit 0 only if every check passes and the browser logged no console errors.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = process.env.E2E_PORT || process.env.PORT || '3099';
const BASE = process.env.E2E_BASE || `http://localhost:${PORT}`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── boot the production server (unless one is already listening) ────────────
let server = null;
const userData = mkdtempSync(path.join(tmpdir(), 'nash-e2e-'));
// Kill AND await the child's exit: process.exit() right after kill() lets a
// retry invocation (CI runs `smoke.mjs || smoke.mjs`) race the dying server
// for the port — waitReady would then see the OLD server still listening.
async function killServer() {
  if (!server) return;
  if (server.exitCode !== null || server.signalCode !== null) return; // already exited
  const exited = new Promise((res) => server.once('exit', res));
  if (!server.kill('SIGKILL')) return; // couldn't signal (already dead / EPERM)
  await exited; // SIGKILL cannot be ignored
}
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
if (!(await waitReady())) {
  // cwd = the temp dir, deliberately: dotenv reads .env from the server's cwd,
  // and this suite must exercise the UNKEYED path even on a dev machine whose
  // repo root has real credentials in .env. The server still serves dist/ —
  // with ELECTRON_USER_DATA_PATH set it resolves the bundle from __dirname.
  const serverDir = path.resolve(import.meta.dirname, '../..');
  server = spawn('node', [path.join(serverDir, 'dist/server.cjs')], {
    cwd: userData,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT,
      ELECTRON_USER_DATA_PATH: userData, // auto-verify signups, keeps db.json out of the repo
      // deliberately NO LLM keys / SMTP / GCS: the report route must take its
      // deterministic no-key path, which is exactly what CI exercises
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  if (!(await waitReady())) {
    console.error('FAIL server never became ready');
    await killServer();
    process.exit(2);
  }
}

// CI resilience: GitHub's 2-core runners render WebGL through SwiftShader, so
// the whole app runs many times slower than locally — a healthy click can
// measure 4s and a busy frame can stall one for 30s+. All waits below are
// poll-based or generously bounded; the defect classes this suite guards
// ("never responds", "never converges", "wrong text") fail ANY bound.
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(120000);
page.setDefaultNavigationTimeout(120000);
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message.slice(0, 200)));

const $ = {
  run: page.getByRole('button', { name: /^Run$/ }),
  step: page.getByRole('button', { name: /^Step$/ }),
  reset: page.getByRole('button', { name: /^Reset$/ }),
  moverB: page.getByRole('button', { name: 'Player B' }).first(),
  shrink: page.getByRole('button', { name: 'Domain Shrink' }).first(),
  regret: page.getByRole('button', { name: 'Opponent Regret' }).first(),
  matrix: page.locator('input[inputmode="decimal"][class*="text-center"]'),
  stepSize: page.locator('xpath=//span[contains(text(),"Initial Domain Shrink Step Size")]/following-sibling::input[1]'),
  x0: page.locator('xpath=//label[contains(text(),"Row Start Point")]/following-sibling::div//input'),
  logLines: page.locator('div.overflow-y-auto.font-mono p'),
};
async function setSpeed(v) {
  return page.evaluate((val) => {
    const el = [...document.querySelectorAll('input[type="range"]')].find((e) => e.min === '1');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  }, v);
}
const startLine = () => page.evaluate(() =>
  [...document.querySelectorAll('p')].map((p) => (p.textContent || '').trim()).find((t) => /^Start \(/.test(t)) || '');
void startLine;
/* Wait for the gl3d scene to be live rather than sleeping a fixed amount.
 * A fixed sleep is both too short when CI's SwiftShader renderer stalls and
 * wasted time when it does not, and the host <div> exists long before Plotly
 * has a camera to read. */
async function waitForScene(timeout = 60000) {
  return page.waitForFunction(() => {
    const gd = document.getElementById('plotly-3d-market-simulation');
    return !!(gd && gd._fullLayout && gd._fullLayout.scene && gd._fullLayout.scene.camera);
  }, null, { timeout }).then(() => true).catch(() => false);
}
async function gotoHome() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await dismissTour();
  await page.waitForTimeout(400);
}
/* The tour auto-opens ~700ms after every anonymous load (by design), and a
 * fresh CI browser is always anonymous. Dismiss it through the
 * viewport-anchored Exit button — the callout card's own X moves with the
 * spotlight, and the tour's step-1 smooth-scroll can leave it unstable or
 * off-screen (observed on CI: spotlight at top:-210px, X unreachable, and
 * every later control click then timed out under the tour scrim). */
async function dismissTour() {
  try {
    await page.locator('[aria-label="Exit tour"]').click({ timeout: 20000 });
  } catch {
    await page.keyboard.press('Escape');
  }
  // Fail LOUDLY if the tour survived: proceeding with it open turns every
  // later click into an unrelated 120s actionability timeout (the exact
  // flake this guards against). Poll for closure rather than one count():
  // React lands the close asynchronously after the click resolves.
  let dismissed = false;
  try {
    await page.waitForFunction(() =>
      !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
      null, { timeout: 10000 });
    dismissed = true;
  } catch { /* still open after 10s — a real failure */ }
  if (!dismissed) throw new Error('guided tour still open after Exit click + Escape');
}

try {
  // ══ 1. cold load (guards: build integrity — a broken bundle was once the
  //      only failure mode CI could not see, because nothing built or ran it)
  await gotoHome();
  record('page loads with the app title',
    (await page.title()).includes('Nash Equilibrium'),
    await page.title());

  // ══ 2. API + deterministic report path (no key → computed ground truth)
  {
    const r = await fetch(`${BASE}/api/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payoffs: { a11: -2, a12: 1, a21: 1, a22: 0, b11: 1, b12: -2, b21: -2, b22: 1 } }),
    });
    const j = await r.json();
    const ok = r.status === 200 && j.source === 'deterministic'
      && Array.isArray(j.groundTruth) && j.groundTruth.length > 0;
    record('report API falls back to deterministic ground truth without a key', ok,
      `status=${r.status} source=${j.source} NEs=${j.groundTruth?.length}`);
  }

  // ══ 3. pasted typographic minus (round 14: silently became 0 on the live site)
  {
    const cell = $.matrix.nth(0);
    await cell.click();
    await cell.fill('');
    await page.keyboard.insertText('−4'); // U+2212, what a PDF paste delivers
    await cell.blur();
    await page.waitForTimeout(300);
    const v = await cell.inputValue();
    record('U+2212 pasted into A(1,1) commits to -4', v === '-4', `got "${v}"`);
    await cell.fill('0'); await cell.blur();
    await page.waitForTimeout(200);
  }

  // ══ 4. start point of 0 (round 14: log said Start (0.217) over a box reading 0)
  {
    await $.x0.fill('0'); await $.x0.blur(); await page.waitForTimeout(200);
    await $.step.click();
    // poll, don't sleep: on CI's SwiftShader runner the step can take seconds
    // to reach the log
    const line = await page.waitForFunction(() => {
      const t = [...document.querySelectorAll('p')].map((p) => (p.textContent || '').trim()).find((l) => /^Start \(/.test(l));
      return /^Start \(0\.000/.test(t || '') ? t : null;
    }, null, { timeout: 90000 }).then((h) => h.jsonValue()).catch(() => '');
    record('x0=0 + Step opens the log "Start (0.000, …)"', /^Start \(0\.000/.test(line), line);
    await $.reset.click(); await page.waitForTimeout(300);
  }

  // ══ 5. THE TAB WEDGE (round 15: one Step click at step-size 0.001 wedged the
  //      tab permanently, live on the public site)
  {
    const vals = [7, -7, -6, -4, -7, 1, 0, -6];
    for (let i = 0; i < 8; i++) { await $.matrix.nth(i).fill(String(vals[i])); await $.matrix.nth(i).blur(); }
    await page.waitForTimeout(300);
    await $.stepSize.fill('0.001'); await $.stepSize.blur(); await page.waitForTimeout(200);
    const t0 = Date.now();
    await $.step.click();
    // poll for the progress readout instead of a fixed 50ms sleep — the click
    // resolves before React paints on a slow runner
    const prog = await page.waitForFunction(() => {
      const els = [...document.querySelectorAll('span')].filter((e) => /^\d+ \/ \d+$/.test((e.textContent || '').trim()));
      return els.length ? els.map((e) => e.textContent.trim()) : null;
    }, null, { timeout: 90000 }).then((h) => h.jsonValue()).catch(() => []);
    const ms = Date.now() - t0;
    // The functional wedge guard is the progress check below (the original
    // defect NEVER advanced). This timing bound only catches "the tab froze
    // for good" — 10s because GitHub's 2-core runners measure 4s for a
    // healthy first Step click (precompute + first interaction); local runs
    // do it in 0.4s.
    record('tab-wedge fixture: Step responds instantly', ms < 10000, `${ms}ms`);
    record('tab-wedge fixture: progress reads 1 / 1504', prog.some((p) => p === '1 / 1504'), JSON.stringify(prog));
    await $.reset.click(); await page.waitForTimeout(300);
    await $.stepSize.fill('0.1'); await $.stepSize.blur(); await page.waitForTimeout(200);
  }

  // ══ 6. a preset runs to convergence (guards the solver + run loop + UI wiring)
  {
    await page.getByRole('button', { name: 'Spy vs. Analyst' }).first().click();
    await page.waitForTimeout(500);
    await setSpeed(10); await page.waitForTimeout(300);
    await $.run.click();
    await page.waitForSelector('text=Converged', { timeout: 240000 });
    const pill = await page.locator('text=Converged').count();
    record('Spy vs. Analyst converges in Domain Shrink mode', pill > 0);
    await $.reset.click(); await page.waitForTimeout(300);
  }

  // ══ 6b. every standard preset reads as a story, not a grid reference
  //       (RED-PUBLIC A/B: 4 of 6 presets fell back to the generic "Row 1" /
  //       "Col 2" matrix header, and even the two with real labels still
  //       named the same option "(Row 1)" in the prose two lines below the
  //       header that called it something else). Checks the RENDERED page —
  //       matrix header (data-tour="matrix") AND narrative card
  //       (data-testid="preset-narrative") — for every standard preset, not
  //       just the data in gameEngine.ts.
  //
  //       Scoped to those two containers, NOT document.body: the
  //       Expected-Payoff panel permanently renders the general convention
  //       "x = P(A plays Row 1), y = P(B plays Col 1)" via MathTex on every
  //       game, preset or not — a body-wide check would fail on the FIXED
  //       code too and the check would be measuring the wrong thing.
  {
    const ROWCOL = /\b(row|col(?:umn)?)\s*\d\b/i;
    const presetNames = [
      'Search Game', 'Battle of the Sexes', 'Prisoners Dilemma',
      'Cops & Robbers', 'Spy vs. Analyst', 'Penalty Kick',
    ];
    let allClean = true;
    const offenders = [];
    for (const name of presetNames) {
      await page.getByRole('button', { name, exact: true }).first().click();
      await page.waitForTimeout(250);
      const scoped = await page.evaluate(() => {
        const matrix = document.querySelector('[data-tour="matrix"]');
        const narrative = document.querySelector('[data-testid="preset-narrative"]');
        return `${matrix ? matrix.textContent : ''} ${narrative ? narrative.textContent : ''}`;
      });
      if (ROWCOL.test(scoped)) { allClean = false; offenders.push(name); }
    }
    record('no standard preset renders "Row N" / "Col N" in its header or narrative card',
      allClean, offenders.join(', '));
    await $.reset.click(); await page.waitForTimeout(300);
  }

  // ══ 7. regret mode converges and names what it did (round 14 wording defect;
  //      guards the mixed-NE realization branch)
  {
    await $.regret.click();
    await page.waitForTimeout(300);
    await $.run.click();
    await page.waitForSelector('text=Converged', { timeout: 240000 });
    await page.waitForTimeout(600);
    const body = await page.evaluate(() => document.body.innerText);
    record('regret mode says "regret contraction cycles"',
      body.includes('regret contraction cycles')
      && !body.includes('contraction cycles of search corridors'));
    await $.shrink.click(); await page.waitForTimeout(300);
  }

  // ══ 8. switching mover clears the run (round 14: stale run under new rules)
  {
    await $.run.click();
    await page.waitForSelector('text=Converged', { timeout: 240000 });
    const before = await page.locator('text=Converged').count();
    await $.moverB.click();
    await page.waitForTimeout(500);
    const after = await page.locator('text=Converged').count();
    const lines = await $.logLines.count();
    record('clicking Player B clears the Converged pill and the log', before > 0 && after === 0 && lines === 1,
      `${lines} log lines`);
  }

  // ══ 9. the report surface, end to end, on the no-key path (guards the
  //      report UI + its agreement with the solver-computed equilibria)
  {
    await $.reset.click();
    const vals = [-9, 3, 0, 5, 5, 0, 1, 1];
    for (let i = 0; i < 8; i++) { await $.matrix.nth(i).fill(String(vals[i])); await $.matrix.nth(i).blur(); }
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /Explain this game/ }).first().click();
    await page.waitForSelector('text=Game-Theoretic Report', { timeout: 30000 });
    await page.waitForTimeout(800);
    const body = await page.evaluate(() => document.body.innerText);
    const hasNE = /Pure NE \(Row2, Col2\)/.test(body);
    const computed = /authoritative|computed/i.test(body);
    record('report renders the computed Pure NE (Row2, Col2) for the fixture', hasNE);
    record('no-key path shows the deterministic report as authoritative', computed);
  }
  // ══ 10. matrix edit after a jump clears the run (round 14: "Search Game,
  //      Run to 49/49, Go to step 0, edit b22" left a STALE certified run on
  //      the new game)
  {
    await $.reset.click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Search Game' }).first().click();
    await page.waitForTimeout(500);
    await $.run.click();
    await page.waitForSelector('text=Converged', { timeout: 240000 });
    const jump = page.locator('xpath=//span[contains(text(),"Go to step")]/following-sibling::input[1]');
    await jump.fill('0');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await page.waitForTimeout(400);
    await $.matrix.nth(7).fill('-4');
    await $.matrix.nth(7).blur();
    await page.waitForTimeout(400);
    const lines = await $.logLines.count();
    const pill = await page.locator('text=Converged').count();
    record('matrix edit after Go-to-step-0 clears the run', lines === 1 && pill === 0,
      `${lines} log lines, Converged pill=${pill}`);
  }

  // ══ 11. the PURE settlement branch (check 6 exercises the mixed one; BoS
  //      settles at a corner — the wording and the realised payoff here are
  //      their own code path, one a red team falsified with a wrong number)
  {
    await $.reset.click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Battle of the Sexes' }).first().click();
    await page.waitForTimeout(500);
    await $.run.click();
    await page.waitForSelector('text=Converged', { timeout: 240000 });
    await page.waitForTimeout(600);
    const body = await page.evaluate(() => document.body.innerText);
    record('BoS converges with the pure-settlement wording',
      body.includes('Mover priority settled') && /realised -?\d/.test(body.replace('realized', 'realised')));
  }

  // ══ 12. theme round-trip (the light/dark pairing convention — a panel left
  //      dark "by omission" in light mode is this repo's classic regression)
  {
    const before = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    await page.locator('[aria-label="Toggle dark mode"]').first().click();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      stored: localStorage.getItem('nash_sim_theme'),
    }));
    record('theme toggle flips the dark class and persists it',
      after.dark === !before && (after.stored === 'dark' || after.stored === 'light'),
      JSON.stringify(after));
    // restore the starting theme for anything running after this suite
    if (after.dark !== before) {
      await page.locator('[aria-label="Toggle dark mode"]').first().click();
      await page.waitForTimeout(200);
    }
  }

  // ══ 13. Reset returns the app to a fresh state (guards the default-game
  //      restore path after two presets, a manual matrix, and a report)
  {
    await $.reset.click();
    await page.waitForTimeout(400);
    const lines = await $.logLines.count();
    const pill = await page.locator('text=Converged').count();
    record('Reset clears the log and the Converged pill', lines === 1 && pill === 0,
      `${lines} log lines, Converged pill=${pill}`);
  }

  // ══ 14. the plot stays directly manipulable (rotate AND zoom)
  //
  //      Round 17 context: pausing a run, adjusting the view and pressing Run
  //      flashed the default camera for one frame. The cause was that Plotly
  //      reports camera interaction as `scene.camera.eye` and never as
  //      `scene.camera`, so the stored pose stopped tracking a ZOOM and every
  //      Plotly.react shipped a stale camera in its layout.
  //
  //      That defect is NOT guarded here, deliberately. An assertion comparing
  //      the layout camera to the on-screen camera was written three different
  //      ways and mutation testing showed every one of them PASSING against the
  //      original defect — `uirevision` makes Plotly ignore the stale pose in a
  //      headless run, so the bug is real but not observable this way. A check
  //      that cannot fail on the bug it names is worse than no check, so it was
  //      removed instead of shipped green. The decidable half lives in
  //      src/unit.test.ts as `isCameraRelayout`, which IS mutation-verified in
  //      both directions.
  //
  //      What is worth asserting here is the precondition that made the bug
  //      reachable at all: the plot must remain rotatable and zoomable. If
  //      direct manipulation breaks, the camera code above is moot and this
  //      fails loudly.
  {
    await $.reset.click();
    await page.locator('#plotly-3d-market-simulation').scrollIntoViewIfNeeded();
    const sceneReady = await waitForScene();
    record('the 3D scene is live before the camera checks (precondition)', sceneReady);

    const liveEye = () => page.evaluate(() => {
      const e = document.getElementById('plotly-3d-market-simulation')?._fullLayout?.scene?.camera?.eye;
      return e ? { x: e.x, y: e.y, z: e.z } : null;
    });
    const moved = (a, b2) => !!a && !!b2
      && Math.hypot(a.x - b2.x, a.y - b2.y, a.z - b2.z) > 0.05;

    const start = await liveEye();
    const box = await page.locator('#plotly-3d-market-simulation').boundingBox();
    if (box) {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      // Paced moves: a burst delivered in a single tick is coalesced and
      // Plotly's turntable handler never sees the drag — which silently turns
      // this check into a tautology.
      for (let i = 1; i <= 10; i++) { await page.mouse.move(cx + 20 * i, cy + 5 * i); await page.waitForTimeout(25); }
      await page.mouse.up();
      await page.waitForTimeout(600);
    }
    const afterDrag = await liveEye();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -150); await page.waitForTimeout(90); }
      await page.waitForTimeout(600);
    }
    const afterZoom = await liveEye();

    record('the 3D plot can be rotated by dragging', moved(start, afterDrag),
      `${JSON.stringify(start)} -> ${JSON.stringify(afterDrag)}`);
    record('the 3D plot can be zoomed by wheel', moved(afterDrag, afterZoom),
      `${JSON.stringify(afterDrag)} -> ${JSON.stringify(afterZoom)}`);

    await $.reset.click();
    await page.waitForTimeout(300);
  }

  // ══ 15. NO CAMERA FLASH WHEN A PAUSED RUN RESUMES (round 17, reported from a
  //      screen recording: pause mid-run by pressing the plot, rotate AND zoom,
  //      press Run — the plot showed the PRE-ZOOM view for a frame before
  //      snapping back to the adjusted one)
  //
  //      Cause: `uirevision` tells Plotly to keep the view it remembers across
  //      a react and ignore the layout camera — and Plotly's memory never
  //      recorded the wheel zoom, so a react re-applied the older pose. The
  //      excursion lives entirely inside one blocked frame, so sampling the
  //      camera from node misses it and "the view did not move" passes against
  //      the bug (three such attempts did). Sample it INSIDE the react call
  //      instead: that is where the stale pose is observable.
  {
    const view = page.viewportSize();
    // Wide enough that the plot and the Run button are both on screen — if
    // Playwright has to scroll to reach Run, the plot moves and the comparison
    // is meaningless.
    await page.setViewportSize({ width: 1710, height: 1100 });
    await page.waitForTimeout(500);
    await $.reset.click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Spy vs. Analyst' }).first().click();
    await page.waitForTimeout(600);
    await setSpeed(5);
    await page.waitForTimeout(300);

    const clickByText = (re) => page.evaluate((src) => {
      const b = [...document.querySelectorAll('button')]
        .find((e) => new RegExp(src).test((e.textContent || '').trim()));
      b?.click();
    }, re);

    await clickByText('^Run$');
    await page.waitForTimeout(1200);
    const box = await page.locator('#plotly-3d-market-simulation').boundingBox();
    if (box) {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.click(cx, cy);          // pause the run
      await page.waitForTimeout(700);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(cx + 18 * i, cy + 5 * i); await page.waitForTimeout(25); }
      await page.mouse.up();
      await page.waitForTimeout(400);
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -150); await page.waitForTimeout(100); }
      await page.waitForTimeout(800);
    }

    const adjusted = await page.evaluate(() => {
      const e = document.getElementById('plotly-3d-market-simulation')?._fullLayout?.scene?.camera?.eye;
      return e ? { x: e.x, y: e.y, z: e.z } : null;
    });

    await page.evaluate(() => {
      window.__flash = [];
      const P = window.Plotly;
      const orig = P.react.bind(P);
      P.react = function (gd, data, layout, ...rest) {
        const live = document.getElementById('plotly-3d-market-simulation')?._fullLayout?.scene?.camera?.eye;
        if (live) window.__flash.push({ x: live.x, y: live.y, z: live.z });
        return orig(gd, data, layout, ...rest);
      };
    });
    await clickByText('^(Run|Pause)$');   // resume the run
    await page.waitForTimeout(2000);

    const worst = await page.evaluate((a) => {
      if (!a || !window.__flash.length) return { n: 0, max: -1 };
      let max = 0;
      for (const c of window.__flash) {
        max = Math.max(max, Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z));
      }
      return { n: window.__flash.length, max };
    }, adjusted);

    record('resuming a paused run keeps the adjusted camera (no pre-zoom flash)',
      worst.n > 0 && worst.max < 0.15,
      `${worst.n} react calls, worst deviation=${worst.max.toFixed(4)}`);

    await $.reset.click();
    await page.waitForTimeout(300);
    await page.setViewportSize(view);
    await page.waitForTimeout(300);
  }

  // ══ 16. ZOOMING PAUSES A RUNNING SIMULATION (reported: a trackpad pinch
  //      adjusted the view while the run kept stepping underneath it)
  //
  //      Pressing the plot has always paused the run. Zooming did not, because
  //      the handler listened for mousedown/touchstart only — and a trackpad
  //      pinch is not a touch gesture on the desktop: the browser delivers it
  //      as a `wheel` event with ctrlKey set. A plain wheel over the scene
  //      zooms the camera too. Both are reaching into the picture, so both
  //      pause, exactly as a press does.
  {
    await $.reset.click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Spy vs. Analyst' }).first().click();
    await page.waitForTimeout(600);
    await setSpeed(1);                       // slow, so the run is still going
    await page.waitForTimeout(250);
    await $.run.click();
    await page.waitForTimeout(1400);

    const isRunning = () => page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Pause'));
    const wasRunning = await isRunning();

    const box = await page.locator('#plotly-3d-market-simulation').boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -150); await page.waitForTimeout(90); }
      await page.waitForTimeout(700);
    }
    const stillRunning = await isRunning();

    // Without the precondition a broken Run button would make this pass by
    // never having started.
    record('the run was going before the zoom (precondition)', wasRunning === true);
    record('zooming the scene pauses a running simulation', wasRunning === true && stillRunning === false);
    await $.reset.click();
    await page.waitForTimeout(300);
  }

} catch (e) {
  // Capture the failure state BEFORE closing the browser — a click timeout
  // with no console errors is unactionable without seeing what the page
  // looked like (what overlay was up, whether the button was even there).
  await page.screenshot({ path: '/tmp/e2e_smoke_failure.png', fullPage: true }).catch(() => {});
  try {
    const fs = await import('node:fs');
    fs.writeFileSync('/tmp/e2e_smoke_failure.html',
      await page.content().catch(() => '<unavailable>'));
  } catch { /* evidence capture must never mask the original failure */ }
  record('suite completed without a script error', false, e.message.slice(0, 200));
}

await page.screenshot({ path: '/tmp/e2e_smoke_end.png' }).catch(() => {});
await browser.close();

// console errors: external analytics/resource failures are not the app's
// signal here; everything else is a failure of the check that ran
const relevantErrors = consoleErrors.filter((t) =>
  !/googletagmanager|google-analytics|gtag|net::|ERR_INTERNET|ERR_NAME_NOT_RESOLVED/i.test(t));
record('no console/page errors across the whole suite', relevantErrors.length === 0,
  relevantErrors.slice(0, 3).join(' | '));

await killServer();
try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ E2E SMOKE: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length) fails.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
process.exit(fails.length ? 1 : 0);

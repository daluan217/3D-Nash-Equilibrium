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
async function waitForScene(timeout = 60000, p = page) {
  return p.waitForFunction(() => {
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
    // Poll for the reset to actually land (CodeRabbit finding, this
    // branch), not a fixed sleep: the very next section clicks a preset
    // button and reads the resulting screen, so a reset that has not yet
    // committed would let that section start from stale state on a
    // stalled CI runner. NO `.catch(() => {})` (a second CodeRabbit
    // finding on the same line): swallowing the timeout would let the
    // suite continue on a genuinely BROKEN Reset, exactly the "check that
    // cannot fail for the reason it claims" this repo's own standing
    // lesson warns about -- the outer try/catch around the whole suite
    // (bottom of this file) already turns an uncaught rejection here into
    // a proper failure with evidence capture.
    await $.reset.click();
    await page.waitForFunction(() => document.querySelectorAll('div.overflow-y-auto.font-mono p').length === 1,
      null, { timeout: 5000 });
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
    // Each preset's own row1Label (headerMarker) AND a distinct phrase that
    // only appears in that preset's PROSE (narrativeMarker) — two separate
    // positive markers for two separate containers, not just the ROWCOL
    // absence check below. Presence is not participation: a check that only
    // asserts "Row N" text is ABSENT would pass vacuously on a click that
    // silently failed, a stale previous preset's screen, or an empty/
    // missing container — none of those are "the fix working". And
    // (CodeRabbit finding, this branch) a check that accepts the header
    // marker OR the narrative marker in EITHER container cannot tell a
    // STALE header (still showing the PREVIOUS preset's label) from a
    // correct one, as long as the narrative card happens to satisfy the
    // marker — the header specifically is what RED-PUBLIC A found broken,
    // so the header marker must be required IN THE HEADER, not "somewhere".
    const presets = [
      ['Search Game', 'Search L', 'searcher'],
      ['Battle of the Sexes', 'Opera', 'Opera'],
      ['Prisoners Dilemma', 'Cooperate', 'Cooperate'],
      ['Cops & Robbers', 'Stay at Home', 'robber'],
      ['Spy vs. Analyst', 'Leak Intel', 'spy'],
      ['Penalty Kick', 'Aim Left', 'kicker'],
    ];
    let allClean = true;
    let allHeaderMarked = true;
    let allNarrativeMarked = true;
    let allPresent = true;
    const offenders = [];
    const headerUnmarked = [];
    const narrativeUnmarked = [];
    const missing = [];
    for (const [name, headerMarker, narrativeMarker] of presets) {
      await page.getByRole('button', { name, exact: true }).first().click();
      // Poll for the header to actually show THIS preset's label rather than
      // a fixed sleep (CodeRabbit finding, this branch): a fixed wait can
      // sample stale React state on a slow runner, silently passing a check
      // that never really looked at the right screen. Polls for the HEADER
      // marker specifically — the container that must have actually updated.
      const state = await page.waitForFunction((expectedHeaderMarker) => {
        const matrix = document.querySelector('[data-tour="matrix"]');
        const narrative = document.querySelector('[data-testid="preset-narrative"]');
        if (!matrix || !narrative) return null; // keep polling — containers may not have mounted yet
        const matrixText = matrix.textContent || '';
        const narrativeText = narrative.textContent || '';
        if (!matrixText.includes(expectedHeaderMarker)) return null; // keep polling — header hasn't updated yet
        return { matrixText, narrativeText };
      }, headerMarker, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => null);
      if (!state) {
        // Either a container never mounted, or the HEADER marker never
        // showed up — both are real failures, not "clean" by default.
        allPresent = false; allHeaderMarked = false; missing.push(name);
        continue;
      }
      // Header marker is already guaranteed present by the poll above (it is
      // the wait condition) — asserted again here so a future edit to the
      // poll cannot silently drop this check without a visible red test.
      if (!state.matrixText.includes(headerMarker)) { allHeaderMarked = false; headerUnmarked.push(name); }
      if (!state.narrativeText.includes(narrativeMarker)) { allNarrativeMarked = false; narrativeUnmarked.push(name); }
      if (ROWCOL.test(state.matrixText + ' ' + state.narrativeText)) {
        allClean = false; offenders.push(name);
      }
    }
    record('every standard preset\'s header/narrative container mounts and reports state',
      allPresent, missing.join(', '));
    record('every standard preset\'s MATRIX HEADER shows its own row1Label',
      allHeaderMarked, headerUnmarked.join(', '));
    record('every standard preset\'s NARRATIVE CARD shows its own expected content',
      allNarrativeMarked, narrativeUnmarked.join(', '));
    record('no standard preset renders "Row N" / "Col N" in its header or narrative card',
      allClean, offenders.join(', '));
    // Poll for the reset (CodeRabbit finding, this branch), same reason as
    // section 6's ending reset above — the next section (regret mode)
    // reads screen state right after this and must not start from a
    // still-settling reset on a stalled runner. No swallowed timeout here
    // either, same reasoning as the first instance.
    await $.reset.click();
    await page.waitForFunction(() => document.querySelectorAll('div.overflow-y-auto.font-mono p').length === 1,
      null, { timeout: 5000 });
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

  // ══ 17. THE 320px ROW/COL LABEL DOES NOT BREAK MID-WORD (RED-APP-4 round 4,
  //      findings/RED-APP-4/004-320px-row-label-midword-break.md)
  //
  //      Prisoner's Dilemma's Row 1 label "Cooperate" (9 chars) wrapped to
  //      "Cooper"/"ate" at a 320px viewport — the row-label column is capped
  //      at 72px (deliberately, to protect the payoff inputs' own WCAG-24px
  //      tap-target width), and "Cooperate" alone doesn't fit inside it at
  //      the default text-xs size once the "A: " prefix has already wrapped.
  //      Every OTHER built-in preset label wraps cleanly at the "A: "/word
  //      boundary; only this one crosses the threshold. Fixed with a
  //      narrow-viewport-only smaller font on the label cells (NOT a wider
  //      column — widening the column's `minmax(0,X)` max has NO effect
  //      here, confirmed empirically: the column loses to its sibling 1fr
  //      columns' own min-content demand when its own min is 0, so only
  //      reducing the LABEL's own min-content — via a smaller font — closes
  //      the gap without taking width from the payoff inputs).
  //
  //      A SEPARATE page at a fixed 320px viewport, since the shared page
  //      above never resizes this narrow.
  {
    const narrowPage = await browser.newPage({ viewport: { width: 320, height: 900 } });
    await narrowPage.goto(BASE, { waitUntil: 'networkidle' });
    const narrowExitTour = narrowPage.getByRole('button', { name: /exit tour/i });
    if (await narrowExitTour.count() > 0) {
      await narrowExitTour.click();
      await narrowPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
        null, { timeout: 10000 }).catch(() => {});
    }
    // Prisoner's Dilemma is the default-selected preset; the exact fixture
    // this defect escaped at. Explicit click rather than relying on default
    // selection, so this check does not silently stop meaning anything if
    // the default preset ever changes.
    await narrowPage.getByRole('button', { name: "Prisoner's Dilemma" }).click().catch(() => {});
    const rowLabel = narrowPage.locator('div[title="Cooperate"]', { hasText: /^A:/ }).first();
    await rowLabel.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

    // THE PRECISE CHECK (CodeRabbit finding, PR #90 re-review): a total-line
    // count of <=2 does NOT prove "Cooperate" itself is unbroken — "A: Coop"
    // on line 1 and "erate" on line 2 is ALSO 2 lines total, with the word
    // split mid-word just as broken as the reported 3-line case, and the old
    // `lines <= 2` check would have passed it. Ask the DOM directly instead:
    // build a Range over exactly the "Cooperate" substring (not the whole
    // label, which also contains "A: ") and read `getClientRects()` — one
    // rect per line box the range's content actually occupies. A word that
    // renders on a single line produces exactly one rect; a word split
    // across two lines produces two (one per fragment), regardless of how
    // many lines the SURROUNDING label happens to wrap onto.
    const wordRectCount = await rowLabel.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const idx = (node.textContent ?? '').indexOf('Cooperate');
        if (idx !== -1) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + 'Cooperate'.length);
          return range.getClientRects().length;
        }
      }
      return null;
    });

    // The height/line-count read is kept as SECONDARY evidence only (folded
    // into the failure detail), never as part of the pass/fail decision —
    // exactly the class of check the primary one above replaces.
    const box = await rowLabel.boundingBox();
    const lineHeight = box ? await rowLabel.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight)) : null;
    const lines = box && lineHeight ? Math.round(box.height / lineHeight) : null;

    record('the "Cooperate" row label wraps at a word boundary, not mid-word, at 320px',
      wordRectCount === 1,
      `wordRectCount=${wordRectCount} (secondary: box=${JSON.stringify(box)} lineHeight=${lineHeight} lines=${lines})`);

    await narrowPage.close();
  }

  // ══ 18. THE IDLE SPIN RESPECTS prefers-reduced-motion (RED-APP-4 round 4,
  //      findings/RED-APP-4/003-idle-spin-ignores-reduced-motion.md)
  //
  //      The idle spin — the plot's continuous, indefinite ~40s/turn camera
  //      rotation while nothing else is happening — never checked the OS-level
  //      reduced-motion preference at all; only a DIFFERENT animation on the
  //      same component (the tour's camera-glide transition) did. Reproduced
  //      against production: camera eye moved by a similar amount in each of
  //      two consecutive idle windows with the preference active. This is the
  //      app's DEFAULT idle state, reachable with zero interaction, so it is
  //      the more consequential of the two animations to miss.
  //
  //      A SEPARATE page (not the shared one above) because the preference
  //      must be readable from the very first render, and setting it mid-way
  //      through this suite would contaminate every later check.
  {
    const rmPage = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const eye = () => rmPage.evaluate(() => {
      const el = document.getElementById('plotly-3d-market-simulation');
      return el?._fullLayout?.scene?.camera?.eye ?? null;
    });
    const dist = (a, b2) => !!a && !!b2 && Math.hypot(a.x - b2.x, a.y - b2.y, a.z - b2.z);

    await rmPage.goto(BASE, { waitUntil: 'networkidle' });
    const rmExitTour = rmPage.getByRole('button', { name: /exit tour/i });
    if (await rmExitTour.count() > 0) {
      await rmExitTour.click();
      await rmPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
        null, { timeout: 10000 }).catch(() => {});
    }
    const sceneReady = await waitForScene(60000, rmPage);
    record('idle-spin check: the scene is live on the fresh page (precondition)', sceneReady);

    // CONTROL, on this same fresh page, BEFORE the preference is set: poll
    // for the camera to move (state-based) rather than sleep a fixed amount
    // and hope — a stalled CI runner (SwiftShader, or a slow first relayout)
    // can need longer than any one fixed guess, and this check's whole point
    // is proving the spin is REACHABLE here, or a "no movement" result below
    // would prove nothing (a broken idle spin would pass this check too).
    const base = await eye();
    const controlMoved = await rmPage.waitForFunction((b) => {
      const el = document.getElementById('plotly-3d-market-simulation');
      const e = el?._fullLayout?.scene?.camera?.eye;
      return !!(e && b) && Math.hypot(e.x - b.x, e.y - b.y, e.z - b.z) > 0.05;
    }, base, { timeout: 15000 }).then(() => true).catch(() => false);
    record('CONTROL: the idle spin turns the camera with NO motion preference set',
      controlMoved, `base=${JSON.stringify(base)}`);

    // THE CHECK: enable the preference on this same live page (also exercises
    // the `change` event path, not just the initial-mount read). Rather than
    // trust two snapshots separated by one fixed delay — which only catches
    // movement if it happens to still be in flight at that exact instant —
    // sample repeatedly across a window and fail the moment ANY movement
    // shows up, wherever in the window it lands.
    await rmPage.emulateMedia({ reducedMotion: 'reduce' });
    const sees = await rmPage.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    record('the page observes the emulated prefers-reduced-motion preference', sees === true);

    const e0 = await eye();
    let firstMoveAt = null;
    let lastEye = e0;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await rmPage.waitForTimeout(200);
      const e1 = await eye();
      if (dist(lastEye, e1) > 1e-9) { firstMoveAt = e1; break; }
      lastEye = e1;
    }
    record('the idle spin does not move the camera once prefers-reduced-motion is set',
      firstMoveAt === null,
      firstMoveAt === null ? `held at ${JSON.stringify(lastEye)} for 6s` : `moved to ${JSON.stringify(firstMoveAt)} from ${JSON.stringify(e0)}`);

    await rmPage.close();
  }

  // ══ 19. THE EXPANDED LOG DIALOG MANAGES FOCUS (CodeRabbit finding, PR #90
  //      re-review, src/App.tsx:3086)
  //
  //      Activating "Expand log" opened the overlay but left focus on the
  //      button underneath it — a keyboard user's next Tab walked the REST
  //      OF THE PAGE (hidden behind the backdrop) before ever reaching the
  //      dialog, and nothing ever moved focus back on close. Fixed: focus
  //      moves into the dialog on open, Tab/Shift+Tab is trapped to the
  //      dialog's own focusable elements while it is open, and focus
  //      returns to the "Expand log" button on close.
  //
  //      A SEPARATE page (not the shared one above), since this leaves the
  //      dialog open/closed and moves focus around — state later checks in
  //      this suite do not expect.
  {
    const focusPage = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await focusPage.goto(BASE, { waitUntil: 'networkidle' });
    const focusExitTour = focusPage.getByRole('button', { name: /exit tour/i });
    if (await focusExitTour.count() > 0) {
      await focusExitTour.click();
      await focusPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
        null, { timeout: 10000 }).catch(() => {});
    }

    const expandBtn = focusPage.getByRole('button', { name: 'Expand simulation log' });
    await expandBtn.waitFor({ state: 'visible', timeout: 15000 });
    await expandBtn.click();
    await focusPage.waitForFunction(() => !!document.querySelector('[role="dialog"][aria-label="Simulation log"]'),
      null, { timeout: 10000 }).catch(() => {});
    // Give the focus-move effect a tick to run after the dialog mounts.
    await focusPage.waitForTimeout(150);

    const isInsideDialog = () => focusPage.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="Simulation log"]');
      return !!dlg && dlg.contains(document.activeElement);
    });

    record('opening the expanded log moves focus INTO the dialog (not left on the opener)',
      await isInsideDialog());

    // Tab several times — more than the dialog's own focusable-element count
    // (collapse button + log region = 2), so a trap failure (focus escaping
    // onto the page) would show up within this loop rather than needing the
    // exact wrap-around step guessed correctly.
    let stayedInside = true;
    for (let i = 0; i < 5; i++) {
      await focusPage.keyboard.press('Tab');
      if (!(await isInsideDialog())) { stayedInside = false; break; }
    }
    record('Tab is trapped inside the expanded log dialog (5 presses, focus never left it)',
      stayedInside);

    await focusPage.keyboard.press('Escape');
    await focusPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Simulation log"]'),
      null, { timeout: 10000 }).catch(() => {});
    await focusPage.waitForTimeout(150);
    const restoredToOpener = await focusPage.evaluate(() =>
      document.activeElement?.getAttribute('aria-label') === 'Expand simulation log');
    record('closing the expanded log restores focus to the "Expand log" button',
      restoredToOpener);

    await focusPage.close();
  }

  // ══ 20. THE OTHER FOUR MODALS ALSO TRAP TAB (RED-APP-5 finding 002,
  //      round 5) — #90 (section 19 above) only fixed the expand-log
  //      dialog; Feedback/Auth/Save/Edit had NO trap at all, so Tab walked
  //      focus onto the page behind the backdrop. Checked via TWO dialogs,
  //      both no-auth-needed so this stays fast, with the shared
  //      `useModalTabTrap` hook wired the same way to Save/Edit too (see
  //      src/a11yfixes.test.ts for the static wiring check on all four):
  //
  //      - Feedback: its own Tab-trap-stays-inside check. RED-APP-5's own
  //        probe (`probe_tab_trap.mjs`) found Feedback's pre-fix leak lands
  //        on <body> (it is near the end of the DOM, nothing focusable
  //        after it) — a dead end, not a second-dialog collision. So this
  //        dialog only tests confinement, not the collision.
  //
  //      - Auth: the SAME confinement check, PLUS the collision RED
  //        actually found — Auth's pre-fix leak lands specifically on the
  //        still-visible "Feedback" launcher BUTTON (Feedback renders
  //        earlier in the DOM), and pressing Enter there opened a SECOND
  //        `aria-modal="true"` dialog on top of the still-open Auth one.
  //        (CodeRabbit CLI review on this branch caught an earlier version
  //        of this check that pressed no Enter at all, so
  //        `secondDialogCount === 1` held in both the fixed and the
  //        defective build — and a first attempt at fixing that ran the
  //        Enter press against Feedback, whose own leak point is <body>, so
  //        it STILL could not discriminate. Mutation-verified against
  //        BOTH dialogs before shipping — see the finding's blue-note.)
  {
    const trapPage = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await trapPage.goto(BASE, { waitUntil: 'networkidle' });
    const trapExitTour = trapPage.getByRole('button', { name: /exit tour/i });
    if (await trapExitTour.count() > 0) {
      await trapExitTour.click();
      await trapPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
        null, { timeout: 10000 }).catch(() => {});
    }

    const isInsideDialog = (label) => trapPage.evaluate((l) => {
      const dlg = document.querySelector(`[role="dialog"][aria-label="${l}"]`);
      return !!dlg && dlg.contains(document.activeElement);
    }, label);
    // More presses than either dialog's own focusable-element count, so a
    // trap failure shows up within the loop rather than needing an exact
    // wrap-around step guessed correctly.
    const sweepTab = async (label) => {
      let stayedInside = true;
      for (let i = 0; i < 15; i++) {
        await trapPage.keyboard.press('Tab');
        if (!(await isInsideDialog(label))) { stayedInside = false; break; }
      }
      return stayedInside;
    };

    const feedbackBtn = trapPage.locator('button[title="Send feedback"]');
    await feedbackBtn.waitFor({ state: 'visible', timeout: 15000 });
    await feedbackBtn.click();
    await trapPage.waitForFunction(() => !!document.querySelector('[role="dialog"][aria-label="Send feedback"]'),
      null, { timeout: 10000 }).catch(() => {});
    await trapPage.locator('[role="dialog"][aria-label="Send feedback"] textarea, [role="dialog"][aria-label="Send feedback"] input').first().focus();
    record('Tab is trapped inside the Feedback dialog (15 presses, focus never left it)',
      await sweepTab('Send feedback'));
    await trapPage.keyboard.press('Escape');
    // Poll for the dialog's actual disappearance rather than a fixed sleep
    // (CodeRabbit review on PR #91: a 150ms sleep can race React's state
    // update + unmount on a slow/2-core CI runner).
    await trapPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Send feedback"]'),
      null, { timeout: 10000 }).catch(() => {});

    await trapPage.getByRole('button', { name: /sign in.*sign up/i }).first().click();
    await trapPage.waitForFunction(() => !!document.querySelector('[role="dialog"][aria-label="Account"]'),
      null, { timeout: 10000 }).catch(() => {});
    // FOCUS MOVES INTO THE DIALOG ON OPEN (CodeRabbit review on PR #91,
    // same round as the Tab-trap fix above): Auth has no `autoFocus` field
    // of its own (unlike Feedback's textarea), so this dialog is the real
    // proof — before the fix, `document.activeElement` stayed on the
    // "Sign In / Sign Up" launcher button until the user's FIRST Tab press.
    // Checked BEFORE the manual `.focus()` call below, which would
    // otherwise overwrite the natural target and hide a regression here.
    // POLLED, not read once immediately (CodeRabbit review, same PR):
    // `useModalTabTrap`'s mount-focus branch runs from a PASSIVE effect
    // AFTER mount + paint, so reading `document.activeElement` in the same
    // tick the dialog appears can false-fail on a slow render. Only a
    // timeout counts as a real failure.
    let authFocusedInsideOnOpen = false;
    try {
      await trapPage.waitForFunction(() => {
        const dlg = document.querySelector('[role="dialog"][aria-label="Account"]');
        return !!dlg && dlg.contains(document.activeElement);
      }, null, { timeout: 5000 });
      authFocusedInsideOnOpen = true;
    } catch { /* timed out — focus never landed inside; recorded as failure below */ }
    record('opening the Auth dialog moves focus into it without a Tab press',
      authFocusedInsideOnOpen);
    await trapPage.locator('[role="dialog"][aria-label="Account"] input').first().focus();
    record('Tab is trapped inside the Auth dialog (15 presses, focus never left it)',
      await sweepTab('Account'));

    // THE COLLISION ITSELF. Tab alone never opens a dialog — the pre-fix
    // defect needs a leaked-to control AND an Enter press on it — so the
    // Enter press is what makes this discriminating (see the section
    // comment above for the CodeRabbit finding that caught the first two
    // attempts at this check).
    await trapPage.keyboard.press('Enter');
    // This is a NEGATIVE assertion (no second dialog stacks) — there is
    // nothing to wait FOR, so poll two animation frames instead of a fixed
    // sleep (CodeRabbit review on PR #91): lets React's state update and
    // paint land at whatever cadence the runner is actually running at,
    // without waiting any longer than necessary on a fast one.
    await trapPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const secondDialogCount = await trapPage.evaluate(() =>
      document.querySelectorAll('[role="dialog"][aria-modal="true"]').length);
    record('Enter after the Auth-dialog Tab sweep cannot stack a second aria-modal dialog',
      secondDialogCount === 1, `found ${secondDialogCount}`);

    await trapPage.close();
  }

  // ══ 21. THE LIVE REGION ANNOUNCES "SETTLED, NOT AN EQUILIBRIUM" AS ITS OWN
  //      PHASE (RED-APP-6/001) — a run that goes STATIONARY at a point that
  //      is NOT a Nash equilibrium (regret exceeds tolerance) is a real,
  //      distinct terminal state — the visible pill says "Settled (not an
  //      NE)", not "Converged" — but the aria-live phase model fell through
  //      to the generic 'paused' phase and its "Simulation paused." text,
  //      BYTE-IDENTICAL to a literal manual Pause click. A screen-reader
  //      user got no indication the run had finished at all.
  //
  //      Fixture from src/test.ts's own testRedTeamFindings4():
  //      a11=9,a12=-1,a21=-9,a22=9,b11=-4,b12=-7,b21=-2,b22=-2 — settles at
  //      (0,1) with regret ~18 for A under the app's own defaults
  //      (firstMover A, shrink mode, step 0.1, x0=y0=0.217).
  {
    const settledPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await settledPage.goto(BASE, { waitUntil: 'networkidle' });
    const settledExitTour = settledPage.getByRole('button', { name: /exit tour/i });
    if (await settledExitTour.isVisible({ timeout: 3000 }).catch(() => false)) await settledExitTour.click();
    await settledPage.waitForTimeout(300);

    const setCell = async (label, value) => {
      const input = settledPage.getByLabel(label, { exact: true });
      await input.click();
      await input.fill(String(value));
      // Blur via keyboard, not .blur() — editing the first cell flips every
      // cell's aria-label from the preset's scenario nouns to generic
      // "Row N, Col N", so a locator captured before the edit can go stale.
      await settledPage.keyboard.press('Tab');
    };
    const labels = await settledPage.evaluate(() =>
      Array.from(document.querySelectorAll('input[aria-label*="Player A payoff"]')).map((i) => i.getAttribute('aria-label')));
    const [r1, c1] = labels[0].split(',').map((s) => s.trim());
    await setCell(`${r1}, ${c1}, Player A payoff`, 9);
    await setCell('Row 1, Col 1, Player B payoff', -4);
    await setCell('Row 1, Col 2, Player A payoff', -1);
    await setCell('Row 1, Col 2, Player B payoff', -7);
    await setCell('Row 2, Col 1, Player A payoff', -9);
    await setCell('Row 2, Col 1, Player B payoff', -2);
    await setCell('Row 2, Col 2, Player A payoff', 9);
    await setCell('Row 2, Col 2, Player B payoff', -2);

    await settledPage.getByRole('button', { name: /^run$/i }).first().click();
    // Poll for the pill instead of a fixed sleep — the run converges/settles
    // in well under a second normally, but CI's SwiftShader path can be slow.
    let pillText = null;
    for (let i = 0; i < 40 && !pillText; i++) {
      await settledPage.waitForTimeout(200);
      pillText = await settledPage.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('span'));
        const pill = spans.find((s) => /Converged|Settled \(not an NE\)/.test(s.textContent || ''));
        return pill ? pill.textContent.trim() : null;
      });
    }
    const finalLive = await settledPage.evaluate(() =>
      document.querySelector('[aria-live="polite"][role="status"]')?.textContent ?? null);
    record('visible pill reads "Settled (not an NE)" for the RED-APP-6/001 fixture',
      pillText === 'Settled (not an NE)', `pillText=${JSON.stringify(pillText)}`);
    record('live region announces the settled-not-NE state distinctly, not "Simulation paused."',
      finalLive === 'Simulation settled — not a Nash equilibrium.', `finalLive=${JSON.stringify(finalLive)}`);

    await settledPage.close();
  }

  // ══ 22. ESCAPE CLOSES ONLY THE TOPMOST LAYER — A DIALOG OVER THE TOUR
  //      DOES NOT ALSO DISMISS THE TOUR (RED-APP-6/002). Walkthrough.tsx has
  //      its own independent window-level Escape listener; App.tsx's dialog
  //      Escape handlers now stopPropagation when they actually close
  //      something, so the same keypress can never also reach the tour's
  //      listener and reset its step to 0.
  {
    const escPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await escPage.goto(BASE, { waitUntil: 'networkidle' });
    // Tour auto-opens on a fresh anonymous load — do NOT exit it here.
    const tourOpen = async () => escPage.evaluate(() => !!document.querySelector('[role="dialog"][aria-label="Guided tour"]'));
    record('tour is open on a fresh anonymous load (precondition)', await tourOpen());

    const nextBtn = escPage.getByRole('button', { name: /^next$/i });
    for (let i = 0; i < 3; i++) {
      await nextBtn.click().catch(() => {});
      await escPage.waitForTimeout(150);
    }
    const tourTitleBefore = await escPage.evaluate(() =>
      document.querySelector('[role="dialog"][aria-label="Guided tour"] h3, [role="dialog"][aria-label="Guided tour"] [class*="font-bold"]')?.textContent ?? null);

    await escPage.getByRole('button', { name: /sign in.*sign up/i }).first().click();
    await escPage.waitForFunction(() => !!document.querySelector('[role="dialog"][aria-label="Account"]'),
      null, { timeout: 10000 }).catch(() => {});
    const authOpenBefore = await escPage.evaluate(() => !!document.querySelector('[role="dialog"][aria-label="Account"]'));
    record('Auth dialog opened over the still-open tour (precondition)', authOpenBefore && (await tourOpen()));

    await escPage.keyboard.press('Escape');
    await escPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Account"]'),
      null, { timeout: 10000 }).catch(() => {});
    await escPage.waitForTimeout(200);

    const authOpenAfter = await escPage.evaluate(() => !!document.querySelector('[role="dialog"][aria-label="Account"]'));
    const tourOpenAfter = await tourOpen();
    const tourTitleAfter = tourOpenAfter
      ? await escPage.evaluate(() =>
        document.querySelector('[role="dialog"][aria-label="Guided tour"] h3, [role="dialog"][aria-label="Guided tour"] [class*="font-bold"]')?.textContent ?? null)
      : null;
    record('one Escape closes the Auth dialog', !authOpenAfter, `authOpenAfter=${authOpenAfter}`);
    record('the SAME Escape press does not also close the tour (RED-APP-6/002)',
      tourOpenAfter, `tourOpenAfter=${tourOpenAfter}`);
    record('the tour is still at the same step, not reset (RED-APP-6/002)',
      tourOpenAfter && tourTitleAfter === tourTitleBefore,
      `before=${JSON.stringify(tourTitleBefore)} after=${JSON.stringify(tourTitleAfter)}`);

    await escPage.close();
  }

  // ══ 23. A STALLED /api/report REQUEST RECOVERS ON ITS OWN, WITH HONEST
  //      WORDING (RED-APP-6/003). Before this fix, `fetchLlmExplanation` had
  //      no AbortController anywhere — a request that neither resolves nor
  //      rejects (a stalled connection, not a closed one) left the button
  //      stuck on "Analyzing…", disabled, forever. Waits past
  //      REPORT_FETCH_TIMEOUT_MS (22s, App.tsx) — real wall-clock time, since
  //      the defect class is specifically "nothing ever forces recovery".
  {
    const hangPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let intercepted = false;
    await hangPage.route('**/api/report', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      intercepted = true;
      // Deliberately never fulfill/abort/continue — a genuinely hung request.
    });
    await hangPage.goto(BASE, { waitUntil: 'networkidle' });
    const hangExitTour = hangPage.getByRole('button', { name: /exit tour/i });
    if (await hangExitTour.isVisible({ timeout: 3000 }).catch(() => false)) await hangExitTour.click();
    await hangPage.waitForTimeout(300);

    const explainBtn = hangPage.getByRole('button', { name: /explain this game/i });
    await explainBtn.click();
    await hangPage.waitForTimeout(1000);
    record('the report request was actually intercepted (precondition)', intercepted);
    const stuckState = await hangPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /analyzing|explain this game|regenerate/i.test(b.textContent || ''));
      return btn ? { text: btn.textContent, disabled: btn.disabled } : null;
    });
    record('the button enters the loading state immediately', !!stuckState?.disabled, JSON.stringify(stuckState));

    await hangPage.waitForTimeout(23000); // past REPORT_FETCH_TIMEOUT_MS
    const recovered = await hangPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /analyzing|explain this game|regenerate/i.test(b.textContent || ''));
      const wording = document.body.innerText.match(/timeout|timed out|taking longer|try again|unavailable/i);
      return { button: btn ? { text: btn.textContent, disabled: btn.disabled } : null, wording: wording ? wording[0] : null };
    });
    record('the button un-sticks (re-enabled, no longer "Analyzing…") after the timeout',
      recovered.button?.disabled === false && recovered.button?.text !== 'Analyzing…', JSON.stringify(recovered));
    record('the page shows honest timeout wording, not silence',
      !!recovered.wording, JSON.stringify(recovered));
    const runStillUsable = await hangPage.getByRole('button', { name: /^run$/i }).first().isEnabled().catch(() => false);
    record('the rest of the app (Run) stays usable while the report request was stuck', runStillUsable);

    await hangPage.close();
  }

  // ══ 24. THE 40-CHAR NO-SPACE LABEL DOES NOT OVERFLOW 320px (RED-APP-6/004,
  //      WCAG 1.4.10 reflow) — the matrix's outer grid had two bare `1fr`
  //      column tracks (== minmax(auto, 1fr)); a label with no break
  //      opportunity (a straight 40-char run, the label field's own
  //      maxLength) could not shrink below its unbroken min-content width,
  //      forcing the grid — and the page — past the viewport instead of
  //      wrapping or shrinking. Fixed with minmax(0, 1fr) on both tracks,
  //      matching what the per-cell payoff-pair grid already did correctly.
  {
    const overflowPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await overflowPage.goto(BASE, { waitUntil: 'networkidle' });
    const oExitTour = overflowPage.getByRole('button', { name: /exit tour/i });
    if (await oExitTour.isVisible({ timeout: 3000 }).catch(() => false)) await oExitTour.click();
    await overflowPage.waitForTimeout(300);

    const uniq = Date.now();
    await overflowPage.getByRole('button', { name: /sign in.*sign up/i }).first().click();
    await overflowPage.waitForSelector('[role="dialog"][aria-label="Account"]', { timeout: 5000 });
    await overflowPage.getByText(/sign up/i).last().click().catch(async () => {
      await overflowPage.getByRole('button', { name: /create.*account|register/i }).first().click();
    });
    await overflowPage.waitForTimeout(300);
    await overflowPage.getByPlaceholder('game_theorist').fill(`e2e6reflow${uniq}`);
    await overflowPage.getByPlaceholder('john@example.com').fill(`e2e6reflow${uniq}@example.com`);
    const pwFields = overflowPage.getByPlaceholder('••••••••');
    await pwFields.nth(0).fill('TestPass123');
    await pwFields.nth(1).fill('TestPass123');
    await overflowPage.getByRole('button', { name: /register account/i }).click();
    await overflowPage.waitForTimeout(800);
    await overflowPage.getByPlaceholder(/example\.com or username/i).fill(`e2e6reflow${uniq}@example.com`);
    await overflowPage.getByPlaceholder('••••••••').first().fill('TestPass123');
    await overflowPage.getByRole('button', { name: /^login$/i }).click();
    await overflowPage.waitForTimeout(800);

    const LONG = 'A'.repeat(40); // the label field's own maxLength, no spaces
    await overflowPage.getByRole('button', { name: /save preset/i }).click();
    await overflowPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    await overflowPage.getByPlaceholder('e.g. Battle of the Sexes 2.0').fill(`Reflow ${uniq}`);
    const labelInputs = overflowPage.locator(
      '[role="dialog"][aria-label="Save custom game"] input[placeholder^="e.g. Undercut"], '
      + '[role="dialog"][aria-label="Save custom game"] input[placeholder^="e.g. Hold price"], '
      + '[role="dialog"][aria-label="Save custom game"] input[placeholder^="e.g. Match"], '
      + '[role="dialog"][aria-label="Save custom game"] input[placeholder^="e.g. Ignore"]');
    const labelCount = await labelInputs.count();
    for (let i = 0; i < labelCount; i++) await labelInputs.nth(i).fill(LONG);
    await overflowPage.getByRole('button', { name: /^save game profile$/i }).click();
    await overflowPage.waitForTimeout(800);

    const storageState = await overflowPage.context().storageState();
    await overflowPage.close();

    const narrow320 = await browser.newContext({ viewport: { width: 320, height: 700 }, storageState });
    const p320 = await narrow320.newPage();
    await p320.goto(BASE, { waitUntil: 'networkidle' });
    await p320.waitForTimeout(1000);
    const p320ExitTour = p320.getByRole('button', { name: /exit tour/i });
    if (await p320ExitTour.isVisible({ timeout: 2000 }).catch(() => false)) await p320ExitTour.click();
    await p320.waitForTimeout(300);

    const overflowing = async () => p320.evaluate(() => {
      const html = document.documentElement;
      return html.scrollWidth > html.clientWidth + 1;
    });
    record('320px is clean before loading the long-label game (precondition)', !(await overflowing()));

    const gameCard = p320.getByText(`Reflow ${uniq}`, { exact: false });
    const cardFound = await gameCard.first().isVisible({ timeout: 5000 }).catch(() => false);
    record('the long-label saved game is reachable at 320px (precondition)', cardFound);
    if (cardFound) {
      await gameCard.first().click();
      await p320.waitForTimeout(500);
      record('the 40-char no-space label does not overflow 320px (RED-APP-6/004)', !(await overflowing()));
    }
    await narrow320.close();
  }

  // ══ 25. THE SAVE DIALOG'S NAME FIELD CLAMPS TO 40 CHARS EVEN WHEN
  //      PREFILLED PROGRAMMATICALLY FROM AN AI-SUGGESTED NAME (RED-APP-6/005)
  //      — the field's own `maxLength={40}` only bounds what a user TYPES;
  //      `setSaveName(sc.name ?? '')` set it via React state with no clamp
  //      at all, unlike its sibling `setEditName(...)` branch for the
  //      identical data. Bypasses the need for real model credentials: the
  //      `/api/report` response is fully replaced with a synthetic but
  //      `envelopeIsTrustworthy()`-satisfying ('template' source) envelope
  //      carrying a crafted 72-character name.
  {
    const clampPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await clampPage.route('**/api/report', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = {
        source: 'template',
        report: {
          claimedEquilibria: [],
          prose: 'A synthetic report used only to exercise the Save dialog Name-field clamp.',
          proseClaims: null,
          geometryClaims: null,
          suggestedScenario: {
            name: 'A'.repeat(72),
            row1: 'Cooperate', row2: 'Defect', col1: 'Cooperate', col2: 'Defect',
            description: 'A synthetic scenario used only to exercise the client-side name clamp.',
            actorA: ['player'], actorB: ['player'],
          },
        },
        validation: null,
        groundTruth: [],
      };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await clampPage.goto(BASE, { waitUntil: 'networkidle' });
    const clampExitTour = clampPage.getByRole('button', { name: /exit tour/i });
    if (await clampExitTour.isVisible({ timeout: 3000 }).catch(() => false)) await clampExitTour.click();
    await clampPage.waitForTimeout(300);

    await clampPage.getByRole('button', { name: /new ai scenario/i }).click();
    // Poll rather than a single isVisible() call — the card only exists in
    // the DOM once the mocked fetch resolves and React renders it, which is
    // an actual state transition to wait FOR, not a snapshot check.
    const cardLocator = clampPage.getByText('Scenario written for this game', { exact: false });
    let cardVisible = false;
    for (let i = 0; i < 20 && !cardVisible; i++) {
      await clampPage.waitForTimeout(500);
      cardVisible = await cardLocator.isVisible({ timeout: 500 }).catch(() => false);
    }
    record('the synthetic suggested-scenario card renders (precondition)', cardVisible);
    if (cardVisible) {
      await clampPage.getByRole('button', { name: /save this scenario with the game/i }).click();
      await clampPage.waitForTimeout(600);
      const nameValue = await clampPage.evaluate(() => {
        const inp = document.querySelector('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]')
          || document.querySelector('[role="dialog"][aria-label="Edit saved game"] input');
        return inp ? inp.value : null;
      });
      record('the Save dialog Name field clamps a 72-char suggested name to 40 (RED-APP-6/005)',
        nameValue !== null && nameValue.length <= 40, `length=${nameValue ? nameValue.length : null}`);
    }
    await clampPage.close();
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

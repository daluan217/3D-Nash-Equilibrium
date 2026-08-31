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
  // flake this guards against).
  if (await page.locator('[role="dialog"][aria-label="Guided tour"]').count()) {
    throw new Error('guided tour still open after Exit click + Escape');
  }
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

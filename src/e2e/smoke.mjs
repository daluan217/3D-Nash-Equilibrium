/* End-to-end smoke suite — the top of the testing pyramid.
 *
 * Runs against the ACTUAL production artifact (dist/ + dist/server.cjs) on a
 * local port, with no LLM keys and no SMTP: the report route takes its
 * documented no-key deterministic path. Every check below guards a defect
 * class that has actually reached a user (each is tagged with where it
 * happened). Run by CI (.github/workflows/test.yml, job `e2e`) and locally:
 *
 *   E2E_BASE=http://localhost:3099 node src/e2e/smoke.mjs
 *   E2E_SHARD=2/4 E2E_BASE=http://localhost:3099 node src/e2e/smoke.mjs
 *
 * Exit 0 only if every check passes and the browser logged no console errors.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { selectSmokeSections } from './selection.js';

const PORT = process.env.E2E_PORT || process.env.PORT || '3099';
const BASE = process.env.E2E_BASE || `http://localhost:${PORT}`;

const results = [];
const sections = [];
let activeSection = null;
let activeAttempt = 1;
let executedShard = null;
function record(name, pass, detail) {
  results.push({ name, pass, detail, sectionId: activeSection?.id ?? null, attempt: activeAttempt });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function section(id, name, shard, run) {
  sections.push({ id: String(id), name, shard, run });
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
const consoleErrors = [];

/**
 * RED-REGEN-2/002 (director-confirmed 2026-09-04): the "no console/page
 * errors across the whole suite" bar (this file's own header comment,
 * line 12) is only as good as what feeds `consoleErrors`. Every dialog/
 * viewport section that needs its own `browser.newPage()` (a different
 * viewport, an isolated storage/session, a second concurrent tab) used to
 * open one with NO listener attached at all — a real exception thrown on
 * one of those ~20 secondary pages was completely invisible to the final
 * check, even though every other assertion in that section could still
 * pass. `newTrackedPage` is the ONE place a page is created from now on:
 * every `browser.newPage()` call site in this file must go through it, so a
 * real bug on ANY page this suite opens reaches the same `consoleErrors`
 * array the final check reads. A self-test proving this actually gates
 * (a planted thrown error on a secondary page fails the suite) lives in
 * `_gen/smoke_tracked_page_selftest.mjs`.
 *
 * `trackPage` is the shared wiring; `newTrackedPage` is the common case
 * (a fresh page straight off `browser`). One section (long-label overflow,
 * §17) needs a page from its OWN `browser.newContext(...)` (to carry a
 * saved `storageState` into a fresh 320px viewport) rather than from
 * `browser` directly — that page must still go through `trackPage` so it is
 * not a second, silent blind spot of exactly the kind this fix closes.
 */
function trackPage(p) {
  p.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push({
        text: m.text().slice(0, 200),
        sectionId: activeSection?.id ?? null,
        attempt: activeAttempt,
      });
    }
  });
  p.on('pageerror', (e) => consoleErrors.push({
    text: 'PAGEERROR: ' + e.message.slice(0, 200),
    sectionId: activeSection?.id ?? null,
    attempt: activeAttempt,
  }));
  return p;
}
async function newTrackedPage(opts) {
  return trackPage(await browser.newPage(opts));
}

const page = await newTrackedPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(120000);
page.setDefaultNavigationTimeout(120000);

const evidenceTag = process.env.E2E_SHARD
  ? `shard-${process.env.E2E_SHARD.replace('/', '-of-')}`
  : process.env.E2E_SECTION
    ? `sections-${process.env.E2E_SECTION.replace(/[^a-zA-Z0-9]+/g, '-')}`
  : 'all';
const failureBase = `/tmp/e2e_smoke_failure_${evidenceTag}`;
const endPng = `/tmp/e2e_smoke_end_${evidenceTag}.png`;
const finalAttemptBySection = new Map();

async function captureFailureEvidence() {
  const suffix = `section-${activeSection?.id ?? 'suite'}-attempt-${activeAttempt}`;
  const failurePng = `${failureBase}_${suffix}.png`;
  const failureHtml = `${failureBase}_${suffix}.html`;
  await page.screenshot({ path: failurePng, fullPage: true }).catch(() => {});
  try {
    const fs = await import('node:fs');
    fs.writeFileSync(failureHtml, await page.content().catch(() => '<unavailable>'));
  } catch { /* evidence capture must never mask the original failure */ }
}

function primaryPageSection(id) {
  const number = Number.parseInt(id, 10);
  return Number.isFinite(number) && number <= 16;
}

async function runSection(definition, attempt) {
  activeSection = definition;
  activeAttempt = attempt;
  const resultStart = results.length;
  const startedAt = Date.now();
  console.log(`\n════ SECTION ${definition.id} [shard ${definition.shard}/4] ${definition.name}${attempt > 1 ? ' (retry)' : ''} ════`);
  try {
    await definition.run();
  } catch (e) {
    record(`section ${definition.id} completed without a script error`, false,
      String(e?.message ?? e).slice(0, 300));
  }
  let attemptResults = results.slice(resultStart);
  // A malformed/refactored section that silently records nothing must never
  // make a retry disappear from the final-attempt filter and turn green.
  if (attemptResults.length === 0) {
    record(`section ${definition.id} recorded at least one check`, false,
      'section returned without calling record()');
    attemptResults = results.slice(resultStart);
  }
  const passed = attemptResults.length > 0 && attemptResults.every((result) => result.pass);
  finalAttemptBySection.set(definition.id, attempt);
  console.log(`SECTION-${passed ? 'PASS' : 'FAIL'} ${definition.id} ${definition.name} (${Date.now() - startedAt}ms)`);
  if (!passed) await captureFailureEvidence();
  activeSection = null;
  activeAttempt = 1;
  return passed;
}

async function executeSections() {
  const selection = selectSmokeSections(sections);
  executedShard = selection.shard;
  const selected = selection.selected;
  console.log(`Running ${selected.length}/${sections.length} smoke sections${selection.label}.`);
  // Shards 2-4 can begin with a primary-page section even though section 1 is
  // assigned to shard 1. Load the same clean starting page once for them.
  if (selected[0].id !== '1' && selected.some((definition) => primaryPageSection(definition.id))) {
    await gotoHome();
  }

  const failed = [];
  for (const definition of selected) {
    const passed = await runSection(definition, 1);
    if (!passed) {
      failed.push(definition);
      // A thrown primary-page action can strand the shared page behind a
      // dialog or mid-run. Recover before another selected core section uses
      // it; dedicated-page sections are isolated by construction.
      if (primaryPageSection(definition.id)) await gotoHome().catch(() => {});
    }
  }

  if (failed.length > 0) {
    console.log(`\n════ RETRYING ONLY FAILED SECTIONS: ${failed.map((definition) => `${definition.id} ${definition.name}`).join(', ')} ════`);
    for (const definition of failed) {
      if (primaryPageSection(definition.id)) await gotoHome().catch(() => {});
      const passed = await runSection(definition, 2);
      if (passed) console.log(`pass-after-section-retry: ${definition.id} ${definition.name}`);
    }
  }
}

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
/* CodeRabbit (CLI, this branch): poll for a committed input value instead of
 * a fixed sleep after blur — React's commit (and any state it drives, like
 * section 42's payoffInputHint) lands asynchronously, and a flat wait is
 * either a race on a slow runner or wasted time on a fast one. Returns once
 * the value matches OR the timeout elapses; the caller reads inputValue()
 * itself afterward either way, so a genuine failure still reports the wrong
 * value rather than silently passing. */
async function waitForInputValue(p, selector, nth, expected, timeout = 3000) {
  return p.waitForFunction(
    ({ selector, nth, expected }) => document.querySelectorAll(selector)[nth]?.value === expected,
    { selector, nth, expected },
    { timeout },
  ).then(() => true).catch(() => false);
}
async function gotoHome() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await dismissTour();
  // A successful navigation can precede React's interactive controls.  The
  // first payoff input is the stable readiness boundary every core section
  // needs; waiting for it removes a fixed delay without racing the UI.
  await $.matrix.first().waitFor({ state: 'visible' });
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

/* Register a fresh account and log in, on the GIVEN page (so a section using
 * a dedicated context/page for route mocking still gets an authenticated
 * session). Returns the unique username fragment used, for building a saved
 * game's name later. Same flow §24/§25 duplicate inline — factored out here
 * because the regen sections below need it four more times. */
async function registerAndLogin(p, tag) {
  await p.goto(BASE, { waitUntil: 'networkidle' });
  const exitTour = p.getByRole('button', { name: /exit tour/i });
  if (await exitTour.isVisible({ timeout: 3000 }).catch(() => false)) await exitTour.click();
  await p.waitForTimeout(300);
  const uniq = `${tag}${Date.now()}`;
  await p.getByRole('button', { name: /sign in.*sign up/i }).first().click();
  await p.waitForSelector('[role="dialog"][aria-label="Account"]', { timeout: 5000 });
  await p.getByText(/sign up/i).last().click().catch(async () => {
    await p.getByRole('button', { name: /create.*account|register/i }).first().click();
  });
  await p.waitForTimeout(300);
  await p.getByPlaceholder('game_theorist').fill(uniq);
  await p.getByPlaceholder('john@example.com').fill(`${uniq}@example.com`);
  const pwFields = p.getByPlaceholder('••••••••');
  await pwFields.nth(0).fill('TestPass123');
  await pwFields.nth(1).fill('TestPass123');
  await p.getByRole('button', { name: /register account/i }).click();
  await p.waitForTimeout(800);
  await p.getByPlaceholder(/example\.com or username/i).fill(`${uniq}@example.com`);
  await p.getByPlaceholder('••••••••').first().fill('TestPass123');
  await p.getByRole('button', { name: /^login$/i }).click();
  await p.waitForTimeout(800);
  return uniq;
}

/* Mock `/api/health` to advertise the regen capability and `/api/scenario/
 * regenerate` with a canned handler — used by every regen section below so
 * none of them needs real credentials or the (not-yet-merged) server route. */
async function mockRegenOn(p, regenerateHandler) {
  await p.route('**/api/health', async (route) => {
    const res = await route.fetch();
    let body;
    try { body = await res.json(); } catch { body = {}; }
    body.capabilities = { ...(body.capabilities || {}), scenarioRegen: true };
    await route.fulfill({ status: res.status(), contentType: 'application/json', body: JSON.stringify(body) });
  });
  if (regenerateHandler) await p.route('**/api/scenario/regenerate', regenerateHandler);
}

// H1: the regenerate-only schema (not the frozen report schema) carries actor
// nouns. The route mocks below deliberately emit the exact enabled wire shape.
const REGEN_STORY_A = {
  name: 'Cider Press Bookings',
  row1: 'Early Slot', row2: 'Late Slot', col1: 'Reserve', col2: 'Walk-in',
  description: 'The north orchard and the south orchard are booking time on the shared cider press before the fruit turns.',
  actorA: ['the north orchard'], actorB: ['the south orchard'],
};
const REGEN_STORY_B = {
  name: 'Kiln Firing Schedule',
  row1: 'Morning Fire', row2: 'Evening Fire', col1: 'Glaze Batch', col2: 'Bisque Batch',
  description: 'A potter and a kiln co-op are scheduling a shared firing slot.',
  actorA: ['A potter'], actorB: ['a kiln co-op'],
};
// RED-REGEN-3/001: a SYMMETRIC draw (row1===col1) — schema-legal and not
// rare (measured: 477/2483 = 19.2% of the shipped bank shares a label
// verbatim between a Row and a Col option).
const REGEN_STORY_SYMMETRIC = {
  name: 'Symmetric PD Test',
  row1: 'Cooperate', row2: 'Defect', col1: 'Cooperate', col2: 'Defect',
  description: 'Two firms decide independently whether to Cooperate or Defect on a shared logistics standard this quarter.',
};

try {
  // ══ 1. cold load (guards: build integrity — a broken bundle was once the
  //      only failure mode CI could not see, because nothing built or ran it)
  section('1', 'cold load', 1, async () => {
    await gotoHome();
    record('page loads with the app title',
      (await page.title()).includes('Nash Equilibrium'),
      await page.title());
  });

  // ══ 2. API + deterministic report path (no key → computed ground truth)
  section('2', 'deterministic report API', 2, async () => {
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
  });

  // ══ 3. pasted typographic minus (round 14: silently became 0 on the live site)
  section('3', 'typographic minus input', 3, async () => {
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
  });

  // ══ 4. start point of 0 (round 14: log said Start (0.217) over a box reading 0)
  section('4', 'zero start point', 4, async () => {
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
  });

  // ══ 5. THE TAB WEDGE (round 15: one Step click at step-size 0.001 wedged the
  //      tab permanently, live on the public site)
  section('5', 'tab-wedge fixture', 1, async () => {
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
  });

  // ══ 6. a preset runs to convergence (guards the solver + run loop + UI wiring)
  section('6', 'mixed convergence', 1, async () => {
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
  });

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
  section('6b', 'standard preset stories', 4, async () => {
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
  });

  // ══ 7. regret mode converges and names what it did (round 14 wording defect;
  //      guards the mixed-NE realization branch)
  section('7', 'regret convergence wording', 2, async () => {
    // This used to inherit Penalty Kick from §6b. Every section must carry
    // its own fixture now that shards can start here and retries can run it
    // alone.
    await page.getByRole('button', { name: 'Spy vs. Analyst' }).first().click();
    await page.waitForTimeout(500);
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
  });

  // ══ 8. switching mover clears the run (round 14: stale run under new rules)
  section('8', 'mover switch clears run', 3, async () => {
    await $.run.click();
    await page.waitForSelector('text=Converged', { timeout: 240000 });
    const before = await page.locator('text=Converged').count();
    await $.moverB.click();
    await page.waitForTimeout(500);
    const after = await page.locator('text=Converged').count();
    const lines = await $.logLines.count();
    record('clicking Player B clears the Converged pill and the log', before > 0 && after === 0 && lines === 1,
      `${lines} log lines`);
  });

  // ══ 9. the report surface, end to end, on the no-key path (guards the
  //      report UI + its agreement with the solver-computed equilibria)
  section('9', 'deterministic report UI', 4, async () => {
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
  });
  // ══ 10. matrix edit after a jump clears the run (round 14: "Search Game,
  //      Run to 49/49, Go to step 0, edit b22" left a STALE certified run on
  //      the new game)
  section('10', 'matrix edit clears jumped run', 2, async () => {
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
  });

  // ══ 11. the PURE settlement branch (check 6 exercises the mixed one; BoS
  //      settles at a corner — the wording and the realised payoff here are
  //      their own code path, one a red team falsified with a wrong number)
  section('11', 'pure settlement wording', 3, async () => {
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
  });

  // ══ 12. theme round-trip (the light/dark pairing convention — a panel left
  //      dark "by omission" in light mode is this repo's classic regression)
  section('12', 'theme round trip', 4, async () => {
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
  });

  // ══ 13. Reset returns the app to a fresh state (guards the default-game
  //      restore path after two presets, a manual matrix, and a report)
  section('13', 'reset clears run', 4, async () => {
    await $.reset.click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Battle of the Sexes' }).first().click();
    await page.waitForTimeout(500);
    await setSpeed(10);
    await $.run.click();
    await page.waitForSelector('text=Converged', { timeout: 240000 });
    const linesBefore = await $.logLines.count();
    const pillBefore = await page.locator('text=Converged').count();
    record('Reset fixture has a completed run to clear', linesBefore > 1 && pillBefore > 0,
      `${linesBefore} log lines, Converged pill=${pillBefore}`);

    await $.reset.click();
    let lines = await $.logLines.count();
    let pill = await page.locator('text=Converged').count();
    for (let i = 0; i < 40 && !(lines === 1 && pill === 0); i++) {
      await page.waitForTimeout(100);
      lines = await $.logLines.count();
      pill = await page.locator('text=Converged').count();
    }
    record('Reset clears the log and the Converged pill', lines === 1 && pill === 0,
      `${lines} log lines, Converged pill=${pill}`);
  });

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
  section('14', 'plot rotate and zoom', 1, async () => {
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
  });

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
  section('15', 'camera stability on resume', 2, async () => {
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
  });

  // ══ 16. ZOOMING PAUSES A RUNNING SIMULATION (reported: a trackpad pinch
  //      adjusted the view while the run kept stepping underneath it)
  //
  //      Pressing the plot has always paused the run. Zooming did not, because
  //      the handler listened for mousedown/touchstart only — and a trackpad
  //      pinch is not a touch gesture on the desktop: the browser delivers it
  //      as a `wheel` event with ctrlKey set. A plain wheel over the scene
  //      zooms the camera too. Both are reaching into the picture, so both
  //      pause, exactly as a press does.
  section('16', 'zoom pauses simulation', 3, async () => {
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
  });

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
  section('17', '320px label wrapping', 3, async () => {
    const narrowPage = await newTrackedPage({ viewport: { width: 320, height: 900 } });
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
  });

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
  section('18', 'reduced-motion idle spin', 2, async () => {
    const rmPage = await newTrackedPage({ viewport: { width: 1400, height: 1000 } });
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
  });

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
  section('19', 'expanded log focus', 2, async () => {
    const focusPage = await newTrackedPage({ viewport: { width: 1400, height: 1000 } });
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
  });

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
  section('20', 'modal focus traps', 3, async () => {
    const trapPage = await newTrackedPage({ viewport: { width: 1400, height: 1000 } });
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
  });

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
  section('21', 'settled live-region wording', 1, async () => {
    const settledPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await settledPage.goto(BASE, { waitUntil: 'networkidle' });
    const settledExitTour = settledPage.getByRole('button', { name: /exit tour/i });
    if (await settledExitTour.isVisible({ timeout: 3000 }).catch(() => false)) {
      await settledExitTour.click();
      // CodeRabbit finding (this branch): poll for the tour dialog's actual
      // detachment instead of a flat sleep, same pattern already used
      // elsewhere in this file (React closes it asynchronously).
      await settledPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
        null, { timeout: 10000 }).catch(() => {});
    }

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
  });

  // ══ 22. ESCAPE CLOSES ONLY THE TOPMOST LAYER — A DIALOG OVER THE TOUR
  //      DOES NOT ALSO DISMISS THE TOUR (RED-APP-6/002). Walkthrough.tsx has
  //      its own independent window-level Escape listener; App.tsx's dialog
  //      Escape handlers now stopPropagation when they actually close
  //      something, so the same keypress can never also reach the tour's
  //      listener and reset its step to 0.
  section('22', 'Escape closes topmost layer', 4, async () => {
    const escPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await escPage.goto(BASE, { waitUntil: 'networkidle' });
    // Tour auto-opens on a fresh anonymous load — do NOT exit it here.
    const tourOpen = async () => escPage.evaluate(() => !!document.querySelector('[role="dialog"][aria-label="Guided tour"]'));
    record('tour is open on a fresh anonymous load (precondition)', await tourOpen());

    // CodeRabbit finding (this branch): poll for the tour's own step counter
    // ("N / M") to actually change after each click, instead of a flat sleep
    // that could read a stale step if a render is slow (CI's SwiftShader
    // path especially).
    const progressText = () => escPage.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const el = spans.find((s) => /^\d+ \/ \d+$/.test((s.textContent || '').trim()));
      return el ? el.textContent.trim() : null;
    });
    const nextBtn = escPage.getByRole('button', { name: /^next$/i });
    for (let i = 0; i < 3; i++) {
      const before = await progressText();
      await nextBtn.click().catch(() => {});
      await escPage.waitForFunction((prev) => {
        const spans = Array.from(document.querySelectorAll('span'));
        const el = spans.find((s) => /^\d+ \/ \d+$/.test((s.textContent || '').trim()));
        return !!el && el.textContent.trim() !== prev;
      }, before, { timeout: 5000 }).catch(() => {});
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
  });

  // ══ 23. A STALLED /api/report REQUEST RECOVERS ON ITS OWN, WITH HONEST
  //      WORDING (RED-APP-6/003). Before this fix, `fetchLlmExplanation` had
  //      no AbortController anywhere — a request that neither resolves nor
  //      rejects (a stalled connection, not a closed one) left the button
  //      stuck on "Analyzing…", disabled, forever. Waits past
  //      REPORT_FETCH_TIMEOUT_MS (22s normally; 5s in CI's throwaway e2e
  //      artifact) — real wall-clock time, since the defect class is
  //      specifically "nothing ever forces recovery".
  section('23', 'stalled report timeout wording', 1, async () => {
    const hangPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    let intercepted = false;
    await hangPage.route('**/api/report', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      intercepted = true;
      // Deliberately never fulfill/abort/continue — a genuinely hung request.
    });
    await hangPage.goto(BASE, { waitUntil: 'networkidle' });
    const hangExitTour = hangPage.getByRole('button', { name: /exit tour/i });
    if (await hangExitTour.isVisible({ timeout: 3000 }).catch(() => false)) {
      await hangExitTour.click();
      await hangPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
        null, { timeout: 10000 }).catch(() => {});
    }

    const explainBtn = hangPage.getByRole('button', { name: /explain this game/i });
    await explainBtn.click();
    // CodeRabbit finding (this branch): poll for the loading state itself
    // instead of a flat 1s sleep -- a slow render (or a real regression that
    // never enters the loading state at all) would otherwise read a stale
    // snapshot rather than failing on its own terms.
    await hangPage.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /analyzing|explain this game|regenerate/i.test(b.textContent || ''));
      return !!btn?.disabled;
    }, null, { timeout: 5000 }).catch(() => {});
    record('the report request was actually intercepted (precondition)', intercepted);
    const stuckState = await hangPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /analyzing|explain this game|regenerate/i.test(b.textContent || ''));
      return btn ? { text: btn.textContent, disabled: btn.disabled } : null;
    });
    record('the button enters the loading state immediately', !!stuckState?.disabled, JSON.stringify(stuckState));

    // CodeRabbit finding (this branch): poll for RECOVERY (the button
    // re-enabling) up to a bound comfortably past REPORT_FETCH_TIMEOUT_MS,
    // instead of always sleeping the full 23s regardless of when the abort
    // actually fires -- returns as soon as the state changes, and still
    // gives the configured client-side timeout its full window to fire.
    await hangPage.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /analyzing|explain this game|regenerate/i.test(b.textContent || ''));
      return !!btn && !btn.disabled;
    }, null, { timeout: 30000 }).catch(() => {});
    const recovered = await hangPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /analyzing|explain this game|regenerate/i.test(b.textContent || ''));
      // CodeRabbit finding (this branch): a broad `timeout|...|try again|
      // unavailable` regex also matches the ORDINARY failure copy
      // ("Couldn't reach the explanation service... try again in a
      // moment.") -- so this check could pass even if `llmTimedOut`
      // regressed to always-false and the timeout-specific branch never
      // rendered. Match the phrase that ONLY the timeout wording contains.
      const wording = document.body.innerText.match(/taking longer than expected/i);
      return { button: btn ? { text: btn.textContent, disabled: btn.disabled } : null, wording: wording ? wording[0] : null };
    });
    record('the button un-sticks (re-enabled, no longer "Analyzing…") after the timeout',
      recovered.button?.disabled === false && recovered.button?.text !== 'Analyzing…', JSON.stringify(recovered));
    record('the page shows the timeout-specific wording, not the generic failure message',
      !!recovered.wording, JSON.stringify(recovered));
    const runStillUsable = await hangPage.getByRole('button', { name: /^run$/i }).first().isEnabled().catch(() => false);
    record('the rest of the app (Run) stays usable while the report request was stuck', runStillUsable);

    await hangPage.close();
  });

  // ══ 24. THE 40-CHAR NO-SPACE LABEL DOES NOT OVERFLOW 320px (RED-APP-6/004,
  //      WCAG 1.4.10 reflow) — the matrix's outer grid had two bare `1fr`
  //      column tracks (== minmax(auto, 1fr)); a label with no break
  //      opportunity (a straight 40-char run, the label field's own
  //      maxLength) could not shrink below its unbroken min-content width,
  //      forcing the grid — and the page — past the viewport instead of
  //      wrapping or shrinking. Fixed with minmax(0, 1fr) on both tracks,
  //      matching what the per-cell payoff-pair grid already did correctly.
  section('24', 'long-label 320px reflow', 2, async () => {
    const overflowPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
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
    const p320 = trackPage(await narrow320.newPage());
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

    // `.isVisible({timeout})` does NOT actually wait/retry — Playwright's
    // isVisible is an immediate, no-retry actability snapshot regardless of
    // any timeout argument passed to it, so this was always a race against
    // however long the post-login games list takes to fetch and render, not
    // a real 5s allowance. Made it a genuine waiting check (found running
    // this suite on a slower CI runner, where the race lost reliably).
    const gameCard = p320.getByText(`Reflow ${uniq}`, { exact: false });
    const cardFound = await gameCard.first().waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true).catch(() => false);
    record('the long-label saved game is reachable at 320px (precondition)', cardFound);
    if (cardFound) {
      await gameCard.first().click();
      // CodeRabbit finding (this branch): poll for the LOADED GAME's own
      // labels to actually be on screen (the crafted 40-char run) instead
      // of a flat sleep, so the overflow check below can't read a stale
      // pre-load layout as if it were the post-load one.
      await p320.waitForFunction(() => document.body.innerText.includes('A'.repeat(40)),
        null, { timeout: 5000 }).catch(() => {});
      record('the 40-char no-space label does not overflow 320px (RED-APP-6/004)', !(await overflowing()));
    }
    await narrow320.close();
  });

  // ══ 25. THE SAVE DIALOG'S NAME FIELD CLAMPS TO 40 CHARS EVEN WHEN
  //      PREFILLED PROGRAMMATICALLY FROM AN AI-SUGGESTED NAME (RED-APP-6/005)
  //      — the field's own `maxLength={40}` only bounds what a user TYPES;
  //      `setSaveName(sc.name ?? '')` set it via React state with no clamp
  //      at all, unlike its sibling `setEditName(...)` branch for the
  //      identical data. Bypasses the need for real model credentials: the
  //      `/api/report` response is fully replaced with a synthetic but
  //      `envelopeIsTrustworthy()`-satisfying ('template' source) envelope
  //      carrying a crafted 72-character name.
  section('25', 'suggested-name clamp', 3, async () => {
    const clampPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
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
            // No actorA/actorB — SCENARIO_SCHEMA (the same object this
            // report path's own suggestedScenario uses) forbids them; see
            // RED-REGEN/001.
            name: 'A'.repeat(72),
            row1: 'Cooperate', row2: 'Defect', col1: 'Cooperate', col2: 'Defect',
            description: 'A synthetic scenario used only to exercise the client-side name clamp.',
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
      // CodeRabbit finding (this branch): poll for the Save/Edit dialog to
      // actually mount instead of a flat 600ms sleep, so a slow render
      // cannot make the read below observe an empty/stale field.
      await clampPage.waitForFunction(() =>
        !!document.querySelector('[role="dialog"][aria-label="Save custom game"], [role="dialog"][aria-label="Edit saved game"]'),
        null, { timeout: 5000 }).catch(() => {});
      const nameValue = await clampPage.evaluate(() => {
        const inp = document.querySelector('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]')
          || document.querySelector('[role="dialog"][aria-label="Edit saved game"] input');
        return inp ? inp.value : null;
      });
      // CodeRabbit finding (this branch): `length <= 40` alone would also
      // pass if some UNRELATED bug truncated the name to a shorter, WRONG
      // string (e.g. an accidental `.slice(0, 10)`) -- assert the EXACT
      // expected value, the first 40 'A's of the crafted 72-char name.
      record('the Save dialog Name field clamps a 72-char suggested name to exactly 40 (RED-APP-6/005)',
        nameValue === 'A'.repeat(40), `length=${nameValue ? nameValue.length : null} value=${JSON.stringify(nameValue)}`);
    }
    await clampPage.close();
  });

  // ══ 26. FEATURE-REGEN — hidden when the server capability is off (the
  //      default: NASH_SCENARIO_REGEN is unset on this build, so the real,
  //      unmocked /api/health has no `capabilities.scenarioRegen` at all).
  //      No route mock in this section on purpose — it must be true against
  //      the ACTUAL running server, not a stand-in for one.
  section('26', 'scenario regeneration hidden', 4, async () => {
    const offPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    // CodeRabbit finding: a FIXED sleep before asserting "absent" can pass
    // for the wrong reason on a stalled CI runner (the button is absent
    // because the probe hasn't resolved yet, not because it reported the
    // capability off) — a regression that flips scenarioRegen on would still
    // slip through. Wait for the actual /api/health response the capability
    // probe fires on mount, and assert its OWN payload positively, before
    // ever checking the button.
    const healthSettled = offPage.waitForResponse(
      (r) => r.url().includes('/api/health') && r.request().method() === 'GET',
      { timeout: 15000 },
    );
    await registerAndLogin(offPage, 'e2e6regenoff');
    const health = await healthSettled.then((r) => r.json()).catch(() => null);
    record('capability-off precondition: the real, unmocked server reports scenarioRegen false',
      health?.capabilities?.scenarioRegen !== true, JSON.stringify(health?.capabilities));
    await offPage.getByRole('button', { name: /save preset/i }).click();
    await offPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    const regenVisibleOff = await offPage.getByRole('button', { name: 'Regenerate scenario' }).isVisible({ timeout: 1000 }).catch(() => false);
    record('Regenerate scenario is NOT shown when the server capability is off (default)', !regenVisibleOff);
    await offPage.close();
  });

  // ══ 27. FEATURE-REGEN — Save dialog: Discard preserves typed edits
  //      (RED-APP-4 class), then Keep replaces desc/labels but leaves a
  //      user-TYPED name untouched (director's amended name rule).
  section('27', 'save-dialog regenerate semantics', 1, async () => {
    const savePage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    let regenCalls = 0;
    await mockRegenOn(savePage, async (route) => {
      regenCalls++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenario: REGEN_STORY_A }) });
    });
    await registerAndLogin(savePage, 'e2e6regensave');
    await savePage.getByRole('button', { name: /save preset/i }).click();
    await savePage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });

    const nameField = savePage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]');
    const descField = savePage.locator('[role="dialog"][aria-label="Save custom game"] textarea');
    const row1Field = savePage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder^="e.g. Undercut"]');
    await nameField.fill('My Own Typed Name');
    await descField.fill('My own typed description, carefully written by hand.');
    await row1Field.fill('My Row One');

    const regenBtn = savePage.getByRole('button', { name: 'Regenerate scenario' });
    await regenBtn.waitFor({ state: 'visible', timeout: 5000 });
    await regenBtn.click();
    const previewLocator = savePage.getByText('New scenario (preview)', { exact: false });
    await previewLocator.waitFor({ state: 'visible', timeout: 5000 });
    record('the regenerated preview shows the mocked scenario name', await savePage.getByText(REGEN_STORY_A.name, { exact: false }).isVisible().catch(() => false));
    const previewActorSpans = await savePage.evaluate(() => {
      const marker = [...document.querySelectorAll('p')].find((node) => node.textContent?.trim() === 'New scenario (preview)');
      const card = marker?.parentElement;
      const spans = card?.querySelectorAll('span') ?? [];
      return [...spans]
        .filter((span) => span.textContent?.toLowerCase() === 'the north orchard' || span.textContent === 'the south orchard')
        .map((span) => ({ term: span.textContent?.toLowerCase(), className: span.className }));
    });
    const northSpans = previewActorSpans.filter((span) => span.term === 'the north orchard');
    const southSpans = previewActorSpans.filter((span) => span.term === 'the south orchard');
    record('H1: actor nouns from the enabled regenerate mock are colour-coded on the preview',
      northSpans.length > 0 && southSpans.length > 0
      && northSpans.every((span) => span.className === 'text-player-a-ink dark:text-player-a-ink-dark font-semibold')
      && southSpans.every((span) => span.className === 'text-player-b-ink dark:text-player-b-ink-dark font-semibold'),
      JSON.stringify(previewActorSpans));

    record('typed Name field is untouched while the preview is showing', await nameField.inputValue() === 'My Own Typed Name');
    record('typed Description field is untouched while the preview is showing', await descField.inputValue() === 'My own typed description, carefully written by hand.');

    // Discard: fields must be byte-identical afterward, and the route must
    // not have been hit again.
    await savePage.getByRole('button', { name: 'Discard' }).click();
    await savePage.waitForTimeout(300);
    record('after Discard, the Name field is untouched (RED-APP-4 class)', await nameField.inputValue() === 'My Own Typed Name');
    record('after Discard, the Description field is untouched', await descField.inputValue() === 'My own typed description, carefully written by hand.');
    record('after Discard, the Row 1 label is untouched', await row1Field.inputValue() === 'My Row One');
    record('Discard leaves no preview card behind', !(await previewLocator.isVisible({ timeout: 1000 }).catch(() => false)));
    record('Discard never called the regenerate route a second time (it only issues a GET-less client reset)', regenCalls === 1, `calls=${regenCalls}`);

    // Regenerate again, then Keep: description/labels replace; the NAME the
    // user typed by hand must survive (typed-this-session always wins).
    await regenBtn.click();
    await previewLocator.waitFor({ state: 'visible', timeout: 5000 });
    await savePage.getByRole('button', { name: 'Keep' }).click();
    await savePage.waitForTimeout(300);
    record('Keep replaces the Description field with the mocked scenario', await descField.inputValue() === REGEN_STORY_A.description);
    record('Keep replaces the Row 1 label with the mocked scenario', await row1Field.inputValue() === REGEN_STORY_A.row1);
    record('Keep NEVER replaces a user-TYPED name (director\'s amended rule)', await nameField.inputValue() === 'My Own Typed Name',
      await nameField.inputValue());
    await savePage.close();
  });

  // ══ 28. FEATURE-REGEN — Edit dialog: an UNTOUCHED (not re-typed this
  //      session) name IS replaced on Keep, description/labels replace, the
  //      eventual PATCH carries the new text with no payoffs, and — the
  //      user-reached case, not just an empty-to-empty vacuous pass
  //      (CodeRabbit, this PR) — REAL, pre-existing colour chips placed
  //      through the actual chip-picker UI survive Regenerate -> Keep ->
  //      Save Changes. The mocked draw supplies actorA/actorB through the
  //      enabled regenerate schema, so the PATCH must preserve user chips and
  //      ADD the returned nouns.
  //      src/scenarioregen.test.ts and src/unit.test.ts cover the same
  //      preserve/add/never-reassign behaviour as pure-function fixtures,
  //      and src/integration/scenario-regen.test.mjs section 10 covers it
  //      end-to-end through the real REST API.
  section('28', 'edit-dialog regenerate semantics', 2, async () => {
    const editPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await mockRegenOn(editPage, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenario: REGEN_STORY_B }) });
    });
    const uniq = await registerAndLogin(editPage, 'e2e6regenedit');
    const gameName = `EditFlowGame${uniq}`;
    await editPage.getByRole('button', { name: /save preset/i }).click();
    await editPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    await editPage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]').fill(gameName);

    // Place two REAL colour chips through the actual DescriptionEditor
    // chip-picker (select text in the textarea, click Player A/B) — not a
    // fixture that starts empty, which the pre-fix keepFill would also pass
    // trivially (empty stays empty either way).
    const saveDescText = 'A vendor and a buyer negotiate delivery windows.';
    const saveDescField = editPage.locator('[role="dialog"][aria-label="Save custom game"] textarea');
    await saveDescField.fill(saveDescText);
    const selectWord = async (word) => {
      await editPage.evaluate(({ w, sel }) => {
        const ta = document.querySelector(sel);
        const idx = ta.value.indexOf(w);
        ta.focus();
        ta.setSelectionRange(idx, idx + w.length);
      }, { w: word, sel: '[role="dialog"][aria-label="Save custom game"] textarea' });
    };
    const saveDialog = editPage.getByRole('dialog', { name: 'Save custom game' });
    await selectWord('vendor');
    await saveDialog.getByRole('button', { name: 'Player A' }).click();
    await selectWord('buyer');
    await saveDialog.getByRole('button', { name: 'Player B' }).click();
    record('chip precondition: two real chips are placed before saving',
      await saveDialog.locator('button:has-text("vendor")').isVisible().catch(() => false)
      && await saveDialog.locator('button:has-text("buyer")').isVisible().catch(() => false));

    await editPage.getByRole('button', { name: /^save game profile$/i }).click();
    await editPage.waitForTimeout(600);

    await editPage.getByRole('button', { name: `Edit ${gameName}` }).click();
    await editPage.waitForSelector('[role="dialog"][aria-label="Edit saved game"]', { timeout: 5000 });
    const editNameField = editPage.locator('[role="dialog"][aria-label="Edit saved game"] input[type="text"]').first();
    record('the Edit dialog opens prefilled with the saved name', await editNameField.inputValue() === gameName);

    const editRegenBtn = editPage.getByRole('button', { name: 'Regenerate scenario' });
    await editRegenBtn.waitFor({ state: 'visible', timeout: 5000 });
    await editRegenBtn.click();
    const editPreview = editPage.getByText('New scenario (preview)', { exact: false });
    await editPreview.waitFor({ state: 'visible', timeout: 5000 });

    let patchBody = null;
    await editPage.route(`**/api/games/*`, async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = JSON.parse(route.request().postData() || '{}');
      }
      await route.continue();
    });
    await editPage.getByRole('button', { name: 'Keep' }).click();
    await editPage.waitForTimeout(300);
    record('Keep replaces the Edit dialog name (untouched this session -> replaced)', await editNameField.inputValue() === REGEN_STORY_B.name,
      await editNameField.inputValue());

    // CodeRabbit finding: a fixed 600ms sleep before reading `patchBody` can
    // report FAIL on a stalled runner for a scheduling reason (the PATCH
    // simply hadn't been issued yet), not a real defect. Wait for the PATCH
    // response itself instead.
    const patchDone = editPage.waitForResponse(
      (r) => /\/api\/games\//.test(r.url()) && r.request().method() === 'PATCH',
      { timeout: 15000 },
    );
    await editPage.getByRole('button', { name: /^save changes$/i }).click();
    await patchDone.catch(() => null);
    record('the PATCH body never carries payoffs (the route the plan forbids)', !!patchBody && !('payoffs' in patchBody));
    record('the PATCH body carries the regenerated description', !!patchBody && patchBody.description === REGEN_STORY_B.description);
    // RED-REGEN/001 (CodeRabbit: exercise the REAL, user-reached case — this
    // game was saved with the "vendor"/"buyer" chips placed above through
    // the actual UI, while the mock supplies actor nouns). Keep must retain
    // those user chips while adding the actor terms — the old keepFill
    // unconditionally sent colorTermsA/B: [].
    record('RED-REGEN/001: a real, pre-existing chip on player A survives Regenerate -> Keep -> Save Changes',
      !!patchBody && Array.isArray(patchBody.colorTermsA) && patchBody.colorTermsA.includes('vendor'),
      JSON.stringify(patchBody?.colorTermsA));
    record('RED-REGEN/001: same for the pre-existing chip on player B',
      !!patchBody && Array.isArray(patchBody.colorTermsB) && patchBody.colorTermsB.includes('buyer'),
      JSON.stringify(patchBody?.colorTermsB));
    record('H1: Keep adds exactly the returned actor nouns alongside the real chips',
      !!patchBody && patchBody.colorTermsA.includes('A potter') && patchBody.colorTermsB.includes('a kiln co-op')
        && patchBody.colorTermsA.length === 2 && patchBody.colorTermsB.length === 2,
      JSON.stringify({ colorTermsA: patchBody?.colorTermsA, colorTermsB: patchBody?.colorTermsB }));
    await editPage.close();
  });

  // ══ 29. FEATURE-REGEN — double-click issues exactly one request, and
  //      focus/aria-live behave (a11y).
  section('29', 'regenerate double-click guard', 3, async () => {
    const dblPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    let hits = 0;
    await mockRegenOn(dblPage, async (route) => {
      hits++;
      await new Promise((r) => setTimeout(r, 400)); // slow enough for a second click to race it
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenario: REGEN_STORY_A }) });
    });
    await registerAndLogin(dblPage, 'e2e6regendbl');
    await dblPage.getByRole('button', { name: /save preset/i }).click();
    await dblPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    const dblRegenBtn = dblPage.getByRole('button', { name: 'Regenerate scenario' });
    await dblRegenBtn.waitFor({ state: 'visible', timeout: 5000 });

    // A REAL double-click / Enter-repeat is two clicks in the SAME JS tick,
    // both landing before the in-flight ref is set. Playwright's locator
    // `.click()` waits for the element to be "stable" (re-checks its
    // bounding box across frames) and RETRIES while the button's own text
    // flips to "Regenerating…" mid-click — so two `.click()` calls raced via
    // `Promise.all` do NOT land together: the plain click can be delayed
    // ~900ms by that retry loop, well past a short mock delay, so it lands
    // AFTER the first request already resolved and cleared the in-flight
    // ref — a false failure that was fixed by discovering this exact gap
    // (director-reproduced: a 400ms mock delay resolves before the retried
    // click fires at ~900ms, so the "second" click is really a legitimate
    // second request after the first one's preview is already showing).
    // Dispatch the native DOM `.click()` twice inside ONE `page.evaluate`
    // call instead: both calls run synchronously in the same JS task, so
    // React's synthetic click handler for the first click runs to
    // completion (setting the ref) before the second dispatch's handler
    // begins — the actual same-tick race the code guards against.
    await dblPage.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Regenerate scenario"]');
      if (!btn) throw new Error('Regenerate scenario button not found');
      btn.click();
      btn.click();
    });
    const liveRegionText = async () => dblPage.evaluate(() => {
      const nodes = [...document.querySelectorAll('[role="status"][aria-live="polite"]')];
      return nodes.map((n) => n.textContent || '').join(' | ');
    });
    let sawLoading = false;
    for (let i = 0; i < 10 && !sawLoading; i++) {
      sawLoading = /Regenerating/.test(await liveRegionText());
      if (!sawLoading) await dblPage.waitForTimeout(100);
    }
    record('the dialog\'s live region announces "Regenerating…" promptly', sawLoading);

    const dblPreview = dblPage.getByText('New scenario (preview)', { exact: false });
    await dblPreview.waitFor({ state: 'visible', timeout: 5000 });
    record('a double-click issues exactly ONE regenerate request', hits === 1, `hits=${hits}`);

    const focusInsideDialog = await dblPage.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="Save custom game"]');
      return !!dlg && dlg.contains(document.activeElement);
    });
    record('focus stays inside the dialog after clicking Regenerate', focusInsideDialog);

    let sawReady = false;
    for (let i = 0; i < 10 && !sawReady; i++) {
      sawReady = /ready/i.test(await liveRegionText());
      if (!sawReady) await dblPage.waitForTimeout(100);
    }
    record('the live region announces the scenario is ready', sawReady);
    await dblPage.close();
  });

  // ══ 30. FEATURE-REGEN — a stalled regenerate request recovers on its own
  //      with honest timeout wording. Real wall-clock wait past
  //      REPORT_FETCH_TIMEOUT_MS (22s normally; 5s in CI's e2e artifact —
  //      handleRegenerateScenario uses the SAME fetchWithTimeout default as
  //      /api/report, see §23's sibling check), because the defect class this
  //      guards is "nothing ever forces recovery".
  section('30', 'regenerate timeout wording', 3, async () => {
    const toPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    let toIntercepted = false;
    await mockRegenOn(toPage, async (route) => {
      toIntercepted = true;
      // Deliberately never fulfill — a genuinely hung request.
    });
    await registerAndLogin(toPage, 'e2e6regento');
    await toPage.getByRole('button', { name: /save preset/i }).click();
    await toPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    const toRegenBtn = toPage.getByRole('button', { name: 'Regenerate scenario' });
    await toRegenBtn.waitFor({ state: 'visible', timeout: 5000 });
    await toRegenBtn.click();
    await toPage.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Regenerate scenario');
      return btn?.getAttribute('aria-disabled') === 'true';
    }, null, { timeout: 5000 }).catch(() => {});
    record('the regenerate request was actually intercepted (precondition)', toIntercepted);

    // Poll for recovery rather than a flat sleep. A real regression (no
    // recovery at all) must time this loop out rather than pass on a stale
    // snapshot; CI's injected timeout only makes the positive transition
    // happen sooner.
    let recovered = null;
    for (let i = 0; i < 30 && !recovered; i++) {
      const state = await toPage.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Regenerate scenario');
        const note = Array.from(document.querySelectorAll('[role="status"][aria-live="polite"]')).map((n) => n.textContent || '').join(' | ');
        return btn ? { text: btn.textContent, ariaDisabled: btn.getAttribute('aria-disabled'), note } : null;
      });
      if (state && state.ariaDisabled !== 'true') recovered = state;
      else await toPage.waitForTimeout(1000);
    }
    record('the regenerate button un-sticks (re-enabled) after the configured timeout',
      !!recovered, JSON.stringify(recovered));
    record('the dialog shows the timeout-specific wording, not a generic failure message',
      /taking longer than expected/i.test(recovered?.note || ''), JSON.stringify(recovered));
    await toPage.close();
  });

  // ══ 31. FEATURE-REGEN — a 429 from the shared rate-limit bucket shows the
  //      server's own wording, and the button recovers immediately (no stuck
  //      "Regenerating…").
  section('31', 'regenerate 429 wording', 4, async () => {
    const rlPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await mockRegenOn(rlPage, async (route) => {
      await route.fulfill({
        status: 429, contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many attempts. Please wait a minute and try again.' }),
      });
    });
    await registerAndLogin(rlPage, 'e2e6regenrl');
    await rlPage.getByRole('button', { name: /save preset/i }).click();
    await rlPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    const rlRegenBtn = rlPage.getByRole('button', { name: 'Regenerate scenario' });
    await rlRegenBtn.waitFor({ state: 'visible', timeout: 5000 });
    await rlRegenBtn.click();

    let rlNote = '';
    for (let i = 0; i < 20 && !/ai limit reached/i.test(rlNote); i++) {
      rlNote = await rlPage.evaluate(() =>
        Array.from(document.querySelectorAll('[role="status"][aria-live="polite"]')).map((n) => n.textContent || '').join(' | '));
      if (!/ai limit reached/i.test(rlNote)) await rlPage.waitForTimeout(150);
    }
    record('a 429 shows the "AI limit reached" wording with the server\'s own message',
      /ai limit reached/i.test(rlNote) && /too many attempts/i.test(rlNote), rlNote);
    const rlDisabled = await rlPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Regenerate scenario');
      return btn?.getAttribute('aria-disabled');
    });
    record('the button is re-enabled (not stuck loading) after a 429', rlDisabled !== 'true', `aria-disabled=${rlDisabled}`);
    await rlPage.close();
  });

  // ══ 32. FEATURE-REGEN — cross-dialog staleness: Edit A's slow response
  //      must never land on Edit B.
  section('32', 'cross-dialog regeneration staleness', 4, async () => {
    const stalePage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await mockRegenOn(stalePage, async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenario: REGEN_STORY_A }) });
    });
    await registerAndLogin(stalePage, 'e2e6regenstale');
    // Save two distinct games to edit. The Save dialog's Name field is
    // located by its distinctive placeholder (it carries no htmlFor/id
    // label association — the existing convention in this suite, e.g. §24).
    for (const label of ['Stale Game A', 'Stale Game B']) {
      await stalePage.getByRole('button', { name: /save preset/i }).click();
      await stalePage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
      await stalePage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]').fill(label);
      await stalePage.getByRole('button', { name: /^save game profile$/i }).click();
      await stalePage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Save custom game"]'),
        null, { timeout: 5000 }).catch(() => {});
    }
    const editButtonFor = (name) => stalePage.getByRole('button', { name: new RegExp(`^Edit ${name}$`) });
    // The Edit dialog's Name field ALSO carries no label association. It is
    // the FIRST plain-text input in DOM order (Name, then Description as a
    // textarea, then the four Option Name inputs), so `.first()` on a plain
    // `input[type="text"]` selector is a stable, real selector here.
    // RED-APP-9/003 removed the native maxLength attribute this locator used
    // to key on (App.tsx's Name field is grapheme-safe-clamped via
    // onBeforeInput/onChange now instead of a bare `maxLength={40}`) — the
    // selector moves to the type attribute, which every one of the five text
    // inputs still carries, with position doing the disambiguating work
    // `maxlength` used to.
    const editNameField = () => stalePage.locator('[role="dialog"][aria-label="Edit saved game"] input[type="text"]').first();
    await editButtonFor('Stale Game A').click();
    await stalePage.waitForSelector('[role="dialog"][aria-label="Edit saved game"]', { timeout: 5000 });
    const staleRegenBtn = stalePage.getByRole('button', { name: 'Regenerate scenario' });
    await staleRegenBtn.waitFor({ state: 'visible', timeout: 5000 });
    // CodeRabbit finding: register the wait for A's (mocked, 3s-delayed)
    // regenerate RESPONSE before clicking — awaiting it explicitly after B
    // opens (instead of a flat sleep) proves the check exercises the actual
    // race (A's late response really did land) rather than passing merely
    // because a timer happened to be long enough.
    const staleRegenSettled = stalePage.waitForResponse(
      (r) => r.url().includes('/api/scenario/regenerate'), { timeout: 15000 },
    );
    // RED-APP-9 hardening: this promise is deliberately created here but not
    // awaited until several steps later (that's the whole point — it must
    // stay pending while B opens). If anything upstream stalls for the full
    // 15s before the real `.catch()` below is reached (a locator that no
    // longer matches anything is exactly this shape — found while landing
    // RED-APP-9/003, which changed what this dialog's Name input looks
    // like), the promise can reject with ZERO handler attached yet, and
    // Node's unhandled-rejection detector crashes the whole suite instead of
    // failing this one section's own assertions. An immediate no-op catch
    // makes this promise safe to leave floating for however long the steps
    // in between take, without changing what the real `.catch()` below
    // observes or how long IT waits.
    staleRegenSettled.catch(() => {});
    await staleRegenBtn.click();
    await stalePage.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Regenerate scenario');
      return btn?.getAttribute('aria-disabled') === 'true';
    }, null, { timeout: 5000 }).catch(() => {});
    // Close A (Escape) before its 3s response lands, open B.
    await stalePage.keyboard.press('Escape');
    await stalePage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Edit saved game"]'),
      null, { timeout: 5000 }).catch(() => {});
    await editButtonFor('Stale Game B').click();
    await stalePage.waitForSelector('[role="dialog"][aria-label="Edit saved game"]', { timeout: 5000 });
    const bNameBefore = await editNameField().inputValue();
    // Await A's response actually arriving (rather than a flat sleep) — the
    // race this check exists to prove is real only if A's late response has
    // genuinely landed by the time we look at B.
    await staleRegenSettled.catch(() => null);
    // The response event alone doesn't guarantee the resulting state update
    // (or lack thereof) has been applied/painted yet — a short settle window
    // after the awaited network event, not a substitute for it.
    await stalePage.waitForTimeout(300);
    const bNameAfter = await editNameField().inputValue();
    const bHasPreview = await stalePage.getByText('New scenario (preview)', { exact: false }).isVisible().catch(() => false);
    record('cross-dialog staleness: B\'s name field is untouched after A\'s late response would have landed',
      bNameBefore === bNameAfter && bNameAfter === 'Stale Game B', `before=${bNameBefore} after=${bNameAfter}`);
    record('cross-dialog staleness: A\'s late preview never rendered inside B', !bHasPreview);
    await stalePage.close();
  });

  // ══ 33. RED-APP-8/001 — a write-action 401 that clears the auth token
  //      (#101's own fix: updateAuthToken(null) so the app's state agrees
  //      with the server's) must never reopen the guided tour mid-session or
  //      touch the active game. The tour-open effect (App.tsx ~2936) used to
  //      be keyed only on `authToken` truthiness with no memory of "was this
  //      visitor ever signed in this session" — so the SAME transition #101
  //      introduced re-armed it for a visitor who had already been signed
  //      in, and the tour's first step swaps the board for the Prisoner's
  //      Dilemma preset, discarding whatever the user was looking at. Models
  //      the 401 with a route interception (byte-identical downstream code
  //      path to a real TTL expiry — `res.status === 401` is all the client
  //      reads) rather than waiting out AUTH_TOKEN_TTL_MS.
  section('33', 'expired-auth tour guard', 1, async () => {
    const tourPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await registerAndLogin(tourPage, 'e2e8tourreopen');
    record('control: a signed-in load does not auto-open the tour',
      !(await tourPage.locator('[role="dialog"][aria-label="Guided tour"]').isVisible({ timeout: 1500 }).catch(() => false)));

    const tourMatrix = tourPage.locator('input[inputmode="decimal"][class*="text-center"]');
    const myValues = ['9', '8', '7', '6', '5', '4', '3', '2']; // distinct from every preset, esp. PD's [3,3,0,5,5,0,1,1]
    const readMatrix = async () => {
      const out = [];
      for (let i = 0; i < 8; i++) out.push(await tourMatrix.nth(i).inputValue());
      return out;
    };
    for (let i = 0; i < 8; i++) { await tourMatrix.nth(i).fill(myValues[i]); await tourMatrix.nth(i).blur(); }
    // CodeRabbit: poll for the DOM to actually reflect the typed values
    // rather than a blind settle delay.
    await tourPage.waitForFunction((expected) => {
      const els = [...document.querySelectorAll('input[inputmode="decimal"].text-center, input[inputmode="decimal"][class*="text-center"]')];
      return els.length === expected.length && els.every((el, i) => el.value === expected[i]);
    }, myValues, { timeout: 5000 }).catch(() => {});

    const gameName = `TourReopenGame${Date.now()}`;
    await tourPage.getByRole('button', { name: /save preset/i }).click();
    await tourPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    await tourPage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]').fill(gameName);
    await tourPage.getByRole('button', { name: /^save game profile$/i }).click();
    await tourPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Save custom game"]'),
      null, { timeout: 5000 }).catch(() => {});
    // CodeRabbit: poll for the matrix to settle back to the saved values
    // (the dialog closing doesn't guarantee the surrounding re-render has
    // landed yet) rather than a blind settle delay.
    await tourPage.waitForFunction((expected) => {
      const els = [...document.querySelectorAll('input[inputmode="decimal"]')];
      return els.length === expected.length && els.every((el, i) => el.value === expected[i]);
    }, myValues, { timeout: 5000 }).catch(() => {});
    record('my saved game is showing my own matrix values, not a preset\'s',
      JSON.stringify(await readMatrix()) === JSON.stringify(myValues), JSON.stringify(await readMatrix()));

    // Force the NEXT PATCH to /api/games/:id to 401, regardless of the real
    // (valid) token the client sends — models a dead token without needing
    // to wait out a real TTL or know the server's per-process AUTH_SECRET.
    await tourPage.route('**/api/games/*', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid or expired session.' }) });
      } else {
        await route.continue();
      }
    });
    await tourPage.getByRole('button', { name: `Edit ${gameName}` }).click();
    await tourPage.waitForSelector('[role="dialog"][aria-label="Edit saved game"]', { timeout: 5000 });
    const patchDone401 = tourPage.waitForResponse(
      (r) => /\/api\/games\//.test(r.url()) && r.request().method() === 'PATCH', { timeout: 15000 });
    await tourPage.getByRole('button', { name: /^save changes$/i }).click();
    await patchDone401.catch(() => null);
    await tourPage.waitForFunction(() =>
      !!document.querySelector('[role="dialog"][aria-label="Edit saved game"] button')
      && Array.from(document.querySelectorAll('[role="dialog"][aria-label="Edit saved game"] button')).some((b) => /sign in.*sign up/i.test(b.textContent || '')),
      null, { timeout: 5000 }).catch(() => {});
    record('the 401 shows the Sign-In card inside the Edit dialog (#101\'s own fix, still working)',
      await tourPage.locator('[role="dialog"][aria-label="Edit saved game"]').getByRole('button', { name: /sign in.*sign up/i }).isVisible().catch(() => false));

    // Past the tour effect's 700ms timer.
    await tourPage.waitForTimeout(1500);
    record('RED-APP-8/001 fix: the guided tour did NOT reopen after the 401',
      !(await tourPage.locator('[role="dialog"][aria-label="Guided tour"]').isVisible({ timeout: 500 }).catch(() => false)));
    record('RED-APP-8/001 fix: my saved game\'s matrix is unchanged (not swapped for a preset)',
      JSON.stringify(await readMatrix()) === JSON.stringify(myValues), JSON.stringify(await readMatrix()));
    await tourPage.close();
  });

  // ══ 34. RED-APP-8/004 — a real QuotaExceededError thrown from
  //      localStorage.setItem('nash_sim_theme', ...) must not blank the
  //      page. That effect fires unconditionally on first mount (before
  //      anything else has painted), and with no error boundary anywhere in
  //      the app, an uncaught throw there took down the whole React tree —
  //      zero visible content, no way for a visitor to recover. Installed
  //      via addInitScript so the throwing storage is in place BEFORE the
  //      app's own JS ever runs, modeling "the browser already has no quota
  //      left" rather than something the app itself did — same technique
  //      the director's own repro used.
  section('34', 'storage-quota error boundary', 2, async () => {
    const quotaPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await quotaPage.addInitScript(() => {
      const real = window.localStorage.setItem.bind(window.localStorage);
      Object.defineProperty(window.localStorage, 'setItem', {
        value: (key, value) => {
          if (key === 'nash_sim_theme') {
            throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          }
          return real(key, value);
        },
        configurable: true,
      });
    });
    const quotaErrors = [];
    quotaPage.on('pageerror', (e) => quotaErrors.push(e.message));
    await quotaPage.goto(BASE, { waitUntil: 'networkidle' });
    await quotaPage.waitForTimeout(500);
    const bodyText = await quotaPage.evaluate(() => document.body.innerText || '');
    record('RED-APP-8/004 fix: the page still renders content when nash_sim_theme\'s setItem throws QuotaExceededError',
      bodyText.length > 0, `bodyText.length=${bodyText.length}`);
    // The safeStorage wrappers swallow the exception at its own call site —
    // it should never even reach an uncaught pageerror, let alone the error
    // boundary's fallback UI.
    record('RED-APP-8/004 fix: no uncaught page error from the quota-exceeded write',
      quotaErrors.length === 0, JSON.stringify(quotaErrors));
    // CodeRabbit: visibility alone proves nothing about the click HANDLER —
    // click the control and poll for the actual theme state (the `dark`
    // class on <html>, same signal section 12's own theme round-trip check
    // uses) to change from its baseline, so a broken handler (or a theme
    // state stuck by the same quota failure) still fails this check.
    const themeToggle = quotaPage.getByRole('button', { name: 'Toggle dark mode' }).first();
    const themeButtonVisible = await themeToggle.isVisible({ timeout: 2000 }).catch(() => false);
    let themeButtonWorks = false;
    if (themeButtonVisible) {
      const before = await quotaPage.evaluate(() => document.documentElement.classList.contains('dark'));
      await themeToggle.click();
      themeButtonWorks = await quotaPage.waitForFunction((wasDark) =>
        document.documentElement.classList.contains('dark') !== wasDark, before, { timeout: 3000 })
        .then(() => true).catch(() => false);
    }
    record('RED-APP-8/004 fix: the app is otherwise interactive (theme toggle click actually changes the theme state) after the quota failure',
      themeButtonWorks);
    await quotaPage.close();
  });

  // ══ 35. RED-APP-8/005 — the Account and Feedback dialogs must be reachable
  //      at a short (400%-zoom-equivalent) viewport. Save/Edit already had
  //      `max-h-[90vh] overflow-y-auto`; Account/Feedback didn't, so at
  //      320x256 (WCAG 1.4.10 Reflow's own floor) part of the dialog rendered
  //      above y=0 and part below the window, and being `position:fixed`, a
  //      real page scroll has ZERO effect on it — there was no path to the
  //      submit button at all. `.click()` here exercises the real thing a
  //      user needs: an actionable click, which Playwright only succeeds at
  //      by scrolling a genuine scrollable ANCESTOR into view (the dialog
  //      itself, post-fix) — there is no such ancestor pre-fix, so the click
  //      times out instead of silently "succeeding" through some shortcut.
  section('35', 'short-viewport dialogs', 3, async () => {
    const shortPage = await newTrackedPage({ viewport: { width: 320, height: 256 } });
    // NOTE: no page-wide setDefaultTimeout override here — the two
    // reachability clicks below already pass their own explicit
    // {timeout: 30000} (30 s, not 5: the 5 s budget flaked on the 2-core CI
    // runner — 102/103 on main's first attempt, 2026-09-03 — while the
    // discriminator does not depend on the budget at all: on the unfixed
    // tree there is NO scrollable ancestor, so the click can never become
    // actionable at any timeout), which is what needs to fail on the unfixed
    // tree; a global override also throttled THIS page's own navigation,
    // which can legitimately take longer than 6s once ~30 prior e2e
    // sections have left other pages/contexts open.
    await shortPage.goto(BASE, { waitUntil: 'networkidle' });
    // The tour auto-opens ~700 ms after mount on every anonymous load, and on
    // the 2-core CI runner that can be AFTER `networkidle` resolves. The old
    // `isVisible({ timeout: 3000 })` check does NOT wait, so on a slow runner
    // it read "no tour" too early; the tour then opened over this page in the
    // middle of the checks below (it also unmounts the feedback launcher), and
    // they failed 3 times in 4 CI attempts on 2026-09-03 while passing every
    // time locally. Dismiss it the way gotoHome()/dismissTour() do: wait for
    // the viewport-anchored Exit button, click it, and assert the tour is gone.
    // A failed Exit click is NOT evidence that the tour is absent (CodeRabbit):
    // the tour dialog itself decides. Escape is the fallback dismissTour() uses,
    // and a tour that survives both is recorded as a failed precondition rather
    // than silently left on top of the checks below.
    const exitTourShort = shortPage.locator('[aria-label="Exit tour"]');
    try { await exitTourShort.click({ timeout: 20000 }); } catch { /* decided by the dialog below */ }
    let shortTourGone = await shortPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
      null, { timeout: 5000 }).then(() => true).catch(() => false);
    if (!shortTourGone) {
      await shortPage.keyboard.press('Escape');
      shortTourGone = await shortPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
        null, { timeout: 10000 }).then(() => true).catch(() => false);
    }
    record('320x256 precondition: the guided tour is dismissed (or never opened) before the reachability checks', shortTourGone);

    await shortPage.getByRole('button', { name: /sign in.*sign up/i }).first().click();
    await shortPage.waitForSelector('[role="dialog"][aria-label="Account"]', { timeout: 5000 });
    // MUTATION-TEST FINDING: the "Login" submit button's own vertical
    // position in the (short, login-mode) form happens to land inside a
    // 256px viewport even on the UNFIXED tree (the dialog centers itself,
    // so the overflow above/below is roughly symmetric and this particular
    // button's offset from the dialog's own top isn't large enough to push
    // it below y=256) -- so it does not reliably discriminate fixed from
    // unfixed here. The dialog's OWN close button, right at its top edge
    // (the dialog's top sits at y=-109 on the unfixed tree, confirmed by
    // direct measurement), does: it is reliably off-screen pre-fix and
    // reliably reachable post-fix, regardless of which form mode is open.
    const accountClose = shortPage.locator('[role="dialog"][aria-label="Account"]').getByRole('button', { name: 'Close dialog' });
    let accountReachable = true;
    let accountErr = '';
    // Keep the click's own reason: a FAIL that says "undefined" told nobody
    // whether the runner timed out, the element vanished, or something sat on
    // top of it (2026-09-03, four CI attempts).
    try { await accountClose.click({ timeout: 30000 }); } catch (e) { accountReachable = false; accountErr = String(e?.message ?? e).split('\n')[0]; }
    record('RED-APP-8/005 fix: the Account dialog\'s own close button is reachable at 320x256', accountReachable, accountReachable ? undefined : accountErr);
    // Whatever the click did, leave no Account dialog behind: the Feedback
    // check must stand on its own. On a tree where this check fails, the
    // still-open modal used to swallow the feedback launcher click below as an
    // unguarded 30 s script error and abort every later section.
    if (await shortPage.locator('[role="dialog"][aria-label="Account"]').count()) {
      await shortPage.keyboard.press('Escape');
    }
    // CodeRabbit: poll for the Account dialog to actually close (the count()
    // above is only a snapshot and Escape has no completion signal), and
    // RECORD a cleanup failure instead of swallowing it — a Feedback FAIL
    // caused by a still-open Account modal must say so.
    const accountGone = await shortPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Account"]'),
      null, { timeout: 5000 }).then(() => true).catch(() => false);
    record('320x256 cleanup: the Account dialog is closed before the Feedback check', accountGone,
      accountGone ? undefined : 'Account dialog still open 5 s after the close click / Escape');

    // Stub the feedback POST — untested-controls.json's own policy for this
    // control is "never actually send real email through SMTP"; this test is
    // about the submit BUTTON's reachability (the RED-APP-8/005 defect), not
    // the feedback route, so the real network call is intercepted rather
    // than reaching the server.
    await shortPage.route('**/api/feedback', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    const feedbackSubmit = shortPage.locator('[role="dialog"][aria-label="Send feedback"]').getByRole('button', { name: /send feedback/i });
    let feedbackReachable = true;
    let feedbackErr = '';
    try {
      // The launcher is part of the check, with its own budget: it is hidden
      // while the tour is open, so a script error here would have meant "the
      // tour came back", which this check should REPORT, not abort on.
      await shortPage.getByRole('button', { name: /send feedback/i }).first().click({ timeout: 10000 });
      await shortPage.waitForSelector('[role="dialog"][aria-label="Send feedback"]', { timeout: 5000 });
      await feedbackSubmit.click({ timeout: 30000 });
    } catch (e) { feedbackReachable = false; feedbackErr = String(e?.message ?? e).split('\n')[0]; }
    record('RED-APP-8/005 fix: the Feedback dialog\'s submit button is reachable at 320x256', feedbackReachable, feedbackReachable ? undefined : feedbackErr);
    await shortPage.close();
  });

  // ══ 36. RED-APP-8/002 — the label inputs' grapheme-safe clamp (#101, RED-
  //      APP-7/004) must never fight an open IME composition. A native
  //      `input` event fires on EVERY keystroke of an open composition, not
  //      just on commit, so clamping unconditionally in `onChange` used to
  //      desync the DOM value from the IME's own growing composing buffer
  //      the moment it crossed 40 units. Dispatches a REAL composition
  //      sequence — native value setter + InputEvent(insertCompositionText,
  //      isComposing:true) per keystroke, matching how
  //      @testing-library/user-event drives React's own composition
  //      detection (which reads exactly `e.nativeEvent.isComposing`).
  section('36', 'IME-safe label clamp', 4, async () => {
    const imePage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await registerAndLogin(imePage, 'e2e8ime');
    await imePage.getByRole('button', { name: /save preset/i }).click();
    await imePage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    const row1Input = imePage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder^="e.g. Undercut"]');
    await row1Input.click();

    // 45 CJK characters, one UTF-16 unit each — 5 past the 40-unit budget,
    // never committed (compositionend) until the very last step.
    const composedChars = ('国际关系与地区安全合作机制建设的历史沿革与展望研究' + '究究究究究究究究究究究究究究究究究究究究').split('');
    const info = await imePage.evaluate(async (chars) => {
      const input = document.activeElement;
      if (!input || input.tagName !== 'INPUT') return { error: 'no focused input' };
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      let composing = '';
      const snapshots = [];
      for (let i = 0; i < chars.length; i++) {
        composing += chars[i];
        nativeSetter.call(input, composing);
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true, cancelable: false, composed: true,
          inputType: 'insertCompositionText', data: composing, isComposing: true,
        }));
        snapshots.push({ i, composingLenIntended: composing.length, domValueLen: input.value.length });
      }
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: composing }));
      nativeSetter.call(input, composing);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: false, composed: true,
        inputType: 'insertCompositionText', data: composing, isComposing: false,
      }));
      await new Promise((r) => setTimeout(r, 50));
      return { snapshots, domValueFinal: input.value, domValueFinalLen: input.value.length, fullComposedLen: composing.length };
    }, composedChars);

    if (info.error) {
      record('RED-APP-8/002: an input was focused for the composition test', false, info.error);
    } else {
      const midCompositionClamped = info.snapshots.some((s) => s.composingLenIntended > 40 && s.domValueLen < s.composingLenIntended);
      record('RED-APP-8/002 fix: the DOM value is NEVER clamped while still composing (isComposing=true)',
        !midCompositionClamped,
        midCompositionClamped ? JSON.stringify(info.snapshots.filter((s) => s.domValueLen < s.composingLenIntended).slice(0, 3)) : 'no clamp seen during composition');
      record('RED-APP-8/002 fix: the final COMMITTED value (post-compositionend) is clamped to <=40 UTF-16 units',
        info.domValueFinalLen <= 40, `len=${info.domValueFinalLen}`);
      record('RED-APP-8/002 fix: the final committed value is NOT the full 45-character composition (the clamp really ran on commit)',
        info.domValueFinal !== '国际关系与地区安全合作机制建设的历史沿革与展望研究究究究究究究究究究究究究究究究究究究究究');
    }
    await imePage.close();
  });

  // ══ 37. RED-APP-8/003 — the FIRST time the label-input clamp actually
  //      narrows a value, native Undo (Cmd/Ctrl+Z) must not go permanently
  //      inert for that field. Types real keystrokes (not synthetic DOM
  //      events) past the 40-unit budget, then presses Undo repeatedly and
  //      confirms the value actually changes at least once (the pre-fix
  //      behaviour: 50 presses, zero change, ever).
  section('37', 'label-clamp undo', 4, async () => {
    const undoPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await registerAndLogin(undoPage, 'e2e8undo');
    await undoPage.getByRole('button', { name: /save preset/i }).click();
    await undoPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    const row1Input = undoPage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder^="e.g. Undercut"]');
    await row1Input.click();
    await row1Input.fill('');
    await undoPage.keyboard.type('AAAAAAAAAA', { delay: 20 }); // 10 chars, well under 40
    for (let i = 0; i < 35; i++) {
      await undoPage.keyboard.type('B', { delay: 25 }); // one keystroke at a time, crossing the 40-unit budget
    }
    const afterOverflow = await row1Input.inputValue();
    record('RED-APP-8/003 fixture sanity: typed value is clamped to 40 units', afterOverflow.length === 40, `len=${afterOverflow.length}`);

    const isMac = process.platform === 'darwin';
    const history = [];
    for (let i = 0; i < 40; i++) {
      await undoPage.keyboard.press(isMac ? 'Meta+z' : 'Control+z');
      await undoPage.waitForTimeout(40);
      history.push(await row1Input.inputValue());
    }
    const everChanged = new Set(history).size > 1;
    record('RED-APP-8/003 fix: native Undo actually changes the value at least once after a clamp fired (was PERMANENTLY inert pre-fix)',
      everChanged, everChanged ? `${new Set(history).size} distinct values over 40 presses` : `stuck at "${history[0]}"`);

    // Control: a field the clamp never touched (the Name field, well under
    // 40 chars) undoes normally — proves undo is not broken everywhere, only
    // isolating this to the moment the clamp actually narrowed a value.
    const nameField = undoPage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]');
    await nameField.click();
    await nameField.fill('');
    await undoPage.keyboard.type('short', { delay: 20 });
    await undoPage.keyboard.press(isMac ? 'Meta+z' : 'Control+z');
    await undoPage.waitForTimeout(80);
    const controlAfterUndo = await nameField.inputValue();
    record('control: an unclamped field\'s undo works normally', controlAfterUndo !== 'short' && controlAfterUndo.length < 5,
      `"${controlAfterUndo}"`);
    await undoPage.close();
  });

  // ══ 38. RED-APP-9/001 — a 404 from PATCH/DELETE /api/games/:id is
  //      authoritative: another tab (or device, or profile) deleting a saved
  //      game must not leave a permanent phantom row in THIS tab's list.
  //      Two pages in one context = one browser, two tabs, same localStorage/
  //      auth token — exactly the red's repro shape. DELETE path: delete in
  //      B, then Delete-of-the-same-game in A must remove the row with no
  //      reload. PATCH path (isolated on a second saved game, so the DELETE
  //      assertions above can't leak into it): Edit dialog open in A, delete
  //      in B, submit in A -> dialog shows the error, row is already gone
  //      underneath, and Cancel closes cleanly (no reload needed either).
  section('38', 'phantom saved-game row after a 404', 1, async () => {
    const twoTabContext = await browser.newContext();
    const tabA = trackPage(await twoTabContext.newPage());
    const tabB = trackPage(await twoTabContext.newPage());
    try {
      const uniq = await registerAndLogin(tabA, 'e9ph');

      // ── DELETE path ──
      const deleteGameName = `PDel-${uniq}`;
      await tabA.getByRole('button', { name: /save preset/i }).click();
      await tabA.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 12000 });
      await tabA.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]').fill(deleteGameName);
      await tabA.getByRole('dialog', { name: 'Save custom game' }).getByRole('button', { name: /save game profile/i }).click();
      await tabA.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Save custom game"]'), null, { timeout: 12000 });

      await tabB.goto(BASE, { waitUntil: 'networkidle' });
      const exitTourB = tabB.getByRole('button', { name: /exit tour/i });
      if (await exitTourB.isVisible({ timeout: 3000 }).catch(() => false)) await exitTourB.click();
      await tabB.waitForTimeout(500);
      const rowB = tabB.getByRole('button', { name: deleteGameName, exact: true });
      await rowB.waitFor({ state: 'visible', timeout: 12000 });
      await tabB.locator('div.group', { has: rowB }).getByTitle('Delete this saved game').click();
      await tabB.waitForFunction((n) => ![...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === n), deleteGameName, { timeout: 12000 });

      const rowA = tabA.getByRole('button', { name: deleteGameName, exact: true });
      record('tab A: row still shown before acting on it (no polling, expected stale)', await rowA.isVisible({ timeout: 4000 }).catch(() => false));
      let dialogMsg = null;
      tabA.once('dialog', async (d) => { dialogMsg = d.message(); await d.accept(); });
      await tabA.locator('div.group', { has: rowA }).getByTitle('Delete this saved game').click();
      // State-based wait (CodeRabbit, #119): the row leaves the DOM only after the
      // 404 handler has alerted (alert() blocks until accepted) and re-rendered,
      // so "row hidden" is the completion signal for both checks below.
      const rowGoneA = await rowA.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true).catch(() => false);
      record('tab A: 404 shows the friendly "deleted elsewhere" message, not a bare "not found"',
        /deleted elsewhere/i.test(dialogMsg || ''), `alert="${dialogMsg}"`);
      record('FIX: phantom row removed from tab A after the server confirms 404 (no reload)', rowGoneA);
      const tokenAfterDelete = await tabA.evaluate(() => localStorage.getItem('nash_sim_token_local') || localStorage.getItem('nash_sim_token_cloud') || localStorage.getItem('nash_sim_token'));
      record('tab A: auth token not cleared by a 404 (only a 401 should clear it)', !!tokenAfterDelete);

      // ── PATCH path (a second, independent saved game) ──
      const editGameName = `PEdit-${uniq}`;
      await tabA.getByRole('button', { name: /save preset/i }).click();
      await tabA.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 12000 });
      await tabA.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]').fill(editGameName);
      await tabA.getByRole('dialog', { name: 'Save custom game' }).getByRole('button', { name: /save game profile/i }).click();
      await tabA.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Save custom game"]'), null, { timeout: 12000 });

      const rowAEdit = tabA.getByRole('button', { name: editGameName, exact: true });
      await tabA.locator('div.group', { has: rowAEdit }).getByTitle(/^Edit /).click();
      await tabA.waitForSelector('[role="dialog"][aria-label="Edit saved game"]', { timeout: 12000 });

      await tabB.reload({ waitUntil: 'networkidle' });
      const exitTourB2 = tabB.getByRole('button', { name: /exit tour/i });
      if (await exitTourB2.isVisible({ timeout: 3000 }).catch(() => false)) await exitTourB2.click();
      await tabB.waitForTimeout(500);
      const rowBEdit = tabB.getByRole('button', { name: editGameName, exact: true });
      await rowBEdit.waitFor({ state: 'visible', timeout: 12000 });
      await tabB.locator('div.group', { has: rowBEdit }).getByTitle('Delete this saved game').click();
      await tabB.waitForFunction((n) => ![...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === n), editGameName, { timeout: 12000 });

      const descField = tabA.locator('[role="dialog"][aria-label="Edit saved game"] textarea').first();
      await descField.fill('Edited after the other tab deleted the underlying game.');
      await tabA.getByRole('dialog', { name: 'Edit saved game' }).getByRole('button', { name: /save changes/i }).click();
      await tabA.locator('[role="dialog"][aria-label="Edit saved game"]').getByText(/deleted elsewhere/i)
        .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      const editErrorText = await tabA.locator('[role="dialog"][aria-label="Edit saved game"]').innerText().catch(() => '');
      record('tab A: PATCH-on-deleted shows the friendly message inside the still-open dialog', /deleted elsewhere/i.test(editErrorText));
      record('FIX: phantom row already gone from tab A\'s list BEFORE Cancel is even clicked',
        !(await tabA.getByRole('button', { name: editGameName, exact: true }).isVisible({ timeout: 2000 }).catch(() => false)));

      const cancelBtn = tabA.getByRole('dialog', { name: 'Edit saved game' }).getByRole('button', { name: /cancel/i });
      await cancelBtn.click();
      await tabA.waitForTimeout(300);
      record('Cancel closes the dialog cleanly after the 404',
        !(await tabA.locator('[role="dialog"][aria-label="Edit saved game"]').isVisible({ timeout: 2000 }).catch(() => false)));
      record('FIX: row still gone from tab A\'s list after Cancel, with no reload',
        !(await tabA.getByRole('button', { name: editGameName, exact: true }).isVisible({ timeout: 2000 }).catch(() => false)));
    } finally {
      await twoTabContext.close();
    }
  });

  // ══ 39. RED-APP-9/002 — a dropped response after a successful Save must
  //      not create a silent duplicate on retry. route.fetch() really sends
  //      the request (the server writes the row); route.abort() drops the
  //      RESPONSE before the page's own fetch() resolves, modeling a flaky
  //      connection precisely. The client-minted clientRequestId is the same
  //      on the retry, so the server must recognize it and return the
  //      original row rather than creating a second one.
  section('39', 'network-flap save does not duplicate', 2, async () => {
    const flapPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    const flapConsoleErrors = [];
    flapPage.on('console', (m) => { if (m.type() === 'error') flapConsoleErrors.push(m.text()); });
    flapPage.on('pageerror', (e) => flapConsoleErrors.push(String(e)));

    const uniq = await registerAndLogin(flapPage, 'e9flap');
    const gameName = `Flap-${uniq}`;

    await flapPage.getByRole('button', { name: /save preset/i }).click();
    await flapPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    await flapPage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]').fill(gameName);

    let flapped = false;
    await flapPage.route('**/api/games', async (route) => {
      if (route.request().method() !== 'POST' || flapped) return route.continue();
      flapped = true;
      await route.fetch(); // really creates the game server-side
      await route.abort('connectionreset'); // client never sees the 200
    });

    await flapPage.getByRole('dialog', { name: 'Save custom game' }).getByRole('button', { name: /save game profile/i }).click();
    await flapPage.locator('[role="dialog"][aria-label="Save custom game"]').getByText(/network error/i)
      .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const errorShown = await flapPage.locator('[role="dialog"][aria-label="Save custom game"]').innerText().catch(() => '');
    record('after the flap: dialog shows a network-error message (not a false success)', /network error/i.test(errorShown), errorShown.slice(0, 200));
    const nameFieldValue = await flapPage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]').inputValue().catch(() => '');
    record('typed game name survived the flap unchanged (retry uses the preserved text)', nameFieldValue === gameName, `got "${nameFieldValue}"`);

    // Retry: route.continue() from here on (flapped=true), so this really
    // reaches the server — with the SAME clientRequestId as the dropped one.
    // The user edits the name first: the retry must then UPDATE the row the
    // dropped write created (one row, carrying the edited name) — neither a
    // duplicate nor the stale original coming back (director probe 2026-09-05).
    const editedName = `${gameName}-v2`;
    await flapPage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]').fill(editedName);
    await flapPage.getByRole('dialog', { name: 'Save custom game' }).getByRole('button', { name: /save game profile/i }).click();
    const dialogClosedAfterRetry = await flapPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Save custom game"]'),
      null, { timeout: 8000 }).then(() => true).catch(() => false);
    record('retry succeeds (dialog closes)', dialogClosedAfterRetry);

    const authToken = await flapPage.evaluate(() => localStorage.getItem('nash_sim_token_local') || localStorage.getItem('nash_sim_token_cloud'));
    const listResp = await flapPage.evaluate(async (t) => {
      const r = await fetch('/api/games', { headers: { Authorization: `Bearer ${t}` } });
      return r.json();
    }, authToken);
    const staleRows = listResp.filter((g) => g.name === gameName);
    const serverRows = listResp.filter((g) => g.name === editedName);
    record('FIX: server holds exactly ONE game for this attempt, carrying the EDITED name (dropped write + retry deduped AND updated)',
      serverRows.length === 1 && staleRows.length === 0,
      `edited=${serverRows.length} stale=${staleRows.length}, ids=${serverRows.map((g) => g.id).join(',')}`);

    await flapPage.reload({ waitUntil: 'networkidle' });
    // Poll rather than a fixed sleep: a fresh reload re-runs the
    // auth/me + games fetch effects from scratch, which can take longer
    // than a short sleep on a busy CI runner.
    await flapPage.getByRole('button', { name: editedName, exact: true }).first()
      .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const uiCountAfterReload = await flapPage.getByRole('button', { name: editedName, exact: true }).count();
    const staleUiCount = await flapPage.getByRole('button', { name: gameName, exact: true }).count();
    record('FIX: exactly one row (the edited name) visible after a reload too — no duplicate, no stale name reaches the user',
      uiCountAfterReload === 1 && staleUiCount === 0, `edited=${uiCountAfterReload} stale=${staleUiCount}`);

    record('no console errors through the flap+retry sequence (net::ERR_CONNECTION_RESET is expected browser noise, filtered)',
      flapConsoleErrors.filter((t) => !/ERR_CONNECTION_RESET/.test(t)).length === 0,
      flapConsoleErrors.join(' | '));
    await flapPage.close();
  });

  // ══ 40. RED-APP-9/003 — the Game Name and Description fields (both
  //      dialogs) must clamp grapheme-safely, the same as the four
  //      option-label inputs (#101/#105): reusing the exact
  //      onBeforeInput/onChange/onCompositionEnd wiring (App.tsx's
  //      clampLabelBeforeInput/clampLabelInput for Name; the equivalent in
  //      DescriptionEditor.tsx for Description) means an insertion that
  //      would push the field over budget is rejected WHOLESALE (never
  //      truncated mid-cluster) — a real behavioral difference from the
  //      native `maxLength` this replaces, which used to truncate AT the
  //      boundary and could split a grapheme cluster in half. Two shapes per
  //      field: a real clipboard paste of one whole grapheme cluster (a ZWJ
  //      family emoji, 11 UTF-16 units — what an emoji picker inserts in one
  //      shot, same as this app's own IME-composition-commit handling) that
  //      lands EXACTLY at the budget must appear intact; one unit further
  //      over budget must be rejected outright, leaving the pre-existing
  //      text unchanged and never a dangling ZWJ/surrogate.
  section('40', 'Name/Description grapheme-safe paste clamp', 3, async () => {
    const familyEmoji = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}'; // 👨‍👩‍👧‍👦, 11 UTF-16 units
    const endsUgly = (s) => /\u{200D}$/u.test(s) || /[\uD800-\uDBFF]$/.test(s);

    async function pasteAtEnd(p, locator, text) {
      await locator.click();
      await p.evaluate(() => {
        const el = document.activeElement;
        if (el && 'selectionStart' in el) el.setSelectionRange(el.value.length, el.value.length);
      });
      await p.evaluate((t) => navigator.clipboard.writeText(t), text);
      const isMac = process.platform === 'darwin';
      await p.keyboard.press(isMac ? 'Meta+V' : 'Control+V');
      await p.waitForTimeout(250);
    }

    // Fills with `fill()` (a direct value set through onChange, not
    // onBeforeInput — matches how a real "type a bunch of plain characters"
    // history would leave the field, without needing hundreds of individual
    // keystrokes) then pastes the family-emoji cluster AT THE END, once at a
    // width where the total lands exactly at budget (must appear intact)
    // and once one unit further over (must be rejected wholesale).
    async function checkClampedField(p, locator, filler, budget, label) {
      await locator.fill(filler.repeat(budget - familyEmoji.length)); // total after paste == budget exactly
      await pasteAtEnd(p, locator, familyEmoji);
      const fits = await locator.inputValue();
      record(`FIX: ${label} — a whole grapheme cluster landing exactly at the budget appears intact`,
        fits.length === budget && fits.endsWith(familyEmoji), `len=${fits.length} tail=${JSON.stringify(fits.slice(-12))}`);
      record(`${label} — never ends in a lone ZWJ/surrogate when it fits`, !endsUgly(fits), JSON.stringify(fits.slice(-8)));

      await locator.fill(filler.repeat(budget - familyEmoji.length + 1)); // one unit further: total would be budget+1
      const before = await locator.inputValue();
      await pasteAtEnd(p, locator, familyEmoji);
      const rejected = await locator.inputValue();
      record(`FIX: ${label} — an insertion that would exceed the budget is rejected wholesale, not truncated mid-cluster`,
        rejected === before, `before=${JSON.stringify(before.slice(-8))} after=${JSON.stringify(rejected.slice(-8))}`);
      record(`${label} — never ends in a lone ZWJ/surrogate when the paste is rejected`, !endsUgly(rejected), JSON.stringify(rejected.slice(-8)));
    }

    const grContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      const grPage = trackPage(await grContext.newPage());
      await registerAndLogin(grPage, 'e9gr');

      // ── Save dialog ──
      await grPage.getByRole('button', { name: /save preset/i }).click();
      await grPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
      const saveNameField = grPage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]');
      await checkClampedField(grPage, saveNameField, 'A', 40, 'Save dialog Name field');
      const finalSaveName = 'A'.repeat(40 - familyEmoji.length) + familyEmoji;
      await saveNameField.fill(finalSaveName); // leave it in the intact, saveable state for the submit below

      const saveDescField = grPage.locator('[role="dialog"][aria-label="Save custom game"] textarea').first();
      await checkClampedField(grPage, saveDescField, 'B', 800, 'Save dialog Description field');
      const finalSaveDesc = 'B'.repeat(800 - familyEmoji.length) + familyEmoji;
      await saveDescField.fill(finalSaveDesc);

      await grPage.getByRole('dialog', { name: 'Save custom game' }).getByRole('button', { name: /save game profile/i }).click();
      await grPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Save custom game"]'), null, { timeout: 5000 });

      const authToken = await grPage.evaluate(() => localStorage.getItem('nash_sim_token_local') || localStorage.getItem('nash_sim_token_cloud'));
      const list = await grPage.evaluate(async (t) => {
        const r = await fetch('/api/games', { headers: { Authorization: `Bearer ${t}` } });
        return r.json();
      }, authToken);
      const saved = list.find((g) => g.name === finalSaveName);
      record('the server-stored name carries the intact grapheme cluster (not a client-mangled half-emoji)',
        saved?.name === finalSaveName, `stored=${JSON.stringify(saved?.name?.slice(-12))}`);
      record('the server-stored description carries the intact grapheme cluster',
        saved?.description === finalSaveDesc, `stored tail=${JSON.stringify(saved?.description?.slice(-12))}`);

      // ── Edit dialog (same saved game) ──
      const savedId = saved?.id;
      const rowBtn = grPage.getByRole('button', { name: finalSaveName, exact: true });
      await grPage.locator('div.group', { has: rowBtn }).getByTitle(/^Edit /).click();
      await grPage.waitForSelector('[role="dialog"][aria-label="Edit saved game"]', { timeout: 5000 });
      const editNameField = grPage.locator('[role="dialog"][aria-label="Edit saved game"] input').first();
      await checkClampedField(grPage, editNameField, 'A', 40, 'Edit dialog Name field');

      const editDescField = grPage.locator('[role="dialog"][aria-label="Edit saved game"] textarea').first();
      await checkClampedField(grPage, editDescField, 'B', 800, 'Edit dialog Description field');

      await grPage.getByRole('dialog', { name: 'Edit saved game' }).getByRole('button', { name: /cancel/i }).click();
      if (savedId) {
        await grPage.evaluate(async ({ id, t }) => {
          await fetch(`/api/games/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } });
        }, { id: savedId, t: authToken });
      }
    } finally {
      await grContext.close();
    }
  });

  // ══ 41. RED-APP-9/004 — print stylesheet. Deterministic: under
  //      `page.emulateMedia({ media: 'print' })`, NOTHING on the page may
  //      compute to `position: fixed`/`sticky` (the red's own probe6d found
  //      exactly two such elements pre-fix: the header and the bottom-left
  //      Feedback launcher — both now reset/hidden under `@media print` in
  //      src/index.css) — fails on the unfixed tree, where the header's own
  //      `sticky top-0` survives untouched. Plus the red's own page.pdf()
  //      smoke: a real PDF, non-empty, no exception, run mid-simulation
  //      exactly as the red's probe6b did.
  section('41', 'print stylesheet', 4, async () => {
    const printPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    const exitTour = printPage.getByRole('button', { name: /exit tour/i });
    await printPage.goto(BASE, { waitUntil: 'networkidle' });
    if (await exitTour.isVisible({ timeout: 3000 }).catch(() => false)) await exitTour.click();
    await printPage.waitForTimeout(500);
    const runBtn = printPage.getByRole('button', { name: /^run$/i });
    if (await runBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await runBtn.click();
      await printPage.waitForTimeout(2000);
    }

    await printPage.emulateMedia({ media: 'print' });
    await printPage.waitForTimeout(300);
    const stickyOrFixed = await printPage.evaluate(() => Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        const p = getComputedStyle(el).position;
        return p === 'fixed' || p === 'sticky';
      })
      .map((el) => ({ tag: el.tagName, cls: el.className.toString().slice(0, 80), pos: getComputedStyle(el).position })));
    record('FIX: no element computes position:fixed/sticky under print media',
      stickyOrFixed.length === 0, JSON.stringify(stickyOrFixed));

    const headerPosition = await printPage.evaluate(() => {
      const h = document.querySelector('header');
      return h ? getComputedStyle(h).position : null;
    });
    record('FIX: the header specifically is not position:sticky under print media',
      headerPosition !== 'sticky', `headerPosition=${headerPosition}`);

    // The red's own page.pdf() smoke, unchanged: a real PDF is produced,
    // non-empty, no thrown exception — print media is reset by page.pdf()
    // itself (Chromium always renders print output under print media), so
    // this exercises the exact same stylesheet as the assertions above.
    let pdfBytes = 0;
    let pdfThrew = null;
    try {
      const pdf = await printPage.pdf({ format: 'A4', printBackground: true });
      pdfBytes = pdf.length;
    } catch (e) {
      pdfThrew = String(e?.message ?? e);
    }
    record('page.pdf() produces a non-empty PDF with no exception', pdfThrew === null && pdfBytes > 1000,
      pdfThrew ?? `bytes=${pdfBytes}`);

    await printPage.close();
  });

  // ══ 42. RED-DESKTOP-9/002 -- a comma in a payoff cell is REJECTED, not
  //      reinterpreted as a decimal separator and not silently truncated to
  //      its leading digits (bare parseFloat made "3,5" -> 3). Repro from the
  //      finding: type "3,5" into a cell and blur -- pre-fix, the cell read
  //      "3" with no error, no border, no toast, and the solver silently used
  //      3. Post-fix, the cell must keep its PREVIOUS value and a hint must
  //      say why, the same treatment any other unparseable text gets.
  section('42', 'comma-decimal payoff input rejected', 1, async () => {
    // A DEDICATED page: this section's id (42) is not a primaryPageSection
    // (id <= 16), so the harness never calls gotoHome() for it when it is
    // selected on its own (E2E_SECTION=42) -- the shared `page` may still be
    // on about:blank. Every other section past id 16 opens its own page for
    // the same reason; this one dismisses the tour itself rather than
    // relying on gotoHome(), matching section 35's pattern.
    const commaPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await commaPage.goto(BASE, { waitUntil: 'networkidle' });
    try { await commaPage.locator('[aria-label="Exit tour"]').click({ timeout: 20000 }); } catch { /* decided below */ }
    let tourGone = await commaPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
      null, { timeout: 5000 }).then(() => true).catch(() => false);
    if (!tourGone) {
      await commaPage.keyboard.press('Escape');
      tourGone = await commaPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
        null, { timeout: 10000 }).then(() => true).catch(() => false);
    }
    record('precondition: the guided tour is dismissed before the matrix checks below', tourGone);

    const matrixSelector = 'input[inputmode="decimal"][class*="text-center"]';
    const matrix = commaPage.locator(matrixSelector);
    const payoffHint = commaPage.locator('[data-testid="payoff-input-hint"]');
    const HINT_TEXT = 'Use a dot for decimals, not a comma.';
    await matrix.first().waitFor({ state: 'visible', timeout: 20000 });

    // Start from a KNOWN preset so the game-state checks have a fixed
    // reference: Prisoners Dilemma, whose B(1,1) payoff is 3. The first
    // version of this section relied on whatever the page happened to hold
    // and typed "3,5" into a cell that already held 3 — so the leading "3"
    // committing through the ordinary path was invisible, and the check
    // passed against a fix that did not work. Two guards below make that
    // impossible now: the fixture asserts the pre-edit value DIFFERS from the
    // typed leading digit, and the game is read from the Expected-Payoff
    // panel (computed from the solver's payoffs), not from the input box.
    const pdButton = commaPage.getByRole('button', { name: 'Prisoners Dilemma', exact: true });
    await pdButton.click();
    const cell = matrix.nth(1); // B(1,1) = 3 in Prisoners Dilemma
    await waitForInputValue(commaPage, matrixSelector, 1, '3', 5000);
    const presetSelected = async () => ((await pdButton.getAttribute('class')) || '').includes('bg-accent-600');
    const epPanel = commaPage.getByText('Expected-Payoff Functions', { exact: true }).first().locator('xpath=..');
    const epSignature = async () => (await epPanel.locator('.katex').allTextContents()).join(' | ');
    const settle = async (pred) => {
      for (let i = 0; i < 30; i++) { if (await pred()) return true; await commaPage.waitForTimeout(100); }
      return pred();
    };

    async function checkCommaRejected(label, commaInput, leadingDigit) {
      const before = await cell.inputValue();
      const gameBefore = await epSignature();
      const presetBefore = await presetSelected();
      record(`${label}: fixture guard — pre-edit value "${before}" differs from the typed leading digit ${leadingDigit} (a coincidental pass is impossible)`,
        Number(before) !== leadingDigit);
      await cell.click();
      await cell.fill('');
      await commaPage.keyboard.type(commaInput, { delay: 20 });
      const midTyping = await cell.inputValue();
      record(`${label}: the cell shows exactly what was typed (no live truncation while a comma is present)`,
        midTyping === commaInput, `got "${midTyping}"`);
      const hintDuringTyping = await payoffHint.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      const hintTextDuringTyping = hintDuringTyping ? await payoffHint.textContent().catch(() => null) : null;
      record(`${label}: the hint appears with the exact guidance text while the field holds an ambiguous comma`,
        hintDuringTyping && hintTextDuringTyping === HINT_TEXT, `visible=${hintDuringTyping} text=${JSON.stringify(hintTextDuringTyping)}`);
      // The leading digit committed through the ordinary path before the comma
      // arrived. The comma's arrival must UNDO that in the game, not merely
      // hide it in the box: the Expected-Payoff formula must read exactly as
      // it did before the edit began, while the cell still shows the comma.
      const gameRestoredDuring = await settle(async () => (await epSignature()) === gameBefore);
      record(`${label}: RED-DESKTOP-9/002 fix — the game's payoff is restored the moment the comma appears (Expected-Payoff formula identical to pre-edit)`,
        gameRestoredDuring, `before=${JSON.stringify(gameBefore)} during=${JSON.stringify(await epSignature())}`);
      const presetRestored = await settle(async () => (await presetSelected()) === presetBefore);
      record(`${label}: the active preset is restored with it (Prisoners Dilemma ${presetBefore ? 'still selected' : 'still not selected'}, as before the edit)`, presetRestored);
      await cell.blur();
      await waitForInputValue(commaPage, matrixSelector, 1, before, 3000);
      const afterBlur = await cell.inputValue();
      record(`${label}: blur reverts the cell to its PRE-EDIT value, not the committed leading digit`,
        afterBlur === before, `before="${before}" after="${afterBlur}"`);
      record(`${label}: after blur the game's payoff still equals the pre-edit value`, (await epSignature()) === gameBefore);
      const hintAfterBlur = await payoffHint.isVisible().catch(() => false);
      record(`${label}: the hint is still visible after blur, explaining why the edit was rejected`, hintAfterBlur);
    }

    // Positive control: a genuine dotted decimal still commits normally, reaches
    // the game, and clears the hint (the fix must not have made ALL edits inert,
    // only comma-holding ones).
    async function checkDotCommits(label, dotted) {
      const gameBefore = await epSignature();
      await cell.click();
      await cell.fill('');
      await commaPage.keyboard.type(dotted, { delay: 20 });
      await cell.blur();
      await waitForInputValue(commaPage, matrixSelector, 1, dotted, 3000);
      const dotCommitted = await cell.inputValue();
      record(`${label}: control — a dotted decimal ("${dotted}") still commits normally`, dotCommitted === dotted, `got "${dotCommitted}"`);
      const gameMoved = await settle(async () => (await epSignature()) !== gameBefore);
      record(`${label}: control — the committed decimal reaches the game (Expected-Payoff formula changed)`, gameMoved);
      const hintClearedAfterValidEdit = !(await payoffHint.isVisible().catch(() => false));
      record(`${label}: the hint clears once a valid (comma-free) edit is made`, hintClearedAfterValidEdit);
    }

    await checkCommaRejected('ASCII comma', '4,5', 4);
    await checkDotCommits('ASCII comma', '7.5');
    // Second pass with the U+FF0C FULLWIDTH COMMA glyph (CodeRabbit, this
    // branch), from the committed 7.5 and with a different leading digit.
    await checkCommaRejected('fullwidth comma (U+FF0C)', '２，５', 2);
    await checkDotCommits('fullwidth comma (U+FF0C)', '6.25');
    await commaPage.close();
  });

  // ══ 43. RED-REGEN-3/001 (director-reproduced) — a pre-existing colour-term
  //      chip that string-matches a BRAND-NEW, SYMMETRIC option label (a real
  //      option BOTH players can pick, ~19% of the shipped bank) must render
  //      NEUTRAL, not repainted as one player's exclusively — in the regen
  //      preview AND in the persisted render after Keep -> Save -> reopen.
  //      Real DOM, real ColorCoded render, real chip-picker UI, real
  //      save/PATCH/GET round trip; `/api/scenario/regenerate` mocked exactly
  //      like every other regen section (the flag-off server, untouched).
  section('43', 'symmetric-label chip collision renders neutral', 1, async () => {
    const symPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await mockRegenOn(symPage, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenario: REGEN_STORY_SYMMETRIC }) });
    });
    const uniq = await registerAndLogin(symPage, 'e2e9symlabel');
    const gameName = `SymLabelGame${uniq}`;
    await symPage.getByRole('button', { name: /save preset/i }).click();
    await symPage.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
    await symPage.locator('[role="dialog"][aria-label="Save custom game"] input[placeholder="e.g. Battle of the Sexes 2.0"]').fill(gameName);

    // Place a REAL chip, through the real chip-picker UI, on the word
    // "cooperate" in the user's OWN unrelated prior text — nothing to do
    // with the draw about to arrive.
    const descField = symPage.locator('[role="dialog"][aria-label="Save custom game"] textarea');
    await descField.fill('The two firms already cooperate informally on scheduling.');
    const selectWord = async (word) => {
      await symPage.evaluate(({ w, sel }) => {
        const ta = document.querySelector(sel);
        const idx = ta.value.indexOf(w);
        ta.focus();
        ta.setSelectionRange(idx, idx + w.length);
      }, { w: word, sel: '[role="dialog"][aria-label="Save custom game"] textarea' });
    };
    const saveDialog = symPage.getByRole('dialog', { name: 'Save custom game' });
    await selectWord('cooperate');
    await saveDialog.getByRole('button', { name: 'Player A' }).click();
    // CodeRabbit (this review): a bare `button:has-text("cooperate")` would
    // pass identically for a chip filed on EITHER player — it only proves a
    // button with that text exists, not that it is actually Player A's chip.
    // Read the chip button's own styling (DescriptionEditor's `chip()` gives
    // Player A's chip `text-player-a-ink` and Player B's `text-player-b-ink`,
    // never both) so a chip accidentally placed on the wrong side would fail
    // this precondition instead of passing it.
    const chipInfo = await symPage.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="Save custom game"]');
      // The chip button's textContent also carries its "×"/"Remove highlight"
      // child spans, so match a leading "cooperate" rather than full equality.
      const btn = [...(dlg?.querySelectorAll('button') ?? [])]
        .find((b) => /^cooperate/i.test(b.textContent?.trim() || ''));
      return btn ? { text: btn.textContent, cls: btn.className } : null;
    });
    record('precondition: a real "cooperate" chip is placed on Player A specifically (unrelated text)',
      !!chipInfo && /text-player-a-ink/.test(chipInfo.cls) && !/text-player-b-ink/.test(chipInfo.cls),
      JSON.stringify(chipInfo));

    // Regenerate -> the mocked draw's labels are SYMMETRIC (row1===col1==="Cooperate").
    const symRegenBtn = symPage.getByRole('button', { name: 'Regenerate scenario' });
    await symRegenBtn.waitFor({ state: 'visible', timeout: 5000 });
    await symRegenBtn.click();
    const symPreview = symPage.getByText('New scenario (preview)', { exact: false });
    await symPreview.waitFor({ state: 'visible', timeout: 5000 });
    // Scoped to the DESCRIPTION paragraph specifically, not the whole preview
    // card: the card also has an "A: Cooperate / Defect" / "B: Cooperate /
    // Defect" structural summary line (always styled per-player — it labels
    // which RAW OPTION belongs to which side, not a ColorCoded claim about a
    // WORD in the prose) that must not be confused with the actual rendered
    // occurrence of "Cooperate" inside the AI-written description text.
    // A NEUTRAL word (this fix's whole point) is rendered by ColorCoded as
    // plain, unwrapped text — it never gets a <span> at all, only a COLOURED
    // match does (see ColorCoded.tsx: aTerms/bTerms entries are the only
    // things `applyRule` wraps). So `.every(...)` over the matched-span list
    // must NOT be asserted non-empty (CodeRabbit's literal suggestion would
    // make the CORRECT, fixed rendering fail this check, since it correctly
    // produces zero colour-matching spans) — the real vacuous-pass risk is
    // the marker/card/paragraph SELECTOR CHAIN silently finding nothing.
    // Guard that specifically: prove the paragraph was located AND the word
    // is genuinely present in it (as plain text or a span, either is fine),
    // then separately check that no SPAN inside it carries a player colour.
    const previewCheck = await symPage.evaluate((expectedDesc) => {
      const marker = [...document.querySelectorAll('p')].find((n) => n.textContent?.trim() === 'New scenario (preview)');
      const card = marker?.parentElement;
      const descParagraph = [...(card?.querySelectorAll('p') ?? [])]
        .find((p) => p.textContent?.includes(expectedDesc.slice(0, 30)));
      const paragraphText = descParagraph?.textContent || '';
      const cooperateSpans = [...(descParagraph?.querySelectorAll('span') ?? [])]
        .filter((s) => /cooperate/i.test(s.textContent || ''))
        .map((s) => ({ text: s.textContent, cls: s.className }));
      return { found: !!descParagraph, hasWord: /cooperate/i.test(paragraphText), cooperateSpans };
    }, REGEN_STORY_SYMMETRIC.description);
    record('precondition: the preview\'s description paragraph was located and genuinely contains "Cooperate"',
      previewCheck.found && previewCheck.hasWord, JSON.stringify(previewCheck));
    record('the word "Cooperate" in the new, both-players-can-pick description renders NEUTRAL (no coloured span) in the preview',
      previewCheck.cooperateSpans.every((s) => !/text-player-a-ink|text-player-b-ink/.test(s.cls)),
      JSON.stringify(previewCheck.cooperateSpans));

    await symPage.getByRole('button', { name: 'Keep' }).click();
    await symPage.waitForTimeout(300);
    await symPage.getByRole('button', { name: /^save game profile$/i }).click();
    await symPage.waitForTimeout(800);

    // Reopen the Edit dialog: a fresh render, through the real saved-game
    // PATCH/GET round trip, not the preview closure above.
    await symPage.getByRole('button', { name: `Edit ${gameName}` }).click();
    await symPage.waitForSelector('[role="dialog"][aria-label="Edit saved game"]', { timeout: 5000 });
    const editDialog = symPage.getByRole('dialog', { name: 'Edit saved game' });
    const editDescText = await editDialog.locator('textarea').inputValue();
    record('precondition: the saved description is the regenerated symmetric-label story',
      /Cooperate or Defect/.test(editDescText));
    // Same shape as the preview check above: a NEUTRAL word renders as plain
    // text, never a span, so the meaningful guard against a broken selector
    // is "the DescriptionEditor preview paragraph was found and genuinely
    // contains the word" — not "a matching span exists" (the fixed, correct
    // rendering has none).
    const savedCheck = await symPage.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="Edit saved game"]');
      // DescriptionEditor's own live preview paragraph (its className is
      // this component's, unique within the Edit dialog).
      const descParagraph = dlg?.querySelector('p.mt-1\\.5.rounded-lg.bg-slate-50') ?? null;
      const paragraphText = descParagraph?.textContent || '';
      const cooperateSpans = [...(descParagraph?.querySelectorAll('span') ?? [])]
        .filter((s) => /^cooperate$/i.test((s.textContent || '').trim()))
        .map((s) => ({ text: s.textContent, cls: s.className }));
      return { found: !!descParagraph, hasWord: /cooperate/i.test(paragraphText), cooperateSpans };
    });
    record('precondition: the saved render\'s description preview paragraph was located and genuinely contains "Cooperate"',
      savedCheck.found && savedCheck.hasWord, JSON.stringify(savedCheck));
    record('the SAVED render (post-Keep, post-Save, reopened Edit dialog) is ALSO neutral (no coloured span), not painted as Player A only',
      savedCheck.cooperateSpans.every((s) => !/text-player-a-ink|text-player-b-ink/.test(s.cls)),
      JSON.stringify(savedCheck.cooperateSpans));

    // The chip is never deleted from the record: it survives in the PATCH
    // body even while neutralized on screen (director's decision: an AI
    // action never destroys user-authored data).
    let patchBody = null;
    await symPage.route(`**/api/games/*`, async (route) => {
      if (route.request().method() === 'PATCH') patchBody = JSON.parse(route.request().postData() || '{}');
      await route.continue();
    });
    // The chip already went out on the earlier PATCH (Save Game Profile
    // above uses POST, not PATCH); re-open Edit's own Save Changes path to
    // observe a PATCH directly.
    const editPatchDone = symPage.waitForResponse(
      (r) => /\/api\/games\//.test(r.url()) && r.request().method() === 'PATCH',
      { timeout: 15000 },
    ).catch(() => null);
    await symPage.getByRole('button', { name: /^save changes$/i }).click();
    await editPatchDone;
    record('the chip is preserved in the stored record even while its render is neutralized',
      !!patchBody && Array.isArray(patchBody.colorTermsA) && patchBody.colorTermsA.includes('cooperate'),
      JSON.stringify(patchBody?.colorTermsA));
    await symPage.close();
  });

  // ══ 44. Director hardening (class of RED-DESKTOP-9/002, second surface): the
  //      step-size / regret-weight box is the one other typed decimal field.
  //      A comma must be rejected with the same hint, and the value in force
  //      must return to its focus-time value — the comma-free prefix ("5" of
  //      "5,5") commits (clamped to 0.999) before the comma exists. The value
  //      in force is read from the SLIDER (bound to shrinkStep), not the box.
  section('44', 'comma in the step-size box rejected, value restored', 3, async () => {
    const stepPage = await newTrackedPage({ viewport: { width: 1280, height: 900 } });
    await stepPage.goto(BASE, { waitUntil: 'networkidle' });
    try { await stepPage.locator('[aria-label="Exit tour"]').click({ timeout: 20000 }); } catch { /* decided below */ }
    let tourGone = await stepPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
      null, { timeout: 5000 }).then(() => true).catch(() => false);
    if (!tourGone) {
      await stepPage.keyboard.press('Escape');
      tourGone = await stepPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
        null, { timeout: 10000 }).then(() => true).catch(() => false);
    }
    record('precondition: the guided tour is dismissed before the step-size checks', tourGone);

    const box = stepPage.getByLabel('Initial Domain Shrink Step Size', { exact: true });
    const slider = stepPage.getByLabel('Initial Domain Shrink Step Size slider', { exact: true });
    const hint = stepPage.locator('[data-testid="step-input-hint"]');
    const HINT_TEXT = 'Use a dot for decimals, not a comma.';
    await box.waitFor({ state: 'visible', timeout: 20000 });
    const settle = async (pred) => {
      for (let i = 0; i < 30; i++) { if (await pred()) return true; await stepPage.waitForTimeout(100); }
      return pred();
    };

    async function checkCommaRejected(label, commaInput, prefixCommits) {
      const before = await box.inputValue();
      const sliderBefore = await slider.inputValue();
      record(`${label}: fixture guard — the value in force (${sliderBefore}) differs from what the typed prefix alone would commit (${prefixCommits})`,
        Number(sliderBefore) !== prefixCommits);
      await box.click();
      await box.fill('');
      await stepPage.keyboard.type(commaInput, { delay: 20 });
      const midTyping = await box.inputValue();
      record(`${label}: the box shows exactly what was typed`, midTyping === commaInput, `got "${midTyping}"`);
      const hintShown = await hint.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      const hintText = hintShown ? await hint.textContent().catch(() => null) : null;
      record(`${label}: the hint appears with the exact guidance text`, hintShown && hintText === HINT_TEXT, `visible=${hintShown} text=${JSON.stringify(hintText)}`);
      const restored = await settle(async () => (await slider.inputValue()) === sliderBefore);
      record(`${label}: the value in force (slider) is back to its pre-edit value while the comma is still in the box`,
        restored, `before=${sliderBefore} now=${await slider.inputValue()}`);
      await box.blur();
      const boxReverted = await settle(async () => (await box.inputValue()) === before);
      record(`${label}: blur reverts the box to its pre-edit text, not the committed prefix`, boxReverted, `before="${before}" after="${await box.inputValue()}"`);
      record(`${label}: after blur the slider still holds the pre-edit value`, (await slider.inputValue()) === sliderBefore);
      record(`${label}: the hint is still visible after blur`, await hint.isVisible().catch(() => false));
    }
    async function checkDotCommits(label, dotted) {
      const sliderBefore = await slider.inputValue();
      await box.click();
      await box.fill('');
      await stepPage.keyboard.type(dotted, { delay: 20 });
      await box.blur();
      const committed = await settle(async () => (await box.inputValue()) === Number(dotted).toFixed(3));
      record(`${label}: control — a dotted decimal ("${dotted}") still commits normally`, committed, `got "${await box.inputValue()}"`);
      const moved = await settle(async () => (await slider.inputValue()) !== sliderBefore);
      record(`${label}: control — the committed decimal reaches the value in force (slider moved)`, moved);
      record(`${label}: the hint clears once a valid edit is made`, !(await hint.isVisible().catch(() => false)));
    }

    await checkCommaRejected('ASCII comma', '5,5', 0.999);
    // A slider edit is a valid edit too: it must clear the stale comma hint (CodeRabbit CLI).
    await slider.focus();
    await stepPage.keyboard.press('ArrowRight');
    record('a slider edit after a rejected comma clears the hint', await settle(async () => !(await hint.isVisible().catch(() => false))));
    await checkDotCommits('ASCII comma', '0.25');
    await checkCommaRejected('fullwidth comma (U+FF0C)', '３，５', 0.999);
    await checkDotCommits('fullwidth comma (U+FF0C)', '0.15');
    await checkCommaRejected('ASCII digits + fullwidth comma', '5，5', 0.999);
    await checkDotCommits('ASCII digits + fullwidth comma', '0.35');
    await stepPage.close();
  });

  await executeSections();

} catch (e) {
  // Capture the failure state BEFORE closing the browser — a click timeout
  // with no console errors is unactionable without seeing what the page
  // looked like (what overlay was up, whether the button was even there).
  await captureFailureEvidence();
  record('suite completed without a script error', false,
    String(e?.message ?? e).slice(0, 200));
}

await page.screenshot({ path: endPng }).catch(() => {});
await browser.close();

// console errors: external analytics/resource failures are not the app's
// signal here; everything else is a failure of the check that ran
//
// RED-REGEN-2/002 fix note: making `newTrackedPage` cover every secondary
// page (§31's `rlPage`, §33's `tourPage`) surfaced a message this suite had
// literally never seen before, because it was always on an untracked page:
// Chromium itself logs "Failed to load resource: the server responded with
// a status of <code>" to the console for ANY completed HTTP response with
// an error status — including the 429/401 responses §31 and §33
// DELIBERATELY mock via `route.fulfill` to test the app's own error-handling
// UI. That is a network-layer diagnostic from the browser, not a JS defect
// signal, exactly like the `net::`/analytics noise already excluded above —
// and each section's own functional assertions ("shows the AI limit reached
// wording", "shows the Sign-In card") already prove the mocked status was
// actually handled correctly.
//
// CodeRabbit (this review): a BLANKET exclusion of every such message is too
// wide — it would also swallow a genuinely unexpected error status from a
// REAL, unmocked call (a real bug), not only the two deliberately-mocked
// ones. So this suppresses only the EXACT, declared diagnostics per section
// (one budgeted entry per status code this section's own mock is known to
// produce) and consumes each at most once; any OTHER status-noise message —
// a different code, a different section, or a surplus repeat — still counts
// as a failure. Excluding it this way, not by leaving those pages untracked,
// keeps the fix real: a genuine `console.error`/`pageerror` on either page
// (this file's own mutation self-test plants one) still fails, and so does
// an unexpected status this table does not name.
const EXPECTED_STATUS_NOISE = {
  '31': [429], // §31 deliberately mocks a 429 to test the "AI limit reached" wording
  '33': [401], // §33 deliberately mocks a 401 to test the Edit dialog's Sign-In card
  // §38 (RED-APP-9/001) deliberately DELETEs and PATCHes an already-deleted
  // game from tab A — a REAL 404 from the real server (not a route mock),
  // twice: once via the Delete button, once via the Edit dialog's Save
  // Changes submit. Both are the exact behavior the section's own
  // assertions verify ("shows the friendly deleted-elsewhere message",
  // "phantom row removed") — same class of expected network-layer
  // diagnostic as §31/§33's mocked statuses above.
  '38': [404, 404],
};
const remainingStatusNoise = new Map(
  Object.entries(EXPECTED_STATUS_NOISE).map(([id, codes]) => [id, [...codes]]),
);
const STATUS_NOISE_RE = /failed to load resource: the server responded with a status of (\d+)/i;
const relevantErrors = consoleErrors
  .filter((error) => error.sectionId === null
    || error.attempt === finalAttemptBySection.get(error.sectionId))
  .filter(({ text }) => !/googletagmanager|google-analytics|gtag|net::|ERR_INTERNET|ERR_NAME_NOT_RESOLVED/i.test(text))
  .filter((error) => {
    const m = STATUS_NOISE_RE.exec(error.text);
    if (!m) return true;
    const budget = remainingStatusNoise.get(error.sectionId);
    const idx = budget ? budget.indexOf(Number(m[1])) : -1;
    if (idx === -1) return true; // not a declared/budgeted diagnostic for this section — a real signal
    budget.splice(idx, 1); // consume exactly one; a surplus repeat is no longer expected
    return false;
  });
if (executedShard && relevantErrors.length === 0) {
  // Enforce this guard independently in every shard, but do not inflate the
  // historical functional-check count from one global check to four.
  console.log('PASS no console/page errors across this shard');
} else {
  record(`no console/page errors across ${executedShard ? 'this shard' : 'the whole suite'}`,
    relevantErrors.length === 0, relevantErrors.slice(0, 3).map(({ text }) => text).join(' | '));
}

await killServer();
try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }

const finalResults = results.filter((result) => result.sectionId === null
  || result.attempt === finalAttemptBySection.get(result.sectionId));
const fails = finalResults.filter((result) => !result.pass);
console.log(`\n══════ E2E SMOKE: ${finalResults.length - fails.length}/${finalResults.length} checks passed ══════`);
if (fails.length) fails.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
process.exit(fails.length ? 1 : 0);

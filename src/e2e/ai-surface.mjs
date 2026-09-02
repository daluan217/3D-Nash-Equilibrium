/* AI-surface e2e — the controls that consume a model response.
 *
 * WHY THIS SUITE EXISTS. "Generate a new game" discarded a perfectly good
 * scenario on EVERY generation for about a day, told the user "the AI scenario
 * isn't available right now", and no test noticed. The server was fine; the
 * frontend required `source === 'llm'` while rung-3 production emits
 * 'template'. A 100%-reproducible, user-facing failure sat behind a button no
 * suite pressed.
 *
 * The existing smoke suite runs the SIMULATION — presets, Run/Step/Reset,
 * convergence. It never opens the save dialog. So the whole AI surface, the
 * part with a network contract behind it, had zero coverage.
 *
 * These checks run WITHOUT provider credentials, by design. CI has none, and
 * waiting on a real model would make the suite slow and flaky for no gain:
 * the defect was never in the model, it was in how the UI reads the envelope.
 * So the API is STUBBED with the exact shape production returns — captured
 * live from nash-equilibrium-simulator.com while diagnosing:
 *
 *     { source: 'template', validation: null,
 *       report: { ..., suggestedScenario: { name, row1..col2, description } } }
 *
 * A stub is the right instrument here precisely because the bug was a contract
 * mismatch. It would have failed on the broken build and passes on the fixed
 * one, which is the only property that matters.
 *
 *   E2E_BASE=http://localhost:3099 node src/e2e/ai-surface.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = process.env.E2E_PORT || '3098';
const BASE = process.env.E2E_BASE || `http://localhost:${PORT}`;
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** The production envelope, verbatim in shape. `validation: null` is the point. */
const TEMPLATE_ENVELOPE = {
  source: 'template',
  validation: null,
  groundTruth: [],
  report: {
    claimedEquilibria: [],
    prose: 'Each player has a strict best reply.',
    proseClaims: null,
    suggestedScenario: {
      name: 'Weir Maintenance Windows',
      row1: 'Early Window', row2: 'Late Window',
      col1: 'Full Crew', col2: 'Skeleton Crew',
      description: 'A river authority and a mill operator each choose when to work on a shared weir.',
    },
  },
};

let server = null;
const userData = mkdtempSync(path.join(tmpdir(), 'nash-ai-e2e-'));
async function killServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  if (!server.kill('SIGKILL')) return;
  await exited;
}
async function waitReady(ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
if (!(await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false))) {
  server = spawn(process.execPath, ['dist/server.cjs'], {
    env: { ...process.env, PORT, NODE_ENV: 'production', ELECTRON_USER_DATA_PATH: userData },
    stdio: 'ignore',
  });
  if (!(await waitReady())) { console.error('server never became ready'); process.exit(1); }
}

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage();
page.setDefaultTimeout(120000);
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Serve the production-shaped envelope for every report call.
let reportCalls = 0;
await page.route('**/api/report', async (route) => {
  reportCalls++;
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEMPLATE_ENVELOPE) });
});

async function dismissTour() {
  // The viewport-anchored Exit button, never the callout X: the card follows
  // the spotlight and step 1's smooth-scroll can leave it off-screen.
  await page.getByRole('button', { name: /Exit tour/i }).click({ timeout: 8000 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[data-tour-overlay]'), { timeout: 10000 }).catch(() => {});
}
/* Sign in first: "Save Preset" renders only for a signed-in user (`{user && …}`),
 * so signed-out e2e could never reach the dialog — which is a large part of why
 * this whole surface went untested. Registration auto-verifies under
 * ELECTRON_USER_DATA_PATH with no SMTP, exactly as the integration suite does,
 * and the token goes straight into localStorage rather than through the auth UI:
 * this suite is about the AI surface, not about sign-in, which has its own
 * coverage. */
const email = `e2e-ai-${Date.now()}@example.test`;
const password = 'Passw0rd!e2e';
let token = '';
try {
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'e2eai', email, password }),
  });
  const login = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json();
  token = login?.token || '';
} catch { /* recorded by the check below */ }
record('e2e can sign in headlessly (auto-verify, no SMTP)', !!token);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
if (token) {
  await page.evaluate((t) => localStorage.setItem('nash_sim_token', t), token);
  await page.reload({ waitUntil: 'domcontentloaded' });
}
await page.waitForTimeout(1800);
await dismissTour();

/* ── 1. "Explain this game" renders the template report ─────────────────── */
try {
  await page.getByRole('button', { name: /Explain this game/i }).click();
  await page.waitForTimeout(1200);
  const shown = await page.getByText(/Each player has a strict best reply/i).count();
  record('Explain this game renders a rung-3 template report', shown > 0,
    `report calls=${reportCalls}`);
} catch (e) { record('Explain this game renders a rung-3 template report', false, String(e).slice(0, 90)); }

/* ── 2. THE REGRESSION: Generate prefills from a template envelope ───────── */
try {
  // "Save Preset" only renders for a CUSTOM game, so edit a payoff first —
  // which is also what a user does before they would ever want this dialog.
  const cell = page.locator('input[type="text"], input[type="number"]').first();
  await cell.fill('4').catch(() => {});
  await cell.blur().catch(() => {});
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /Save Preset/i }).first()
    .click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(900);
  const gen = page.getByRole('button', { name: /^Generate$/ });
  const reachable = await gen.count();
  record('the save dialog exposes Generate', reachable > 0);
  if (reachable) {
    await gen.click();
    // Poll the name field rather than a fixed sleep: if generation takes
    // longer than a fixed budget, a timed sleep reads the name/description
    // checks as failed while the "isn't available right now" note check
    // passes vacuously (the request just hasn't landed yet).
    await page.waitForFunction(() => {
      const el = document.querySelector('input[placeholder*="Battle of the Sexes 2.0" i]');
      return !!el && el.value.length > 0;
    }, { timeout: 15000 }).catch(() => {});
    const name = await page.getByPlaceholder(/Battle of the Sexes 2\.0/i).inputValue().catch(() => '');
    const desc = await page.getByPlaceholder(/background storyline/i).inputValue().catch(() => '');
    const note = await page.getByText(/isn't available right now/i).count();
    // THE BUG: the envelope carried a scenario and the dialog said it did not.
    record('Generate prefills the name from a template envelope', name.length > 0, `name=${JSON.stringify(name)}`);
    record('Generate prefills the description', desc.length > 0, `${desc.length} chars`);
    record('Generate does NOT claim the scenario is unavailable', note === 0,
      note ? 'the "isn\'t available right now" note is showing' : '');
  }
} catch (e) { record('Generate prefills from a template envelope', false, String(e).slice(0, 110)); }

await browser.close();
const relevant = consoleErrors.filter((t) => !/googletagmanager|google-analytics|gtag|net::|ERR_/i.test(t));
record('no console/page errors across the AI surface', relevant.length === 0, relevant.slice(0, 2).join(' | '));
await killServer();
try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
const fails = results.filter((r) => !r.pass);
console.log(`\n══════ AI SURFACE: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length) fails.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
process.exit(fails.length ? 1 : 0);

// RED-DESKTOP-19 angle 1: the local-games-offer route (adoptLocalGames /
// POST /api/games/adopt-local) is one of the account-scoped-state routes the
// brief names for the stale-identity-discard FAMILY. Every OTHER such route
// (GET /api/games via refetchUserGames, POST /api/games via
// handleSaveGameSubmit, PATCH /api/games/:id via handleEditGameSubmit, DELETE
// /api/games/:id via handleDeleteGame) calls the shared
// `handleDeadSessionResponse` helper on a non-ok response, which clears a
// dead auth token so the header stops claiming "signed in" for a session the
// server has already killed. adoptLocalGames's `!res.ok` branch does not
// call it at all (confirmed by source read: src/App.tsx handleDeadSessionResponse
// call sites are only at the Edit/Delete/Save/refetch handlers).
//
// This probes whether that gap is REAL: sign in as A right after saving a
// game with no account (so the local-games offer appears with a real,
// count>0 offer and a real bearer token bound to it), hold the "Move into my
// account" POST via a Playwright route interceptor (headers already fixed by
// the app's own fetch call, same technique round17/RED-DESKTOP-18's angle 2
// used and the brief's angle 1 explicitly re-licenses: "sign out / switch
// account BETWEEN request and response" -- here the narrower, same-identity
// case: the token dies server-side (password reset) between click and
// response, no client-side account switch at all), invalidate A's session
// out-of-band via forgot-password/reset-password (same mechanism as
// round17/001 and getAuthUser's tokenVersion check), then release.
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WT = process.argv[2];
const PORT = process.argv[3] || '4801';
const LABEL = process.argv[4] || 'RUN';
const userData = mkdtempSync(join(tmpdir(), 'nash-rd19-a1x-'));
const emptyCwd = mkdtempSync(join(tmpdir(), 'nash-rd19-a1x-cwd-'));

const child = spawn('node', [join(WT, 'dist/server.cjs')], {
  cwd: emptyCwd,
  env: { PATH: process.env.PATH, HOME: userData, NODE_ENV: 'production', PORT, IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; child.stdout.on('data', (d) => srvLog += d); child.stderr.on('data', (d) => srvLog += d);
let lastHealth = '(none yet)';
// Reap on ANY exit path. Killing only on the success path is what leaked a
// server onto 4812 for 15 minutes in S71; the next probe then met a stale
// holder and its own child walked to port+1.
// It must also REPORT: a bare process.exit(1) on uncaughtException swallowed
// the error, and S74's control-delete failure left no trace in its log.
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (err) => {
    try { child.kill('SIGKILL'); } catch {}
    if (sig === 'exit') return;
    console.error(`PROBE ABORTED (${sig}):`, err?.stack ?? err);
    // S74-008: make a recurrence diagnosable in ONE run — who held the port,
    // and the last health body this probe saw from it.
    try {
      const holders = execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
      for (const h of holders) console.error(`  port ${PORT} held by pid ${h}: ${execSync(`ps -o command= -p ${h} 2>/dev/null || true`).toString().trim()}`);
      if (!holders.length) console.error(`  port ${PORT}: no listener at abort`);
    } catch (e) { console.error('  port holder lookup failed:', e.message); }
    console.error(`  our child pid ${child.pid}, exitCode ${child.exitCode}; last /api/health seen: ${lastHealth}`);
    process.exit(1);
  });
}

const BASE = `http://localhost:${PORT}`;
// pid-bound, not `if (r.ok)`: in IS_ELECTRON mode the server WALKS to port+1
// on EADDRINUSE (server.ts:5115), so a leaked or displaced server can answer
// here while our child serves somewhere else — measured in S71.
async function waitReady() {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${srvLog.slice(-400)}`);
    try {
      const r = await fetch(BASE + '/api/health');
      const body = r.ok ? await r.json() : null;
      lastHealth = JSON.stringify(body);
      if (body?.pid === child.pid) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no server with pid ${child.pid} answered on ${PORT} — it may have walked to `
    + `another port because something else holds ${PORT}. Log: ${srvLog.slice(-400)}`);
}
await waitReady();

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) nash-equilibrium-simulator/0.0.193 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: UA });
const alerts = [];
page.on('dialog', async (d) => { alerts.push({ t: Date.now(), msg: d.message() }); await d.accept(); });

// Assert we're really talking to THIS worktree's bundle (defends against a
// stale server left on the port from a prior/other agent's run).
const html = await (await fetch(BASE)).text();
const bundleMatch = html.match(/assets\/index-[^."]+\.js/);
console.log(`[${LABEL}] served bundle:`, bundleMatch?.[0]);

await page.goto(BASE, { waitUntil: 'networkidle' });
const { dismissTourForSetup } = await import(pathToFileURL(join(WT, 'src/e2e/tour.mjs')).href);
await dismissTourForSetup(page, 'clear the first-run tour before signing in');

const authDlg = page.locator('[role="dialog"][aria-label="Account"]');
async function registerAndLogin(username, email, password, { dismissOffer = true } = {}) {
  await page.locator('header').getByRole('button', { name: /sign in.*sign up/i }).click();
  await authDlg.waitFor({ state: 'visible' });
  await authDlg.getByRole('button', { name: /^sign up$/i }).click().catch(() => {});
  await authDlg.locator('input[placeholder="game_theorist"]').waitFor({ state: 'visible', timeout: 5000 });
  await authDlg.locator('input[placeholder="game_theorist"]').fill(username);
  await authDlg.locator('input[placeholder="john@example.com"]').fill(email);
  await authDlg.locator('input[placeholder="••••••••"]').first().fill(password);
  await authDlg.locator('input[placeholder="••••••••"]').nth(1).fill(password);
  // State, not time (S94): wait for the register response, then for the dialog's
  // own switch to Sign In; press "Log In" only if it did not switch.
  const regP = page.waitForResponse((r) => r.url().includes('/api/auth/register'), { timeout: 30000 });
  await authDlg.getByRole('button', { name: /register account/i }).click();
  await regP;
  const loginField = authDlg.locator('input[placeholder*="example.com or username"]');
  if (!(await loginField.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false))) {
    await authDlg.getByRole('button', { name: /^log in$/i }).click({ timeout: 5000 }).catch(() => {});
  }
  await loginField.waitFor({ state: 'visible', timeout: 8000 });
  await authDlg.locator('input[placeholder*="example.com or username"]').fill(email);
  await authDlg.locator('input[placeholder="••••••••"]').first().fill(password);
  const respP = page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST');
  await authDlg.getByRole('button', { name: /^login$/i }).click();
  const loginResp = await respP;
  const loginBody = await loginResp.json().catch(() => null);
  await authDlg.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  if (dismissOffer) {
    const offer = page.locator('[role="dialog"][aria-label="Games saved on this device"]');
    if (await offer.isVisible({ timeout: 800 }).catch(() => false)) {
      await page.getByRole('button', { name: /leave .* on this device/i }).click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
  }
  return loginBody;
}

async function saveGameSignedOut(name) {
  await page.getByRole('button', { name: /save preset/i }).click();
  const sdlg = page.locator('[role="dialog"][aria-label="Save custom game"]');
  await sdlg.waitFor({ state: 'visible' });
  await sdlg.locator('input[type="text"], input:not([type])').first().fill(name);
  const respP = page.waitForResponse((r) => r.url().includes('/api/games') && r.request().method() === 'POST');
  await sdlg.getByRole('button', { name: /save game profile/i }).click();
  const resp = await respP;
  const body = await resp.json().catch(() => null);
  return { status: resp.status(), body };
}

console.log(`[${LABEL}] === Save a game while signed OUT (becomes a local-owner game) ===`);
const localSave = await saveGameSignedOut('DeviceOnlyGame');
console.log(`[${LABEL}] local save status/id:`, localSave.status, localSave.body?.game?.id, 'userId:', localSave.body?.game?.userId);

console.log(`[${LABEL}] === Register + log in as A (should surface the local-games offer) ===`);
const A = { u: 'rd19a', e: 'rd19a@desk.local', p: 'TestPass123' };
const loginBody = await registerAndLogin(A.u, A.e, A.p, { dismissOffer: false });
console.log(`[${LABEL}] login response localGames:`, loginBody?.localGames);

const offer = page.locator('[role="dialog"][aria-label="Games saved on this device"]');
const offerVisible = await offer.isVisible({ timeout: 2000 }).catch(() => false);
console.log(`[${LABEL}] local-games offer dialog visible:`, offerVisible);
if (!offerVisible) {
  console.log(`[${LABEL}] ABORT: offer never appeared, cannot probe adoptLocalGames. srvLog tail:`, srvLog.slice(-800));
  child.kill(); await browser.close(); process.exit(2);
}

console.log(`[${LABEL}] === Intercept the upcoming POST /api/games/adopt-local and hold it ===`);
let releaseHold;
const holdGate = new Promise((resolve) => { releaseHold = resolve; });
let interceptedAuthHeader = null;
await page.route('**/api/games/adopt-local', async (route, request) => {
  interceptedAuthHeader = request.headers()['authorization'] || null;
  console.log(`[${LABEL}]   [intercepted adopt-local] auth header:`, interceptedAuthHeader?.slice(0, 30) + '...');
  await holdGate;
  console.log(`[${LABEL}]   [intercepted adopt-local] releasing to real server now`);
  await route.continue();
});

const tokenBeforeClick = await page.evaluate(() => localStorage.getItem('nash_sim_token_local'));
console.log(`[${LABEL}] A token before click:`, tokenBeforeClick?.slice(0, 30) + '...');

const moveRespPromise = page.waitForResponse((r) => r.url().includes('/api/games/adopt-local'));
await page.getByRole('button', { name: /move .* into my account/i }).click();
await page.waitForTimeout(300);

console.log(`[${LABEL}] === While held: invalidate A's session out-of-band (password reset) ===`);
const invalidateResult = await page.evaluate(async ({ email, newPassword }) => {
  const fr = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  const fb = await fr.json().catch(() => ({}));
  const code = fb.recoveryCode || fb.code;
  const rr = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code, newPassword }) });
  return { forgotStatus: fr.status, resetStatus: rr.status, code };
}, { email: A.e, newPassword: 'NewPass456' });
console.log(`[${LABEL}] invalidation:`, JSON.stringify(invalidateResult));

console.log(`[${LABEL}] === Release the held POST (forwards with A's now-dead token) ===`);
alerts.length = 0;
releaseHold();
const moveResp = await moveRespPromise;
await page.waitForTimeout(600);
let moveBody = null; try { moveBody = await moveResp.json(); } catch {}
console.log(`[${LABEL}] adopt-local final status:`, moveResp.status(), 'body:', JSON.stringify(moveBody));

const errorTextVisible = await page.locator('[role="alert"]').filter({ hasText: /.+/ }).first().textContent().catch(() => null);
console.log(`[${LABEL}] error text shown in dialog:`, errorTextVisible);

const tokenAfter = await page.evaluate(() => localStorage.getItem('nash_sim_token_local'));
console.log(`[${LABEL}] A token AFTER dead-token response (should be CLEARED like every other route, per handleDeadSessionResponse):`, tokenAfter?.slice(0, 30) + '...', '| unchanged from before:', tokenAfter === tokenBeforeClick);

const headerShowsSignedIn = await page.locator('header').getByRole('button', { name: /log out/i }).isVisible().catch(() => false);
console.log(`[${LABEL}] header STILL shows "Log out" (i.e. claims signed-in) after a confirmed-dead token:`, headerShowsSignedIn);

// Does a subsequent action (e.g. clicking "Leave them on this device", which
// is a pure client no-op, or trying another account-scoped action) recover?
// Check the dialog is still open / actionable and what the buttons show now.
const dialogStillOpen = await offer.isVisible().catch(() => false);
console.log(`[${LABEL}] offer dialog still open:`, dialogStillOpen);

console.log(`\n[${LABEL}] === VERDICT ===`);
const tokenNotCleared = tokenAfter !== null && tokenAfter === tokenBeforeClick;
const headerLies = headerShowsSignedIn && moveResp.status() === 401;
console.log(`[${LABEL}] response was 401 (dead token, as expected):`, moveResp.status() === 401);
console.log(`[${LABEL}] token left uncleared despite dead-session response:`, tokenNotCleared);
console.log(`[${LABEL}] header still claims signed-in despite dead-session response:`, headerLies);
if (tokenNotCleared && headerLies) {
  console.log(`[${LABEL}] DEFECT-CANDIDATE: adoptLocalGames does not call handleDeadSessionResponse; a dead token from THIS route leaves the header claiming "signed in" / "Log out" indefinitely, unlike every other account-scoped route.`);
} else {
  console.log(`[${LABEL}] RESULT: PASS (dead token was cleared / header updated correctly)`);
}

child.kill();
await browser.close();
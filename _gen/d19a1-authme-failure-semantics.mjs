// STRUCT-DESKTOP-19, red pass 1, angle D19-1.
//
// CLAIM UNDER TEST: the /api/auth/me session probe (src/App.tsx, the
// "Fetch Session User and Games" effect) treats EVERY failure as a dead
// session — `if (res.ok) return res.json(); throw new Error('Session invalid')`
// with a `.catch(() => { updateAuthToken(null); setUser(null); })`. So a
// transient 5xx, or a plain network failure (offline / server restarting /
// captive portal), DESTROYS the token in localStorage and signs the user out
// for good, and a late failure from an OLD token clears whatever token is
// CURRENT. Every other account-scoped route in the app routes its 401 through
// `handleDeadSessionResponse` (401 only, and only when the token is still the
// one the request used) and explicitly does NOT wipe state on a non-401
// ("A failed request is not an empty library", CodeRabbit on #142).
//
// The harness is self-controlled: the same interception technique is applied
// to /api/games (the sibling that IS hardened) and a genuine 401 on
// /api/auth/me (which SHOULD clear), so a failure here cannot be the harness.
//
// Usage: node _gen/d19a1-authme-failure-semantics.mjs <worktree> <port> <LABEL>
import { chromium } from 'playwright';
import { startOwnServer, registerAndLogin, ELECTRON_UA } from './harnesslib.mjs';

const WT = process.argv[2];
const PORT = process.argv[3] || '4835';
const LABEL = process.argv[4] || 'RUN';

// Packaged-app shape (the brief's desktop condition): EMPTY cwd so dotenv
// cannot find the repo's .env, no credentials, IS_ELECTRON=true, Electron UA,
// throwaway user-data dir. Registration is only self-service in this shape (the
// hosted one needs real SMTP), which is why the account arm runs here; the
// client code under test (`/api/auth/me`'s catch) is identical in both.
// startOwnServer PROVES the port serves THIS worktree's bundle before anything
// is asserted (orphaned servers from other worktrees squat these ports).
const srv = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'a1' });
const child = srv.child;
const BASE = srv.base;
console.log(`[${LABEL}] server is ours, serving`, srv.bundle);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: ELECTRON_UA });
page.on('dialog', async (d) => { await d.accept(); });

await page.goto(BASE, { waitUntil: 'networkidle' });
try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 4000 }); } catch {}

const rAndL = (u, e, p) => registerAndLogin(page, { u, e, p });

const A = { u: 'd19a1user', e: 'd19a1@desk.local', p: 'TestPass123' };
await rAndL(A.u, A.e, A.p);
const tokenKey = 'nash_sim_token_local';
const token0 = await page.evaluate((k) => localStorage.getItem(k), tokenKey);
console.log(`[${LABEL}] signed in, token present:`, !!token0);
if (!token0) { console.log(`[${LABEL}] ABORT: never signed in. srv tail:`, srv.getLog().slice(-600)); child.kill(); await browser.close(); process.exit(2); }

// Read state from a MODEL-DERIVED rendering, not from localStorage alone:
// the header's own "Log out" control is what the app shows the user.
async function headerSignedIn() {
  return await page.locator('header').getByRole('button', { name: /log out/i }).isVisible().catch(() => false);
}

/**
 * Re-mount the app with `mode` applied to the named route, then report whether
 * the session survived. Reload is the real trigger: the session-probe effect
 * runs on every mount with a stored token — exactly what happens when the user
 * opens the app while the server is down or flaky.
 */
async function reloadWith(routeGlob, mode) {
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await page.route(routeGlob, async (route) => {
    if (mode === 'abort') return route.abort('failed');
    if (mode === 'http503') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Service Unavailable' }) });
    if (mode === 'http401') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid or expired session.' }) });
    return route.continue();
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 3000 }); } catch {}
  await page.waitForTimeout(1200);
  const tok = await page.evaluate((k) => localStorage.getItem(k), tokenKey);
  const hdr = await headerSignedIn();
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  return { token: tok, headerSignedIn: hdr };
}

async function restoreToken() {
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [tokenKey, token0]);
}

const results = {};

console.log(`\n[${LABEL}] --- CASE A: /api/auth/me answers 503 (transient server error) ---`);
results.me503 = await reloadWith('**/api/auth/me', 'http503');
console.log(`[${LABEL}]   token still stored:`, results.me503.token === token0, '| header signed in:', results.me503.headerSignedIn);

await restoreToken();
console.log(`\n[${LABEL}] --- CASE B: /api/auth/me network failure (offline / server restarting) ---`);
results.meAbort = await reloadWith('**/api/auth/me', 'abort');
console.log(`[${LABEL}]   token still stored:`, results.meAbort.token === token0, '| header signed in:', results.meAbort.headerSignedIn);

await restoreToken();
console.log(`\n[${LABEL}] --- NEGATIVE CONTROL: /api/auth/me answers 401 (genuinely dead session) ---`);
results.me401 = await reloadWith('**/api/auth/me', 'http401');
console.log(`[${LABEL}]   token still stored:`, results.me401.token === token0, '| header signed in:', results.me401.headerSignedIn,
  '  (CORRECT behaviour here is token CLEARED)');

await restoreToken();
console.log(`\n[${LABEL}] --- POSITIVE CONTROL: the hardened sibling, GET /api/games answers 503 ---`);
results.games503 = await reloadWith('**/api/games', 'http503');
console.log(`[${LABEL}]   token still stored:`, results.games503.token === token0, '| header signed in:', results.games503.headerSignedIn,
  '  (CORRECT behaviour here is token KEPT — "a failed request is not an empty library")');

await restoreToken();
console.log(`\n[${LABEL}] --- CASE C: a LATE failure for an OLD token clears the CURRENT session ---`);
// Hold the first /api/auth/me (token A). Sign out and sign in as B while it is
// held, then release it as a 503. Nothing in the catch checks which token the
// request belonged to, so B's live session is destroyed by A's stale failure.
{
  let release; const gate = new Promise((r) => { release = r; });
  let seen = 0;
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await page.route('**/api/auth/me', async (route) => {
    seen += 1;
    if (seen === 1) { await gate; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Service Unavailable' }) }); }
    return route.continue();
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 3000 }); } catch {}
  await page.waitForTimeout(500);
  // sign out (A) and sign in as a DIFFERENT account B while A's probe is held
  await page.locator('header').getByRole('button', { name: /log out/i }).click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300);
  const B = { u: 'd19a1userb', e: 'd19a1b@desk.local', p: 'TestPass123' };
  await rAndL(B.u, B.e, B.p);
  const tokenB = await page.evaluate((k) => localStorage.getItem(k), tokenKey);
  const hdrBefore = await headerSignedIn();
  console.log(`[${LABEL}]   B signed in (token differs from A):`, !!tokenB && tokenB !== token0, '| header signed in:', hdrBefore);
  release();
  await page.waitForTimeout(1200);
  const tokenAfter = await page.evaluate((k) => localStorage.getItem(k), tokenKey);
  const hdrAfter = await headerSignedIn();
  results.staleKillsCurrent = { survived: tokenAfter === tokenB && !!tokenB, headerSignedIn: hdrAfter, held: seen };
  console.log(`[${LABEL}]   after releasing A's stale 503 — B's token survived:`, results.staleKillsCurrent.survived, '| header signed in:', hdrAfter);
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
}

console.log(`\n[${LABEL}] === VERDICT ===`);
const harnessSane = results.me401.token === null && results.games503.token === token0;
console.log(`[${LABEL}] harness sane (401 clears AND sibling 503 keeps):`, harnessSane,
  ` [401->token=${results.me401.token === null ? 'cleared' : 'kept'}, games503->token=${results.games503.token === token0 ? 'kept' : 'cleared'}]`);
const defectA = results.me503.token !== token0;
const defectB = results.meAbort.token !== token0;
const defectC = !results.staleKillsCurrent.survived;
console.log(`[${LABEL}] A transient 503 on /api/auth/me destroyed the session:`, defectA);
console.log(`[${LABEL}] B network failure on /api/auth/me destroyed the session:`, defectB);
console.log(`[${LABEL}] C stale failure for an OLD token destroyed the CURRENT session:`, defectC);
if (!harnessSane) console.log(`[${LABEL}] RESULT: INCONCLUSIVE (harness controls did not behave; do not trust the cases above)`);
else if (defectA || defectB || defectC) console.log(`[${LABEL}] RESULT: DEFECT (${[defectA && 'A-503', defectB && 'B-offline', defectC && 'C-stale'].filter(Boolean).join(', ')})`);
else console.log(`[${LABEL}] RESULT: PASS`);

child.kill();
await browser.close();

// STRUCT-DESKTOP-19, red pass 1, angle D19-2.
//
// CLAIM UNDER TEST: the account-deletion routes in src/components/MenuDrawer.tsx
// carry a SECOND, weaker copy of the app's dead-session rule —
//   const clearTokenIfExpired = (res) => { if (res.status === 401) updateAuthToken(null); };
// It has no stale-token guard (App.tsx's `handleDeadSessionResponse` clears only
// when `authTokenRef.current === requestToken`) and no request-context gate, so
// a 401 for a token the app has ALREADY replaced destroys the live session.
// Its `catch (err) { setDeleteError(err.message) }` also shows the browser's raw
// network-failure text to the user.
//
// Usage: node _gen/d19a3-dangerzone-session-copy.mjs <worktree> <port> <LABEL>
import { chromium } from 'playwright';
import { startOwnServer, registerAndLogin, ELECTRON_UA } from './harnesslib.mjs';

const WT = process.argv[2];
const PORT = process.argv[3] || '4839';
const LABEL = process.argv[4] || 'RUN';
const srv = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'a3' });
const child = srv.child;
const BASE = srv.base;
console.log(`[${LABEL}] server is ours, serving`, srv.bundle);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, userAgent: ELECTRON_UA });
page.on('dialog', async (d) => { await d.accept(); });

await page.goto(BASE, { waitUntil: 'networkidle' });
try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 4000 }); } catch {}

const rAndL = (u, e, p) => registerAndLogin(page, { u, e, p });

async function openDangerZone() {
  await page.getByRole('button', { name: 'Open workspace menu' }).first().click();
  await page.waitForTimeout(700);
  // The Danger Zone lives behind the drawer's third tab of the same name.
  await page.getByRole('button', { name: /^danger zone$/i }).click({ timeout: 6000 });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /delete account permanent/i }).scrollIntoViewIfNeeded().catch(() => {});
  await page.getByRole('button', { name: /delete account permanent/i }).click({ timeout: 6000 });
  await page.waitForTimeout(300);
}
async function dangerError() {
  // Read the rendered error line itself (textContent of the rose alert block),
  // not innerText of an ancestor: innerText excludes visibility:hidden text and
  // an ancestor filter resolves to the innermost matching node (the title row).
  const txt = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('span, div, p'));
    const hit = nodes.filter((n) => n.children.length === 0 && (n.textContent || '').trim().length > 3)
      .map((n) => (n.textContent || '').trim());
    return hit.join(' | ');
  });
  return { panelText: txt.replace(/\s+/g, ' ') };
}
const K = 'nash_sim_token_local';
const A = { u: 'd19a3a', e: 'd19a3a@desk.local', p: 'TestPass123' };
await rAndL(A.u, A.e, A.p);
const tokenA = await page.evaluate((k) => localStorage.getItem(k), K);
console.log(`[${LABEL}] A signed in:`, !!tokenA);
if (!tokenA) { console.log(`[${LABEL}] ABORT. srv:`, srv.getLog().slice(-500)); child.kill(); await browser.close(); process.exit(2); }

console.log(`\n[${LABEL}] --- CASE A: network failure in the Danger Zone shows the browser's raw error text ---`);
await openDangerZone();
await page.route('**/api/auth/delete-request', (route) => route.abort('failed'));
await page.getByRole('button', { name: /confirm and request verification code/i }).click();
await page.waitForTimeout(1200);
const errA = await dangerError();
const rawLeak = /failed to fetch|load failed|networkerror|typeerror/i.test(errA.panelText);
console.log(`[${LABEL}]   error line rendered:`, (errA.panelText.match(/[^|]*(?:Failed to fetch|Load failed|NetworkError|TypeError|Failed to initialize deletion request)[^|]*/i) || ['(none found)'])[0].trim());
console.log(`[${LABEL}]   raw browser network text shown to the user:`, rawLeak);
await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
await page.screenshot({ path: `/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/round19/findings/STRUCT-DESKTOP-19/002-dangerzone-raw-error-${LABEL}.png`, fullPage: false }).catch(() => {});

console.log(`\n[${LABEL}] --- CASE B: a 401 for an OLD token destroys the CURRENT session ---`);
// Hold the delete-request POST; sign out and sign in as B while it is held;
// release it as a 401 for A's (by then irrelevant) token.
let release; const gate = new Promise((r) => { release = r; });
await page.route('**/api/auth/delete-request', async (route) => {
  await gate;
  return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid or expired session.' }) });
});
await page.getByRole('button', { name: /confirm and request verification code/i }).click();
await page.waitForTimeout(400);
// close the drawer, sign out, sign in as B
await page.getByRole('button', { name: /close menu/i }).click({ timeout: 4000 }).catch(() => {});
await page.waitForTimeout(300);
await page.locator('header').getByRole('button', { name: /log out/i }).click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(400);
const B = { u: 'd19a3b', e: 'd19a3b@desk.local', p: 'TestPass123' };
await rAndL(B.u, B.e, B.p);
const tokenB = await page.evaluate((k) => localStorage.getItem(k), K);
const hdrBefore = await page.locator('header').getByRole('button', { name: /log out/i }).isVisible().catch(() => false);
console.log(`[${LABEL}]   B signed in (token differs from A):`, !!tokenB && tokenB !== tokenA, '| header signed in:', hdrBefore);
release();
await page.waitForTimeout(1500);
const tokenAfter = await page.evaluate((k) => localStorage.getItem(k), K);
const hdrAfter = await page.locator('header').getByRole('button', { name: /log out/i }).isVisible().catch(() => false);
console.log(`[${LABEL}]   after A's stale 401 landed — B's token survived:`, tokenAfter === tokenB && !!tokenB,
  `(stored token is now ${tokenAfter === null ? 'ABSENT' : tokenAfter === tokenB ? "B's" : "some other value"})`, '| header still claims signed in:', hdrAfter);
await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});

console.log(`\n[${LABEL}] === VERDICT ===`);
const staleKills = !(tokenAfter === tokenB && !!tokenB);
const controlOk = !!tokenB && tokenB !== tokenA && hdrBefore;
console.log(`[${LABEL}] control sane (B really was signed in with a different token before release):`, controlOk);
console.log(`[${LABEL}] A: Danger Zone leaks the raw browser network error:`, rawLeak);
console.log(`[${LABEL}] B: a stale 401 for an old token destroyed the current session:`, staleKills);
if (!controlOk) console.log(`[${LABEL}] RESULT: INCONCLUSIVE (control failed)`);
else if (rawLeak || staleKills) console.log(`[${LABEL}] RESULT: DEFECT (${[rawLeak && 'A-raw-error', staleKills && 'B-stale-401'].filter(Boolean).join(', ')})`);
else console.log(`[${LABEL}] RESULT: PASS`);

child.kill();
await browser.close();

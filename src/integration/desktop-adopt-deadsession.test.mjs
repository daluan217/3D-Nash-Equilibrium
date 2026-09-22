// BLUE-LOOP-DESKTOP-22 / SR-46: adopt-local's DEAD-SESSION behaviour, driven
// through the real renderer.
//
// RED-DESKTOP-19/001 was: the local-games offer was the one account-scoped
// route that never told the shared client its 401 meant "this session is
// dead", so the header went on offering "Log out" for a session the server
// had already killed. It was fixed in App.tsx `adoptLocalGames`.
//
// Everything guarding that fix was a SOURCE REGEX (src/localowner.test.ts
// checks the `res.sessionDied` / `res.sessionCleared` branch is written;
// desktop-adopt-local.test.mjs is HTTP-only and never runs the client at
// all). Measured, not assumed: mutating `const requestToken =
// localGamesOffer.token` to `localGamesOffer.token + ' '` leaves every one of
// those patterns literally present — api.request('/api/games/adopt-local'),
// `token: requestToken`, the sessionDied branch, no raw fetch — so all 19
// adopt-local checks and all of localowner.test.ts stay green, while
// `deps.currentToken() === requestToken` can never be true, `clearSession()`
// is never called, and the header claims "signed in" forever. The red probe
// caught it; CI did not.
//
// So this asserts the BEHAVIOUR in a browser: kill the session server-side
// between sign-in and the click, then look at what the page does. The control
// run (session left alive) is what stops this passing by always-clearing.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 3128, not 3119: UNWRITABLE_SAVE_PORT is 3119 in an earlier step of the SAME
// CI job (.github/workflows/test.yml), and IS_ELECTRON makes the server walk
// to the next free port on EADDRINUSE rather than fail (gate review #8, f6).
const PORT = process.env.DESKTOP_ADOPT_DEAD_PORT || '3128';
const BASE = `http://localhost:${PORT}`;
// Electron's UA is what App.tsx reads to decide the offer exists at all
// (`isElectron`), so a plain chromium UA would skip the whole surface.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) nash-equilibrium-simulator/0.0.1 Chrome/128.0.6613.186 '
  + 'Electron/32.2.7 Safari/537.36';

let failures = 0;
let total = 0;
const rec = (name, pass, detail = '') => {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${pass || !detail ? '' : ` — ${detail}`}`);
};

const userData = mkdtempSync(join(tmpdir(), 'nash-adopt-dead-'));
const emptyCwd = mkdtempSync(join(tmpdir(), 'nash-adopt-dead-cwd-'));
const child = spawn(process.execPath, [join(ROOT, 'dist', 'server.cjs')], {
  cwd: emptyCwd,
  env: { PATH: process.env.PATH, HOME: userData, NODE_ENV: 'production', PORT,
    IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
child.stdout.on('data', (d) => { srvLog += d; });
child.stderr.on('data', (d) => { srvLog += d; });

let browser = null;
try {
  // Gate review #8, finding 6: `IS_ELECTRON` makes the server WALK to the next
  // port on EADDRINUSE, while BASE stays fixed — so an `ok` health response
  // could come from a stray listener (or another suite's server) on this port
  // while our child quietly served a different one, and the whole run would
  // measure a foreign process. `/api/health` reports its pid for exactly this;
  // require it to be OUR child's before believing anything that follows.
  let up = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${srvLog.slice(-400)}`);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok && (await r.json())?.pid === child.pid) { up = true; break; }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    throw new Error(`no server with pid ${child.pid} answered on ${PORT} — it may have walked to `
      + `another port because something else holds ${PORT}. Log: ${srvLog.slice(-400)}`);
  }

  browser = await chromium.launch();

  // One scenario = one fresh browser context (its own localStorage, so the
  // second run cannot inherit the first run's cleared/uncleared token) and
  // its own account, against the same desktop server.
  async function run({ killSession, user }) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message)));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.locator('[aria-label="Exit tour"]').click({ timeout: 5000 }).catch(() => {});

    // 1. Save a game with no account: it lands on the local owner, which is
    //    what makes the offer appear at the next sign-in.
    await page.getByRole('button', { name: /save preset/i }).click();
    const sdlg = page.locator('[role="dialog"][aria-label="Save custom game"]');
    await sdlg.waitFor({ state: 'visible' });
    await sdlg.locator('input[type="text"], input:not([type])').first().fill(`${user.u}-device-game`);
    const saveP = page.waitForResponse((r) => r.url().includes('/api/games') && r.request().method() === 'POST');
    await sdlg.getByRole('button', { name: /save game profile/i }).click();
    const saveBody = await (await saveP).json().catch(() => null);

    // 2. Register + sign in. The login response carries the local-games count.
    const authDlg = page.locator('[role="dialog"][aria-label="Account"]');
    await page.locator('header').getByRole('button', { name: /sign in.*sign up/i }).click();
    await authDlg.waitFor({ state: 'visible' });
    await authDlg.getByRole('button', { name: /^sign up$/i }).click().catch(() => {});
    await authDlg.locator('input[placeholder="game_theorist"]').waitFor({ state: 'visible', timeout: 8000 });
    await authDlg.locator('input[placeholder="game_theorist"]').fill(user.u);
    await authDlg.locator('input[placeholder="john@example.com"]').fill(user.e);
    await authDlg.locator('input[placeholder="••••••••"]').first().fill(user.p);
    await authDlg.locator('input[placeholder="••••••••"]').nth(1).fill(user.p);
    await authDlg.getByRole('button', { name: /register account/i }).click();
    await page.waitForTimeout(800);
    await authDlg.getByRole('button', { name: /^log in$/i }).click({ timeout: 2000 }).catch(() => {});
    await authDlg.locator('input[placeholder*="example.com or username"]').waitFor({ state: 'visible', timeout: 8000 });
    await authDlg.locator('input[placeholder*="example.com or username"]').fill(user.e);
    await authDlg.locator('input[placeholder="••••••••"]').first().fill(user.p);
    const loginP = page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST');
    await authDlg.getByRole('button', { name: /^login$/i }).click();
    const loginBody = await (await loginP).json().catch(() => null);
    await authDlg.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

    // 3. The offer. `text=/saved on this device/i` matches BOTH the heading and
    //    the body copy — a strict-mode violation that reads as "not visible"
    //    and silently skips the rest. The dialog's aria-label is the one node.
    const offer = page.locator('[role="dialog"][aria-label="Games saved on this device"]');
    const offerVisible = await offer.isVisible({ timeout: 5000 }).catch(() => false);

    const tokenBefore = await page.evaluate(() => localStorage.getItem('nash_sim_token_local'));

    // 4. Optionally kill the session server-side, BEFORE the click. A password
    //    reset bumps tokenVersion, which is what getAuthUser checks, so the
    //    token the offer holds is dead by the time the button is pressed.
    let killed = null;
    if (killSession) {
      killed = await page.evaluate(async ({ email, newPassword }) => {
        const fr = await fetch('/api/auth/forgot-password', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        const fb = await fr.json().catch(() => ({}));
        const code = fb.recoveryCode || fb.code;
        const rr = await fetch('/api/auth/reset-password', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, code, newPassword }) });
        return { forgot: fr.status, reset: rr.status };
      }, { email: user.e, newPassword: `${user.p}X9` });
    }

    // 5. Press the button the user presses.
    const moveP = page.waitForResponse((r) => r.url().includes('/api/games/adopt-local'));
    await page.getByRole('button', { name: /move .* into my account/i }).click();
    const moveResp = await moveP;
    const moveBody = await moveResp.json().catch(() => null);
    await page.waitForTimeout(900);

    const after = await page.evaluate(() => ({
      token: localStorage.getItem('nash_sim_token_local'),
      logText: Array.from(document.querySelectorAll('*'))
        .filter((el) => el.children.length === 0)
        .map((el) => el.textContent || '').join('\n'),
    }));
    const headerSignedIn = await page.locator('header').getByRole('button', { name: /log out/i })
      .isVisible().catch(() => false);
    const offerStillOpen = await offer.isVisible().catch(() => false);

    await ctx.close();
    return { saveBody, loginBody, offerVisible, tokenBefore, killed,
      status: moveResp.status(), moveBody, after, headerSignedIn, offerStillOpen, pageErrors };
  }

  console.log('── the session is killed between sign-in and the click ──');
  const dead = await run({ killSession: true, user: { u: 'deadses', e: 'deadses@desk.local', p: 'TestPass123' } });
  rec('precondition: the no-account save landed on the local owner',
    dead.saveBody?.game?.userId === 'local-owner', JSON.stringify(dead.saveBody?.game?.userId));
  rec('precondition: the login response reports 1 game saved on this device',
    dead.loginBody?.localGames === 1, JSON.stringify(dead.loginBody?.localGames));
  rec('precondition: the offer dialog is on screen', dead.offerVisible === true);
  rec('precondition: the page held a token before the click',
    typeof dead.tokenBefore === 'string' && dead.tokenBefore.length > 20);
  rec('precondition: the out-of-band password reset succeeded',
    dead.killed?.forgot === 200 && dead.killed?.reset === 200, JSON.stringify(dead.killed));
  rec('the server refuses the move with 401', dead.status === 401, `status ${dead.status}`);
  // THE FIX. Each of these dies on the divergent-token mutant described above.
  rec('FIX: the dead token is cleared from storage, not left behind',
    dead.after.token === null, String(dead.after.token).slice(0, 30));
  rec('FIX: the header stops claiming the user is signed in',
    dead.headerSignedIn === false);
  rec('FIX: the offer closes rather than sitting there un-actionable',
    dead.offerStillOpen === false);
  rec('FIX: the user is told the session ended and that nothing was lost',
    /session ended before the move/i.test(dead.after.logText)
    && /still on this device/i.test(dead.after.logText),
    dead.after.logText.split('\n').filter((l) => /session|device/i.test(l)).slice(-3).join(' | ').slice(0, 200));
  rec('the renderer threw nothing', dead.pageErrors.length === 0, dead.pageErrors.join(' | ').slice(0, 200));

  console.log('── CONTROL: the same flow with a LIVE session ──');
  // Without this the four FIX checks above would all pass on a client that
  // cleared the session on every response, which would sign the user out of a
  // perfectly good account and lose the move.
  const live = await run({ killSession: false, user: { u: 'liveses', e: 'liveses@desk.local', p: 'TestPass123' } });
  rec('CONTROL: the offer appears for the live session too', live.offerVisible === true);
  // The dead run's game was REFUSED, so it is still on the device: the live
  // run sees its own save plus that one. Read the number the server itself
  // reported at login rather than hardcoding it — a literal here would go
  // stale the moment the run order changed, and would not notice a move that
  // adopted the wrong number of games.
  const liveCount = live.loginBody?.localGames;
  rec('CONTROL: the login count is the 2 games actually left on the device',
    liveCount === 2, JSON.stringify(liveCount));
  rec('CONTROL: the move succeeds (200) and adopts exactly the games the server counted',
    live.status === 200 && live.moveBody?.adopted === liveCount,
    JSON.stringify({ s: live.status, b: live.moveBody, counted: liveCount }));
  rec('CONTROL: a good session keeps its token — clearing is not unconditional',
    live.after.token === live.tokenBefore && typeof live.after.token === 'string');
  rec('CONTROL: the header still shows the user signed in', live.headerSignedIn === true);
  rec('CONTROL: the offer closes after a successful move', live.offerStillOpen === false);
  rec('CONTROL: the log reports the move, not a dead session',
    new RegExp(`Moved ${liveCount} saved games? from this device`, 'i').test(live.after.logText)
    && !/session ended before the move/i.test(live.after.logText),
    live.after.logText.split('\n').filter((l) => /Moved|session/i.test(l)).slice(-3).join(' | ').slice(0, 200));
  rec('CONTROL: the renderer threw nothing', live.pageErrors.length === 0, live.pageErrors.join(' | ').slice(0, 200));
} catch (e) {
  rec('test script completed without an exception', false, String(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  rmSync(userData, { recursive: true, force: true });
  rmSync(emptyCwd, { recursive: true, force: true });
}

// SR-47: the count is DECLARED, not counted — a silently skipped block
// otherwise prints "N/N passed" and exits 0. Measured: filtering one data
// array to empty in desktop-dead-token-owner removed six checks and the run
// said "37/37 checks passed".
// Gate review #8, finding 1: this said 18 while 19 checks run, and the banner
// below printed a hardcoded "18/18" instead of the measured total. Both are
// the defect this file exists to close, in the file that closes it: deleting
// one check left `total` at 18, `18 < 18` false, rc=0, banner unchanged. The
// floor is now EXACT and the banner prints what was counted.
const EXPECTED_CHECKS = 19;
if (total !== EXPECTED_CHECKS) {
  console.error(`FAILED: ${total} checks ran, expected exactly ${EXPECTED_CHECKS} — a block was `
    + 'skipped (fewer) or double-counted (more). Change EXPECTED_CHECKS deliberately.');
  process.exit(1);
}
if (failures) {
  console.log(`\n✗ desktop-adopt-deadsession: ${failures} of ${total} failed`);
  process.exit(1);
}
console.log(`\n══════ DESKTOP ADOPT DEAD-SESSION: ${total}/${EXPECTED_CHECKS} checks passed ══════`);

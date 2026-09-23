// Positive control for finding 001 (adoptLocalGames): the SAME same-identity
// dead-token technique (hold a request, invalidate via password reset,
// release), applied to DELETE instead -- to confirm the shared
// handleDeadSessionResponse helper DOES clear the token & flip the header on
// THIS candidate, so the adopt-local gap is a genuine asymmetry and not an
// artifact of the harness/technique.
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WT = process.argv[2];
const PORT = process.argv[3] || '4804';
const userData = mkdtempSync(join(tmpdir(), 'nash-rd19-ctl-'));
const emptyCwd = mkdtempSync(join(tmpdir(), 'nash-rd19-ctl-cwd-'));
// Server-side access lines (arrival/finish of every non-GET /api request) classify a lost DELETE.
const child = spawn('node', ['--require', join(WT, 'src/desktop/access-log.cjs'), join(WT, 'dist/server.cjs')], {
  cwd: emptyCwd,
  env: { PATH: process.env.PATH, HOME: userData, NODE_ENV: 'production', PORT, IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
child.stdout.on('data', (d) => { srvLog += d; });
child.stderr.on('data', (d) => { srvLog += d; });
let lastHealth = '(none yet)';
const netLog = []; // every /api/games request's lifecycle, for the abort report
let uiState = '(none)'; // refreshed on a timer so a synchronous abort handler can report it
const t0 = Date.now(); const ts = () => `+${Date.now() - t0}ms`;
// Reap on ANY exit path. Killing only on the success path is what leaked a
// server onto 4812 for 15 minutes in S71; the next probe then met a stale
// holder and its own child walked to port+1.
// It must also REPORT: a bare process.exit(1) on uncaughtException swallowed
// the error, and S74's control-delete failure left no trace in its log.
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (err) => {
    // Diagnose BEFORE the kill: S84's "no listener at abort" was the probe's own kill.
    if (sig === 'exit') { try { child.kill('SIGKILL'); } catch {} return; }
    console.error(`PROBE ABORTED (${sig}):`, err?.stack ?? err);
    // S74-008: make a recurrence diagnosable in ONE run — who held the port,
    // and the last health body this probe saw from it.
    try {
      const holders = execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
      for (const h of holders) console.error(`  port ${PORT} held by pid ${h}: ${execSync(`ps -o command= -p ${h} 2>/dev/null || true`).toString().trim()}`);
      if (!holders.length) console.error(`  port ${PORT}: no listener at abort`);
    } catch (e) { console.error('  port holder lookup failed:', e.message); }
    console.error(`  our child pid ${child.pid}, exitCode ${child.exitCode}; last /api/health seen: ${lastHealth}`);
    console.error(`  /api/games request log:\n    ${netLog.join('\n    ') || '(none)'}`);
    console.error(`  UI at last checkpoint: ${uiState}`);
    console.error(`  server access lines: ${srvLog.split('\n').filter((l) => l.startsWith('ACCESS')).join(' | ') || '(none)'}`);
    console.error(`  server log tail: ${srvLog.slice(-600).replace(/\n/g, ' | ')}`);
    try { child.kill('SIGKILL'); } catch {}
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
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 nash-equilibrium-simulator/0.0.193 Electron/32.2.7 Safari/537.36';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: UA });
page.on('dialog', async (d) => { netLog.push(`${ts()} dialog ${d.type()}: ${d.message().slice(0, 80)}`); await d.accept(); });
for (const ev of ['request', 'requestfinished', 'requestfailed']) {
  page.on(ev, (r) => { if (r.url().includes('/api/games')) netLog.push(`${ts()} ${ev} ${r.method()} ${r.url().replace(BASE, '')}${ev === 'requestfailed' ? ' ' + r.failure()?.errorText : ''}`); });
}
page.on('response', (r) => { if (r.url().includes('/api/games')) netLog.push(`${ts()} response ${r.request().method()} ${r.status()}`); });
page.on('pageerror', (e) => netLog.push(`${ts()} pageerror ${String(e).slice(0, 120)}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') netLog.push(`${ts()} console.${m.type()} ${m.text().slice(0, 140)}`); });
setInterval(() => { page.evaluate(() => ({
  dialogs: Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).map((d) => `${d.getAttribute('aria-label')}: ${(d.textContent || '').replace(/\s+/g, ' ').slice(0, 160)}`),
  token: !!localStorage.getItem('nash_sim_token_local'),
  header: (document.querySelector('header')?.textContent || '').replace(/\s+/g, ' ').slice(0, 100),
})).then((u) => { uiState = JSON.stringify(u); if (process.env.CTL_SHOT) page.screenshot({ path: process.env.CTL_SHOT }).catch(() => {}); }).catch(() => {}); }, 1000).unref();
await page.goto(BASE, { waitUntil: 'networkidle' });
const { dismissTourForSetup } = await import(pathToFileURL(join(WT, 'src/e2e/tour.mjs')).href);
await dismissTourForSetup(page, 'clear the first-run tour before signing in');

const authDlg = page.locator('[role="dialog"][aria-label="Account"]');
async function registerAndLogin(username, email, password) {
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
  await authDlg.getByRole('button', { name: /^login$/i }).click();
  await authDlg.waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(400);
  const offer = page.locator('[role="dialog"][aria-label="Games saved on this device"]');
  if (await offer.isVisible({ timeout: 800 }).catch(() => false)) {
    await page.getByRole('button', { name: /leave .* on this device/i }).click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(200);
  }
}

await registerAndLogin('rd19ctl', 'rd19ctl@desk.local', 'TestPass123');

await page.getByRole('button', { name: /save preset/i }).click();
const sdlg = page.locator('[role="dialog"][aria-label="Save custom game"]');
await sdlg.waitFor({ state: 'visible' });
await sdlg.locator('input[type="text"], input:not([type])').first().fill('CtlGame');
const saveRespP = page.waitForResponse((r) => r.url().includes('/api/games') && r.request().method() === 'POST');
await sdlg.getByRole('button', { name: /save game profile/i }).click();
const saveResp = await saveRespP;
const saveBody = await saveResp.json();
const gid = saveBody.game.id;
console.log('saved game id:', gid);

let releaseHold; const holdGate = new Promise((r) => { releaseHold = r; });
await page.route('**/api/games/**', async (route, request) => {
  if (request.method() === 'DELETE') { netLog.push(`${ts()} route: holding DELETE`); await holdGate; netLog.push(`${ts()} route: releasing DELETE`); }
  await route.continue().catch((e) => netLog.push(`${ts()} route.continue failed: ${e.message.slice(0, 100)}`));
});
const tokenBefore = await page.evaluate(() => localStorage.getItem('nash_sim_token_local'));
// Classify a missing DELETE (director): (a) never issued, (b) aborted by the page, (c) no answer.
page.on('framenavigated', (f) => { if (f === page.mainFrame()) netLog.push(`${ts()} framenavigated ${f.url().replace(BASE, '')}`); });
// Wait on STATE, not time: the save dialog must be gone before the row is clicked.
await sdlg.waitFor({ state: 'hidden', timeout: 10000 });
const rowsAtClick = await page.evaluate(() => Array.from(document.querySelectorAll('[data-saved-game]')).map((r) => ({
  text: (r.textContent || '').trim().slice(0, 30), drawer: r.hasAttribute('data-drawer-game'),
  del: !!r.querySelector('button[title="Delete this saved game"]'), disabled: !!r.querySelector('button[title="Delete this saved game"]')?.disabled })));
const tokenAtClick = await page.evaluate(() => !!localStorage.getItem('nash_sim_token_local'));
netLog.push(`${ts()} rows at click: ${JSON.stringify(rowsAtClick)} | token present: ${tokenAtClick}`);
// The 10 s watch starts at the click, not before the dialog wait above.
const delReqP = page.waitForRequest((r) => r.url().includes(`/api/games/${gid}`) && r.method() === 'DELETE', { timeout: 10000 }).catch(() => null);
await page.locator('[data-saved-game]:not([data-drawer-game])').filter({ hasText: 'CtlGame' }).locator('button[title="Delete this saved game"]').click();
netLog.push(`${ts()} clicked Delete`);
await page.waitForTimeout(300);
const inv = await page.evaluate(async ({ email, newPassword }) => {
  const fr = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  const fb = await fr.json().catch(() => ({}));
  const code = fb.recoveryCode || fb.code;
  const rr = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code, newPassword }) });
  return { forgotStatus: fr.status, resetStatus: rr.status };
}, { email: 'rd19ctl@desk.local', newPassword: 'NewPass456' });
console.log('invalidation:', JSON.stringify(inv));
const delReq = await delReqP;
netLog.push(`${ts()} DELETE request ${delReq ? 'issued' : 'NOT issued within 10 s'}`);
releaseHold();
const { deleteFate } = await import(pathToFileURL(join(WT, 'src/desktop/delete-fate.mjs')).href);
const delResp = await deleteFate(delReq, { page, gameId: gid, srvLog: () => srvLog, dbFile: join(userData, 'db.json') });
await page.waitForTimeout(Number(process.env.CTL_SETTLE_MS ?? 600));
console.log('DELETE final status:', delResp.status());
// Same fix as the header read below: a single read at a fixed offset races
// the clear. Poll BOTH to one deadline -- a token that is genuinely left
// behind still fails, because it never goes null.
let tokenAfter = 'unread';
for (let i = 0; i < 50; i++) {
  tokenAfter = await page.evaluate(() => localStorage.getItem('nash_sim_token_local'));
  if (tokenAfter === null) break;
  await page.waitForTimeout(100);
}
console.log('token before:', tokenBefore?.slice(0,20), '| after:', tokenAfter, '| cleared:', tokenAfter === null);
// BLUE S57: this was a SINGLE read at a fixed offset. Measured: the token and
// the header do not clear in the same tick -- the header follows ~200ms later
// -- so at a short offset this reported 'still signed in' on a correct
// product (deterministic at offset 0: 3/3). Poll to a deadline; a header that
// is genuinely stuck still fails, because it never clears.
let headerShowsSignedIn = true;
for (let i = 0; i < 50; i++) {
  headerShowsSignedIn = await page.locator('header').getByRole('button', { name: /log out/i }).isVisible().catch(() => false);
  if (!headerShowsSignedIn) break;
  await page.waitForTimeout(100);
}
console.log('header still shows Log out (claims signed-in):', headerShowsSignedIn);
// DIAGNOSIS (blue, S57): poll AFTER the probe's single fixed-offset read, in
// the probe's own sequence, to tell a stuck header from a slow one.
{
  const tr = [];
  for (let i = 0; i < 40; i++) {
    const s = await page.evaluate(() => ({
      t: localStorage.getItem('nash_sim_token_local'),
      l: !!Array.from(document.querySelectorAll('header button')).find((b) => /log out/i.test(b.textContent || '')),
    }));
    tr.push(`+${i * 100}ms token=${s.t === null ? 'null' : 'present'} logout=${s.l}`);
    if (!s.l && s.t === null) break;
    await page.waitForTimeout(100);
  }
  console.log('POST-READ TRACE:', tr.join(' | '));
}
console.log('CONTROL RESULT:', (tokenAfter === null && !headerShowsSignedIn) ? 'PASS (Delete correctly clears dead token/header)' : 'UNEXPECTED (Delete also fails to clear)');
child.kill();
await browser.close();
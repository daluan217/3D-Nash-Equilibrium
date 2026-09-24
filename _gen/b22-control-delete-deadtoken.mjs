// Positive control for finding 001 (adoptLocalGames): the SAME same-identity
// dead-token technique (hold a request, invalidate via password reset,
// release), applied to DELETE instead -- to confirm the shared
// handleDeadSessionResponse helper DOES clear the token & flip the header on
// THIS candidate, so the adopt-local gap is a genuine asymmetry and not an
// artifact of the harness/technique.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WT = process.argv[2];
const PORT = process.argv[3] || '4804';
const userData = mkdtempSync(join(tmpdir(), 'nash-rd19-ctl-'));
const emptyCwd = mkdtempSync(join(tmpdir(), 'nash-rd19-ctl-cwd-'));
const child = spawn('node', [join(WT, 'dist/server.cjs')], {
  cwd: emptyCwd,
  env: { PATH: process.env.PATH, HOME: userData, NODE_ENV: 'production', PORT, IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const BASE = `http://localhost:${PORT}`;
async function waitReady() { for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); } throw new Error('never ready'); }
await waitReady();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 nash-equilibrium-simulator/0.0.193 Electron/32.2.7 Safari/537.36';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: UA });
page.on('dialog', async (d) => { await d.accept(); });
await page.goto(BASE, { waitUntil: 'networkidle' });
try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 4000 }); } catch {}

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
  await authDlg.getByRole('button', { name: /register account/i }).click();
  await page.waitForTimeout(600);
  await authDlg.getByRole('button', { name: /^log in$/i }).click({ timeout: 1500 }).catch(() => {});
  await authDlg.locator('input[placeholder*="example.com or username"]').waitFor({ state: 'visible', timeout: 5000 });
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
  if (request.method() === 'DELETE') { await holdGate; }
  await route.continue();
});
const tokenBefore = await page.evaluate(() => localStorage.getItem('nash_sim_token_local'));
const delRespP = page.waitForResponse((r) => r.url().includes(`/api/games/${gid}`) && r.request().method() === 'DELETE');
await page.locator('[data-saved-game]:not([data-drawer-game])').filter({ hasText: 'CtlGame' }).locator('button[title="Delete this saved game"]').click();
await page.waitForTimeout(300);
const inv = await page.evaluate(async ({ email, newPassword }) => {
  const fr = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  const fb = await fr.json().catch(() => ({}));
  const code = fb.recoveryCode || fb.code;
  const rr = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code, newPassword }) });
  return { forgotStatus: fr.status, resetStatus: rr.status };
}, { email: 'rd19ctl@desk.local', newPassword: 'NewPass456' });
console.log('invalidation:', JSON.stringify(inv));
releaseHold();
const delResp = await delRespP;
await page.waitForTimeout(600);
console.log('DELETE final status:', delResp.status());
const tokenAfter = await page.evaluate(() => localStorage.getItem('nash_sim_token_local'));
console.log('token before:', tokenBefore?.slice(0,20), '| after:', tokenAfter, '| cleared:', tokenAfter === null);
// Sample the header over time rather than once at t=600ms: a single instant
// check cannot tell "the header never updates" (a real stale-identity defect)
// from "the check ran before React re-rendered". Assertion unchanged — the
// FINAL sample is what the verdict below uses.
const headerSamples = [];
for (const t of [0, 400, 800, 1500, 2500, 4000]) {
  if (t) await page.waitForTimeout(t === 400 ? 400 : t === 800 ? 400 : t === 1500 ? 700 : t === 2500 ? 1000 : 1500);
  headerSamples.push({
    t: 600 + t,
    logout: await page.locator('header').getByRole('button', { name: /log out/i }).isVisible().catch(() => false),
    signin: await page.locator('header').getByRole('button', { name: /sign in|log in|account/i }).isVisible().catch(() => false),
    token: await page.evaluate(() => localStorage.getItem('nash_sim_token_local')),
  });
}
console.log('header samples over time:', JSON.stringify(headerSamples));
const headerShowsSignedIn = headerSamples[headerSamples.length - 1].logout;
console.log('header still shows Log out (claims signed-in):', headerShowsSignedIn);
console.log('CONTROL RESULT:', (tokenAfter === null && !headerShowsSignedIn) ? 'PASS (Delete correctly clears dead token/header)' : 'UNEXPECTED (Delete also fails to clear)');
child.kill();
await browser.close();
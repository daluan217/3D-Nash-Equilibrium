// Light+dark screenshots of the FIXED Save dialog error state (RED-DESKTOP-15/001):
// a desktop local owner's dropped connection now shows a plain rose error,
// never the Sign In / Sign Up invitation.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = process.env.VIS_PORT || '4815';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.VIS_OUT || '/tmp';
const root = path.resolve(import.meta.dirname, '..');
const userData = mkdtempSync(path.join(os.tmpdir(), 'nash-vis-d15-'));
const server = spawn('node', [path.join(root, 'dist/server.cjs')], {
  cwd: userData,
  env: { ...process.env, NODE_ENV: 'production', PORT, IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: userData },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', () => {});
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch {} if (!ready) await new Promise((r) => setTimeout(r, 500)); }
if (!ready) { console.error('server never came up'); server.kill('SIGKILL'); process.exit(1); }

const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({
    viewport: { width: 900, height: 700 }, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) nash-equilibrium-simulator/0.0.0 Chrome/128.0.0.0 Electron/32.0.0 Safari/537.36',
  });
  await ctx.addInitScript((t) => { try { localStorage.setItem('nash_sim_theme', t); } catch {} }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_RESET/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 15000 }); } catch { /* may not show */ }
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'), null, { timeout: 10000 }).catch(() => {});
  await page.route('**/api/games', (route) => (route.request().method() === 'POST' ? route.abort('connectionreset') : route.continue()));
  await page.getByRole('button', { name: /save preset/i }).click();
  const dlg = page.locator('[role="dialog"][aria-label="Save custom game"]');
  await dlg.waitFor({ state: 'visible', timeout: 8000 });
  await dlg.locator('input[placeholder="e.g. Battle of the Sexes 2.0"]').fill('Screenshot-LocalOwner-NetFail');
  await dlg.getByRole('button', { name: /save game profile/i }).click();
  await dlg.getByText(/network error/i).waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  const text = (await dlg.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
  const hasInvite = await dlg.getByRole('button', { name: /sign in \/ sign up/i }).isVisible().catch(() => false);
  console.log(`${theme}: dialog="${text}" hasInvite=${hasInvite} errors=${errors.length}`);
  await dlg.screenshot({ path: `${OUT}/save-error-${theme}.png` });
  await ctx.close();
}
await browser.close();
server.kill('SIGKILL');

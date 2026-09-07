// Director's independent check of RED-DESKTOP-15/001: on desktop, as a LOCAL OWNER (no account), does a
// non-auth save failure render the "Sign In / Sign Up" invitation?
import { spawn } from 'node:child_process'; import { chromium } from 'playwright'; import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const WT = process.argv[2]; const PORT = process.argv[3] || '4748'; const userData = mkdtempSync(join(tmpdir(), 'nash-d15-'));
const child = spawn('node', [join(WT, 'dist/server.cjs')], { cwd: userData, env: { PATH: process.env.PATH, HOME: userData, NODE_ENV: 'production', PORT, IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: userData }, stdio: ['ignore', 'pipe', 'pipe'] });
const BASE = `http://localhost:${PORT}`;
for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) nash-equilibrium-simulator/0.0.175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36' });
await p.goto(BASE, { waitUntil: 'networkidle' }); try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 8000 }); } catch {}
const signedOut = await p.getByRole('button', { name: /sign in.*sign up/i }).first().isVisible().catch(() => false);
const saveBtn = p.getByRole('button', { name: /save preset/i });
console.log('precondition: local owner (signed out, Save Preset offered):', signedOut, await saveBtn.isVisible());
// a NON-auth failure: the request is dropped on the floor
await p.route('**/api/games', (route) => route.request().method() === 'POST' ? route.abort('connectionfailed') : route.continue());
await saveBtn.click(); const dlg = p.locator('[role="dialog"][aria-label="Save custom game"]'); await dlg.waitFor({ state: 'visible' });
await dlg.locator('input[type="text"], input:not([type])').first().fill('LocalOwnerNetFail');
await dlg.getByRole('button', { name: /save game profile/i }).click();
await p.waitForTimeout(1500);
const text = (await dlg.textContent()) || '';
const invite = await dlg.getByRole('button', { name: /sign in/i }).isVisible().catch(() => false);
console.log('dialog text after a dropped POST:', text.replace(/\s+/g, ' ').slice(0, 260));
console.log(invite ? 'DEFECT: a network failure is rendered as a Sign In / Sign Up invitation for a local owner who needs no account' : 'PASS: plain error, no sign-in invitation');
await b.close(); child.kill();

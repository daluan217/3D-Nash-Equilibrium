// Director's independent check of RED-APP-15/001: click the empty-library card in the drawer, press Tab once — does focus leave the drawer?
import { spawn } from 'node:child_process'; import { chromium, webkit } from 'playwright'; import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const WT = process.argv[2]; const PORT = process.argv[3] || '4731'; const engine = process.argv[4] || 'chromium'; const userData = mkdtempSync(join(tmpdir(), 'nash-a15-'));
const child = spawn('node', [join(WT, 'dist/server.cjs')], { cwd: userData, env: { PATH: process.env.PATH, HOME: userData, NODE_ENV: 'production', PORT, ELECTRON_USER_DATA_PATH: userData }, stdio: ['ignore', 'pipe', 'pipe'] });
const BASE = `http://localhost:${PORT}`;
for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
const b = await (engine === 'webkit' ? webkit : chromium).launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto(BASE, { waitUntil: 'networkidle' }); try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 8000 }); } catch {}
const u = `dir${Date.now()}`; const h = { 'Content-Type': 'application/json' };
await fetch(BASE + '/api/auth/register', { method: 'POST', headers: h, body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'TestPass123' }) });
const tok = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: h, body: JSON.stringify({ email: `${u}@example.com`, password: 'TestPass123' }) })).json()).token;
await p.evaluate((t) => localStorage.setItem('nash_sim_token_local', t), tok); await p.reload({ waitUntil: 'networkidle' }); try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 5000 }); } catch {}
await p.getByRole('button', { name: /open workspace menu/i }).first().click();
const drawer = p.locator('[role="dialog"]', { has: p.locator('[data-focus-fallback="drawer-games"]') });
await p.getByRole('tab', { name: /library/i }).or(p.getByRole('button', { name: /library/i })).first().click().catch(() => {});
const card = p.locator('[data-focus-fallback="drawer-games"]'); await card.waitFor({ state: 'visible', timeout: 8000 });
await card.evaluate((e) => e.scrollIntoView({ block: 'center' }));
const cb = await card.boundingBox(); const cx = cb.x + cb.width / 2, cy = cb.y + Math.min(20, cb.height / 2);
const hit = await p.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-focus-fallback="drawer-games"]'), [cx, cy]);
if (!(cy < 900 && hit)) throw new Error(`card click point not on-screen/hit-testable: y=${cy} hit=${hit}`);
await p.mouse.click(cx, cy);
const before = await p.evaluate(() => ({ tag: document.activeElement.tagName, landmark: document.activeElement.getAttribute('data-focus-fallback'), inDialog: !!document.activeElement.closest('[role="dialog"]') }));
await p.keyboard.press('Tab'); await p.waitForTimeout(400);
const after = await p.evaluate(() => ({ tag: document.activeElement.tagName, label: (document.activeElement.getAttribute('title') || document.activeElement.getAttribute('aria-label') || document.activeElement.textContent || '').slice(0, 40), inDialog: !!document.activeElement.closest('[role="dialog"]') }));
console.log(engine, 'after card click:', JSON.stringify(before)); console.log(engine, 'after one Tab:', JSON.stringify(after));
console.log(after.inDialog ? 'PASS: focus stayed in the drawer' : 'DEFECT: one Tab from the library card left the aria-modal drawer');
await b.close(); child.kill();

// Director's independent check of RED-APP-15/002 (admin overlay outside ModalSurface) and /003 (tour Next clickable over the open drawer).
import { spawn } from 'node:child_process'; import { chromium } from 'playwright'; import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const WT = process.argv[2]; const PORT = process.argv[3] || '4739'; const userData = mkdtempSync(join(tmpdir(), 'nash-a15b-'));
const child = spawn('node', [join(WT, 'dist/server.cjs')], { cwd: userData, env: { PATH: process.env.PATH, HOME: userData, NODE_ENV: 'production', PORT, ELECTRON_USER_DATA_PATH: userData }, stdio: ['ignore', 'pipe', 'pipe'] });
const BASE = `http://localhost:${PORT}`;
for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto(BASE, { waitUntil: 'networkidle' }); // tour open on first visit
const tourStep = () => p.evaluate(() => (document.body.innerText.match(/(\d+)\s*\/\s*19/) || [])[1] || null);
const payoffs = () => p.evaluate(() => [...document.querySelectorAll('input[inputmode="decimal"]')].slice(0, 8).map((i) => i.value).join(','));
console.log('tour open, step', await tourStep(), 'payoffs', await payoffs());
// ── 003: open the drawer under the tour, click the tour's Next button
await p.getByRole('button', { name: /open workspace menu/i }).first().click();
await p.getByRole('button', { name: /close menu/i }).first().waitFor({ state: 'visible', timeout: 8000 });
// BLUE-MODAL-16 fix (RED-APP-15/003): the Next button is now aria-hidden
// while blocked, which correctly removes it from the a11y tree — so a
// role-based locator can no longer find it post-fix. Locate by DOM text
// instead, which does not depend on the a11y tree either way.
const next = p.locator('button', { hasText: /^Next\s*$/ }).first();
const nb = await next.boundingBox();
const hit = nb ? await p.evaluate(([x, y]) => { const h = document.elementFromPoint(x, y); return { tag: h?.tagName, text: (h?.textContent || '').slice(0, 20), inDialog: !!h?.closest('[role="dialog"]') }; }, [nb.x + nb.width / 2, nb.y + nb.height / 2]) : null;
console.log('003 drawer open; hit-test at tour Next centre:', JSON.stringify(hit));
const s0 = await tourStep(), pay0 = await payoffs();
if (nb) { await p.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2); await p.waitForTimeout(700); }
const s1 = await tourStep(), pay1 = await payoffs();
console.log('003 after one click on Next with the drawer open: step', s0, '->', s1, 'payoffs changed:', pay0 !== pay1);
console.log(s1 !== s0 ? 'DEFECT 003: the tour advanced from a pointer click while an aria-modal drawer is open' : 'PASS 003: tour not clickable over the drawer');
await p.keyboard.press('Escape'); await p.waitForTimeout(400);
await p.getByRole('button', { name: /close menu/i }).first().click().catch(() => {}); await p.waitForTimeout(400);
// ── 002: triple-click the header compass icon → admin overlay; type into its password field
const stepBefore = await tourStep();
const compass = p.locator('header svg').first(); const cb = await compass.boundingBox();
await p.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2, { clickCount: 3 }); await p.waitForTimeout(600);
const overlay = await p.evaluate(() => { const els = [...document.querySelectorAll('div')].filter((d) => /fixed/.test(d.className) && /inset-0/.test(d.className)); return els.map((d) => ({ role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), surface: d.getAttribute('data-modal-surface'), hasPw: !!d.querySelector('input[type="password"]') })).filter((o) => o.hasPw); });
console.log('002 fixed inset-0 overlays with a password field after the triple-click:', JSON.stringify(overlay));
if (overlay.length) { await p.locator('input[type="password"]').first().click(); for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowRight'); await p.waitForTimeout(500); }
const stepAfter = await tourStep();
console.log('002 tour step before/after 3 ArrowRight typed into the admin password field:', stepBefore, '->', stepAfter, '| overlay role/registry:', overlay[0]?.role ?? 'none', overlay[0]?.surface ?? 'not-a-ModalSurface');
console.log(overlay.length && stepAfter !== stepBefore ? 'DEFECT 002: an overlay outside ModalSurface lets its own keystrokes drive the tour' : (overlay.length ? 'PASS 002 (keys gated)' : 'NO overlay opened (harness gap)'));
await b.close(); child.kill();

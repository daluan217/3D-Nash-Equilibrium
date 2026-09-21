// SWEEP 45: angle1 has aborted at the SAME line in sweeps 43, 44 and 45 —
// login returns localGames:1 but the "Games saved on this device" offer never
// becomes visible, so the probe can never reach the adoptLocalGames route it
// exists to attack. Three readings, and I have never distinguished them:
//   (a) harness: the probe's own dialog-dismissal / timing is wrong.
//   (b) product: the offer IS rendered but something (registry queueing,
//       z-order, the auth dialog's exit) keeps it from being visible, so a
//       real desktop user who signs in after saving locally is never offered
//       their games — silent data orphaning.
//   (c) product: the offer is never rendered at all.
// Distinguish by asking the DOM directly rather than Playwright's visibility:
// is the panel IN the document? what does the registry think is active? what
// is on top at the centre of the screen?
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WT = process.argv[2];
const PORT = process.argv[3] || '4845';
const userData = mkdtempSync(join(tmpdir(), 'nash-s45o-'));
const emptyCwd = mkdtempSync(join(tmpdir(), 'nash-s45o-cwd-'));

const child = spawn('node', [join(WT, 'dist/server.cjs')], {
  cwd: emptyCwd,
  env: { PATH: process.env.PATH, HOME: userData, NODE_ENV: 'production', PORT, IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; child.stdout.on('data', (d) => srvLog += d); child.stderr.on('data', (d) => srvLog += d);

const BASE = `http://localhost:${PORT}`;
for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) nash-equilibrium-simulator/0.0.193 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: UA });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e.message).slice(0, 160)));
await page.goto(BASE, { waitUntil: 'networkidle' });
try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 4000 }); } catch {}

console.log('UA electron?', await page.evaluate(() => navigator.userAgent.toLowerCase().includes('electron')));

// Save a game signed out.
await page.getByRole('button', { name: /save preset/i }).click();
const sdlg = page.locator('[role="dialog"][aria-label="Save custom game"]');
await sdlg.waitFor({ state: 'visible' });
await sdlg.locator('input[type="text"], input:not([type])').first().fill('DeviceOnlyGame');
const sresp = page.waitForResponse((r) => r.url().includes('/api/games') && r.request().method() === 'POST');
await sdlg.getByRole('button', { name: /save game profile/i }).click();
const sbody = await (await sresp).json().catch(() => null);
console.log('local save userId:', sbody?.game?.userId);
await page.waitForTimeout(500);

// Register + log in.
const authDlg = page.locator('[role="dialog"][aria-label="Account"]');
await page.locator('header').getByRole('button', { name: /sign in.*sign up/i }).click();
await authDlg.waitFor({ state: 'visible' });
await authDlg.getByRole('button', { name: /^sign up$/i }).click().catch(() => {});
await authDlg.locator('input[placeholder="game_theorist"]').waitFor({ state: 'visible', timeout: 5000 });
await authDlg.locator('input[placeholder="game_theorist"]').fill('s45o');
await authDlg.locator('input[placeholder="john@example.com"]').fill('s45o@desk.local');
await authDlg.locator('input[placeholder="••••••••"]').first().fill('TestPass123');
await authDlg.locator('input[placeholder="••••••••"]').nth(1).fill('TestPass123');
await authDlg.getByRole('button', { name: /register account/i }).click();
await page.waitForTimeout(800);
await authDlg.getByRole('button', { name: /^log in$/i }).click({ timeout: 1500 }).catch(() => {});
await authDlg.locator('input[placeholder*="example.com or username"]').waitFor({ state: 'visible', timeout: 5000 });
await authDlg.locator('input[placeholder*="example.com or username"]').fill('s45o@desk.local');
await authDlg.locator('input[placeholder="••••••••"]').first().fill('TestPass123');
const lresp = page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST');
await authDlg.getByRole('button', { name: /^login$/i }).click();
const lbody = await (await lresp).json().catch(() => null);
console.log('login localGames:', lbody?.localGames);

// Sample the DOM repeatedly: is the offer panel ever IN the document, and if
// so is anything covering it?
const probe = () => page.evaluate(() => {
  const el = document.querySelector('[aria-label="Games saved on this device"]');
  const out = { inDom: !!el };
  if (el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.rect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    out.display = cs.display; out.visibility = cs.visibility; out.opacity = cs.opacity;
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    out.topAtCentre = top ? `${top.tagName}.${String(top.className).slice(0, 40)}` : null;
    out.coveredByOther = !!(top && !el.contains(top) && top !== el);
    out.moveBtn = !!Array.from(el.querySelectorAll('button')).find((b) => /move .* into my account/i.test(b.textContent || ''));
  }
  out.openDialogs = Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => d.getAttribute('aria-label'));
  return out;
});
for (const t of [300, 1000, 2000, 4000]) {
  await page.waitForTimeout(t === 300 ? 300 : 1000);
  console.log(`t=${t}ms`, JSON.stringify(await probe()));
}

await page.screenshot({ path: '/tmp/s45-offer.png' });
console.log('srvLog tail:', srvLog.slice(-300).replace(/\n/g, ' '));
child.kill(); await browser.close();

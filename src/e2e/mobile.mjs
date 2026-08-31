/* MOBILE + TABLET smoke — the device layer of the testing pyramid.
 *
 * Everything else drives a 1440x1000 desktop viewport. Phones and tablets fail
 * differently: layout overflows, targets too small for a thumb, and — the one
 * a desktop runner can never show — far less compute. This suite runs the real
 * production bundle on three device profiles and then again under CPU
 * throttling, which is what a mid-range Android actually feels like.
 *
 *   node src/e2e/mobile.mjs
 *
 * Budgets here are deliberately loose. CI runs on 2-core runners rendering
 * WebGL through SwiftShader, so exact milliseconds are meaningless; these
 * catch "the app no longer works on a phone", not a 200ms regression.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';

const PORT = process.env.MOBILE_PORT || '3097';
const BASE = process.env.MOBILE_BASE || `http://localhost:${PORT}`;
const PLOT = 'plotly-3d-market-simulation';
/** WCAG 2.2 SC 2.5.8 (AA): interactive targets are at least 24x24 CSS px. */
const TARGET_MIN = 24;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

let server = null;
const userData = mkdtempSync(path.join(tmpdir(), 'nash-mobile-'));
async function killServer() {
  if (!server) return;
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((res) => server.once('exit', res));
  if (!server.kill('SIGKILL')) return;
  await exited;
}
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/`); if (r.ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
if (!(await waitReady())) {
  const serverDir = path.resolve(import.meta.dirname, '../..');
  server = spawn('node', [path.join(serverDir, 'dist/server.cjs')], {
    cwd: userData,
    env: { ...process.env, NODE_ENV: 'production', PORT, ELECTRON_USER_DATA_PATH: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  if (!(await waitReady())) { console.error('FAIL server never became ready'); await killServer(); process.exit(2); }
}

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });

async function dismissTour(page) {
  try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 30000 }); }
  catch { await page.keyboard.press('Escape').catch(() => {}); }
  return page.waitForFunction(
    () => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
    null, { timeout: 20000 },
  ).then(() => true).catch(() => false);
}

// ── 1. the three device profiles ────────────────────────────────────────────
for (const label of ['iPhone 14 Pro', 'Pixel 7', 'iPad (gen 7)']) {
  const dev = devices[label];
  const ctx = await browser.newContext({ ...dev });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 160)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  record(`[${label}] the guided tour can be dismissed`, await dismissTour(page));
  await page.waitForTimeout(800);

  // Horizontal overflow is the classic mobile break: it makes the whole page
  // swipe sideways and puts controls off-screen.
  const box = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, win: window.innerWidth,
  }));
  record(`[${label}] no horizontal overflow`, box.doc <= box.win + 2,
    `page ${box.doc}px in a ${box.win}px viewport`);

  const plot = await page.locator('#' + PLOT).boundingBox();
  record(`[${label}] the 3D plot renders at a usable size`,
    !!plot && plot.width > 100 && plot.height > 100 && plot.width <= box.win + 2,
    plot ? `${Math.round(plot.width)}x${Math.round(plot.height)}` : 'missing');

  // Thumb-sized targets. Reported with names so a failure says WHICH control.
  const small = await page.evaluate((min) => {
    const bad = [];
    for (const el of document.querySelectorAll('button, a[href], input, select')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.width < min || r.height < min)) {
        bad.push(`${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 22)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return bad;
  }, TARGET_MIN);
  record(`[${label}] every target meets the ${TARGET_MIN}px WCAG 2.2 AA floor`,
    small.length === 0, small.slice(0, 5).join(' | '));

  // The app has to actually work, not just lay out.
  // Do NOT swallow these: a failed preset click leaves the DEFAULT game loaded,
  // which converges perfectly well and would record a pass for a game this
  // check never selected.
  await page.getByRole('button', { name: 'Spy vs. Analyst' }).first().click();
  await page.waitForFunction(() => {
    const cells = [...document.querySelectorAll('input[inputmode="decimal"][class*="text-center"]')];
    return cells.length >= 8 && cells[0].value === '3' && cells[1].value === '-3';
  }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  const presetLoaded = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('input[inputmode="decimal"][class*="text-center"]')];
    return cells.length >= 8 && cells[0].value === '3' && cells[1].value === '-3';
  });
  record(`[${label}] the preset actually loaded (precondition for convergence)`, presetLoaded);
  await page.getByRole('button', { name: /^Run$/, exact: true }).first().click();
  const converged = await page.waitForSelector('text=Converged', { timeout: 240000 })
    .then(() => true).catch(() => false);
  record(`[${label}] a preset runs to convergence on the device`, converged && presetLoaded);

  // Exclude ONLY known third-party analytics. A blanket net::/ERR_ filter hid
  // failures of our own bundle, API and assets — exactly the breakage this
  // check exists to catch on a device.
  const ANALYTICS = /googletagmanager|google-analytics|gtag|doubleclick|region1\.analytics/i;
  const relevant = errors.filter((t) => !ANALYTICS.test(t));
  record(`[${label}] no console or page errors`, relevant.length === 0, relevant.slice(0, 2).join(' | '));
  await ctx.close();
}

// ── 1b. pinch-to-zoom, which is how a phone adjusts the view ────────────────
// Two things have to happen on a two-finger pinch during a run: the run pauses,
// exactly as a tap does, and the zoom actually reaches the camera.
//
// The zoom half was broken and invisible: the handlers were bound to the plot
// container, and Plotly's own gl3d touch handlers sit on the canvas inside it
// and stop propagation, so they were attached but never fired — pinch did
// nothing at all, running or idle. Only a device test can see this; the desktop
// smoke suite has no touch.
{
  const ctx = await browser.newContext({ ...devices['iPad (gen 7)'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const cdp = await ctx.newCDPSession(page);

  const eyeRadius = () => page.evaluate((id) => {
    const e = document.getElementById(id)?._fullLayout?.scene?.camera?.eye;
    return e ? Math.hypot(e.x, e.y, e.z) : null;
  }, PLOT);
  const isRunning = () => page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Pause'));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await dismissTour(page);
  await page.getByRole('button', { name: 'Spy vs. Analyst' }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  // slowest speed, so the run is still going when the pinch lands
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('input[type=range]')].find((e) => e.min === '1');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, '1');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Run')?.click();
  });
  await page.waitForTimeout(1500);

  const wasRunning = await isRunning();
  const before = await eyeRadius();
  const box = await page.locator('#' + PLOT).boundingBox();
  let pausedByPinch = null;
  if (box) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const pts = (d) => [{ x: cx - d, y: cy }, { x: cx + d, y: cy }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(60) });
    await page.waitForTimeout(150);
    pausedByPinch = !(await isRunning());
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(60 + i * 22) });
      await page.waitForTimeout(70);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(800);
  }
  const after = await eyeRadius();

  record('[pinch] the run was actually going before the pinch (precondition)', wasRunning === true);
  record('[pinch] a two-finger pinch pauses the run, like a tap', pausedByPinch === true);
  record('[pinch] the pinch reaches the camera (view actually zooms)',
    before !== null && after !== null && Math.abs(before - after) > 0.05,
    `eye radius ${before?.toFixed(3)} -> ${after?.toFixed(3)}`);
  await ctx.close();
}

// ── 2. the compute budget: a phone has far less of it ───────────────────────
// 4x is Lighthouse's "mobile" setting. The interesting failures here are the
// ones that make the app unusable rather than merely slower: a first paint that
// never arrives, a control that stops responding, a single task long enough to
// swallow a tap.
{
  const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); })
        .observe({ entryTypes: ['longtask'] });
    } catch { /* not supported */ }
  });

  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // The host <div> is in the markup before Plotly ever runs, so waiting for the
  // SELECTOR would pass while a throttled device failed to initialise the
  // scene. Poll for the gl3d scene itself — that is the thing that has to
  // exist for anything to be visible.
  const plotUp = await page.waitForFunction((id) => {
    const gd = document.getElementById(id);
    return !!(gd && gd._fullLayout && gd._fullLayout.scene && gd._fullLayout.scene.camera);
  }, PLOT, { timeout: 120000 }).then(() => true).catch(() => false);
  const tPlot = Date.now() - t0;
  record('[4x CPU] the 3D scene actually initialises within 60s', plotUp && tPlot < 60000, `${tPlot}ms`);

  const dismissed = await dismissTour(page);
  const tReady = Date.now() - t0;
  record('[4x CPU] the app is interactive within 90s', dismissed && tReady < 90000, `${tReady}ms`);

  // The tab-wedge fixture: 1504 steps precomputed in one synchronous pass. This
  // is the heaviest thing the app does, and it once froze the tab outright.
  const cells = page.locator('input[inputmode="decimal"][class*="text-center"]');
  const vals = [7, -7, -6, -4, -7, 1, 0, -6];
  for (let i = 0; i < 8; i++) { await cells.nth(i).fill(String(vals[i])).catch(() => {}); await cells.nth(i).blur().catch(() => {}); }
  const stepSize = page.locator('xpath=//span[contains(text(),"Initial Domain Shrink Step Size")]/following-sibling::input[1]');
  await stepSize.fill('0.001').catch(() => {}); await stepSize.blur().catch(() => {});
  await page.waitForTimeout(800);
  const tStep0 = Date.now();
  await page.getByRole('button', { name: /^Step$/, exact: true }).first().click().catch(() => {});
  const advanced = await page.waitForFunction(
    () => [...document.querySelectorAll('span')].some((e) => e.textContent?.trim() === '1 / 1504'),
    null, { timeout: 120000 },
  ).then(() => true).catch(() => false);
  const tStep = Date.now() - tStep0;
  record('[4x CPU] the 1504-step precompute still responds (no wedged tab)',
    advanced && tStep < 30000, `${tStep}ms`);

  // The idle spin drives a synchronous relayout every frame. On a phone it once
  // owned ~100% of the main thread and taps queued for seconds; it is throttled
  // now, and this keeps it that way.
  await page.evaluate(() => { window.__lt.length = 0; });
  await page.waitForTimeout(5000);
  const spin = await page.evaluate(() => ({
    blocked: window.__lt.reduce((a, c) => a + c, 0),
    longest: Math.max(0, ...window.__lt),
  }));
  record('[4x CPU] the idle spin leaves the main thread mostly free',
    spin.blocked < 3000, `${spin.blocked}ms blocked of 5000ms, longest task ${spin.longest}ms`);
  await ctx.close();
}

await browser.close();
await killServer();
try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ MOBILE: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length) fails.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
process.exit(fails.length ? 1 : 0);

// STRUCT-DESKTOP-19 red pass 2 probe: WHY does section 53 see two DELETEs?
// Reproduces the fixture's exact shape and timestamps every event, so a
// second request can be attributed either to the in-flight guard failing
// (t ~= first click) or to the second click landing after the first settled
// (t >= hold), which would make the FIXTURE wrong, not the product.
import { chromium } from 'playwright';
import { startOwnServer, registerAndLogin, ELECTRON_UA } from './harnesslib.mjs';

const WT = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/wt-struct-desktop';
const PORT = Number(process.env.PROBE_PORT || 4837);
const HOLD = Number(process.env.HOLD_MS || 1500);

const srv = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'dd' });
console.log('server ok, bundle', srv.bundle);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: ELECTRON_UA });
const p = await ctx.newPage();
await p.goto(srv.base, { waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 5000 }); } catch { /* no tour */ }
const uniq = String(Date.now()).slice(-6);
await registerAndLogin(p, { u: `dd${uniq}`, e: `dd${uniq}@example.com`, p: 'Passw0rd!23' });
const token = await p.evaluate(() => localStorage.getItem('nash_sim_token_local') || localStorage.getItem('nash_sim_token_cloud'));
const name = `DoubleDelete-${uniq}`;
const saved = await p.evaluate(async ([n, t]) => (await fetch('/api/games', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  body: JSON.stringify({ name: n, description: 'to be deleted twice at once', payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 }, row1Label: 'C', row2Label: 'D', col1Label: 'C', col2Label: 'D' }) })).status, [name, token]);
console.log('save status', saved, 'token?', !!token);
await p.reload({ waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 5000 }); } catch { /* no tour */ }
const row = p.locator('div.group', { has: p.getByRole('button', { name, exact: true }) });
await row.waitFor({ state: 'visible', timeout: 15000 });
const del = row.getByTitle('Delete this saved game');

const t0 = Date.now();
const T = () => Date.now() - t0;
const ev = [];
p.on('dialog', async (d) => { ev.push({ t: T(), what: 'dialog', msg: d.message() }); await d.accept(); });
p.on('request', (rq) => { if (rq.method() === 'DELETE' && rq.url().includes('/api/games/')) ev.push({ t: T(), what: 'request', url: rq.url() }); });
p.on('requestfailed', (rq) => { if (rq.method() === 'DELETE') ev.push({ t: T(), what: 'requestfailed', err: rq.failure()?.errorText }); });
await p.route('**/api/games/**', async (route) => {
  if (route.request().method() !== 'DELETE') return route.continue();
  ev.push({ t: T(), what: 'route-hold-start' });
  await new Promise((r) => setTimeout(r, HOLD));
  ev.push({ t: T(), what: 'route-abort' });
  await route.abort('internetdisconnected');
});
ev.push({ t: T(), what: 'click1-begin', disabled: await del.isDisabled() });
await del.click();
ev.push({ t: T(), what: 'click1-done', disabled: await del.isDisabled() });
await del.click({ force: true }).catch((e) => ev.push({ t: T(), what: 'click2-threw', err: String(e).slice(0, 120) }));
ev.push({ t: T(), what: 'click2-done', disabled: await del.isDisabled() });
for (let i = 0; i < 60; i++) { await p.waitForTimeout(100); }
ev.push({ t: T(), what: 'end', disabled: await del.isDisabled() });
console.log(JSON.stringify(ev, null, 1));
const reqs = ev.filter((e) => e.what === 'request');
const dlgs = ev.filter((e) => e.what === 'dialog');
console.log(`RESULT requests=${reqs.length} dialogs=${dlgs.length} reqTimes=${reqs.map((r) => r.t)} dlgTimes=${dlgs.map((d) => d.t)}`);
await browser.close(); srv.child.kill('SIGKILL');

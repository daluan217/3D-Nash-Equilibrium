// Which mechanism actually stops the second Delete click, and is each one
// observable from a fixture? A: same-tick native .click() twice (a real
// double-click / Enter-repeat). B: same-tick dispatchEvent twice, which the
// disabled attribute does not suppress, isolating the deletingGamesRef guard.
// The DELETE is held until the test releases it, so neither experiment can
// lose a race with a timed hold (that race is exactly what made section 53
// fail on a loaded runner).
import { chromium } from 'playwright';
import { startOwnServer, registerAndLogin, ELECTRON_UA } from './harnesslib.mjs';

const WT = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/wt-struct-desktop';
const PORT = Number(process.env.PROBE_PORT || 4837);
const MODE = process.env.PROBE_MODE || 'both';

const srv = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'ddm' });
console.log('server ok, bundle', srv.bundle);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: ELECTRON_UA });
const p = await ctx.newPage();
await p.goto(srv.base, { waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 5000 }); } catch { /* no tour */ }
const uniq = String(Date.now()).slice(-6);
await registerAndLogin(p, { u: `dm${uniq}`, e: `dm${uniq}@example.com`, p: 'Passw0rd!23' });
const token = await p.evaluate(() => localStorage.getItem('nash_sim_token_local') || localStorage.getItem('nash_sim_token_cloud'));
const mk = async (n) => p.evaluate(async ([nm, t]) => (await fetch('/api/games', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  body: JSON.stringify({ name: nm, description: 'double click target', payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 }, row1Label: 'C', row2Label: 'D', col1Label: 'C', col2Label: 'D' }) })).status, [n, token]);
const nameA = `DDA-${uniq}`; const nameB = `DDB-${uniq}`;
console.log('saved', await mk(nameA), await mk(nameB));
await p.reload({ waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 5000 }); } catch { /* no tour */ }

const deletes = []; const dialogs = [];
p.on('request', (rq) => { if (rq.method() === 'DELETE' && rq.url().includes('/api/games/')) deletes.push(rq.url()); });
p.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
let release = () => {}; let held = new Promise((r) => { release = r; }); let aborted = false;
await p.route('**/api/games/**', async (route) => {
  if (route.request().method() !== 'DELETE') return route.continue();
  await held;
  aborted = true;
  await route.abort('internetdisconnected');
});

async function experiment(name, kind) {
  deletes.length = 0; dialogs.length = 0; aborted = false;
  held = new Promise((r) => { release = r; });
  const row = p.locator('div.group', { has: p.getByRole('button', { name, exact: true }) });
  await row.waitFor({ state: 'visible', timeout: 15000 });
  const del = row.getByTitle('Delete this saved game');
  await del.scrollIntoViewIfNeeded();
  const seen = await del.evaluate((b, k) => {
    const out = [];
    const fire = () => (k === 'native' ? b.click() : b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    out.push(b.disabled); fire();
    out.push(b.disabled); fire();
    out.push(b.disabled);
    return out;
  }, kind);
  // Both requests, if the guard is broken, are issued in that same task; give
  // the browser a bounded window to actually put them on the wire.
  for (let i = 0; i < 30 && deletes.length < 2; i++) await p.waitForTimeout(100);
  const disabledInFlight = await del.isDisabled().catch(() => null);
  const premiseHeld = !aborted;
  release();
  for (let i = 0; i < 60 && dialogs.length < 1; i++) await p.waitForTimeout(100);
  await p.waitForTimeout(500);
  console.log(`EXPERIMENT ${kind}: disabledAt[before1,before2,after]=${JSON.stringify(seen)} requests=${deletes.length} dialogs=${dialogs.length} disabledInFlight=${disabledInFlight} firstStillHeldAtSecondClick=${premiseHeld}`);
  return { kind, seen, requests: deletes.length, dialogs: dialogs.length };
}

if (MODE === 'both' || MODE === 'native') await experiment(nameA, 'native');
if (MODE === 'both' || MODE === 'dispatch') await experiment(nameB, 'dispatch');
await browser.close(); srv.child.kill('SIGKILL');

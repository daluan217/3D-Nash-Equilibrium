// STRUCT-DESKTOP-19, red pass 1, angle D19-1 REAL INSTANCE (no interception).
//
// The packaged desktop app serves its own UI from http://localhost:<port> and,
// in CLOUD database mode, calls the hosted backend cross-origin. So the shell
// always loads even when the backend is unreachable — which is exactly the
// ordinary "laptop is offline" launch. This harness stages that with two real
// servers and NO route interception at all: the failure is a genuine
// ECONNREFUSED from a genuinely dead remote.
//
// Usage: node _gen/d19a2-cloudmode-offline-session-loss.mjs <worktree> <localPort> <cloudPort> <LABEL>
import { chromium } from 'playwright';
import { startOwnServer, waitPortDead, ELECTRON_UA } from './harnesslib.mjs';

const WT = process.argv[2];
const LPORT = process.argv[3] || '4836';
const CPORT = process.argv[4] || '4837';
const LABEL = process.argv[5] || 'RUN';

// Two REAL servers from THIS worktree's dist (startOwnServer proves each port
// serves our own bundle): `local` is the packaged app's own server, `cloud`
// stands in for the hosted backend the desktop app calls in cloud mode.
const local = await startOwnServer(WT, LPORT, { mode: 'desktop', tag: 'a2local' });
let cloud = await startOwnServer(WT, CPORT, { mode: 'desktop', tag: 'a2cloud' });
const cloudDataDir = cloud.dataDir;
const LBASE = local.base, CBASE = cloud.base;
console.log(`[${LABEL}] both servers are ours, serving`, local.bundle);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: ELECTRON_UA });
page.on('dialog', async (d) => { await d.accept(); });

await page.goto(LBASE, { waitUntil: 'domcontentloaded' });
// The app's OWN persisted settings, exactly as the menu drawer writes them.
await page.evaluate((cb) => { localStorage.setItem('nash_sim_db_mode', 'cloud'); localStorage.setItem('nash_sim_api_base', cb); }, CBASE);
await page.goto(LBASE, { waitUntil: 'networkidle' });
try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 4000 }); } catch {}

const authDlg = page.locator('[role="dialog"][aria-label="Account"]');
const A = { u: 'd19a2user', e: 'd19a2@desk.local', p: 'TestPass123' };
await page.locator('header').getByRole('button', { name: /sign in.*sign up/i }).click();
await authDlg.waitFor({ state: 'visible' });
await authDlg.getByRole('button', { name: /^sign up$/i }).click().catch(() => {});
await authDlg.locator('input[placeholder="game_theorist"]').waitFor({ state: 'visible', timeout: 6000 });
await authDlg.locator('input[placeholder="game_theorist"]').fill(A.u);
await authDlg.locator('input[placeholder="john@example.com"]').fill(A.e);
await authDlg.locator('input[placeholder="••••••••"]').first().fill(A.p);
await authDlg.locator('input[placeholder="••••••••"]').nth(1).fill(A.p);
const regResp = page.waitForResponse((r) => r.url().includes('/api/auth/register'));
await authDlg.getByRole('button', { name: /register account/i }).click();
const rr = await regResp;
console.log(`[${LABEL}] register went to:`, new URL(rr.url()).origin, 'status', rr.status(), '(must be the CLOUD origin)');
await page.waitForTimeout(1500);
await authDlg.getByRole('button', { name: /^log in$/i }).click({ timeout: 2500 }).catch(() => {});
await page.waitForTimeout(800);
await authDlg.locator('input[placeholder*="example.com or username"]').waitFor({ state: 'visible', timeout: 6000 });
await page.waitForTimeout(400);
await authDlg.locator('input[placeholder*="example.com or username"]').fill(A.e);
await authDlg.locator('input[placeholder="••••••••"]').first().fill(A.p);
const loginResp = page.waitForResponse((r) => r.url().includes('/api/auth/login'));
await authDlg.getByRole('button', { name: /^login$/i }).click();
await loginResp;
await authDlg.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
await page.waitForTimeout(500);
const offer = page.locator('[role="dialog"][aria-label="Games saved on this device"]');
if (await offer.isVisible({ timeout: 600 }).catch(() => false)) await page.getByRole('button', { name: /leave .* on this device/i }).click({ timeout: 2000 }).catch(() => {});

const K = 'nash_sim_token_cloud';
const token0 = await page.evaluate((k) => localStorage.getItem(k), K);
const hdr0 = await page.locator('header').getByRole('button', { name: /log out/i }).isVisible().catch(() => false);
console.log(`[${LABEL}] signed in to the cloud server — token stored: ${!!token0} | header signed in: ${hdr0}`);
if (!token0) { console.log(`[${LABEL}] ABORT: never signed in. cloud srv tail:`, cloud.getLog().slice(-600)); local.child.kill(); cloud.child.kill(); await browser.close(); process.exit(2); }

console.log(`\n[${LABEL}] --- CONTROL: relaunch with the backend UP (token must survive) ---`);
await page.goto(LBASE, { waitUntil: 'domcontentloaded' });
try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 3000 }); } catch {}
await page.waitForTimeout(1500);
const tokenUp = await page.evaluate((k) => localStorage.getItem(k), K);
const hdrUp = await page.locator('header').getByRole('button', { name: /log out/i }).isVisible().catch(() => false);
console.log(`[${LABEL}]   token survived: ${tokenUp === token0} | header signed in: ${hdrUp}`);

console.log(`\n[${LABEL}] --- REAL CASE: backend unreachable (offline), relaunch the app ---`);
cloud.child.kill('SIGKILL');
console.log(`[${LABEL}]   cloud backend really dead:`, await waitPortDead(CPORT));
await page.goto(LBASE, { waitUntil: 'domcontentloaded' });   // shell still served by the LOCAL packaged server
try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 3000 }); } catch {}
await page.waitForTimeout(2000);
const tokenOffline = await page.evaluate((k) => localStorage.getItem(k), K);
const hdrOffline = await page.locator('header').getByRole('button', { name: /log out/i }).isVisible().catch(() => false);
console.log(`[${LABEL}]   token survived: ${tokenOffline === token0} | header signed in: ${hdrOffline}`);
await page.screenshot({ path: `/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/round19/findings/STRUCT-DESKTOP-19/001-offline-relaunch-${LABEL}.png` }).catch(() => {});

console.log(`\n[${LABEL}] --- RECOVERY: the same backend comes back, relaunch again ---`);
// The SAME data dir, so the account and its token version still exist: the
// question is whether the app can still present a credential and sign back in
// by itself, which is the whole point of not destroying it while offline.
cloud = await startOwnServer(WT, CPORT, { mode: 'desktop', tag: 'a2cloud2', reuseDataDir: cloudDataDir });
await page.goto(LBASE, { waitUntil: 'domcontentloaded' });
try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 3000 }); } catch {}
await page.waitForTimeout(1500);
const tokenBack = await page.evaluate((k) => localStorage.getItem(k), K);
const hdrBack = await page.locator('header').getByRole('button', { name: /log out/i }).isVisible().catch(() => false);
console.log(`[${LABEL}]   token present again: ${!!tokenBack} (same as before the outage: ${tokenBack === token0}) | header signed in: ${hdrBack}`);

console.log(`\n[${LABEL}] === VERDICT ===`);
const controlOk = tokenUp === token0 && hdrUp;
console.log(`[${LABEL}] control sane (a relaunch against a LIVE backend keeps the session):`, controlOk);
const destroyed = tokenOffline !== token0;
console.log(`[${LABEL}] one offline relaunch destroyed the stored cloud session:`, destroyed);
const recovered = tokenBack === token0 && hdrBack;
console.log(`[${LABEL}] signed back in by itself once the backend returned:`, recovered);
if (!controlOk) console.log(`[${LABEL}] RESULT: INCONCLUSIVE (control failed)`);
else if (destroyed) console.log(`[${LABEL}] RESULT: DEFECT (offline relaunch permanently signs the user out; no interception used)`);
else if (!recovered) console.log(`[${LABEL}] RESULT: DEFECT (the credential survived the outage but the app never signed back in when the backend returned)`);
else console.log(`[${LABEL}] RESULT: PASS`);

local.child.kill(); cloud.child.kill();
await browser.close();

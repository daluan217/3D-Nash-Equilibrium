// Red pass 3: the desktop session secret becomes unreadable between launches
// (a permissions accident, a restored backup, a corrupted file). AUTH_SECRET
// then falls back to a per-process random value — silently, because the
// "sessions will be invalidated on restart" warning is deliberately skipped
// when ELECTRON_USER_DATA_PATH is set. Every token stops verifying and the
// account's games become invisible to an anonymous local owner. Does the user
// get ANY signal, or just an empty library?
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startOwnServer, waitPortDead, registerAndLogin, ELECTRON_UA } from './harnesslib.mjs';

const WT = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/wt-struct-desktop';
const PORT = Number(process.env.PROBE_PORT || 4837);
let fails = 0;
const rec = (ok, what, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`); };

const srv = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'sec' });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: ELECTRON_UA });
const p = await ctx.newPage();
await p.goto(srv.base, { waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 5000 }); } catch { /* no tour */ }
const uniq = String(Date.now()).slice(-6);
await registerAndLogin(p, { u: `sec${uniq}`, e: `sec${uniq}@example.com`, p: 'Passw0rd!23' });
const token = await p.evaluate(() => localStorage.getItem('nash_sim_token_local') || localStorage.getItem('nash_sim_token_cloud'));
rec(!!token, 'precondition: signed in on this device, token stored');
const name = `SecretLoss-${uniq}`;
const saved = await p.evaluate(async ([n, t]) => (await fetch('/api/games', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
  body: JSON.stringify({ name: n, description: 'saved under the account, before the secret was lost', payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 }, row1Label: 'C', row2Label: 'D', col1Label: 'C', col2Label: 'D' }) })).status, [name, token]);
rec(saved === 200, 'precondition: the account owns a saved game', `status ${saved}`);
await p.reload({ waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 5000 }); } catch { /* no tour */ }
rec(await p.getByRole('button', { name, exact: true }).isVisible({ timeout: 10000 }).catch(() => false),
  'precondition: the row is visible while signed in');

// ── The accident: the secret file becomes unreadable, everything else intact.
const secretFile = join(srv.dataDir, 'auth-secret');
rec(existsSync(secretFile), 'precondition: the desktop session secret really is a file in the data dir',
  `${secretFile} — dir holds ${JSON.stringify(readdirSync(srv.dataDir))}`);
srv.child.kill('SIGKILL');
await waitPortDead(PORT);
chmodSync(secretFile, 0o000);
const srv2 = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'sec2', reuseDataDir: srv.dataDir });
rec(existsSync(join(srv.dataDir, 'db.json')), 'precondition: the database itself is untouched and still readable');

await p.reload({ waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 5000 }); } catch { /* no tour */ }
// The probe answers land after /api/auth/me 401s and the notice's own fetch.
const notice = p.locator('[role="status"]', { hasText: /used this app before/i });
let noticeShown = false;
for (let i = 0; i < 40 && !noticeShown; i++) { noticeShown = await notice.isVisible().catch(() => false); if (!noticeShown) await p.waitForTimeout(250); }
const tokenAfter = await p.evaluate(() => localStorage.getItem('nash_sim_token_local') || localStorage.getItem('nash_sim_token_cloud'));
const rowAfter = await p.getByRole('button', { name, exact: true }).isVisible().catch(() => false);
rec(tokenAfter === null, 'the dead token is cleared rather than left claiming a session', `token=${tokenAfter ? 'still there' : 'cleared'}`);
rec(!rowAfter, 'the account row is (correctly) not listed for the anonymous local owner');
rec(noticeShown, 'THE QUESTION: the user is told an account on this device holds games ("Used this app before?")');
console.log(`server log mentions the secret failure: ${/session secret/i.test(srv2.getLog())}`);

// ── Control: nothing was lost. Restore the file and sign in again.
srv2.child.kill('SIGKILL');
await waitPortDead(PORT);
chmodSync(secretFile, 0o600);
const srv3 = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'sec3', reuseDataDir: srv.dataDir });
await p.reload({ waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 5000 }); } catch { /* no tour */ }
const relog = await p.evaluate(async ([e, pw]) => {
  const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: pw }) });
  const j = await r.json().catch(() => ({}));
  if (j.token) { localStorage.setItem('nash_sim_token_local', j.token); }
  const games = j.token ? await (await fetch('/api/games', { headers: { Authorization: `Bearer ${j.token}` } })).json() : [];
  return { status: r.status, names: Array.isArray(games) ? games.map((g) => g.name) : games };
}, [`sec${uniq}@example.com`, 'Passw0rd!23']);
rec(relog.status === 200 && relog.names.includes(name),
  'CONTROL: with the secret readable again, the same account signs in and its game is still there', JSON.stringify(relog));
console.log(fails === 0 ? '\nPROBE CLEAN' : `\nPROBE FOUND ${fails} FAILURE(S)`);
await browser.close(); srv3.child.kill('SIGKILL');

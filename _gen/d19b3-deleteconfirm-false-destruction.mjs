// STRUCT-DESKTOP-19 red pass 2: does "your account and all saved game
// profiles have been successfully deleted from our records" survive a write
// that never reached the disk? Desktop shape, real HTTP, no interception:
// the only thing done to the app is making its own data directory read-only,
// which is exactly the condition §50 already exercises for adopt-local.
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startOwnServer, waitPortDead } from './harnesslib.mjs';

const WT = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/wt-struct-desktop';
const PORT = Number(process.env.PROBE_PORT || 4837);
const say = (ok, what, detail = '') => console.log(`${ok ? 'OK  ' : 'BAD '} ${what}${detail ? ' — ' + detail : ''}`);

const srv = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'del' });
const B = srv.base;
const j = async (path, init = {}) => {
  const res = await fetch(B + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
  let body = {}; try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
};
const u = `del${String(Date.now()).slice(-6)}`;
const email = `${u}@example.com`, pass = 'Passw0rd!23';
console.log('bundle', srv.bundle, 'dataDir', srv.dataDir);

const reg = await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: u, email, password: pass }) });
say(reg.status === 200, 'registered', `status ${reg.status} ${JSON.stringify(reg.body).slice(0, 120)}`);
const login = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: pass }) });
const token = login.body.token;
say(!!token, 'logged in', `status ${login.status}`);
const auth = { Authorization: `Bearer ${token}` };
const save = await j('/api/games', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Keepsake', description: 'the game the user believes was destroyed',
  payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 }, row1Label: 'C', row2Label: 'D', col1Label: 'C', col2Label: 'D' }) });
say(save.status === 200, 'saved one game', `status ${save.status}`);

const req = await j('/api/auth/delete-request', { method: 'POST', headers: auth });
const code = req.body.deleteCode;
say(!!code, 'got the deletion code from the desktop response', `status ${req.status}`);

// The data directory goes read-only: every later write fails at the OS.
chmodSync(srv.dataDir, 0o555);
const confirm = await j('/api/auth/delete-confirm', { method: 'POST', headers: auth, body: JSON.stringify({ code }) });
chmodSync(srv.dataDir, 0o755);
console.log(`\nDELETE-CONFIRM ANSWERED ${confirm.status}: ${JSON.stringify(confirm.body)}\n`);

// What the running process now thinks.
const meAfter = await j('/api/auth/me', { headers: auth });
console.log(`GET /api/auth/me right after: ${meAfter.status} ${JSON.stringify(meAfter.body).slice(0, 100)}`);

// What is actually on disk.
const dbPath = join(srv.dataDir, 'db.json');
const onDisk = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, 'utf-8')) : { users: [], games: [] };
const stillThere = onDisk.users.some((x) => x.email?.toLowerCase() === email) && onDisk.games.some((g) => g.name === 'Keepsake');
console.log(`ON DISK after the "successful" deletion: users=${onDisk.users.length} games=${onDisk.games.length} thisAccountStillPresent=${stillThere}`);

// And what the user sees on the next launch, which is the whole point.
srv.child.kill('SIGKILL');
await waitPortDead(PORT);
const srv2 = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'del2', reuseDataDir: srv.dataDir });
const relogin = await (async () => {
  const res = await fetch(srv2.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
})();
const games = relogin.body.token
  ? await (await fetch(srv2.base + '/api/games', { headers: { Authorization: `Bearer ${relogin.body.token}` } })).json()
  : [];
console.log(`\nAFTER RESTART: login ${relogin.status}, account back = ${!!relogin.body.token}, games back = ${Array.isArray(games) ? games.length : 'n/a'} (${Array.isArray(games) ? games.map((g) => g.name).join(',') : ''})`);
console.log(`\nVERDICT: told "${String(confirm.body.message || confirm.body.error).slice(0, 90)}" with status ${confirm.status}; the account ${relogin.body.token ? 'STILL EXISTS' : 'is gone'}.`);
srv2.child.kill('SIGKILL');

// ── CONTROL: with a writable data directory the same flow must really delete.
// Without this the run proves only that the route can say no.
console.log('\n── CONTROL: writable directory, same flow ──');
const srv3 = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'del3' });
const j3 = async (path, init = {}) => {
  const res = await fetch(srv3.base + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
  let body = {}; try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
};
const cu = `ctl${String(Date.now()).slice(-6)}`, cemail = `${cu}@example.com`;
await j3('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: cu, email: cemail, password: pass }) });
const clogin = await j3('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: cemail, password: pass }) });
const cauth = { Authorization: `Bearer ${clogin.body.token}` };
await j3('/api/games', { method: 'POST', headers: cauth, body: JSON.stringify({ name: 'Doomed', description: 'this one really goes',
  payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 }, row1Label: 'C', row2Label: 'D', col1Label: 'C', col2Label: 'D' }) });
const creq = await j3('/api/auth/delete-request', { method: 'POST', headers: cauth });
const cconfirm = await j3('/api/auth/delete-confirm', { method: 'POST', headers: cauth, body: JSON.stringify({ code: creq.body.deleteCode }) });
say(cconfirm.status === 200 && cconfirm.body.success === true, 'CONTROL: the deletion is accepted', `status ${cconfirm.status}`);
const cme = await j3('/api/auth/me', { headers: cauth });
say(cme.status === 401, 'CONTROL: the session is dead immediately after', `status ${cme.status}`);
const cdisk = JSON.parse(readFileSync(join(srv3.dataDir, 'db.json'), 'utf-8'));
say(!cdisk.users.some((x) => x.email?.toLowerCase() === cemail) && !cdisk.games.some((g) => g.name === 'Doomed'),
  'CONTROL: the account and its game are gone from disk', `users=${cdisk.users.length} games=${cdisk.games.length}`);
srv3.child.kill('SIGKILL');
await waitPortDead(PORT);
const srv4 = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'del4', reuseDataDir: srv3.dataDir });
const clogin2 = await (await fetch(srv4.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: cemail, password: pass }) })).json().catch(() => ({}));
say(!clogin2.token, 'CONTROL: it stays deleted across a restart', JSON.stringify(clogin2).slice(0, 80));
srv4.child.kill('SIGKILL');

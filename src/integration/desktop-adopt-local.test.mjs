/* INTEGRATION — signing in on the desktop must NEVER move another person's
 * no-account games by itself (RED-DESKTOP-11/001, round 11).
 *
 * The desktop lets anyone save games without an account (#123): they belong to
 * the reserved `local-owner`. Until this fix, `POST /api/auth/login` called
 * adoptLocalGames() unconditionally, so on a shared machine EVERY local-owner
 * game was re-parented to whichever account logged in next — a brand-new
 * account that had never seen them included — silently, with no way back.
 *
 * The contract now:
 *   1. a fresh account's sign-in leaves local-owner games where they are, and
 *      its own list is empty; the login response reports `localGames`;
 *   2. the move happens only through POST /api/games/adopt-local, by the
 *      signed-in user, and is idempotent (a second call moves nothing);
 *   3. the route needs a token on the desktop and does not exist (404) on the
 *      hosted service, where there is no local owner.
 *
 * Booted from a temp directory with a scrubbed env, like every desktop
 * integration test: dotenv reads `.env` from the cwd, and inheriting the
 * repo's credentials would stop describing the shipped product.
 *
 *   node src/integration/desktop-adopt-local.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
const basePort = Number(process.env.DESKTOP_ADOPT_PORT || 3117);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function boot(userData, thePort, { desktop }) {
  const env = {
    PATH: process.env.PATH,
    HOME: userData,
    NODE_ENV: 'production',
    PORT: String(thePort),
  };
  if (desktop) {
    env.IS_ELECTRON = 'true';
    env.ELECTRON_USER_DATA_PATH = userData;
  }
  const child = spawn('node', [BUNDLE], { cwd: userData, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${thePort}/api/health`)).ok) return { child, log: () => log }; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`server on ${thePort} never came up:\n${log.slice(-800)}`);
}
async function stop(srv) {
  if (!srv || srv.child.exitCode !== null) return; // never started, or already gone
  await new Promise((resolve) => {
    srv.child.once('exit', resolve);
    if (!srv.child.kill('SIGTERM')) return resolve(); // already dead: no exit event will follow
    setTimeout(() => { if (srv.child.exitCode === null) srv.child.kill('SIGKILL'); }, 3000).unref();
  });
}
async function call(thePort, method, url, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${thePort}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const game = (name) => ({
  name, description: 'saved on this device without an account',
  payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 },
  row1Label: 'Cooperate', row2Label: 'Defect', col1Label: 'Cooperate', col2Label: 'Defect',
});
const names = (r) => (Array.isArray(r.json) ? r.json.map((g) => g.name).sort() : `status ${r.status}`);
const owners = (r) => (Array.isArray(r.json) ? [...new Set(r.json.map((g) => g.userId))] : []);

const deskData = mkdtempSync(path.join(tmpdir(), 'nash-adopt-desk-'));
const hostData = mkdtempSync(path.join(tmpdir(), 'nash-adopt-host-'));
let desk = null; let host = null;
try {
  desk = await boot(deskData, basePort, { desktop: true });
  const port = basePort;

  // Person A saves without an account.
  const saveA = await call(port, 'POST', '/api/games', { body: game('A-private') });
  record('precondition: a no-account save lands on the local owner', saveA.status === 200 && saveA.json?.game?.userId === 'local-owner', `status ${saveA.status}`);

  // Person B makes a BRAND-NEW account on the same machine and signs in.
  const credB = { username: 'personB', email: 'personb@example.com', password: 'Passw0rd123' };
  const regB = await call(port, 'POST', '/api/auth/register', { body: credB });
  const loginB = await call(port, 'POST', '/api/auth/login', { body: { email: credB.email, password: credB.password } });
  const tokenB = loginB.json?.token;
  record('precondition: B registers and signs in', regB.status === 200 && typeof tokenB === 'string', `register ${regB.status}, login ${loginB.status}`);
  record('FIX: the login response reports the number of no-account games on this device (localGames = 1)', loginB.json?.localGames === 1, JSON.stringify(loginB.json?.localGames));

  const listB0 = await call(port, 'GET', '/api/games', { token: tokenB });
  record("FIX: B's own list is EMPTY after signing in — A's game was not adopted", Array.isArray(listB0.json) && listB0.json.length === 0, JSON.stringify(names(listB0)));
  const anon0 = await call(port, 'GET', '/api/games');
  record("FIX: A's game is still the local owner's (visible without an account)", names(anon0).join() === 'A-private' && owners(anon0).join() === 'local-owner', JSON.stringify(names(anon0)));

  // The move is explicit, and needs the account.
  const noTok = await call(port, 'POST', '/api/games/adopt-local');
  record('adopt-local without a token is refused (401) and moves nothing', noTok.status === 401 && names(await call(port, 'GET', '/api/games')).join() === 'A-private', `status ${noTok.status}`);
  const moveB = await call(port, 'POST', '/api/games/adopt-local', { token: tokenB });
  record('adopt-local as B moves exactly the 1 local game', moveB.status === 200 && moveB.json?.adopted === 1, JSON.stringify(moveB.json));
  const listB1 = await call(port, 'GET', '/api/games', { token: tokenB });
  record("after the explicit move B's list holds A-private, owned by B", names(listB1).join() === 'A-private' && owners(listB1).join() === loginB.json?.user?.id, JSON.stringify(names(listB1)));
  record('and the no-account view no longer lists it', Array.isArray((await call(port, 'GET', '/api/games')).json) && (await call(port, 'GET', '/api/games')).json.length === 0);
  const moveAgain = await call(port, 'POST', '/api/games/adopt-local', { token: tokenB });
  record('a second adopt-local moves nothing (idempotent)', moveAgain.status === 200 && moveAgain.json?.adopted === 0, JSON.stringify(moveAgain.json));

  // A second person saves without an account, then a THIRD brand-new account
  // signs in — the exact shape the red used to prove it was not a first-login quirk.
  const saveC = await call(port, 'POST', '/api/games', { body: game('C-private') });
  const credD = { username: 'personD', email: 'persond@example.com', password: 'Passw0rd123' };
  await call(port, 'POST', '/api/auth/register', { body: credD });
  const loginD = await call(port, 'POST', '/api/auth/login', { body: { email: credD.email, password: credD.password } });
  const tokenD = loginD.json?.token;
  const listD = await call(port, 'GET', '/api/games', { token: tokenD });
  record("FIX: a later brand-new account's sign-in adopts nothing either (D's list empty, C-private still local)",
    saveC.status === 200 && Array.isArray(listD.json) && listD.json.length === 0 && names(await call(port, 'GET', '/api/games')).join() === 'C-private',
    JSON.stringify(names(listD)));
  record("B's library is untouched by D's sign-in", names(await call(port, 'GET', '/api/games', { token: tokenB })).join() === 'A-private');
  record('server log never reports an adoption at login', !/\[auth\] adopted/.test(desk.log()), desk.log().split('\n').filter((l) => /adopt/i.test(l)).join(' | ').slice(0, 200));

  // Hosted shape: no local owner, so the route does not exist.
  host = await boot(hostData, basePort + 1, { desktop: false });
  const hosted = await call(basePort + 1, 'POST', '/api/games/adopt-local');
  record('on the hosted service adopt-local is 404 (no local owner exists there)', hosted.status === 404, `status ${hosted.status}`);
} catch (e) {
  record('test script completed without an exception', false, String(e).slice(0, 300));
} finally {
  await stop(desk); await stop(host);
  rmSync(deskData, { recursive: true, force: true }); rmSync(hostData, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass);
console.log(`\n══════ DESKTOP ADOPT-LOCAL: ${results.length - failed.length}/${results.length} checks passed ══════`);
process.exit(failed.length ? 1 : 0);

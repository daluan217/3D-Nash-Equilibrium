/* INTEGRATION — a second `dist/server.cjs` process must refuse to start
 * against a `ELECTRON_USER_DATA_PATH` another live process already owns,
 * over real child processes on the real production artifact.
 *
 * THE DEFECT THIS GUARDS (RED-DESKTOP-3, findings/RED-DESKTOP-3/
 * 001-concurrent-servers-silent-data-loss.md — reproduced independently by
 * BLUE-SERVER-DESKTOP before this fix, on ports 3037/3038, same result):
 * `loadDB()` caches the WHOLE database in memory once at startup and
 * `saveDB()` always overwrites the WHOLE file with that snapshot. Two
 * processes pointed at the same user-data directory hold two independent,
 * diverging snapshots; whichever saves LAST silently and completely erases
 * the other's saved games, with a 200 OK returned to BOTH windows at the
 * moment each save was made.
 *
 * THE FIX: a PID lockfile (`.server.lock` in the user-data directory),
 * acquired before `initDB()` ever runs. A second process finds a live PID in
 * it and exits(1) before touching the database or binding a port — loud and
 * immediate instead of silent and eventual. A STALE lock (the recorded PID
 * is no longer running — the normal case after `SIGKILL` or a crash) is
 * detected and taken over, so a crash can never permanently brick the app.
 *
 * WHY cwd IS AN EMPTY TEMP DIR: same reason as desktop-persistence.test.mjs.
 *
 *   node src/integration/desktop-concurrent-lock.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
let port = Number(process.env.LOCK_TEST_PORT || 3113);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function spawnServer(userData, thePort) {
  return spawn('node', [BUNDLE], {
    cwd: userData,
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT: String(thePort),
      IS_ELECTRON: 'true',
      ELECTRON_USER_DATA_PATH: userData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady(child, thePort) {
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming ready on ${thePort} (code ${child.exitCode})\n${log}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${thePort}/api/health`);
      if (r.ok && (await r.json())?.pid === child.pid) return { child, log: () => log };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready on ${thePort}\n${log}`);
}

/** Wait for a child that is expected to EXIT rather than become ready. */
async function waitExit(child, timeoutMs = 8000) {
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const code = await Promise.race([
    new Promise((res) => child.once('exit', (c) => res(c))),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for exit')), timeoutMs)),
  ]);
  return { code, log };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((res) => child.once('exit', res));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  await ended;
  clearTimeout(timer);
}

const userData = mkdtempSync(path.join(tmpdir(), 'nash-lock-'));
let a = null, b = null, c = null;

try {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. THE FIX: a second process on the same data dir refuses to start while
  // the first is alive, and does not silently take over on a different port.
  // ───────────────────────────────────────────────────────────────────────────
  a = spawnServer(userData, port);
  await waitReady(a, port);

  const saveA = await fetch(`http://127.0.0.1:${port}/api/games`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Game-A', payoffs: { a11: 1, a12: 2, a21: 3, a22: 4, b11: 1, b12: 2, b21: 3, b22: 4 },
    }),
  });
  record('server A saves its game', saveA.status === 200, `status ${saveA.status}`);

  const lockFile = path.join(userData, '.server.lock');
  record('a lock file is written, holding server A\'s pid',
    existsSync(lockFile) && readFileSync(lockFile, 'utf-8').trim() === String(a.pid),
    existsSync(lockFile) ? readFileSync(lockFile, 'utf-8').trim() : 'no lock file');

  const bPort = port + 1;
  b = spawnServer(userData, bPort);
  const { code: bExit, log: bLog } = await waitExit(b);
  record('THE DEFECT (fixed): a second process on the SAME data dir refuses to start (exits non-zero)',
    bExit !== 0, `exit code ${bExit}`);
  record('the refusal is loud: the reason is on stderr/stdout, not a silent failure',
    /already using this data directory/i.test(bLog), bLog.slice(0, 300));

  // It must not have silently landed on a different port instead.
  let bAnsweredSomewhere = false;
  try {
    const probe = await fetch(`http://127.0.0.1:${bPort}/api/health`);
    bAnsweredSomewhere = probe.ok;
  } catch { /* good: nothing listening */ }
  record('the refused process never bound ANY port (no silent EADDRINUSE-style retry)',
    !bAnsweredSomewhere);

  // Server A is unharmed and its data is intact — the whole point of the fix.
  const gamesAfter = await fetch(`http://127.0.0.1:${port}/api/games`);
  const gamesAfterJson = await gamesAfter.json();
  record('server A is still running and its game still there after the refused second process',
    Array.isArray(gamesAfterJson) && gamesAfterJson.some((g) => g.name === 'Game-A'),
    JSON.stringify(gamesAfterJson));

  // ───────────────────────────────────────────────────────────────────────────
  // 2. A STALE lock (recorded pid no longer running) is taken over, not stuck
  // ───────────────────────────────────────────────────────────────────────────
  a.kill('SIGKILL'); // simulate a crash: no cleanup, lock file left behind
  await new Promise((res) => a.once('exit', res));
  a = null;

  record('the lock file survives an unclean kill (fixture precondition)', existsSync(lockFile));

  const cPort = port + 2;
  c = spawnServer(userData, cPort);
  await waitReady(c, cPort);

  const lockAfterTakeover = existsSync(lockFile) ? readFileSync(lockFile, 'utf-8').trim() : null;
  record('a THIRD process takes over the stale lock rather than refusing forever',
    lockAfterTakeover === String(c.pid), `lock holds "${lockAfterTakeover}", expected ${c.pid}`);

  const gamesViaC = await (await fetch(`http://127.0.0.1:${cPort}/api/games`)).json();
  record('the data from before the crash is intact after the stale-lock takeover',
    Array.isArray(gamesViaC) && gamesViaC.some((g) => g.name === 'Game-A'),
    JSON.stringify(gamesViaC));

  // ───────────────────────────────────────────────────────────────────────────
  // 3. A clean shutdown releases the lock (no stale-lock false alarm next launch)
  // ───────────────────────────────────────────────────────────────────────────
  await stop(c);
  record('a clean SIGTERM shutdown removes the lock file', !existsSync(lockFile));
  c = null;

} finally {
  await stop(a);
  await stop(b);
  await stop(c);
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

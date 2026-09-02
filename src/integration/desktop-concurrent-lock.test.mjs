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

function spawnServer(userData, thePort, extraEnv = {}) {
  return spawn('node', [BUNDLE], {
    cwd: userData,
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT: String(thePort),
      IS_ELECTRON: 'true',
      ELECTRON_USER_DATA_PATH: userData,
      ...extraEnv,
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
      // Bounded: an unbounded fetch here could hang past this loop's own
      // retry budget if the health endpoint accepted the connection but
      // never completed the response.
      const r = await fetch(`http://127.0.0.1:${thePort}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok && (await r.json())?.pid === child.pid) return { child, log: () => log };
    } catch { /* not up yet, or the health check itself timed out */ }
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
  // The timeout timer must be CLEARED on the normal (exit-first) path, or it
  // keeps the test process alive for the rest of `timeoutMs` on every single
  // call — harmless to correctness, but it makes the whole suite needlessly
  // slow and (with enough calls) risks tripping a CI job's own wall-clock
  // budget for no reason (CodeRabbit caught this).
  let timer;
  try {
    const code = await Promise.race([
      new Promise((res) => child.once('exit', (c) => res(c))),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out waiting for exit')), timeoutMs); }),
    ]);
    return { code, log };
  } finally {
    clearTimeout(timer);
  }
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

  // ───────────────────────────────────────────────────────────────────────────
  // 4. THE STALE-TAKEOVER RACE (CodeRabbit): unconditionally unlinking a
  // lock file it had already decided was stale, without re-checking right
  // before the delete, let one process delete ANOTHER process's brand-new
  // LIVE lock — the exact interleaving: process D reads a stale lock and
  // decides to take it over; before D unlinks it, process E independently
  // does the same read-decide-takeover and SUCCEEDS, becoming the live
  // owner; D's unconditional unlink then deletes E's fresh lock anyway,
  // and D goes on to create a SECOND live lock — two writers.
  //
  // Real OS-timing cannot be trusted to hit this deterministically (a
  // 12-process stress test against the pre-recheck code still serialized to
  // 1 winner in this sandbox — see the round's REPORT). `NASH_LOCK_TEST_DELAY_MS`
  // is a test-only hook: it makes D pause, synchronously, AFTER deciding the
  // lock is stale but BEFORE its recheck-and-unlink, giving E time to
  // complete a full takeover in between. This exercises the exact
  // vulnerable window directly instead of hoping to get lucky on timing.
  // ───────────────────────────────────────────────────────────────────────────
  const raceUserData = mkdtempSync(path.join(tmpdir(), 'nash-stale-race-'));
  const raceLockFile = path.join(raceUserData, '.server.lock');
  // A lock held by a PID that is guaranteed not to exist (Linux/macOS PIDs
  // don't reach this range in practice) — genuinely stale from the start.
  writeFileSync(raceLockFile, '999999999', 'utf-8');

  const dPort = port + 10;
  const ePort = port + 11;
  let d = null, e = null;
  try {
    // D starts first and will pause mid-takeover.
    d = spawnServer(raceUserData, dPort, { NASH_LOCK_TEST_DELAY_MS: '2500' });
    // Give D time to reach its read-decide-stale point (well before its
    // 2500ms pause ends) before E starts its own takeover attempt.
    await new Promise((r) => setTimeout(r, 800));
    e = spawnServer(raceUserData, ePort, {});

    // E should win cleanly and become the live, healthy server.
    await waitReady(e, ePort);
    record('process E completes its stale takeover and becomes healthy',
      true, `pid ${e.pid}`);
    const lockAfterE = readFileSync(raceLockFile, 'utf-8').trim();
    record('the lock now holds E\'s pid (E genuinely took over)',
      lockAfterE === String(e.pid), `lock holds "${lockAfterE}", expected ${e.pid}`);

    // Now D wakes from its pause, rechecks, and (on the fix) MUST detect the
    // change and refuse rather than deleting E's fresh lock.
    const { code: dExit, log: dLog } = await waitExit(d, 8000);
    record('THE FIX: D detects the change and refuses (exits non-zero), rather than winning a second lock',
      dExit !== 0, `exit code ${dExit}`);

    // The clinching check: E must still be alive and healthy AFTER D's
    // whole sequence completes — on the pre-fix code, D's blind unlink would
    // have deleted E's lock file (E itself stays alive in-process, unaware,
    // but the FILE protecting it is gone), and D would then create its own
    // second lock and start serving too.
    const eStillUp = await fetch(`http://127.0.0.1:${ePort}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok).catch(() => false);
    record('E is still running and healthy after D\'s whole attempt',
      eStillUp);
    const lockAfterD = existsSync(raceLockFile) ? readFileSync(raceLockFile, 'utf-8').trim() : null;
    record('the lock file still holds E\'s pid, undisturbed by D',
      lockAfterD === String(e.pid), `lock holds "${lockAfterD}", expected ${e.pid}`);

    // D must never have bound its own port either.
    const dBound = await fetch(`http://127.0.0.1:${dPort}/api/health`, { signal: AbortSignal.timeout(500) })
      .then((r) => r.ok).catch(() => false);
    record('D never bound a port of its own (no second live writer)', !dBound);
  } finally {
    await stop(d);
    await stop(e);
    rmSync(raceUserData, { recursive: true, force: true });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5. THE ENOENT RACE (CodeRabbit's re-review of the section-4 fix):
  // `fs.existsSync(lockFile)` and `fs.readFileSync(lockFile)` are two
  // separate calls — a competing process (or, deterministically here, the
  // test itself) can unlink the file in the gap between them, and the
  // unguarded `readFileSync` would throw ENOENT OUTSIDE any catch,
  // crashing `startServer()` before it ever reaches `initDB()`/`listen()`.
  // `NASH_LOCK_TEST_READ_RACE_DELAY_MS` pauses right after confirming the
  // file exists but before reading it, so the test can delete the file out
  // from under the process deterministically rather than racing real
  // process timing (no second server process even needed for this one).
  // ───────────────────────────────────────────────────────────────────────────
  const enoentUserData = mkdtempSync(path.join(tmpdir(), 'nash-enoent-race-'));
  const enoentLockFile = path.join(enoentUserData, '.server.lock');
  writeFileSync(enoentLockFile, '999999999', 'utf-8'); // stale from the start

  const fPort = port + 12;
  let f = null;
  try {
    f = spawnServer(enoentUserData, fPort, { NASH_LOCK_TEST_READ_RACE_DELAY_MS: '1500' });
    // Give F time to reach openSync(wx) -> EEXIST -> existsSync check
    // (well before its own 1500ms pause ends), then delete the lock file
    // out from under it while it's paused.
    await new Promise((r) => setTimeout(r, 500));
    record('fixture precondition: the lock file exists right before we delete it mid-pause',
      existsSync(enoentLockFile));
    rmSync(enoentLockFile, { force: true });

    // F resumes, calls readFileSync against a now-missing file. On the
    // pre-fix code this throws uncaught and the process exits/crashes
    // abnormally without ever becoming healthy; on the fix it catches
    // ENOENT, loops, and — since the path is now free — successfully
    // creates its OWN fresh lock and boots normally.
    await waitReady(f, fPort);
    record('THE FIX: F survives the ENOENT and becomes healthy, rather than crashing on an uncaught throw',
      true, `pid ${f.pid}`);
    const lockAfterF = existsSync(enoentLockFile) ? readFileSync(enoentLockFile, 'utf-8').trim() : null;
    record('F ends up holding its own fresh lock',
      lockAfterF === String(f.pid), `lock holds "${lockAfterF}", expected ${f.pid}`);
  } finally {
    await stop(f);
    rmSync(enoentUserData, { recursive: true, force: true });
  }

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

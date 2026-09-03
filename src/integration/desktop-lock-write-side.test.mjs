/* INTEGRATION — `acquireDesktopLock`'s handling of the read-only-lock-file
 * and the-directory-itself-blocked cases, over real child processes on the
 * real production artifact.
 *
 * PART 1 (RED-DESKTOP-5/001's own reproduction — this was verified BY HAND
 * twice in that finding and BLUE-SERVER-DESKTOP-5's own writeup, but had no
 * automated regression yet; this is that regression):
 * `acquireDesktopLock` has a READ-side branch — the lock file EXISTS
 * (`fs.openSync(lockFile, "wx", ...)` returned EEXIST) but this process
 * cannot READ its content. The un-fixed code failed OPEN on that ambiguity;
 * the fix (server.ts, the `catch` around `fs.readFileSync(lockFile, ...)`)
 * refuses loudly instead, on the reasoning that EEXIST is itself positive
 * evidence someone wrote the lock. This exercises the director's own exact
 * reproduction: a real, alive first instance; chmod 000 on the EXISTING
 * lock file; a second instance against the same directory must never serve
 * traffic.
 *
 * PART 2 (RED-DESKTOP-5b, this round's follow-up to 001's open question —
 * "should the WRITE-side fail-open also close?"): there are TWO distinct
 * write-side "unexpected filesystem error" branches, and this round's
 * analysis (see server.ts's own comments at each site) found they are NOT
 * symmetric:
 *
 *   (a) the directory-creation branch (mkdirSync, reached only when
 *       `fs.existsSync(userDataPath)` already said false) can only be
 *       reached when there is no accessible pre-existing directory for
 *       ANY process to have data in — failing open there buys nothing
 *       (loadDBFromFile needs the identical access and silently falls back
 *       to an empty DB) and is now CLOSED (fails loudly).
 *
 *   (b) the lock-file-creation branch (openSync "wx") is reached with the
 *       directory already known to exist, and `err.code !== "EEXIST"` is
 *       NOT reliable proof no lock file is there — verified empirically
 *       (see the round's STATE.md): a directory with no search/lookup
 *       permission (chmod 000) reports EACCES for a lock-file path
 *       REGARDLESS of whether that lock file exists, and `fs.existsSync`
 *       cannot tell the two apart either (it swallows every error the same
 *       way). `fs.statSync`'s error CODE can: `ENOENT` positively proves
 *       absence (the lookup itself succeeded); anything else means the
 *       lookup could not even be attempted. So the fix: ENOENT on the stat
 *       -> confirmed absent, safe to fail open (this is EXACTLY the shape
 *       desktop-unwritable-save.test.mjs already exercises and must keep
 *       passing — a read+execute-but-not-writable directory with no lock
 *       file yet); anything else on the stat -> cannot resolve -> refuse,
 *       same principle as 001's read-side fix.
 *
 * WHY chmod, not real concurrent processes, for part 2's cases: the whole
 * point is to reproduce a SPECIFIC filesystem-permission shape (a directory
 * whose contents cannot even be looked up), which chmod recreates exactly
 * and deterministically; the shape is a real, reachable one in production
 * (an external tool or the user tightening permissions on the data
 * directory, e.g. via a security/EDR product or a mistaken `chmod`).
 *
 *   node src/integration/desktop-lock-write-side.test.mjs
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// A mutation that makes a fixed branch fail OPEN again typically means the
// server we spawned never exits — `waitExit` then REJECTS on its own
// timeout. Left uncaught, that crashes this whole script and (worse) hides
// whatever the LATER parts would have shown. Running each part through this
// wrapper turns that rejection into an ordinary recorded failure instead, so
// one part's mutation-caught crash cannot mask another part's result.
async function runPart(label, fn) {
  try {
    await fn();
  } catch (err) {
    record(`${label}: did not complete (crashed/timed out)`, false, String(err && err.message || err));
  }
}

function spawnServer(userData, thePort, extraEnv = {}, cwdOverride = null) {
  // `cwdOverride` matters ONLY for part 2a below, where `userData` itself is
  // deliberately not a usable directory (a plain file sits at that path) —
  // spawn() itself needs a real directory to chdir into, distinct from
  // ELECTRON_USER_DATA_PATH, which is what the server actually reads.
  return spawn('node', [BUNDLE], {
    cwd: cwdOverride || userData,
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

async function waitReady(child, thePort, timeoutMs = 20000) {
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming ready on ${thePort} (code ${child.exitCode})\n${log}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${thePort}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok && (await r.json())?.pid === child.pid) return { child, log: () => log };
    } catch { /* not up yet, or the health check itself timed out */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready on ${thePort}\n${log}`);
}

/** Wait for a child that is expected to REFUSE (exit non-zero) rather than serve. */
async function waitExit(child, timeoutMs = 8000) {
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
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

const port1 = Number(process.env.LOCK_WS_PORT || 3150);

// ═════════════════════════════════════════════════════════════════════════
// PART 1: chmod 000 on an EXISTING lock file, with a LIVE holder — the
// director's own reproduction of RED-DESKTOP-5/001.
// ═════════════════════════════════════════════════════════════════════════
await runPart('PART 1', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-lock-ws1-'));
  const lockFile = path.join(userData, '.server.lock');
  let p1 = null, p2 = null;
  try {
    p1 = spawnServer(userData, port1);
    await waitReady(p1, port1);
    record('P1: real alive first instance boots and holds the lock', existsSync(lockFile));

    chmodSync(lockFile, 0o000);
    record('fixture: the lock file is now unreadable (chmod 000) while P1 is still alive', true);

    const port2 = port1 + 1;
    p2 = spawnServer(userData, port2);
    const { code, log } = await waitExit(p2);
    record('THE FIX: a second process refuses to start against an unreadable-but-existing lock (exits non-zero)',
      code !== 0, `exit code ${code}`);
    record('the refusal names the real problem (unreadable/EACCES), not a generic message',
      /could not.*be read|EACCES|permission/i.test(log), log.slice(0, 400));

    let p2Answered = false;
    try {
      const probe = await fetch(`http://127.0.0.1:${port2}/api/health`, { signal: AbortSignal.timeout(1000) });
      p2Answered = probe.ok;
    } catch { /* good: nothing listening */ }
    record('P2 never served /api/health (did not silently boot unprotected)', !p2Answered);

    const p1Health = await fetch(`http://127.0.0.1:${port1}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok).catch(() => false);
    record('P1 is unaffected and still healthy the whole time', p1Health);
  } finally {
    await stop(p1);
    await stop(p2);
    try { chmodSync(lockFile, 0o600); } catch { /* may already be gone */ }
    rmSync(userData, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PART 2a: the directory-CREATION branch now fails CLOSED. `userDataPath`
// does not exist yet (so `acquireDesktopLock` will actually attempt
// `mkdirSync`, unlike parts 2b/2c below where the path already exists in
// SOME form and mkdir is skipped) and its PARENT has no write permission,
// so the create genuinely fails with no directory ever coming into being —
// verified empirically before writing this fixture (see the round's
// STATE.md): `existsSync(userDataPath)` is `false`, `mkdirSync` throws
// EACCES.
// ═════════════════════════════════════════════════════════════════════════
await runPart('PART 2a', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'nash-lock-ws2a-'));
  const userData = path.join(parent, 'user-data'); // deliberately does NOT exist
  chmodSync(parent, 0o555); // r-x: readable/listable, but nothing can be CREATED inside it
  let p = null;
  try {
    const port = port1 + 10;
    p = spawnServer(userData, port, {}, parent); // spawn's cwd must be a real, accessible dir
    const { code, log } = await waitExit(p);
    record('THE FIX: a directory-creation failure (parent not writable) now refuses to start (exits non-zero)',
      code !== 0, `exit code ${code}`);
    record('the refusal names the directory-creation problem',
      /could not create or access the desktop data directory/i.test(log), log.slice(0, 500));
    let answered = false;
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      answered = probe.ok;
    } catch { /* good */ }
    record('it never served /api/health (no silent empty-database boot)', !answered);
  } finally {
    await stop(p);
    chmodSync(parent, 0o755);
    rmSync(parent, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PART 2b: the lock-file-CREATION branch, ENOTDIR shape — a FILE occupies
// the spot the directory needs to be (a realistic corruption: a stray file
// left by some other tool with the exact name Electron would use for the
// user-data directory). `existsSync(userDataPath)` is TRUE here (it exists,
// just not as a directory), so `mkdirSync` is skipped entirely (part 2a's
// branch does not fire) and the failure instead surfaces where
// `acquireDesktopLock` tries to create the LOCK FILE inside it — with
// `err.code === "ENOTDIR"`, not `"EEXIST"`, exercising the same
// "cannot determine, so refuse" logic as part 2c below via a different
// underlying errno.
// ═════════════════════════════════════════════════════════════════════════
await runPart('PART 2b', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'nash-lock-ws2b-'));
  const userData = path.join(parent, 'user-data');
  writeFileSync(userData, 'not a directory'); // a FILE sits where the dir should be
  let p = null;
  try {
    const port = port1 + 11;
    p = spawnServer(userData, port, {}, parent);
    const { code, log } = await waitExit(p);
    record('THE FIX: a non-directory at the user-data path refuses to start (exits non-zero)',
      code !== 0, `exit code ${code}`);
    record('the refusal explains it could not determine whether a lock already exists',
      /could not determine whether/i.test(log), log.slice(0, 500));
    let answered = false;
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      answered = probe.ok;
    } catch { /* good */ }
    record('it never served /api/health (no silent empty-database boot)', !answered);
  } finally {
    await stop(p);
    rmSync(parent, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PART 2c: the lock-file-CREATION branch — when the directory blocks even
// LOOKING (chmod 000: no search/lookup permission), whether a lock file
// exists there or not is genuinely undecidable from here, so this must now
// refuse (fail closed), matching 001's own "cannot resolve -> refuse"
// principle. This is the worst case the round found `fs.existsSync` could
// NOT distinguish from "confirmed absent" (both report `false`).
// ═════════════════════════════════════════════════════════════════════════
await runPart('PART 2c', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'nash-lock-ws2c-'));
  const userData = path.join(parent, 'user-data');
  // Create the dir normally first (so `existsSync(userDataPath)` is true and
  // `mkdirSync` never even runs — this is purely the wx-open branch), put a
  // REAL lock file in there (as if another instance IS holding it), then
  // lock out all access to the directory's own contents — the worst case:
  // this process cannot even confirm the lock file's existence, let alone
  // read it. `parent` (kept accessible) is used as spawn's own cwd — chmod
  // 000 blocks even chdir-ing INTO userData, which would break spawn() itself
  // before the server process ever started.
  mkdirSync(userData);
  writeFileSync(path.join(userData, '.server.lock'), '999999999'); // stale pid, doesn't matter — unreachable anyway
  chmodSync(userData, 0o000);
  let p = null;
  try {
    const port = port1 + 12;
    p = spawnServer(userData, port, {}, parent);
    const { code, log } = await waitExit(p);
    record('THE FIX: a totally-inaccessible data directory refuses to start rather than guessing "no lock" (exits non-zero)',
      code !== 0, `exit code ${code}`);
    record('the refusal explains it could not determine whether a lock already exists',
      /could not determine whether/i.test(log), log.slice(0, 500));
    let answered = false;
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      answered = probe.ok;
    } catch { /* good */ }
    record('it never served /api/health', !answered);
  } finally {
    await stop(p);
    chmodSync(userData, 0o755);
    rmSync(parent, { recursive: true, force: true });
  }
});

const failed = results.filter((r) => !r.pass);
console.log(`\n══════ DESKTOP LOCK WRITE-SIDE: ${results.length - failed.length}/${results.length} checks passed ══════`);
if (failed.length > 0) {
  console.error(`\n${failed.length} FAILURE(S):`);
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

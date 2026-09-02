/* INTEGRATION — the packaged desktop app must not silently vanish when its
 * data-directory lock is held (or looks held).
 *
 * THE DEFECT (RED-DESKTOP-4, round4/findings/RED-DESKTOP-4/001-reused-pid-
 * silent-app-vanish.md, reproduced independently against the real installed
 * .app before this fix): server.ts's acquireDesktopLock() told a live
 * lock-holder apart from a stale one purely by `process.kill(heldBy, 0)` —
 * "is *some* process using this pid running right now" — and on "alive"
 * called a bare `process.exit(1)`. Because electron-main.cjs require()s
 * dist/server.cjs IN-PROCESS (not as a spawned child), that exit silently
 * killed the WHOLE Electron main process before any BrowserWindow existed:
 * no window, no dialog, no crash report, nothing in the unified log. Since a
 * pid is not a durable identity — any prior crash/force-quit leaves the lock
 * file's pid stale, and the OS is free to hand that pid to an unrelated
 * process later — this could brick the packaged app forever with zero
 * diagnostic reachable by a normal user.
 *
 * THE FIX: acquireDesktopLock now returns a boolean instead of exiting
 * unconditionally. On "alive" (or "could not acquire after contention") it
 * calls `reportDesktopLockFailure`, which checks for
 * `globalThis.onDesktopLockFailure` — the hook electron-main.cjs registers
 * BEFORE requiring dist/server.cjs, whose presence IS the "we are the
 * packaged app and someone can show a dialog" signal. With the hook present:
 * the hook is called with `{ message, lockFile }` and the process does NOT
 * exit (server.ts hands control to the hook instead, which shows a real
 * dialog and lets the user quit OR clear a misidentified lock and relaunch).
 * Without the hook (a standalone `node dist/server.cjs`, exactly this file's
 * sibling desktop-concurrent-lock.test.mjs): `process.exit(1)` still fires,
 * unchanged — a loud, immediate terminal failure is the CORRECT behavior
 * there, and that suite's own regression coverage must keep passing.
 *
 * WHY THIS RUNS OUTSIDE HTTP: the failure happens before any port is bound,
 * so there is nothing to fetch(). The runner (src/desktop/lock-hook-runner.cjs)
 * requires the bundle IN-PROCESS, exactly as electron-main.cjs does, and has
 * to be a SEPARATE child process per case so each gets a fresh top-level
 * execution (a second in-process require of the same path would hit Node's
 * require cache and skip startServer()'s side effects entirely).
 *
 *   node src/integration/desktop-lock-dialog-hook.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
const RUNNER = path.join(serverDir, 'src/desktop/lock-hook-runner.cjs');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function run(withHook) {
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-lockhook-'));
  const r = spawnSync('node', [RUNNER, BUNDLE, userData, withHook ? '1' : '0'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  rmSync(userData, { recursive: true, force: true });
  return r;
}

// ══ 1. WITH the hook (the packaged-app condition): the process must survive,
//      the hook must fire with the right shape, and the server must never
//      have gone on to bind a port.
{
  const r = run(true);
  const m = (r.stdout || '').match(/RUNNER_RESULT (\{.*\})/);
  const parsed = m ? JSON.parse(m[1]) : null;

  record('with the hook registered, the process survives (exit 0, not killed by acquireDesktopLock)',
    r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`);
  record('the hook is actually invoked', !!parsed?.hookCalled,
    `stdout=${(r.stdout || '').slice(0, 300)}`);
  record('the hook receives a message naming the conflict',
    typeof parsed?.hookPayload?.message === 'string' && parsed.hookPayload.message.includes('Refusing to start'),
    `message=${JSON.stringify(parsed?.hookPayload?.message)}`);
  // CodeRabbit (2026-09-02 re-review): a bare .endsWith('.server.lock')
  // suffix check would pass for an unrelated path that merely ends the same
  // way. The runner now reports the exact path it wrote the lock to
  // (expectedLockFile); compare for equality, not a suffix.
  record('the hook receives the actual lock file path (not parsed back out of prose)',
    typeof parsed?.hookPayload?.lockFile === 'string'
      && parsed.hookPayload.lockFile === parsed?.expectedLockFile,
    `lockFile=${JSON.stringify(parsed?.hookPayload?.lockFile)} expected=${JSON.stringify(parsed?.expectedLockFile)}`);
  // CodeRabbit (2026-09-02 re-review): log text ("Express server running")
  // is not proof — a code path that binds a port without printing that
  // exact line would pass. The runner instruments net.Server.prototype.listen
  // BEFORE requiring the bundle and reports the real call count.
  record('the server never went on to bind a port (initDB/listen skipped)',
    parsed?.listenCallCount === 0,
    `listenCallCount=${parsed?.listenCallCount}`);
}

// ══ 2. WITHOUT the hook (a standalone `node dist/server.cjs`, e.g. this
//      file's own sibling desktop-concurrent-lock.test.mjs): unchanged,
//      loud, immediate process.exit(1). This is the regression guard that
//      the hook path is gated behind the hook's PRESENCE, not a blanket
//      change to "never exit."
{
  const r = run(false);
  record('WITHOUT the hook, the original loud process.exit(1) still fires',
    r.status === 1, `status=${r.status}`);
  record('WITHOUT the hook, no RUNNER_RESULT is printed (the process never reached that line)',
    !(r.stdout || '').includes('RUNNER_RESULT'), `stdout=${(r.stdout || '').slice(0, 200)}`);
}

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ DESKTOP LOCK DIALOG HOOK: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length > 0) {
  console.error(`\n${fails.length} FAILURE(S):`);
  for (const f of fails) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

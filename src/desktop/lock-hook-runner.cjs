/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runner for src/integration/desktop-lock-dialog-hook.test.mjs.
 *
 * Requires the REAL dist/server.cjs bundle IN-PROCESS (never spawned as a
 * child of ITS OWN), exactly the way electron-main.cjs does — that in-process
 * require is what made the pre-fix `process.exit(1)` inside
 * acquireDesktopLock kill the WHOLE Electron main process silently
 * (RED-DESKTOP-4/001-reused-pid-silent-app-vanish.md). This file has to be a
 * separate process from the test runner itself so each invocation gets a
 * fresh top-level execution of the bundle (Node's require cache would return
 * the same cached exports, and skip startServer()'s top-level side effects
 * entirely, on a second in-process require of the same path).
 *
 * Writes a live node CHILD's pid into the lock file before requiring the
 * bundle, which deterministically exercises the "alive" branch of
 * acquireDesktopLock and survives both stale proofs (the child started after
 * nothing; it is a node, i.e. ours). This is also exactly the shape of the false-positive class the
 * finding is about — PID aliveness alone cannot tell "the same server" apart
 * from "any live process," which is why the packaged app needs a real dialog
 * and a way to clear a misidentified lock rather than a silent kill.
 *
 * Usage: node lock-hook-runner.cjs <bundlePath> <userDataDir> <withHook 0|1>
 * Prints one line `RUNNER_RESULT <json>` and exits 0 if the process survived
 * to report (i.e. was not process.exit()'d by acquireDesktopLock). If the
 * process WAS exited by acquireDesktopLock, no RUNNER_RESULT line appears and
 * the exit code is whatever acquireDesktopLock chose (1 in the current code).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const bundlePath = process.argv[2];
const userDataDir = process.argv[3];
const withHook = process.argv[4] === '1';

if (!bundlePath || !userDataDir) {
  console.error('usage: lock-hook-runner.cjs <bundlePath> <userDataDir> <withHook 0|1>');
  process.exit(2);
}

fs.mkdirSync(userDataDir, { recursive: true });
const lockFile = path.join(userDataDir, '.server.lock');
// A live holder of the data directory, the way a running server holds it
// (flock-holder.cjs: flock on darwin, a live pid elsewhere). The bundle is
// required only once it is READY, so the refusal is deterministic.
const holder = require('child_process').spawn(process.execPath,
  [path.join(__dirname, 'flock-holder.cjs'), userDataDir], { stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { holder.kill('SIGKILL'); } catch {} });

process.env.NODE_ENV = 'production';
process.env.IS_ELECTRON = 'true';
process.env.ELECTRON_USER_DATA_PATH = userDataDir;
process.env.PORT = '0';
// Never let a real .env on the machine running this test hand the bundle
// credentials or secrets it could not have as a packaged app.
delete process.env.AUTH_SECRET;
delete process.env.ADMIN_SECRET;
delete process.env.GCS_BUCKET_NAME;

let hookPayload = null;
if (withHook) {
  // The exact global electron-main.cjs registers BEFORE requiring
  // dist/server.cjs. Its mere presence is server.ts's own signal that a
  // dialog can be shown instead of exiting in-process.
  globalThis.onDesktopLockFailure = (payload) => {
    hookPayload = payload;
  };
}

// CodeRabbit (2026-09-02 re-review): "the server never went on to bind a
// port" used to be checked by scanning stdout for the literal string
// "Express server running" -- log text a normal user never sees and this
// test should not depend on either. Patched BEFORE require() so it also
// catches a bind attempt that happens on a code path with NO log line at
// all. `listenCallCount` is the actual proof; `RUNNER_RESULT` reports it
// alongside the hook payload.
let listenCallCount = 0;
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  listenCallCount++;
  return originalListen.apply(this, args);
};

holder.stdout.once('data', () => {
require(path.resolve(bundlePath));

// If acquireDesktopLock took the process.exit(1) path, execution never
// reaches here at all -- there is no line left to print and the process's
// own exit code (1) is the signal the test reads.
setTimeout(() => {
  console.log(`RUNNER_RESULT ${JSON.stringify({
    hookCalled: hookPayload !== null,
    hookPayload,
    expectedLockFile: lockFile,
    listenCallCount,
  })}`);
  process.exit(0);
}, 300);
});

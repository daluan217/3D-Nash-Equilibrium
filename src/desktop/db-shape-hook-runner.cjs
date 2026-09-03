/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runner for src/integration/db-shape-refusal.test.mjs's packaged-app case.
 *
 * Sibling of lock-hook-runner.cjs, same in-process-require shape (electron-
 * main.cjs requires dist/server.cjs IN-PROCESS, so a bare `process.exit()`
 * anywhere inside it — including `reportDesktopLockFailure`, which
 * `normalizeDbShape`'s caller in `loadDBFromFile` reuses for an
 * unrecoverable db.json shape, not only for a lock conflict — would
 * otherwise kill the whole Electron main process silently, no window, no
 * dialog, nothing in the unified log). Deliberately does NOT pre-write a
 * `.server.lock` file the way lock-hook-runner.cjs does: writing one here
 * would make `acquireDesktopLock` (which runs BEFORE `initDB`/
 * `loadDBFromFile`) refuse on the LOCK path first, and the db.json shape
 * check would never be reached at all. The bad-shape db.json itself is
 * written by the caller before invoking this runner.
 *
 * Usage: node db-shape-hook-runner.cjs <bundlePath> <userDataDir> <withHook 0|1>
 * Prints one line `RUNNER_RESULT <json>` and exits 0 if the process survived
 * to report (i.e. was not exited by the db-shape refusal). If the process
 * WAS exited, no RUNNER_RESULT line appears and the exit code is whatever
 * `reportDesktopLockFailure` chose (1 in the current code, the standalone —
 * no hook — branch).
 */
const net = require('net');
const path = require('path');

const bundlePath = process.argv[2];
const userDataDir = process.argv[3];
const withHook = process.argv[4] === '1';

if (!bundlePath || !userDataDir) {
  console.error('usage: db-shape-hook-runner.cjs <bundlePath> <userDataDir> <withHook 0|1>');
  process.exit(2);
}

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

// Same instrumentation as lock-hook-runner.cjs: proof the server never went
// on to bind a port, not a scan of log text a normal user never sees.
let listenCallCount = 0;
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  listenCallCount++;
  return originalListen.apply(this, args);
};

require(path.resolve(bundlePath));

// If the db-shape refusal took the process.exit(1) path (no hook), execution
// never reaches here at all — there is no line left to print and the
// process's own exit code (1) is the signal the test reads.
setTimeout(() => {
  console.log(`RUNNER_RESULT ${JSON.stringify({
    hookCalled: hookPayload !== null,
    hookPayload,
    listenCallCount,
  })}`);
  process.exit(0);
}, 300);

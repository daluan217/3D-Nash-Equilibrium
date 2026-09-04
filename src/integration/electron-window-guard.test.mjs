/* INTEGRATION — RED-DESKTOP-5/002: no stray blank window during a desktop
 * lock-failure dialog.
 *
 * THE DEFECT: electron-main.cjs's 800ms "slow boot sequence" fallback (and
 * `app.on('activate')`) called `createWindow()` whenever `mainWindow` was
 * still null, with no awareness that a desktop-lock failure was in progress.
 * server.ts's lock-failure path deliberately never binds a port, so that
 * extra window loaded Chromium's own chrome-error://chromewebdata/ — a
 * stray, blank, broken-looking window appearing RIGHT ALONGSIDE the correct
 * native "Startup Blocked" dialog (round4's #88 fix, still correct). This is
 * a regression risk introduced BY #88: keeping the process alive for the
 * dialog is what gives this timer room to fire at all.
 *
 * THE FIX: `global.onDesktopLockFailure` now cancels the fallback timer
 * outright (`clearTimeout`) the moment it is known the server will never
 * bind a port, plus a `lockFailurePending` guard on `app.on('activate')`
 * (no timer to cancel there — a dock-icon click can happen at any time).
 *
 * Runs via src/desktop/electron-window-guard-runner.cjs, a separate process
 * per scenario (fresh top-level execution each time — Node's require cache
 * would otherwise skip electron-main.cjs's side effects on a second
 * in-process require) with `electron` totally stubbed (same style as
 * src/desktop/require-probe.cjs) except for the few calls this test reads:
 * `app.on(event, cb)` capture, `new BrowserWindow()` counting, and
 * `dialog.showMessageBox` (never resolves within the test, matching a real
 * modal dialog staying open).
 *
 *   node src/integration/electron-window-guard.test.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const MAIN_CJS = path.join(serverDir, 'electron-main.cjs');
const RUNNER = path.join(serverDir, 'src/desktop/electron-window-guard-runner.cjs');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function run(mode) {
  const r = spawnSync('node', [RUNNER, MAIN_CJS, mode], { encoding: 'utf8', timeout: 10_000 });
  const m = (r.stdout || '').match(/RUNNER_RESULT (\{.*\})/);
  return { raw: r, parsed: m ? JSON.parse(m[1]) : null };
}

// ══ 1. THE DEFECT FIXTURE: a lock failure, then 'ready' fires (server never
//      started), then past the 800ms fallback window, then 'activate' fires
//      too (a dock-icon click while the dialog is still up). ZERO windows
//      may ever be created — the dialog is the only UI a user should see.
{
  const { raw, parsed } = run('lockfail');
  record('runner completed cleanly', raw.status === 0, `status=${raw.status} stderr=${(raw.stderr || '').slice(0, 300)}`);
  record('the lock-failure dialog was shown', parsed?.dialogShown === 1, `dialogShown=${parsed?.dialogShown}`);
  record('THE DEFECT FIXTURE: no window is ever created after a lock failure (800ms fallback + activate both suppressed)',
    parsed?.windowCount === 0, `windowCount=${parsed?.windowCount}`);
}

// ══ 2. CONTROL: a genuine slow boot with NO lock failure must still show a
//      window after 800ms — the fix must not disable the fallback it was
//      built for, only gate it on a lock failure actually being in progress.
{
  const { raw, parsed } = run('slowboot-normal');
  record('runner completed cleanly (control)', raw.status === 0, `status=${raw.status} stderr=${(raw.stderr || '').slice(0, 300)}`);
  record('CONTROL: no dialog shown (no lock failure occurred)', parsed?.dialogShown === 0, `dialogShown=${parsed?.dialogShown}`);
  record('CONTROL: a genuine slow boot still opens exactly one window after 800ms (fallback still works)',
    parsed?.windowCount === 1, `windowCount=${parsed?.windowCount}`);
}

// ══ 3. DATA CONFLICT: this uses the same no-window startup-blocked path as
//      a lock, but must not tell a person to inspect/delete a lock. The
//      recovery wording is deliberately backup-first and says the app has
//      not selected or merged either valid database.
{
  const { raw, parsed } = run('data-conflict');
  const detail = parsed?.dialogOptions?.detail || '';
  record('data-conflict runner completed cleanly', raw.status === 0,
    `status=${raw.status} stderr=${(raw.stderr || '').slice(0, 300)}`);
  record('DATA CONFLICT: the startup-blocked dialog is shown without creating a window',
    parsed?.dialogShown === 1 && parsed?.windowCount === 0,
    `dialogShown=${parsed?.dialogShown} windowCount=${parsed?.windowCount}`);
  record('DATA CONFLICT: the dialog tells the user to back up both databases before recovery',
    /Back up both database files before resolving the conflict/.test(detail), detail);
  record('DATA CONFLICT: the dialog promises no automatic choice, merge, rename, or deletion',
    /will not choose, merge, rename, or delete either copy/.test(detail), detail);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

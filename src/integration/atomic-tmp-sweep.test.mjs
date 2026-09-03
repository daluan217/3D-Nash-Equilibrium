/* INTEGRATION — a `db.json.tmp-*` scratch file orphaned by an earlier,
 * interrupted `writeFileAtomicSync` must be swept away at the next startup,
 * not left forever.
 *
 * THE DEFECT (RED-DESKTOP-7/001, round7/findings/RED-DESKTOP-7/
 * 001-orphaned-tmp-file-on-rename-failure.md, director-reproduced): when the
 * user-data directory turns unwritable specifically between the tmp file
 * being closed and the `renameSync` over the real file, the rename fails —
 * and `writeFileAtomicSync`'s OWN failure-cleanup (`fs.unlinkSync(tmp)`)
 * fails for the identical reason (unlink also needs directory-write
 * permission), silently (`catch { /* best effort *\/ }`, no log line). The
 * scratch file is orphaned on disk forever, with no operator-visible trace.
 * RED-DESKTOP-7 reproduced this under 50 concurrent `POST /api/games`
 * requests with the directory chmod'd read-only mid-burst (2 of 3 runs left
 * exactly one `.tmp-*` file); every affected request still got an honest
 * 500 and db.json itself stayed valid JSON throughout — this test does not
 * re-run that race (it is inherently timing-dependent and already proven in
 * the finding), it proves the FIX: whatever orphan is sitting there at the
 * next boot is found, removed, and logged.
 *
 * THE FIX: `writeFileAtomicSync`'s cleanup now logs when it cannot remove its
 * own scratch file, and a new `sweepStaleAtomicTmpFiles`, called once at
 * startup right after the desktop lock is held, removes any
 * `db.json.tmp-*` file older than a few seconds. A file younger than that
 * threshold is left alone (negative control below) — proving the sweep is
 * actually AGE-GATED, not "delete everything matching the prefix", which
 * would be unsafe if this ever ran while a save was genuinely in flight.
 *
 *   node src/integration/atomic-tmp-sweep.test.mjs
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, utimesSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = process.env.ATOMIC_SWEEP_PORT || '3721';
const BASE = `http://localhost:${PORT}`;
const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const userData = mkdtempSync(path.join(tmpdir(), 'nash-atomic-sweep-'));

// A valid, minimal db.json so loadDBFromFile takes the ordinary path (not
// the missing-file/corrupt-file recovery branches — this fixture is about
// the SWEEP, not those).
const dbFile = path.join(userData, 'db.json');
{
  const fd = openSync(dbFile, 'w', 0o600);
  writeSync(fd, JSON.stringify({ users: [], games: [] }, null, 2));
  closeSync(fd);
}

// An OLD orphan — a fake pid that cannot possibly be this process, mtime
// backdated well past the sweep's threshold. Must be removed.
const oldOrphan = path.join(userData, 'db.json.tmp-999999-1700000000000');
{
  const fd = openSync(oldOrphan, 'w', 0o600);
  writeSync(fd, '{"partial": tr'); // deliberately not even valid JSON — a real interrupted write
  closeSync(fd);
  const old = new Date(Date.now() - 60_000);
  utimesSync(oldOrphan, old, old);
}

// A YOUNG "orphan" (also not this process's pid, but freshly written — mtime
// left at "now"). Must survive THIS boot: the age gate exists specifically
// so the sweep never races a write that is still genuinely in flight.
const youngOrphan = path.join(userData, 'db.json.tmp-888888-1700000000001');
{
  const fd = openSync(youngOrphan, 'w', 0o600);
  writeSync(fd, '{"partial": tr');
  closeSync(fd);
}

let server = null;
let log = '';
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet, or the health check itself timed out */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}

try {
  server = spawn('node', [BUNDLE], {
    cwd: userData,
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT,
      IS_ELECTRON: 'true',
      ELECTRON_USER_DATA_PATH: userData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  const ready = await waitReady();
  record('server started against a directory holding a stale orphan tmp file', ready, log.slice(-500));

  record('the OLD orphan (past the sweep threshold) is gone after startup',
    !existsSync(oldOrphan), `still present at ${oldOrphan}`);
  record('the removal was LOGGED, not silent',
    /Removed a stale atomic-write scratch file[^\n]*db\.json\.tmp-999999-1700000000000/.test(log),
    log.slice(0, 2000));

  record('the YOUNG file (under the age threshold) is left alone — the sweep is age-gated, not a blind prefix delete',
    existsSync(youngOrphan), `expected ${youngOrphan} to still exist`);

  // db.json itself must be completely unaffected by the sweep.
  const health = await fetch(`${BASE}/api/health`);
  record('the server is healthy and serving normally after the sweep', health.ok, `status=${health.status}`);
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

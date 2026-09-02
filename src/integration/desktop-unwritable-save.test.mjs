/* INTEGRATION — a desktop install whose ELECTRON_USER_DATA_PATH is not
 * writable must not tell the user a game saved when it did not.
 *
 * THE DEFECT (RED-DESKTOP-4, round4/findings/RED-DESKTOP-4/002-unwritable-
 * userdata-fake-save-success.md, reproduced independently before this fix):
 * `acquireDesktopLock` fails OPEN on anything but EEXIST (a read-only
 * directory, a full disk, ...), so startup does not refuse; `saveDB` then
 * swallowed every write error (`console.error` only, `void` return) and every
 * route responded 200 unconditionally right after calling it. On an
 * unwritable data directory, POST /api/games returned HTTP 200
 * "Game saved successfully!", db.json was NEVER created, and restarting the
 * same process against the same directory made the "saved" game gone —
 * permanently, with nothing in the request/response cycle ever having said
 * otherwise. Same shape for PATCH (update) and DELETE.
 *
 * THE FIX: `saveDB` now returns whether the write is KNOWN to have happened
 * (honest for the synchronous desktop/file branch; the async GCS branch is
 * unchanged fire-and-forget, noted but not covered here — see saveDB's own
 * comment). The three game routes use a new `saveDBOrFail` helper that turns
 * a real write failure into a 500 instead of a false 200.
 *
 * WHY chmod, NOT a nonexistent path: an unwritable EXISTING directory is what
 * a real disk-full/permissions failure looks like, and it is what lets
 * acquireDesktopLock's own directory-creation step succeed (so the lock file
 * write is what fails, exactly like the finding's own reproduction) while
 * still reaching the routes under test.
 *
 *   node src/integration/desktop-unwritable-save.test.mjs
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = process.env.UNWRITABLE_SAVE_PORT || '3117';
const BASE = `http://localhost:${PORT}`;
const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function call(method, url, body) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

const MP = { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 };

// A read-only user-data directory: acquireDesktopLock's mkdir succeeds (the
// dir already exists), so this reproduces the "lock/db writes specifically
// fail" case the finding is about, not a startup-time refusal.
const userData = mkdtempSync(path.join(tmpdir(), 'nash-unwritable-'));
chmodSync(userData, 0o555);

let server = null;
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      // Bounded: an UNBOUNDED fetch here could hang past this loop's own
      // retry budget if the health endpoint accepted the connection but
      // never completed the response (CodeRabbit, 2026-09-02 re-review —
      // same shape as the 798s-hang class this repo already guards
      // elsewhere, e.g. dmg-download.test.mjs's own bounded health fetch).
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet, or the health check itself timed out */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

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
let bootLog = '';
server.stdout.on('data', (d) => { bootLog += d; });
server.stderr.on('data', (d) => { bootLog += d; });

try {
  if (!(await waitReady())) {
    console.error(`FAIL server never became ready\n${bootLog}`);
    process.exit(2);
  }

  // ══ 1. the read-only directory is genuinely reached: the boot log shows
  //      the lock/db writes failing (fail-open startup, unchanged) rather
  //      than this fixture accidentally testing a writable directory.
  record('boot log shows the unwritable-directory write failures (fixture is real)',
    /EACCES|EPERM|readonly|read-only/i.test(bootLog), `bootLog=${bootLog.slice(0, 400)}`);

  // ══ 2. POST /api/games on the unwritable directory must NOT claim success
  const created = await call('POST', '/api/games', { name: 'Unwritable dir test', payoffs: MP });
  record('POST /api/games on an unwritable data directory responds 500, not 200',
    created.status === 500, `status=${created.status} body=${JSON.stringify(created.json)}`);
  record('the 500 response does not claim the game was saved',
    created.json?.success !== true
      && created.json?.error === 'Could not save your changes. Please try again.',
    `body=${JSON.stringify(created.json)}`);

  // CodeRabbit (2026-09-02): the 500 alone doesn't prove nothing was left
  // mutated in memory — a route that built a NEW games array only commits
  // it to inMemoryDb on a confirmed write, so a failed save must be
  // invisible to the very next GET, not just absent from ITS OWN response.
  const afterFailedPost = await call('GET', '/api/games');
  record('a GET right after the failed POST does not show the phantom game (no rollback needed — nothing was ever committed)',
    afterFailedPost.status === 200 && Array.isArray(afterFailedPost.json)
      && !afterFailedPost.json.some((g) => g.name === 'Unwritable dir test'),
    `status=${afterFailedPost.status} names=${JSON.stringify((afterFailedPost.json ?? []).map((g) => g.name))}`);

  // ══ 3. the SAME failure mode on update/delete of a game that already
  //      exists in memory (created before the directory went read-only, the
  //      realistic case: the app was fine, then the disk/permission problem
  //      started). Recreate the scenario with a fresh writable-then-broken
  //      directory so we get a real game id to PATCH/DELETE.
} finally {
  server?.kill('SIGKILL');
  await new Promise((res) => server?.once('exit', res) ?? res());
  chmodSync(userData, 0o755); // restore so rmSync can clean up
  rmSync(userData, { recursive: true, force: true });
}

// A second phase: create the game while writable, THEN make the directory
// read-only and confirm PATCH/DELETE also refuse honestly rather than
// claiming success on an update/delete that never reached disk.
const userData2 = mkdtempSync(path.join(tmpdir(), 'nash-unwritable2-'));
const PORT2 = process.env.UNWRITABLE_SAVE_PORT2 || '3118';
const BASE2 = `http://localhost:${PORT2}`;
async function call2(method, url, body) {
  const r = await fetch(`${BASE2}${url}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}
async function waitReady2() {
  for (let i = 0; i < 60; i++) {
    try {
      // Bounded — see waitReady's own comment above.
      const r = await fetch(`${BASE2}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet, or the health check itself timed out */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}
const server2 = spawn('node', [BUNDLE], {
  cwd: userData2,
  env: {
    PATH: process.env.PATH,
    HOME: userData2,
    NODE_ENV: 'production',
    PORT: PORT2,
    IS_ELECTRON: 'true',
    ELECTRON_USER_DATA_PATH: userData2,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  if (!(await waitReady2())) {
    console.error('FAIL server2 never became ready');
    process.exit(2);
  }
  const created2 = await call2('POST', '/api/games', { name: 'Will go read-only', payoffs: MP });
  const gid = created2.json?.game?.id || '';
  record('phase 2 setup: game created while the directory is still writable',
    created2.status === 200 && !!gid, `status=${created2.status} id=${gid}`);

  chmodSync(userData2, 0o555);
  const patched = await call2('PATCH', `/api/games/${gid}`, { name: 'Renamed after read-only' });
  record('PATCH /api/games/:id after the directory goes read-only responds 500, not 200',
    patched.status === 500, `status=${patched.status} body=${JSON.stringify(patched.json)}`);
  record('the PATCH 500 response does not claim the game was updated',
    patched.json?.success !== true
      && patched.json?.error === 'Could not save your changes. Please try again.',
    `body=${JSON.stringify(patched.json)}`);

  // CodeRabbit: the route builds a NEW games array and only commits it to
  // inMemoryDb on a confirmed write, so a failed PATCH must leave the
  // ORIGINAL name in place, visible to the very next GET — not silently
  // applied in memory while the write itself failed.
  const afterFailedPatch = await call2('GET', '/api/games');
  const stillOriginal = (afterFailedPatch.json ?? []).find((g) => g.id === gid);
  record('a GET right after the failed PATCH still shows the ORIGINAL name, not the rejected rename',
    afterFailedPatch.status === 200 && stillOriginal?.name === 'Will go read-only',
    `status=${afterFailedPatch.status} name=${JSON.stringify(stillOriginal?.name)}`);

  const deleted = await call2('DELETE', `/api/games/${gid}`);
  record('DELETE /api/games/:id after the directory goes read-only responds 500, not 200',
    deleted.status === 500, `status=${deleted.status} body=${JSON.stringify(deleted.json)}`);
  record('the DELETE 500 response does not claim the game was deleted',
    deleted.json?.success !== true
      && deleted.json?.error === 'Could not save your changes. Please try again.',
    `body=${JSON.stringify(deleted.json)}`);

  // Same principle: a failed DELETE must leave the game PRESENT, visible to
  // the very next GET — not silently removed from memory while the write
  // itself failed.
  const afterFailedDelete = await call2('GET', '/api/games');
  record('a GET right after the failed DELETE still shows the game (nothing was actually removed)',
    afterFailedDelete.status === 200
      && (afterFailedDelete.json ?? []).some((g) => g.id === gid),
    `status=${afterFailedDelete.status} ids=${JSON.stringify((afterFailedDelete.json ?? []).map((g) => g.id))}`);
} finally {
  server2.kill('SIGKILL');
  await new Promise((res) => server2.once('exit', res) ?? res());
  chmodSync(userData2, 0o755);
  rmSync(userData2, { recursive: true, force: true });
}

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ DESKTOP UNWRITABLE-SAVE: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length > 0) {
  console.error(`\n${fails.length} FAILURE(S):`);
  for (const f of fails) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

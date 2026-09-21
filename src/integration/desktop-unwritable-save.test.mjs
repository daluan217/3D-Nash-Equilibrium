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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = process.env.UNWRITABLE_SAVE_PORT || '3117';
const BASE = `http://localhost:${PORT}`;
const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');

/** Wait for a killed child to be reaped, but never hang: a process that had
 *  already exited emits nothing more, and `once('exit')` would then wait for
 *  an event that will never come (CodeRabbit CLI on this branch). */
function reaped(child, ms = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { clearTimeout(t); res(); };
    const t = setTimeout(done, ms);
    child.once('exit', done);
  });
}

// This harness makes a directory read-only and asserts the app refuses to lie
// about writing to it. chmod does not constrain root, so as root every refusal
// check would fail for a reason that has nothing to do with the product.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error('INCONCLUSIVE: running as root — chmod 0555 cannot block a write, so this harness proves nothing. Run it as a normal user.');
  process.exit(2);
}

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
  await reaped(server);
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
  await reaped(server2);
  chmodSync(userData2, 0o755);
  rmSync(userData2, { recursive: true, force: true });
}

// ── PHASE 3 (STRUCT-DESKTOP-19): the same failure on the one route that
// promises DESTRUCTION. `POST /api/auth/delete-confirm` wiped the account and
// its games from the shared in-memory database in place, called `saveDB`
// without reading its boolean, and answered 200 "Your account and all saved
// game profiles have been successfully deleted from our records" — on an
// unwritable data directory that sentence was false twice over: nothing left
// the disk, and the running process behaved as though the account were gone
// (its own GET /api/auth/me answered 401) until the next launch brought the
// account and every saved game back. Reproduced end to end before the fix by
// _gen/d19b3-deleteconfirm-false-destruction.mjs.
//
// Mutations that fail this phase: drop the `if (!saveDB(remaining))` check in
// delete-confirm (check 3 sees a 200 that claims destruction); move
// `inMemoryDb = db` back ABOVE the write in `saveDB` (checks 4 and 5 see the
// session and the games gone from a process that never wrote anything).
const userData3 = mkdtempSync(path.join(tmpdir(), 'nash-unwritable3-'));
const PORT3 = process.env.UNWRITABLE_SAVE_PORT3 || '3121';
const BASE3 = `http://localhost:${PORT3}`;
async function call3(method, url, body, token) {
  const r = await fetch(`${BASE3}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}
async function waitReady3() {
  for (let i = 0; i < 60; i++) {
    try {
      // Bounded — see waitReady's own comment above.
      const r = await fetch(`${BASE3}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet, or the health check itself timed out */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}
const server3 = spawn('node', [BUNDLE], {
  cwd: userData3,
  env: {
    PATH: process.env.PATH,
    HOME: userData3,
    NODE_ENV: 'production',
    PORT: PORT3,
    IS_ELECTRON: 'true',
    ELECTRON_USER_DATA_PATH: userData3,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  if (!(await waitReady3())) {
    console.error('FAIL server3 never became ready');
    process.exit(2);
  }
  // Setup, all of it while the directory is still writable: a real account,
  // a real saved game, and a real deletion code (the desktop build hands the
  // code back in the response because it has no SMTP to mail it with).
  const who = `del${Date.now().toString().slice(-6)}`;
  const email = `${who}@example.com`;
  const password = 'Passw0rd!23';
  const reg = await call3('POST', '/api/auth/register', { username: who, email, password });
  const login = await call3('POST', '/api/auth/login', { email, password });
  const token = login.json?.token;
  record('phase 3 setup: an account exists and is signed in while the directory is writable',
    reg.status === 200 && login.status === 200 && !!token, `register=${reg.status} login=${login.status}`);
  const mine = await call3('POST', '/api/games', { name: 'Keepsake', payoffs: MP }, token);
  record('phase 3 setup: that account has a saved game', mine.status === 200, `status=${mine.status}`);
  const askedToDelete = await call3('POST', '/api/auth/delete-request', undefined, token);
  const deleteCode = askedToDelete.json?.deleteCode;
  record('phase 3 setup: the desktop build returned a deletion code',
    askedToDelete.status === 200 && !!deleteCode, `status=${askedToDelete.status}`);

  chmodSync(userData3, 0o555);
  const confirmed = await call3('POST', '/api/auth/delete-confirm', { code: deleteCode }, token);
  record('delete-confirm on an unwritable data directory responds 500, not 200',
    confirmed.status === 500, `status=${confirmed.status} body=${JSON.stringify(confirmed.json)}`);
  record('the 500 does not claim the account was deleted, and says nothing was removed',
    confirmed.json?.success !== true
      && !/successfully deleted/i.test(String(confirmed.json?.message ?? ''))
      && /nothing was removed/i.test(String(confirmed.json?.error ?? '')),
    `body=${JSON.stringify(confirmed.json)}`);
  // The other half of the lie: the process must not act deleted either.
  const meAfter = await call3('GET', '/api/auth/me', undefined, token);
  record('the session still works right after the refused deletion (nothing was committed in memory)',
    meAfter.status === 200 && meAfter.json?.email === email, `status=${meAfter.status} body=${JSON.stringify(meAfter.json).slice(0, 120)}`);
  const gamesAfter = await call3('GET', '/api/games', undefined, token);
  record('the account\'s saved game is still listed after the refused deletion',
    gamesAfter.status === 200 && (gamesAfter.json ?? []).some((g) => g.name === 'Keepsake'),
    `status=${gamesAfter.status} names=${JSON.stringify((gamesAfter.json ?? []).map((g) => g.name))}`);

  // CONTROL: the route can still really delete. Without this, every check
  // above would also pass on a build where deletion never works at all.
  chmodSync(userData3, 0o755);
  const askedAgain = await call3('POST', '/api/auth/delete-request', undefined, token);
  const reallyGone = await call3('POST', '/api/auth/delete-confirm', { code: askedAgain.json?.deleteCode }, token);
  record('CONTROL: with the directory writable again the same request really deletes',
    reallyGone.status === 200 && reallyGone.json?.success === true, `status=${reallyGone.status}`);
  const meGone = await call3('GET', '/api/auth/me', undefined, token);
  record('CONTROL: the session is dead once the deletion actually happened', meGone.status === 401, `status=${meGone.status}`);
} finally {
  server3.kill('SIGKILL');
  await reaped(server3);
  chmodSync(userData3, 0o755);
  rmSync(userData3, { recursive: true, force: true });
}

// ── PHASE 4 (STRUCT-DESKTOP-19): the OTHER route whose message is a safety
// claim. `POST /api/auth/reset-password` assigned `user.passwordHash` on the
// shared record, bumped `tokenVersion` to kill live sessions, called `saveDB`
// without reading its boolean, and answered 200 "Password reset successfully!
// You can now log in with your new password." On an unwritable data directory
// that sentence was false in the way that matters most: the new hash lived
// only in that process, so the next launch refused the new password and
// accepted the OLD one — the password the user reset precisely because they
// wanted it dead — and the sessions the version bump had killed came back with
// it. Walked end to end before the fix by
// _gen/d19b4-resetpassword-false-success.mjs.
//
// This phase reads the SAME PROCESS rather than restarting it, which is the
// stronger statement: with the candidate committed only on a confirmed write,
// the running server must not accept the new password either, because nothing
// about the reset happened. Mutations that fail it: drop the
// `if (!saveDB({ users: db.users.map(...) }))` check (check 2 sees a 200 that
// claims the password changed); assign `user.passwordHash` in place again
// (checks 3 and 4 see the new password working in a process that wrote
// nothing).
const userData4 = mkdtempSync(path.join(tmpdir(), 'nash-unwritable4-'));
const PORT4 = process.env.UNWRITABLE_SAVE_PORT4 || '3122';
const BASE4 = `http://localhost:${PORT4}`;
async function call4(method, url, body) {
  const r = await fetch(`${BASE4}${url}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}
async function waitReady4() {
  for (let i = 0; i < 60; i++) {
    try {
      // Bounded — see waitReady's own comment above.
      const r = await fetch(`${BASE4}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet, or the health check itself timed out */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}
const server4 = spawn('node', [BUNDLE], {
  cwd: userData4,
  env: {
    PATH: process.env.PATH,
    HOME: userData4,
    NODE_ENV: 'production',
    PORT: PORT4,
    IS_ELECTRON: 'true',
    ELECTRON_USER_DATA_PATH: userData4,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  if (!(await waitReady4())) {
    console.error('FAIL server4 never became ready');
    process.exit(2);
  }
  const who4 = `rst${Date.now().toString().slice(-6)}`;
  const email4 = `${who4}@example.com`;
  const OLD_PASSWORD = 'OldPassw0rd!23';
  const NEW_PASSWORD = 'NewPassw0rd!45';
  const reg4 = await call4('POST', '/api/auth/register', { username: who4, email: email4, password: OLD_PASSWORD });
  const login4 = await call4('POST', '/api/auth/login', { email: email4, password: OLD_PASSWORD });
  record('phase 4 setup: an account exists and its password works while the directory is writable',
    reg4.status === 200 && login4.status === 200, `register=${reg4.status} login=${login4.status}`);
  const forgot4 = await call4('POST', '/api/auth/forgot-password', { email: email4 });
  const recoveryCode = forgot4.json?.recoveryCode;
  record('phase 4 setup: the desktop build returned a recovery code',
    forgot4.status === 200 && !!recoveryCode, `status=${forgot4.status}`);

  chmodSync(userData4, 0o555);
  const reset4 = await call4('POST', '/api/auth/reset-password', { email: email4, code: recoveryCode, newPassword: NEW_PASSWORD });
  record('reset-password on an unwritable data directory responds 500, not 200',
    reset4.status === 500, `status=${reset4.status} body=${JSON.stringify(reset4.json)}`);
  record('the 500 does not claim the password changed, and says the old one still works',
    reset4.json?.success !== true
      && !/reset successfully/i.test(String(reset4.json?.message ?? ''))
      && /OLD password still works/i.test(String(reset4.json?.error ?? '')),
    `body=${JSON.stringify(reset4.json)}`);
  const withNew = await call4('POST', '/api/auth/login', { email: email4, password: NEW_PASSWORD });
  record('the NEW password does not work in the process that failed to write it',
    withNew.status === 401, `status=${withNew.status}`);
  const withOld = await call4('POST', '/api/auth/login', { email: email4, password: OLD_PASSWORD });
  record('the OLD password still works, exactly as the refusal said',
    withOld.status === 200, `status=${withOld.status}`);

  // CONTROL: the route can still really reset a password. Without this, every
  // check above would also pass on a build where the reset never works at all.
  chmodSync(userData4, 0o755);
  const forgotAgain = await call4('POST', '/api/auth/forgot-password', { email: email4 });
  const reallyReset = await call4('POST', '/api/auth/reset-password',
    { email: email4, code: forgotAgain.json?.recoveryCode, newPassword: NEW_PASSWORD });
  record('CONTROL: with the directory writable again the same request really resets the password',
    reallyReset.status === 200 && reallyReset.json?.success === true, `status=${reallyReset.status}`);
  const newWorks = await call4('POST', '/api/auth/login', { email: email4, password: NEW_PASSWORD });
  const oldDead = await call4('POST', '/api/auth/login', { email: email4, password: OLD_PASSWORD });
  record('CONTROL: after the real reset the new password works and the old one is dead',
    newWorks.status === 200 && oldDead.status === 401, `new=${newWorks.status} old=${oldDead.status}`);
} finally {
  server4.kill('SIGKILL');
  await reaped(server4);
  chmodSync(userData4, 0o755);
  rmSync(userData4, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUE-LOOP-DESKTOP-22, invented angle J — the data directory pulled out from
// under a RUNNING app.
//
// The cases above all hold the directory in one state for the whole session.
// The data dir lives in ~/Library/Application Support: users clean it out,
// sync tools relocate it, and "reset the app" advice tells people to delete
// it. The app holds `inMemoryDb` for the whole process lifetime, so the
// question none of the cases above ask is whether a save AFTER the rug-pull
// still tells the truth.
//
// THE INVARIANT, one line: a save either lands on disk or reports failure.
// A 200 "Game saved successfully!" with nothing on disk is the defect —
// the same class as the RED-DESKTOP-4 finding at the top of this file, in a
// shape that file never reached.
//
// MEASURED (_gen/b22-angleJ-rugpull.mjs, 0.0.224): deleted -> the write path
// recreates the dir and the game really lands; replaced-by-a-file -> honest
// 500; deleted-then-recreated -> lands, with the owner row; unwritable then
// writable again -> honest 500, then recovers. No case claimed success with
// nothing on disk. This block is what keeps that true.
// ═══════════════════════════════════════════════════════════════════════════
{
  // 3123, not 3122: PORT4 already defaults to 3122 AND the workflow pins
  // UNWRITABLE_SAVE_PORT4 to it, so the original default collided in both the
  // local and the CI configuration (reviewer finding, verified: PORT4 line 384
  // and test.yml's env block both read 3122). Phase 4's server is killed before
  // this block, so the collision would have surfaced only as a flake.
  const PORT5 = process.env.UNWRITABLE_SAVE_PORT5 || '3123';
  const BASE5 = `http://localhost:${PORT5}`;
  // One extra level: the data directory sits inside a PRIVATE parent, so case
  // E below can take write permission off that parent without touching the
  // shared system temp dir (which would break every other process on the
  // machine, including suites running in parallel in CI).
  const rugpullRoot = mkdtempSync(path.join(tmpdir(), 'nash-rugpull-'));
  const userData5 = path.join(rugpullRoot, 'data');
  mkdirSync(userData5);
  const call5 = async (method, url, body) => {
    const r = await fetch(`${BASE5}${url}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, json };
  };
  const server5 = spawn('node', [BUNDLE], {
    cwd: userData5,
    env: {
      PATH: process.env.PATH, HOME: userData5, NODE_ENV: 'production',
      PORT: PORT5, IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: userData5,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log5 = '';
  server5.stdout.on('data', (d) => { log5 += d; });
  server5.stderr.on('data', (d) => { log5 += d; });
  try {
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      // Bounded, like every other health poll in this file: an UNBOUNDED fetch
      // hangs past this loop's own retry budget if the endpoint accepts the
      // connection but never completes the response (the 798s-hang class this
      // repo guards elsewhere). Reviewer finding; the other three phases
      // already used AbortSignal.timeout and this new one did not.
      try { ready = (await fetch(`${BASE5}/api/health`, { signal: AbortSignal.timeout(2000) })).ok; }
      catch { /* not up yet, or the health check itself timed out */ }
      if (!ready) await new Promise((r) => setTimeout(r, 250));
    }
    record('rug-pull: the server booted', ready, ready ? '' : log5.slice(-300));

    const dbOnDisk = () => {
      const f = path.join(userData5, 'db.json');
      if (!existsSync(f)) return null;
      try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return 'unparseable'; }
    };
    const has = (name) => { const d = dbOnDisk(); return !!d && d !== 'unparseable' && (d.games ?? []).some((g) => g.name === name); };
    // The judgement, in one place: a 200 with success:true MUST be on disk.
    const honest = (label, res, name) => {
      const claimed = res.status === 200 && res.json?.success === true;
      record(`rug-pull ${label}: the save claim matches the disk`, !claimed || has(name),
        `status=${res.status} claimedSaved=${claimed} onDisk=${has(name)}`);
      return claimed;
    };

    // CONTROL FIRST. Without it, every "no false success" below would also
    // pass on a build where saving never works at all.
    const control = await call5('POST', '/api/games', { name: 'J-control', description: 'rugpull', payoffs: MP });
    record('rug-pull CONTROL: an ordinary save succeeds and lands on disk',
      control.status === 200 && control.json?.success === true && has('J-control'),
      `status=${control.status} onDisk=${has('J-control')}`);

    // A. Directory deleted outright underneath the running process.
    rmSync(userData5, { recursive: true, force: true });
    const afterDelete = await call5('POST', '/api/games', { name: 'J-after-delete', description: 'rugpull', payoffs: MP });
    honest('after the directory was deleted', afterDelete, 'J-after-delete');
    // Honesty is the floor, not the whole bar. A build that answers 500
    // forever after the user cleans out Application Support is honest and
    // still broken: every later save fails for the rest of the session with
    // no way back short of a restart. The write path recreates a missing data
    // directory (`if (!fs.existsSync(dbDir)) mkdirSync`), and that recovery is
    // what this asserts — the honesty checks above pass with or without it,
    // so without this line the mkdir could be deleted silently.
    record('rug-pull: the app RECREATES a deleted data directory and the save really lands',
      afterDelete.status === 200 && has('J-after-delete'),
      `status=${afterDelete.status} onDisk=${has('J-after-delete')}`);

    // B. Directory replaced by a regular FILE of the same name (the shape a
    // sync tool or a careless script produces). Nothing can be written there,
    // so the only honest answer is a failure.
    rmSync(userData5, { recursive: true, force: true });
    writeFileSync(userData5, 'not a directory');
    const afterSwap = await call5('POST', '/api/games', { name: 'J-after-swap', description: 'rugpull', payoffs: MP });
    honest('after the directory became a file', afterSwap, 'J-after-swap');
    record('rug-pull: a save into a dir-turned-file FAILS rather than claiming success',
      afterSwap.status >= 500 && afterSwap.json?.success !== true, `status=${afterSwap.status}`);

    // C. Deleted and recreated empty — the "reset the app" shape. The write
    // can succeed again here, so the bar is that whatever lands is coherent:
    // a game on disk must have its owner row on disk.
    rmSync(userData5, { force: true });
    mkdirSync(userData5, { recursive: true });
    const afterRecreate = await call5('POST', '/api/games', { name: 'J-after-recreate', description: 'rugpull', payoffs: MP });
    honest('after the directory was recreated', afterRecreate, 'J-after-recreate');
    if (has('J-after-recreate')) {
      const d = dbOnDisk();
      record('rug-pull: a game written after a recreate still has its owner row',
        (d?.users ?? []).some((u) => u.id === 'local-owner'),
        `users=${JSON.stringify((d?.users ?? []).map((u) => u.id))}`);
    }

    // D. Unwritable mid-session, then writable again: honest failure, then
    // real recovery. The recovery half is the control for the failure half.
    chmodSync(userData5, 0o555);
    const whileLocked = await call5('POST', '/api/games', { name: 'J-locked', description: 'rugpull', payoffs: MP });
    honest('while the directory is read-only', whileLocked, 'J-locked');
    record('rug-pull: a save into a read-only dir FAILS rather than claiming success',
      whileLocked.status >= 500 && whileLocked.json?.success !== true, `status=${whileLocked.status}`);
    chmodSync(userData5, 0o755);
    const recovered = await call5('POST', '/api/games', { name: 'J-recovered', description: 'rugpull', payoffs: MP });
    record('rug-pull CONTROL: the app recovers once the directory is writable again',
      recovered.status === 200 && has('J-recovered'),
      `status=${recovered.status} onDisk=${has('J-recovered')}`);

    // E. THE DIRECTORY CANNOT BE RECREATED (BLUE-LOOP-DESKTOP-22, sweep 21).
    //
    // Case A above passes because saveDB recreates a missing data directory.
    // "It recreates it" is only an answer while mkdir can SUCCEED. Delete the
    // directory AND take write permission off its PARENT and mkdirSync fails
    // EACCES — the one branch where the recovery that makes A honest is not
    // available. Nothing in this suite reached it: every other unwritable case
    // leaves the directory itself in place. Measured on the real bundle
    // (_gen probe, sweep 21): the save answers
    // {"error":"Could not save your changes. Please try again."} and the log
    // names the cause. The failure mode being guarded is the opposite — a 200
    // "Game saved successfully!" for a write that cannot physically happen.
    //
    // `rugpullRoot` is this block's own private parent (see its creation
    // above), never the shared system temp dir.
    let parentLocked = false;
    try {
      rmSync(userData5, { recursive: true, force: true });
      chmodSync(rugpullRoot, 0o555);
      parentLocked = true;
    } catch { /* fall through to the setup check below */ }
    // Never bank a silent skip: if the OS would not let this fixture exist,
    // say so instead of recording a pass for a case that never ran.
    record('rug-pull setup: the data directory is gone and its parent is unwritable',
      parentLocked && !existsSync(userData5), `parentLocked=${parentLocked} dirExists=${existsSync(userData5)}`);
    if (parentLocked) {
      try {
        // Proof the fixture really is unrecreatable — otherwise the refusal
        // below could be coming from something else entirely.
        let mkdirBlocked = false;
        try { mkdirSync(userData5); } catch { mkdirBlocked = true; }
        record('rug-pull setup: mkdir into the locked parent really fails',
          mkdirBlocked && !existsSync(userData5), `mkdirBlocked=${mkdirBlocked}`);

        const unrecreatable = await call5('POST', '/api/games', { name: 'J-unrecreatable', description: 'rugpull', payoffs: MP });
        record('rug-pull: a save that CANNOT recreate its directory fails instead of claiming success',
          unrecreatable.status >= 500 && unrecreatable.json?.success !== true,
          `status=${unrecreatable.status} body=${JSON.stringify(unrecreatable.json)}`);
        record('rug-pull: that refusal tells the user the change was not saved',
          typeof unrecreatable.json?.error === 'string' && /could not save|try again/i.test(unrecreatable.json.error),
          JSON.stringify(unrecreatable.json));

        // And the failed write must not have emptied the library the app is
        // still serving: the user's existing games stay readable through an
        // outage they did not cause.
        const stillServed = await call5('GET', '/api/games');
        record('rug-pull: the games already in memory are still served after the refused write',
          Array.isArray(stillServed.json) && stillServed.json.some((g) => g.name === 'J-recovered'),
          `status=${stillServed.status} names=${JSON.stringify(Array.isArray(stillServed.json) ? stillServed.json.map((g) => g.name) : stillServed.json)}`);
      } finally {
        chmodSync(rugpullRoot, 0o755);
      }
      // CONTROL: with the parent writable again the very same request works,
      // so the refusal above was about the locked parent and nothing else.
      const afterUnlock = await call5('POST', '/api/games', { name: 'J-after-unlock', description: 'rugpull', payoffs: MP });
      record('rug-pull CONTROL: the same save succeeds once the parent is writable again',
        afterUnlock.status === 200 && has('J-after-unlock'),
        `status=${afterUnlock.status} onDisk=${has('J-after-unlock')}`);
    }

    // F. CONCURRENCY (BLUE-LOOP-DESKTOP-22, sweep 24). Everything above is
    // sequential. desktop-concurrent-lock covers two PROCESSES fighting over
    // the lock file; nothing covered many in-flight requests inside ONE
    // process, which is the ordinary desktop case — a user mashing Save, an
    // autosave firing during a rename, the renderer retrying a slow response.
    // The write path is a read-modify-write of one shared inMemoryDb.games
    // array, so the shapes that matter are a LOST UPDATE and a POISONED
    // QUEUE: one write fails while others are queued behind it.
    const names = Array.from({ length: 24 }, (_, i) => `J-conc-${i}`);
    const burst = await Promise.all(names.map((n) =>
      call5('POST', '/api/games', { name: n, description: 'rugpull', payoffs: MP })));
    const claimed = burst.filter((r) => r.status === 200 && r.json?.success === true).length;
    const landed = names.filter(has).length;
    record('concurrency: every concurrent save that CLAIMED success is on disk',
      claimed === landed, `claimed=${claimed} onDisk=${landed} — a shortfall is silently lost work`);
    record('concurrency CONTROL: the burst really did save (not all refused)',
      claimed === names.length, `${claimed}/${names.length} claimed success`);
    const dAll = dbOnDisk();
    const ids = (dAll && dAll !== 'unparseable' ? dAll.games : []).map((g) => g.id);
    record('concurrency: no duplicate game ids were produced',
      new Set(ids).size === ids.length, `${ids.length} games, ${new Set(ids).size} unique ids`);

    // POISONED QUEUE: fire a burst, pull writability out from under it
    // mid-flight, give it back. Nothing may claim a success it did not get.
    // MUTATION-PROVEN: making saveDB swallow its error and return true leaves
    // 8 of 12 claimed-but-absent and fails this check by name.
    //
    // THE WINDOW IS RETRIED UNTIL IT BITES, not timed and hoped for. A fixed
    // "fire 12, sleep 40ms, chmod" is a race by construction, and CI ran it on
    // a faster disk than this laptop: all 12 saves completed before the chmod
    // landed, the poison window never opened, and the control below caught it
    // (0/12 refused) exactly as designed — a red CI check for a vacuous
    // fixture, which is the control doing its job rather than a product
    // defect. Escalating attempts make the window real instead of likely: more
    // in-flight saves take longer to drain, and a shorter delay chmods earlier.
    // The no-phantom property is asserted over EVERY attempt, so a save that
    // lies about success in an attempt that did not bite still fails the suite.
    const poisonAttempt = async (count, delayMs) => {
      const names = Array.from({ length: count }, (_, i) => `J-poison-${delayMs}-${i}`);
      const burst = names.map((n) =>
        call5('POST', '/api/games', { name: n, description: 'rugpull', payoffs: MP }));
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      chmodSync(userData5, 0o555);
      const res = await Promise.all(burst);
      chmodSync(userData5, 0o755);
      return { names, res };
    };
    const phantom = [];
    let poisonResults = [];
    let poisonTried = 0;
    for (const [count, delayMs] of [[12, 40], [48, 5], [200, 0]]) {
      const { names, res } = await poisonAttempt(count, delayMs);
      poisonTried++;
      poisonResults = res;
      phantom.push(...names.filter((n, i) =>
        res[i].status === 200 && res[i].json?.success === true && !has(n)));
      if (res.filter((r) => r.status >= 500).length > 0) break;
    }
    record('concurrency: no queued save claimed success while the directory was unwritable',
      phantom.length === 0, `phantom saves: ${JSON.stringify(phantom)}`);
    // THE CONTROL THAT MAKES THE CHECK ABOVE MEAN SOMETHING (reviewer finding,
    // 2026-09-20). Without it, a run where every save finished before the
    // chmod landed legitimately succeeds, `phantom` is empty, and the check
    // passes with the unwritable window never having been open. It fired for
    // real on CI at 12-saves/40ms, which is why the attempts above escalate
    // instead of being timed once. If this ever fires again, widen the
    // escalation — never weaken the assertion above.
    const refused = poisonResults.filter((r) => r.status >= 500).length;
    record('concurrency CONTROL: the poison window really bit (some save was refused)',
      refused > 0,
      `${refused}/${poisonResults.length} refused after ${poisonTried} attempt(s) — 0 means every `
      + 'save completed before the chmod landed, so the phantom check above proved nothing this run');
    const postPoison = await call5('POST', '/api/games', { name: 'J-post-poison', description: 'rugpull', payoffs: MP });
    record('concurrency CONTROL: the app recovers after the mid-burst outage',
      postPoison.status === 200 && has('J-post-poison'), `status=${postPoison.status}`);
  } finally {
    server5.kill('SIGKILL');
    await reaped(server5);
    // Unlock the private parent FIRST: case E leaves it 0555 if it threw, and
    // an rm inside a read-only parent cannot remove anything.
    try { chmodSync(rugpullRoot, 0o755); } catch { /* already gone */ }
    try { chmodSync(userData5, 0o755); } catch { /* may be a file or gone */ }
    rmSync(rugpullRoot, { recursive: true, force: true });
  }
}

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ DESKTOP UNWRITABLE-SAVE: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length > 0) {
  console.error(`\n${fails.length} FAILURE(S):`);
  for (const f of fails) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

/* INTEGRATION — a db.json whose "users"/"games" fields are PRESENT but the
 * WRONG TYPE must refuse to boot loudly, over the real production artifact,
 * rather than silently guessing an empty database.
 *
 * THE DEFECT THIS GUARDS (RED-DESKTOP-6/001, round6/findings/RED-DESKTOP-6/
 * 001-malformed-db-json-bricks-account-and-save-system.md — director-
 * reproduced 2026-09-02 against dist/server.cjs @5fcbb19: `{"games":[]}`
 * crashed the process on the first request that touched `db.users`
 * (TypeError at ensureLocalOwner), and `{"users":[],"games":null}` bricked
 * every future GET /api/games with a silent `[]`). `loadDBFromFile` used to
 * do ZERO validation of the parsed object's shape beyond "is it valid JSON"
 * — a db.json from an old schema, or hand-edited, loaded straight into
 * `inMemoryDb` and only failed the first time a route actually touched the
 * missing/wrong-typed field, at which point the failure mode depended on
 * which route ran first: an unhandled throw (crash) for some shapes, a
 * quietly-wrong read (data made invisible) for others.
 *
 * THE FIX (server.ts's `normalizeDbShape`, `loadDBFromFile`): a MISSING or
 * `null` "users"/"games" is a known old/partial-write shape, normalised to
 * `[]` with a logged warning (covered by the RECOVERABLE-SHAPE control
 * below, and by desktop-persistence.test.mjs's own pre-existing coverage of
 * the happy path). A field that is PRESENT but the WRONG TYPE — not a
 * recognised old shape, nothing safe to guess the intent of — is NOT
 * defaulted to empty. It throws inside `normalizeDbShape`, and the caller
 * treats that exactly like an unparseable file: the bad file is preserved
 * aside (never deleted, never silently overwritten by the next save) and
 * the process refuses to start via `reportDesktopLockFailure` — the SAME
 * dialog/exit machinery `acquireDesktopLock` already uses (#88/#93), so a
 * packaged install shows a real dialog instead of vanishing, and a
 * standalone `node dist/server.cjs` fails loudly on its own terminal.
 *
 * THIS FILE WAS A GAP left by the fix's own author (BLUE-SERVER-DESKTOP-6's
 * STATE.md, "known open items"): the refusal path was verified by hand that
 * session but shipped with no automated coverage. Closing it here.
 *
 * SECTION 6 (below) GUARDS A SECOND DEFECT, found by CodeRabbit on THIS
 * file's own PR (2026-09-03): `loadDBFromFile` is not desktop-only — `initDB`
 * also calls it on the HOSTED path (no ELECTRON_USER_DATA_PATH configured at
 * all, or as the fallback when a GCS load throws), where `isDesktop()` is
 * false and the hard refusal above used to fire there too via a bare
 * `process.exit(1)` — crashing a Cloud Run instance over what is, on that
 * path, ephemeral scratch state a transient GCS failure fell back to, with a
 * refusal message written for a desktop user ("quit, inspect/repair or
 * delete it, then relaunch"). Fixed by gating the hard refusal to
 * `isDesktop()`; the hosted path now gets the SAME treatment as an
 * unparseable file (preserve the bytes aside, log loudly, start with a fresh
 * empty DB) instead of exiting.
 *
 * SECTION 7 GUARDS A THIRD DEFECT (CodeRabbit, PR #96 GitHub review,
 * 2026-09-03, Major — real data loss, reproduced): `loadDBFromFile`'s
 * `fs.readFileSync(DB_FILE, ...)` catch, for an EXISTING file the earlier
 * `fs.existsSync` check just confirmed is really there, used to log and
 * return an empty `{users:[],games:[]}` unconditionally — the same
 * dangerous shape the JSON-parse and shape-mismatch branches next to it
 * already guard against: the very next `saveDB` overwrites the file
 * WHOLESALE with that empty object, permanently erasing real, never-
 * actually-corrupted data (a permissions problem, a busy volume, `EISDIR`,
 * ... — not "no database yet"). Reproduced directly against the shipping
 * bundle: `chmod 000` on an existing db.json holding a real user and a real
 * saved game — the server boots, `/api/health` is 200, and the very next
 * write (a plain registration) replaces the whole file with just the new
 * user; the original data is gone. Fixed with the SAME desktop/hosted split
 * as section 6's shape-mismatch fix (`fs.renameSync` preserves the original
 * bytes aside — it needs only directory write permission, not permission on
 * the file's own bits, so it still succeeds when the read itself failed on
 * EACCES); a genuine ENOENT at this point (a TOCTOU race — the file vanished
 * between the `existsSync` check and the read) is treated as the safe
 * "nothing to lose" case, same as a first launch.
 *
 *   node src/integration/db-shape-refusal.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForOwnServer } from './ownserver.mjs';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
const RUNNER = path.join(serverDir, 'src/desktop/db-shape-hook-runner.cjs');
let port = Number(process.env.DB_SHAPE_TEST_PORT || 3155);

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

// Deliberately NOT IS_ELECTRON/ELECTRON_USER_DATA_PATH/GCS_BUCKET_NAME — the
// hosted-service shape (initDB's no-GCS-configured branch), where
// `loadDBFromFile`'s DB_FILE falls back to `process.cwd()/db.json`. `env` is
// passed as a whole replacement object (never inherits the real process.env),
// so this can never accidentally pick up real GCS credentials from the
// machine running the test.
function spawnHostedServer(userData, thePort, extraEnv = {}) {
  return spawn('node', [BUNDLE], {
    cwd: userData,
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT: String(thePort),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady(child, thePort) {
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  try {
    await waitForOwnServer(child, `http://127.0.0.1:${thePort}`, { timeoutMs: 10000 });
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${err.message}\n${log}`);
  }
  return { log: () => log };
}

/** Wait for a child expected to EXIT rather than become ready. */
async function waitExit(child, timeoutMs = 8000) {
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let timer;
  try {
    // CodeRabbit, 2026-09-03: `exit` fires as soon as the process has
    // terminated, which can be BEFORE its stdio pipes finish flushing and
    // closing — the caller reads `log` for its refusal-message assertions
    // right after this resolves, so a genuinely fast exit could race a
    // still-draining stderr write and read a truncated string. `close`
    // fires only once the process has ended AND both piped streams have
    // closed (Node's own documented ordering: `close` always follows
    // `exit`), so by the time this resolves every byte the child ever wrote
    // is already in `log`. `close`'s first argument is the same exit code
    // `exit` carries.
    const code = await Promise.race([
      new Promise((res) => child.once('close', (c) => res(c))),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out waiting for close')), timeoutMs); }),
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

// ═════════════════════════════════════════════════════════════════════════
// 1. STANDALONE (no packaged-app hook): wrong-type "users" refuses loudly.
// ═════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-users-'));
  const original = JSON.stringify({ users: 'not-an-array', games: [] });
  writeFileSync(path.join(userData, 'db.json'), original);

  const child = spawnServer(userData, port);
  const { code, log } = await waitExit(child);

  record('wrong-type "users": the process refuses to start (exits non-zero)',
    code !== 0, `exit code ${code}`);
  record('the refusal is loud and names db.json',
    /Refusing to start/.test(log) && /db\.json/.test(log),
    log.slice(0, 400));
  record('the refusal message names the actual reason (not an array)',
    /"users" is present but is a string, not an array/.test(log),
    log.slice(0, 400));

  let bootedAnyway = false;
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    bootedAnyway = probe.ok;
  } catch { /* good: nothing listening */ }
  record('the refused process never bound the port (never served /api/health)', !bootedAnyway);

  const entries = readdirSync(userData);
  const corrupt = entries.find((f) => f.startsWith('db.json.corrupt-'));
  record('the unreadable file is PRESERVED aside (not deleted), a db.json.corrupt-* sibling exists',
    !!corrupt, `entries=${JSON.stringify(entries)}`);
  record('the preserved file has the ORIGINAL bytes, untouched',
    !!corrupt && readFileSync(path.join(userData, corrupt), 'utf-8') === original,
    corrupt ? readFileSync(path.join(userData, corrupt), 'utf-8') : '(no file)');
  record('no fresh empty db.json was written in its place (nothing to accidentally boot from later)',
    !existsSync(path.join(userData, 'db.json')));

  rmSync(userData, { recursive: true, force: true });
  port += 1;
}

// ═════════════════════════════════════════════════════════════════════════
// 2. STANDALONE: wrong-type "games" (the OTHER normalizeCollection call
//    site — RED-DESKTOP-6/001's own second fixture used a wrong "games"
//    shape, `{"games":[]}` was actually the RECOVERABLE case; this is the
//    unrecoverable sibling, an object instead of an array or null).
// ═════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-games-'));
  const original = JSON.stringify({ users: [], games: { notAnArray: true } });
  writeFileSync(path.join(userData, 'db.json'), original);

  const child = spawnServer(userData, port);
  const { code, log } = await waitExit(child);

  record('wrong-type "games" (an object): the process refuses to start (exits non-zero)',
    code !== 0, `exit code ${code}`);
  record('the refusal names "games", not "users" (the right field is diagnosed)',
    /"games" is present but is a object, not an array/.test(log)
      || /"games" is present but is an object, not an array/.test(log),
    log.slice(0, 400));

  const entries = readdirSync(userData);
  record('the unreadable file is preserved aside here too',
    entries.some((f) => f.startsWith('db.json.corrupt-')), `entries=${JSON.stringify(entries)}`);

  rmSync(userData, { recursive: true, force: true });
  port += 1;
}

// ═════════════════════════════════════════════════════════════════════════
// 3. CONTROL — a RECOVERABLE old shape (missing "users" key entirely, the
//    fixture RED-DESKTOP-6/001 itself used, `{"games":[]}`) must NOT refuse:
//    the server boots, serves, and the games are visible. This is the
//    mutation-sensitivity control — a check that fires on EVERY shape
//    (recoverable or not) would "pass" this suite for the wrong reason.
// ═════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-control-'));
  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({ games: [] }));

  const child = spawnServer(userData, port);
  try {
    await waitReady(child, port);
    record('CONTROL: a recoverable shape (missing "users") boots and serves, no refusal',
      true);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    record('CONTROL: /api/health responds 200 on the recoverable shape', health.ok, `status ${health.status}`);
  } catch (err) {
    record('CONTROL: a recoverable shape (missing "users") boots and serves, no refusal',
      false, String(err));
  } finally {
    await stop(child);
    rmSync(userData, { recursive: true, force: true });
  }
  port += 1;
}

// ═════════════════════════════════════════════════════════════════════════
// 4. PACKAGED APP (in-process require, the electron-main.cjs shape): WITH
//    the #88/#93 dialog hook registered, the process must SURVIVE (not
//    process.exit the whole Electron main process), the hook must fire
//    naming db.json, and the server must never have bound a port.
// ═════════════════════════════════════════════════════════════════════════
function runHook(userData, withHook, fireUnrelated = false) {
  const r = spawnSync('node', [RUNNER, BUNDLE, userData, withHook ? '1' : '0', fireUnrelated ? '1' : '0'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return r;
}

{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-hook-'));
  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({ users: 42, games: [] }));

  const r = runHook(userData, true);
  const m = (r.stdout || '').match(/RUNNER_RESULT (\{.*\})/);
  const parsed = m ? JSON.parse(m[1]) : null;

  record('WITH the packaged-app hook: the process survives (exit 0, not killed in-process)',
    r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`);
  record('WITH the hook: it is actually invoked for a db-shape refusal (same mechanism as the lock hook)',
    !!parsed?.hookCalled, `stdout=${(r.stdout || '').slice(0, 300)}`);
  record('WITH the hook: the payload message names "Refusing to start" and db.json',
    typeof parsed?.hookPayload?.message === 'string'
      && parsed.hookPayload.message.includes('Refusing to start')
      && parsed.hookPayload.message.includes('db.json'),
    `message=${JSON.stringify(parsed?.hookPayload?.message)}`);
  record('WITH the hook: the server never went on to bind a port',
    parsed?.listenCallCount === 0, `listenCallCount=${parsed?.listenCallCount}`);

  rmSync(userData, { recursive: true, force: true });
}

// ── 4b. THE DIALOG WINDOW MUST NOT BE KILLABLE BY AN UNRELATED ERROR ───────
// CodeRabbit, 2026-09-03: between the hook firing (above) and the async
// native dialog actually being shown/dismissed, `startServer` has already
// returned WITHOUT ever setting `serverListening`. Before this fix, ANY
// totally unrelated unhandledRejection/uncaughtException landing in that
// window hit `handleFatalAsync`'s `!serverListening` branch and called
// `process.exit(1)` — since server.ts runs IN-PROCESS inside
// electron-main.cjs, that silently kills the WHOLE Electron main process,
// dialog included, reintroducing the exact "vanish with no dialog" class
// #88/#93 exists to prevent, through a different door.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-unrelated-'));
  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({ users: 42, games: [] }));

  const r = runHook(userData, true, true);
  const m = (r.stdout || '').match(/RUNNER_RESULT (\{.*\})/);
  const parsed = m ? JSON.parse(m[1]) : null;

  record('an UNRELATED unhandled rejection during the post-refusal dialog window does not kill the process',
    r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(0, 300)}`);
  record('the refusal was still reported to the hook before the unrelated error fired',
    !!parsed?.hookCalled, `stdout=${(r.stdout || '').slice(0, 300)}`);

  rmSync(userData, { recursive: true, force: true });
}

// ═════════════════════════════════════════════════════════════════════════
// 5. PACKAGED APP, WITHOUT the hook (a standalone `node dist/server.cjs`
//    required in-process by this runner, mirroring the lock-dialog-hook
//    suite's own regression guard): unchanged, loud, immediate
//    `process.exit(1)`. Confirms the hook path is gated behind the hook's
//    PRESENCE, not a blanket "db-shape refusals never exit."
// ═════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-nohook-'));
  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({ users: 42, games: [] }));

  const r = runHook(userData, false);
  record('WITHOUT the hook: the original loud process.exit(1) still fires',
    r.status === 1, `status=${r.status}`);
  record('WITHOUT the hook: no RUNNER_RESULT is printed (the process never reached that line)',
    !(r.stdout || '').includes('RUNNER_RESULT'), `stdout=${(r.stdout || '').slice(0, 200)}`);

  rmSync(userData, { recursive: true, force: true });
}

// ═════════════════════════════════════════════════════════════════════════
// 6. THE HOSTED PATH (CodeRabbit, 2026-09-03): the SAME wrong-type db.json
//    that must hard-refuse on desktop must NOT crash a hosted instance. No
//    IS_ELECTRON/ELECTRON_USER_DATA_PATH/GCS_BUCKET_NAME — `DB_FILE` falls
//    back to `process.cwd()/db.json`, exactly `initDB`'s no-GCS-configured
//    branch (and the shape a GCS-load-throws fallback lands on too).
// ═════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-hosted-'));
  const original = JSON.stringify({ users: 'not-an-array', games: [] });
  writeFileSync(path.join(userData, 'db.json'), original);

  const child = spawnHostedServer(userData, port);
  try {
    const { log } = await waitReady(child, port);
    record('HOSTED: a wrong-type db.json does NOT crash the process (boots and serves)', true);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    record('HOSTED: /api/health responds 200 despite the malformed file', health.ok, `status ${health.status}`);
    record('HOSTED: the malformed file is still logged loudly, naming db.json',
      /db\.json/.test(log()) && /"users" is present but is a string, not an array/.test(log()),
      log().slice(0, 400));
    record('HOSTED: the log does NOT use desktop-specific "quit...relaunch" wording',
      !/quit, inspect\/repair or delete it, then relaunch/.test(log()), log().slice(0, 300));
  } catch (err) {
    record('HOSTED: a wrong-type db.json does NOT crash the process (boots and serves)', false, String(err));
  }

  const entries = readdirSync(userData);
  record('HOSTED: the unreadable file is preserved aside, same as the desktop case',
    entries.some((f) => f.startsWith('db.json.corrupt-')), `entries=${JSON.stringify(entries)}`);

  await stop(child);
  rmSync(userData, { recursive: true, force: true });
  port += 1;
}

// ═════════════════════════════════════════════════════════════════════════
// 7. AN UNREADABLE *EXISTING* FILE — not malformed JSON, not the wrong
//    shape, a genuine READ failure (chmod 000). Real data, briefly
//    unreadable, must never be silently replaced with an empty database.
//    WHY chmod, not a nonexistent path: an existing-but-unreadable file is
//    what a real permissions/disk problem looks like, and `fs.existsSync`
//    must see it as PRESENT for this to exercise the right branch (the
//    `readFileSync` catch, not the "no file yet" branch above it). This
//    reproduces false under root (root ignores file permission bits, same
//    caveat desktop-unwritable-save.test.mjs's own chmod fixtures carry —
//    GitHub Actions' ubuntu-latest runners are non-root by default).
// ═════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-unreadable-'));
  const original = JSON.stringify({
    users: [{ id: 'u1', username: 'real-user', email: 'real@x.com', passwordHash: '', isVerified: true, verificationCode: '', verificationCodeExpires: 0, tokenVersion: 0 }],
    games: [{ id: 'g1', userId: 'u1', name: 'Precious Real Game', payoffs: { a11: 1, a12: 2, a21: 3, a22: 4, b11: 4, b12: 3, b21: 2, b22: 1 } }],
  });
  writeFileSync(path.join(userData, 'db.json'), original);
  chmodSync(path.join(userData, 'db.json'), 0o000);

  const child = spawnServer(userData, port);
  const { code, log } = await waitExit(child);

  record('DESKTOP, unreadable existing file: the process refuses to start (exits non-zero)',
    code !== 0, `exit code ${code}`);
  record('DESKTOP: the refusal names db.json and says it EXISTS but could not be read (not "no database yet")',
    /Refusing to start/.test(log) && /exists but could not be read/.test(log) && /db\.json/.test(log),
    log.slice(0, 400));

  let bootedAnyway = false;
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    bootedAnyway = probe.ok;
  } catch { /* good: nothing listening */ }
  record('DESKTOP: the refused process never bound the port', !bootedAnyway);

  const entries = readdirSync(userData);
  const aside = entries.find((f) => f.startsWith('db.json.unreadable-'));
  record('DESKTOP: the file is preserved aside under its OWN name (not "corrupt" — it was never actually bad)',
    !!aside, `entries=${JSON.stringify(entries)}`);
  if (aside) chmodSync(path.join(userData, aside), 0o644);
  record('DESKTOP: the preserved file has the ORIGINAL, unmodified bytes — the real user and game are NOT lost',
    aside ? readFileSync(path.join(userData, aside), 'utf-8') === original : false,
    aside ? readFileSync(path.join(userData, aside), 'utf-8') : '(no file)');

  port += 1;
  rmSync(userData, { recursive: true, force: true });
}

// Same fixture, no IS_ELECTRON: the hosted-service shape this whole session's
// "scope the hard refusal to desktop" fix (section 6) exists for — a hosted
// instance must degrade, not exit(1), on a startup DB problem. No write probe
// here: an unauthenticated /api/auth/register on a hosted (non-IS_ELECTRON)
// server needs real SMTP configuration this test environment does not (and
// must not) have — the structural guarantee that matters (`saveDB` always
// targets the fixed `DB_FILE` path, never the aside-renamed one) is already
// proven by the preserved-aside file's bytes staying untouched below.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-unreadable-hosted-'));
  const original = JSON.stringify({
    users: [{ id: 'u1', username: 'real-user', email: 'real@x.com', passwordHash: '', isVerified: true, verificationCode: '', verificationCodeExpires: 0, tokenVersion: 0 }],
    games: [{ id: 'g1', userId: 'u1', name: 'Precious Real Game', payoffs: { a11: 1, a12: 2, a21: 3, a22: 4, b11: 4, b12: 3, b21: 2, b22: 1 } }],
  });
  writeFileSync(path.join(userData, 'db.json'), original);
  chmodSync(path.join(userData, 'db.json'), 0o000);

  const child = spawnHostedServer(userData, port);
  try {
    const { log } = await waitReady(child, port);
    record('HOSTED, unreadable existing file: does NOT crash the process (boots and serves)', true);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    record('HOSTED: /api/health responds 200', health.ok, `status ${health.status}`);
    record('HOSTED: the log says the file EXISTS but could not be read, and resets rather than exits',
      /exists but could not be read/.test(log()) && /Resetting to a fresh database/.test(log()),
      log().slice(0, 400));
  } catch (err) {
    record('HOSTED, unreadable existing file: does NOT crash the process (boots and serves)', false, String(err));
  }
  await stop(child);

  const entries = readdirSync(userData);
  const aside = entries.find((f) => f.startsWith('db.json.unreadable-'));
  record('HOSTED: the original file is preserved aside', !!aside, `entries=${JSON.stringify(entries)}`);
  if (aside) chmodSync(path.join(userData, aside), 0o644);
  record('HOSTED: the preserved-aside file has the ORIGINAL, unmodified bytes — the real user and game are NOT lost',
    aside ? readFileSync(path.join(userData, aside), 'utf-8') === original : false,
    aside ? readFileSync(path.join(userData, aside), 'utf-8') : '(no file)');

  port += 1;
  rmSync(userData, { recursive: true, force: true });
}

// SECTION 8 (CodeRabbit, PR #96 GitHub review round 3, 2026-09-03, Major):
// "Block local-file writes after failed preservation." When the recovery
// path could NOT move the unreadable file aside (the directory itself is not
// writable), the original bytes are still at db.json and the process runs on
// a fresh empty DB. The dangerous sequence is: operator fixes the directory
// permissions to "make saving work" -> the next local-file save writes the
// empty DB straight over the real data. Reproduced here end to end on the
// HOSTED shape: dir 0o500 + file 0o000 at boot (rename fails), then chmod the
// dir back to 0o700 (the operator's fix), then a register attempt — on the
// hosted no-SMTP server register calls saveDB() BEFORE the mail send (which
// then fails 500), so it is a real local-file write trigger. Expected with
// the fix: the write is REFUSED, the original bytes survive; without the
// `localFileSaveBlocked()` guard in saveDB/saveDBAwaited the file is
// overwritten (mutation-verified: removing the guard fails the last check).
if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
  // Windows chmod does not enforce POSIX directory permissions (the rename
  // would succeed), and root ignores them — the fixture cannot fail
  // preservation there, so the section is skipped rather than asserted.
  record('HOSTED, preservation failed: (skipped — Windows or root: chmod does not restrict)', true);
} else {
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-blocked-hosted-'));
  const original = JSON.stringify({
    users: [{ id: 'u1', username: 'real-user', email: 'real@x.com', passwordHash: '', isVerified: true, verificationCode: '', verificationCodeExpires: 0, tokenVersion: 0 }],
    games: [{ id: 'g1', userId: 'u1', name: 'Precious Real Game', payoffs: { a11: 1, a12: 2, a21: 3, a22: 4, b11: 4, b12: 3, b21: 2, b22: 1 } }],
  });
  writeFileSync(path.join(userData, 'db.json'), original);
  chmodSync(path.join(userData, 'db.json'), 0o000);
  chmodSync(userData, 0o500); // directory NOT writable: renameSync(db.json -> aside) must fail

  const child = spawnHostedServer(userData, port);
  let booted = false;
  try {
    const { log } = await waitReady(child, port);
    booted = true;
    record('HOSTED, preservation failed: still boots (degrades, no exit)', true);
    record('HOSTED, preservation failed: the log says the file could NOT be moved aside AND that local persistence is BLOCKED',
      /could NOT be moved aside/.test(log()) && /Local-file persistence is now BLOCKED/.test(log()),
      log().slice(0, 600));

    chmodSync(userData, 0o700); // the operator "fixes" the directory — writes would now succeed
    const reg = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'newbie', email: 'newbie@x.com', password: 'CorrectHorse9!' }),
    });
    // The HTTP response can land before this process has drained the child's
    // stderr, so poll (bounded) for the refusal line instead of reading log()
    // once (CodeRabbit, PR #96 round 4).
    const refusalRe = /Refusing to write .*db\.json: local-file persistence is blocked/;
    const refusalDeadline = Date.now() + 5000;
    while (!refusalRe.test(log()) && Date.now() < refusalDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    record('HOSTED, preservation failed: a write attempt after the operator fix is refused in the log',
      refusalRe.test(log()),
      `register status ${reg.status}; log tail: ${log().slice(-500)}`);
  } catch (err) {
    record('HOSTED, preservation failed: still boots (degrades, no exit)', false, String(err));
  }
  await stop(child);
  chmodSync(userData, 0o700);
  chmodSync(path.join(userData, 'db.json'), 0o644);
  const after = readFileSync(path.join(userData, 'db.json'), 'utf-8');
  record('HOSTED, preservation failed: the ORIGINAL db.json bytes are intact after the write attempt — the real user and game are NOT overwritten',
    booted && after === original, after.slice(0, 300));
  const entries = readdirSync(userData);
  record('HOSTED, preservation failed: no aside copy was created (nothing to preserve to) and no stray temp file is left',
    entries.length === 1 && entries[0] === 'db.json', JSON.stringify(entries));

  port += 1;
  rmSync(userData, { recursive: true, force: true });
}

// ═════════════════════════════════════════════════════════════════════════
// 9. THE ELEMENTS INSIDE THE ARRAYS (BLUE-LOOP-DESKTOP-22 / SR-61, found by
//    this agent). Every section above validates the CONTAINER — "users" and
//    "games" are arrays — which is exactly as far as RED-DESKTOP-6/001's fix
//    went, so the class it closed survived one level down. `[null]` IS an
//    array: it passed normalizeDbShape whole, and the next reader
//    dereferenced the element.
//
//    MEASURED on the unfixed tree, real dist/server.cjs, packaged condition
//    (env -i, empty cwd, IS_ELECTRON=true — probes/s18-dbelements.log):
//      users:[null]  ensureLocalOwner's `db.users.find(u => u.id === ...)`
//                    threw "Cannot read properties of null (reading 'id')".
//                    GET /api/games 500 and POST /api/games 500 for the LIFE
//                    of the process — the app looks permanently broken with
//                    nothing ever naming db.json.
//      games:[null]  migrateOwnerlessGames' `g.userId` threw in the STARTUP
//                    path, before serverListening, so handleFatalAsync took
//                    its process.exit(1) branch. server.ts is required
//                    IN-PROCESS by electron-main.cjs, so that exits the whole
//                    Electron main process: no window, no dialog — #88/#93's
//                    silent-vanish class through a third door.
//    Both now take this function's existing unguessable-shape policy: throw,
//    preserve the bytes aside, refuse to boot through the same hook.
//
//    WHY THESE CANNOT PASS BY COINCIDENCE: section 9c is a CONTROL on the
//    same code path with an element that IS an object but carries none of the
//    fields these readers want (`{}`). It must still BOOT and SERVE. A guard
//    that rejected "anything that doesn't look like a User" — or that simply
//    refused every non-empty array — would pass 9a and 9b and fail 9c.
for (const [label, doc, expectMsg] of [
  ['users[0] is null', { users: [null], games: [] }, /"users\[0\]" is null, not an object/],
  ['games[0] is null', { users: [], games: [null] }, /"games\[0\]" is null, not an object/],
  ['users[0] is a string', { users: ['nope'], games: [] }, /"users\[0\]" is a string, not an object/],
  ['games[1] is a number (the index is the REAL one, not 0)',
    { users: [], games: [{ id: 'g1', userId: 'local-owner', name: 'ok' }, 7] },
    /"games\[1\]" is a number, not an object/],
  ['users[0] is an array (arrays are objects to typeof — the check must not be fooled)',
    { users: [[]], games: [] }, /"users\[0\]" is an array, not an object/],
  // BLUE-LOOP-CLOUD-22: one level further. `users:[{}]` 500'd login and
  // register for everyone (`u.email.trim()`, `passwordHash.startsWith`).
  ['users[0] is {} (no email, no hash: every auth route dereferenced them)',
    { users: [{}], games: [] }, /"users\[0\]\.id" is not a string/],
  ['users[1].passwordHash is a number (the index and FIELD are the real ones)',
    { users: [{ id: 'u1', username: 'a', email: 'a@x.test', passwordHash: '' }, { id: 'u2', username: 'b', email: 'b@x.test', passwordHash: 5 }], games: [] },
    /"users\[1\]\.passwordHash" is not a string/],
]) {
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-el-'));
  const original = JSON.stringify(doc);
  writeFileSync(path.join(userData, 'db.json'), original);

  const child = spawnServer(userData, port);
  // NOT a bare `await waitExit(...)`: on an unfixed tree the server BOOTS and
  // serves 500s instead of exiting, so waitExit rejects on its own timeout and
  // takes the whole file down with an unnamed stack trace — a guard that
  // detects the defect but reports nothing and skips every later section.
  // Catch it and turn "it kept running" into the failing check it actually is.
  let code = null; let log = '';
  try {
    ({ code, log } = await waitExit(child));
  } catch (err) {
    log = `(did not exit) ${err && err.message}`;
    await stop(child);
  }

  record(`element shape, ${label}: the process refuses to start (exits non-zero)`,
    code !== null && code !== 0, `exit code ${code} — ${log.slice(0, 200)}`);
  record(`element shape, ${label}: the refusal names the exact offending ELEMENT and index`,
    expectMsg.test(log), log.slice(0, 400));

  let bootedAnyway = false;
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    bootedAnyway = probe.ok;
  } catch { /* good: nothing listening */ }
  record(`element shape, ${label}: never bound the port (no 500-forever server)`, !bootedAnyway);

  const entries = readdirSync(userData);
  const corrupt = entries.find((f) => f.startsWith('db.json.corrupt-'));
  record(`element shape, ${label}: the user's bytes are PRESERVED aside, unmodified`,
    !!corrupt && readFileSync(path.join(userData, corrupt), 'utf-8') === original,
    `entries=${JSON.stringify(entries)}`);

  rmSync(userData, { recursive: true, force: true });
  port += 1;
}

// 9c. THE CONTROL. A user with its four string fields — passwordHash '' is
// exactly the desktop local owner's own shape, so a "non-empty" check would
// refuse every existing install — and a game `{}` (no reader crashes on game
// fields; not validated on purpose). It must boot AND serve.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-el-control-'));
  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({
    users: [{ id: 'local-owner', username: 'This device', email: 'local-owner@localhost.invalid', passwordHash: '' }], games: [{}] }));

  const child = spawnServer(userData, port);
  try {
    const ready = await waitReady(child, port);
    const list = await fetch(`http://127.0.0.1:${port}/api/games`);
    record('CONTROL: a local-owner-shaped user (passwordHash \'\') and a bare game object still BOOT and serve',
      list.ok, `GET /api/games status ${list.status}`);
    record('CONTROL: no legacy-password SECURITY warning for the local owner (\'\' is no password, not a reversible one)',
      !/SECURITY: \d+ account\(s\) still use legacy/.test(ready.log()), ready.log().slice(0, 200));
    const save = await fetch(`http://127.0.0.1:${port}/api/games`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe', description: 'd',
        payoffs: { a11: 1, b11: 1, a12: 0, b12: 0, a21: 0, b21: 0, a22: 1, b22: 1 } }),
    });
    record('CONTROL: and saving still works on it (the refusal did not widen to every array)',
      save.ok, `POST /api/games status ${save.status}`);
  } catch (err) {
    record('CONTROL: a local-owner-shaped user (passwordHash \'\') and a bare game object still BOOT and serve', false, String(err));
  } finally {
    await stop(child);
    rmSync(userData, { recursive: true, force: true });
  }
  port += 1;
}

// 10. A STORED EMAIL THE SHAPE CHECK ACCEPTS BUT REGISTER NEVER WRITES (sweep 22, S1-1). The
//     validator asks only for a string, so a legacy or hand-edited "Kate@Example.test" loads. Register,
//     forgot and reset folded it; login and verify compared it exactly: "already registered" at sign-up,
//     401 at log-in, 404 at verify. Hosted, file-backed, the real bundle. The wrong-password control
//     keeps the 200 from passing because login accepts anything.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-email-'));
  const PW = 'Sup3rSecret!23';
  const salt = randomBytes(16);
  const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hash = `pbkdf2$1000$${b64u(salt)}$${b64u(pbkdf2Sync(PW, salt, 1000, 32, 'sha256'))}`;
  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({ games: [], users: [
    { id: 'u_kate', username: 'kate', email: 'Kate@Example.test', passwordHash: hash, isVerified: true, verificationCode: '', verificationCodeExpires: 0 },
    { id: 'u_pat', username: 'pat', email: ' Pat@Example.test', passwordHash: hash, isVerified: false,
      verificationCode: '123456', verificationCodeExpires: Date.now() + 3_600_000 },
  ] }));
  const child = spawnHostedServer(userData, port);
  const post = (route, body) => fetch(`http://127.0.0.1:${port}/api/auth/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await waitReady(child, port);
    const taken = await post('register', { username: 'kate2', email: 'kate@example.test', password: PW });
    record('stored "Kate@Example.test": CONTROL, register already sees the account (400)', taken.status === 400, `status ${taken.status}`);
    const login = await post('login', { email: 'kate@example.test', password: PW });
    record('stored "Kate@Example.test": login by the typed email succeeds (200), as it does by username',
      login.status === 200, `status ${login.status}`);
    const wrong = await post('login', { email: 'kate@example.test', password: 'Wr0ngSecret!23' });
    record('stored "Kate@Example.test": CONTROL, a wrong password is still 401', wrong.status === 401, `status ${wrong.status}`);
    const verify = await post('verify', { email: 'pat@example.test', code: '123456', password: PW });
    record('stored " Pat@Example.test" (pending): verify by the typed email succeeds (200)', verify.status === 200, `status ${verify.status}`);
  } catch (err) {
    record('stored mixed-case email: the hosted server boots', false, String(err));
  } finally {
    await stop(child);
    rmSync(userData, { recursive: true, force: true });
  }
  port += 1;
}

// 11. TWO ROWS, ONE MAILBOX (sweep 22, S1-2). A merged or legacy store can hold both (dedupe keeps
//     duplicates GCS already held). delete-confirm removed every row with the email but only the
//     signed-in row's games, then said "all saved game profiles ... deleted". A third account's game
//     is the control: a wipe-everything fix would pass the first check and fail this one.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-dupmail-'));
  const PW = 'Sup3rSecret!23';
  const salt = randomBytes(16);
  const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hash = `pbkdf2$1000$${b64u(salt)}$${b64u(pbkdf2Sync(PW, salt, 1000, 32, 'sha256'))}`;
  const row = (id, username, email) => ({ id, username, email, passwordHash: hash, isVerified: true, verificationCode: '', verificationCodeExpires: 0 });
  const payoffs = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({
    users: [row('u_b', 'kate-old', 'Kate@Example.test'), row('u_a', 'kate', 'kate@example.test'), row('u_c', 'other', 'other@example.test')],
    games: [{ id: 'g_a', userId: 'u_a', name: 'A', payoffs }, { id: 'g_b', userId: 'u_b', name: 'B', payoffs }, { id: 'g_c', userId: 'u_c', name: 'C', payoffs }] }));
  const child = spawnServer(userData, port);
  const call = (route, body, token) => fetch(`http://127.0.0.1:${port}/api/auth/${route}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  try {
    await waitReady(child, port);
    // One lookup rule for every route (findByEmail): u_b sorts first but u_a holds the typed spelling,
    // so forgot, reset and login all land on u_a. Unfixed, reset hit u_b and login u_a (401); a plain
    // fold moves login onto the legacy u_b.
    const { json: forgot } = await call('forgot-password', { email: 'kate@example.test' });
    const NEW = 'N3wSecret!456';
    const reset = await call('reset-password', { email: 'kate@example.test', code: forgot?.recoveryCode, newPassword: NEW });
    const relog = await call('login', { email: 'kate@example.test', password: NEW });
    record('two rows, one mailbox: forgot, reset and login reach the same row (the new password logs in, as u_a)',
      reset.status === 200 && relog.status === 200 && relog.json?.user?.id === 'u_a', `reset ${reset.status}, login ${relog.status} as ${relog.json?.user?.id}`);
    const { json: login } = await call('login', { email: 'kate', password: NEW });
    const { json: ask } = await call('delete-request', {}, login?.token);
    const done = await call('delete-confirm', { code: ask?.deleteCode }, login?.token);
    const after = JSON.parse(readFileSync(path.join(userData, 'db.json'), 'utf-8'));
    const ids = (xs) => xs.map((x) => x.id).sort().join(',');
    record('two rows, one mailbox: delete-confirm answers 200', done.status === 200, `status ${done.status}`);
    record('two rows, one mailbox: both rows AND both rows\' games are gone from disk',
      !after.games.some((g) => g.userId === 'u_a' || g.userId === 'u_b') && !after.users.some((u) => u.id === 'u_a' || u.id === 'u_b'),
      `users ${ids(after.users)}; games ${ids(after.games)}`);
    record('two rows, one mailbox: CONTROL, the other account and its game are untouched',
      after.users.some((u) => u.id === 'u_c') && after.games.some((g) => g.id === 'g_c'), `users ${ids(after.users)}; games ${ids(after.games)}`);
  } catch (err) {
    record('two rows, one mailbox: the desktop server boots', false, String(err));
  } finally {
    await stop(child);
    rmSync(userData, { recursive: true, force: true });
  }
  port += 1;
}

// 12. VERIFIED VS PENDING, ONE MAILBOX (sweep 22, S1-4). A legacy store holds the owner's verified
//     "Kate@Example.test" and a later pending "kate@example.test" (register once compared exactly).
//     S1-3's exact-first lookup sent the owner's email login to the pending row (401) and forgot to it
//     (no code), and the pending row's password opened a 403 "verify" path. Each check names u_owner or
//     the status the owner's row gives, so a lookup that drops the pending row cannot pass them by luck.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-pending-'));
  const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hashOf = (pw) => { const s = randomBytes(16); return `pbkdf2$1000$${b64u(s)}$${b64u(pbkdf2Sync(pw, s, 1000, 32, 'sha256'))}`; };
  const OWN = 'Own3rSecret!1', SQUAT = 'Squ4tter!pw9';
  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({ games: [], users: [
    { id: 'u_pend', username: 'kate2', email: 'kate@example.test', passwordHash: hashOf(SQUAT), isVerified: false,
      verificationCode: '654321', verificationCodeExpires: Date.now() + 3_600_000 },
    { id: 'u_owner', username: 'kate', email: 'Kate@Example.test', passwordHash: hashOf(OWN), isVerified: true, verificationCode: '', verificationCodeExpires: 0 },
  ] }));
  const child = spawnServer(userData, port);
  const call = (route, body) => fetch(`http://127.0.0.1:${port}/api/auth/${route}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  try {
    await waitReady(child, port);
    const own = await call('login', { email: 'kate@example.test', password: OWN });
    record('verified vs pending: the owner logs in by the typed email (200, as u_owner)',
      own.status === 200 && own.json?.user?.id === 'u_owner', `status ${own.status} as ${own.json?.user?.id}`);
    const squat = await call('login', { email: 'kate@example.test', password: SQUAT });
    record('verified vs pending: the pending row\'s password is a 401 (owner\'s row), not a 403 verify path', squat.status === 401, `status ${squat.status}`);
    const forgot = await call('forgot-password', { email: 'kate@example.test' });
    record('verified vs pending: forgot issues the owner a recovery code', typeof forgot.json?.recoveryCode === 'string',
      `status ${forgot.status}, code ${forgot.json?.recoveryCode ? 'issued' : 'none'}`);
  } catch (err) {
    record('verified vs pending: the desktop server boots', false, String(err));
  } finally {
    await stop(child);
    rmSync(userData, { recursive: true, force: true });
  }
  port += 1;
}

// 13. HOSTILE BODIES, HOSTED (sweep 22, empty probes checked in). Every POST route answers a body that
//     is not a JSON object with a 4xx; every game field given the wrong type answers without a 5xx and
//     stores only strings (or string lists). TRUST_PROXY + one X-Forwarded-For per request keeps the
//     rate limits out of it: the first probe run was 401/429 throughout and "passed" with nothing
//     tested, so the 200 counts below are asserted, and a dead server fails as status 0.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-dbshape-bodies-'));
  const PW = 'Sup3rSecret!23', salt = randomBytes(16);
  const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({ games: [], users: [{ id: 'u_k', username: 'kate', email: 'kate@example.test',
    passwordHash: `pbkdf2$1000$${b64u(salt)}$${b64u(pbkdf2Sync(PW, salt, 1000, 32, 'sha256'))}`, isVerified: true, verificationCode: '', verificationCodeExpires: 0 }] }));
  const child = spawnHostedServer(userData, port, { TRUST_PROXY: 'true' });
  let ip = 0;
  const raw = (method, route, type, body, token) => fetch(`http://127.0.0.1:${port}/api/${route}`, { method, body,
    headers: { 'content-type': type, 'x-forwarded-for': `10.${(++ip >> 8) & 255}.${ip & 255}.1`, ...(token ? { authorization: `Bearer ${token}` } : {}) } })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }), () => ({ status: 0, json: null }));
  const call = (method, route, body, token) => raw(method, route, 'application/json', body === undefined ? undefined : JSON.stringify(body), token);
  try {
    const ready = await waitReady(child, port);
    const bodies = [['text/plain', 'x'], ['application/json', 'null'], ['application/json', '[1]'], ['application/json', '"s"'],
      ['application/json', '{'], ['application/x-www-form-urlencoded', 'email=a']];
    const routes = ['auth/register', 'auth/verify', 'auth/login', 'auth/forgot-password', 'auth/reset-password', 'auth/delete-request',
      'auth/delete-confirm', 'feedback', 'report', 'games', 'games/adopt-local', 'scenario/regenerate'];
    const off = [];
    for (const r of routes) for (const [type, body] of bodies) {
      const { status } = await raw('POST', r, type, body);
      if (status < 400 || status >= 500) off.push(`${r} ${body} -> ${status}`);
    }
    record('hostile bodies: every POST route answers a non-object body with a 4xx (72 requests)', off.length === 0, off.join('; ') || 'all 4xx');
    const token = (await call('POST', 'auth/login', { email: 'kate', password: PW })).json?.token;
    const P = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
    const base = (await call('POST', 'games', { name: 'base', payoffs: P }, token)).json?.game?.id;
    record('hostile bodies: CONTROL, a well-formed login and save succeed on the same server', !!token && !!base, `token ${!!token}, game ${base}`);
    const junk = [null, 5, true, [], ['x'], [5], [{}], [null], ['a', 'a'], Array(500).fill('word'), {}, { toString: 'x' }, 'x'.repeat(5000), '‮\u0000', -0, 1e308];
    const fields = ['name', 'description', 'row1Label', 'row2Label', 'col1Label', 'col2Label', 'colorTermsA', 'colorTermsB', 'clientRequestId', 'allowClear', 'scenarioSource'];
    const shapeOk = (g) => Object.entries(g ?? {}).every(([k, v]) => (k === 'payoffs' ? Object.values(v).every(Number.isFinite)
      : /^colorTerms[AB]$/.test(k) ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === 'string'));
    const bad = [], ok = { POST: 0, PATCH: 0 };
    for (const f of fields) for (const v of junk) {
      const tag = `${f}=${JSON.stringify(v)?.slice(0, 16)}`;
      const a = await call('POST', 'games', { name: 'n', payoffs: P, [f]: v }, token);
      if (a.status === 0 || a.status >= 500 || (a.status === 200 && !shapeOk(a.json?.game))) bad.push(`POST ${tag} -> ${a.status} ${JSON.stringify(a.json?.game?.[f])?.slice(0, 30)}`);
      if (a.status === 200) { ok.POST++; await call('DELETE', `games/${a.json.game.id}`, undefined, token); }
      const b = await call('PATCH', `games/${base}`, { name: 'n2', [f]: v }, token);
      if (b.status === 0 || b.status >= 500 || (b.status === 200 && !shapeOk(b.json?.game))) bad.push(`PATCH ${tag} -> ${b.status} ${JSON.stringify(b.json?.game?.[f])?.slice(0, 30)}`);
      if (b.status === 200) ok.PATCH++;
    }
    const stored = JSON.parse(readFileSync(path.join(userData, 'db.json'), 'utf-8')).games;
    record('hostile bodies: every mistyped game field answers without a 5xx and stores only strings / string lists',
      bad.length === 0 && stored.every(shapeOk), bad.slice(0, 4).join('; ') || `${stored.length} stored game(s) clean`);
    record('hostile bodies: FIXTURE, the saves really ran (>= 150 POST and PATCH answered 200, not 401/429)',
      ok.POST >= 150 && ok.PATCH >= 150, JSON.stringify(ok));
    record('hostile bodies: the server logged no TypeError', !/TypeError/.test(ready.log()), (ready.log().match(/.*TypeError.*/) ?? [''])[0].slice(0, 120));
  } catch (err) {
    record('hostile bodies: the hosted server boots', false, String(err));
  } finally {
    await stop(child);
    rmSync(userData, { recursive: true, force: true });
  }
  port += 1;
}

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ DB-SHAPE REFUSAL: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length > 0) {
  console.error(`\n${fails.length} FAILURE(S):`);
  for (const f of fails) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

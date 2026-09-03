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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
function spawnHostedServer(userData, thePort) {
  return spawn('node', [BUNDLE], {
    cwd: userData,
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT: String(thePort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady(child, thePort) {
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming ready on ${thePort} (code ${child.exitCode})\n${log}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${thePort}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { log: () => log };
    } catch { /* not up yet, or the health check itself timed out */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready on ${thePort}\n${log}`);
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

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ DB-SHAPE REFUSAL: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length > 0) {
  console.error(`\n${fails.length} FAILURE(S):`);
  for (const f of fails) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

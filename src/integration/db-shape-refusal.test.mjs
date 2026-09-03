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
 *   node src/integration/db-shape-refusal.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
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
function runHook(userData, withHook) {
  const r = spawnSync('node', [RUNNER, BUNDLE, userData, withHook ? '1' : '0'], {
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

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ DB-SHAPE REFUSAL: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length > 0) {
  console.error(`\n${fails.length} FAILURE(S):`);
  for (const f of fails) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

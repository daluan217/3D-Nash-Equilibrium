/* INTEGRATION — RED-DESKTOP-8/001: never silently choose one of two local
 * desktop databases.
 *
 * A real packaged 0.0.136 app was started on a case-sensitive APFS volume
 * under a whitespace/non-ASCII profile path containing two valid databases:
 * `db.json` and an iCloud-style `db.json 2`. It loaded the primary, accepted
 * a save, and relaunched without ever telling the user the second library
 * existed. The duplicate was neither malformed nor atomic-write scratch data;
 * choosing or merging it automatically cannot be safe.
 *
 * This production-bundle regression uses the same exact direct sibling name.
 * It proves a standalone desktop backend refuses before binding a port and
 * leaves both original byte streams intact. The in-process hook case mirrors
 * Electron's `require('./dist/server.cjs')` startup and proves that the
 * package receives the distinct `data-conflict` recovery handoff, rather than
 * being killed before it can show the native backup-first dialog. The control
 * keeps the established `.corrupt-*` recovery artifacts non-blocking.
 *
 *   node src/integration/desktop-db-conflict.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(repo, 'dist/server.cjs');
const HOOK_RUNNER = path.join(repo, 'src/desktop/db-shape-hook-runner.cjs');
let port = Number(process.env.DB_CONFLICT_TEST_PORT || 3175);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function validDatabase(userId, gameName) {
  return JSON.stringify({
    users: [{
      id: userId,
      username: `${userId}-user`,
      email: `${userId}@example.test`,
      passwordHash: 'fixture',
      isVerified: true,
      verificationCode: '',
      verificationCodeExpires: 0,
      tokenVersion: 0,
    }],
    games: [{
      id: `${userId}-game`,
      userId,
      name: gameName,
      payoffs: { a11: 1, a12: 2, a21: 3, a22: 4, b11: 4, b12: 3, b21: 2, b22: 1 },
    }],
  }, null, 2);
}

function spawnDesktop(userData, targetPort) {
  return spawn('node', [BUNDLE], {
    cwd: userData,
    // Full replacement environment: the test cannot inherit a local .env,
    // GCS configuration, or a real desktop profile by accident.
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT: String(targetPort),
      IS_ELECTRON: 'true',
      ELECTRON_USER_DATA_PATH: userData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForClose(child, timeoutMs = 5000) {
  let log = '';
  child.stdout.on('data', (data) => { log += data; });
  child.stderr.on('data', (data) => { log += data; });
  let timer;
  const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  try {
    const code = await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out waiting for startup refusal')), timeoutMs); }),
    ]);
    return { code, log };
  } catch (err) {
    // A mutation back to the old silent behavior starts a server instead of
    // exiting. Kill only this fixture process so the failed regression never
    // leaks a listener into a later suite.
    if (child.exitCode === null) child.kill('SIGKILL');
    await closed;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function waitReady(child, targetPort) {
  let log = '';
  child.stdout.on('data', (data) => { log += data; });
  child.stderr.on('data', (data) => { log += data; });
  for (let i = 0; i < 30; i++) {
    if (child.exitCode !== null) throw new Error(`server exited before readiness: ${log}`);
    try {
      const health = await fetch(`http://127.0.0.1:${targetPort}/api/health`, { signal: AbortSignal.timeout(500) });
      if (health.ok) return;
    } catch { /* wait for the process to listen */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become ready: ${log}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await closed;
  clearTimeout(timer);
}

async function healthIsDown(targetPort) {
  try {
    const health = await fetch(`http://127.0.0.1:${targetPort}/api/health`, { signal: AbortSignal.timeout(500) });
    return !health.ok;
  } catch {
    return true;
  }
}

// ══ 1. THE DEFECT FIXTURE: two independently valid databases under the
//      exact observed `db.json 2` name must stop before loading either one.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-db-conflict-'));
  const primaryPath = path.join(userData, 'db.json');
  const conflictPath = path.join(userData, 'db.json 2');
  const primary = validDatabase('primary-owner', 'Primary library game');
  const conflict = validDatabase('conflict-owner', 'Conflict-copy saved game');
  writeFileSync(primaryPath, primary);
  writeFileSync(conflictPath, conflict);

  const child = spawnDesktop(userData, port);
  let outcome = null;
  try {
    outcome = await waitForClose(child);
    record('two valid databases: desktop startup refuses (non-zero exit)', outcome.code !== 0, `exit=${outcome.code}`);
    record('the refusal is explicit about multiple local databases and names db.json 2',
      /Refusing to start: found multiple possible local databases/.test(outcome.log) && /db\.json 2/.test(outcome.log),
      outcome.log.slice(0, 700));
    record('the refusal promises no automatic choose, merge, rename, or delete',
      /will not choose, merge, rename, or delete either file/.test(outcome.log), outcome.log.slice(0, 700));
  } catch (err) {
    record('two valid databases: desktop startup refuses (non-zero exit)', false, String(err));
  }
  record('the refused process never binds its HTTP port', await healthIsDown(port));
  record('the primary database bytes remain exactly unchanged',
    readFileSync(primaryPath, 'utf8') === primary, readFileSync(primaryPath, 'utf8'));
  record('the conflict-copy bytes remain exactly unchanged',
    readFileSync(conflictPath, 'utf8') === conflict, readFileSync(conflictPath, 'utf8'));
  const entries = readdirSync(userData);
  record('both candidates remain in place; neither was renamed aside or deleted',
    existsSync(primaryPath) && existsSync(conflictPath) && !entries.some((entry) => entry.startsWith('db.json.corrupt-')),
    `entries=${JSON.stringify(entries)}`);

  rmSync(userData, { recursive: true, force: true });
  port += 1;
}

// ══ 2. PACKAGED-APP HANDOFF: Electron loads the production bundle in
//      process. The hook must receive the distinct kind and the actual
//      conflict-copy path, while the server still never attempts a listen.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-db-conflict-hook-'));
  const primaryPath = path.join(userData, 'db.json');
  const conflictPath = path.join(userData, 'db.json 2');
  const primary = validDatabase('primary-hook', 'Primary hook game');
  const conflict = validDatabase('conflict-hook', 'Conflict hook game');
  writeFileSync(primaryPath, primary);
  writeFileSync(conflictPath, conflict);

  const run = spawnSync('node', [HOOK_RUNNER, BUNDLE, userData, '1'], { encoding: 'utf8', timeout: 10_000 });
  const match = (run.stdout || '').match(/RUNNER_RESULT (\{.*\})/);
  const parsed = match ? JSON.parse(match[1]) : null;
  record('packaged-app handoff survives the refusal (no in-process exit)', run.status === 0,
    `status=${run.status} stderr=${(run.stderr || '').slice(0, 500)}`);
  record('the Electron hook receives the data-conflict kind and exact conflict-copy path',
    parsed?.hookPayload?.kind === 'data-conflict' && parsed?.hookPayload?.lockFile === conflictPath,
    `payload=${JSON.stringify(parsed?.hookPayload)}`);
  record('the Electron hook message says to back up and inspect both files',
    /back up and inspect both files/i.test(parsed?.hookPayload?.message || ''),
    `message=${JSON.stringify(parsed?.hookPayload?.message)}`);
  record('the production bundle never binds a port after handing off the conflict',
    parsed?.listenCallCount === 0, `listenCallCount=${parsed?.listenCallCount}`);
  record('the packaged-app handoff preserves both database byte streams too',
    readFileSync(primaryPath, 'utf8') === primary && readFileSync(conflictPath, 'utf8') === conflict);

  rmSync(userData, { recursive: true, force: true });
}

// ══ 3. CONTROL: an established corrupt-file recovery artifact is not a
//      second candidate. It must continue to boot normally, proving the
//      narrow name check does not turn existing recovery semantics into a
//      blanket refusal for every `db.json.*` sibling.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-db-conflict-control-'));
  const primaryPath = path.join(userData, 'db.json');
  const primary = validDatabase('control-owner', 'Control library game');
  writeFileSync(primaryPath, primary);
  writeFileSync(path.join(userData, 'db.json.corrupt-2026-09-04T00-00-00-000Z'), '{preserved bytes}');

  const child = spawnDesktop(userData, port);
  try {
    await waitReady(child, port);
    record('CONTROL: a db.json.corrupt-* recovery sidecar does not block ordinary desktop startup', true);
  } catch (err) {
    record('CONTROL: a db.json.corrupt-* recovery sidecar does not block ordinary desktop startup', false, String(err));
  } finally {
    await stop(child);
  }
  record('CONTROL: the primary database remains byte-for-byte unchanged without a save request',
    readFileSync(primaryPath, 'utf8') === primary);
  rmSync(userData, { recursive: true, force: true });
}

const failures = results.filter((result) => !result.pass);
console.log(`\n══════ DESKTOP DB-CONFLICT: ${results.length - failures.length}/${results.length} checks passed ══════`);
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail}`);
  process.exit(1);
}

/* Integration guard for the development Vite middleware boundary.
 *
 * Vite's SPA history fallback accepts browser-style HTML requests. Unknown
 * /api paths must be consumed by Express before that middleware in development
 * just as they are before the production index fallback.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const PORT = process.env.DEV_FALLBACK_PORT || '3184';
const BASE = `http://127.0.0.1:${PORT}`;
const userData = mkdtempSync(path.join(tmpdir(), 'nash-dev-fallback-'));

const serverEnv = (port) => ({
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(port),
  ELECTRON_USER_DATA_PATH: userData,
  SMTP_USER: '',
  SMTP_PASS: '',
  ADMIN_SECRET: '',
  AUTH_SECRET: '',
  AZURE_FOUNDRY_ENDPOINT: '',
  AZURE_FOUNDRY_API_KEY: '',
  GCS_BUCKET_NAME: '',
});

const hasOwnListenMarker = (log, port) => log.split(/\r?\n/)
  .some((line) => line.trim() === `Express server running on http://0.0.0.0:${port}`);
const isOwnReady = ({ log, port, childProcess, healthOk }) => healthOk
  && childProcess.exitCode === null
  && childProcess.signalCode === null
  && hasOwnListenMarker(log, port);

// Truth-table controls isolate both non-vacuous ownership conjuncts. Dropping
// either the live-child check or the child's own listen marker makes one of
// these fail, while the positive row proves the predicate can become ready.
const ownMarker = `Express server running on http://0.0.0.0:${PORT}\n`;
if (isOwnReady({ log: '', port: PORT, childProcess: { exitCode: null, signalCode: null }, healthOk: true })
    || isOwnReady({ log: ownMarker, port: PORT, childProcess: { exitCode: 1, signalCode: null }, healthOk: true })
    || !isOwnReady({ log: ownMarker, port: PORT, childProcess: { exitCode: null, signalCode: null }, healthOk: true })) {
  throw new Error('development readiness ownership truth table failed');
}

const spawnDevServer = (port) => spawn(
  process.execPath,
  ['--import', 'tsx', path.join(serverDir, 'server.ts')],
  {
    cwd: serverDir,
    env: serverEnv(port),
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

const REQUEST_TIMEOUT_MS = 1000;
/** Give every request in this boundary test the same finite attempt budget. */
const boundedFetch = (url, init = {}) => fetch(url, {
  ...init,
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
/** Read the readiness endpoint through the shared bounded transport. */
const fetchHealth = async (base) => (await boundedFetch(`${base}/api/health`)).ok;
/** Read the Vite root control through the shared bounded transport. */
const fetchRoot = (base) => boundedFetch(`${base}/`, { headers: { accept: 'text/html' } });
/** Read the unknown API boundary through the shared bounded transport. */
const fetchUnknownApi = (base) => boundedFetch(`${base}/api/scenarios`, { headers: { accept: 'text/html' } });

// Mutation control for the per-attempt deadline used below. A peer can accept
// the connection and never send headers; without AbortSignal.timeout, one
// iteration would hang and the outer 120-attempt bound would be meaningless.
const staller = createServer(() => { /* deliberately never respond */ });
await new Promise((resolve, reject) => {
  staller.once('error', reject);
  staller.listen(0, '127.0.0.1', resolve);
});
const stallerAddress = staller.address();
if (!stallerAddress || typeof stallerAddress === 'string') throw new Error('stall control did not bind a TCP port');
try {
  const stalledBase = `http://127.0.0.1:${stallerAddress.port}`;
  const outcomes = await Promise.race([
    Promise.all([
      fetchHealth(stalledBase),
      fetchRoot(stalledBase),
      fetchUnknownApi(stalledBase),
    ].map((attempt) => attempt.then(() => 'resolved', () => 'aborted'))),
    new Promise((resolve) => setTimeout(() => resolve(['hung']), REQUEST_TIMEOUT_MS * 2)),
  ]);
  if (outcomes.length !== 3 || outcomes.some((outcome) => outcome !== 'aborted')) {
    throw new Error(`request deadline controls failed: ${JSON.stringify(outcomes)}`);
  }
} finally {
  staller.closeAllConnections?.();
  await new Promise((resolve) => staller.close(resolve));
}

// Regression control for the exact false-ready shape: an unrelated service
// already owns the port and answers /api/health while our child exits on
// EADDRINUSE. A status-only readiness probe would incorrectly accept it.
const decoy = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"status":"decoy"}');
});
await new Promise((resolve, reject) => {
  decoy.once('error', reject);
  // Hosted/dev mode binds the wildcard interface, so the decoy must do the
  // same. On macOS a 127.0.0.1-only owner can coexist with 0.0.0.0 and would
  // not exercise the server's EADDRINUSE path.
  decoy.listen(0, '0.0.0.0', resolve);
});
const decoyAddress = decoy.address();
if (!decoyAddress || typeof decoyAddress === 'string') throw new Error('decoy did not bind a TCP port');
const collisionChild = spawnDevServer(decoyAddress.port);
let collisionLog = '';
collisionChild.stdout.on('data', (chunk) => { collisionLog += chunk; });
collisionChild.stderr.on('data', (chunk) => { collisionLog += chunk; });
try {
  const collisionExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('colliding dev server did not exit')), 10000);
    collisionChild.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    collisionChild.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const decoyHealth = await fetch(`http://127.0.0.1:${decoyAddress.port}/api/health`);
  await decoyHealth.text();
  if (typeof collisionExit.code !== 'number' || collisionExit.code === 0
      || !/EADDRINUSE|already in use/.test(collisionLog) || !decoyHealth.ok
      || isOwnReady({ log: collisionLog, port: decoyAddress.port, childProcess: collisionChild, healthOk: true })) {
    throw new Error(
      `occupied-port control failed: exit=${JSON.stringify(collisionExit)} decoy=${decoyHealth.status}\n${collisionLog.slice(-1000)}`,
    );
  }
} finally {
  if (collisionChild.exitCode === null && collisionChild.signalCode === null) collisionChild.kill('SIGKILL');
  await new Promise((resolve) => decoy.close(resolve));
}

// Use the same TS loader as `npm run dev`. Node's built-in type stripping does
// not resolve this project's extensionless TypeScript imports on Node 22.
// Launch Node directly (rather than the `tsx` CLI shim) so cleanup owns the
// actual server process and cannot strand a grandchild.
const child = spawnDevServer(PORT);
let serverLog = '';
child.stdout.on('data', (chunk) => { serverLog += chunk; });
child.stderr.on('data', (chunk) => { serverLog += chunk; });

const stop = async () => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
};

try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    let healthOk = false;
    try {
      healthOk = await fetchHealth(BASE);
    } catch { /* still booting */ }
    if (isOwnReady({ log: serverLog, port: PORT, childProcess: child, healthOk })) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`development server never became ready\n${serverLog.slice(-1000)}`);

  const root = await fetchRoot(BASE);
  const rootType = root.headers.get('content-type') || '';
  if (root.status !== 200 || !rootType.includes('text/html')) {
    throw new Error(`Vite control failed: / returned ${root.status} ${rootType}`);
  }

  const unknown = await fetchUnknownApi(BASE);
  const unknownType = unknown.headers.get('content-type') || '';
  const body = await unknown.json().catch(() => null);
  if (unknown.status !== 404 || !unknownType.includes('application/json') || body?.error !== 'Not found') {
    throw new Error(
      `unknown dev API path escaped to Vite: status=${unknown.status} type=${unknownType} body=${JSON.stringify(body)}`,
    );
  }
  console.log('✓ development Vite boundary: browser-style unknown /api request is a JSON 404; root still serves HTML');
} finally {
  await stop();
  rmSync(userData, { recursive: true, force: true });
}

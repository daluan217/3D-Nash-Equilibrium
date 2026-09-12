/* Integration guard for the development Vite middleware boundary.
 *
 * Vite's SPA history fallback accepts browser-style HTML requests. Unknown
 * /api paths must be consumed by Express before that middleware in development
 * just as they are before the production index fallback.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const PORT = process.env.DEV_FALLBACK_PORT || '3184';
const BASE = `http://127.0.0.1:${PORT}`;
const userData = mkdtempSync(path.join(tmpdir(), 'nash-dev-fallback-'));

// Use the same TS loader as `npm run dev`. Node's built-in type stripping does
// not resolve this project's extensionless TypeScript imports on Node 22.
// Launch Node directly (rather than the `tsx` CLI shim) so cleanup owns the
// actual server process and cannot strand a grandchild.
const child = spawn(process.execPath, ['--import', 'tsx', path.join(serverDir, 'server.ts')], {
  cwd: serverDir,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT,
    ELECTRON_USER_DATA_PATH: userData,
    SMTP_USER: '',
    SMTP_PASS: '',
    ADMIN_SECRET: '',
    AUTH_SECRET: '',
    AZURE_FOUNDRY_ENDPOINT: '',
    AZURE_FOUNDRY_API_KEY: '',
    GCS_BUCKET_NAME: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
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
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; }
    } catch { /* still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`development server never became ready\n${serverLog.slice(-1000)}`);

  const root = await fetch(`${BASE}/`, { headers: { accept: 'text/html' } });
  const rootType = root.headers.get('content-type') || '';
  if (root.status !== 200 || !rootType.includes('text/html')) {
    throw new Error(`Vite control failed: / returned ${root.status} ${rootType}`);
  }

  const unknown = await fetch(`${BASE}/api/scenarios`, { headers: { accept: 'text/html' } });
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

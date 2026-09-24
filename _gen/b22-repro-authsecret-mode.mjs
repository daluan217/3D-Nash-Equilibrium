// REPRO: the desktop session secret keeps a pre-existing file's permissions.
// server.ts:824  fs.writeFileSync(file, fresh, { encoding: 'utf-8', mode: 0o600 })
// `mode` is honoured only when writeFileSync CREATES the file. If auth-secret
// already exists, the mode argument is ignored and the freshly generated HMAC
// key inherits whatever permissions were already there.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const WT = process.argv[2], PORT = Number(process.argv[3] || 4895);
const udd = mkdtempSync(join(tmpdir(), 'nash-authmode-'));
const cwd = mkdtempSync(join(tmpdir(), 'nash-authmode-cwd-'));
const f = join(udd, 'auth-secret');
// A world-readable+writable file where the secret goes. Reachable by: a sync
// client, a restore from a backup that flattened modes, a shared-machine
// attacker who got there first, or an earlier version of this very app.
writeFileSync(f, 'not-a-key'); chmodSync(f, 0o666);
console.log('before boot :', (statSync(f).mode & 0o777).toString(8), JSON.stringify(readFileSync(f,'utf8')));
const child = spawn('node', [join(WT, 'dist/server.cjs')], { cwd,
  env: { PATH: process.env.PATH, HOME: udd, NODE_ENV: 'production', PORT: String(PORT),
    IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: udd }, stdio: ['ignore','pipe','pipe'] });
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 200));
}
const mode = (statSync(f).mode & 0o777).toString(8);
const key = readFileSync(f, 'utf8').trim();
console.log('after boot  :', mode, `key=${key.slice(0,12)}… valid=${/^[0-9a-f]{64}$/.test(key)}`);
console.log(mode === '600'
  ? 'EMPTY: the secret is 0600'
  : `DEFECT: a freshly generated session key is mode ${mode} — world-readable${mode[2] >= '2' ? ' AND WRITABLE' : ''}.`);
child.kill();

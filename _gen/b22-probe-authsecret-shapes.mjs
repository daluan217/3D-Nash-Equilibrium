// New angle: the desktop session secret file is attacker-adjacent state (it
// lives in the user's data dir). What happens when it is hostile on disk?
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const WT = process.argv[2], PORT0 = Number(process.argv[3] || 4894);
const UA = 'Mozilla/5.0 (Macintosh) nash-equilibrium-simulator/0.0.224 Electron/32.2.7 Safari/537.36';

async function boot(port, prepare) {
  const udd = mkdtempSync(join(tmpdir(), 'nash-authsec-'));
  const cwd = mkdtempSync(join(tmpdir(), 'nash-authsec-cwd-'));
  prepare(udd);
  const child = spawn('node', [join(WT, 'dist/server.cjs')], { cwd,
    env: { PATH: process.env.PATH, HOME: udd, NODE_ENV: 'production', PORT: String(port),
      IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: udd },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return { child, udd, log: () => log }; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  child.kill(); throw new Error('never ready:\n' + log.slice(-600));
}

const cases = {
  'empty file':        d => writeFileSync(join(d, 'auth-secret'), ''),
  'one char':          d => writeFileSync(join(d, 'auth-secret'), 'a'),
  'truncated (32 hex)':d => writeFileSync(join(d, 'auth-secret'), 'a'.repeat(32)),
  'non-hex 64 chars':  d => writeFileSync(join(d, 'auth-secret'), 'z'.repeat(64)),
  'uppercase hex':     d => writeFileSync(join(d, 'auth-secret'), 'A'.repeat(64)),
  'valid + newline':   d => writeFileSync(join(d, 'auth-secret'), 'b'.repeat(64) + '\n'),
  'a DIRECTORY':       d => mkdirSync(join(d, 'auth-secret')),
  'huge file':         d => writeFileSync(join(d, 'auth-secret'), 'c'.repeat(5_000_000)),
};
let port = PORT0;
for (const [label, prep] of Object.entries(cases)) {
  let verdict;
  try {
    const { child, udd } = await boot(port++, prep);
    // Register, then check the token still validates — i.e. the secret is stable.
    const email = `u${Date.now()}@e.com`;
    const reg = await fetch(`http://127.0.0.1:${port-1}/api/register`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ email, password: 'Passw0rd!x' }) });
    const body = await reg.json().catch(() => ({}));
    const tok = body.token;
    const me = tok ? await fetch(`http://127.0.0.1:${port-1}/api/games`, { headers: { authorization: `Bearer ${tok}`, 'user-agent': UA } }) : null;
    let onDisk = null, mode = null;
    try { onDisk = readFileSync(join(udd, 'auth-secret'), 'utf8').trim(); mode = (statSync(join(udd,'auth-secret')).mode & 0o777).toString(8); } catch (e) { onDisk = `<${e.code}>`; }
    verdict = `reg=${reg.status} authed=${me ? me.status : 'n/a'} secretLen=${onDisk.length} valid64hex=${/^[0-9a-f]{64}$/.test(onDisk)} mode=${mode}`;
    child.kill();
  } catch (e) { verdict = `BOOT FAILED: ${String(e.message).slice(0, 120)}`; }
  console.log(`${label.padEnd(20)} ${verdict}`);
}

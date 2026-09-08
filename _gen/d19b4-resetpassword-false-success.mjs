// Red pass 3: the same class as 005 on the other route whose promise is about
// safety. "Password reset successfully! You can now log in with your new
// password." — with the data directory read-only, is the old password dead?
import { chmodSync } from 'node:fs';
import { startOwnServer, waitPortDead } from './harnesslib.mjs';

const WT = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/wt-struct-desktop';
const PORT = Number(process.env.PROBE_PORT || 4837);
const P1 = 'OldPassw0rd!23';
const P2 = 'NewPassw0rd!45';

const srv = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'rst' });
const call = async (base, path, body) => {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: j };
};
const u = `rst${String(Date.now()).slice(-6)}`, email = `${u}@example.com`;
console.log('register', (await call(srv.base, '/api/auth/register', { username: u, email, password: P1 })).status);
console.log('login with the OLD password', (await call(srv.base, '/api/auth/login', { email, password: P1 })).status);
const forgot = await call(srv.base, '/api/auth/forgot-password', { email });
const code = forgot.body.recoveryCode;
console.log('recovery code issued:', !!code);

// CONTROL=1 keeps the directory writable: the same flow must really reset.
if (!process.env.CONTROL) chmodSync(srv.dataDir, 0o555);
const reset = await call(srv.base, '/api/auth/reset-password', { email, code, newPassword: P2 });
if (!process.env.CONTROL) chmodSync(srv.dataDir, 0o755);
console.log(`\nRESET ANSWERED ${reset.status}: ${JSON.stringify(reset.body)}\n`);
console.log('same process — login with the NEW password:', (await call(srv.base, '/api/auth/login', { email, password: P2 })).status);
console.log('same process — login with the OLD password:', (await call(srv.base, '/api/auth/login', { email, password: P1 })).status);

srv.child.kill('SIGKILL');
await waitPortDead(PORT);
const srv2 = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'rst2', reuseDataDir: srv.dataDir });
const newAfter = await call(srv2.base, '/api/auth/login', { email, password: P2 });
const oldAfter = await call(srv2.base, '/api/auth/login', { email, password: P1 });
console.log(`\nAFTER RESTART — new password: ${newAfter.status}, OLD password: ${oldAfter.status}`);
console.log(`VERDICT: told "${String(reset.body.message || reset.body.error).slice(0, 80)}"; the old password ${oldAfter.status === 200 ? 'STILL WORKS' : 'is dead'}.`);
srv2.child.kill('SIGKILL');

// BLUE-LOOP-DESKTOP-22 — the gap RED-DESKTOP-21 noted but never confirmed:
// ensureLocalOwner() (server.ts:2155-2180) calls saveDB(db) and IGNORES its
// return value, then returns the owner regardless. saveDB returns false when
// the local file write fails (unwritable dir, ENOSPC, blocked persistence),
// and since STRUCT-DESKTOP-19 it only commits inMemoryDb AFTER the bytes land
// — so on a failed write the owner is in NEITHER the file NOR inMemoryDb, but
// resolveGameOwner() hands it back as the identity for the request.
//
// QUESTION: does that produce a user-visible wrong outcome — a save that is
// reported successful but is unrecoverable, or games filed under an owner the
// next request cannot see?
// Shipping condition: dist/server.cjs, env -i-style env, empty cwd, IS_ELECTRON.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WT = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(port, udd, extraEnv = {}) {
  const emptyCwd = mkdtempSync(join(tmpdir(), 'b22-elo-cwd-'));
  const child = spawn(process.execPath, [join(WT, 'dist/server.cjs')], {
    cwd: emptyCwd,
    env: { PATH: process.env.PATH, HOME: udd, NODE_ENV: 'production', PORT: String(port),
      IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: udd, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => log += d); child.stderr.on('data', (d) => log += d);
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return { child, log: () => log }; } catch {}
    await sleep(200);
  }
  throw new Error('server did not boot: ' + log);
}

const UA = { 'User-Agent': 'Electron/32 nash', 'Content-Type': 'application/json' };
const GAME = { name: 'ELO probe', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } };

async function scenario(label, port, prep) {
  const udd = mkdtempSync(join(tmpdir(), 'b22-elo-udd-'));
  const restore = prep ? prep(udd) : null;
  let s;
  try { s = await boot(port, udd); }
  catch (e) { console.log(`[${label}] server refused to boot: ${String(e).slice(0, 200)}`); if (restore) restore(); return; }
  try {
    const post = await fetch(`http://127.0.0.1:${port}/api/games`, { method: 'POST', headers: UA, body: JSON.stringify(GAME) });
    const pbody = await post.json().catch(() => null);
    const get = await fetch(`http://127.0.0.1:${port}/api/games`, { headers: UA });
    const gbody = await get.json().catch(() => null);
    const onDisk = existsSync(join(udd, 'db.json')) ? JSON.parse(readFileSync(join(udd, 'db.json'), 'utf-8')) : null;
    const claimedSaved = post.status === 200 && pbody?.success === true;
    const visibleNow = Array.isArray(gbody) && gbody.length > 0;
    const persisted = !!onDisk && onDisk.games?.length > 0;
    console.log(`[${label}] POST=${post.status} claimedSaved=${claimedSaved} | GET=${get.status} visibleNow=${visibleNow} `
      + `| onDisk games=${onDisk ? onDisk.games.length : 'NO FILE'} users=${onDisk ? onDisk.users.length : '-'}`);
    if (claimedSaved && !persisted) console.log(`  >>> HIT: told the user "${pbody?.message}" but nothing is on disk`);
    if (claimedSaved && !visibleNow) console.log('  >>> HIT: claimed saved but the very next GET cannot see it');
    // Restart: does what the user was told survive?
    s.child.kill('SIGKILL'); await sleep(400);
    if (restore) { restore(); }
    const s2 = await boot(port + 50, udd).catch((e) => { console.log(`  [${label}] restart refused: ${String(e).slice(0,120)}`); return null; });
    if (s2) {
      const g2 = await fetch(`http://127.0.0.1:${port + 50}/api/games`, { headers: UA });
      const b2 = await g2.json().catch(() => null);
      console.log(`  [${label}] after restart: GET=${g2.status} games=${Array.isArray(b2) ? b2.length : JSON.stringify(b2).slice(0,80)}`);
      if (claimedSaved && Array.isArray(b2) && b2.length === 0) console.log(`  >>> HIT: the save the user was told succeeded is GONE after restart`);
      s2.child.kill('SIGKILL');
    }
  } finally { try { s.child.kill('SIGKILL'); } catch {} }
}

// A: healthy baseline (control — must be a clean, persisted save)
await scenario('A-healthy', 4890, null);
// B: user-data dir read-only AFTER first boot created db.json — the classic
//    unwritable-save shape, now with the local owner NOT yet provisioned.
await scenario('B-readonly-dir', 4891, (udd) => {
  // Pre-create a db.json with NO local-owner user, then make the dir read-only
  // so ensureLocalOwner's saveDB(db) must fail.
  writeFileSync(join(udd, 'db.json'), JSON.stringify({ users: [], games: [] }, null, 2));
  chmodSync(udd, 0o500);
  return () => { try { chmodSync(udd, 0o700); } catch {} };
});
// C: db.json itself read-only (dir writable) — writeFileAtomicSync's rename path
await scenario('C-readonly-file', 4892, (udd) => {
  writeFileSync(join(udd, 'db.json'), JSON.stringify({ users: [], games: [] }, null, 2));
  chmodSync(join(udd, 'db.json'), 0o400);
  return () => { try { chmodSync(join(udd, 'db.json'), 0o600); } catch {} };
});
console.log('DONE');

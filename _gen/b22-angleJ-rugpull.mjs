// BLUE-LOOP-DESKTOP-22 — invented angle J: the user-data directory pulled out
// from under a RUNNING app.
//
// Real and unattacked: the data dir lives in ~/Library/Application Support, a
// place users clean out, sync tools relocate, and "reset the app" advice tells
// people to delete. The app holds `inMemoryDb` for the whole process lifetime,
// so the question is whether a save AFTER the rug-pull tells the truth.
//
// The bar is the brief's own defect class — "silent data loss or overwrite on
// a failed save", plus "a UI string that is a lie about state": a save must
// either land on disk or report failure. A 200 "Game saved successfully!" with
// nothing on disk is the defect.
//
// Shipping condition: dist/server.cjs, empty cwd, IS_ELECTRON=true,
// ELECTRON_USER_DATA_PATH set — dotenv must find no .env.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WT = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22';
const BUNDLE = path.join(WT, 'dist/server.cjs');
let port = Number(process.argv[2] || 4898);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const findings = [];
const hit = (w) => { findings.push(w); console.log(`>>> HIT ${w}`); };

async function boot(ud, p) {
  const child = spawn('node', [BUNDLE], {
    cwd: ud,
    env: { PATH: process.env.PATH, HOME: ud, NODE_ENV: 'production', PORT: String(p),
           IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: ud },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`exited early (${child.exitCode})\n${log}`);
    try { const r = await fetch(`http://127.0.0.1:${p}/api/health`); if (r.ok) return { child, log: () => log }; } catch {}
    await sleep(250);
  }
  child.kill(); throw new Error('never ready\n' + log);
}
const save = (p, name) => fetch(`http://127.0.0.1:${p}/api/games`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, description: 'rugpull probe',
    payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 } }),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) })).catch(e => ({ status: 'threw', json: String(e) }));
const list = (p) => fetch(`http://127.0.0.1:${p}/api/games`).then(r => r.json()).catch(() => null);
const onDisk = (ud) => { const f = path.join(ud, 'db.json');
  if (!existsSync(f)) return null; try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return 'unparseable'; } };

// A save is HONEST when the claim and the disk agree.
function judge(label, res, db, p) {
  const claimed = res.status === 200 && res.json?.success === true;
  const landed = !!db && db !== 'unparseable' && (db.games ?? []).some(g => g.name === p);
  console.log(`  ${label.padEnd(30)} status=${res.status} claimedSaved=${claimed} onDisk=${landed}`);
  if (claimed && !landed) hit(`${label}: claimed success but nothing on disk (silent data loss)`);
  return { claimed, landed };
}

// ── A: directory DELETED outright while the app runs ────────────────────────
{
  const ud = mkdtempSync(path.join(tmpdir(), 'b22-rug-a-'));
  const { child } = await boot(ud, port);
  const c = await save(port, 'A-control');
  const okControl = judge('CONTROL before the rug-pull', c, onDisk(ud), 'A-control');
  if (!okControl.landed) hit('the CONTROL save did not land — every case below would be vacuous');
  rmSync(ud, { recursive: true, force: true });
  console.log('  (data directory deleted)');
  const after = await save(port, 'A-after-delete');
  judge('save after rmdir', after, onDisk(ud), 'A-after-delete');
  const still = await list(port);
  console.log(`  GET after rmdir: ${Array.isArray(still) ? JSON.stringify(still.map(g => g.name)) : still}`);
  child.kill(); rmSync(ud, { recursive: true, force: true });
  port++;
}

// ── B: directory REPLACED by a file of the same name (a sync-tool shape) ────
{
  const ud = mkdtempSync(path.join(tmpdir(), 'b22-rug-b-'));
  const { child } = await boot(ud, port);
  const c = await save(port, 'B-control');
  judge('CONTROL before the swap', c, onDisk(ud), 'B-control');
  rmSync(ud, { recursive: true, force: true });
  writeFileSync(ud, 'not a directory');
  console.log('  (data directory replaced by a regular file)');
  const after = await save(port, 'B-after-swap');
  judge('save after dir->file swap', after, onDisk(ud), 'B-after-swap');
  child.kill(); rmSync(ud, { force: true });
  port++;
}

// ── C: directory deleted, then RECREATED empty (the "reset the app" shape).
// The nastiest case: the write can now succeed, so the honest outcomes are
// either a clean save or an honest failure — never a success that silently
// resurrects a stale in-memory list over the user's fresh state.
{
  const ud = mkdtempSync(path.join(tmpdir(), 'b22-rug-c-'));
  const { child } = await boot(ud, port);
  await save(port, 'C-first');
  rmSync(ud, { recursive: true, force: true });
  mkdirSync(ud, { recursive: true });
  console.log('  (data directory deleted and recreated empty)');
  const after = await save(port, 'C-after-recreate');
  const db = judge('save after recreate', after, onDisk(ud), 'C-after-recreate');
  if (db.landed) {
    const d = onDisk(ud);
    const names = (d?.games ?? []).map(g => g.name);
    console.log(`  db.json now holds: ${JSON.stringify(names)}`);
    const users = (d?.users ?? []).map(u => u.id);
    if (names.length && !users.includes('local-owner'))
      hit('a game was written with no owner row after the directory was recreated');
  }
  child.kill(); rmSync(ud, { recursive: true, force: true });
  port++;
}

// ── D: directory made UNWRITABLE mid-session (permissions changed under it) ──
{
  const ud = mkdtempSync(path.join(tmpdir(), 'b22-rug-d-'));
  const { child } = await boot(ud, port);
  await save(port, 'D-control');
  chmodSync(ud, 0o555);
  console.log('  (data directory made read-only)');
  const after = await save(port, 'D-after-chmod');
  judge('save while unwritable', after, onDisk(ud), 'D-after-chmod');
  chmodSync(ud, 0o755);
  const restored = await save(port, 'D-after-restore');
  const r = judge('save after permissions restored', restored, onDisk(ud), 'D-after-restore');
  if (!r.landed) hit('the app never recovered after the directory became writable again');
  child.kill(); rmSync(ud, { recursive: true, force: true });
  port++;
}

console.log('');
if (findings.length) { console.log(`>>> ${findings.length} HIT(s)`); process.exitCode = 2; }
else console.log('EMPTY: no rug-pull shape produced a success claim without a file on disk');

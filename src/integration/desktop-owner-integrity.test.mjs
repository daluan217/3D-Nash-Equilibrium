/* INTEGRATION — G7: referential integrity between games and their owner row
 * on disk, under the PACKAGED desktop condition.
 *
 * WHAT THIS IS ABOUT. `ensureLocalOwner()` (server.ts) pushes the owner and
 * calls `saveDB(db)` WITHOUT looking at the return value, so a failed owner
 * write is invisible to it. BLUE-LOOP-DESKTOP-22 hunted that with five vectors
 * (healthy control, read-only dir, read-only db.json, ENOSPC that later clears,
 * owner-write-fails-then-a-later-write-succeeds) and produced no orphan, so it
 * was recorded as a HOLE WITH ZERO REACHABLE INSTANCES, not a defect.
 *
 * The mechanism, which is why it holds: `loadDB()` returns the LIVE
 * `inMemoryDb` singleton, so `db.users.push(owner)` mutates it in place — the
 * owner is in memory whether or not that write landed — and `saveDBAwaited`
 * persists `{users: inMemoryDb?.users ?? [], games}`, reading users FRESH at
 * commit time. So any later successful game write carries the owner with it.
 *
 * WHY IT STILL GETS A GUARD. That is emergent, not asserted anywhere. If
 * `loadDB()` ever returns a copy, or the save path ever snapshots users at
 * entry instead of at commit, a db.json with games and no owner row becomes
 * reachable — games that render with no owner, and a `local-owner` id that
 * resolves to nothing. This file asserts the OUTCOME ("a game on disk always
 * has its owner row on disk"), so it stays true however the internals change.
 *
 * cwd: the server is booted from a temp directory, never the repo, so dotenv
 * finds no `.env` and the measurement stays on the packaged condition.
 *
 *   node src/integration/desktop-owner-integrity.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
let port = Number(process.env.OWNER_INTEGRITY_PORT || 3141);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function boot(userData, thePort, extraEnv = {}) {
  const child = spawn('node', [BUNDLE], {
    cwd: userData,
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT: String(thePort),
      IS_ELECTRON: 'true',
      ELECTRON_USER_DATA_PATH: userData,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})\n${log}`);
    try {
      const ctl = AbortController ? new AbortController() : null;
      const t = setTimeout(() => ctl?.abort(), 1500);
      const r = await fetch(`http://127.0.0.1:${thePort}/api/health`, { signal: ctl?.signal });
      clearTimeout(t);
      if (r.ok) return { child, log: () => log };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`server never became ready on ${thePort}\n${log}`);
}

const save = (p, name) => fetch(`http://127.0.0.1:${p}/api/games`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name, description: 'owner-integrity probe',
    payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 },
  }),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const readDb = (dir) => {
  const f = path.join(dir, 'db.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return 'unparseable'; }
};

// THE INVARIANT, in one place: every game on disk has its owner row on disk.
function orphans(db) {
  if (!db || db === 'unparseable') return [];
  const userIds = new Set((db.users ?? []).map((u) => u.id));
  return (db.games ?? []).filter((g) => !userIds.has(g.userId)).map((g) => `${g.name}->${g.userId}`);
}

// Self-test of the predicate itself, before it is trusted anywhere below. A
// checker that returns [] for everything would make every case pass.
record('PREDICATE SELF-TEST: an orphan game IS detected',
  orphans({ users: [{ id: 'local-owner' }], games: [{ name: 'g', userId: 'ghost' }] }).length === 1,
  'a game whose userId has no user row must be reported');
record('PREDICATE SELF-TEST: a well-formed db is NOT reported',
  orphans({ users: [{ id: 'local-owner' }], games: [{ name: 'g', userId: 'local-owner' }] }).length === 0,
  'a game whose owner row exists must not be reported');

async function main() {
  // ── CASE A: the ordinary path. Also the CONTROL for every case below: if a
  // save does not land here, "no orphans" elsewhere proves nothing, because
  // there would be no game on disk to be orphaned.
  {
    const ud = mkdtempSync(path.join(tmpdir(), 'b22-owner-a-'));
    const { child } = await boot(ud, port++);
    const r = await save(port - 1, 'A-healthy');
    const db = readDb(ud);
    record('CONTROL: a first save on a fresh install succeeds',
      r.status === 200 && r.json?.success === true, `status ${r.status}`);
    record('CONTROL: that game really is on disk (otherwise the check below is vacuous)',
      (db?.games ?? []).length === 1, `games=${(db?.games ?? []).length}`);
    record('the owner row is on disk alongside its game',
      (db?.users ?? []).some((u) => u.id === 'local-owner'), `users=${JSON.stringify((db?.users ?? []).map((u) => u.id))}`);
    record('no orphan games after an ordinary save', orphans(db).length === 0, JSON.stringify(orphans(db)));
    child.kill(); rmSync(ud, { recursive: true, force: true });
  }

  // ── CASE B: the owner's own write CANNOT land (db.json read-only at the
  // moment the owner is provisioned), then the file becomes writable and a
  // later save succeeds. This is the shape that would strand an owner: the
  // provisioning write is lost, and the question is whether the LATER write
  // carries the owner with it or persists a game against a user row that was
  // never written.
  {
    // The DIRECTORY, not the file. `writeFileAtomicSync` (server.ts) writes
    // `db.json.tmp-<pid>-<ts>` and renames it over the target, so a read-only
    // db.json changes nothing — the first draft of this case chmod'ed the file
    // and its own control failed with a 200, which is the product behaving
    // correctly and the harness being wrong. Both operations need a writable
    // directory, so that is what has to be taken away.
    const ud = mkdtempSync(path.join(tmpdir(), 'b22-owner-b-'));
    writeFileSync(path.join(ud, 'db.json'), JSON.stringify({ users: [], games: [] }));
    const { child } = await boot(ud, port++);
    chmodSync(ud, 0o555);
    const blocked = await save(port - 1, 'B-blocked');
    record('CONTROL: the save fails honestly while the data directory is read-only',
      blocked.status >= 500 && blocked.json?.success !== true, `status ${blocked.status}`);
    record('CONTROL: the blocked save left NOTHING on disk (no half-write)',
      !(readDb(ud)?.games ?? []).some((g) => g.name === 'B-blocked'),
      JSON.stringify((readDb(ud)?.games ?? []).map((g) => g.name)));
    chmodSync(ud, 0o755);
    const later = await save(port - 1, 'B-after-unlock');
    const db = readDb(ud);
    record('CONTROL: the later save succeeds once db.json is writable again',
      later.status === 200, `status ${later.status}`);
    record('CONTROL: the later game really is on disk',
      (db?.games ?? []).some((g) => g.name === 'B-after-unlock'), JSON.stringify((db?.games ?? []).map((g) => g.name)));
    record('a write that lands after a FAILED owner write still carries the owner row',
      (db?.users ?? []).some((u) => u.id === 'local-owner'),
      `users=${JSON.stringify((db?.users ?? []).map((u) => u.id))}`);
    record('no orphan games after a failed-then-successful write', orphans(db).length === 0, JSON.stringify(orphans(db)));
    child.kill(); rmSync(ud, { recursive: true, force: true });
  }

  // ── CASE C: restart. The owner row must survive a process restart rather
  // than existing only in the previous process's memory — the failure mode
  // where "it is in inMemoryDb" is mistaken for "it is persisted".
  {
    const ud = mkdtempSync(path.join(tmpdir(), 'b22-owner-c-'));
    const first = await boot(ud, port++);
    await save(port - 1, 'C-before-restart');
    first.child.kill();
    await new Promise((r) => setTimeout(r, 400));
    const second = await boot(ud, port++);
    const listed = await fetch(`http://127.0.0.1:${port - 1}/api/games`).then((r) => r.json()).catch(() => null);
    const db = readDb(ud);
    record('CONTROL: the game is still listed after a restart',
      Array.isArray(listed) && listed.some((g) => g.name === 'C-before-restart'),
      JSON.stringify(Array.isArray(listed) ? listed.map((g) => g.name) : listed));
    record('the owner row survives a restart on disk',
      (db?.users ?? []).some((u) => u.id === 'local-owner'), `users=${(db?.users ?? []).length}`);
    record('no orphan games after a restart', orphans(db).length === 0, JSON.stringify(orphans(db)));
    second.child.kill(); rmSync(ud, { recursive: true, force: true });
  }

  // SR-47: the count is DECLARED, not counted — a silently skipped block
  // otherwise prints "N/N checks passed" and exits 0. Measured: filtering one
  // data array to empty in desktop-dead-token-owner removed six checks and the
  // run said "37/37 checks passed".
  const EXPECTED_CHECKS = 15;
  if (results.length < EXPECTED_CHECKS) {
    console.error(`FAILED: only ${results.length} checks ran, expected at least ${EXPECTED_CHECKS} — a block was skipped.`);
    process.exit(1);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error('FAILED:\n' + failed.map((f) => `  - ${f.name} (${f.detail})`).join('\n'));
    process.exit(1);
  }
  console.log('PASS: every game on disk has its owner row on disk');
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });

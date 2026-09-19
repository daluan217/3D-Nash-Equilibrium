// BLUE-LOOP-DESKTOP-22 — invented angle K: TWO copies of the packaged app
// launched against the same user-data directory.
//
// desktop-concurrent-lock.test.mjs guards the SERVER half (a second
// dist/server.cjs refuses a directory another live process owns). The
// ELECTRON half — app.requestSingleInstanceLock() and the 'second-instance'
// handler — has only ever been checked by reading the source. This launches
// the real packaged binary twice and measures what happens.
//
// The bar, from the brief's defect classes: no silent data loss, no second
// window quietly serving a diverging copy, and no dead/blank window.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP = process.argv[2] ||
  '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22/dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const udd = mkdtempSync(path.join(tmpdir(), 'b22-twoinst-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const findings = [];
const hit = (w) => { findings.push(w); console.log(`>>> HIT ${w}`); };

function launch(tag) {
  const c = spawn(APP, [`--user-data-dir=${udd}`], {
    cwd: '/tmp',
    env: { IS_ELECTRON: 'true', NODE_ENV: 'production', PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  c.stdout.on('data', d => { log += d; });
  c.stderr.on('data', d => { log += d; });
  return { c, tag, log: () => log };
}
const portOf = (log) => { const m = /Express server running on http:\/\/127\.0\.0\.1:(\d+)/.exec(log); return m ? Number(m[1]) : null; };
const save = (p, name) => fetch(`http://127.0.0.1:${p}/api/games`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, description: 'two-instance probe',
    payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 } }),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) })).catch(e => ({ status: 'threw', json: String(e.name) }));
const disk = () => { const f = path.join(udd, 'db.json');
  if (!existsSync(f)) return null; try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return 'unparseable'; } };

const A = launch('A');
for (let i = 0; i < 60 && !portOf(A.log()); i++) await sleep(500);
const portA = portOf(A.log());
console.log('instance A port:', portA);
if (!portA) { A.c.kill(); console.error('INCONCLUSIVE: instance A never bound a port'); process.exit(3); }

// CONTROL: A works on its own. Without it, "B did no damage" is meaningless.
const a1 = await save(portA, 'K-A-first');
console.log('A save:', a1.status, 'onDisk:', (disk()?.games ?? []).map(g => g.name));
if (a1.status !== 200) hit('the FIRST instance could not save — every check below is vacuous');

// Second launch against the same directory.
const B = launch('B');
await sleep(9000);
const portB = portOf(B.log());
const bExited = B.c.exitCode !== null;
console.log(`instance B: exited=${bExited} exitCode=${B.c.exitCode} boundPort=${portB}`);
console.log('B log tail:', B.log().split('\n').filter(l => l.trim()).slice(-4).join(' | ').slice(0, 300));

// A second Electron instance must NOT come up as a rival server. Either the
// single-instance lock makes it quit (the design), or — if it does bind — it
// must not be a second writer against the same db.
if (portB && portB !== portA) {
  hit(`a second instance bound its OWN port ${portB} against the same data directory`);
  const b1 = await save(portB, 'K-B-rival');
  console.log('B save:', b1.status);
  const names = (disk()?.games ?? []).map(g => g.name);
  console.log('db.json after both wrote:', names);
  if (b1.status === 200 && !names.includes('K-A-first'))
    hit("the second instance's write ERASED the first instance's game (silent data loss)");
}

// A must still be healthy and must still hold its data.
const aAfter = await fetch(`http://127.0.0.1:${portA}/api/games`).then(r => r.json()).catch(e => 'threw:' + e.name);
console.log('A games after B launched:', Array.isArray(aAfter) ? aAfter.map(g => g.name) : aAfter);
if (!Array.isArray(aAfter)) hit('the first instance stopped answering after a second was launched');
else if (!aAfter.some(g => g.name === 'K-A-first')) hit("the first instance LOST its own game after a second was launched");

const a2 = await save(portA, 'K-A-second');
const finalNames = (disk()?.games ?? []).map(g => g.name);
console.log('A can still save:', a2.status, '| db.json:', finalNames);
if (a2.status !== 200) hit('the first instance could no longer save after a second was launched');
if (!finalNames.includes('K-A-first') || !finalNames.includes('K-A-second'))
  hit(`db.json lost a game: ${JSON.stringify(finalNames)}`);

console.log('');
if (findings.length) { console.log(`>>> ${findings.length} HIT(s)`); process.exitCode = 2; }
else console.log('EMPTY: a second instance never became a rival writer, and the first kept its data');
A.c.kill(); B.c.kill();
rmSync(udd, { recursive: true, force: true });

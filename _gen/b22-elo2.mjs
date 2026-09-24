// ensureLocalOwner gap, HARDER. Scenario B failed the POST because the game
// write also failed. The real question is whether the owner-provisioning write
// can fail while the GAME write succeeds — that would leave games filed under
// an owner that exists in neither db.json nor inMemoryDb.
// Vector: ENOSPC that clears. ensureLocalOwner()'s saveDB happens on the FIRST
// desktop request; if the volume is full at that instant but has room by the
// next request, the owner row is silently missing while games reference it.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const WT = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22';
const VOL = '/Volumes/RED21FULL';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'User-Agent': 'Electron/32 nash', 'Content-Type': 'application/json' };
const game = (n) => ({ name: 'elo2-' + n, payoffs: { a11: n, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } });

async function boot(port, udd) {
  const emptyCwd = mkdtempSync(join(tmpdir(), 'b22-elo2-cwd-'));
  const child = spawn(process.execPath, [join(WT, 'dist/server.cjs')], { cwd: emptyCwd,
    env: { PATH: process.env.PATH, HOME: udd, NODE_ENV: 'production', PORT: String(port), IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: udd },
    stdio: ['ignore','pipe','pipe'] });
  let log=''; child.stdout.on('data',d=>log+=d); child.stderr.on('data',d=>log+=d);
  for (let i=0;i<80;i++){ try{ const r=await fetch(`http://127.0.0.1:${port}/api/health`); if(r.ok) return {child,log:()=>log}; }catch{} await sleep(200);}
  throw new Error('no boot: '+log);
}
const udd = join(VOL, 'elo2-' + Date.now());
try { execSync(`rm -f ${VOL}/pad`); } catch {}
mkdirSync(udd, { recursive: true });
writeFileSync(join(udd, 'db.json'), JSON.stringify({ users: [], games: [] }, null, 2));
const s = await boot(4893, udd);
console.log('booted. filling the volume so the FIRST desktop request (which provisions the owner) hits ENOSPC');
try { execSync(`dd if=/dev/zero of=${VOL}/pad bs=1024 2>/dev/null`, { stdio: 'ignore' }); } catch {}
console.log('df:', execSync(`df -h ${VOL}`).toString().split('\n')[1]);
const r1 = await fetch('http://127.0.0.1:4893/api/games', { method:'POST', headers: UA, body: JSON.stringify(game(1)) });
const b1 = await r1.json().catch(()=>null);
console.log(`REQ1 (full disk): status=${r1.status} success=${b1?.success} msg=${(b1?.message||b1?.error||'').slice(0,60)}`);
// Now free the disk. The owner may have been "returned" but never persisted.
try { execSync(`rm -f ${VOL}/pad`); } catch {}
console.log('df after free:', execSync(`df -h ${VOL}`).toString().split('\n')[1]);
const r2 = await fetch('http://127.0.0.1:4893/api/games', { method:'POST', headers: UA, body: JSON.stringify(game(2)) });
const b2 = await r2.json().catch(()=>null);
console.log(`REQ2 (disk free): status=${r2.status} success=${b2?.success} gameUserId=${b2?.game?.userId}`);
const g = await fetch('http://127.0.0.1:4893/api/games', { headers: UA });
const gb = await g.json().catch(()=>null);
console.log(`GET: status=${g.status} count=${Array.isArray(gb)?gb.length:'?'}`);
const disk = existsSync(join(udd,'db.json')) ? JSON.parse(readFileSync(join(udd,'db.json'),'utf-8')) : null;
console.log('ON DISK users:', disk? JSON.stringify(disk.users.map(u=>u.id)) : 'NO FILE',
            '| games:', disk? disk.games.length : '-', '| game owners:', disk? JSON.stringify([...new Set(disk.games.map(x=>x.userId))]) : '-');
const orphan = disk && disk.games.some(x => !disk.users.some(u => u.id === x.userId));
console.log(orphan ? '>>> HIT: a game on disk references an owner that is NOT in db.users (orphaned by the ignored saveDB return)'
                   : 'EMPTY: every game on disk has its owner row on disk too');
// And after a restart, is the user's library still there and still theirs?
s.child.kill('SIGKILL'); await sleep(400);
const s2 = await boot(4894, udd);
const g2 = await fetch('http://127.0.0.1:4894/api/games', { headers: UA });
const gb2 = await g2.json().catch(()=>null);
console.log(`AFTER RESTART: GET=${g2.status} count=${Array.isArray(gb2)?gb2.length:JSON.stringify(gb2).slice(0,80)}`);
const claimed = (r1.status===200?1:0)+(r2.status===200?1:0);
console.log(`claimed-successful saves = ${claimed}; visible after restart = ${Array.isArray(gb2)?gb2.length:0}`);
if (Array.isArray(gb2) && gb2.length < claimed) console.log('>>> HIT: fewer games survive than the app said it saved');
s2.child.kill('SIGKILL');
console.log('DONE');

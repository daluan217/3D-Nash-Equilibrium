// WHY is the ensureLocalOwner saveDB-return gap not reachable? Establish the
// mechanism rather than inferring it from three clean outcomes.
// loadDB() returns the LIVE inMemoryDb singleton, so `db.users.push(owner)`
// mutates it IN PLACE — the owner is in memory whether or not saveDB's write
// landed, and saveDB's `inMemoryDb = db` commit-after-write is a no-op
// reassignment here. Consequence to test: after a FAILED owner write, does a
// LATER successful write persist the owner (self-heal), and is any response in
// between dishonest?
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const WT='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UA={'User-Agent':'Electron/32 nash','Content-Type':'application/json'};
const game=(n)=>({name:'elo3-'+n,payoffs:{a11:n,a12:0,a21:0,a22:1,b11:1,b12:0,b21:0,b22:1}});
const udd = mkdtempSync(join(tmpdir(),'b22-elo3-'));
writeFileSync(join(udd,'db.json'), JSON.stringify({users:[],games:[]},null,2));
const emptyCwd = mkdtempSync(join(tmpdir(),'b22-elo3-cwd-'));
const child = spawn(process.execPath,[join(WT,'dist/server.cjs')],{cwd:emptyCwd,
  env:{PATH:process.env.PATH,HOME:udd,NODE_ENV:'production',PORT:'4895',IS_ELECTRON:'true',ELECTRON_USER_DATA_PATH:udd},
  stdio:['ignore','pipe','pipe']});
let log=''; child.stdout.on('data',d=>log+=d); child.stderr.on('data',d=>log+=d);
for(let i=0;i<80;i++){ try{ const r=await fetch('http://127.0.0.1:4895/api/health'); if(r.ok) break; }catch{} await sleep(200);}
const read=()=>existsSync(join(udd,'db.json'))?JSON.parse(readFileSync(join(udd,'db.json'),'utf-8')):null;
console.log('disk at boot: users=', JSON.stringify(read().users.map(u=>u.id)));

// STEP 1: make the dir read-only so the owner-provisioning write MUST fail.
chmodSync(udd, 0o500);
const r1=await fetch('http://127.0.0.1:4895/api/games',{method:'POST',headers:UA,body:JSON.stringify(game(1))});
const b1=await r1.json().catch(()=>null);
console.log(`STEP1 (dir ro) POST=${r1.status} body=${JSON.stringify(b1).slice(0,90)}`);
chmodSync(udd, 0o700);
console.log('  disk users after the failed owner write:', JSON.stringify(read().users.map(u=>u.id)),
            '(owner NOT on disk — the saveDB return was ignored)');
// Is the owner nonetheless the identity the server hands out? A GET tells us.
const g1=await fetch('http://127.0.0.1:4895/api/games',{headers:UA});
console.log('  GET while owner is memory-only:', g1.status, JSON.stringify(await g1.json().catch(()=>null)).slice(0,60));

// STEP 2: disk writable again. Does the next save persist BOTH the game and
// the owner it references (self-heal), or ship an orphan?
const r2=await fetch('http://127.0.0.1:4895/api/games',{method:'POST',headers:UA,body:JSON.stringify(game(2))});
const b2=await r2.json().catch(()=>null);
console.log(`STEP2 (dir rw) POST=${r2.status} success=${b2?.success} owner=${b2?.game?.userId}`);
const d=read();
console.log('  disk users:', JSON.stringify(d.users.map(u=>u.id)), '| games:', d.games.length,
            '| owners:', JSON.stringify([...new Set(d.games.map(x=>x.userId))]));
const orphan = d.games.some(x=>!d.users.some(u=>u.id===x.userId));
console.log(orphan ? '>>> HIT: orphaned game (owner row never reached disk)'
                   : 'EMPTY: the later successful write carried the owner too — no orphan reachable');
// STEP 3: restart. Is the library intact and correctly owned?
child.kill('SIGKILL'); await sleep(400);
const c2=spawn(process.execPath,[join(WT,'dist/server.cjs')],{cwd:emptyCwd,
  env:{PATH:process.env.PATH,HOME:udd,NODE_ENV:'production',PORT:'4896',IS_ELECTRON:'true',ELECTRON_USER_DATA_PATH:udd},stdio:['ignore','pipe','pipe']});
for(let i=0;i<80;i++){ try{ const r=await fetch('http://127.0.0.1:4896/api/health'); if(r.ok) break; }catch{} await sleep(200);}
const g3=await fetch('http://127.0.0.1:4896/api/games',{headers:UA});
const b3=await g3.json().catch(()=>null);
const claimed=[r1,r2].filter(r=>r.status===200).length;
console.log(`STEP3 after restart: GET=${g3.status} count=${Array.isArray(b3)?b3.length:'?'} | claimed-successful saves=${claimed}`);
console.log(Array.isArray(b3)&&b3.length>=claimed ? 'EMPTY: everything the app said it saved survived'
                                                  : '>>> HIT: fewer games survive than were reported saved');
c2.kill('SIGKILL'); console.log('DONE');

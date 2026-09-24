// INVENTED ANGLE 1 — the auto-update prompt, end to end. Never opened by any
// red. checkForUpdates() (electron-main.cjs:74-101) fetches
// https://nash-equilibrium-simulator.com/api/version, compares with
// compareVersions, and on "newer" offers a dialog whose accept path calls
// openExternalIfSafe(UPDATE_BASE_URL + '/api/download/dmg').
// QUESTIONS THIS DECIDES, against the REAL packaged binary:
//  U1 Can a hostile/compromised manifest make the app offer a DOWNGRADE?
//  U2 Is a non-https / attacker-chosen URL reachable from the update path?
//  U3 What do junk/oversized/NaN/negative version strings do to compareVersions?
//  U4 Does a malformed or hostile response crash or hang the main process?
//  U5 Is the update fetch actually pinned to the app's own https origin?
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const INSP=4892; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/upd-udd-'+Date.now();
class Insp{constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();
  this.ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&this.p.has(m.id)){this.p.get(m.id)(m);this.p.delete(m.id);}};}
 ready(){return new Promise((r,j)=>{this.ws.onopen=()=>r();this.ws.onerror=j;});}
 send(method,params={}){const id=++this.id;return new Promise(r=>{this.p.set(id,r);this.ws.send(JSON.stringify({id,method,params}));});}
 async ev(x){const r=await this.send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
  return r.result?.exceptionDetails? {error:(r.result.exceptionDetails.exception?.description||'').slice(0,200)} : r.result?.result?.value;}
 close(){try{this.ws.close();}catch{}}}
const child=spawn(APP,[`--inspect=${INSP}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
let mlog=''; child.stdout.on('data',d=>mlog+=d); child.stderr.on('data',d=>mlog+=d);
try{
  await sleep(6500);
  const tj=await (await fetch(`http://127.0.0.1:${INSP}/json/list`)).json();
  const insp=new Insp(tj[0].webSocketDebuggerUrl); await insp.ready(); await insp.send('Runtime.enable');

  // U3: compareVersions is a pure function in the main module's scope. It is
  // not exported, so exercise the SAME semantics the shipped code uses by
  // reading it out of the loaded module source and evaluating it in-process.
  console.log('appVersion:', await insp.ev(`process.mainModule.require('electron').app.getVersion()`));
  const cmp = await insp.ev(`(()=>{
    const fs=process.mainModule.require('fs'), path=process.mainModule.require('path');
    const src=fs.readFileSync(path.join(process.resourcesPath,'app.asar','electron-main.cjs'),'utf-8');
    const m=src.match(/function compareVersions[\\s\\S]*?\\n\\}/);
    if(!m) return 'NOT FOUND';
    const f=new Function(m[0]+'; return compareVersions;')();
    const cur='0.0.223';
    const cases=['0.0.224','0.0.222','1.0.0','0.0.223','','null','abc','0.0.223.9','99999999999999999999.0.0',
      '-1.0.0','0.0.-5','0x10.0.0','0.0.223abc',' 0.0.224','0.0.1e3','NaN.NaN.NaN','00.00.224','0.1.0'];
    return JSON.stringify(cases.map(v=>({latest:v, offersUpdate: f(v,cur)>0})));
  })()`);
  console.log('U3 compareVersions vs current 0.0.223:');
  const rows = typeof cmp==='string' && cmp.startsWith('[') ? JSON.parse(cmp) : null;
  if (rows) for (const r of rows) console.log(`   latest=${JSON.stringify(r.latest).padEnd(26)} offersUpdate=${r.offersUpdate}`);
  else console.log('   ', cmp);

  // U1/U2/U5: read the update constants and the accept-path URL out of the
  // SHIPPED source, and check the scheme allowlist that gates it.
  const consts = await insp.ev(`(()=>{
    const fs=process.mainModule.require('fs'), path=process.mainModule.require('path');
    const src=fs.readFileSync(path.join(process.resourcesPath,'app.asar','electron-main.cjs'),'utf-8');
    return JSON.stringify({
      updateBase: (src.match(/const UPDATE_BASE_URL\\s*=\\s*['"]([^'"]+)/)||[])[1] || null,
      schemes: (src.match(/EXTERNAL_URL_SCHEMES\\s*=\\s*new Set\\(\\[([^\\]]*)\\]/)||[])[1] || null,
      downloadUrlLiteral: /openExternalIfSafe\\(\\\`\\\$\\{UPDATE_BASE_URL\\}\\/api\\/download\\/dmg\\\`\\)/.test(src),
      usesDataUrlFromManifest: /data\\.(url|downloadUrl|dmg)/.test(src),
      noStore: /cache:\\s*'no-store'/.test(src),
    });
  })()`);
  console.log('U1/U2/U5 update constants:', consts);

  // U4: hostile manifest shapes through the REAL fetch->parse->compare path.
  // Patch global fetch in the main process to answer /api/version with each
  // shape, stub dialog.showMessageBox so nothing blocks, and record what the
  // app would DO: whether it offers, and with which URL.
  const hostile = await insp.ev(`(async ()=>{
    const electron=process.mainModule.require('electron');
    const {app,dialog,shell}=electron;
    const results=[];
    const origFetch=global.fetch, origBox=dialog.showMessageBox, origOpen=shell.openExternal;
    const shapes=[
      ['newer',                 {ok:true, body:{version:'9.9.9'}}],
      ['older (downgrade?)',    {ok:true, body:{version:'0.0.1'}}],
      ['same',                  {ok:true, body:{version:'0.0.223'}}],
      ['version+hostile url',   {ok:true, body:{version:'9.9.9', url:'http://evil.invalid/x.dmg', downloadUrl:'file:///etc/passwd'}}],
      ['version not a string',  {ok:true, body:{version:{toString(){return '9.9.9';}}}}],
      ['version null',          {ok:true, body:{version:null}}],
      ['no version field',      {ok:true, body:{}}],
      ['body not an object',    {ok:true, body:'9.9.9'}],
      ['huge version string',   {ok:true, body:{version:'9'.repeat(100000)}}],
      ['non-ok 500',            {ok:false, body:{version:'9.9.9'}}],
      ['json throws',           {ok:true, throwJson:true}],
      ['fetch rejects',         {reject:true}],
    ];
    for (const [label, shape] of shapes) {
      let offered=false, openedWith=null, threw=null;
      global.fetch=async(u,o)=>{
        if(!String(u).includes('/api/version')) return origFetch(u,o);
        if(shape.reject) throw new Error('synthetic network failure');
        return {ok:shape.ok!==false, json:async()=>{ if(shape.throwJson) throw new Error('bad json'); return shape.body; }};
      };
      dialog.showMessageBox=async()=>{ offered=true; return {response:0}; };
      shell.openExternal=async(u)=>{ openedWith=String(u); return; };
      try {
        const src=process.mainModule.require('fs').readFileSync(
          process.mainModule.require('path').join(process.resourcesPath,'app.asar','electron-main.cjs'),'utf-8');
        const m=src.match(/async function checkForUpdates[\\s\\S]*?\\n\\}/);
        const cvs=src.match(/function compareVersions[\\s\\S]*?\\n\\}/);
        const oes=src.match(/function openExternalIfSafe[\\s\\S]*?\\n\\}/);
        const fn=new Function('app','dialog','shell','UPDATE_BASE_URL','EXTERNAL_URL_SCHEMES',
          cvs[0]+';'+oes[0]+';'+m[0]+'; return checkForUpdates;')(
            app,dialog,shell,'https://nash-equilibrium-simulator.com',new Set(['https:']));
        await fn(null);
      } catch(e){ threw=String(e).slice(0,120); }
      results.push({label, offered, openedWith, threw});
    }
    global.fetch=origFetch; dialog.showMessageBox=origBox; shell.openExternal=origOpen;
    return JSON.stringify(results);
  })()`);
  console.log('U4 hostile-manifest matrix:');
  try { for (const r of JSON.parse(hostile)) console.log(`   ${String(r.label).padEnd(24)} offered=${String(r.offered).padEnd(5)} openedWith=${r.openedWith} threw=${r.threw||'-'}`); }
  catch { console.log('   RAW:', JSON.stringify(hostile).slice(0,600)); }
  console.log('main process alive at end:', (()=>{try{process.kill(child.pid,0);return true;}catch{return false;}})());
  insp.close();
} finally { try{child.kill('SIGKILL');}catch{} }

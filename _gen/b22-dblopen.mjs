// PROBE: electron-main.cjs:64-70 registers keepInApp on BOTH 'will-navigate'
// AND 'will-frame-navigate'. Electron fires will-frame-navigate for EVERY
// frame INCLUDING the main frame, and will-navigate for the main frame too.
// So ONE click on an external link may call shell.openExternal TWICE ->
// two browser tabs / two OS handler launches for one user click.
// MEASURE IT: instrument shell.openExternal in the packaged main process and
// count calls per single click.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { chromium } from 'playwright';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const CDP=4895, INSP=4892; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/dblopen-udd-'+Date.now();
class Insp{constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();
  this.ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&this.p.has(m.id)){this.p.get(m.id)(m);this.p.delete(m.id);}};}
 ready(){return new Promise((r,j)=>{this.ws.onopen=()=>r();this.ws.onerror=j;});}
 send(method,params={}){const id=++this.id;return new Promise(r=>{this.p.set(id,r);this.ws.send(JSON.stringify({id,method,params}));});}
 async ev(x){const r=await this.send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
  return r.result?.exceptionDetails? {error:r.result.exceptionDetails.exception?.description} : r.result?.result?.value;}
 close(){try{this.ws.close();}catch{}}}
const child=spawn(APP,[`--remote-debugging-port=${CDP}`,`--inspect=${INSP}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
try{
  await sleep(6000);
  const tj = await (await fetch(`http://127.0.0.1:${INSP}/json/list`)).json();
  const insp = new Insp(tj[0].webSocketDebuggerUrl); await insp.ready();
  await insp.send('Runtime.enable');
  // Instrument shell.openExternal so nothing actually launches a browser, and
  // every call is recorded with its URL. Same module object the app holds.
  const armed = await insp.ev(`(()=>{const sh=process.mainModule.require('electron').shell;
    if(!global.__oeCalls){global.__oeCalls=[]; const orig=sh.openExternal.bind(sh);
      sh.openExternal=(u,o)=>{global.__oeCalls.push(String(u)); return Promise.resolve();};}
    return 'armed';})()`);
  console.log('instrumentation:', armed);
  let b=null; for(let i=0;i<30;i++){ try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`); break;}catch{ await sleep(500);} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(2000);
  const cdp = await ctx.newCDPSession(page);
  const raw = async (x,y)=>{ await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1}); };

  for (const [name, setup] of [
    ['a-href main-frame click', `const a=document.createElement('a'); a.id='t'; a.href='https://example.com/CASE1'; a.textContent='EXT';
       a.style.cssText='position:fixed;top:4px;left:4px;z-index:2147483647;background:#fff;padding:12px;font-size:20px'; document.body.appendChild(a);`],
    ['target=_blank click',     `const a=document.createElement('a'); a.id='t'; a.href='https://example.com/CASE2'; a.target='_blank'; a.textContent='EXT';
       a.style.cssText='position:fixed;top:4px;left:4px;z-index:2147483647;background:#fff;padding:12px;font-size:20px'; document.body.appendChild(a);`],
  ]) {
    await insp.ev(`(()=>{global.__oeCalls=[];return 'reset';})()`);
    const pt = await page.evaluate((code)=>{ const o=document.getElementById('t'); if(o)o.remove();
      new Function(code)(); const r=document.getElementById('t').getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2}; }, setup);
    await raw(pt.x, pt.y);
    await sleep(2000);
    const calls = await insp.ev(`JSON.stringify(global.__oeCalls)`);
    const arr = JSON.parse(calls);
    console.log(`${name.padEnd(26)} openExternal calls = ${arr.length} ${JSON.stringify(arr)} ${arr.length>1?'  <<<< DOUBLE OPEN':''}`);
  }
  // location.href assignment (main-frame navigation, no anchor)
  await insp.ev(`(()=>{global.__oeCalls=[];return 'reset';})()`);
  await page.evaluate(()=>{ window.location.href='https://example.com/CASE3'; }).catch(()=>{});
  await sleep(2000);
  const c3 = JSON.parse(await insp.ev(`JSON.stringify(global.__oeCalls)`));
  console.log(`${'location.href assignment'.padEnd(26)} openExternal calls = ${c3.length} ${JSON.stringify(c3)} ${c3.length>1?'  <<<< DOUBLE OPEN':''}`);
  // window.open (setWindowOpenHandler path only)
  await insp.ev(`(()=>{global.__oeCalls=[];return 'reset';})()`);
  await page.evaluate(()=>{ window.open('https://example.com/CASE4','_blank'); }).catch(()=>{});
  await sleep(2000);
  const c4 = JSON.parse(await insp.ev(`JSON.stringify(global.__oeCalls)`));
  console.log(`${'window.open'.padEnd(26)} openExternal calls = ${c4.length} ${JSON.stringify(c4)} ${c4.length>1?'  <<<< DOUBLE OPEN':''}`);
  insp.close();
} finally { try{child.kill('SIGKILL');}catch{} }

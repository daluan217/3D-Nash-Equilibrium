// CONTROL 11 — PRODUCT question behind control 9's R3 timeout: Playwright's
// barrier is "a navigation was scheduled and never finished". If Chromium
// agrees, the window stays in a LOADING state forever after a user clicks an
// external link — a visible spinner/stuck state, a real defect. Read
// webContents.isLoading() from the MAIN process (the authoritative signal).
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { chromium } from 'playwright';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const CDP=4895, INSP=4892; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ctl11-udd-'+Date.now();
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
  let b=null; for(let i=0;i<30;i++){ try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`); break;}catch{ await sleep(500);} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(2000);
  const wcState = () => insp.ev(`(()=>{const {BrowserWindow}=process.mainModule.require('electron');
    const w=BrowserWindow.getAllWindows()[0];
    return JSON.stringify({isLoading:w.webContents.isLoading(),isWaitingForResponse:w.webContents.isWaitingForResponse(),url:w.webContents.getURL()});})()`);
  console.log('BEFORE:', await wcState());
  const cdp = await ctx.newCDPSession(page);
  const ap = await page.evaluate(()=>{
    const a=document.createElement('a'); a.id='ctl11'; a.href='https://example.com/ctl11'; a.textContent='EXT';
    a.style.cssText='position:fixed;top:4px;left:4px;z-index:2147483647;background:#fff;padding:12px;font-size:20px';
    document.body.appendChild(a); const r=a.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
  });
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:ap.x,y:ap.y,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:ap.x,y:ap.y,button:'left',clickCount:1});
  for (const t of [300,1000,3000,8000]) { await sleep(t===300?300:t-(t===1000?300:t===3000?1000:3000));
    console.log(`t=${t}ms:`, await wcState(), '| renderer readyState=', await page.evaluate(()=>document.readyState)); }
  insp.close();
} finally { try{child.kill('SIGKILL');}catch{} }

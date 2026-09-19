// INVENTED ANGLE D — "uncaught throw in a main-process handler" (a named
// defect class in my brief) via the ONE IPC channel the app exposes.
//
// electron-main.cjs:345-349:
//   ipcMain.on('set-background-color', (event, color) => {
//     if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
//     const win = BrowserWindow.fromWebContents(event.sender);
//     if (win) win.setBackgroundColor(color);
//   });
//
// The `if (win)` null-check does NOT cover a window that is non-null but
// DESTROYED: Electron throws "Object has been destroyed" on a method call
// against a destroyed BrowserWindow, and a throw inside an ipcMain listener
// is an uncaught exception in the MAIN process — which takes the whole app
// down, not just a tab. The renderer calls this on every theme change, and a
// theme change racing a window close is an ordinary user action (Cmd+W while
// the OS is mid theme-switch, or a close during the dark-mode transition).
//
// Also fuzzes the sender identity: the handler resolves the window FROM the
// sender, so a child webContents must only ever affect its own window.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { chromium } from 'playwright';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22/dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const CDP=4895, INSP=4892; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ipcrace-udd-'+Date.now();
class Insp{constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();
  this.ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&this.p.has(m.id)){this.p.get(m.id)(m);this.p.delete(m.id);}};}
 ready(){return new Promise((r,j)=>{this.ws.onopen=()=>r();this.ws.onerror=j;});}
 send(method,params={}){const id=++this.id;return new Promise(r=>{this.p.set(id,r);this.ws.send(JSON.stringify({id,method,params}));});}
 async ev(x){const r=await this.send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
  return r.result?.exceptionDetails? {error:(r.result.exceptionDetails.exception?.description||'').slice(0,240)} : r.result?.result?.value;}
 close(){try{this.ws.close();}catch{}}}
const child=spawn(APP,[`--remote-debugging-port=${CDP}`,`--inspect=${INSP}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
let mlog=''; child.stdout.on('data',d=>mlog+=d); child.stderr.on('data',d=>mlog+=d);
const alive=()=>{try{process.kill(child.pid,0);return true;}catch{return false;}};
try{
  await sleep(6500);
  const tj=await (await fetch(`http://127.0.0.1:${INSP}/json/list`)).json();
  const insp=new Insp(tj[0].webSocketDebuggerUrl); await insp.ready(); await insp.send('Runtime.enable');
  // Record any uncaught exception in the MAIN process.
  await insp.ev(`(()=>{global.__unc=[]; process.on('uncaughtException',(e)=>global.__unc.push(String(e&&e.message).slice(0,160))); return 1;})()`);

  // D1 — does a DESTROYED (but non-null) window make the handler throw?
  // Drive the exact handler body against a genuinely destroyed window.
  const d1 = await insp.ev(`(()=>{
    const {BrowserWindow}=process.mainModule.require('electron');
    const w=new BrowserWindow({show:false});
    const wc=w.webContents;
    w.destroy();
    const resolved=BrowserWindow.fromWebContents(wc);
    let nullCheckPasses=false, threw=null;
    try {
      if (resolved) { nullCheckPasses=true; resolved.setBackgroundColor('#123456'); }
    } catch(e){ threw=String(e.message).slice(0,120); }
    return JSON.stringify({fromWebContentsReturned: resolved===null?'null':'a window',
      nullCheckWouldPass:nullCheckPasses, threw});
  })()`);
  console.log('D1 destroyed-window handler body:', d1);

  // D2 — the REAL race, through the REAL IPC channel: hammer
  // nashDesktop.setBackgroundColor from the renderer while the window closes.
  let b=null; for(let i=0;i<30;i++){ try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`); break;}catch{ await sleep(500);} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(1500);
  // Fire a continuous stream of valid colour messages, then close the window
  // underneath it. Fire-and-forget so the renderer going away cannot hang us.
  page.evaluate(()=>{ let i=0; const t=setInterval(()=>{
      try { window.nashDesktop.setBackgroundColor('#' + (i++%2?'020617':'f8fafc')); } catch(e){}
    }, 1); setTimeout(()=>clearInterval(t), 4000); }).catch(()=>{});
  await sleep(250);
  insp.send('Runtime.evaluate',{expression:`(()=>{const {BrowserWindow}=process.mainModule.require('electron');
     const w=BrowserWindow.getAllWindows()[0]; if(w) w.close(); return 'closing';})()`,returnByValue:true}).catch(()=>{});
  await sleep(4000);
  console.log('D2 main alive after close-during-IPC-storm:', alive());
  const unc = await insp.ev(`JSON.stringify(global.__unc||[])`);
  console.log('D2 uncaught exceptions in MAIN:', unc);

  // D3 — reopen (macOS activate) and confirm the app is still usable.
  await insp.ev(`(()=>{const {app}=process.mainModule.require('electron'); app.emit('activate'); return 'emitted';})()`);
  await sleep(2500);
  const wins = await insp.ev(`(()=>{const {BrowserWindow}=process.mainModule.require('electron');
    return JSON.stringify({count:BrowserWindow.getAllWindows().length});})()`);
  console.log('D3 windows after activate:', wins, '| main alive:', alive());
  const unc2 = await insp.ev(`JSON.stringify(global.__unc||[])`);
  console.log('D3 uncaught exceptions in MAIN (cumulative):', unc2);
  console.log(mlog.match(/uncaught|Uncaught|Object has been destroyed/g) ? '>>> check main log' : 'main log clean of destroyed/uncaught');
  insp.close();
} finally { try{child.kill('SIGKILL');}catch{} }

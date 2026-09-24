// VECTOR 16 INVESTIGATION: a file:// navigation attempt produces NO "Refused
// to open an external URL with an unsupported scheme: file:" log on the live
// 0.0.223 DMG. Decide WHY: (a) will-navigate fires and the allowlist refuses
// (log expected), or (b) will-navigate never fires because Chromium blocked
// the http->file navigation in the renderer first.
// Instruments the MAIN process: records every will-navigate /
// will-frame-navigate / setWindowOpenHandler event and every openExternal call.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { chromium } from 'playwright';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const CDP=4895, INSP=4892; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/file16-udd-'+Date.now();
class Insp{constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();
  this.ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&this.p.has(m.id)){this.p.get(m.id)(m);this.p.delete(m.id);}};}
 ready(){return new Promise((r,j)=>{this.ws.onopen=()=>r();this.ws.onerror=j;});}
 send(method,params={}){const id=++this.id;return new Promise(r=>{this.p.set(id,r);this.ws.send(JSON.stringify({id,method,params}));});}
 async ev(x){const r=await this.send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
  return r.result?.exceptionDetails? {error:r.result.exceptionDetails.exception?.description} : r.result?.result?.value;}
 close(){try{this.ws.close();}catch{}}}
const child=spawn(APP,[`--remote-debugging-port=${CDP}`,`--inspect=${INSP}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
let mlog=''; child.stdout.on('data',d=>mlog+=d); child.stderr.on('data',d=>mlog+=d);
try{
  await sleep(6000);
  const tj = await (await fetch(`http://127.0.0.1:${INSP}/json/list`)).json();
  const insp = new Insp(tj[0].webSocketDebuggerUrl); await insp.ready();
  await insp.send('Runtime.enable');
  console.log('arm:', await insp.ev(`(()=>{
    const {BrowserWindow, shell}=process.mainModule.require('electron');
    const w=BrowserWindow.getAllWindows()[0];
    global.__ev=[];
    w.webContents.on('will-navigate',(e,u)=>global.__ev.push('will-navigate:'+u));
    w.webContents.on('will-frame-navigate',(e,d)=>global.__ev.push('will-frame-navigate:'+((d&&d.url)||(e&&e.url))));
    w.webContents.on('did-start-navigation',(e,u)=>global.__ev.push('did-start-navigation:'+u));
    w.webContents.on('did-fail-load',(e,code,desc,u)=>global.__ev.push('did-fail-load:'+code+':'+desc+':'+u));
    if(!global.__oe){global.__oe=[]; const o=shell.openExternal.bind(shell);
      shell.openExternal=(u)=>{global.__oe.push(String(u)); return Promise.resolve();};}
    return 'armed';})()`));
  let b=null; for(let i=0;i<30;i++){ try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`); break;}catch{ await sleep(500);} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(2000);
  const conmsgs=[]; page.on('console', m=>conmsgs.push(m.type()+': '+m.text().slice(0,140)));
  const cdp = await ctx.newCDPSession(page);
  const reset = ()=>insp.ev(`(()=>{global.__ev=[];global.__oe=[];return 1;})()`);
  const dump = async(tag)=>{
    const ev=JSON.parse(await insp.ev(`JSON.stringify(global.__ev)`));
    const oe=JSON.parse(await insp.ev(`JSON.stringify(global.__oe)`));
    console.log(`[${tag}] mainEvents=${JSON.stringify(ev)} openExternal=${JSON.stringify(oe)} url=${page.url()} pages=${ctx.pages().length}`);
    console.log(`[${tag}] renderer console: ${JSON.stringify(conmsgs.slice(-3))}`); conmsgs.length=0;
  };
  for (const [tag, href] of [['file-anchor','file:///etc/passwd'], ['smb-anchor','smb://attacker/share'], ['tel-anchor','tel:+15555555555']]) {
    await reset();
    const pt = await page.evaluate((h)=>{ const o=document.getElementById('v16'); if(o)o.remove();
      const a=document.createElement('a'); a.id='v16'; a.href=h; a.textContent='X';
      a.style.cssText='position:fixed;top:8px;left:8px;z-index:2147483647;background:#fff;padding:12px;font-size:20px';
      document.body.appendChild(a); const r=a.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; }, href);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:pt.x,y:pt.y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pt.x,y:pt.y,button:'left',clickCount:1});
    await sleep(1800); await dump(tag);
  }
  for (const [tag, code] of [
    ['file-location', `window.location.href='file:///etc/passwd'`],
    ['file-windowopen', `window.open('file:///etc/passwd','_blank')`],
    ['file-assign', `window.location.assign('file:///etc/passwd')`],
    ['file-replace', `window.location.replace('file:///etc/passwd')`],
    ['file-iframe', `{const f=document.createElement('iframe');f.src='file:///etc/passwd';document.body.appendChild(f);}`],
    ['file-form', `{const fm=document.createElement('form');fm.action='file:///etc/passwd';fm.method='GET';document.body.appendChild(fm);fm.submit();}`],
  ]) {
    await reset();
    await page.evaluate(`(()=>{try{${code}}catch(e){window.__e=String(e);}})()`).catch(e=>console.log('  eval threw:',e.message.split('\n')[0]));
    await sleep(1800); await dump(tag);
  }
  insp.close();
  console.log('MAIN STDOUT Refused lines:', mlog.split('\n').filter(l=>/Refused/.test(l)).join(' | ')||'(none)');
} finally { try{child.kill('SIGKILL');}catch{} }

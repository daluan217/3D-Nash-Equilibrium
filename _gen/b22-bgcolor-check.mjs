// Regression check for the angle-G permission policy: the set-background-color
// IPC (drag-resize theming) must still take effect. It goes through the preload
// bridge, not a permission, but the policy now runs on every webContents, so
// this proves it did not disturb the path.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22/dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT=Number(process.argv[2]||4893), IPORT=PORT+1;
const udd=mkdtempSync(join(tmpdir(),'b22-bg-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const child=spawn(APP,[`--remote-debugging-port=${PORT}`,`--inspect=${IPORT}`,`--user-data-dir=${udd}`],
 {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
let browser; for(let i=0;i<40&&!browser;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);}catch{await sleep(500);}}
if(!browser){child.kill();console.error('no CDP');process.exit(1);}
const ctx=browser.contexts()[0]; let page;
for(let i=0;i<30&&!page;i++){page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1'));if(!page)await sleep(500);}
if(!page){child.kill();console.error('no page');process.exit(1);}
const bridge=await page.evaluate(()=>typeof window.nashDesktop?.setBackgroundColor);
console.log('bridge function present:', bridge);
const sent=await page.evaluate(()=>{try{window.nashDesktop.setBackgroundColor('#123456');return 'sent';}catch(e){return 'threw '+e.name;}});
console.log('valid colour send:', sent);
await sleep(800);
// Read the NATIVE background from the main process — the only place the effect
// is observable; the renderer cannot see it.
const { default: http } = await import('node:http');
const res = await new Promise((r)=>http.get(`http://127.0.0.1:${IPORT}/json/list`,(x)=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>r(d));}).on('error',()=>r(null)));
let wsUrl=null; try{ wsUrl=JSON.parse(res)[0]?.webSocketDebuggerUrl; }catch{}
if(!wsUrl){ console.log('(no inspector socket; reporting the send only)'); }
else {
  const { WebSocket } = await import('ws').catch(()=>({WebSocket:null}));
  if(!WebSocket){ console.log('(ws module unavailable; reporting the send only)'); }
  else {
    const sock=new WebSocket(wsUrl); await new Promise(r=>sock.on('open',r));
    const evalIn=(expr)=>new Promise((r)=>{const id=Math.floor(Math.random()*1e6);
      sock.on('message',function h(m){const j=JSON.parse(m);if(j.id===id){sock.off('message',h);r(j.result?.result);}});
      sock.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true,awaitPromise:true}}));});
    const bg=await evalIn("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].getBackgroundColor()");
    console.log('native backgroundColor after the IPC:', JSON.stringify(bg?.value));
    const applied = String(bg?.value||'').toLowerCase().includes('123456');
    console.log(applied ? '\nEMPTY: the set-background-color IPC still takes effect'
                        : '\n>>> HIT: the IPC no longer applies the colour');
    process.exitCode = applied?0:2;
    sock.close();
  }
}
await browser.close().catch(()=>{}); child.kill();

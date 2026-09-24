// CONTROL for the 16-vector harness's vector-1 timeout: is the hang the APP
// blocking navigation (good) or Playwright unable to observe navigation at all
// (harness broken)? Arm A: external href -> must be blocked. Arm B: SAME-ORIGIN
// href -> must navigate and the click must RESOLVE. If B resolves and A times
// out, the timeout is the guard working, not a broken harness.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT=4895; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const child=spawn(APP,[`--remote-debugging-port=${PORT}`,`--user-data-dir=/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ctl-udd-${Date.now()}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
let log=''; child.stdout.on('data',d=>log+=d); child.stderr.on('data',d=>log+=d);
try{
  let b=null; for(let i=0;i<40;i++){ await sleep(500); try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break;}catch{} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(1500);
  const initial=page.url(); console.log('initial',initial);
  for (const [arm,href] of [['A-external','https://example.com/ctl'],['B-sameorigin-fullnav',initial+'?ctl=1'],['C-sameorigin-hash',initial+'#ctl-same']]) {
    await page.evaluate((h)=>{ const old=document.getElementById('ctl-a'); if(old)old.remove();
      const a=document.createElement('a'); a.id='ctl-a'; a.href=h; a.textContent='x'; document.body.appendChild(a); }, href);
    const t0=Date.now(); let outcome='resolved';
    try { await page.click('#ctl-a',{timeout:5000}); } catch(e){ outcome='TIMEOUT:'+e.name; }
    // second measurement: does dispatchEvent-based click (no nav wait) work?
    await sleep(800);
    console.log(arm,'href='+href,'clickOutcome='+outcome,'ms='+(Date.now()-t0),'urlAfter='+page.url(),'pages='+ctx.pages().length);
  }
} finally { try{child.kill('SIGKILL');}catch{} }

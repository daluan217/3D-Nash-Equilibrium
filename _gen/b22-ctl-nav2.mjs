// CONTROL 2: separate "the app blocks navigation" from "playwright's click
// nav-wait is broken". Arms use DIFFERENT navigation mechanisms.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT=4895; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ctl2-udd-'+Date.now();
const child=spawn(APP,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
let log=''; child.stdout.on('data',d=>log+=d); child.stderr.on('data',d=>log+=d);
try{
  let b=null; for(let i=0;i<40;i++){ await sleep(500); try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break;}catch{} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(1500);
  const initial=page.url(); console.log('initial',initial);

  // Arm 1: location.href to SAME ORIGIN (must succeed — keepInApp lets it through)
  await page.evaluate((u)=>{ window.location.href=u; }, initial+'?ctl=1').catch(e=>console.log('eval err',e.message));
  await sleep(2500);
  console.log('ARM1 same-origin location.href -> url=', page.url(), ' EXPECT ?ctl=1');

  // Arm 2: location.href to EXTERNAL (must be blocked)
  const before2 = page.url();
  await page.evaluate(()=>{ window.location.href='https://example.com/ctl2'; }).catch(()=>{});
  await sleep(2500);
  console.log('ARM2 external location.href -> url=', page.url(), ' (before', before2, ') EXPECT unchanged');

  // Arm 3: anchor click with noWaitAfter (does the DEFAULT ACTION fire at all?)
  await page.evaluate((h)=>{ const o=document.getElementById('ctl-a'); if(o)o.remove();
    const a=document.createElement('a'); a.id='ctl-a'; a.href=h; a.textContent='x'; document.body.appendChild(a); }, page.url().split('?')[0]+'?ctl=3');
  let arm3='resolved';
  try { await page.click('#ctl-a',{timeout:4000,noWaitAfter:true}); } catch(e){ arm3='TIMEOUT'; }
  await sleep(2000);
  console.log('ARM3 same-origin anchor click noWaitAfter:', arm3, '-> url=', page.url(), ' EXPECT ?ctl=3');

  // Arm 4: EXTERNAL anchor click with noWaitAfter (must be blocked, click must resolve)
  const before4=page.url();
  await page.evaluate(()=>{ const o=document.getElementById('ctl-a'); if(o)o.remove();
    const a=document.createElement('a'); a.id='ctl-a'; a.href='https://example.com/ctl4'; a.textContent='x'; document.body.appendChild(a); });
  let arm4='resolved';
  try { await page.click('#ctl-a',{timeout:4000,noWaitAfter:true}); } catch(e){ arm4='TIMEOUT'; }
  await sleep(2000);
  console.log('ARM4 external anchor click noWaitAfter:', arm4, '-> url=', page.url(), ' (before', before4, ') EXPECT unchanged');
  console.log('pages:', ctx.pages().length);
} finally { try{child.kill('SIGKILL');}catch{} }

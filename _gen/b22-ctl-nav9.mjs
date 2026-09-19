// CONTROL 9: decide the in-view-external timeout. Playwright's page.click
// waits for "scheduled navigations to finish". Electron's will-navigate
// preventDefault cancels the nav in the BROWSER process after the renderer
// already scheduled it -> the barrier may never be released.
// Arms, all IN VIEW and all confirmed hit-testable:
//  R1 real in-app button              -> if resolves, the app is clickable; geometry was the other half
//  R2 external anchor + renderer-side preventDefault (no nav scheduled)
//  R3 external anchor, plain (nav scheduled, main cancels it)
//  R4 button with a JS-only handler   -> no anchor, no nav
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT=4895; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ctl9-udd-'+Date.now();
const child=spawn(APP,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
try{
  let b=null; for(let i=0;i<40;i++){ await sleep(500); try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break;}catch{} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(2000);
  await page.evaluate(()=>window.scrollTo(0,0)); await sleep(500);

  // R1: a REAL in-app button, scrolled to top so it is genuinely in view.
  const g1 = await page.evaluate(()=>{
    const bs=[...document.querySelectorAll('button')].filter(x=>{const r=x.getBoundingClientRect();
      return r.width>0&&r.height>0&&r.y>=0&&r.y+r.height<=innerHeight;});
    if(!bs.length) return null; const bt=bs[0]; bt.id='ctl9-real';
    const r=bt.getBoundingClientRect();
    return {label:(bt.textContent||'').trim().slice(0,30), y:Math.round(r.y),
      self:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===bt};
  });
  let r1='resolved'; let t=Date.now();
  try{ await page.click('#ctl9-real',{timeout:5000}); }catch(e){ r1='TIMEOUT'; }
  console.log('R1 real in-app button  :', r1.padEnd(9), (Date.now()-t)+'ms', JSON.stringify(g1));

  const mk = (extra) => page.evaluate((code)=>{
    const o=document.getElementById('ctl9'); if(o)o.remove();
    const a=document.createElement('a'); a.id='ctl9'; a.href='https://example.com/ctl9'; a.textContent='CTL9';
    a.style.cssText='position:fixed;top:4px;left:4px;z-index:2147483647;background:#fff;padding:10px;font-size:20px';
    document.body.appendChild(a); if(code) new Function('a',code)(a);
    const r=a.getBoundingClientRect();
    return {self:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===a};
  }, extra);

  const g2 = await mk("a.addEventListener('click',e=>e.preventDefault())");
  let r2='resolved'; t=Date.now();
  try{ await page.click('#ctl9',{timeout:5000}); }catch(e){ r2='TIMEOUT'; }
  console.log('R2 ext anchor + renderer preventDefault:', r2.padEnd(9), (Date.now()-t)+'ms', JSON.stringify(g2), 'url=',page.url());

  const g3 = await mk(null);
  let r3='resolved'; t=Date.now();
  try{ await page.click('#ctl9',{timeout:5000}); }catch(e){ r3='TIMEOUT'; }
  console.log('R3 ext anchor plain (main cancels nav) :', r3.padEnd(9), (Date.now()-t)+'ms', JSON.stringify(g3), 'url=',page.url());

  const g4 = await page.evaluate(()=>{
    const o=document.getElementById('ctl9'); if(o)o.remove();
    const bt=document.createElement('button'); bt.id='ctl9'; bt.textContent='CTL9B';
    bt.style.cssText='position:fixed;top:4px;left:4px;z-index:2147483647;padding:10px;font-size:20px';
    window.__got=false; bt.addEventListener('click',()=>{window.__got=true;}); document.body.appendChild(bt);
    const r=bt.getBoundingClientRect();
    return {self:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===bt};
  });
  let r4='resolved'; t=Date.now();
  try{ await page.click('#ctl9',{timeout:5000}); }catch(e){ r4='TIMEOUT'; }
  console.log('R4 plain button JS handler             :', r4.padEnd(9), (Date.now()-t)+'ms', JSON.stringify(g4), 'handlerFired=', await page.evaluate(()=>window.__got));
} finally { try{child.kill('SIGKILL');}catch{} }

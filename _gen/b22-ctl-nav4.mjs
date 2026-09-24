// CONTROL 4: WHY does a bare-appended anchor's click hang while a fixed,
// top-z one resolves? Read the geometry + what is actually at that point.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT=4895; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ctl4-udd-'+Date.now();
const child=spawn(APP,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
try{
  let b=null; for(let i=0;i<40;i++){ await sleep(500); try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break;}catch{} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(2000);
  // EXACTLY the 16-vector harness's injection: bare append, no styling.
  const geom = await page.evaluate(()=>{
    const o=document.getElementById('red20-link-1'); if(o)o.remove();
    const a=document.createElement('a'); a.id='red20-link-1';
    a.href='https://example.com/vector-1-ahref'; a.textContent='vector 1 link';
    document.body.appendChild(a);
    const r=a.getBoundingClientRect();
    const cx=r.x+r.width/2, cy=r.y+r.height/2;
    const at=document.elementFromPoint(cx,cy);
    return {rect:{x:r.x,y:r.y,w:r.width,h:r.height}, vh:innerHeight, vw:innerWidth,
      scrollY:scrollY, docH:document.documentElement.scrollHeight,
      atPoint: at ? (at.id||at.tagName)+'.'+(at.className||'').toString().slice(0,60) : null,
      isSelf: at===a};
  });
  console.log('GEOM:', JSON.stringify(geom));
  let out='resolved'; const t0=Date.now();
  try { await page.click('#red20-link-1',{timeout:6000}); } catch(e){ out='TIMEOUT'; }
  console.log('bare-append click:', out, (Date.now()-t0)+'ms', 'url=',page.url());
  // Does a plain DOM .click() (real default action, no synthetic input) navigate?
  const before=page.url();
  await page.evaluate(()=>{ const a=document.getElementById('red20-link-1'); if(a) a.click(); });
  await sleep(2500);
  console.log('dom .click() external anchor: before=',before,'after=',page.url(),'pages=',ctx.pages().length);
} finally { try{child.kill('SIGKILL');}catch{} }

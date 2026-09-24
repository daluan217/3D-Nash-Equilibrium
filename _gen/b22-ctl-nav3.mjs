// CONTROL 3: does the synthesized click EVENT reach the anchor, and is its
// default action prevented? Separates "click lands elsewhere" (coordinate/zoom
// problem) from "app preventDefaults it" from "navigation blocked downstream".
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT=4895; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ctl3-udd-'+Date.now();
const child=spawn(APP,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
try{
  let b=null; for(let i=0;i<40;i++){ await sleep(500); try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break;}catch{} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(1500);
  const initial=page.url();
  console.log('zoom/dpr:', JSON.stringify(await page.evaluate(()=>({dpr:devicePixelRatio,iw:innerWidth,ih:innerHeight,ow:outerWidth}))));

  await page.evaluate((h)=>{
    const o=document.getElementById('ctl-a'); if(o)o.remove();
    const a=document.createElement('a'); a.id='ctl-a'; a.href=h; a.textContent='CTLANCHOR';
    a.style.cssText='position:fixed;top:4px;left:4px;z-index:2147483647;background:#fff;padding:8px;font-size:20px';
    document.body.appendChild(a);
    window.__hits=[];
    a.addEventListener('click',(e)=>window.__hits.push({on:'anchor',dp:e.defaultPrevented,x:e.clientX,y:e.clientY}));
    document.addEventListener('click',(e)=>window.__hits.push({on:'document',tgt:e.target&&e.target.id||e.target.tagName,dp:e.defaultPrevented,x:e.clientX,y:e.clientY}),true);
  }, initial.split('?')[0]+'?ctl=3');
  const box = await page.locator('#ctl-a').boundingBox();
  console.log('anchor boundingBox:', JSON.stringify(box));

  // A: playwright page.click
  let a='resolved'; try{ await page.click('#ctl-a',{timeout:4000}); }catch(e){ a='TIMEOUT'; }
  await sleep(1200);
  console.log('A page.click:', a, 'hits=',JSON.stringify(await page.evaluate(()=>window.__hits)), 'url=',page.url());

  // B: raw CDP mouse at the box centre
  await page.evaluate(()=>{window.__hits=[];});
  if (box) { await page.mouse.click(box.x+box.width/2, box.y+box.height/2); }
  await sleep(1200);
  console.log('B mouse.click:', 'hits=',JSON.stringify(await page.evaluate(()=>window.__hits||[])), 'url=',page.url());

  // C: DOM .click() — no synthetic input at all
  await page.evaluate(()=>{window.__hits=[]; document.getElementById('ctl-a').click();});
  await sleep(1500);
  console.log('C dom.click(): url=',page.url());
} finally { try{child.kill('SIGKILL');}catch{} }

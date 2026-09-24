// CONTROL 10 — THE PRODUCT QUESTION. After the main process cancels an
// external navigation (will-navigate preventDefault), does REAL MOUSE INPUT
// still reach the renderer? Raw CDP Input.dispatchMouseEvent bypasses
// Playwright's actionability wait entirely, so a handler that fires proves
// the app is fine and the earlier timeouts were the harness's nav barrier;
// a handler that does NOT fire is a wedged app = a product defect.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT=4895; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ctl10-udd-'+Date.now();
const child=spawn(APP,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
try{
  let b=null; for(let i=0;i<40;i++){ await sleep(500); try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break;}catch{} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(2000);
  const cdp = await ctx.newCDPSession(page);
  const rawClick = async (x,y)=>{
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
  };
  const mkButton = () => page.evaluate(()=>{
    const o=document.getElementById('ctl10b'); if(o)o.remove();
    const bt=document.createElement('button'); bt.id='ctl10b'; bt.textContent='BTN';
    bt.style.cssText='position:fixed;top:120px;left:4px;z-index:2147483647;padding:12px;font-size:20px';
    window.__got=0; bt.addEventListener('click',()=>{window.__got++;}); document.body.appendChild(bt);
    const r=bt.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
  });
  // BASELINE: raw click on a fresh button BEFORE any blocked navigation.
  let p = await mkButton(); await rawClick(p.x,p.y); await sleep(600);
  console.log('BASELINE raw click handlerFired =', await page.evaluate(()=>window.__got));
  // Now trigger the BLOCKED external navigation via a real anchor click.
  const ap = await page.evaluate(()=>{
    const o=document.getElementById('ctl10a'); if(o)o.remove();
    const a=document.createElement('a'); a.id='ctl10a'; a.href='https://example.com/ctl10'; a.textContent='EXT';
    a.style.cssText='position:fixed;top:4px;left:4px;z-index:2147483647;background:#fff;padding:12px;font-size:20px';
    document.body.appendChild(a); const r=a.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
  });
  await rawClick(ap.x,ap.y); await sleep(2500);
  console.log('after blocked ext nav: url=',page.url(),'pages=',ctx.pages().length);
  // AFTER: raw click on a fresh button. Does the handler still fire?
  p = await mkButton(); await rawClick(p.x,p.y); await sleep(600);
  const after = await page.evaluate(()=>window.__got);
  console.log('AFTER-BLOCK raw click handlerFired =', after, after>0 ? '=> APP IS FINE (harness barrier)' : '=> APP INPUT WEDGED (product defect)');
  // And again, twice more, to rule out a one-shot recovery.
  p = await mkButton(); await rawClick(p.x,p.y); await sleep(600);
  console.log('AFTER-BLOCK raw click #2 handlerFired =', await page.evaluate(()=>window.__got));
  // Real in-app control via raw input, end to end.
  const bp = await page.evaluate(()=>{
    const bt=[...document.querySelectorAll('button')].find(x=>/Prisoner/i.test(x.textContent||''));
    if(!bt) return null; bt.scrollIntoView({block:'center'}); const r=bt.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2,label:(bt.textContent||'').trim().slice(0,30)};
  });
  if (bp) { await rawClick(bp.x,bp.y); await sleep(1200);
    console.log('real preset raw-clicked:', bp.label, '-> app still at', page.url()); }
} finally { try{child.kill('SIGKILL');}catch{} }

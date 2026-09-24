// CONTROL 5: the 2x2 — {in-view, below-fold} x {same-origin, external}.
// Discriminates "the app blocks/hangs" (href should matter) from "the click
// never lands" (position should matter).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT=4895; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ctl5-udd-'+Date.now();
const child=spawn(APP,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
try{
  let b=null; for(let i=0;i<40;i++){ await sleep(500); try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break;}catch{} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(2000);
  const base=page.url().split('?')[0];
  for (const pos of ['inview']) {
    for (const kind of ['external','external-nowait','sameorigin-nowait']) {
      const href = kind.startsWith('sameorigin') ? base+'?k='+kind : 'https://example.com/'+kind;
      const info = await page.evaluate(([h,p])=>{
        const o=document.getElementById('ctl-a'); if(o)o.remove();
        const a=document.createElement('a'); a.id='ctl-a'; a.href=h; a.textContent='CTL';
        if(p==='inview') a.style.cssText='position:fixed;top:4px;left:4px;z-index:2147483647;background:#fff;padding:8px;font-size:20px';
        document.body.appendChild(a);
        const r=a.getBoundingClientRect(); const cx=r.x+r.width/2, cy=r.y+r.height/2;
        const at=document.elementFromPoint(cx,cy);
        return {y:Math.round(r.y), inViewport: r.y>=0&&r.y<innerHeight, atPointIsSelf: at===a};
      },[href,pos]);
      let out='resolved'; const t0=Date.now();
      try{ await page.click('#ctl-a',{timeout:5000, ...(kind.endsWith('nowait')?{noWaitAfter:true}:{})}); }catch(e){ out='TIMEOUT'; }
      await sleep(1200);
      const after=page.url();
      console.log(`${pos.padEnd(10)} ${kind.padEnd(11)} click=${out.padEnd(8)} ${String(Date.now()-t0).padStart(5)}ms geom=${JSON.stringify(info)} url=${after}`);
      if (after!==base && !after.startsWith(base)) console.log('  !! LEFT THE APP ORIGIN');
      if (after!==base) { await page.goto(base); await sleep(1200); }
    }
  }
  console.log('final pages:', ctx.pages().length, 'url:', page.url());
} finally { try{child.kill('SIGKILL');}catch{} }

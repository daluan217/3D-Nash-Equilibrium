// CONTROL 7: after the main process preventDefaults an external navigation,
// is the RENDERER still fully usable (the product question), and does
// Playwright's click resolve if we dispatch the event without its nav barrier?
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT=4895; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ctl7-udd-'+Date.now();
const child=spawn(APP,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
let mlog=''; child.stdout.on('data',d=>mlog+=d); child.stderr.on('data',d=>mlog+=d);
try{
  let b=null; for(let i=0;i<40;i++){ await sleep(500); try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break;}catch{} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(2000);
  const base=page.url();
  // In-view external anchor; trigger via CDP Input directly (no Playwright nav barrier).
  const cdp = await ctx.newCDPSession(page);
  const box = await page.evaluate(()=>{
    const o=document.getElementById('ctl-a'); if(o)o.remove();
    const a=document.createElement('a'); a.id='ctl-a'; a.href='https://example.com/ctl7'; a.textContent='CTL7';
    a.style.cssText='position:fixed;top:4px;left:4px;z-index:2147483647;background:#fff;padding:8px;font-size:20px';
    document.body.appendChild(a); const r=a.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  });
  const t0=Date.now();
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x,y:box.y,button:'left',clickCount:1});
  console.log('CDP raw click dispatched in', (Date.now()-t0)+'ms');
  await sleep(2500);
  console.log('url after external click:', page.url(), '(base', base, ') pages=', ctx.pages().length);
  // PRODUCT QUESTION: is the app still usable?
  const usable = await page.evaluate(()=>{
    const btns=[...document.querySelectorAll('button')].length;
    return {title:document.title, ready:document.readyState, buttons:btns,
      rootChildren:(document.getElementById('root')||{children:[]}).children.length};
  });
  console.log('renderer usable after blocked click:', JSON.stringify(usable));
  // Can a REAL in-app control still be clicked and take effect?
  const clicked = await page.evaluate(()=>{
    const b=[...document.querySelectorAll('button')].find(x=>/preset|prisoner|coordination|chicken/i.test(x.textContent||''));
    if(!b) return 'no preset button found';
    b.click(); return 'clicked: '+(b.textContent||'').trim().slice(0,40);
  });
  await sleep(1200);
  console.log('post-block in-app control:', clicked, '-> url', page.url());
  // And a REAL playwright click on an in-app control (the usability test that matters)
  await page.evaluate(()=>{ const o=document.getElementById('ctl-a'); if(o)o.remove(); });
  const realBtn = await page.evaluate(()=>{
    const b=[...document.querySelectorAll('button')].find(x=>/Prisoner/i.test(x.textContent||''));
    if(!b) return null; b.id='ctl-realbtn';
    const r=b.getBoundingClientRect();
    return {y:Math.round(r.y), inView:r.y>=0&&r.y<innerHeight, self:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b};
  });
  console.log('real button geom:', JSON.stringify(realBtn));
  let pwOk='resolved'; const t2=Date.now();
  try { await page.click('#ctl-realbtn',{timeout:5000}); } catch(e){ pwOk='ERR:'+e.message.split('\n')[0]; }
  console.log('playwright click on a real in-app button after the block:', pwOk, (Date.now()-t2)+'ms');
  console.log('MAIN LOG (Refused/openExternal lines):', mlog.split('\n').filter(l=>/Refused|refused|openExternal|external/i.test(l)).join(' | ') || '(none)');
} finally { try{child.kill('SIGKILL');}catch{} }

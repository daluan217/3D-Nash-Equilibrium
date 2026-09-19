// CONTROL 8: electron-main.cjs:415 sets webContents.setZoomFactor(1.33).
// Hypothesis: CDP Input coordinates are NOT zoom-scaled, so a synthetic click
// at CSS point (x,y) lands at physical (x*1.33, y*1.33) -> error grows with
// distance from the origin. Measure the displacement directly.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const APP='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT=4895; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/ctl8-udd-'+Date.now();
const child=spawn(APP,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
try{
  let b=null; for(let i=0;i<40;i++){ await sleep(500); try{ b=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break;}catch{} }
  const ctx=b.contexts()[0]; let page=null;
  for(let i=0;i<40;i++){ page=ctx.pages().find(p=>p.url().startsWith('http://127.0.0.1')); if(page)break; await sleep(300);}
  await page.waitForLoadState('domcontentloaded'); await sleep(2000);
  const cdp = await ctx.newCDPSession(page);
  // Put probe targets at known CSS coordinates and see where a CDP click at
  // those same numbers actually lands.
  await page.evaluate(()=>{
    document.querySelectorAll('.ctl8').forEach(e=>e.remove());
    window.__land=[];
    document.addEventListener('mousedown',(e)=>window.__land.push({cx:e.clientX,cy:e.clientY,tgt:(e.target.id||e.target.tagName)}),true);
  });
  for (const [x,y] of [[20,20],[300,300],[600,600],[100,700]]) {
    await page.evaluate(()=>{window.__land=[];});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
    await sleep(250);
    const land = await page.evaluate(()=>window.__land);
    const l = land[0];
    if (l) console.log(`sent CSS(${x},${y}) -> page saw client(${l.cx},${l.cy})  ratio=(${(l.cx/x).toFixed(3)},${(l.cy/y).toFixed(3)}) tgt=${l.tgt}`);
    else console.log(`sent CSS(${x},${y}) -> NO mousedown observed`);
  }
  console.log('zoomFactor(main-side 1.33) / devicePixelRatio:', JSON.stringify(await page.evaluate(()=>({dpr:devicePixelRatio,iw:innerWidth,ih:innerHeight}))));
} finally { try{child.kill('SIGKILL');}catch{} }

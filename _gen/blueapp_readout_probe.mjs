/* Is the "realtime coordinates" box the same quantity as the panel's x*, or a
 * different one? Ground truth: does it MOVE while the run moves? */
import { chromium } from 'playwright';
const BASE = process.env.E2E_BASE;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1100 } });
p.setDefaultTimeout(60000);
await p.goto(BASE, { waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 15000 }); } catch { await p.keyboard.press('Escape'); }
await p.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'), null, { timeout: 10000 });
const vals = () => p.evaluate(() => {
  const boxes = [...document.querySelectorAll('div')].filter(d =>
    /x: P\(A playing Row 1\)|y: P\(B playing Col 1\)|Expected Payoff E\[/.test(d.textContent||'')
    && d.querySelectorAll('div').length === 0);
  const readout = {};
  for (const d of boxes) {
    const t = d.textContent.trim();
    const m = t.match(/^(.*?)(-?[\d.−]+|less than.*|greater than.*)$/);
    if (m) readout[m[1].trim()] = m[2].trim();
  }
  const tex = [...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map(a=>a.textContent);
  const heading = [...document.querySelectorAll('span')].map(s=>s.textContent.trim()).find(t=>/Nash Equilibrium Reached/.test(t)) || null;
  const log = [...document.querySelectorAll('p')].map(x=>(x.textContent||'').trim()).filter(t=>/^━━/.test(t));
  return { readout, tex: tex.filter(x=>/x\^\*|y\^\*|mathbb\{E\}\[[AB]\] /.test(x)), heading, log };
});
await p.getByRole('button', { name: 'Search Game', exact: false }).first().click();
await p.waitForTimeout(500);
await p.evaluate(() => { const el=[...document.querySelectorAll('input[type="range"]')].find(e=>e.min==='1');
  const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el,'3');
  el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); });
await p.getByRole('button', { name: /^Run$/ }).click();
const samples = [];
for (let i = 0; i < 5; i++) { await p.waitForTimeout(450); samples.push((await vals()).readout); }
console.log('DURING THE RUN — successive samples of the readout box:');
for (const s of samples) console.log('   ', JSON.stringify(s));
const moved = new Set(samples.map(s => JSON.stringify(s))).size > 1;
console.log('   readout changes while the run moves:', moved, moved ? '-> it is a LIVE trajectory readout' : '-> it is NOT live');
await p.waitForFunction(() => [...document.querySelectorAll('span')].some(s=>/Nash Equilibrium Reached/.test(s.textContent||'')), null, { timeout: 120000 });
await p.waitForTimeout(900);
const end = await vals();
console.log('\nAFTER CONVERGENCE:');
console.log('  readout box :', JSON.stringify(end.readout));
console.log('  panel TeX   :', JSON.stringify(end.tex));
console.log('  log line    :', JSON.stringify(end.log));
await b.close();

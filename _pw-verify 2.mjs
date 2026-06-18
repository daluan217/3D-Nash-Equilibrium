import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.setViewportSize({ width: 1512, height: 950 });
await p.goto('http://localhost:3001/', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await p.getByRole('button', { name: 'Battle of the Sexes' }).click().catch(()=>{});
await p.waitForTimeout(600);

const measure = async () => p.evaluate(() => {
  const logHdr = [...document.querySelectorAll('span')].find(e => e.textContent.trim() === 'Simulation Log');
  const params = [...document.querySelectorAll('div')].find(e => e.textContent.trim() === 'Simulation Coordinates & Parameters')?.closest('div.rounded-2xl');
  const log = logHdr?.closest('div.rounded-2xl');
  const r = el => el && el.getBoundingClientRect();
  const pr = r(params), lr = r(log);
  return { paramsBottom: pr&&Math.round(pr.bottom), logBottom: lr&&Math.round(lr.bottom),
    logLeft: lr&&Math.round(lr.left), logWidth: lr&&Math.round(lr.width),
    diff: pr&&lr&&Math.round(pr.bottom-lr.bottom),
    converged: document.body.innerText.includes('Nash Equilibrium Reached') };
});

await p.getByRole('button', { name: 'Run', exact: true }).click();
await p.waitForFunction(() => document.body.innerText.includes('Nash Equilibrium Reached'), { timeout: 25000 }).catch(()=>{});
await p.waitForTimeout(2000);
console.log('BoS CONVERGED:', JSON.stringify(await measure()));
await p.screenshot({ path: '/tmp/nash-bos.png', fullPage: true });
await b.close();

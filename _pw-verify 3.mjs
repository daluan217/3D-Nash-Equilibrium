import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.setViewportSize({ width: 1512, height: 950 });
await p.goto('http://localhost:3001/', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await p.getByRole('button', { name: 'Battle of the Sexes' }).click().catch(()=>{});
await p.waitForTimeout(600);

const snap = async (label) => {
  const d = await p.evaluate(() => {
    const all = [...document.querySelectorAll('div,span')];
    const txt = (t)=>all.find(e=>e.textContent.trim()===t);
    const eqBox = all.find(e=>/Strategy Nash Equilibrium Reached$/.test(e.textContent.trim()));
    const report = txt('Game-Theoretic Report')?.closest('div.rounded-2xl');
    const params = txt('Simulation Coordinates & Parameters')?.closest('div.rounded-2xl');
    const logHdr=[...document.querySelectorAll('span')].find(e=>e.textContent.trim()==='Simulation Log');
    const log = logHdr?.closest('div.rounded-2xl');
    const r=el=>el&&Math.round(el.getBoundingClientRect().bottom);
    const lr=log&&log.getBoundingClientRect();
    return { converged: !!eqBox, paramsBottom:r(params), reportBottom:r(report),
      roomReportToParams: (params&&report)? Math.round(params.getBoundingClientRect().bottom-report.getBoundingClientRect().bottom):null,
      logLeft: lr&&Math.round(lr.left), logWidth: lr&&Math.round(lr.width),
      logBottom: lr&&Math.round(lr.bottom) };
  });
  console.log(label, JSON.stringify(d));
};

await snap('PRE');
await p.getByRole('button', { name: 'Run', exact: true }).click();
await p.waitForFunction(() => /Strategy Nash Equilibrium Reached/.test(document.body.innerText), { timeout: 30000 }).catch(()=>console.log('TIMEOUT waiting convergence'));
await p.waitForTimeout(2000);
await snap('POST');
await p.screenshot({ path: '/tmp/nash-bos.png', fullPage: true });
await b.close();

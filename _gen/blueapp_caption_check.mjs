/* Does the convention line appear exactly where it should, and nowhere else? */
import { chromium } from 'playwright';
const BASE = process.env.E2E_BASE;
const CAPTION = /Computed at the exact equilibrium, then rounded to 3 dp for display/;
const b = await chromium.launch();
const fails = [];
async function run(preset, { dark = false } = {}) {
  const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
  p.setDefaultTimeout(60000);
  await p.goto(BASE, { waitUntil: 'networkidle' });
  try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 15000 }); } catch { await p.keyboard.press('Escape'); }
  await p.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'), null, { timeout: 10000 });
  if (dark) { await p.evaluate(() => { document.documentElement.classList.add('dark'); localStorage.setItem('nash_sim_theme', 'dark'); }); await p.waitForTimeout(300); }
  await p.getByRole('button', { name: preset, exact: false }).first().click();
  await p.waitForTimeout(500);
  await p.evaluate(() => { const el=[...document.querySelectorAll('input[type="range"]')].find(e=>e.min==='1');
    const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el,'10');
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); });
  await p.getByRole('button', { name: /^Run$/ }).click();
  const ok = await p.waitForFunction(() => [...document.querySelectorAll('span')].some(s=>/Nash Equilibrium Reached/.test(s.textContent||'')), null, { timeout: 120000 }).then(()=>true).catch(()=>false);
  await p.waitForTimeout(800);
  const r = await p.evaluate(() => {
    const h = [...document.querySelectorAll('span')].find(s => /Nash Equilibrium Reached/.test(s.textContent||''));
    return { heading: h ? h.textContent.trim() : null, body: document.body.innerText };
  });
  const shown = CAPTION.test(r.body);
  // Guarded: on a build WITHOUT the caption this would otherwise burn a 60s
  // locator timeout and die with a TimeoutError instead of reporting the real
  // finding, which is that the line is missing.
  if (dark && shown) {
    try {
      const el = p.locator('p', { hasText: CAPTION }).first();
      await el.scrollIntoViewIfNeeded({ timeout: 10000 });
      await el.screenshot({ path: '/tmp/blueapp_caption_dark.png' });
    } catch (e) { fails.push('could not screenshot the dark-mode caption: ' + e.message.slice(0, 120)); }
  }
  await p.close();
  return { ok, heading: r.heading, shown };
}
const mixed = await run('Search Game');
console.log('Search Game    ->', mixed.heading, '| caption shown:', mixed.shown);
if (!mixed.shown) fails.push('the convention line is missing from a MIXED equilibrium panel');
const pure = await run('Battle of the Sexes');
console.log('Battle of Sexes->', pure.heading, '| caption shown:', pure.shown);
if (!/Pure/.test(pure.heading || '')) fails.push(`expected a PURE panel for Battle of the Sexes, got ${pure.heading}`);
if (pure.shown) fails.push('the convention line must NOT appear on a pure equilibrium — its coordinates are exactly 0/1 and the substitution is exact');
const darkRun = await run('Search Game', { dark: true });
console.log('Search (dark)  ->', darkRun.heading, '| caption shown:', darkRun.shown, '| screenshot /tmp/blueapp_caption_dark.png');
if (!darkRun.shown) fails.push('the convention line vanished in dark mode');
await b.close();
if (fails.length) { console.error('\nFAIL:'); for (const f of fails) console.error('  - ' + f); process.exit(1); }
console.log('\nPASS');

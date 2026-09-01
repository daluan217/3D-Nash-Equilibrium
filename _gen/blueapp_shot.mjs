import { chromium } from 'playwright';
const BASE = process.env.E2E_BASE, TAG = process.env.SHOT_TAG || '';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
p.setDefaultTimeout(60000);
await p.goto(BASE, { waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 15000 }); } catch { await p.keyboard.press('Escape'); }
await p.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'), null, { timeout: 10000 });
await p.getByRole('button', { name: process.argv[2] || 'Search Game', exact: false }).first().click();
await p.waitForTimeout(500);
await p.evaluate(() => { const el=[...document.querySelectorAll('input[type="range"]')].find(e=>e.min==='1');
  const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el,'10');
  el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); });
await p.getByRole('button', { name: /^Run$/ }).click();
await p.waitForFunction(() => [...document.querySelectorAll('span')].some(s=>/Nash Equilibrium Reached/.test(s.textContent||'')), null, { timeout: 120000 });
await p.waitForTimeout(900);
// Walk up from the heading to the panel container that also holds the two lines.
const box = await p.evaluateHandle(() => {
  const h = [...document.querySelectorAll('span')].find(s => /Nash Equilibrium Reached/.test(s.textContent||''));
  let n = h; while (n && !/indifferent:|strictly prefers:/.test(n.textContent||'')) n = n.parentElement;
  return n;
});
await box.asElement().scrollIntoViewIfNeeded();
await box.asElement().screenshot({ path: `/tmp/blueapp_panel${TAG}.png` });
console.log('wrote', `/tmp/blueapp_panel${TAG}.png`);
await b.close();

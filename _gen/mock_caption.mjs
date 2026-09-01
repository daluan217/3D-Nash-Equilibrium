import { chromium } from 'playwright';
const BASE = process.env.E2E_BASE;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
p.setDefaultTimeout(60000);
await p.goto(BASE, { waitUntil: 'networkidle' });
try { await p.locator('[aria-label="Exit tour"]').click({ timeout: 15000 }); } catch { await p.keyboard.press('Escape'); }
await p.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'), null, { timeout: 10000 });
const csv = process.argv[2];
if (csv) {
  const m = p.locator('input[inputmode="decimal"][class*="text-center"]');
  const v = csv.split(',');
  for (let i = 0; i < 8; i++) { await m.nth(i).fill(v[i]); await m.nth(i).blur(); }
  await p.waitForTimeout(400);
}
await p.evaluate(() => { const el=[...document.querySelectorAll('input[type="range"]')].find(e=>e.min==='1');
  const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el,'10');
  el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); });
await p.getByRole('button', { name: /^Run$/ }).click();
await p.waitForFunction(() => [...document.querySelectorAll('span')].some(s=>/Nash Equilibrium Reached/.test(s.textContent||'')), null, { timeout: 120000 });
await p.waitForTimeout(900);
// MOCK ONLY — injected into the live DOM, not committed to any source file.
const box = await p.evaluateHandle(() => {
  const h = [...document.querySelectorAll('span')].find(s => /Nash Equilibrium Reached/.test(s.textContent||''));
  let n = h; while (n && n.parentElement && !/indifferent:|strictly prefers:|Mover priority/.test(n.textContent||'')) n = n.parentElement;
  if (!n) n = h.closest('div');
  const grid = [...n.querySelectorAll('div')].find(d => /x^∗|x∗/.test(d.textContent||'') && /E\[B\]/.test(d.textContent||''));
  const cap = document.createElement('p');
  cap.textContent = 'Computed at the exact equilibrium, then rounded to 3 dp for display — recomputing E[A] from the rounded x* and y* can differ in the last digits.';
  cap.setAttribute('style', 'font-size:11px;line-height:1.45;margin:6px 2px 0;color:#64748b;font-family:ui-sans-serif,system-ui;');
  (grid ?? n).insertAdjacentElement('afterend', cap);
  return n;
});
await box.asElement().scrollIntoViewIfNeeded();
await box.asElement().screenshot({ path: process.env.OUT });
console.log('wrote', process.env.OUT);
await b.close();

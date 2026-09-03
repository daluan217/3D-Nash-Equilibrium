import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];

await page.locator('button:has-text("Save Preset")').click();
await page.waitForTimeout(800);
await page.screenshot({ path: '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/rd6_save_modal.png' });

// Fill the game name field if present
const nameInput = page.locator('input[type="text"]').first();
const inputCount = await page.locator('input').count();
console.log('input count:', inputCount);
const allInputs = await page.locator('input').all();
for (const inp of allInputs) {
  const placeholder = await inp.getAttribute('placeholder').catch(()=>null);
  const type = await inp.getAttribute('type').catch(()=>null);
  console.log('input:', type, placeholder);
}
process.exit(0);

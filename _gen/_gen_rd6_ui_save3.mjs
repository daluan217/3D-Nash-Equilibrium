import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];

await page.locator('input[placeholder="e.g. Battle of the Sexes 2.0"]').fill('RD6-crash-test-game');
await page.waitForTimeout(300);

const buttons = await page.locator('button').allTextContents();
console.log('MODAL BUTTONS:', JSON.stringify(buttons));

// Find the submit button (likely "Save Game Profile" or similar)
const saveBtn = page.locator('button', { hasText: /Save Game/i });
console.log('saveBtn count:', await saveBtn.count());
if (await saveBtn.count() > 0) {
  await saveBtn.first().click();
}
await page.waitForTimeout(3000);
await page.screenshot({ path: '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/rd6_after_save_click.png' });

// Grab any visible error text
const bodyText = await page.locator('body').innerText();
console.log('BODY_TEXT_SNIPPET:', bodyText.slice(0, 3000));
process.exit(0);

import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];

try {
  await page.locator('text=Sign Up').first().click({ force: true, timeout: 5000 });
  console.log('clicked ok');
} catch (e) {
  console.log('click failed:', e.message.slice(0,200));
}
await page.waitForTimeout(500);
await page.screenshot({ path: '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/rd6_shot4.png' });
process.exit(0);

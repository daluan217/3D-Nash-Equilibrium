import { chromium } from 'playwright';
const BASE = 'http://localhost:3062';
async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /sign in.*sign up/i }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label="Account"]', { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/red-app-5-tour-blocks-login.png', fullPage: true });
  console.log('screenshot saved');
  await browser.close();
}
main();

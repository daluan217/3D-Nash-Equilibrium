// RED-APP-5 probe: since Tab escapes the Save modal onto the background page
// (confirmed: lands on the "Feedback" fixed button), can a keyboard user then
// ACTIVATE that background control and open a second dialog stacked on top of
// the first, while the first is still open? This is exactly brief angle 4
// ("nested dialogs ... nothing may become unreachable or trap forever").
import { chromium } from 'playwright';

const BASE = 'http://localhost:3065';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });

  const exitTourBtn = page.getByRole('button', { name: /exit tour/i });
  if (await exitTourBtn.isVisible({ timeout: 3000 }).catch(() => false)) await exitTourBtn.click();

  // Open Auth modal (no login needed, reachable from a clean state)
  await page.getByRole('button', { name: /sign in.*sign up/i }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label="Account"]', { timeout: 5000 });
  await page.locator('[role="dialog"][aria-label="Account"] input').first().focus();

  // Tab until we land on the Feedback button (background), same as prior probe (5 tabs)
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  const active = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { tag: el.tagName, title: el.getAttribute('title'), text: (el.textContent||'').slice(0,30) } : null;
  });
  console.log('focused element after 5 tabs from Auth modal:', JSON.stringify(active));

  // Activate it with Enter/Space (button activation)
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);

  const dialogCount = await page.locator('[role="dialog"]').count();
  const dialogLabels = await page.locator('[role="dialog"]').evaluateAll(els => els.map(e => ({label: e.getAttribute('aria-label'), visible: e.offsetParent !== null})));
  console.log('dialogs in DOM after activating background control:', dialogCount, JSON.stringify(dialogLabels));

  // Is the Auth modal STILL open underneath?
  const authStillThere = await page.locator('[role="dialog"][aria-label="Account"]').count();
  console.log('Auth modal still present in DOM:', authStillThere);

  // Try Escape now - which dialog closes?
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const afterEscape = await page.locator('[role="dialog"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
  console.log('dialogs after one Escape:', JSON.stringify(afterEscape));

  await page.screenshot({ path: '/tmp/red-app-5-nested-collision.png', fullPage: true });

  await browser.close();
}

main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });

import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(1500);

// Dismiss tour if present
const exitTour = page.locator('button:has-text("Exit tour")');
if (await exitTour.count() > 0) {
  await exitTour.click();
  await page.waitForTimeout(500);
}

// Look for "Save Preset" or similar button
const buttons = await page.locator('button').allTextContents();
console.log('BUTTONS:', JSON.stringify(buttons.slice(0, 60)));

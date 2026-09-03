import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];

// Close save modal first if open
const cancelBtn = page.locator('button:has-text("Cancel")');
if (await cancelBtn.count() > 0 && await cancelBtn.isVisible()) {
  await cancelBtn.click();
  await page.waitForTimeout(300);
}

await page.locator('button:has-text("Sign In / Sign Up")').first().click();
await page.waitForTimeout(500);
let txt = await page.locator('body').innerText();
console.log('AFTER SIGNIN CLICK snippet:', txt.slice(txt.indexOf('Sign'), txt.indexOf('Sign')+600));

// find "Sign Up" toggle/tab
const signUpTab = page.locator('button:has-text("Sign Up"), a:has-text("Sign Up")');
console.log('signUpTab count', await signUpTab.count());
if (await signUpTab.count() > 0) {
  await signUpTab.first().click();
  await page.waitForTimeout(400);
}
const inputs = await page.locator('input').all();
for (const inp of inputs) {
  const ph = await inp.getAttribute('placeholder').catch(()=>null);
  const ty = await inp.getAttribute('type').catch(()=>null);
  const nm = await inp.getAttribute('name').catch(()=>null);
  console.log('input', ty, nm, ph);
}
process.exit(0);

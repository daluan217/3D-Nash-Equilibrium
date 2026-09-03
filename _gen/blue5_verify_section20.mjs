// Standalone mirror of smoke.mjs section 20 (post-CodeRabbit-review,
// Auth-dialog-based collision check) — run directly against whatever build
// is serving on :3065, used to mutation-test the check quickly.
import { chromium } from 'playwright';
const BASE = 'http://localhost:3065';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const trapPage = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await trapPage.goto(BASE, { waitUntil: 'networkidle' });
  const trapExitTour = trapPage.getByRole('button', { name: /exit tour/i });
  if (await trapExitTour.count() > 0) {
    await trapExitTour.click();
    await trapPage.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
      null, { timeout: 10000 }).catch(() => {});
  }

  const isInsideDialog = (label) => trapPage.evaluate((l) => {
    const dlg = document.querySelector(`[role="dialog"][aria-label="${l}"]`);
    return !!dlg && dlg.contains(document.activeElement);
  }, label);
  const sweepTab = async (label) => {
    let stayedInside = true;
    for (let i = 0; i < 15; i++) {
      await trapPage.keyboard.press('Tab');
      if (!(await isInsideDialog(label))) { stayedInside = false; break; }
    }
    return stayedInside;
  };

  const feedbackBtn = trapPage.locator('button[title="Send feedback"]');
  await feedbackBtn.waitFor({ state: 'visible', timeout: 15000 });
  await feedbackBtn.click();
  await trapPage.waitForFunction(() => !!document.querySelector('[role="dialog"][aria-label="Send feedback"]'),
    null, { timeout: 10000 }).catch(() => {});
  await trapPage.locator('[role="dialog"][aria-label="Send feedback"] textarea, [role="dialog"][aria-label="Send feedback"] input').first().focus();
  const feedbackStayed = await sweepTab('Send feedback');
  console.log('Feedback stayedInside:', feedbackStayed);
  await trapPage.keyboard.press('Escape');
  await trapPage.waitForTimeout(150);

  await trapPage.getByRole('button', { name: /sign in.*sign up/i }).first().click();
  await trapPage.waitForFunction(() => !!document.querySelector('[role="dialog"][aria-label="Account"]'),
    null, { timeout: 10000 }).catch(() => {});
  await trapPage.locator('[role="dialog"][aria-label="Account"] input').first().focus();
  const authStayed = await sweepTab('Account');
  console.log('Auth stayedInside:', authStayed);

  const activeInfo = await trapPage.evaluate(() => {
    const el = document.activeElement;
    return el ? { tag: el.tagName, title: el.getAttribute('title'), text: (el.textContent || '').slice(0, 40) } : null;
  });
  console.log('activeElement right before Enter:', JSON.stringify(activeInfo));

  await trapPage.keyboard.press('Enter');
  await trapPage.waitForTimeout(150);
  const secondDialogCount = await trapPage.evaluate(() =>
    document.querySelectorAll('[role="dialog"][aria-modal="true"]').length);
  console.log('secondDialogCount after Enter:', secondDialogCount, secondDialogCount === 1 ? 'PASS' : 'FAIL');
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

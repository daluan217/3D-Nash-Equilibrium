// Follow-up to probe_tour_plus_modal: is a real, named control in the Auth
// modal actually occluded (click-intercepted) by the tour's callout card
// while both are open? Use Playwright's normal .click() (not force) so an
// intercepted click throws/times out instead of silently succeeding.
import { chromium } from 'playwright';
const BASE = 'http://localhost:3065';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200); // let tour auto-open

  const tourOpen = await page.locator('[role="dialog"][aria-label="Guided tour"]').isVisible().catch(() => false);
  console.log('tour open:', tourOpen);

  await page.getByRole('button', { name: /sign in.*sign up/i }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label="Account"]', { timeout: 5000 });
  console.log('auth modal opened while tour still open');

  // Try to click the Login submit button with a short timeout and no force.
  const loginBtn = page.getByRole('button', { name: /^login$/i });
  try {
    await loginBtn.click({ timeout: 4000 });
    console.log('Login button click SUCCEEDED normally (not blocked)');
  } catch (e) {
    console.log('Login button click FAILED/blocked:', e.message.split('\n').slice(0,3).join(' | '));
  }

  // Also probe: what element sits at the Login button's own bounding-box center?
  const info = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => /^Login$/.test(b.textContent?.trim() || ''));
    if (!btn) return { error: 'no login button' };
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return {
      buttonRect: { x: r.left, y: r.top, w: r.width, h: r.height },
      topElement: top ? { tag: top.tagName, cls: (top.className||'').toString().slice(0,80), isButtonOrDescendant: btn.contains(top) || top === btn } : null,
    };
  });
  console.log('login button occlusion check:', JSON.stringify(info, null, 2));

  await browser.close();
}

main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });

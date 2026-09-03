// RED-APP-5 probe: angle 1 - does the simulation log / convergence banner have
// any ARIA live-region semantics? grep of src/App.tsx found zero occurrences
// of aria-live, role="log", role="status" anywhere in the file. This confirms
// in the live DOM: run a simulation, check whether the log container or any
// ancestor up to <body> carries aria-live/role=status/role=log, and whether
// the "Equilibrium Reached" banner does either, once it appears.
import { chromium } from 'playwright';
const BASE = 'http://localhost:3065';

async function ancestorHasLiveRegion(page, selector) {
  return await page.evaluate((sel) => {
    let el = document.querySelector(sel);
    if (!el) return { found: false };
    const chain = [];
    let hasLive = false;
    while (el && el !== document.body) {
      const live = el.getAttribute('aria-live');
      const role = el.getAttribute('role');
      chain.push({ tag: el.tagName, live, role });
      if (live || role === 'status' || role === 'log' || role === 'alert') hasLive = true;
      el = el.parentElement;
    }
    return { found: true, hasLive, chainLen: chain.length, chain: chain.slice(0, 3) };
  }, selector);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const exitTourBtn = page.getByRole('button', { name: /exit tour/i });
  if (await exitTourBtn.isVisible({ timeout: 3000 }).catch(() => false)) await exitTourBtn.click();

  // Find the "Run" / start simulation button
  const runBtn = page.getByRole('button', { name: /^run$|start simulation|run simulation/i });
  const runVisible = await runBtn.first().isVisible({ timeout: 5000 }).catch(() => false);
  console.log('run button visible:', runVisible);
  if (runVisible) {
    await runBtn.first().click();
    await page.waitForTimeout(3000); // let it run/converge
  }

  // Log container: identified earlier by its classes (font-mono text-xs ... space-y-1)
  const logSelector = 'div.font-mono.text-xs';
  const logResult = await ancestorHasLiveRegion(page, logSelector);
  console.log('LOG container live-region check:', JSON.stringify(logResult));

  // Convergence banner: look for the text "Nash Equilibrium Reached"
  const bannerFound = await page.locator('text=/Nash Equilibrium Reached/i').count();
  console.log('convergence banner present:', bannerFound);
  if (bannerFound > 0) {
    const bannerResult = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('*')).find(e => /Nash Equilibrium Reached/i.test(e.textContent || '') && e.children.length < 5);
      let cur = el ? el.closest('div') : null;
      const chain = [];
      let hasLive = false;
      while (cur && cur !== document.body) {
        const live = cur.getAttribute('aria-live');
        const role = cur.getAttribute('role');
        chain.push({ tag: cur.tagName, live, role, cls: (cur.className||'').slice(0,40) });
        if (live || role === 'status' || role === 'log' || role === 'alert') hasLive = true;
        cur = cur.parentElement;
      }
      return { hasLive, chainLen: chain.length, chain: chain.slice(0, 4) };
    });
    console.log('BANNER live-region check:', JSON.stringify(bannerResult));
  }

  await browser.close();
}

main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });

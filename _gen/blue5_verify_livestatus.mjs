// Verifies RED-APP-5 finding 004's fix: an aria-live region exists, updates
// on run-phase transitions (start/pause/converge), and does NOT re-announce
// every individual log line during a run.
import { chromium } from 'playwright';
const BASE = 'http://localhost:3065';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const exitTourBtn = page.getByRole('button', { name: /exit tour/i });
  if (await exitTourBtn.isVisible({ timeout: 3000 }).catch(() => false)) await exitTourBtn.click();

  const liveInfo = await page.evaluate(() => {
    const el = document.querySelector('[aria-live="polite"][role="status"]');
    return el ? { found: true, text: el.textContent } : { found: false };
  });
  console.log('live region present at load:', JSON.stringify(liveInfo));

  // Pick a preset that does not converge on the very first tick, so the
  // "running" phase is actually observable before "converged" overwrites it.
  await page.getByRole('button', { name: 'Spy vs. Analyst' }).first().click();
  await page.waitForTimeout(200);

  // Start a run, and poll TIGHTLY right after the click so "running" is
  // caught before a fast convergence could overwrite it.
  await page.getByRole('button', { name: /^run$/i }).click();
  const samples = new Set();
  for (let i = 0; i < 20; i++) {
    const t = await page.evaluate(() =>
      document.querySelector('[aria-live="polite"][role="status"]')?.textContent);
    samples.add(t);
    await page.waitForTimeout(50);
  }
  const afterRun = [...samples].find((s) => s === 'Simulation running.') ?? [...samples][0];
  console.log('live text seen shortly after Run click:', JSON.stringify(afterRun));
  console.log('all distinct live-region strings during the run:', JSON.stringify([...samples]));
  const logLineCount = await page.evaluate(() =>
    document.querySelector('[role="region"][aria-label="Simulation log"]')?.children.length ?? 0);
  console.log('distinct live-region strings while running:', JSON.stringify([...samples]), 'log lines grown to:', logLineCount);

  // Pause.
  await page.getByRole('button', { name: /^pause$/i }).click().catch(() => {});
  await page.waitForTimeout(300);
  const afterPause = await page.evaluate(() =>
    document.querySelector('[aria-live="polite"][role="status"]')?.textContent);
  console.log('live text after Pause click:', JSON.stringify(afterPause));

  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

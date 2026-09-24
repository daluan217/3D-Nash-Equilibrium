// Light+dark screenshots of the DownloadModal Gatekeeper block (angle F fix).
// Reads state from a MODEL-DERIVED rendering: the modal is opened by the real
// UI button and the block is located by its shipped heading, never by injecting
// markup — so a shot that looks right proves the app renders it right.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const WT = process.argv[2];
const PORT = Number(process.argv[3] || 4892);
const OUT = process.argv[4];
mkdirSync(OUT, { recursive: true });

const srv = spawn(process.execPath, ['dist/server.cjs'], {
  cwd: WT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' }, stdio: 'ignore',
});
const die = async (msg) => { srv.kill(); console.error(msg); process.exit(1); };
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) break; } catch {}
  await new Promise(r => setTimeout(r, 500));
  if (i === 59) await die('server never came up');
}

const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  await page.addInitScript((t) => localStorage.setItem('nash_sim_theme', t), theme);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Open the download modal through the real control.
  const opener = page.getByRole('button', { name: /Get Desktop App|Get the desktop app/i }).first();
  await opener.waitFor({ state: 'visible', timeout: 15000 });
  await opener.click();

  const heading = page.getByText('macOS Security', { exact: false }).first();
  await heading.waitFor({ state: 'visible', timeout: 15000 });

  // The assertion behind the picture: read the RENDERED text of the block and
  // require the measured wording. A screenshot alone cannot fail.
  const block = page.locator('div').filter({ hasText: /macOS Security/ }).last();
  const txt = (await block.innerText()).replace(/\s+/g, ' ');
  const must = ['click Done', 'not click Move to Trash', 'could not verify', 'was blocked to protect your Mac'];
  const mustNot = ['click Cancel (not Move to Trash)', '"unidentified developer"'];
  for (const m of must) if (!txt.includes(m)) await die(`RENDERED text is missing ${JSON.stringify(m)} in ${theme}: ${txt.slice(0, 400)}`);
  for (const m of mustNot) if (txt.includes(m)) await die(`RENDERED text still contains ${JSON.stringify(m)} in ${theme}`);

  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  if (isDark !== (theme === 'dark')) await die(`theme did not apply: wanted ${theme}, html.dark=${isDark}`);

  await heading.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/gatekeeper-${theme}.png` });
  console.log(`${theme}: ok (html.dark=${isDark}) — rendered text carries all four measured strings`);
  await ctx.close();
}
await browser.close();
srv.kill();
console.log('EMPTY: both themes render the measured Gatekeeper copy');

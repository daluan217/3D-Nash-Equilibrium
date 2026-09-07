// Light+dark screenshot of the RED-REGEN-11/001 fix: Regenerate -> Keep at
// the 12-chip cap names the dropped noun through the regen.note live region.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = process.env.VIS_PORT || '4841';
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.VIS_OUT || '/tmp';
const root = path.resolve(import.meta.dirname, '..');
const userData = mkdtempSync(path.join(os.tmpdir(), 'nash-vis-regen11-'));
const server = spawn('node', [path.join(root, 'dist/server.cjs')], {
  cwd: userData, env: { ...process.env, NODE_ENV: 'production', PORT, ELECTRON_USER_DATA_PATH: userData },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', () => {});
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch {} if (!ready) await new Promise((r) => setTimeout(r, 500)); }
if (!ready) { console.error('server never came up'); server.kill('SIGKILL'); process.exit(1); }

const REGEN_STORY_CAP = {
  name: 'Harbour Watch Rotation',
  row1: 'Morning Watch', row2: 'Night Watch', col1: 'Dock Duty', col2: 'Patrol',
  description: 'The lighthouse keeper and the ferry crew coordinate harbour watch shifts.',
  actorA: ['the lighthouse keeper'], actorB: ['the ferry crew'],
};
const CAP_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
const desc = `The ${CAP_WORDS.join(', ')} crew members meet at the dock.`;

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('nash_sim_theme', t); } catch {} }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.route('**/api/health', async (route) => {
    const res = await route.fetch();
    let body; try { body = await res.json(); } catch { body = {}; }
    body.capabilities = { ...(body.capabilities || {}), scenarioRegen: true };
    await route.fulfill({ status: res.status(), contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/api/scenario/regenerate', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenario: REGEN_STORY_CAP }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 8000 }); } catch {}
  await page.waitForTimeout(300);
  const uniq = `vis80${theme}${Date.now()}`;
  await page.getByRole('button', { name: /sign in.*sign up/i }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label="Account"]', { timeout: 5000 });
  await page.getByText(/sign up/i).last().click().catch(async () => {
    await page.getByRole('button', { name: /create.*account|register/i }).first().click();
  });
  await page.waitForTimeout(300);
  await page.getByPlaceholder('game_theorist').fill(uniq);
  await page.getByPlaceholder('john@example.com').fill(`${uniq}@example.com`);
  const pwFields = page.getByPlaceholder('••••••••');
  await pwFields.nth(0).fill('TestPass123');
  await pwFields.nth(1).fill('TestPass123');
  await page.getByRole('button', { name: /register account/i }).click();
  await page.getByPlaceholder(/example\.com or username/i).waitFor({ state: 'visible', timeout: 20000 });
  await page.getByPlaceholder(/example\.com or username/i).fill(`${uniq}@example.com`);
  await page.getByPlaceholder('••••••••').first().fill('TestPass123');
  await page.getByRole('button', { name: /^login$/i }).click();
  await page.waitForFunction(() => !!(localStorage.getItem('nash_sim_token_local') || localStorage.getItem('nash_sim_token_cloud')), null, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Account"]'), null, { timeout: 10000 });

  await page.getByRole('button', { name: /save preset/i }).click();
  await page.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
  await page.locator('[role="dialog"][aria-label="Save custom game"] textarea').fill(desc);
  const dialog = page.getByRole('dialog', { name: 'Save custom game' });
  for (const w of CAP_WORDS) {
    await page.evaluate(({ w, sel }) => {
      const ta = document.querySelector(sel);
      const idx = ta.value.indexOf(w);
      ta.focus();
      ta.setSelectionRange(idx, idx + w.length);
    }, { w, sel: '[role="dialog"][aria-label="Save custom game"] textarea' });
    await dialog.getByRole('button', { name: 'Player A' }).click();
  }
  await page.getByRole('button', { name: 'Regenerate scenario' }).click();
  await page.getByText('New scenario (preview)', { exact: false }).waitFor({ state: 'visible', timeout: 5000 });
  await page.getByRole('button', { name: 'Keep' }).click();
  await page.waitForTimeout(400);

  const note = await dialog.locator('p[role="status"]').innerText().catch(() => '(none)');
  console.log(`${theme}: note="${note}" errors=${errors.length}`);
  await dialog.screenshot({ path: `${OUT}/regen11-cap-hint-${theme}-dialog.png` });
  const noteEl = dialog.locator('p[role="status"]').first();
  await noteEl.screenshot({ path: `${OUT}/regen11-cap-hint-${theme}-note.png` }).catch(() => {});
  await ctx.close();
}
await browser.close();
server.kill('SIGKILL');

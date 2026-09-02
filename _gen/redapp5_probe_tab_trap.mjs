// RED-APP-5 probe: does Tab escape modal dialogs onto the background page?
// Angle 4 (nested dialogs / focus trap). The expand-log dialog got a Tab trap
// in #90; check whether Save/Auth/Feedback/Edit modals (which predate #90 and
// were not touched by it) trap Tab the same way, or let focus leak to the
// (still-rendered, just visually covered) page behind the backdrop.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3062';
const uniq = Date.now();
const username = `redapp5b_${uniq}`;
const email = `redapp5b_${uniq}@example.com`;
const password = 'TestPass123';

async function tabAndCheck(page, dialogSelector, label, tabs = 25) {
  let leaked = false;
  let leakAt = -1;
  for (let i = 0; i < tabs; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate((sel) => {
      const dlg = document.querySelector(sel);
      if (!dlg) return null;
      return dlg.contains(document.activeElement);
    }, dialogSelector);
    if (inside === false) { leaked = true; leakAt = i + 1; break; }
    if (inside === null) { console.log(label, 'dialog gone from DOM at tab', i + 1); break; }
  }
  const activeInfo = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { tag: el.tagName, text: (el.textContent || '').slice(0, 40), role: el.getAttribute('role') } : null;
  });
  console.log(`${label}: Tab leaked outside dialog =`, leaked, leaked ? `at tab #${leakAt}` : '', 'activeElement=', JSON.stringify(activeInfo));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });

  const exitTourBtn = page.getByRole('button', { name: /exit tour/i });
  if (await exitTourBtn.isVisible({ timeout: 3000 }).catch(() => false)) await exitTourBtn.click();

  // --- Feedback modal: open with no auth needed ---
  const feedbackBtn = page.locator('button[title="Send feedback"]');
  if (await feedbackBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await feedbackBtn.click();
    await page.waitForSelector('[role="dialog"][aria-label="Send feedback"]', { timeout: 5000 });
    await page.locator('[role="dialog"][aria-label="Send feedback"] textarea, [role="dialog"][aria-label="Send feedback"] input').first().focus();
    await tabAndCheck(page, '[role="dialog"][aria-label="Send feedback"]', 'FEEDBACK');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else {
    console.log('feedback button not found');
  }

  // --- Auth modal ---
  await page.getByRole('button', { name: /sign in.*sign up/i }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label="Account"]', { timeout: 5000 });
  await page.locator('[role="dialog"][aria-label="Account"] input').first().focus();
  await tabAndCheck(page, '[role="dialog"][aria-label="Account"]', 'AUTH');

  // register + login so we can reach Save/Edit
  await page.getByRole('button', { name: /create.*account|sign up here|register/i }).first().click().catch(async () => {
    await page.getByText(/sign up/i).last().click();
  });
  await page.waitForTimeout(300);
  await page.getByPlaceholder('game_theorist').fill(username);
  await page.getByPlaceholder('john@example.com').fill(email);
  const pwFields = page.getByPlaceholder('••••••••');
  await pwFields.nth(0).fill(password);
  await pwFields.nth(1).fill(password);
  await page.getByRole('button', { name: /register account/i }).click();
  await page.waitForTimeout(800);
  await page.getByPlaceholder(/example\.com or username/i).fill(email);
  await page.getByPlaceholder('••••••••').first().fill(password);
  await page.getByRole('button', { name: /^login$/i }).click();
  await page.waitForTimeout(800);

  // --- Save modal ---
  const savePresetBtn = page.getByRole('button', { name: /save preset/i });
  await savePresetBtn.click();
  await page.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
  await page.locator('[role="dialog"][aria-label="Save custom game"] input').first().focus();
  await tabAndCheck(page, '[role="dialog"][aria-label="Save custom game"]', 'SAVE', 40);

  const gameName = `RedApp5b Game ${uniq}`;
  await page.getByPlaceholder('e.g. Battle of the Sexes 2.0').fill(gameName);
  await page.getByRole('button', { name: /^save game profile$/i }).click();
  await page.waitForTimeout(800);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const exitTourBtn2 = page.getByRole('button', { name: /exit tour/i });
  if (await exitTourBtn2.isVisible({ timeout: 2000 }).catch(() => false)) await exitTourBtn2.click();

  const editBtn = page.getByRole('button', { name: new RegExp(`^Edit ${gameName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  await editBtn.first().click();
  await page.waitForSelector('[role="dialog"][aria-label="Edit saved game"]', { timeout: 5000 });
  await page.locator('[role="dialog"][aria-label="Edit saved game"] input').first().focus();
  await tabAndCheck(page, '[role="dialog"][aria-label="Edit saved game"]', 'EDIT', 40);

  await browser.close();
}

main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });

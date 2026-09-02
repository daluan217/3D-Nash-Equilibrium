// RED-APP-5 probe: does Escape close the "Edit saved game" dialog?
// Angle 4 (nested dialogs / Escape behaviour with the focus trap).
// Reads src/App.tsx around the "Close whichever foreground modal is open on
// Escape" useEffect (~line 1817): it lists isFeedbackOpen, isSaveModalOpen,
// isAuthModalOpen but NOT isEditModalOpen. This probe drives the real UI to
// confirm that omission is reachable and produces wrong behaviour.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3062';
const uniq = Date.now();
const username = `redapp5_${uniq}`;
const email = `redapp5_${uniq}@example.com`;
const password = 'TestPass123';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Dismiss tour if it auto-opens
  const exitTourBtn = page.getByRole('button', { name: /exit tour/i });
  if (await exitTourBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await exitTourBtn.click();
  }

  // Open Sign In / Sign Up
  await page.getByRole('button', { name: /sign in.*sign up/i }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label="Account"]', { timeout: 5000 });

  // Switch to register mode
  await page.getByRole('button', { name: /create.*account|sign up here|register/i }).first().click().catch(async () => {
    // fallback: click text "Sign Up" link inside login mode
    await page.getByText(/sign up/i).last().click();
  });

  await page.waitForTimeout(300);

  // Fill registration form using placeholders
  await page.getByPlaceholder('game_theorist').fill(username);
  await page.getByPlaceholder('john@example.com').fill(email);
  const pwFields = page.getByPlaceholder('••••••••');
  const pwCount = await pwFields.count();
  console.log('password fields found:', pwCount);
  await pwFields.nth(0).fill(password);
  await pwFields.nth(1).fill(password);

  await page.getByRole('button', { name: /register account/i }).click();
  await page.waitForTimeout(800);

  const authSuccessText = await page.locator('body').innerText();
  console.log('post-register mode has success banner:', authSuccessText.includes('successfully'));

  // Now should be in login mode (auto-verified). Fill login form.
  await page.getByPlaceholder(/example\.com or username/i).fill(email);
  await page.getByPlaceholder('••••••••').first().fill(password);
  await page.getByRole('button', { name: /^login$/i }).click();
  await page.waitForTimeout(800);

  const bodyAfterLogin = await page.locator('body').innerText();
  console.log('logged in (has Save Preset control candidate):', bodyAfterLogin.includes('Save Preset'));

  // Open Save modal
  const savePresetBtn = page.getByRole('button', { name: /save preset/i });
  if (!(await savePresetBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    console.log('FAIL: Save Preset button not visible after login');
    await page.screenshot({ path: '/tmp/red-app-5-after-login.png', fullPage: true });
    await browser.close();
    return;
  }
  await savePresetBtn.click();
  await page.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });

  const gameName = `RedApp5 Game ${uniq}`;
  await page.getByPlaceholder('e.g. Battle of the Sexes 2.0').fill(gameName);
  await page.getByRole('button', { name: /^save game profile$/i }).click();
  await page.waitForTimeout(800);

  const afterSave = await page.locator('[role="dialog"]').count();
  console.log('dialogs open after save submit:', afterSave);

  // Reload so the saved game list is fresh (also tests persistence angle)
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const exitTourBtn2 = page.getByRole('button', { name: /exit tour/i });
  if (await exitTourBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
    await exitTourBtn2.click();
  }

  // Find the game entry and click its Edit (pencil) button
  const editBtn = page.getByRole('button', { name: new RegExp(`^Edit ${gameName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  const editVisible = await editBtn.first().isVisible({ timeout: 5000 }).catch(() => false);
  console.log('edit button visible:', editVisible);
  if (!editVisible) {
    await page.screenshot({ path: '/tmp/red-app-5-no-edit-btn.png', fullPage: true });
    console.log('body snippet:', (await page.locator('body').innerText()).slice(0, 2000));
    await browser.close();
    return;
  }
  await editBtn.first().click();

  const editDialog = page.locator('[role="dialog"][aria-label="Edit saved game"]');
  await editDialog.waitFor({ state: 'visible', timeout: 5000 });
  console.log('Edit dialog opened: true');

  // Press Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  const stillOpen = await editDialog.isVisible().catch(() => false);
  console.log('RESULT: Edit dialog still visible after Escape =', stillOpen);

  // Sanity control: does Escape close the Save modal? (known-good comparison)
  await editDialog.locator('button', { hasText: /cancel/i }).click().catch(async () => {
    // try close X
    await page.getByRole('button', { name: /close dialog/i }).click().catch(() => {});
  });
  await page.waitForTimeout(300);

  await savePresetBtn.click();
  await page.waitForSelector('[role="dialog"][aria-label="Save custom game"]', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const saveStillOpen = await page.locator('[role="dialog"][aria-label="Save custom game"]').isVisible().catch(() => false);
  console.log('CONTROL: Save dialog still visible after Escape =', saveStillOpen);

  console.log('console errors during run:', consoleErrors.length ? consoleErrors : 'none');

  await browser.close();
}

main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });

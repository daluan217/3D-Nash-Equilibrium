// RED-DESKTOP-20 angle 2 probe #2: POST /api/auth/login goes through a RAW
// `fetch(getApiUrl(...))` (App.tsx ~3491), not the account client, and reads
// the body with its own try/catch that falls back to
// `{error:"Server returned invalid response..."}` on a parse failure -- but
// then still branches on `res.ok`. A 200 + non-JSON body (captive portal /
// misbehaving proxy on the user-configurable cloud apiBaseUrl) takes the
// SUCCESS branch: updateAuthToken(data.token) [undefined], then
// `data.user.username` throws, caught by the outer catch which sets
// authError -- AFTER the modal has already been closed by
// setIsAuthModalOpen(false) two lines earlier. Does the user see a silent,
// unexplained "success" (modal closes) while not actually being logged in?
import { chromium } from 'playwright';
import { startOwnServer, ELECTRON_UA } from './harnesslib.mjs';

const WT = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22';
const PORT = 4897;
const MOCK_BASE = 'http://127.0.0.1:4899';

async function main() {
  const srv = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'd20-logincp' });
  console.log('server up:', srv.base, 'bundle', srv.bundle);

  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: ELECTRON_UA });
  const page = await context.newPage();
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  // Point cloud mode at the mock BEFORE any login attempt -- logged OUT state.
  await page.evaluate((mockBase) => {
    localStorage.setItem('nash_sim_db_mode', 'cloud');
    localStorage.setItem('nash_sim_api_base', mockBase);
  }, MOCK_BASE);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: /sign in.*sign up/i }).first().click();
  const authDlg = page.locator('[role="dialog"][aria-label="Account"]');
  await authDlg.waitFor({ state: 'visible', timeout: 5000 });
  const loginEmail = authDlg.locator('input[placeholder*="example.com or username"]');
  await loginEmail.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
    // might default to register mode -- switch to login
    await authDlg.getByRole('button', { name: /^log in$/i }).click({ timeout: 2000 }).catch(() => {});
  });
  await loginEmail.fill('redmock@example.com');
  await authDlg.locator('input[placeholder="••••••••"]').first().fill('Password123');

  const dlgVisibleBefore = await authDlg.isVisible();
  console.log('auth dialog visible BEFORE submit:', dlgVisibleBefore);

  await authDlg.getByRole('button', { name: /^login$/i }).click();
  await page.waitForTimeout(1500);

  const dlgVisibleAfter = await authDlg.isVisible().catch(() => false);
  console.log('auth dialog visible AFTER submit (captive-portal 200+HTML response):', dlgVisibleAfter);
  console.log('RESULT: dialog closed as if login succeeded =', !dlgVisibleAfter);

  const tokenAfter = await page.evaluate(() => localStorage.getItem('nash_sim_token_cloud'));
  console.log('nash_sim_token_cloud after this flow:', JSON.stringify(tokenAfter));

  await page.screenshot({ path: '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/red20-desktop/probe2-after-login.png', fullPage: false }).catch(() => {});

  console.log('--- console/page errors (last 25) ---');
  for (const m of consoleMsgs.slice(-25)) console.log(m);

  await browser.close();
  srv.child.kill('SIGKILL');
  process.exit(0);
}

main().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });

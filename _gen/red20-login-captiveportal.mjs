// RED-DESKTOP-20/001 browser fixtures for captive portals, delayed auth
// continuations, and route-semantic success bodies. Run after npm run build.
// Examples: node _gen/red20-login-captiveportal.mjs
//   MOCK_LOGIN_VALID_JSON=1 node _gen/red20-login-captiveportal.mjs
//   AUTH_SCENARIO=login-delayed-close node _gen/red20-login-captiveportal.mjs
//   AUTH_SCENARIO=login-delayed-success node _gen/red20-login-captiveportal.mjs
//   AUTH_SCENARIO=forgot-empty node _gen/red20-login-captiveportal.mjs
//   AUTH_SCENARIO=forgot-valid node _gen/red20-login-captiveportal.mjs
//   AUTH_SCENARIO=register-valid|register-malformed node _gen/red20-login-captiveportal.mjs
//   AUTH_SCENARIO=verify-valid|verify-malformed node _gen/red20-login-captiveportal.mjs
//   AUTH_SCENARIO=reset-valid|reset-malformed node _gen/red20-login-captiveportal.mjs
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startOwnServer, ELECTRON_UA } from './harnesslib.mjs';
import { closeTour } from '../src/e2e/tour.mjs';

const APP_PORT = Number(process.env.AUTH_APP_PORT ?? '4937');
const MOCK_PORT = Number(process.env.AUTH_MOCK_PORT ?? '4999');
const scenario = process.env.AUTH_SCENARIO
  ?? (process.env.MOCK_LOGIN_VALID_JSON === '1' ? 'login-valid' : 'login-html');
const delayMs = Number(process.env.AUTH_DELAY_MS ?? '1200');
const firstDelayMs = Number(process.env.AUTH_FIRST_DELAY_MS ?? String(delayMs));
const secondDelayMs = Number(process.env.AUTH_SECOND_DELAY_MS ?? String(Math.max(delayMs * 2, delayMs + 600)));
const picture = process.env.AUTH_PICTURE
  ?? `/tmp/red20-desktop/h1-auth-${scenario}.png`;

let loginCalls = 0;
let resolvedLoginCalls = 0;
let forgotResolved = false;
let registerResolved = false;
let verifyResolved = false;
let resetResolved = false;
const mock = createServer((req, res) => {
  const url = req.url ?? '';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST' && url === '/api/auth/login') {
    if (scenario === 'login-html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Please sign in to the WiFi network to continue.</body></html>');
      return;
    }
    const call = ++loginCalls;
    const token = scenario === 'login-delayed-close' ? `race-${call}-token` : 'fake.valid.token';
    const wait = scenario === 'login-delayed-close'
      ? (call === 1 ? firstDelayMs : secondDelayMs)
      : delayMs;
    setTimeout(() => {
      resolvedLoginCalls = call;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        token,
        user: { id: 'u1', username: 'redmock', email: 'redmock@example.com' },
        localGames: 0,
      }));
    }, wait);
    return;
  }
  if (req.method === 'POST' && url === '/api/auth/forgot-password') {
    const valid = scenario !== 'forgot-empty';
    setTimeout(() => {
      forgotResolved = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(valid ? JSON.stringify({ success: true, message: 'Recovery code sent.' }) : '{}');
    }, delayMs);
    return;
  }
  if (req.method === 'POST' && url === '/api/auth/register') {
    const valid = scenario !== 'register-malformed';
    setTimeout(() => {
      registerResolved = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(valid ? JSON.stringify({
        success: true,
        message: 'Registration successful! A 6-digit confirmation code has been sent to your email address.',
        email: 'redmock@example.com',
        via: 'smtp',
        previewUrl: null,
      }) : '{}');
    }, delayMs);
    return;
  }
  if (req.method === 'POST' && url === '/api/auth/verify') {
    const valid = scenario !== 'verify-malformed';
    setTimeout(() => {
      verifyResolved = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(valid ? JSON.stringify({
        success: true,
        message: 'Email verified successfully! You can now log in.',
        username: 'redmock',
      }) : '{}');
    }, delayMs);
    return;
  }
  if (req.method === 'POST' && url === '/api/auth/reset-password') {
    const valid = scenario !== 'reset-malformed';
    setTimeout(() => {
      resetResolved = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(valid ? JSON.stringify({
        success: true,
        message: 'Password reset successfully! You can now log in with your new password.',
      }) : '{}');
    }, delayMs);
    return;
  }
  if (req.method === 'GET' && url === '/api/auth/me') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'u1', username: 'redmock', email: 'redmock@example.com' }));
    return;
  }
  if (req.method === 'GET' && url === '/api/games') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found in auth fixture' }));
});

const listen = () => new Promise((resolve, reject) => {
  mock.once('error', reject);
  mock.listen(MOCK_PORT, '127.0.0.1', resolve);
});
const closeMock = () => new Promise((resolve) => mock.close(() => resolve()));
const waitFor = async (predicate, label) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture timed out waiting for ${label}`);
};

let srv = null;
let browser = null;
try {
  await listen();
  srv = await startOwnServer(process.cwd(), APP_PORT, { mode: 'desktop', tag: `h1-auth-${scenario}` });
  browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: ELECTRON_UA });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !/status of 404/i.test(message.text())) errors.push(`[error] ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));
  const dialog = page.locator('[role="dialog"][aria-label="Account"]');
  const submit = () => dialog.locator('form button[type="submit"]');
  const openAuth = async () => {
    await page.getByRole('button', { name: /sign in.*sign up/i }).first().waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: /sign in.*sign up/i }).first().click();
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.locator('form').waitFor({ state: 'visible', timeout: 5000 });
  };
  const fillLogin = async () => {
    await dialog.locator('input[placeholder*="example.com or username"]').fill('redmock@example.com');
    await dialog.locator('input[placeholder="••••••••"]').first().fill('Password123');
  };
  const openRegistration = async () => {
    await dialog.getByRole('button', { name: /sign up/i }).click();
    await dialog.locator('input[placeholder="game_theorist"]').waitFor({ state: 'visible', timeout: 5000 });
  };
  const fillRegistration = async () => {
    await dialog.locator('input[placeholder="game_theorist"]').fill('redmock');
    await dialog.locator('input[placeholder="john@example.com"]').fill('redmock@example.com');
    const passwords = dialog.locator('input[placeholder="••••••••"]');
    await passwords.nth(0).fill('Password123');
    await passwords.nth(1).fill('Password123');
  };
  const openForgot = async () => {
    await dialog.getByRole('button', { name: /forgot your password/i }).click();
    await dialog.locator('input[placeholder="john@example.com"]').fill('redmock@example.com');
  };
  const fillVerification = async () => {
    await dialog.locator('input[placeholder="123456"]').fill('123456');
  };
  const fillReset = async () => {
    await dialog.locator('input[placeholder="123456"]').fill('123456');
    const passwords = dialog.locator('input[placeholder="••••••••"]');
    await passwords.nth(0).fill('NewPassword123');
    await passwords.nth(1).fill('NewPassword123');
  };
  const waitForLogin = async (count) => waitFor(() => resolvedLoginCalls >= count, `login response ${count}`);
  const waitForForgot = async () => waitFor(() => forgotResolved, 'forgot-password response');
  const waitForRegister = async () => waitFor(() => registerResolved, 'register response');
  const waitForVerify = async () => waitFor(() => verifyResolved, 'verify response');
  const waitForReset = async () => waitFor(() => resetResolved, 'reset-password response');
  const dismissGuidedTour = async () => {
    const { closed, via } = await closeTour(page, { timeout: 20000 });
    const gone = await page.waitForFunction(
      () => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
      null, { timeout: 10000 },
    ).then(() => true).catch(() => false);
    if (!gone) throw new Error(`guided tour remained open (closeTour closed=${closed} via=${via})`);
  };

  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((base) => {
    localStorage.setItem('nash_sim_db_mode', 'cloud');
    localStorage.setItem('nash_sim_api_base', base);
  }, `http://127.0.0.1:${MOCK_PORT}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The app intentionally auto-opens this on anonymous loads. Use the shared
  // measured closeTour helper so the scrim cannot race the auth controls.
  await dismissGuidedTour();

  if (scenario === 'login-delayed-close') {
    await openAuth();
    await fillLogin();
    await submit().click();
    await page.waitForTimeout(150);
    await dialog.locator('button[aria-label="Close dialog"]').click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });

    // Reopen and submit a second request before the first response arrives.
    // The first continuation must not close this new session or clear loading.
    await openAuth();
    await fillLogin();
    await submit().click();
    await waitForLogin(1);
    const mid = {
      dialogVisible: await dialog.isVisible(),
      token: await page.evaluate(() => localStorage.getItem('nash_sim_token_cloud')),
      buttonText: await submit().innerText(),
      buttonDisabled: await submit().isDisabled(),
      loginCalls,
      errors: [...errors],
    };
    await page.screenshot({ path: picture, fullPage: false });
    if (!mid.dialogVisible || mid.token !== null || !mid.buttonDisabled || mid.errors.length > 0 || loginCalls !== 2) {
      throw new Error(`stale delayed response corrupted the reopened auth session: ${JSON.stringify(mid)}`);
    }
    await waitForLogin(2);
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    const final = {
      dialogVisible: false,
      token: await page.evaluate(() => localStorage.getItem('nash_sim_token_cloud')),
      errors: [...errors],
    };
    console.log('RESULT:', JSON.stringify({ scenario, mid, final, picture }));
    if (final.dialogVisible || final.token !== 'race-2-token' || final.errors.length > 0) {
      throw new Error(`current delayed login did not complete cleanly: ${JSON.stringify(final)}`);
    }
  } else if (scenario === 'login-delayed-success') {
    await openAuth();
    await fillLogin();
    await submit().click();
    await waitForLogin(1);
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    const result = {
      dialogVisible: false,
      token: await page.evaluate(() => localStorage.getItem('nash_sim_token_cloud')),
      errors: [...errors],
      picture,
    };
    await page.screenshot({ path: picture, fullPage: false });
    console.log('RESULT:', JSON.stringify({ scenario, ...result }));
    if (result.dialogVisible || result.token !== 'fake.valid.token' || result.errors.length > 0) {
      throw new Error(`delayed valid login control did not complete cleanly: ${JSON.stringify(result)}`);
    }
  } else if (scenario === 'register-valid' || scenario === 'register-malformed') {
    await openAuth();
    await openRegistration();
    await fillRegistration();
    await dialog.getByRole('button', { name: /register account/i }).click();
    await waitForRegister();
    const expectedHeading = scenario === 'register-valid' ? 'Verify Email' : 'Create Account';
    const headingNode = dialog.locator('span.font-bold').filter({ hasText: expectedHeading }).first();
    await headingNode.waitFor({ state: 'visible', timeout: 5000 });
    const result = {
      heading: await headingNode.innerText(),
      invalidResponse: await dialog.getByText(/server returned invalid response/i).count(),
      dialogVisible: await dialog.isVisible(),
      errors: [...errors],
      picture,
    };
    await page.screenshot({ path: picture, fullPage: false });
    console.log('RESULT:', JSON.stringify({ scenario, ...result }));
    if (scenario === 'register-valid') {
      if (result.heading !== 'Verify Email' || result.invalidResponse !== 0 || result.errors.length > 0) {
        throw new Error(`valid register response did not advance to verification: ${JSON.stringify(result)}`);
      }
    } else if (result.heading !== 'Create Account' || result.invalidResponse === 0 || result.errors.length > 0) {
      throw new Error(`malformed register response advanced the flow: ${JSON.stringify(result)}`);
    }
  } else if (scenario === 'verify-valid' || scenario === 'verify-malformed') {
    await openAuth();
    await openRegistration();
    await fillRegistration();
    await dialog.getByRole('button', { name: /register account/i }).click();
    await waitForRegister();
    await dialog.locator('input[placeholder="123456"]').waitFor({ state: 'visible', timeout: 5000 });
    await fillVerification();
    await dialog.getByRole('button', { name: /verify & setup account/i }).click();
    await waitForVerify();
    const expectedHeading = scenario === 'verify-valid' ? 'Sign In' : 'Verify Email';
    const headingNode = dialog.locator('span.font-bold').filter({ hasText: expectedHeading }).first();
    await headingNode.waitFor({ state: 'visible', timeout: 5000 });
    const result = {
      heading: await headingNode.innerText(),
      invalidResponse: await dialog.getByText(/server returned invalid response/i).count(),
      dialogVisible: await dialog.isVisible(),
      errors: [...errors],
      picture,
    };
    await page.screenshot({ path: picture, fullPage: false });
    console.log('RESULT:', JSON.stringify({ scenario, ...result }));
    if (scenario === 'verify-valid') {
      if (result.heading !== 'Sign In' || result.invalidResponse !== 0 || result.errors.length > 0) {
        throw new Error(`valid verify response did not advance to login: ${JSON.stringify(result)}`);
      }
    } else if (result.heading !== 'Verify Email' || result.invalidResponse === 0 || result.errors.length > 0) {
      throw new Error(`malformed verify response advanced the flow: ${JSON.stringify(result)}`);
    }
  } else if (scenario === 'reset-valid' || scenario === 'reset-malformed') {
    await openAuth();
    await openForgot();
    await dialog.getByRole('button', { name: /send recovery code/i }).click();
    await waitForForgot();
    await dialog.locator('input[placeholder="123456"]').waitFor({ state: 'visible', timeout: 5000 });
    await fillReset();
    await dialog.getByRole('button', { name: /^reset password$/i }).click();
    await waitForReset();
    const expectedHeading = scenario === 'reset-valid' ? 'Sign In' : 'Reset Password';
    const headingNode = dialog.locator('span.font-bold').filter({ hasText: expectedHeading }).first();
    await headingNode.waitFor({ state: 'visible', timeout: 5000 });
    const result = {
      heading: await headingNode.innerText(),
      invalidResponse: await dialog.getByText(/server returned invalid response/i).count(),
      dialogVisible: await dialog.isVisible(),
      errors: [...errors],
      picture,
    };
    await page.screenshot({ path: picture, fullPage: false });
    console.log('RESULT:', JSON.stringify({ scenario, ...result }));
    if (scenario === 'reset-valid') {
      if (result.heading !== 'Sign In' || result.invalidResponse !== 0 || result.errors.length > 0) {
        throw new Error(`valid reset response did not advance to login: ${JSON.stringify(result)}`);
      }
    } else if (result.heading !== 'Reset Password' || result.invalidResponse === 0 || result.errors.length > 0) {
      throw new Error(`malformed reset response advanced the flow: ${JSON.stringify(result)}`);
    }
  } else if (scenario === 'forgot-empty' || scenario === 'forgot-valid') {
    await openAuth();
    await dialog.getByRole('button', { name: /forgot your password/i }).click();
    await dialog.locator('input[placeholder="john@example.com"]').fill('redmock@example.com');
    await dialog.getByRole('button', { name: /send recovery code/i }).click();
    await waitForForgot();
    const wantedHeading = scenario === 'forgot-valid' ? 'Reset Password' : 'Forgot Password';
    const headingNode = dialog.locator('span.font-bold').filter({ hasText: wantedHeading }).first();
    await headingNode.waitFor({ state: 'visible', timeout: 5000 });
    const heading = await headingNode.innerText();
    const result = {
      heading,
      resetFields: await dialog.locator('input[placeholder="••••••••"]').count(),
      invalidResponse: await dialog.getByText(/server returned invalid response/i).count(),
      dialogVisible: await dialog.isVisible(),
      errors: [...errors],
      picture,
    };
    await page.screenshot({ path: picture, fullPage: false });
    console.log('RESULT:', JSON.stringify({ scenario, ...result }));
    if (scenario === 'forgot-empty') {
      if (result.heading !== 'Forgot Password' || result.resetFields !== 0 || result.invalidResponse === 0 || !result.dialogVisible || result.errors.length > 0) {
        throw new Error(`200 {} advanced the forgot-password flow: ${JSON.stringify(result)}`);
      }
    } else if (result.heading !== 'Reset Password' || result.resetFields !== 2 || result.invalidResponse !== 0 || result.errors.length > 0) {
      throw new Error(`valid forgot-password response did not advance cleanly: ${JSON.stringify(result)}`);
    }
  } else {
    await openAuth();
    await fillLogin();
    console.log('auth dialog visible BEFORE submit:', await dialog.isVisible());
    await submit().click();
    if (scenario === 'login-valid') {
      await waitForLogin(1);
      await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    } else await page.waitForTimeout(700);
    const result = {
      dialogVisible: scenario === 'login-valid' ? false : await dialog.isVisible().catch(() => false),
      errorCard: (await page.getByText(/something went wrong/i).count()) > 0,
      authError: await dialog.locator('div').filter({ hasText: /connection error|invalid response/i }).count().catch(() => 0),
      token: await page.evaluate(() => localStorage.getItem('nash_sim_token_cloud')),
      errors,
      picture,
    };
    await page.screenshot({ path: picture, fullPage: false });
    console.log('RESULT:', JSON.stringify({ scenario, ...result }));
    if (scenario === 'login-valid') {
      if (result.dialogVisible || result.errorCard || result.token !== 'fake.valid.token' || result.errors.length > 0) throw new Error('valid JSON control did not complete cleanly');
    } else if (!result.dialogVisible || result.errorCard || result.token !== null || result.errors.length > 0 || result.authError === 0) {
      throw new Error('200/HTML response was not kept inside the auth dialog');
    }
  }
} finally {
  if (browser) await browser.close();
  if (srv?.child) srv.child.kill('SIGKILL');
  await closeMock().catch(() => {});
}

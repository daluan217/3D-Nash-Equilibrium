import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const DIST_SERVER = path.join(ROOT, 'dist/server.cjs');
const PORT = Number(process.env.RED7_PORT || 4321);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH_SECRET = process.env.RED7_AUTH_SECRET || 'red7-auth-secret';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function signToken(claims) {
  const payload = b64url(JSON.stringify(claims));
  const sig = b64url(crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

async function waitReady(url, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready at ${url}`);
}

async function main() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'red7-cwd-'));
  const userData = mkdtempSync(path.join(tmpdir(), 'red7-userdata-'));
  const server = spawn('node', [DIST_SERVER], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      AUTH_SECRET,
      ELECTRON_USER_DATA_PATH: userData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  server.stdout.on('data', (d) => logs.push(`[stdout] ${String(d)}`));
  server.stderr.on('data', (d) => logs.push(`[stderr] ${String(d)}`));

  let browser;
  try {
    await waitReady(`${BASE}/`);

    const uniq = Date.now();
    const identity = {
      username: `red7u${uniq}`,
      email: `red7u${uniq}@example.com`,
      password: 'TestPass123',
    };

    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(identity),
    });
    if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: identity.email, password: identity.password }),
    });
    const loginJson = await login.json();
    if (!login.ok) throw new Error(`login failed: ${login.status} ${JSON.stringify(loginJson)}`);

    const goodToken = loginJson.token;
    const user = loginJson.user;

    // Seed one saved game to make the signed-in state realistic.
    const save = await fetch(`${BASE}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `****** },
      body: JSON.stringify({
        name: 'RED7 baseline game',
        description: 'baseline',
        payoffs: { a11: 1, b11: 1, a12: 0, b12: 0, a21: 0, b21: 0, a22: 2, b22: 2 },
      }),
    });
    if (!save.ok) throw new Error(`seed save failed: ${save.status} ${await save.text()}`);

    const goodPayload = JSON.parse(Buffer.from(goodToken.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const expiredToken = signToken({
      sub: user.id,
      ver: typeof goodPayload.ver === 'number' ? goodPayload.ver : 0,
      exp: Date.now() - 5_000,
      nonce: b64url(crypto.randomBytes(8)),
    });

    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });

    // Simulate a mid-session expiry: app boots "signed in" from /api/auth/me,
    // then write operations use the now-expired token and hit 401.
    let meCalls = 0;
    await context.route('**/api/auth/me', async (route) => {
      meCalls++;
      if (meCalls === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(user),
        });
      } else {
        await route.continue();
      }
    });

    const page = await context.newPage();
    await page.addInitScript((token) => {
      localStorage.setItem('nash_sim_db_mode', 'local');
      localStorage.setItem('nash_sim_token_local', token);
    }, expiredToken);

    await page.goto(BASE, { waitUntil: 'networkidle' });

    const exitTour = page.getByRole('button', { name: /exit tour/i });
    if (await exitTour.isVisible({ timeout: 2500 }).catch(() => false)) {
      await exitTour.click();
    }

    const savePreset = page.getByRole('button', { name: /save preset/i }).first();
    await savePreset.click();

    const dialog = page.locator('[role="dialog"][aria-label="Save custom game"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.locator('input[required]').first().fill('RED7 Expired Save');
    await dialog.getByRole('button', { name: /^save$/i }).click();

    const errorText = await dialog.locator('text=/invalid or expired session|unauthorized/i').first().textContent({ timeout: 5000 }).catch(() => null);
    const hasReauthCta = await dialog.getByRole('button', { name: /sign in \/ sign up/i }).isVisible().catch(() => false);

    const result = {
      command: 'node _gen/red7/RED-APP-7/angle1-expired-token-save.mjs',
      meCalls,
      expected: 'On save with an expired token, UI should switch to a re-auth prompt (Sign In / Sign Up CTA) without surfacing raw session errors.',
      observed: {
        saveErrorText: errorText,
        hasReauthCta,
      },
      pass: Boolean(hasReauthCta),
    };
    console.log(JSON.stringify(result, null, 2));

    if (result.pass) process.exitCode = 0;
    else process.exitCode = 23;

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGKILL');
    await new Promise((r) => server.once('exit', r));
    rmSync(cwd, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    if (process.exitCode && logs.length) {
      console.error(logs.slice(-20).join(''));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

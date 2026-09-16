/* INTEGRATION — BLUE-LOOP-APP-21C: a failed verification email must not return
 * the mail provider's own diagnostics to the browser.
 *
 * THE DEFECT (live-reproduced on this branch at c2aafd5, registering through
 * the real UI against the repo's .env): POST /api/register caught the SMTP
 * error and returned `err.message` verbatim inside a 500, so the Account
 * modal's role="alert" rendered, to the visitor:
 *
 *   "Could not send verification email: SMTP Mail delivery failed: Invalid
 *    login: 535-5.7.8 Username and Password not accepted. For more information,
 *    go to https://support.google.com/mail/?p=BadCredentials
 *    af79cd13be357-93b781dfbf1sm327404985a.11 - gsmtp. Please check your server
 *    SMTP settings."
 *
 * That names the mail host, the exact credential-failure code and a per-attempt
 * message id, and it blames the VISITOR for an operator-side misconfiguration
 * ("check your server SMTP settings" — not their server). Both 500 sites did it
 * (the resend-to-an-unverified-user branch and the new-registration branch).
 *
 * THE FIX: `verificationEmailFailure()` in server.ts logs the provider text to
 * the server console and returns one fixed, non-diagnostic sentence.
 *
 * WHY THIS CANNOT PASS BY COINCIDENCE: SMTP_HOST points at a closed port on
 * 127.0.0.1, so the send ALWAYS fails and the 500 branch is ALWAYS taken --
 * the test asserts it got a 500 with a non-empty error first, so a route that
 * stopped failing (or stopped existing) fails the test rather than passing it
 * vacuously. The leak assertions then run on a string known to exist.
 *
 *   node src/integration/register-smtp-leak.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.RSL_TEST_PORT || '3187';
const BASE = `http://127.0.0.1:${PORT}`;
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const userData = mkdtempSync(path.join(tmpdir(), 'nash-rsl-'));

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const server = spawn('node', [path.join(serverDir, 'dist/server.cjs')], {
  cwd: userData,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    // A closed port: nodemailer's connect fails, so the SMTP catch is certain.
    // Credentials are present but meaningless -- the point is a FAILING send,
    // not a particular provider's wording.
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '2',
    SMTP_USER: 'rsl-test-user',
    SMTP_PASS: 'rsl-test-pass',
    SMTP_FROM: 'rsl@example.invalid',
    ELECTRON_USER_DATA_PATH: undefined, // hosted mode: do NOT auto-verify
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1000) });
      if (r.ok || r.status === 404) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  if (!await waitForServer()) throw new Error(`server never came up on ${PORT}:\n${serverLog.slice(-800)}`);

  const uniq = `rsl${Date.now()}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uniq, email: `${uniq}@example.invalid`, password: 'TestPass123' }),
  });
  const body = await res.json().catch(() => ({}));
  const shown = String(body.error ?? '');

  // The branch under test must actually have been taken.
  record('the failing-SMTP registration really did take the 500 error branch',
    res.status === 500 && shown.length > 0,
    `status=${res.status} errorChars=${shown.length}`);

  // Each needle is something the provider's own text carries and a user-facing
  // sentence never should. Checked individually so a failure NAMES the leak.
  const LEAKS = [
    ['an SMTP status/enhanced code', /\b\d{3}[- ]\d\.\d\.\d\b/],
    ['the phrase "SMTP"', /SMTP/i],
    ['a mail host or provider URL', /smtp\.|gmail|google|\bmx\b|https?:\/\//i],
    ['a nodemailer/connection error code', /\b(ECONNREFUSED|ETIMEDOUT|EAUTH|ENOTFOUND|ECONNRESET)\b/],
    ['the raw thrown wrapper', /Mail delivery failed/i],
    ['blame aimed at the visitor for server config', /check your server/i],
  ];
  for (const [what, re] of LEAKS) {
    record(`the visitor-facing error does not expose ${what}`, !re.test(shown),
      re.test(shown) ? `leaked: ${JSON.stringify(shown.slice(0, 160))}` : 'absent');
  }

  // Honesty in the other direction: it must still SAY the send failed, so the
  // fix cannot be "return an empty string" or a success shape.
  record('the visitor is still told the verification email did not go out',
    /verification email/i.test(shown) && /again/i.test(shown),
    JSON.stringify(shown));

  // The detail an operator needs is not destroyed, just moved.
  await new Promise((r) => setTimeout(r, 200));
  record('the provider detail is still logged server-side for operators',
    /verification email send failed/i.test(serverLog),
    /verification email send failed/i.test(serverLog) ? 'present in server log' : 'MISSING from server log');
} finally {
  server.kill('SIGKILL');
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.error('FAILED:\n' + failed.map((f) => ` - ${f.name}: ${f.detail}`).join('\n')); process.exit(1); }

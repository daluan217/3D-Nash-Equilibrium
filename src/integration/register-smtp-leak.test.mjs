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
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForOwnServer } from './ownserver.mjs';
import { fileURLToPath } from 'node:url';

const PORT = process.env.RSL_TEST_PORT || '3187';
const SMTP_PORT = process.env.RSL_SMTP_PORT || '3188';
const BASE = `http://127.0.0.1:${PORT}`;
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const userData = mkdtempSync(path.join(tmpdir(), 'nash-rsl-'));

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

/* A minimal SMTP server that says 250 to the FIRST message and 451 to every
 * one after. Both matter:
 *  - the first send SUCCEEDS, so the unverified user is persisted -- the
 *    new-registration branch DELETES the user whenever the send fails
 *    (server.ts ~3960), so with an always-failing server a second attempt just
 *    re-enters the same branch and the resend site is unreachable. That is why
 *    an earlier version of this test passed while the resend site was reverted:
 *    the mutant SURVIVED, which is how the gap was found.
 *  - the second send FAILS, which is what drives the resend 500. */
let messageCount = 0;
const smtp = createServer((sock) => {
  let inData = false;
  sock.write('220 rsl.test ESMTP\r\n');
  sock.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line) continue;
      if (inData) {
        if (line === '.') {
          inData = false;
          messageCount += 1;
          sock.write(messageCount === 1 ? '250 2.0.0 Ok: queued\r\n' : '451 4.3.0 Mail server temporarily rejected message\r\n');
        }
        continue;
      }
      const verb = line.split(' ')[0].toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') sock.write('250-rsl.test\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (verb === 'AUTH') sock.write('235 2.7.0 Authentication successful\r\n');
      else if (verb === 'MAIL' || verb === 'RCPT') sock.write('250 2.1.0 Ok\r\n');
      else if (verb === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (verb === 'QUIT') { sock.write('221 2.0.0 Bye\r\n'); sock.end(); }
      else sock.write('250 2.0.0 Ok\r\n');
    }
  });
  sock.on('error', () => {});
});
await new Promise((r) => smtp.listen(Number(SMTP_PORT), '127.0.0.1', r));

const server = spawn('node', [path.join(serverDir, 'dist/server.cjs')], {
  cwd: userData,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    // The fake server above: first send OK, every later send refused.
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT,
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
  try { await waitForOwnServer(server, BASE, { timeoutMs: 20000 }); return true; }
  catch (err) { serverLog += `\n${err.message}`; return false; }
}

try {
  if (!await waitForServer()) throw new Error(`server never came up on ${PORT}:\n${serverLog.slice(-800)}`);

  const uniq = `rsl${Date.now()}`;
  const register = async () => {
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uniq, email: `${uniq}@example.invalid`, password: 'TestPass123' }),
    });
    const b = await r.json().catch(() => ({}));
    return { status: r.status, shown: String(b.error ?? '') };
  };

  // BOTH 500 sites leaked, so both are driven. The FIRST call takes the
  // new-registration branch (server.ts ~3962); the SECOND, with the same
  // still-unverified email, takes the resend-to-an-unverified-user branch
  // (~3903). Asserting only the first left half the fix unguarded (reviewer F5).
  const first = await register();
  const second = await register();
  const res = { status: first.status };
  const shown = first.shown;

  // Arm 1 must SUCCEED, or the user is discarded and arm 2 cannot reach the
  // resend site at all -- assert that, so the setup cannot rot into a test
  // that measures the same branch twice.
  record('the first registration succeeded, leaving an UNVERIFIED user for the resend path',
    first.status === 200 || first.status === 201,
    `status=${first.status} body=${JSON.stringify(first.shown.slice(0, 80))}`);
  record('the RESEND branch (same unverified email, send now refused) took its 500 error branch',
    second.status === 500 && second.shown.length > 0,
    `status=${second.status} errorChars=${second.shown.length}`);
  // A FRESH email takes the NEW-REGISTRATION branch (server.ts ~3962) with the
  // send already refused. Re-using `uniq` does NOT work: the resend site (~3903)
  // returns WITHOUT deleting the user, so a repeat lands on 3903 again -- and a
  // version of this test that assumed otherwise let the 3962 mutant SURVIVE.
  const fresh = `${uniq}b`;
  const third = await (async () => {
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fresh, email: `${fresh}@example.invalid`, password: 'TestPass123' }),
    });
    const b = await r.json().catch(() => ({}));
    return { status: r.status, shown: String(b.error ?? '') };
  })();
  record('a FRESH email takes the new-registration 500 branch (the other leak site)',
    third.status === 500 && third.shown.length > 0,
    `status=${third.status} errorChars=${third.shown.length}`);

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
    for (const [label, text] of [['resend', second.shown], ['new-registration', third.shown]]) {
      record(`the ${label} error does not expose ${what}`, !re.test(text),
        re.test(text) ? `leaked: ${JSON.stringify(text.slice(0, 160))}` : 'absent');
    }
  }

  // Honesty in the other direction: it must still SAY the send failed, so the
  // fix cannot be "return an empty string" or a success shape.
  for (const [label, text] of [['resend', second.shown], ['new-registration', third.shown]]) {
    record(`the ${label} path still tells the visitor the verification email did not go out`,
      /verification email/i.test(text) && /again/i.test(text), JSON.stringify(text));
  }

  // The detail an operator needs is not destroyed, just moved.
  await new Promise((r) => setTimeout(r, 200));
  record('the provider detail is still logged server-side for operators',
    /verification email send failed/i.test(serverLog),
    /verification email send failed/i.test(serverLog) ? 'present in server log' : 'MISSING from server log');
} finally {
  server.kill('SIGKILL');
  smtp.close();
  rmSync(userData, { recursive: true, force: true });
}

// ── Review #15: the hosted rollback must not write back a stale snapshot ──
// register (new email) holds its `db` across the SMTP send; when the send fails
// it removes the user and saves. Routes now commit NEW snapshots, so saving the
// held one undid whatever landed meanwhile. Here: a recovery code issued during
// the slow failure must survive it, and so must a retry of the same address whose
// fresh code DID go out. SMTP: the FIRST message to a SLOW address is refused
// after 3 s; every other message is accepted and its code captured.
{
  const PORT2 = String(Number(PORT) + 2);
  const SMTP2 = String(Number(SMTP_PORT) + 2);
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const SLOW = 'slowfail@example.invalid';
  const RETRY = 'retry@example.invalid';
  const slowOnce = new Set([SLOW, RETRY]);
  const codes = {};
  const smtp2 = createServer((sock) => {
    let inData = false; let rcpt = ''; let body = '';
    sock.write('220 rsl2.test ESMTP\r\n');
    sock.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (inData) {
          if (line === '.') {
            inData = false;
            const code = (body.replace(/=\r?\n/g, '').match(/\b\d{6}\b/) || [])[0];
            if (slowOnce.delete(rcpt)) setTimeout(() => sock.write('451 4.3.0 try later\r\n'), 3000);
            else { codes[rcpt] = code; sock.write('250 2.0.0 Ok: queued\r\n'); }
          } else body += line + '\n';
          continue;
        }
        if (!line) continue;
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') sock.write('250-rsl2.test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (verb === 'AUTH') sock.write('235 2.7.0 Authentication successful\r\n');
        else if (verb === 'RCPT') { rcpt = (line.match(/<([^>]+)>/) || [])[1] || ''; sock.write('250 2.1.0 Ok\r\n'); }
        else if (verb === 'MAIL') sock.write('250 2.1.0 Ok\r\n');
        else if (verb === 'DATA') { inData = true; body = ''; sock.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('250 2.0.0 Ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => smtp2.listen(Number(SMTP2), '127.0.0.1', r));
  const userData2 = mkdtempSync(path.join(tmpdir(), 'nash-rsl2-'));
  const server2 = spawn('node', [path.join(serverDir, 'dist/server.cjs')], { cwd: userData2, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', PORT: PORT2, SMTP_HOST: '127.0.0.1', SMTP_PORT: SMTP2, SMTP_USER: 'u', SMTP_PASS: 'p',
      SMTP_FROM: 'rsl2@example.invalid', ELECTRON_USER_DATA_PATH: undefined, IS_ELECTRON: undefined, GCS_BUCKET_NAME: undefined } });
  const post = (url, body) => fetch(`${BASE2}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }), () => ({ status: 0, json: null }));
  try {
    await waitForOwnServer(server2, BASE2, { timeoutMs: 20000 });
    const V = 'victim@example.invalid';
    const reg = await post('/api/auth/register', { username: 'victim', email: V, password: 'TestPass123' });
    const ver = await post('/api/auth/verify', { email: V, code: codes[V] });
    record('rollback setup: a verified hosted account exists (code read from the mail)', reg.status === 200 && ver.status === 200,
      `register=${reg.status} verify=${ver.status} code=${codes[V] ? 'captured' : 'none'}`);
    delete codes[V];
    const slowReg = post('/api/auth/register', { username: 'slowfail', email: SLOW, password: 'TestPass123' });
    await new Promise((r) => setTimeout(r, 800));
    const forgot = await post('/api/auth/forgot-password', { email: V });
    const rolled = await slowReg;
    record('rollback setup: the recovery code was issued WHILE the other registration waited, which then failed',
      forgot.status === 200 && !!codes[V] && rolled.status === 500, `forgot=${forgot.status} code=${codes[V] ? 'captured' : 'none'} slowRegister=${rolled.status}`);
    const reset = await post('/api/auth/reset-password', { email: V, code: codes[V], newPassword: 'NewPass456' });
    record("the failed registration's rollback did not erase a recovery code issued meanwhile: the reset works",
      reset.status === 200, `reset=${reset.status} ${JSON.stringify(reset.json).slice(0, 120)}`);

    const first = post('/api/auth/register', { username: 'retry', email: RETRY, password: 'TestPass123' });
    await new Promise((r) => setTimeout(r, 800));
    const retry = await post('/api/auth/register', { username: 'retry', email: RETRY, password: 'TestPass123' });
    const firstDone = await first;
    const retryVer = await post('/api/auth/verify', { email: RETRY, code: codes[RETRY] });
    record("a retry whose code went out survives the first attempt's rollback: that code verifies",
      retry.status === 200 && firstDone.status === 500 && !!codes[RETRY] && retryVer.status === 200,
      `retry=${retry.status} first=${firstDone.status} verify=${retryVer.status} ${JSON.stringify(retryVer.json).slice(0, 100)}`);
  } catch (e) {
    record('rollback phase completed without an exception', false, String(e?.stack || e).slice(0, 300));
  } finally {
    server2.kill('SIGKILL'); smtp2.close();
    rmSync(userData2, { recursive: true, force: true });
  }
}

const EXPECTED_CHECKS = 22;
if (results.length !== EXPECTED_CHECKS) {
  console.error(`FAILED: ${results.length} checks ran, expected exactly ${EXPECTED_CHECKS}`);
  process.exit(1);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.error('FAILED:\n' + failed.map((f) => ` - ${f.name}: ${f.detail}`).join('\n')); process.exit(1); }

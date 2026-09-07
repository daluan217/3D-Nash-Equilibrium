/* INTEGRATION — RED-DESKTOP-16/001: a desktop session's Bearer token that was
 * PRESENTED but no longer resolves (garbled, or invalidated by a REAL
 * password reset) must be REFUSED (401) on every game CRUD route, never
 * silently re-owned by the shared local-owner identity. The old
 * `getAuthUser(req) ?? ensureLocalOwner()` collapsed "no token" and "a dead
 * token" into the same fallback, so a stale account session's save landed
 * under `local-owner` with an ordinary 200/"Saved successfully" and no error
 * anywhere, while the account's own prior games could simultaneously vanish
 * from the same list.
 *
 * Real routes only: the reset flow goes through the actual
 * forgot-password/reset-password endpoints (Electron returns the recovery
 * code directly, no SMTP needed) — nothing is forged, no db.json hand-edit,
 * no header surgery beyond attaching a Bearer token the server itself minted
 * (then invalidated).
 *
 *   node src/integration/desktop-dead-token-owner.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
const port = Number(process.env.DESKTOP_DEAD_TOKEN_PORT || 4830);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// Boot the production bundle the way the packaged desktop app boots it — see
// desktop-persistence.test.mjs's own comment for why the cwd/env must be
// exactly this and not the repo (no .env, no ambient AUTH_SECRET).
async function boot(userData, thePort) {
  const child = spawn('node', [BUNDLE], {
    cwd: userData,
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT: String(thePort),
      IS_ELECTRON: 'true',
      ELECTRON_USER_DATA_PATH: userData,
      NASH_PAYOFF_TEMPLATE: '1',
      NASH_LLM_TIES: 'template',
      NASH_DIRECTION_CHECKS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming ready on ${thePort} (code ${child.exitCode})\n${log}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${thePort}/api/health`);
      if (r.ok && (await r.json())?.pid === child.pid) return { child, log: () => log };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready on ${thePort}\n${log}`);
}

async function stop(srv) {
  if (!srv?.child || srv.child.exitCode !== null) return;
  const ended = new Promise((res) => srv.child.once('exit', res));
  srv.child.kill('SIGTERM');
  const timer = setTimeout(() => srv.child.kill('SIGKILL'), 4000);
  await ended;
  clearTimeout(timer);
}

// `rawAuth` bypasses the "Bearer " prefix entirely, for the lowercase-scheme
// regression check below — CodeRabbit CLI on #163 (fixed): getAuthUser and
// hasPresentedToken must AGREE on a lowercase "bearer" scheme too, or a
// lowercase-scheme dead token falls through the "no token at all" path,
// same class of bug as the one this suite exists to guard.
async function call(thePort, method, url, { body, token, rawAuth } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (rawAuth !== undefined) headers.authorization = rawAuth;
  else if (token !== undefined && token !== null) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${thePort}${url}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

// Node's `fetch`/undici cannot send TWO separate `Authorization:` header
// lines (a plain object collapses to one value); `http.request` can, via an
// array value — this is how the "first header wins" shape (director's
// structural decision, 2026-09-07) is actually reproduced, not approximated.
function callTwoAuthHeaders(thePort, method, url, authValues, body) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: authValues };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: thePort, path: url, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const game = (tag) => ({
  name: `DeadToken-${tag}`, description: 'desktop-dead-token-owner fixture',
  payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 },
});

const userData = mkdtempSync(path.join(tmpdir(), 'nash-desktop-deadtoken-'));
let srv = null;

try {
  srv = await boot(userData, port);

  const cred = { username: 'deadtokenuser', email: 'deadtoken@example.test', password: 'Sup3rSecret!23' };
  const reg = await call(port, 'POST', '/api/auth/register', { body: cred });
  record('a desktop account registers without SMTP (auto-verify)', reg.status === 200 && reg.json?.success === true,
    `status ${reg.status}`);
  const login = await call(port, 'POST', '/api/auth/login', { body: { email: cred.email, password: cred.password } });
  const token = login.json?.token;
  record('sign-in returns a token', typeof token === 'string' && token.length > 0, `status ${login.status}`);

  // ── Controls: the mechanism must still work normally ─────────────────────
  const baseline = await call(port, 'POST', '/api/games', { token, body: game('valid-token') });
  record('control: a VALID token saves under the account', baseline.status === 200 && baseline.json?.game?.userId
    && baseline.json.game.userId !== 'local-owner', `status ${baseline.status} userId ${baseline.json?.game?.userId}`);

  const noTokenSave = await call(port, 'POST', '/api/games', { body: game('no-token') });
  record('control: NO token still saves as the desktop local owner (unchanged, by design)',
    noTokenSave.status === 200 && noTokenSave.json?.game?.userId === 'local-owner',
    `status ${noTokenSave.status} userId ${noTokenSave.json?.game?.userId}`);
  // This row is left in the local-owner bucket deliberately — it is the
  // baseline the "local-owner bucket got ONLY its own no-token control row"
  // check below expects to still find there.

  // ── The defect surface: a token that WAS presented but does not resolve ──
  const garbled = token.slice(0, -4) + 'dead';
  const garbledSave = await call(port, 'POST', '/api/games', { token: garbled, body: game('garbled') });
  record('THE DEFECT (POST): a garbled token is refused (401), never re-owned by the local owner',
    garbledSave.status === 401 && garbledSave.json?.game === undefined, `status ${garbledSave.status} body ${JSON.stringify(garbledSave.json)}`);

  // Regression (CodeRabbit CLI on #163): the Bearer scheme match must be
  // case-INSENSITIVE, and getAuthUser/hasPresentedToken must agree on it —
  // both a VALID and a DEAD outcome, lowercase-scheme, against real routes.
  const lowerValidSave = await call(port, 'POST', '/api/games', { rawAuth: `bearer ${token}`, body: game('lower-bearer-valid') });
  record('lowercase "bearer" scheme still resolves a VALID token to the account',
    lowerValidSave.status === 200 && lowerValidSave.json?.game?.userId && lowerValidSave.json.game.userId !== 'local-owner',
    `status ${lowerValidSave.status} userId ${lowerValidSave.json?.game?.userId}`);
  const lowerGarbledSave = await call(port, 'POST', '/api/games', { rawAuth: `bearer ${garbled}`, body: game('lower-bearer-garbled') });
  record('lowercase "bearer" scheme with a DEAD token is refused (401), never re-owned',
    lowerGarbledSave.status === 401 && lowerGarbledSave.json?.game === undefined,
    `status ${lowerGarbledSave.status} body ${JSON.stringify(lowerGarbledSave.json)}`);

  // Director's structural decision (2026-09-07, following OPUS-REVIEW-DESKTOP16
  // NOTE 1 + CodeRabbit on server.ts:2066): the invariant is no longer
  // Bearer-specific. ANY Authorization header that does not resolve to a
  // live user must be refused — only a genuinely ABSENT header may fall
  // back to the local owner. Every shape NOTE 1 measured on the pre-fix
  // build, now asserted 401 on the ACTUAL fix.
  const bareBearer = await call(port, 'POST', '/api/games', { rawAuth: 'Bearer', body: game('headershape-bare-bearer') });
  record('a bare "Bearer" header (no space, no token at all) is refused (401), never re-owned',
    bareBearer.status === 401 && bareBearer.json?.game === undefined,
    `status ${bareBearer.status} body ${JSON.stringify(bareBearer.json)}`);

  const whitespaceBearer = await call(port, 'POST', '/api/games', { rawAuth: 'Bearer    ', body: game('headershape-whitespace-bearer') });
  record('"Bearer" followed only by whitespace is refused (401), never re-owned',
    whitespaceBearer.status === 401 && whitespaceBearer.json?.game === undefined,
    `status ${whitespaceBearer.status} body ${JSON.stringify(whitespaceBearer.json)}`);

  const basicAuth = await call(port, 'POST', '/api/games', { rawAuth: 'Basic eHl6', body: game('headershape-basic') });
  record('a "Basic" (non-Bearer) scheme is refused (401), never re-owned',
    basicAuth.status === 401 && basicAuth.json?.game === undefined,
    `status ${basicAuth.status} body ${JSON.stringify(basicAuth.json)}`);

  const tokenAuth = await call(port, 'POST', '/api/games', { rawAuth: 'Token abc', body: game('headershape-token-scheme') });
  record('a "Token" (non-Bearer) scheme is refused (401), never re-owned',
    tokenAuth.status === 401 && tokenAuth.json?.game === undefined,
    `status ${tokenAuth.status} body ${JSON.stringify(tokenAuth.json)}`);

  // Two REAL Authorization header lines (Node keeps only the first) — the
  // second value is the STILL-VALID token (not a garbled one): if the
  // server looked at all headers, or the LAST one, this would succeed
  // (200, account-owned), so refusal here specifically proves the FIRST
  // header is what's masking it, not merely that the second value is dead.
  const twoHeaders = await callTwoAuthHeaders(port, 'POST', '/api/games',
    ['Basic eHl6', `Bearer ${token}`], game('headershape-two-header'));
  record('two Authorization headers (Basic first, VALID Bearer second — the FIRST one wins) is refused (401), never re-owned',
    twoHeaders.status === 401 && twoHeaders.json?.game === undefined,
    `status ${twoHeaders.status} body ${JSON.stringify(twoHeaders.json)}`);

  // Invalidate the REAL token via the real forgot/reset-password routes —
  // exactly what a password reset from another device does server-side
  // (bumps tokenVersion), never a forged header or a db.json edit.
  const fp = await call(port, 'POST', '/api/auth/forgot-password', { body: { email: cred.email } });
  const recoveryCode = fp.json?.recoveryCode;
  record('forgot-password (Electron) returns the recovery code directly', fp.status === 200 && typeof recoveryCode === 'string',
    `status ${fp.status} body ${JSON.stringify(fp.json).slice(0, 120)}`);

  const reset = await call(port, 'POST', '/api/auth/reset-password', {
    body: { email: cred.email, code: recoveryCode, newPassword: 'NewPass456' },
  });
  record('reset-password succeeds through the real route', reset.status === 200 && reset.json?.success === true,
    `status ${reset.status} body ${JSON.stringify(reset.json).slice(0, 120)}`);

  // The OLD token is now genuinely dead (tokenVersion bumped server-side) —
  // reused exactly as a still-open SPA that never re-asked /api/auth/me would.
  const deadSave = await call(port, 'POST', '/api/games', { token, body: game('reset-invalidated') });
  record('THE DEFECT (POST): a token invalidated by a real password reset is refused (401), never re-owned',
    deadSave.status === 401 && deadSave.json?.game === undefined, `status ${deadSave.status} body ${JSON.stringify(deadSave.json)}`);

  const deadPatch = await call(port, 'PATCH', '/api/games/nonexistent-id', { token, body: { name: 'x' } });
  record('THE DEFECT (PATCH): the reset-invalidated token is refused (401) before any DB lookup',
    deadPatch.status === 401, `status ${deadPatch.status} body ${JSON.stringify(deadPatch.json)}`);

  const deadDelete = await call(port, 'DELETE', '/api/games/nonexistent-id', { token });
  record('THE DEFECT (DELETE): the reset-invalidated token is refused (401) before any DB lookup',
    deadDelete.status === 401, `status ${deadDelete.status} body ${JSON.stringify(deadDelete.json)}`);
  // OPUS-REVIEW-DESKTOP16 N4: DELETE used to answer "Unauthorized access."
  // here, the only one of the 4 routes with different wording (the other 3
  // all say "Invalid or expired session."), and App.tsx alerted it verbatim.
  record('DELETE\'s dead-session wording matches GET/POST/PATCH ("Invalid or expired session.")',
    deadDelete.json?.error === 'Invalid or expired session.', `error: ${deadDelete.json?.error}`);

  const deadGet = await call(port, 'GET', '/api/games', { token });
  record('GET with the reset-invalidated token also refuses (401), not a local-owner-scoped list',
    deadGet.status === 401, `status ${deadGet.status} body ${JSON.stringify(deadGet.json)}`);

  // ── The account's own view is unaffected, and the local-owner bucket did
  //    NOT gain a misfiled row from any of the refused writes above ────────
  const newLogin = await call(port, 'POST', '/api/auth/login', { body: { email: cred.email, password: 'NewPass456' } });
  const newToken = newLogin.json?.token;
  record('signing back in with the NEW password returns a fresh token', typeof newToken === 'string' && newToken.length > 0,
    `status ${newLogin.status}`);

  const acctGames = await call(port, 'GET', '/api/games', { token: newToken });
  const acctNames = Array.isArray(acctGames.json) ? acctGames.json.map((g) => g.name) : [];
  record('the account still lists its own valid-token save (nothing lost)',
    acctGames.status === 200 && acctNames.includes('DeadToken-valid-token'), `names: ${acctNames.join(', ')}`);
  record('the account also lists the lowercase-"bearer" valid-token save (case-insensitive scheme works both ways)',
    acctGames.status === 200 && acctNames.includes('DeadToken-lower-bearer-valid'), `names: ${acctNames.join(', ')}`);
  record('none of the refused writes (garbled/reset-invalidated/header-shape x POST/PATCH/DELETE/GET) landed on the account',
    !acctNames.some((n) => n.includes('garbled') || n.includes('reset-invalidated') || n.includes('headershape')),
    `names: ${acctNames.join(', ')}`);

  const localGames = await call(port, 'GET', '/api/games');
  const localNames = Array.isArray(localGames.json) ? localGames.json.map((g) => g.name) : [];
  record('the local-owner bucket got ONLY its own no-token control row — no misfiled dead-token OR header-shape write landed there',
    localGames.status === 200 && localNames.includes('DeadToken-no-token')
      && !localNames.some((n) => n.includes('garbled') || n.includes('reset-invalidated') || n.includes('headershape')),
    `names: ${localNames.join(', ')}`);
} finally {
  await stop(srv);
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((f) => f.name).join(' | ')}`);
  process.exit(1);
}

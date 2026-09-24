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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
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

const b64 = (x) => Buffer.from(x).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const claimsOf = (t) => JSON.parse(Buffer.from(
  t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
// Rewrite a token's CLAIMS while keeping the signature the server itself
// produced — the attacker's actual position (they hold a token, not the key).
const rewritePayload = (t, patch) => `${b64(JSON.stringify({ ...claimsOf(t), ...patch }))}.${t.split('.')[1]}`;

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

  // ── An EXPIRED token is the third way a token dies, and the one nothing
  //    on this branch measured ────────────────────────────────────────────
  //
  // `readAuthToken` refuses on `parsed.exp < Date.now()`. Every other check
  // in this file kills a token by breaking its SIGNATURE (garbled) or its
  // VERSION (password reset); delete the `exp` clause entirely and all of
  // them stay green, while a stolen desktop token becomes immortal. A
  // desktop is where that matters most: the token sits in a machine the
  // user carries, and AUTH_TOKEN_TTL_MS is the only thing that ever retires
  // it — there is no server-side session list to sweep.
  //
  // Waiting out a 7-day TTL is not a test, and moving the clock measures the
  // harness as much as the product. Instead the token is MINTED HERE with
  // the app's own key: `auth-secret` is a file in the user-data directory
  // (that is the whole point of desktop-persistence's section 2), so the
  // test can sign the exact payload shape the server signs and choose `exp`
  // freely. The HMAC is therefore genuine — a 401 can only be the expiry
  // clause, never a signature mismatch, and the +1h CONTROL below proves
  // the minting itself is accepted.
  {
    const secret = readFileSync(path.join(userData, 'auth-secret'), 'utf-8').trim();
    record('CONTROL: the key this section signs with is the app\'s real 32-byte auth-secret',
      /^[0-9a-f]{64}$/.test(secret), `${secret.length} chars`);
    const mint = (claims) => {
      const pay = b64(JSON.stringify(claims));
      return `${pay}.${b64(createHmac('sha256', secret).update(pay).digest())}`;
    };
    const claims = claimsOf(token);

    // CONTROL FIRST: if hand-minting did not produce an acceptable token, every
    // 401 below would be free and this whole section would prove nothing.
    const fresh = await call(port, 'GET', '/api/auth/me', { token: mint({ ...claims, exp: Date.now() + 3_600_000 }) });
    record('CONTROL: a hand-minted token with exp one hour out is ACCEPTED (the mint is valid)',
      fresh.status === 200, `status ${fresh.status} body ${JSON.stringify(fresh.json)}`);
    // …and the same payload under the WRONG key must fail, or "accepted"
    // above would mean the signature is not being checked at all.
    const wrongKey = (() => {
      const pay = b64(JSON.stringify({ ...claims, exp: Date.now() + 3_600_000 }));
      return `${pay}.${b64(createHmac('sha256', 'f'.repeat(64)).update(pay).digest())}`;
    })();
    record('CONTROL: the same payload signed with the WRONG key is refused (the HMAC is load-bearing)',
      (await call(port, 'GET', '/api/auth/me', { token: wrongKey })).status === 401);

    // THE INVARIANT, over every shape of a stale or absent `exp`.
    for (const [label, exp] of [
      ['one second in the past', Date.now() - 1000],
      ['a year in the past', Date.now() - 31_536_000_000],
      ['the epoch (0)', 0],
      // JSON.stringify turns these into `null`, i.e. `typeof exp !== 'number'`
      // — the other half of the same clause, and the shape a corrupted or
      // hand-edited token most plausibly takes.
      ['Infinity (serialises to null)', Infinity],
      ['NaN (serialises to null)', NaN],
      // A numeric string passes `>` comparisons in a language that coerces —
      // `"9999999999999" < Date.now()` is false — so only the typeof check
      // refuses it. That is precisely the clause a "simplification" drops.
      ['a far-future NUMERIC STRING', '9999999999999'],
    ]) {
      const r = await call(port, 'GET', '/api/auth/me', { token: mint({ ...claims, exp }) });
      record(`a correctly-signed token whose exp is ${label} is refused (401)`,
        r.status === 401, `status ${r.status} body ${JSON.stringify(r.json)}`);
    }
    const noExp = await call(port, 'GET', '/api/auth/me',
      { token: mint({ sub: claims.sub, ver: claims.ver, nonce: claims.nonce }) });
    record('a correctly-signed token with NO exp claim at all is refused (401)',
      noExp.status === 401, `status ${noExp.status} body ${JSON.stringify(noExp.json)}`);

    // ── The other half: the signature must cover the WHOLE payload ───────
    //
    // Minting with the real key above is legitimate by design — whoever can
    // read `auth-secret` is the server. The attacker's actual position is the
    // opposite one: they hold a token and NOT the key. So keep the server's
    // own signature byte-for-byte and rewrite the claims underneath it.
    //
    // api.test.mjs flips the last two characters of the SIGNATURE and gets a
    // 401; an implementation that signed only `sub`, or a constant, would
    // pass that check unchanged. These rewrite the PAYLOAD instead, one
    // victim claim each — the sub (takeover) and the exp (immortality) here,
    // and the `ver` one after the password reset below, where the account's
    // tokenVersion is genuinely non-zero and forcing it to 0 is therefore a
    // real downgrade rather than a re-encoding of the same number.
    const reclaim = (patch) => rewritePayload(token, patch);
    const other = await call(port, 'POST', '/api/auth/register',
      { body: { username: 'expvictim', email: 'expvictim@example.test', password: 'Sup3rSecret!23' } });
    record('CONTROL: a second account exists to be impersonated', other.status === 200,
      `status ${other.status}`);
    const victimLogin = await call(port, 'POST', '/api/auth/login',
      { body: { email: 'expvictim@example.test', password: 'Sup3rSecret!23' } });
    const victimId = (await call(port, 'GET', '/api/auth/me', { token: victimLogin.json?.token })).json?.id;
    record('CONTROL: the victim id was resolved and differs from ours (an equal sub would make the swap a no-op)',
      typeof victimId === 'string' && victimId.length > 0 && victimId !== claims.sub, String(victimId));

    for (const [label, patch] of [
      ['another user\'s sub (account takeover)', { sub: victimId }],
      ['exp pushed ten years out (an immortal session)', { exp: Date.now() + 315_360_000_000 }],
    ]) {
      const r = await call(port, 'GET', '/api/auth/me', { token: reclaim(patch) });
      record(`the server's OWN signature over a payload rewritten to ${label} is refused (401)`,
        r.status === 401, `status ${r.status} body ${JSON.stringify(r.json)}`);
    }
    // CONTROL: `reclaim` with NO patch must still be the original token and
    // still work — otherwise every 401 above is just "re-encoding broke it",
    // which would pass for a server that ignored the payload entirely.
    const rebuilt = await call(port, 'GET', '/api/auth/me', { token: reclaim({}) });
    record('CONTROL: re-encoding the payload UNCHANGED under the same signature still authenticates',
      rebuilt.status === 200 && rebuilt.json?.id === claims.sub,
      `status ${rebuilt.status} body ${JSON.stringify(rebuilt.json)}`);
  }

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

  // ── The revocation, attacked from the token side ─────────────────────────
  //
  // `getAuthUser` refuses when `user.tokenVersion !== claims.ver`. NOW that
  // the reset has bumped the account's version, the stale token carries the
  // old number — so rewriting its `ver` forward under the server's own
  // signature is the whole password reset undone. This is the first moment
  // in this file where that rewrite is not a no-op: before the reset both
  // numbers are 0, and a check placed there would pass by re-encoding the
  // same value (measured — it did, until it was moved here).
  if (typeof newToken === 'string' && newToken.length > 0) {
    const stale = claimsOf(token);
    const fresh = claimsOf(newToken);
    record('CONTROL: the reset really moved the token version (an unchanged ver makes the rewrite a no-op)',
      typeof stale.ver === 'number' && typeof fresh.ver === 'number' && fresh.ver !== stale.ver,
      `before ${stale.ver} after ${fresh.ver}`);
    const upgraded = await call(port, 'GET', '/api/auth/me',
      { token: rewritePayload(token, { ver: fresh.ver }) });
    record('the revoked token\'s ver rewritten FORWARD to the live version is still refused (401)',
      upgraded.status === 401, `status ${upgraded.status} body ${JSON.stringify(upgraded.json)}`);
    // A LIVE token whose ver is edited backwards is caught by the HMAC alone
    // — no mutation isolates it that the FORWARD row above does not already
    // catch — so it is deliberately not asserted here. What IS worth its own
    // row is the same downgrade done HONESTLY: a token minted (with the real
    // key) carrying the pre-reset version, which is exactly the token an
    // attacker who had stolen the key before the reset would replay.
    const oldVerMint = (() => {
      const secret = readFileSync(path.join(userData, 'auth-secret'), 'utf-8').trim();
      const pay = b64(JSON.stringify({ ...fresh, ver: stale.ver }));
      return `${pay}.${b64(createHmac('sha256', secret).update(pay).digest())}`;
    })();
    const downgraded = await call(port, 'GET', '/api/auth/me', { token: oldVerMint });
    record('a VALIDLY SIGNED token carrying the pre-reset version is refused (401) — revocation is not a signature check',
      downgraded.status === 401, `status ${downgraded.status} body ${JSON.stringify(downgraded.json)}`);
    // CONTROL: the live token itself still works, so the two 401s above are
    // the rewrite being caught and not the session having died meanwhile.
    const live = await call(port, 'GET', '/api/auth/me', { token: newToken });
    record('CONTROL: the untouched post-reset token still authenticates',
      live.status === 200, `status ${live.status}`);
  }

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

// SR-47: a suite that SILENTLY SKIPS a block still prints "N/N checks passed"
// and exits 0, because N is counted, not expected. Measured on this file's own
// ancestor: filtering one data array to empty removed six checks and the run
// said "37/37 checks passed". The red probe that had aborted for three sweeps
// was the same shape. So the count is DECLARED: fewer means a block did not
// run, which is a failure even when every check that did run passed.
const EXPECTED_CHECKS = 43;
if (results.length < EXPECTED_CHECKS) {
  console.error(`FAILED: only ${results.length} checks ran, expected at least ${EXPECTED_CHECKS} — `
    + 'a block was skipped. Raise EXPECTED_CHECKS deliberately when adding checks.');
  process.exit(1);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((f) => f.name).join(' | ')}`);
  process.exit(1);
}

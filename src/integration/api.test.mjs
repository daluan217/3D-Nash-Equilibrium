/* INTEGRATION layer of the testing pyramid — the real server, real routes,
 * real persistence, exercised over HTTP exactly as the deployed API is.
 *
 * Runs against the ACTUAL production artifact (dist/server.cjs) on an
 * ephemeral port with no LLM keys and no SMTP: registration takes the
 * documented ELECTRON auto-verify path, and the report route takes its
 * deterministic no-key path. `db.json` lives in a temp directory and dies
 * with the suite. Run by CI (.github/workflows/test.yml, job `integration`)
 * and locally:
 *
 *   node src/integration/api.test.mjs
 *
 * Each check names the contract it guards; several guard defects that
 * actually shipped (CORS preflight missing PATCH broke the desktop app's
 * save; clamping and text limits are the injection/overflow surface).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = process.env.INTEGRATION_PORT || '3098';
const BASE = process.env.INTEGRATION_BASE || `http://localhost:${PORT}`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
async function call(method, url, { body, token, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (method === 'OPTIONS' && origin) headers['access-control-request-method'] = 'PATCH';
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON body */ }
  return { status: r.status, json, headers: r.headers };
}

// ── boot the production server (unless one is already listening) ────────────
let server = null;
const userData = mkdtempSync(path.join(tmpdir(), 'nash-int-'));
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
if (!(await waitReady())) {
  // cwd = temp dir, deliberately: dotenv reads .env from the server's cwd, and
  // this suite must run the documented key-less paths even on a dev machine
  // whose repo root has real credentials in .env.
  const serverDir = path.resolve(import.meta.dirname, '../..');
  server = spawn('node', [path.join(serverDir, 'dist/server.cjs')], {
    cwd: userData,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT,
      ELECTRON_USER_DATA_PATH: userData, // auto-verify signups; db.json stays in temp
      // a KNOWN secret so the admin route's positive path is testable; unset
      // ADMIN_SECRET must itself fail closed (checked below)
      ADMIN_SECRET: 'ci-admin-secret-for-tests',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  if (!(await waitReady())) {
    console.error('FAIL server never became ready');
    server?.kill('SIGKILL');
    process.exit(2);
  }
}

const MP = { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 };

try {
  // ══ 1. liveness + build metadata
  {
    const r = await call('GET', '/api/health');
    record('GET /api/health is 200', r.status === 200, `status=${r.status}`);
    const v = await call('GET', '/api/version');
    // without GCS configured (local + CI) the route answers {version: null} —
    // the contract is a 200 JSON answer, not a non-null version
    record('GET /api/version answers 200 JSON', v.status === 200 && typeof v.json === 'object',
      `status=${v.status} version=${v.json?.version}`);
  }

  // ══ 2. hardening headers on every API response (the injection/clickjacking
  //      surface; the site is embedded nowhere and sniffed nowhere)
  {
    const r = await call('GET', '/api/health');
    const h = r.headers;
    const ok = h.get('x-content-type-options') === 'nosniff'
      && h.get('x-frame-options') === 'DENY'
      && (h.get('content-security-policy') || '').includes("frame-ancestors 'none'");
    record('security headers (nosniff / DENY / CSP frame-ancestors)', ok,
      `nosniff=${h.get('x-content-type-options')} xfo=${h.get('x-frame-options')}`);
  }

  // ══ 3. report route, no key: the deterministic path CI and the desktop
  //      no-key build both rely on
  {
    const r = await call('POST', '/api/report', { body: { payoffs: MP } });
    const ok = r.status === 200 && r.json?.source === 'deterministic'
      && Array.isArray(r.json?.groundTruth) && r.json.groundTruth.length > 0;
    record('POST /api/report (no key) → deterministic ground truth', ok,
      `status=${r.status} source=${r.json?.source} NEs=${r.json?.groundTruth?.length}`);
    // the mixed NE of matching pennies must be (0.5, 0.5)
    const mixed = (r.json?.groundTruth || []).find((n) => n.type === 'mixed');
    record('ground truth solves matching pennies at (0.5, 0.5)',
      !!mixed && Math.abs(mixed.x - 0.5) < 1e-9 && Math.abs(mixed.y - 0.5) < 1e-9,
      mixed ? `(${mixed.x}, ${mixed.y})` : 'no mixed NE returned');
  }

  // ══ 4. report route rejects a malformed matrix
  {
    const r = await call('POST', '/api/report', { body: { payoffs: { a11: 'x' } } });
    record('POST /api/report with junk matrix → 400', r.status === 400, `status=${r.status}`);
  }

  // ══ 5. CORS preflight must answer PATCH (PR #30: its absence broke every
  //      save from the cross-origin desktop client while the website worked)
  {
    const r = await call('OPTIONS', '/api/games', { origin: 'http://127.0.0.1:5173' });
    const methods = r.headers.get('access-control-allow-methods') || '';
    record('CORS preflight allows PATCH (desktop save path)',
      r.status === 200 && methods.includes('PATCH'), `status=${r.status} methods=${methods}`);
    const aco = r.headers.get('access-control-allow-origin');
    record('CORS preflight answers the requesting origin', aco === '*' || aco === 'http://127.0.0.1:5173',
      `allow-origin=${aco}`);
  }

  // ══ 6. registration validation + the Electron auto-verify path
  const email = `int-${Date.now()}@example.test`;
  const password = 'Sup3rSecret';
  {
    const weak = await call('POST', '/api/auth/register',
      { body: { username: 'weak', email, password: 'alllowercase1' } });
    record('register rejects a password without uppercase', weak.status === 400, `status=${weak.status}`);
    const missing = await call('POST', '/api/auth/register', { body: { username: 'x' } });
    record('register rejects a missing email/password', missing.status === 400, `status=${missing.status}`);

    const ok = await call('POST', '/api/auth/register',
      { body: { username: 'integration', email, password } });
    record('register succeeds and auto-verifies under ELECTRON_USER_DATA_PATH',
      ok.status === 200 && ok.json?.success === true && ok.json?.autoVerified === true,
      `status=${ok.status} autoVerified=${ok.json?.autoVerified}`);

    const dup = await call('POST', '/api/auth/register',
      { body: { username: 'integration', email: `other-${Date.now()}@example.test`, password } });
    record('register rejects a taken username (case-insensitive)', dup.status === 400, `status=${dup.status}`);
  }

  // ══ 7. login: wrong password 401, right password mints a bearer token
  let token = '';
  {
    const bad = await call('POST', '/api/auth/login', { body: { email, password: 'WrongPass1' } });
    record('login with wrong password → 401', bad.status === 401, `status=${bad.status}`);
    const good = await call('POST', '/api/auth/login', { body: { email, password } });
    token = good.json?.token || '';
    record('login mints a bearer token',
      good.status === 200 && !!token && good.json?.user?.email === email,
      `status=${good.status} user=${good.json?.user?.email}`);
  }

  // ══ 8. session contract: token works, garbage and absence do not
  {
    const me = await call('GET', '/api/auth/me', { token });
    record('GET /api/auth/me with the token → 200 + identity',
      me.status === 200 && me.json?.email === email, `status=${me.status}`);
    const no = await call('GET', '/api/auth/me');
    record('GET /api/auth/me without a token → 401', no.status === 401, `status=${no.status}`);
    const junk = await call('GET', '/api/auth/me', { token: 'garbage.token.here' });
    record('GET /api/auth/me with a junk token → 401', junk.status === 401, `status=${junk.status}`);
  }

  // ══ 9. the saved-game CRUD lifecycle — the desktop save path end to end
  let gameId = '';
  {
    const anon = await call('GET', '/api/games');
    record('GET /api/games without a token → 401', anon.status === 401, `status=${anon.status}`);

    const invalid = await call('POST', '/api/games', { token, body: { name: '', payoffs: MP } });
    record('POST /api/games without a name → 400', invalid.status === 400, `status=${invalid.status}`);

    // clamping + text limits are the overflow/rowdy-input surface: 150 must
    // land as 100, a 900-char description must be trimmed to 800.
    const longDesc = 'x'.repeat(900);
    const created = await call('POST', '/api/games', {
      token,
      body: {
        name: 'Integration fixture',
        description: longDesc,
        payoffs: { ...MP, a11: 150, b12: 0.12345 },
      },
    });
    const g = created.json?.game;
    gameId = g?.id || '';
    record('POST /api/games saves the game', created.status === 200 && !!gameId,
      `status=${created.status} id=${gameId}`);
    record('saved payoffs are clamped to ±100 and rounded to 3dp',
      g?.payoffs?.a11 === 100 && g?.payoffs?.b12 === 0.123,
      `a11=${g?.payoffs?.a11} b12=${g?.payoffs?.b12}`);
    record('saved description is clamped to 800 chars',
      typeof g?.description === 'string' && g.description.length === 800,
      `len=${g?.description?.length}`);

    const listed = await call('GET', '/api/games', { token });
    record('GET /api/games lists the saved game for its owner',
      listed.status === 200 && Array.isArray(listed.json) && listed.json.some((x) => x.id === gameId),
      `count=${listed.json?.length}`);

    // ── SECURITY — server-side bidi/control-character stripping ────────────
    // The "Game Name"/"Game Description"/label FORM strips these before the
    // browser ever sends a request (src/utils/textSafety.ts), but a direct
    // POST/PATCH — curl, a script, a modified client — bypasses the form
    // entirely. server.ts's own `cleanText` used to only `.trim().slice()`,
    // so a name carrying a RIGHT-TO-LEFT OVERRIDE (U+202E) plus a fake
    // extension landed and came back byte-for-byte, rendering
    // bidi-reordered everywhere this app shows a saved name back. Numeric
    // code points only, never a literal control character pasted into this
    // source file (same Trojan-Source reasoning as textSafety.ts itself).
    {
      const RLO = String.fromCodePoint(0x202e);
      const SOH = String.fromCodePoint(0x0001); // raw control character
      const dirty = await call('POST', '/api/games', {
        token,
        body: {
          name: `evidence${RLO}txt.exe`,
          description: `line one${SOH}line two`,
          payoffs: MP,
          row1Label: `Heads${RLO}`,
        },
      });
      const dg = dirty.json?.game;
      const dirtyId = dg?.id || '';
      record('POST /api/games strips a bidi override from the name',
        dirty.status === 200 && dg?.name === 'evidencetxt.exe',
        `status=${dirty.status} name=${JSON.stringify(dg?.name)}`);
      record('POST /api/games strips a raw control character from the description',
        dg?.description === 'line oneline two', `desc=${JSON.stringify(dg?.description)}`);
      record('POST /api/games strips a bidi override from an option label',
        dg?.row1Label === 'Heads', `row1Label=${JSON.stringify(dg?.row1Label)}`);

      const dirtyPatch = await call('PATCH', `/api/games/${dirtyId}`, {
        token,
        body: { name: `Patched${RLO}Name`, col1Label: `Tails${SOH}` },
      });
      const pdg = dirtyPatch.json?.game;
      record('PATCH /api/games/:id strips a bidi override from the name',
        pdg?.name === 'PatchedName', `name=${JSON.stringify(pdg?.name)}`);
      record('PATCH /api/games/:id strips a raw control character from a label',
        pdg?.col1Label === 'Tails', `col1Label=${JSON.stringify(pdg?.col1Label)}`);

      if (dirtyId) await call('DELETE', `/api/games/${dirtyId}`, { token });
    }

    // ── SECURITY/QUALITY — cleanLabels cuts long option labels at a WORD
    // BOUNDARY, not mid-word. RED-APP-4/CROSS.md: cleanScenario's own
    // label() was fixed to avoid a bare 40-char slice (which cuts mid-word
    // and the stub then repeats through a rendered paragraph), but the
    // SIBLING path — cleanLabels, used by POST/PATCH /api/games' own
    // row/col labels — still called the old blunt cleanText(v, 40). Only
    // reachable via a direct API call (the Save/Edit modal's own
    // maxlength=40 blocks this in ordinary UI use), which is exactly what
    // this integration suite exercises.
    {
      const longLabel = await call('POST', '/api/games', {
        token,
        body: {
          name: 'Long label truncation test',
          payoffs: MP,
          row1Label: 'Escalate the dispute to the regional arbitration board immediately',
        },
      });
      const llg = longLabel.json?.game;
      const llId = llg?.id || '';
      record('POST /api/games cuts a long row1Label at a word boundary, not mid-word',
        llg?.row1Label === 'Escalate the dispute to the regional', // <=40 chars, no partial word
        `row1Label=${JSON.stringify(llg?.row1Label)} (len ${llg?.row1Label?.length})`);
      record('the truncated label is at most 40 characters',
        typeof llg?.row1Label === 'string' && llg.row1Label.length <= 40,
        `len=${llg?.row1Label?.length}`);
      if (llId) await call('DELETE', `/api/games/${llId}`, { token });
    }

    // PATCH is the scenario-keep path: story edits only, never payoffs
    const patched = await call('PATCH', `/api/games/${gameId}`, {
      token,
      body: { description: 'A kept scenario', row1Label: 'Heads', col1Label: 'Heads' },
    });
    const pg = patched.json?.game;
    record('PATCH /api/games/:id updates the story and labels',
      patched.status === 200 && pg?.description === 'A kept scenario' && pg?.row1Label === 'Heads',
      `status=${patched.status} desc=${pg?.description} row1=${pg?.row1Label}`);
    record('PATCH never touches payoffs',
      pg?.payoffs?.a11 === 100 && pg?.payoffs?.a11 !== MP.a11,
      `a11=${pg?.payoffs?.a11}`);
    const nothing = await call('PATCH', `/api/games/${gameId}`, { token, body: {} });
    record('PATCH with nothing to update → 400', nothing.status === 400, `status=${nothing.status}`);
    const missing404 = await call('PATCH', '/api/games/g-does-not-exist', { token, body: { name: 'x' } });
    record('PATCH on a missing game → 404', missing404.status === 404, `status=${missing404.status}`);

    // a second user must not touch the first user's game
    const email2 = `int2-${Date.now()}@example.test`;
    await call('POST', '/api/auth/register', { body: { username: 'integration2', email: email2, password } });
    const login2 = await call('POST', '/api/auth/login', { body: { email: email2, password } });
    const foreign = await call('PATCH', `/api/games/${gameId}`,
      { token: login2.json?.token, body: { name: 'hijack' } });
    record('PATCH on another user\'s game → 403', foreign.status === 403, `status=${foreign.status}`);
    const foreignList = await call('GET', '/api/games', { token: login2.json?.token });
    record('GET /api/games only lists the caller\'s own games',
      foreignList.status === 200 && !foreignList.json.some((x) => x.id === gameId),
      `count=${foreignList.json?.length}`);

    const deleted = await call('DELETE', `/api/games/${gameId}`, { token });
    record('DELETE /api/games/:id removes the game', deleted.status === 200 && deleted.json?.success === true,
      `status=${deleted.status}`);
    const after = await call('GET', '/api/games', { token });
    record('the deleted game is gone from the list',
      !after.json.some((x) => x.id === gameId), `count=${after.json?.length}`);
    const again = await call('DELETE', `/api/games/${gameId}`, { token });
    record('DELETE on an already-deleted game → 404', again.status === 404, `status=${again.status}`);
  }

  // ══ 10. SECURITY — the admin route fails closed (it returns all-user PII;
  //      an unset ADMIN_SECRET used to make `undefined !== undefined` pass)
  {
    const noSecret = await call('GET', '/api/admin/stats');
    record('admin stats without a secret → 401', noSecret.status === 401, `status=${noSecret.status}`);
    const wrongSecret = await call('GET', '/api/admin/stats');
    record('admin stats with a wrong secret → 401', wrongSecret.status === 401, `status=${wrongSecret.status}`);
    if (server) { // positive path needs the ADMIN_SECRET we spawned with
      const r = await fetch(`${BASE}/api/admin/stats`, { headers: { 'x-admin-secret': 'ci-admin-secret-for-tests' } });
      const j = await r.json().catch(() => null);
      record('admin stats with the right secret → 200 + aggregate stats',
        r.status === 200 && typeof j?.totalUsers === 'number' && Array.isArray(j?.users),
        `status=${r.status} totalUsers=${j?.totalUsers}`);
    }
  }

  // ══ 11. SECURITY — bearer-token integrity (a token is an identity; a
  //      tampered or malformed one must never authenticate)
  {
    const tampered = token.slice(0, -2) + (token.endsWith('zz') ? 'yy' : 'zz');
    const t = await call('GET', '/api/auth/me', { token: tampered });
    record('a tampered token (signature flipped) → 401', t.status === 401, `status=${t.status}`);
    const bare = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: 'Bearer' } });
    record('"Bearer" with no token → 401', bare.status === 401, `status=${bare.status}`);
    const basic = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    record('a Basic auth header → 401 (only Bearer is valid)', basic.status === 401, `status=${basic.status}`);
    // login must not enumerate accounts: unknown user gets the same 401 shape
    const ghost = await call('POST', '/api/auth/login',
      { body: { email: `ghost-${Date.now()}@example.test`, password: 'WrongPass1' } });
    record('login with an unknown account → 401 (no enumeration)', ghost.status === 401
      && ghost.json?.error === 'Invalid email/username or password.',
      `status=${ghost.status}`);
  }

  // ══ 12. SECURITY — request-body ceiling (express.json's 100kb default is
  //      the whole defense against unbounded payloads; a 200kb body must be
  //      rejected before any route logic sees it)
  {
    const big = 'x'.repeat(200 * 1024);
    const r = await fetch(`${BASE}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'big', description: big, payoffs: MP }),
    });
    record('a 200kb request body → 413 (payload ceiling enforced)', r.status === 413, `status=${r.status}`);
  }

  // ══ 13. SECURITY — rate limiting (the brute-force surface of login and
  //      registration; run LAST because it burns the register bucket)
  {
    let saw429 = false;
    let lastStatus = 0;
    for (let i = 0; i < 12 && !saw429; i++) {
      const r = await call('POST', '/api/auth/register',
        { body: { username: `flood${i}`, email: `flood-${Date.now()}-${i}@example.test`, password } });
      lastStatus = r.status;
      if (r.status === 429) saw429 = true;
    }
    record('register rate-limits after the burst budget (429)', saw429,
      `last status=${lastStatus}`);
  }
} catch (e) {
  record('suite completed without a script error', false, e.message.slice(0, 200));
}

if (server) server.kill('SIGKILL');
try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ INTEGRATION: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length) fails.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
process.exit(fails.length ? 1 : 0);

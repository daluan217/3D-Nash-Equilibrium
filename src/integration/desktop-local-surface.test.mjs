/* INTEGRATION — what a TOKENLESS LOCAL CALLER can do to the desktop app.
 *
 * The desktop authenticates NOTHING by design: resolveGameOwner hands any
 * caller the shared local owner when no Authorization header is present, which
 * is the whole point of "no account needed to save a file to your own disk".
 * SR-57/SR-59 closed the BROWSER door (only the app's own origin is echoed),
 * but any local process can still talk to the port — so the properties below
 * are the ones holding the surface together, and none of them had a guard.
 *
 * This file checks in the probes that came back empty during BLUE-LOOP-DESKTOP-22's
 * sweeps 19 and 20. Per Daniel (2026-09-15) a sweep is only EMPTY once every
 * empty probe is a green, mutation-proven CI guard — a probe left under _gen/
 * protects nothing.
 *
 * SECTION 1 — the route census, DERIVED from the shipped bundle rather than
 * hand-written, so a route added later is automatically covered instead of
 * being missed by a stale literal. The five routes that must stay
 * credential-gated are asserted by name.
 *
 * SECTION 2 — no cross-owner read or write. A seeded victim account and its
 * game must survive every auth-mutation route a local caller can reach, with
 * REAL well-formed bodies (an empty-body 400 proves only that a handler ran).
 *
 * SECTION 3 — RED-DESKTOP-11/001 stays fixed under a live attack: logging in
 * must NOT re-parent the no-account library; only the user's own explicit
 * adopt-local call may. The original defect handed one person's games to
 * whoever signed in next, brand-new accounts included.
 *
 * SECTION 4 — the rate-limit split. Limits that protect the USER (login,
 * recovery) are unmarked and stay in force on desktop; the convenience limits
 * marked 'hosted-only' are lifted. This is what keeps the desktop's
 * locally-returned recovery code (no SMTP in a packaged app, so it has to be
 * shown) from being brute-forceable. Both halves are asserted, because
 * asserting only the throttle would pass if EVERY limit were on, and asserting
 * only the lift would pass if every limit were off.
 *
 * SECTION 5 — the startup scratch-file sweep is the ONE code path that DELETES
 * files from the user's data directory. It matches on a name prefix and ages
 * entries with fs.statSync, which FOLLOWS symlinks (SR-54's lesson: link
 * classes are what a naive stat misses).
 *
 *   node src/integration/desktop-local-surface.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync,
         existsSync, symlinkSync, mkdirSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(repo, 'dist/server.cjs');
let port = Number(process.env.LOCAL_SURFACE_PORT || 3212);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

if (!existsSync(BUNDLE)) {
  console.error(`missing ${BUNDLE} — run \`npm run build\` first.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAYOFFS = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };

/**
 * Boot the production bundle in the PACKAGED condition: cwd is a temp dir, never
 * the repo, because dotenv would otherwise load this checkout's .env and hand
 * the app credentials a packaged build never has. The three rung-3 flags are the
 * ones electron-main.cjs sets before requiring the server.
 */
async function boot(userData, extraEnv = {}) {
  const thePort = port++;
  const child = spawn(process.execPath, [BUNDLE], {
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH, HOME: userData,
      NODE_ENV: 'production', IS_ELECTRON: 'true',
      PORT: String(thePort), ELECTRON_USER_DATA_PATH: userData,
      NASH_PAYOFF_TEMPLATE: '1', NASH_LLM_TIES: 'template', NASH_DIRECTION_CHECKS: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  // Read the port the server actually BOUND: the EADDRINUSE walk moves it, so a
  // hardcoded expectation would talk to whatever else holds the port.
  let bound = null;
  for (let i = 0; i < 80; i++) {
    const m = /Express server running on http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
    if (m) { bound = Number(m[1]); break; }
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  return { child, bound, base: bound ? `http://127.0.0.1:${bound}` : null, log: () => log, userData };
}

async function stop(srv) {
  if (!srv?.child || srv.child.exitCode !== null) return;
  const ended = new Promise((res) => srv.child.once('exit', res));
  srv.child.kill('SIGTERM');
  const timer = setTimeout(() => srv.child.kill('SIGKILL'), 4000);
  await ended;
  clearTimeout(timer);
}

async function req(base, verb, p, body, token) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const r = await fetch(base + p, {
      method: verb, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, text, json };
  } catch (e) { return { status: 'threw', text: e.message, json: null }; }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE ROUTE CENSUS, derived from the shipped bundle.
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = readFileSync(BUNDLE, 'utf8');
  // Every quote style, plus `all`. The original spelling accepted only
  // double-quoted paths, so a route added as app.post('/api/…') or with a
  // template literal would silently not be probed while `routes.length >= 20`
  // stayed true (reviewer finding, 2026-09-20). esbuild normalises quotes
  // today, which is exactly why the narrow regex looked fine — it was correct
  // by coincidence of the bundler's output, not by construction.
  const routes = [...new Set(
    [...src.matchAll(/app\.(get|post|put|patch|delete|all)\(\s*['"`](\/api\/[^'"`]*)['"`]/g)]
      .map((m) => `${m[1].toUpperCase()} ${m[2]}`),
  )].sort();
  record('CONTROL: the route table was extracted from the bundle at all',
    routes.length >= 20,
    `${routes.length} routes. A broken extraction would make every census check below `
    + 'assert against an empty list and pass for free.');

  // A census that silently under-reports is worse than no census: it reads as
  // "everything is gated". These two alarms fire when a registration form
  // appears that this extraction cannot see, instead of quietly skipping it.
  record('no route is registered through app.route() (this census cannot see those)',
    !/app\.route\s*\(/.test(src),
    'app.route(...) chains register verbs the matchAll above never matches');
  record('no sub-router is mounted (this census only sees app.<verb> registrations)',
    !/express\.Router\s*\(/.test(src),
    'a mounted Router registers its paths relative to the mount point, invisible to this regex');

  const userData = mkdtempSync(path.join(tmpdir(), 'nash-census-'));
  const srv = await boot(userData);
  record('the desktop server starts in the packaged condition', !!srv.bound,
    srv.bound ? `port ${srv.bound}` : srv.log().slice(-300));

  if (srv.bound) {
    // An empty body is not good enough for routes that validate INPUT before
    // they check the SESSION: delete-confirm answers 400 "code is required"
    // to `{}` and never reaches its auth check, so the census scored it
    // "reached" for a reason that has nothing to do with credentials
    // (reviewer finding, 2026-09-20). These bodies are well-formed enough to
    // get past input validation and land on the gate itself.
    const CENSUS_BODY = {
      'POST /api/auth/delete-confirm': { code: '123456' },
      'POST /api/auth/delete-request': { password: 'CorrectHorse9!' },
      'POST /api/auth/reset-password': { email: 'nobody@example.com', code: '123456', newPassword: 'Attacker1!' },
    };
    const reached = new Set();
    for (const route of routes) {
      const [verb, p] = route.split(' ');
      const url = p.replace(/:[A-Za-z]+/g, 'probe-id');
      const body = verb === 'GET' ? undefined : (CENSUS_BODY[route] ?? {});
      const r = await req(srv.base, verb, url, body);
      // 401/403 ONLY. 404 used to count as gated, but every 404 on this surface
      // comes from a handler that already RAN: reset-password 404s after its
      // db.users lookup (the same call with an email that EXISTS answers 400),
      // DELETE /api/games/:id after its game lookup, regenerate after its flag
      // check. A missing data row is not a credential check (measured 2026-09-20).
      if (typeof r.status === 'number' && ![401, 403].includes(r.status)) reached.add(route);
    }

    // These must stay credential-gated for a tokenless caller. Named
    // individually so a failure says WHICH one opened up.
    for (const route of ['GET /api/auth/me', 'POST /api/auth/delete-request',
      'POST /api/auth/delete-confirm',
      'POST /api/games/adopt-local', 'GET /api/admin/stats']) {
      record(`${route} stays credential-gated for a tokenless local caller`,
        !reached.has(route), `reached=${reached.has(route)}`);
    }
    // …and the no-login design must still WORK, or the four checks above would
    // also pass on a server that refused everything.
    for (const route of ['GET /api/games', 'POST /api/games', 'POST /api/report']) {
      record(`CONTROL: ${route} IS reachable (the desktop no-login design)`,
        reached.has(route), `reached=${reached.has(route)}`);
    }
  }
  await stop(srv);
  rmSync(userData, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. NO CROSS-OWNER READ OR WRITE, with real bodies against a seeded victim.
// ═══════════════════════════════════════════════════════════════════════════
{
  const victim = {
    id: 'victim-1', username: 'victim', email: 'victim@example.com',
    passwordHash: 'scrypt$notarealhash', isVerified: true,
    verificationCode: '', verificationCodeExpires: 0, tokenVersion: 3,
  };
  const victimGame = {
    id: 'victim-game', userId: 'victim-1', name: 'VICTIM DATA',
    payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 },
  };
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-victim-'));
  writeFileSync(path.join(userData, 'db.json'),
    JSON.stringify({ users: [victim], games: [victimGame] }));
  const srv = await boot(userData);
  record('the victim fixture boots', !!srv.bound, srv.bound ? '' : srv.log().slice(-300));

  if (srv.bound) {
    const r1 = await req(srv.base, 'POST', '/api/auth/register',
      { username: 'victim2', email: 'victim@example.com', password: 'CorrectHorse9!' });
    record("registering the VICTIM's email is refused (no account takeover by re-registration)",
      r1.status === 400, `status ${r1.status} ${r1.text.slice(0, 80)}`);

    const r2 = await req(srv.base, 'POST', '/api/auth/login',
      { email: 'victim@example.com', password: 'CorrectHorse9!' });
    record('a guessed password does not log in as the victim', r2.status === 401, `status ${r2.status}`);

    const r3 = await req(srv.base, 'POST', '/api/auth/reset-password',
      { email: 'victim@example.com', code: '123456', newPassword: 'Attacker1!' });
    record('a made-up recovery code cannot reset the victim password',
      r3.status === 400, `status ${r3.status} ${r3.text.slice(0, 80)}`);

    // 401 EXACTLY, not "401 or 400". delete-confirm rejects a MISSING code
    // with 400 before it ever looks at the session, so accepting 400 here let
    // an implementation that skips authentication entirely still pass
    // (reviewer finding, 2026-09-20). A well-formed code reaches the auth
    // check, and the only correct answer for a tokenless caller is 401.
    const r4 = await req(srv.base, 'POST', '/api/auth/delete-confirm',
      { email: 'victim@example.com', code: '123456' });
    record('a made-up code cannot confirm deletion of the victim account',
      r4.status === 401, `status ${r4.status} ${r4.text.slice(0, 80)}`);
    // CONTROL: the 400 branch really does exist and really is reached by a
    // missing code — otherwise the check above could be demanding 401 for a
    // route that answers 401 to everything, including malformed input.
    const r4b = await req(srv.base, 'POST', '/api/auth/delete-confirm', {});
    record('CONTROL: delete-confirm answers 400 to a MISSING code (so 401 above is the auth check)',
      r4b.status === 400, `status ${r4b.status} ${r4b.text.slice(0, 80)}`);

    // The cross-owner WRITE: a tokenless local caller editing a game that
    // belongs to a real account.
    const r5 = await req(srv.base, 'PATCH', '/api/games/victim-game',
      { name: 'PWNED', payoffs: { a11: 9, a12: 9, a21: 9, a22: 9, b11: 9, b12: 9, b21: 9, b22: 9 } });
    record("a tokenless caller cannot PATCH another owner's game",
      r5.status === 403, `status ${r5.status} ${r5.text.slice(0, 80)}`);

    // The cross-owner DELETE. Only PATCH was attacked here, so removing the
    // ownership check from the DELETE route broke nothing in this suite: the
    // victim's game survived simply because nobody ever tried to delete it
    // (reviewer finding, 2026-09-20). The census probe cannot cover this — it
    // uses a nonexistent 'probe-id', which 404s before any ownership check.
    const r5b = await req(srv.base, 'DELETE', '/api/games/victim-game');
    record("a tokenless caller cannot DELETE another owner's game",
      r5b.status === 403, `status ${r5b.status} ${r5b.text.slice(0, 80)}`);
    // The status is not the claim that matters — the bytes are.
    const diskAfter = JSON.parse(readFileSync(path.join(userData, 'db.json'), 'utf8'));
    record("the victim's game is still ON DISK after the refused DELETE",
      (diskAfter.games ?? []).some((g) => g.id === 'victim-game' && g.name === 'VICTIM DATA'),
      JSON.stringify((diskAfter.games ?? []).map((g) => `${g.id}:${g.name}`)));

    // The victim's games must never appear in a tokenless read.
    const r6 = await req(srv.base, 'GET', '/api/games');
    const names = Array.isArray(r6.json) ? r6.json.map((g) => g.name) : ['(not an array)'];
    record("a tokenless read never returns another owner's games",
      !names.includes('VICTIM DATA'), `saw ${JSON.stringify(names)}`);

    // THE CONTROL that makes all of the above meaningful: the bytes on disk.
    await sleep(500);
    const after = JSON.parse(readFileSync(path.join(userData, 'db.json'), 'utf8'));
    const v = after.users.find((u) => u.id === 'victim-1');
    const vg = after.games.find((g) => g.id === 'victim-game');
    record('the victim row survives every attack', !!v);
    record('the victim passwordHash is unchanged', !!v && v.passwordHash === victim.passwordHash,
      v ? v.passwordHash : '(gone)');
    record('the victim tokenVersion is unchanged (no session invalidation)',
      !!v && v.tokenVersion === 3, v ? String(v.tokenVersion) : '(gone)');
    record("the victim's game name is unchanged", !!vg && vg.name === 'VICTIM DATA',
      vg ? vg.name : '(GONE)');
    record("the victim's game payoffs are unchanged", !!vg && vg.payoffs.a11 === 1,
      vg ? `a11=${vg.payoffs.a11}` : '(gone)');
  }
  await stop(srv);
  rmSync(userData, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. RED-DESKTOP-11/001: login must not steal the no-account library.
// ═══════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-adopt-'));
  const srv = await boot(userData);
  record('the adopt fixture boots', !!srv.bound, srv.bound ? '' : srv.log().slice(-300));

  if (srv.bound) {
    await req(srv.base, 'POST', '/api/games',
      { name: 'OWNER PRIVATE', description: 'd', payoffs: PAYOFFS });
    const owned = await req(srv.base, 'GET', '/api/games');
    record('CONTROL: the local owner saved a game with no account',
      Array.isArray(owned.json) && owned.json.some((g) => g.name === 'OWNER PRIVATE'),
      JSON.stringify(Array.isArray(owned.json) ? owned.json.map((g) => g.name) : owned.text.slice(0, 80)));

    await req(srv.base, 'POST', '/api/auth/register',
      { username: 'attacker', email: 'a@b.com', password: 'CorrectHorse9!' });
    const login = await req(srv.base, 'POST', '/api/auth/login',
      { email: 'a@b.com', password: 'CorrectHorse9!' });
    const token = login.json?.token;
    record('CONTROL: a brand-new offline account can log in (else nothing below is exercised)',
      !!token, `status ${login.status}`);
    record("CONTROL: login reports the local owner's game count, so the client can OFFER adoption",
      login.json?.localGames === 1, `localGames=${JSON.stringify(login.json?.localGames)}`);

    if (token) {
      const theirs = await req(srv.base, 'GET', '/api/games', undefined, token);
      const stolen = Array.isArray(theirs.json) ? theirs.json.map((g) => g.name) : ['(not an array)'];
      record('LOGGING IN ALONE DOES NOT re-parent the no-account library (RED-DESKTOP-11/001)',
        !stolen.includes('OWNER PRIVATE'),
        `the new account sees ${JSON.stringify(stolen)} right after login. The original defect ran `
        + 'the move inside every successful login, which on a shared machine handed one person\'s '
        + 'no-account games to whoever signed in next.');
      const stillOwner = await req(srv.base, 'GET', '/api/games');
      record('…and the local owner still has it',
        Array.isArray(stillOwner.json) && stillOwner.json.some((g) => g.name === 'OWNER PRIVATE'));

      // Only the user's OWN explicit call may move them. This is also the
      // control proving the checks above are not passing because adoption is
      // broken outright — the feature has to still work.
      const adopt = await req(srv.base, 'POST', '/api/games/adopt-local', {}, token);
      record('CONTROL: an EXPLICIT adopt-local with a valid token does adopt them',
        adopt.status === 200 && adopt.json?.adopted === 1,
        `status ${adopt.status} ${adopt.text.slice(0, 80)}`);
      const afterAdopt = await req(srv.base, 'GET', '/api/games');
      record('after the explicit adoption the games are re-parented, not copied',
        Array.isArray(afterAdopt.json) && afterAdopt.json.length === 0,
        `local owner now sees ${JSON.stringify(Array.isArray(afterAdopt.json) ? afterAdopt.json.map((g) => g.name) : afterAdopt.text.slice(0, 60))}`);
    }
  }
  await stop(srv);
  rmSync(userData, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE RATE-LIMIT SPLIT: user-protecting limits ON, hosted-only ones LIFTED.
// ═══════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-rl-'));
  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({
    users: [{ id: 'v', username: 'victim', email: 'victim@example.com',
      passwordHash: 'scrypt$x', isVerified: true, verificationCode: '',
      verificationCodeExpires: 0, tokenVersion: 1 }],
    games: [],
  }));
  const srv = await boot(userData);
  record('the rate-limit fixture boots', !!srv.bound, srv.bound ? '' : srv.log().slice(-300));

  if (srv.bound) {
    // forgot-password: rateLimit("forgot", 6, 60_000), NOT marked hosted-only.
    // It is the limiter that keeps the desktop's locally-RETURNED recovery code
    // (a packaged app has no SMTP, so it must be shown) from being guessable.
    const forgot = [];
    for (let i = 0; i < 9; i++) {
      const r = await req(srv.base, 'POST', '/api/auth/forgot-password', { email: 'victim@example.com' });
      forgot.push(r.status);
    }
    record('the recovery limiter is IN FORCE on the desktop (429 after its budget)',
      forgot.includes(429),
      `statuses ${JSON.stringify(forgot)} — limit is 6/min and is deliberately NOT 'hosted-only'.`);
    record('CONTROL: …and the first requests SUCCEEDED, so the 429 is a limit and not a broken route',
      forgot[0] === 200, `first status ${forgot[0]}`);

    // login: also user-protecting, also unmarked.
    const logins = [];
    for (let i = 0; i < 12; i++) {
      const r = await req(srv.base, 'POST', '/api/auth/login', { email: 'victim@example.com', password: 'wrong' });
      logins.push(r.status);
    }
    record('the login limiter is IN FORCE on the desktop (429 after its budget)',
      logins.includes(429), `statuses ${JSON.stringify(logins)}`);
    record('CONTROL: …and the early attempts were ordinary 401s, not the limiter',
      logins[0] === 401, `first status ${logins[0]}`);

    // /api/report carries rateLimit(..., 'hosted-only') and must NOT throttle
    // here. Asserting only the throttles above would pass on a build where
    // EVERY limit was on, which would break the desktop's own design.
    const reports = [];
    for (let i = 0; i < 8; i++) {
      const r = await req(srv.base, 'POST', '/api/report', { payoffs: PAYOFFS });
      reports.push(r.status);
    }
    record("a 'hosted-only' limit is LIFTED on the desktop (no 429 on /api/report)",
      !reports.includes(429) && reports.every((s) => s === 200),
      `statuses ${JSON.stringify(reports)} — "no shared server, nobody else on the socket".`);
  }
  await stop(srv);
  rmSync(userData, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE STARTUP SCRATCH-FILE SWEEP vs. LINK CLASSES (SR-54's lesson).
// ═══════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-swp-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'nash-outside-'));
  const precious = path.join(outside, 'precious.txt');
  const PRECIOUS_BYTES = 'DO NOT DELETE ME';
  writeFileSync(precious, PRECIOUS_BYTES);
  // Old enough to pass the sweep's own age gate (maxAgeMs = 5000).
  const old = (Date.now() - 600_000) / 1000;
  utimesSync(precious, old, old);

  writeFileSync(path.join(userData, 'db.json'), JSON.stringify({
    users: [], games: [{ id: 'g1', userId: 'local-owner', name: 'KEEPME', payoffs: PAYOFFS }],
  }));
  // A scratch-named SYMLINK pointing OUTSIDE the data directory.
  symlinkSync(precious, path.join(userData, 'db.json.tmp-999-1'));
  // A scratch-named SYMLINK pointing at db.json ITSELF.
  symlinkSync(path.join(userData, 'db.json'), path.join(userData, 'db.json.tmp-999-2'));
  // A DIRECTORY with a scratch name (unlinkSync must fail, be logged, not crash).
  mkdirSync(path.join(userData, 'db.json.tmp-999-3'));
  utimesSync(path.join(userData, 'db.json.tmp-999-3'), old, old);
  // A GENUINE old orphan — THE CONTROL. If this survives, the sweep never ran
  // and every other reading in this section is a no-op that passes for free.
  const orphan = path.join(userData, 'db.json.tmp-999-4');
  writeFileSync(orphan, 'orphan scratch');
  utimesSync(orphan, old, old);

  const srv = await boot(userData);
  record('the sweep fixture boots with link-shaped scratch entries present', !!srv.bound,
    srv.bound ? '' : srv.log().slice(-300));
  record('CONTROL: the genuine stale orphan WAS swept (proves the sweep ran at all)',
    !existsSync(orphan), `log mentions a removal: ${/Removed a stale atomic-write/.test(srv.log())}`);
  record('a scratch-named symlink does NOT delete its target outside the data directory',
    existsSync(precious),
    existsSync(precious) ? 'target intact' : 'THE OUTSIDE FILE WAS DELETED');
  record("…and that target's bytes are untouched",
    existsSync(precious) && readFileSync(precious, 'utf8') === PRECIOUS_BYTES);
  record('db.json survives a scratch-named symlink pointing AT it',
    existsSync(path.join(userData, 'db.json')));
  record("…and still holds the user's game",
    existsSync(path.join(userData, 'db.json'))
    && /KEEPME/.test(readFileSync(path.join(userData, 'db.json'), 'utf8')));
  if (srv.bound) {
    const r = await req(srv.base, 'GET', '/api/games');
    record('the API serves the game after the sweep ran over those entries',
      Array.isArray(r.json) && r.json.some((g) => g.name === 'KEEPME'),
      `status ${r.status}`);
  }
  await stop(srv);
  rmSync(userData, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. SR-64 — EVERY cleanPayoffs CALLER REFUSES A NON-NUMBER PAYOFF.
//
// `Number()` coerces, so validating the coerced value accepted inputs that
// were never payoffs (null -> 0, [1] -> 1, "" -> 0, true -> 1). MEASURED
// against this bundle before the fix: POST /api/report with a11:null answered
// 200 and the prose asserted "(5 rather than 0)" — a number the user never
// supplied — while a11:"NaN" was correctly refused.
//
// The unit contract (src/desktoppayoffs.contract.test.ts) proves the function;
// this proves the three CALLERS actually reach it, which is where the
// regression risk lives — a caller that relied on the old coercion would
// break here and nowhere else. Each caller gets a rejected shape AND an
// accepted control, because "everything 400s now" would satisfy the rejection
// half while breaking the app.
// ═══════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-payoffs-'));
  // NASH_SCENARIO_REGEN=1: /api/scenario/regenerate answers 404 "Not enabled."
  // before its handler otherwise, so the flag is what makes that caller
  // reachable at all. It still needs no key: cleanPayoffs runs before the
  // no-key branch, so a rejected matrix must 400 rather than fall through.
  const srv = await boot(userData, { NASH_SCENARIO_REGEN: '1' });
  record('the payoff-validation fixture boots', !!srv.bound,
    srv.bound ? '' : srv.log().slice(-300));

  if (srv.bound) {
    const GOOD = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
    // One rejected shape per caller, each finite under Number() — i.e. each a
    // real instance of the defect, not a shape the old code already refused.
    for (const [route, body, bad] of [
      ['POST /api/report', (p) => ({ payoffs: p }), null],
      ['POST /api/scenario/regenerate', (p) => ({ payoffs: p }), [1]],
      ['POST /api/games', (p) => ({ name: 'sr64', payoffs: p }), ''],
    ]) {
      const [verb, url] = route.split(' ');
      const r = await req(srv.base, verb, url, body({ ...GOOD, a11: bad }));
      record(`SR-64: ${route} refuses a11=${JSON.stringify(bad)} instead of coercing it to a number`,
        r.status === 400,
        `status ${r.status} ${r.text.slice(0, 90)} — a 200 here means the response describes a `
        + 'payoff value the caller never sent');
      // CONTROL: the same caller still accepts a numeric string, so the check
      // above is not passing because the route now refuses everything.
      const ok = await req(srv.base, verb, url, body({ ...GOOD, a11: '5' }));
      record(`SR-64 CONTROL: ${route} still accepts the numeric string "5"`,
        ok.status === 200, `status ${ok.status} ${ok.text.slice(0, 90)}`);
    }
    // …and the ordinary all-numbers matrix, the shape the real client sends.
    const plain = await req(srv.base, 'POST', '/api/report', { payoffs: GOOD });
    record('SR-64 CONTROL: an ordinary numeric matrix still produces a report',
      plain.status === 200, `status ${plain.status}`);
  }
  await stop(srv);
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n══════ DESKTOP LOCAL SURFACE: ${results.length - failed.length}/${results.length} checks passed ══════`);
if (failed.length > 0) {
  console.error(`\n${failed.length} FAILURE(S):`);
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

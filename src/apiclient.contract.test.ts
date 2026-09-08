/**
 * The account-API client: its RULE, executed, and the contract that keeps
 * every account-scoped request inside it.
 *
 * WHY (STRUCT-DESKTOP-19). Session semantics were hand-wired per call site,
 * and six consecutive rounds each found the one site that had not been wired
 * (see `src/utils/apiClient.ts`'s header for the list). Two of them were found
 * this round and are the reason this file exists:
 *
 *   001  `/api/auth/me` treated EVERY failure as a dead session. A transient
 *        503, or one ordinary offline launch of the desktop app in cloud mode,
 *        ran `updateAuthToken(null)` — which DELETES the token from
 *        localStorage. The user was signed out permanently.
 *        Harness: `_gen/d19a1-authme-failure-semantics.mjs`,
 *                 `_gen/d19a2-cloudmode-offline-session-loss.mjs` (no
 *                 interception: a real dead backend).
 *   002  The menu drawer's Danger Zone carried a SECOND copy of the rule
 *        (`clearTokenIfExpired`) with no stale-token guard, so a 401 for a
 *        token the app had already replaced destroyed the live session; and it
 *        put the browser's raw "Failed to fetch" in its error line.
 *        Harness: `_gen/d19a3-dangerzone-session-copy.mjs`.
 *
 * Part A executes the REAL client (no re-implementation, no text pin) over the
 * whole case matrix, with a mutated client as the known-positive for each rule.
 * Part B is the structural contract: nothing outside the client may attach a
 * credential, and the set of endpoints reached outside it is pinned, so a new
 * account-scoped route cannot quietly grow its own session handling again.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createAccountApi, describeRequestFailure, ACCOUNT_REQUEST_TIMEOUT_MS, type AccountApiDeps, type AccountResponse } from './utils/apiClient';
import { DEFAULT_REPORT_FETCH_TIMEOUT_MS } from './utils/fetchTimeout';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};

/**
 * Drop whole-line comments. A comment is not code, and App.tsx's own prose
 * mentions `res.status === 401` while explaining why that check moved into the
 * client — scanning raw text would flag the explanation of the fix. Only lines
 * that are ENTIRELY a comment are removed, so a `//` inside a URL literal is
 * never touched.
 */
function codeOnly(src: string): string {
  return src.split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    .join('\n');
}

// ───────────────────────── Part A — the rule, executed ─────────────────────

type Transport =
  | { kind: 'status'; status: number; body?: unknown; bodyText?: string }
  | { kind: 'reject'; error: unknown };

interface Harness {
  api: ReturnType<typeof createAccountApi>;
  cleared: () => boolean;
  lastInit: () => RequestInit | null;
  lastUrl: () => string | null;
  lastTimeout: () => number | undefined;
  setCommitted: (t: string | null) => void;
  bumpGen: () => void;
  /** Bump the generation the instant the body is read — models the context
   *  moving on DURING the second await, which is where #169's fix lives. */
  bumpGenDuringBodyRead: (on: boolean) => void;
}

function harness(transport: Transport, committed: string | null, build = createAccountApi): Harness {
  let cleared = false;
  let gen = 1;
  let bumpDuringBody = false;
  let lastInit: RequestInit | null = null;
  let lastUrl: string | null = null;
  let lastTimeout: number | undefined;
  let token = committed;
  const deps: AccountApiDeps = {
    getApiUrl: (p) => `http://server${p}`,
    currentToken: () => token,
    currentGen: () => gen,
    clearSession: () => { cleared = true; token = null; },
    fetchWithTimeout: (url, init, _c, timeoutMs) => {
      lastUrl = url; lastInit = init; lastTimeout = timeoutMs;
      if (transport.kind === 'reject') return { promise: Promise.reject(transport.error), clear: () => {} };
      const body = transport.bodyText !== undefined ? transport.bodyText : JSON.stringify(transport.body ?? {});
      const res = new Response(body, { status: transport.status, headers: { 'Content-Type': 'application/json' } });
      // `json()` is where the SECOND await happens; a context change here is
      // the case CodeRabbit CLI raised on #169's fix.
      const patched = new Proxy(res, {
        get(target, prop, recv) {
          if (prop === 'json') return async () => { if (bumpDuringBody) gen += 1; return JSON.parse(body); };
          const v = Reflect.get(target, prop, recv);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      return { promise: Promise.resolve(patched as Response), clear: () => {} };
    },
  };
  return {
    api: build(deps),
    cleared: () => cleared,
    lastInit: () => lastInit,
    lastUrl: () => lastUrl,
    lastTimeout: () => lastTimeout,
    setCommitted: (t) => { token = t; },
    bumpGen: () => { gen += 1; },
    bumpGenDuringBodyRead: (on) => { bumpDuringBody = on; },
  };
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

interface Case {
  name: string;
  committed: string | null;
  requestToken?: string | null;   // omit to use the committed one
  transport: Transport;
  /** move the context on while the body is being read */
  contextMoves?: boolean;
  expect: Partial<AccountResponse> & { cleared: boolean };
}

const CASES: Case[] = [
  // The #163 delayed-401 matrix, unchanged in meaning, now run on the real client.
  { name: 'matching token, 401 -> session died AND cleared',
    committed: 'tok-A', requestToken: 'tok-A', transport: { kind: 'status', status: 401 },
    expect: { unauthorized: true, sessionDied: true, sessionCleared: true, stale: false, cleared: true } },
  { name: 'STALE token (delayed response after re-auth), 401 -> died, but the CURRENT session is left alone',
    committed: 'tok-B', requestToken: 'tok-A', transport: { kind: 'status', status: 401 },
    expect: { unauthorized: true, sessionDied: true, sessionCleared: false, cleared: false } },
  // A request that attached NO credential cannot prove one died: the desktop
  // local owner lists and saves games with no token at all, and a 401 there is
  // the server declining an anonymous caller, not a session expiring. Before
  // this, the first of these cleared a session that never existed, and both
  // reported `sessionDied` to callers whose alert reads "Invalid or expired
  // session." (CodeRabbit CLI on this branch).
  { name: 'no token sent, none committed, 401 -> unauthorized, but nothing died and nothing is cleared',
    committed: null, requestToken: null, transport: { kind: 'status', status: 401 },
    expect: { unauthorized: true, sessionDied: false, sessionCleared: false, cleared: false } },
  { name: 'no token sent but one has since been committed, 401 -> unauthorized, and says nothing about it',
    committed: 'tok-B', requestToken: null, transport: { kind: 'status', status: 401 },
    expect: { unauthorized: true, sessionDied: false, sessionCleared: false, cleared: false } },
  { name: 'matching token, 200 -> not an auth failure, nothing cleared',
    committed: 'tok-A', requestToken: 'tok-A', transport: { kind: 'status', status: 200, body: { ok: 1 } },
    expect: { ok: true, unauthorized: false, sessionDied: false, sessionCleared: false, cleared: false } },
  // STRUCT-DESKTOP-19/001: the three that used to destroy the credential.
  { name: '503 (backend redeploying) -> NOT a dead session, NOT unauthorized, credential kept',
    committed: 'tok-A', transport: { kind: 'status', status: 503, body: { error: 'Service Unavailable' } },
    expect: { ok: false, status: 503, unauthorized: false, sessionDied: false, sessionCleared: false, cleared: false } },
  { name: '500 -> NOT a dead session, credential kept',
    committed: 'tok-A', transport: { kind: 'status', status: 500 },
    expect: { sessionDied: false, cleared: false } },
  { name: '404 -> NOT a dead session, credential kept',
    committed: 'tok-A', transport: { kind: 'status', status: 404 },
    expect: { sessionDied: false, cleared: false } },
  { name: 'network failure (offline / refused) -> kind network, credential kept',
    committed: 'tok-A', transport: { kind: 'reject', error: new TypeError('Failed to fetch') },
    expect: { kind: 'network', ok: false, status: 0, unauthorized: false, sessionDied: false, cleared: false } },
  { name: 'our own deadline fired -> kind timeout, credential kept',
    committed: 'tok-A', transport: { kind: 'reject', error: abortError() },
    expect: { kind: 'timeout', ok: false, sessionDied: false, cleared: false } },
  // The context-generation gate (RED-DESKTOP-18/001 + STRUCT-DESKTOP-19/001 C).
  { name: 'context moved during the body read, 401 -> stale, claims NOTHING, and nothing is cleared',
    committed: 'tok-A', requestToken: 'tok-A', transport: { kind: 'status', status: 401 }, contextMoves: true,
    expect: { stale: true, unauthorized: false, sessionDied: false, sessionCleared: false, cleared: false } },
  { name: 'context moved during the body read, 200 -> stale (the caller must act on nothing)',
    committed: 'tok-A', transport: { kind: 'status', status: 200, body: { game: 1 } }, contextMoves: true,
    expect: { stale: true, ok: true, cleared: false } },
  // A success whose body is not JSON must be distinguishable from a real one.
  { name: '200 with an unparseable body -> ok, but dataParsed false',
    committed: 'tok-A', transport: { kind: 'status', status: 200, bodyText: '<html>proxy</html>' },
    expect: { ok: true, dataParsed: false, cleared: false } },
];

async function runCase(c: Case, build = createAccountApi): Promise<{ res: AccountResponse; cleared: boolean }> {
  const h = harness(c.transport, c.committed, build);
  if (c.contextMoves) h.bumpGenDuringBodyRead(true);
  const init = 'requestToken' in c ? { token: c.requestToken } : {};
  const res = await h.api.request('/api/games', init);
  return { res, cleared: h.cleared() };
}

for (const c of CASES) {
  const { res, cleared } = await runCase(c);
  const wrong: string[] = [];
  for (const [k, want] of Object.entries(c.expect)) {
    const got = k === 'cleared' ? cleared : (res as any)[k];
    if (got !== want) wrong.push(`${k}=${String(got)} (want ${String(want)})`);
  }
  check(`client rule: ${c.name}`, wrong.length === 0, wrong.join(', '));
}

// The caller's own staleness predicate (a dialog session, a save request id)
// is honoured on top of the context generation.
{
  const h = harness({ kind: 'status', status: 401 }, 'tok-A');
  const res = await h.api.request('/api/games', { isStale: () => true });
  check('client rule: a caller-supplied isStale() makes the response stale and clears nothing',
    res.stale === true && res.sessionDied === false && h.cleared() === false,
    `stale=${res.stale} died=${res.sessionDied} cleared=${h.cleared()}`);
}

// Headers are the client's job, and only the client's.
{
  const h = harness({ kind: 'status', status: 200 }, 'tok-A');
  await h.api.request('/api/games', { method: 'POST', json: { a: 1 } });
  const hdr = (h.lastInit()?.headers ?? {}) as Record<string, string>;
  check('client attaches the committed bearer token itself', hdr['Authorization'] === 'Bearer tok-A', JSON.stringify(hdr));
  check('client sets Content-Type only when it is sending JSON', hdr['Content-Type'] === 'application/json');
  check('client sends the body it was given', h.lastInit()?.body === JSON.stringify({ a: 1 }));
  check('client resolves the path through getApiUrl', h.lastUrl() === 'http://server/api/games', String(h.lastUrl()));

  const h2 = harness({ kind: 'status', status: 200 }, 'tok-A');
  await h2.api.request('/api/games', { token: null });
  const hdr2 = (h2.lastInit()?.headers ?? {}) as Record<string, string>;
  check('an explicit token: null sends NO Authorization header (the desktop local owner)',
    !('Authorization' in hdr2), JSON.stringify(hdr2));
  check('a GET without a body sets no Content-Type', !('Content-Type' in hdr2));
}

/**
 * REGRESSION PROBE (STRUCT-DESKTOP-19, self-caught before the single push).
 *
 * Routing the games routes through `fetchWithTimeout` gave them a deadline they
 * never had — and if that deadline were the caller's DEFAULT, it would be
 * App.tsx's `REPORT_FETCH_TIMEOUT_MS`, which CI's e2e bundle compiles down to
 * 5 s (`VITE_E2E_FETCH_TIMEOUT_MS: '5000'` in .github/workflows/test.yml) so two
 * report-stall tests need not each wait 22 real seconds. Every save, edit,
 * delete and list in CI would then abort after 5 s on a loaded runner, while the
 * server had already done the write. The client passes its OWN number on every
 * request instead, so that knob cannot reach an account route.
 */
{
  const h = harness({ kind: 'status', status: 200 }, 'tok-A');
  await h.api.request('/api/games');
  check('an account request carries an explicit deadline (never "whatever the caller defaults to")',
    typeof h.lastTimeout() === 'number', String(h.lastTimeout()));
  check('that deadline is the constant, not the CI-overridable report timeout',
    h.lastTimeout() === ACCOUNT_REQUEST_TIMEOUT_MS && ACCOUNT_REQUEST_TIMEOUT_MS === DEFAULT_REPORT_FETCH_TIMEOUT_MS
    && ACCOUNT_REQUEST_TIMEOUT_MS === 22_000, `${h.lastTimeout()} / ${ACCOUNT_REQUEST_TIMEOUT_MS}`);
  const h2 = harness({ kind: 'status', status: 200 }, 'tok-A');
  await h2.api.request('/api/games', { timeoutMs: 1234 });
  check('a caller may still name its own deadline', h2.lastTimeout() === 1234, String(h2.lastTimeout()));
  const client = readFileSync('src/utils/apiClient.ts', 'utf8');
  check('the client never reads the CI-overridable variable itself',
    !/VITE_E2E_FETCH_TIMEOUT_MS|import\.meta\.env/.test(codeOnly(client)));
  check('fixture: omitting the explicit deadline would hand the request the caller\'s default',
    /init\.timeoutMs \?\? ACCOUNT_REQUEST_TIMEOUT_MS,/.test(client));
}

// User-facing copy for a request that never produced a response — the browser's
// own text must never reach the user (STRUCT-DESKTOP-19/002).
{
  const net = { kind: 'network' } as AccountResponse;
  const to = { kind: 'timeout' } as AccountResponse;
  check('describeRequestFailure says what happened, in our words, for a network failure',
    describeRequestFailure(net, 'delete your account') === 'Connection error. Could not delete your account.');
  check('describeRequestFailure distinguishes our own deadline',
    describeRequestFailure(to, 'delete your account') === 'The server did not answer in time. Could not delete your account.');
  check('describeRequestFailure never echoes the browser\'s own wording',
    !/failed to fetch|load failed/i.test(describeRequestFailure(net, 'x') + describeRequestFailure(to, 'x')));
}

// ─── Known-positive mutants: each rule, removed, must fail its own case ───
// These are the mutations a reviewer would try on `createAccountApi`. Each one
// is a real alternative implementation of the SAME interface, run through the
// SAME matrix; the check passes only when the mutant FAILS the case that names
// the rule it broke. (A mutant that changed nothing would show up here as a
// case that still passes.)
function mutantIgnoresStaleToken(deps: AccountApiDeps) {
  // The CodeRabbit-on-#163 regression: clear on any 401, whatever token it was.
  const real = createAccountApi(deps);
  return {
    request: async (p: string, i?: any) => {
      const res = await real.request(p, i);
      if (res.status === 401 && !res.stale && !res.sessionCleared) { deps.clearSession(); return { ...res, sessionCleared: true }; }
      return res;
    },
  };
}
function mutantTreatsAnyFailureAsDead(deps: AccountApiDeps) {
  // The STRUCT-DESKTOP-19/001 shape: any non-ok, and any rejection, is a dead
  // session. This is exactly what `/api/auth/me` used to do.
  const real = createAccountApi(deps);
  return {
    request: async (p: string, i?: any) => {
      const res = await real.request(p, i);
      if (!res.ok && !res.stale) { deps.clearSession(); return { ...res, sessionDied: true, sessionCleared: true }; }
      return res;
    },
  };
}
function mutantAnonymous401IsDeadSession(deps: AccountApiDeps) {
  // Drop the "a credential was attached" half of the rule: every 401 becomes a
  // dead session, including one answering a request that presented nothing.
  const real = createAccountApi(deps);
  return {
    request: async (p: string, i?: any) => {
      const res = await real.request(p, i);
      if (res.status === 401 && !res.stale && !res.sessionDied) return { ...res, sessionDied: true };
      return res;
    },
  };
}
{
  const staleTokenCase = CASES.find((c) => c.name.startsWith('STALE token'))!;
  const m1 = await runCase(staleTokenCase, mutantIgnoresStaleToken as any);
  check('mutant: dropping the stale-token comparison makes the STALE-token case fail (so the case really tests it)',
    m1.cleared === true, `cleared=${m1.cleared}`);

  for (const name of ['no token sent, none committed', 'no token sent but one has since been committed']) {
    const c = CASES.find((x) => x.name.startsWith(name))!;
    const m3 = await runCase(c, mutantAnonymous401IsDeadSession as any);
    check(`mutant: treating an anonymous 401 as a dead session makes "${name}" fail (so the case really tests it)`,
      m3.res.sessionDied === true, `sessionDied=${m3.res.sessionDied}`);
  }

  for (const name of ['503 (backend redeploying)', 'network failure (offline / refused)', 'our own deadline fired']) {
    const c = CASES.find((x) => x.name.startsWith(name))!;
    const m2 = await runCase(c, mutantTreatsAnyFailureAsDead as any);
    check(`mutant: treating any failure as a dead session makes "${name}" fail (so the case really tests it)`,
      m2.cleared === true, `cleared=${m2.cleared}`);
  }
}

// ──────────────── Part B — the contract: one client, no exceptions ─────────

/** Every source file that runs in the browser, minus the client itself. */
function browserSources(): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        // e2e harnesses and integration tests are Node scripts, not app code.
        if (entry.name === 'e2e' || entry.name === 'integration' || entry.name === 'evals') continue;
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name) || entry.name === 'test.ts') continue;
      if (p === join('src', 'utils', 'apiClient.ts')) continue;
      out.push({ path: p, src: readFileSync(p, 'utf8') });
    }
  };
  walk('src');
  return out;
}

/**
 * Each request site in a file — `fetch(` AND `fetchWithTimeout(`, because the
 * bounded wrapper is a request too and a route that used it would otherwise
 * slip past this whole contract — with the text of that call only (cut at the
 * next site so one window can never bleed into the next).
 */
function fetchSites(rawSrc: string): Array<{ index: number; text: string }> {
  const src = codeOnly(rawSrc);
  const out: Array<{ index: number; text: string }> = [];
  const re = /\bfetch(?:WithTimeout)?\(/g;
  let m: RegExpExecArray | null;
  const starts: number[] = [];
  while ((m = re.exec(src))) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    // The DEFINITION of fetchWithTimeout is not a call site. (Only `function
    // NAME(` is skipped: `const { promise, clear } = fetchWithTimeout(` is a
    // CALL, and an earlier draft that also skipped `= ` silently dropped every
    // bounded request — the report and regenerate sites — from this contract.)
    if (/\bfunction\s*$/.test(src.slice(Math.max(0, starts[i] - 20), starts[i]))) continue;
    const end = Math.min(starts[i] + 700, i + 1 < starts.length ? starts[i + 1] : src.length);
    out.push({ index: starts[i], text: src.slice(starts[i], end) });
  }
  return out;
}

const API_PATH = /['"`](\/api\/[A-Za-z0-9/_.-]*)/;

/**
 * A credential being BUILT, as opposed to the word appearing in prose. Whole-line
 * comment stripping is not enough on its own: a JSX comment's continuation lines
 * start with ordinary text. A header key is always quoted or followed by a colon.
 */
const CREDENTIAL_IN_CODE = /['"]Authorization['"]|\bAuthorization\s*:|authHeaders/;

/**
 * Endpoints reached by a raw `fetch` OUTSIDE the client, each one deliberately
 * unauthenticated: they carry no bearer token, so there is no session for them
 * to mishandle. The set is pinned in BOTH directions — a new entry means a new
 * route grew its own request handling and must be justified here; a missing one
 * means a route moved and this list is stale.
 */
const UNAUTHENTICATED_OUTSIDE_CLIENT = [
  '/api/admin/stats',          // AdminDashboard: x-admin-secret, not a user session
  '/api/auth/desktop-hint',    // OtherAccountsNotice: anonymous "are there accounts here"
  '/api/auth/forgot-password',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/reset-password',
  '/api/auth/verify',
  '/api/download/dmg',         // DownloadModal: public download
  '/api/feedback',             // anonymous feedback
  '/api/health',               // capability probe + the drawer's base-URL check
  '/api/report',               // the explanation endpoint: no account involved
  '/api/scenario/regenerate',  // ditto
].sort();

/** The one other credential in the app: the admin panel's shared secret. It is
 *  not a user session, so its own 401 handling is not the rule this contract
 *  is about — but it must SAY so at the site, which is what this matches. */
const OTHER_CREDENTIAL = /x-admin-secret/;

{
  const credentialed: string[] = [];
  const paths = new Set<string>();
  for (const { path, src } of browserSources()) {
    for (const site of fetchSites(src)) {
      const line = src.slice(0, site.index).split('\n').length;
      const apiPath = site.text.match(API_PATH)?.[1];
      // A template path such as `/api/games/${id}` reduces to its literal head.
      if (apiPath) paths.add(apiPath.replace(/\/$/, ''));
      if (CREDENTIAL_IN_CODE.test(site.text)) credentialed.push(`${path}:${line}`);
    }
  }
  check('no request outside src/utils/apiClient.ts attaches an Authorization header',
    credentialed.length === 0, credentialed.join(', '));

  const found = [...paths].sort();
  check('the endpoints reached outside the client are EXACTLY the pinned unauthenticated set',
    JSON.stringify(found) === JSON.stringify(UNAUTHENTICATED_OUTSIDE_CLIENT),
    `found ${JSON.stringify(found)}`);
}

// Known-positive fixtures for Part B: the two shapes this contract exists to
// stop — the pre-fix `/api/auth/me` and the pre-fix Danger Zone — must both be
// flagged by the same scanner, and an ordinary anonymous fetch must not be.
{
  const preFixAuthMe = `fetch(getApiUrl('/api/auth/me'), {\n  headers: { 'Authorization': \`Bearer \${authToken}\` }\n})`;
  const preFixDangerZone = `const res = await fetch(getApiUrl('/api/auth/delete-request'), {\n  method: 'POST',\n  headers: { 'Authorization': \`Bearer \${authToken}\`, 'Content-Type': 'application/json' },\n});`;
  const preFixGamesGet = `const res = await fetch(getApiUrl('/api/games'), { headers: authHeaders() });`;
  const anonymous = `fetch(getApiUrl('/api/health')).then((r) => r.json())`;
  const flags = (s: string) => fetchSites(s).some((site) => CREDENTIAL_IN_CODE.test(site.text));
  check('fixture: the pre-fix /api/auth/me request (STRUCT-DESKTOP-19/001) is flagged', flags(preFixAuthMe));
  check('fixture: the pre-fix Danger Zone request (STRUCT-DESKTOP-19/002) is flagged', flags(preFixDangerZone));
  check('fixture: the pre-fix authHeaders() games read (RED-DESKTOP-16/001) is flagged', flags(preFixGamesGet));
  check('control: an anonymous /api/health probe is NOT flagged', !flags(anonymous));
  check('control: prose mentioning the word "Authorization" is not a credential',
    !CREDENTIAL_IN_CODE.test('a save with no Authorization header lands under the local owner'));
  check('fixture: a NEW account route would break the pinned endpoint set',
    !UNAUTHENTICATED_OUTSIDE_CLIENT.includes('/api/games/adopt-local'));
}

// The client is the only place the rule may live: no second copy may reappear
// under another name (the `clearTokenIfExpired` shape, STRUCT-DESKTOP-19/002).
{
  const offenders: string[] = [];
  for (const { path, src } of browserSources()) {
    for (const site of fetchSites(src)) {
      if (!/status === 401/.test(site.text)) continue;
      if (OTHER_CREDENTIAL.test(site.text)) continue;   // the admin secret, not a session
      offenders.push(`${path}:${src.slice(0, site.index).split('\n').length}`);
    }
  }
  check('no request outside the client decides session-death from a raw 401 status',
    offenders.length === 0, offenders.join(', '));
  check('fixture: the deleted `clearTokenIfExpired` shape would be caught by that scan',
    /res\.status === 401/.test('const clearTokenIfExpired = (res) => { if (res.status === 401) updateAuthToken(null); };'));
}

// An unreadable 2xx is neither an identity nor a library. Both commit sites in
// App.tsx must require `dataParsed` (and the list, an actual array) before the
// body reaches state — a captive portal's 200 HTML otherwise renders a user
// with no name, or replaces the array every row renderer maps over.
{
  const appSrc = codeOnly(readFileSync('src/App.tsx', 'utf8'));
  const IDENTITY_PIN = /if \(res\.ok && res\.dataParsed\) \{ setUser\(res\.data\); return; \}/;
  const LIST_PIN = /if \(!res\.ok \|\| !res\.dataParsed \|\| !Array\.isArray\(res\.data\)\) return undefined;/;
  check('the identity probe commits only a parsed 2xx body', IDENTITY_PIN.test(appSrc));
  check('the saved-game list commits only a parsed 2xx body that is an array', LIST_PIN.test(appSrc));
  // Known-positives: each pin refuses the shape it replaced.
  check('fixture: the old unguarded identity commit would be caught',
    !IDENTITY_PIN.test('      if (res.ok) { setUser(res.data); return; }'));
  check('fixture: the old unguarded list commit would be caught',
    !LIST_PIN.test('      if (!res.ok) return undefined;\n      const rows = res.data;'));
}

// Which flag each caller reads is the whole point of splitting them. The gate
// sites ask "did the server demand an account?" (`unauthorized`, true for a
// signed-out desktop user's 401 — e2e §78's close-and-reopen block turned red
// the moment they read `sessionDied` instead); only the sites that clear, log
// or word a message about "your session" read the narrower flag.
{
  const appSrc = codeOnly(readFileSync('src/App.tsx', 'utf8'));
  const gateSites = appSrc.match(/const wasAuthFailure = res\.unauthorized;/g) ?? [];
  check('both Save and Edit gates read `unauthorized`', gateSites.length === 2, `${gateSites.length} site(s)`);
  check('no gate still reads `sessionDied`', !/const wasAuthFailure = res\.sessionDied;/.test(appSrc));
  check('the saved-game list clears on `unauthorized` too', /if \(res\.unauthorized\) \{\n\s*if \(seq === gamesFetchSeqRef\.current\) setUserCustomGames\(\[\]\);/.test(appSrc));
  check('the identity probe still reads the narrower `sessionDied`', /setUser\(null\);\s*if \(res\.sessionDied\) return;/.test(appSrc));
  // Known-positives: the pre-fix shape of each pin is refused.
  check('fixture: a gate reading sessionDied would be caught',
    /const wasAuthFailure = res\.sessionDied;/.test('        const wasAuthFailure = res.sessionDied;'));
  check('fixture: a list clearing only on sessionDied would be caught',
    !/if \(res\.unauthorized\) \{/.test('      if (res.sessionDied) {\n        if (seq === gamesFetchSeqRef.current) setUserCustomGames([]);'));
}

if (failures > 0) { console.error(`✗ api client: ${failures} failed`); process.exit(1); }
console.log('✓ api client contract');

/**
 * The local owner: what it must and must not reach.
 *
 * The feature is that the desktop app stops asking a user to invent a password
 * to save a file to their own disk. The RISK is that a fallback identity leaks
 * into a route where "whoever is at the keyboard" is not an acceptable answer.
 *
 * `getAuthUser` guards account DELETION as well as saved games. So the fallback
 * lives in a SEPARATE resolver used only by the four game routes, and the
 * deletion routes keep the strict check. That distinction is the entire safety
 * argument, so it is asserted against the source rather than left to a reader —
 * a future edit that "tidies" the two resolvers into one would silently hand
 * the keyboard an account-deletion flow, and every behavioural test would still
 * pass.
 */
import { readFileSync, readdirSync } from 'node:fs';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const server = readFileSync('server.ts', 'utf8');

/** Each `getAuthUser`/`resolveGameOwner` call, tagged with the route above it. */
function resolverByRoute(src: string): Array<{ route: string; resolver: string }> {
  const out: Array<{ route: string; resolver: string }> = [];
  let route = '(top level)';
  for (const line of src.split('\n')) {
    const m = line.match(/app\.(get|post|patch|delete)\("(\/api\/[^"]+)"/);
    if (m) route = m[2];
    const r = line.match(/\b(getAuthUser|resolveGameOwner)\(req\)/);
    if (r) out.push({ route, resolver: r[1] });
  }
  return out;
}

const sites = resolverByRoute(server);
// A count is not coverage. `sites.length >= 7` passes if a route VANISHES and
// another gains a call — the shape of a check that cannot fail for the reason
// it claims, which is this campaign's most repeated defect. Assert each route
// by NAME, exactly once.
const EXPECTED_ONCE = ['/api/auth/me', '/api/auth/delete-request', '/api/auth/delete-confirm'];
const EXPECTED_TWICE = ['/api/games', '/api/games/:id'];
for (const r of EXPECTED_ONCE) {
  check(`${r} is present exactly once`, sites.filter((s2) => s2.route === r).length === 1,
    `${sites.filter((s2) => s2.route === r).length}`);
}
for (const r of EXPECTED_TWICE) {
  check(`${r} is present twice (read + write)`, sites.filter((s2) => s2.route === r).length === 2,
    `${sites.filter((s2) => s2.route === r).length}`);
}

// Routes that decide who owns SAVED GAMES may fall back to the local owner.
const GAME_ROUTES = ['/api/games', '/api/games/:id'];
// Routes where "whoever is at the keyboard" is not an acceptable identity.
const STRICT_ROUTES = ['/api/auth/delete-request', '/api/auth/delete-confirm', '/api/auth/me'];

for (const { route, resolver } of sites) {
  if (GAME_ROUTES.includes(route)) {
    check(`${route} resolves the game owner (so the desktop works signed out)`,
      resolver === 'resolveGameOwner', `uses ${resolver}`);
  }
  if (STRICT_ROUTES.includes(route)) {
    check(`${route} keeps the STRICT check — a fallback identity here would hand the keyboard someone's account`,
      resolver === 'getAuthUser', `uses ${resolver}`);
  }
}
check('account deletion is covered by the strict list',
  sites.some((s) => s.route === '/api/auth/delete-confirm' && s.resolver === 'getAuthUser'));

// The owner may only ever exist on the desktop.
check('the owner is gated on IS_ELECTRON', /function isDesktop\(\)[\s\S]{0,120}IS_ELECTRON === 'true'/.test(server));
check('provisioning refuses to run off the desktop',
  /function ensureLocalOwner\(\)[\s\S]{0,160}if \(!isDesktop\(\)\) return null;/.test(server));
// Adoption returns { games, adopted: 0 } off the desktop — the caller's array untouched.
check('adoption refuses to run off the desktop and hands back the UNTOUCHED array',
  /function adoptLocalGames\([\s\S]{0,260}if \(!isDesktop\(\) \|\| userId === LOCAL_OWNER_ID\) return \{ games: db\.games, adopted: 0 \};/.test(server));
// Adoption RE-PARENTS (same rows, new owner) rather than copying — copying would
// duplicate a library on a second sign-in — and it does so on NEW objects in a NEW
// array (a map that spreads each row), never by writing into the live rows: the
// route commits the candidate only through saveDBOrFail's confirmed write
// (RED-DESKTOP-11/001 + CodeRabbit on #132). Writing `g.userId = userId` into the
// live row is the bug this guards against.
const adoptSrc = server.slice(server.indexOf('function adoptLocalGames'), server.indexOf('function adoptLocalGames') + 1200);
check('adoption re-parents rather than copies, on a fresh array of fresh objects',
  /db\.games\.map\(/.test(adoptSrc) && /\{ \.\.\.g, userId \}/.test(adoptSrc)
  && !/\.push\(/.test(adoptSrc) && !/g\.userId = userId/.test(adoptSrc));
// And the route persists that candidate, never the live array.
check('the adopt-local route commits the candidate through a confirmed write and answers a failure with its own message',
  /adopt-local[\s\S]{0,900}const \{ games, adopted \} = adoptLocalGames\(db, user\.id\);[\s\S]{0,1200}saveDBAwaited\(games\)[\s\S]{0,600}still saved on this device/.test(server));

/* ------------------------------------------------------ known positives */
const MUST_FLAG: Array<[string, string]> = [
  ['deletion falling back to the game owner',
   'app.post("/api/auth/delete-confirm", h, (req, res) => {\n  const user = resolveGameOwner(req);\n});'],
  ['a game route left on the strict check',
   'app.get("/api/games", h, (req, res) => {\n  const user = getAuthUser(req);\n});'],
];
for (const [name, src] of MUST_FLAG) {
  const found = resolverByRoute(src);
  const bad = found.some((f) => (STRICT_ROUTES.includes(f.route) && f.resolver !== 'getAuthUser')
    || (GAME_ROUTES.includes(f.route) && f.resolver !== 'resolveGameOwner'));
  check(`fixture "${name}" is flagged`, bad);
}
// Control: the correct shape must not be flagged.
{
  const good = 'app.get("/api/games", h, (req, res) => {\n  const user = resolveGameOwner(req);\n});\n'
    + 'app.post("/api/auth/delete-confirm", h, (req, res) => {\n  const user = getAuthUser(req);\n});';
  const found = resolverByRoute(good);
  const bad = found.some((f) => (STRICT_ROUTES.includes(f.route) && f.resolver !== 'getAuthUser')
    || (GAME_ROUTES.includes(f.route) && f.resolver !== 'resolveGameOwner'));
  check('the correct shape is not flagged', !bad);
}

// RED-DESKTOP-16/001: the OLD expression silently re-owned a presented-but-dead
// token under the shared local owner. It must never reappear, anywhere in the
// file — not just inside resolveGameOwner, which no longer exists under that
// name.
check('the silently-reowning expression `getAuthUser(req) ?? ensureLocalOwner()` is gone from server.ts',
  !/getAuthUser\(req\)\s*\?\?\s*ensureLocalOwner\(\)/.test(server));
// Known-positive: the same regex, run against a fixture that plants the old
// expression back, must fail BY NAME (proving the check can actually fire).
check('fixture: a planted old expression is flagged by the same regex',
  /getAuthUser\(req\)\s*\?\?\s*ensureLocalOwner\(\)/.test('function getGameOwner(req) {\n  return getAuthUser(req) ?? ensureLocalOwner();\n}'));

// resolveGameOwner itself must distinguish "no token" from "a token that
// didn't resolve" rather than collapsing both to the same fallback — the
// actual mechanism of the fix, not just the absence of the old text (a
// rewrite that reintroduced the bug under new names would still pass the
// text-absence check above). OPUS-REVIEW-DESKTOP16 N2: the return shape is
// now a bare `User | null` — the earlier `{ owner, presentedDeadToken }`
// wrapper had a second field nothing ever read, so it was dropped rather
// than kept as documented-but-unenforced dead code.
{
  const fnStart = server.indexOf('function resolveGameOwner(req');
  check('resolveGameOwner is defined', fnStart >= 0);
  const fnSrc = server.slice(fnStart, server.indexOf('\n}', fnStart) + 2);
  check('resolveGameOwner checks getAuthUser(req) first',
    /const user = getAuthUser\(req\);\s*\n\s*if \(user\) return user;/.test(fnSrc));
  check('resolveGameOwner refuses (null) when an Authorization header WAS presented but did not resolve',
    /if \(hasAuthorizationHeader\(req\)\) return null;/.test(fnSrc));
  check('resolveGameOwner falls back to the local owner ONLY when no Authorization header was presented at all',
    /return ensureLocalOwner\(\);/.test(fnSrc));
  // CodeRabbit CLI: the three checks above each confirm a LINE is present
  // ANYWHERE in the function — none of them enforce ORDER. A reordering that
  // moves the `hasAuthorizationHeader` guard BEFORE `getAuthUser` would
  // refuse every VALID token too (any presented header, resolved or not,
  // hits the guard first) while still satisfying all three checks above,
  // since every substring they look for would still be present somewhere in
  // the function. One exact WHOLE-BODY pin (statement order included) closes
  // that gap.
  check('resolveGameOwner\'s full body matches the exact intended sequence (auth check, then the header-presence guard, then the local-owner fallback — in that order)',
    /^function resolveGameOwner\(req: express\.Request\): User \| null \{\n {2}const user = getAuthUser\(req\);\n {2}if \(user\) return user;\n {2}if \(hasAuthorizationHeader\(req\)\) return null;\n {2}return ensureLocalOwner\(\);\n\}$/.test(fnSrc));

  // Known-positive: a regression back to unconditional fallback (the old bug,
  // renamed) must be caught by the same three checks above going false.
  const regressed = 'function resolveGameOwner(req) {\n  return getAuthUser(req) ?? ensureLocalOwner();\n}';
  check('fixture: a regression to unconditional fallback fails the "presented header refused" check',
    !/if \(hasAuthorizationHeader\(req\)\) return null;/.test(regressed));
  // Known-positive: a regression back to the narrower, Bearer-SPECIFIC
  // predicate this same finding replaced (CodeRabbit on server.ts:2066 —
  // OPUS-REVIEW-DESKTOP16 NOTE 1's "unreachable from the SPA" argument
  // stopped being load-bearing once a bare Bearer/Basic/Token header proved
  // reachable through a direct API call) must ALSO be caught, since it is
  // textually different from `hasAuthorizationHeader`.
  const regressedBearerOnly = 'function resolveGameOwner(req) {\n  const user = getAuthUser(req);\n  if (user) return user;\n'
    + '  if (hasPresentedToken(req)) return null;\n  return ensureLocalOwner();\n}';
  check('fixture: a regression back to the Bearer-specific predicate (hasPresentedToken) fails the structural check',
    !/if \(hasAuthorizationHeader\(req\)\) return null;/.test(regressedBearerOnly));
  // Known-positive (CodeRabbit CLI, MAJOR): the reordered shape itself — the
  // header-presence guard moved BEFORE the auth check. Every one of the
  // three presence checks above still matches this text (nothing was
  // deleted, only moved), so ONLY the new whole-body order pin can catch it.
  const reordered = 'function resolveGameOwner(req: express.Request): User | null {\n'
    + '  if (hasAuthorizationHeader(req)) return null;\n'
    + '  const user = getAuthUser(req);\n'
    + '  if (user) return user;\n'
    + '  return ensureLocalOwner();\n}';
  check('fixture sanity: the reordered function still passes all three individual presence checks (proving they cannot catch this on their own)',
    /const user = getAuthUser\(req\);\s*\n\s*if \(user\) return user;/.test(reordered)
    && /if \(hasAuthorizationHeader\(req\)\) return null;/.test(reordered)
    && /return ensureLocalOwner\(\);/.test(reordered));
  check('fixture: the reordered function (header guard before the auth check — would 401 a VALID token) fails the whole-body order pin',
    !/^function resolveGameOwner\(req: express\.Request\): User \| null \{\n {2}const user = getAuthUser\(req\);\n {2}if \(user\) return user;\n {2}if \(hasAuthorizationHeader\(req\)\) return null;\n {2}return ensureLocalOwner\(\);\n\}$/.test(reordered));
}

// OPUS-REVIEW-DESKTOP16 (residual) + director's structural decision
// (2026-09-07, following CodeRabbit on server.ts:2066): `hasPresentedToken`
// (Bearer-scheme-specific: `parseBearerToken(req) !== null`) is replaced by
// `hasAuthorizationHeader` (structural: header PRESENCE, not scheme
// parsing) — the earlier predicate read a bare `Bearer`, whitespace-only
// `Bearer `, `Basic`/`Token` schemes, and (via Node keeping only the FIRST
// `Authorization` header) a dead Bearer masked by a preceding Basic header
// as "nothing presented", so all of those fell back to the local owner
// exactly like RED-DESKTOP-16/001's original bug. This file has no way to
// IMPORT server.ts (it is the app entrypoint, not a module anything else
// here requires), so re-pinned the same way as before: an EXACT-text pin
// on the real function body (a mutant fails this immediately, by name),
// plus a case matrix gated by that pin, not trusted on its own.
{
  check('hasAuthorizationHeader is exactly `return typeof req.headers.authorization === "string";` (structural: only an ABSENT header counts as no-credential)',
    /function hasAuthorizationHeader\(req: express\.Request\): boolean \{\s*\n\s*return typeof req\.headers\.authorization === "string";\s*\n\}/.test(server));

  // Known-positives: two DIFFERENT realistic regressions — a lazy
  // hardcoded shortcut, and "tidying" it back to the narrower Bearer-only
  // predicate this same round replaced.
  const regressedHardcodedFalse = 'function hasAuthorizationHeader(req: express.Request): boolean {\n  return false;\n}';
  check('fixture: a hardcoded-false hasAuthorizationHeader fails the exact-body-text pin',
    !/function hasAuthorizationHeader\(req: express\.Request\): boolean \{\s*\n\s*return typeof req\.headers\.authorization === "string";\s*\n\}/.test(regressedHardcodedFalse));
  const regressedBackToBearerOnly = 'function hasAuthorizationHeader(req: express.Request): boolean {\n  return parseBearerToken(req) !== null;\n}';
  check('fixture: reverting to the old Bearer-only predicate fails the exact-body-text pin',
    !/function hasAuthorizationHeader\(req: express\.Request\): boolean \{\s*\n\s*return typeof req\.headers\.authorization === "string";\s*\n\}/.test(regressedBackToBearerOnly));

  // Case matrix — gated by the exact-text pin above (its realism is
  // guaranteed by that pin passing, not by itself): every header shape
  // OPUS NOTE 1 and CodeRabbit (server.ts:2066) named. Only the ABSENT
  // header (undefined) reads as "nothing presented"; every string value,
  // however malformed, reads as presented.
  const hasAuthorizationHeaderFixture = (authHeader: string | undefined): boolean => typeof authHeader === 'string';
  const cases: Array<[string, string | undefined, boolean]> = [
    ['absent header (undefined) -> the ONLY case the local owner may answer', undefined, false],
    ['empty string header -> a credential WAS presented', '', true],
    ['bare "Bearer" (no space, no token at all) -> presented', 'Bearer', true],
    ['"Bearer " (whitespace only after the scheme) -> presented', 'Bearer ', true],
    ['"Bearer    " (several whitespace chars, still no token) -> presented', 'Bearer    ', true],
    ['"Basic eHl6" (a real, non-Bearer scheme) -> presented', 'Basic eHl6', true],
    ['"Token abc" (a made-up non-Bearer scheme) -> presented', 'Token abc', true],
    ['a garbled Bearer token -> presented', 'Bearer dead', true],
  ];
  for (const [name, header, expected] of cases) {
    check(`hasAuthorizationHeader fixture: ${name}`, hasAuthorizationHeaderFixture(header) === expected);
  }
}

// RED-DESKTOP-13/001 (director-reproduced), now closed structurally
// (BLUE-LIST-14): the drawer's Library tab and the sidebar both render
// through ONE src/components/SavedGamesList.tsx, which gates ownership on
// `canOwnGames` (token OR desktop local owner) and never receives a `user`
// prop at all — so a `user`-keyed gate on the saved-games list is no longer
// merely wrong, it is impossible to write without adding a prop this file
// would then flag.
{
  const list = readFileSync('src/components/SavedGamesList.tsx', 'utf8');
  // Prose (this file's own comments) legitimately says "user" — what must be
  // absent is a `user` GATE, i.e. a JSX-conditional or destructured `user`
  // this component could branch on. It never takes a `user` prop at all.
  check('SavedGamesList takes no `user` prop (only `canOwnGames`)',
    !/\buser\b\s*[,:;)]/.test(list.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  const userGates = list.match(/\{!?user\b[^}]*(?:&&|\?)/g) ?? [];
  check(`SavedGamesList has no user-keyed gate (found ${userGates.length})`, userGates.length === 0);
  check('SavedGamesList gates the not-owner state on canOwnGames',
    /if \(!canOwnGames\) \{/.test(list));
  check('SavedGamesList gates the empty (owner, no games) state on games.length === 0',
    /if \(games\.length === 0\) \{/.test(list));

  const drawer = readFileSync('src/components/MenuDrawer.tsx', 'utf8');
  const lo = drawer.indexOf('Custom User Profiles (');
  const hi = drawer.indexOf('TAB 3: ACCOUNT');
  check('MenuDrawer: the Library tab region is found', lo > 0 && hi > lo);
  const region = drawer.slice(lo - 400, hi);
  const drawerUserGates = region.match(/\{!?user\b[^}]*(?:&&|\?)/g) ?? [];
  check(`MenuDrawer Library tab has no user-keyed gate on the saved-games list (found ${drawerUserGates.length}: ${drawerUserGates.join(' | ').slice(0, 120)})`, drawerUserGates.length === 0);
  check('MenuDrawer renders the shared SavedGamesList, not an inline list',
    /<SavedGamesList\b/.test(region) && !/data-drawer-game/.test(region));
  check('MenuDrawer passes canOwnGames straight through to SavedGamesList',
    /<SavedGamesList[\s\S]{0,300}canOwnGames=\{canOwnGames\}/.test(region));
  check('App passes canOwnGames to MenuDrawer', /<MenuDrawer[\s\S]{0,400}canOwnGames=\{canOwnGames\}/.test(readFileSync('src/App.tsx', 'utf8')));
  const app = readFileSync('src/App.tsx', 'utf8');
  check('App passes canOwnGames to its own SavedGamesList (sidebar)',
    /<SavedGamesList[\s\S]{0,400}canOwnGames=\{canOwnGames\}/.test(app));
}

// MUTATION FIXTURE — the REAL predicates above (not a reimplementation of
// them) run against realistic regressions. OPUS-REVIEW-LIST F2 on #150: the
// previous fixture applied `/\buser\b/g` to `'if (!user) {'` — a regex
// neither real check above uses. The real JSX-gate regex requires `{`
// immediately before `!user`, which `if (!user) {` does not have (that `(`
// is not `{`), so the old fixture could not have caught what it claimed to.
{
  // (a) The JSX-gate regex line 129 actually uses, run against the DRAWER
  // region's historical shape (a regression back to `{!user && (...)}`).
  const jsxGateRegex = /\{!?user\b[^}]*(?:&&|\?)/;
  const regressedDrawerRegion = 'Custom User Profiles ({n})\n{!user && (\n  <span>Log in to persist</span>\n)}\n<SavedGamesList canOwnGames={canOwnGames} />';
  check('fixture sanity: the REAL JSX-gate regex (line 129) flags a regressed {!user && ...} block',
    jsxGateRegex.test(regressedDrawerRegion));
  const currentDrawer = readFileSync('src/components/MenuDrawer.tsx', 'utf8');
  const currentLo = currentDrawer.indexOf('Custom User Profiles (');
  const currentHi = currentDrawer.indexOf('TAB 3: ACCOUNT');
  const currentRegion = currentDrawer.slice(currentLo - 400, currentHi);
  check('fixture precondition: the CURRENT drawer region does not already trip the same regex', !jsxGateRegex.test(currentRegion));

  // (b) The if-statement gate regex line 131 actually uses, run against a
  // regressed SavedGamesList body where `canOwnGames` was replaced by
  // `user` — the positive check must go from true to FALSE, exactly what a
  // revert-the-fix mutation test demands.
  const regressedIfGate = 'if (!user) {\n  return null;\n}';
  check('fixture sanity: the REAL "gates on canOwnGames" check (line 131) goes FALSE against a regressed if (!user) body',
    !/if \(!canOwnGames\) \{/.test(regressedIfGate));
}

// RED-DESKTOP-15/001: the Save/Edit error banners decided "does this failure
// need a sign-in" by asking `!authToken`/`authToken ?` — a boolean that is
// STRUCTURALLY always false for a local owner (no account at all), so it
// mislabeled every non-auth failure (network drop, blank name, 404, 409) as
// "please sign in". The fix reads a per-error flag (`saveErrorNeedsAuth` /
// `editErrorNeedsAuth`) set only where the failure is actually auth-shaped.
// This guards the predicate never regresses back to the raw token read in a
// render/copy decision. `authToken ?` is allow-listed for exactly one line
// — `authHeaders`, which builds an HTTP header, not a UI decision.
//
// OPUS-REVIEW-DESKTOP F1 (2026-09-06): the first version of this guard read
// two hard-coded files line-by-line, so it could not see (a) the SAME
// ternary split across lines (what a formatter produces for a long JSX
// ternary), (b) the `&&`-gate form of the identical decision, or (c) the
// predicate reappearing in ANY OTHER component (SavedGamesList.tsx, or a
// future extraction) — a real risk given round 15/16's ModalSurface/
// SavedGamesList extraction work. Rewritten to scan every `src/**/*.tsx`
// file on whitespace-NORMALIZED text (so a multi-line ternary reads the same
// as a one-liner) for both the `? (`/`? <` and `&& (`/`&& <` shapes — the
// shape this codebase actually authors a JSX consequent in (never `? {`,
// which is what excludes `authHeaders` structurally, on top of the explicit
// allow-list kept for defense in depth).
function findTsxFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true } as any)
    .map((f) => String(f))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `${dir}/${f}`);
}

function authTokenRenderViolations(files: string[], allowListed: RegExp[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // Collapse ALL whitespace (including newlines) to one space: a ternary or
    // &&-chain split across lines by a formatter reads identically to a
    // one-liner, so the multi-line escape shape (OPUS F1a) is not a distinct
    // case to detect — it is the SAME regex match.
    const norm = src.replace(/\s+/g, ' ');
    // Ternary: `!?authToken ? (` or `!?authToken ? <` — excludes `? {`, the
    // authHeaders shape (an object literal, never a JSX/UI branch), and `?.`
    // (optional chaining) since `.` is neither `(` nor `<`.
    // &&-gate: `!?authToken && (` or `!?authToken && <` — excludes a plain
    // boolean combination like `(authToken && user) || localOwnerMode`
    // (App.tsx's own refetch-gating effect), where nothing JSX-shaped
    // immediately follows the `&&`.
    // CodeRabbit CLI: also matches the PARENTHESIZED forms, `(!authToken) ?`
    // / `(authToken) &&` — the bare alternative alone missed these. The
    // parenthesized alternative requires authToken's OWN closing `)`
    // immediately after (only whitespace between), which is why
    // `(authToken && user)` still does not match it (the `)` there closes
    // over `&& user`, not authToken alone).
    // CodeRabbit CLI: also matches a CHAINED &&-gate where a plain
    // identifier sits between authToken and the JSX, e.g.
    // `!authToken && saveError && (<Invite/>)` — the bare form alone
    // required the JSX immediately after authToken's OWN `&&`. Each extra
    // link must itself be a bare identifier (`[A-Za-z_$][\w$.]*`, optionally
    // negated) followed by `&&`, which is why the control effect-gate
    // (`(authToken && user) || localOwnerMode`) still does not match: `user`
    // is followed by `)`, never another `&&`, so the chain cannot close.
    const pattern = /(?<!\w)(?:!?authToken|\(\s*!?authToken\s*\))\s*(?:\?\s*[(<]|&&(?:\s*!?[A-Za-z_$][\w$.]*\s*&&)*\s*[(<])/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(norm))) {
      const context = norm.slice(Math.max(0, m.index - 60), m.index);
      if (allowListed.some((re) => re.test(context))) continue;
      violations.push(`${file}: …${norm.slice(Math.max(0, m.index - 20), m.index + 30)}…`);
    }
  }
  return violations;
}

{
  const app = readFileSync('src/App.tsx', 'utf8');
  const tsxFiles = findTsxFiles('src');
  check('src scan includes App.tsx, MenuDrawer.tsx and SavedGamesList.tsx (sanity: the scan reaches the files that matter)',
    tsxFiles.some((f) => f.endsWith('App.tsx')) && tsxFiles.some((f) => f.endsWith('MenuDrawer.tsx'))
    && tsxFiles.some((f) => f.endsWith('SavedGamesList.tsx')));
  // The ONE legitimate `authToken ?` ternary: it returns an HTTP header
  // object (`Authorization: Bearer ...`), never JSX, never a copy decision.
  // CodeRabbit CLI: the bare `authHeaders\s*=` context check could suppress
  // a REAL defect if unrelated text happened to mention "authHeaders" within
  // the window — tied to the exact declaration signature instead (nothing
  // else in this codebase reads `(): Record<string, string> =>`), and the
  // window (60 chars) is sized to the real line's own length, not padded
  // further for slack.
  const ALLOW = [/authHeaders\s*=\s*\(\):\s*Record<string,\s*string>\s*=>/];

  const violations = authTokenRenderViolations(tsxFiles, ALLOW);
  check(`no authToken-ternary/&& render or copy branch anywhere under src/**/*.tsx (found ${violations.length}: ${violations.join(' | ').slice(0, 300)})`,
    violations.length === 0);

  // The two fixed sites read the per-error flag (OR'd with `deadSession`
  // since OPUS-REVIEW-DESKTOP17 F1 — the banner must persist across a
  // dialog close+reopen, which clears `saveError`/`editError` but not
  // `deadSession`). CodeRabbit CLI: `\s*` (not a literal space) so a
  // formatter's line break between the flag and `?` still passes.
  check('Save dialog error render gates on deadSession === \'save\' OR saveErrorNeedsAuth',
    /\(deadSession === 'save' \|\| saveErrorNeedsAuth\)\s*\?\s*\(/.test(app));
  check('Edit dialog error render gates on deadSession === \'edit\' OR editErrorNeedsAuth',
    /\(deadSession === 'edit' \|\| editErrorNeedsAuth\)\s*\?\s*\(/.test(app));

  // CodeRabbit on #158 (outside-diff, 73e5fba): `if (!editGameId ||
  // !canOwnGames) return;` was a SILENT no-op if the token died while the
  // Edit dialog stayed open — resubmitting did nothing, no banner. The
  // handler's own `!canOwnGames` branch must set BOTH the message and the
  // flag, same as handleSaveGameSubmit's preflight.
  {
    const editFnStart = app.indexOf('const handleEditGameSubmit');
    // 1100, not 700: RED-DESKTOP-17/002 and OPUS-REVIEW-DESKTOP17 F1 each
    // added a needs-auth gate/comment ahead of this block, pushing
    // !canOwnGames further into the function body.
    const editFnSlice = app.slice(editFnStart, editFnStart + 1100);
    check("handleEditGameSubmit's own !canOwnGames branch sets both editError and editErrorNeedsAuth(true), not a silent return",
      /if \(!canOwnGames\) \{[^}]*setEditError\([^}]*setEditErrorNeedsAuth\(true\)/.test(editFnSlice),
      editFnSlice.replace(/\s+/g, ' ').slice(0, 160));
  }

  // CodeRabbit on #158 (outside-diff, 9a71dce): a late response from a
  // PREVIOUS dialog session (submitted, closed, reopened) used to paint its
  // error/needsAuth/loading into the NEW session — a stale 401 could show a
  // sign-in invitation over an unrelated dialog. Both handlers must check
  // staleness right after the response arrives (before ANY branch touches
  // state), in the catch, AND in finally (which runs on every path,
  // including the early return) — checking only one of the three would
  // still let a stale response through the other two.
  // CodeRabbit CLI: the anchored regexes above prove the guard is PRESENT
  // near the response, but not that it comes BEFORE every state setter — a
  // mutation that inserted `setEditError(...)` between the response and the
  // guard could still satisfy a "guard found within N chars" regex. This
  // walks the actual text between the response and the guard and requires
  // it contain NONE of the setters the guard exists to protect.
  function guardPrecedesSetters(slice: string, anchor: string, guardTail: string, setterNames: string[]): { ok: boolean; between: string } {
    const anchorIdx = slice.indexOf(anchor);
    if (anchorIdx < 0) return { ok: false, between: '(anchor not found)' };
    const guardIdx = slice.indexOf(guardTail, anchorIdx);
    if (guardIdx < 0) return { ok: false, between: '(guard not found)' };
    const between = slice.slice(anchorIdx + anchor.length, guardIdx);
    const leaked = setterNames.filter((name) => between.includes(`${name}(`));
    return { ok: leaked.length === 0, between: leaked.join(',') || between.replace(/\s+/g, ' ').slice(0, 80) };
  }

  {
    const editSlice = app.slice(app.indexOf('const handleEditGameSubmit'), app.indexOf('const handleDeleteGame'));
    const saveSlice = app.slice(app.indexOf('const handleSaveGameSubmit'), app.indexOf('const handleRegenerateScenario'));
    check('handleEditGameSubmit checks staleness (editSessionRef) immediately after the response, before any branch',
      /const data = await res\.json\(\);[\s\S]{0,200}staleSession = editSessionRef\.current !== editSessionAtSubmit;[\s\S]{0,10}if \(staleSession\) return;/.test(editSlice));
    check('handleEditGameSubmit checks staleness in its catch block too',
      /catch \{[\s\S]{0,200}staleSession = editSessionRef\.current !== editSessionAtSubmit;[\s\S]{0,10}if \(staleSession\) return;/.test(editSlice));
    check('handleEditGameSubmit guards setEditLoading(false) in finally with the SAME flag (not re-derived, which the success branch\'s own session bump would flip)',
      /finally \{[\s\S]{0,50}if \(!staleSession\) setEditLoading\(false\);/.test(editSlice));
    check('handleSaveGameSubmit checks staleness (saveRequestIdRef vs clientRequestId) immediately after the response, before any branch',
      /const data = await res\.json\(\);[\s\S]{0,200}staleSession = saveRequestIdRef\.current !== clientRequestId;[\s\S]{0,10}if \(staleSession\) return;/.test(saveSlice));
    check('handleSaveGameSubmit checks staleness in its catch block too',
      /catch \(err\) \{[\s\S]{0,200}staleSession = saveRequestIdRef\.current !== clientRequestId;[\s\S]{0,10}if \(staleSession\) return;/.test(saveSlice));
    check('handleSaveGameSubmit guards setSaveLoading(false) in finally with the SAME flag',
      /finally \{[\s\S]{0,50}if \(!staleSession\) setSaveLoading\(false\);/.test(saveSlice));

    // The guard must precede every setter it exists to protect — no setter
    // sneaks in between the response and the `if (staleSession) return;`.
    const editGate = guardPrecedesSetters(editSlice, 'const data = await res.json();', 'if (staleSession) return;',
      ['setEditError', 'setEditErrorNeedsAuth', 'setEditLoading', 'setUserCustomGames']);
    check(`handleEditGameSubmit: no setter runs between the response and its staleness guard (found: ${editGate.between})`, editGate.ok);
    const saveGate = guardPrecedesSetters(saveSlice, 'const data = await res.json();', 'if (staleSession) return;',
      ['setSaveError', 'setSaveErrorNeedsAuth', 'setSaveLoading', 'setUserCustomGames']);
    check(`handleSaveGameSubmit: no setter runs between the response and its staleness guard (found: ${saveGate.between})`, saveGate.ok);

    // Known-positive fixtures: a setter inserted BEFORE the guard (the exact
    // regression the anchored regexes above cannot see on their own) MUST be
    // caught by `guardPrecedesSetters`.
    const regressedOrder = 'const data = await res.json();\nsetEditError(data.error || \'x\');\nstaleSession = editSessionRef.current !== editSessionAtSubmit;\nif (staleSession) return;';
    const regressedGate = guardPrecedesSetters(regressedOrder, 'const data = await res.json();', 'if (staleSession) return;', ['setEditError']);
    check('fixture sanity: guardPrecedesSetters catches a setter placed BEFORE the staleness guard', !regressedGate.ok);
  }

  // Director-verified regression on f3ca711: since `finally` now SKIPS
  // setEditLoading/setSaveLoading(false) for a stale session (the point of
  // the guard above), a request left in flight when its dialog closed left
  // the flag stuck true FOREVER — nothing else ever cleared it, so the
  // NEXT session's submit button stayed disabled ("Saving..."/"Saving
  // Changes..." forever). A session's loading flag belongs to the session:
  // it must be reset wherever that session STARTS.
  {
    // Edit: the ONE choke point every open/close/game-switch already passes
    // through (not each of the several setIsEditModalOpen(true) call sites).
    const editSessionEffect = app.slice(app.indexOf('const editSessionRef = useRef(0);'), app.indexOf('const editSessionRef = useRef(0);') + 800);
    check('the editSessionRef bump effect also resets editLoading (one choke point covers every open/close/game-switch)',
      /useEffect\(\(\) => \{ editSessionRef\.current \+= 1; setEditLoading\(false\); \}, \[isEditModalOpen, editGameId\]\);/.test(editSessionEffect));

    // Save has no single choke point (saveRequestIdRef is reset by hand at
    // each fresh-open site) — classify each `saveRequestIdRef.current =
    // null;` occurrence as an OPEN site (immediately followed by
    // setIsSaveModalOpen(true)) or the success-branch reset (is not), and
    // require every OPEN site — and only those — to also reset saveLoading.
    // CodeRabbit CLI: the original 400-char window accepted `setSaveLoading
    // (false);` ANYWHERE in the window — even after the open call, or from
    // an unrelated later statement. Tightened to the ordered shape every
    // real site actually has: find the SPECIFIC `setIsSaveModalOpen(true);`
    // this reset leads into, and require the loading reset strictly BETWEEN
    // the two (proving it belongs to THIS site, in the right order).
    function classifySaveResetSites(src: string): Array<{ isOpenSite: boolean; hasLoadingReset: boolean }> {
      const re = /saveRequestIdRef\.current = null;/g;
      const sites: Array<{ isOpenSite: boolean; hasLoadingReset: boolean }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const resetEnd = m.index + m[0].length;
        const openIdx = src.indexOf('setIsSaveModalOpen(true);', resetEnd);
        const isOpenSite = openIdx >= 0 && openIdx - resetEnd < 400;
        const between = isOpenSite ? src.slice(resetEnd, openIdx) : '';
        sites.push({ isOpenSite, hasLoadingReset: isOpenSite && /setSaveLoading\(false\);/.test(between) });
      }
      return sites;
    }
    const saveSites = classifySaveResetSites(app);
    const openSites = saveSites.filter((s) => s.isOpenSite);
    check(`exactly 2 save-dialog fresh-open sites are found (a resolver drift would silently stop checking a real site) — found ${openSites.length}`,
      openSites.length === 2);
    check('every save-dialog fresh-open site also resets saveLoading', openSites.every((s) => s.hasLoadingReset));
    // The success-branch reset (not an open site) needs no such check — its
    // OWN request's finally already clears saveLoading for the still-current session.
    check('precondition: the success-branch reset is correctly classified as NOT an open site (so it is not required to reset loading here)',
      saveSites.some((s) => !s.isOpenSite));

    // Known-positive fixture: an open site WITHOUT the loading reset (the
    // exact pre-fix shape) must be classified as missing it.
    const regressedOpenSite = 'saveRequestIdRef.current = null;\nsetIsSaveModalOpen(true);';
    const regressed = classifySaveResetSites(regressedOpenSite)[0];
    check('fixture sanity: an open site missing setSaveLoading(false) is correctly flagged', regressed.isOpenSite && !regressed.hasLoadingReset);
  }

  // OPUS-REVIEW-DESKTOP N5: a bare COUNT comparison passes if an unpaired
  // non-empty setter is added anywhere and an extra flag call is added
  // anywhere else, and misreads `setSaveError("")` (double quotes) or a
  // setter broken across a line as "non-empty". This instead PAIRS each
  // real (non-empty) call with a flag call inside its own statement — found
  // by balancing parens from the setter's `(` to its OWN closing `)`, then
  // requiring the flag setter within a short window after that close, which
  // is where every real call site puts it (see handleSaveGameSubmit /
  // handleEditGameSubmit) even when the message itself spans many lines
  // (the 409 branch's nested ternary).
  function pairedNonEmptySetters(src: string, setter: string, flag: string): string[] {
    const unpaired: string[] = [];
    const re = new RegExp(`${setter}\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const start = m.index + m[0].length;
      // A pure reset — setSaveError('') or setSaveError("") — is not a real
      // message and needs no flag.
      if (/^\s*(['"])\1\s*\)/.test(src.slice(start, start + 12))) continue;
      let depth = 1;
      let i = start;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      // CodeRabbit CLI: require the flag call IMMEDIATELY after this setter's
      // own closing paren (only a `;` and whitespace between) — not merely
      // somewhere within a window, which could be satisfied by an unrelated
      // LATER setter's flag call and let a genuinely unpaired setter through.
      const after = src.slice(i);
      if (!new RegExp(`^\\s*;?\\s*${flag}\\(`).test(after)) {
        unpaired.push(src.slice(m.index, Math.min(i, m.index + 80)).replace(/\s+/g, ' '));
      }
    }
    return unpaired;
  }
  const unpairedSave = pairedNonEmptySetters(app, 'setSaveError', 'setSaveErrorNeedsAuth');
  check(`every non-empty setSaveError call sets saveErrorNeedsAuth in its own statement (found ${unpairedSave.length} unpaired: ${unpairedSave.join(' | ').slice(0, 200)})`,
    unpairedSave.length === 0);
  const unpairedEdit = pairedNonEmptySetters(app, 'setEditError', 'setEditErrorNeedsAuth');
  check(`every non-empty setEditError call sets editErrorNeedsAuth in its own statement (found ${unpairedEdit.length} unpaired: ${unpairedEdit.join(' | ').slice(0, 200)})`,
    unpairedEdit.length === 0);

  // Known-positive fixtures: each escape shape F1 named MUST trip the check.
  // `authTokenRenderViolations` reads FILES; `violationsInText` drives the
  // SAME regex and allow-list directly, on an in-memory string, so a fixture
  // never touches disk while staying in lockstep with the real detector.
  const multilineTernary = '{saveError && (\n  !authToken\n    ? (\n      <div>Sign In / Sign Up</div>\n    )\n    : (\n      <p>{saveError}</p>\n    )\n)}';
  function violationsInText(text: string, allowListed: RegExp[]): string[] {
    const norm = text.replace(/\s+/g, ' ');
    const pattern = /(?<!\w)(?:!?authToken|\(\s*!?authToken\s*\))\s*(?:\?\s*[(<]|&&(?:\s*!?[A-Za-z_$][\w$.]*\s*&&)*\s*[(<])/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(norm))) {
      const context = norm.slice(Math.max(0, m.index - 60), m.index);
      if (allowListed.some((re) => re.test(context))) continue;
      out.push(norm.slice(m.index, m.index + 30));
    }
    return out;
  }
  check('fixture (a) multi-line ternary is flagged (OPUS F1a)',
    violationsInText(multilineTernary, ALLOW).length > 0);
  // (b) The `&&`-gate form of the identical decision.
  const andGate = '{saveError && !authToken && (\n  <div>Sign In / Sign Up</div>\n)}';
  check('fixture (b) &&-gate form is flagged (OPUS F1b)',
    violationsInText(andGate, ALLOW).length > 0);
  // CodeRabbit CLI: the PARENTHESIZED forms of both shapes.
  check('fixture: parenthesized ternary `(!authToken) ? (` is flagged',
    violationsInText('{saveError && (\n  (!authToken) ? (\n    <div>Sign In / Sign Up</div>\n  ) : null\n)}', ALLOW).length > 0);
  check('fixture: parenthesized &&-gate `(authToken) && (` is flagged',
    violationsInText('{saveError && (authToken) && (\n  <div>Sign In / Sign Up</div>\n)}', ALLOW).length > 0);
  // Control: the parenthesized alternative must not misfire on the
  // legitimate effect-gating `(authToken && user)` — its own closing paren
  // does not sit immediately after `authToken`.
  check('control: `(authToken && user) || localOwnerMode` still is not flagged with the parenthesized alternative added',
    violationsInText('if ((authToken && user) || localOwnerMode) {', ALLOW).length === 0);
  // CodeRabbit CLI: a CHAINED &&-gate — an unrelated identifier between
  // authToken and the JSX, not the JSX immediately after authToken's own &&.
  check('fixture: chained &&-gate `!authToken && saveError && (` is flagged',
    violationsInText('{!authToken && saveError && (\n  <div>Sign In / Sign Up</div>\n)}', ALLOW).length > 0);
  // Control: the chain-link grammar (a bare identifier + &&) must not let
  // the effect-gate's own `user` link the chain to something JSX-shaped
  // further away — there is nothing further away here, so this stays a
  // sanity re-check rather than a new distinct shape.
  check('control: the effect-gate is still unflagged with the chained-&& extension',
    violationsInText('if ((authToken && user) || localOwnerMode) {', ALLOW).length === 0);
  // (c) The predicate reappearing in a DIFFERENT component the old two-file
  // guard never read — SavedGamesList.tsx's real "not signed in" branch,
  // mutated exactly the way F1's own demonstration did (canOwnGames swapped
  // for the raw token), scanned through the SAME multi-file `findTsxFiles`
  // path (not a hand-picked file) to prove the scan itself reaches it.
  const savedGamesListSrc = readFileSync('src/components/SavedGamesList.tsx', 'utf8');
  const regressedSavedGamesList = savedGamesListSrc.replace('if (!canOwnGames) {',
    'if (!authToken) {\n  return (\n    <span>{!authToken ? (\n      <em>Sign In / Sign Up</em>\n    ) : null}</span>\n  );\n}\nif (!canOwnGames) {');
  check('precondition: the REAL SavedGamesList.tsx is clean before mutation', violationsInText(savedGamesListSrc, ALLOW).length === 0);
  check('fixture (c) the predicate in a DIFFERENT component (SavedGamesList-shaped) is flagged (OPUS F1c)',
    violationsInText(regressedSavedGamesList, ALLOW).length > 0);

  // Control: the header-builder line alone must NOT trip it (object-literal
  // consequent `{`, not `(`/`<`, PLUS the explicit allow-list).
  const headerOnly = "const authHeaders = (): Record<string, string> => (authToken ? { 'Authorization': `Bearer ${authToken}` } : {});";
  check('control: the authHeaders line alone is not flagged', violationsInText(headerOnly, ALLOW).length === 0);
  // CodeRabbit CLI: an unrelated REAL defect elsewhere in the same file must
  // still be flagged — the authHeaders declaration's presence earlier in the
  // text must not leak an allow-list past its own statement.
  const headerFollowedByRealDefect = `${headerOnly}\n// unrelated code between the two statements\nfunction Foo() {\n  return (\n    <div>{saveError && (\n      !authToken ? (\n        <span>Sign In / Sign Up</span>\n      ) : null\n    )}</div>\n  );\n}`;
  check('control: a genuine defect elsewhere in the file is still flagged despite an earlier, unrelated authHeaders declaration',
    violationsInText(headerFollowedByRealDefect, ALLOW).length > 0);
  // Control: the legitimate effect-gating `&&` (App.tsx's own refetch guard)
  // must NOT trip the &&-shape detector — its consequent is `user`, not a
  // JSX/parenthesized expression.
  check('control: `(authToken && user) || localOwnerMode` (App.tsx\'s own effect) is not flagged',
    violationsInText('if ((authToken && user) || localOwnerMode) {', ALLOW).length === 0);
}

// OPUS-REVIEW-DESKTOP16 N3: all FOUR client call sites for the game routes
// (GET refetchUserGames, POST/PATCH/DELETE handlers) must route their 401
// through the ONE shared `handleDeadSessionResponse` helper, not a separate
// inline `res.status === 401` check each — the GET site originally had NO
// check at all (a dead token left the list stale and the header lying until
// the next write). Each site is sliced out of App.tsx by its own stable
// start/end markers (the same markers the staleness-guard checks above
// already use for the Save/Edit handlers) and scanned independently, so a
// regression in ONE site is named, not just "something in App.tsx broke".
{
  const app = readFileSync('src/App.tsx', 'utf8');
  const idx = (marker: string): number => {
    const i = app.indexOf(marker);
    if (i < 0) throw new Error(`marker not found: ${marker}`);
    return i;
  };
  const FOUR_SITES: Array<[string, string, string]> = [
    ['GET /api/games (refetchUserGames)', 'const refetchUserGames = useCallback',
      '}, [authToken, apiBaseUrl, dbMode, canOwnGames]);'],
    ['POST /api/games (handleSaveGameSubmit)', 'const handleSaveGameSubmit = async', 'const handleRegenerateScenario = async'],
    ['PATCH /api/games/:id (handleEditGameSubmit)', 'const handleEditGameSubmit = async', 'const handleDeleteGame = async'],
    ['DELETE /api/games/:id (handleDeleteGame)', 'const handleDeleteGame = async', 'const handleGenerateGame = async'],
  ];
  for (const [name, startMarker, endMarker] of FOUR_SITES) {
    const slice = app.slice(idx(startMarker), idx(endMarker));
    check(`${name} routes its 401 through handleDeadSessionResponse`,
      /handleDeadSessionResponse\(res/.test(slice));
    // A site that checks `res.status === 401` DIRECTLY, bypassing the
    // helper, is exactly the pre-fix shape (three independent inline copies
    // plus one site with no check at all) — must not reappear in any of the
    // four slices.
    check(`${name} has no bypassing inline \`res.status === 401\` check`,
      !/res\.status === 401/.test(slice));
    // CodeRabbit on #163 (src/App.tsx:466): a response for a request sent
    // under an OLD token must not clear a CURRENT, different one committed
    // while that request was still in flight — so the helper takes the
    // token THIS request actually used, captured BEFORE the fetch, not
    // whatever is current by the time the response lands. Each site must
    // (a) capture it and (b) pass EXACTLY that captured identifier as the
    // second argument — passing `null` or re-reading the CURRENT token at
    // call time (`authTokenRef.current`, or the outer `authToken` read
    // AFTER a later `await`) would make the ref-comparison inside the
    // helper trivially always-true again, silently reintroducing the exact
    // race CodeRabbit found under a different spelling.
    check(`${name} captures its own requestToken before the fetch`,
      /const requestToken = authToken;/.test(slice));
    check(`${name} passes its captured requestToken (not null, not a re-read of the current token) to the helper`,
      /handleDeadSessionResponse\(res, requestToken\)/.test(slice));
  }

  // Known-positive (the mutation OPUS-REVIEW-DESKTOP16 N3 names by example):
  // revert the GET site to its pre-fix shape (no dead-session check at all)
  // and confirm the FIRST check above fails BY NAME for that site only.
  const regressedRefetch = "const refetchUserGames = useCallback(async () => {\n"
    + "  const res = await fetch(getApiUrl('/api/games'), { headers: authHeaders() });\n"
    + "  if (!res.ok) return undefined;\n"
    + "  const rows = await res.json();\n"
    + "  setUserCustomGames(rows);\n"
    + "  return rows;\n"
    + "}, [authToken, apiBaseUrl, dbMode, canOwnGames]);";
  check('fixture: the pre-fix GET site (no dead-session check) fails the routing check',
    !/handleDeadSessionResponse\(res/.test(regressedRefetch));
  // And a regression back to the OLD inline three-copies shape (still bypassing
  // the helper) must be flagged by the second check.
  const regressedInline = "const wasAuthFailure = res.status === 401;\nif (wasAuthFailure) updateAuthToken(null);";
  check('fixture: the pre-fix inline `res.status === 401` shape is flagged by the bypass check',
    /res\.status === 401/.test(regressedInline));

  // CodeRabbit's own named mutations: passing `null`, or re-reading the
  // CURRENT token instead of the captured snapshot, at the helper call site.
  const passedNull = "const requestToken = authToken;\n"
    + "const res = await fetch(getApiUrl('/api/games'), { headers: authHeaders() });\n"
    + "handleDeadSessionResponse(res, null);";
  check('fixture: passing `null` as the second argument fails the requestToken-passing check',
    !/handleDeadSessionResponse\(res, requestToken\)/.test(passedNull));
  const passedCurrentTokenRef = "const requestToken = authToken;\n"
    + "const res = await fetch(getApiUrl('/api/games'), { headers: authHeaders() });\n"
    + "handleDeadSessionResponse(res, authTokenRef.current);";
  check('fixture: passing `authTokenRef.current` (re-reading the CURRENT token, not the captured one) fails the requestToken-passing check',
    !/handleDeadSessionResponse\(res, requestToken\)/.test(passedCurrentTokenRef));
  // Control: the correct shape (capture, then pass that exact identifier) passes both.
  const correctShape = "const requestToken = authToken;\n"
    + "const res = await fetch(getApiUrl('/api/games'), { headers: authHeaders() });\n"
    + "handleDeadSessionResponse(res, requestToken);";
  check('control: the correct capture-then-pass shape is not flagged',
    /const requestToken = authToken;/.test(correctShape) && /handleDeadSessionResponse\(res, requestToken\)/.test(correctShape));
}

// CodeRabbit on #163 (delayed-401 regression, unit-level on the helper
// itself): a 401 with a STALE requestToken (does not match what is
// currently committed) must NOT clear the current token; a 401 with the
// MATCHING token must. The four call-site checks above only pin that each
// site passes its OWN captured token through — they say nothing about
// whether `handleDeadSessionResponse`'s own comparison is correct. Pinned
// two ways: (1) an exact-text pin on the helper's own conditional (a
// mutation to the comparison, e.g. dropping the ref check or comparing the
// wrong things, fails this immediately); (2) a hand-run case matrix against
// a reimplementation of that SAME pinned line — its realism is guaranteed
// by (1) passing, not by itself (this file cannot import App.tsx's
// component internals to call the real closure directly).
{
  const app = readFileSync('src/App.tsx', 'utf8');
  const fnStart = app.indexOf('const handleDeadSessionResponse = (res: Response, requestToken');
  check('handleDeadSessionResponse is defined with the (res, requestToken) signature', fnStart >= 0);
  const fnSrc = app.slice(fnStart, app.indexOf('};', fnStart) + 2);
  check('handleDeadSessionResponse only clears the token when authTokenRef.current === requestToken',
    /if \(wasAuthFailure && authTokenRef\.current === requestToken\) updateAuthToken\(null\);/.test(fnSrc));
  check('handleDeadSessionResponse still reports wasAuthFailure from the RAW response status, regardless of the ref match',
    /const wasAuthFailure = res\.status === 401;/.test(fnSrc));

  // Known-positive: the exact CodeRabbit-named regression (unconditional
  // clear, ignoring which token the response belongs to) must fail the pin.
  const regressedUnconditional = 'const handleDeadSessionResponse = (res, requestToken) => {\n'
    + '  const wasAuthFailure = res.status === 401;\n'
    + '  if (wasAuthFailure) updateAuthToken(null);\n'
    + '  return wasAuthFailure;\n};';
  check('fixture: an unconditional clear (the pre-fix / CodeRabbit-found shape) fails the ref-match pin',
    !/if \(wasAuthFailure && authTokenRef\.current === requestToken\) updateAuthToken\(null\);/.test(regressedUnconditional));

  // Delayed-401 case matrix, gated by the exact-text pin above.
  type Case = { name: string; committedToken: string | null; requestToken: string | null; status: number; expectCleared: boolean; expectAuthFailure: boolean };
  const cases: Case[] = [
    { name: 'matching token, 401 -> clears', committedToken: 'tok-A', requestToken: 'tok-A', status: 401, expectCleared: true, expectAuthFailure: true },
    { name: 'STALE token (delayed response after re-auth), 401 -> does NOT clear the current one', committedToken: 'tok-B', requestToken: 'tok-A', status: 401, expectCleared: false, expectAuthFailure: true },
    { name: 'request sent with no token, committed also none, 401 -> clears (both null, matches)', committedToken: null, requestToken: null, status: 401, expectCleared: true, expectAuthFailure: true },
    { name: 'request sent with no token but a token was since committed, 401 -> does NOT clear it', committedToken: 'tok-B', requestToken: null, status: 401, expectCleared: false, expectAuthFailure: true },
    { name: 'matching token, 200 -> no clear, not an auth failure', committedToken: 'tok-A', requestToken: 'tok-A', status: 200, expectCleared: false, expectAuthFailure: false },
    { name: 'stale token, 200 -> no clear, not an auth failure', committedToken: 'tok-B', requestToken: 'tok-A', status: 200, expectCleared: false, expectAuthFailure: false },
  ];
  for (const c of cases) {
    let cleared = false;
    const authTokenRefSim = { current: c.committedToken };
    const updateAuthTokenSim = (t: string | null) => { cleared = t === null ? true : cleared; };
    // The SAME pinned line, executed:
    const wasAuthFailure = c.status === 401;
    if (wasAuthFailure && authTokenRefSim.current === c.requestToken) updateAuthTokenSim(null);
    check(`delayed-401 fixture: ${c.name}`,
      cleared === c.expectCleared && wasAuthFailure === c.expectAuthFailure,
      `cleared=${cleared} (want ${c.expectCleared}), wasAuthFailure=${wasAuthFailure} (want ${c.expectAuthFailure})`);
  }
}

// RED-DESKTOP-17/002: a SECOND click of the SAME still-enabled submit
// button, after THIS dialog's own banner already shows the sign-in
// invitation (a real 401 cleared the token), used to resubmit as the local
// owner — `canOwnGames` alone doesn't catch it, because a dead token flips
// `localOwnerMode` true on desktop. Every submit handler must consult its
// own needs-auth flag BEFORE the fetch, through the ONE shared helper
// (`beginNeedsAuthSignIn`) — never a per-button/per-dialog duplicate. Sliced
// by the SAME stable markers the 401-routing block above already uses, so a
// regression in either dialog is named, not just "something in App.tsx
// broke".
{
  const app = readFileSync('src/App.tsx', 'utf8');
  const editSlice = app.slice(app.indexOf('const handleEditGameSubmit'), app.indexOf('const handleDeleteGame'));
  const saveSlice = app.slice(app.indexOf('const handleSaveGameSubmit'), app.indexOf('const handleRegenerateScenario'));
  // OPUS-REVIEW-DESKTOP17 F1: the gate reads `deadSession`, not the
  // resettable `saveError && saveErrorNeedsAuth` / `editError &&
  // editErrorNeedsAuth` pair (that pair is reset by validation branches
  // below the gate — exactly the hole F1 closed).
  const editGatePattern = /if \(deadSession === 'edit'\) \{ beginNeedsAuthSignIn\('edit'\); return; \}/;
  const saveGatePattern = /if \(!localConfirmed && deadSession === 'save'\) \{ beginNeedsAuthSignIn\('save'\); return; \}/;

  // Order matters, not just presence: a gate present but placed AFTER the
  // fetch it exists to prevent would satisfy a naive substring check while
  // protecting nothing.
  function gatePrecedesFetch(slice: string, gatePattern: RegExp): { ok: boolean; detail: string } {
    const gateIdx = slice.search(gatePattern);
    const fetchIdx = slice.indexOf('await fetch(');
    if (gateIdx === -1) return { ok: false, detail: 'gate not found' };
    if (fetchIdx === -1) return { ok: false, detail: 'fetch not found' };
    return { ok: gateIdx < fetchIdx, detail: `gate@${gateIdx} fetch@${fetchIdx}` };
  }

  const editGate = gatePrecedesFetch(editSlice, editGatePattern);
  check(`handleEditGameSubmit consults its needs-auth gate before the fetch (${editGate.detail})`, editGate.ok);
  const saveGate = gatePrecedesFetch(saveSlice, saveGatePattern);
  check(`handleSaveGameSubmit consults its needs-auth gate before the fetch (${saveGate.detail})`, saveGate.ok);

  // Both dialogs must route through the SAME helper name — never a
  // per-button/per-dialog duplicate of the sign-in-detour logic.
  check('the needs-auth gate is ONE shared helper (beginNeedsAuthSignIn), used by both dialogs',
    (app.match(/const beginNeedsAuthSignIn = /g) || []).length === 1
    && /beginNeedsAuthSignIn\('edit'\)/.test(editSlice) && /beginNeedsAuthSignIn\('save'\)/.test(saveSlice));

  // Save's explicit bypass exists ONLY for the deliberate "Save on this
  // device instead" choice — without `localConfirmed` gating the check
  // itself, that button could never get past its own gate.
  check('the Save gate has a named escape for the explicit local-device choice (localConfirmed)',
    /!localConfirmed &&/.test(saveSlice));

  // RED-DESKTOP-18/001: Delete has no dialog, so a response that lands AFTER
  // the user signed out of A and back in as B (a request sent under A's
  // token; B validly signed in) used to be handled as if it were B's — its
  // 401 alerted B "Invalid or expired session." — and the first fix's
  // "refresh the list instead" ran the handler's STALE closure (A's token),
  // whose own 401 then cleared B's list (director's regression run of the
  // red's harness). The invariant is the one Save/Edit already hold: a
  // stale-identity response is discarded before it touches ANY state —
  // before `res.ok`'s list edit, before the 404 refetch, before the helper.
  //
  // CodeRabbit CLI on the fix: identity is not the whole context — both
  // database modes can be signed out (token null in each), and the mode
  // decides which server the response came from — so the gate compares a
  // request-context GENERATION bumped on every identity / mode / API-base
  // commit, captured before the fetch.
  const deleteSlice = app.slice(app.indexOf('const handleDeleteGame'), app.indexOf('const handleGenerateGame'));
  const DELETE_STALE_GATE = 'if (gamesContextGenRef.current !== requestGen) return;';
  const gateIdx = deleteSlice.indexOf(DELETE_STALE_GATE);
  const okIdx = deleteSlice.indexOf('if (res.ok)');
  const helperIdx = deleteSlice.indexOf('handleDeadSessionResponse(res, requestToken)');
  const fetchIdx = deleteSlice.indexOf('await fetch(');
  check(`handleDeleteGame discards a stale-context response before ANY state change (fetch@${fetchIdx} gate@${gateIdx} res.ok@${okIdx} helper@${helperIdx})`,
    gateIdx !== -1 && okIdx !== -1 && helperIdx !== -1 && fetchIdx !== -1
    && fetchIdx < gateIdx && gateIdx < okIdx && gateIdx < helperIdx);
  check('handleDeleteGame captures the request generation before the fetch (requestGen = gamesContextGenRef.current)',
    (() => { const i = deleteSlice.indexOf('const requestGen = gamesContextGenRef.current;'); return i !== -1 && i < fetchIdx; })());
  check('the games-context generation is bumped on every identity, API-base and database-mode commit',
    /useLayoutEffect\(\(\) => \{ gamesContextGenRef\.current \+= 1; \}, \[authToken, apiBaseUrl, dbMode\]\);/.test(app));
  // Every await is a chance for the context to move on: the body read before
  // the server-error alert, and the catch before the network alert.
  const jsonIdx = deleteSlice.indexOf('const data = await res.json();');
  const errAlertIdx = deleteSlice.indexOf("alert(data.error || 'Failed to delete game.')");
  const netAlertIdx = deleteSlice.indexOf("alert('Network error. Failed to delete game.");
  const gateAfter = (from: number, before: number) => { const i = deleteSlice.indexOf(DELETE_STALE_GATE, from); return i !== -1 && i < before; };
  check(`handleDeleteGame re-checks the generation after the body read, before the server-error alert (json@${jsonIdx} alert@${errAlertIdx})`,
    jsonIdx !== -1 && errAlertIdx !== -1 && gateAfter(jsonIdx, errAlertIdx));
  check(`handleDeleteGame re-checks the generation in the catch, before the network alert (alert@${netAlertIdx})`,
    netAlertIdx !== -1 && gateAfter(errAlertIdx, netAlertIdx));
  // Mutation fixtures: the two ways this regresses — the gate removed (the
  // original defect) and the gate moved below the helper (the alert is gone
  // but the list edits and the 404 refetch run under the wrong identity).
  // (The gate string recurs after the later awaits; removing the FIRST one
  // leaves only gates that sit after `if (res.ok)`, which the discard check
  // rejects.)
  const noGate = deleteSlice.replace(DELETE_STALE_GATE + '\n', '');
  const noGateFirst = noGate.indexOf(DELETE_STALE_GATE);
  check('fixture: removing the stale-identity gate fails the discard check (precondition: the plant landed)',
    noGate !== deleteSlice && (noGateFirst === -1 || noGateFirst > noGate.indexOf('if (res.ok)')));
  const lateGate = deleteSlice.replace(DELETE_STALE_GATE + '\n', '')
    .replace('handleDeadSessionResponse(res, requestToken);', 'handleDeadSessionResponse(res, requestToken);\n        ' + DELETE_STALE_GATE);
  const lateIdx = lateGate.indexOf(DELETE_STALE_GATE);
  check('fixture: a gate placed after the helper fails the discard check (precondition: the plant landed)',
    lateGate !== deleteSlice && lateIdx !== -1 && !(lateIdx < lateGate.indexOf('if (res.ok)')));

  // Known-positive fixtures (mutation: bypass -> fails by name): removing
  // the gate line entirely must be caught, by NAME, for each dialog.
  const editBypassed = editSlice.replace(new RegExp(`${editGatePattern.source}\\n\\s*`), '');
  check('fixture: reverting the Edit gate (bypass) is caught by the gate-before-fetch check',
    !gatePrecedesFetch(editBypassed, editGatePattern).ok);
  const saveBypassed = saveSlice.replace(new RegExp(`${saveGatePattern.source}\\n\\s*`), '');
  check('fixture: reverting the Save gate (bypass) is caught by the gate-before-fetch check',
    !gatePrecedesFetch(saveBypassed, saveGatePattern).ok);

  // Known-positive: the gate present but MOVED after the fetch (order, not
  // just presence) must also be caught.
  const saveGateAfterFetch = `${saveSlice.replace(new RegExp(`${saveGatePattern.source}\\n\\s*`), '')}\n    if (!localConfirmed && deadSession === 'save') { beginNeedsAuthSignIn('save'); return; }\n`;
  check('fixture: the Save gate present but placed AFTER the fetch is still caught (order-sensitive, not a bare substring check)',
    !gatePrecedesFetch(saveGateAfterFetch, saveGatePattern).ok);

  // Control: the real, unmutated slices must NOT be flagged by the bypass
  // detector — proves the fixtures above test the mutation, not the harness.
  check('control: the real (unmutated) Edit slice passes', gatePrecedesFetch(editSlice, editGatePattern).ok);
  check('control: the real (unmutated) Save slice passes', gatePrecedesFetch(saveSlice, saveGatePattern).ok);

  // CodeRabbit CLI: the gate must precede the `!canOwnGames` preflight too,
  // not just the fetch — otherwise a signed-out repeat click (no account,
  // no local fallback) falls into the generic "sign in or create an
  // account" branch again instead of routing straight to Sign In, unlike
  // Save's own ordering.
  const precedesCanOwnGames = (slice: string, gatePattern: RegExp): boolean => {
    const gateIdx = slice.search(gatePattern);
    const preflightIdx = slice.indexOf('if (!canOwnGames)');
    return gateIdx !== -1 && preflightIdx !== -1 && gateIdx < preflightIdx;
  };
  check('handleEditGameSubmit\'s gate precedes its own !canOwnGames preflight too (matches Save\'s ordering)',
    precedesCanOwnGames(editSlice, editGatePattern));
  check('handleSaveGameSubmit\'s gate precedes its own !canOwnGames preflight too',
    precedesCanOwnGames(saveSlice, saveGatePattern));
  // Known-positive: the pre-CodeRabbit-fix Edit ordering (gate AFTER the
  // !canOwnGames preflight, the shape this finding replaced) must be caught.
  const editPreflightFirst = 'const handleEditGameSubmit = async (e) => {\n'
    + '  e.preventDefault();\n  if (!editGameId) return;\n  if (!canOwnGames) {\n'
    + "    setEditError('Sign in or create an account to save changes.');\n"
    + '    setEditErrorNeedsAuth(true);\n    return;\n  }\n'
    + "  if (deadSession === 'edit') { beginNeedsAuthSignIn('edit'); return; }\n";
  check('fixture: the pre-CodeRabbit-fix Edit ordering (gate AFTER !canOwnGames) is caught',
    !precedesCanOwnGames(editPreflightFirst, editGatePattern));

  // OPUS-REVIEW-DESKTOP17 F1's actual root cause: `deadSession` must be
  // clearable ONLY by a successful submit (the functional-updater form,
  // `(d) => (d === 'save' ? null : d)`, used in both handlers' res.ok
  // branches — see STATE.md) or the sign-in-resume effect — NEVER by a
  // validation/network/409 branch. A literal `setDeadSession(null)` call
  // anywhere in either handler's body is exactly that regression (the F1
  // bug was `setEditErrorNeedsAuth`/`setSaveErrorNeedsAuth`'s equivalent: a
  // later branch clearing the gate's own state). Mutation: reintroducing
  // one in the empty-name check must fail THIS check by name.
  check('handleSaveGameSubmit never hard-clears deadSession outside its functional-updater success path (no literal setDeadSession(null))',
    !/setDeadSession\(null\)/.test(saveSlice));
  check('handleEditGameSubmit never hard-clears deadSession outside its functional-updater success path (no literal setDeadSession(null))',
    !/setDeadSession\(null\)/.test(editSlice));
  // Known-positive: planting the exact mutation the brief names (a
  // `setDeadSession(null)` inserted into the empty-name check) must fail
  // the SAME "never hard-clears" check above, by the same predicate.
  const saveNameCheckUngated = saveSlice.replace(
    "setSaveErrorNeedsAuth(false);\n      return;",
    'setSaveErrorNeedsAuth(false);\n      setDeadSession(null);\n      return;',
  );
  check('fixture: a setDeadSession(null) planted in the empty-name check is caught by the same predicate (precondition: the plant actually landed)',
    saveNameCheckUngated !== saveSlice);
  check('fixture: a setDeadSession(null) planted in the empty-name check fails the "never hard-clears" check',
    !(!/setDeadSession\(null\)/.test(saveNameCheckUngated)));
}

if (failures > 0) { console.error(`✗ local owner: ${failures} failed`); process.exit(1); }
console.log(`✓ local owner: ${sites.length} resolver sites — game routes fall back to the device owner, account deletion and /auth/me keep the strict check, provisioning and adoption are desktop-only, adoption re-parents`);

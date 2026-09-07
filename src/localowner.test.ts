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

/** Each `getAuthUser`/`getGameOwner` call, tagged with the route above it. */
function resolverByRoute(src: string): Array<{ route: string; resolver: string }> {
  const out: Array<{ route: string; resolver: string }> = [];
  let route = '(top level)';
  for (const line of src.split('\n')) {
    const m = line.match(/app\.(get|post|patch|delete)\("(\/api\/[^"]+)"/);
    if (m) route = m[2];
    const r = line.match(/\b(getAuthUser|getGameOwner)\(req\)/);
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
      resolver === 'getGameOwner', `uses ${resolver}`);
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
   'app.post("/api/auth/delete-confirm", h, (req, res) => {\n  const user = getGameOwner(req);\n});'],
  ['a game route left on the strict check',
   'app.get("/api/games", h, (req, res) => {\n  const user = getAuthUser(req);\n});'],
];
for (const [name, src] of MUST_FLAG) {
  const found = resolverByRoute(src);
  const bad = found.some((f) => (STRICT_ROUTES.includes(f.route) && f.resolver !== 'getAuthUser')
    || (GAME_ROUTES.includes(f.route) && f.resolver !== 'getGameOwner'));
  check(`fixture "${name}" is flagged`, bad);
}
// Control: the correct shape must not be flagged.
{
  const good = 'app.get("/api/games", h, (req, res) => {\n  const user = getGameOwner(req);\n});\n'
    + 'app.post("/api/auth/delete-confirm", h, (req, res) => {\n  const user = getAuthUser(req);\n});';
  const found = resolverByRoute(good);
  const bad = found.some((f) => (STRICT_ROUTES.includes(f.route) && f.resolver !== 'getAuthUser')
    || (GAME_ROUTES.includes(f.route) && f.resolver !== 'getGameOwner'));
  check('the correct shape is not flagged', !bad);
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
    const pattern = /(?<!\w)!?authToken\s*(?:\?|&&)\s*[(<]/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(norm))) {
      const context = norm.slice(Math.max(0, m.index - 40), m.index);
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
  const ALLOW = [/authHeaders\s*=/];

  const violations = authTokenRenderViolations(tsxFiles, ALLOW);
  check(`no authToken-ternary/&& render or copy branch anywhere under src/**/*.tsx (found ${violations.length}: ${violations.join(' | ').slice(0, 300)})`,
    violations.length === 0);

  // The two fixed sites read the per-error flag instead.
  check('Save dialog error render gates on saveErrorNeedsAuth', /saveErrorNeedsAuth \? \(/.test(app));
  check('Edit dialog error render gates on editErrorNeedsAuth', /editErrorNeedsAuth \? \(/.test(app));

  // CodeRabbit on #158 (outside-diff, 73e5fba): `if (!editGameId ||
  // !canOwnGames) return;` was a SILENT no-op if the token died while the
  // Edit dialog stayed open — resubmitting did nothing, no banner. The
  // handler's own `!canOwnGames` branch must set BOTH the message and the
  // flag, same as handleSaveGameSubmit's preflight.
  {
    const editFnStart = app.indexOf('const handleEditGameSubmit');
    const editFnSlice = app.slice(editFnStart, editFnStart + 700);
    check("handleEditGameSubmit's own !canOwnGames branch sets both editError and editErrorNeedsAuth(true), not a silent return",
      /if \(!canOwnGames\) \{[^}]*setEditError\([^}]*setEditErrorNeedsAuth\(true\)/.test(editFnSlice),
      editFnSlice.replace(/\s+/g, ' ').slice(0, 160));
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
      const after = src.slice(i, Math.min(src.length, i + 200));
      if (!new RegExp(`${flag}\\(`).test(after)) {
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
    const pattern = /(?<!\w)!?authToken\s*(?:\?|&&)\s*[(<]/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(norm))) {
      const context = norm.slice(Math.max(0, m.index - 40), m.index);
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
  // Control: the legitimate effect-gating `&&` (App.tsx's own refetch guard)
  // must NOT trip the &&-shape detector — its consequent is `user`, not a
  // JSX/parenthesized expression.
  check('control: `(authToken && user) || localOwnerMode` (App.tsx\'s own effect) is not flagged',
    violationsInText('if ((authToken && user) || localOwnerMode) {', ALLOW).length === 0);
}

if (failures > 0) { console.error(`✗ local owner: ${failures} failed`); process.exit(1); }
console.log(`✓ local owner: ${sites.length} resolver sites — game routes fall back to the device owner, account deletion and /auth/me keep the strict check, provisioning and adoption are desktop-only, adoption re-parents`);

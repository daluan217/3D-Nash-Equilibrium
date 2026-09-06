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
import { readFileSync } from 'node:fs';

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

if (failures > 0) { console.error(`✗ local owner: ${failures} failed`); process.exit(1); }
console.log(`✓ local owner: ${sites.length} resolver sites — game routes fall back to the device owner, account deletion and /auth/me keep the strict check, provisioning and adoption are desktop-only, adoption re-parents`);

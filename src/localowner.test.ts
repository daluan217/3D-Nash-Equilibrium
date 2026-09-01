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
check('adoption refuses to run off the desktop',
  /function adoptLocalGames\([\s\S]{0,200}if \(!isDesktop\(\)[\s\S]{0,40}return 0;/.test(server));
// Adoption RE-PARENTS; copying would duplicate a library on a second sign-in.
check('adoption re-parents rather than copies',
  /for \(const g of mine\) g\.userId = userId;/.test(server) && !/db\.games\.push/.test(server.slice(server.indexOf('function adoptLocalGames'), server.indexOf('function adoptLocalGames') + 900)));

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

if (failures > 0) { console.error(`✗ local owner: ${failures} failed`); process.exit(1); }
console.log(`✓ local owner: ${sites.length} resolver sites — game routes fall back to the device owner, account deletion and /auth/me keep the strict check, provisioning and adoption are desktop-only, adoption re-parents`);

/**
 * Route policy and write-primitive COMPLETENESS for server.ts.
 *
 * WHY. Six rounds of desktop findings were the same shape twice over: a route
 * that reads or writes somebody's saved games decides for itself who the
 * caller is (RED-DESKTOP-16/17: local-owner rows visible to a signed-in
 * account, a 401 that was really a missing owner), and a route that mutates
 * the database decides for itself how to persist (RED-DESKTOP-4/002: an
 * unwritable data directory echoing a save that never reached disk). Both were
 * fixed one route at a time. The structural answer is that there is exactly
 * ONE actor resolver (`getAuthUser` / `ensureLocalOwner` / `resolveGameOwner`)
 * and exactly ONE game-write path (`serializeGameWrite` -> `saveDBOrFail` ->
 * `writeFileAtomicSync`), and this contract is what makes a NEW route that
 * skips either one fail the build instead of shipping.
 *
 * It reads the source, so it costs nothing at runtime and cannot be satisfied
 * by prose: whole-line comments are stripped before any predicate runs, and
 * every predicate below is mutation-tested against a synthetic route that
 * commits the exact omission it is meant to catch.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const server = readFileSync('server.ts', 'utf8');

/** Whole-line comments only: a rule must be satisfied by code, never by a note about the code. */
export function codeOnly(src: string): string {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/** "GET /api/games" -> the handler's source, ending at its own `});` / `}));` at route indentation. */
export function routeBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^ {2}app\.(get|post|patch|delete|put)\("([^"]+)"/gm)) {
    const start = m.index ?? 0;
    const rest = src.slice(start);
    const close = rest.search(/\n {2}\}\)*\);/);
    out.set(`${m[1].toUpperCase()} ${m[2]}`, close >= 0 ? rest.slice(0, close) : rest);
  }
  return out;
}

const RESOLVER = /\b(getAuthUser|resolveGameOwner|ensureLocalOwner)\(/;
const TOUCHES_USER_DATA = /\bdb\.(games|users)\b/;
const PERSISTS_GAMES = /\bsaveDBOrFail\(/;
const SERIALIZED = /\bserializeGameWrite\(/;
const MUTATES_GAMES = /\bdb\.games\s*=|\bdb\.games\.(push|splice|shift|unshift|pop)\(/;
const WRITES_DB = /\bsaveDB\(/;
const CHECKED_PERSIST = /\bsaveDBOrFail\(|if \(!saveDB\(/;

/**
 * Routes that legitimately touch user data WITHOUT resolving a session, each
 * with the reason. A route may only be here because the caller proves who they
 * are some other way, or because the route hands back no user data at all.
 */
const NO_SESSION_BY_DESIGN: Record<string, string> = {
  'POST /api/auth/register': 'creates the account; there is no session to resolve yet',
  'POST /api/auth/verify': 'the emailed verification code is the credential',
  'POST /api/auth/login': 'the password is the credential',
  'POST /api/auth/forgot-password': 'anonymous by design; answers the same either way',
  'POST /api/auth/reset-password': 'the emailed reset token is the credential',
  'GET /api/admin/stats': 'x-admin-secret, checked by the /api/admin/ middleware, not a user session',
  'GET /api/auth/desktop-hint': 'returns only whether this desktop build already has a local owner — no user data',
};

/**
 * Routes that persist with an UNCHECKED `saveDB` today, each with what the
 * user is told when that write silently fails. A RATCHET, not an endorsement:
 * the set is frozen at what exists now, so a NEW route cannot join it without
 * someone writing down the consequence — and `POST /api/auth/delete-confirm`,
 * the one route that promises destruction, is deliberately NOT in it.
 */
const UNCHECKED_WRITE_ROUTES: Record<string, string> = {
  'POST /api/auth/register': 'a failed write leaves the account in memory only; the next launch has no account and the user simply registers again',
  'POST /api/auth/verify': 'a failed write loses the verified flag; the user is asked to verify again',
  'POST /api/auth/login': 'writes only the last-login bookkeeping; nothing the user is told depends on it',
  'POST /api/auth/forgot-password': 'a failed write loses the reset token; the emailed link then reports an invalid token instead of silently working',
  'POST /api/auth/delete-request': 'a failed write loses the deletion code, and delete-confirm then refuses it — the destructive step is the one that is checked',
};

export function policyFailures(src: string): string[] {
  const out: string[] = [];
  const bodies = routeBodies(codeOnly(src));
  for (const [route, body] of bodies) {
    if (TOUCHES_USER_DATA.test(body) && !RESOLVER.test(body) && !(route in NO_SESSION_BY_DESIGN)) {
      out.push(`${route} reads or writes db.games/db.users without resolving an actor through getAuthUser/resolveGameOwner/ensureLocalOwner`);
    }
    if (PERSISTS_GAMES.test(body) && !SERIALIZED.test(body)) {
      out.push(`${route} persists games outside serializeGameWrite — concurrent writes can drop one another`);
    }
    if (MUTATES_GAMES.test(body) && !CHECKED_PERSIST.test(body)) {
      out.push(`${route} mutates db.games but never checks that the write happened — the caller gets a success the disk never saw`);
    }
    if (WRITES_DB.test(body) && !CHECKED_PERSIST.test(body) && !(route in UNCHECKED_WRITE_ROUTES)) {
      out.push(`${route} persists with an unchecked saveDB — check it, or record in UNCHECKED_WRITE_ROUTES what the user is told when that write fails`);
    }
  }
  for (const route of [...Object.keys(NO_SESSION_BY_DESIGN), ...Object.keys(UNCHECKED_WRITE_ROUTES)]) {
    if (!bodies.has(route)) out.push(`${route} is exempted here but no longer exists — the exemption list has rotted`);
  }
  // The one route that promises destruction must read its own write. It told
  // the user "your account and all saved game profiles have been successfully
  // deleted from our records" while an unwritable data directory kept every
  // record, and the account came back on the next launch (STRUCT-DESKTOP-19,
  // reproduced by _gen/d19b3-deleteconfirm-false-destruction.mjs and guarded
  // at runtime by src/integration/desktop-unwritable-save.test.mjs phase 3).
  // The password reset makes the same kind of claim — the old password is
  // dead — and made it after an unchecked, in-place write: the next launch
  // accepted the old password and refused the new one.
  const resetPassword = bodies.get('POST /api/auth/reset-password') ?? '';
  if (!/if \(!saveDB\(/.test(resetPassword)) {
    out.push('POST /api/auth/reset-password must refuse (500) when the write fails — its success message says the old password no longer works');
  }
  if (/user\.passwordHash\s*=/.test(resetPassword)) {
    out.push('POST /api/auth/reset-password must build the updated user as a candidate, not assign passwordHash on the shared record — an in-place change survives a failed write');
  }
  const deleteConfirm = bodies.get('POST /api/auth/delete-confirm') ?? '';
  if (!/if \(!saveDB\(/.test(deleteConfirm)) {
    out.push('POST /api/auth/delete-confirm must refuse (500) when the deletion write fails — it is the one route whose success message asserts that records are gone');
  }
  if (/\bdb\.(users|games)\s*=/.test(deleteConfirm)) {
    out.push('POST /api/auth/delete-confirm must build the post-deletion database as a candidate, not mutate the shared one in place — an in-place wipe survives a failed write');
  }
  // `saveDB` commits the in-memory database only AFTER the bytes land. With
  // the assignment above the write, a refused deletion still emptied the
  // running process: /api/auth/me answered 401 for an account that was never
  // removed from disk.
  const allCode = codeOnly(src);
  const saveDBBody = allCode.slice(allCode.indexOf('function saveDB(db: DB): boolean {'));
  const localBranch = saveDBBody.slice(0, saveDBBody.indexOf('\n}'));
  const writeAt = localBranch.indexOf('writeFileAtomicSync(DB_FILE');
  const commitAt = localBranch.lastIndexOf('inMemoryDb = db;');
  if (writeAt < 0 || commitAt < 0 || commitAt < writeAt) {
    out.push('saveDB must assign inMemoryDb only after writeFileAtomicSync has returned — committing first makes a failed write invisible to the process that failed it');
  }
  // One writer for the database file. `writeFileAtomicSync` is tmp + fsync +
  // rename; a bare writeFileSync truncates first, so a crash mid-write leaves
  // a half file where every saved game used to be.
  const code = codeOnly(src);
  if (/\bfs\.writeFileSync\(\s*DB_FILE/.test(code)) {
    out.push('DB_FILE is written by a bare fs.writeFileSync — every database write must go through writeFileAtomicSync');
  }
  return out;
}

let failures = 0;
const fail = (m: string): void => { console.error(`  ✗ ${m}`); failures++; };

// ── The real server obeys the policy.
const realBodies = routeBodies(codeOnly(server));
if (realBodies.size < 20) fail(`route extraction found only ${realBodies.size} routes — the extractor, not the server, is what broke`);
for (const known of ['GET /api/games', 'POST /api/games', 'PATCH /api/games/:id', 'DELETE /api/games/:id',
  'POST /api/games/adopt-local', 'GET /api/auth/me', 'POST /api/auth/delete-request', 'POST /api/auth/delete-confirm']) {
  if (!realBodies.has(known)) fail(`route extraction lost ${known}`);
}
if (!RESOLVER.test(realBodies.get('GET /api/games') ?? '')) fail('extraction is wrong: GET /api/games does resolve an owner');
const real = policyFailures(server);
if (real.length > 0) for (const f of real) fail(f);

// ── Each rule fires, on a route that commits exactly the omission it names.
// Every mutant is appended to the real source, so a rule that has quietly
// stopped matching anything cannot pass these either.
const mutants: Array<[string, string, RegExp]> = [
  ['a new route reading saved games with no actor resolution',
    `\n  app.get("/api/games/export", (req, res) => {\n    const db = loadDB();\n    res.json(db.games);\n  });\n`,
    /GET \/api\/games\/export reads or writes/],
  ['a new route persisting games outside the write queue',
    `\n  app.post("/api/games/import", async (req, res) => {\n    const user = resolveGameOwner(req);\n    const db = loadDB();\n    if (!(await saveDBOrFail([...db.games], res))) return;\n    res.json({ ok: true });\n  });\n`,
    /POST \/api\/games\/import persists games outside serializeGameWrite/],
  ['a new route mutating games in memory and answering success',
    `\n  app.post("/api/games/touch", (req, res) => {\n    const user = resolveGameOwner(req);\n    const db = loadDB();\n    db.games.push({ id: "x" } as SavedGame);\n    res.json({ ok: true });\n  });\n`,
    /POST \/api\/games\/touch mutates db\.games but never checks/],
  ['a bare, non-atomic write of the database file',
    `\nfunction quickSave(db: DB): void {\n  fs.writeFileSync(DB_FILE, JSON.stringify(db));\n}\n`,
    /DB_FILE is written by a bare fs\.writeFileSync/],
];
for (const [what, snippet, expected] of mutants) {
  const found = policyFailures(server + snippet);
  if (!found.some((f) => expected.test(f))) fail(`mutant not caught (${what}): ${JSON.stringify(found)}`);
}
// The two halves of the delete-confirm fix, and the ratchet, each fire alone.
{
  const unchecked = server.replace(
    /    if \(!saveDB\(remaining\)\) \{[\s\S]*?\n    \}\n/,
    '    saveDB(remaining);\n');
  const found = policyFailures(unchecked);
  if (!found.some((f) => /delete-confirm must refuse \(500\)/.test(f))) {
    fail(`mutant not caught (delete-confirm stops checking its write): ${JSON.stringify(found)}`);
  }
  const inPlace = server.replace('const remaining: DB = {', 'db.users = [];\n    const remaining: DB = {');
  if (!policyFailures(inPlace).some((f) => /must build the post-deletion database as a candidate/.test(f))) {
    fail('mutant not caught (delete-confirm wiping the shared database in place)');
  }
  const committedFirst = server.replace(
    /      writeFileAtomicSync\(DB_FILE, JSON\.stringify\(db, null, 2\)\);/,
    '      inMemoryDb = db;\n      writeFileAtomicSync(DB_FILE, JSON.stringify(db, null, 2));')
    .replace(/\n      inMemoryDb = db;\n      return true;/, '\n      return true;');
  if (!policyFailures(committedFirst).some((f) => /saveDB must assign inMemoryDb only after/.test(f))) {
    fail('mutant not caught (saveDB committing in memory before the write)');
  }
  const resetUnchecked = server.replace(
    /    if \(!saveDB\(\{ users: db\.users\.map[\s\S]*?\n    \}\n/,
    '    saveDB(db);\n');
  if (!policyFailures(resetUnchecked).some((f) => /reset-password must refuse \(500\)/.test(f))) {
    fail('mutant not caught (reset-password stops checking its write)');
  }
  const resetInPlace = server.replace('    const updated: User = {', '    user.passwordHash = hashPassword(newPassword);\n    const updated: User = {');
  if (!policyFailures(resetInPlace).some((f) => /reset-password must build the updated user as a candidate/.test(f))) {
    fail('mutant not caught (reset-password assigning passwordHash in place)');
  }
  const newUnchecked = policyFailures(server + `\n  app.post("/api/auth/nickname", (req, res) => {\n    const user = getAuthUser(req);\n    const db = loadDB();\n    saveDB(db);\n    res.json({ success: true });\n  });\n`);
  if (!newUnchecked.some((f) => /POST \/api\/auth\/nickname persists with an unchecked saveDB/.test(f))) {
    fail(`mutant not caught (a new route persisting without checking): ${JSON.stringify(newUnchecked)}`);
  }
}

// A comment describing the omission is not the omission.
const commented = policyFailures(server + `\n  // app.get("/api/games/export", (req, res) => { res.json(db.games); });\n`);
if (commented.length > 0) fail(`commented-out code must not be read as a route: ${JSON.stringify(commented)}`);
// And the exemption list cannot outlive its routes.
const rotted = policyFailures(server.replace('app.post("/api/auth/login"', 'app.post("/api/auth/login-v2"'));
if (!rotted.some((f) => /POST \/api\/auth\/login is exempted here but no longer exists/.test(f))) {
  fail('a renamed exempt route must fail this contract instead of silently losing its exemption');
}

if (failures > 0) { console.error(`✗ server policy contract: ${failures} failure(s)`); process.exit(1); }
console.log(`✓ server policy contract: ${realBodies.size} routes, ${Object.keys(NO_SESSION_BY_DESIGN).length} justified exemptions, one actor resolver, one game-write path, one database writer`);

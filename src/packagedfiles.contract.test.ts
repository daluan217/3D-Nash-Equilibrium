/**
 * The packaged desktop app must never ship a database, a dotenv file, or any
 * other developer-machine artifact.
 *
 * THE DEFECT (BLUE-LOOP-DESKTOP-22, found by packing a canary rather than by
 * reading). `package.json`'s `build.files` listed `"db.json"` outright, and
 * `DB_FILE` falls back to `path.join(process.cwd(), "db.json")` whenever
 * `ELECTRON_USER_DATA_PATH` is unset (server.ts) — which is every ordinary
 * local run: `npm run dev`, `npm run start`, or a bare `node dist/server.cjs`
 * in the repo root each create one. A `db.json` sitting in the checkout when
 * `electron-builder` runs was therefore copied INTO `app.asar` and shipped to
 * every person who downloads the DMG.
 *
 * REPRODUCED, not theorised: a `db.json` holding
 * `passwordHash: "B22LEAKCANARY_PASSWORD_HASH"` and an e-mail address was
 * planted in the worktree root, `npm run electron:pack` was run, and the file
 * was recovered from the built package with
 * `npx asar extract-file .../app.asar db.json` — canary intact. Separately
 * confirmed that a plain `node dist/server.cjs` in the repo root creates the
 * file in the first place, so the precondition is an ordinary developer
 * action and not a contrived one.
 *
 * Severity is about WHAT it leaks: `db.json` is the account store — usernames,
 * e-mail addresses, bcrypt password hashes, `tokenVersion`, and every saved
 * game. The shipped 0.0.223 DMG happens to be clean (verified: `/db.json` is
 * absent from its 14,965-entry asar listing) because the release workflow
 * builds on a fresh `macos-latest` checkout that never ran the server. That is
 * luck, not a guarantee — one `npm run dev` added to the release job, or one
 * locally-built DMG, ships real users' credentials.
 *
 * `db.json` was also DEAD WEIGHT in the package: nothing reads a database out
 * of the asar (the packaged app always resolves `DB_FILE` under
 * `ELECTRON_USER_DATA_PATH`, and the asar is read-only anyway), so removing it
 * costs nothing. Confirmed with a control: after the fix the package still
 * contains 160 of the app's own files.
 *
 * THE FIX: drop `"db.json"` from `build.files` and add explicit negations for
 * it, its recovery siblings (`db.json.corrupt-*`, `db.json.unreadable-*`) and
 * the iCloud conflict-copy shape (`db.json 2`) this repo is plagued by — a
 * negation is what survives someone re-adding a broad glob later.
 *
 * MUTATION-TESTED — each of these, applied to the fixed tree, fails this file:
 *   M1  put `"db.json"` back into build.files            -> check 2 fails
 *   M2  drop the `!db.json` negation                     -> check 3 fails
 *   M3  drop the `!**\/.env*` negation                    -> check 4 fails
 *   M4  add a broad `"*.json"` glob                      -> check 5 fails
 *   M5  empty the files array                            -> check 6 fails
 *
 *   npx tsx src/packagedfiles.contract.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
  build?: { files?: unknown; asar?: unknown };
};

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1 — there is a files allowlist at all.
// With `build.files` absent, electron-builder packages essentially the whole
// project directory, which is strictly worse than the defect this file guards.
// ─────────────────────────────────────────────────────────────────────────────
ok(Array.isArray(pkg.build?.files),
  'package.json build.files must be an explicit array. Without it electron-builder packages the '
  + 'whole project directory — every dotfile, every local database, every scratch artifact.');
const files = pkg.build!.files as unknown[];
ok(files.every((f) => typeof f === 'string'),
  'every build.files entry must be a plain string glob this contract can reason about');
const globs = files as string[];
const includes = globs.filter((g) => !g.startsWith('!'));
const excludes = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2 — the database is not named as something to INCLUDE.
// This is the exact line that shipped: `"db.json"` sat in the include list.
// ─────────────────────────────────────────────────────────────────────────────
for (const forbidden of ['db.json', './db.json', 'db.json 2']) {
  ok(!includes.includes(forbidden),
    `package.json build.files must not list ${JSON.stringify(forbidden)} as an included file. `
    + 'DB_FILE falls back to process.cwd()/db.json whenever ELECTRON_USER_DATA_PATH is unset, so an '
    + 'ordinary `npm run dev` / `npm start` in the checkout creates one — and electron-builder then '
    + "copies the account store (e-mails, password hashes, tokenVersion, every saved game) into "
    + 'app.asar and ships it to everyone who downloads the DMG. Reproduced with a planted canary '
    + 'and recovered from the built package with `asar extract-file` (BLUE-LOOP-DESKTOP-22). '
    + 'Nothing reads a database out of the asar, so this entry is pure liability.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3 — the database is EXPLICITLY excluded, not merely absent.
// Absence alone is fragile: a future `"*.json"` or `"**/*"` include would
// silently pull db.json back in.
//
// CORRECTION (BLUE-LOOP-DESKTOP-22 self-review). An earlier version of this
// comment claimed "a negation keeps winning". That is FALSE, and it was
// measured rather than argued: appending `"**/db.json"` AFTER the negations,
// with a canary db.json in the checkout, produced a build whose app.asar
// contains /db.json — `asar extract-file` recovered
// {"users":[{"id":"CANARY3","email":"c3@leak.test","passwordHash":"..."}]}
// while this contract still reported "21 checks passed". electron-builder
// resolves LAST MATCHING PATTERN WINS, so a negation only protects what no
// later include re-matches. CHECK 3b below is the check that would have caught
// that; the presence checks here are necessary but not sufficient.
// ─────────────────────────────────────────────────────────────────────────────
ok(excludes.includes('db.json'),
  'package.json build.files must explicitly exclude "!db.json", not merely omit it. A later broad '
  + 'glob (e.g. "*.json") would otherwise re-include the account store without anyone noticing; an '
  + 'explicit negation survives that.');
// The recovery artifacts and the iCloud conflict copy carry the same data.
ok(excludes.includes('db.json.*'),
  'build.files must exclude "!db.json.*" — server.ts writes db.json.corrupt-<ts> and '
  + 'db.json.unreadable-<ts> beside the database, and those hold the same user records.');
ok(excludes.some((e) => /^db\.json \[?\d/.test(e)),
  'build.files must exclude the iCloud/Finder conflict-copy shape ("!db.json [0-9]*"). This repo '
  + 'lives on iCloud Drive and routinely grows "db.json 2" siblings; npm test even has a guard for '
  + 'that filename class in the working tree.');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3b — NO INCLUDE MAY FOLLOW THE NEGATIONS AND RE-MATCH THE DATABASE.
//
// This is the check the presence checks above cannot make. electron-builder
// applies patterns in order and the LAST match wins, so `!db.json` protects
// nothing against a later `"**/db.json"`, `"*.json"` or `"**/*"`. Measured:
// appending `"**/db.json"` after the negations shipped a canary account store
// inside app.asar while every other check in this file still passed.
//
// Rather than blacklist spellings, evaluate the ACTUAL resolution: walk the
// patterns in order against representative paths and require the final verdict
// to be "excluded". A future glob nobody here anticipated is judged by what it
// does, not by how it is written.
// ─────────────────────────────────────────────────────────────────────────────
function lastVerdict(patterns: string[], candidate: string): 'included' | 'excluded' {
  // Minimal glob -> RegExp for the shapes electron-builder's `files` accepts.
  // `**` crosses separators, `*` does not, `?` is one non-separator character.
  const toRe = (glob: string) => {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
        else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
      else re += c;
    }
    return new RegExp(`^${re}$`);
  };
  let verdict: 'included' | 'excluded' = 'excluded'; // nothing matched => not packaged
  for (const p of patterns) {
    const negated = p.startsWith('!');
    const body = negated ? p.slice(1) : p;
    const bare = body.startsWith('./') ? body.slice(2) : body;
    if (toRe(bare).test(candidate)) verdict = negated ? 'excluded' : 'included';
  }
  return verdict;
}
// The resolver itself, proven on both polarities before anything trusts it —
// otherwise a resolver that always says "excluded" would pass every case below.
ok(lastVerdict(['**/*'], 'db.json') === 'included',
  'RESOLVER SELF-TEST: a bare "**/*" include must resolve db.json as INCLUDED');
ok(lastVerdict(['**/*', '!db.json'], 'db.json') === 'excluded',
  'RESOLVER SELF-TEST: a trailing negation must resolve db.json as EXCLUDED');
ok(lastVerdict(['**/*', '!db.json', '**/db.json'], 'db.json') === 'included',
  'RESOLVER SELF-TEST: a re-include AFTER the negation must resolve as INCLUDED — that is the '
  + 'measured leak this check exists for, and a resolver that misses it is inert');
ok(lastVerdict(['dist/**/*'], 'dist/server.cjs') === 'included',
  'RESOLVER SELF-TEST: "dist/**/*" must still include a file inside dist/');

for (const sensitive of [
  'db.json', 'db.json 2', 'db.json 3', 'db.json.corrupt-1700000000000',
  'db.json.unreadable-1700000000000', 'db.json.tmp-123-456',
  '.env', '.env.local', '.env.production',
]) {
  ok(lastVerdict(globs, sensitive) === 'excluded',
    `build.files resolves ${JSON.stringify(sensitive)} as INCLUDED. electron-builder applies patterns `
    + 'in order and the LAST match wins, so an include listed after the negations re-packages the '
    + 'account store however emphatic the "!" lines above it are. Measured: appending "**/db.json" '
    + 'put a canary db.json (e-mail + password hash) inside the shipped app.asar.');
}
// CONTROL: the app's own files must still resolve as INCLUDED, or "everything
// is excluded" would satisfy every line above and ship a DMG that cannot run.
for (const needed of ['dist/server.cjs', 'dist/index.html', 'electron-main.cjs', 'electron-preload.cjs']) {
  ok(lastVerdict(globs, needed) === 'included',
    `build.files resolves ${JSON.stringify(needed)} as EXCLUDED — the app cannot run without it. `
    + 'A contract that only ever demands exclusion is satisfied by an empty package.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 4 — dotenv files stay excluded (the pre-existing guarantee).
// The fix rewrote this array, so the property it already had is asserted here
// rather than assumed to have survived the edit.
// ─────────────────────────────────────────────────────────────────────────────
ok(excludes.some((e) => /^\*\*\/\.env/.test(e)),
  'build.files must keep excluding "!**/.env*" — a packaged app must never carry credentials, and '
  + 'this negation is the only thing standing between a local .env and the DMG.');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 5 — no include glob is broad enough to sweep the repo root.
// `"*.json"` would re-admit db.json; `"**/*"` or `"."` would admit everything.
// ─────────────────────────────────────────────────────────────────────────────
for (const g of includes) {
  const sweepsRoot = g === '**/*' || g === '**' || g === '.' || g === '*'
    || /^\*\.[a-z]+$/i.test(g) || g.startsWith('!') === false && /^\*\*\/\*\.[a-z]+$/i.test(g);
  ok(!sweepsRoot,
    `build.files include glob ${JSON.stringify(g)} is broad enough to sweep the repository root `
    + 'into the package. Name the app\'s own files (dist/**/*, electron-main.cjs, '
    + 'electron-preload.cjs) instead — a root-wide glob is how a local database, a scratch dump or '
    + 'a credentials file ends up in a public download.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6 — CONTROL. The app's OWN files must still be included.
// Without this arm, deleting every entry would pass checks 2-5 while shipping
// a package that cannot run: an instrument that only forbids is measuring
// itself. (The end-to-end version of this control is the pack itself: after
// the fix the built asar still carried 160 of the app's own files.)
// ─────────────────────────────────────────────────────────────────────────────
ok(includes.some((g) => g.startsWith('dist/')),
  'CONTROL: build.files must still include the built app (dist/**/*) — a package with nothing in '
  + 'it would satisfy every exclusion above.');
for (const needed of ['electron-main.cjs', 'electron-preload.cjs']) {
  ok(includes.includes(needed),
    `CONTROL: build.files must still include ${needed}; without it the packaged app has no main `
    + 'process or no preload bridge.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 7 — asar packaging stays on. With `asar: false` the same files sit
// loose in Resources/, which is the identical exposure with an easier path to
// it.
// ─────────────────────────────────────────────────────────────────────────────
ok(pkg.build?.asar !== false,
  'package.json build.asar must not be false: unpacked resources expose exactly the same files, '
  + 'just without needing `asar extract-file` to read them.');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 8 — the guard can fail. Each predicate above is re-run against a
// deliberately bad allowlist; if any of them passes it, this file is
// decoration. (Beware checks that cannot fail for the reason they claim.)
// ─────────────────────────────────────────────────────────────────────────────
{
  const badGlobs = ['dist/**/*', 'electron-main.cjs', 'electron-preload.cjs', 'db.json', '!**/.env*'];
  const badIncludes = badGlobs.filter((g) => !g.startsWith('!'));
  const badExcludes = badGlobs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  ok(badIncludes.includes('db.json'),
    'self-test: the pre-fix allowlist must be detected as INCLUDING db.json (check 2 would fire)');
  ok(!badExcludes.includes('db.json'),
    'self-test: the pre-fix allowlist must be detected as lacking the !db.json negation (check 3 would fire)');
  const sweep = ['*.json', '**/*', '.'];
  for (const g of sweep) {
    const detected = g === '**/*' || g === '**' || g === '.' || g === '*' || /^\*\.[a-z]+$/i.test(g);
    ok(detected, `self-test: ${JSON.stringify(g)} must be detected as a root-sweeping glob (check 5 would fire)`);
  }
}

console.log(`packagedfiles.contract.test.ts: ${checks} checks passed`);

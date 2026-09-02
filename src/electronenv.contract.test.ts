/**
 * The desktop app's environment contract.
 *
 * WHY THIS EXISTS. The web backend gets its rung-3 flags from `cloudbuild.yaml`
 * and `src/cloudbuild.contract.test.ts` guards them. The desktop gets its
 * environment from `electron-main.cjs` and nothing guarded that at all, so the
 * two surfaces silently diverged: the site ran rung 3 while the packaged app
 * ran a path that produced `source: 'deterministic'` — no explanation, no
 * scenario — and nothing in CI could see it. `npm run lint` is `tsc --noEmit`
 * with `allowJs` and no `checkJs`, there is no ESLint here, and no test boots
 * the packaged app, so a `.cjs` file is invisible to all five jobs.
 *
 * This is a TEXT contract on purpose. Importing `electron-main.cjs` would pull
 * in Electron's `app` object and start a browser process; the thing worth
 * asserting is anyway not that the file runs but that it still SAYS these
 * words, because the failure mode is deletion, not malfunction.
 *
 *   npx tsx src/electronenv.contract.test.ts
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

const main = readFileSync(join(repo, 'electron-main.cjs'), 'utf8');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
  build?: { files?: string[]; extraResources?: unknown };
};

// Comments must not satisfy the contract: a rule that a code comment can pass
// is not a rule. Strip them first, and prove the stripper works.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
ok(!stripComments('// process.env.NASH_PAYOFF_TEMPLATE = "1";').includes('NASH_PAYOFF_TEMPLATE'),
  'the comment stripper must remove a line comment');
ok(!stripComments('/* process.env.NASH_LLM_TIES = "template"; */').includes('NASH_LLM_TIES'),
  'the comment stripper must remove a block comment');
ok(stripComments("process.env.NASH_PAYOFF_TEMPLATE = '1';").includes('NASH_PAYOFF_TEMPLATE'),
  'the comment stripper must keep real code');

const code = stripComments(main);

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE RUNG-3 TRIO
//
// Values matter as much as names: `NASH_PAYOFF_TEMPLATE` is compared against
// the STRING '1' in server.ts, so `= 1` or `= 'true'` would leave the desktop
// on the deterministic path while looking set.
// ─────────────────────────────────────────────────────────────────────────────
const required: [string, string][] = [
  ['NASH_PAYOFF_TEMPLATE', '1'],
  ['NASH_LLM_TIES', 'template'],
  ['NASH_DIRECTION_CHECKS', '1'],
];
for (const [name, value] of required) {
  const re = new RegExp(`process\\.env\\.${name}\\s*=\\s*['"]${value}['"]`);
  ok(re.test(code),
    `electron-main.cjs must set ${name} = '${value}'. Without it the packaged app answers `
    + `source: 'deterministic' — no explanation and no scenario — while the website runs rung 3.`);
}

// The four it already set, so a refactor cannot drop those either.
for (const [name, value] of [
  ['NODE_ENV', 'production'],
  ['IS_ELECTRON', 'true'],
] as [string, string][]) {
  ok(new RegExp(`process\\.env\\.${name}\\s*=\\s*['"]${value}['"]`).test(code),
    `electron-main.cjs must set ${name} = '${value}'`);
}
ok(/process\.env\.ELECTRON_USER_DATA_PATH\s*=/.test(code),
  'electron-main.cjs must set ELECTRON_USER_DATA_PATH');
ok(/process\.env\.PORT\s*=/.test(code), 'electron-main.cjs must set PORT');

// IS_ELECTRON is what makes the bundled bank reachable at all (`canInvent`
// requires it), so the trio above is only half the story.
ok(code.indexOf("process.env.IS_ELECTRON") < code.indexOf("process.env.NASH_PAYOFF_TEMPLATE"),
  'IS_ELECTRON must be set before the rung-3 flags, in the same block, so the bank is reachable');

// ─────────────────────────────────────────────────────────────────────────────
// 2. THEY MUST BE SET BEFORE THE SERVER IS REQUIRED
//
// `server.ts` reads these at request time, but `dotenv.config()` and the module
// graph run at require time; setting them after the require would work today
// and become a load-bearing accident.
// ─────────────────────────────────────────────────────────────────────────────
{
  const requireIdx = code.search(/require\(['"][^'"]*server\.cjs['"]\)/);
  ok(requireIdx > 0, 'electron-main.cjs must require the compiled server');
  for (const [name] of required) {
    ok(code.indexOf(`process.env.${name}`) < requireIdx,
      `${name} must be set BEFORE dist/server.cjs is required`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. NO .env IS PACKAGED
//
// The flags are set in code precisely because a packaged app carries no `.env`.
// If one were ever added to build.files it would ship credentials to every
// user, and it would also make the desktop's behaviour depend on a file the
// developer happens to have — which is the exact trap that made an earlier
// measurement of this same question wrong.
// ─────────────────────────────────────────────────────────────────────────────
{
  const files = pkg.build?.files ?? [];
  ok(files.length > 0, 'package.json build.files must exist');
  // A leading `!` is a glob NEGATION (exclude), not an include — testing the
  // raw string here would flag the exclusion pattern below as if it were
  // itself packaging a .env.
  ok(!files.some((f) => !f.startsWith('!') && /(^|\/)\.env/.test(f)),
    `build.files must not package a .env: ${JSON.stringify(files)}`);
  // The literal check above only catches a `.env`-shaped INCLUDE pattern. It
  // cannot see a broad glob (`dist/**/*`) silently sweeping up a `dist/.env`
  // that got there some other way — electron-builder does not exclude
  // dotfiles by default. An explicit negation pattern is the one shape that
  // protects the resolved list regardless of how a dotfile got into `dist/`.
  //
  // MUST BE `.env*`, not just `.env`: Vite/dotenv's own convention is
  // `.env.local` / `.env.production` / `.env.*.local` (see .gitignore), and
  // `!**/.env` alone would leave every one of those packageable.
  ok(files.includes('!**/.env*'),
    `build.files must carry the repo-wide exclusion '!**/.env*' so no .env variant (.env.local, .env.production, ...) can be packaged from any directory: ${JSON.stringify(files)}`);
  ok(files.includes('electron-main.cjs'),
    'build.files must package electron-main.cjs — it is where the desktop environment now lives');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE RUNG-3 / CLAIM-FREE SCREEN IS BUILD-TIME ONLY, NEVER REQUEST-TIME
//
// `NASH_PAYOFF_TEMPLATE` gates the CLAIM-FREE scenario screen (server.ts:
// under it, `inventScreenedScenario` requires the description to assert
// nothing decidable — the solver states the mathematics instead). It is set
// exactly ONCE, above, before `dist/server.cjs` is even required, and read
// from `process.env` only. round3/BLUE-SERVER-DESKTOP.md's queue item 4 asks
// to confirm this can never become a per-REQUEST toggle: a client that could
// flip it on or off would let a request opt OUT of the claim-free guarantee
// the desktop is supposed to enforce unconditionally, or opt IN somewhere it
// was deliberately not measured. This is a NEGATIVE-existence check — the
// failure mode is someone adding a `req.body.forceTemplate`-shaped backdoor
// later, not a removal, which is why it lives beside the trio checks above
// rather than as a positive assertion of its own.
// ─────────────────────────────────────────────────────────────────────────────
{
  const serverSrc = stripComments(readFileSync(join(repo, 'server.ts'), 'utf8'));
  const flagNames = ['NASH_PAYOFF_TEMPLATE', 'NASH_LLM_TIES', 'NASH_DIRECTION_CHECKS'];

  for (const name of flagNames) {
    // server.ts must only ever COMPARE against process.env.<name>, never
    // ASSIGN to it — an assignment there would mean some code path (a route
    // handler, most plausibly) can change the flag after startup. The
    // negative lookahead excludes `===`/`==`, which start with the same `=`
    // this would otherwise flag as an assignment — checked directly below:
    // the trio's real reads are `process.env.X === '1'` and must NOT trip
    // this check, or the assertion would be vacuous (failing on correct code
    // too, which is worse than not existing).
    const assignRe = new RegExp(`process\\.env\\.${name}\\s*=(?!=)`);
    ok(!assignRe.test(serverSrc),
      `server.ts must never ASSIGN process.env.${name} — it is a build/launch-time flag, ` +
      `set once in electron-main.cjs (desktop) or cloudbuild.yaml (hosted), never at request time`);
  }

  // No request-derived value (req.body / req.query / req.headers, however the
  // property is spelled) may share a line with any of the three flag names —
  // catches `if (req.body.forceTemplate)` guarding a flag-name reference, a
  // destructure pulling a flag name off req.body, etc. Line-based (not just a
  // same-file check) so a handler far away from the real gate cannot launder
  // a match; every one of the trio's real reads is a single `process.env.X`
  // expression with nothing req-shaped on that line, which is exactly what a
  // literal correct implementation looks like.
  const reqShapeRe = /\breq\s*\.\s*(body|query|headers|params)\b/;
  const lines = serverSrc.split('\n');
  const offending: string[] = [];
  for (const line of lines) {
    if (reqShapeRe.test(line) && flagNames.some((n) => line.includes(n))) {
      offending.push(line.trim());
    }
  }
  ok(offending.length === 0,
    `server.ts must never read a rung-3 flag name from req.body/query/headers/params ` +
    `(found: ${JSON.stringify(offending)})`);
}

console.log(`electronenv.contract.test.ts: ${checks} checks passed`);

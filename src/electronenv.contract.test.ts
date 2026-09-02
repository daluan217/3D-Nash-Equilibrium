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

console.log(`electronenv.contract.test.ts: ${checks} checks passed`);

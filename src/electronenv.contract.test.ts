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
import ts from 'typescript';
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

// Neither a comment NOR a string may satisfy the contract, and section 2 below
// compares INDEXES, so whatever we blank has to keep every other character at
// its original offset. The old `stripComments` failed both halves: it deleted
// the text it removed (shifting every later index) and it could not see a
// literal at all. MEASURED on the real file: with the assignment moved below
// the require and `const ENV_DOC = 'process.env.NODE_ENV ...';` added near the
// top, the suite passed 28/28 while the packaged app would boot Vite.
// TWO views, both offset-preserving. `blankLiterals: false` keeps the quoted
// VALUES that section 1's `= '1'` regexes must read; `true` also blanks them,
// which is what the NAME and ORDER checks need. A value check cannot use the
// strict view (nothing to match) and an order check cannot use the loose one
// (a string is exactly how you forge one).
function codeOnly(src: string, blankLiterals = true, kind = ts.ScriptKind.JS): string {
  const sf = ts.createSourceFile('probe', src, ts.ScriptTarget.Latest, true, kind);
  const out = src.split('');
  const blank = (a: number, b: number) => {
    for (let i = a; i < b; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  const LITERALS = new Set<number>([
    ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail,
  ]);
  const walk = (n: ts.Node): void => {
    if (blankLiterals && LITERALS.has(n.kind)) blank(n.getStart(sf), n.getEnd());
    for (const r of ts.getLeadingCommentRanges(src, n.getFullStart()) ?? []) blank(r.pos, r.end);
    for (const r of ts.getTrailingCommentRanges(src, n.getEnd()) ?? []) blank(r.pos, r.end);
    n.forEachChild(walk);
  };
  walk(sf);
  return out.join('');
}
// SELF-TESTS. The last two are the shapes that defeated the old stripper; the
// CONTROL fails a scanner that simply blanks everything.
for (const [shape, src, needle] of [
  ['a line comment', '// process.env.NASH_PAYOFF_TEMPLATE = "1";', 'NASH_PAYOFF_TEMPLATE'],
  ['a block comment', '/* process.env.NASH_LLM_TIES = "template"; */', 'NASH_LLM_TIES'],
  ['a single-quoted string', "const d = 'process.env.NODE_ENV is set';", 'NODE_ENV'],
  ['a template literal', 'const d = `process.env.NODE_ENV ${x} set`;', 'NODE_ENV'],
] as const) {
  ok(!codeOnly(src).includes(needle), `${shape} must NOT satisfy the contract`);
}
ok(codeOnly("process.env.NASH_PAYOFF_TEMPLATE = '1';").includes('NASH_PAYOFF_TEMPLATE'),
  'CONTROL: real code must survive, or every check above passes vacuously');
// The loose view keeps VALUES but must still drop comments, or section 1's
// `= '1'` regexes could be satisfied by a commented-out assignment.
ok(codeOnly("process.env.NASH_LLM_TIES = 'template';", false).includes("'template'"),
  'CONTROL: the loose view must keep the quoted value section 1 matches on');
ok(!codeOnly("// process.env.NASH_LLM_TIES = 'template';", false).includes('NASH_LLM_TIES'),
  'the loose view must still remove comments');
// Offsets must be PRESERVED, or the `indexOf(...) < requireIdx` comparisons in
// section 2 are comparing positions in a string the file never had.
{
  const src = "const d = 'xxxxxxxx'; process.env.NODE_ENV = 'production';";
  ok(codeOnly(src).length === src.length
    && codeOnly(src).indexOf('process.env.NODE_ENV') === src.indexOf('process.env.NODE_ENV'),
    'CONTROL: blanking must not move any surviving character');
}

const code = codeOnly(main);          // names + ORDER: literals blanked too
const codeWithValues = codeOnly(main, false);  // VALUES: literals kept

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
  ok(re.test(codeWithValues),
    `electron-main.cjs must set ${name} = '${value}'. Without it the packaged app answers `
    + `source: 'deterministic' — no explanation and no scenario — while the website runs rung 3.`);
}

// The four it already set, so a refactor cannot drop those either.
for (const [name, value] of [
  ['NODE_ENV', 'production'],
  ['IS_ELECTRON', 'true'],
] as [string, string][]) {
  ok(new RegExp(`process\\.env\\.${name}\\s*=\\s*['"]${value}['"]`).test(codeWithValues),
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
  // From the AST, not from `code`: blanking literals erases the require's own
  // path argument, and a text search over the RAW file matches the prose
  // mention of `require('./dist/server.cjs')` 56 lines above the real call —
  // which is what made the SR-56 check compare against the wrong offset.
  // Offsets are preserved by codeOnly, so an AST position is comparable to an
  // index into `code`. Lowest call wins: a later one cannot launder an early
  // require. EXECUTED calls only — a nested `require` inside a function that is
  // never invoked is not what boots the server, but we have none, and
  // `requireCalls === 1` below fails loudly if that ever changes.
  const sf = ts.createSourceFile('m.js', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const requirePositions: number[] = [];
  const findRequires = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'require'
      && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0])
      && /server\.cjs$/.test(n.arguments[0].text)) requirePositions.push(n.getStart(sf));
    n.forEachChild(findRequires);
  };
  findRequires(sf);
  ok(requirePositions.length === 1,
    `electron-main.cjs must require the compiled server exactly once; found `
    + `${requirePositions.length}. With more than one, "before the require" is ambiguous `
    + 'and this section must be rewritten rather than silently picking the first.');
  const requireIdx = requirePositions[0];
  ok(requireIdx > 0, 'electron-main.cjs must require the compiled server');
  // CONTROL: the anchor must be the CALL, not the prose that mentions it. The
  // raw-text search lands 56 lines earlier, so these two disagree today; if
  // they ever agree, this control is dead and must be re-derived.
  ok(main.search(/require\(['"][^'"]*server\.cjs['"]\)/) < requireIdx,
    'CONTROL: a raw-text search finds the COMMENT first — proof the AST anchor is doing work');
  // SR-56. This loop covered `required` — the three rung-3 flags — and left out
  // the variable with the largest blast radius. server.ts gates its DEV branch
  // on `process.env.NODE_ENV !== "production"`, and that branch calls
  // createViteServer(). The flags are read per request, so setting one late is
  // a latent bug; NODE_ENV is read while the module graph loads, so setting it
  // late is live. MEASURED: moving the NODE_ENV line below the require left
  // this file 24/24 GREEN while the packaged app booted a Vite dev server in
  // the user's app and SPAWNED esbuild — electron-behavior.test.mjs caught it
  // with "the main process made a child_process.spawn call", this file did not.
  // The dev toolchain really is in the shipped asar (vite, rollup, esbuild,
  // tailwind, babel — 40 entries under node_modules for vite/esbuild alone,
  // and the unpacked esbuild binary runs: `--version` -> 0.25.12), so the
  // branch is not merely wrong, it WORKS.
  for (const [name] of [...required, ['NODE_ENV'], ['IS_ELECTRON'],
    ['ELECTRON_USER_DATA_PATH'], ['PORT']] as [string][]) {
    ok(code.indexOf(`process.env.${name}`) < requireIdx,
      `${name} must be set BEFORE dist/server.cjs is required. For NODE_ENV this is not a `
      + 'style point: server.ts takes its `NODE_ENV !== "production"` dev branch and calls '
      + 'createViteServer() in the packaged app, which ships the whole dev toolchain.');
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
  // TS kind: server.ts's type annotations and generics would otherwise parse
  // as expressions and shift what counts as a literal.
  const serverSrc = codeOnly(readFileSync(join(repo, 'server.ts'), 'utf8'), true, ts.ScriptKind.TS);
  const flagNames = ['NASH_PAYOFF_TEMPLATE', 'NASH_LLM_TIES', 'NASH_DIRECTION_CHECKS', 'NASH_SCENARIO_REGEN'];

  for (const name of flagNames) {
    // server.ts must only ever COMPARE against process.env.<name>, never
    // ASSIGN to it — an assignment there would mean some code path (a route
    // handler, most plausibly) can change the flag after startup. The
    // negative lookahead excludes `===`/`==`, which start with the same `=`
    // this would otherwise flag as an assignment — checked directly below:
    // the trio's real reads are `process.env.X === '1'` and must NOT trip
    // this check, or the assertion would be vacuous (failing on correct code
    // too, which is worse than not existing).
    //
    // TWO FORMS (CodeRabbit caught the dot-only version missing the second):
    // dot notation `process.env.NAME = ` and bracket notation
    // `process.env['NAME'] = ` / `process.env["NAME"] = ` — JS treats them
    // identically at runtime, so a check that only sees one is a check that
    // can be silently routed around.
    const assignReDot = new RegExp(`process\\.env\\.${name}\\s*=(?!=)`);
    const assignReBracket = new RegExp(`process\\.env\\[['"]${name}['"]\\]\\s*=(?!=)`);
    ok(!assignReDot.test(serverSrc) && !assignReBracket.test(serverSrc),
      `server.ts must never ASSIGN process.env.${name} (dot OR bracket notation) — it is a ` +
      `build/launch-time flag, set once in electron-main.cjs (desktop) or cloudbuild.yaml ` +
      `(hosted), never at request time`);
  }

  // No request-derived value (req.body / req.query / req.headers / req.params,
  // however the property is spelled) may share a line with any of the three
  // flag names — catches `if (req.body.forceTemplate)` guarding a flag-name
  // reference, a destructure pulling a flag name off req.body, etc.
  const reqShapeRe = /\breq\s*\.\s*(body|query|headers|params)\b/;
  const lines = serverSrc.split('\n');
  const offending: string[] = [];
  for (const line of lines) {
    if (reqShapeRe.test(line) && flagNames.some((n) => line.includes(n))) {
      offending.push(line.trim());
    }
  }

  // CROSS-STATEMENT form (CodeRabbit's finding — the same-line check above
  // cannot see this): a request-derived value assigned to an intermediate
  // VARIABLE on one line, that variable's NAME then appearing near a flag
  // read on a LATER line — `const wantsTemplate = req.body.forceTemplate;`
  // ... `if (wantsTemplate) { ...process.env.NASH_PAYOFF_TEMPLATE... }`.
  //
  // DELIBERATELY NARROW, and here is why: an EARLIER, broader version of
  // this check flagged "any req.body/query/headers/params reference
  // anywhere in the flag's enclosing route handler" — and FAILED ITS OWN
  // FIRST RUN, on real, correct code: `/api/report` legitimately reads
  // `req.body.payoffs`/`req.body.scenario` for unrelated business logic in
  // the SAME large handler that also reads the rung-3 flags, so that
  // version was 100% false positives on the very thing it exists to guard
  // (predicates over-fire on the first draft — the standing lesson this
  // repo has hit five separate times before). This version instead tracks
  // only NAMED VARIABLES actually assigned from req.*, and only flags one
  // when that SPECIFIC variable's name appears within a few lines of a flag
  // read — a real data-flow signal, not "req.* exists somewhere nearby."
  const reqVarRe = /\b(?:const|let|var)\s+(\w+)\s*=\s*req\s*\.\s*(?:body|query|headers|params)\b/g;
  const reqDerivedVars = new Set<string>();
  { let vm: RegExpExecArray | null; while ((vm = reqVarRe.exec(serverSrc)) !== null) reqDerivedVars.add(vm[1]); }
  if (reqDerivedVars.size > 0) {
    // lines before/after the flag read
    for (const name of flagNames) {
      lines.forEach((line, i) => {
        if (!line.includes(name)) return;
        const windowText = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 3 + 1)).join('\n');
        for (const v of reqDerivedVars) {
          if (new RegExp(`\\b${v}\\b`).test(windowText)) {
            offending.push(`${name} near line ${i + 1} shares a 3-line window with request-derived variable "${v}"`);
          }
        }
      });
    }
  }

  ok(offending.length === 0,
    `server.ts must never let a request-derived value (same line, or a named variable within ` +
    `${3} lines) reach the code that reads a rung-3 flag name (found: ${JSON.stringify(offending)})`);
}

console.log(`electronenv.contract.test.ts: ${checks} checks passed`);

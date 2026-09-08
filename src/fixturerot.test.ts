/**
 * No source-shape guard may carry a DEAD mutant plant.
 *
 * Many guards in this suite work by mutating a copy of a real source file and
 * asserting the check they just made now fails:
 *
 *     check('fixture: that check rejects the pre-fix shape',
 *       !RULE.test(app.replace("<a line of App.tsx>", "<the pre-fix line>")));
 *
 * The whole thing rests on the first argument still occurring in the file. Once
 * it does not, `.replace` is a silent no-op, the mutated copy equals the real
 * one, and the fixture passes for the wrong reason — it can no longer fail for
 * the reason it claims. That has happened twice on this branch alone (after the
 * save-form refactor and again after the Generate-note refactor), each time
 * caught by hand rather than by CI.
 *
 * So: in every `*.test.ts`, find the variables that hold a real file's contents
 * (`const app = readFileSync('src/App.tsx', 'utf8')`), take the string-literal
 * first argument of every `.replace(` applied to one of them, and require it to
 * occur in that tree. A plant that no longer matches fails HERE, by name, at the
 * moment it goes stale.
 *
 * Only file-backed receivers count. A test that mutates a fixture string it
 * declared itself (`scene.replace('while the other independently chooses', …)` in
 * unit.test.ts) is not this hazard — its plant is supposed to be absent from the
 * product — and counting it would produce noise that trains people to ignore this
 * file.
 *
 *   npx tsx src/fixturerot.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let failures = 0;
let cases = 0;
function check(name: string, cond: boolean, detail = ''): void {
  cases++;
  if (!cond) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const SKIP_EXT = /\.(png|jpe?g|gif|icns|ico|woff2?|ttf|zip|dmg)$/i;
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n').filter((f) => f && !SKIP_EXT.test(f));

/**
 * Every tracked text file EXCEPT the guards themselves, concatenated — a plant may
 * target any product source. Excluding `*.test.ts` is what makes this file able to
 * fail at all: a plant's text always occurs in the guard that spells it out, so a
 * haystack containing the guards matches every plant, stale or not. (Found by
 * mutation: with the guards included, deliberately breaking a plant was not
 * reported. That is precisely the "check that cannot fail for the reason it claims"
 * shape this file exists to catch, so it had to be caught here first.)
 */
const haystack = tracked
  .filter((f) => !f.endsWith('.test.ts'))
  .map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } })
  .join('\n \n');

/** Variables in this test that hold a real file's contents. */
function fileBackedVars(src: string): string[] {
  const out: string[] = [];
  const re = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*readFileSync\(/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) out.push(m[1]);
  return out;
}

/**
 * The string-literal first argument of every `.replace(` whose RECEIVER is one of
 * those variables — resolved properly, so a chain
 * (`app.replace(a, b).replace(c, d)`) counts for both links: from the `.replace(`
 * token, walk left; a `)` means skip its balanced group and the `.replace` before
 * it, and repeat; what remains must be the identifier.
 *
 * Template-literal and RegExp firsts are skipped: a regex plant that stops matching
 * is the same hazard, but its text is not a literal to look up, and a pattern this
 * file could not evaluate would be a check that cannot fail.
 */
function receiverOf(src: string, at: number): string | null {
  let i = at;
  for (let guard = 0; guard < 20; guard++) {
    while (i > 0 && /\s/.test(src[i - 1])) i--;
    if (src[i - 1] === ')') {
      let depth = 0;
      i--;
      while (i > 0) {
        const c = src[i];
        if (c === ')') depth++;
        else if (c === '(') { depth--; if (depth === 0) break; }
        i--;
      }
      // now at the '(' of that call; the token before it must be `.replace`
      const before = src.slice(Math.max(0, i - 8), i);
      if (!/\.replace$/.test(before)) return null;
      i -= 8;
      continue;
    }
    const m = /([A-Za-z_$][\w$]*)$/.exec(src.slice(Math.max(0, i - 64), i));
    return m ? m[1] : null;
  }
  return null;
}

function plantsIn(src: string, vars: readonly string[]): string[] {
  if (vars.length === 0) return [];
  const owned = new Set(vars);
  const out: string[] = [];
  const re = /\.replace\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const recv = receiverOf(src, m.index);
    if (recv === null || !owned.has(recv)) continue;
    let lit: string;
    try {
      lit = JSON.parse(`"${m[2].replace(/"/g, '\\"').replace(/\\'/g, "'")}"`) as string;
    } catch {
      continue;
    }
    // Short plants ("  " -> " ") are ordinary string munging, not source shapes.
    if (lit.length >= 25) out.push(lit);
  }
  return out;
}

const testFiles = tracked.filter((f) => f.endsWith('.test.ts'));
check('there are test files to scan (an empty scan would pass vacuously)', testFiles.length > 20, String(testFiles.length));

let planted = 0;
const stale: string[] = [];
for (const f of testFiles) {
  const src = readFileSync(f, 'utf8');
  for (const lit of plantsIn(src, fileBackedVars(src))) {
    planted++;
    if (!haystack.includes(lit)) stale.push(`${f}: ${JSON.stringify(lit.slice(0, 90))}`);
  }
}
// 29 file-backed plants across the suite today. The floor is a vacuity guard, not
// a target: it exists so that an extractor that silently stops matching (or a
// wholesale deletion of the source-shape guards) fails here instead of reporting a
// clean scan of nothing.
check('the scan found mutant plants to check (a 0-plant scan would pass vacuously)', planted >= 20, String(planted));
check('every mutant plant still occurs in the sources it mutates', stale.length === 0,
  stale.slice(0, 6).join('\n      '));

// The scanner itself must be able to see a stale plant — otherwise this whole
// file is a check that cannot fail. Two fixtures: one plant that is really in
// the tree, one that cannot be.
{
  const real = 'export function highlightWouldMatch(term: string, desc: string): boolean {';
  const fake = 'export function thisFunctionHasNeverExisted_STRUCT_REGEN_19(x: never): void {';
  check('fixture: a plant naming real source text is found', haystack.includes(real));
  check('fixture: a plant naming text that is not in the tree is reported stale', !haystack.includes(fake));
  const sample = `const app = readFileSync('src/App.tsx', 'utf8');\nconst x = app.replace("${real}", "else").replace("${real} two", "else");`;
  const sampleVars = fileBackedVars(sample);
  check('fixture: a readFileSync variable is recognised', sampleVars.join() === 'app', sampleVars.join());
  check('fixture: the extractor pulls plants out of a CHAINED .replace( on that variable',
    plantsIn(sample, sampleVars).length === 2 && plantsIn(sample, sampleVars)[0] === real,
    JSON.stringify(plantsIn(sample, sampleVars)));
  check('fixture: a .replace( on a string the TEST declared itself is not a plant',
    plantsIn(`const scene = 'a sentence the test wrote';\nscene.replace("${real}", "else");`, ['app']).length === 0);
  check('fixture: the extractor ignores a short .replace( that is ordinary munging',
    plantsIn('const app = readFileSync("x");\napp.replace("  ", " ");', ['app']).length === 0);
}

if (failures > 0) {
  console.error(`\n✗ ${failures} failure(s) of ${cases} checks`);
  process.exit(1);
}
console.log(`✓ fixturerot.test.ts: ${cases} checks — ${planted} mutant plants across ${testFiles.length} guards all still match their sources`);

/**
 * Guards BLUE-WEBKIT-CI (CodeRabbit outside-diff on #166, smoke.mjs:6647 —
 * "Do not mark skipped WebKit coverage as passing"). Two invariants on
 * src/e2e/smoke.mjs:
 *   1. `webkit.launch()` is called from exactly ONE place — the shared
 *      `launchWebkitOrSkip` helper — never an inline try/catch copy at a
 *      section's own call site.
 *   2. A skipped WebKit case is never recorded with `pass: true`/`record(...,
 *      true, ...)` — it must go through `recordSkip`, which the final
 *      summary tallies separately from "checks passed".
 * Mutation-tested: reverting either fix (reintroducing an inline
 * `webkit.launch()` copy, or a `record(<skip message>, true, ...)`) makes
 * this fail, by name, on the exact line reintroduced.
 *
 *   npx tsx src/webkitguard.test.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};

const smoke = readFileSync('src/e2e/smoke.mjs', 'utf8');

// ── Invariant 1: one launch site, and it lives inside the helper ───────────
const launchSites = [...smoke.matchAll(/webkit\.launch\(\)/g)];
check('smoke.mjs calls webkit.launch() from exactly one place', launchSites.length === 1,
  `found ${launchSites.length} at offsets ${launchSites.map((m) => m.index).join(', ')}`);

const helperMatch = /async function launchWebkitOrSkip\(label\) \{[\s\S]*?\n\}/.exec(smoke);
check('smoke.mjs defines the single launchWebkitOrSkip(label) helper', !!helperMatch);
if (helperMatch && launchSites.length === 1) {
  const [helperStart, helperEnd] = [helperMatch.index, helperMatch.index + helperMatch[0].length];
  const idx = launchSites[0].index!;
  check('the sole webkit.launch() call is inside launchWebkitOrSkip, not a section body',
    idx > helperStart && idx < helperEnd, `launch at ${idx}, helper spans [${helperStart}, ${helperEnd}]`);
}

// Every WebKit-guarded section must call the helper — reject the pre-fix
// per-site shape (`let webkitAvailable = true` ... `webkit.launch()` ...
// `catch { webkitAvailable = false }`) appearing ANYWHERE outside the helper
// definition itself.
const inlineCopyPattern = /webkitAvailable = true[\s\S]{0,60}webkit\.launch\(\)/g;
const inlineCopies = [...smoke.matchAll(inlineCopyPattern)].filter((m) => {
  if (!helperMatch) return true;
  return !(m.index! > helperMatch.index! && m.index! < helperMatch.index! + helperMatch[0].length);
});
check('no inline webkit.launch() try/catch copies remain outside the helper', inlineCopies.length === 0,
  `found ${inlineCopies.length} outside the helper`);

// Every call site uses the helper by name (§70, §75, §83 — the three sites
// the CodeRabbit finding named).
const callSites = [...smoke.matchAll(/launchWebkitOrSkip\('([^']+)'\)/g)].map((m) => m[1]);
check('all three WebKit sections (§70, §75, §83) call launchWebkitOrSkip',
  ['§70', '§75', '§83'].every((label) => callSites.includes(label)), `found calls for: ${callSites.join(', ') || '(none)'}`);

// ── Invariant 2: a skip is never recorded as a pass ─────────────────────────
// The pre-fix shape was exactly `record('...skipped...', true, ...)` — a
// literal `true` as the second argument on a message naming "skip". Search
// the whole file (not just the helper) so a regression anywhere is caught.
const passingSkipPattern = /record\(\s*[`'][^`']*\bskip(?:ped)?\b[^`']*[`']\s*,\s*true\b/i;
const passingSkip = passingSkipPattern.exec(smoke);
check('no record(...) call marks a "skip" message as pass:true', !passingSkip,
  passingSkip ? passingSkip[0].slice(0, 160) : '');

// The helper's own skip path must use recordSkip, not record.
if (helperMatch) {
  const helperBody = helperMatch[0];
  check('launchWebkitOrSkip records the local-skip path via recordSkip(...)', /recordSkip\(/.test(helperBody));
  check('launchWebkitOrSkip records the CI-failure path via record(..., false, ...)',
    /record\(\s*`[^`]*`\s*,\s*false\b/.test(helperBody));
}

// recordSkip itself must exist and must not push pass: true.
const recordSkipMatch = /function recordSkip\([\s\S]*?\n\}/.exec(smoke);
check('smoke.mjs defines recordSkip(name, detail)', !!recordSkipMatch);
if (recordSkipMatch) {
  check('recordSkip pushes a result that is excluded from the pass/fail tally (skip: true)',
    /skip:\s*true/.test(recordSkipMatch[0]));
}

// The final summary must exclude skips from both the denominator and the
// fail computation (a skip has pass: null, which `!pass` would wrongly count
// as a failure if summed in with the scored set).
const summaryMatch = /const finalResults = results\.filter[\s\S]*?process\.exit\(fails\.length \? 1 : 0\);/.exec(smoke);
check('the final summary computes a scored set that excludes skips before computing fails',
  !!summaryMatch && /scored = finalResults\.filter\(\(result\) => !result\.skip\)/.test(summaryMatch[0]));

// A skip must not make runSection's per-section pass/fail (and therefore its
// retry decision) treat the section as failed — `result.pass` alone is
// falsy for a skip (pass: null), so the `.every()` must explicitly allow
// `result.skip`. Without this a WebKit skip outside CI burns a full,
// pointless section retry every single run.
const runSectionMatch = /async function runSection\([\s\S]*?\n\}/.exec(smoke);
check('runSection exists', !!runSectionMatch);
if (runSectionMatch) {
  check('runSection\'s pass computation excludes skips (result.skip || result.pass), not result.pass alone',
    /attemptResults\.every\(\(result\) => result\.skip \|\| result\.pass\)/.test(runSectionMatch[0]));
}

console.log(failures === 0
  ? '✓ webkit guard: single launch site inside the helper, all three sections wired, skip is never recorded as pass'
  : `✗ webkit guard: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

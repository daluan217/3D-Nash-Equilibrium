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

// PR #188 CI exposed a WebKit-only race in §83's own oracle: the step counter
// was visible while the tour's smooth scroll / measured-card placement was
// still moving, so the test compared a transient pre-open box with the settled
// hidden box and failed twice even though visibility:hidden, inert, click
// blocking, and surface semantics all passed. Keep the exact geometry oracle,
// but require its baseline to come from the bounded stability helper first.
const section83Start = smoke.indexOf("section('83'");
const section84Start = smoke.indexOf("section('84'", section83Start);
const section83 = section83Start >= 0 && section84Start > section83Start
  ? smoke.slice(section83Start, section84Start)
  : '';
check('§83 defines a bounded settled-geometry helper for its WebKit baseline',
  /const stableTourControlRect = \(btn\)[\s\S]*document\.fonts\.status === 'loaded'[\s\S]*stableFrames >= 30[\s\S]*performance\.now\(\) >= deadline/.test(section83));
const hasSettledBaselineBeforeOpen = (source: string): boolean => {
  const stableBaseline = source.indexOf('const bbBefore = await stableTourControlRect(btn);');
  const surfaceOpen = source.indexOf('await openSurface(p);');
  return stableBaseline >= 0 && surfaceOpen >= 0 && stableBaseline < surfaceOpen;
};
check('§83 captures the settled tour-control baseline before opening each surface',
  hasSettledBaselineBeforeOpen(section83));
const unstabilizedMutant = section83.replace(
  'const bbBefore = await stableTourControlRect(btn);',
  'const bbBefore = await btn.boundingBox();',
);
check('mutation: restoring the transient boundingBox baseline fails the §83 stability contract',
  !hasSettledBaselineBeforeOpen(unstabilizedMutant));

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

  // OPUS-REVIEW-WEBKIT FIX-BEFORE-MERGE 1: every check above tests the SHAPE
  // (which function is called, where it's defined) but not the CONDITION
  // that picks between them. `if (process.env.CI)` -> `if (!process.env.CI)`
  // or `if (process.env.CI && process.env.STRICT_WEBKIT)` restores the exact
  // pre-#168 defect (WebKit never actually gated in CI) with every check
  // above still green. This pins the condition itself: the CI arm must FAIL
  // and the non-CI arm must SKIP, in that branch order.
  check('the CI arm FAILS and the non-CI arm SKIPS (the condition, not just the shapes)',
    /if \(process\.env\.CI\) \{\s*record\([\s\S]{0,240}?,\s*false\b[\s\S]{0,80}?\} else \{\s*recordSkip\(/
      .test(helperBody));
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
// CodeRabbit: checking that `scored` excludes skips is not enough on its own
// — a mutant that keeps `scored` correct but computes `fails` from
// `finalResults` (or any set other than `scored`) would still pass this
// check while skips are right back in the fail tally. Pin both halves.
check('the final summary computes a scored set that excludes skips before computing fails',
  !!summaryMatch
    && /scored = finalResults\.filter\(\(result\) => !result\.skip\)/.test(summaryMatch[0])
    && /\bfails\s*=\s*scored\.filter\(/.test(summaryMatch[0]));

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

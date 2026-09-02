/**
 * Every scenario-invention path in server.ts screens the same way.
 *
 * WHY. server.ts invents a scenario at three places — the rung-3 report path,
 * the tie path, and the `scenarioOnly` path behind the "New AI scenario"
 * button. They had drifted: the first two ran `scenarioIsClaimFree`, the third
 * did not. So the LOOSEST gate was also the only one with a retry, meaning it
 * got two draws through the weakest filter while the strictest got one.
 *
 * What made that user-visible is that the split was on the MATRIX, not on the
 * button. "New AI scenario" on a TIE game is served from the tie block and was
 * screened; on any other game it fell to `scenarioOnly` and was not. Ties are
 * 12.7% of a random sample, so roughly 87% of clicks on that button took the
 * weaker path — same button, same user, same model, different screening
 * because of something about the matrix the user never sees. Measured before
 * the fix: 4 of 4 known positives the report path rejects sailed through,
 * including a real "Col1 or Col2" draw rejected in the wild on the other path.
 *
 * This is a SOURCE contract, deliberately. The behaviour is only reachable
 * through a live provider call, so a behavioural test would need credentials
 * and would not run on every PR; the drift, though, is plainly visible in the
 * text. It is the same trade the cloudbuild contract makes.
 *
 * Known-positive fixtures below prove the check can fire, per repo policy —
 * four guards this round were found structurally unable to.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const server = readFileSync('server.ts', 'utf8');

/**
 * Each place that decides whether an invented scenario may be shown. Found by
 * the guard rather than by a hardcoded line number, so moving code cannot
 * silently drop a site out of the contract.
 */
function screeningSites(src: string): Array<{ full: string; decision: string }> {
  // The decision that gates ONE invented scenario, taken as a window running
  // backwards from the `validateScenario` call as well as forwards: two of the
  // three sites hoist the claim-free result into a local first
  // (`claimFreeOk`, `claimFree?.ok`), so a forward-only window reads as if the
  // screen were absent. That exact shape made the first draft of this file
  // report three false positives against correct code.
  const out: Array<{ full: string; decision: string }> = [];
  for (const m of src.matchAll(/validateScenario\([^)]*\)\.ok[\s\S]{0,600}?;/g)) {
    const back = src.slice(Math.max(0, m.index! - 400), m.index!);
    // `decision` is the boolean expression that actually gates the scenario;
    // `full` adds the preceding lines so a hoisted local is visible. The split
    // is load-bearing — see the dead-call check below.
    out.push({ full: back + m[0], decision: m[0] });
  }
  return out;
}

/**
 * Only the CLAIM-FREE surfaces are in scope, and the distinction is the whole
 * point rather than a carve-out.
 *
 * `generateScenario` is called with the rung-3 scenario prompt, which forbids
 * the description from asserting anything decidable because the solver states
 * all of it. Those sites MUST screen for claims.
 *
 * `generateReport` is the full-report path used at rungs 0-2, where the model
 * writes the mathematics itself and a description that makes claims is exactly
 * what was asked for. Those claims are checked against the matrix by the
 * declared-claims gates instead. Demanding `scenarioIsClaimFree` there would be
 * a false positive aimed straight at the rung-2/1/0 exploration Daniel has
 * queued — the no-numbers rule is true ONLY because the solver states every
 * number, i.e. only at rung 3.
 */
function isClaimFreeSurface(site: { full: string }): boolean {
  return /generateScenario\s*\(|inventScenario\s*\(/.test(site.full) || /claimFree/i.test(site.full);
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT IS NOW STRUCTURAL, AND STRONGER.
 *
 * This file used to check that three separate copies of the screen agreed. They
 * drifted anyway — three times, in three different properties. Screening was
 * unified in #56; the RETRY was not (the tie branch had none, so the SAME
 * BUTTON returned no story on 1.30% of tie-game presses and 0.00% of non-tie,
 * z=6.3 at n=3000 per cell); and the NASH_SCENARIO_CHECKS opt-out was read only
 * on paths production does not serve, so it was inert exactly where it was
 * meant to make the gate measurable.
 *
 * "Three copies that must agree" is the wrong contract, because it is satisfied
 * by three copies that agree on the property being checked and differ on the
 * next one. So there is now ONE screened, rerolled draw and every path goes
 * through it, and this file checks that this stays true: the helper runs all
 * three screens and lets each decide, and nothing reaches the raw draw around
 * it. That cannot drift, because there is only one of it.
 *
 * The synthetic fixtures further down are unchanged and still guard the old
 * shape — they are what would catch someone re-inlining a screen at a call site.
 * ──────────────────────────────────────────────────────────────────────────── */

// 1. The single screened draw exists; its body is what the rest of this checks.
const helper = server.match(/async function inventScreenedScenario\([\s\S]*?\n}\n/);
check('the one screened, rerolled draw exists', !!helper,
  'inventScreenedScenario is the single place a scenario is drawn and screened');
const helperBody = helper?.[0] ?? '';

// 2. Nothing bypasses it. `inventScenario` is the RAW draw; only the helper's
//    own deadline wrapper may call it. A new call site reaching past the helper
//    is exactly how the retry drifted last time, and it is invisible to any
//    test that only inspects responses.
const rawCallLines = server.split('\n')
  .map((line, n) => ({ line, n: n + 1 }))
  .filter(({ line }) => /\binventScenario\s*\(/.test(line)
    && !/function inventScenario/.test(line)
    && !/^\s*(\*|\/\/)/.test(line));
check('every scenario draw goes through the screened helper',
  rawCallLines.length <= 1,
  'raw inventScenario( calls outside the screened path: '
  + rawCallLines.map(({ line, n }) => `${n}: ${line.trim().slice(0, 70)}`).join(' | '));

// 3. All three screens run inside it, and each one gates the result.
for (const [name, re] of [
  ['the declarations gate', /validateScenario\s*\(/],
  ['the claim-free screen', /scenarioIsClaimFree\s*\(/],
  ['the direction checks', /validateProseDirections\s*\(/],
] as const) {
  check(`the screened draw runs ${name}`, re.test(helperBody), helperBody.slice(0, 160).replace(/\s+/g, ' '));
}
// PRESENCE IS NOT PARTICIPATION — the same distinction the per-site checks make.
check('the screened draw returns false on a claim-free failure',
  /claimFree\.ok[\s\S]{0,140}return false/.test(helperBody),
  'the claim-free call is present but its result never reaches the returned boolean');
// 4. The opt-out is honoured HERE, which is what makes it honoured everywhere.
check('the screened draw honours NASH_SCENARIO_CHECKS',
  /NASH_SCENARIO_CHECKS/.test(helperBody),
  'the flag promises each gate is measurable in isolation; it must be read where the gate runs');
// 5. And the reroll lives in it, so no branch can be the one without a second
//    draw. Two DIFFERENT instruments, both structurally required:
//      - a LOST draw (timeout/error/unparseable — no scenario at all) gets
//        exactly ONE retry, unconditionally (`usedTimeoutRetry` guards it).
//      - a GATE-DROPPED draw (a real draw the screen rejected) gets rerolled
//        up to the BOUNDED `NASH_SCENARIO_REROLLS` setting
//        (`gateRerollsUsed` against `SCENARIO_REROLL_LIMIT`), added
//        2026-09-02 after production shipped a report with no story on two
//        independent gate-drops in a row (~0.54% residual on the old
//        single-reroll shape, 2.7x the 0.2% ship bar).
//    `drawWithDeadline` appears ONCE in the source (inside a loop, so it can
//    fire more than once at RUNTIME) rather than as N literal call sites —
//    a call-count floor would defeat exactly that shape, so this checks for
//    the LOOP instead.
// CONTROL-FLOW-AWARE, not just identifier presence (a name mentioned in a
// comment or declared-but-unused would pass a bare /usedTimeoutRetry/.test):
// each check requires the counter actually GATE a branch (an `if` reading
// it) AND actually be MUTATED (the loop advancing it), which together are
// what makes it a real guard rather than dead code sitting next to a real
// one.
check('the screened draw retries a LOST draw exactly once, and stops on the second (guard READ)',
  /if\s*\(\s*usedTimeoutRetry\s*\)/.test(helperBody),
  'a draw that never produced a scenario at all must be retried once, then stop — no `if (usedTimeoutRetry)` found');
check('...and the retry is actually consumed (guard WRITTEN)',
  /usedTimeoutRetry\s*=\s*true/.test(helperBody),
  'usedTimeoutRetry is read but never set — the "exactly once" bound cannot hold');
check('the screened draw rerolls a GATE-DROPPED draw up to the bounded setting (guard READ)',
  /gateRerollsUsed\s*>=\s*SCENARIO_REROLL_LIMIT/.test(helperBody) && /SCENARIO_REROLL_LIMIT/.test(server),
  'a draw that came back but failed the screen must be rerolled up to NASH_SCENARIO_REROLLS — no '
  + '`gateRerollsUsed >= SCENARIO_REROLL_LIMIT` bound found');
check('...and the reroll count is actually consumed (guard WRITTEN)',
  /gateRerollsUsed\s*\+\+/.test(helperBody),
  'gateRerollsUsed is compared but never incremented — the loop cannot terminate on repeated gate-drops');
// The draw itself must sit inside a LOOP (not N literal call sites — a
// call-count floor would accept the OLD hand-unrolled two-call shape, which
// is exactly the bug this file exists to catch drifting back in).
check('the reroll happens inside a loop, so it can fire more than once at runtime',
  /for\s*\(\s*;;\s*\)[\s\S]*?drawWithDeadline\s*\(/.test(helperBody),
  'a lost or gate-rejected draw must be drawn again from INSIDE a loop — the only instrument permitted here '
  + '(a fixed second literal call site is the exact shape this contract must reject)');
// 6. The draw is bounded. A provider that accepts and never answers held a real
//    request open for 798 s with no timeout at any layer; the story is optional
//    by construction, so it gets a deadline and the report goes out without it.
check('the draw is bounded by a deadline', /function drawWithDeadline/.test(server)
  && /Promise\.race/.test(server),
  'an unanswered provider must not hold the user request open');

const allSites = screeningSites(server);
// A floor, or every check below is satisfied by a regex that stopped matching:
// hoist `validateScenario(...)` into a local before reading `.ok` off it and
// `allSites` goes to zero, the per-site loop never runs, and every "claim-free
// site N ..." check silently vanishes instead of failing.
check('the screening-site scan still finds the sites it reasons about',
  allSites.length > 0, 'screeningSites matched nothing in server.ts — the site checks below cannot fail');
const sites = allSites.filter(isClaimFreeSurface);
// NOTE: `sites` is legitimately [] against today's server.ts — the unification
// above collapsed the three inline call sites this scan was built for into the
// single `inventScreenedScenario` helper, whose internal statements sit further
// apart than this regex's window. The per-site loop below runs 0 times against
// real code today; it stays as regression insurance against someone re-inlining
// a screen at a call site, proven by the MUST_FLAG synthetic fixtures further
// down. A floor here would fail on correct code, so it is not added.
// The full-report path must still be OUT of scope, or this contract would fail
// the rung-0/1/2 code it has to leave alone.
check('the full-report path is out of scope',
  allSites.every((s2) => !/generateReport/.test(s2.full) || !isClaimFreeSurface(s2)));

for (const [i, site] of sites.entries()) {
  check(
    `claim-free site ${i + 1} runs the claim-free screen`,
    /scenarioIsClaimFree\s*\(/.test(site.full),
    'a scenario path that validates but does not screen for claims: the digit rule and '
    + 'every CLAIMY rule are skipped, so a description asserting something decidable reaches '
    + 'the user on that path only.\n' + site.full.slice(0, 220).replace(/\s+/g, ' '),
  );
  check(
    `claim-free site ${i + 1} honours NASH_DIRECTION_CHECKS`,
    /validateProseDirections\s*\(/.test(site.full),
    site.full.slice(-200).replace(/\s+/g, ' '),
  );
  // PRESENCE IS NOT PARTICIPATION. The two checks above find the CALL; this one
  // requires its RESULT to gate the decision. Without it the screen can be
  // unwired from the boolean while the call stays behind as dead code, and the
  // guard reports green — verified, not theorised: deleting `&& claimFree?.ok`
  // from a real site left every other assertion here passing, on this branch
  // AND on main. That is the same "a check that cannot fail for the reason it
  // claims" shape this file was written to prevent, living inside the file
  // itself.
  check(
    `claim-free site ${i + 1} lets the screen decide`,
    /claimFree|scenarioIsClaimFree/i.test(site.decision),
    'the claim-free call is present but its result never reaches the boolean that '
    + 'gates the scenario, so the screen runs and is discarded.\n'
    + site.decision.slice(0, 220).replace(/\s+/g, ' '),
  );
}

// The screen must be read as a boolean, never through a cast. `scenarioIsClaimFree`
// returns an object, so `&& scenarioIsClaimFree(x)` is ALWAYS truthy — a shape
// that reads as a check and screens nothing.
check(
  'the claim-free result is never used as a bare truthy value',
  !/&&\s*scenarioIsClaimFree\([^)]*\)\s*(?![.\s]*\.?ok)[;&)\n]/.test(server)
    && !/\(claimFree as any\)/.test(server),
  'scenarioIsClaimFree returns {ok, reason}; using it without .ok always passes',
);

/* --------------------------------------------------- known-positive fixtures */
const MUST_FLAG: Array<[string, string]> = [
  ['a claim-free site with no claim-free screen',
   'const r = await generateScenario(p, {}); const ok = validateScenario(sc, p).ok && other(sc);'],
  ['a claim-free site with no direction check',
   'const r = await generateScenario(p, {}); const ok = validateScenario(sc, p).ok && scenarioIsClaimFree(sc).ok;'],
  // The mutation that survived every other assertion in this file: the screen is
  // CALLED, its result is hoisted into a local, and the local never reaches the
  // boolean. Present, running, and screening nothing.
  ['a claim-free site whose screen result is discarded',
   'const r = await generateScenario(p, {}); const claimFree = scenarioIsClaimFree(sc);'
   + ' const ok = validateScenario(sc, p).ok && validateProseDirections(d, sc, p).length === 0;'],
];
for (const [name, src] of MUST_FLAG) {
  const found = screeningSites(src).filter(isClaimFreeSurface);
  check(`fixture "${name}" is located at all`, found.length === 1, `${found.length} sites`);
  const missingClaim = found.length === 1 && !/scenarioIsClaimFree\s*\(/.test(found[0].full);
  const missingDir = found.length === 1 && !/validateProseDirections\s*\(/.test(found[0].full);
  const deadCall = found.length === 1 && !/claimFree|scenarioIsClaimFree/i.test(found[0].decision);
  check(`fixture "${name}" is flagged`, missingClaim || missingDir || deadCall);
}
// The rung-0/1/2 report path must NOT be flagged: it is allowed to make claims.
check('the full-report shape is out of scope, not a failure',
  !screeningSites('const r = await generateReport(p, {}); const ok = validateScenario(r.suggestedScenario, p).ok;')
    .some(isClaimFreeSurface));
// Control: the correct shape must not be flagged.
{
  const good = 'const r = await generateScenario(p, {}); const ok = validateScenario(sc, p).ok && scenarioIsClaimFree(sc).ok'
    + " && (process.env.NASH_DIRECTION_CHECKS !== '1' || validateProseDirections(d, sc, p).length === 0);";
  const f = screeningSites(good).filter(isClaimFreeSurface);
  check('the correct shape is not flagged',
    f.length === 1 && /scenarioIsClaimFree/.test(f[0].full) && /validateProseDirections/.test(f[0].full)
    && /claimFree|scenarioIsClaimFree/i.test(f[0].decision));
}

if (failures > 0) { console.error(`✗ scenario paths: ${failures} failed`); process.exit(1); }
console.log(`✓ scenario paths: all ${sites.length} claim-free invention sites (of ${allSites.length} total) screen identically (validate + claim-free + directions), no bare-truthy read, fixtures flagged and control clean`);

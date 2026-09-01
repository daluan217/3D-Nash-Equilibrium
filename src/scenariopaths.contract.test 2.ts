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

const allSites = screeningSites(server);
check('every invention site is found', allSites.length >= 4, `found ${allSites.length}`);
const sites = allSites.filter(isClaimFreeSurface);
check('the claim-free surfaces are identified', sites.length >= 3, `found ${sites.length} of ${allSites.length}`);
// And the full-report path is correctly NOT treated as one, or this contract
// would fail the rung-0/1/2 code it must leave alone.
check('the full-report path is out of scope',
  allSites.some((s2) => /generateReport|suggestedScenario/.test(s2.full) && !isClaimFreeSurface(s2)));

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

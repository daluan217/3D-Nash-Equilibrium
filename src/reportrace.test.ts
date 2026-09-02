/**
 * A "verified against the solver" report must never be shown for a game
 * other than the one on screen.
 *
 * RED-APP-3 finding 001 (round 3, notes/RED-APP-3/001-stale-report-race-wrong-game.md):
 * `fetchLlmExplanation` had no staleness guard. Clicking "Explain this game",
 * then switching to a DIFFERENT preset before the (slow -- this app's own
 * history records an 838-second hang) response returned, rendered the OLD
 * game's prose and probabilities on top of the NEW game's matrix, under the
 * label "Every equilibrium named above was verified against the solver". The
 * report was real, server-validated output -- validated against the WRONG
 * game.
 *
 * REPRODUCED INDEPENDENTLY before this fix, against a locally built
 * `dist/server.cjs` run with real credentials (the shipping path, not the
 * no-key fallback): RED's exact repro script (delay `/api/report` 6s, click
 * "Explain this game" on Search Game, switch to Battle of the Sexes after
 * 500ms) showed Battle of the Sexes's matrix (2,1,0,0,0,0,1,2) on screen with
 * Search Game's "verified" mixed-equilibrium prose ("Search L"/"Hide L")
 * still rendered underneath -- twice, not a flake. Re-ran the identical
 * script against the FIXED build: the stale response is dropped and the
 * panel correctly falls back to "Explain this game" (unasked) for the new
 * game. That real-credential browser repro is NOT part of `npm test` (it
 * spends real model calls, same reason `LIVE_DEEP` browser checks in
 * src/e2e/live-smoke.mjs are opt-in) -- what follows are the two checks that
 * ARE free and CI-run: the pure comparison the fix is built on, and a
 * structural guard (same style as src/reportprose.test.ts) that the guard is
 * actually wired into both the success and failure paths of the fetch.
 *
 *   npx tsx src/reportrace.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { payoffsEqual } from './App';
import type { GamePayoffs } from './types';

let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

function payoffs(overrides: Partial<GamePayoffs> = {}): GamePayoffs {
  return { a11: 2, b11: 1, a12: 0, b12: 0, a21: 0, b21: 0, a22: 1, b22: 2, ...overrides };
}

// ── 1. payoffsEqual: the exact predicate the staleness guard is built on ────
ok(payoffsEqual(payoffs(), payoffs()), 'identical payoff sets (by value, different objects) must be equal');
ok(payoffsEqual(payoffs(), { ...payoffs() }), 'a spread copy must be equal to its source');
// The real-world pair from the reproduction: Search Game vs Battle of the
// Sexes. These must NOT compare equal -- if they did, the guard would let
// the stale Search Game response through onto the BoS matrix, which is
// exactly the defect.
const SEARCH_GAME = payoffs({ a11: 2, b11: -2, a12: 0, b12: 0, a21: 0, b21: 0, a22: 1, b22: -1 });
const BATTLE_OF_SEXES = payoffs({ a11: 2, b11: 1, a12: 0, b12: 0, a21: 0, b21: 0, a22: 1, b22: 2 });
ok(!payoffsEqual(SEARCH_GAME, BATTLE_OF_SEXES),
  'Search Game and Battle of the Sexes (the exact pair from the reproduction) must not compare equal');
// Every single field must be load-bearing -- a predicate that only checks
// SOME of the 8 numbers would silently pass some other pair of different
// games through the guard.
const FIELDS: (keyof GamePayoffs)[] = ['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'];
for (const field of FIELDS) {
  const base = payoffs();
  const changed = payoffs({ [field]: base[field] + 1 } as Partial<GamePayoffs>);
  ok(!payoffsEqual(base, changed), `changing only ${field} must make payoffsEqual return false`);
}

// ── 2. structural guard: the comparison is actually wired into the fetch ────
// Same style as src/reportprose.test.ts: there is no DOM test harness in this
// repo, and exercising the LIVE race needs a real, paid LLM call (see the
// header comment). What is checkable without either: that the guard
// (`payoffsEqual(requestPayoffs, payoffsRef.current)`) sits between the
// response arriving and EVERY state-setting statement that would put it on
// screen, in both the success and catch branches of fetchLlmExplanation.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'App.tsx'), 'utf8');

const fetchLlmStart = src.indexOf('const fetchLlmExplanation = async');
const fetchFreshStart = src.indexOf('const fetchFreshScenario = async');
ok(fetchLlmStart !== -1 && fetchFreshStart !== -1 && fetchLlmStart < fetchFreshStart,
  'fetchLlmExplanation must exist and precede fetchFreshScenario');
const body = src.slice(fetchLlmStart, fetchFreshStart);

ok(/const requestPayoffs = payoffs;/.test(body),
  'fetchLlmExplanation must snapshot the payoffs it was called for');
ok(/payoffsRef\.current = payoffs;/.test(src),
  'a ref tracking the LATEST payoffs must be kept current every render '
  + '(without it there is nothing fresher than the closure to compare against)');

// CodeRabbit finding (this branch): a total count of 2 does not prove ONE
// of them protects the catch path specifically -- two occurrences in the
// SUCCESS branch alone would satisfy a bare count check while a stale
// FAILED request still ran setLlmEnvelope(null) unguarded for whatever
// game is on screen now. Isolate the try-block's success section and the
// catch block SEPARATELY and check each in its own right.
const catchStart = body.indexOf('} catch {');
const finallyStart = body.indexOf('} finally {');
ok(catchStart !== -1 && finallyStart !== -1 && catchStart < finallyStart,
  'fetchLlmExplanation must have a catch block followed by a finally block');
const successSection = body.slice(0, catchStart);
const catchSection = body.slice(catchStart, finallyStart);
const finallySection = body.slice(finallyStart);

const GUARD_RE = /myGeneration !== requestGenerationRef\.current \|\| !payoffsEqual\(requestPayoffs, payoffsRef\.current\)/;
ok(GUARD_RE.test(successSection),
  'REGRESSION GUARD: the success branch must contain the combined generation + payoffs staleness check');
ok(GUARD_RE.test(catchSection),
  'REGRESSION GUARD: the catch branch, checked SEPARATELY from the success branch, must ALSO contain '
  + 'the combined staleness check -- a stale failed request must not paint an error over the current game');

// Ordering within EACH branch: the guard must run BEFORE that branch's own
// state-setting calls, not after -- checking staleness after already
// rendering/erroring would be too late.
const successGuardIdx = successSection.search(GUARD_RE);
const setEnvelopeIdx = successSection.indexOf('setLlmEnvelope(envelope)');
ok(successGuardIdx !== -1 && setEnvelopeIdx !== -1 && successGuardIdx < setEnvelopeIdx,
  'the staleness check must run BEFORE setLlmEnvelope(envelope) in the success branch, not after');

const catchGuardIdx = catchSection.search(GUARD_RE);
const catchSetNullIdx = catchSection.indexOf('setLlmEnvelope(null)');
ok(catchGuardIdx !== -1 && catchSetNullIdx !== -1 && catchGuardIdx < catchSetNullIdx,
  'the staleness check must run BEFORE setLlmEnvelope(null) in the catch branch, not after');

// ── 3. the generation-token mechanism (CodeRabbit finding: payoff equality
//      alone is not a sufficient identity check -- two DIFFERENT games can
//      share identical payoff numbers, and two requests for the SAME
//      unchanged game can still resolve out of order). A monotonic counter,
//      bumped both on a real identity change (payoffs effect) and at the
//      START of every individual request, closes both: kept alongside
//      payoffsEqual as a second, independent guard, not a replacement.
ok(/const requestGenerationRef = useRef\(0\);/.test(src),
  'requestGenerationRef must be declared');
// Bumped in the payoffs-change effect -- ANY identity change (including
// switching between two different games that happen to share numerically
// identical payoffs) invalidates whatever is in flight.
const payoffsEffectMatch = src.match(/useEffect\(\(\) => \{\s*requestGenerationRef\.current \+= 1;[\s\S]{0,400}?\}, \[payoffs\]\);/);
ok(!!payoffsEffectMatch,
  'the payoffs-change effect must bump requestGenerationRef, not just clear llmEnvelope/proseScenario');
ok(!!payoffsEffectMatch && /setLlmLoading\(false\); setScenarioLoading\(false\);/.test(payoffsEffectMatch[0]),
  'the payoffs-change effect must also reset the loading flags, so switching away from a game with a '
  + 'slow request in flight does not leave the report controls stuck disabled for the NEWLY selected game');
// Bump-THEN-capture inside fetchLlmExplanation itself -- reading without
// bumping would give two same-game requests (e.g. two Regenerate clicks)
// the IDENTICAL generation number, and the guard above would then be
// unable to tell which of the two responses is the more recent one.
ok(/const myGeneration = \(requestGenerationRef\.current \+= 1\);/.test(body),
  'REGRESSION GUARD: fetchLlmExplanation must BUMP requestGenerationRef when capturing myGeneration, '
  + 'not merely read it -- a read-only capture cannot distinguish two requests for the same unchanged game');
// The finally block must only clear the loading flag for the request that
// is STILL current -- a superseded request's finally must not clobber a
// newer, still-in-flight request's spinner.
ok(/if \(myGeneration === requestGenerationRef\.current\) setLlmLoading\(false\);/.test(finallySection),
  'the finally block must gate setLlmLoading(false) on the request still being current');

// ── 4. fetchFreshScenario ("New AI scenario") needs the SAME guard, and had
//      none of its own -- CodeRabbit finding on the fixup commit. Its
//      updater `setLlmEnvelope((prev) => prev?.report ? ... : prev)` only
//      proves SOME report exists when the response lands, not that it is
//      the SAME game's report: game A fires this, the user switches to
//      game B, game B gets its OWN report (so `prev?.report` is now
//      truthy again, just for B), and A's late scenario merges into B's
//      envelope. Isolate fetchFreshScenario's own body the same way as
//      fetchLlmExplanation's above.
const fetchFreshEnd2 = /\n  (const |function )/.exec(src.slice(fetchFreshStart + 40));
const freshBody = src.slice(fetchFreshStart, fetchFreshEnd2 ? fetchFreshStart + 40 + fetchFreshEnd2.index : fetchFreshStart + 3000);

ok(/const requestPayoffs = payoffs;/.test(freshBody),
  'REGRESSION GUARD: fetchFreshScenario must snapshot the payoffs it was called for, same as fetchLlmExplanation');
ok(/const myGeneration = \(requestGenerationRef\.current \+= 1\);/.test(freshBody),
  'REGRESSION GUARD: fetchFreshScenario must bump-then-capture its own generation number');

const freshGuardCount = (freshBody.match(/myGeneration !== requestGenerationRef\.current \|\| !payoffsEqual\(requestPayoffs, payoffsRef\.current\)/g) || []).length;
ok(freshGuardCount >= 2,
  `REGRESSION GUARD: the staleness check must appear at least twice in fetchFreshScenario `
  + `(once before touching state on the success path, once in the catch) -- found ${freshGuardCount}`);

// The success-path guard must run BEFORE setLlmEnvelope is ever called with
// the fetched scenario -- checking staleness after already merging it in
// would be too late. Isolated before fetchFreshScenario's own catch, same
// pattern as section 2 above.
const freshCatchStart = freshBody.indexOf('} catch {');
ok(freshCatchStart !== -1, 'fetchFreshScenario must have a catch block');
const freshSuccessSection = freshBody.slice(0, freshCatchStart);
const freshGuardIdx = freshSuccessSection.search(/myGeneration !== requestGenerationRef\.current \|\| !payoffsEqual\(requestPayoffs, payoffsRef\.current\)/);
const freshSetEnvelopeIdx = freshSuccessSection.indexOf('setLlmEnvelope((prev)');
ok(freshGuardIdx !== -1 && freshSetEnvelopeIdx !== -1 && freshGuardIdx < freshSetEnvelopeIdx,
  'the staleness check must run BEFORE fetchFreshScenario merges the new scenario into the envelope, not after');

// Director finding (this branch, second re-review): the aggregate count
// above does not prove the CATCH-path occurrence actually runs BEFORE
// that branch's own state-setting call -- two occurrences that are BOTH
// in the success section would satisfy a bare count check while the catch
// branch appends a "couldn't reach the server" log line for an abandoned
// game, unguarded. Isolate the catch section specifically (between
// `} catch {` and `} finally {`) and check its OWN guard ordering,
// independent of the success-path check above.
const freshFinallyIdxForCatch = freshBody.indexOf('} finally {');
ok(freshFinallyIdxForCatch !== -1, 'fetchFreshScenario must have a finally block');
const freshCatchSection = freshBody.slice(freshCatchStart, freshFinallyIdxForCatch);
const freshCatchGuardIdx = freshCatchSection.search(/myGeneration !== requestGenerationRef\.current \|\| !payoffsEqual\(requestPayoffs, payoffsRef\.current\)/);
const freshCatchSetLogIdx = freshCatchSection.indexOf('setLogEntries(');
ok(freshCatchGuardIdx !== -1 && freshCatchSetLogIdx !== -1 && freshCatchGuardIdx < freshCatchSetLogIdx,
  'REGRESSION GUARD: the staleness check must run BEFORE setLogEntries in fetchFreshScenario\'s catch '
  + 'branch specifically, not merely appear somewhere in the function -- a stale FAILED scenario '
  + 'request must not append a "couldn\'t reach the server" line about a game the user has since left');

// Its own finally must ALSO only clear scenarioLoading for the request
// that is still current, same reasoning as fetchLlmExplanation's finally.
const freshFinallyIdx = freshBody.indexOf('} finally {');
const freshFinallySection = freshFinallyIdx !== -1 ? freshBody.slice(freshFinallyIdx) : '';
ok(/if \(myGeneration === requestGenerationRef\.current\) setScenarioLoading\(false\);/.test(freshFinallySection),
  'fetchFreshScenario\'s finally block must gate setScenarioLoading(false) on the request still being current');

console.log(`reportrace.test.ts: ${checks} checks passed`);

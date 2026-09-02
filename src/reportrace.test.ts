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

const guardCount = (body.match(/payoffsEqual\(requestPayoffs, payoffsRef\.current\)/g) || []).length;
ok(guardCount >= 2,
  `REGRESSION GUARD: the staleness check must appear at least twice in fetchLlmExplanation `
  + `(once before the success-path setLlmEnvelope, once before the catch-path setLlmEnvelope) `
  + `-- found ${guardCount}`);

// The guard in the success path must come BEFORE the line that shows the
// report, not after -- checking staleness after already rendering it would
// be too late.
const successGuardIdx = body.indexOf('payoffsEqual(requestPayoffs, payoffsRef.current)');
const setEnvelopeIdx = body.indexOf('setLlmEnvelope(envelope)');
ok(successGuardIdx !== -1 && setEnvelopeIdx !== -1 && successGuardIdx < setEnvelopeIdx,
  'the staleness check must run BEFORE setLlmEnvelope(envelope), not after');

console.log(`reportrace.test.ts: ${checks} checks passed`);

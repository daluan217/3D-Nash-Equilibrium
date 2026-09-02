/**
 * BLUE-INPUT — the minimax widening, and the rung-3 prompt change that was
 * MEASURED AND REFUSED.
 *
 * Two subjects, one file, because both are the same lesson from opposite ends:
 * a sentence in the grounding payload is a factual assertion to the model, and
 * whether it earns its place is a question for measurement rather than reading.
 *
 *   npx tsx src/briefingclaims.test.ts
 */
import assert from 'node:assert';
import { describeGeometry, geometryBriefing } from './utils/geometry';
import { computeAllNE, PRESETS } from './utils/gameEngine';
import { SCENARIO_SYSTEM_PROMPT, buildGroundingPayload } from './utils/report';
import { describeStakes, stakesHint } from './utils/scenarioStakes';
import { validateReport } from './utils/nashValidator';
import type { GamePayoffs } from './types';

let checks = 0;
const check = (name: string, cond: boolean, detail = '') => {
  checks++;
  assert(cond, `FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
};

const EA = (g: GamePayoffs, x: number, y: number) =>
  x * y * g.a11 + x * (1 - y) * g.a12 + (1 - x) * y * g.a21 + (1 - x) * (1 - y) * g.a22;

/** A's security level: max over own mixtures of the worst B can do. */
function maximinA(g: GamePayoffs, steps = 100000): number {
  let best = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    const v = Math.min(EA(g, x, 0), EA(g, x, 1));
    if (v > best) best = v;
  }
  return best;
}

// ── 1. THE FALSEHOOD THAT WAS SHIPPING ──────────────────────────────────────
//
// KNOWN-POSITIVE FIXTURE. b = -a/3 - 4: not constant-sum (cell sums -6, -10,
// -8, 0), so the old predicate took the "there is NO single value" branch, and
// that was false. Verified here against an oracle that does not use
// describeGeometry at all.
const AFFINE_NEG: GamePayoffs = { a11: -3, a12: -9, a21: -6, a22: 6, b11: -3, b12: -1, b21: -2, b22: -6 };

check('fixture really is NOT constant-sum (so the old branch fired on it)',
  !describeGeometry(AFFINE_NEG).zeroSum && !describeGeometry(AFFINE_NEG).constantSum);
check('fixture is recognised as strictly competitive', describeGeometry(AFFINE_NEG).strictlyCompetitive);
check('fixture: minimax now applies', describeGeometry(AFFINE_NEG).minimaxApplies);
{
  // The independent oracle: a value exists iff every equilibrium pays A the
  // same and that amount is A's maximin.
  const pays = computeAllNE(AFFINE_NEG).map((ne) => EA(AFFINE_NEG, ne.x, ne.y));
  check('fixture: every equilibrium pays A the same', Math.max(...pays) - Math.min(...pays) < 1e-9,
    `payoffs ${JSON.stringify(pays)}`);
  check('fixture: that amount IS A\'s maximin', Math.abs(pays[0] - maximinA(AFFINE_NEG)) < 1e-3,
    `NE ${pays[0]} vs maximin ${maximinA(AFFINE_NEG)}`);
}
check('the briefing no longer denies the value on the fixture',
  !/there is NO single "value of the game"/.test(geometryBriefing(AFFINE_NEG)));
check('the briefing says minimax applies on the fixture',
  /the minimax framing applies/.test(geometryBriefing(AFFINE_NEG)));

// ── 2. NEGATIVE FIXTURES: correct behaviour that must NOT break ──────────────
//
// Battle of the Sexes is the control that makes the rule falsifiable: its
// equilibria pay A 1, 2 and 0.667, so there genuinely is no value and the
// original sentence is CORRECT. If the widening swallowed this, it would be
// asserting the opposite falsehood.
const BOS = PRESETS.bos as unknown as GamePayoffs;
check('CONTROL Battle of the Sexes is not strictly competitive', !describeGeometry(BOS).strictlyCompetitive);
check('CONTROL Battle of the Sexes still gets the NO-value sentence',
  /there is NO single "value of the game"/.test(geometryBriefing(BOS)));
{
  const pays = computeAllNE(BOS).map((ne) => EA(BOS, ne.x, ne.y));
  check('CONTROL: and that is right — its equilibria pay A DIFFERENT amounts',
    Math.max(...pays) - Math.min(...pays) > 0.5, `payoffs ${JSON.stringify(pays)}`);
}

// PRISONER'S DILEMMA — the negative fixture that exists because the FIRST
// oracle tried for this change got it wrong. "the unique equilibrium pays A
// their maximin" is true here (both players have a dominant strategy), so an
// oracle built on that fires on a game nobody would call competitive. Kept as a
// permanent negative fixture, per the standing rule that every false positive
// becomes one.
const PD = PRESETS.pd as unknown as GamePayoffs;
check('CONTROL prisoners dilemma is NOT strictly competitive', !describeGeometry(PD).strictlyCompetitive);
{
  const pays = computeAllNE(PD).map((ne) => EA(PD, ne.x, ne.y));
  check('CONTROL prisoners dilemma DOES satisfy the naive oracle — which is why it is here',
    Math.abs(pays[0] - maximinA(PD)) < 1e-3);
}

check('k > 0 (common interest) is not competitive',
  !describeGeometry({ a11: 1, a12: 2, a21: 3, a22: 4, b11: 2, b12: 4, b21: 6, b22: 8 }).strictlyCompetitive);
check('A flat everywhere is excluded (k is undefined, not negative)',
  !describeGeometry({ a11: 2, a12: 2, a21: 2, a22: 2, b11: 1, b12: 4, b21: -2, b22: 7 }).strictlyCompetitive);
check('a NEAR-miss is not a strategic equivalence (one cell off by 0.01)',
  !describeGeometry({ ...AFFINE_NEG, b22: -5.99 }).strictlyCompetitive);

// ── 3. MUTATION: each guard is load-bearing ─────────────────────────────────
//
// Re-implemented locally so the mutants can be applied. Each mutant must FAIL
// at least one fixture above; a guard whose removal changes nothing is not a
// guard. (The k<0 test is the reason this is not just "b is affine in a".)
{
  const EPSL = 1e-9;
  const fit = (g: GamePayoffs, opts: { allowNonNegK?: boolean; skipFlatGuard?: boolean; skipExactness?: boolean }) => {
    const a = [g.a11, g.a12, g.a21, g.a22];
    const b = [g.b11, g.b12, g.b21, g.b22];
    const j = a.findIndex((v) => Math.abs(v - a[0]) > EPSL);
    if (j < 0) return opts.skipFlatGuard ? true : false;
    const k = (b[j] - b[0]) / (a[j] - a[0]);
    if (!opts.allowNonNegK && !(k < -EPSL)) return false;
    const c = b[0] - k * a[0];
    if (opts.skipExactness) return true;
    return a.every((ai, i) => Math.abs(b[i] - (k * ai + c)) <= 1e-9 * (1 + Math.abs(b[i])));
  };
  check('MUTANT dropping the k<0 test wrongly accepts common-interest b = 2a',
    fit({ a11: 1, a12: 2, a21: 3, a22: 4, b11: 2, b12: 4, b21: 6, b22: 8 }, { allowNonNegK: true }));
  check('MUTANT dropping the flat-A guard wrongly accepts an everywhere-indifferent A',
    fit({ a11: 2, a12: 2, a21: 2, a22: 2, b11: 1, b12: 4, b21: -2, b22: 7 }, { skipFlatGuard: true }));
  check('MUTANT dropping the exact-fit test wrongly accepts the 0.01 near-miss',
    fit({ ...AFFINE_NEG, b22: -5.99 }, { skipExactness: true }));
  check('and the SHIPPED predicate rejects all three',
    !fit({ a11: 1, a12: 2, a21: 3, a22: 4, b11: 2, b12: 4, b21: 6, b22: 8 }, {})
    && !fit({ a11: 2, a12: 2, a21: 2, a22: 2, b11: 1, b12: 4, b21: -2, b22: 7 }, {})
    && !fit({ ...AFFINE_NEG, b22: -5.99 }, {}));
}

// ── 4. THE GATE MOVES WITH THE FIELD, BOTH DIRECTIONS ───────────────────────
//
// nashValidator reads `geo.minimaxApplies` and the check is one-way, so
// widening can only ever REMOVE a rejection. BLUE-GATE asked for this fixture
// in both directions, because one direction alone cannot fail.
{
  const report = (g: GamePayoffs, invokesMinimax: boolean) => ({
    prose: 'x', claimedEquilibria: computeAllNE(g).map((n) => ({ type: n.type as 'pure' | 'mixed', x: n.x, y: n.y })),
    suggestedScenario: null, proseClaims: null,
    geometryClaims: { invokesMinimax, saysZeroSum: null, saysDominant: null, saysInteriorFlatSpot: null },
  });
  const kinds = (g: GamePayoffs, claim: boolean) =>
    (validateReport(report(g, claim) as never, g).mismatches ?? []).map((m: { kind: string }) => m.kind);
  check('claiming minimax on the strictly-competitive fixture is now ACCEPTED',
    !kinds(AFFINE_NEG, true).includes('geometry-bad-minimax'), JSON.stringify(kinds(AFFINE_NEG, true)));
  check('claiming minimax on Battle of the Sexes is STILL rejected',
    kinds(BOS, true).includes('geometry-bad-minimax'), JSON.stringify(kinds(BOS, true)));
}

// ── 5. BYTE-IDENTITY WHERE THE OLD SENTENCE WAS ALREADY TRUE ────────────────
//
// The whole point of gating the new branch on `!zeroSum && !constantSum`: every
// game outside the newly-true class must get the exact string it got before.
// The old text is pinned here verbatim so a future edit to either branch has to
// come past this test.
{
  const OLD_TRUE_ZERO = "  This game is zero-sum, so it HAS a value in von Neumann's sense and the minimax framing applies.";
  const OLD_TRUE_CONST = "  This game is constant-sum, so it HAS a value in von Neumann's sense and the minimax framing applies.";
  const OLD_FALSE = '  This game is NOT zero-sum or constant-sum, so there is NO single "value of the game" and the minimax framing does NOT apply. Do not call the equilibrium a minimax value.';
  check('zero-sum games keep the ORIGINAL sentence, verbatim',
    geometryBriefing(PRESETS.search as unknown as GamePayoffs).includes(OLD_TRUE_ZERO));
  check('constant-sum-but-not-zero-sum games keep the ORIGINAL sentence, verbatim',
    geometryBriefing({ a11: 3, a12: 1, a21: 4, a22: 2, b11: 2, b12: 4, b21: 1, b22: 3 }).includes(OLD_TRUE_CONST));
  check('ordinary non-competitive games keep the ORIGINAL sentence, verbatim',
    geometryBriefing(BOS).includes(OLD_FALSE));

  // All seven presets are outside the newly-true class, so not one of them
  // moves. This is the "no preset user ever saw the false sentence" claim,
  // asserted rather than asserted-about.
  const movedPresets = Object.entries(PRESETS).filter(([, p]) => {
    const geo = describeGeometry(p as unknown as GamePayoffs);
    return geo.strictlyCompetitive && !geo.zeroSum && !geo.constantSum;
  });
  check('no preset is in the newly-true class', movedPresets.length === 0,
    movedPresets.map(([k]) => k).join(','));

  // Reach, over a corpus that INCLUDES the one range where the class is
  // reachable — a byte-identity sweep that never exercises the moving branch
  // would prove nothing.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  let wide = 0; let narrow = 0;
  const isNew = (g: GamePayoffs) => { const d = describeGeometry(g); return d.strictlyCompetitive && !d.zeroSum && !d.constantSum; };
  for (let i = 0; i < 20000; i++) {
    if (isNew({ a11: ri(-9, 9), a12: ri(-9, 9), a21: ri(-9, 9), a22: ri(-9, 9), b11: ri(-9, 9), b12: ri(-9, 9), b21: ri(-9, 9), b22: ri(-9, 9) })) wide++;
    if (isNew({ a11: ri(-3, 3), a12: ri(-3, 3), a21: ri(-3, 3), a22: ri(-3, 3), b11: ri(-3, 3), b12: ri(-3, 3), b21: ri(-3, 3), b22: ri(-3, 3) })) narrow++;
  }
  check('the branch is genuinely REACHABLE (else this whole file is vacuous)', narrow > 0, `int[-3,3] hits ${narrow}`);
  check('and it stays rare on the wide range', wide / 20000 < 0.01, `int[-9,9] ${wide}/20000`);
}

// ── 6. THE RUNG-3 PARAGRAPH: A REFUSAL, PINNED ──────────────────────────────
//
// SCENARIO_SYSTEM_PROMPT opens with a paragraph conditional on "if the request
// says the description must be claim-free", and NOTHING production sends says
// it: `framingGuidance` is declared on generateReport and passed by no caller,
// so generateScenario has no channel into the request at all. It reads dead,
// and the payload's invention block asks for the very numbers
// `scenarioIsClaimFree` discards. Removing it is the obvious tidy-up.
//
// IT IS NOT DEAD, AND REMOVING IT WAS MEASURED AT A REAL COST. Candidate =
// paragraph deleted + the invention block's "state that cell's numbers" offer
// dropped on the scenario-only path. Real path, gpt-5.6-luna pinned, domain
// from pickScenarioDomain, stakes on, no reasoning argument, judged by the
// shipped screen set:
//
//   seed 90301, 25 games, PAIRED on identical (game, domain):
//     production 25/25 pass      candidate 17/25 pass
//     8 discordant pairs, ALL production-passes-candidate-fails
//     McNemar exact p = 0.0078
//   pooled with seed 90201: production 42/42, candidate 36/45
//
// Every candidate failure was a META leak the paragraph had been suppressing —
// "Player A" in the story, a bare letter as a character, the word payoff — even
// though its stated condition was never met. A conditional instruction still
// shapes the output; "the trigger never fires" is not the same as "the text
// does nothing".
//
// Separately: emitting the trigger instead is NOT supported either. My 20 pairs
// suggested it hurt (17/17 vs 13/16) but that is p = 0.10, and RED-INPUT's 40
// pairs found no difference (36/39 vs 35/37, p = 1.0). Pooled, it is a null.
// And the numeral the contradiction is about never appears: 0 in 3,213 cloud
// descriptions (3,104 unfiltered teacher rows + both our runs).
//
// So the prompt is LEFT EXACTLY AS IT IS, and this test pins it, because the
// next reader will reach the same "this is dead code" conclusion I did.
check('the rung-3 conditional paragraph is still present — deleting it cost 8/25 stories, see above',
  SCENARIO_SYSTEM_PROMPT.startsWith('RUNG-3 MODE')
  && SCENARIO_SYSTEM_PROMPT.includes('if the request says the description must be claim-free'));
check('the invention block still offers the cell-numbers branch, for the same measured reason',
  buildGroundingPayload({ a11: 3, a12: -1, a21: 0, a22: 2, b11: 1, b12: 2, b21: 3, b22: -2 })
    .includes("state that cell's numbers and cite the cell, or leave the outcome unsaid"));

console.log(`✓ geometry/minimax + rung-3 refusal: ${checks} checks passed`);

// ── 7. THE playerGap LINE: THE ONE FALSEHOOD WE AUTHORED OURSELVES ──────────
//
// "Player B has far more riding on this than Player A" is decidable from the
// matrix printed beside the story, and the statistic behind it did not mean
// what the words mean. `swingA`/`swingB` measure how far a party's OWN choice
// moves their own payoff; "riding on this" is about exposure to the OUTCOME.
// The line now fires only when both readings name the same party.
//
// This section is the reason the whole file exists: every other gate in this
// repo checks the MODEL against us. Here the model was obeying us exactly and
// we were the ones asserting something false.
{
  // KNOWN-POSITIVE FIXTURE — RED-INPUT's case, re-derived. A's outcomes span
  // -8..7; B's span 3..8, so B cannot lose under any pair of choices. But
  // swingA = 1 and swingB = 5, so the old line named B as the exposed party.
  const FORCED: GamePayoffs = { a11: -8, a12: 6, a21: -8, a22: 7, b11: 3, b12: 8, b21: 4, b22: 3 };
  const s = describeStakes(FORCED);
  const rangeOf = (v: number[]) => Math.max(...v) - Math.min(...v);
  check('fixture: B cannot lose — every outcome for B is above every loss A can take',
    Math.min(FORCED.b11, FORCED.b12, FORCED.b21, FORCED.b22) > 0
    && Math.min(FORCED.a11, FORCED.a12, FORCED.a21, FORCED.a22) < 0);
  check('fixture: A is far more exposed by RANGE',
    rangeOf([FORCED.a11, FORCED.a12, FORCED.a21, FORCED.a22]) > rangeOf([FORCED.b11, FORCED.b12, FORCED.b21, FORCED.b22]));
  check('fixture: but B has the larger own-decision SWING — the two readings conflict',
    s.swingB > s.swingA);
  check('fixture: the gap is above threshold, so the line WOULD have fired', s.playerGap >= 4);
  check('fixture: the line is now WITHHELD rather than pointed at the wrong party',
    !/riding on this/.test(stakesHint(FORCED)), stakesHint(FORCED));

  // NEGATIVE FIXTURE — the line must still fire, unchanged, when the readings
  // agree. Without this the "fix" could be `return ''` and still pass.
  // swingA = |10 - -10| = 20 and rangeA = 20; swingB = |1 - 0| = 1 and rangeB = 1.
  // Both readings name A, so nothing about this game changes.
  const AGREE: GamePayoffs = { a11: 10, a12: 10, a21: -10, a22: -10, b11: 1, b12: 0, b21: 1, b22: 0 };
  const sa = describeStakes(AGREE);
  check('CONTROL: a game where both readings name A', sa.swingA > sa.swingB && sa.playerGap >= 4
    && rangeOf([AGREE.a11, AGREE.a12, AGREE.a21, AGREE.a22]) > rangeOf([AGREE.b11, AGREE.b12, AGREE.b21, AGREE.b22]));
  check('CONTROL: the line still fires there, with the ORIGINAL wording verbatim',
    stakesHint(AGREE).includes('Player A has far more riding on this than Player B — make that difference in exposure part of who the two parties are.'),
    stakesHint(AGREE));

  // MUTATION: the agreement guard is load-bearing in BOTH directions.
  const wouldFire = (g: GamePayoffs, requireAgreement: boolean) => {
    const st = describeStakes(g);
    const bySwing = st.swingA >= st.swingB ? 'A' : 'B';
    const rA = rangeOf([g.a11, g.a12, g.a21, g.a22]); const rB = rangeOf([g.b11, g.b12, g.b21, g.b22]);
    const byRange = rA > rB ? 'A' : rB > rA ? 'B' : null;
    return st.playerGap >= 4 && (!requireAgreement || byRange === bySwing);
  };
  check('MUTANT without the agreement guard fires on the fixture (the shipped defect)',
    wouldFire(FORCED, false));
  check('and WITH the guard it does not', !wouldFire(FORCED, true));
  check('MUTANT: the guard does not simply silence everything — the control still fires',
    wouldFire(AGREE, true) && wouldFire(AGREE, false));

  // COST, and the byte-identity claim, over a corpus rather than an anecdote.
  let seed = 555;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  let fires = 0; let conflict = 0;
  for (let i = 0; i < 20000; i++) {
    const g: GamePayoffs = { a11: ri(-9, 9), a12: ri(-9, 9), a21: ri(-9, 9), a22: ri(-9, 9), b11: ri(-9, 9), b12: ri(-9, 9), b21: ri(-9, 9), b22: ri(-9, 9) };
    if (wouldFire(g, false)) { fires++; if (!wouldFire(g, true)) conflict++; }
  }
  check('the conflicting class is REACHABLE (else this section is vacuous)', conflict > 0, `${conflict}`);
  check('and it is a minority of firings — the line keeps most of its reach',
    conflict / fires < 0.35, `${conflict}/${fires} = ${((conflict / fires) * 100).toFixed(1)}%`);
}

console.log('✓ playerGap agreement guard: fixture, control, mutants and reach all checked');

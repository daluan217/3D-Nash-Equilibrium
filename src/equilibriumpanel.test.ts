/**
 * The equilibrium panel must not contradict itself.
 *
 * Every check here is written against the SHIPPED `indifferenceLines` /
 * `neValues`, and every one of them FAILS on the code this branch replaced. The
 * negative fixtures that prove that are kept in the file rather than described,
 * because the repo's standing lesson is that an assertion which passes against
 * the defect it was written for is worse than no assertion.
 *
 *   npx tsx src/equilibriumpanel.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PRESETS, computeAllNE, computeMixedNE, doStep, resolveProfile, indifferenceAt,
  EA, EB, r3, fmtPayoff, payoffTexRhs, neTolerancePlayer,
} from './utils/gameEngine';
import { indifferenceLines, indifferenceLine, neValues } from './components/equilibriumPanel';
import type { GamePayoffs, SimState, NashEquilibrium } from './types';

const here = dirname(fileURLToPath(import.meta.url));
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

function preset(key: string): GamePayoffs {
  const p = (PRESETS as unknown as Record<string, Partial<GamePayoffs>>)[key];
  const g = {
    a11: p.a11 ?? 0, a12: p.a12 ?? 0, a21: p.a21 ?? 0, a22: p.a22 ?? 0,
    b11: p.b11 ?? 0, b12: p.b12 ?? 0, b21: p.b21 ?? 0, b22: p.b22 ?? 0,
  } as GamePayoffs;
  // `?? 0` would silently turn a renamed preset into the all-zero game, which
  // has an equilibrium everywhere and would make every check below pass.
  ok(Object.values(g).some((v) => v !== 0), `preset "${key}" must exist and be non-trivial`);
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE PRESET A REVIEWER CLICKS
//
// Search Game's unique equilibrium is x* = y* = 1/3 with both row payoffs
// EXACTLY 2/3 and both column payoffs exactly -2/3. Nothing here is a rounding
// judgement call, which is what makes it the right fixture: the panel either
// prints one number on both sides of `≈` or it is wrong.
// ─────────────────────────────────────────────────────────────────────────────
{
  const g = preset('search');
  const mn = computeMixedNE(g)!;
  ok(mn !== null && Math.abs(mn.x - 1 / 3) < 1e-12 && Math.abs(mn.y - 1 / 3) < 1e-12,
    `Search Game NE must be (1/3, 1/3), got ${JSON.stringify(mn)}`);

  const L = indifferenceLines(g, mn.x, mn.y);
  ok(L.a.indifferent && L.b.indifferent, 'both players are indifferent at Search Game\'s NE');
  ok(L.a.pStr === '0.667' && L.a.qStr === '0.667',
    `Search Game A line must read 0.667 on BOTH sides, got ${L.a.pStr} / ${L.a.qStr}`);
  ok(L.b.pStr === '-0.667' && L.b.qStr === '-0.667',
    `Search Game B line must read -0.667 on BOTH sides, got ${L.b.pStr} / ${L.b.qStr}`);

  // The headline row and the line under it must be the same number. This is the
  // referee-visible claim: at a mixed NE, E[A] IS E[Row 1] IS E[Row 2].
  ok(payoffTexRhs(EA(mn.x, mn.y, g)) === `${L.a.pRel} ${L.a.pStr}`,
    `E[A] and E[Row 1] must render identically, got "${payoffTexRhs(EA(mn.x, mn.y, g))}" vs "${L.a.pRel} ${L.a.pStr}"`);
  ok(payoffTexRhs(EB(mn.x, mn.y, g)) === `${L.b.pRel} ${L.b.pStr}`,
    `E[B] and E[Col 1] must render identically, got "${payoffTexRhs(EB(mn.x, mn.y, g))}" vs "${L.b.pRel} ${L.b.pStr}"`);

  // MUTATION / NEGATIVE FIXTURE — the defect itself, verbatim.
  // The shipped panel used to feed `simState.cx`/`cy`, which `doStep` has already
  // pushed through r3. If the assertions above could not tell the two coordinate
  // sources apart they would be worthless, so prove they can.
  //
  // Under the OLD (tolerance-driven) ≈ rule this printed "0.666 ≈ 0.667" — an
  // approximate-equality assertion between two DIFFERENT numbers, because
  // `neTolerancePlayer` on this preset's spread comfortably covers the 0.001
  // quantisation gap. Under the DISPLAY-anchored rule (director decision,
  // 2026-09-02, "Option B") a 0.001 gap is >= the 5e-4 display-resolution
  // threshold, so the SAME coordinate bug now renders as an honest — if
  // wrong-ROOT-CAUSE — STRICT inequality instead: never an approximate-equality
  // assertion between two numbers that read differently. This is a real,
  // structural consequence of Option B, not a relaxation of the fixture.
  const bad = indifferenceLines(g, r3(mn.x), r3(mn.y));
  ok(bad.a.pStr === '0.666' && bad.a.qStr === '0.667',
    `the 3dp coordinate must still reproduce the shipped gap (0.666 vs 0.667), got ${bad.a.pStr} / ${bad.a.qStr}`);
  ok(bad.b.pStr === '-0.666' && bad.b.qStr === '-0.667',
    `the 3dp coordinate must still reproduce the shipped B gap, got ${bad.b.pStr} / ${bad.b.qStr}`);
  ok(!bad.a.indifferent && bad.a.relation === '<',
    `THE FIX: a >=5e-4 gap must never be asserted "≈" any more, got indifferent=${bad.a.indifferent} relation=${bad.a.relation}`);
  ok(bad.a.pStr !== bad.a.qStr,
    'the coordinate bug is still visibly WRONG (different numbers), just no longer self-contradictory (no ≈)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b. A SUB-RESOLUTION PAYOFF UNDER `≈` MUST NOT ASSERT "0.000"
//
// `three()` (the panel's own 3dp formatter) collapsed a nonzero value below
// display resolution to a bald "0.000"/"-0.000" — the same false-precision
// defect `fmtPayoff`/`payoffTexRhs` were already fixed for one layer up, just
// never ported to this one remaining formatter. Fixed by routing the ≈ branch
// through `payoffTexRhs` itself (split into operator + magnitude) rather than
// re-deriving 3dp rounding, so the line and the headline are the same call.
// ─────────────────────────────────────────────────────────────────────────────
{
  const tiny = 0.0002; // nonzero; r3(0.0002) === 0
  const posBoth = indifferenceLine('Row 1', 'Row 2', tiny, tiny);
  ok(posBoth.pRel === '<' && posBoth.pStr === '0.001' && posBoth.qRel === '<' && posBoth.qStr === '0.001',
    `a tiny POSITIVE indifferent payoff must read "< 0.001" on both sides, got ${JSON.stringify(posBoth)}`);
  ok(!/0\.000/.test(posBoth.tex), `THE DEFECT: a nonzero payoff must never render as 0.000, got tex="${posBoth.tex}"`);

  const negBoth = indifferenceLine('Row 1', 'Row 2', -tiny, -tiny);
  ok(negBoth.pRel === '>' && negBoth.pStr === '-0.001' && negBoth.qRel === '>' && negBoth.qStr === '-0.001',
    `a tiny NEGATIVE indifferent payoff must read "> -0.001" on both sides, got ${JSON.stringify(negBoth)}`);
  ok(!/-0\.000/.test(negBoth.tex), `THE DEFECT: a tiny negative payoff must never render as -0.000, got tex="${negBoth.tex}"`);

  // The headline formula must be reconstructible from pRel/pStr exactly —
  // this IS the "one rendering of one quantity" contract the fix exists for.
  ok(payoffTexRhs(tiny) === `${posBoth.pRel} ${posBoth.pStr}`,
    `the line's own operator+value must equal payoffTexRhs's, got "${posBoth.pRel} ${posBoth.pStr}" vs "${payoffTexRhs(tiny)}"`);

  // An EXACT zero, and an ordinary value, must be untouched by this fix.
  const exactZero = indifferenceLine('Row 1', 'Row 2', 0, 0);
  ok(exactZero.pRel === '=' && exactZero.pStr === '0', `an exact zero must read "= 0", got ${JSON.stringify(exactZero)}`);
  const ordinary = indifferenceLine('Row 1', 'Row 2', 2 / 3, 2 / 3);
  ok(ordinary.pRel === '=' && ordinary.pStr === '0.667', `an ordinary value must still read "= 0.667", got ${JSON.stringify(ordinary)}`);

  // THE MIDPOINT-SHARING TRAP, REVISED (RED-MATH-5 finding 001, round 5).
  //
  // This fixture used to require p and q straddling zero to KEEP their own
  // independently-rounded directional strings ("< 0.001" / "> -0.001"),
  // reasoning that sharing the midpoint (exactly 0 here) would print "= 0"
  // for a quantity that is not zero on either side. That was itself a
  // defect: gating the collapse on `pRel === '=' && qRel === '='` left the
  // sub-resolution band rendering TWO INDEPENDENTLY-ROUNDED strings, and at
  // a genuine mixed-NE indifference point (whose TRUE value is exactly 0 by
  // definition) ~1e-16 float noise routinely lands the two independent
  // expressions on OPPOSITE sides of zero — producing exactly what Option B
  // exists to forbid: "≈" between two DIFFERENT printed numbers ("-0.001"
  // vs "0.001"). See `_gen/redmath5_minimal_repro.ts` for the real-game
  // repro (A=[[-3,2],[6,-4]], B=[[5,1],[-7,1]]) and section 9 below.
  //
  // The fix shares ONE rendering unconditionally whenever `indifferent` is
  // true — sub-resolution or not — so this exact contrived case (a REAL,
  // non-noise ~4e-4 gap) now ALSO collapses to a single "= 0", the same
  // outcome RED's own finding proposed ("a single honest '0' ... instead of
  // two conflicting ones"). The two sides can never again print different
  // digits under `≈`: that is the invariant this file now enforces (section
  // 9), not "sub-resolution keeps its own wording".
  const straddle = indifferenceLine('Row 1', 'Row 2', 0.0002, -0.0002);
  ok(straddle.pStr === straddle.qStr && straddle.pRel === straddle.qRel,
    `THE FIX: both sides of an indifferent line must always print identically, got tex="${straddle.tex}"`);
  ok(straddle.pRel === '=' && straddle.pStr === '0',
    `the shared midpoint here is exactly 0, so both sides read "= 0", got ${JSON.stringify(straddle)}`);
  // The ulp-noise case that midpoint-sharing exists FOR must still collapse.
  const ulp = indifferenceLine('Row 1', 'Row 2', 2 * (1 / 3), 1 - (1 / 3));
  ok(ulp.pRel === '=' && ulp.pStr === '0.667' && ulp.qRel === '=' && ulp.qStr === '0.667',
    `a genuine float-dust pair must still share the midpoint, got ${JSON.stringify(ulp)}`);

  // THE CASE THAT USED TO SPLIT: opposite-sign float noise around an exact
  // zero, with NO anchor supplied (the isolated-call path). Without an
  // anchor the shared value is the plain midpoint, which for near-zero noise
  // still lands near zero and renders identically on both sides — the
  // defect (pStr !== qStr) is what must be gone, not any specific string.
  const noise = indifferenceLine('Row 1', 'Row 2', -2.220446049250313e-16, 4.440892098500626e-16);
  ok(noise.pStr === noise.qStr && noise.pRel === noise.qRel,
    `THE DEFECT ITSELF (RED-MATH-5 001): float noise around an exact 0 must not split, got tex="${noise.tex}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE OTHER TWO PRESETS THAT RENDER THE PANEL
//
// BoS / PD / Cops converge pure, so the mixed panel never appears for them.
// Spy vs. Analyst and Penalty Kick do, in all four mover x method combinations,
// and both printed mismatched numbers before this branch (RED-APP's scrape:
// Penalty Kick showed 0.740 ≈ 0.726, a gap of 0.014).
// ─────────────────────────────────────────────────────────────────────────────
function createInitialState(startX: number, startY: number, g: GamePayoffs): SimState {
  return {
    cx: startX, cy: startY, exactX: startX, exactY: startY, calcX: startX, calcY: startY,
    displayX: startX, displayY: startY, startX, startY,
    domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1,
    stratX: startX, stratY: startY, cycleCount: 0, visitedPositions: [], ghostVisitedPositions: [],
    discoveredMixedX: null, discoveredMixedY: null, foundAxis: null,
    running: false, converged: false, stepCount: 0,
    pathSegmentsA: [{ xs: [startX], ys: [startY], zs: [r3(EA(startX, startY, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [startX], ys: [startY], zs: [r3(EB(startX, startY, g))], mover: 'A' }],
    phase1PtsA: null, phase1PtsB: null, ghostPathSegmentsA: [], ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false, bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false, ghostBisectGoodLo: 0, ghostBisectGoodHi: 1,
    ghostBisectBadLo: 0, ghostBisectBadHi: 1,
  } as unknown as SimState;
}

function converge(g: GamePayoffs, fm: 'A' | 'B', mode: 'shrink' | 'regret', step = 0.01): SimState {
  const st = createInitialState(0.217, 0.217, g);
  const allNE = computeAllNE(g);
  const pure = allNE.filter((n: NashEquilibrium) => n.type === 'pure');
  const committed = pure.length
    ? pure.reduce((b: NashEquilibrium, n: NashEquilibrium) =>
        ((fm === 'A' ? n.eA : n.eB) > (fm === 'A' ? b.eA : b.eB) ? n : b))
    : null;
  for (let i = 0; i < 20000 && !st.converged; i++) {
    doStep(g, st, fm, step, allNE, committed, () => {}, () => {}, () => {}, mode);
  }
  return st;
}

let panelsSeen = 0;
for (const key of ['search', 'spy', 'penalty']) {
  const g = preset(key);
  for (const mode of ['shrink', 'regret'] as const) {
    for (const fm of ['A', 'B'] as const) {
      const st = converge(g, fm, mode);
      ok(st.converged, `${key} [${mode}/${fm}] must converge`);
      const res = resolveProfile(g, st);
      if (res.concept !== 'mixed') continue;
      panelsSeen++;
      const L = indifferenceLines(g, res.x, res.y);
      for (const side of ['a', 'b'] as const) {
        const l = L[side];
        ok(!l.indifferent || l.pStr === l.qStr,
          `${key} [${mode}/${fm}] ${side}: "indifferent" printed ${l.pStr} ${String.raw`\approx`} ${l.qStr}`);
      }
      // The four headline numbers and the two lines describe ONE point.
      if (L.a.indifferent) {
        ok(payoffTexRhs(EA(res.x, res.y, g)) === `${L.a.pRel} ${L.a.pStr}`,
          `${key} [${mode}/${fm}]: E[A] "${payoffTexRhs(EA(res.x, res.y, g))}" must equal E[Row 1] "${L.a.pRel} ${L.a.pStr}"`);
      }
      if (L.b.indifferent) {
        ok(payoffTexRhs(EB(res.x, res.y, g)) === `${L.b.pRel} ${L.b.pStr}`,
          `${key} [${mode}/${fm}]: E[B] "${payoffTexRhs(EB(res.x, res.y, g))}" must equal E[Col 1] "${L.b.pRel} ${L.b.pStr}"`);
      }
      // And the pre-fix source must still be visibly broken, so this loop is
      // not passing for the wrong reason on some later refactor.
      //
      // Under the OLD ≈ rule, Penalty Kick's shipped defect from
      // simState.cx/cy was `oldL.a.indifferent && pStr !== qStr` — an
      // approximate-equality assertion between two different numbers (RED-APP's
      // scrape: "0.740 ≈ 0.726"). Under the DISPLAY-anchored rule that specific
      // shape is now impossible (a >=5e-4 gap can never print `≈`), so the
      // regression check is reframed: the WRONG coordinate source must still
      // render VISIBLY DIFFERENTLY from the correct one (different digits
      // and/or a different ≈-vs-strict verdict), proving the caller-fix in
      // App.tsx (feeding resolveProfile's exact coordinates, not simState.cx/cy)
      // still matters.
      const oldL = indifferenceLines(g, st.cx, st.cy);
      if (key === 'penalty' && mode === 'shrink') {
        const oldWrong = oldL.a.pStr !== L.a.pStr || oldL.a.qStr !== L.a.qStr
          || oldL.a.indifferent !== L.a.indifferent;
        ok(oldWrong,
          `Penalty Kick's shipped defect must still reproduce (wrong coordinate source `
          + `must render differently from the correct one), got old=${JSON.stringify(oldL.a)} vs correct=${JSON.stringify(L.a)}`);
      }
    }
  }
}
ok(panelsSeen === 12, `all three mixed presets x 2 movers x 2 methods must render the panel, saw ${panelsSeen}`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. SWEEP — no "indifferent" line may print two different numbers
// ─────────────────────────────────────────────────────────────────────────────
function mk(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
for (const SCALE of [10, 100]) {
  const rnd = mk(20260901 + SCALE);
  let lines = 0, mismatched = 0, exponential = 0, oldWrong = 0;
  for (let i = 0; i < 320; i++) {
    const v = () => Math.round((rnd() * 2 - 1) * SCALE);
    const g = { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() } as GamePayoffs;
    for (const mode of ['shrink', 'regret'] as const) {
      for (const fm of ['A', 'B'] as const) {
        const st = converge(g, fm, mode);
        if (!st.converged || (st as SimState & { convergedIsNE?: boolean }).convergedIsNE === false) continue;
        const res = resolveProfile(g, st);
        if (res.concept !== 'mixed') continue;
        const L = indifferenceLines(g, res.x, res.y);
        const O = indifferenceLines(g, st.cx, st.cy);   // the pre-fix source
        for (const side of ['a', 'b'] as const) {
          lines++;
          if (L[side].indifferent && L[side].pStr !== L[side].qStr) mismatched++;
          // The OLD regression signature ("indifferent && mismatched") is no
          // longer reachable by construction under the display-anchored rule
          // (see section 1's comment) — a >=5e-4 gap can never print `≈` any
          // more, on either coordinate source. So the "is the wrong coordinate
          // source still visibly wrong" check is now: does it render
          // differently (digits or ≈-vs-strict verdict) from the correct one.
          if (O[side].pStr !== L[side].pStr || O[side].qStr !== L[side].qStr
            || O[side].indifferent !== L[side].indifferent) oldWrong++;
          if (/e[+-]/.test(L[side].pStr) || /e[+-]/.test(L[side].qStr)) exponential++;
        }
      }
    }
  }
  ok(lines > 200, `scale ${SCALE}: sweep must render enough lines to mean something, got ${lines}`);
  ok(mismatched === 0, `scale ${SCALE}: ${mismatched}/${lines} "indifferent" lines print two different numbers`);
  // The sweep is only evidence if the defect is REACHABLE in it. If this ever
  // drops to zero the corpus has stopped exercising the thing under test.
  ok(oldWrong > lines / 4,
    `scale ${SCALE}: the pre-fix coordinate source must still render visibly differently here (${oldWrong}/${lines})`);
  // `fmtPayoffPair`'s 8dp/exponential fallback must never reach the screen: it
  // exists to separate two values under a STRICT relation, and chasing float
  // dust under an approximate one would print "6.67e-1 ≈ 6.67e-1".
  ok(exponential === 0, `scale ${SCALE}: exponential notation reached the panel ${exponential} times`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE STRICT BRANCH KEEPS ITS WIDENING
//
// Guards the opposite mistake: applying the midpoint rule everywhere would
// reintroduce "0.030 > 0.030", which `fmtPayoffPair` was added to stop.
// ─────────────────────────────────────────────────────────────────────────────
{
  const strict = indifferenceLine('Row 1', 'Row 2', 0.0304, 0.0296);
  ok(strict.relation === '>', 'a strict relation keeps its direction');
  ok(strict.pStr !== strict.qStr,
    `a strict relation must never print the same number twice, got ${strict.pStr} > ${strict.qStr}`);
  ok(strict.pStr === '0.0304' && strict.qStr === '0.0296',
    `strict widening must expose the difference, got ${strict.pStr} / ${strict.qStr}`);

  // ROUNDING-BOUNDARY FIXTURE. Both row payoffs are -30.5625 and differ by
  // 3.6e-15; -30.5625 is exactly r3's half-way point and Math.round breaks that
  // tie towards +inf, so the dust used to decide which side each value landed
  // on and the panel printed "-30.562 ≈ -30.563".
  const g = { a11: -25, a12: -32, a21: 64, a22: -55, b11: 29, b12: -97, b21: -76, b22: 4 } as GamePayoffs;
  const mn = computeMixedNE(g)!;
  const L = indifferenceLines(g, mn.x, mn.y);
  ok(L.a.indifferent, 'A is indifferent at this equilibrium');
  ok(Math.abs(L.a.p - L.a.q) < 1e-12,
    `the two row payoffs are equal in exact arithmetic (gap ${Math.abs(L.a.p - L.a.q)})`);
  ok(L.a.pStr === L.a.qStr,
    `a 3.6e-15 difference must not be rendered as a 0.001 one, got ${L.a.pStr} / ${L.a.qStr}`);
  // Mutation: without the midpoint rule these two DO split. Recomputing the
  // naive render here proves the fixture discriminates.
  ok(r3(L.a.p).toFixed(3) !== r3(L.a.q).toFixed(3),
    'the naive per-side render must still split on this fixture, or the fixture has stopped testing anything');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. FALSE ZEROS IN THE NE LIST
// ─────────────────────────────────────────────────────────────────────────────
{
  // Reported repro. The mixed NE's true E[A] is -0.000412.
  const g = {
    a11: -0.017, a12: 0.01, a21: 0.077, a22: -0.049,
    b11: -0.034, b12: 0.048, b21: 0.048, b22: 0.034,
  } as GamePayoffs;
  const mixed = computeAllNE(g).find((n: NashEquilibrium) => n.type === 'mixed')!;
  ok(mixed !== undefined, 'the repro game has a mixed NE');
  const exact = EA(mixed.x, mixed.y, g);
  ok(Math.abs(exact - -0.000412) < 1e-5, `E[A] must be about -0.000412, got ${exact}`);

  ok(mixed.eA.toFixed(3) === '0.000',
    `the shipped render must still be the false zero it was, got ${mixed.eA.toFixed(3)}`);
  // The subtler half: `computeAllNE` stores eA ALREADY r3-rounded, r3 of a tiny
  // negative is -0, and -0 === 0, so a bare fmtPayoff swap re-spells the false
  // zero instead of fixing it. If this ever stops holding, the recompute in
  // `neValues` has become unnecessary and should be simplified, not kept.
  ok(fmtPayoff(mixed.eA) === '0',
    `fmtPayoff on the STORED value must still print a false zero, got "${fmtPayoff(mixed.eA)}"`);
  ok(neValues(mixed, g).a === 'greater than -0.001',
    `neValues must refuse the false zero, got "${neValues(mixed, g).a}"`);
  ok(neValues(mixed, g).b === '0.036', `E[B] is an ordinary number, got "${neValues(mixed, g).b}"`);

  // And it must not have become chatty on ordinary games.
  const search = preset('search');
  for (const ne of computeAllNE(search)) {
    const v = neValues(ne, search);
    ok(/^-?\d+\.\d{3}$|^0$/.test(v.a) && /^-?\d+\.\d{3}$|^0$/.test(v.b),
      `Search Game NE values must stay plain numbers, got ${v.a} / ${v.b}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE WIRING
//
// The defect lived in the CALL SITE, not in the function that computed the
// coordinates — `resolveProfile` was already correct and already tested.
// (`indifferenceAt` was the panel's ≈ arbiter when this section was written;
// since the "Option B" display-anchored rule in §7 it no longer is — the
// panel decides ≈-vs-strict from the printed digits alone. `indifferenceAt`
// stays a directly-tested utility with no production caller.) So assert the
// wiring itself, the way `cloudbuild.contract.test.ts` asserts a deploy file
// it cannot execute.
// ─────────────────────────────────────────────────────────────────────────────
{
  const app = readFileSync(join(here, 'App.tsx'), 'utf8');
  ok(app.includes('indifferenceLines(payoffs, resolved.x, resolved.y)'),
    'App.tsx must build the indifference lines from resolveProfile\'s exact coordinates');
  // `lastIndexOf`: the phrase also appears in a comment 2,700 lines up, and
  // anchoring on the first hit swept in the LIVE coordinate readout, which reads
  // simState legitimately — it is showing where the run is, not where the
  // equilibrium is.
  const start = app.lastIndexOf('Strategy Nash Equilibrium Reached');
  const end = app.indexOf('Resolved via', start);
  ok(start > 0 && end > start, 'the equilibrium panel anchors must both be found');
  const box = app.slice(start, end);
  // A slice that silently went empty would pass every check below vacuously.
  ok(box.includes('indifferent:') && box.includes('lines.a.tex') && box.includes('lines.b.tex'),
    'the slice under test must actually be the equilibrium panel');
  ok(!/simState\.c[xy]/.test(box),
    'the equilibrium panel must not read the 3dp display coordinate anywhere inside itself');
  // Mutation: the pre-fix panel DID read it, so the check must fire on that text.
  ok(/simState\.c[xy]/.test('const p = simState.cy * payoffs.a11 + (1 - simState.cy) * payoffs.a12;'),
    'the wiring predicate must match the text it was written against');
  ok(!/\.eA\.toFixed\(|\.eB\.toFixed\(/.test(app),
    'no site may print a stored (pre-rounded) equilibrium payoff with a bare toFixed');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. JOB 1 IS UNCHANGED; JOB 2 IS NOW DISPLAY-ANCHORED (director decision,
//    "Option B", 2026-09-02) — the panel's `≈` no longer answers job 1's
//    question at all.
// ─────────────────────────────────────────────────────────────────────────────
{
  const g = preset('penalty');
  ok(Math.abs(neTolerancePlayer(g, 'A') - 4 * 5e-4 * 20) < 1e-12,
    'neTolerancePlayer must still be 0.002 x that player\'s own spread — the scaling question is a design decision, not a bug fix');
  // `indifferenceAt` (job 1's convergence-tolerance test) is itself untouched —
  // still answers the SAME question it always did — it is simply no longer
  // consulted by the panel (see §6's comment and `indifferenceLines`).
  ok(indifferenceAt(g, 1 / 11, 4 / 11).a,
    'indifferenceAt must still report A indifferent at Penalty Kick\'s equilibrium — its own math is unchanged');

  // THE 1-CALLER TRIPWIRE — kept exactly as before. It no longer protects
  // against a misprint (that is now impossible by construction, see below),
  // but it still protects against the OTHER thing a second caller can do:
  // render "A strictly prefers" under a heading that says MIXED, which is
  // correct output but a surprising screen a future caller should choose
  // deliberately rather than discover.
  const app = readFileSync(join(here, 'App.tsx'), 'utf8');
  const callers = [...app.matchAll(/indifferenceLines\s*\(/g)].length;
  ok(callers === 1,
    `indifferenceLines must have exactly ONE production caller, found ${callers}. `
    + 'A caller that passes an ARBITRARY profile (a restored saved game, a jumped-to step) '
    + 'lets resolveProfile land on a continuum EDGE, where up to 38.6% of mixed-panel lines '
    + 'sit at a vertex, and ~31% of those render "A strictly prefers" under a MIXED heading '
    + '(correct math, surprising screen). Feeding computeAllNE coordinates (an NE-list click) '
    + 'is SAFE — it never yields a mixed-concept vertex point. Decide the "strictly prefers '
    + 'under MIXED" display question before adding a caller of the first kind.');
  ok(/indifferenceLines\(payoffs, resolved\.x, resolved\.y\)/.test(app),
    'and that one caller must still be the converged-run profile');

  // THE MISPRINT CLASS IS NOW STRUCTURALLY IMPOSSIBLE, not merely rare.
  //
  // This is the EXACT fixture that used to print "≈" between two different
  // numbers under the OLD (neTolerancePlayer-driven) rule: a vertex point
  // whose gap (6.5e-4) sits comfortably inside this game's inflated tolerance
  // (3.07e-3, `_gen/blueapp_renderer_reach.ts` measured 716/217,652 = 0.33%
  // of adversarially-generated mixed panels doing this). Under the
  // DISPLAY-anchored rule the SAME gap is >= the fixed 5e-4 display-resolution
  // threshold, so it is now asserted as a STRICT relation instead — the
  // renderer no longer needs the 1-caller tripwire to stay safe from this
  // specific class; it is safe for ANY caller now, by construction.
  const cont = { a11: -0.993, a12: -0.67, a21: 0.54, a22: -0.766,
                 b11: 0.138, b12: 0.138, b21: -0.457, b22: -0.912 } as GamePayoffs;
  const mn = computeMixedNE(cont);
  ok(mn !== null, 'the reachable-shape fixture must have a mixed NE');
  const off = resolveProfile(cont, { exactX: mn!.x + 4e-4, exactY: mn!.y - 4e-4 } as unknown as SimState);
  ok(off.concept === 'mixed' && (off.x === 0 || off.x === 1),
    `the fixture must resolve to a MIXED panel with a player at a vertex, got ${JSON.stringify(off)}`);
  const bad = indifferenceLines(cont, off.x, off.y);
  ok(Math.abs(bad.a.p - bad.a.q) < neTolerancePlayer(cont, 'A'),
    'the fixture must still sit inside the OLD (job-1) tolerance, or this fixture has gone stale');
  ok(!bad.a.indifferent,
    `THE FIX: this exact vertex-class shape must no longer print "≈" (got indifferent=${bad.a.indifferent}, `
    + `${bad.a.pStr} / ${bad.a.qStr}) — if it does, Option B has regressed`);
  ok(bad.a.pStr !== bad.a.qStr,
    'and the two numbers genuinely are different — the fixture must still exercise a REAL gap, not a rounding artefact');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7b. THE "IDENTICAL PRINTED DIGITS" PROPERTY — the display-anchored rule
// itself, checked as a property rather than one fixture at a time.
//
// The claim: `indifferenceLine`'s ≈-vs-strict choice depends ONLY on
// `Math.abs(p - q)` against the fixed 5e-4 display-resolution threshold —
// never on the MAGNITUDE of p/q, i.e. never on payoff scale. And whenever it
// asserts ≈, the two printed strings are IDENTICAL — never merely close —
// WHETHER OR NOT either side needed sub-resolution `<`/`>` wording.
//
// [RED-MATH-5 finding 001, round 5] This property used to be checked ONLY in
// the ordinary-magnitude branch (`pRel === '=' && qRel === '='`); the
// near-zero branch below incremented `sawNearZero` and asserted NOTHING about
// `pStr`/`qStr` — so this exact sweep ran, "passed", and never noticed that
// the near-zero branch could print two different numbers. Both branches now
// assert the same thing.
// ─────────────────────────────────────────────────────────────────────────────
{
  function mkProp(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mkProp(20260902);
  let n = 0, sawIndifferent = 0, sawStrict = 0, sawNearZero = 0;
  // Sweep payoff SCALE across six orders of magnitude — the display threshold
  // (5e-4) must decide ≈-vs-strict the SAME way at every scale, unlike the old
  // neTolerancePlayer-driven rule (0.002 x spread), which would have scaled
  // its own cutoff right along with these.
  for (const scale of [0.01, 1, 10, 1000, 100000]) {
    for (let i = 0; i < 400; i++) {
      const base = (rnd() * 2 - 1) * scale;
      // Gap is drawn independently of scale — this is the point: the SAME
      // absolute gap distribution is tested against every payoff magnitude.
      const gap = (rnd() * 2 - 1) * 2e-3;
      const p = base;
      const q = base + gap;
      const L = indifferenceLine('Row 1', 'Row 2', p, q);
      n++;
      ok(L.indifferent === (Math.abs(p - q) < 5e-4),
        `scale ${scale}: indifferent must be exactly (gap < 5e-4), got indifferent=${L.indifferent} `
        + `gap=${Math.abs(p - q)} at p=${p} q=${q}`);
      if (L.indifferent) {
        sawIndifferent++;
        // THE FIX: identical digits AND identical relation wording, in EVERY
        // ≈ line — sub-resolution or ordinary. This is the assertion that was
        // previously skipped for the near-zero branch (see the comment above).
        ok(L.pStr === L.qStr && L.pRel === L.qRel,
          `scale ${scale}: an ≈ line must print IDENTICALLY on both sides, got `
          + `"${L.pRel} ${L.pStr}" / "${L.qRel} ${L.qStr}" (p=${p} q=${q})`);
        if (!(L.pRel === '=' && L.qRel === '=')) sawNearZero++;
      } else {
        sawStrict++;
        ok(L.pStr !== L.qStr,
          `scale ${scale}: a strict line must never print the same digits twice, got ${L.pStr} (p=${p} q=${q})`);
      }
    }
  }
  ok(n > 1500, `the property sweep must run enough cases to mean something, got ${n}`);
  // Both branches, and the documented near-zero exception, must actually be
  // exercised — otherwise this "property" is proving something vacuous.
  ok(sawIndifferent > n / 10 && sawStrict > n / 10,
    `both ≈ and strict must be reachable in this sweep, got indifferent=${sawIndifferent} strict=${sawStrict} of ${n}`);
  ok(sawNearZero > 0,
    `the near-zero sub-resolution exception must be reachable too, got ${sawNearZero} of ${n}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. THE ROUNDING CONVENTION IS STATED ON SCREEN
//
// Nothing in the panel is false, but the four printed numbers are not a tuple a
// reader can recompute: substitute the printed x*, y* into E[A] and you land
// elsewhere for 50.5% of mixed equilibria on int[-9,9] and 90.0% at the +/-100
// clamp. A referee checking the arithmetic by hand concludes the app is wrong,
// so the convention is said out loud instead of left to be discovered.
// ─────────────────────────────────────────────────────────────────────────────
{
  const app = readFileSync(join(here, 'App.tsx'), 'utf8');
  const caption = 'Computed at the exact equilibrium, then rounded to 3 dp for display'
    + ' \u2014 recomputing E[A] from the rounded x* and y* can differ in the last digits.';
  ok(app.includes(caption), 'the equilibrium panel must state the rounding convention verbatim');
  // Mixed only: at a pure equilibrium the coordinates are exactly 0 or 1 and
  // the substitution reproduces the payoff, so the caveat would be false noise.
  const at = app.indexOf(caption);
  const guard = app.lastIndexOf("realisedConcept === 'mixed'", at);
  ok(guard > 0 && at - guard < 400, 'the convention line must be gated on a MIXED equilibrium');

  // The claim the caption makes must actually be true of this app, and it must
  // be true in the direction stated ("can differ", not "always differs").
  const rd = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  const rnd = mk(4242);
  let mixed = 0, differ = 0;
  for (let i = 0; i < 20000; i++) {
    const v = () => Math.round((rnd() * 2 - 1) * 9);
    const g = { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() } as GamePayoffs;
    const m = computeMixedNE(g);
    if (!m) continue;
    mixed++;
    if (r3(EA(rd(m.x, 3), rd(m.y, 3), g)).toFixed(3) !== r3(EA(m.x, m.y, g)).toFixed(3)) differ++;
  }
  ok(mixed > 1000, `the convention sweep needs mixed equilibria to mean anything, got ${mixed}`);
  ok(differ > mixed / 4,
    `"can differ" must be a real warning: only ${differ}/${mixed} mixed NEs differ under substitution`);
  ok(differ < mixed,
    `"can differ" must not be "always differs": ${differ}/${mixed} — if this ever hits 100% the wording is too weak`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. RED-MATH-5 FINDING 001 (round 5) — "≈" between two DIFFERENT numbers at
//    an EXACT-ZERO mixed-NE indifference point, through the real production
//    call chain (`App.tsx` -> `resolveProfile` -> `indifferenceLines`).
//
// Option B's own claim ("THE MISPRINT CLASS IS NOW STRUCTURALLY IMPOSSIBLE",
// section 7 above) was FALSE for this case: `shareMidpoint` only fired when
// NEITHER side needed sub-resolution `<`/`>` wording, so a genuine mixed-NE
// indifference whose TRUE value is exactly 0 — where `eRow1`/`eRow2` are two
// DIFFERENT floating-point expressions for that same zero — could have
// ~1e-16 rounding noise land them on opposite sides of zero, each picking up
// its own directional wording independently: "-0.001" on one side, "0.001"
// on the other, joined by "\approx". This section is the real-game repro plus
// a seeded-corpus reach count, so this class cannot silently come back.
// ─────────────────────────────────────────────────────────────────────────────
{
  // Minimal hand-verified repro (`_gen/redmath5_minimal_repro.ts`): small
  // single-digit integers, directly enterable in the UI.
  const g = { a11: -3, a12: 2, a21: 6, a22: -4, b11: 5, b12: 1, b21: -7, b22: 1 } as GamePayoffs;
  const nes = computeAllNE(g) as NashEquilibrium[];
  const mixed = nes.find((n) => n.x > 0 && n.x < 1 && n.y > 0 && n.y < 1)!;
  ok(mixed !== undefined
    && Math.abs(mixed.x - 2 / 3) < 1e-9 && Math.abs(mixed.y - 0.4) < 1e-9,
    `finding 001's repro game must still have its mixed NE at (2/3, 0.4), got ${JSON.stringify(mixed)}`);
  const resolved = resolveProfile(g, { exactX: mixed.x, exactY: mixed.y } as unknown as SimState);
  const L = indifferenceLines(g, resolved.x, resolved.y);

  // The mechanism, stated: both row payoffs are exactly 0 in real arithmetic
  // (that is what makes y*=0.4 the indifference root) but land on opposite
  // sides of zero in floating point.
  const eRow1 = mixed.y * g.a11 + (1 - mixed.y) * g.a12;
  const eRow2 = mixed.y * g.a21 + (1 - mixed.y) * g.a22;
  ok(eRow1 < 0 && eRow2 > 0 && Math.abs(eRow1) < 1e-12 && Math.abs(eRow2) < 1e-12,
    `the repro must still exercise opposite-sign float noise around exact 0, got eRow1=${eRow1} eRow2=${eRow2}`);

  ok(L.a.indifferent, 'A must still be indifferent at this equilibrium');
  ok(L.a.pStr === L.a.qStr && L.a.pRel === L.a.qRel,
    `THE DEFECT ITSELF: both sides of the A line must print identically, got tex="${L.a.tex}"`);
  ok(!/-0\.001.*0\.001|0\.001.*-0\.001/.test(L.a.tex),
    `the exact shipped defect string must not appear, got tex="${L.a.tex}"`);

  // And the line must now match the headline it sits three lines under — the
  // "worse:" half of the finding (E[A] = 0 while the line said otherwise).
  ok(payoffTexRhs(EA(resolved.x, resolved.y, g)) === `${L.a.pRel} ${L.a.pStr}`,
    `the row line must render the SAME statement as the headline E[A], got `
    + `"${payoffTexRhs(EA(resolved.x, resolved.y, g))}" vs "${L.a.pRel} ${L.a.pStr}"`);
  ok(L.a.tex === '\\mathbb{E}[\\text{Row 1}] = 0 \\approx \\mathbb{E}[\\text{Row 2}] = 0',
    `exact rendering must be the honest shared zero, got tex="${L.a.tex}"`);

  // MUTATION FIXTURE: reverting to independent per-side rendering (the
  // pre-fix mechanism) must reproduce the shipped defect string on this exact
  // game, or this fixture has stopped testing anything.
  const naiveP = payoffTexRhs(eRow1), naiveQ = payoffTexRhs(eRow2);
  ok(naiveP !== naiveQ,
    `the naive independent render must still split on this fixture (got "${naiveP}" / "${naiveQ}"), `
    + 'or the repro has gone stale and no longer proves the fix does anything');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9b. CORPUS REACH — "≈ between different printed numbers" must be 0 over
// the same seeded corpus RED-MATH-5 used to find it (`_gen/redmath5_vertex_
// reach.ts` pattern: `computeAllNE` roots through `resolveProfile`, the real
// NE-list / converged-run call chain). RED measured 262/607,874 before this
// fix (concentrated on int[-9,9] small-integer games). Reduced scale here to
// stay fast in `npm test`; the full corpus lives in the `_gen/` script for
// re-verification.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rnd = mk(90210);
  let neEntries = 0, mismatched = 0, identicalNoRel = 0;
  for (let i = 0; i < 6000; i++) {
    const v = () => Math.round((rnd() * 2 - 1) * 9);
    const g = { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() } as GamePayoffs;
    for (const ne of computeAllNE(g) as NashEquilibrium[]) {
      if (ne.x <= 0 || ne.x >= 1 || ne.y <= 0 || ne.y >= 1) continue;
      neEntries++;
      const L = indifferenceLines(g, ne.x, ne.y);
      for (const side of ['a', 'b'] as const) {
        if (L[side].indifferent && L[side].pStr !== L[side].qStr) mismatched++;
        if (L[side].indifferent && L[side].pStr === L[side].qStr && L[side].pRel !== L[side].qRel) identicalNoRel++;
      }
    }
  }
  ok(neEntries > 300, `the corpus must produce enough mixed NE entries to mean something, got ${neEntries}`);
  ok(mismatched === 0,
    `${mismatched}/${neEntries} mixed-NE indifference lines print "≈" between two different numbers`);
  ok(identicalNoRel === 0,
    `${identicalNoRel}/${neEntries} lines print identical digits but different relation wording (also a misprint)`);
}

console.log(`equilibriumpanel.test.ts: ${checks} checks passed`);

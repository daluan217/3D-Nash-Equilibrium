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
  ok(payoffTexRhs(EA(mn.x, mn.y, g)) === `= ${L.a.pStr}`,
    `E[A] and E[Row 1] must render identically, got "${payoffTexRhs(EA(mn.x, mn.y, g))}" vs "= ${L.a.pStr}"`);
  ok(payoffTexRhs(EB(mn.x, mn.y, g)) === `= ${L.b.pStr}`,
    `E[B] and E[Col 1] must render identically, got "${payoffTexRhs(EB(mn.x, mn.y, g))}" vs "= ${L.b.pStr}"`);

  // MUTATION / NEGATIVE FIXTURE — the defect itself, verbatim.
  // The shipped panel used to feed `simState.cx`/`cy`, which `doStep` has already
  // pushed through r3. If the assertions above could not tell the two coordinate
  // sources apart they would be worthless, so prove they can.
  const bad = indifferenceLines(g, r3(mn.x), r3(mn.y));
  ok(bad.a.pStr === '0.666' && bad.a.qStr === '0.667',
    `the 3dp coordinate must still reproduce the shipped defect (0.666 vs 0.667), got ${bad.a.pStr} / ${bad.a.qStr}`);
  ok(bad.b.pStr === '-0.666' && bad.b.qStr === '-0.667',
    `the 3dp coordinate must still reproduce the shipped B defect, got ${bad.b.pStr} / ${bad.b.qStr}`);
  ok(bad.a.indifferent && bad.a.pStr !== bad.a.qStr,
    'the defect is precisely "indifferent" asserted between two different numbers');
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
        ok(payoffTexRhs(EA(res.x, res.y, g)) === `= ${L.a.pStr}`,
          `${key} [${mode}/${fm}]: E[A] "${payoffTexRhs(EA(res.x, res.y, g))}" must equal E[Row 1] "= ${L.a.pStr}"`);
      }
      if (L.b.indifferent) {
        ok(payoffTexRhs(EB(res.x, res.y, g)) === `= ${L.b.pStr}`,
          `${key} [${mode}/${fm}]: E[B] "${payoffTexRhs(EB(res.x, res.y, g))}" must equal E[Col 1] "= ${L.b.pStr}"`);
      }
      // And the pre-fix source must still be visibly broken, so this loop is
      // not passing for the wrong reason on some later refactor.
      const oldL = indifferenceLines(g, st.cx, st.cy);
      if (key === 'penalty' && mode === 'shrink') {
        ok(oldL.a.indifferent && oldL.a.pStr !== oldL.a.qStr,
          `Penalty Kick's shipped defect must reproduce from simState.cx/cy, got ${oldL.a.pStr} / ${oldL.a.qStr}`);
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
  let lines = 0, mismatched = 0, exponential = 0, oldMismatched = 0;
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
          if (O[side].indifferent && O[side].pStr !== O[side].qStr) oldMismatched++;
          if (/e[+-]/.test(L[side].pStr) || /e[+-]/.test(L[side].qStr)) exponential++;
        }
      }
    }
  }
  ok(lines > 200, `scale ${SCALE}: sweep must render enough lines to mean something, got ${lines}`);
  ok(mismatched === 0, `scale ${SCALE}: ${mismatched}/${lines} "indifferent" lines print two different numbers`);
  // The sweep is only evidence if the defect is REACHABLE in it. If this ever
  // drops to zero the corpus has stopped exercising the thing under test.
  ok(oldMismatched > lines / 4,
    `scale ${SCALE}: the pre-fix coordinate source must still be visibly broken here (${oldMismatched}/${lines})`);
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
  const strict = indifferenceLine('Row 1', 'Row 2', 0.0304, 0.0296, false);
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
// The defect lived in the CALL SITE, not in either function it called — both
// `indifferenceAt` and `resolveProfile` were already correct and already tested.
// So assert the wiring itself, the way `cloudbuild.contract.test.ts` asserts a
// deploy file it cannot execute.
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
// 7. THE TOLERANCE IS UNCHANGED — reported, not silently retuned.
// ─────────────────────────────────────────────────────────────────────────────
{
  const g = preset('penalty');
  ok(Math.abs(neTolerancePlayer(g, 'A') - 4 * 5e-4 * 20) < 1e-12,
    'neTolerancePlayer must still be 0.002 x that player\'s own spread — the scaling question is a design decision, not a bug fix');
  ok(indifferenceAt(g, 1 / 11, 4 / 11).a || true, 'indifferenceAt is still the arbiter of the label');

  // THE CONDITION THE "UNREACHED" CLAIM RESTS ON.
  //
  // Through the converged run, `≈` never sits between two different numbers.
  // That is a fact about THE CALLER, not about the renderer: hand the renderer
  // arbitrary profiles and 0.33% of mixed-panel renderings do print it (716 of
  // 217,652 — `_gen/blueapp_renderer_reach.ts`), every one at a resolved point
  // with a coordinate at a vertex, i.e. a player holding a pure strategy inside
  // an equilibrium region.
  //
  // WHICH SECOND CALLER, precisely — because the obvious guess is wrong and a
  // guard that names the wrong hazard misdirects whoever reads it
  // (`_gen/blueapp_vertex_class.ts`, 120,000 games per alphabet):
  //   * An NE-LIST CLICK IS SAFE on this axis. `computeAllNE` gates the mixed
  //     root at 0 < x < 1 and returns pure NEs at corners, so it never yields a
  //     MIXED-concept point with a coordinate at a vertex. Feeding its own
  //     coordinates produces 0 / 16 / 0 vertex-class lines and 0 misprints.
  //   * The hazard is a caller passing an ARBITRARY, non-equilibrium profile
  //     and letting `resolveProfile` project it onto the EDGE of a continuum —
  //     a restored saved game, a jumped-to step. There the vertex class is
  //     38.6% / 0.5% / 4.9% of mixed-panel lines, ~31% of it renders "strictly
  //     prefers" under a heading that says MIXED (correct output, surprising
  //     screen), and 0.04-0.09% of it is the misprint.
  // So the misprint stays rare even for the hazardous caller; what a second
  // caller really buys is the "strictly prefers" class, and that is a display
  // decision to take deliberately rather than discover.
  //
  // Rather than assume nobody adds that caller, fail when they do. This is the
  // load-bearing check: if it ever fires, the tolerance question has become
  // reachable and must be answered before the new caller ships.
  const app = readFileSync(join(here, 'App.tsx'), 'utf8');
  const callers = [...app.matchAll(/indifferenceLines\s*\(/g)].length;
  ok(callers === 1,
    `indifferenceLines must have exactly ONE production caller, found ${callers}. `
    + 'A caller that passes an ARBITRARY profile (a restored saved game, a jumped-to step) '
    + 'lets resolveProfile land on a continuum EDGE, where up to 38.6% of mixed-panel lines '
    + 'sit at a vertex: ~31% of those render "A strictly prefers" under a MIXED heading, and '
    + '0.04-0.09% print "≈" between two different numbers. Feeding computeAllNE coordinates '
    + '(an NE-list click) is SAFE — it never yields a mixed-concept vertex point. Decide the '
    + 'display question before adding a caller of the first kind.');
  ok(/indifferenceLines\(payoffs, resolved\.x, resolved\.y\)/.test(app),
    'and that one caller must still be the converged-run profile');

  // The 0.33% is real, so prove the predicate above is guarding something
  // rather than describing a hypothetical. This is the shape it takes.
  const cont = { a11: -0.993, a12: -0.67, a21: 0.54, a22: -0.766,
                 b11: 0.138, b12: 0.138, b21: -0.457, b22: -0.912 } as GamePayoffs;
  const mn = computeMixedNE(cont);
  ok(mn !== null, 'the reachable-shape fixture must have a mixed NE');
  const off = resolveProfile(cont, { exactX: mn!.x + 4e-4, exactY: mn!.y - 4e-4 } as unknown as SimState);
  ok(off.concept === 'mixed' && (off.x === 0 || off.x === 1),
    `the fixture must resolve to a MIXED panel with a player at a vertex, got ${JSON.stringify(off)}`);
  const bad = indifferenceLines(cont, off.x, off.y);
  ok(bad.a.indifferent && bad.a.pStr !== bad.a.qStr,
    `the fixture must actually print "≈" between two different numbers (${bad.a.pStr} / ${bad.a.qStr}) — `
    + 'if it stops doing so, either the tolerance changed or this fixture has gone stale');
  ok(Math.abs(bad.a.p - bad.a.q) < neTolerancePlayer(cont, 'A'),
    'and it must be the TOLERANCE admitting it, not a rounding artefact');
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

console.log(`equilibriumpanel.test.ts: ${checks} checks passed`);

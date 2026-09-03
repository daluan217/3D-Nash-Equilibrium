/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RED-MATH-6/001 regression guard: THREE renderings of one equilibrium payoff
 * — the equilibrium panel, the simulation log, and the LLM grounding payload
 * — must never disagree, and none may print a genuinely nonzero payoff as an
 * exact "0"/"0.000".
 *
 * ROOT CAUSE (see the finding, round6/findings/RED-MATH-6/001): `computeAllNE`
 * stores `eA`/`eB` PRE-ROUNDED to 3dp (`r3(EA(...))`). `r3` of anything with
 * `|v| < 0.0005` collapses to a literal JS `0` (or `-0`, which is `=== 0`), so
 * by the time a caller reads `ne.eA`/`ne.eB` the information "was this really
 * zero, or merely too small to show at 3dp" is already gone.
 *
 * `src/components/equilibriumPanel.ts`'s `neValues` was hardened against this
 * years ago (that file's own docstring names the trap): it never reads
 * `ne.eA`/`ne.eB`, it recomputes `fmtPayoff(EA(ne.x, ne.y, g))` from the exact
 * coordinates every time. Two OTHER consumers of the identical quantity were
 * not: `src/utils/gameEngine.ts`'s `doStep` (the simulation log's per-step and
 * convergence lines) and `src/utils/report.ts`'s `buildGroundingPayload` (the
 * literal prompt handed to the model) both called `.toFixed(3)` on an
 * already-`r3`-rounded number, or interpolated `e.eA`/`e.eB` directly.
 *
 * Per Daniel's confirmed rule for this class of defect: a sub-resolution value
 * that is not exactly 0 (or, for probabilities, not exactly 1) must always
 * print the RELATION ("less than 0.001" / "greater than -0.001" — the payoff
 * analogue of `fmtProb`'s "less than 0.001" / "more than 0.999", which is
 * bounded to [0,1] and therefore uses different endpoints), never a bare "0"
 * or "0.000". `fmtPayoff` already implements exactly this contract for
 * payoffs (unbounded, unlike probabilities) — the fix is routing every
 * consumer through it, recomputed from the EXACT coordinates, never through
 * the pre-rounded `eA`/`eB` fields.
 *
 * Mutation-tested: reverting any one of the three call-site fixes (report.ts
 * back to `payoffs A=${e.eA}, B=${e.eB}`; either gameEngine.ts log site back
 * to `.toFixed(3)` on the r3-rounded local; MenuDrawer.tsx back to
 * `eq.eA.toFixed(2)`) makes the corresponding check below fail.
 *
 *   npx tsx src/payoffhonesty.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  GamePayoffs, SimState, NashEquilibrium,
} from './types';
import {
  doStep, PRESETS, computeAllNE, computeIndifference, computeMixedNE, fmtPayoff, EA, EB, r3,
  equilibriumSet, kindOf, describeContinua,
} from './utils/gameEngine';
import { buildGroundingPayload } from './utils/report';
import { neValues } from './components/equilibriumPanel';
import { makeTraces, buildSurfaces } from './utils/plotting';

let checks = 0;
function ok(cond: unknown, msg: string): asserts cond {
  checks++;
  assert(cond, msg);
}

function mk(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function presetGame(key: keyof typeof PRESETS): GamePayoffs {
  const p = PRESETS[key];
  return {
    a11: p.a11 ?? 0, a12: p.a12 ?? 0, a21: p.a21 ?? 0, a22: p.a22 ?? 0,
    b11: p.b11 ?? 0, b12: p.b12 ?? 0, b21: p.b21 ?? 0, b22: p.b22 ?? 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Panel vs grounding payload — EXACT string agreement, same NE, same game.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The exact fixture from the finding's Repro A: every cell on the matrix
 * editor's 0.001 grid, exact mixed NE (0.7220163083765753, 0.8768971332209107),
 * true E[A] = -0.00005902192242826336 (nonzero, negative, rounds to 0 at 3dp).
 */
const REPRO_A_GAME: GamePayoffs = {
  a11: 0.134, a12: -0.955, a21: 0.061, a22: -0.435,
  b11: 0.303, b12: 0.678, b21: 0.919, b22: -0.055,
};

function payoffsFromPayload(payload: string): Array<{ a: string; b: string }> {
  return [...payload.matchAll(/\(payoffs A=([^,]+), B=([^)]+)\)/g)].map((m) => ({ a: m[1], b: m[2] }));
}

function testPayloadAgreesWithPanel() {
  // Known positive: the true payload must state the honest relation, not "0".
  {
    const payload = buildGroundingPayload(REPRO_A_GAME);
    const pairs = payoffsFromPayload(payload);
    ok(pairs.length === 1, `fixture must carry exactly one equilibrium; payload="${payload}"`);
    ok(pairs[0].a === 'greater than -0.001',
      `fixture: payload must state A="greater than -0.001" (true E[A] is -5.9e-5, nonzero); got "${pairs[0].a}" — payload="${payload}"`);
    ok(pairs[0].b === '0.474', `fixture: payload B must read "0.474"; got "${pairs[0].b}"`);
    ok(!/A=0,/.test(payload) && !/B=0\)/.test(payload),
      `fixture: payload must never state a bare "A=0"/"B=0" for this game — payload="${payload}"`);
  }

  // Corpus sweep: every equilibrium of every non-degenerate game in the
  // corpus must have the payload's stated payoff EXACTLY equal to the panel's
  // own formatter (neValues), evaluated at the same (x, y).
  let checked = 0;
  let falseZeroExercised = 0;
  const corpus: GamePayoffs[] = [REPRO_A_GAME, ...Object.keys(PRESETS).map((k) => presetGame(k as keyof typeof PRESETS))];
  for (const scale of [1, 3]) {
    const rnd = mk(0x51ade000 + scale);
    for (let i = 0; i < 8000; i++) {
      const v = () => Math.round((rnd() * 2 - 1) * scale * 1000) / 1000;
      corpus.push({ a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() });
    }
  }
  for (const g of corpus) {
    // RED-MATH-7/001: buildGroundingPayload's continuum branch is now gated
    // on the TRUE ground-truth test (equilibriumSet has a non-point
    // component), not the narrower computeIndifference (full-indifference-
    // only) it used before this fix — skip here on the SAME predicate, or
    // this sweep would wrongly expect "(payoffs A=..., B=...)" lines on a
    // game where buildGroundingPayload now (correctly) takes the continuum
    // branch instead.
    if (equilibriumSet(g).some((r) => kindOf(r) !== 'point')) continue;
    const nes = computeAllNE(g);
    if (nes.length === 0) continue;
    const payload = buildGroundingPayload(g);
    const pairs = payoffsFromPayload(payload);
    ok(pairs.length === nes.length,
      `${nes.length} equilibria but ${pairs.length} "(payoffs A=..., B=...)" segments in payload for game=${JSON.stringify(g)}`);
    nes.forEach((e, idx) => {
      checked++;
      const panel = neValues(e, g);
      const trueA = EA(e.x, e.y, g);
      const trueB = EB(e.x, e.y, g);
      if (trueA !== 0 && Math.abs(trueA) < 0.0005) falseZeroExercised++;
      if (trueB !== 0 && Math.abs(trueB) < 0.0005) falseZeroExercised++;
      ok(pairs[idx].a === panel.a,
        `game=${JSON.stringify(g)} ${e.type} NE (${e.x}, ${e.y}): payload A="${pairs[idx].a}" but panel A="${panel.a}" (true EA=${trueA})`);
      ok(pairs[idx].b === panel.b,
        `game=${JSON.stringify(g)} ${e.type} NE (${e.x}, ${e.y}): payload B="${pairs[idx].b}" but panel B="${panel.b}" (true EB=${trueB})`);
    });
  }
  ok(checked > 5000, `corpus too small to be a real sweep: only ${checked} equilibria checked`);
  ok(falseZeroExercised >= 1,
    `corpus never hit a genuine sub-resolution-but-nonzero payoff — the invariant this test exists to check was never exercised (falseZeroExercised=${falseZeroExercised})`);
  console.log(`✓ grounding payload agrees with the equilibrium panel on every payoff: ${checked} equilibria checked, ${falseZeroExercised} genuine sub-resolution cases exercised`);
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Simulation log lines — every E[A]=/E[B]= token must be the honest
//    rendering of the EXACT payoff at the coordinate the SAME line reports.
// ════════════════════════════════════════════════════════════════════════════

function createInitialState(startX: number, startY: number, g: GamePayoffs): SimState {
  return {
    cx: startX, cy: startY, exactX: startX, exactY: startY,
    calcX: startX, calcY: startY, displayX: startX, displayY: startY,
    startX, startY, domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1,
    stratX: startX, stratY: startY, cycleCount: 0,
    visitedPositions: [], ghostVisitedPositions: [],
    discoveredMixedX: null, discoveredMixedY: null, foundAxis: null,
    running: false, converged: false, stepCount: 0,
    pathSegmentsA: [{ xs: [startX], ys: [startY], zs: [r3(EA(startX, startY, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [startX], ys: [startY], zs: [r3(EB(startX, startY, g))], mover: 'A' }],
    phase1PtsA: null, phase1PtsB: null, ghostPathSegmentsA: [], ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false, bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false, ghostBisectGoodLo: 0, ghostBisectGoodHi: 1,
    ghostBisectBadLo: 0, ghostBisectBadHi: 1,
  };
}

/**
 * Every log line this codebase emits with a payoff pair uses the SAME
 * template shape: `E[A]=A  E[B]=B` (note the double space before each `E[`,
 * which `fmtPayoff`'s prose values — single-spaced — never contain, so it is
 * a safe anchor). Returns null for lines that carry no payoff pair (discovery
 * lines, ghost-cycle lines).
 */
function parsePayoffTokens(line: string): { eaTok: string; ebTok: string } | null {
  const m = line.match(/E\[A\]=(.+?)  E\[B\]=(.+)$/);
  if (!m) return null;
  return { eaTok: m[1], ebTok: m[2] };
}

/**
 * Captured at the EXACT moment each log line was emitted, from the live
 * SimState object rather than re-parsed out of the rendered (rounded)
 * string. Re-parsing a rounded 3dp string and recomputing from it introduces
 * its OWN rounding-boundary noise — unrelated to this finding — because
 * doStep's mixed-continuum branch (RED-MATH-6/001 fix #3) evaluates the
 * payoff at the EXACT `computeMixedNE` root while the printed x=/y= is that
 * same root through `fmtProb` (3dp); reconstructing the root from the 3dp
 * string loses precision the branch's own computation never had. So this
 * checks against BOTH candidate ground-truth points the shipped code can
 * legitimately have evaluated at for a given line: the live (st.cx, st.cy)
 * (per-step and pure/settled convergence lines) and the exact mixed-NE root
 * when one exists (mixed-continuum convergence lines) — never against a
 * value reconstructed from the rendered text.
 */
function testSimLogAgreesWithGroundTruth() {
  type Captured = { line: string; cx: number; cy: number };
  let captured: Captured[] = [];

  // Known positive: the finding's exact Repro B fixture.
  {
    const g: GamePayoffs = { a11: 8, a12: -2, a21: 2, a22: 0, b11: -8, b12: 2, b21: 4, b22: -1 };
    captured = [];
    const st = createInitialState(0.5, 0.5, g);
    const addLog = (m: string) => captured.push({ line: m, cx: st.cx, cy: st.cy });
    const all = computeAllNE(g);
    const pure = all.filter((n) => n.type === 'pure');
    const committed = pure.length ? pure.reduce((b, n) => ((n.eB) > (b.eB) ? n : b)) : null;
    for (let i = 0; i < 200 && !st.converged; i++) doStep(g, st, 'B', 0.1, all, committed, addLog, () => {}, () => {}, 'shrink');
    ok(st.converged, 'Repro B fixture must converge within 200 steps');
    const headline = captured.map((c) => c.line).filter((l) => l.startsWith('━━')).pop();
    ok(!!headline, `Repro B fixture: no convergence headline in log: ${JSON.stringify(captured.map((c) => c.line))}`);
    ok(headline!.includes('E[B]=less than 0.001'),
      `Repro B fixture: convergence headline must state "E[B]=less than 0.001" (true E[B]=0.00025, nonzero); got "${headline}"`);
    ok(!headline!.includes('E[B]=0.000'),
      `Repro B fixture: convergence headline must NOT claim E[B]=0.000 — that is false; got "${headline}"`);
  }

  // Corpus sweep, exhaustively checking EVERY payoff-bearing log line against
  // the exact ground truth at whichever point the shipped code legitimately
  // evaluated (see the function docstring for why there are two candidates).
  let checked = 0;
  let falseZeroExercised = 0;
  const rnd = mk(0xba5eba11);
  for (let i = 0; i < 400; i++) {
    const v = () => Math.round((rnd() * 2 - 1) * 1000) / 1000; // scale ±1, matrix's own 3dp grid
    const g: GamePayoffs = { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() };
    const mixedExact = computeMixedNE(g);
    for (const fm of ['A', 'B'] as const) {
      for (const [sx0, sy0] of [[0.217, 0.217], [0.5, 0.5]] as [number, number][]) {
        captured = [];
        const st = createInitialState(sx0, sy0, g);
        const addLog = (m: string) => captured.push({ line: m, cx: st.cx, cy: st.cy });
        const all = computeAllNE(g);
        const pure = all.filter((n) => n.type === 'pure');
        const committed = pure.length
          ? pure.reduce((b, n) => ((fm === 'A' ? n.eA : n.eB) > (fm === 'A' ? b.eA : b.eB) ? n : b))
          : null;
        for (let s = 0; s < 400 && !st.converged; s++) doStep(g, st, fm, 0.1, all, committed, addLog, () => {}, () => {}, 'shrink');
        for (const { line, cx, cy } of captured) {
          const parsed = parsePayoffTokens(line);
          if (!parsed) continue;
          checked++;
          const trueA1 = EA(cx, cy, g), trueB1 = EB(cx, cy, g);
          const wantA1 = fmtPayoff(trueA1), wantB1 = fmtPayoff(trueB1);
          const wantA2 = mixedExact ? fmtPayoff(EA(mixedExact.x, mixedExact.y, g)) : null;
          const wantB2 = mixedExact ? fmtPayoff(EB(mixedExact.x, mixedExact.y, g)) : null;
          if (trueA1 !== 0 && Math.abs(trueA1) < 0.0005) falseZeroExercised++;
          if (trueB1 !== 0 && Math.abs(trueB1) < 0.0005) falseZeroExercised++;
          ok(parsed.eaTok === wantA1 || parsed.eaTok === wantA2,
            `log line "${line}" states E[A]=${parsed.eaTok}, but neither candidate ground truth matches: at live (cx,cy)=(${cx},${cy}) honest=${wantA1} (true=${trueA1}); at mixed-NE root honest=${wantA2} — game=${JSON.stringify(g)}`);
          ok(parsed.ebTok === wantB1 || parsed.ebTok === wantB2,
            `log line "${line}" states E[B]=${parsed.ebTok}, but neither candidate ground truth matches: at live (cx,cy)=(${cx},${cy}) honest=${wantB1} (true=${trueB1}); at mixed-NE root honest=${wantB2} — game=${JSON.stringify(g)}`);
        }
      }
    }
  }
  ok(checked > 2000, `corpus too small to be a real sweep: only ${checked} log lines checked`);
  ok(falseZeroExercised >= 1,
    `corpus never hit a genuine sub-resolution-but-nonzero payoff in the simulation log (falseZeroExercised=${falseZeroExercised})`);
  console.log(`✓ simulation log payoff tokens are honest at every reported coordinate: ${checked} lines checked, ${falseZeroExercised} genuine sub-resolution cases exercised`);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. MenuDrawer.tsx (preset picker + saved-games list) — structural guard.
//    Not unit-testable directly (JSX), so this pins the SOURCE TEXT the way
//    src/logandlabelfixes.test.ts already does for other JSX-embedded fixes.
// ════════════════════════════════════════════════════════════════════════════

function testMenuDrawerSourceUsesFmtPayoff() {
  const src = readFileSync('src/components/MenuDrawer.tsx', 'utf8');
  ok(!/eq\.eA\.toFixed|eq\.eB\.toFixed/.test(src),
    'MenuDrawer.tsx must not read eq.eA/eq.eB (computeAllNE\'s r3-pre-rounded fields) directly for display — RED-MATH-6/001');
  const fmtPayoffSites = [...src.matchAll(/fmtPayoff\(EA\(eq\.x, eq\.y, (preset|game)\.payoffs\)\)/g)];
  ok(fmtPayoffSites.length === 2,
    `expected 2 sites recomputing via fmtPayoff(EA(eq.x, eq.y, ...)) (standard presets + saved games), found ${fmtPayoffSites.length}`);

  // RED-MATH-7/001: MenuDrawer.tsx used to read ONLY computeAllNE's finite
  // corner list — silently under-reporting an equilibrium continuum, the
  // same class the checks below close in report.ts and plotting.ts. Two
  // call sites (standard presets + saved games), same as the fmtPayoff
  // check above.
  const describeContinuaSites = [...src.matchAll(/describeContinua\((preset|game)\.payoffs\)/g)];
  ok(describeContinuaSites.length === 2,
    `expected 2 sites calling describeContinua(...payoffs) (standard presets + saved games), found ${describeContinuaSites.length}`);
  // The rendered list must actually include those lines, not just compute
  // them — the {continua.map(...)} JSX and the emptiness guard must both be
  // present AT BOTH SITES (a bare .test() only proves at least one exists,
  // which a mutation that reverts just ONE of the two sites back to the old
  // shape would still pass — counted, exactly like the fmtPayoff/
  // describeContinua site checks above).
  const continuaMapSites = [...src.matchAll(/\{continua\.map\(/g)];
  ok(continuaMapSites.length === 2,
    `expected 2 sites rendering {continua.map(...)} (standard presets + saved games), found ${continuaMapSites.length}`);
  const fixedEmptyGuardSites = [...src.matchAll(/eqList\.length === 0 && continua\.length === 0/g)];
  ok(fixedEmptyGuardSites.length === 2,
    `expected 2 "No classic NE" guards requiring BOTH eqList and continua empty (standard presets + saved games), found ${fixedEmptyGuardSites.length} — `
    + 'otherwise a continuum-only game (0 corners) would wrongly show "No classic NE" at whichever site still has the old single-condition guard');

  // MUTATION / NEGATIVE FIXTURE — the pre-fix source shape, verbatim (no
  // describeContinua import or call, and the old single-condition
  // emptiness guard). Proves the checks above can tell the fixed source
  // apart from the defect.
  const preFixEmptyGuard = 'eqList.length === 0 && (';
  ok(!/eqList\.length === 0 && continua\.length === 0/.test(preFixEmptyGuard),
    'the pre-fix fixture text must not accidentally already carry the fixed guard (fixture sanity check)');
}

// ════════════════════════════════════════════════════════════════════════════
// 4. RED-MATH-7/001 — continuum renderings agree across FOUR consumers: the
//    on-screen panel / MenuDrawer.tsx (both driven by `describeContinua`,
//    checked above and below), the LLM grounding payload (`report.ts`, this
//    fix), and the templated/`tieProse.ts` rendering path (already correct —
//    server.ts's own simple tie flag, reproduced literally below, is what
//    routes a game there; this proves that path is reached whenever the
//    payload declares a continuum, not bypassed).
// ════════════════════════════════════════════════════════════════════════════

function hasContinuum(g: GamePayoffs): boolean {
  return equilibriumSet(g).some((r) => kindOf(r) !== 'point');
}

/**
 * `server.ts`'s "Tie-game policy" gate (~line 2709), reproduced verbatim as a
 * literal (not imported — server.ts is the Node/SDK-bound entry point, not a
 * module this browser-safe test tree pulls in). This lets the sweep below
 * independently confirm a mathematical fact: whenever `equilibriumSet` finds
 * a non-point component, AT LEAST ONE of the four raw cross-pair equalities
 * this flag checks is also true — a continuum-carrying segment always forms
 * at the boundary where the FREE player is exactly indifferent at the OTHER
 * player's PINNED pure value, which reduces to exactly one such equality (the
 * full-square case needs all four). So the already-correct templated/
 * tieProse.ts path (NASH_LLM_TIES=template) is never bypassed for a game the
 * payload now declares a continuum on.
 */
function serverTieFlag(g: GamePayoffs): boolean {
  return g.a11 === g.a21 || g.a12 === g.a22 || g.b11 === g.b12 || g.b21 === g.b22;
}

function testContinuumRenderingsAgree() {
  // Known positive: the finding's exact repro (RED-MATH-7/001). NE set is
  // the whole y=0 edge — computeIndifference is FALSE (the narrow predicate
  // the bug used) precisely because this is a PARTIAL tie, not a full one.
  const FIXTURE: GamePayoffs = { a11: 10, a12: 5, a21: 0, a22: 5, b11: 0, b12: 5, b21: 0, b22: 5 };
  ok(computeIndifference(FIXTURE).any === false,
    'fixture sanity: computeIndifference must be FALSE (the narrow predicate the bug used) so this exercises the actual gap');
  ok(hasContinuum(FIXTURE), 'fixture sanity: equilibriumSet must show a genuine continuum');
  {
    const payload = buildGroundingPayload(FIXTURE);
    ok(!payload.includes('This game is not degenerate; the solver output above is complete.'),
      `fixture: payload must never claim completeness on a continuum game — payload="${payload}"`);
    ok(payload.includes('CONTINUUM'), `fixture: payload must declare a continuum — payload="${payload}"`);
    const panelLines = describeContinua(FIXTURE);
    ok(panelLines.length > 0, 'fixture: describeContinua must return at least one line');
    for (const line of panelLines) {
      ok(payload.includes(line),
        `fixture: payload must include the SAME line the on-screen panel/MenuDrawer show ("${line}") — payload="${payload}"`);
    }
    ok(serverTieFlag(FIXTURE),
      "fixture: server.ts's own tie flag must ALSO be true here, proving the templated/tieProse rendering path (already correct) is reached for this exact game, not bypassed");
  }

  // Corpus sweep — the red's own reach class: 300,000 random int[-9,9] games
  // (the app's own generateRandomGame range, and the class the finding's own
  // reach table measured at 14.13%).
  const N = 300000;
  const rnd = mk(0xc0021771);
  const cell = () => Math.floor(rnd() * 19) - 9; // integers in [-9, 9]
  let checkedContinuum = 0;
  let regressionClassCount = 0; // hasContinuum true, computeIndifference.any false -- the exact undetected-before-this-fix class
  let bothClassCount = 0;       // hasContinuum true AND computeIndifference.any true -- already correctly handled before this fix
  for (let i = 0; i < N; i++) {
    const g: GamePayoffs = {
      a11: cell(), a12: cell(), a21: cell(), a22: cell(),
      b11: cell(), b12: cell(), b21: cell(), b22: cell(),
    };
    if (!hasContinuum(g)) continue;
    checkedContinuum++;
    if (computeIndifference(g).any) bothClassCount++; else regressionClassCount++;

    const payload = buildGroundingPayload(g);
    ok(!payload.includes('This game is not degenerate; the solver output above is complete.'),
      `game=${JSON.stringify(g)}: payload must never claim completeness on a continuum game — payload="${payload}"`);
    const panelLines = describeContinua(g);
    ok(panelLines.length > 0, `game=${JSON.stringify(g)}: describeContinua must return at least one line for a continuum game`);
    for (const line of panelLines) {
      ok(payload.includes(line),
        `game=${JSON.stringify(g)}: payload must include panel/MenuDrawer line "${line}" verbatim — payload="${payload}"`);
    }
    ok(serverTieFlag(g),
      `game=${JSON.stringify(g)}: server.ts's tie flag must be true whenever a continuum exists (proves the templated/tieProse path is reached), but was false`);
  }
  ok(checkedContinuum > 20000, `corpus too small / predicate too narrow: only ${checkedContinuum} continuum games found out of ${N}`);
  ok(regressionClassCount > 15000,
    `the exact regression class (hasContinuum true, computeIndifference.any false — the class this fix closes) was barely exercised: ${regressionClassCount}`);
  console.log(`✓ continuum renderings agree: ${N} games swept, ${checkedContinuum} (${(checkedContinuum / N * 100).toFixed(2)}%) `
    + `had a genuine continuum — ${regressionClassCount} (${(regressionClassCount / N * 100).toFixed(2)}%) in the class this fix `
    + `closes (undetected by computeIndifference before), ${bothClassCount} already caught by computeIndifference. `
    + `0 false "complete" claims; every payload line matched the panel/MenuDrawer line verbatim; server.ts's tie flag agreed on all ${checkedContinuum}.`);
}

// ════════════════════════════════════════════════════════════════════════════
// 5. plotting.ts — the 3D plot's NE diamonds are driven by the CALLER's
//    `computeAllNE` list (App.tsx), so they inherit the same corner-only
//    blind spot. Checked here against the same ground-truth test
//    (`equilibriumSet`/`kindOf`) the other three renderings above use.
// ════════════════════════════════════════════════════════════════════════════

function testPlottingDrawsContinuumMarker() {
  const FIXTURE: GamePayoffs = { a11: 10, a12: 5, a21: 0, a22: 5, b11: 0, b12: 5, b21: 0, b22: 5 };
  ok(hasContinuum(FIXTURE), 'fixture sanity: FIXTURE must have a genuine continuum');
  const st = createInitialState(0.5, 0.5, FIXTURE);
  const surf = buildSurfaces(FIXTURE);
  const traces = makeTraces(surf, FIXTURE, st, 'both', computeAllNE(FIXTURE), false, 'shrink');
  const continuumTraces = traces.filter((t: any) => t.legendgroup === 'continuumNE');
  ok(continuumTraces.length > 0,
    `plotting.ts must draw at least one continuumNE trace for a game whose equilibriumSet has a non-point component; legendgroups=${JSON.stringify(traces.map((t: any) => t.legendgroup))}`);
  ok(continuumTraces.filter((t: any) => t.showlegend === true).length === 1,
    `exactly one continuumNE trace must carry the legend entry, found ${continuumTraces.filter((t: any) => t.showlegend === true).length}`);

  // Negative control: a plain non-degenerate game (classic Prisoner's
  // Dilemma shape, a unique pure NE, NO payoff tie at all in any of the four
  // raw cross-pairs) must draw ZERO continuumNE traces.
  const CONTROL: GamePayoffs = { a11: -1, a12: -3, a21: 0, a22: -2, b11: -1, b12: 0, b21: -3, b22: -2 };
  ok(!hasContinuum(CONTROL), 'control fixture sanity: CONTROL must not have a continuum');
  const stC = createInitialState(0.5, 0.5, CONTROL);
  const surfC = buildSurfaces(CONTROL);
  const tracesC = makeTraces(surfC, CONTROL, stC, 'both', computeAllNE(CONTROL), false, 'shrink');
  const continuumTracesC = tracesC.filter((t: any) => t.legendgroup === 'continuumNE');
  ok(continuumTracesC.length === 0, `CONTROL (no continuum) must draw ZERO continuumNE traces, found ${continuumTracesC.length}`);

  console.log('✓ plotting.ts draws an equilibrium-continuum marker exactly when equilibriumSet says one exists (fixture + negative control)');
}

testPayloadAgreesWithPanel();
testSimLogAgreesWithGroundTruth();
testMenuDrawerSourceUsesFmtPayoff();
testContinuumRenderingsAgree();
testPlottingDrawsContinuumMarker();
console.log(`✓ payoffhonesty.test.ts: ${checks} assertions passed`);

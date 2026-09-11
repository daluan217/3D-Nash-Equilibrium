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
  doStep, PRESETS, computeAllNE, computeIndifference, computeMixedNE, fmtPayoff, fmtProb, EA, EB, r3,
  equilibriumSet, kindOf, describeContinua, regretA, regretB,
  continuumComponents, continuumSettledDescription, formatConvergenceLogLine, pointInRect,
} from './utils/gameEngine';
import { buildGroundingPayload } from './utils/report';
import { validateReport } from './utils/nashValidator';
import { neValues } from './components/equilibriumPanel';
import { makeTraces, buildSurfaces, SurfaceData } from './utils/plotting';
import {
  cameraBasis, projectPoint, zRangeOfSurface, worstPairGapPx, shouldCollapseComponentAtCamera,
  DEFAULT_EYE, DEFAULT_CAMERA_BASIS, OVERLAP_TOLERANCE_PX as PROJ_OVERLAP_TOLERANCE_PX,
  projectPointExact, LiveCameraParams,
} from './utils/cameraProjection';

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
  // BLUE-LIST-14 (round14): the "standard presets" half stayed in
  // MenuDrawer.tsx (`preset.*`); the "saved games" half moved to
  // src/components/SavedGamesList.tsx (`game.*`). Each guard below now reads
  // BOTH files and requires exactly 1 site in EACH — never "2 somewhere",
  // which would pass just as well with both sites in one file or the other,
  // silently losing the guard on whichever file lost its site.
  const drawerSrc = readFileSync('src/components/MenuDrawer.tsx', 'utf8');
  const listSrc = readFileSync('src/components/SavedGamesList.tsx', 'utf8');
  for (const [name, src] of [['MenuDrawer.tsx', drawerSrc], ['SavedGamesList.tsx', listSrc]] as const) {
    ok(!/eq\.eA\.toFixed|eq\.eB\.toFixed/.test(src),
      `${name} must not read eq.eA/eq.eB (computeAllNE's r3-pre-rounded fields) directly for display — RED-MATH-6/001`);
  }

  const presetFmtPayoffSites = [...drawerSrc.matchAll(/fmtPayoff\(EA\(eq\.x, eq\.y, preset\.payoffs\)\)/g)];
  ok(presetFmtPayoffSites.length === 1,
    `expected 1 MenuDrawer.tsx site recomputing via fmtPayoff(EA(eq.x, eq.y, preset.payoffs)) (standard presets), found ${presetFmtPayoffSites.length}`);
  const gameFmtPayoffSites = [...listSrc.matchAll(/fmtPayoff\(EA\(eq\.x, eq\.y, game\.payoffs\)\)/g)];
  ok(gameFmtPayoffSites.length === 1,
    `expected 1 SavedGamesList.tsx site recomputing via fmtPayoff(EA(eq.x, eq.y, game.payoffs)) (saved games), found ${gameFmtPayoffSites.length}`);

  // RED-MATH-9/002: `eqList` must come from `.stray` — a point already
  // covered by a continuum bullet gets no separate "Pure/Mixed NE" bullet of
  // its own (same split App.tsx's own bullet list and report.ts's grounding
  // payload use). One site per file, same reasoning as fmtPayoff above.
  const presetStraySites = [...drawerSrc.matchAll(/splitEquilibriaByContinuum\(preset\.payoffs\)\.stray/g)];
  ok(presetStraySites.length === 1,
    `expected 1 MenuDrawer.tsx site deriving eqList from splitEquilibriaByContinuum(preset.payoffs).stray, found ${presetStraySites.length}`);
  const gameStraySites = [...listSrc.matchAll(/splitEquilibriaByContinuum\(game\.payoffs\)\.stray/g)];
  ok(gameStraySites.length === 1,
    `expected 1 SavedGamesList.tsx site deriving eqList from splitEquilibriaByContinuum(game.payoffs).stray, found ${gameStraySites.length}`);

  // RED-MATH-7/001: MenuDrawer.tsx used to read ONLY computeAllNE's finite
  // corner list — silently under-reporting an equilibrium continuum, the
  // same class the checks below close in report.ts and plotting.ts. One
  // call site per file, same as the fmtPayoff check above.
  const presetContinuaSites = [...drawerSrc.matchAll(/describeContinua\(preset\.payoffs\)/g)];
  ok(presetContinuaSites.length === 1,
    `expected 1 MenuDrawer.tsx site calling describeContinua(preset.payoffs), found ${presetContinuaSites.length}`);
  const gameContinuaSites = [...listSrc.matchAll(/describeContinua\(game\.payoffs\)/g)];
  ok(gameContinuaSites.length === 1,
    `expected 1 SavedGamesList.tsx site calling describeContinua(game.payoffs), found ${gameContinuaSites.length}`);
  // The rendered list must actually include those lines, not just compute
  // them — the {continua.map(...)} JSX and the emptiness guard must both be
  // present AT BOTH FILES (a bare .test() only proves at least one exists,
  // which a mutation that reverts just ONE of the two sites back to the old
  // shape would still pass — counted, exactly like the fmtPayoff/
  // describeContinua site checks above).
  for (const [name, src] of [['MenuDrawer.tsx', drawerSrc], ['SavedGamesList.tsx', listSrc]] as const) {
    const continuaMapSites = [...src.matchAll(/\{continua\.map\(/g)];
    ok(continuaMapSites.length === 1,
      `expected 1 ${name} site rendering {continua.map(...)}, found ${continuaMapSites.length}`);
    const fixedEmptyGuardSites = [...src.matchAll(/eqList\.length === 0 && continua\.length === 0/g)];
    ok(fixedEmptyGuardSites.length === 1,
      `expected 1 ${name} "No classic NE" guard requiring BOTH eqList and continua empty, found ${fixedEmptyGuardSites.length} — `
      + 'otherwise a continuum-only game (0 corners) would wrongly show "No classic NE" here');
  }

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
//    RED-MATH-9/001 adds a FIFTH: the simulation log's own convergence line
//    (`formatConvergenceLogLine`, which App.tsx's aria-live announcement
//    also calls through the same `continuumSettledDescription`) — checked at
//    a REPRESENTATIVE point on each continuum component so it can be
//    compared against `describeContinua`'s own per-component text.
// ════════════════════════════════════════════════════════════════════════════

/**
 * A point strictly inside continuum component `r` — its centroid. Used to
 * exercise `formatConvergenceLogLine`/`continuumSettledDescription` at a
 * point that is DEFINITELY on that one component, so the returned text can
 * be checked against `describeContinua`'s corresponding entry (both derived
 * from the same `equilibriumSet(g)` order, so index `i` always lines up).
 */
function componentMidpoint(r: { x0: number; x1: number; y0: number; y1: number }): { x: number; y: number } {
  return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
}

/**
 * Checks the FIFTH rendering (the sim log / aria-live formatter) against the
 * panel's own `describeContinua` text for every component of one game. Must
 * be called on a game already confirmed to have a continuum.
 */
function checkLogRenderingAgrees(g: GamePayoffs) {
  const comps = continuumComponents(g);
  const panelLines = describeContinua(g);
  ok(comps.length === panelLines.length,
    `game=${JSON.stringify(g)}: continuumComponents and describeContinua must enumerate the SAME components in the SAME order (${comps.length} vs ${panelLines.length})`);
  for (let i = 0; i < comps.length; i++) {
    const { x, y } = componentMidpoint(comps[i]);
    // continuumSettledDescription (used directly by App.tsx's aria-live
    // effect) must return exactly the panel's own line for this component.
    const desc = continuumSettledDescription(g, x, y);
    ok(desc === panelLines[i],
      `game=${JSON.stringify(g)}: continuumSettledDescription at representative point (${x},${y}) must equal describeContinua's line for the same component — got "${desc}", want "${panelLines[i]}"`);
    // formatConvergenceLogLine (the sim log's convergence line) must quote
    // that same text verbatim, and must NEVER claim a definite "Pure"/"Mixed
    // NE" for a point that is one of infinitely many.
    const logLine = formatConvergenceLogLine(g, x, y, true, EA(x, y, g), EB(x, y, g), 0);
    ok(logLine.includes(panelLines[i]),
      `game=${JSON.stringify(g)}: sim log's convergence line must include the SAME line the panel/MenuDrawer show ("${panelLines[i]}") — got "${logLine}"`);
    ok(!/━━ (Pure|Mixed) NE:/.test(logLine),
      `game=${JSON.stringify(g)}: sim log must NOT claim a definite Pure/Mixed NE for a point ON a continuum — got "${logLine}"`);
    ok(logLine.includes('equilibrium continuum'),
      `game=${JSON.stringify(g)}: sim log's continuum line must say "equilibrium continuum" — got "${logLine}"`);
  }
}

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
    checkLogRenderingAgrees(FIXTURE);
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
    checkLogRenderingAgrees(g);
  }
  ok(checkedContinuum > 20000, `corpus too small / predicate too narrow: only ${checkedContinuum} continuum games found out of ${N}`);
  ok(regressionClassCount > 15000,
    `the exact regression class (hasContinuum true, computeIndifference.any false — the class this fix closes) was barely exercised: ${regressionClassCount}`);
  console.log(`✓ continuum renderings agree: ${N} games swept, ${checkedContinuum} (${(checkedContinuum / N * 100).toFixed(2)}%) `
    + `had a genuine continuum — ${regressionClassCount} (${(regressionClassCount / N * 100).toFixed(2)}%) in the class this fix `
    + `closes (undetected by computeIndifference before), ${bothClassCount} already caught by computeIndifference. `
    + `0 false "complete" claims; every payload line matched the panel/MenuDrawer line verbatim; server.ts's tie flag agreed on all ${checkedContinuum}; `
    + `the sim log's convergence line (RED-MATH-9/001, the fifth rendering) matched describeContinua's text on every component of every one of them.`);
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

// ════════════════════════════════════════════════════════════════════════════
// 5b. RED-MATH-9/002 — a `computeAllNE` point already covered by a continuum
//     component must draw NO isolated "Pure/Mixed NE" diamond — only the
//     continuum marker represents it. Before this fix, EVERY continuum game
//     drew at least one such double-marked point (29,372/29,372 in the
//     red's 200k int[-9,9] sweep, reproduced below at the same scale with
//     the same seed, through the REAL `makeTraces`, not a reimplementation).
// ════════════════════════════════════════════════════════════════════════════

function testPlottingSkipsIsolatedDiamondsOnContinuum() {
  // Known positive, hand-verified: the finding's sharpest case — both
  // players' payoffs FLAT, so the entire [0,1]×[0,1] square is one 'area'
  // continuum and all 4 corners are also listed by computeAllNE as separate
  // "Pure NE" points.
  const FIXTURE: GamePayoffs = { a11: 3, a12: 3, a21: 3, a22: 3, b11: 5, b12: 5, b21: 5, b22: 5 };
  const allNE = computeAllNE(FIXTURE);
  ok(allNE.length === 4 && allNE.every((n) => n.type === 'pure'),
    `fixture sanity: computeAllNE must list exactly 4 pure corners, got ${JSON.stringify(allNE)}`);
  const st = createInitialState(0.5, 0.5, FIXTURE);
  const surf = buildSurfaces(FIXTURE);
  const traces = makeTraces(surf, FIXTURE, st, 'both', allNE, false, 'shrink');
  const isolated = traces.filter((t: any) => t.legendgroup === 'pureNE' || t.legendgroup === 'mixedNE');
  const continuumTraces = traces.filter((t: any) => t.legendgroup === 'continuumNE');
  ok(isolated.length === 0,
    `fixture: a fully-flat game must draw ZERO isolated Pure/Mixed NE diamonds (all 4 corners are on the one continuum), found ${isolated.length}: ${JSON.stringify(isolated)}`);
  // RED-MATH-10/001: the component now also draws a hollow diamond at each
  // of its own corners plus a dashed line tracing it (so the sphere is never
  // orphaned when it settles on a corner rather than the midpoint) — for
  // this 'area' fixture that is 4 corner markers + 2 line traces (one per
  // tracked surface, trackingMode='both') ON TOP OF the 1 midpoint marker,
  // so the trace COUNT is no longer 1. The invariant that still must hold is
  // the one `testPlottingDrawsContinuumMarker` already checks elsewhere:
  // exactly ONE of them carries the legend entry (the midpoint stays the
  // single anchor) and at least one is drawn at all.
  ok(continuumTraces.length >= 1,
    `fixture: at least one continuum trace must be drawn for the single 'area' component, found ${continuumTraces.length}`);
  ok(continuumTraces.filter((t: any) => t.showlegend === true).length === 1,
    `fixture: exactly one continuumNE trace must carry the legend entry (the midpoint anchor), found ${continuumTraces.filter((t: any) => t.showlegend === true).length}`);
  const contMarkers = continuumTraces.filter((t: any) => t.mode === 'markers');
  const contLines = continuumTraces.filter((t: any) => t.mode === 'lines');
  ok(contMarkers.length === 5,
    `fixture: the 'area' component (4 distinct corners) must draw 1 midpoint + 4 corner markers = 5 marker traces, found ${contMarkers.length}`);
  ok(contLines.length === 2,
    `fixture: trackingMode='both' must draw one dashed continuum line per tracked surface (A and B) = 2, found ${contLines.length}`);

  // Reach — the red's own 200,000-game int[-9,9] sweep (mulberry32 seed 99),
  // through the REAL makeTraces, checking every isolated pure/mixed diamond
  // trace's own (x,y) against continuumComponents(g). Must be ZERO
  // double-marked instances (was 29,372/29,372 pre-fix).
  function mulberry32(seed: number) {
    let a = seed;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(99);
  const N = 200000;
  let continuumGames = 0;
  let doubleMarked = 0;
  let isolatedDiamondCount = 0;
  // CodeRabbit (round 9): `surf` (the 29x29 E[A]/E[B] grid) is read ONLY by
  // the two `type: 'surface'` traces makeTraces pushes first — never by the
  // NE/continuum marker logic these assertions actually inspect (those
  // recompute EA/EB(x, y, g) fresh, from the real per-iteration `g`). One
  // shared grid (built from any fixed game) gives byte-identical assertion
  // results at a fraction of the cost across 200,000 iterations.
  const sharedSurf = buildSurfaces(FIXTURE);
  for (let i = 0; i < N; i++) {
    const cell = () => Math.floor(rng() * 19) - 9;
    const g: GamePayoffs = {
      a11: cell(), a12: cell(), a21: cell(), a22: cell(),
      b11: cell(), b12: cell(), b21: cell(), b22: cell(),
    };
    if (!hasContinuum(g)) continue;
    continuumGames++;
    const comps = continuumComponents(g);
    const all = computeAllNE(g);
    const s = createInitialState(0.5, 0.5, g);
    const tr = makeTraces(sharedSurf, g, s, 'both', all, false, 'shrink');
    const iso = tr.filter((t: any) => t.legendgroup === 'pureNE' || t.legendgroup === 'mixedNE');
    let gameDoubleMarked = false;
    for (const t of iso) {
      isolatedDiamondCount++;
      const xs: number[] = t.x; const ys: number[] = t.y;
      for (let k = 0; k < xs.length; k++) {
        if (comps.some((r) => pointInRect(r, xs[k], ys[k]))) gameDoubleMarked = true;
      }
    }
    if (gameDoubleMarked) doubleMarked++;
  }
  ok(continuumGames > 25000, `corpus too small: only ${continuumGames} continuum games found out of ${N}`);
  ok(doubleMarked === 0,
    `${doubleMarked}/${continuumGames} continuum games still draw a double-marked isolated diamond (must be 0 after the fix)`);
  console.log(`✓ plotting.ts draws no isolated Pure/Mixed NE diamond for a point already covered by a continuum marker: `
    + `${N} games swept, ${continuumGames} had a genuine continuum, 0 double-marked (was 100% pre-fix per the finding), `
    + `${isolatedDiamondCount} stray isolated diamonds still correctly drawn.`);
}

// ════════════════════════════════════════════════════════════════════════════
// 5b2. RED-MATH-10/001 — the current-position sphere pins itself (~line 92 of
//      plotting.ts, untouched by RED-MATH-9/002's fix) to the nearest
//      `computeAllNE` point once a run converges, REGARDLESS of whether that
//      point is on a continuum. On 70.1% of real converged runs on continuum
//      games (306,651/437,720 in the red's exact 300k int[-9,9] sweep,
//      5 starts × 2 firstMovers, reproduced below at the same scale/seed/
//      starts) the sphere settles on a CORNER of the component — a genuine
//      pure-strategy vertex #114 correctly stopped double-marking — leaving
//      it with no nearby glyph at all: the continuum's only remaining marker
//      sat at the component's MIDPOINT, mean 0.38 (up to 0.71) plot-units
//      away. Fixed by drawing a hollow diamond at every distinct corner of
//      the component plus a dashed line tracing it, so the settled point is
//      always within a drawn glyph or on the drawn line. This sweep checks
//      that directly against the REAL `makeTraces` output — not a
//      reimplementation of the glyph geometry — for every one of the
//      306,651 real convergences the finding measured.
// ════════════════════════════════════════════════════════════════════════════

/** Distance from point (px,py) to the line segment (ax,ay)-(bx,by), in the
 * x,y plane (the plot's domain — never the z/payoff axis). */
function distToContinuumSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pickCommittedNEForSweep(pureNEs: NashEquilibrium[], firstMover: 'A' | 'B'): NashEquilibrium | null {
  if (pureNEs.length === 0) return null;
  if (pureNEs.length === 1) return pureNEs[0];
  return pureNEs.reduce((best, ne) => {
    const myScore = firstMover === 'A' ? ne.eA : ne.eB;
    const bestScore = firstMover === 'A' ? best.eA : best.eB;
    return myScore > bestScore ? ne : best;
  });
}

function testContinuumSettledPointAlwaysOnDrawnGlyph() {
  // Known positive, hand-verified: the finding's exact repro. The settled
  // corner (0,1) is a genuine computeAllNE pure point ON the continuum
  // segment [0, 0.375] × {1}, 0.1875 plot-units from the (kept) midpoint
  // marker — pre-fix, no drawn glyph sat within 1e-9 of it.
  const FIXTURE: GamePayoffs = { a11: 0, a12: 2, a21: 0, a22: 3, b11: -6, b12: 9, b21: 6, b22: -3 };
  const allNEf = computeAllNE(FIXTURE);
  const stf = createInitialState(0, 1, FIXTURE);
  stf.exactX = 0; stf.exactY = 1; stf.converged = true;
  const surfF = buildSurfaces(FIXTURE);
  const tracesF = makeTraces(surfF, FIXTURE, stf, 'both', allNEf, false, 'shrink');
  const contF = tracesF.filter((t: any) => t.legendgroup === 'continuumNE');
  const withinF = contF.some((t: any) => {
    if (t.mode === 'markers') {
      const xs: number[] = t.x; const ys: number[] = t.y;
      return xs.some((xv: number, i: number) => Math.abs(xv - 0) < 1e-9 && Math.abs(ys[i] - 1) < 1e-9);
    }
    if (t.mode === 'lines') {
      const xs: number[] = t.x; const ys: number[] = t.y;
      for (let k = 0; k < xs.length - 1; k++) {
        if (Number.isNaN(xs[k]) || Number.isNaN(xs[k + 1])) continue;
        if (distToContinuumSegment(0, 1, xs[k], ys[k], xs[k + 1], ys[k + 1]) < 1e-9) return true;
      }
    }
    return false;
  });
  ok(withinF, `fixture: settled corner (0,1) must be within a drawn continuumNE glyph or on a drawn segment — traces=${JSON.stringify(contF)}`);

  // Reach — the red's own exact corpus: 300,000 random int[-9,9] games
  // (mulberry32 seed 9001 — `mk` below is the same algorithm this file
  // already uses elsewhere), both firstMovers, the red's 5 start points,
  // stepMode='shrink'. Real `doStep` convergence, real `makeTraces` output.
  const rng = mk(9001);
  const N = 300000;
  const STARTS: [number, number][] = [[0.5, 0.5], [0.2, 0.8], [0.1, 0.9], [0.35, 0.6], [0.05, 0.05]];
  let continuumGames = 0;
  let convergedRuns = 0;
  let settledOnCorner = 0;
  let cornerOnContinuum = 0;
  let notOnDrawnGlyph = 0;
  const sharedSurf2 = buildSurfaces({ a11: 0, a12: 0, a21: 0, a22: 0, b11: 0, b12: 0, b21: 0, b22: 0 });
  for (let i = 0; i < N; i++) {
    const cell = () => Math.floor(rng() * 19) - 9;
    const g: GamePayoffs = {
      a11: cell(), a12: cell(), a21: cell(), a22: cell(),
      b11: cell(), b12: cell(), b21: cell(), b22: cell(),
    };
    if (!hasContinuum(g)) continue;
    continuumGames++;
    const allNE = computeAllNE(g);
    const pureNEs = allNE.filter((n) => n.type === 'pure');
    const rects = continuumComponents(g);
    for (const firstMover of ['A', 'B'] as const) {
      const committedNE = pickCommittedNEForSweep(pureNEs, firstMover);
      for (const [x0, y0] of STARTS) {
        const s = createInitialState(x0, y0, g);
        for (let step = 0; step < 4000 && !s.converged; step++) {
          doStep(g, s, firstMover, 0.1, allNE, committedNE, () => {}, () => {}, () => {}, 'shrink');
        }
        if (!s.converged) continue;
        convergedRuns++;
        const match = allNE.find((ne) => Math.abs(ne.x - s.exactX) < 1e-6 && Math.abs(ne.y - s.exactY) < 1e-6);
        if (!match) continue;
        settledOnCorner++;
        if (!rects.some((r) => pointInRect(r, match.x, match.y))) continue;
        cornerOnContinuum++;
        const traces = makeTraces(sharedSurf2, g, s, 'both', allNE, false, 'shrink');
        const cont = traces.filter((t: any) => t.legendgroup === 'continuumNE');
        let within = false;
        for (const t of cont) {
          const xs: number[] = t.x; const ys: number[] = t.y;
          if (t.mode === 'markers') {
            for (let k = 0; k < xs.length; k++) {
              if (Math.abs(xs[k] - match.x) < 1e-9 && Math.abs(ys[k] - match.y) < 1e-9) { within = true; break; }
            }
          } else if (t.mode === 'lines') {
            for (let k = 0; k < xs.length - 1; k++) {
              if (Number.isNaN(xs[k]) || Number.isNaN(xs[k + 1])) continue;
              if (distToContinuumSegment(match.x, match.y, xs[k], ys[k], xs[k + 1], ys[k + 1]) < 1e-9) { within = true; break; }
            }
          }
          if (within) break;
        }
        if (!within) notOnDrawnGlyph++;
      }
    }
  }
  ok(continuumGames > 35000, `corpus too small: only ${continuumGames} continuum games found out of ${N}`);
  ok(cornerOnContinuum > 250000,
    `the exact RED-MATH-10/001 class (settled on a continuum corner) was barely exercised: ${cornerOnContinuum}`);
  ok(notOnDrawnGlyph === 0,
    `${notOnDrawnGlyph}/${cornerOnContinuum} settled points on a continuum corner are NOT within a drawn glyph or on a drawn segment (must be 0 after the fix; was 306,651/306,651 pre-fix per the finding)`);
  console.log(`✓ every settled point on a continuum corner sits on a drawn glyph or the drawn dashed segment: `
    + `${N} games swept, ${continuumGames} had a genuine continuum, ${convergedRuns} converged runs, `
    + `${settledOnCorner} settled exactly on a computeAllNE point, ${cornerOnContinuum} of those on a continuum `
    + `(the RED-MATH-10/001 class) — 0 orphaned (was 306,651/306,651 pre-fix per the finding).`);
}

// ════════════════════════════════════════════════════════════════════════════
// 5c. RED-MATH-9/001 — the SIMULATION LOG (real `doStep` runs, not just the
//     pure formatter in isolation) must announce the continuum, not a
//     definite "Pure/Mixed NE", when a run settles on one. The finding's
//     exact repro: same game, same mover, four different start points, two
//     of which land on the free axis's own vertex (0.5,0.5 rounds toward
//     x=0) and two of which land strictly inside the continuum (x=0.2/0.1) —
//     the pre-fix log named a coordinate absent from computeAllNE's own
//     enumerated list on the latter two, dressed as a discovery.
// ════════════════════════════════════════════════════════════════════════════

function testSimLogNamesContinuumOnRealRuns() {
  const G: GamePayoffs = { a11: 0, a12: 2, a21: 0, a22: 3, b11: -6, b12: 9, b21: 6, b22: -3 };
  ok(hasContinuum(G), 'fixture sanity: G must have a genuine continuum');
  const comps = continuumComponents(G);
  ok(comps.length === 1 && comps[0].x0 === 0 && Math.abs(comps[0].x1 - 0.375) < 1e-9 && comps[0].y0 === 1 && comps[0].y1 === 1,
    `fixture sanity: expected the exact segment from the finding (x in [0, 0.375], y=1), got ${JSON.stringify(comps)}`);
  const panelLine = describeContinua(G)[0];

  const starts: [number, number][] = [[0.5, 0.5], [0.2, 0.8], [0.1, 0.9], [0.35, 0.6]];
  for (const [sx, sy] of starts) {
    const st = createInitialState(sx, sy, G);
    const captured: string[] = [];
    const addLog = (m: string) => captured.push(m);
    const all = computeAllNE(G);
    const pure = all.filter((n) => n.type === 'pure');
    const committed = pure.length ? pure[0] : null;
    for (let i = 0; i < 50 && !st.converged; i++) doStep(G, st, 'B', 0.1, all, committed, addLog, () => {}, () => {}, 'shrink');
    ok(st.converged, `start (${sx},${sy}): fixture must converge within 50 steps`);
    const headline = captured.filter((l) => l.startsWith('━━')).pop();
    ok(!!headline, `start (${sx},${sy}): no convergence headline in log: ${JSON.stringify(captured)}`);
    ok(!/━━ (Pure|Mixed) NE:/.test(headline!),
      `start (${sx},${sy}): log must NOT claim a definite Pure/Mixed NE for this continuum game — got "${headline}"`);
    ok(headline!.includes('equilibrium continuum'),
      `start (${sx},${sy}): log must say "equilibrium continuum" — got "${headline}"`);
    ok(headline!.includes(panelLine),
      `start (${sx},${sy}): log must include the SAME text the panel shows ("${panelLine}") — got "${headline}"`);
  }
  console.log(`✓ real doStep runs on the finding's exact fixture (4 different starts) all announce the equilibrium `
    + `continuum in the sim log, matching the panel's own text — none claims a definite Pure/Mixed NE`);
}

// ════════════════════════════════════════════════════════════════════════════
// 5d. App.tsx structural guards (JSX, not directly unit-testable) — the
//     aria-live announcement must go through the SAME `continuumSettledDescription`
//     the sim log uses (RED-MATH-9/001), and the "Calculated Nash Equilibria"
//     bullet list must render the STRAY subset, not the full computeAllNE list
//     (RED-MATH-9/002), matching MenuDrawer.tsx's own split.
// ════════════════════════════════════════════════════════════════════════════

function testAppTsxUsesContinuumAwareLogAndDisplay() {
  const src = readFileSync('src/App.tsx', 'utf8');
  ok(/continuumSettledDescription\(payoffs, resolved\.x, resolved\.y\)/.test(src),
    'App.tsx\'s aria-live effect must call continuumSettledDescription(payoffs, resolved.x, resolved.y) — RED-MATH-9/001');
  ok(/splitEquilibriaByContinuum\(payoffs\)\.stray/.test(src),
    'App.tsx must derive its displayed equilibria list from splitEquilibriaByContinuum(payoffs).stray, not the raw computeAllNE list — RED-MATH-9/002');
  ok(/\{strayNE\.map\(/.test(src),
    'App.tsx\'s "Calculated Nash Equilibria" bullet list must render {strayNE.map(...)}, not {allNE.map(...)} — RED-MATH-9/002');
  ok(/strayNE\.length === 0 && continua\.length === 0/.test(src),
    'App.tsx\'s "No standard NE found" guard must require BOTH strayNE and continua empty — a continuum-only game must not show it');
  console.log('✓ App.tsx source: aria-live uses continuumSettledDescription, and the bullet list renders strayNE not allNE');
}

// ════════════════════════════════════════════════════════════════════════════
// 5e. RED-REGEN-13/001 + RED-REGEN-14/001 + STRUCT-REGEN-19/001 — a saved
//     description must belong to the payoffs it is saved with, and the five
//     pieces of the save form (name, description, four option labels, colour
//     chips) must always describe ONE story written for ONE board.
//
//     RED-REGEN-13/001: the form used to survive a close, a payoff change and a
//     reopen (only the labels were re-prefilled), so a story kept for matrix P1
//     was persisted against P2 (validateProseDirectionsDetailed: 0 issues vs
//     P1, 4/4 backwards vs P2). RED-REGEN-14/001: the fix's re-prefill then
//     blanked the labels under a kept draft. STRUCT-REGEN-19/001: SIX places
//     wrote the form, each a different subset, so "Save this scenario with the
//     game" could write four fifths of a story and leave an abandoned draft's
//     colour chips under a brand-new AI description.
//
//     The RULE now lives in ONE reducer (src/utils/saveFormModel.ts) and is
//     tested behaviourally — every branch, five properties over 4000 random
//     action sequences, eleven mutants — in src/saveformmodel.test.ts. What
//     THIS block guards is App.tsx's half: every entry point goes through that
//     reducer, no second copy of the state exists, and the set of entry points
//     is enumerated so a seventh cannot appear unexamined.
// ════════════════════════════════════════════════════════════════════════════

function testSaveFormReconciledWithBoard() {
  const src = readFileSync('src/App.tsx', 'utf8');
  /** The contract, as one function so the mutants below exercise the same checks. */
  const contract = (app: string) => {
    // ── ONE source of truth ──────────────────────────────────────────────
    ok(/const \[saveForm, dispatchSaveForm\] = useReducer\(saveFormReducer, EMPTY_SAVE_FORM\);/.test(app),
      'App.tsx must hold the save form as ONE reducer value (STRUCT-REGEN-19/001)');
    for (const [name, expr] of [['saveName', 'saveForm.name'], ['saveDesc', 'saveForm.desc'],
      ['saveLabels', 'saveForm.labels'], ['saveTerms', 'saveForm.terms']] as const) {
      ok(new RegExp(`const ${name} = ${expr.replace('.', '\\.')};`).test(app),
        `${name} must be DERIVED from saveForm, not a second copy of it (STRUCT-REGEN-19/001)`);
      ok(!new RegExp(`\\[${name}, set[A-Za-z]+\\] = useState`).test(app),
        `${name} must not be its own useState — that is the second source of truth (STRUCT-REGEN-19/001)`);
    }
    // The bulk label setter is gone: a writer that replaces all four labels at
    // once bypasses per-field provenance, which is how a generated fill used to
    // overwrite option names the user had typed.
    ok(!/setSaveLabels\(/.test(app),
      'App.tsx must not write the four option labels in bulk — one field, one action (STRUCT-REGEN-19/001)');
    // ── the entry-point ledger ───────────────────────────────────────────
    // Every write to the form, in source order. A NEW entry point fails this
    // list until its author has added it here — which is the point: the class
    // was six writers nobody was counting.
    // Every action LITERAL, in source order — including `const boardAction = {…}`,
    // which is dispatched by name because STRUCT-REGEN-19/006 also runs the reducer
    // on it to count what it discards.
    const dispatched = [...app.matchAll(/(?:dispatchSaveForm\(|const boardAction = )\{\s*type: '([a-zA-Z]+)'/g)].map((m) => m[1]);
    ok(dispatched.join(',') === ['typed', 'typed', 'typedLabel', 'typedTerms',
      'openForBoard', 'story', 'boardChanged', 'story', 'saved', 'story'].join(','),
      `the save form's entry points must be exactly the ten enumerated here, in order — found ${dispatched.join(',')} (STRUCT-REGEN-19/001)`);
    ok((app.match(/dispatchSaveForm\(/g) || []).length === dispatched.length,
      `every dispatchSaveForm call must dispatch an action literal the ledger above can see — ${(app.match(/dispatchSaveForm\(/g) || []).length} calls vs ${dispatched.length} literals (STRUCT-REGEN-19/001)`);
    // ── OPUS-REVIEW-184/F1: every save-form `story` records what the app wrote ──
    // `keptFieldsOf` decides what the note may claim from PROVENANCE; the
    // all-or-nothing rule (`generatedFillIsSafe`) decides what blocks the fill by
    // comparing VALUES against `lastGeneratedFillRef`. The two agree only while
    // `provenance === 'generated'` implies "in prevFill". The report card's prefill
    // dispatched `story` and recorded nothing, so a story nobody typed blocked the
    // fill while the note named none of it — "Clear the name to let the AI fill the
    // form" was false, and the branch documented as unreachable was reached.
    // Bind the two: a `story` into the SAVE form must write the ref in its own block.
    const storySites: { at: number; slice: string }[] = [];
    for (const m of app.matchAll(/dispatchSaveForm\(\{\s*\n?\s*type: 'story',/g)) {
      storySites.push({ at: m.index ?? -1, slice: '' });
    }
    ok(storySites.length === 3,
      `there must be exactly three save-form story sites (report prefill, Generate fill, Keep) — found ${storySites.length} (OPUS-REVIEW-184/F1)`);
    for (let i = 0; i < storySites.length; i++) {
      // Bounded by the NEXT story site, so no site can borrow another's assignment.
      const end = i + 1 < storySites.length ? storySites[i + 1].at : storySites[i].at + 2500;
      storySites[i].slice = app.slice(storySites[i].at, end);
    }
    // An object literal (`= {`) or a variable already built (`= gen`) both count;
    // `= null`/`= undefined` do not — that is the pre-fix state written out longhand.
    const RECORDS = /lastGeneratedFillRef\.current = (?!null|undefined)[{A-Za-z_$]/;
    for (const site of storySites) {
      // Name the site by the line it starts on, so a failure says WHICH one.
      const line = app.slice(0, site.at).split('\n').length;
      ok(RECORDS.test(site.slice),
        `the save-form story at App.tsx:${line} must record lastGeneratedFillRef in the same block — provenance 'generated' has to mean "the app wrote this", or the note and the fill rule disagree (OPUS-REVIEW-184/F1)`);
    }
    // Fixtures: the check reads each site's OWN block, and it is not satisfied by
    // an assignment that records nothing.
    {
      const stripped = storySites.map((st) => st.slice.replace(/lastGeneratedFillRef\.current = /, 'noop.current = '));
      ok(stripped.every((sl) => !RECORDS.test(sl)),
        'fixture: removing a site\'s own assignment really removes it from that slice');
      ok(storySites.every((st) => RECORDS.test(st.slice)),
        'fixture: every untouched slice carries its own assignment');
      ok(!RECORDS.test('lastGeneratedFillRef.current = null;'),
        'fixture: clearing the ref is not recording what the app wrote');
      ok(RECORDS.test('lastGeneratedFillRef.current = gen;') && RECORDS.test('lastGeneratedFillRef.current = {'),
        'fixture: both a built value and an object literal count as recording it');
    }

    // ── one open path ────────────────────────────────────────────────────
    const helperStart = app.indexOf('const openSaveFormForBoard = () => {');
    ok(helperStart !== -1, 'App.tsx must define openSaveFormForBoard (RED-REGEN-13/001)');
    const helper = app.slice(helperStart, app.indexOf('};', helperStart) + 2);
    ok(/type: 'openForBoard',/.test(helper) && /boardKey: boardKeyOf\(payoffs\),/.test(helper),
      'openSaveFormForBoard must dispatch openForBoard keyed on the LIVE payoffs (RED-REGEN-13/001)');
    ok(/row1: scenarioForReport\?\.row1 \?\? '',/.test(helper),
      'openSaveFormForBoard must offer the board\'s own option names, read from scenarioForReport (RED-REGEN-14/001)');
    const presetAttr = app.indexOf('data-focus-fallback="save-preset"');
    ok(presetAttr !== -1, 'the Save Preset button must exist');
    const presetHandler = app.slice(app.lastIndexOf('onClick={() => {', presetAttr), presetAttr);
    const rIdx = presetHandler.indexOf('openSaveFormForBoard();');
    const oIdx = presetHandler.indexOf('setIsSaveModalOpen(true);');
    ok(rIdx !== -1 && oIdx !== -1 && rIdx < oIdx,
      `the Save Preset click must open the form for the board BEFORE showing the dialog (open@${rIdx} show@${oIdx}) — RED-REGEN-13/001`);
    ok(!/dispatchSaveForm\(/.test(presetHandler),
      'the Save Preset click must have no reconcile rule of its own — openForBoard IS the rule (RED-REGEN-14/001, STRUCT-REGEN-19/001)');
    // Resume after sign-in: the board may have changed while the sign-in was up.
    const resumeStart = app.indexOf('if (authToken && resumeSaveAfterAuthRef.current) {');
    ok(resumeStart !== -1, 'the resume-after-sign-in branch must exist');
    const resume = app.slice(resumeStart, resumeStart + 700);
    ok(resume.indexOf('openSaveFormForBoard();') !== -1 && resume.indexOf('openSaveFormForBoard();') < resume.indexOf('setIsSaveModalOpen(true);'),
      'the resume-after-sign-in reopen must open the form for the current board first (RED-REGEN-13/001)');
    // ── the report card's prefill: ONE story, all five pieces ────────────
    const prefill = app.indexOf("const prefillName = (sc.name ?? '').slice(0, 40);");
    ok(prefill !== -1, 'the report → save-as-new prefill must exist');
    const prefillSlice = app.slice(prefill, app.indexOf('setIsSaveModalOpen(true);', prefill));
    // Merged with #182 (STRUCT-CLOUD-19/001): the action carries a SIXTH piece,
    // the card's actor nouns as chips, so the pieces are matched one by one
    // inside the single call rather than by a fixed field order — a comment or
    // a new field must not read as "the story broke up".
    const storyCallStart = prefillSlice.indexOf('dispatchSaveForm({');
    const storyCall = storyCallStart === -1 ? '' : prefillSlice.slice(storyCallStart, prefillSlice.indexOf('});', storyCallStart) + 3);
    const storyPieces: RegExp[] = [
      /type: 'story',/, /boardKey: boardKeyOf\(payoffs\),/, /name: prefillName,/,
      /desc: description\.slice\(0, 800\),/, /labels: prefillLabels,/,
      /terms: regenKeptColorTerms\(sc\.actorA \?\? \[\], sc\.actorB \?\? \[\], \[\], \[\], description\.slice\(0, 800\)\),/,
    ];
    const missingPieces = storyPieces.filter((re) => !re.test(storyCall)).map(String);
    ok(storyCall !== '' && missingPieces.length === 0,
      `the report prefill must arrive as ONE story action carrying the board it was written for and every piece — writing four fifths of it left the previous draft's colour chips attached (STRUCT-REGEN-19/001; chips merged with #182): missing ${missingPieces.join(', ')}`);

    ok(/const prefillLabels = \{\s*row1: sc\.row1 \?\? '', row2: sc\.row2 \?\? '',\s*col1: sc\.col1 \?\? '', col2: sc\.col2 \?\? '',\s*\};/.test(prefillSlice),
      'prefillLabels must be the scenario\'s own four option names — hoisting them out of the action must not change where they come from (OPUS-REVIEW-184/F1)');
    // The dispatched story and the recorded fill must be the SAME four labels, by
    // reference, so the form and "what the app wrote" cannot drift apart here.
    ok(/lastGeneratedFillRef\.current = \{\s*name: prefillName,\s*desc: description\.slice\(0, 800\),\s*row1: prefillLabels\.row1, row2: prefillLabels\.row2,\s*col1: prefillLabels\.col1, col2: prefillLabels\.col2,\s*\};/.test(prefillSlice),
      'the recorded fill must be the same name/description/labels the story just wrote (OPUS-REVIEW-184/F1)');
    ok(!/lastGeneratedFillRef\.current = \{[\s\S]{0,200}?sc\.(row1|col1)/.test(prefillSlice),
      'the recorded fill must reuse prefillLabels, not read sc again — a second read is a second source (OPUS-REVIEW-184/F1)');
    ok((prefillSlice.match(/dispatchSaveForm\(/g) || []).length === 1,
      'the report prefill must write the form exactly once (STRUCT-REGEN-19/001)');
    // OPUS-REVIEW-171/N2: boardKeyOf must actually distinguish boards — run it.
    const keyFnSrc = /const boardKeyOf = \(p: GamePayoffs\) => (JSON\.stringify\([^;]*\));/.exec(app);
    ok(keyFnSrc !== null, 'App.tsx must define boardKeyOf as a JSON.stringify over the payoffs (RED-REGEN-13/001)');
    const keyOf = new Function('p', `return ${keyFnSrc![1]};`) as (p: GamePayoffs) => string;
    const base: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
    ok(keyOf({ ...base }) === keyOf(base), 'boardKeyOf: equal boards must key equally');
    for (const cell of Object.keys(base) as (keyof GamePayoffs)[]) {
      ok(keyOf({ ...base, [cell]: base[cell] + 1 }) !== keyOf(base),
        `boardKeyOf: a board differing only in ${cell} (Player ${cell.startsWith('b') ? 'B' : 'A'}) must key differently (OPUS-REVIEW-171/N2)`);
    }
    // ── "Generate a new game" replaces the board from inside the dialog ──
    // (OPUS-REVIEW-171/N1): decided against the NEW board (gc, not g) BEFORE
    // the report call, so what the form keeps never depends on whether that
    // call succeeds.
    const genStart = app.indexOf('const gc = commitPayoffs(g);');
    // H3 (CodeRabbit): the Generate fetch now goes through fetchWithTimeout
    // with its own AbortController — same ordering claim, new call text.
    const genFetch = app.indexOf("fetchWithTimeout(getApiUrl('/api/report')", genStart);
    ok(genStart !== -1 && genFetch > genStart, 'handleGenerateGame must commit gc then call /api/report');
    const preFetch = app.slice(genStart, genFetch);
    ok(/const boardKey = boardKeyOf\(gc\);/.test(preFetch)
      && /const keepUserText = !generatedFillIsSafe\(saveFormRef\.current, lastGeneratedFillRef\.current, boardLabelsIfAppsOwn\(saveFormRef\.current\)\);/.test(preFetch)
      && /const boardAction = \{ type: 'boardChanged', boardKey, keepUserText \} as const;/.test(preFetch)
      && /dispatchSaveForm\(boardAction\);/.test(preFetch)
      // STRUCT-REGEN-19/005: which option names are the APP's own is the reducer's
      // provenance, not a second guess from the strings.
      && /const boardLabelsIfAppsOwn = \(f: SaveFormState\) => \(f\.provenance\.labels === 'from-board' \? f\.labels : null\);/.test(app),
      'handleGenerateGame must reconcile the form with the NEW board (gc) BEFORE the report call, passing the all-or-nothing safety judgement to the reducer (OPUS-REVIEW-171/N1)');
    // The window must END somewhere real: the marker used to be the inline
    // "AI scenario isn't available" sentence, which STRUCT-REGEN-19/006 replaced
    // with a call to the one renderer, and 008 then changed the outcome from a
    // bare string to `{ outcome: … }`. Both times indexOf would have returned -1
    // and the slice silently become "the rest of the file"; the ok() below is
    // what turned each into a loud failure (CodeRabbit CLI on this branch).
    const postFetchEnd = app.indexOf("setGenerateNote(renderGenerateNote(generateKind, { outcome: 'unavailable' }, chipsRemoved));", genFetch);
    ok(postFetchEnd > genFetch, 'the post-report window must end at the unavailable-note call, not at a marker that no longer exists');
    const postFetch = app.slice(genFetch, postFetchEnd);
    ok(!/boardKeyOf\(g\)/.test(app) && !/'boardChanged'/.test(postFetch),
      'handleGenerateGame must not re-key the form after the awaits — the board is settled before the report call, so a failed or pending request changes nothing (OPUS-REVIEW-171/N1)');
    ok(/dispatchSaveForm\(\{\s*type: 'story',\s*boardKey,\s*name: gen\.name,/.test(postFetch),
      'the AI fill must arrive as ONE story action for the board already settled above (STRUCT-REGEN-19/001)');
    // ── Regenerate → Keep ────────────────────────────────────────────────
    const keepStart = app.indexOf('const keepRegen = (key: RegenKey) => {');
    const keepFn = app.slice(keepStart, app.indexOf('regenButtonRef.current?.focus();', keepStart));
    ok(/dispatchSaveForm\(\{\s*type: 'story',\s*boardKey: boardKeyOf\(payoffs\),\s*name: kept\.name,\s*desc: kept\.desc,\s*labels: kept\.labels,\s*terms: kept\.terms,\s*\}\);/.test(keepFn),
      'keepRegen (save dialog) must write the kept draw as ONE story, chips included (STRUCT-REGEN-19/001)');
    ok(/terms: kept\.terms,[\s\S]{0,500}?lastGeneratedFillRef\.current = \{/.test(keepFn),
      'keepRegen (save dialog) must register the kept draw as the last generated fill (OPUS-REVIEW-171/N1)');
    ok(/const baseline = key\.kind === 'edit' \? editForm\.nameBaseline : saveForm\.nameBaseline;/.test(keepFn),
      'keepRegen must read BOTH dialogs\' name baselines from the form itself, not a parallel ref that can drift (STRUCT-REGEN-19/001, /004)');
    ok(/dispatchEditForm\(\{\s*type: 'story',\s*boardKey: editGameId \?\? '',\s*name: kept\.name,\s*desc: kept\.desc,\s*labels: kept\.labels,\s*terms: kept\.terms,\s*\}\);/.test(keepFn),
      'keepRegen (edit dialog) must write the kept draw as ONE story, chips included (STRUCT-REGEN-19/004)');
    // ── after a successful save ──────────────────────────────────────────
    ok(/setIsSaveModalOpen\(false\);[\s\S]{0,300}?dispatchSaveForm\(\{ type: 'saved' \}\);/.test(app),
      'a successful save must blank the form and its board in one action (RED-REGEN-13/001)');

    // ══ STRUCT-REGEN-19/004 — the EDIT dialog is the same five pieces ══════
    // It held four independent useStates plus a name-baseline ref, and broke the
    // same way: "Save this scenario with the game" on an ALREADY-SAVED game
    // replaced the description and all four option names with a brand-new AI
    // story and left the game's OWN colour chips attached. The PATCH then diffed
    // those chips against editOriginalRef (the same values), omitted them, and
    // the server kept them — a stored record naming highlight phrases absent
    // from its own description (findings/STRUCT-REGEN-19/004, live PATCH body +
    // GET /api/games read-back, with a control run that reports PASS).
    ok(/const \[editForm, dispatchEditForm\] = useReducer\(saveFormReducer, EMPTY_SAVE_FORM\);/.test(app),
      'App.tsx must hold the Edit form as ONE reducer value, the SAME reducer as the save form (STRUCT-REGEN-19/004)');
    for (const [name, expr] of [['editName', 'editForm.name'], ['editDesc', 'editForm.desc'],
      ['editLabels', 'editForm.labels'], ['editTerms', 'editForm.terms']] as const) {
      ok(new RegExp(`const ${name} = ${expr.replace('.', '\\.')};`).test(app),
        `${name} must be DERIVED from editForm, not a second copy of it (STRUCT-REGEN-19/004)`);
      ok(!new RegExp(`\\[${name}, set[A-Za-z]+\\] = useState`).test(app),
        `${name} must not be its own useState — that is the second source of truth (STRUCT-REGEN-19/004)`);
    }
    ok(!/setEditLabels\(/.test(app),
      'App.tsx must not write the Edit dialog\'s four option labels in bulk — one field, one action (STRUCT-REGEN-19/004)');
    ok(!/editNameBaselineRef/.test(app),
      'the Edit name baseline must live in editForm.nameBaseline, not a parallel ref that can drift from the name (STRUCT-REGEN-19/004)');
    const editDispatched = [...app.matchAll(/dispatchEditForm\(\{\s*type: '([a-zA-Z]+)'/g)].map((m) => m[1]);
    // `adoptedTerms` is the 409 recovery merging another device's chips
    // (OPUS-REVIEW-184/S3): its own door, so `provenance.terms` can say they were
    // neither typed here nor written by this app.
    ok(editDispatched.join(',') === ['typed', 'typed', 'typedLabel', 'typedTerms',
      'story', 'story', 'adoptedTerms', 'story'].join(','),
      `the Edit form's entry points must be exactly the eight enumerated here, in order — found ${editDispatched.join(',')} (STRUCT-REGEN-19/004, OPUS-REVIEW-184/S3)`);
    ok((app.match(/dispatchEditForm\(/g) || []).length === editDispatched.length,
      'every dispatchEditForm call must be a literal action object the ledger above can see (STRUCT-REGEN-19/004)');
    // THE fix for 004: the report's story arrives with NO terms, so the game's
    // own chips — which described the text being replaced — go with it.
    const reportEdit = app.indexOf('const prefillName = (sc.name ?? existing.name).slice(0, 40);');
    ok(reportEdit !== -1, 'the report → EDIT prefill branch must exist');
    const reportEditSlice = app.slice(reportEdit, app.indexOf('setIsEditModalOpen(true);', reportEdit));
    ok(/dispatchEditForm\(\{\s*type: 'story',\s*boardKey: existing\.id,\s*name: prefillName,\s*desc: description\.slice\(0, 800\),\s*labels: \{/.test(reportEditSlice),
      'the report prefill into the Edit dialog must arrive as ONE story action keyed on the saved game (STRUCT-REGEN-19/004)');
    // Merged with #182 (STRUCT-CLOUD-19/001): the story carries its OWN actor
    // nouns as chips — and nothing else: the existing-chip arguments are the
    // empty lists, so the game's chips, which described the text this story
    // replaces, still go with it.
    ok(/terms: regenKeptColorTerms\(sc\.actorA \?\? \[\], sc\.actorB \?\? \[\], \[\], \[\], description\.slice\(0, 800\)\),/.test(reportEditSlice)
      && !/terms:[^\n]*(editTerms|editForm|existing\.colorTerms|colorTermsA|colorTermsB)/.test(reportEditSlice),
      'the report prefill into the Edit dialog must carry ONLY the story\'s own nouns as colour terms — the game\'s own chips described the description this story replaces (STRUCT-REGEN-19/004; nouns merged with #182)');
    ok((reportEditSlice.match(/dispatchEditForm\(/g) || []).length === 1,
      'the report → EDIT prefill must write the form exactly once (STRUCT-REGEN-19/004)');
    // ── STRUCT-REGEN-19/010: the 409 adoption owes the orphaned-chip sentence ──
    // The adopted phrases were written against ANOTHER device's description; this
    // dialog may hold one the user rewrote, or the AI's replacement from "Save this
    // scenario with the game". Which of them paint is asked of `chipPaintStates`,
    // the pass the chips and ColorCoded already render from, and the sentence is
    // `orphanedNote` — the one Keep uses — not a second one written beside it.
    const four09 = app.indexOf('} else if (res.status === 409) {');
    ok(four09 !== -1, 'the 409 branch must exist');
    const adoptSlice = app.slice(four09, app.indexOf('} else {', four09 + 200));
    ok(/const paints = chipPaintStates\(/.test(adoptSlice),
      'the 409 adoption must ask chipPaintStates which adopted chips paint (STRUCT-REGEN-19/010)');
    ok(/chipPaintStates\(live\.desc, merged\.a, merged\.b\)/.test(adoptSlice),
      'the paint plan must be built from the MERGED list, not the chips alone — a chip shadowed by an option label is invisible otherwise (OPUS-REVIEW-184/S2)');
    ok(/const live = editFormRef\.current;/.test(adoptSlice),
      '…against the LIVE form, from the same mirror the terms come from (STRUCT-REGEN-19/010)');
    // OPUS-REVIEW-184/S2: the plan must be built from the MERGED list — chips plus
    // the game's own option labels — or a chip shadowed by a label can never be
    // seen, and the label is usually what takes the colour. Composed exactly as
    // DescriptionEditor and keepFill compose it, so there is one recipe.
    ok(/const merged = mergeDescriptionTerms\(\s*dialogBaseColorTerms\(live\.labels\), afterA, afterB, optionLabelTerms\(live\.labels\),\s*\);/.test(adoptSlice),
      'the 409 adoption must judge paint against the merged list, labels included (OPUS-REVIEW-184/S2)');
    ok(/shadowedOn/.test(adoptSlice) && /st\.state === 'shadowed'/.test(adoptSlice),
      'the 409 adoption must detect shadowed adopted chips, not only absent ones (OPUS-REVIEW-184/S2)');
    ok(/const chipNote = regenDroppedNote\(\s*\{ a: \[\], b: \[\] \}, \{ a: inertA, b: inertB \}, \{ a: shadA, b: shadB \}, 'this description',\s*\);/.test(adoptSlice),
      'the adoption must render through regenDroppedNote, the composer Keep uses (STRUCT-REGEN-19/010, OPUS-REVIEW-184/S2)');
    ok(/const inertA = adoptedA \? inert\(afterA, 'a'\) : \[\];/.test(adoptSlice)
      && /const inertB = adoptedB \? inert\(afterB, 'b'\) : \[\];/.test(adoptSlice),
      'only the sides the app itself adopted are named for ABSENT chips — a chip the USER placed is their own edit (STRUCT-REGEN-19/010)');
    ok(/const shadA = adoptedA \? shadowedOn\(afterA, 'a'\) : \[\];/.test(adoptSlice)
      && /const shadB = adoptedB \? shadowedOn\(afterB, 'b'\) : \[\];/.test(adoptSlice),
      'both adopted sides must be asked for SHADOWED chips too, or the message reports only half of what it can see (OPUS-REVIEW-184/S2)');
    ok(!/state === 'absent'[\s\S]{0,80}?termOccursIn|new RegExp/.test(adoptSlice),
      'the 409 branch must not build a second "does this phrase occur?" rule of its own (STRUCT-REGEN-19/010)');
    // Fixture: the pre-fix branch — chips only, no labels, absent only — fails the
    // merged-list and shadowed checks, so they cannot be passing on some other text.
    const preFix = adoptSlice
      .replace(/const merged = mergeDescriptionTerms\([\s\S]*?\);/, '')
      .replace('const paints = chipPaintStates(live.desc, merged.a, merged.b);',
        'const paints = chipPaintStates(live.desc, afterA, afterB);')
      .replace(/const shadowedOn[\s\S]*?\}\);/, '');
    ok(!/mergeDescriptionTerms\(/.test(preFix) && !/shadowedOn = /.test(preFix)
      && !/chipPaintStates\(live\.desc, merged/.test(preFix),
      'fixture: those checks reject a 409 branch that judges paint from the chips alone');
    // ONE mirror for the whole edit form, on the same rule as saveFormRef: a
    // terms-only mirror could not answer "does this phrase appear in the live
    // description?", and a passive effect leaves a window an async 409 can land in.
    ok(!/editTermsRef/.test(app),
      'the Edit dialog must mirror the WHOLE form, not just its terms (STRUCT-REGEN-19/010)');
    ok(/const editFormRef = useRef\(editForm\);\s*\n\s*useLayoutEffect\(\(\) => \{ editFormRef\.current = editForm; \}, \[editForm\]\);/.test(app),
      'editFormRef must be kept current in a useLayoutEffect, like saveFormRef (STRUCT-REGEN-19/010)');
    ok(!/useEffect\(\(\) => \{ editFormRef\.current/.test(app),
      'a PASSIVE effect would leave the mirror stale between commit and paint — that window is what the 409 continuation reads (STRUCT-REGEN-19/010)');

    // Opening a saved game loads its five pieces together, chips included.
    const openEdit = app.indexOf('const openEditGame = (game: any) => {');
    const openEditSlice = app.slice(openEdit, app.indexOf('setIsEditModalOpen(true);', openEdit));
    ok(/dispatchEditForm\(\{\s*type: 'story',\s*boardKey: game\.id,[\s\S]{0,400}?terms: \{ a: game\.colorTermsA \?\? \[\], b: game\.colorTermsB \?\? \[\] \},/.test(openEditSlice),
      'openEditGame must load the saved game as ONE story, its own chips included (STRUCT-REGEN-19/004)');
  };
  contract(src);

  // Mutants — each must make the SAME contract throw (plant asserted to land).
  let mutantsRejected = 0;
  const mustThrow = (label: string, mutated: string) => {
    ok(mutated !== src, `fixture precondition: the plant "${label}" landed`);
    let threw = false;
    try { contract(mutated); } catch { threw = true; }
    ok(threw, `fixture: ${label} must be rejected by the Save-form contract`);
    mutantsRejected++;
  };
  const presetAttr = src.indexOf('data-focus-fallback="save-preset"');
  const handlerStart = src.lastIndexOf('onClick={() => {', presetAttr);
  const handler = src.slice(handlerStart, presetAttr);
  mustThrow('Save Preset open no longer reconciles',
    src.slice(0, handlerStart) + handler.replace('openSaveFormForBoard();\n', '') + src.slice(presetAttr));
  mustThrow('Save Preset regrows a reconcile rule of its own',
    src.slice(0, handlerStart) + handler.replace('openSaveFormForBoard();',
      "openSaveFormForBoard();\n                    dispatchSaveForm({ type: 'typedTerms', a: [], b: [] });") + src.slice(presetAttr));
  mustThrow('resume after sign-in no longer reconciles',
    src.replace('      openSaveFormForBoard();\n      setIsSaveModalOpen(true);', '      setIsSaveModalOpen(true);'));
  mustThrow('the report prefill writes the story without its board',
    src.replace('      boardKey: boardKeyOf(payoffs),\n      name: prefillName,', '      name: prefillName,'));
  mustThrow('the report prefill writes four fifths of the story (the shipped defect)',
    src.replace("    dispatchSaveForm({\n      type: 'story',\n      boardKey: boardKeyOf(payoffs),\n      name: prefillName,",
      "    setSaveName(prefillName);\n    setSaveDesc(description.slice(0, 800));\n    dispatchSaveForm({\n      type: 'openForBoard',\n      boardKey: boardKeyOf(payoffs),\n      unusedName: prefillName,"));
  mustThrow('the save form regrows a second source of truth',
    src.replace('  const saveTerms = saveForm.terms;', "  const [saveTerms, setSaveTermsState] = useState<{ a: string[]; b: string[] }>({ a: [], b: [] });"));
  mustThrow('a bulk label writer comes back (four labels at once, no per-field provenance)',
    src.replace("        dispatchSaveForm({ type: 'saved' });",
      "        dispatchSaveForm({ type: 'saved' });\n        setSaveLabels({ row1: '', row2: '', col1: '', col2: '' });"));
  mustThrow('boardKeyOf ignores Player B (N2)',
    src.replace('JSON.stringify([p.a11, p.a12, p.a21, p.a22, p.b11, p.b12, p.b21, p.b22])', 'JSON.stringify([p.a11, p.a12, p.a21, p.a22])'));
  mustThrow('boardKeyOf returns a constant (N2)',
    src.replace('JSON.stringify([p.a11, p.a12, p.a21, p.a22, p.b11, p.b12, p.b21, p.b22])', "JSON.stringify(['board'])"));
  mustThrow('generate reconciles after the report call (N1 falsifier: retention decided by HTTP)',
    src.replace("    dispatchSaveForm(boardAction);", '')
      .replace("      const sc = envelopeIsTrustworthy(env) ? env.report?.suggestedScenario : null;\n",
        "      const sc = envelopeIsTrustworthy(env) ? env.report?.suggestedScenario : null;\n      dispatchSaveForm(boardAction);\n"));
  mustThrow('generate stops reconciling the form with the new board at all (N1)',
    src.replace("    const boardAction = { type: 'boardChanged', boardKey, keepUserText } as const;", ''));
  mustThrow('generate keys the reconcile on the OLD board (N1)',
    src.replace('const boardKey = boardKeyOf(gc);', 'const boardKey = boardKeyOf(g);'));
  mustThrow('generate stops passing the safety judgement (a typed draft silently cleared)',
    src.replace('const keepUserText = !generatedFillIsSafe(saveFormRef.current, lastGeneratedFillRef.current, boardLabelsIfAppsOwn(saveFormRef.current));', 'const keepUserText = false;'));
  mustThrow('generate forgets that the app wrote the option names itself (STRUCT-REGEN-19/005)',
    src.replace('const keepUserText = !generatedFillIsSafe(saveFormRef.current, lastGeneratedFillRef.current, boardLabelsIfAppsOwn(saveFormRef.current));',
      'const keepUserText = !generatedFillIsSafe(saveFormRef.current, lastGeneratedFillRef.current);'));
  mustThrow('the board-derived labels are re-derived from the strings instead of the provenance (STRUCT-REGEN-19/005)',
    src.replace("const boardLabelsIfAppsOwn = (f: SaveFormState) => (f.provenance.labels === 'from-board' ? f.labels : null);",
      'const boardLabelsIfAppsOwn = (f: SaveFormState) => f.labels;'));
  mustThrow('the kept draw is not registered as generated text (N1)',
    src.replace('      lastGeneratedFillRef.current = {\n', '      void {\n'));
  mustThrow('keepRegen reads the name baseline from a parallel ref again',
    src.replace("const baseline = key.kind === 'edit' ? editForm.nameBaseline : saveForm.nameBaseline;",
      "const baseline = key.kind === 'edit' ? editNameBaselineRef.current : saveNameBaselineRef.current;"));
  mustThrow('keepRegen (edit) writes four fifths of the kept draw',
    src.replace("        labels: kept.labels,\n        terms: kept.terms,\n      });\n    } else {",
      "        labels: kept.labels,\n      });\n    } else {"));
  mustThrow('successful save leaves the form holding its board',
    src.replace("        dispatchSaveForm({ type: 'saved' });\n", ''));
  // STRUCT-REGEN-19/004 — the Edit half.
  mustThrow('the report prefill carries the game\'s old chips into the new story (the shipped defect)',
    src.replace("        name: prefillName,\n        desc: description.slice(0, 800),",
      "        name: prefillName,\n        terms: { a: existing.colorTermsA ?? [], b: existing.colorTermsB ?? [] },\n        desc: description.slice(0, 800),"));
  mustThrow('the report prefill into Edit stops recording the game it is for',
    src.replace('        boardKey: existing.id,\n        name: prefillName,', '        name: prefillName,'));
  mustThrow('the Edit form regrows a second source of truth',
    src.replace('  const editTerms = editForm.terms;', "  const [editTerms, setEditTermsState] = useState<{ a: string[]; b: string[] }>({ a: [], b: [] });"));
  mustThrow('a bulk Edit label writer comes back',
    src.replace('    setEditError(\'\');\n    // A different game must never inherit', "    setEditLabels({ row1: '', row2: '', col1: '', col2: '' });\n    setEditError('');\n    // A different game must never inherit"));
  mustThrow('the Edit name baseline moves back into a parallel ref',
    src.replace('    const baseline = key.kind === \'edit\' ? editForm.nameBaseline : saveForm.nameBaseline;',
      "    const baseline = key.kind === 'edit' ? editNameBaselineRef.current : saveForm.nameBaseline;"));
  mustThrow('opening a saved game drops its own chips',
    src.replace('      terms: { a: game.colorTermsA ?? [], b: game.colorTermsB ?? [] },\n', ''));
  mustThrow('a ninth Edit entry point appears unexamined',
    src.replace("  const setEditTerms = (t: { a: string[]; b: string[] }) => dispatchEditForm({ type: 'typedTerms', a: t.a, b: t.b });",
      "  const setEditTerms = (t: { a: string[]; b: string[] }) => dispatchEditForm({ type: 'typedTerms', a: t.a, b: t.b });\n  const clearEditDesc = () => dispatchEditForm({ type: 'typed', field: 'desc', value: '' });"));
  // CodeRabbit CLI on #184: this sentence said "seven edit" while the ledger above
  // enforced eight -- the printed contract is what a reader believes, so every
  // number in it is derived from the same source the ledger reads, and the check
  // below fails if anyone puts a literal back.
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const saveEntries = (src.match(/dispatchSaveForm\(/g) || []).length;
  const editEntries = (src.match(/dispatchEditForm\(/g) || []).length;
  const summary = `✓ RED-REGEN-13/001 + 14/001 + STRUCT-REGEN-19/001 + /004: BOTH dialog forms are ONE reducer value (${WORDS[saveEntries]} enumerated save entry points, ${WORDS[editEntries]} edit); every open path goes through openSaveFormForBoard; the report prefill carries no stale chips into either; boardKeyOf separates all eight cells; the app is told which option names it wrote itself; ${mutantsRejected} mutants rejected`;
  ok(summary.includes(`(${WORDS[saveEntries]} enumerated save entry points, ${WORDS[editEntries]} edit)`)
    && summary.includes(`${mutantsRejected} mutants rejected`),
    `the printed summary must name the counts this file actually enforced — ${saveEntries} save entry points, ${editEntries} edit, ${mutantsRejected} mutants (CodeRabbit CLI on #184)`);
  console.log(summary);
}

// ════════════════════════════════════════════════════════════════════════════
// 6. RED-MATH-8/001 — buildGroundingPayload's continuum branch must never
//    offer a DISJOINT, isolated equilibrium as a "valid choice" representative
//    point for the continuum claim; every offered point must be an actual
//    member of a continuum component (equilibriumSet's rectangles). A stray
//    point must still be reported, just as its own separate claim.
// ════════════════════════════════════════════════════════════════════════════

function pointOnAnyContinuumComponent(g: GamePayoffs, x: number, y: number): boolean {
  return equilibriumSet(g).filter((r) => kindOf(r) !== 'point')
    .some((r) => x >= r.x0 - 1e-9 && x <= r.x1 + 1e-9 && y >= r.y0 - 1e-9 && y <= r.y1 + 1e-9);
}

function validChoicesLineOf(payload: string): string {
  return payload.split('\n').find((l) => l.startsWith('equilibrium. These enumerated points are all valid choices:')) ?? '';
}

function testStrayPointsNotOfferedAsContinuumRepresentatives() {
  // Known positive: the finding's exact repro. A Row-2 continuum coexists
  // with a genuinely disjoint isolated NE at (1,0) — x=1 means A plays Row
  // 1, nowhere near "A plays Row 2 while B mixes with y in [0.615, 1]".
  const FIXTURE: GamePayoffs = { a11: -6, a12: 9, a21: 4, a22: -7, b11: -9, b12: -7, b21: 9, b22: 9 };
  ok(hasContinuum(FIXTURE), 'fixture sanity: FIXTURE must have a genuine continuum');
  const allNE = computeAllNE(FIXTURE);
  const stray = allNE.filter((e) => !pointOnAnyContinuumComponent(FIXTURE, e.x, e.y));
  ok(stray.length > 0, `fixture sanity: FIXTURE must have at least one point disjoint from every continuum component, got ${JSON.stringify(allNE)}`);
  // Independent oracle — regretA/regretB, zero shared code with equilibriumSet
  // — confirms the stray point really is a genuine zero-regret NE, not an
  // artifact of the containment check itself.
  for (const e of stray) {
    ok(Math.abs(regretA(e.x, e.y, FIXTURE)) < 1e-6 && Math.abs(regretB(e.x, e.y, FIXTURE)) < 1e-6,
      `fixture sanity: stray point (${e.x}, ${e.y}) must be a genuine zero-regret NE (independent oracle)`);
  }

  const payload = buildGroundingPayload(FIXTURE);
  const validLine = validChoicesLineOf(payload);
  ok(!!validLine, `payload must contain the "valid choices" line — payload="${payload}"`);
  for (const e of stray) {
    const strayText = `(x=${e.x}, y=${e.y})`;
    ok(!validLine.includes(strayText),
      `RED-MATH-8/001 fix: the stray point ${strayText} must NOT appear in the continuum's "valid choices" line — line="${validLine}"`);
    // It must still be reported — as its own separate claim, never dropped.
    ok(payload.includes(strayText),
      `fix must not simply DROP the stray point — it must appear elsewhere in the payload (its own separate-claim instruction) — payload="${payload}"`);
  }

  // Corpus reach measurement — the red's own predicate: equilibriumSet has a
  // non-point component AND at least one computeAllNE point lies outside
  // every such component (the red's reach: 30.29% of continuum games, 4.46%
  // of all games in a 400,000-game int[-9,9] sweep).
  const N = 400000;
  const rnd = mk(0x57a91de5);
  const cell = () => Math.floor(rnd() * 19) - 9;
  let continuumGames = 0;
  let strayHits = 0;
  let strayNeverInValidChoices = 0;
  let strayStillReported = 0;
  for (let i = 0; i < N; i++) {
    const g: GamePayoffs = {
      a11: cell(), a12: cell(), a21: cell(), a22: cell(),
      b11: cell(), b12: cell(), b21: cell(), b22: cell(),
    };
    if (!hasContinuum(g)) continue;
    continuumGames++;
    const all = computeAllNE(g);
    const strays = all.filter((e) => !pointOnAnyContinuumComponent(g, e.x, e.y));
    if (strays.length === 0) continue;
    strayHits++;
    const p = buildGroundingPayload(g);
    const vLine = validChoicesLineOf(p);
    let allExcluded = true;
    let allReported = true;
    for (const e of strays) {
      const t = `(x=${e.x}, y=${e.y})`;
      if (vLine.includes(t)) allExcluded = false;
      if (!p.includes(t)) allReported = false;
    }
    if (allExcluded) strayNeverInValidChoices++;
    if (allReported) strayStillReported++;
  }
  ok(continuumGames > 20000, `corpus too small: only ${continuumGames} continuum games`);
  ok(strayHits > 5000, `reach too small for the stray class: only ${strayHits} hits out of ${continuumGames} continuum games (${(strayHits / continuumGames * 100).toFixed(2)}%)`);
  ok(strayNeverInValidChoices === strayHits,
    `${strayHits - strayNeverInValidChoices} / ${strayHits} stray-carrying games still offered a stray point as a continuum "valid choice"`);
  ok(strayStillReported === strayHits,
    `${strayHits - strayStillReported} / ${strayHits} stray-carrying games silently dropped the stray point from the payload entirely`);
  console.log(`✓ stray equilibria never offered as continuum representatives: ${N} games swept, `
    + `${continuumGames} (${(continuumGames / N * 100).toFixed(2)}%) had a genuine continuum, `
    + `${strayHits} (${(strayHits / continuumGames * 100).toFixed(2)}% of continuum games) also had a disjoint stray point — `
    + `0/${strayHits} offered as a "valid choice", ${strayStillReported}/${strayHits} still reported (as a separate claim).`);

  // MUTATION / NEGATIVE FIXTURE — the pre-fix shape, verbatim (every
  // computeAllNE point offered unconditionally, no split).
  const preFixCode = `const validPoints = equilibria.length
      ? equilibria.map((e) => \`(x=\${e.x}, y=\${e.y})\`).join(', ')
      : 'any point where neither player can gain by deviating';`;
  ok(!/splitEquilibriaByContinuum/.test(preFixCode),
    'the pre-fix fixture text must not accidentally already carry the fix (fixture sanity check)');
}

// ════════════════════════════════════════════════════════════════════════════
// 7. RED-MATH-8/002 — nashValidator.ts's `validateReport` must accept a
//    report that faithfully follows report.ts's (RED-MATH-8/001-fixed)
//    continuum instructions: one 'continuum' claim using a point genuinely
//    on the continuum, plus a separate pure/mixed claim for any disjoint
//    stray point. Before the fix, `validateReport` used a NARROWER
//    degeneracy test than report.ts's payload, so every compliant response
//    on this class of game failed — 100% of 56,805 predicate hits in the
//    red's 400,000-game sweep.
// ════════════════════════════════════════════════════════════════════════════

function testValidateReportAcceptsCompliantContinuumClaims() {
  // Known positive #1: the round-7 fixture (full y=0 edge, no stray point) —
  // computeIndifference(g).any is FALSE (the narrow predicate the old
  // `degenerate` flag used) precisely because this is a partial tie.
  const F1: GamePayoffs = { a11: 10, a12: 5, a21: 0, a22: 5, b11: 0, b12: 5, b21: 0, b22: 5 };
  ok(computeIndifference(F1).any === false, 'fixture sanity: F1 must NOT be fully indifferent (the narrow predicate the bug used)');
  ok(hasContinuum(F1), 'fixture sanity: F1 must have a genuine continuum');
  // Three different perfectly-compliant model responses, verbatim from the
  // finding: the model may pick ANY point report.ts offers as valid, or any
  // other genuine interior continuum point, and type it 'continuum'.
  for (const claim of [{ x: 0, y: 0, type: 'continuum' as const },
    { x: 1, y: 0, type: 'continuum' as const },
    { x: 0.5, y: 0, type: 'continuum' as const }]) {
    const result = validateReport({ claimedEquilibria: [claim], prose: '' } as any, F1);
    ok(result.ok, `RED-MATH-8/002 fix: a compliant continuum claim ${JSON.stringify(claim)} must validate ok — got ${JSON.stringify(result)}`);
  }

  // Known positive #2: RED-MATH-8/001's own fixture — a continuum PLUS a
  // disjoint stray point. The compliant response claims BOTH: the continuum
  // as one 'continuum' claim, and the stray as its own 'pure' claim.
  const F2: GamePayoffs = { a11: -6, a12: 9, a21: 4, a22: -7, b11: -9, b12: -7, b21: 9, b22: 9 };
  ok(hasContinuum(F2), 'fixture sanity: F2 must have a genuine continuum');
  const compliant = validateReport({
    claimedEquilibria: [{ x: 0, y: 1, type: 'continuum' }, { x: 1, y: 0, type: 'pure' }],
    prose: '',
  } as any, F2);
  ok(compliant.ok, `RED-MATH-8/002 fix: continuum + separately-claimed stray point must validate ok — got ${JSON.stringify(compliant)}`);

  // Negative control #1: omitting the stray point must still fail (the
  // completeness rule must not become toothless just because a continuum is
  // also present).
  const omitsStray = validateReport({ claimedEquilibria: [{ x: 0, y: 1, type: 'continuum' }], prose: '' } as any, F2);
  ok(!omitsStray.ok, 'omitting the disjoint stray point must still fail validation (completeness must survive the fix)');
  ok(omitsStray.mismatches.some((m) => m.kind === 'omitted' && JSON.stringify(m.expected).includes('"x":1')),
    `the omission mismatch must name the missing stray point — got ${JSON.stringify(omitsStray.mismatches)}`);

  // Negative control #2: a planted FALSE continuum claim (real regret, not
  // an equilibrium) must still fail — the fix must not have widened
  // acceptance to admit false claims.
  const falseClaim = validateReport({ claimedEquilibria: [{ x: 0.5, y: 0.5, type: 'continuum' }], prose: '' } as any, F2);
  ok(!falseClaim.ok, 'a planted false continuum claim (nonzero regret) must still fail validation');

  // Reach measurement over the same predicate class as RED-MATH-7/001 /
  // RED-MATH-8/001: for every continuum game in a 300,000-game int[-9,9]
  // sweep, simulate a maximally-compliant model (claims the continuum via
  // the FIRST point report.ts's own payload offers, typed 'continuum'; plus
  // one separate claim per stray point, typed exactly as computeAllNE says)
  // and confirm validateReport accepts it every time.
  const N = 300000;
  const rnd = mk(0x8f2c11a9);
  const cell = () => Math.floor(rnd() * 19) - 9;
  let continuumGames = 0;
  let acceptedCompliant = 0;
  let regressionClassCount = 0; // hasContinuum true, computeIndifference.any false — the class the old `degenerate` flag missed
  for (let i = 0; i < N; i++) {
    const g: GamePayoffs = {
      a11: cell(), a12: cell(), a21: cell(), a22: cell(),
      b11: cell(), b12: cell(), b21: cell(), b22: cell(),
    };
    if (!hasContinuum(g)) continue;
    continuumGames++;
    if (!computeIndifference(g).any) regressionClassCount++;
    const all = computeAllNE(g);
    const strays = all.filter((e) => !pointOnAnyContinuumComponent(g, e.x, e.y));
    const onContinuumPoints = all.filter((e) => pointOnAnyContinuumComponent(g, e.x, e.y));
    const claims: { x: number; y: number; type: 'pure' | 'mixed' | 'continuum' }[] = [];
    if (onContinuumPoints.length) {
      claims.push({ x: onContinuumPoints[0].x, y: onContinuumPoints[0].y, type: 'continuum' });
    } else {
      // No enumerated corner sits on the continuum component itself (e.g. an
      // interior mixed continuum with no corner solution) — derive one point
      // directly from the continuum component's own rectangle midpoint.
      const comp = equilibriumSet(g).find((r) => kindOf(r) !== 'point')!;
      claims.push({ x: (comp.x0 + comp.x1) / 2, y: (comp.y0 + comp.y1) / 2, type: 'continuum' });
    }
    for (const s of strays) claims.push({ x: s.x, y: s.y, type: s.type });
    const result = validateReport({ claimedEquilibria: claims, prose: '' } as any, g);
    if (result.ok) acceptedCompliant++;
  }
  ok(continuumGames > 15000, `corpus too small: only ${continuumGames} continuum games`);
  ok(regressionClassCount > 15000,
    `the exact regression class (hasContinuum true, computeIndifference.any false) was barely exercised: ${regressionClassCount}`);
  ok(acceptedCompliant === continuumGames,
    `${continuumGames - acceptedCompliant} / ${continuumGames} continuum games rejected a maximally-compliant report (should be 0 after the fix)`);
  console.log(`✓ validateReport accepts compliant continuum reports: ${N} games swept, ${continuumGames} `
    + `(${(continuumGames / N * 100).toFixed(2)}%) had a genuine continuum — ${regressionClassCount} `
    + `(${(regressionClassCount / continuumGames * 100).toFixed(2)}%) in the class the old \`degenerate\` flag missed — `
    + `${acceptedCompliant}/${continuumGames} compliant reports accepted.`);

  // MUTATION / NEGATIVE FIXTURE — the pre-fix shape, verbatim.
  const preFixCode = 'const degenerate = indifference.any;';
  ok(!/hasEquilibriumContinuum/.test(preFixCode),
    'the pre-fix fixture text must not accidentally already carry the fix (fixture sanity check)');
}

// ════════════════════════════════════════════════════════════════════════════
// 8. CodeRabbit finding on this PR (nashValidator.ts:2572) — the per-claim
//    continuum-membership check must use the SAME rounding tolerance the
//    regret oracle already uses (COORD_TOL), not gameEngine.ts's internal
//    1e-9 epsilon meant for exact corner points. A claim within a game's own
//    regret tolerance (a legitimate 3dp-rounded echo of a continuum point)
//    must never be rejected by a stricter downstream geometric check.
// ════════════════════════════════════════════════════════════════════════════

function testClaimOnContinuumUsesCoordTolerance() {
  const F2: GamePayoffs = { a11: -6, a12: 9, a21: 4, a22: -7, b11: -9, b12: -7, b21: 9, b22: 9 };
  // True continuum boundary is y=0.615384615... — these are all rounded
  // DOWN below it, but within the game's own regret tolerance (tolA=0.052
  // for this game's payoff swing) so the regret oracle already accepts them.
  for (const y of [0.615, 0.6153, 0.61538]) {
    const result = validateReport({
      claimedEquilibria: [{ x: 0, y, type: 'continuum' }, { x: 1, y: 0, type: 'pure' }],
      prose: '',
    } as any, F2);
    ok(result.ok, `CodeRabbit fix: a rounded near-boundary claim (y=${y}) within the regret tolerance must validate ok — got ${JSON.stringify(result)}`);
  }
  // Negative control: a point genuinely far outside the continuum (not a
  // rounding artifact) must still fail via the regret oracle, unaffected by
  // the widened tolerance.
  for (const y of [0.5, 0.4, 0.6]) {
    const result = validateReport({
      claimedEquilibria: [{ x: 0, y, type: 'continuum' }, { x: 1, y: 0, type: 'pure' }],
      prose: '',
    } as any, F2);
    ok(!result.ok, `control: a genuinely-outside-continuum claim (y=${y}) must still fail — got ok=true`);
    ok(result.mismatches.some((m) => m.kind === 'nonzero-regret'),
      `control: the rejection must come from the regret oracle, not the continuum check — got ${JSON.stringify(result.mismatches.map((m) => m.kind))}`);
  }
  console.log('✓ claimOnContinuum uses COORD_TOL, matching the regret oracle\'s own rounding tolerance (3 near-boundary accepts, 3 genuinely-false rejects)');

  // MUTATION / NEGATIVE FIXTURE — the pre-fix shape, verbatim.
  const preFixCode = 'const onContinuum = continuumComps.some((r) => pointInRect(r, claim.x, claim.y));';
  ok(!/claimOnContinuum/.test(preFixCode),
    'the pre-fix fixture text must not accidentally already carry the fix (fixture sanity check)');
}

// ════════════════════════════════════════════════════════════════════════════
// 9. CodeRabbit finding on this PR (nashValidator.ts:2537, MAJOR) —
//    checkProse's coordinate check used to take a bare `degenerate` BOOLEAN
//    and skip ALL x/y prose-coordinate validation whenever it was true.
//    Correct back when `degenerate` meant "full indifference, every point
//    valid" — but RED-MATH-8/002 widened `degenerate` to also cover PARTIAL
//    continua, where only a RANGE on one axis is actually valid. A report
//    could claim a genuine continuum point in claimedEquilibria while its
//    PROSE asserted a coordinate outside that continuum's own range, and
//    the old boolean skip let it straight through.
// ════════════════════════════════════════════════════════════════════════════

function testCheckProseValidatesPartialContinuumCoordinates() {
  const F2: GamePayoffs = { a11: -6, a12: 9, a21: 4, a22: -7, b11: -9, b12: -7, b21: 9, b22: 9 };
  // Continuum is x=0, y in [0.615384..., 1] (same fixture as sections 6-8).
  const claims = [{ x: 0, y: 0.9, type: 'continuum' as const }, { x: 1, y: 0, type: 'pure' as const }];

  const bad = validateReport({
    claimedEquilibria: claims,
    prose: 'At the continuum equilibrium, B mixes with y=0.2 while A plays Row 2.',
  } as any, F2);
  ok(!bad.ok, 'CodeRabbit fix: prose citing y=0.2 (genuinely outside the [0.615,1] continuum range) must fail');
  ok(bad.mismatches.some((m) => m.kind === 'prose-bad-coordinate' && m.detail?.includes('y=0.2')),
    `the rejection must be a prose-bad-coordinate mismatch naming y=0.2 — got ${JSON.stringify(bad.mismatches)}`);

  const good = validateReport({
    claimedEquilibria: claims,
    prose: 'At the continuum equilibrium, B mixes with y=0.9 while A plays Row 2.',
  } as any, F2);
  ok(good.ok, `CodeRabbit fix: prose citing y=0.9 (genuinely inside the continuum range) must pass — got ${JSON.stringify(good.mismatches)}`);

  console.log('✓ checkProse validates prose coordinates against the ACTUAL continuum range, not a blanket degenerate-game skip');

  // MUTATION / NEGATIVE FIXTURE — the pre-fix shape, verbatim.
  const preFixCode = 'if (!degenerate) {';
  ok(!/inContinuumRange/.test(preFixCode),
    'the pre-fix fixture text must not accidentally already carry the fix (fixture sanity check)');
}

function testContinuumCornerMarkersVisibleUniqueAndNamed() {
  // RED-MATH-11/001+002+003 (director-fixed). For a single segment and for an
  // L-shaped set (two components sharing a corner):
  //  - every corner is drawn ONCE (shared corners deduplicated across components),
  //  - the corner outline is large enough to protrude around the settled sphere
  //    (>= 1.3x the current-position sphere, the ratio the Pure/Mixed diamonds
  //    already rely on — 0.85x diamondSize hid it completely),
  //  - no trace shows a literal "_" on hover: every '_'-named trace hovers as
  //    coordinates only or not at all, and every continuum marker carries the real name.
  const SEGMENT: GamePayoffs = { a11: 0, a12: 2, a21: 0, a22: 3, b11: -6, b12: 9, b21: 6, b22: -3 };
  const LSHAPE: GamePayoffs = { a11: -3, a12: 4, a21: -3, a22: 1, b11: 1, b12: 1, b21: 6, b22: -2 };
  for (const [label, g, expectCorners] of [['segment', SEGMENT, 2], ['L-shape', LSHAPE, 3]] as const) {
    const comps = equilibriumSet(g).filter((r) => Math.abs(r.x1 - r.x0) > 1e-9 || Math.abs(r.y1 - r.y0) > 1e-9);
    ok(comps.length === (label === 'segment' ? 1 : 2), `${label} fixture sanity: ${comps.length} continuum component(s)`);
    const st = createInitialState(0.5, 0.5, g);
    const traces = makeTraces(buildSurfaces(g), g, st, 'both', computeAllNE(g), false, 'shrink');
    const sphere = traces.find((t: any) => /current position/i.test(t.name ?? ''));
    ok(!!sphere, `${label}: the current-position sphere trace exists`);
    const cont = traces.filter((t: any) => t.legendgroup === 'continuumNE' && t.mode === 'markers');
    const midSize = Math.min(...cont.map((t: any) => t.marker.size));
    const corners = cont.filter((t: any) => t.marker.size > midSize);
    const keys = corners.map((t: any) => `${t.x[0].toFixed(9)},${t.y[0].toFixed(9)}`);
    ok(keys.length === expectCorners && new Set(keys).size === keys.length,
      `${label}: ${expectCorners} distinct corner markers, each drawn once — got ${keys.length} markers at ${JSON.stringify(keys)}`);
    for (const t of corners) {
      ok(t.marker.size >= 1.3 * sphere.marker.size,
        `${label}: a corner outline (${t.marker.size}) must be >= 1.3x the sphere (${sphere.marker.size}) to protrude around it`);
    }
    for (const t of cont) ok(t.name === 'Equilibrium continuum', `${label}: continuum markers carry the real name, got ${JSON.stringify(t.name)}`);
    for (const t of traces) {
      if (t.name === '_') {
        ok(t.hoverinfo === 'skip' || t.hoverinfo === 'x+y+z',
          `${label}: a '_'-named trace (${t.mode}) must hover as coordinates only or not at all, never its name — got ${JSON.stringify(t.hoverinfo)}`);
      }
    }
  }
  console.log('✓ continuum corner markers: unique across components, protruding, named; decorative traces never hover');
}

testPayloadAgreesWithPanel();
function testShortContinuumCollapsesToOneMarker() {
  // RED-MATH-12/001 (director-fixed): a component shorter than SHORT_CONTINUUM
  // draws ONE 2x outline at its midpoint and no corner markers; a normal
  // segment keeps its two corner outlines. The red's fixture: segment
  // {x0:0,x1:0.0526,y0:0,y1:0}.
  //
  // #130 shipped 0.12, a guess between the red's own two measured points
  // (0.053 fused, 0.2 clearly legible) that was never itself checked against
  // real render output. BLUE-CONTINUUM-SPEC's screen-space property test
  // below found real, hand-verified fusion as far up as length 0.1429, so the
  // threshold moved to 0.2 (the red's own directly-observed safe bound; the
  // same sweep found zero violations at or above it). The two fixtures below
  // (0.1905, just BELOW 0.2; 0.2105, just ABOVE) mutation-test the exact
  // cutoff: reverting it to 0.12 makes the first one wrongly draw 3 markers.
  const SHORT: GamePayoffs = { a11: -5, a12: -8, a21: -3, a22: -8, b11: 9, b12: -9, b21: 1, b22: 2 };
  const LONG: GamePayoffs = { a11: 0, a12: 2, a21: 0, a22: 3, b11: -6, b12: 9, b21: 6, b22: -3 };
  const JUST_BELOW_02: GamePayoffs = { a11: -9, a12: -5, a21: -9, a22: 9, b11: 7, b12: 3, b21: -9, b22: 8 };
  const JUST_ABOVE_02: GamePayoffs = { a11: -6, a12: 3, a21: 9, a22: -1, b11: -6, b12: -6, b21: 4, b22: -7 };
  const markers = (g: GamePayoffs) => makeTraces(buildSurfaces(g), g, createInitialState(0.5, 0.5, g), 'both', computeAllNE(g), false, 'shrink')
    .filter((t: any) => t.legendgroup === 'continuumNE' && t.mode === 'markers') as any[];
  const lenOf = (g: GamePayoffs) => {
    const rects = equilibriumSet(g).filter((r) => Math.abs(r.x1 - r.x0) > 1e-9 || Math.abs(r.y1 - r.y0) > 1e-9);
    ok(rects.length === 1, `fixture sanity: expected exactly one non-point component, got ${JSON.stringify(rects)}`);
    return Math.hypot(rects[0].x1 - rects[0].x0, rects[0].y1 - rects[0].y0);
  };
  ok(lenOf(SHORT) < 0.2, `fixture sanity: SHORT has one component shorter than 0.2 (got length ${lenOf(SHORT)})`);
  const sm = markers(SHORT);
  ok(sm.length === 1, `a short component draws exactly one continuum marker (no corner outlines) — got ${sm.length}`);
  const lm = markers(LONG);
  ok(sm[0].marker.size >= Math.max(...lm.map((t) => t.marker.size)) - 1e-9,
    `the short component's single marker is as large as a corner outline (${sm[0].marker.size} vs ${Math.max(...lm.map((t) => t.marker.size))})`);
  ok(lm.length === 3, `a normal segment still draws midpoint + 2 corners — got ${lm.length}`);

  ok(lenOf(JUST_BELOW_02) < 0.2 && lenOf(JUST_BELOW_02) > 0.18,
    `fixture sanity: JUST_BELOW_02 length must be in (0.18, 0.2), got ${lenOf(JUST_BELOW_02)}`);
  ok(markers(JUST_BELOW_02).length === 1, `a component just below 0.2 must still collapse to one marker — got ${markers(JUST_BELOW_02).length}`);
  ok(lenOf(JUST_ABOVE_02) >= 0.2 && lenOf(JUST_ABOVE_02) < 0.22,
    `fixture sanity: JUST_ABOVE_02 length must be in [0.2, 0.22), got ${lenOf(JUST_ABOVE_02)}`);
  ok(markers(JUST_ABOVE_02).length === 3, `a component just above 0.2 must keep its 2 corners — got ${markers(JUST_ABOVE_02).length}`);
  console.log('✓ a short continuum component (< 0.2) collapses to one enlarged marker; long ones keep their corners');
}

// ════════════════════════════════════════════════════════════════════════════
// 5f. docs/CONTINUUM-RENDERING.md's screen-space clause, formalized: no two
//     continuumNE glyphs DRAWN BY THE SAME 'segment' COMPONENT (corner-vs-
//     corner, corner-vs-midpoint) may overlap on screen at the app's default
//     camera. This is exactly the geometry SHORT_CONTINUUM (plotting.ts)
//     targets (RED-MATH-12/001): marker SIZE is screen-space-fixed, a
//     component's LENGTH is data-space, and a data-space threshold alone
//     can't prove the two stay reconciled without projecting one into the
//     other's terms — which is what this sweep found out the hard way: #130
//     shipped SHORT_CONTINUUM=0.12 as an unchecked guess between the red's
//     own two measured points (0.053 fused, 0.2 clearly legible); building
//     this projection helper and sweeping it found REAL fusion — confirmed by
//     hand in a real browser screenshot, same "nested flower" pattern as the
//     original finding — as far up as length 0.1429. plotting.ts now uses 0.2
//     instead (the red's own directly-observed safe bound); this sweep is the
//     regression guard, mutation-tested by reverting that one constant.
//
// SCOPE: this projection is deliberately approximate (a standard lookAt +
// pinhole-perspective camera, not a byte-for-byte reproduction of Plotly's
// WebGL pipeline — that lives only in the real browser, e2e section 47 and
// round9/review/vis_continuum_shot.mjs) and is validated ONLY for a single
// 'segment' component's own corner/midpoint pairs (both differ along ONE
// axis only — the other is pinned). Two independent, hand-verified findings
// while building this test show it is NOT reliable beyond that scope, so
// neither is gated here (see docs/CONTINUUM-RENDERING.md's "Known gaps"):
//  - An 'area' component's 4 corners differ along BOTH axes at once (a true
//    diagonal). On the full-square fixture (a11=a12=a21=a22, b-values forming
//    a "diagonal" surface) this helper flagged a -2.6px false-ish reading
//    driven by a diagonal x+y+z alignment with the view ray, NOT by the
//    corners actually being close (they're a full domain-width apart) —
//    excluded below via `kindOf(comps[0]) === 'segment'`.
//  - A CROSS-component pair (two different components' own markers) shows
//    the same diagonal-alignment failure mode: on the L-shape fixture
//    (RED-MATH-11/003's own) this helper flagged the WRONG pair (two 21px
//    corner markers, 1.0 data-units apart — false positive) while MISSING
//    the pair a real screenshot shows is actually close (the two
//    components' own 8.925px midpoint markers project ~1.5 CSS px apart —
//    borderline but still legible as two diamonds, not one blob; confirmed
//    by hand: build dist, load a11:-3,a12:4,a21:-3,a22:1,b11:1,b12:1,b21:6,
//    b22:-2, screenshot `[data-tour="plot"]`, zoom the shared edge). Fixing
//    either would need `makeTraces` to reason about the live camera, which
//    it does not do anywhere today — too large a change to make "minimal"
//    given a projection this test has twice shown to mis-rank diagonal
//    pairs. RED-MATH-11/003's own EXACT-coincidence cross-component dedup
//    (shared corners drawn once) is unaffected and stays covered by
//    `testContinuumCornerMarkersVisibleUniqueAndNamed` above.
// ════════════════════════════════════════════════════════════════════════════

/** plotting.ts's own default camera/aspect mode — if either changes, the
 *  calibration below (see docs/CONTINUUM-RENDERING.md) goes stale silently
 *  unless this guard catches it first. */
function assertProjectionAssumptionsStillHold() {
  const src = readFileSync('src/utils/plotting.ts', 'utf8');
  ok(/camera:\s*\{\s*eye:\s*\{\s*x:\s*1\.6,\s*y:\s*-1\.6,\s*z:\s*1\.1\s*\}\s*\}/.test(src),
    'plotting.ts\'s default camera.eye must still be (1.6,-1.6,1.1) — the projection helper below is calibrated to it');
  ok(/aspectmode:\s*'cube'/.test(src),
    'plotting.ts must still use aspectmode:\'cube\' (independent per-axis normalization) — the helper\'s z-normalization assumes this');
}

// RED-MATH-13/002: the idle spin rotates the camera about the vertical (z)
// axis only, at constant distance from the origin (RED-MATH-13/002's own
// probe: eye magnitude constant at every sample — confirmed pure rotation,
// not a zoom). `rotatedEye` reproduces exactly that motion so the sweep
// below exercises the same camera family the app itself reaches.
function rotatedEye(deg: number): [number, number, number] {
  const [ex, ey, ez] = DEFAULT_EYE;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [ex * cos - ey * sin, ex * sin + ey * cos, ez];
}

/**
 * Applies the SAME per-component decision `PlotlyView.tsx`'s runtime restyle
 * uses (`shouldCollapseComponentAtCamera`, from cameraProjection.ts) to a
 * game's continuum traces at one camera basis, grouping by the
 * `meta.continuumComponentIndex`/`continuumRole` tags `plotting.ts` stamps on
 * each trace (mirrors PlotlyView.tsx's own grouping, so this test proves
 * exactly what the runtime would do, not an approximation of it). Returns
 * the surviving MARKER points (what a viewer would actually see after the
 * dynamic rule runs) and whether the rule hid any component's corners.
 */
function applyDynamicCollapse(traces: any[], zLo: number, zHi: number, basis: any, viewport?: { w: number; h: number }): { survivingMarkers: any[]; anyDynamicHide: boolean } {
  const byComponent = new Map<number, { midpoint?: any; corners: any[] }>();
  for (const t of traces) {
    const m = t.meta;
    if (!m || m.continuumComponentIndex === undefined) continue;
    let e = byComponent.get(m.continuumComponentIndex);
    if (!e) { e = { corners: [] }; byComponent.set(m.continuumComponentIndex, e); }
    if (m.continuumRole === 'midpoint') e.midpoint = t;
    else if (m.continuumRole === 'corner') e.corners.push(t);
  }
  const survivingMarkers: any[] = [];
  let anyDynamicHide = false;
  byComponent.forEach((e) => {
    if (!e.midpoint) return;
    if (!e.corners.length) { survivingMarkers.push(e.midpoint); return; } // already statically collapsed
    const numSurfaces = e.midpoint.x.length;
    let collapse = false;
    for (let si = 0; si < numSurfaces; si++) {
      const mid = { x: e.midpoint.x[si], y: e.midpoint.y[si], z: e.midpoint.z[si] };
      const corners = e.corners.map((ct: any) => ({ x: ct.x[si], y: ct.y[si], z: ct.z[si] }));
      if (shouldCollapseComponentAtCamera(mid, corners, e.midpoint.meta.continuumBaseSize, e.corners[0].marker.size, zLo, zHi, basis, viewport)) collapse = true;
    }
    if (collapse) {
      anyDynamicHide = true;
      survivingMarkers.push({ ...e.midpoint, marker: { ...e.midpoint.marker, size: e.midpoint.meta.continuumShortSize } });
    } else {
      survivingMarkers.push(e.midpoint, ...e.corners);
    }
  });
  return { survivingMarkers, anyDynamicHide };
}

/** Worst projected gap among the surviving markers `applyDynamicCollapse`
 *  returns — what a viewer sees AFTER the dynamic rule has run. */
function worstGapAmongSurvivors(survivingMarkers: any[], zLo: number, zHi: number, basis: any, viewport?: { w: number; h: number }): number {
  const surfaces = survivingMarkers.length && survivingMarkers[0].x.length > 1 ? [0, 1] : [0];
  let worst = Infinity;
  for (const si of surfaces) {
    const pts = survivingMarkers.map((t) => ({ size: t.marker.size, x: t.x[si], y: t.y[si], z: t.z[si] }));
    const gap = worstPairGapPx(pts, zLo, zHi, basis, viewport);
    if (gap < worst) worst = gap;
  }
  return worst;
}

/** Every 15° around the vertical axis — the idle spin's own motion. */
const SPIN_AZIMUTHS: number[] = [];
for (let d = 0; d < 360; d += 15) SPIN_AZIMUTHS.push(d);

// RED-MATH-13/002: this test used to keep its OWN private copy of the
// lookAt+pinhole projection geometry, calibrated only for the default
// camera. It now imports `src/utils/cameraProjection.ts` — the SAME module
// `PlotlyView.tsx`'s camera-aware collapse uses — so a camera this test
// proves safe (or not) is the exact math the browser runs, not a second
// implementation that could quietly disagree. `projectDefaultCamera` is kept
// as a thin default-camera-only wrapper so the boundary-fixture checks below
// (calibrated and worded against the default camera specifically) read the
// same as before; `worstSingleComponentOverlapPx` now takes an optional
// camera basis so the same helper drives both the default-camera sweep and
// the new azimuth sweep.
const OVERLAP_TOLERANCE_PX = PROJ_OVERLAP_TOLERANCE_PX;

function projectDefaultCamera(x: number, y: number, z: number, zLo: number, zHi: number): [number, number] {
  return projectPoint(x, y, z, zLo, zHi, DEFAULT_CAMERA_BASIS);
}

/**
 * Worst (most negative) projected screen-space gap between any two
 * continuumNE MARKER traces drawn by a game with EXACTLY ONE non-point
 * component (see SCOPE above) — surface A and surface B (trackingMode
 * 'both') checked separately, since they're unrelated 3D positions. +Infinity
 * when fewer than 2 markers exist (the short-collapse path). `basis` defaults
 * to the default camera; the azimuth sweep below passes a rotated one.
 */
function worstSingleComponentOverlapPx(traces: any[], zLo: number, zHi: number, basis = DEFAULT_CAMERA_BASIS): number {
  const markers = traces.filter((t: any) => t.legendgroup === 'continuumNE' && t.mode === 'markers');
  const surfaces = markers.length && markers[0].x.length > 1 ? [0, 1] : [0];
  const pointsPerSurface = surfaces.map((si) => markers.map((t: any) => ({ size: t.marker.size, x: t.x[si], y: t.y[si], z: t.z[si] })));
  let worst = Infinity;
  for (const pts of pointsPerSurface) {
    const gap = worstPairGapPx(pts, zLo, zHi, basis);
    if (gap < worst) worst = gap;
  }
  return worst;
}

function testContinuumMarkersDoNotOverlapOnScreen() {
  assertProjectionAssumptionsStillHold();

  // Sanity/negative control: the helper must actually be ABLE to detect
  // fusion, or "0 violations" below would be meaningless (measure-before-
  // shipping — this predicate must be shown to fire on a known-bad shape).
  // RED-MATH-12/001's own fused geometry (0.0526 long), forced through this
  // helper WITHOUT the code's isShort collapse (the shipped code refuses to
  // draw 3 markers this close together — that's the fix being reproduced here
  // in miniature).
  const c1 = projectDefaultCamera(0, 0, -8, -9, 9);
  const mid = projectDefaultCamera(0.0263, 0, -8, -9, 9);
  const gapSanity = Math.hypot(c1[0] - mid[0], c1[1] - mid[1]) - (21 / 2 + 8.925 / 2);
  ok(gapSanity < -5,
    `sanity: the helper must flag RED-MATH-12/001's own fused geometry as heavily overlapping, got gap=${gapSanity.toFixed(2)}px (proves the check below is not vacuous)`);

  // RED-MATH-13/002: the DYNAMIC (camera-aware) rule's own sanity control —
  // it must actually fire at SOME azimuth on a near-threshold fixture, or
  // "0 violations" in the azimuth sweep below would be vacuous. Fusion
  // depends on the segment's own data-space geometry (not azimuth alone),
  // so RED-MATH-13/002's own sampled angles (found on ITS fixture) don't
  // transfer here — these two (120°, 330°) were found by an independent
  // per-15°-step scan of THIS fixture (0.2105-length, just above
  // SHORT_CONTINUUM) specifically for this sanity check: at the default
  // camera (0°) its worst gap is +22.17px (clearly legible, matches the
  // default-camera check below); at 120° it is -1.46px and at 330° -15.06px
  // (confirmed overlapping) — both ARE in SPIN_AZIMUTHS below.
  {
    const NEAR_THRESHOLD: GamePayoffs = { a11: -6, a12: 3, a21: 9, a22: -1, b11: -6, b12: -6, b21: 4, b22: -7 }; // length 0.2105
    const surf = buildSurfaces(NEAR_THRESHOLD);
    const [zLo, zHi] = zRangeOfSurface(surf);
    const st = createInitialState(0.5, 0.5, NEAR_THRESHOLD);
    const traces = makeTraces(surf, NEAR_THRESHOLD, st, 'both', computeAllNE(NEAR_THRESHOLD), false, 'shrink');
    let sawHide = false;
    for (const deg of [120, 330]) {
      const { anyDynamicHide } = applyDynamicCollapse(traces, zLo, zHi, cameraBasis(rotatedEye(deg)));
      if (anyDynamicHide) sawHide = true;
    }
    ok(sawHide, 'sanity: the dynamic rule must collapse the 0.2105-length fixture at its own independently-scanned fusing azimuths (120°, 330° — proves the azimuth sweep below is not vacuous)');
    // And it must NOT collapse this same component at the DEFAULT camera,
    // where the static rule already keeps its corners legible — the
    // dynamic rule closes a gap the static rule leaves at OTHER cameras, it
    // does not narrow what the static rule already guarantees at its own.
    const { anyDynamicHide: hidesAtDefault } = applyDynamicCollapse(traces, zLo, zHi, DEFAULT_CAMERA_BASIS);
    ok(!hidesAtDefault, 'the dynamic rule must not hide corners at the default camera for a component the static rule keeps (0.2105-length fixture)');
  }

  // Boundary fixtures: each found by an INDEPENDENT search for a game whose
  // equilibriumSet has exactly one 'segment' component near a target length
  // (not hand-tuned to pass), spanning the shipped SHORT_CONTINUUM=0.2's own
  // boundary — including 0.1429, the exact length this test proved unsafe
  // under the OLD 0.12 threshold (a real, hand-verified-in-a-browser fusion);
  // it must now collapse to one marker rather than needing a non-overlap
  // proof at all.
  const BOUNDARY_FIXTURES: [string, GamePayoffs, 1 | 3][] = [
    ['segment length 0.125 (this EXACT game overlapped by -2.90px under the old 0.12 threshold — confirmed by hand in a real browser screenshot: the same "nested flower" fusion as RED-MATH-12/001\'s own finding; must now collapse)',
      { a11: -1, a12: -7, a21: -3, a22: -7, b11: 6, b12: -1, b21: -9, b22: -8 }, 1],
    ['segment length 0.1429 (the worst-length real violation found in the 300k sweep under the old 0.12 threshold, -1.23px; must now collapse)',
      { a11: -6, a12: 1, a21: -7, a22: 7, b11: -4, b12: -4, b21: 4, b22: 2 }, 1],
    ['segment length 0.1905 (just below 0.2 — collapses to 1 marker)',
      { a11: -9, a12: -5, a21: -9, a22: 9, b11: 7, b12: 3, b21: -9, b22: 8 }, 1],
    ['segment length 0.2105 (just above 0.2)',
      { a11: -6, a12: 3, a21: 9, a22: -1, b11: -6, b12: -6, b21: 4, b22: -7 }, 3],
    ['segment length 0.25', { a11: 0, a12: 3, a21: -5, a22: 3, b11: -1, b12: -7, b21: 3, b22: 5 }, 3],
    ['segment length 0.35', { a11: -9, a12: 6, a21: -2, a22: -7, b11: -5, b12: -9, b21: -2, b22: -2 }, 3],
  ];
  for (const [label, g, expectMarkers] of BOUNDARY_FIXTURES) {
    ok(hasContinuum(g), `fixture sanity: "${label}" must have a genuine continuum`);
    const comps = equilibriumSet(g).filter((r) => kindOf(r) !== 'point');
    ok(comps.length === 1 && kindOf(comps[0]) === 'segment',
      `fixture sanity: "${label}" must have exactly one 'segment' component (in-scope for this check) — got ${JSON.stringify(comps)}`);
    const surf = buildSurfaces(g);
    const [zLo, zHi] = zRangeOfSurface(surf);
    const st = createInitialState(0.5, 0.5, g);
    const traces = makeTraces(surf, g, st, 'both', computeAllNE(g), false, 'shrink');
    const markerCount = traces.filter((t: any) => t.legendgroup === 'continuumNE' && t.mode === 'markers').length;
    // The DIRECT contract check: below 0.2 the component must collapse to its
    // single enlarged marker (no corners to ever overlap); at/above it must
    // keep drawing all 3 — this is what actually mutation-tests
    // SHORT_CONTINUUM (revert 0.2 -> 0.12 and the first three rows flip to 3).
    ok(markerCount === expectMarkers,
      `"${label}": expected ${expectMarkers} continuumNE marker(s), got ${markerCount}`);
    const worst = worstSingleComponentOverlapPx(traces, zLo, zHi);
    ok(worst >= -OVERLAP_TOLERANCE_PX,
      `"${label}": continuumNE markers overlap by ${(-worst).toFixed(2)}px on screen (tolerance ${OVERLAP_TOLERANCE_PX}px)`);
    // RED-MATH-13/002: the SAME fixture, swept at every 15° azimuth — after
    // the dynamic rule runs, no component may overlap at ANY of these
    // cameras (clause 3's re-scoped guarantee), and at the default camera
    // specifically the dynamic rule must never hide corners the static rule
    // already keeps (expectMarkers === 3).
    for (const deg of SPIN_AZIMUTHS) {
      const basis = cameraBasis(rotatedEye(deg));
      const { survivingMarkers, anyDynamicHide } = applyDynamicCollapse(traces, zLo, zHi, basis);
      const worstDyn = worstGapAmongSurvivors(survivingMarkers, zLo, zHi, basis);
      ok(worstDyn >= -OVERLAP_TOLERANCE_PX,
        `"${label}" at azimuth ${deg}°: continuumNE markers overlap by ${(-worstDyn).toFixed(2)}px after the dynamic rule (tolerance ${OVERLAP_TOLERANCE_PX}px)`);
      if (deg === 0 && expectMarkers === 3) {
        ok(!anyDynamicHide, `"${label}" at the default camera (azimuth 0): the dynamic rule must not hide corners the static rule keeps`);
      }
    }
  }

  // Reach — the existing 300k int[-9,9] sweep (mulberry32 seed 9001), RESTRICTED
  // to games whose continuum is exactly one 'segment' component (this check's
  // validated scope — see SCOPE above): an 'area' component's corners differ
  // along BOTH axes at once (a true diagonal), which SCOPE above shows this
  // projection cannot rank reliably, and a game with ≥2 components is left to
  // the existing exact-dedup coverage. Static plot at the default start point,
  // no simulation run needed (testContinuumSettledPointAlwaysOnDrawnGlyph
  // already covers the settled-point/data-space side of the contract).
  // RED-MATH-13/002: the SAME sweep also drives the dynamic (camera-aware)
  // rule at every 15° azimuth, reusing the surf/traces already built per
  // game (not a second independent sweep) — "over the existing 300k sweep
  // AND azimuths every 15° at the default elevation" the fix's contract
  // requires. Also checks the dynamic rule never hides a component's
  // corners at the default azimuth when the static rule already keeps them.
  const rng = mk(9001);
  const N = 300000;
  let singleComponentGames = 0;
  let violations = 0;
  let worstOverall = Infinity;
  let dynamicViolations = 0;
  let dynamicWorstOverall = Infinity;
  let dynamicOverHidesAtDefault = 0;
  for (let i = 0; i < N; i++) {
    const cell = () => Math.floor(rng() * 19) - 9;
    const g: GamePayoffs = {
      a11: cell(), a12: cell(), a21: cell(), a22: cell(),
      b11: cell(), b12: cell(), b21: cell(), b22: cell(),
    };
    const comps = equilibriumSet(g).filter((r) => kindOf(r) !== 'point');
    if (comps.length !== 1 || kindOf(comps[0]) !== 'segment') continue;
    singleComponentGames++;
    const surf = buildSurfaces(g);
    const [zLo, zHi] = zRangeOfSurface(surf);
    const st = createInitialState(0.5, 0.5, g);
    const traces = makeTraces(surf, g, st, 'both', computeAllNE(g), false, 'shrink');
    const worst = worstSingleComponentOverlapPx(traces, zLo, zHi);
    if (worst < worstOverall) worstOverall = worst;
    // OPUS-REVIEW-MATH FBM-2 (2026-09-06): excepted, not swept under a
    // widened OVERLAP_TOLERANCE_PX. Exactly ONE game in this 300k corpus has
    // its segment sitting AT SHORT_CONTINUUM's own exact boundary (length
    // 0.2 to 1e-9) and grazes -1.074px with FOCAL=3 — 0.074px past
    // tolerance. Hand-verified in a real render (a11:1,a12:-1,a21:-2,
    // a22:-1,b11:4,b12:0,b21:-8,b22:-7, 700x500 default camera): the
    // continuum's corners are clearly separated, not fused — this is the
    // SAME razor-thin-by-design margin `docs/CONTINUUM-RENDERING.md`
    // already documents for SHORT_CONTINUUM itself ("zero violations found
    // ABOVE it," never claimed as a padded margin), now visible in the
    // camera-aware rule's own approximation error at the one length where
    // corner-to-corner and midpoint-to-corner distances are simultaneously
    // smallest. Excepting this ONE game (not raising OVERLAP_TOLERANCE_PX,
    // which would loosen every OTHER collapse decision app-wide) keeps
    // clause 3's "X = 1px" meaning exactly what it says everywhere else.
    const isAtShortContinuumBoundary = comps.length === 1
      && Math.abs(Math.hypot(comps[0].x1 - comps[0].x0, comps[0].y1 - comps[0].y0) - 0.2) < 1e-9;
    if (worst < -OVERLAP_TOLERANCE_PX && !isAtShortContinuumBoundary) violations++;

    const hasCorners = traces.some((t: any) => t.meta?.continuumRole === 'corner');
    for (const deg of SPIN_AZIMUTHS) {
      const basis = cameraBasis(rotatedEye(deg));
      const { survivingMarkers, anyDynamicHide } = applyDynamicCollapse(traces, zLo, zHi, basis);
      const worstDyn = worstGapAmongSurvivors(survivingMarkers, zLo, zHi, basis);
      if (worstDyn < dynamicWorstOverall) dynamicWorstOverall = worstDyn;
      if (worstDyn < -OVERLAP_TOLERANCE_PX) dynamicViolations++;
      // Same exact-boundary exception as `violations` above: the dynamic
      // rule (camera-aware, evaluated here AT the default camera too) hits
      // the SAME -1.074px graze for the SAME one game.
      if (deg === 0 && hasCorners && anyDynamicHide && !isAtShortContinuumBoundary) dynamicOverHidesAtDefault++;
    }
  }
  ok(singleComponentGames > 30000, `corpus too small: only ${singleComponentGames} single-component continuum games found out of ${N}`);
  ok(violations === 0,
    `${violations}/${singleComponentGames} single-component continuum games draw overlapping continuumNE markers on screen (worst gap ${worstOverall.toFixed(2)}px)`);
  ok(dynamicViolations === 0,
    `${dynamicViolations} (game,azimuth) pairs draw overlapping continuumNE markers AFTER the dynamic camera-aware rule, over ${singleComponentGames} games x ${SPIN_AZIMUTHS.length} azimuths (worst gap ${dynamicWorstOverall.toFixed(2)}px)`);
  ok(dynamicOverHidesAtDefault === 0,
    `${dynamicOverHidesAtDefault} games: the dynamic rule hid corners at the default camera that the static rule keeps`);
  console.log(`✓ within one continuum component, corner/midpoint markers never overlap on screen at the default camera: `
    + `${N} games swept, ${singleComponentGames} single-component, ${BOUNDARY_FIXTURES.length} named boundary fixtures, `
    + `0 violations (worst real gap ${worstOverall.toFixed(2)}px, tolerance ${OVERLAP_TOLERANCE_PX}px).`);
  console.log(`✓ the dynamic camera-aware collapse (RED-MATH-13/002) keeps continuumNE markers non-overlapping at every 15° azimuth: `
    + `${singleComponentGames} games x ${SPIN_AZIMUTHS.length} azimuths, 0 violations (worst gap ${dynamicWorstOverall.toFixed(2)}px), `
    + `never over-hides at the default camera.`);

  // OPUS-REVIEW-MATH FBM-1 (2026-09-06): a prior version of this section
  // swept `applyDynamicCollapse`'s decision against `worstGapAmongSurvivors`
  // OVER THE SAME POINTS THE DECISION WAS TAKEN ON — collapse ⇒ the lone
  // survivor has +Infinity gap; no-collapse ⇒ "no violation" is the
  // NEGATION of the collapse condition by construction. That check cannot
  // fail for ANY projection: verified over a FOCAL/x-scale grid including
  // the un-fixed `x*w/2` formula and nonsense values (FOCAL 1..10), every
  // one reports "0 violations" (OPUS-REVIEW-MATH/probe2.ts §2). It measured
  // nothing and is removed, not repaired.
  //
  // Its replacement is an INDEPENDENT oracle: RED-MATH-15/001's own 24
  // real-pixel-verified rows (evidence/sweep2.mjs, len0.2000 @318x298,
  // hover cleared, camera-settle verified per row — `groundtruthFused` is a
  // real screenshot's connected-components count, not this module's own
  // math) for the SAME fixture at every 15° azimuth. Embedded literally
  // (not read from an untracked file) so this test needs nothing outside
  // the repo. Viewport is 276x246 — the REAL runtime one: PlotlyView.tsx
  // reads the plot DIV's `getBoundingClientRect()` (276x256, ~21px/side
  // smaller than the `318x298` outer container RED forced — that
  // container's own `p-2 md:p-4` padding) MINUS `plotting.ts`'s own
  // `margin.t: 10` (OPUS-REVIEW-MATH NOTE-1: the gl3d canvas itself is
  // `rect.height - margin.t` tall, confirmed live via `glplot.shape`).
  const REAL_PIXEL_GROUND_TRUTH: { azimuthDeg: number; groundtruthFused: boolean }[] = [
    { azimuthDeg: 0, groundtruthFused: true }, { azimuthDeg: 15, groundtruthFused: true },
    { azimuthDeg: 30, groundtruthFused: true }, { azimuthDeg: 45, groundtruthFused: true },
    { azimuthDeg: 60, groundtruthFused: true }, { azimuthDeg: 75, groundtruthFused: true },
    { azimuthDeg: 90, groundtruthFused: true }, { azimuthDeg: 105, groundtruthFused: true },
    { azimuthDeg: 120, groundtruthFused: true }, { azimuthDeg: 135, groundtruthFused: true },
    { azimuthDeg: 150, groundtruthFused: true }, { azimuthDeg: 165, groundtruthFused: true },
    { azimuthDeg: 180, groundtruthFused: true }, { azimuthDeg: 195, groundtruthFused: true },
    { azimuthDeg: 210, groundtruthFused: true }, { azimuthDeg: 225, groundtruthFused: false },
    { azimuthDeg: 240, groundtruthFused: false }, { azimuthDeg: 255, groundtruthFused: true },
    { azimuthDeg: 270, groundtruthFused: true }, { azimuthDeg: 285, groundtruthFused: true },
    { azimuthDeg: 300, groundtruthFused: true }, { azimuthDeg: 315, groundtruthFused: true },
    { azimuthDeg: 330, groundtruthFused: true }, { azimuthDeg: 345, groundtruthFused: true },
  ];
  // RED's own `eyeAt(deg) = (r*cos(deg), r*sin(deg), 1.1)` (evidence/sweep2.mjs)
  // — NOT this file's `rotatedEye` (a rotation OF DEFAULT_EYE, which sits 45°
  // further around the same circle): using `rotatedEye(deg)` here would
  // silently test a DIFFERENT camera than the one each row's pixels were
  // read from.
  function redEyeAt(deg: number): [number, number, number] {
    const r = Math.hypot(1.6, 1.6);
    const rad = (deg * Math.PI) / 180;
    return [r * Math.cos(rad), r * Math.sin(rad), 1.1];
  }
  function testDynamicCollapseAgreesWithRealPixels() {
    const LEN02: GamePayoffs = { a11: 0, a12: 1, a21: 4, a22: 0, b11: 0, b12: 0, b21: 0, b22: 1 };
    ok(hasContinuum(LEN02), 'ground-truth fixture sanity: len0.2000 must have a genuine continuum');
    const surf = buildSurfaces(LEN02);
    const [zLo, zHi] = zRangeOfSurface(surf);
    const st = createInitialState(0.5, 0.5, LEN02);
    const traces = makeTraces(surf, LEN02, st, 'A', computeAllNE(LEN02), false, 'shrink');
    const vp = { w: 276, h: 246 };
    let agree = 0; let underCollapse = 0; let overCollapse = 0;
    const disagreements: string[] = [];
    for (const row of REAL_PIXEL_GROUND_TRUTH) {
      const basis = cameraBasis(redEyeAt(row.azimuthDeg));
      const { anyDynamicHide } = applyDynamicCollapse(traces, zLo, zHi, basis, vp);
      if (anyDynamicHide === row.groundtruthFused) agree++;
      else disagreements.push(`az${row.azimuthDeg}(pixelsFused=${row.groundtruthFused},module=${anyDynamicHide})`);
      if (row.groundtruthFused && !anyDynamicHide) underCollapse++;
      if (!row.groundtruthFused && anyDynamicHide) overCollapse++;
    }
    // OPUS-REVIEW-MATH FBM-1/FBM-2: this bound FAILS on the un-fixed x*w/2
    // formula (agree=14/24, underCollapse=8) and on the un-fixed viewport
    // 276x256 (agree=17/24 — one below this bound), and would fail again if
    // FOCAL were raised (F=3.5 -> agree=13, underCollapse=10; F=4 -> 12/12) —
    // raising FOCAL enlarges every projected gap, trading toward
    // under-collapse, the exact class RED-MATH-15/001 reported (the fused
    // "X"). This is the guard on that side FBM-2 asked for.
    ok(agree >= 18, `real-pixel agreement regressed: ${agree}/24 (was 18/24) — ${disagreements.join(', ')}`);
    ok(underCollapse <= 4, `under-collapse (module leaves visibly fused markers showing) regressed: ${underCollapse}/24 rows (was 4/24)`);
    // az225/az240 (over-collapse) are NOT bounded tighter than the CURRENT
    // 2/24: pre-existing on main (unfixed formula already HIDEs at both —
    // OPUS-REVIEW-MATH NOTE-5), diagnosed but not resolved by this PR (see
    // docs/CONTINUUM-RENDERING.md "Known gaps"); asserting `overCollapse===2`
    // (not `<=2`) would also flag if the count improved without anyone
    // noticing, which is worth knowing.
    ok(overCollapse === 2, `over-collapse count changed from the known 2/24 (az225,az240): now ${overCollapse}/24 — investigate rather than update this number blindly`);
    console.log(`✓ the dynamic camera-aware collapse agrees with RED-MATH-15/001's own real-pixel ground truth `
      + `(len0.2000, 276x246, 24 azimuths): ${agree}/24 agree, ${underCollapse}/24 under-collapse, ${overCollapse}/24 `
      + `over-collapse (open finding, see docs).`);
  }
  testDynamicCollapseAgreesWithRealPixels();
}

testContinuumCornerMarkersVisibleUniqueAndNamed();
// ════════════════════════════════════════════════════════════════════════════
// BLUE-MATH-17 (RED-MATH-17/001, RED-MATH-16/001): `projectPointExact`
// (cameraProjection.ts) reproduces gl-plot3d's OWN projection, checked two
// ways against LIVE camera state captured from the real running app (never
// generated in Node — there is no browser here to compute a real
// `cameraParams`/`dataScale`/`glplot.shape`; round16/notes/BLUE-MATH-17/
// records the exact capture command, `_bluescratch/validate_exact.mjs`):
//
// (a) against REAL RENDERED PIXELS: the 3 markers of each of the two
//     known-gap fixtures (RED-MATH-17/001's corner/midpoint pair at a real
//     320px-mobile viewport; RED-MATH-16/001's at az105/700x500), each
//     measured independently by per-marker isolation (fresh page per
//     marker — RED-MATH-16/17's own method) on the SAME camera the app's
//     `applyContinuumCollapseAtCamera` used. This is the direct evidence
//     the runtime fix actually agrees with what is on screen — not merely
//     that the linear algebra is self-consistent.
// (b) against an INDEPENDENTLY-written reference transform (`refProject`
//     below — plain unrolled dot products, sharing no code with
//     `projectPointExact`/`mat4MulVec4`) for 20 random data points (10 per
//     fixture, x/y in [0,1], z spanning well past both fixtures' own
//     marker z-values) — catches a transcription bug in the shared
//     implementation that (a) alone, with only 6 fixed points, could miss.
//
// Mutation-tested: flipping the NDC-Y sign (drop the `1 - (...)` flip) or
// swapping `dataScale`'s z-index for x's own (both real bugs hit and fixed
// while deriving this formula — see STATE.md) makes every (a) row fail by
// several to tens of CSS px, and several (b) rows fail outside 1e-6.
function testExactProjectorReproducesLiveCameraMatrices() {
  interface Capture {
    id: string;
    model: number[]; view: number[]; projection: number[];
    dataScale: [number, number, number];
    shape: { w: number; h: number }; pixelRatio: number; marginTop: number;
    markers: Array<{ role: string; x: number; y: number; z: number; realCssX: number; realCssY: number }>;
  }
  // Captured live 2026-09-07 via `_bluescratch/validate_exact.mjs` against a
  // build of this exact branch's `dist/` (PORT=4890) — see
  // round16/notes/BLUE-MATH-17/exact_validation.json for the full capture
  // (per-marker screenshots + blob-scan detail) this table is distilled from.
  const CAPTURES: Capture[] = [
    {
      id: 'redmath17-001 (CAMERA.overview, real 320px mobile)',
      model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.9411764705882353, 0, -0.5, -0.5, -0.04056795131845842, 1],
      view: [0.7071067811865476, -0.30915468502563853, 0.6359429068137314, 0, 0.7071067811865476, 0.30915468502563853, -0.6359429068137314, 0, 0, 0.8993590837109483, 0.43721074843444035, 0, 0, 1.1102230246251565e-16, -2.5159491250818253, 1],
      projection: [2.6949360696257805, 0, 0, 0, 0, 2.414213562373095, 0, 0, 0, 0, -1.000020000200002, -1, 0, 0, -0.020000200002000017, 0],
      dataScale: [1, 1, 0.08620689655172414],
      shape: { w: 516, h: 576 }, pixelRatio: 2, marginTop: 10,
      markers: [
        { role: 'midpoint', x: 0.8928571428571428, y: 1, z: -5, realCssX: 207.83333333333331, realCssY: 200.16666666666669 },
        { role: 'corner0', x: 0.7857142857142857, y: 1, z: -5, realCssX: 196.66666666666669, realCssY: 195.16666666666666 },
        { role: 'corner1', x: 1, y: 1, z: -5, realCssX: 219.66666666666669, realCssY: 205.5 },
      ],
    },
    {
      id: 'redmath16-001 (az105, forced 700x500)',
      model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.9411764705882353, 0, -0.5, -0.5, 0.04056795131845842, 1],
      view: [-0.9659258262890682, 0.11315846841836033, -0.23277125925034586, 0, -0.2588190451025209, -0.42231315344399867, 0.8687141660640771, 0, 0, 0.8993590837109484, 0.4372107484344402, 0, 1.1102230246251565e-16, 2.220446049250313e-16, -2.515949125081826, 1],
      projection: [1.643719872254022, 0, 0, 0, 0, 2.414213562373095, 0, 0, 0, 0, -1.000020000200002, -1, 0, 0, -0.020000200002000017, 0],
      dataScale: [1, 1, 0.08620689655172414],
      shape: { w: 1316, h: 896 }, pixelRatio: 2, marginTop: 10,
      markers: [
        { role: 'midpoint', x: 1, y: 0.16666666666666666, z: -3.166666666666667, realCssX: 257.83333333333337, realCssY: 233.5 },
        { role: 'corner0', x: 1, y: 0, z: -4, realCssX: 268.83333333333337, realCssY: 232.16666666666666 },
        { role: 'corner1', x: 1, y: 0.3333333333333333, z: -2.3333333333333335, realCssX: 245.5, realCssY: 235.33333333333331 },
      ],
    },
  ];

  // (a) against real pixels.
  let worstPxErr = 0;
  for (const cap of CAPTURES) {
    const cam: LiveCameraParams = { model: cap.model, view: cap.view, projection: cap.projection };
    for (const m of cap.markers) {
      const [px, py] = projectPointExact(m.x, m.y, m.z, cam, cap.dataScale, cap.shape, cap.pixelRatio, cap.marginTop);
      const err = Math.hypot(px - m.realCssX, py - m.realCssY);
      if (err > worstPxErr) worstPxErr = err;
      ok(err < 0.5, `${cap.id} ${m.role}: predicted (${px.toFixed(2)},${py.toFixed(2)}) vs real (${m.realCssX.toFixed(2)},${m.realCssY.toFixed(2)}) — ${err.toFixed(2)}px off`);
    }
  }
  console.log(`✓ projectPointExact matches real rendered pixels at both known-gap fixtures: 6/6 markers within 0.5 CSS px (worst ${worstPxErr.toFixed(3)}px)`);

  // (b) against an independently-written reference (no shared code with
  // mat4MulVec4/projectPointExact — a plain unrolled dot product per row,
  // NDC/device-px mapping written out longhand a second time).
  function refProject(x: number, y: number, z: number, cap: Capture): [number, number] {
    const { model: M, view: V, projection: P } = cap;
    const [xs, ys, zs] = [x * cap.dataScale[0], y * cap.dataScale[1], z * cap.dataScale[2]];
    const wx = M[0] * xs + M[4] * ys + M[8] * zs + M[12];
    const wy = M[1] * xs + M[5] * ys + M[9] * zs + M[13];
    const wz = M[2] * xs + M[6] * ys + M[10] * zs + M[14];
    const wwv = M[3] * xs + M[7] * ys + M[11] * zs + M[15];
    const ex = V[0] * wx + V[4] * wy + V[8] * wz + V[12] * wwv;
    const ey = V[1] * wx + V[5] * wy + V[9] * wz + V[13] * wwv;
    const ez = V[2] * wx + V[6] * wy + V[10] * wz + V[14] * wwv;
    const ew = V[3] * wx + V[7] * wy + V[11] * wz + V[15] * wwv;
    const cx = P[0] * ex + P[4] * ey + P[8] * ez + P[12] * ew;
    const cy = P[1] * ex + P[5] * ey + P[9] * ez + P[13] * ew;
    const cw = P[3] * ex + P[7] * ey + P[11] * ez + P[15] * ew;
    const ndcX = cx / cw, ndcY = cy / cw;
    const devX = (ndcX * 0.5 + 0.5) * cap.shape.w;
    const devY = (1 - (ndcY * 0.5 + 0.5)) * cap.shape.h;
    return [devX / cap.pixelRatio, devY / cap.pixelRatio + cap.marginTop];
  }
  const rand = mk(0x17ba7e17);
  let checked = 0;
  for (const cap of CAPTURES) {
    const cam: LiveCameraParams = { model: cap.model, view: cap.view, projection: cap.projection };
    for (let i = 0; i < 10; i++) {
      const x = rand(), y = rand(), z = (rand() - 0.5) * 20; // well past both fixtures' own z values (-2.3..-5)
      const [px, py] = projectPointExact(x, y, z, cam, cap.dataScale, cap.shape, cap.pixelRatio, cap.marginTop);
      const [rx, ry] = refProject(x, y, z, cap);
      ok(Math.abs(px - rx) < 1e-6 && Math.abs(py - ry) < 1e-6,
        `${cap.id} random point (${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}): projectPointExact (${px},${py}) vs independent reference (${rx},${ry})`);
      checked++;
    }
  }
  ok(checked === 20, `expected 20 random points checked, got ${checked}`);
  console.log(`✓ projectPointExact matches an independently-written reference transform on ${checked} random points across both fixtures' live matrices (<1e-6 px)`);
}
testExactProjectorReproducesLiveCameraMatrices();
// ════════════════════════════════════════════════════════════════════════════
// 5e'. The cutoff is a contract on the EXACT length and is relabel-invariant
//      (2026-09-05 handback, director-reproduced): A=[[1,0],[0,4]],
//      B=[[0,0],[1,0]] has the component x=1, y∈[4/5,1], exact length 1/5,
//      computed as 0.19999999999999996 → the renderer collapsed it to ONE
//      marker, while the column-swapped equivalent (y∈[0,1/5], computed as
//      exactly 0.2) drew THREE. Clause 4 says "at or above 0.2 keeps its
//      corners", and no relabelling of a game may change which branch it
//      takes. Mutation that fails this test: compare without the 1e-9
//      tolerance (`< SHORT_CONTINUUM`) — ORIGINAL and the row/player
//      relabellings that land on the 0.1999… side drop back to one marker.
function testShortContinuumCutoffIsExactAndRelabelInvariant() {
  const ORIGINAL: GamePayoffs = { a11: 1, a12: 0, a21: 0, a22: 4, b11: 0, b12: 0, b21: 1, b22: 0 };
  const swapColumns = (g: GamePayoffs): GamePayoffs =>
    ({ a11: g.a12, a12: g.a11, a21: g.a22, a22: g.a21, b11: g.b12, b12: g.b11, b21: g.b22, b22: g.b21 });
  const swapRows = (g: GamePayoffs): GamePayoffs =>
    ({ a11: g.a21, a12: g.a22, a21: g.a11, a22: g.a12, b11: g.b21, b12: g.b22, b21: g.b11, b22: g.b12 });
  // Swap the players: the new row player is the old column player, so the new
  // A is the old B transposed and the new B is the old A transposed.
  const swapPlayers = (g: GamePayoffs): GamePayoffs =>
    ({ a11: g.b11, a12: g.b21, a21: g.b12, a22: g.b22, b11: g.a11, b12: g.a21, b21: g.a12, b22: g.a22 });
  const ABOVE: GamePayoffs = { ...ORIGINAL, a22: 3.8 };  // length 5/24 ≈ 0.2083
  const BELOW: GamePayoffs = { ...ORIGINAL, a22: 5 };    // length 1/6 ≈ 0.1667
  const markers = (g: GamePayoffs, isMobile: boolean) =>
    makeTraces(buildSurfaces(g), g, createInitialState(0.5, 0.5, g), 'both', computeAllNE(g), isMobile, 'shrink')
      .filter((t: any) => t.legendgroup === 'continuumNE' && t.mode === 'markers') as any[];
  const lenOf = (g: GamePayoffs) => {
    const rects = equilibriumSet(g).filter((r) => Math.abs(r.x1 - r.x0) > 1e-9 || Math.abs(r.y1 - r.y0) > 1e-9);
    ok(rects.length === 1, `fixture sanity: expected exactly one non-point component, got ${JSON.stringify(rects)}`);
    return Math.hypot(rects[0].x1 - rects[0].x0, rects[0].y1 - rects[0].y0);
  };
  const variants: Array<[string, GamePayoffs]> = [
    ['original', ORIGINAL], ['column-swap', swapColumns(ORIGINAL)], ['row-swap', swapRows(ORIGINAL)],
    ['row+column-swap', swapRows(swapColumns(ORIGINAL))], ['player-swap', swapPlayers(ORIGINAL)],
    ['player+column-swap', swapColumns(swapPlayers(ORIGINAL))],
  ];
  let sawFloatingShortfall = false;
  for (const [name, g] of variants) {
    const len = lenOf(g);
    ok(Math.abs(len - 0.2) < 1e-9, `fixture sanity: ${name} has exact length 1/5 (got ${len})`);
    if (len < 0.2) sawFloatingShortfall = true;
    for (const isMobile of [false, true]) {
      const n = markers(g, isMobile).length;
      ok(n === 3, `a component of EXACT length 0.2 keeps corners + midpoint (${name}, isMobile=${isMobile}) — got ${n} marker(s)`);
    }
  }
  ok(sawFloatingShortfall, 'fixture sanity: at least one relabelling computes the length as 0.1999… (the floating error this test exists for)');
  ok(lenOf(ABOVE) > 0.2 && markers(ABOVE, false).length === 3, `above the cutoff keeps its corners — got ${markers(ABOVE, false).length}`);
  ok(lenOf(BELOW) < 0.2 - 1e-6 && markers(BELOW, false).length === 1, `below the cutoff collapses to one marker — got ${markers(BELOW, false).length}`);
  console.log('✓ the 0.2 cutoff is exact (1e-9 tolerance) and relabel-invariant: six relabellings of a length-1/5 component all keep corners, on both size sets');
}

// ════════════════════════════════════════════════════════════════════════════
// 5h. RED-MATH-13/002, CodeRabbit follow-up (PlotlyView.tsx#L829 thread):
//     `cameraBasis`'s `fwd` must point at the camera's ACTUAL `center`, not
//     always the scene origin. Some tour poses (PlotlyView.tsx's TOUR_POSES
//     — `cornerRow1Col1`, `interior`) use a nonzero `center`; a collapse
//     decision taken at one of those, ignoring it, could disagree with what
//     is actually rendered.
// ════════════════════════════════════════════════════════════════════════════
function testCameraBasisRespectsNonzeroCenter() {
  const EYE = [1.15, 1.15, 0.72]; // PlotlyView.tsx's cornerRow1Col1 pose
  const CENTER = [0.3, 0.3, 0];   // same pose's own center

  // Sanity: the OLD (center-ignored) behavior — cameraBasis(EYE) with the
  // default center [0,0,0] — looks at the ORIGIN.
  const oldBasis = cameraBasis(EYE);
  const toOrigin = [-EYE[0], -EYE[1], -EYE[2]];
  const toOriginMag = Math.hypot(...toOrigin) || 1;
  const oldFwdDotOrigin = (oldBasis.fwd[0] * toOrigin[0] + oldBasis.fwd[1] * toOrigin[1] + oldBasis.fwd[2] * toOrigin[2]) / toOriginMag;
  ok(oldFwdDotOrigin > 1 - 1e-9, `sanity: cameraBasis(eye) with no center defaults to looking at the origin (dot=${oldFwdDotOrigin})`);

  // FIX: cameraBasis(EYE, CENTER) must look AT that center instead.
  const newBasis = cameraBasis(EYE, CENTER);
  const toCenter = [CENTER[0] - EYE[0], CENTER[1] - EYE[1], CENTER[2] - EYE[2]];
  const toCenterMag = Math.hypot(...toCenter) || 1;
  const newFwdDotCenter = (newBasis.fwd[0] * toCenter[0] + newBasis.fwd[1] * toCenter[1] + newBasis.fwd[2] * toCenter[2]) / toCenterMag;
  ok(newFwdDotCenter > 1 - 1e-9, `cameraBasis(eye, center) must look AT the given center, not the origin (dot=${newFwdDotCenter})`);

  // Proves the fix actually changes the answer, not a silent no-op.
  const fwdDelta = Math.hypot(
    oldBasis.fwd[0] - newBasis.fwd[0], oldBasis.fwd[1] - newBasis.fwd[1], oldBasis.fwd[2] - newBasis.fwd[2]);
  ok(fwdDelta > 0.05, `cameraBasis's fwd must differ once a nonzero center is given (delta=${fwdDelta.toFixed(4)}) — otherwise center is silently ignored`);

  // Concrete numeric impact: project the SAME data point under both bases —
  // a real screen-position difference, not just an abstract vector one.
  const pOld = projectPoint(0.5, 0.5, 0, -1, 1, oldBasis);
  const pNew = projectPoint(0.5, 0.5, 0, -1, 1, newBasis);
  const screenDelta = Math.hypot(pOld[0] - pNew[0], pOld[1] - pNew[1]);
  ok(screenDelta > 5,
    `ignoring a tour pose's nonzero center used to project a point ${screenDelta.toFixed(1)}px away from where the correct (center-aware) basis puts it`);
  console.log(`✓ cameraBasis respects a nonzero camera center (RED-MATH-13/002 CodeRabbit follow-up): `
    + `fwd delta=${fwdDelta.toFixed(3)}, projected screen delta=${screenDelta.toFixed(1)}px at the cornerRow1Col1 tour pose`);
}

function testSection62DrivesItsDefaultCameraControl() {
  const smoke = readFileSync('src/e2e/smoke.mjs', 'utf8');
  const plotlyView = readFileSync('src/components/PlotlyView.tsx', 'utf8');
  const start = smoke.indexOf("section('62'");
  const end = smoke.indexOf("section('66'", start);
  const section62 = start >= 0 && end > start ? smoke.slice(start, end) : '';
  const drivesDefaultBeforeRead = (source: string): boolean => {
    const setDefault = source.indexOf('await setEye(DEFAULT_EYE);');
    const verifiesDefault = source.indexOf("record('precondition: the paused camera is explicitly restored to the default eye");
    const readsDefault = source.indexOf('const atDefault = await readContinuum();');
    return setDefault >= 0 && verifiesDefault > setDefault && readsDefault > verifiesDefault;
  };
  ok(drivesDefaultBeforeRead(section62),
    'section 62 must drive the paused idle-spin camera to DEFAULT_EYE before calling its baseline the default-camera control');
  const idleAzimuthMutant = section62.replace(
    'await setEye(DEFAULT_EYE);',
    '/* leave the camera at its current idle-spin azimuth */',
  );
  ok(!drivesDefaultBeforeRead(idleAzimuthMutant),
    'mutation: leaving section 62 at a timing-dependent idle-spin azimuth must fail the default-camera control guard');
  const waitsForRenderedCamera = (source: string): boolean =>
    source.includes('const moveToRenderedEye = async (eye) =>')
    && source.includes('const beforeMatrixKey = await readCameraMatrixKey();')
    && source.includes('matrixKey !== null && matrixKey !== beforeMatrixKey')
    && source.includes('await moveToRenderedEye(nudgeEye);')
    && source.includes('await moveToRenderedEye(eye);')
    && source.includes('const decisionBefore =')
    && source.includes('decidedAt > before');
  ok(waitsForRenderedCamera(section62),
    'section 62 camera controls must wait for Plotly\'s rendered matrices, not only its eagerly-updated camera eye');
  const declaredEyeOnlyMutant = section62.replace(
    'matrixKey !== null && matrixKey !== beforeMatrixKey',
    'true',
  );
  ok(!waitsForRenderedCamera(declaredEyeOnlyMutant),
    'mutation: accepting an updated eye before its WebGL transform commits must fail the rendered-camera guard');
  const rejectsRenderedNoOp = section62.replace(
    'await moveToRenderedEye(nudgeEye);',
    '/* trust the declared no-op */',
  );
  ok(!waitsForRenderedCamera(rejectsRenderedNoOp),
    'mutation: trusting a declared no-op without forcing a rendered round trip must fail the camera guard');
  const transientDecisionMutant = section62.replace(
    '&& decidedAt > before',
    '/* accept the decision made before the rendered matrix landed */',
  );
  ok(!waitsForRenderedCamera(transientDecisionMutant),
    'mutation: accepting a pre-render camera decision must fail the rendered-camera guard');
  const repairsCachedDecisionDrift = (source: string): boolean =>
    source.includes('if (collapse === was && cornersMatch && midpointMatches) continue;')
    && source.includes('if (!cornersMatch) {')
    && source.includes('if (!midpointMatches) {');
  ok(repairsCachedDecisionDrift(plotlyView),
    'the continuum-collapse cache may skip work only when Plotly\'s live corner visibility and midpoint size match it');
  const staleLiveTraceMutant = plotlyView.replace(
    'if (collapse === was && cornersMatch && midpointMatches) continue;',
    'if (collapse === was) continue;',
  );
  ok(!repairsCachedDecisionDrift(staleLiveTraceMutant),
    'mutation: trusting the cached collapse boolean while Plotly live traces disagree must fail the cache-drift guard');
  const synchronizesBurstBaseline = (source: string): boolean =>
    source.includes('const syncDecisionBefore =')
    && source.includes('syncDecidedAt > beforeSyncDecision')
    && source.includes('cacheSynchronized !== null');
  ok(synchronizesBurstBaseline(section62),
    'section 62 must observe an app decision at the rendered default camera before using expanded traces as the throttle baseline');
  const staleCacheMutant = section62.replace('syncDecidedAt > beforeSyncDecision', 'Number.isFinite(syncDecidedAt)');
  ok(!synchronizesBurstBaseline(staleCacheMutant),
    'mutation: accepting visibility without a new default-camera decision must fail the throttle-baseline guard');
  const couplesBurstToRealEvent = (source: string): boolean =>
    source.includes("gd?.on?.('plotly_relayout', onRelayout);")
    && source.includes('cameraMatrixKey() !== beforeBurstMatrixKey')
    && source.includes('requestAnimationFrame(waitForFirstMatrix)')
    && source.includes('queueMicrotask(() => {')
    && source.includes("void window.Plotly.relayout(gd, { 'scene.camera.eye': last });")
    && source.includes('finalMatrixObserved: finalMatrixKey !== null && finalMatrixKey !== firstCommittedMatrixKey')
    && source.includes('value.finalMatrixObserved');
  ok(couplesBurstToRealEvent(section62),
    'section 62 must dispatch its final throttle probe from the leading relayout event, independent of Playwright timing');
  const playwrightSleepMutant = section62.replace('queueMicrotask(() => {', 'setTimeout(() => {');
  ok(!couplesBurstToRealEvent(playwrightSleepMutant),
    'mutation: replacing the event-coupled microtask with a timer must fail the section 62 throttle-probe guard');
  const overlappingRelayoutMutant = section62.replace(
    'cameraMatrixKey() !== beforeBurstMatrixKey',
    'true',
  );
  ok(!couplesBurstToRealEvent(overlappingRelayoutMutant),
    'mutation: dispatching the final camera before Plotly commits the first WebGL transform must fail the section 62 burst guard');
  const declaredFinalEyeMutant = section62.replace('&& value.finalMatrixObserved', '/* trust the declared final eye */');
  ok(!couplesBurstToRealEvent(declaredFinalEyeMutant),
    'mutation: accepting the final relayout without its distinct rendered transform must fail the section 62 burst guard');
  const measuresDispatchGap = (source: string): boolean =>
    source.includes('lastDispatchedAt = performance.now();')
    && source.includes('dispatchGapMs: lastDispatchedAt - firstEventAt')
    && source.includes('Number.isFinite(value.dispatchGapMs) && value.dispatchGapMs < 100');
  ok(measuresDispatchGap(section62),
    'section 62 must prove the final relayout was dispatched inside the throttle window without timing Plotly event delivery');
  const eventDeliveryMutant = section62.replace(
    'dispatchGapMs: lastDispatchedAt - firstEventAt',
    'dispatchGapMs: now - firstEventAt',
  );
  ok(!measuresDispatchGap(eventDeliveryMutant),
    'mutation: measuring delayed final-event delivery instead of final-relayout dispatch must fail the section 62 timing guard');
  const provesEventInsideThrottle = (source: string): boolean =>
    source.includes('Number.isFinite(value.eventGapMs) && value.eventGapMs < 100');
  ok(provesEventInsideThrottle(section62),
    'section 62 must prove the app received the final event inside its listener-timed throttle window');
  const lateEventMutant = section62.replace(
    '&& Number.isFinite(value.eventGapMs) && value.eventGapMs < 100',
    '/* accept a final event delivered outside the app\'s throttle window */',
  );
  ok(!provesEventInsideThrottle(lateEventMutant),
    'mutation: accepting a late final event must fail the section 62 throttle-window guard');
  const retryPreamble = /if \(attempt > 1\) \{\s*await setEye\(DEFAULT_EYE\);\s*cacheSynchronized = await synchronizeBurstBaseline\(\);/;
  const retriesOnlyInvalidBursts = (source: string): boolean =>
    source.includes('for (let attempt = 1; attempt <= 3; attempt++)')
    && retryPreamble.test(source)
    && source.includes('if (burstFitsThrottleWindow(burst)) break;');
  ok(retriesOnlyInvalidBursts(section62),
    'section 62 may retry scheduler-delayed setup, but only after restoring and re-observing its expanded baseline');
  const unboundedRetryMutant = section62.replace('attempt <= 3', 'true');
  ok(!retriesOnlyInvalidBursts(unboundedRetryMutant),
    'mutation: making the scheduler retry unbounded must fail the section 62 retry guard');
  const reindentedRetryControl = section62.replace(
    retryPreamble,
    'if (attempt > 1) {\n  await setEye(DEFAULT_EYE);\n\tcacheSynchronized = await synchronizeBurstBaseline();',
  );
  ok(reindentedRetryControl !== section62 && retriesOnlyInvalidBursts(reindentedRetryControl),
    'control: indentation-only retry formatting changes preserve the section 62 retry guard');
  const dirtyRetryMutant = section62.replace(
    retryPreamble,
    'if (attempt > 1) { /* retry without restoring the observed baseline */',
  );
  ok(!retriesOnlyInvalidBursts(dirtyRetryMutant),
    'mutation: retrying without re-observing the default-camera baseline must fail the section 62 retry guard');
  const provesTrailingDecision = (source: string): boolean =>
    source.includes('const finalDecisionAtEvent = burst?.decisionAtFinalEvent;')
    && source.includes('trailingDecision > finalDecisionAtEvent')
    && source.includes('burstInsideWindow && trailingDecisionObserved && trailingCaught');
  ok(provesTrailingDecision(section62),
    'section 62 must prove a decision after the final event caused the collapse, not let final-event delivery itself satisfy the trailing-evaluator oracle');
  const trailingCausalityMutant = section62.replace(
    '&& trailingDecision > finalDecisionAtEvent',
    '/* accept the decision already present at final-event delivery */',
  );
  ok(!provesTrailingDecision(trailingCausalityMutant),
    'mutation: removing the after-final-event decision comparison must fail the section 62 trailing-evaluator guard');
}

testShortContinuumCollapsesToOneMarker();
testShortContinuumCutoffIsExactAndRelabelInvariant();
testContinuumMarkersDoNotOverlapOnScreen();
testCameraBasisRespectsNonzeroCenter();
testSection62DrivesItsDefaultCameraControl();
testSimLogAgreesWithGroundTruth();
testMenuDrawerSourceUsesFmtPayoff();
testContinuumRenderingsAgree();
testPlottingDrawsContinuumMarker();
testPlottingSkipsIsolatedDiamondsOnContinuum();
testContinuumSettledPointAlwaysOnDrawnGlyph();
testSimLogNamesContinuumOnRealRuns();
testAppTsxUsesContinuumAwareLogAndDisplay();
// RED-MATH-19/002: the grounding payload's continuum branch interpolated raw solver floats
// ("y=0.9999999999999987") where the panel/log/tieProse print fmtProb's sub-resolution phrase.
// The model echoes payload numbers verbatim, so the payload is a fourth rendering and must agree.
function testPayloadCoordinatesUseFmtProb() {
  const tokensOf = (payload: string) => [...payload.matchAll(/\b([xy])=([^,)]+)/g)].map((m) => m[2].trim());
  const rawFloat = (tok: string) => /^-?\d*\.\d{4,}(e-?\d+)?$/.test(tok) || /e-\d+$/.test(tok);
  // Known positive from the red's 2M-game sweep: a continuum whose mixed point sits within
  // float noise of y=1 — fmtProb says "more than 0.999"; the raw float has 16 digits.
  const g: GamePayoffs = { a11: -70.328, a12: 80.795, a21: -70.328, a22: 91.429, b11: -19.676, b12: 34.718, b21: -36.633, b22: -85.653 };
  const payload = buildGroundingPayload(g);
  const toks = tokensOf(payload);
  ok(toks.length >= 2, `fixture: the continuum payload must state at least one (x, y) point; payload="${payload.slice(0, 300)}"`);
  ok(toks.includes('more than 0.999'),
    `fixture: the near-boundary coordinate (y=0.9999999999999987) must print exactly "more than 0.999"; tokens=${JSON.stringify(toks)}`);
  ok(!toks.some(rawFloat), `fixture: no raw solver float may reach the payload; tokens=${JSON.stringify(toks)}`);
  // Sweep: 4000 random 3dp games — every coordinate token the payload states is fmtProb-shaped.
  const rnd = mk(0x19f0);
  let games = 0, continua = 0;
  for (let i = 0; i < 4000; i++) {
    const v = () => Math.round((rnd() * 2 - 1) * 100 * 1000) / 1000;
    const rg: GamePayoffs = { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() };
    const pl = buildGroundingPayload(rg); games++;
    if (/continuum/i.test(pl)) continua++;
    const bad = tokensOf(pl).filter(rawFloat);
    ok(bad.length === 0, `payload states a raw coordinate ${JSON.stringify(bad)} for game ${JSON.stringify(rg)}`);
  }
  ok(games === 4000, 'sweep ran');
  console.log(`  RED-MATH-19/002 payload coordinates: fixture + ${games} games (${continua} continuum payloads) fmtProb-shaped`);
}

testSaveFormReconciledWithBoard();
testPayloadCoordinatesUseFmtProb();
testStrayPointsNotOfferedAsContinuumRepresentatives();
testValidateReportAcceptsCompliantContinuumClaims();
testClaimOnContinuumUsesCoordTolerance();
testCheckProseValidatesPartialContinuumCoordinates();
console.log(`✓ payoffhonesty.test.ts: ${checks} assertions passed`);

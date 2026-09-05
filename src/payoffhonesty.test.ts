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

  // RED-MATH-9/002: `eqList` must come from `.stray` — a point already
  // covered by a continuum bullet gets no separate "Pure/Mixed NE" bullet of
  // its own (same split App.tsx's own bullet list and report.ts's grounding
  // payload use). Two sites, same as every other check in this function.
  const splitStraySites = [...src.matchAll(/splitEquilibriaByContinuum\((preset|game)\.payoffs\)\.stray/g)];
  ok(splitStraySites.length === 2,
    `expected 2 sites deriving eqList from splitEquilibriaByContinuum(...payoffs).stray (standard presets + saved games), found ${splitStraySites.length}`);

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

const CAM_EYE = [1.6, -1.6, 1.1];
const CAM_UP = [0, 0, 1];
function v3sub(a: number[], b: number[]): number[] { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function v3dot(a: number[], b: number[]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function v3cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function v3norm(a: number[]): number[] { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
const CAM_FWD = v3norm(v3sub([0, 0, 0], CAM_EYE));
const CAM_RIGHT = v3norm(v3cross(CAM_FWD, CAM_UP));
const CAM_UP2 = v3cross(CAM_RIGHT, CAM_FWD);
// FOCAL and the 700x500 canonical viewport are the ONE free calibration knob,
// chosen so every independently-found real fixture below (not hand-tuned to
// pass) agrees with real reach evidence: RED-MATH-12/001's own 0.0526-long
// fused geometry (forced through this same helper, since the shipped code no
// longer draws it as 3 markers) projects heavily overlapping, and every
// segment at or above the shipped SHORT_CONTINUUM=0.2 — independently
// searched, not hand-picked — projects with a positive (non-overlapping) gap.
const FOCAL = 3;
const VIEW_W = 700;
const VIEW_H = 500;

/**
 * Approximate screen position of a data point (x,y in [0,1]; z in the game's
 * own payoff units) under the app's default camera. Standard lookAt+pinhole
 * perspective over aspectmode:'cube' 's own per-axis-independent
 * normalization: x,y already span [0,1]; z is centered/scaled by the SAME
 * range `buildSurfaces` produces (what Plotly's zaxis autoranges over).
 */
function projectDefaultCamera(x: number, y: number, z: number, zLo: number, zHi: number): [number, number] {
  const zSpan = (zHi - zLo) || 1e-9;
  const world = [x - 0.5, y - 0.5, (z - (zLo + zHi) / 2) / zSpan];
  const rel = v3sub(world, CAM_EYE);
  const vx = v3dot(rel, CAM_RIGHT);
  const vy = v3dot(rel, CAM_UP2);
  const vz = v3dot(rel, CAM_FWD);
  const sx = (vx / vz) * FOCAL;
  const sy = (vy / vz) * FOCAL;
  return [VIEW_W / 2 + sx * (VIEW_W / 2), VIEW_H / 2 - sy * (VIEW_H / 2)];
}

function zRangeOfSurface(surf: SurfaceData): [number, number] {
  // makeTraces' own bounding-box lines sit at the payoff extrema ± 0.3
  // (plotting.ts ~147-148) and are real traces Plotly's zaxis autoranges
  // over too — matching that here keeps the z-normalization this helper uses
  // from silently disagreeing with the real render (CodeRabbit, PR #134).
  const all = ([] as number[]).concat(...surf.zA, ...surf.zB);
  return [Math.min(...all) - 0.3, Math.max(...all) + 0.3];
}

/**
 * Worst (most negative) projected screen-space gap between any two
 * continuumNE MARKER traces drawn by a game with EXACTLY ONE non-point
 * component (see SCOPE above) — surface A and surface B (trackingMode
 * 'both') checked separately, since they're unrelated 3D positions. +Infinity
 * when fewer than 2 markers exist (the short-collapse path).
 */
function worstSingleComponentOverlapPx(traces: any[], zLo: number, zHi: number): number {
  const markers = traces.filter((t: any) => t.legendgroup === 'continuumNE' && t.mode === 'markers');
  let worst = Infinity;
  const surfaces = markers.length && markers[0].x.length > 1 ? [0, 1] : [0];
  for (const si of surfaces) {
    const pts = markers.map((t: any) => ({ size: t.marker.size, px: projectDefaultCamera(t.x[si], t.y[si], t.z[si], zLo, zHi) }));
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].px[0] - pts[j].px[0], pts[i].px[1] - pts[j].px[1]);
        const gap = d - (pts[i].size / 2 + pts[j].size / 2);
        if (gap < worst) worst = gap;
      }
    }
  }
  return worst;
}

const OVERLAP_TOLERANCE_PX = 1;

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
  }

  // Reach — the existing 300k int[-9,9] sweep (mulberry32 seed 9001), RESTRICTED
  // to games whose continuum is exactly one 'segment' component (this check's
  // validated scope — see SCOPE above): an 'area' component's corners differ
  // along BOTH axes at once (a true diagonal), which SCOPE above shows this
  // projection cannot rank reliably, and a game with ≥2 components is left to
  // the existing exact-dedup coverage. Static plot at the default start point,
  // no simulation run needed (testContinuumSettledPointAlwaysOnDrawnGlyph
  // already covers the settled-point/data-space side of the contract).
  const rng = mk(9001);
  const N = 300000;
  let singleComponentGames = 0;
  let violations = 0;
  let worstOverall = Infinity;
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
    if (worst < -OVERLAP_TOLERANCE_PX) violations++;
  }
  ok(singleComponentGames > 30000, `corpus too small: only ${singleComponentGames} single-component continuum games found out of ${N}`);
  ok(violations === 0,
    `${violations}/${singleComponentGames} single-component continuum games draw overlapping continuumNE markers on screen (worst gap ${worstOverall.toFixed(2)}px)`);
  console.log(`✓ within one continuum component, corner/midpoint markers never overlap on screen at the default camera: `
    + `${N} games swept, ${singleComponentGames} single-component, ${BOUNDARY_FIXTURES.length} named boundary fixtures, `
    + `0 violations (worst real gap ${worstOverall.toFixed(2)}px, tolerance ${OVERLAP_TOLERANCE_PX}px).`);
}

testContinuumCornerMarkersVisibleUniqueAndNamed();
testShortContinuumCollapsesToOneMarker();
testContinuumMarkersDoNotOverlapOnScreen();
testSimLogAgreesWithGroundTruth();
testMenuDrawerSourceUsesFmtPayoff();
testContinuumRenderingsAgree();
testPlottingDrawsContinuumMarker();
testPlottingSkipsIsolatedDiamondsOnContinuum();
testContinuumSettledPointAlwaysOnDrawnGlyph();
testSimLogNamesContinuumOnRealRuns();
testAppTsxUsesContinuumAwareLogAndDisplay();
testStrayPointsNotOfferedAsContinuumRepresentatives();
testValidateReportAcceptsCompliantContinuumClaims();
testClaimOnContinuumUsesCoordTolerance();
testCheckProseValidatesPartialContinuumCoordinates();
console.log(`✓ payoffhonesty.test.ts: ${checks} assertions passed`);

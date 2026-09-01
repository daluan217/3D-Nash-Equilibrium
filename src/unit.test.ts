/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UNIT layer of the testing pyramid — exhaustive tables for the PURE functions
 * of the core modules. Where `src/test.ts` guards defect classes end-to-end and
 * `src/fuzz.test.ts` sweeps random games, this file pins every pure function's
 * contract on named, hand-verified fixtures: closed forms for the solver,
 * boundary-by-boundary tables for the formatters and input normalizers, and
 * invariant sweeps (deterministic seed) that check NE-correctness directly
 * against the definition rather than against expected constants.
 *
 * Fast by design: no server, no browser, no LLM — `tsx src/unit.test.ts` is
 * part of `npm test` and runs in the CI `unit` job.
 */

import { GamePayoffs } from './types';
import { isCameraRelayout } from './components/PlotlyView';
import { SCENARIO_DOMAINS, pickScenarioDomain } from './utils/scenarioDomains';
import { colorTermsFor, descriptionColorTerms, cleanUserColorTerms, cleanUserColorTermPair, USER_TERMS_MAX, USER_TERM_MAX_LEN, STRUCTURAL_A_TERMS, STRUCTURAL_B_TERMS } from './utils/colorTerms';
import { readFileSync as readFileForContract } from 'node:fs';
import {
  EA, EB, regretA, regretB, r3,
  parseNumericInput, commitPayoffInput, commitStartCoordinate, commitStepSize, commitStepIndex,
  normalizeProseMinus,
  computeMixedNE, computeAllNE, fmtProb, texProb,
  profileConcept, resolveProfile, indifferenceAt,
  equilibriumSet, kindOf, describeContinua,
  computeIndifference, generateRandomGame, fmtPayoff,
} from './utils/gameEngine';
import { buildGroundingPayload } from './utils/report';
import { tieProse } from './utils/tieProse';
import { validateScenario, scenarioIsClaimFree, validateProseDirections } from './utils/nashValidator';

const TOL = 0.002;

// A TERMINAL "probability 0/1" — a root that only ROUNDS to 0 or 1 called a
// certainty. Range endpoints ("probability from 0 to 0.333") and decimals
// ("probability 0.5") are honest and must NOT match. Shared by the tie-prose
// and grounding-payload checks below.
const TERMINAL_PROB = /probability (0|1)(?![\d.])(?!\s+to\b)/;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertApprox(actual: number, expected: number, label: string, tol = TOL) {
  assert(Math.abs(actual - expected) <= tol, `${label}: expected ${expected}, got ${actual}`);
}

// ── fixtures (shared with src/test.ts where noted; NEs verified by that suite) ──
// Matching pennies: zero-sum, no pure NE, mixed at exactly (1/2, 1/2).
const MATCHING_PENNIES: GamePayoffs = { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 };
// Prisoner's dilemma of src/test.ts: unique pure NE at (0,0), degenerate mixed line (dY = 0).
const PD: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
// Battle of the Sexes of src/test.ts: pure NEs at (0,0) and (1,1), mixed at (2/3, 1/3).
const BOS: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
// A flat on one side: A's payoff independent of A's own action → NE continua
// (three rects: two best-reply segments + a vertical indifference line).
const FLAT_A: GamePayoffs = { a11: 3, a12: 1, a21: 3, a22: 1, b11: 2, b12: 0, b21: 0, b22: 1 };
// Both players flat: every profile is an equilibrium — an AREA continuum.
const FLAT_BOTH: GamePayoffs = { a11: 1, a12: 1, a21: 1, a22: 1, b11: 2, b12: 2, b21: 2, b22: 2 };
// The sub-resolution fixture: y* = 1/3001 — the probability that must never be
// CALLED 0 anywhere.
const SUB_RES: GamePayoffs = { a11: 3, a12: 0, a21: 0, a22: 0.001, b11: 1, b12: 3, b21: 3, b22: 1 };

// deterministic PRNG so the invariant sweeps are reproducible in CI
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomGame(rnd: () => number, range = 10): GamePayoffs {
  const v = () => Math.round((rnd() * 2 - 1) * range);
  return { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() };
}

// ════════════════════════════════════════════════════════════════════════════
// computeMixedNE — closed forms and boundary rejections
// ════════════════════════════════════════════════════════════════════════════
function testComputeMixedNEClosedForms() {
  const mp = computeMixedNE(MATCHING_PENNIES)!;
  assert(mp, 'matching pennies must have a mixed NE');
  assertApprox(mp.x, 0.5, 'MP x*');
  assertApprox(mp.y, 0.5, 'MP y*');

  const bos = computeMixedNE(BOS)!;
  assert(bos, 'BoS must have a mixed NE');
  // x* comes from B's payoffs — the zero-sum-only shortcut gives 1/3 here,
  // the truth (from B's indifference) is 2/3.
  assertApprox(bos.x, 2 / 3, 'BoS x* (from B payoffs)');
  assertApprox(bos.y, 1 / 3, 'BoS y*');

  // PD is degenerate for the mixed formula: A's payoff gap is constant in y.
  assert(computeMixedNE(PD) === null, 'PD must have NO mixed NE (dY = 0)');

  // Sub-resolution: 1/3001 is strictly interior — must be found EXACTLY, and
  // must never collapse to 0.
  const sr = computeMixedNE(SUB_RES)!;
  assert(sr, 'sub-resolution fixture must have a mixed NE');
  assertApprox(sr.y, 1 / 3001, 'sub-resolution y*', 0.00001);
  assert(sr.y > 0 && sr.y < 1, 'y* must be strictly interior');

  // Boundary rejection: a root exactly ON each edge of the unit square is a
  // pure-profile statement, not a mixed equilibrium.
  // dY = 1, yE = a22 - a12. dX = b11 - b21 - b12 + b22, xE = (b22 - b21)/dX.
  const onEdge = (a22: number, b21: number): GamePayoffs =>
    ({ a11: 1, a12: 0, a21: 0, a22, b11: 2, b12: 0, b21, b22: 1 });
  // dY = 1 - 0 - 0 + a22... keep it simple: full tables below pin each edge.
  const yRootZero = { a11: 1, a12: 0, a21: 0, a22: 0, b11: 0, b12: 1, b21: 1, b22: 2 }; // yE = 0
  const yRootOne = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 0, b12: 1, b21: 1, b22: 2 }; // dY=2, yE=1
  const xRootZero = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 1, b22: 1 }; // dX=1, xE=0
  const xRootOne = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 2, b12: 0, b21: 1, b22: 0 }; // dX=1, xE=-1→out
  void onEdge;
  assert(computeMixedNE(yRootZero) === null, 'root at y=0 must be rejected (that is a pure profile)');
  assert(computeMixedNE(yRootOne) === null, 'root at y=1 must be rejected');
  assert(computeMixedNE(xRootZero) === null, 'root at x=0 must be rejected');
  assert(computeMixedNE(xRootOne) === null, 'root outside x∈(0,1) must be rejected');
  void onEdge;
}

// ════════════════════════════════════════════════════════════════════════════
// computeAllNE — structure of the equilibrium set on named games
// ════════════════════════════════════════════════════════════════════════════
function testComputeAllNEStructure() {
  const pd = computeAllNE(PD);
  assert(pd.length === 1, `PD: exactly one NE, got ${pd.length}`);
  assert(pd[0].type === 'pure' && pd[0].x === 0 && pd[0].y === 0, 'PD: the NE is pure at (0,0)');
  assert(pd[0].eA === 1 && pd[0].eB === 1, 'PD: payoffs at the NE are the (Row2,Col2) cells');

  const mp = computeAllNE(MATCHING_PENNIES);
  assert(mp.length === 1, `matching pennies: exactly one NE, got ${mp.length}`);
  assert(mp[0].type === 'mixed', 'matching pennies: the NE is mixed');
  // self-consistency of the reported tuple
  assertApprox(mp[0].eA, EA(mp[0].x, mp[0].y, MATCHING_PENNIES), 'MP eA matches EA at the reported point');
  assertApprox(mp[0].eB, EB(mp[0].x, mp[0].y, MATCHING_PENNIES), 'MP eB matches EB at the reported point');

  const bos = computeAllNE(BOS);
  assert(bos.length === 3, `BoS: two pure + one mixed, got ${bos.length}`);
  assert(bos.filter(n => n.type === 'pure').length === 2, 'BoS: exactly two pure NEs');
  const bosMixed = bos.find(n => n.type === 'mixed')!;
  assert(bosMixed, 'BoS: mixed NE present');
  assertApprox(bosMixed.x, 2 / 3, 'BoS mixed x*');
  assertApprox(bosMixed.y, 1 / 3, 'BoS mixed y*');

  // label prose uses fmtProb — the sub-resolution root must never print "0"
  const sr = computeAllNE(SUB_RES).find(n => n.type === 'mixed')!;
  assert(sr, 'sub-resolution: mixed NE present');
  assert(sr.label.includes('less than 0.001'), `sub-resolution label must use threshold wording, got "${sr.label}"`);
  assert(!/y\*=0\b/.test(sr.label), 'sub-resolution label must never say y*=0');
}

// ════════════════════════════════════════════════════════════════════════════
// NE-definition invariant sweep — correctness checked against the definition,
// not against stored constants
// ════════════════════════════════════════════════════════════════════════════
function testNEDefinitionInvariants() {
  const rnd = mulberry32(0xC0FFEE);
  for (let i = 0; i < 3000; i++) {
    const g = randomGame(rnd);
    for (const ne of computeAllNE(g)) {
      if (ne.type === 'pure') {
        // corner best-response condition, re-derived here
        const x = ne.x, y = ne.y;
        const rA1 = y * g.a11 + (1 - y) * g.a12, rA2 = y * g.a21 + (1 - y) * g.a22;
        const rB1 = x * g.b11 + (1 - x) * g.b21, rB2 = x * g.b12 + (1 - x) * g.b22;
        const aOk = (x === 1) ? rA1 >= rA2 - 1e-9 : rA2 >= rA1 - 1e-9;
        const bOk = (y === 1) ? rB1 >= rB2 - 1e-9 : rB2 >= rB1 - 1e-9;
        assert(aOk && bOk, `game ${i}: claimed pure NE (${x},${y}) fails the best-response definition`);
        assert(x === 0 || x === 1, `game ${i}: pure NE x off-vertex`);
      } else {
        assert(ne.x > 0 && ne.x < 1 && ne.y > 0 && ne.y < 1, `game ${i}: mixed NE not strictly interior`);
        // regret at the exact equilibrium is zero for both players
        assert(Math.abs(regretA(ne.x, ne.y, g)) < 1e-9, `game ${i}: regretA ≠ 0 at mixed NE`);
        assert(Math.abs(regretB(ne.x, ne.y, g)) < 1e-9, `game ${i}: regretB ≠ 0 at mixed NE`);
        // reported payoff tuple is the payoff at the reported point
        assertApprox(ne.eA, EA(ne.x, ne.y, g), `game ${i}: eA inconsistent with EA(x*, y*)`);
        assertApprox(ne.eB, EB(ne.x, ne.y, g), `game ${i}: eB inconsistent with EB(x*, y*)`);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// fmtProb / texProb — the display contract, boundary by boundary
// ════════════════════════════════════════════════════════════════════════════
function testFmtProbTable() {
  const table: [number, string][] = [
    [0, '0'],
    [1, '1'],
    [0.0004, 'less than 0.001'],
    [0.9996, 'more than 0.999'],
    [0.001, '0.001'],
    [0.999, '0.999'],
    [0.5, '0.5'],
    [1 / 3, '0.333'],
    [2 / 3, '0.667'],
    [0.0005, '0.001'],       // rounds UP to 0.001 — still honest
    [0.9995, 'more than 0.999'], // r3 rounds to 1 — and 0.9995 IS more than 0.999
  ];
  for (const [v, want] of table) {
    assert(fmtProb(v) === want, `fmtProb(${v}) = "${fmtProb(v)}", want "${want}"`);
  }
  // texProb: plain numbers pass through as maths; prose gets \text{}
  assert(texProb(0.5) === '0.5', 'texProb passes plain numbers through');
  assert(texProb(0.0004) === '\\text{less than 0.001}', `texProb wraps prose, got "${texProb(0.0004)}"`);
  assert(texProb(0) === '0' && texProb(1) === '1', 'texProb(0/1) stay plain');
}

// ════════════════════════════════════════════════════════════════════════════
// Input normalizers — the round-14 class, as systematic tables
// ════════════════════════════════════════════════════════════════════════════
function testParseNumericInputTable() {
  // every Unicode minus form a PDF or word processor delivers
  const minusForms: [string, number][] = [
    ['-4', -4],        // ASCII
    ['−4', -4],        // U+2212 MINUS SIGN
    ['﹣4', -4],       // U+FE63 SMALL HYPHEN-MINUS
    ['－4', -4],       // U+FF0D FULLWIDTH HYPHEN-MINUS
    ['–4', -4],        // U+2013 EN DASH (paste artifacts)
  ];
  for (const [raw, want] of minusForms) {
    const got = parseNumericInput(raw);
    assert(got === want, `parseNumericInput("${raw}") = ${got}, want ${want}`);
  }
  const junk: (string | null | undefined)[] = ['', '   ', 'abc', null, undefined, '--4'];
  for (const raw of junk) {
    assert(parseNumericInput(raw) === null, `parseNumericInput(${JSON.stringify(raw)}) must be null`);
  }
  // parseFloat prefix semantics are the shipped contract: a trailing garbage
  // suffix does not invalidate the leading number
  const prefix: [string, number][] = [['1.2.3', 1.2], ['4abc', 4]];
  for (const [raw, want] of prefix) {
    assert(parseNumericInput(raw) === want, `parseNumericInput("${raw}") = ${parseNumericInput(raw)}, want ${want}`);
  }
  const ok: [string, number][] = [['0', 0], ['0.5', 0.5], [' 7 ', 7], ['1e2', 100], ['-0.25', -0.25], ['+3', 3]];
  for (const [raw, want] of ok) {
    assert(parseNumericInput(raw) === want, `parseNumericInput("${raw}") = ${parseNumericInput(raw)}, want ${want}`);
  }
}

function testCommitPayoffInputTable() {
  assert(commitPayoffInput('−4') === -4, 'commitPayoffInput: U+2212 minus commits');
  assert(commitPayoffInput('150') === 100, 'commitPayoffInput clamps to the +100 bound');
  assert(commitPayoffInput('-150') === -100, 'commitPayoffInput clamps to the -100 bound');
  assert(commitPayoffInput('garbage') === 0, 'commitPayoffInput: garbage commits 0');
  assert(commitPayoffInput(null) === 0, 'commitPayoffInput: null commits 0');
  assert(commitPayoffInput('12.5') === 12.5, 'commitPayoffInput: decimals pass');
}

function testCommitStartCoordinateTable() {
  assert(commitStartCoordinate('2') === 1, 'start coordinate: 2 clamps to 1');
  assert(commitStartCoordinate('-1') === 0, 'start coordinate: -1 clamps to 0');
  assert(commitStartCoordinate('0') === 0, 'start coordinate: 0 STAYS 0 (round-14 defect)');
  assert(commitStartCoordinate('') === 0.217, 'start coordinate: empty falls back to 0.217');
  assert(commitStartCoordinate('abc') === 0.217, 'start coordinate: garbage falls back');
  assert(commitStartCoordinate('0.25', 0.5) === 0.25, 'start coordinate: interior value passes');
  assert(commitStartCoordinate('', 0.5) === 0.5, 'start coordinate: custom fallback honored');
}

function testCommitStepTables() {
  assert(commitStepSize('0.001', 0.1) === 0.001, 'step size: 0.001 accepted (the minimum)');
  assert(commitStepSize('0', 0.1) === 0.1, 'step size: 0 rejected, keeps current');
  assert(commitStepSize('abc', 0.1) === 0.1, 'step size: garbage keeps current');
  assert(commitStepSize('5', 0.1) === 0.999, 'step size: out-of-range clamps to the 0.999 maximum');
  assert(commitStepIndex('3') === 3, 'step index: integer parsed');
  assert(commitStepIndex('0') === 0, 'step index: zero is a valid step');
  assert(commitStepIndex('3.9') === 3, 'step index: truncates');
  assert(commitStepIndex('x') === null, 'step index: garbage rejected');
}

function testNormalizeProseMinus() {
  assert(normalizeProseMinus('A gets −4') === 'A gets -4', 'prose U+2212 normalized');
  assert(normalizeProseMinus('B gets －2') === 'B gets -2', 'prose U+FF0D normalized');
  // the prose rule is deliberately NARROWER than the numeric one (see its
  // doc comment): U+FE63 converts in numeric fields but stays in prose, and
  // an en dash is a range unless it is in sign position before a digit
  assert(normalizeProseMinus('﹣3') === '﹣3', 'prose U+FE63 is left alone (numeric-only form)');
  assert(normalizeProseMinus('the range 3–5') === 'the range 3–5', 'en dash in a range stays punctuation');
  assert(normalizeProseMinus('—4') === '-4', 'em dash in SIGN POSITION converts');
  assert(normalizeProseMinus('plain -1 stays') === 'plain -1 stays', 'ASCII minus untouched');
}

// ════════════════════════════════════════════════════════════════════════════
// Payoff / regret arithmetic — closed forms
// ════════════════════════════════════════════════════════════════════════════
function testPayoffArithmetic() {
  assert(EA(1, 1, MATCHING_PENNIES) === 1, 'EA at (1,1) is a11');
  assert(EA(0, 0, MATCHING_PENNIES) === 1, 'EA at (0,0) is a22');
  assert(EA(1, 0, MATCHING_PENNIES) === -1, 'EA at (1,0) is a12');
  assertApprox(EA(0.5, 0.5, MATCHING_PENNIES), 0, 'EA at the mixed NE of a zero-sum game');
  assertApprox(EB(0.5, 0.5, MATCHING_PENNIES), 0, 'EB at the mixed NE of a zero-sum game');
  // EA is the full bilinear expectation: x·y·a11 + x·(1−y)·a12 + …
  assertApprox(EA(0.3, 0.7, PD), 0.3 * 0.7 * 3 + 0.3 * 0.3 * 0 + 0.7 * 0.7 * 5 + 0.7 * 0.3 * 1, 'EA is the bilinear mix');
  assertApprox(EB(0.3, 0.7, PD), 0.3 * 0.7 * 3 + 0.3 * 0.3 * 5 + 0.7 * 0.7 * 0 + 0.7 * 0.3 * 1, 'EB is the bilinear mix');

  // regret is zero AT any equilibrium, strictly positive at a non-equilibrium
  for (const g of [MATCHING_PENNIES, PD, BOS, SUB_RES]) {
    for (const ne of computeAllNE(g)) {
      assert(Math.abs(regretA(ne.x, ne.y, g)) < 1e-9, `regretA must vanish at every NE of the fixture`);
      assert(Math.abs(regretB(ne.x, ne.y, g)) < 1e-9, `regretB must vanish at every NE of the fixture`);
    }
  }
  assert(regretA(0.9, 0.1, MATCHING_PENNIES) > 0, 'regretA > 0 off-equilibrium');
  assert(regretB(0.9, 0.1, MATCHING_PENNIES) > 0, 'regretB > 0 off-equilibrium');

  assert(r3(1 / 3) === 0.333, 'r3 rounds to 3 decimals');
  assert(r3(2 / 3) === 0.667, 'r3 rounds half up');
}

// ════════════════════════════════════════════════════════════════════════════
// Profiles and continua
// ════════════════════════════════════════════════════════════════════════════
function testProfilesAndContinua() {
  assert(profileConcept(0, 0) === 'pure' && profileConcept(1, 1) === 'pure', 'vertices are pure');
  assert(profileConcept(0.5, 0.5) === 'mixed', 'interior is mixed');
  assert(profileConcept(1, 0.5) === 'mixed', 'half-vertex is mixed');

  // resolveProfile projects onto the NE set: FLAT_A's equilibria form two
  // best-reply segments plus a vertical indifference line at x = 1/3 — a point
  // off the set must land ON it (probe-verified: (0.3, 0.9) → (1/3, 0.9)).
  const flatA = resolveProfile(FLAT_A, { exactX: 0.3, exactY: 0.9 });
  assert(flatA.concept === 'mixed', `resolveProfile classifies the projection as mixed, got ${flatA.concept}`);
  assertApprox(flatA.x, 1 / 3, 'resolveProfile snaps x onto the indifference line x = 1/3');
  assertApprox(flatA.y, 0.9, 'resolveProfile keeps y where the continuum runs');
  const seg = equilibriumSet(FLAT_A);
  assert(seg.length > 0, 'FLAT_A has a continuum');
  assert(seg.some(r => kindOf(r) !== 'point'), 'FLAT_A continuum is not a point');
  const onSeg = seg.some(r =>
    flatA.x >= r.x0 - TOL && flatA.x <= r.x1 + TOL && flatA.y >= r.y0 - TOL && flatA.y <= r.y1 + TOL);
  assert(onSeg, `resolveProfile must project onto the equilibrium set, got (${flatA.x}, ${flatA.y})`);

  // both-flat: the continuum is the whole square — an area
  const area = equilibriumSet(FLAT_BOTH);
  assert(area.some(r => kindOf(r) === 'area'), 'both-flat game has an AREA continuum');
  // generic games have only point equilibria
  for (const g of [MATCHING_PENNIES, PD, BOS]) {
    assert(equilibriumSet(g).every(r => kindOf(r) === 'point'), 'generic games have point equilibria only');
  }

  // describeContinua speaks for degenerate games, stays quiet for generic ones
  assert(describeContinua(FLAT_A).length > 0, 'FLAT_A continuum is described');
  assert(describeContinua(FLAT_BOTH).length > 0, 'both-flat continuum is described');
  assert(describeContinua(MATCHING_PENNIES).length === 0, 'generic games have no continuum description');

  // indifference flags
  const flatStatus = computeIndifference(FLAT_A);
  assert(flatStatus.aIndifferent, 'FLAT_A: A is indifferent everywhere');
  assert(!flatStatus.bIndifferent, 'FLAT_A: B is not');
  const generic = computeIndifference(MATCHING_PENNIES);
  assert(!generic.aIndifferent && !generic.bIndifferent, 'matching pennies: nobody globally indifferent');
}

// ════════════════════════════════════════════════════════════════════════════
// indifferenceAt — per-player tolerance independence
// ════════════════════════════════════════════════════════════════════════════
function testIndifferenceAt() {
  // at a mixed NE both players are indifferent
  const mp = computeMixedNE(MATCHING_PENNIES)!;
  const at = indifferenceAt(MATCHING_PENNIES, mp.x, mp.y);
  assert(at.a && at.b, 'both players indifferent at the mixed NE');

  // at PD's pure NE neither player is indifferent
  const pdNE = indifferenceAt(PD, 0, 0);
  assert(!pdNE.a && !pdNE.b, 'nobody indifferent at PD\'s strict pure NE');

  // per-player tolerance: A's ±100 spread must not decide B's indifference.
  // B's gap here is 0.2 — large relative to B's own [0,1]-scale payoffs but
  // tiny against A's ±100; only B's own scale may judge it.
  const wide: GamePayoffs = { a11: 100, a12: -100, a21: -100, a22: 100, b11: 0.6, b12: 0.4, b21: 0.4, b22: 0.6 };
  const w = indifferenceAt(wide, 0.5, 0.5);
  // B's gap at x=0.5: E[Col1]=0.5, E[Col2]=0.5 → genuinely indifferent. A's
  // gap at y=0.5 is 0 too. Construct the asymmetric case: B off by 0.2.
  const wideB: GamePayoffs = { a11: 100, a12: -100, a21: -100, a22: 100, b11: 0.6, b12: 0.4, b21: 0.4, b22: 0.2 };
  const wb = indifferenceAt(wideB, 0, 0);
  assert(!wb.b, 'B not indifferent when B\'s own gap is 0.2 — regardless of A\'s ±100 spread');
  void w;
}

// ════════════════════════════════════════════════════════════════════════════
// generateRandomGame — the generator's own contract (the fuzz suites build on it)
// ════════════════════════════════════════════════════════════════════════════
function testRandomGameContract() {
  const rnd = mulberry32(1234);
  for (let i = 0; i < 500; i++) {
    const pure = generateRandomGame('pure');
    assert(computeAllNE(pure).some(n => n.type === 'pure'), `pure game ${i}: must have a pure NE`);
    const mixed = generateRandomGame('mixed');
    assert(computeMixedNE(mixed) !== null, `mixed game ${i}: must have an interior mixed NE`);
  }
  void rnd;
}

// ════════════════════════════════════════════════════════════════════════════
// tieProse — the deterministic prose surface, per tie shape
// ════════════════════════════════════════════════════════════════════════════
function testTieProseUnitTable() {
  const shapes: [string, GamePayoffs][] = [
    ['A flat', FLAT_A],
    ['both flat', FLAT_BOTH],
    ['diagonal tie', { a11: 2, a12: 0, a21: 0, a22: 2, b11: 1, b12: 0, b21: 0, b22: 1 }],
  ];
  for (const [name, g] of shapes) {
    const prose = tieProse(g);
    assert(prose.length > 40, `${name}: prose must be substantive`);
    // the defect is a TERMINAL "probability 0/1" (a rounded-away root called a
    // certainty). Range endpoints and decimals are honest and must keep passing.
    assert(!TERMINAL_PROB.test(prose),
      `${name}: prose must never call a probability a terminal 0 or 1`);
  }
  // mutation-test the guard itself: it must catch the defect sentence it
  // exists for (a paraphrased guard once passed while the defect shipped)
  assert(TERMINAL_PROB.test('B plays Col 1 with probability 0 and Col 2 with probability 1.'),
    'TERMINAL_PROB must catch the defect sentence');
  assert(!TERMINAL_PROB.test('probability 0.5'), 'TERMINAL_PROB must pass decimals');
  assert(!TERMINAL_PROB.test('with any probability from 0 to 0.333'), 'TERMINAL_PROB must pass range endpoints');
  // a game with strict best replies everywhere must never claim a payoff tie
  // (the tie screen and the strict screen are mutually exclusive)
  const strict = tieProse(MATCHING_PENNIES);
  assert(/strict best reply/.test(strict), 'no-tie game gets the strict-best-reply prose');
  assert(!/payoff tie/.test(strict), 'no-tie game must not claim a tie');
  const tied = tieProse(FLAT_A);
  assert(/payoff tie/.test(tied), 'tie game claims its tie');
  // labels flow into the prose when supplied
  const labeled = tieProse(FLAT_A, { row1: 'Attack', row2: 'Defend', col1: 'Left', col2: 'Right' });
  assert(/Attack|Defend/.test(labeled), 'tie prose uses the supplied row labels');
  assert(/Left|Right/.test(labeled), 'tie prose uses the supplied col labels');
}

// ════════════════════════════════════════════════════════════════════════════
// buildGroundingPayload — what the model is TOLD must match the solver
// ════════════════════════════════════════════════════════════════════════════
function testGroundingPayload() {
  for (const [name, g] of [['PD', PD], ['BoS', BOS], ['MP', MATCHING_PENNIES], ['sub-resolution', SUB_RES]] as const) {
    const payload = buildGroundingPayload(g);
    // every equilibrium the solver found is spelled out in the payload
    for (const ne of computeAllNE(g)) {
      const xWord = ne.type === 'mixed' ? fmtProb(ne.x) : String(ne.x);
      const yWord = ne.type === 'mixed' ? fmtProb(ne.y) : String(ne.y);
      assert(payload.includes(xWord), `${name}: payload must state x=${xWord}`);
      assert(payload.includes(yWord), `${name}: payload must state y=${yWord}`);
    }
    assert(/geometry|surface|shelf|warp/i.test(payload), `${name}: payload carries geometry`);
  }
  // the sub-resolution root must be handed over with threshold wording, never
  // a terminal "probability 0" (decimals like 0.5 are fine, as above)
  const srPayload = buildGroundingPayload(SUB_RES);
  assert(srPayload.includes('less than 0.001'), 'sub-resolution payload must use threshold wording');
  assert(!TERMINAL_PROB.test(srPayload),
    'sub-resolution payload must never call a probability a terminal 0 or 1');
}


function testCameraRelayoutPredicate() {
  // Plotly reports camera interaction with GRANULAR keys. This is the whole
  // defect: the listener tested for 'scene.camera', which Plotly never emits,
  // so the stored pose stopped tracking the user's view and every Plotly.react
  // shipped a stale camera. A wheel/pinch ZOOM is the interaction that made it
  // visible — it arrives as 'scene.camera.eye' and nothing else.
  const mustSync: Array<[Record<string, unknown>, string]> = [
    [{ 'scene.camera.eye': { x: 1, y: 1, z: 1 } }, 'a drag or a wheel zoom (the real-world payload)'],
    [{ 'scene.camera': { eye: { x: 1, y: 1, z: 1 } } }, 'a whole-camera relayout'],
    [{ 'scene.camera.eye.x': 1.5 }, 'a single-component update'],
    [{ 'scene.camera.center': { x: 0, y: 0, z: 0 } }, 'a pan, which moves center rather than eye'],
    [{ 'scene.dragmode': 'turntable', 'scene.camera.eye': { x: 1, y: 1, z: 1 } }, 'a camera key alongside others'],
  ];
  for (const [payload, why] of mustSync) {
    assert(isCameraRelayout(payload),
      `isCameraRelayout must return true for ${why}: ${JSON.stringify(payload)}`);
  }

  const mustNotSync: Array<[Record<string, unknown> | null | undefined, string]> = [
    [{ 'scene.dragmode': 'turntable' }, 'rebinding the drag controller'],
    [{ width: 800, height: 600 }, 'a resize'],
    [{ 'scene.annotations': [] }, 'tour callouts'],
    [{}, 'an empty payload'],
    [null, 'null'],
    [undefined, 'undefined'],
    // Guards the boundary between the exact key and the dotted prefix: a key
    // that merely STARTS WITH the string but is a different attribute must not
    // count, or the predicate would resync on unrelated scene changes.
    [{ 'scene.cameraFoo': 1 }, 'a different attribute sharing the prefix'],
  ];
  for (const [payload, why] of mustNotSync) {
    assert(!isCameraRelayout(payload),
      `isCameraRelayout must return false for ${why}: ${JSON.stringify(payload)}`);
  }

  console.log('✓ camera relayout predicate: granular scene.camera.* keys count as camera changes');
}

// ════════════════════════════════════════════════════════════════════════════
// 16. COLOR-CODING TERM PARITY
//
// The same scenario text appears on two surfaces: the "Scenario written for
// this game" suggestion card, and — after the user keeps it — the saved game's
// description. Each call site used to build its own term list, and they did not
// match: the card passed the four option names, the saved description passed
// those PLUS the structural Row/Col terms. Identical prose, visibly different
// amounts of colored text, flipping at the instant of the save.
//
// These assert the shapes that made that possible, so the two surfaces cannot
// drift apart again.
// ════════════════════════════════════════════════════════════════════════════

function testColorTermParity() {
  const sc = { row1: 'Ship Early', row2: 'Hold Back', col1: 'Audit Now', col2: 'Wait' };

  // The card (no actor nouns) and a saved game (also no actor nouns, since
  // actorA/actorB belong to built-in presets) must produce IDENTICAL terms.
  const card = colorTermsFor(sc);
  const saved = colorTermsFor(sc, [], []);
  assert(JSON.stringify(card) === JSON.stringify(saved),
    `card and saved terms differ: ${JSON.stringify(card)} vs ${JSON.stringify(saved)}`);

  // The structural terms are present on BOTH — this is the exact asymmetry
  // that shipped: the card was missing them.
  for (const t of STRUCTURAL_A_TERMS) {
    assert(card.a.includes(t), `player-A terms must always include "${t}"`);
  }
  for (const t of STRUCTURAL_B_TERMS) {
    assert(card.b.includes(t), `player-B terms must always include "${t}"`);
  }

  // Option names land on the right player.
  assert(card.a.includes('Ship Early') && card.a.includes('Hold Back'),
    'row labels must be player-A terms');
  assert(card.b.includes('Audit Now') && card.b.includes('Wait'),
    'col labels must be player-B terms');
  assert(!card.a.includes('Audit Now'), 'col labels must not leak into player-A terms');

  // A game with no scenario still colors structural notation, and nothing else:
  // a null scenario must not silently drop Row/Col highlighting.
  const none = colorTermsFor(null);
  assert(none.a.length === STRUCTURAL_A_TERMS.length && none.b.length === STRUCTURAL_B_TERMS.length,
    `a scenario-less game should carry only structural terms, got ${JSON.stringify(none)}`);

  // Missing/empty labels are dropped rather than colored as empty strings —
  // an empty term would build a regex alternative that matches everywhere.
  const partial = colorTermsFor({ row1: 'Only One', row2: '', col1: null, col2: undefined });
  assert(partial.a.includes('Only One'), 'a present label must survive');
  assert(!partial.a.some((t) => t === ''), 'empty labels must never become terms');
  assert(partial.b.length === STRUCTURAL_B_TERMS.length,
    `absent col labels must add nothing, got ${JSON.stringify(partial.b)}`);

  // Actor nouns are additive and preset-only; they must never be attributed to
  // the wrong player.
  const withActors = colorTermsFor(sc, ['the striker'], ['the keeper']);
  assert(withActors.a.includes('the striker') && !withActors.b.includes('the striker'),
    'actorA nouns belong to player A only');
  assert(withActors.b.includes('the keeper') && !withActors.a.includes('the keeper'),
    'actorB nouns belong to player B only');

  // ── a phrase BOTH players can play belongs to neither colour ──
  // Symmetric games share option names by design: the Prisoner's Dilemma is
  // "Cooperate" for Row 1 AND Col 1. That is correct input, so it must not be
  // rejected — but ColorCoded scans every A term before any B term and takes
  // the first match, so a shared phrase was always painted as A's: wrong half
  // the time, exactly where the reader needs to know whose move it is.
  const pd = colorTermsFor({ row1: 'Cooperate', row2: 'Defect', col1: 'Cooperate', col2: 'Defect' });
  assert(!pd.a.some((t) => t.toLowerCase() === 'cooperate'),
    'a shared option must not be coloured as player A');
  assert(!pd.b.some((t) => t.toLowerCase() === 'cooperate'),
    'a shared option must not be coloured as player B either — it is genuinely ambiguous');
  assert(!pd.a.some((t) => t.toLowerCase() === 'defect') && !pd.b.some((t) => t.toLowerCase() === 'defect'),
    'both shared options drop, not just the first');
  // The unambiguous structure must survive: dropping shared options must not
  // take the Row/Col notation with it.
  for (const t of STRUCTURAL_A_TERMS) assert(pd.a.includes(t), `structural term "${t}" must survive`);
  for (const t of STRUCTURAL_B_TERMS) assert(pd.b.includes(t), `structural term "${t}" must survive`);

  // Case and padding must not smuggle an ambiguous term through.
  const messy = colorTermsFor({ row1: '  Hold Plan ', row2: 'Flood Plan', col1: 'hold plan', col2: 'Divert' });
  assert(!messy.a.some((t) => t.trim().toLowerCase() === 'hold plan')
      && !messy.b.some((t) => t.trim().toLowerCase() === 'hold plan'),
    'shared-option detection must be case- and whitespace-insensitive');
  assert(messy.a.includes('Flood Plan') && messy.b.includes('Divert'),
    'options owned by exactly one player keep their colour');

  console.log('✓ color-coding term parity: card and saved description derive identical terms');
}


function testUserColorTerms() {
  // ── the cleaning rules (client and server share this exact function) ──
  const table: Array<[unknown, string[], string]> = [
    [['Ship Early'], ['Ship Early'], 'a normal phrase survives'],
    [['  padded  '], ['padded'], 'surrounding whitespace is trimmed'],
    [['two\nlines'], ['two lines'], 'a selection across a line break collapses to one space'],
    [['A'], [], 'single characters are refused — ambiguous with the article'],
    [[''], [], 'the empty string is refused — it would match at every position'],
    [['   '], [], 'whitespace-only is refused'],
    [['dup', 'DUP'], ['dup'], 'duplicates are dropped case-insensitively'],
    [[42, 'ok'], ['ok'], 'non-strings are ignored'],
    ['not an array', [], 'a non-array yields nothing'],
    [null, [], 'null yields nothing'],
  ];
  for (const [input, expected, why] of table) {
    const got = cleanUserColorTerms(input);
    assert(JSON.stringify(got) === JSON.stringify(expected),
      `cleanUserColorTerms(${JSON.stringify(input)}): ${why} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  }

  // Length and count caps.
  const long = 'x'.repeat(USER_TERM_MAX_LEN + 40);
  assert(cleanUserColorTerms([long])[0].length === USER_TERM_MAX_LEN,
    'an over-long term is clamped, not dropped');
  const many = Array.from({ length: USER_TERMS_MAX + 7 }, (_, i) => `term ${i}`);
  assert(cleanUserColorTerms(many).length === USER_TERMS_MAX,
    `at most ${USER_TERMS_MAX} terms are kept`);

  // ── THE BOUNDARY ──
  // The user's highlights colour the user's description. They must not appear
  // in the terms used for model-written prose: colorTermsFor is what the AI
  // explanation renders with, descriptionColorTerms is what the description
  // renders with, and only the latter may carry them.
  const sc = { row1: 'Ship Early', row2: 'Hold Back', col1: 'Audit Now', col2: 'Wait' };
  const forProse = colorTermsFor(sc);
  const forDesc = descriptionColorTerms(sc, [], [], ['my phrase'], ['their phrase']);
  assert(!forProse.a.includes('my phrase') && !forProse.b.includes('my phrase'),
    'a user term must never reach the terms used for MODEL prose');
  assert(!forProse.b.includes('their phrase'),
    'a user term must never reach the terms used for MODEL prose');
  assert(forDesc.a.includes('my phrase'), 'the description must carry the user\'s player-A terms');
  assert(forDesc.b.includes('their phrase'), 'the description must carry the user\'s player-B terms');
  // Everything colorTermsFor colours, descriptionColorTerms still colours.
  for (const t of forProse.a) assert(forDesc.a.includes(t), `description lost structural term "${t}"`);
  for (const t of forProse.b) assert(forDesc.b.includes(t), `description lost structural term "${t}"`);
  // User terms are cleaned on the way in, so junk cannot slip through here
  // either.
  assert(!descriptionColorTerms(sc, [], [], ['', 'A'], []).a.some((t) => t === '' || t === 'A'),
    'descriptionColorTerms must apply the same cleaning rules');

  // ── the server-side half of the boundary ──
  // cleanScenario builds the object that goes into the model prompt. It is a
  // whitelist today; a spread or an extra field would carry the user's terms
  // into the prompt, which is the one thing this feature must never do. Assert
  // the shape at the source rather than trusting it stays that way.
  const serverSrc = readFileForContract('server.ts', 'utf8');
  const m = serverSrc.match(/const sc: Scenario = \{([\s\S]*?)\n  \};/);
  assert(!!m, 'could not find the cleanScenario literal in server.ts');
  const keys = [...m![1].matchAll(/^\s*([A-Za-z_][\w]*)\s*:/gm)].map((x) => x[1]).sort();
  const allowed = ['col1', 'col2', 'description', 'name', 'row1', 'row2'];
  assert(JSON.stringify(keys) === JSON.stringify(allowed),
    `cleanScenario must build exactly ${allowed.join(', ')} — got ${keys.join(', ')}. `
    + 'Any other field here reaches the model prompt.');
  assert(!/\.\.\./.test(m![1]),
    'cleanScenario must not spread the client object into the prompt scenario');

  // ── ownership is exclusive ──
  // A phrase belongs to one player. The editor never produces both, but a
  // direct PATCH can, and then the colour depends on which list the renderer
  // scans first — a decision nobody made.
  const pair = cleanUserColorTermPair(['Shared', 'OnlyA'], ['Shared', 'OnlyB']);
  assert(pair.a.includes('Shared') && !pair.b.includes('Shared'),
    'a phrase claimed by both players must resolve to exactly one (A wins)');
  assert(pair.a.includes('OnlyA') && pair.b.includes('OnlyB'),
    'non-conflicting terms survive on both sides');
  assert(cleanUserColorTermPair(['x'], ['X']).b.length === 0,
    'the conflict check is case-insensitive');

  // ── the user's explicit choice outranks an automatic term ──
  // "Row 1" is coloured for player A automatically. A user who deliberately
  // marks it for player B must SEE player B — in the editor preview and in the
  // saved description alike, since both render through descriptionColorTerms.
  const overlap = descriptionColorTerms(sc, [], [], [], ['Row 1']);
  assert(overlap.b.includes('Row 1'), "the user's assignment must be honoured");
  assert(!overlap.a.includes('Row 1'),
    'the automatic owner must be REMOVED, not merely ordered behind: ColorCoded scans every '
    + 'A term before any B term, so an A entry would win the tie however the lists are sorted');
  // The other automatic terms are untouched.
  assert(overlap.a.includes('Row 2') && overlap.b.includes('Col 1'),
    'reassigning one phrase must not disturb the rest');

  console.log('✓ user colour terms: cleaning rules hold and never cross into model prose');
}


function testScenarioDomains() {
  // The product target: no single scenario name may dominate. Rotating the
  // SETTING bounds the top-name share at roughly 1/|DOMAINS|, so the list
  // length is the guarantee — assert it against the target itself rather than
  // a magic number, so shrinking the list fails here instead of silently
  // degrading diversity in production.
  const TARGET_TOP_SHARE = 0.05;
  assert(SCENARIO_DOMAINS.length >= Math.ceil(1 / TARGET_TOP_SHARE),
    `need at least ${Math.ceil(1 / TARGET_TOP_SHARE)} domains to keep the top share under `
    + `${TARGET_TOP_SHARE * 100}%, have ${SCENARIO_DOMAINS.length}`);

  // A duplicate silently doubles one domain's share — the exact defect this
  // list exists to prevent, reintroduced by a careless edit.
  const seen = new Set(SCENARIO_DOMAINS.map((d) => d.toLowerCase().trim()));
  assert(seen.size === SCENARIO_DOMAINS.length,
    `SCENARIO_DOMAINS has duplicates: ${SCENARIO_DOMAINS.length} entries, ${seen.size} distinct`);

  for (const d of SCENARIO_DOMAINS) {
    assert(d.trim().length >= 3, `domain too short to be a setting: "${d}"`);
    // A domain carrying a number or a comparative would push a CLAIM into a
    // rung-3 description, which must be pure scene-setting — the claim-free
    // gate would then drop the scenario and the user would get no story.
    assert(!/\d/.test(d), `domain must not carry a number: "${d}"`);
    // Trailing \b matters: without it "wins?" matches the "win" inside
    // "windows" and rejects a perfectly good setting. `equilibri` is left
    // unanchored on purpose so it catches equilibrium/equilibria alike.
    assert(!(/\b(?:best|better|worse|optimal|wins?|beats?|dominant)\b/i.test(d) || /equilibri/i.test(d)),
      `domain must not assert anything decidable: "${d}"`);
  }

  // The picker must stay in range at both ends, including a sloppy pick().
  const first = pickScenarioDomain(() => 0);
  const last = pickScenarioDomain(() => 0.999999999);
  assert(first === SCENARIO_DOMAINS[0], 'pick()=0 must select the first domain');
  assert(last === SCENARIO_DOMAINS[SCENARIO_DOMAINS.length - 1],
    'pick()->1 must select the last domain, not run off the end');
  assert(typeof pickScenarioDomain(() => 1) === 'string', 'pick()=1 must not return undefined');
  assert(typeof pickScenarioDomain(() => -0.5) === 'string', 'a negative pick must not return undefined');

  // And the distribution has to actually deliver the target over a realistic
  // number of requests, not merely in principle.
  const counts = new Map<string, number>();
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const d = pickScenarioDomain();
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const top = Math.max(...counts.values()) / N;
  assert(top < TARGET_TOP_SHARE,
    `top domain share ${(top * 100).toFixed(2)}% over ${N} picks exceeds the ${TARGET_TOP_SHARE * 100}% target`);

  console.log(`✓ scenario domains: ${SCENARIO_DOMAINS.length} distinct settings, top share `
    + `${(top * 100).toFixed(2)}% over ${N} picks (target < ${TARGET_TOP_SHARE * 100}%)`);
}


function testFmtPayoffSubResolution() {
  // The matrix accepts values down to 0.001 and clamps at +/-100, so an
  // expected payoff — a weighted average of four cells — can be smaller than
  // the display resolution. A bare toFixed(3) then printed "-0.000": it claims
  // the payoff is nothing AND reads as a typo. fmtProb has guarded
  // probabilities against exactly this since round 14; payoffs were not.
  const table: Array<[number, string, string]> = [
    [0, '0', 'an exact zero is a fact, and prints plainly'],
    [-0, '0', 'negative zero must never reach the screen'],
    [-33.333, '-33.333', 'ordinary magnitudes are unchanged'],
    [2.5, '2.500', 'three decimals kept for alignment'],
    [-0.003, '-0.003', 'the smallest representable payoff still prints'],
    [0.0003333, 'less than 0.001', 'a positive value below resolution says so'],
    [-0.0003333, 'greater than -0.001', 'and so does a negative one, with the correct direction'],
    [-1e-9, 'greater than -0.001', 'however small'],
  ];
  for (const [v, want, why] of table) {
    const got = fmtPayoff(v);
    assert(got === want, `fmtPayoff(${v}): ${why} — expected "${want}", got "${got}"`);
  }
  // The property that matters: a NONZERO payoff must never be rendered as a
  // bare zero, at any scale the matrix can produce.
  for (const v of [1e-4, -1e-4, 5e-4, -5e-4, 9.9e-4, -9.9e-4]) {
    const got = fmtPayoff(v);
    assert(!/^-?0(\.0+)?$/.test(got),
      `fmtPayoff(${v}) rendered a nonzero payoff as "${got}", which claims it is zero`);
  }
  console.log('✓ fmtPayoff: sub-resolution payoffs never render as zero');
}

// ════════════════════════════════════════════════════════════════════════════

function runUnitTests() {
  testComputeMixedNEClosedForms();
  testComputeAllNEStructure();
  testNEDefinitionInvariants();
  testFmtProbTable();
  testParseNumericInputTable();
  testCommitPayoffInputTable();
  testCommitStartCoordinateTable();
  testCommitStepTables();
  testNormalizeProseMinus();
  testPayoffArithmetic();
  testProfilesAndContinua();
  testIndifferenceAt();
  testRandomGameContract();
  testTieProseUnitTable();
  testGroundingPayload();
  testColorTermParity();
  testUserColorTerms();
  testCameraRelayoutPredicate();
  testScenarioDomains();
  testFmtPayoffSubResolution();
  testGateFixesAugust31();
  testOptionLabelChannel();
  testNegotiationForm();
  console.log('All unit tests passed.');
}

/**
 * THE THREE GATE FIXES OF THE 2026-08-31 FIX WINDOW.
 *
 * Every check below ships with at least one KNOWN-POSITIVE draw it must flag,
 * asserted in the same run as its negative control. That rule is not stylistic:
 * four separate guards were found this round to be structurally unable to fire
 * — one whose inputs the schema forbids, one formatter applied to an
 * already-rounded value, one port assertion the kernel answers misleadingly, and
 * one inside the red team's own instrument whose scan window had eaten the
 * evidence and reported a clean zero. CLAUDE.md already records the same shape
 * in `_gen/verify_geom.ts`. A green number from a check that cannot fire is
 * worse than no check, so each fixture here is a draw observed in the wild.
 */
function testGateFixesAugust31() {
  const ANTI: GamePayoffs = { a11: 0, a12: 3, a21: 2, a22: 0, b11: 0, b12: 2, b21: 3, b22: 0 };
  const MATCH: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 2, b12: 0, b21: 0, b22: 1 };
  const PD_LOCAL: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };

  // ── F11: an option with no name at all ────────────────────────────────────
  // Verbatim draw: the model emitted col1 plus INVENTED keys day1/day2, so col2
  // is ABSENT rather than empty. Every distinctness check short-circuits on a
  // falsy label, so nothing examined it and the whole gate passed. Downstream it
  // reached the user's SAVED description as "...and undefined".
  const saffron: any = {
    name: 'Saffron Harvest Labour', row1: 'Early Harvest', row2: 'Late Harvest',
    col1: 'Night Work', day1: 'Morning Work', day2: 'Evening Work', storyClaims: null,
    description: 'A farmer chooses between Early Harvest and Late Harvest for his saffron crop. A nearby worker chooses between Night Work and Day Work for the same harvest period.',
  };
  assert(!validateScenario(saffron, PD_LOCAL).ok,
    'F11: a scenario whose col2 is ABSENT must be rejected — the observed draw invented day1/day2');
  // The distinction that IS the defect: a check written against `=== ""` reports
  // clean on the very draw it was written for.
  assert(!validateScenario({ ...saffron, col2: '   ' }, PD_LOCAL).ok,
    'F11: a whitespace-only label must be rejected too');
  assert(validateScenario({ ...saffron, col2: 'Day Work' }, PD_LOCAL).ok,
    'F11 CONTROL: with all four labels present the same scenario must pass');

  // ── F1: matching language on a game whose every pure NE is a MISMATCH ─────
  // The shape gate read `diag === pure.length || anti === pure.length`, which
  // conflates "has a matching-or-mismatching structure" with "matching language
  // is true here" — so the screen skipped exactly the games where it is false.
  const coordSc = (d: string) => ({
    name: 'X', row1: 'Morning Harvest', row2: 'Evening Harvest',
    col1: 'Shared Window', col2: 'Separate Window', storyClaims: null, description: d,
  } as any);
  const MATCH_TALK = "Both cooperatives want to match the opponent's choice for the drying season.";
  assert(!validateScenario(coordSc(MATCH_TALK), ANTI).ok,
    'F1: matching language must be caught where every pure equilibrium is a MISMATCH');
  // The pair that matters: same sentence, different matrix. Only the game differs.
  assert(validateScenario(coordSc(MATCH_TALK), MATCH).ok,
    'F1 CONTROL: the identical sentence on a genuine matching game must still pass');
  assert(validateScenario(coordSc('A seaweed cooperative picks a drying slot while a neighbouring firm picks a window.'), ANTI).ok,
    'F1 CONTROL: plain scene-setting on the mismatch game must still pass');

  // ── F1-vocab: the ABSTRACT-PLAYER form, which is what the model actually ──
  // writes. The predicate above was correct and matched ZERO of 341 real draws,
  // because COORD_TALK's vocabulary ("incentive to match the opponent's
  // choice") is not this model's. "The two players coordinate their choices" is,
  // and it asserts the same thing. Reach on 875 stored draws: 14 (1.60%) local,
  // 0 cloud — see `_gen/blue_w2_check.mjs`, which measures reach and fixtures in
  // the same run.
  //
  // THE DISCRIMINATOR IS SUBJECT-HOOD, NOT THE WORD. Gating on "coordinate"
  // itself has 11.9% precision and rejects 7.6% of local draws for the JOB TITLE
  // "coordinator" alone. Each negative below is the specific shape a looser rule
  // over-reaches into; C6 is a MEASURED false positive of the proximity draft
  // this replaced, not a hypothetical.
  const ONE_MATCH: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
  const NO_PURE: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 0, b12: 1, b21: 2, b22: 0 };
  const CLAIM = 'The two players coordinate their choices for the drying season.';
  assert(!validateScenario(coordSc(CLAIM), ANTI).ok,
    'F1-vocab: "the two players coordinate their choices" must be caught where no pure equilibrium matches');
  assert(!validateScenario(coordSc(CLAIM), NO_PURE).ok,
    'F1-vocab: and where the game has no pure equilibrium at all');
  assert(!validateScenario(coordSc('The two players are planning a coordinated drying schedule for their racks.'), ANTI).ok,
    'F1-vocab: the intention form with a participle object must be caught');
  assert(!validateScenario(coordSc('Both parties are coordinating their harvest and procurement plans.'), ANTI).ok,
    'F1-vocab: the "both" subject arm must be caught — untested vocabulary is unshipped vocabulary');
  // Only the matrix may change the verdict.
  assert(validateScenario(coordSc(CLAIM), MATCH).ok,
    'F1-vocab CONTROL: the identical sentence where both pure equilibria MATCH must pass');
  assert(validateScenario(coordSc(CLAIM), ONE_MATCH).ok,
    'F1-vocab CONTROL: and where the single pure equilibrium IS a matching pair — the issue string would be false there');
  // The job title, which is a scenario noun and never a claim.
  assert(validateScenario(coordSc('A shipyards and a harbor coordinator are coordinating dredging operations for a shared canal.'), ANTI).ok,
    'F1-vocab CONTROL (red 2, load-bearing): a job title AND a named-actor coordination verb in one sentence must pass');
  assert(validateScenario(coordSc('The two players are the shipyard and the harbor coordinator for the canal.'), ANTI).ok,
    'F1-vocab CONTROL: an abstract subject whose PREDICATE is the job title must pass');
  assert(validateScenario(coordSc('The two players are coordinators at the same depot, and each picks a shift.'), ANTI).ok,
    'F1-vocab CONTROL: "are coordinators" is a noun, not the players coordinating');
  // The flat ACTIVITY tic: uniform across equilibrium shapes, so gating it would
  // be the word list this screen exists to avoid.
  assert(validateScenario(coordSc('A ferry operator and a dock warden are coordinating a joint experiment for the season.'), ANTI).ok,
    'F1-vocab CONTROL: the flat ACTIVITY form with named actors must pass');
  assert(validateScenario(coordSc('The two players are choosing how their shared grid will respond to a coordinated demand period.'), ANTI).ok,
    'F1-vocab CONTROL (rt2#129, a MEASURED false positive of the proximity draft): the players\' verb is "are choosing"');
  assert(validateScenario(coordSc('The two players are the coordinating body for the canal traffic.'), ANTI).ok,
    'F1-vocab CONTROL: "the coordinating body" — a determiner with no verb of intention before it');
  // Negation is excluded structurally: "never"/"do"/"cannot" are not in the
  // closed bridge class, so the subject never reaches the verb.
  for (const neg of ['The two players never coordinate their choices here.',
    'The two players do not coordinate their choices.',
    'The two players cannot coordinate their choices.']) {
    assert(validateScenario(coordSc(neg), ANTI).ok, `F1-vocab CONTROL: a negated claim must pass — ${neg}`);
  }

  // ── F12: cross-attribution through the LETTER form ───────────────────────
  // The role-noun misattribution check fires only on declared actor nouns and
  // has never executed on a model-invented scenario, because the cloud schema
  // forbids actorA/actorB. The letter form went unscreened because it was
  // assumed unambiguous; this is the counterexample.
  const orchard = {
    name: 'Orchard Frost Watch', row1: 'Early Harvest', row2: 'Late Harvest',
    col1: 'Release Water', col2: 'Hold Water', storyClaims: null,
  };
  const S12 = 'An orchard manager, Player A, chooses between Early Harvest and Late Harvest for the season. A regional water cooperative, Player B, chooses between Release Water and Hold Water for the same fields.';
  assert(!validateScenario({ ...orchard, description: `${S12} Player A chooses when to release water, and Player B chooses how to manage it.` } as any, ANTI).ok,
    'F12: "Player A chooses when to release water" must be caught — Release Water is B\'s option');
  // The negative half matters as much: this is the CORRECT letter prose and it
  // appears in most letter-using draws. A screen that flags it is unshippable.
  assert(validateScenario({ ...orchard, description: S12 } as any, ANTI).ok,
    'F12 CONTROL: correct letter prose naming each player\'s own options must pass');
  assert(validateScenario({ ...orchard, description: `${S12} Player A chooses Early Harvest.` } as any, ANTI).ok,
    'F12 CONTROL: a letter naming its OWN option must pass');

  // ── F11, the save path (App.tsx useSuggestedScenario) ────────────────────
  // Source-level, in the style of the other App.tsx invariants here: the
  // fallback sentence must be built from the pairs that EXIST. Asserting on the
  // source is the only way to guard a branch that lives inside a component.
  const appSrc = readFileForContract('src/App.tsx', 'utf8');
  assert(/const pair = \(who: string, a\?: string, b\?: string\) =>\s*\n?\s*a && b \?/.test(appSrc),
    'F11 save path: the label sentence must be built per PAIR, so a partial draw keeps what it supplied');
  assert(!/B chooses between \$\{sc\.col1\} and \$\{sc\.col2\}/.test(appSrc),
    'F11 save path: the old template interpolated a missing label straight into the saved description');
  assert(!/\[sc\.row1, sc\.row2, sc\.col1, sc\.col2\]\.some\(Boolean\) \? labelSentence/.test(appSrc),
    'F11 save path: the some(Boolean) guard gated a sentence only built correctly when all four were present');

  console.log('✓ gate fixes 2026-08-31: F11 missing label (gate + save path), F1 shape gate, F12 letter-form attribution');
}

/**
 * THE OPTION-LABEL / NAME CHANNEL (RED 2, cases L1–L6).
 *
 * Rung 3's no-numbers rule governed `sc.description` and nothing else. The name
 * field was screened by NOTHING, and a number in an option label was examined
 * only when it sat INSIDE PARENTHESES. Six hand-built magnitude claims were
 * pushed through the real shipping gate — validateScenario + scenarioIsClaimFree
 * + validateProseDirections, as server.ts composes them — and all six reached
 * the user. Four are closed here.
 *
 * TWO ARE DELIBERATELY LEFT OPEN, and that is the important part of this test.
 * "Full Evacuation / No Evacuation" and "Full Shutdown / No Shutdown" are not
 * decidable from anything the program holds: the same shape is real, good model
 * output ("Full Monitoring / No Monitoring"), and a word list broad enough to
 * catch them rejects 32.2% of gate-passing draws (282 of 875 measured;
 * `_gen/blue_w3_mutation.mjs` prices that mutant against the corpus). The
 * controls below are that boundary written down, so a later widening of this
 * screen fails here instead of quietly costing a third of all output.
 *
 * Reach of everything added here: 0 of 890 stored real draws, cloud and local.
 * This is CONTAINMENT, not detection.
 */
function testOptionLabelChannel() {
  const TINY: GamePayoffs = { a11: 0.001, a12: 0, a21: 0, a22: 0.001, b11: 0, b12: 0.001, b21: 0.001, b22: 0 };
  const sc = (o: Record<string, unknown>) => ({
    name: 'Regional Allocation', row1: 'Alpha', row2: 'Beta', col1: 'Gamma', col2: 'Delta',
    storyClaims: null, ...o,
  } as any);
  // The gate the SERVER runs, not a subset of it. Reproducing two thirds of a
  // gate and calling the result a pass is the error this campaign keeps finding.
  const gate = (s: any) => validateScenario(s, TINY).ok
    && scenarioIsClaimFree(s).ok !== false
    && validateProseDirections(s.description ?? '', s, TINY).length === 0;

  // ── L1: a bare number in an option label ─────────────────────────────────
  assert(!gate(sc({ row1: 'Commit 1000 Units', row2: 'Commit 1 Unit' })),
    'L1: a bare number in an option label must be rejected — the digit screen read sc.description only');
  // ── L2: an explicit multiple in an option label ──────────────────────────
  assert(!gate(sc({ row1: 'Hundredfold Expansion', row2: 'No Change' })),
    'L2: "Hundredfold" states a ratio on a game whose every swing is one thousandth of a unit');
  // ── L4: magnitude in the NAME, a field no screen read ────────────────────
  assert(!gate(sc({ name: 'The 100000x Decision' })),
    'L4: the scenario name must be screened — it was read by nothing');
  // ── L5: the same claim spelled out, so it carries no digit ───────────────
  assert(!gate(sc({ description: 'A regional operator weighs a choice worth a hundred thousand times more than the other party\'s, in the same season.' })),
    'L5: a spelled-out multiple carries the claim with no numeral for /\\d/ to find');

  // The keystroke that blinds validateScenario's parenthetical rule. VERBATIM
  // from the C11 draw that rule was written for, U+2212 and all — a paraphrased
  // regression test once passed while the real defect shipped.
  assert(!gate(sc({ row1: 'Signal −1/−1', row2: 'Signal +1/+1' })),
    'C11 without brackets: the annotation rule only looks inside parentheses, so this walked through it');

  // `\p{N}`, not `\d`. `\d` is ASCII-only in JavaScript; this repo has shipped
  // that hole before and typography has bitten it three times.
  assert(!gate(sc({ row1: 'Commit １０００ Units' })),
    'a fullwidth numeral in a label must be rejected — /\\d/ misses it entirely');
  assert(!gate(sc({ description: 'A regional operator commits ١٠٠ crates while a second operator commits its own.' })),
    'an Arabic-Indic numeral in the description must be rejected');

  // ── CONTROLS. Real, gate-passing draws. None may be newly rejected. ──────
  assert(gate(sc({ name: 'Antique Restoration Bidding', row1: 'Full Repairs', row2: 'Minor Repairs', col1: 'Open Call', col2: 'Reserve' })),
    'CONTROL (rt1#3): a magnitude-BEARING label pair is ordinary output and must pass');
  assert(gate(sc({ name: 'Cheese Cave Ripening', row1: 'Early Ripening', row2: 'Late Ripening', col1: 'Full Monitoring', col2: 'No Monitoring' })),
    'CONTROL (r2local#108): the ONLY total-vs-nothing pair in 883 real draws is good output — this is the boundary L3/L6 sit on');
  assert(gate(sc({ name: 'Bakery Pricing', row1: 'Premium Price', row2: 'Discount Price', col1: 'Bulk Flour', col2: 'Specialty Flour' })),
    'CONTROL: premium/discount label pairs are the single most common real shape');
  assert(gate(sc({ row1: 'Manifold Assembly', row2: 'Valve Assembly' })),
    'CONTROL: "Manifold" is not a multiple — the -fold rule requires a numeral stem');
  assert(gate(sc({ row1: 'Double Shift', row2: 'Single Shift' })),
    'CONTROL: "double" asserts no specific ratio and is ordinary English');
  assert(gate(sc({ description: 'A regional operator has run this route many times before, and a second operator is new to it.' })),
    'CONTROL: "many times" names no number — gating it would be the word list this screen avoids');

  // ── WHERE THE RULE LIVES. This is an architectural assertion, both ways. ──
  // The no-numbers rule is TRUE ONLY AT RUNG 3, because only there does the
  // solver state every number. validateScenario runs at every rung, and at rung
  // 0 the model writes the numbers itself — "Gate 12 / Gate 7" is an ordinary
  // pair of option names there. So the screen must sit on the rung-3-only
  // function, and the all-rung one must stay silent about it.
  const numbered = sc({ name: 'Airport Gate Assignment', row1: 'Gate 12', row2: 'Gate 7', col1: 'Stand A', col2: 'Stand B' });
  assert(validateScenario(numbered, TINY).ok,
    'PLACEMENT: validateScenario runs at EVERY rung and must not carry the rung-3 numeral rule — "Gate 12" is a fine rung-0 label');
  assert(scenarioIsClaimFree(numbered).ok === false,
    'PLACEMENT: the rung-3 screen must still reject it');
  // And the matrix-checked annotation rule must NOT have migrated: it is
  // decidable at any rung, so it belongs where it was.
  assert(validateScenario(sc({ row1: 'Early Run (77, 88)', row2: 'Late Run' }), TINY).issues
    ?.some((s) => /annotates a payoff pair/.test(s)),
    'PLACEMENT: the matrix-checked parenthetical rule must remain in validateScenario');

  console.log('✓ option-label channel: L1/L2/L4/L5 closed at 0 reach on 890 real draws; L3/L6 left open as undecidable, boundary asserted');
}

/**
 * THE NEGOTIATION FORM — RED 1's largest remaining oracle hole.
 *
 * "The two yards negotiate over the rack calendar. One side offers an Early
 * Slot or a Late Slot and the other accepts a Shared Window or a Separate
 * Window in exchange." False about EVERY game this app models, not merely this
 * matrix: an offer answered by an acceptance places one move after the other
 * and makes the second a response to the first, and a one-shot simultaneous
 * game has no such order. It is the same defect the move-order and "responds
 * to" rules exist for, in vocabulary neither of them shares.
 *
 * THE CONTROLS BELOW ARE REAL DRAWS, QUOTED. Every one is model output that
 * passed the gate, and every one contains a word the naive fix would have
 * banned. They are the evidence that the shipped rule is a conjunction rather
 * than a word list: "negotiate" alone is 1.12% of real output, "offer" 1.12%,
 * "contract/deal/terms" 6.18%, and all of it is good.
 */
function testNegotiationForm() {
  const ANTI: GamePayoffs = { a11: 0, a12: 3, a21: 2, a22: 0, b11: 0, b12: 2, b21: 3, b22: 0 };
  const sc = (d: string) => ({
    name: 'Test', row1: 'Early Slot', row2: 'Late Slot',
    col1: 'Shared Window', col2: 'Separate Window', storyClaims: null, description: d,
  } as any);
  const gate = (d: string) => validateScenario(sc(d), ANTI).ok
    && scenarioIsClaimFree(sc(d)).ok !== false
    && validateProseDirections(d, sc(d), ANTI).length === 0;

  // ── THE HOLE, verbatim from _gen/rt_gate_holes.mjs ───────────────────────
  assert(!gate('The two yards negotiate over the rack calendar. One side offers an Early Slot or a Late Slot and the other accepts a Shared Window or a Separate Window in exchange.'),
    'NEGOTIATION: the offer-and-accept protocol must be caught — it asserts sequence in a simultaneous game');
  // Each arm alone, so a later edit that guts one is not hidden by the other.
  assert(!gate('A shipyard offers an Early Slot or a Late Slot for the dredging window. A harbour board accepts one of two berth arrangements for the same window.'),
    'NEGOTIATION arm A: offer plus accept, without the word "negotiate" anywhere');
  assert(!gate('Two rack yards bargain until they reach an agreement on the season calendar.'),
    'NEGOTIATION arm B: reaching an agreement asserts a cooperative solution concept');
  assert(!gate('The two yards each pick a slot, and the result is a binding arrangement for the season.'),
    'NEGOTIATION arm B: binding language must be caught');
  assert(!gate('A yard takes an Early Slot and the neighbouring yard gives up its window in exchange.'),
    'NEGOTIATION arm B: "in exchange" asserts a reciprocal trade the game cannot express');

  // ── CONTROLS: REAL DRAWS that passed the gate. None may be newly rejected. ─
  // Quoted from the stored corpora, not paraphrased — a paraphrased regression
  // test has already passed here while the real defect shipped.
  const REAL: [string, string][] = [
    ['stcloud#7, "negotiating" as scene-setting',
      'Two fishing cooperatives are negotiating how to manage a shared seasonal catch quota. The North Fleet chooses between Firm quota and Flexible quota, while the South Fleet independently chooses between Firm quota and Flexible quota.'],
    ['rt2#20, negotiating a contract',
      'A regional railroad and a neighboring railroad are negotiating a hedge-laying contract. The railroad chooses between Reserve Market and Hold Market, while the neighboring railroad chooses between Short Hedge and Long Hedge.'],
    ['stcloud#24, negotiating plus two independent choices',
      'An antique dealer and a restoration studio are negotiating a restoration contract. The dealer chooses between Firm Bid and Flexible Bid, while the studio chooses between Detailed Scope and Basic Scope.'],
    ['stcloud#6, "offering" in the ordinary sense of providing',
      'A bakery manager chooses between placing an Early Order or a Late Order for the next production cycle. A flour supplier chooses between offering Bulk Flour or Specialty Flour.'],
    ['r2cloud#4, a distributor offering contract types',
      'An orchard grower, Player A, chooses between an Early Harvest and a Late Harvest for the season. A fruit distributor, Player B, chooses between offering a Firm Contract and a Flexible Contract for purchasing the fruit.'],
    ['r2local#4, "accept" as one player\'s own simultaneous choice',
      'A fruit cooperative chooses whether to plant Early Harvest or Late Harvest. A retailer chooses whether to accept an Open Contract or a Fixed Contract.'],
    ['rt1#180, "contract" as an ordinary scenario noun',
      'An agricultural cooperative chooses between Early Planting and Late Planting for its wheat crop. A contract buyer chooses between Stable Contract and Flexible Contract for arranging the payment schedule.'],
  ];
  for (const [tag, d] of REAL) {
    assert(gate(d), `NEGOTIATION CONTROL (${tag}): real gate-passing output must not be newly rejected — this is why the rule is a conjunction, not a word list`);
  }
  // THE MINIMAL PAIR. "Negotiating" is held constant across both, so the word
  // is demonstrably not what decides the verdict — only the protocol is. Note
  // the first draft of this pair was WRONG and the suite caught it: it swapped
  // in "the other accepts" alone and expected a rejection, but an acceptance
  // that answers nothing is one player's own simultaneous choice and is real,
  // legal output (r2local#4 above). It takes BOTH roles to assert the protocol.
  const scene = 'Two rack yards are negotiating the season calendar. One yard chooses an Early Slot or a Late Slot, while the other independently chooses a Shared Window or a Separate Window.';
  assert(gate(scene),
    'NEGOTIATION CONTROL: negotiating as a setting, with two independent choices, must pass');
  assert(!gate(scene
    .replace('One yard chooses', 'One yard offers')
    .replace('while the other independently chooses', 'and the other accepts')),
    'NEGOTIATION: the identical sentence becomes a claim once one side OFFERS and the other ACCEPTS');
  // And the half-step in between stays legal, which is what keeps the rule a
  // conjunction: an offer with no acceptance is just a supplier providing
  // options, the single most common real use of the word.
  assert(gate(scene.replace('One yard chooses', 'One yard offers')),
    'NEGOTIATION CONTROL: an offer with no acceptance answering it must still pass');

  console.log('✓ negotiation form: offer/accept protocol and binding-agreement claims caught; 7 real draws containing negotiate/offer/accept/contract still pass');
}

try {
  runUnitTests();
} catch (err: any) {
  console.error('Unit test suite failure:');
  console.error(err?.message || err);
  process.exit(1);
}

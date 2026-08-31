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
  console.log('All unit tests passed.');
}

try {
  runUnitTests();
} catch (err: any) {
  console.error('Unit test suite failure:');
  console.error(err?.message || err);
  process.exit(1);
}

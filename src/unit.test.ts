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

/**
 * MODEL-INTERNAL DEBRIS reaching the user.
 *
 * Five distinct real cloud draws, every one accepted by every shipped gate
 * before this. Rare (5 of 4,088 draws that reach the user, 0.122%, across 67
 * corpora plus the scenario bank) and every one user-facing.
 *
 * EACH RULE HAS A FIXTURE ONLY IT CAN CATCH. The two observed dirty rows carry
 * more than one signal each — row 185 has Hebrew AND braces, row 805 has braces
 * AND self-talk — so a suite built only from them cannot fail when a single rule
 * is deleted. The isolating fixtures below exist for exactly that reason, and
 * the mutation run (_gen/blue_w8_debris_mutation.py) confirms each rule is
 * killed by its own.
 */
function testModelDebris() {
  const G: GamePayoffs = { a11: 2, a12: -1, a21: 0, a22: 3, b11: 1, b12: 0, b21: -2, b22: 1 };
  const sc = (o: Record<string, unknown>) => ({
    name: 'Depot Window', row1: 'Early Slot', row2: 'Late Slot', col1: 'Full Crew', col2: 'Lean Crew',
    storyClaims: null, description: 'A depot and a haulier each pick a loading window for the morning.', ...o,
  } as any);
  const debris = (o: Record<string, unknown>) =>
    validateScenario(sc(o), G).issues.filter((i) => /outside the expected script|curly brace|talking to itself/.test(i));

  // ── THE OBSERVED ROWS, quoted from the corpora they were found in ────────
  assert(debris({ name: 'Regional Triage Staffing', col1: 'Surge Roster', col2: 'Core Roster',
    description: 'Two hospitals share a regional triage plan. Hospital A chooses either "Expanded Roster" or "Lean Roster." לה}} 腾讯分分彩? 亚洲色}}' }).length > 0,
    'DEBRIS: Hebrew and CJK spam appended to a real description must be rejected');
  assert(debris({ row1: 'Thin coat', row2: '厚 coat' }).length > 0,
    'DEBRIS: a CJK character inside an English option label must be rejected');
  assert(debris({ row2: '深-cycle Service' }).length > 0,
    'DEBRIS: the 深-cycle label that shipped in the wild must be rejected');
  // The Arabic row existed ONLY in the bank, so no report corpus ever produced
  // it. The script list already covered Arabic on principle; this is the draw
  // that turned that from a boundary fixture into an observed positive.
  assert(debris({ name: 'Herbarium Loan Request', row1: 'Approve Loan', row2: 'Defer Loan', col1: 'Rush Request', col2: 'Routine Request',
    description: 'A university herbarium is coordinating a specimen-loan request with a botanical researcher. The herbarium chooses between "Approve Loan" and "Defer Loan," while the researcher chooses between "Rush Request" and "Routine Request." يُ}} GG. } siu' }).length > 0,
    'DEBRIS: the Arabic + brace bank row must be rejected');
  // The self-talk positive, first-hand from the bank rather than from a log
  // excerpt: this is the row the rule was written against.
  assert(debris({ name: 'Side-Table Touch-Up', row1: 'Trim Bid', row2: 'Full Bid', col1: 'Quick Approval', col2: 'Careful Review',
    description: 'A neighborhood antique dealer and a restoration studio are discussing a bid. The dealer chooses between "Quick Approval" and "Careful Review." wait invalid. Need clean JSON.' })
    .some((i) => /talking to itself/.test(i)),
    'DEBRIS: the bank\'s Side-Table row is the first-hand self-talk positive');

  // ── ONE FIXTURE PER RULE, each isolating a single signal ─────────────────
  assert(debris({ row2: '厚 coat' }).some((i) => /outside the expected script/.test(i)),
    'DEBRIS (script only): a non-Latin codepoint with no braces and no self-talk');
  assert(debris({ description: 'A depot picks a lane while the board picks a window.}}' })
    .some((i) => /curly brace/.test(i)),
    'DEBRIS (brace only): JSON braces with no foreign script and no self-talk');
  assert(debris({ description: 'The board picks a window. wait invalid. Need clean JSON. I accidentally weird.' })
    .some((i) => /talking to itself/.test(i)),
    'DEBRIS (self-talk only): the model narrating itself, with no braces and no foreign script');
  // The curly apostrophe is not optional: the observed row writes "Let’s
  // formulate" with U+2019, and an ASCII-only list missed it.
  assert(debris({ description: 'The board picks a window. Let’s formulate.' })
    .some((i) => /talking to itself/.test(i)),
    'DEBRIS: the self-talk list must match the CURLY apostrophe, which is what the model actually emits');

  // ── THE NEAR-MISSES. Every one would break a careless version. ───────────
  const clean = (o: Record<string, unknown>, why: string) => assert(debris(o).length === 0, why);
  clean({ description: 'The yard books a slot; the board notes a −100 swing for the season.' },
    'DEBRIS CONTROL: U+2212 MINUS must pass — it has been mistaken for a defect in this repo three times');
  clean({ name: 'Café Réservation', description: 'A Zürich café and a naïve façade restorer each pick a window.' },
    'DEBRIS CONTROL: accented Latin is ordinary text');
  clean({ description: 'The yard’s slot and the board’s “window” — an Early–Late choice…' },
    'DEBRIS CONTROL: curly quotes, em and en dashes and the ellipsis must pass');
  clean({ description: 'At 20°C the depot quotes £5, €5 or $5, a ± 3 swing, ≤ 4 crates.' },
    'DEBRIS CONTROL: degree, currency and mathematical symbols are Symbol-class and must pass');
  clean({ row1: 'Early Slot (peak)', description: 'The depot picks a lane [north or south] while the board picks a window.' },
    'DEBRIS CONTROL: parentheses and square brackets are legitimate — only CURLY braces are JSON');
  clean({ col1: 'Board Now', col2: 'Wait Briefly',
    description: 'At a small cable ferry the ferryman picks a pull, while a passenger chooses Board Now or Wait Briefly.' },
    'DEBRIS CONTROL: "Wait Briefly" is a real OPTION LABEL — a bare \\bwait\\b flags 13 of 7,684 held draws and a hand-read kills all 13');
  clean({ description: 'Two kelp farms must each choose whether to harvest early or wait for the later harvest window.' },
    'DEBRIS CONTROL: "wait for the later window" is ordinary English');
  clean({}, 'DEBRIS CONTROL: an ordinary good draw must pass');

  // ── THE PROPERTY THE SCRIPT RULE'S SAFETY RESTS ON ──────────────────────
  // A non-Latin screen is only defensible because `validateScenario` never sees
  // text a USER wrote. If the game-save endpoints ever started calling it, this
  // rule would reject a user's own Chinese- or Hebrew-titled game — an
  // internationalisation regression, not a defect fix. Asserted against the
  // real server source rather than left as a comment, and asserted in BOTH
  // directions so it cannot pass by the validators disappearing altogether.
  {
    const server = readFileForContract(new URL('../server.ts', import.meta.url), 'utf-8');
    const firstGames = server.indexOf('"/api/games"');
    const lastGames = server.lastIndexOf('/api/games/:id');
    assert(firstGames > 0 && lastGames > firstGames,
      'DEBRIS CONTRACT: could not locate the /api/games handlers in server.ts — this check must not silently pass');
    const saveRegion = server.slice(firstGames, server.indexOf('\n  });', lastGames));
    for (const fn of ['validateScenario', 'scenarioIsClaimFree']) {
      assert(!saveRegion.includes(fn),
        `DEBRIS CONTRACT: ${fn} must never run on the game-save path — it would screen USER-authored text, and the non-Latin rule would reject a user's own Chinese- or Hebrew-titled game`);
    }
    // The other direction: the report path must still gate, or the assertion
    // above is satisfied by a server that validates nothing at all.
    const reportRegion = server.slice(0, firstGames);
    assert(reportRegion.includes('validateScenario(') && reportRegion.includes('scenarioIsClaimFree('),
      'DEBRIS CONTRACT: the report path must still call both scenario gates — otherwise the save-path assertion above is vacuous');
  }

  console.log('✓ model-internal debris: 3 rules, 5 of 4,088 user-reaching draws newly rejected across 67 corpora + the shipping bank, 0 false positives; each rule isolated by its own fixture');
}

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
  testInterestAlignment();
  testTwoChooserStructure();
  testRepeatedPlayRefused();
  testMetaVocabulary();
  testModelDebris();
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

  // ── L7 and L10: the two DECIDABLE label holes RED 1's newer oracle still
  //    showed reaching the user. Both were verified reaching it through the
  //    REAL gate before either was written (rule 4: never answer "is that
  //    covered?" from an instrument).
  assert(!gate(sc({ row1: 'Order-of-Magnitude Expansion', row2: 'Token Expansion', col1: 'Order-of-Magnitude Backing', col2: 'Token Backing' })),
    'L10: "orders of magnitude" HYPHENATED must be caught — the rule already existed and was defeated by punctuation, exactly like U+2212');
  assert(!gate(sc({ row1: 'Ten Thousand Crates', row2: 'One Crate', col1: 'Ten Thousand Slots', col2: 'One Slot' })),
    'L7: a numeral written as a WORD in a label is the same claim as a digit');
  assert(!gate(sc({ name: 'The Million-Unit Decision' })),
    'L7: and in the NAME, the field no screen read at all before this campaign');
  // The spaced spelling must STILL be caught, or the widening replaced the
  // rule rather than extending it.
  assert(!gate(sc({ description: 'The two yards differ by orders of magnitude in what this decision is worth.' })),
    'L10 REGRESSION: the original spaced spelling must still be caught');

  // ── COLLISION CONTROLS for L7. Every one of these is caught by the
  //    predicate RED 1 scored (their D4) and must NOT be caught by this one.
  //    None appears in the 3,296 draws on this box, so all three measure 0%
  //    today — they are excluded on the SHAPE of the word, because the rate is
  //    precisely what would have hidden them.
  assert(gate(sc({ row1: 'Manifold Assembly', row2: 'Valve Assembly' })),
    'L7 COLLISION: "Manifold" — red\'s D4 uses \\w+fold and would break this already-passing control');
  // THESE TWO WERE SITED IN THE DESCRIPTION, WHERE THIS RULE NEVER RUNS.
  // BIG_SPELLED_QUANTITY is scoped to the name and the option labels — see the
  // block comment on it — so "twice-weekly" and "dozens of crates" in a
  // DESCRIPTION passed no matter what the rule contained. Proved by the
  // mutation these controls exist to catch: adopting red's D4 vocabulary
  // (`dozens?|twice|thrice|\w+fold`) leaves both of them green, while the same
  // words in a LABEL are rejected. A control that cannot fail for the reason it
  // claims is the defect this suite keeps finding in other people's work, and
  // here it was in mine. Relocated to labels, where the collision is real; the
  // scope point they were doubling up on is asserted on its own below.
  assert(gate(sc({ row1: 'Twice-Weekly Run', row2: 'Weekly Run' })),
    'L7 COLLISION: "twice-weekly" is a SCHEDULE, not a magnitude — and red\'s D4 `twice` would reject this label');
  // NB the first draft of this control read "…each morning before either
  // operator decides", and the suite failed it — correctly. "before … decides"
  // is the move-order claim, caught by a rule that has nothing to do with
  // quantities. The fixture was wrong, not the gate; recorded because a
  // control that fails for an unrelated reason is the easiest way to talk
  // yourself into loosening the wrong rule.
  assert(gate(sc({ row1: 'Dozen-Crate Lot', row2: 'Single-Crate Lot' })),
    'L7 COLLISION: a dozen crates is ordinary scene-setting — and red\'s D4 `dozens?` would reject this label');
  // The description forms of the same two words, kept as the SCOPE half: legal
  // there today, and they must stay legal if the scope is ever widened by
  // accident.
  assert(gate(sc({ description: 'A depot runs a twice-weekly delivery to the yard, and the yard schedules its own crew.' })),
    'L7 SCOPE: "twice-weekly" in a DESCRIPTION is out of this rule\'s scope and stays legal');
  assert(gate(sc({ description: 'Dozens of crates move through the depot each morning, and the two operators each pick a loading window.' })),
    'L7 SCOPE: "dozens of crates" in a DESCRIPTION is out of this rule\'s scope and stays legal');
  assert(gate(sc({ row1: 'Batch One', row2: 'Batch Two' })),
    'L7 COLLISION (the one real FP in red\'s 527-row corpus): a spelled numeral used as an IDENTIFIER, not a magnitude');
  // SCOPE: name+labels only. A description may set a scene at scale; a label
  // asserting one is making a claim about a matrix it cannot see.
  assert(gate(sc({ description: 'The depot handles thousands of crates a week, and the two operators each pick a window.' })),
    'L7 SCOPE: a large quantity in the DESCRIPTION is scene-setting and stays legal — the description already carries the multiplier screen for the form that is a claim');

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

  console.log('✓ option-label channel: L1/L2/L4/L5 closed at 0 reach on 1,808 real draws (RED 1 independently: 0/274 fresh); L3/L6 left open as undecidable, boundary asserted');
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
    // WAS r2cloud#4, which contains "Player A"/"Player B" and is now rejected
    // by the META screen. It was quoted here to prove the NEGOTIATION rule is a
    // conjunction, and its meta vocabulary was incidental to that job — so the
    // control is re-based on another REAL draw that exercises the same boundary
    // (an offer with no acceptance, plus the word "contract") and carries no
    // meta. The original is not discarded: it is asserted below, by REASON, so
    // the fact it was quoted for is still tested.
    ['rt3_character_cloud#4, a bottler offering a price for a harvest contract',
      'An orchard cooperative is choosing whether to commit its fruit to an early harvest or a late harvest. A juice bottler is choosing between offering a premium price or buying at the spot price for that harvest contract.'],
    ['r2local#4, "accept" as one player\'s own simultaneous choice',
      'A fruit cooperative chooses whether to plant Early Harvest or Late Harvest. A retailer chooses whether to accept an Open Contract or a Fixed Contract.'],
    ['rt1#180, "contract" as an ordinary scenario noun',
      'An agricultural cooperative chooses between Early Planting and Late Planting for its wheat crop. A contract buyer chooses between Stable Contract and Flexible Contract for arranging the payment schedule.'],
  ];
  for (const [tag, d] of REAL) {
    assert(gate(d), `NEGOTIATION CONTROL (${tag}): real gate-passing output must not be newly rejected — this is why the rule is a conjunction, not a word list`);
  }
  // The re-based control's original, kept and tested BY REASON. r2cloud#4 is
  // now rejected — but for META vocabulary, not for negotiation. Asserting the
  // reason rather than the verdict keeps the original claim ("the negotiation
  // rule does not fire on an offer with no acceptance") under test, instead of
  // letting a draw quietly change which rule it is evidence about.
  const r2cloud4 = 'An orchard grower, Player A, chooses between an Early Harvest and a Late Harvest for the season. A fruit distributor, Player B, chooses between offering a Firm Contract and a Flexible Contract for purchasing the fruit.';
  const r2cloud4Why = scenarioIsClaimFree(sc(r2cloud4)).reason ?? '';
  assert(/cast names/.test(r2cloud4Why),
    `NEGOTIATION/META: r2cloud#4 must be rejected for its META vocabulary, got: ${r2cloud4Why || '(accepted)'}`);
  assert(!/offers and the other accepts|binding agreement/.test(r2cloud4Why),
    'NEGOTIATION: the negotiation rule must STILL not fire on an offer with no acceptance answering it — that is what this draw was quoted to prove');
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

/**
 * INTEREST ALIGNMENT — three more of RED 1's oracle holes, closed together
 * because they share one property: THE MATRIX SIDE IS EXACT.
 *
 *   constant-sum    a+b identical in all four cells — one side's gain is
 *                   precisely the other's loss, so a shared goal is impossible
 *   common interest a == b in every cell — the two never disagree, so there is
 *                   nothing to be rivals over
 *   flat            a player's payoff does not move with the opponent's column,
 *                   so that opponent cannot determine their outcome
 *
 * No tolerance, no equilibrium computation, nothing to tune. That is what makes
 * these shippable where a vocabulary rule would not be: the screens CANNOT fire
 * on an ordinary matrix however the sentence is worded, so the false-positive
 * risk is bounded by the matrix instead of by the word list. Measured reach on
 * 890 stored draws: 0 for all three (_gen/blue_w3_framing.mjs, which self-tests
 * that its detector can fire before reporting that zero).
 *
 * THE FOURTH HOLE IN THIS FAMILY IS DELIBERATELY LEFT OPEN. RED 1's "zero-sum +
 * cooperative framing" probe is "An antique store and a restoration company are
 * COORDINATING a new display" on a +100/-100 matrix. 103 of 890 real draws pair
 * some form of "coordinat*" with a constant-sum matrix (38 with the tight "are
 * coordinating" form), and they read as good output — parties who cooperate on
 * an activity while competing over its terms are ordinary, and nothing in the
 * corpus separates them from the probe. Gating it costs 4-12% of real output to
 * catch something undecidable. The controls below pin that boundary.
 */
function testInterestAlignment() {
  const MP: GamePayoffs = { a11: 100, a12: -100, a21: -100, a22: 100, b11: -100, b12: 100, b21: 100, b22: -100 };
  const COORD: GamePayoffs = { a11: 4, a12: 0, a21: 0, a22: 2, b11: 4, b12: 0, b21: 0, b22: 2 };
  const AFLAT: GamePayoffs = { a11: 5, a12: 5, a21: 5, a22: 5, b11: 0, b12: 3, b21: -3, b22: 1 };
  const PLAIN: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 1, b12: 4, b21: 2, b22: 6 };
  const sc = (d: string) => ({
    name: 'Test', row1: 'Early Slot', row2: 'Late Slot',
    col1: 'Shared Window', col2: 'Separate Window', storyClaims: null, description: d,
  } as any);
  const ok_ = (d: string, g: GamePayoffs) => validateScenario(sc(d), g).ok;

  // ── HOLES, verbatim from the oracle ──────────────────────────────────────
  assert(!ok_('A store and a restorer work together toward the same goal for the display. Each books its own slot for the season.', MP),
    'ALIGNMENT: a shared goal on a constant-sum matrix — one player gains exactly what the other loses in every cell');
  assert(!ok_('A textile company and a competing manufacturer fight for the same order. Each books its own dyeing slot for the run.', COORD),
    'ALIGNMENT: rivalry where the two players\' payoffs are IDENTICAL in every cell');
  assert(!ok_("A roastery picks its supplier for the season. The distribution partner's decision will determine the handling and pricing outcome for the roastery.", AFLAT),
    "ALIGNMENT: \"B determines A's outcome\" where A earns the same in all four cells");

  // ── THE MATRIX IS WHAT DECIDES. Same sentence, different matrix. ─────────
  // This pair is the whole argument: if the screens were word lists these would
  // both fail, and the second is ordinary good output.
  assert(ok_('A store and a restorer work together toward the same goal for the display. Each books its own slot for the season.', COORD),
    'ALIGNMENT CONTROL: the identical shared-goal sentence on a common-interest matrix is TRUE and must pass');
  assert(ok_('A textile company and a competing manufacturer fight for the same order. Each books its own dyeing slot for the run.', MP),
    'ALIGNMENT CONTROL: the identical rivalry sentence on a strictly opposed matrix is TRUE and must pass');
  assert(ok_("A mill books a slot. A haulier books a window, and that partner's decision will determine the pricing outcome for the mill.", PLAIN),
    "ALIGNMENT CONTROL: \"determines the outcome\" where the payoffs really do vary must pass");

  // ── The oracle's own controls, which a careless widening would break. ────
  // RE-EXPRESSED BY REASON. This control was written as "nothing rejects this",
  // which is a stronger claim than the fact it was recruited to protect. The
  // fact is that the sentence is not FALSE — "their choices determine the
  // resulting payoffs" is true on any matrix whose payoffs vary — and that is
  // asserted below, undiminished. It IS now rejected, by the META screen, for
  // naming the mathematical object in user-facing fiction. True and out of
  // register are independent, and a draw can be both.
  const vacuous = 'A mill books an Early Slot or a Late Slot for the run. A haulier books a Shared Window or a Separate Window. Their choices determine the resulting payoffs.';
  const vacuousWhy = scenarioIsClaimFree(sc(vacuous)).reason ?? '';
  assert(!/share a goal|frames the two players as rivals|determines the outcome|comparative|attached to a comparison|conditional outcome|moves first/.test(vacuousWhy),
    `ALIGNMENT CONTROL: no FALSEHOOD screen may fire on "their choices determine the payoffs" — it is the vacuous closer and it is true here. Got: ${vacuousWhy}`);
  assert(validateScenario(sc(vacuous), PLAIN).ok,
    'ALIGNMENT CONTROL: and the matrix-decided screens must still pass it');
  assert(/mathematical object/.test(vacuousWhy),
    `ALIGNMENT/META: it is rejected, but for REGISTER, not for falsehood. Got: ${vacuousWhy || '(accepted)'}`);
  assert(ok_('Two hauliers share one loading dock. One books an Early Slot or a Late Slot; the other books a Shared Window or a Separate Window.', MP),
    'ALIGNMENT CONTROL: sharing a RESOURCE is a scene fact, not a claim that interests are aligned');
  // THE BOUNDARY, asserted so a later widening fails here rather than in
  // production: "coordinating" on a constant-sum matrix stays legal, because
  // 103 of 890 real draws have exactly that pairing and are good output.
  assert(ok_('An antique store and a restoration company are coordinating a new display. The store books a slot while the restorer books a window.', MP),
    'ALIGNMENT BOUNDARY: "coordinating" on a constant-sum matrix must stay legal — 103 of 890 real draws pair the two, and gating it costs 4-12% of output to catch something undecidable');

  // Negation must not trip the rules, and the guard is WINDOWED — a negation
  // elsewhere in the paragraph must not switch a rule off.
  assert(ok_('The two firms do not work together toward the same goal; each books its own slot.', MP),
    'ALIGNMENT: a negated shared-goal claim must pass');
  assert(!ok_('The display is not yet booked. A store and a restorer work together toward the same goal for it.', MP),
    'ALIGNMENT: a negation in an EARLIER clause must not suppress the rule — the guard is windowed, not a whole-description scan');

  // ── THE FIRST-MATCH-ONLY UNDER-FIRE (CodeRabbit, verified by the coordinator)
  // The guard read `re.exec(desc)` and judged the FIRST occurrence alone, so one
  // negated early mention switched the whole rule off and a later genuine
  // assertion walked through. All three rules share the helper, so all three had
  // it — asserted here for each, because a fix verified on one arm is not
  // verified. One unnegated occurrence is an assertion; the rest cannot retract it.
  assert(!ok_('They do not work together on scheduling. Two hauliers pick a lane, and the firms work together toward the same goal.', MP),
    'ALIGNMENT (shared goal): a NEGATED FIRST mention must not suppress a later real claim');
  assert(!ok_('They do not compete for shelf space. Two firms pick a lane, and the yards compete for the same order.', COORD),
    'ALIGNMENT (rivalry): a NEGATED FIRST mention must not suppress a later real claim');
  assert(!ok_("A roastery picks a supplier. Weather does not determine the result. The partner's decision determines the outcome.", AFLAT),
    'ALIGNMENT (determines): a NEGATED FIRST mention must not suppress a later real claim');
  // And the other direction, or the fix has simply disabled the guard: a claim
  // negated at EVERY occurrence must still pass.
  assert(ok_('They do not work together toward the same goal. The two firms never work together toward the same goal either.', MP),
    'ALIGNMENT: when every occurrence is negated the rule must still stay silent — scanning all matches must not become "ignore negation"');
  assert(ok_('The firms do not compete for the same order. They never compete for shelf space.', COORD),
    'ALIGNMENT (rivalry): every occurrence negated must still pass');

  console.log('✓ interest alignment: shared-goal/rivalry/determines decided by the matrix, 0 reach on 1,808 draws AFTER the attributive-"rival" fix; the "coordinating on zero-sum" boundary pinned as legal');
}

/**
 * TWO DISTINCT CHOOSERS (RED 1 holes: one player holding both option pairs, the
 * second pair handed to a pronoun, both players making the same move).
 *
 * THIS IS THE FIRST BLOCK IN THIS FILE WITH REACH ON OBSERVED OUTPUT. Every
 * other screen blue has added is containment — a real channel, demonstrably
 * walkable, that the current models happen not to walk. These three catch what
 * the models ACTUALLY DID: five defects across 1,808 gate-passing draws from
 * every corpus this campaign holds, RED 1's newest 928 included, at zero false
 * positives (_gen/blue_w4_fullgate.mjs, which self-tests that its detector can
 * fire before reporting any zero).
 *
 * EVERY POSITIVE AND EVERY CONTROL BELOW IS A REAL DRAW, QUOTED. The controls
 * matter more than the positives here, because each one is a sentence the FIRST
 * DRAFT of these rules wrongly rejected. The word is never the discriminator —
 * the description's own cast is.
 */
function testTwoChooserStructure() {
  const ANTI: GamePayoffs = { a11: 0, a12: 3, a21: 2, a22: 0, b11: 0, b12: 2, b21: 3, b22: 0 };
  const COMMON: GamePayoffs = { a11: 4, a12: 0, a21: 0, a22: 2, b11: 4, b12: 0, b21: 0, b22: 2 };
  const sc = (d: string) => ({
    name: 'Test', row1: 'Early Slot', row2: 'Late Slot',
    col1: 'Shared Window', col2: 'Separate Window', storyClaims: null, description: d,
  } as any);
  const gate = (d: string, g: GamePayoffs = ANTI) => validateScenario(sc(d), g).ok
    && scenarioIsClaimFree(sc(d)).ok !== false
    && validateProseDirections(d, sc(d), g).length === 0;

  // ── ONE ACTOR TAKING A SECOND DECISION ───────────────────────────────────
  assert(!gate("A regional airport is planning a survey of a mountain range's glaciers and will either use an Early Survey or a Late Survey for that data set. The airport will also choose between sharing a route with the same survey team or taking a separate route for that same data set."),
    'W4 (rt1#71, in the wild): one actor holding BOTH option pairs — there is no second player');
  assert(!gate('Two neighboring vineyard managers must each choose between Early Watering and Late Watering for their vines. Each manager also chooses between Deep Irrigation and Surface Irrigation for the shared vineyard water system.'),
    'W4 (rt2 stakes pilot, in the wild): "each manager also chooses" gives one actor four options');
  // THE CONTROL THAT DEFINES THE RULE. Same word, opposite meaning: here "also"
  // is "likewise", and the subject is a NEWLY INTRODUCED second actor. The
  // first draft captured the auxiliary "is" as the subject and rejected this.
  assert(gate('A major film studio is choosing when to release its season-defining feature, with its budget and reputation tied to the campaign. A smaller independent distributor is also choosing between an open slot and a crowded slot for a film whose release matters less to its annual plans.'),
    'W4 CONTROL (rt2 gap ladder, a MEASURED false positive of the first draft): "also" meaning "likewise", with a new actor, must pass');

  // ── THE SECOND PAIR HANDED TO A PRONOUN ──────────────────────────────────
  assert(!gate("A dairy co-op is deciding between Premium Pricing and Cost-Plus Pricing for its seasonal milk product. It chooses either Local Sales or Online Sales for distribution, with each choice shaping the co-op's overall pricing and distribution plan."),
    'W4 (rt1#116, in the wild): "It chooses" hands the second pair back to the only player named');
  assert(!gate('A dairy co-op is deciding whether to set its pricing at Premium Pricing or Cost-Plus Pricing. It must choose between Open Market and Stable Market for its main distribution channels.'),
    'W4 (rt2 local#95, in the wild): the same shape with "It must choose"');
  // The pronoun is fine when a second actor exists. The first draft counted only
  // CHOOSING verbs, so an actor introduced with "is planning" was invisible.
  assert(gate("A regional airline is planning a series of flights through a rapidly changing glacier route. It chooses between Early Survey and Late Survey for the flights, while the glacier manager chooses between Early Survey and Late Survey for the region's seasonal monitoring plan."),
    'W4 CONTROL (rt3 slot control, a MEASURED false positive of the first draft): a pronoun for a properly introduced player, with a second actor present, must pass');
  // A PLURAL pronoun refers to both players and is the correct way to say they
  // move together — excluded structurally, not by a negation list.
  assert(gate('A mill chooses an Early Slot or a Late Slot. A haulier chooses a Shared Window or a Separate Window. They choose simultaneously, without seeing each other.'),
    'W4 CONTROL: "They choose simultaneously" is the correct statement and must pass');

  // ── A CLAIM THAT THE TWO MOVES COINCIDE ──────────────────────────────────
  assert(!gate('A farm cooperative and a harvest coordinator are coordinating a saffron harvest. The cooperative chooses Early Harvest or Late Harvest, while the coordinator chooses the same timing.'),
    'W4 (rt1#117, in the wild): "chooses the same timing" asserts B\'s move IS A\'s move');
  // Both controls are real draws the first draft rejected. The discriminator is
  // whether the shared noun is already IN THE SCENE.
  assert(gate('A textile mill and a nearby finishing mill each schedule its dyeing work for either an Early Shift or a Late Shift. The first mill chooses between Early Shift and Late Shift, while the second mill independently makes the same scheduling choice.'),
    'W4 CONTROL (rt3 character cloud, a MEASURED false positive): "the same scheduling choice" is the same KIND of decision, not the same move');
  assert(gate('A dairy co-op is deciding between Premium Pricing and Bulk Pricing for its seasonal product. The co-op chooses one, while the market buyer chooses the same product through the same season.'),
    'W4 CONTROL (rt stakes leak local, a MEASURED false positive): "the same product" shares a thing already named in the scene, not a move');

  // ── THE NEGOTIATION WIDENING (r2cloud#11), and its boundary ──────────────
  assert(!gate('A courier company chooses whether to submit a Premium Route or a Budget Route bid for a delivery contract. A logistics platform chooses whether to Accept Bid or Reject Bid.'),
    'W4 (rt2 cloud#11, in the wild): a bid submitted and then accepted or rejected is the offer/accept protocol in different words');
  assert(gate('Two courier firms are competing for the same delivery contract. Each firm chooses between a Priority Bid, which offers a faster route, and an Economy Bid, which offers a lower-cost route.'),
    'W4 CONTROL: bids and "offers" with NO acceptance answering them must pass — the rule stays a conjunction');

  // ── REGRESSION: the rivals false positive RED 1's new corpus exposed ─────
  // Shipped in W3 as a bare `rivals?`, which caught the word used ATTRIBUTIVELY
  // to name an actor. Two real draws were being rejected.
  // rt3_character_local#7 is now rejected by the META screen — it opens "A is a
  // fisherman… B is a rival fisherman", the bare-letter form. Its meta
  // vocabulary is incidental to what it was quoted to prove, so it is asserted
  // BY REASON: the rivalry screen must still not fire on the attributive use.
  // The verdict changed; the fact under test did not.
  const rival7 = "A is a fisherman choosing between Open Fish and Keep Fish for the day's catch. B is a rival fisherman choosing between Open Fish and Keep Fish for the same catch.";
  const rival7Why = scenarioIsClaimFree(sc(rival7)).reason ?? '';
  assert(/bare letter/.test(rival7Why),
    `W4/META: rt3 character local#7 must be rejected for the bare-letter form, got: ${rival7Why || '(accepted)'}`);
  assert(!/frames the two players as rivals/.test(rival7Why),
    'W4 REGRESSION (rt3 character local#7): "a RIVAL fisherman" names the actor — the rivalry screen must STILL not fire on it, even on a common-interest matrix');
  assert(gate('A city marathon coordinator chooses whether to schedule the race with an Early Closure or a Late Closure. A rival event coordinator chooses whether to use a Peak Route or a Quiet Route.', COMMON),
    'W4 REGRESSION (rt3 character local#29): the same attributive use must pass');
  // And the claim itself must still be caught, or the fix removed the rule.
  assert(!gate('A textile company and a competing manufacturer fight for the same order. Each books its own dyeing slot for the run.', COMMON),
    'W4 REGRESSION CONTROL: the actual rivalry CLAIM must still be caught on a common-interest matrix');

  // ── W7: THE SAME PAIR HELD BY BOTH PLAYERS, THE OTHER PAIR ABSENT ────────
  // The retrained local model produces the pronoun rule's defect with a
  // COLLECTIVE subject, which walked straight through it. Both positives are
  // real gate-accepted v2 draws, quoted with the labels they actually shipped.
  const lab = (o: Record<string, string>) => ({ name: 'Test', storyClaims: null, ...o } as any);
  const claimFreeWhy = (o: Record<string, string>) => scenarioIsClaimFree(lab(o)).reason ?? '';
  const HELD = /only option pair in the story is held by both players at once/;
  assert(HELD.test(claimFreeWhy({ row1: 'Roof Shed', row2: 'Garden Shed', col1: 'Drainage Line', col2: 'Open Corridor',
    description: 'Two neighboring beekeepers are choosing winter apiary sited near their homes. The beekeepers must choose either Roof Shed or Garden Shed for the apiary.' })),
    'W7 (v2, in the wild): the collective plural holds the only pair named — the second player has no options in the story');
  assert(HELD.test(claimFreeWhy({ row1: 'Limited Rotation', row2: 'Open Rotation', col1: 'Early Access', col2: 'Late Access',
    description: 'Two neighboring salt-marsh graziers are arranging their seasonal grazing rights on adjacent shared grazing rights. Each chooses between Limited Rotation and Open Rotation for its holding schedule.' })),
    'W7 (v2, in the wild): "Each chooses between…" with the other pair absent');
  // THE CONTROL THAT DEFINES THE RULE. Identical phrasing, SYMMETRIC labels —
  // the shape every real "each X chooses between Y and Z" draw in every corpus
  // turns out to have. It must pass, or the rule has become a ban on symmetric
  // games, which this repo deliberately allows.
  assert(!HELD.test(claimFreeWhy({ row1: 'Raise Quota', row2: 'Hold Quota', col1: 'Raise Quota', col2: 'Hold Quota',
    description: 'Two fishing cooperatives are negotiating next season\u2019s shared catch limit. Each cooperative chooses either Raise Quota or Hold Quota for its position at the bargaining table.' })),
    'W7 CONTROL: a genuinely SYMMETRIC game described collectively is complete prose and must pass');
  // The guard against the shape the first draft got wrong: one pair merely
  // PARAPHRASED while a second, specific chooser is named.
  assert(!HELD.test(claimFreeWhy({ row1: 'Early Slot', row2: 'Late Slot', col1: 'Open Window', col2: 'Hold Window',
    description: 'Two yards each choose between Early Slot and Late Slot, while the board decides whether to open or hold the window for the season.' })),
    'W7 CONTROL: a second SPECIFIC chooser means the story has two sides, however the second pair is worded');
  // And with no chooser at all in the prose, the collective half is what keeps
  // the rule off an ordinary description that just names one pair.
  assert(!HELD.test(claimFreeWhy({ row1: 'Early Watch', row2: 'Late Watch', col1: 'Confirm Rows', col2: 'Confirm Covers',
    description: 'The season\u2019s Early Watch and Late Watch are set by an orchard grower; a neighbouring cider cooperative handles cover placement for the same nights.' })),
    'W7 CONTROL: naming one pair is not itself the defect — somebody has to be choosing collectively');

  console.log('\u2713 two-chooser structure: 5 real defects caught across 1,808 draws at 0 false positives; every control is a draw an earlier draft wrongly rejected');
  console.log('\u2713 W7 collective pair: 6 v2 defects caught across 3,297 user-reaching draws at 0 false positives; symmetric games pass');
}

/**
 * REPEATED PLAY — PRICED AND REFUSED. This block ships NO new rule. It exists
 * so the refusal is a standing, executable boundary rather than a note in a log
 * that the next window has to rediscover.
 *
 * THE IDEA. The app models a ONE-SHOT simultaneous normal-form game. A scenario
 * asserting the game is played over and over is therefore making a false claim
 * about the object, and a serious one: under repetition the equilibrium set is
 * a different thing entirely (folk theorem), so "each season they choose again,
 * and a defector is punished next year" describes a game this app does not
 * solve and whose surface does not match the plot on screen.
 *
 * WHY IT WAS REFUSED. Measured over 48 corpus files, 3,185 unique draws, 3,134
 * of them gate-passing (_gen/blue_w5_repeatverdict.mjs), with the detector
 * self-tested against hand-built positives before any zero was reported:
 *
 *   1. THE FALSE CLAIM IS ABSENT, NOT CONTAINED. The folk-theorem machinery was
 *      counted TOKEN BY TOKEN so a zero could not hide inside an alternation:
 *      retaliat* 0, punish* 0, forgiv* 0, tit-for-tat 0, "repeated game" 0,
 *      iterat* 0, "future round/season/play" 0, "later rounds" 0, "over many X"
 *      0, "again" 0, "season after season" 0, "in the long run" 0, "build a
 *      reputation" 0, reputation-carried-across-plays 0. Zero on the 3,134
 *      accepted draws AND zero on the 51 the gate rejects — so no existing
 *      screen is quietly holding this back. The generator simply does not make
 *      this claim. Building a gate for it would be pure containment for a
 *      channel that, unlike the numeral channel, no one has shown is walkable.
 *
 *   2. THE ONLY CANDIDATE RULE WITH ANY REACH IS 100% FALSE POSITIVE. The
 *      structural form — a recurrence quantifier attached to a CHOOSING verb,
 *      which is the only form that is a claim about the GAME rather than about
 *      the world — fires on exactly 1 of 3,134 draws, and that one is wrong.
 *      It is the fourth instance of the scene-noun collision this campaign
 *      keeps hitting, and the sharpest yet: see the control below.
 *
 *   3. EVERY LOOSER VARIANT IS THE 32.2% MISTAKE AGAIN. A gate on cycle nouns
 *      (season/year/week/shift/day) would reject 943 of 3,134 draws = 30.09%.
 *      The narrow-looking ones are no better once read: "round" (4 draws) is a
 *      maintenance round, a purchasing round and a bird-ringing dawn round;
 *      "long run" (2 draws) is a letterpress PRINT run and is literally an
 *      OPTION LABEL ("Short Run / Long Run"); "reputation" (58 draws) is the
 *      stakes-fidelity feature working as designed — a consequence of the ONE
 *      decision, never a mechanism spanning plays.
 *
 * The controls below are all REAL, QUOTED, gate-passing draws. They pin the
 * boundary so a later window that decides to revisit this cannot ship a
 * cycle-noun word list without the suite going red.
 */
function testRepeatedPlayRefused() {
  const ANTI: GamePayoffs = { a11: 0, a12: 3, a21: 2, a22: 0, b11: 0, b12: 2, b21: 3, b22: 0 };
  const sc = (d: string, labels?: Partial<Record<'row1' | 'row2' | 'col1' | 'col2', string>>) => ({
    name: 'Test', row1: 'Early Slot', row2: 'Late Slot',
    col1: 'Shared Window', col2: 'Separate Window', storyClaims: null, description: d, ...labels,
  } as any);
  const gate = (d: string, labels?: Partial<Record<'row1' | 'row2' | 'col1' | 'col2', string>>) =>
    validateScenario(sc(d, labels), ANTI).ok
    && scenarioIsClaimFree(sc(d, labels)).ok !== false
    && validateProseDirections(d, sc(d, labels), ANTI).length === 0;

  // ── THE FALSE POSITIVE THAT DECIDED IT (rt3_stakes_cloud#10, verbatim) ───
  // "Each shift chooses" — "each" distributes over the two PLAYERS, and the
  // players ARE the shifts. The cycle noun is the actor noun. The collision is
  // doubled here, because "Shift" is also in both option labels. Any rule
  // keyed on `(each|every) + <cycle noun>` rejects this correct draw.
  assert(gate('Two textile dyeing shifts, A and B, are scheduling the timing of their routine dye-bath adjustments. Each shift chooses between Early Shift and Late Shift for its adjustment.',
    { row1: 'Early Shift', row2: 'Late Shift', col1: 'Early Shift', col2: 'Late Shift' }),
    'REPEATED PLAY (the measured false positive): "Each SHIFT chooses" distributes over the two PLAYERS — the cycle noun is the actor');

  // EVERY "EACH X CHOOSES BETWEEN Y AND Z" DRAW IN THIS BLOCK IS A SYMMETRIC
  // GAME, and four of them were being asserted against the wrong labels.
  //
  // The descriptions are quoted verbatim from real corpora, but the LABELS were
  // this function's defaults (Early Slot / Late Slot / Shared Window / Separate
  // Window), which none of these draws ever had. Looked up in the corpora they
  // came from, all four carry the SAME pair on both sides — Early Slot / Late
  // Slot, North Bid / South Bid, Premium Price / Discount Price, Raise Quota /
  // Hold Quota — which is what makes "each cooperative chooses either Raise
  // Quota or Hold Quota" complete prose rather than a story missing half its
  // options. Glued onto unrelated column labels the same sentence describes a
  // game whose second player has no options in the story at all, so the gate
  // SHOULD reject it, and the control was asserting the opposite about a
  // scenario that never existed. Real labels restored: the controls now pin
  // what they were recruited to pin, and each can fail for the reason it claims.
  // ── THE SCENE NOUNS, every one a real draw the loose rules would have hit ─
  const REAL: [string, string, Partial<Record<'row1' | 'row2' | 'col1' | 'col2', string>>?][] = [
    ['rt3_flat_cloud2#51, "Long Run" is a PRINT run — and an option label',
      'A small letterpress publisher is choosing between a Short Run and a Long Run for a new edition. Its paper supplier is choosing between Classic Type and Modern Type for the same edition.',
      { row1: 'Short Run', row2: 'Long Run' }],
    ['rt3_flat_cloud#39, "round" is a maintenance round',
      'The clocktower caretaker chooses between Inspect Gears and Check Bell for the scheduled maintenance round. The restoration contractor chooses between Replace Ropes and Tune Chimes for the same round.'],
    ['rt3_reroll_cloud#58, "Round" is a bird-ringing patrol — and an option label',
      'A bird-ringing station manager chooses between a Dawn Round and an Extended Round for the station’s work. A visiting bird research team chooses whether to request the Early Slot or the Late Slot.',
      { row1: 'Dawn Round', row2: 'Extended Round' }],
    ['rt_label_corpus#48, "recurring" describes the CONTRACT, not the game',
      'Two courier companies are competing for a recurring delivery contract. Each company chooses whether to submit a bid centered on the north route or the south route.',
      { row1: 'North Bid', row2: 'South Bid', col1: 'North Bid', col2: 'South Bid' }],
    ['rt3_character_cloud#27, "daily sailings" is the business, one decision about it',
      'Two ferry operators are assigning their daily sailings to timetable slots on the same route. Each operator chooses between the Early Slot and the Late Slot.',
      { row1: 'Early Slot', row2: 'Late Slot', col1: 'Early Slot', col2: 'Late Slot' }],
    ['rt_label_corpus#31, "routine weekly prices" — recurrent context, single choice',
      'Two neighboring dairy co-ops are setting routine weekly prices for comparable milk products. Each co-op chooses between Premium Price and Discount Price for the coming week.',
      { row1: 'Premium Price', row2: 'Discount Price', col1: 'Premium Price', col2: 'Discount Price' }],
    ['rt2_gapladder_g25#12, "reputation" is a STAKE on this one decision',
      'A large ski resort is setting its grooming plan for the season, with its reputation and operating budget heavily tied to reliable lift access. An independent grooming contractor, whose own business is less exposed, chooses between a Full Pass and a Selective Pass.'],
    ['rt3_stakes_cloud#7, "next season’s catch limit" is the SUBJECT of one choice',
      'Two fishing cooperatives are negotiating next season’s shared catch limit. Each cooperative chooses either Raise Quota or Hold Quota for its position at the bargaining table.',
      { row1: 'Raise Quota', row2: 'Hold Quota', col1: 'Raise Quota', col2: 'Hold Quota' }],
  ];
  for (const [tag, d, labels] of REAL) {
    assert(gate(d, labels), `REPEATED PLAY CONTROL (${tag}): a cycle noun is scene-setting — gating it would reject 30.09% of real output`);
  }

  // ── AND THE CLAIM ITSELF, so the refusal is honest about what still ships ─
  // These are NOT caught. They are recorded as reachable, exactly as the F1
  // vocabulary gap was, so nobody reads this block as "repeated play is
  // handled". If the retrained model starts producing them, this is the
  // fixture that is already written.
  const STILL_REACHES_THE_USER = [
    'Each season the co-op chooses between an Early Harvest and a Late Harvest, and the mill chooses again the following season.',
    'The two operators play this out over many rounds, and either can retaliate the next time the corridor is groomed.',
    'A yard that undercuts today builds a reputation that costs it in future rounds.',
  ];
  for (const d of STILL_REACHES_THE_USER) {
    assert(gate(d), `REPEATED PLAY, KNOWN OPEN: this genuinely false claim still reaches the user by design — 0 instances in 3,185 draws did not justify a rule whose only real-world hit was a false positive: ${d}`);
  }

  console.log('✓ repeated play: PRICED AND REFUSED — folk-theorem machinery 0/3,134 accepted and 0/51 rejected; candidate rule 1 hit, 1 false positive; 9 real draws pinned as controls; 3 true claims recorded as still reaching the user');
}

/**
 * META VOCABULARY — the prompt's own words and the mathematical object leaking
 * into user-facing fiction. A REGISTER defect, not a falsehood: "Player A
 * chooses between Early Harvest and Late Harvest" asserts nothing untrue, it
 * simply is not a story.
 *
 * THE LARGEST REMAINING CLASS WITH REAL REACH. Measured per surface over 3,363
 * gate-passing draws — and the two surfaces are NOT the same population, so the
 * earlier "equal on both, therefore inherited from the teacher" reading does
 * not hold once all sub-forms are counted:
 *
 *     union of the four shipped forms:  local 14.0%   cloud 7.0%
 *     "Player A" alone:                 local  6.1%   cloud 6.2%   <- the one that IS equal
 *     "the game" as an object:          local  0.6%   cloud 0.0%
 *
 * EVERY POSITIVE BELOW IS A REAL DRAW, QUOTED. Every control is either a
 * measured false positive of an earlier draft or a shape whose collision is
 * predicted by the domain rotation.
 */
function testMetaVocabulary() {
  const ANTI: GamePayoffs = { a11: 0, a12: 3, a21: 2, a22: 0, b11: 0, b12: 2, b21: 3, b22: 0 };
  const sc = (d: string, labels?: Partial<Record<'name' | 'row1' | 'row2' | 'col1' | 'col2', string>>) => ({
    name: 'Test', row1: 'Early Slot', row2: 'Late Slot',
    col1: 'Shared Window', col2: 'Separate Window', storyClaims: null, description: d, ...labels,
  } as any);
  const gate = (d: string, labels?: Partial<Record<'name' | 'row1' | 'row2' | 'col1' | 'col2', string>>) =>
    validateScenario(sc(d, labels), ANTI).ok
    && scenarioIsClaimFree(sc(d, labels)).ok !== false
    && validateProseDirections(d, sc(d, labels), ANTI).length === 0;
  const why = (d: string, labels?: Partial<Record<'name' | 'row1' | 'row2' | 'col1' | 'col2', string>>) =>
    scenarioIsClaimFree(sc(d, labels)).reason ?? '';

  // ── POSITIVES, all real draws ────────────────────────────────────────────
  assert(!gate('A dairy co-op, Player A, is deciding between Premium Pricing and Cost-Plus Pricing for its seasonal produce. Player B, the distributor, is choosing between Premium Pricing and Cost-Plus Pricing for its delivery network.'),
    'META (rt_label_corpus#16): "Player A"/"Player B" is the prompt\'s own cast, not a story');
  assert(!gate('A is a mushroom grower choosing between Early Harvest and Late Harvest for its crops. B is a distributor choosing between Open Market and Stabilize Supply for the same products.'),
    'META (rt_label_corpus#57): a bare letter standing in for a character');
  assert(!gate('The two players are choosing their distribution timing for the same brew.'),
    'META (rt_label_corpus#20): "the two players" names the game\'s cast, not the world\'s');
  assert(!gate('A city planning department and a construction firm are coordinating the repair of a stone wall. The game is between these two players and represents the negotiation of their repair plan.'),
    'META (rt2_local_prod200#73): the game named as an object');
  // The NAME and the LABELS are user-facing too — the name is a field no screen
  // read at all before this campaign.
  assert(!gate('A mill and a haulier each pick a window.', { name: 'Player A Scheduling' }),
    'META: the scenario NAME is screened too');
  assert(!gate('A mill and a haulier each pick a window.', { row1: 'Player A Slot' }),
    'META: option LABELS are screened too');

  // ── TRAP A: "the game" is a PRODUCT in this corpus ───────────────────────
  // Two guards, and the measurement shows each spares a case the other does
  // not. Both are asserted, so a later edit cannot quietly drop either.
  // NB the first draft of these two controls DID NOT TEST THEIR GUARDS. Both
  // sentences lacked game-theory vocabulary, so the theory requirement spared
  // them on its own and the mutation run passed with the hyphen boundary and
  // the product guard both deleted. They are rewritten to carry theory
  // vocabulary, so now only the guard under test can spare each one. A guard
  // whose control cannot fail when the guard is removed is not a tested guard —
  // this suite has caught that shape repeatedly, and here it caught mine.
  assert(gate('A concession vendor chooses between Joint Promotion and Solo Sales for the game-day menu, and both operators move simultaneously.'),
    'META TRAP A (from rt_label_corpus#9, a REAL cloud draw): "the GAME-DAY menu" — only the hyphen boundary spares this, because \\b sits happily before a hyphen');
  assert(gate('A small game studio chooses whether to give the game a Featured Slot or a Standard Slot, while a rival studio moves simultaneously on its own title.'),
    'META TRAP A: a video-game scenario — only the product-vocabulary test spares this one; the hyphen guard does not, because "the game" here is unhyphenated');
  assert(!gate('A mill books a slot and a haulier books a window. The two decisions form the game\'s normal-form setup.'),
    'META TRAP A: and the actual claim must still be caught — theory vocabulary, no product vocabulary');

  // ── TRAP B: the bare-letter form needs the negative lookbehind ───────────
  // This is CLOUD'S GOOD SHAPE. The naive predicate scores 20.0% on cloud
  // against 1.2% with the lookbehind; 229 draws separate those numbers and
  // every one inspected reads like these.
  assert(gate('Agency A chooses Prime Slot or Off-Prime Slot, while Operator B chooses Full Pricing or Reduced Pricing.'),
    'META TRAP B (rt3_flat_local#8): "Agency A chooses… while Operator B chooses" is ordinary English for two indistinguishable parties');
  assert(gate('Operator A chooses Early Shift or Late Shift, while Operator B chooses Open Lighthouse or Hold Lighthouse.'),
    'META TRAP B (rt3_flat_local2#111): a noun before the letter makes it a name, not a stand-in');
  assert(gate('Bakery A and Bakery B are competing shops placing weekly flour orders with the same mill. Each bakery chooses whether to submit its order early or wait until later in the ordering window.'),
    'META TRAP B (rt3_character_cloud#6): "Bakery A and Bakery B" must pass');
  assert(gate('Two hospitals share one air-ambulance pad. Hospital A chooses between Surge Staffing and Core Staffing; Hospital B chooses between a Central Pool and Local Teams.'),
    'META TRAP B: the same shape with a semicolon and two clauses');

  // ── COLLISION CONTROLS: "player" is a scene noun in some domains ─────────
  // The rotation contains "puppet theatre touring", where "the players" is the
  // acting company. Bare "the players" is therefore EXCLUDED on shape — it
  // measures 0.1% local / 0.0% cloud and the only draws it uniquely catches are
  // caught by another form anyway. W5's D4 refusal is the precedent.
  assert(gate('A touring puppet company chooses an Early Tour or a Late Tour, and the players rehearse whichever slot the hall offers.'),
    'META COLLISION: "the players" is the acting company — excluded on SHAPE, because the rotation contains puppet theatre touring');
  assert(gate('A glaciology team led by a senior surveyor chooses between Dawn Flight and Dusk Flight. A partner team chooses between a North Transect and a South Transect.'),
    'META COLLISION: "team"/"led by" near no meta token must pass — the word "player" is what matters, not the sporting register');

  // ── WHERE THE RULE LIVES, both ways. Same architectural test as the numeral
  //    screen: META is a rung-3 defect, because only at rung 3 does the solver
  //    state the mathematics and the description exist purely as a story.
  const meta = sc('Player A chooses an Early Slot. Player B chooses a Shared Window.');
  assert(validateScenario(meta, ANTI).ok,
    'PLACEMENT: validateScenario runs at EVERY rung and must not carry the rung-3 META rule');
  assert(scenarioIsClaimFree(meta).ok === false,
    'PLACEMENT: the rung-3 screen must reject it');

  // ── THE FIFTH SUB-FORM: "payoff", the mathematical object by name. ───────
  // This looked like a conflict with a control RED 1'S OWN ORACLE scores and it
  // is not one. THE TWO PROPOSITIONS ARE INDEPENDENT, and both are asserted
  // here, which is the whole point:
  //   the sentence is NOT FALSE      — true on any matrix whose payoffs vary
  //   the sentence is NOT IN REGISTER — it names the mathematical object
  // The control read as "nothing rejects this", which is stronger than the fact
  // it was recruited to protect. Expressed by REASON, both facts survive.
  const vacuousCloser = 'A mill books an Early Slot or a Late Slot for the run. A haulier books a Shared Window or a Separate Window. Their choices determine the resulting payoffs.';
  const vacuousWhy2 = scenarioIsClaimFree(sc(vacuousCloser)).reason ?? '';
  assert(/mathematical object/.test(vacuousWhy2),
    `META: the bare noun "payoffs" is screened for REGISTER: ${vacuousWhy2 || '(accepted)'}`);
  assert(!/comparative|attached to a comparison|conditional outcome|moves first|share a goal|rivals/.test(vacuousWhy2),
    'META/FALSEHOOD SEPARATION: no falsehood screen may fire on the vacuous closer — that proposition is red 1\'s and it still stands');
  assert(validateScenario(sc(vacuousCloser), ANTI).ok,
    'META/FALSEHOOD SEPARATION: and the matrix-decided screens must still pass it');
  // The falsehood rule for payoffs ATTACHED to a comparison must still fire on
  // its own ground, or merging the two questions has quietly lost one.
  assert(/attached to a comparison/.test(scenarioIsClaimFree(sc('A mill books a slot. The haulier\'s payoffs are higher than the mill\'s for every window.')).reason ?? ''),
    'META/FALSEHOOD SEPARATION: an attached payoff COMPARISON is still caught as a falsehood, not merely as register');

  console.log('✓ meta vocabulary: 5 sub-forms screened; both traps pinned — "the game-day menu" and the video-game studio pass, "Operator A chooses" passes at 20.0%-vs-1.2% cloud cost; "payoff" screened for REGISTER while the falsehood proposition about it still stands');
}

try {
  runUnitTests();
} catch (err: any) {
  console.error('Unit test suite failure:');
  console.error(err?.message || err);
  process.exit(1);
}

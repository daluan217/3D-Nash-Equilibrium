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
import { payoffTexRhs, fmtPayoffPair, indifferenceAt as indifferenceAtForDisplay } from './utils/gameEngine';
import { isCameraRelayout } from './components/PlotlyView';
import {
  isAgentRouterEndpoint,
  buildChatRequestBody,
  resolveProvider,
  hasCredentials,
  openrouterModelId,
  openrouterVariants,
  isRateLimit,
} from './utils/providers';
import { SCENARIO_DOMAINS, pickScenarioDomain } from './utils/scenarioDomains';
import { colorTermsFor, descriptionColorTerms, cleanUserColorTerms, cleanUserColorTermPair, USER_TERMS_MAX, USER_TERM_MAX_LEN, STRUCTURAL_A_TERMS, STRUCTURAL_B_TERMS } from './utils/colorTerms';
import { savedGameColorTerms, dialogBaseColorTerms, mergeDescriptionTerms, regenKeptColorTerms, regenPreviewColorTerms } from './utils/colorTerms';
import { keepFill } from './utils/scenarioRegen';
import { cleanScenarioActorNouns } from './utils/scenarioActorNouns';
import { readFileSync as readFileForContract, readdirSync as readDirForContract } from 'node:fs';
import ReactForRender from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ColorCoded } from './components/ColorCoded';
import {
  EA, EB, regretA, regretB, r3,
  parseNumericInput, commitPayoffInput, commitStartCoordinate, commitStepSize, commitStepIndex,
  normalizeProseMinus,
  computeMixedNE, computeAllNE, fmtProb, texProb,
  profileConcept, resolveProfile, indifferenceAt,
  equilibriumSet, kindOf, describeContinua,
  computeIndifference, generateRandomGame, fmtPayoff, fmtPayoffProse,
} from './utils/gameEngine';
import { buildGroundingPayload } from './utils/report';
import { describeGeometry, geometryBriefing } from './utils/geometry';
import { tieProse } from './utils/tieProse';
import { validateScenario, scenarioIsClaimFree, validateProseDirections, validateReport } from './utils/nashValidator';

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
// tieProse section 4 — the DERIVED payoff, which used to collapse onto zero
// ════════════════════════════════════════════════════════════════════════════
/**
 * The expected-payoff sentence was rendered by a local `num` helper —
 * `Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '')` —
 * rather than by `fmtPayoff`. On a matrix CELL that is harmless (every payoff
 * reaching this module is r3-clamped by `cleanPayoffs`, so toFixed(3) is
 * exact), but an expected payoff is a weighted AVERAGE of four cells and is
 * neither clamped nor bounded away from zero. Two live classes, both measured
 * against an exact BigInt oracle over 200,000 games per distribution:
 *
 *   "-0"        145 / 200,000 on int[-9,9] — `generateRandomGame`'s own
 *               alphabet, so the random-game button hit it about 1 in 1,300.
 *   FALSE "0"   up to 246 / 200,000 on 3-dp decimals: a genuinely nonzero
 *               payoff asserted to be zero, in the paragraph that exists
 *               because the model's arithmetic could not be trusted.
 *
 * Under `NASH_PAYOFF_TEMPLATE=1` this is the prose production returns for every
 * game, not only ties.
 */
function testTieProseDerivedPayoff() {
  // ---- KNOWN POSITIVES: the exact matrices that produced each defect --------
  // NOTE the `$`: a lazy `(.+?)\.` stops at the DECIMAL POINT, so "-4.2" reads
  // back as "-4" and "less than 0.001" as "less than 0". The first draft of this
  // helper did exactly that and made the renderer look broken when it was not.
  const sentence = (g: GamePayoffs) => {
    const m = tieProse(g).match(/the expected payoffs are E\[A\] = (.+?) and E\[B\] = (.+?)\.\s*$/);
    assert(!!m, `no expected-payoff sentence rendered for ${JSON.stringify(g)}`);
    return { a: m![1], b: m![2] };
  };
  assert(sentence({ a11: 6, a12: -4, a21: -1, a22: 8, b11: -9, b12: 6, b21: -1, b22: -8 }).b === '-3.545',
    'the extraction helper must return whole values, decimal point included');
  // 1. NEGATIVE ZERO. True E[A] is exactly 0; the float is -5.55e-17.
  const negZero: GamePayoffs = { a11: 0, a12: 0, a21: -2, a22: 5, b11: -9, b12: -6, b21: -1, b22: -3 };
  assert(EA(...(() => { const r = equilibriumSet(negZero)[0]; return [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, negZero] as const; })()) !== 0,
    'negative-zero fixture no longer carries float noise — it can no longer exercise the defect');
  assert(sentence(negZero).a === 'greater than -0.001',
    `negative-zero fixture: E[A] rendered "${sentence(negZero).a}"; the shipped defect printed "-0"`);
  // second instance, a different matrix with the same shape
  const negZero2: GamePayoffs = { a11: 0, a12: 0, a21: 2, a22: -1, b11: 3, b12: -9, b21: -8, b22: -2 };
  assert(sentence(negZero2).a === 'greater than -0.001' && sentence(negZero2).b === '-4.333',
    `negative-zero fixture 2: got E[A] = ${sentence(negZero2).a}, E[B] = ${sentence(negZero2).b}`);
  // A SIGNED-ZERO TOKEN, anywhere in the paragraph. `\b` is the wrong boundary
  // here — it fires INSIDE "-0.001", which is a legitimate rendering; the first
  // draft of this predicate failed on its own fixture for exactly that reason,
  // the same over-firing shape this campaign has hit five times.
  const SIGNED_ZERO = /-0(?![\d.])/;
  assert(SIGNED_ZERO.test('the expected payoffs are E[A] = -0 and E[B] = -4.2.'),
    'SIGNED_ZERO must catch the defect sentence it exists for');
  assert(!SIGNED_ZERO.test('E[A] = greater than -0.001'), 'SIGNED_ZERO must pass a legitimate -0.001');
  assert(!SIGNED_ZERO.test('E[A] = -0.5'), 'SIGNED_ZERO must pass an ordinary negative');
  for (const g of [negZero, negZero2])
    assert(!SIGNED_ZERO.test(tieProse(g)), 'a negative-zero fixture still renders a signed zero somewhere');
  // 2. FALSE ZERO. True E[B] is 529/2695000 = 0.000196…, printed as "0".
  const falseZero: GamePayoffs = { a11: 0.617, a12: -6.983, a21: 0.47, a22: -3.506, b11: 3.089, b12: 5.776, b21: -3.107, b22: -5.81 };
  assert(sentence(falseZero).b === 'less than 0.001',
    `false-zero fixture: E[B] rendered "${sentence(falseZero).b}"; the shipped defect printed "0", which is false`);
  // 3. FALSE ZERO, negative side. True E[B] is -2143/16001500 = -0.000133…
  const falseZeroNeg: GamePayoffs = { a11: -6.78, a12: 6.376, a21: -5.298, a22: -4.974, b11: 8.224, b12: -7.807, b21: -8.194, b22: 7.778 };
  assert(sentence(falseZeroNeg).b === 'greater than -0.001',
    `negative false-zero fixture: E[B] rendered "${sentence(falseZeroNeg).b}"`);

  // ---- NEGATIVE FIXTURES: the register must NOT change on ordinary games ----
  // `fmtPayoff` alone would have turned "E[A] = 3" into "E[A] = 3.000" on
  // 469,654 of 1,600,000 renderings. That is churn, not a fix, so the prose
  // form trims — and these pin the wording that must survive.
  for (const [name, g, wantA, wantB] of [
    ['PD', PD, '1', '1'],
    ['BoS', BOS, '1', '2'],
    ['matching pennies', MATCHING_PENNIES, '0', '0'],   // an EXACT zero still prints plainly
  ] as [string, GamePayoffs, string, string][]) {
    const s = sentence(g);
    assert(s.a === wantA && s.b === wantB,
      `${name}: expected E[A] = ${wantA}, E[B] = ${wantB}; got E[A] = ${s.a}, E[B] = ${s.b}`);
  }
  // and a plain non-integer payoff still prints as digits, not as a phrase
  assert(/^-?\d+(\.\d+)?$/.test(sentence({ a11: 6, a12: -4, a21: -1, a22: 8, b11: -9, b12: 6, b21: -1, b22: -8 }).a),
    'an ordinary mixed-NE payoff must still render as a number');

  console.log('✓ tieProse: the derived expected payoff never collapses onto zero');
}

/**
 * The trim in `fmtPayoffProse` is cosmetic and must stay cosmetic.
 *
 * EXHAUSTIVE, not sampled: the matrix clamps every cell to ±100 at 3 dp and an
 * expected payoff is a convex combination of four cells, so |E| ≤ 100 and the
 * only values `fmtPayoff` can hand over as digits are the 200,001 multiples of
 * 0.001 in [-100, 100]. Every one is checked to round-trip and to print "0"
 * only when it IS zero.
 */
function testFmtPayoffProseExhaustive() {
  let zeros = 0;
  for (let k = -100000; k <= 100000; k++) {
    const v = k / 1000;
    const s = fmtPayoffProse(v);
    if (/^-?0(\.0+)?$/.test(s)) {
      zeros++;
      assert(k === 0, `fmtPayoffProse(${v}) printed "${s}", claiming a payoff of ${v} is zero`);
    }
    assert(s !== '-0', `fmtPayoffProse(${v}) printed a negative zero`);
    assert(Math.abs(Number(s) - v) < 5e-7, `fmtPayoffProse(${v}) = "${s}" does not round-trip`);
  }
  assert(zeros === 1, `exactly one of the 200,001 3-dp values may print as zero; ${zeros} did`);
  // sub-resolution and noise values leave as PHRASES, with the right sign
  const phrases: [number, string][] = [
    [0, '0'],
    [-0, '0'],
    [5.551115123125783e-17, 'less than 0.001'],
    [-5.551115123125783e-17, 'greater than -0.001'],
    [0.000196289, 'less than 0.001'],
    [-0.000133925, 'greater than -0.001'],
    [0.0005, '0.001'],       // r3 rounds half up; still a number, not a phrase
    [-0.0005, 'greater than -0.001'],
  ];
  for (const [v, want] of phrases)
    assert(fmtPayoffProse(v) === want, `fmtPayoffProse(${v}): expected "${want}", got "${fmtPayoffProse(v)}"`);
  // MUTATION CONTROL — the legacy renderer this replaced must FAIL the checks
  // above, or they are decorative. (A guard whose deletion changes no result
  // has turned up four times in this campaign.)
  const legacy = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, ''));
  assert(legacy(-5.551115123125783e-17) === '-0', 'the legacy renderer must reproduce the "-0" defect');
  assert(legacy(0.000196289) === '0', 'the legacy renderer must reproduce the false-zero defect');
  assert(fmtPayoffProse(-5.551115123125783e-17) !== legacy(-5.551115123125783e-17)
    && fmtPayoffProse(0.000196289) !== legacy(0.000196289),
    'the prose renderer must differ from the legacy one on exactly the defect inputs');
  console.log('✓ fmtPayoffProse: 200,001 exhaustive values, "0" only for an exact zero');
}

// ════════════════════════════════════════════════════════════════════════════
// geometryBriefing — five sentences that were false about real games
// ════════════════════════════════════════════════════════════════════════════
/**
 * The briefing is handed to the model labelled "computed, authoritative", and it
 * sits inside `buildGroundingPayload`, which is the user prompt for BOTH
 * `generateReport` and `generateScenario` — so it is what the cloud model reads
 * every time it invents a scenario.
 *
 * Five classes, each measured over 100,000 games per corpus and each confirmed
 * to be the sentence the renderer actually emits (rates: "New random game"
 * draws / hand-typed int[-9,9] / int[-3,3]):
 *
 *   (a) "the level point would be at y = 0, outside [0,1]" — 0 is IN [0,1]; the
 *       root is on the EDGE of the board.               0.00% / 10.0% / 24.4%
 *       and the same sentence with "y = undefined" when there is no root at
 *       all, which asserts nothing false about a NUMBER (there is none) but
 *       hands the model a hole.                          2.05% /  3.4% /  9.6%
 *       Split after RED-MATH pointed out that pooling them overstated the
 *       falsehood on the random button, where the boundary case is 0%.
 *   (b) "A's payoff does not depend on what B does" on twist = 0, where the
 *       dependence on B is a21 - a22 and the twist is only the INTERACTION.
 *       E_A = -1 - 4y is a function of B's mix alone.   2.00% /  3.3% /  7.5%
 *   (c) "A's surface always tilts one way" where A is indifferent between the
 *       rows everywhere — the whole board is a shelf.      0% /  0.3% /  2.0%
 *   (d) "The equilibrium sits on an edge or corner" where the equilibrium set
 *       contains strictly interior points.                 0% /  0.2% /  1.5%
 *       NOW IMPOSSIBLE rather than rare: an equilibrium with both coordinates
 *       interior means both players are indifferent, which IS a joint flat
 *       spot. It could only appear because `hasInteriorFlatSpot` was blind to
 *       the degenerate shelf. Asserted below as an INVARIANT against the regret
 *       definition, which is stronger than a sentence check.
 *   (e) "NEITHER player has a dominant strategy: ... which option is better
 *       depends on what the opponent does" where a player has a WEAKLY
 *       dominant option.                                   0% / 10.3% / 26.5%
 *
 * The three zeroes are structural, not luck: `generateRandomGame` rejects every
 * within-player tie, and (c), (d) and (e) each require one.
 */
function testGeometryBriefingTruth() {
  // The SAME threshold the renderer branches on. A `=== 0` predicate called
  // three games clean whose float twist was 1.3e-15 and which took the
  // twist-zero branch — measuring against a different threshold than the code
  // uses is measuring a different program.
  const E = 1e-9;
  const twA = (g: GamePayoffs) => g.a11 - g.a12 - g.a21 + g.a22;
  const defA = (g: GamePayoffs) => {
    if (Math.abs(twA(g)) < E) return true;
    const y = (g.a22 - g.a12) / twA(g);
    return Math.abs(y) <= E || Math.abs(y - 1) <= E;
  };
  const defB = (g: GamePayoffs) => Math.abs(twA(g)) < E && Math.abs(g.a21 - g.a22) >= E;
  const defC = (g: GamePayoffs) => Math.abs(twA(g)) < E && Math.abs(g.a12 - g.a22) < E;
  // (d) is no longer a sentence class but an INVARIANT: no game may have an
  // equilibrium with both coordinates strictly interior while the flat-spot
  // predicate says there is none. Returns the offending point so a failure
  // names it.
  const interiorNEWithoutFlatSpot = (g: GamePayoffs): [number, number] | null => {
    if (describeGeometry(g).hasInteriorFlatSpot) return null;
    for (const rc of equilibriumSet(g)) {
      if (!(rc.x1 > 0 && rc.x0 < 1 && rc.y1 > 0 && rc.y0 < 1)) continue;
      const x = Math.min(Math.max((Math.max(rc.x0, 0) + Math.min(rc.x1, 1)) / 2, 1e-6), 1 - 1e-6);
      const y = Math.min(Math.max((Math.max(rc.y0, 0) + Math.min(rc.y1, 1)) / 2, 1e-6), 1 - 1e-6);
      if (x < rc.x0 - 1e-12 || x > rc.x1 + 1e-12 || y < rc.y0 - 1e-12 || y > rc.y1 + 1e-12) continue;
      // confirmed by the DEFINITION, not by the solver that produced the rect
      if (Math.abs(regretA(x, y, g)) < 1e-9 && Math.abs(regretB(x, y, g)) < 1e-9) return [x, y];
    }
    return null;
  };
  const defE = (g: GamePayoffs) => {
    const geo = describeGeometry(g);
    if (geo.dominantRowA || geo.dominantColB) return false;
    return ((g.a11 >= g.a21 && g.a12 >= g.a22) || (g.a21 >= g.a11 && g.a22 >= g.a12))
      || ((g.b11 >= g.b12 && g.b21 >= g.b22) || (g.b12 >= g.b11 && g.b22 >= g.b21));
  };
  const FALSE_SENTENCE: Record<string, string> = {
    a: 'outside [0,1]',
    b: "A's payoff does not depend on what B does",
    c: "A's surface always tilts one way",
    e: 'NEITHER player has a dominant strategy',
  };
  const preds: Record<string, (g: GamePayoffs) => boolean> = { a: defA, b: defB, c: defC, e: defE };

  // ---- KNOWN POSITIVES: the exact matrices, and the sentence each now gets --
  const FIX: [string, GamePayoffs, string[], string][] = [
    ['(a) root at y = 0', { a11: 3, a12: -6, a21: -9, a22: -6, b11: 8, b12: 9, b21: 0, b22: 3 },
      ['a'], 'goes level only at y = 0, which is the edge of the square (B playing Col 2 outright)'],
    ['(a) root at y = 1', { a11: 1, a12: 8, a21: 1, a22: 5, b11: 7, b12: -2, b21: -1, b22: -9 },
      ['a'], 'goes level only at y = 1, which is the edge of the square (B playing Col 1 outright)'],
    ['(b)+(c) A flat, payoff still moves with B', { a11: -5, a12: -1, a21: -5, a22: -1, b11: -6, b12: -6, b21: 0, b22: 6 },
      ['a', 'b', 'c', 'e'], "A's payoff does still move with B's choice (by -4 as B shifts from Col 2 to Col 1)"],
    ['(c) whole board is a shelf', { a11: 7, a12: -9, a21: 7, a22: -9, b11: 3, b12: 0, b21: 2, b22: -4 },
      ['a', 'b', 'c'], 'A is indifferent between the two rows EVERYWHERE on the board'],
    ['(d/f2) degenerate joint flat spot', { a11: -2, a12: 2, a21: 4, a22: -5, b11: 3, b12: 3, b21: 4, b22: 4 },
      ['e'], "B's surface is level at EVERY x, because B is indifferent between the columns whatever A does"],
    ['(e) weakly dominant row', { a11: -7, a12: -5, a21: -7, a22: 7, b11: -3, b12: -1, b21: -6, b22: -8 },
      ['a', 'e'], "A's Row 2 is never worse than Row 1 and is strictly better against at least one column"],
    // THE OTHER DEGENERATE BRANCH — twistA = 0 with a CONSTANT non-zero own-axis
    // slope, so A never goes level. Added on BLUE's evidence: with only the two
    // positive shapes above, `hasFlatShelfForA` is TRUE on both, so hard-wiring
    // it to `true` satisfied every fixture. It survived BLUE's fixture set for
    // exactly that reason. (My sweep catches the hard-wire on its own — verified
    // by mutation, all three hard-wires caught — but a fixture set that only
    // ever asserts one polarity is a trap whether or not a sweep is standing
    // behind it today.)
    ['(b) A flat, level NOWHERE', { a11: 5, a12: 4, a21: 1, a22: 0, b11: 2, b12: -3, b21: -1, b22: 4 },
      ['a', 'b'], 'A is always better off from Row 1, by 4, whatever B does'],
  ];
  for (const [name, g, classes, want] of FIX) {
    const t = geometryBriefing(g);
    for (const k of classes) {
      // the fixture must actually EXERCISE the class it is filed under
      assert(preds[k](g), `${name}: fixture no longer triggers class (${k}) — it cannot guard it`);
      assert(!t.includes(FALSE_SENTENCE[k]), `${name}: briefing still contains the class-(${k}) false sentence "${FALSE_SENTENCE[k]}"`);
    }
    assert(t.includes(want), `${name}: expected the briefing to say "${want}"\n${t}`);
  }
  // The (d)/f2 fixture, checked against the DEFINITION rather than the solver:
  // (0.5, 7/13) must be an equilibrium, and the widened predicate must now SEE
  // the flat spot that the model was previously failed for naming.
  const dGame = FIX[4][1];
  assert(Math.abs(regretA(0.5, 7 / 13, dGame)) < 1e-9 && Math.abs(regretB(0.5, 7 / 13, dGame)) < 1e-9,
    '(d) fixture: (0.5, 7/13) must be an equilibrium by the regret definition, or the finding is not a finding');
  assert(describeGeometry(dGame).hasInteriorFlatSpot,
    '(f2) hasInteriorFlatSpot must be TRUE here — a validator comparing against it rejected a true model claim');
  assert(describeGeometry(FIX[2][1]).hasFlatShelfForA,
    '(f1) hasFlatShelfForA must be TRUE on a board that is level along A\'s axis everywhere');
  assert(!describeGeometry(FIX[2][1]).yStarInRange,
    'yStarInRange must stay STRICT — the new field is additional, not a redefinition');
  // BOTH POLARITIES of the degenerate branch, so no constant can satisfy the set.
  const nowhere = FIX[6][1];
  assert(Math.abs(nowhere.a11 - nowhere.a12 - nowhere.a21 + nowhere.a22) < 1e-9,
    'the level-nowhere fixture must actually have a vanishing twist');
  assert(!describeGeometry(nowhere).hasFlatShelfForA,
    'hasFlatShelfForA must be FALSE when the twist vanishes and the own-axis slope does not');
  assert(!describeGeometry(nowhere).hasInteriorFlatSpot,
    'a game where A never goes level cannot have a joint flat spot');

  // ---- NEGATIVE FIXTURES: what must NOT change -----------------------------
  // The STRICT dominance predicates are the validator's contract and stay strict.
  assert(!describeGeometry(FIX[5][1]).dominantRowA,
    'dominantRowA must stay STRICT — a weakly dominant row must not start counting');
  assert(describeGeometry(PD).dominantRowA && describeGeometry(PD).dominantColB,
    'PD must still report strict dominance for both players');
  // The untouched branches must render verbatim: this fix is a repair of five
  // sentences, not a rewrite of the prompt. Measured against origin/main's own
  // renderer, the briefing is byte-identical on every game where none of the
  // five predicates fires (0 of 355,491 clean games across five corpora) and on
  // all six shipped presets.
  const PRESET_LINES: [string, GamePayoffs, string][] = [
    ['PD', PD, '  Dominant strategy present for A and B — one option beats the other whatever the opponent does.'],
    // PD, not BoS: BoS HAS an interior flat spot (x* = 2/3, y* = 1/3) and takes
    // the other branch. PD's roots are both at -1, so it is the preset that
    // exercises the sentence class (d) had to leave alone.
    ['PD', PD, '  There is NO interior joint flat spot. The equilibrium sits on an edge or corner of the square, where a player is pinned to one action rather than balanced between two.'],
    ['BoS', BOS, "  Both surfaces are level at the same interior point (x = 0.6667 (two-thirds), y = 0.3333 (a third)) — the joint flat spot, which is the mixed equilibrium."],
    ['matching pennies', MATCHING_PENNIES, "  A's surface goes LEVEL along A's axis when B plays y = 0.5 (a half) — that flat shelf is A's indifference."],
  ];
  for (const [name, g, line] of PRESET_LINES)
    assert(geometryBriefing(g).split('\n').includes(line), `${name}: the untouched branch must render verbatim — missing\n  ${line}`);

  // ---- REACHABILITY, asserted rather than assumed --------------------------
  // `generateScenario` passes `buildGroundingPayload(g)` as its USER PROMPT
  // (report.ts), and that payload embeds this briefing verbatim. So the briefing
  // is what the cloud model reads on every scenario invention — including under
  // NASH_PAYOFF_TEMPLATE=1, where the report prose is templated but the STORY is
  // still invented. Anyone re-classifying these five as unreachable has to
  // delete this assertion first.
  assert(buildGroundingPayload(FIX[0][1]).includes(geometryBriefing(FIX[0][1])),
    'the geometry briefing must still be inside the grounding payload the model is sent');

  // ---- SWEEP: no class may survive on any corpus ---------------------------
  const ri = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const corpora: [string, () => GamePayoffs][] = [
    // int[-1,1] is where these classes are DENSEST (80% of games trip at least
    // one), so a small sample there is a real test rather than a formality.
    ['int[-1,1]', () => { const c = () => ri(-1, 1); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; }],
    ['int[-9,9]', () => { const c = () => ri(-9, 9); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; }],
    ['random button', () => generateRandomGame(Math.random() < 0.5 ? 'pure' : 'mixed')],
  ];
  // GROUND TRUTH for "is this surface level along its own axis in the interior",
  // read off the REAL E_A / E_B by SIGN CHANGE. Not by |slope| < eps on a grid:
  // that instrument cannot see a transversal crossing between samples and
  // disagrees with the truth on 37-45% of games, which would put a 40% headline
  // on a 0.3% defect. (BLUE hit exactly that and said so; I reproduced it.)
  const H = 1e-6;
  const levelInterior = (f: (t: number) => number) => {
    let prev = f(1 / 201);
    if (Math.abs(prev) < 1e-7) return true;
    for (let i = 2; i <= 200; i++) {
      const v = f(i / 201);
      if (Math.abs(v) < 1e-7) return true;
      if ((prev < 0) !== (v < 0)) return true;
      prev = v;
    }
    return false;
  };
  const exercised: Record<string, number> = { a: 0, b: 0, c: 0, e: 0 };
  let degenerateShelves = 0;
  for (const [cname, gen] of corpora) {
    for (let i = 0; i < 4000; i++) {
      const g = gen();
      const t = geometryBriefing(g);
      for (const k of Object.keys(preds)) {
        if (!preds[k](g)) continue;
        exercised[k]++;
        assert(!t.includes(FALSE_SENTENCE[k]),
          `${cname}: class (${k}) false sentence survives on ${JSON.stringify(g)}\n${t}`);
      }
      // No sentence may hand the model a hole where a number belongs. This is
      // how the "y = undefined" defect reached production, and widening the
      // flat-spot predicate created a mirror of it at "x = undefined".
      assert(!/undefined|NaN/.test(t), `${cname}: briefing contains a hole on ${JSON.stringify(g)}\n${t}`);
      const geo = describeGeometry(g);
      // The two new predicates, against the surfaces themselves.
      const truthA = levelInterior((y) => (EA(0.5 + H, y, g) - EA(0.5 - H, y, g)) / (2 * H));
      const truthB = levelInterior((x) => (EB(x, 0.5 + H, g) - EB(x, 0.5 - H, g)) / (2 * H));
      assert(geo.hasFlatShelfForA === truthA,
        `${cname}: hasFlatShelfForA=${geo.hasFlatShelfForA} but A's surface is ${truthA ? '' : 'NOT '}level somewhere interior — ${JSON.stringify(g)}`);
      assert(geo.hasFlatShelfForB === truthB,
        `${cname}: hasFlatShelfForB=${geo.hasFlatShelfForB} but B's surface is ${truthB ? '' : 'NOT '}level somewhere interior — ${JSON.stringify(g)}`);
      if (geo.hasFlatShelfForA !== geo.yStarInRange || geo.hasFlatShelfForB !== geo.xStarInRange) degenerateShelves++;
      // THE INVARIANT that replaced class (d): both coordinates interior means
      // both players are mixing, which means both are indifferent, which IS a
      // joint flat spot. Checked with the regret oracle, not the solver.
      const pt = interiorNEWithoutFlatSpot(g);
      assert(pt === null,
        `${cname}: (${pt?.[0]}, ${pt?.[1]}) is an interior equilibrium by the regret definition, yet hasInteriorFlatSpot is false — ${JSON.stringify(g)}`);
    }
  }
  // The degenerate case must actually OCCUR in the sweep, or the two new
  // predicates are indistinguishable from the old ones and prove nothing.
  assert(degenerateShelves >= 20,
    `sweep met the degenerate shelf only ${degenerateShelves} times — the new predicates are untested against the old`);
  // NON-VACUITY: a sweep that never met the classes proves nothing. int[-1,1]
  // alone trips (a) in ~68% of games, so these floors sit far below the mean.
  for (const [k, floor] of [['a', 200], ['b', 20], ['c', 20], ['e', 200]] as [string, number][])
    assert(exercised[k] >= floor, `sweep met class (${k}) only ${exercised[k]} times — too few to be a test`);

  console.log(`✓ geometryBriefing: 5 false-sentence classes closed (sweep exercised a=${exercised.a} b=${exercised.b} c=${exercised.c} e=${exercised.e}), flat-shelf predicates match a sign-change scan of the real surfaces, presets byte-identical`);
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

function testIsAgentRouterEndpoint() {
  // AgentRouter gates on the User-Agent header, and the fabricated header is
  // meant to reach ONLY agentrouter.org — a substring match instead of a
  // hostname match would leak it to a lookalike host or a path fragment.
  const mustMatch: Array<[string, string]> = [
    ['https://agentrouter.org/v1', 'the bare host'],
    ['https://agentrouter.org', 'no path at all'],
    ['https://api.agentrouter.org/v1', 'a real subdomain'],
    ['http://agentrouter.org:8080/v1', 'a non-default port'],
    ['https://AgentRouter.ORG/v1', 'case-insensitive host'],
  ];
  for (const [endpoint, why] of mustMatch) {
    assert(isAgentRouterEndpoint(endpoint), `isAgentRouterEndpoint must return true for ${why}: ${endpoint}`);
  }

  const mustNotMatch: Array<[string | undefined, string]> = [
    ['https://agentrouter.org.evil.example/v1', 'a lookalike host with agentrouter.org as a prefix'],
    ['https://evil.example/proxy//agentrouter.org/v1', 'agentrouter.org appearing only in the path'],
    ['https://notagentrouter.org/v1', 'a different host that merely ends in the same suffix'],
    ['not a url', 'a malformed endpoint'],
    [undefined, 'no endpoint configured'],
    ['', 'an empty endpoint'],
  ];
  for (const [endpoint, why] of mustNotMatch) {
    assert(!isAgentRouterEndpoint(endpoint), `isAgentRouterEndpoint must return false for ${why}: ${endpoint}`);
  }

  console.log('✓ isAgentRouterEndpoint: exact-hostname match only — lookalike hosts and path fragments do not leak the fabricated User-Agent');
}

function testBuildChatRequestBody() {
  // extraBody is an escape hatch, but the canonical request fields are not
  // negotiable: a caller supplying `model`, `messages` or a variant field
  // (response_format, a token-limit key) in extraBody must not be able to
  // replace the production prompt, schema or token budget.
  const messages = [{ role: 'system', content: 'the real prompt' }];
  const variant = { response_format: { type: 'json_object' }, max_tokens: 700 };
  const body = buildChatRequestBody('real-model', messages, variant, {
    model: 'attacker-model',
    messages: [{ role: 'user', content: 'pwned' }],
    response_format: { type: 'text' },
    max_tokens: 999999,
    temperature: 0.9, // NOT canonical — an extraBody field with no collision must survive
  });
  assert(body.model === 'real-model', 'extraBody must not override model');
  assert(body.messages === messages, 'extraBody must not override messages');
  assert(JSON.stringify(body.response_format) === JSON.stringify(variant.response_format),
    'extraBody must not override the negotiated response_format');
  assert(body.max_tokens === 700, 'extraBody must not override the negotiated token limit');
  assert(body.temperature === 0.9, 'a non-colliding extraBody field must still reach the request');

  // No extraBody at all must behave exactly like the bare canonical shape.
  const bare = buildChatRequestBody('m', messages, variant, undefined);
  assert(bare.model === 'm' && bare.messages === messages && bare.max_tokens === 700,
    'buildChatRequestBody with no extraBody must still assemble the canonical shape');

  // THE OTHER token-limit ALIAS must not survive either: `variant` sets
  // exactly one of max_tokens / max_completion_tokens, and spreading extraBody
  // first only overwrites the SAME key — the other alias would otherwise ship
  // alongside variant's own choice, which some Foundry deployments reject.
  const variantMct = { response_format: { type: 'json_object' }, max_completion_tokens: 700 };
  const bodyBothAliases = buildChatRequestBody('m', messages, variantMct, { max_tokens: 999999 });
  assert(bodyBothAliases.max_completion_tokens === 700 && !('max_tokens' in bodyBothAliases),
    `only variant's own token-limit alias may reach the request, got ${JSON.stringify(bodyBothAliases)}`);
  const variantMt = { response_format: { type: 'json_object' }, max_tokens: 700 };
  const bodyBothAliases2 = buildChatRequestBody('m', messages, variantMt, { max_completion_tokens: 999999 });
  assert(bodyBothAliases2.max_tokens === 700 && !('max_completion_tokens' in bodyBothAliases2),
    `and the reverse alias pairing, got ${JSON.stringify(bodyBothAliases2)}`);

  console.log('✓ buildChatRequestBody: extraBody cannot replace model, messages, the negotiated variant, or add the OTHER token-limit alias');
}

function testOpenRouterResolveProvider() {
  // The `openrouter/` prefix is an explicit routing instruction and must win
  // regardless of what the REST of the id looks like — including ids that
  // would otherwise match the gemini-/claude- heuristics.
  const mustRouteOpenRouter = [
    'openrouter/deepseek-v4-flash',
    'openrouter/glm-5.3',
    'openrouter/deepseek/deepseek-chat',
    'openrouter/gemini-pretender',
    'openrouter/claude-pretender',
  ];
  for (const model of mustRouteOpenRouter) {
    assert(resolveProvider(model) === 'openrouter', `resolveProvider(${model}) must be 'openrouter'`);
  }

  // No behaviour change for any existing (non-prefixed) model.
  assert(resolveProvider('gemini-2.5-flash') === 'gemini', 'gemini- models must still route to gemini');
  assert(resolveProvider('claude-haiku-4-5') === 'foundry-anthropic', 'claude- models must still route to foundry-anthropic');
  assert(resolveProvider('gpt-5.4-mini') === 'foundry-openai', 'everything else must still default to foundry-openai');
  // A bare "openrouter" (no slash) is not the prefix form and must not match.
  assert(resolveProvider('openrouter') === 'foundry-openai', 'bare "openrouter" with no slash must not route to openrouter');
  assert(resolveProvider('openrouterish-model') === 'foundry-openai', 'a model name merely STARTING WITH the word must not match without the slash');

  // EVAL_PROVIDER_ override must accept 'openrouter' like the other three.
  process.env['EVAL_PROVIDER_some-model'] = 'openrouter';
  try {
    assert(resolveProvider('some-model') === 'openrouter', 'EVAL_PROVIDER_ override must accept openrouter');
  } finally {
    delete process.env['EVAL_PROVIDER_some-model'];
  }

  console.log('✓ resolveProvider: openrouter/ prefix routes to openrouter ahead of every other heuristic; no change to existing models');
}

function testOpenRouterCredentialGating() {
  const ENDPOINT = 'OPEN_ROUTER_ENDPOINT';
  const KEY = 'OPEN_ROUTER_API_KEY';
  const savedEndpoint = process.env[ENDPOINT];
  const savedKey = process.env[KEY];
  try {
    delete process.env[ENDPOINT];
    delete process.env[KEY];
    assert(!hasCredentials('openrouter/glm-5.3'), 'hasCredentials must be false with neither env var set');

    process.env[ENDPOINT] = 'https://example.invalid/v1';
    delete process.env[KEY];
    assert(!hasCredentials('openrouter/glm-5.3'), 'hasCredentials must be false with only the endpoint set');

    delete process.env[ENDPOINT];
    process.env[KEY] = 'sk-test';
    assert(!hasCredentials('openrouter/glm-5.3'), 'hasCredentials must be false with only the key set');

    process.env[ENDPOINT] = 'https://example.invalid/v1';
    process.env[KEY] = 'sk-test';
    assert(hasCredentials('openrouter/glm-5.3'), 'hasCredentials must be true with both env vars set');

    // Gating is per-provider: an openrouter/ model must not be satisfied by
    // Foundry credentials, and a Foundry model must not be satisfied by
    // OpenRouter credentials. foundryCreds checks the PER-MODEL variable
    // (`${MODEL}_AZURE_FOUNDRY_ENDPOINT`/`_API_KEY`) before the generic one,
    // so both must be cleared or a per-model var left over in the environment
    // would make this assertion fail for an unrelated reason.
    const MODEL = 'gpt-5.4-mini';
    const slug = MODEL.toUpperCase();
    const FOUNDRY_KEYS = [
      'AZURE_FOUNDRY_ENDPOINT', 'AZURE_FOUNDRY_API_KEY',
      `${slug}_AZURE_FOUNDRY_ENDPOINT`, `${slug}_AZURE_FOUNDRY_API_KEY`,
    ];
    const savedFoundry = FOUNDRY_KEYS.map((k) => process.env[k]);
    for (const k of FOUNDRY_KEYS) delete process.env[k];
    try {
      assert(!hasCredentials(MODEL), 'a foundry-openai model must not read OpenRouter credentials as its own');

      // The other direction: Foundry credentials must not satisfy an
      // openrouter/ model even though both adapters happen to be OpenAI-
      // compatible under the hood.
      delete process.env[ENDPOINT];
      delete process.env[KEY];
      process.env.AZURE_FOUNDRY_ENDPOINT = 'https://example.invalid/foundry';
      process.env.AZURE_FOUNDRY_API_KEY = 'foundry-key';
      assert(!hasCredentials('openrouter/glm-5.3'),
        'an openrouter/ model must not be satisfied by Foundry credentials');
    } finally {
      FOUNDRY_KEYS.forEach((k, idx) => {
        const v = savedFoundry[idx];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      });
    }
  } finally {
    if (savedEndpoint === undefined) delete process.env[ENDPOINT]; else process.env[ENDPOINT] = savedEndpoint;
    if (savedKey === undefined) delete process.env[KEY]; else process.env[KEY] = savedKey;
  }

  console.log('✓ hasCredentials(openrouter/...): true only when BOTH OPEN_ROUTER_ENDPOINT and OPEN_ROUTER_API_KEY are set, and gating stays per-provider');
}

function testIsRateLimit() {
  // Real transient infra failures must still be caught: numeric status
  // codes/`code` fields, and ordinary-English rate-limit phrasing regardless
  // of case, on the DEFAULT (non-Gemini) call path.
  const mustBeRateLimit: Array<[unknown, string]> = [
    [{ status: 429 }, 'HTTP 429'],
    [{ status: 503 }, 'HTTP 503'],
    [{ status: 500 }, 'HTTP 500'],
    [{ code: 429 }, 'a `code` field instead of `status`'],
    [{ message: 'Too Many Requests' }, 'the plain English phrase, mixed case'],
    [{ message: 'the service is overloaded, try again' }, 'overloaded'],
    [{ message: 'rate limit exceeded' }, 'rate limit with a space'],
    [{ message: 'ratelimit exceeded' }, 'rate limit with no space'],
    [{ message: '"code": 503' }, 'a JSON-embedded numeric code'],
  ];
  for (const [err, why] of mustBeRateLimit) {
    assert(isRateLimit(err), `isRateLimit must return true for ${why}: ${JSON.stringify(err)}`);
  }

  // STRUCTURAL FIX (2026-09-02, CodeRabbit on PR #92): the first fix matched
  // Gemini's tokens exactly instead of case-insensitively, which closed the
  // ONE observed message but left the real discriminator as casing rather
  // than the thing that actually separates an infra failure from a
  // content-shape rejection — the HTTP status. Now: whenever a numeric
  // status/code is present at all (true for every error this codebase's
  // adapters throw — Gemini's `ApiError.status` IS the HTTP status, the
  // OpenAI SDK always sets `.status`), it is the ONLY thing consulted. A 400
  // can never be a rate limit no matter what its message says — casing
  // included — so this closes CodeRabbit's own "KNOWN OPEN" follow-up
  // (`RESPONSE_FORMAT UNAVAILABLE`, uppercase, still a 400) along with the
  // original DeepSeek/OpenRouter regression, rather than tuning the regex a
  // second time to cover one more shape.
  const mustNotBeRateLimit: Array<[unknown, string]> = [
    [{ status: 400, message: 'This response_format type is unavailable now' }, 'the exact DeepSeek/OpenRouter regression'],
    [{ status: 400, message: 'this feature is currently unavailable' }, 'any other lowercase "unavailable" substring'],
    [{ status: 400, message: 'RESPONSE_FORMAT UNAVAILABLE for this model' }, 'CodeRabbit\'s follow-up: an UPPERCASE UNAVAILABLE in a 400 — casing is no longer the discriminator, status is'],
    [{ status: 400, message: 'content-blocked' }, 'a content-policy 400'],
    [{ status: 401 }, 'an auth failure'],
    [{ status: 404 }, 'a not-found'],
    [{ message: 'invalid request' }, 'a generic client error with no matching phrase'],
    [{}, 'no status or message at all'],
    [undefined, 'a non-object error'],
  ];
  for (const [err, why] of mustNotBeRateLimit) {
    assert(!isRateLimit(err), `isRateLimit must return false for ${why}: ${JSON.stringify(err)}`);
  }

  // The Gemini-token fallback exists only for error shapes with NO numeric
  // status/code, and only fires when the CALLER identifies the call as
  // Gemini's — never for an arbitrary provider's message that merely
  // contains the same English word. Both directions pinned:
  assert(isRateLimit({ message: 'RESOURCE_EXHAUSTED: quota exceeded' }, true),
    "on the Gemini path, RESOURCE_EXHAUSTED with no status must still count");
  assert(isRateLimit({ message: 'model is UNAVAILABLE right now' }, true),
    "on the Gemini path, UNAVAILABLE with no status must still count");
  assert(!isRateLimit({ message: 'RESOURCE_EXHAUSTED: quota exceeded' }, false),
    "off the Gemini path (the default), the same token must NOT count — it is not this call's SDK");
  assert(!isRateLimit({ message: 'model is UNAVAILABLE right now' }),
    "isGeminiCall defaults to false, so a bare call must not honour Gemini's tokens either");
  // And a numeric status still overrides the Gemini flag in either direction:
  // a genuine Gemini 400 must not become a rate limit just because the
  // caller happens to pass isGeminiCall: true.
  assert(!isRateLimit({ status: 400, message: 'UNAVAILABLE for this request' }, true),
    'a numeric non-{429,503,500} status wins even on the Gemini path');

  console.log('✓ isRateLimit: a numeric status/code is the ONLY signal consulted when present (400 never a rate limit, regardless of message casing); the Gemini SCREAMING_CASE token fallback fires only with no numeric status AND only on the Gemini call path');
}

function testOpenRouterModelId() {
  assert(openrouterModelId('openrouter/glm-5.3') === 'glm-5.3', 'the flat-catalog form must strip only the prefix');
  assert(openrouterModelId('openrouter/deepseek/deepseek-chat') === 'deepseek/deepseek-chat',
    'the vendor/model form must keep its internal slash — only the LEADING openrouter/ segment is stripped');
  assert(openrouterModelId('glm-5.3') === 'glm-5.3', 'a model with no prefix at all must pass through unchanged');
}

function testOpenRouterRequestVariants() {
  const schema = { type: 'json_schema', json_schema: { name: 'x' } };

  // No reasoning requested: two variants (strict schema, then json_object),
  // neither carrying a reasoning_effort field, and every variant must carry
  // max_tokens — the exact knob CLAUDE.md records glm-5.3/deepseek-v4-flash
  // need to avoid spending their whole budget thinking.
  const noReasoning = openrouterVariants(4096, undefined, schema);
  assert(noReasoning.length === 2, `no-reasoning must produce exactly 2 variants, got ${noReasoning.length}`);
  for (const v of noReasoning) {
    assert(v.max_tokens === 4096, `every variant must carry max_tokens, got ${JSON.stringify(v)}`);
    assert(!('reasoning_effort' in v), `no-reasoning variants must not carry reasoning_effort, got ${JSON.stringify(v)}`);
    assert(!('max_completion_tokens' in v), `OpenRouter variants must use max_tokens only, not the max_completion_tokens alias`);
  }
  assert(JSON.stringify(noReasoning[0].response_format) === JSON.stringify(schema),
    'the first no-reasoning variant must try the strict json_schema shape');
  assert((noReasoning[1].response_format as { type: string }).type === 'json_object',
    'the second no-reasoning variant must fall back to json_object');

  // Reasoning requested: the two reasoning_effort-carrying variants must come
  // FIRST (so a model that accepts the field never falls through to a
  // reasoning-free attempt it didn't need), followed by the same two
  // reasoning-free fallbacks for models that reject the field outright
  // (glm-5.3, per CLAUDE.md).
  const withReasoning = openrouterVariants(4096, 'low', schema);
  assert(withReasoning.length === 4, `reasoning must produce exactly 4 variants, got ${withReasoning.length}`);
  assert(withReasoning[0].reasoning_effort === 'low' && withReasoning[1].reasoning_effort === 'low',
    'the first two reasoning variants must carry reasoning_effort: low');
  assert(!('reasoning_effort' in withReasoning[2]) && !('reasoning_effort' in withReasoning[3]),
    'the fallback variants must NOT carry reasoning_effort, or a model rejecting it would fail every attempt');
  for (const v of withReasoning) {
    assert(v.max_tokens === 4096, `max_tokens must survive on every reasoning variant too, got ${JSON.stringify(v)}`);
  }

  // BOUNDARY (CodeRabbit on PR #92): 'none' is a MEMBER of ReasoningEffort
  // and is truthy, so a bare `reasoning ? ... : shapes` check would wrongly
  // take the reasoning branch and ship `reasoning_effort: 'none'` — not a
  // value OpenAI-compatible APIs recognise, so a model that rejects
  // unrecognised reasoning fields (glm-5.3) would fail its first two
  // attempts for nothing. Fixed to gate on `thinkingRequested`, the same
  // predicate callGemini/callFoundryAnthropic use, under which 'none' means
  // "explicitly disable" and therefore takes the SAME reasoning-free
  // variants as `undefined` — the real disable knob for a model that ignores
  // reasoning_effort is extraBody's `{ thinking: { type: 'disabled' } }`.
  const none = openrouterVariants(4096, 'none', schema);
  assert(none.length === 2, `'none' must take the same 2 reasoning-free variants as undefined, got ${none.length}`);
  for (const v of none) {
    assert(!('reasoning_effort' in v), `'none' must not carry reasoning_effort, got ${JSON.stringify(v)}`);
  }
  assert(JSON.stringify(none) === JSON.stringify(noReasoning),
    "'none' and undefined must produce byte-identical variants — both mean no reasoning_effort field");

  console.log('✓ openrouterVariants: max_tokens on every variant, reasoning_effort passthrough tried first then dropped as a fallback, never the max_completion_tokens alias, and \'none\' (a truthy ReasoningEffort member meaning explicit disable) takes the same path as undefined rather than shipping an unrecognised reasoning_effort: \'none\'');
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

  // Canonically-equivalent Unicode must not smuggle a shared term through
  // either: NFC (\u00e9 as one precomposed code point) vs NFD (e followed
  // by a combining acute, \u0065\u0301) render identically but compare
  // unequal without normalizing. Built from \u escapes, not a literal
  // combining character, so the fixture cannot be silently re-normalized by
  // an editor or a copy/paste.
  // Typed `string`, not inferred as a literal: TS statically knows two DIFFERENT
  // string literal types can never be equal and flags `!==` between them as
  // "always true" (TS2367) \u2014 a real fact about the literal types, not about
  // whether the fixture is testing the right thing at runtime.
  const nfc: string = 'R\u00e9serve';
  const nfd: string = 'Re\u0301serve';
  assert(nfc !== nfd, 'the fixture must actually be two different code point sequences');
  assert(nfc.normalize('NFC') === nfd.normalize('NFC'),
    'the fixture must actually be canonically equivalent (same rendering)');
  const unicodeShared = colorTermsFor({ row1: nfc, row2: 'Hold', col1: nfd, col2: 'Ignore' });
  assert(!unicodeShared.a.includes(nfc) && !unicodeShared.b.includes(nfd),
    `NFC/NFD forms of the same rendered text must be recognised as shared and dropped, got ${JSON.stringify(unicodeShared)}`);
  assert(unicodeShared.a.includes('Hold') && unicodeShared.b.includes('Ignore'),
    'unambiguous options on the same call keep their colour');

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
  const cleanScenarioSource = serverSrc.slice(
    serverSrc.indexOf('function cleanScenario('),
    serverSrc.indexOf('function cleanPayoffs('),
  );
  assert(/options: \{ actorNouns\?: boolean \} = \{\}/.test(cleanScenarioSource),
    'cleanScenario must default actor noun retention off for all callers');
  assert(/if \(options\.actorNouns\) Object\.assign\(sc, cleanScenarioActorNouns\(value, sc\)\);/.test(cleanScenarioSource),
    'actor noun retention must be an explicit cleanScenario opt-in');
  // CodeRabbit, PR #111: the base-scenario non-empty check must run BEFORE
  // actor metadata is merged in, or an ungated draw (NASH_SCENARIO_CHECKS=0)
  // carrying only actorA/actorB could make an otherwise-empty scenario read
  // as non-empty. `actorNounsOk` (scenarioBank.ts) independently requires
  // every accepted noun to appear verbatim in a non-empty description, so
  // this exact order is not reachable through the real predicate today — but
  // the ordering is the correctness boundary regardless of what the
  // predicate currently enforces, so it is asserted at the source directly.
  const ASSIGN_LINE = 'if (options.actorNouns) Object.assign(sc, cleanScenarioActorNouns(value, sc));';
  const emptyCheckIndex = cleanScenarioSource.indexOf('Object.values(sc).some(Boolean)');
  const assignIndex = cleanScenarioSource.indexOf(ASSIGN_LINE);
  assert(emptyCheckIndex !== -1 && assignIndex !== -1 && emptyCheckIndex < assignIndex,
    'cleanScenario must reject an empty base scenario BEFORE actor metadata can be merged in, not after');
  // CodeRabbit follow-up on PR #111: checking only that the ONE emptiness
  // check is early and the function ends with `return sc;` would still pass
  // if a SECOND `.some(Boolean)` check were added after the actor-noun
  // merge (the function could still end with `return sc;` further down).
  // The real invariant is that the check occurs EXACTLY ONCE, before the
  // merge — so assert nothing shaped like an emptiness check exists in the
  // remainder of the function after the merge line at all.
  const afterAssign = cleanScenarioSource.slice(assignIndex + ASSIGN_LINE.length);
  assert(!/\.some\(Boolean\)/.test(afterAssign),
    'cleanScenario must not repeat an emptiness check after the actor-noun merge — the ONE check before the merge must be the only one, not merely the first of several');
  const reportRouteSource = serverSrc.slice(
    serverSrc.indexOf('app.post("/api/report"'),
    serverSrc.indexOf('app.post("/api/scenario/regenerate"'),
  );
  assert(/const scenario = cleanScenario\(req\.body\?\.scenario\);/.test(reportRouteSource),
    '/api/report must use cleanScenario without actor noun retention');
  assert(!/actorNouns:\s*true/.test(reportRouteSource),
    '/api/report must never carry client actor nouns into its prompt scenario');
  const regenRouteSource = serverSrc.slice(serverSrc.indexOf('app.post("/api/scenario/regenerate"'));
  assert(/const cleanedScenario = cleanScenario\(scenario, \{ actorNouns: true \}\);/.test(regenRouteSource),
    'only the regenerate response boundary must opt in to actor noun retention');

  // Actor nouns are the one deliberate extension to this boundary. The pure
  // sanitizer owns their cap/dedup/collision policy and delegates the final
  // verbatim/disjoint decision to scenarioBank.actorNounsOk; user colour chips
  // remain outside cleanScenario and can never reach a model prompt.
  const actorContext = {
    description: 'The harbor operator coordinates with the tug company at the berth.',
    row1: 'Load now', row2: 'Load later', col1: 'Send tug', col2: 'Hold tug',
  };
  const cleanActors = cleanScenarioActorNouns({
    actorA: ['the harbor operator', 'the harbor operator', 'Load now'],
    actorB: ['the tug company'],
  }, actorContext);
  assert(JSON.stringify(cleanActors) === JSON.stringify({ actorA: ['the harbor operator'], actorB: ['the tug company'] }),
    `server actor sanitizer must dedup and remove label/cross-owner nouns, got ${JSON.stringify(cleanActors)}`);
  const crossOwned = cleanScenarioActorNouns({ actorA: ['the harbor operator'], actorB: ['the harbor operator'] }, actorContext);
  assert(!('actorA' in crossOwned) && !('actorB' in crossOwned),
    'server actor sanitizer must drop a noun claimed by both players');
  const overlongActor = `the ${'harbor '.repeat(12)}operator`;
  const clampedActors = cleanScenarioActorNouns({ actorA: [overlongActor], actorB: ['the tug company'] }, {
    ...actorContext,
    description: `${overlongActor} coordinates with the tug company at the berth.`,
  });
  assert((clampedActors.actorA?.[0].length ?? 0) <= 60,
    'server actor sanitizer must cap each noun at 60 grapheme-safe UTF-16 units');
  // 53 UTF-16 units plus this seven-unit emoji fills the budget exactly; the
  // trailing z must be dropped as a whole following grapheme, never by cutting
  // the emoji's surrogate/ZWJ sequence. The retained declaration must still
  // be a verbatim span of the source description after the boundary clamp.
  const graphemeActor = `${'a'.repeat(53)}👩🏽‍💻z`;
  const graphemeActors = cleanScenarioActorNouns({ actorA: [graphemeActor], actorB: ['the tug company'] }, {
    ...actorContext,
    description: `${graphemeActor} coordinates with the tug company at the berth.`,
  });
  const graphemeTerm = graphemeActors.actorA?.[0] ?? '';
  assert(graphemeTerm.length <= 60 && graphemeTerm.endsWith('👩🏽‍💻') && !graphemeTerm.endsWith('z'),
    `server actor sanitizer must preserve a complete boundary emoji, got ${JSON.stringify(graphemeTerm)}`);
  assert(`${graphemeActor} coordinates with the tug company at the berth.`.includes(graphemeTerm),
    'the grapheme-safe clamped actor noun must remain verbatim in its description');
  assert(!('actorA' in cleanScenarioActorNouns({ actorA: ['the warehouse manager'], actorB: ['the tug company'] }, actorContext)),
    'a non-verbatim actor noun must drop the whole actor declaration rather than ship a coloured fabrication');
  const actorScenario = {
    name: 'Harbor handover', ...actorContext,
    actorA: ['the harbor operator'], actorB: ['the tug company'], storyClaims: null,
  };
  assert(validateScenario(actorScenario, MATCHING_PENNIES, { actorNouns: true }).ok,
    'the regenerate-only actor gate accepts verbatim, disjoint declarations');
  const nonVerbatimActor = { ...actorScenario, actorA: ['the warehouse manager'] };
  assert(!validateScenario(nonVerbatimActor, MATCHING_PENNIES, { actorNouns: true }).ok,
    'the regenerate-only actor gate rejects a non-verbatim declaration');
  assert(validateScenario(nonVerbatimActor, MATCHING_PENNIES).ok,
    'the full-report path remains unchanged when it does not opt into actor declarations');

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


// ════════════════════════════════════════════════════════════════════════════
// COLOUR TERMS: ONE SOURCE, AND A GUARD THAT FAILS WHEN A SECOND ONE APPEARS
//
// `colorTerms.ts` says in its own docstring that it exists so "the amount of
// highlighting cannot depend on which surface you happen to be looking at".
// It shipped anyway with three surfaces colouring a saved description and only
// one of them asking the module: the workspace drawer assembled its own pair
// inline, and both description dialogs previewed against the terms of whichever
// game was selected in the MAIN PANEL rather than their own.
//
// Every defect below was a term list built somewhere other than colorTerms.ts,
// so the tests come in two halves: behaviour (the single source does the right
// thing for each surface) and a SOURCE-LEVEL guard (no second list exists).
// The behavioural half alone cannot catch the regression — a new hand-rolled
// list in a component passes every assertion written against the module.
// ════════════════════════════════════════════════════════════════════════════

/** Every .ts/.tsx under src/, minus the module under test and the tests. */
function colorTermSourceFiles(): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = [];
  const walk = (dir: string) => {
    for (const e of readDirForContract(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      if (/\.test\.tsx?$/.test(e.name) || e.name === 'test.ts') continue;
      if (p.endsWith('src/utils/colorTerms.ts')) continue;   // the one source
      out.push({ path: p, src: readFileForContract(p, 'utf8') });
    }
  };
  walk('src');
  return out;
}

function testColorTermSingleSource() {
  const files = colorTermSourceFiles();
  assert(files.length > 10, `source scan found only ${files.length} files — the walk is broken`);

  // ── (1) nobody assembles an option-name list by hand ──
  // The exact shape that shipped in MenuDrawer:
  //   aTerms: [g.row1Label, g.row2Label].filter(Boolean)
  // A list built this way silently skips everything colorTerms.ts does for a
  // living: the structural Row/Col terms, `dropAmbiguous`, and the user's own
  // `colorTermsA`/`colorTermsB`.
  const HAND_ROLLED = [
    { re: /\[[^\]\n]*\brow1Label\b[^\]\n]*\brow2Label\b[^\]\n]*\]/, what: 'a [row1Label, row2Label] array' },
    { re: /\[[^\]\n]*\bcol1Label\b[^\]\n]*\bcol2Label\b[^\]\n]*\]/, what: 'a [col1Label, col2Label] array' },
    // Case-SENSITIVE, both entries required, single space enforced. The first
    // draft of these two was /i with only the first entry, and it fired on the
    // Option Names form, whose field keys are the strings 'row1' and 'col1' —
    // a list of input names, not a term list. Kept as written so the negative
    // is permanent: the form is still in App.tsx and would light this up again.
    { re: /\[\s*(['"])Row [12]\1\s*,\s*(['"])Row [12]\2/, what: "a ['Row 1', 'Row 2'] literal" },
    { re: /\[\s*(['"])Col(?:umn)? [12]\1\s*,\s*(['"])Col(?:umn)? [12]\2/, what: "a ['Col 1', 'Col 2'] literal" },
  ];
  for (const f of files) {
    for (const { re, what } of HAND_ROLLED) {
      assert(!re.test(f.src),
        `${f.path} builds ${what} of its own. Colour terms have ONE source: import from `
        + 'src/utils/colorTerms.ts (savedGameColorTerms for a saved game\'s record, '
        + 'dialogBaseColorTerms for a dialog\'s own labels) instead of assembling a list here. '
        + 'A second list drifts from the first — that is the whole defect class.');
    }
  }

  // ── (2) anything that FEEDS ColorCoded terms must get them from the module ──
  // Catches a hand-rolled list in a shape rule (1) did not anticipate.
  for (const f of files) {
    if (!/\baTerms=|\bbTerms=/.test(f.src)) continue;
    assert(/from ['"][^'"]*utils\/colorTerms['"]/.test(f.src),
      `${f.path} passes aTerms/bTerms to ColorCoded but imports nothing from utils/colorTerms — `
      + 'so whatever it passes was assembled locally.');
  }

  // ── (3) the dialog previews read their OWN labels, never the selection ──
  // Defect 3, both directions. `colorTerms` is the selected game's pair; a
  // preview fed from it promises highlights the save will not deliver (pencil
  // path) or hides ones it will (save-with-new-labels path).
  const app = readFileForContract('src/App.tsx', 'utf8');
  const bases = [...app.matchAll(/\bbase([AB])=\{([^}]*)\}/g)];
  assert(bases.length >= 4, `expected both DescriptionEditor call sites to set baseA/baseB, found ${bases.length}`);
  for (const m of bases) {
    assert(!/\bcolorTerms\b/.test(m[2]),
      `App.tsx passes base${m[1]}={${m[2]}} to a description preview. That is the SELECTED game's `
      + 'pair, which is neither the game the dialog edits nor the option names being typed into it. '
      + 'Derive it from the dialog\'s own labels (dialogBaseColorTerms) so the preview keeps the '
      + 'promise its own comment makes: "what this preview shows is what the game will show".');
  }

  console.log('✓ colour terms single source: no surface assembles its own term list, and both '
    + 'description previews read the dialog\'s own labels');
}

function testSavedGameColorTermsBehaviour() {
  // The three surfaces that colour a saved description must agree. `panel` is
  // written the long way ON PURPOSE — spelling out what App.tsx passes for a
  // custom game (no actor nouns: `mergedPresets` merges saved games in without
  // them) so this is a real comparison and not `f(x) === f(x)`.
  const panelPair = (g: any) => descriptionColorTerms(
    { row1: g.row1Label, row2: g.row2Label, col1: g.col1Label, col2: g.col2Label },
    [], [], g.colorTermsA ?? [], g.colorTermsB ?? []);

  // Fixture 1 — the user's own highlights. The drawer dropped these entirely,
  // which made the whole hand-highlighting feature invisible one click from
  // where it worked.
  const withUserTerms = {
    row1Label: 'Advertise', row2Label: 'Hold back', col1Label: 'Match', col2Label: 'Ignore',
    colorTermsA: ['the haulier'], colorTermsB: ['the council', 'the tender'],
  };
  const drawn = savedGameColorTerms(withUserTerms);
  assert(drawn.a.includes('the haulier') && drawn.b.includes('the council') && drawn.b.includes('the tender'),
    `a saved game's own highlights must colour on every surface — got A=${drawn.a} B=${drawn.b}`);
  assert(drawn.a.includes('Advertise') && drawn.b.includes('Ignore'), 'option names still colour');
  for (const t of STRUCTURAL_A_TERMS) assert(drawn.a.includes(t), `structural "${t}" must be present`);
  for (const t of STRUCTURAL_B_TERMS) assert(drawn.b.includes(t), `structural "${t}" must be present`);
  assert(JSON.stringify(drawn) === JSON.stringify(panelPair(withUserTerms)),
    'the drawer card and the main-panel card render the SAME sentence and must use the same terms');

  // Fixture 2 — a symmetric game. Both players own "Cooperate", so neither
  // colour is true and the drawer used to paint it as A's. The bank ships
  // 489/2505 scenarios (19.5%) with a shared option name, and the built-in
  // Prisoner's Dilemma has the same shape, so this is the common case.
  const symmetric = {
    row1Label: 'Cooperate', row2Label: 'Defect', col1Label: 'Cooperate', col2Label: 'Defect',
    colorTermsA: [], colorTermsB: [],
  };
  const sym = savedGameColorTerms(symmetric);
  assert(!sym.a.includes('Cooperate') && !sym.b.includes('Cooperate'),
    `a phrase BOTH players can play belongs to neither colour — got A=${sym.a} B=${sym.b}`);
  assert(!sym.a.includes('Defect') && !sym.b.includes('Defect'), 'same for the second shared name');
  assert(JSON.stringify(sym) === JSON.stringify(panelPair(symmetric)), 'drawer and panel agree here too');

  // Fixture 3 — the NEGATIVE control. Without it, a mutant that returns only
  // the structural terms and drops every option name passes fixtures 1 and 2.
  const asymmetric = {
    row1Label: 'Advertise', row2Label: 'Hold back', col1Label: 'Match', col2Label: 'Ignore',
    colorTermsA: [], colorTermsB: [],
  };
  const asym = savedGameColorTerms(asymmetric);
  assert(asym.a.includes('Advertise') && asym.a.includes('Hold back'),
    'an UNSHARED option name must survive — dropAmbiguous must not fire here');
  assert(asym.b.includes('Match') && asym.b.includes('Ignore'), 'same for B');

  // A game with nothing on it still colours its structural notation.
  const bare = savedGameColorTerms({});
  assert(bare.a.length === STRUCTURAL_A_TERMS.length && bare.b.length === STRUCTURAL_B_TERMS.length,
    'a label-less, highlight-less saved game gets exactly the structural terms');
  assert(savedGameColorTerms(null).a.length === STRUCTURAL_A_TERMS.length, 'null is a game with no labels');

  // A hand-edited or migration-corrupted db.json can hold a non-array
  // colorTermsA/B. mergeDescriptionTerms spreads its user-term args before
  // cleanUserColorTerms gets to Array.isArray-check them, so this must be
  // normalized at the savedGameColorTerms boundary or MenuDrawer crashes
  // rendering the drawer's game list.
  let corruptThrew = false;
  try { savedGameColorTerms({ colorTermsA: { oops: true } as any, colorTermsB: 42 as any }); }
  catch { corruptThrew = true; }
  assert(!corruptThrew, 'a non-array colorTermsA/B must not throw — it must be treated as no highlights');

  console.log('✓ savedGameColorTerms: user highlights, shared-name suppression and structural terms '
    + 'all reach a saved game\'s card, and match the main panel');
}

function testDescriptionPreviewMatchesSave() {
  // The preview's contract, in its own words: "what this preview shows is what
  // the game will show". `saved` drives the REAL entry point the saved card's
  // component calls — savedGameColorTerms, on a record-SHAPED object
  // (row1Label, not row1) — rather than re-deriving the preview's own
  // composition. Both reduce to mergeDescriptionTerms(colorTermsFor(...), ...)
  // internally, but pinning the record shape here is what can actually catch a
  // row1-vs-row1Label mapping mistake at either call site.
  const preview = (labels: any, uA: string[], uB: string[]) =>
    mergeDescriptionTerms(dialogBaseColorTerms(labels), uA, uB);          // DescriptionEditor.tsx
  const saved = (labels: any, uA: string[], uB: string[]) =>
    savedGameColorTerms({
      row1Label: labels.row1, row2Label: labels.row2,
      col1Label: labels.col1, col2Label: labels.col2,
      colorTermsA: uA, colorTermsB: uB,
    });                                                                    // the saved game's card

  const CASES: Array<[string, any, string[], string[]]> = [
    // Save dialog: a preset saved under four NEW option names. The preview used
    // to show one highlight and the save delivered four.
    ['new option names', { row1: 'Advertise', row2: 'Hold back', col1: 'Match', col2: 'Ignore' }, ['Opera'], []],
    // Pencil path: the edited game has no labels at all, while some OTHER game
    // is still selected behind the dialog. The preview used to promise three
    // highlights and the save delivered one.
    ['no labels at all', { row1: '', row2: '', col1: '', col2: '' }, [], ['crew']],
    // A half-filled form, mid-typing.
    ['half-filled', { row1: 'Advertise', row2: '', col1: '', col2: 'Ignore' }, ['the depot'], ['the yard']],
    // The user reassigns a structural term to the other player.
    ['reassigned structural', { row1: 'Advertise', row2: 'Hold back', col1: 'Match', col2: 'Ignore' }, [], ['Row 1']],
    // A symmetric game typed into the dialog: shared names drop on both sides.
    ['symmetric labels', { row1: 'Cooperate', row2: 'Defect', col1: 'Cooperate', col2: 'Defect' }, ['the hedge'], []],
    // The dialog holds labels UNTRIMMED; the save path sends `.trim()`. The
    // preview must promise what the trimmed record will deliver.
    ['padded labels', { row1: '  Advertise ', row2: 'Hold back', col1: 'Match ', col2: ' Ignore' }, [], []],
    ['nothing at all', { row1: '', row2: '', col1: '', col2: '' }, [], []],
  ];
  for (const [why, labels, uA, uB] of CASES) {
    const p = preview(labels, uA, uB), s = saved(labels, uA, uB);
    assert(JSON.stringify(p) === JSON.stringify(s),
      `preview and save disagree for "${why}": preview A=${p.a} B=${p.b} vs saved A=${s.a} B=${s.b}`);
  }

  // NEGATIVE CONTROL — the assertions above are only worth something if this
  // comparison can fail at all. Feeding the preview a DIFFERENT game's labels
  // is precisely the shipped defect, and it must be caught.
  const otherGamesTerms = dialogBaseColorTerms({ row1: 'Advertise', row2: 'Hold back', col1: 'Match', col2: 'Ignore' });
  const wrong = mergeDescriptionTerms(otherGamesTerms, [], ['crew']);
  const right = saved({ row1: '', row2: '', col1: '', col2: '' }, [], ['crew']);
  assert(JSON.stringify(wrong) !== JSON.stringify(right),
    'the preview/save comparison is tautological — it cannot tell a wrong base from a right one');

  console.log('✓ description preview: what the preview shows is what the game will show, on six '
    + 'label shapes, and a wrong base is still detectable');
}

function testRegenColorTerms() {
  // RED-REGEN/001: Keep must never wipe the user's existing colour-term
  // chips — SCENARIO_SCHEMA is strict, so a real draw never carries
  // actorA/actorB, and the old `keepFill` replaced the chips with
  // cleanUserColorTermPair(preview.actorA ?? [], preview.actorB ?? []),
  // i.e. always {a:[],b:[]} in practice.
  const bankRow = { description: 'd', row1: 'r1', row2: 'r2', col1: 'c1', col2: 'c2' }; // no actorA/actorB, like a real draw

  const existing = { a: ['the vendor'], b: ['the buyer'] };
  const kept = keepFill(bankRow, false, existing);
  assert(kept.terms.a.includes('the vendor') && kept.terms.b.includes('the buyer'),
    `a Keep with no actor nouns must leave the user's existing chips untouched — got ${JSON.stringify(kept.terms)}`);

  // The historical (pre-fix) default — no existingTerms argument at all —
  // must not silently wipe either; it is a genuinely EMPTY starting point,
  // not evidence that Keep destroys anything.
  const bare = keepFill(bankRow, false);
  assert(bare.terms.a.length === 0 && bare.terms.b.length === 0,
    'with no existing chips to preserve, a Keep with no actor nouns yields no chips (not a defect — nothing existed to keep)');

  // If a draw DOES supply actor nouns (never happens today, but the function
  // must be correct if the schema is ever extended), they are ADDED to the
  // existing chips, never substituted for them.
  const withActors = keepFill(
    { ...bankRow, actorA: ['the miller'], actorB: ['the trader'] },
    false,
    existing,
  );
  assert(withActors.terms.a.includes('the vendor') && withActors.terms.a.includes('the miller'),
    `actor nouns must be ADDED to the existing chip, not replace it — got ${JSON.stringify(withActors.terms.a)}`);
  assert(withActors.terms.b.includes('the buyer') && withActors.terms.b.includes('the trader'),
    `same for player B — got ${JSON.stringify(withActors.terms.b)}`);

  // A duplicate actor noun (already one of the user's chips) does not
  // double up — cleanUserColorTermPair's own de-duplication still applies
  // to the UNION.
  const dup = keepFill({ ...bankRow, actorA: ['the vendor'] }, false, existing);
  assert(dup.terms.a.filter((t) => t.toLowerCase() === 'the vendor').length === 1,
    'a re-offered actor noun already in the user\'s chips must not duplicate');

  // CodeRabbit (this PR): "never destroys" must also mean "never REASSIGNS".
  // The user placed "wolf" on player B; a draw's actorA also offers "wolf".
  // Concatenating existing+actor BEFORE cleaning let A claim it and silently
  // dropped the user's own B assignment as a "duplicate" — the exact
  // opposite of the director's decision. `regenKeptColorTerms` now cleans
  // the EXISTING pair first, so the user's ownership is fixed before any
  // actor noun is considered, and a colliding actor noun is simply dropped.
  const reassignAttempt = keepFill(
    { ...bankRow, actorA: ['wolf'] }, false, { a: [], b: ['wolf'] },
  );
  assert(reassignAttempt.terms.b.includes('wolf') && !reassignAttempt.terms.a.includes('wolf'),
    `an actor noun colliding with the user's EXISTING opposite-side chip must not reassign it — `
    + `got terms=${JSON.stringify(reassignAttempt.terms)}`);
  // Symmetric direction: existingA vs actorB.
  const reassignAttempt2 = keepFill(
    { ...bankRow, actorB: ['fox'] }, false, { a: ['fox'], b: [] },
  );
  assert(reassignAttempt2.terms.a.includes('fox') && !reassignAttempt2.terms.b.includes('fox'),
    `same in the other direction — got terms=${JSON.stringify(reassignAttempt2.terms)}`);

  // ── RED-REGEN/002: the preview card and the post-Keep saved render must
  // agree on a colliding actor-noun/label pair — they used to diverge
  // because the preview ran `colorTermsFor` (dropAmbiguous over structural +
  // label + actor terms together) while the eventual saved render ran
  // `mergeDescriptionTerms` on top of `dialogBaseColorTerms` (no ambiguity
  // check against the label side at all).
  const colliding = {
    row1: 'Wolf', row2: 'Stay Home', col1: 'Hunt', col2: 'Retreat',
    description: 'd', actorA: [] as string[], actorB: ['Wolf'],
  };
  const noExisting = { a: [] as string[], b: [] as string[] };

  // What the regen preview card renders (App.tsx's regenPreviewTerms).
  const previewTerms = regenPreviewColorTerms(
    colliding, colliding.actorA, colliding.actorB, noExisting.a, noExisting.b,
  );
  // What Keep actually stores, then what DescriptionEditor renders for it —
  // the SAME composition (dialogBaseColorTerms + mergeDescriptionTerms) every
  // other saved/custom game's preview and save use, per
  // testDescriptionPreviewMatchesSave above.
  const savedKept = keepFill(colliding, false, noExisting);
  const savedTerms = mergeDescriptionTerms(dialogBaseColorTerms(savedKept.labels), savedKept.terms.a, savedKept.terms.b);
  assert(JSON.stringify(previewTerms) === JSON.stringify(savedTerms),
    `regen preview and the post-Keep saved render disagree on a colliding actor-noun/label pair: `
    + `preview=${JSON.stringify(previewTerms)} saved=${JSON.stringify(savedTerms)}`);

  // NEGATIVE CONTROL: the comparison above is only worth something if it can
  // actually fail. Feeding the two paths genuinely DIFFERENT existing chips
  // must produce genuinely different results.
  const previewOther = regenPreviewColorTerms(colliding, colliding.actorA, colliding.actorB, ['the depot'], []);
  assert(JSON.stringify(previewOther) !== JSON.stringify(previewTerms),
    'the preview/saved comparison is tautological — different existing chips must change the result');

  // regenKeptColorTerms alone: ownership stays exclusive (A wins a tie), same
  // rule cleanUserColorTermPair applies everywhere else.
  const tie = regenKeptColorTerms(['shared'], ['shared'], [], []);
  assert(tie.a.includes('shared') && !tie.b.includes('shared'),
    'a term offered to both players resolves to A only, same tie-break as cleanUserColorTermPair');

  console.log('✓ regen colour terms: Keep never destroys existing chips, actor nouns only ADD, and the '
    + 'preview card renders exactly what Keep will produce');
}

function testDescriptionsAreNeverHtml() {
  // The property is the BRANCH, not a sanitiser: `cleanText` on the server does
  // NOT strip tags, so a saved description keeps its markup byte-for-byte in
  // the database. What makes it safe is that a CUSTOM game's description is
  // rendered through <ColorCoded> (React text nodes) while only BUILT-IN
  // presets take the dangerouslySetInnerHTML branch. If a saved game ever
  // reaches that branch, the hole reopens with the payload already stored.
  const PAYLOADS = [
    '<img src=x onerror=alert(1)> and <b>bold</b> text',
    '<script>alert(document.domain)</script>hello',
  ];
  for (const text of PAYLOADS) {
    const html = renderToStaticMarkup(
      ReactForRender.createElement(ColorCoded, { text, aTerms: ['bold'], bTerms: ['hello'] }),
    );
    assert(!/<(img|script|b)[\s>/]/i.test(html),
      `ColorCoded emitted a live tag for ${JSON.stringify(text)}: ${html}`);
    assert(html.includes('&lt;'), `the markup must survive as ESCAPED text, not be stripped: ${html}`);
  }
  // ColorCoded is the safe renderer precisely because it never takes this door.
  assert(!/dangerouslySetInnerHTML/.test(readFileForContract('src/components/ColorCoded.tsx', 'utf8')),
    'ColorCoded must never set innerHTML — it exists to colour UNTRUSTED text');

  // The branch itself: a custom game's description goes to ColorCoded, and the
  // innerHTML branch is the `:` alternative reached only when there is none.
  const app = readFileForContract('src/App.tsx', 'utf8');
  const card = app.match(/\{selectedPreset\?\.desc && \([\s\S]*?\n {12}\)\}/);
  assert(!!card, 'could not locate the selected-game description card in App.tsx');
  const block = card![0];
  const iColor = block.indexOf('<ColorCoded');
  const iHtml = block.indexOf('dangerouslySetInnerHTML');
  assert(/selectedCustomGame \?/.test(block),
    'the description card must branch on selectedCustomGame — that branch IS the injection guard');
  assert(iColor !== -1 && iHtml !== -1 && iColor < iHtml,
    'a custom game must be rendered by <ColorCoded> in the TRUE arm, with innerHTML only in the '
    + 'built-in-preset arm. Reversing these arms would feed stored user markup to innerHTML.');

  console.log('✓ descriptions are never HTML: stored markup renders as literal escaped text, and a '
    + 'custom game cannot reach the innerHTML branch');
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
  testColorTermSingleSource();
  testSavedGameColorTermsBehaviour();
  testDescriptionPreviewMatchesSave();
  testRegenColorTerms();
  testDescriptionsAreNeverHtml();
  testUserColorTerms();
  testCameraRelayoutPredicate();
  testIsAgentRouterEndpoint();
  testBuildChatRequestBody();
  testOpenRouterResolveProvider();
  testOpenRouterCredentialGating();
  testIsRateLimit();
  testOpenRouterModelId();
  testOpenRouterRequestVariants();
  testScenarioDomains();
  testFmtPayoffSubResolution();
  testFmtPayoffProseExhaustive();
  testTieProseDerivedPayoff();
  testGeometryBriefingTruth();
  testGateFixesAugust31();
  testOptionLabelChannel();
  testNegotiationForm();
  testInterestAlignment();
  testTwoChooserStructure();
  testRepeatedPlayRefused();
  testMetaVocabulary();
  payoffDisplayTests();
  testModelDebris();
  testOracleGateHoles();
  testGeometryDegenerateShelf();
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
  // COORD_TALK on a game with exactly ONE pure equilibrium that IS on the
  // matching diagonal (F1, not F1-vocab): this must still be REJECTED — "both
  // want to coordinate" asserts the game IS a coordination game, which this
  // file's own comment says needs TWO matching equilibria to be true. A lone
  // equilibrium landing on a "matching" index is dominant-strategy
  // convergence (Prisoner's Dilemma's own shape), not a coordination problem.
  // The OLD issue string was literally false here ("its pure equilibria do
  // not all sit on matching pairs" — the one it has does); the fix reworded
  // the string onto the real claim ("does not have multiple ... that all
  // sit on matching pairs") rather than widening the predicate.
  assert(!validateScenario(coordSc(MATCH_TALK), ONE_MATCH).ok,
    'F1 CONTROL: COORD_TALK vocabulary must still be rejected where there is only ONE matching equilibrium — that is not a coordination game');
  // Exact text, not a substring: a named regression test must be sensitive to
  // an incorrect qualifier, prefix, or suffix creeping into the wording later.
  assert(validateScenario(coordSc(MATCH_TALK), ONE_MATCH).issues
    .includes('description frames the game as coordination (matching the opponent), but this game does not have multiple pure equilibria that all sit on matching pairs'),
    'F1 CONTROL: and the issue string must be true of the game (a single equilibrium, not "not all" of a set with more than one)');
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
  // THE MIRROR CASE (CodeRabbit CLI, self-review of the fix above): scanning
  // every DETERMINES sentence for a non-joint subject must not ALSO stop
  // checking that sentence's OWN negation. Reusing the whole-description
  // `negatedBefore` here asked "is every occurrence negated", which an
  // unnegated joint OPENER always fails — wrongly rejecting a later singular
  // sentence that correctly denies the claim.
  assert(ok_("Their choices determine the outcome for the season. The mill's decision does not determine the result.", AFLAT),
    'ALIGNMENT (determines): a joint TRUE opener followed by a properly NEGATED singular sentence must pass');
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

/* ---------------------------------------------------------------- 16. payoff
 * DISPLAY PRECISION: the screen must not assert what it cannot show.
 *
 * Both defects here come from one root — `r3(v).toFixed(3)` discards precision
 * that the surrounding claim depends on — and both were found by probing the
 * shipped render path over random games rather than by reading it.
 *
 *   (a) A non-zero payoff printed as exactly "0.000". 8 of 40,000 random games
 *       reach it at the equilibrium, and an exact zero becomes indistinguishable
 *       from 0.0004.
 *   (b) "0.030 > 0.030" — two DIFFERENT payoffs collapsed to one string with a
 *       strict inequality still drawn between them: visibly self-contradictory
 *       mathematics. Reachable where the gap exceeds the per-player
 *       `indifferenceAt` tolerance (so a strict relation is shown) but falls
 *       under 3dp. 28 of 640,000 relation renderings, 24 distinct games.
 */
function payoffDisplayTests() {
  // (a) the relation moves into the OPERATOR, because prose cannot go in TeX.
  assert(payoffTexRhs(0) === '= 0', 'an EXACT zero is stated as exactly zero');
  assert(payoffTexRhs(0.0004) === '< 0.001', `sub-resolution positive: got ${payoffTexRhs(0.0004)}`);
  assert(payoffTexRhs(-0.0004) === '> -0.001', `sub-resolution negative: got ${payoffTexRhs(-0.0004)}`);
  assert(payoffTexRhs(2.3156) === '= 2.316', 'ordinary values keep 3dp');
  assert(!/0\.000/.test(payoffTexRhs(1e-9)), 'a non-zero payoff is NEVER rendered as 0.000');
  assert(!/=\s*0$/.test(payoffTexRhs(1e-9)), 'nor claimed equal to zero');

  // (b) a strict relation must never be drawn between two identical strings.
  const pairs: Array<[number, number]> = [
    [0.0304366, 0.0300847], [-0.1974418, -0.1969141], [0.3124434, 0.3115643],
    [1e-9, 2e-9], [5, 5.0000001], [-2.5, -2.5001],
  ];
  for (const [p, q] of pairs) {
    const f = fmtPayoffPair(p, q);
    assert(f.p !== f.q,
      `SELF-CONTRADICTION: ${p} vs ${q} both render as "${f.p}", with a strict relation between them`);
  }
  // Equal values are the indifference case: they SHOULD render identically, and
  // the caller draws an approx sign rather than a strict relation.
  const eq = fmtPayoffPair(0.5, 0.5);
  assert(eq.p === eq.q && eq.p === '0.500', `genuinely equal payoffs still render alike: ${eq.p}/${eq.q}`);
  // 3dp stays the common case — this must not widen everything.
  const ord = fmtPayoffPair(1.234, 5.678);
  assert(ord.p === '1.234' && ord.q === '5.678', `ordinary pairs keep 3dp: ${ord.p}/${ord.q}`);

  // And the end-to-end property, over the shipped condition rather than a
  // stand-in for it: an earlier count using `p === q` in place of the real
  // tolerance read 19,719 instead of 28 — 33x high.
  let contradictions = 0, sampled = 0;
  const rnd = (() => { let z = 4242; return () => ((z = (z * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  for (let i = 0; i < 1200; i++) {
    const sc2 = [0.5, 2, 10, 50][i % 4];
    const g: GamePayoffs = { a11: (rnd()*2-1)*sc2, a12: (rnd()*2-1)*sc2, a21: (rnd()*2-1)*sc2, a22: (rnd()*2-1)*sc2,
                             b11: (rnd()*2-1)*sc2, b12: (rnd()*2-1)*sc2, b21: (rnd()*2-1)*sc2, b22: (rnd()*2-1)*sc2 };
    for (let k = 0; k < 40; k++) {
      const cx = rnd(), cy = rnd();
      const ind = indifferenceAtForDisplay(g, cx, cy);
      const r1 = cy*g.a11 + (1-cy)*g.a12, r2 = cy*g.a21 + (1-cy)*g.a22;
      const c1 = cx*g.b11 + (1-cx)*g.b21, c2 = cx*g.b12 + (1-cx)*g.b22;
      for (const [pp, qq, isInd] of [[r1, r2, ind.a], [c1, c2, ind.b]] as Array<[number, number, boolean]>) {
        sampled++;
        if (isInd) continue;
        const f = fmtPayoffPair(pp, qq);
        if (f.p === f.q) contradictions++;
      }
    }
  }
  assert(contradictions === 0,
    `${contradictions} of ${sampled} relation renderings still print X > X`);
  console.log(`✓ payoff display: sub-resolution payoffs state a relation instead of asserting 0.000, and ${sampled} sampled strict-relation renderings contain no "X > X"`);
}

try {
  runUnitTests();
} catch (err: any) {
  console.error('Unit test suite failure:');
  console.error(err?.message || err);
  process.exit(1);
}

/**
 * THE HOLES ORACLE FOUND, AND THE ONE BUG THAT FALLS OUT OF PROVING A RULE
 * UNREACHABLE.
 *
 * Every rule below is measured over 7,989 unique draws that pass all three
 * shipping gates today, pooled from every corpus either team holds, with every
 * match hand-read. Each ships with the defect it must catch AND the ordinary
 * output the guard spares, because a guard whose control cannot fail when the
 * guard is deleted is not a tested guard.
 */
function testOracleGateHoles() {
  const ANTI: GamePayoffs = { a11: 0, a12: 3, a21: 2, a22: 0, b11: 0, b12: 2, b21: 3, b22: 0 };
  const sc = (d: string, labels?: Partial<Record<'name' | 'row1' | 'row2' | 'col1' | 'col2', string>>) => ({
    name: 'Test', row1: 'Early Slot', row2: 'Late Slot',
    col1: 'Shared Window', col2: 'Separate Window', storyClaims: null, description: d, ...labels,
  } as any);
  const gate = (d: string, labels?: Partial<Record<'name' | 'row1' | 'row2' | 'col1' | 'col2', string>>) =>
    scenarioIsClaimFree(sc(d, labels)).ok;

  // ── THE CAST NOUN IN A GAME-THEORETIC CONSTRUCTION ──────────────────────
  // Verbatim production-model output, all gate-clean before this rule.
  assert(!gate('The players are two rival truffle cooperatives sharing access to a high-value forest whose annual permit plan can be opened or tightened.'),
    'CAST (scenario_raw_v2): "The players are X"');
  assert(!gate('Two textile firms booking capacity at the same dyehouse are the players. Firm A chooses Early Shift or Late Shift.'),
    'CAST (scenario_raw_v2): "X are the players"');
  assert(!gate('Farmer A (the row player) chooses whether to plant Wheat or Barley. Farmer B (the column player) decides whether to sell early or late.'),
    'CAST (fair_round): "the row player"');
  assert(!gate('The first player is the triage chief at Hospital A, choosing between Core Staffing and Surge Staffing.'),
    'CAST (rt3_reroll_cloud): "the first player"');
  assert(!gate('Both sides commit simultaneously, with no other factor influencing either player\'s decision.'),
    'CAST (rt3_slot_control): "either player"');
  // THE COLLISION THE BARE NOUN WAS REFUSED FOR, and the reason the narrow form
  // exists. "puppet theatre touring" is a live domain in the rotation; these
  // must keep passing, and they are what a widening to `\bplayers?\b` would
  // break. Measured: over the same 7,989 gate-passing draws the narrow form and
  // the bare noun find the SAME 19 rows, so the collision safety is free HERE —
  // the build-time screen in _gen/trainset_screens.ts takes the bare noun
  // instead, where over-firing costs one row of ~2,300 rather than a user's
  // generation.
  assert(gate('A touring puppet theatre company books an Early Slot while a rival books a Late Slot; the players rehearse in the afternoon.'),
    'CAST CONTROL: "the players" is the acting company in a puppet-theatre setting');
  assert(gate('A brass band books an Early Slot while the hall books a Shared Window, and its players tune beforehand.'),
    'CAST CONTROL: "its players" are musicians');

  // ── BARE LETTER, WIDENED VERB LIST ──────────────────────────────────────
  assert(!gate('A manages a protected site and chooses between Patrol and Stay back. B operates nearby and chooses between Harvest and Abandon site.'),
    'BARE LETTER (local draw): "A manages" — outside the shipped verb list');
  assert(!gate('A books an Early Slot or a Late Slot. B books a Shared Window or a Separate Window.'),
    'BARE LETTER: "A books"');
  // THE LOOKBEHIND, which is what makes the widening safe. Dropping it takes the
  // widened rule from 3 hits to 743 on the same pool, and the 740 extra are all
  // this shape.
  assert(gate('Two neighbouring growers share a greenhouse. Grower A takes the Early Slot while Grower B takes the Late Slot, and both commit at once.'),
    'BARE LETTER CONTROL: "Grower A takes" is a designation, not the prompt\'s variable');
  assert(gate('Two foundries are casting a bell. Foundry A schedules the Early Slot and Foundry B schedules the Late Slot, moving simultaneously.'),
    'BARE LETTER CONTROL: "Foundry A schedules"');

  // ── THE BARE LETTER WITH ITS ROLE IN APPOSITION ─────────────────────────
  // Verbatim gate-passing draws. Whatever verb list META_BARE_LETTER carries,
  // the comma puts the verb where that rule does not look.
  assert(!gate('A volunteer ecologist chooses whether to conduct the bat survey during an early or late evening window. B, the park coordinator, chooses whether to assign a quiet route or a busy route for that night\'s survey.'),
    'APPOSITION (RED-CLOUD, cloud draw): "B, the park coordinator, chooses…"');
  assert(!gate('A hospital charge nurse chooses between a Core Team and a Surge Team for the triage desk. B, the ambulance coordinator, chooses between Steady Arrivals and Surge Arrivals.'),
    'APPOSITION: "B, the ambulance coordinator"');
  assert(!gate('A satellite operator chooses between the Early Window and the Late Window for a downlink. B, a ground-network coordinator, chooses between a Priority Link and a Shared Link.'),
    'APPOSITION: the indefinite article form, "B, a ground-network coordinator"');
  // THE LOOKBEHIND, measured: it excludes exactly one row on the pooled corpora,
  // and this is it — noun-preceded, so the letter only disambiguates.
  assert(gate('Two oyster farmers with adjacent leased beds decide on harvesting. For Farmer A, the choices are Early Slot or Late Slot. For Farmer B, the choices are Shared Window or Separate Window.'),
    'APPOSITION CONTROL: "For Farmer A, the choices…" is noun-preceded');
  // The SYMMETRIC appositive, where both parties are charactered and the letter
  // only disambiguates. ORACLE's negative fixture, re-checked here.
  assert(gate('Operator A, the larger firm, chooses between an Early Slot and a Late Slot, while Operator B, the smaller, chooses between a Shared Window and a Separate Window.'),
    'APPOSITION CONTROL: "Operator A, the larger firm" — both sides charactered');
  // THE PAIR FORM IS DELIBERATELY NOT GATED — 82 draws on the same pool, both
  // parties equally charactered. Asserted so a later widening has to face it.
  // ISOLATED ON PURPOSE. The first draft of this control read "…Each company
  // chooses between an Early Slot and a Late Slot" and failed — not on the pair
  // form at all, but on `onlyPairHeldCollectively`, which correctly rejects one
  // pair handed to a collective subject. A control carrying two signals cannot
  // show what it claims to show; both choosers and both pairs are named here so
  // only the pair form is under test.
  assert(gate('Two local courier companies, A and B, are bidding for a delivery route. Courier A chooses between an Early Slot and a Late Slot, while Courier B chooses between a Shared Window and a Separate Window.'),
    'APPOSITION CONTROL: the symmetric pair form stays legal');

  // ── THE SECOND PAIR HANDED BACK TO THE SAME NAMED ACTOR ─────────────────
  assert(!gate('A university library director chooses between Early Slot and Late Slot for a new book series. The same director chooses between Shared Window and Separate Window for evaluating the same publishing deal.'),
    'SAME ACTOR (gate-passing draw): the second pair handed back to "the same director"');
  assert(!gate('A small grocer chooses between Early Slot and Late Slot for the season. The same grocer chooses between Shared Window and Separate Window for the same bed.'),
    'SAME ACTOR: "The same grocer chooses"');
  // THE CLAUSE ANCHOR. Without it the rule finds 5 rather than 3 on the pooled
  // corpora, and these two are the extra pair — "the same" modifying a SCENE
  // noun, with a real second party as the subject.
  assert(gate('A survey team chooses between Early Slot and Late Slot for a bat survey night. A second team surveying the same habitat chooses between Shared Window and Separate Window.'),
    'SAME ACTOR CONTROL: "the same habitat" is a scene noun and the subject is a second party');
  assert(gate('A roastery chooses between Early Slot and Late Slot for its sourcing plan. A coffee importer arranging the same supply chooses between Shared Window and Separate Window.'),
    'SAME ACTOR CONTROL: "the same supply"');

  // ── THE SENTENCE-FINAL PAYOFF CITATION ──────────────────────────────────
  // Latent at rung 3 (the numeral screens reject the field first) and live the
  // moment the rung steps down. The typography is verbatim on purpose: this
  // repo's own record says punctuation has bitten it three times.
  const cited = (d: string) => validateScenario({
    name: 'Haulage Window', row1: 'Early Window', row2: 'Late Window',
    col1: 'Open Dock', col2: 'Hold Dock', description: d, storyClaims: null,
  } as any, { a11: 3, a12: -2, a21: -4, a22: 5, b11: -3, b12: 2, b21: 4, b22: -5 })
    .issues.some((i) => /cellCitation/.test(i));
  assert(cited('A haulier books a window and earns 9.'),
    'PAYOFF CITATION: a payoff number at the END OF A SENTENCE was invisible — the old lookahead excluded the full stop');
  assert(cited('A haulier books a window and earns 9 for the season.'),
    'PAYOFF CITATION: mid-sentence, which always worked');
  assert(cited('A haulier books a window and earns 12 tokens.'),
    'PAYOFF CITATION: a multi-digit number followed by a word');
  // WHAT THE EXCLUSION WAS ACTUALLY PROTECTING. Decimals and dimensions are not
  // payoff citations and must stay skipped, or the rule fires on every "2x2".
  assert(!cited('The dock runs a 2x2 trial and the haulier earns 2.5 per run.'),
    'PAYOFF CITATION CONTROL: a decimal and a dimension are not citations');
  assert(!cited('The haulier earns 100% of the fee on an early window.'),
    'PAYOFF CITATION CONTROL: a percentage is not a payoff');

  console.log('✓ oracle gate holes: the cast noun in 5 game-theoretic constructions (puppet-theatre collision spared), the bare letter under a widened verb list AND in apposition (designations and the symmetric pair form spared), the second pair handed back to the same named actor (scene-noun "the same X" spared), and the sentence-final payoff citation the old lookahead could not see');
}

/**
 * THE VALIDATOR SIDE OF THE DEGENERATE FLAT SHELF.
 *
 * `checkGeometry` compared the model's `hasFlatShelfForA` against
 * `yStarInRange`, which is false when twistA is 0 because yStar is NaN. There
 * are three ways a shelf can relate to the board, not two: the level point is
 * inside [0,1], it is outside, or twistA vanishes — and in that last case the
 * shelf either does not exist at all (A's own-axis slope is a non-zero
 * constant) or is EVERYTHING (the slope is zero). The old predicate called the
 * third case "no shelf", so the validator DEMOTED A REPORT FOR STATING A TRUTH.
 *
 * Both matrices below are BLUE-MATH's, re-verified here against the payoff
 * definition rather than against the predicate: on the first, dE_A/dx = 0 at
 * y = 0, .25, .5, .75 and 1; on the second, dE_B/dy = 0 at every x while A goes
 * level at y = 7/13, so both surfaces are level along a whole interior line.
 *
 * Asserted in BOTH directions. A one-way fixture would pass against a predicate
 * hard-wired to true, which is exactly the failure this suite keeps finding.
 */
function testGeometryDegenerateShelf() {
  const G = (a: number[][], b: number[][]): GamePayoffs =>
    ({ a11: a[0][0], a12: a[0][1], a21: a[1][0], a22: a[1][1], b11: b[0][0], b12: b[0][1], b21: b[1][0], b22: b[1][1] });
  // ENTIRELY a shelf: a11 === a21 and a12 === a22, so A's own-axis slope is 0.
  const WHOLE_SHELF = G([[-5, -1], [-5, -1]], [[-6, -6], [0, 6]]);
  // B level along B's axis at EVERY x, A level at y = 7/13 -> a joint flat spot.
  const FLAT_LINE = G([[-2, 2], [4, -5]], [[3, 3], [4, 4]]);

  // Ground truth from the surfaces, so the fixture does not assume the predicate.
  const EA = (g: GamePayoffs, x: number, y: number) => x * y * g.a11 + x * (1 - y) * g.a12 + (1 - x) * y * g.a21 + (1 - x) * (1 - y) * g.a22;
  const EB = (g: GamePayoffs, x: number, y: number) => x * y * g.b11 + x * (1 - y) * g.b12 + (1 - x) * y * g.b21 + (1 - x) * (1 - y) * g.b22;
  for (const y of [0, 0.25, 0.5, 0.75, 1]) {
    assert(Math.abs(EA(WHOLE_SHELF, 1, y) - EA(WHOLE_SHELF, 0, y)) < 1e-12,
      `WHOLE_SHELF: A must be level along its own axis at y=${y} — the fixture's premise, checked from E_A and not from describeGeometry`);
  }
  for (const x of [0, 0.25, 0.5, 0.75, 1]) {
    assert(Math.abs(EB(FLAT_LINE, x, 1) - EB(FLAT_LINE, x, 0)) < 1e-12,
      `FLAT_LINE: B must be level along its own axis at x=${x}`);
  }
  assert(Math.abs(EA(FLAT_LINE, 1, 7 / 13) - EA(FLAT_LINE, 0, 7 / 13)) < 1e-12,
    'FLAT_LINE: A must be level at y = 7/13, so the flat spot is a genuine interior line');

  assert(describeGeometry(WHOLE_SHELF).hasFlatShelfForA,
    'a board that is ENTIRELY a shelf must report one — the old predicate said no shelf because yStar is NaN');
  assert(describeGeometry(FLAT_LINE).hasInteriorFlatSpot,
    'both surfaces level along an interior line IS an interior joint flat spot — the old predicate said edge-or-corner because xStar is NaN');
  // The predicate must still say NO where there genuinely is none: twistA is 0
  // but A's own-axis slope is a non-zero constant, so A never goes level.
  assert(!describeGeometry(G([[3, 1], [1, -1]], [[0, 0], [0, 0]])).hasFlatShelfForA,
    'twist 0 with a NON-zero constant slope is the OTHER degenerate case and has no shelf at all');

  // …and through the real validator, in both directions.
  const claims = (g: GamePayoffs, over: Partial<Record<string, boolean>> = {}) => {
    const geo = describeGeometry(g);
    return {
      surfacesInteract: Math.abs(geo.twistA) >= 1e-9,
      opponentSurfaceIsMirror: geo.zeroSum || geo.constantSum,
      hasFlatShelfForA: geo.hasFlatShelfForA,
      equilibriumIsInteriorFlatSpot: geo.hasInteriorFlatSpot,
      minimaxApplies: geo.minimaxApplies,
      hasDominantStrategy: geo.dominantRowA || geo.dominantColB,
      ...over,
    } as never;
  };
  const geoKinds = (g: GamePayoffs, c: unknown) =>
    validateReport({ prose: 'A short description.', claimedEquilibria: [], geometryClaims: c } as never, g)
      .mismatches.map((m) => m.kind).filter((k) => k.startsWith('geometry-'));

  // THE SHAPE GUARD ATE MY FIRST VERSION OF THIS CHECK. Passing `equilibria: []`
  // instead of `claimedEquilibria: []` makes validateReport return early on
  // malformed shape, so BOTH the truthful and the negated claims came back with
  // no geometry mismatch and the harness looked like a clean pass. The negation
  // assertions below are the only reason that was caught.
  // THE THIRD GAME EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT. Hard-wiring the
  // shelf row's `actual` to `true` passed the whole suite on the two games
  // above, because `hasFlatShelfForA` is true on BOTH of them — so every
  // assertion still held and the fixture proved nothing about the field being
  // read. This is the OTHER degenerate branch: twistA is 0 and A's own-axis
  // slope is the non-zero constant 4, so A never goes level and a claimed shelf
  // must be caught. Same trap the comment above warns about, found by running
  // the mutation rather than by reasoning about it.
  const NO_SHELF = G([[5, 4], [1, 0]], [[2, -1], [0, 3]]);
  assert(Math.abs(EA(NO_SHELF, 1, 0.5) - EA(NO_SHELF, 0, 0.5)) > 1e-9,
    'NO_SHELF: A must NOT be level at mid-board — the fixture premise, from E_A');
  assert(!describeGeometry(NO_SHELF).hasFlatShelfForA, 'NO_SHELF has no shelf for A');

  for (const [name, g] of [['WHOLE_SHELF', WHOLE_SHELF], ['FLAT_LINE', FLAT_LINE], ['NO_SHELF', NO_SHELF]] as Array<[string, GamePayoffs]>) {
    assert(geoKinds(g, claims(g)).length === 0,
      `${name}: a report stating the geometry TRUTHFULLY must not be demoted (was: ${geoKinds(g, claims(g)).join(', ')})`);
    assert(geoKinds(g, claims(g, { hasFlatShelfForA: !describeGeometry(g).hasFlatShelfForA })).includes('geometry-bad-shelf'),
      `${name}: negating the shelf claim MUST still be caught`);
    assert(geoKinds(g, claims(g, { equilibriumIsInteriorFlatSpot: !describeGeometry(g).hasInteriorFlatSpot })).includes('geometry-bad-flatspot'),
      `${name}: negating the flat-spot claim MUST still be caught`);
  }

  console.log('✓ geometry degenerate shelf: a board that is entirely a shelf, and an interior flat LINE, are both stated truthfully without being demoted — and negating either claim is still caught');
}

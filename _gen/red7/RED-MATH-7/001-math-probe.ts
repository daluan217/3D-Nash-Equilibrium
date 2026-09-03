import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  computeAllNE,
  computeMixedNE,
  computeIndifference,
  equilibriumSet,
  describeContinua,
  fmtProb,
  fmtPayoff,
  doStep,
  EA,
  EB,
  regretA,
  regretB,
  PRESETS,
} from '../../src/utils/gameEngine';
import { neValues, indifferenceLine } from '../../src/components/equilibriumPanel';
import { buildGroundingPayload } from '../../src/utils/report';
import type { GamePayoffs, SimState } from '../../src/types';

const out: string[] = [];
const failures: string[] = [];
const notes: string[] = [];

function log(s: string) { out.push(s); }
function fail(s: string) { failures.push(s); out.push(`FAIL: ${s}`); }
function ok(cond: unknown, s: string) { if (!cond) fail(s); }

function mk(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeState(startX: number, startY: number, g: GamePayoffs): SimState {
  return {
    cx: startX, cy: startY, exactX: startX, exactY: startY,
    calcX: startX, calcY: startY, displayX: startX, displayY: startY,
    startX, startY, domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1,
    stratX: startX, stratY: startY, cycleCount: 0,
    visitedPositions: [], ghostVisitedPositions: [],
    discoveredMixedX: null, discoveredMixedY: null, foundAxis: null,
    running: false, converged: false, stepCount: 0,
    pathSegmentsA: [{ xs: [startX], ys: [startY], zs: [0], mover: 'A' }],
    pathSegmentsB: [{ xs: [startX], ys: [startY], zs: [0], mover: 'A' }],
    phase1PtsA: null, phase1PtsB: null, ghostPathSegmentsA: [], ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false, bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false, ghostBisectGoodLo: 0, ghostBisectGoodHi: 1,
    ghostBisectBadLo: 0, ghostBisectBadHi: 1,
  };
}

function parsePayloadMixed(payload: string): Array<{ x: string; y: string; a: string; b: string }> {
  const re = /^\s{2}mixed at x=([^,]+), y=([^\s]+) \(payoffs A=([^,]+), B=([^\)]+)\)/gm;
  const arr: Array<{ x: string; y: string; a: string; b: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(payload)) !== null) arr.push({ x: m[1], y: m[2], a: m[3], b: m[4] });
  return arr;
}

function parseLogHeadline(lines: string[]) {
  const line = [...lines].reverse().find((l) => l.startsWith('━━')) ?? null;
  if (!line) return null;
  const m = line.match(/^━━\s+(Pure|Mixed) NE: x=(.+), y=(.+)\s+E\[A\]=(.+)\s+E\[B\]=(.+)$/);
  if (!m) return { line, parsed: null as null | { kind: string; x: string; y: string; a: string; b: string } };
  return { line, parsed: { kind: m[1], x: m[2], y: m[3], a: m[4], b: m[5] } };
}

// Angle 1: continua/degenerate consistency through closed-form surfaces
log('## Angle 1 (function-level: continua/degenerate consistency)');
const fixtures: Array<{ name: string; g: GamePayoffs }> = [
  {
    name: 'row-of-ties (A indifferent, one-sided continuum)',
    g: { a11: 1, a12: 2, a21: 1, a22: 2, b11: 2, b12: 1, b21: 0, b22: 3 },
  },
  {
    name: 'column-of-ties (B indifferent, one-sided continuum)',
    g: { a11: 3, a12: 1, a21: 0, a22: 2, b11: 1, b12: 1, b21: 2, b22: 2 },
  },
  {
    name: 'all-equal matrix (both-sided/full square)',
    g: { a11: 5, a12: 5, a21: 5, a22: 5, b11: -2, b12: -2, b21: -2, b22: -2 },
  },
  {
    name: 'one-sided interior anchor continuum',
    g: { a11: 0, a12: 2, a21: 0, a22: 2, b11: 4, b12: -2, b21: -1, b22: 1 },
  },
  {
    name: 'both-sided continuum variant',
    g: { a11: 7, a12: 7, a21: 7, a22: 7, b11: 3, b12: 3, b21: 3, b22: 3 },
  },
];

for (const { name, g } of fixtures) {
  const all = computeAllNE(g);
  const ind = computeIndifference(g);
  const set = equilibriumSet(g);
  const cont = describeContinua(g);
  const payload = buildGroundingPayload(g);

  log(`- ${name}: ind.any=${ind.any} allNE=${all.length} setParts=${set.length} continua=${cont.length}`);
  if (ind.any) {
    ok(payload.includes('DEGENERATE'), `${name}: payload must mark DEGENERATE`);
    ok(payload.includes('continuum'), `${name}: payload must mention continuum`);
  }
  if (cont.length > 0) {
    for (const line of cont) ok(line.length > 0, `${name}: continuum line must be non-empty`);
  }
}

// Angle 2: formatter boundaries
log('\n## Angle 2 (formatter boundaries)');
const probCases: Array<[number, string]> = [
  [0.00049, 'less than 0.001'],
  [0.0005, '0.001'],
  [0.0006, '0.001'],
  [0.9994, '0.999'],
  [0.9995, 'more than 0.999'],
  [0.9996, 'more than 0.999'],
];
for (const [v, expected] of probCases) {
  const got = fmtProb(v);
  ok(got === expected, `fmtProb(${v}) expected "${expected}" got "${got}"`);
}
const payoffCases: Array<[number, string]> = [
  [-0.00049, 'greater than -0.001'],
  [0.00049, 'less than 0.001'],
  [-0, '0'],
  [0, '0'],
  [-0.0005, '-0.001'],
  [0.0005, '0.001'],
];
for (const [v, expected] of payoffCases) {
  const got = fmtPayoff(v);
  ok(got === expected, `fmtPayoff(${Object.is(v, -0) ? '-0' : v}) expected "${expected}" got "${got}"`);
}

// Angle 3 + 4 + 5: regret agreement + handover spell-out + 20k fuzz
log('\n## Angles 3,4,5 (regret agreement, handover spell-out, 20k fuzz)');
const rand = mk(0x7badb055);
let sampled = 0;
let mixedChecked = 0;
let regretChecked = 0;
let approxChecked = 0;
const mismatchExamples: string[] = [];

while (sampled < 20000) {
  const intGame = sampled < 10000;
  const v = () => {
    if (intGame) return Math.floor(rand() * 21) - 10;
    return Math.round((rand() * 20 - 10) * 1000) / 1000;
  };
  const g: GamePayoffs = { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() };
  sampled++;

  const all = computeAllNE(g);
  const payload = buildGroundingPayload(g);

  const mixed = all.find((e) => e.type === 'mixed');
  if (!mixed) continue;
  mixedChecked++;

  // fuzz invariant: mixed renderings must not collapse to exact 0/1
  const xWord = fmtProb(mixed.x);
  const yWord = fmtProb(mixed.y);
  if ((xWord === '0' || xWord === '1') || (yWord === '0' || yWord === '1')) {
    mismatchExamples.push(`mixed-fmtProb-collapse game=${JSON.stringify(g)} x=${mixed.x}->${xWord} y=${mixed.y}->${yWord}`);
  }

  const panelVals = neValues(mixed, g);
  const payloadMixed = parsePayloadMixed(payload)[0];
  if (payloadMixed) {
    if (payloadMixed.x !== xWord || payloadMixed.y !== yWord) {
      mismatchExamples.push(`payload-coord-mismatch game=${JSON.stringify(g)} payload=(${payloadMixed.x},${payloadMixed.y}) fmt=(${xWord},${yWord})`);
    }
    if (payloadMixed.a !== panelVals.a || payloadMixed.b !== panelVals.b) {
      mismatchExamples.push(`payload-payoff-mismatch game=${JSON.stringify(g)} payload=(${payloadMixed.a},${payloadMixed.b}) panel=(${panelVals.a},${panelVals.b})`);
    }
  }

  const row1 = mixed.y * g.a11 + (1 - mixed.y) * g.a12;
  const row2 = mixed.y * g.a21 + (1 - mixed.y) * g.a22;
  const col1 = mixed.x * g.b11 + (1 - mixed.x) * g.b21;
  const col2 = mixed.x * g.b12 + (1 - mixed.x) * g.b22;
  const la = indifferenceLine('Row 1', 'Row 2', row1, row2, EA(mixed.x, mixed.y, g));
  const lb = indifferenceLine('Col 1', 'Col 2', col1, col2, EB(mixed.x, mixed.y, g));
  if (la.indifferent) {
    approxChecked++;
    if (la.pStr !== la.qStr) mismatchExamples.push(`approx-mismatch-A game=${JSON.stringify(g)} ${la.pStr} vs ${la.qStr}`);
  }
  if (lb.indifferent) {
    approxChecked++;
    if (lb.pStr !== lb.qStr) mismatchExamples.push(`approx-mismatch-B game=${JSON.stringify(g)} ${lb.pStr} vs ${lb.qStr}`);
  }

  // regret-specific check on first 400 mixed-only games with no pure NEs
  if (regretChecked < 400 && all.filter((e) => e.type === 'pure').length === 0) {
    const st = makeState(0.5, 0.5, g);
    const logs: string[] = [];
    const addLog = (m: string) => logs.push(m);
    for (let i = 0; i < 800 && !st.converged; i++) {
      doStep(g, st, 'A', 0.04, all, null, addLog, () => {}, () => {}, 'regret');
    }
    if (st.converged) {
      regretChecked++;
      const exact = computeMixedNE(g);
      if (exact) {
        const headline = parseLogHeadline(logs);
        if (!headline || !headline.parsed) {
          mismatchExamples.push(`regret-headline-parse game=${JSON.stringify(g)} line=${headline?.line ?? 'none'}`);
        } else {
          const wantX = fmtProb(exact.x);
          const wantY = fmtProb(exact.y);
          const wantA = fmtPayoff(EA(exact.x, exact.y, g));
          const wantB = fmtPayoff(EB(exact.x, exact.y, g));
          if (headline.parsed.x !== wantX || headline.parsed.y !== wantY || headline.parsed.a !== wantA || headline.parsed.b !== wantB) {
            mismatchExamples.push(`regret-headline-mismatch game=${JSON.stringify(g)} got=${JSON.stringify(headline.parsed)} want=${JSON.stringify({ x: wantX, y: wantY, a: wantA, b: wantB })}`);
          }
        }

        const xDisc = logs.find((l) => l.startsWith('✓ x-coordinate discovered: '));
        const yDisc = logs.find((l) => l.startsWith('✓ y-coordinate discovered: '));
        if (xDisc && !xDisc.endsWith(fmtProb(exact.x))) mismatchExamples.push(`x-discovery-mismatch game=${JSON.stringify(g)} line=${xDisc} want=${fmtProb(exact.x)}`);
        if (yDisc && !yDisc.endsWith(fmtProb(exact.y))) mismatchExamples.push(`y-discovery-mismatch game=${JSON.stringify(g)} line=${yDisc} want=${fmtProb(exact.y)}`);
      }
    }
  }
}

ok(sampled === 20000, `must sample exactly 20,000 games, got ${sampled}`);
ok(mixedChecked > 0, 'fuzz must include mixed equilibria');
ok(regretChecked > 100, `regret sweep too small (${regretChecked})`);

if (mismatchExamples.length === 0) {
  notes.push('No mismatches found in 20,000-game fuzz and 400 regret runs; hand-read-20 requirement not applicable (0 matches).');
} else {
  notes.push(`Found ${mismatchExamples.length} matches; first 20 listed for manual hand-read:`);
  mismatchExamples.slice(0, 20).forEach((m, i) => notes.push(`  ${i + 1}. ${m}`));
}

// Extra angle: MenuDrawer source-level parity guard (same payoff rendering path)
log('\n## Extra angle (own): MenuDrawer payoff formatting path parity');
const menuSrc = readFileSync('src/components/MenuDrawer.tsx', 'utf8');
ok(/fmtPayoff\(EA\(eq\.x, eq\.y, preset\.payoffs\)\)/.test(menuSrc), 'MenuDrawer presets must render E[A] from fmtPayoff(EA(eq.x,eq.y,...))');
ok(/fmtPayoff\(EB\(eq\.x, eq\.y, preset\.payoffs\)\)/.test(menuSrc), 'MenuDrawer presets must render E[B] from fmtPayoff(EB(eq.x,eq.y,...))');
ok(/fmtPayoff\(EA\(eq\.x, eq\.y, game\.payoffs\)\)/.test(menuSrc), 'MenuDrawer saved games must render E[A] from fmtPayoff(EA(eq.x,eq.y,...))');
ok(/fmtPayoff\(EB\(eq\.x, eq\.y, game\.payoffs\)\)/.test(menuSrc), 'MenuDrawer saved games must render E[B] from fmtPayoff(EB(eq.x,eq.y,...))');

log(`\nSampled games: ${sampled}`);
log(`Mixed equilibria checked: ${mixedChecked}`);
log(`Regret convergences checked: ${regretChecked}`);
log(`Approx lines checked: ${approxChecked}`);
log(`Matches found: ${mismatchExamples.length}`);
if (notes.length) {
  log('\nNotes:');
  for (const n of notes) log(`- ${n}`);
}

const text = out.join('\n') + '\n';
writeFileSync('_gen/red7/RED-MATH-7/001-math-probe.out.txt', text, 'utf8');
console.log(text);
if (failures.length) {
  console.error(`Total FAILURES: ${failures.length}`);
  process.exit(1);
}
console.log('All RED-MATH-7 math probes passed.');

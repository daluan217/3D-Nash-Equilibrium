/**
 * Exact-rational oracle for the solver (math-loop-22). Payoffs ship as 3dp (commitPayoffInput,
 * server cleanPayoffs), so ×1000 makes every quantity an integer and BigInt decides each
 * question exactly. Fixtures F1–F3 are the defects this file was built on; each names the
 * check that caught it. Sweep sizes are fixed seeds, so a pass is reproducible, not luck.
 *
 *   npx tsx src/mathexact.test.ts
 */
import { computeAllNE, computeMixedNE, equilibriumSet, pointInRect, kindOf, fmtProb, indifferenceRoot } from './utils/gameEngine';
import { describeGeometry, geometryBriefing } from './utils/geometry';
import { buildGroundingPayload } from './utils/report';
import type { GamePayoffs } from './types';

const fails: Record<string, number> = {};
const firstFail: Record<string, string> = {};
let checks = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  checks++;
  if (ok) return;
  fails[name] = (fails[name] ?? 0) + 1;
  firstFail[name] ??= detail;
};

// ── exact arithmetic on integer thousandths ──────────────────────────────────
const K = ['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const;
const milli = (v: number) => BigInt(Math.round(v * 1000));
/** A player's indifference root as an exact fraction n/d (d > 0), or null when level. */
function exactRoot(d1: bigint, d2: bigint): { n: bigint; d: bigint } | null {
  let n = -d2, d = d1 - d2;
  if (d === 0n) return null;
  if (d < 0n) { n = -n; d = -d; }
  return { n, d };
}
const rootsOf = (g: GamePayoffs) => {
  const m = Object.fromEntries(K.map((k) => [k, milli(g[k])])) as Record<(typeof K)[number], bigint>;
  return {
    m,
    y: exactRoot(m.a11 - m.a21, m.a12 - m.a22),   // B's mix that levels A
    x: exactRoot(m.b11 - m.b12, m.b21 - m.b22),   // A's mix that levels B
  };
};
const interior = (r: { n: bigint; d: bigint } | null) => !!r && r.n > 0n && r.n < r.d;
// IEEE division of two integers < 2^53 is correctly rounded: THE float of the exact root.
const floatOf = (r: { n: bigint; d: bigint }) => Number(r.n) / Number(r.d);

/** Exact best-reply test at a rational point (px/q, py/q). */
function isNEexact(m: Record<(typeof K)[number], bigint>, px: bigint, py: bigint, q: bigint): boolean {
  const DA = py * (m.a11 - m.a21) + (q - py) * (m.a12 - m.a22);   // sign of A's Row1-minus-Row2 gain
  const DB = px * (m.b11 - m.b12) + (q - px) * (m.b21 - m.b22);
  const okA = DA > 0n ? px === q : DA < 0n ? px === 0n : true;
  const okB = DB > 0n ? py === q : DB < 0n ? py === 0n : true;
  return okA && okB;
}

// ── generators (fixed seed) ──────────────────────────────────────────────────
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry(0x22a7);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const KINDS: Record<string, () => number> = {
  int1: () => Math.floor(rnd() * 3) - 1,
  int9: () => Math.floor(rnd() * 19) - 9,
  dp3: () => Math.round((rnd() * 200 - 100) * 1000) / 1000,
  dp3small: () => (Math.floor(rnd() * 7) - 3) / 1000,
  edges: () => pick([100, -100, 99.999, -99.999, 0.001, -0.001, 0]),
  // dense ties: equal cells make boundary roots (F1) and half-way rationals (F2) common
  ties: () => pick([0.1, 0.2, 0.3, 0.7, -0.1, 0.6, 0.05, -0.06, 0.08, -0.07]),
};

// ── the checks, one game at a time ───────────────────────────────────────────
let wordHits = 0, payloadHits = 0;
const WORDS: [number, number, string][] = [
  [1, 2, 'a half'], [1, 3, 'a third'], [2, 3, 'two-thirds'], [1, 4, 'a quarter'], [3, 4, 'three-quarters'],
  [1, 5, 'a fifth'], [2, 5, 'two-fifths'], [3, 5, 'three-fifths'], [4, 5, 'four-fifths'],
];

function checkGame(g: GamePayoffs, heavy: boolean): void {
  const gs = JSON.stringify(g);
  const { m, x, y } = rootsOf(g);

  // E1 root-correctly-rounded: every surface's root IS the correctly rounded exact root.
  for (const [axis, r, got] of [
    ['y', y, indifferenceRoot(g.a11 - g.a21, g.a12 - g.a22)],
    ['x', x, indifferenceRoot(g.b11 - g.b12, g.b21 - g.b22)],
  ] as const) {
    check('E1 root-correctly-rounded', r ? got === floatOf(r) : Number.isNaN(got), `${gs} ${axis}: got ${got}, exact ${r && floatOf(r)}`);
  }
  const geo = describeGeometry(g);
  check('E1 root-correctly-rounded', y ? geo.yStar === floatOf(y) : Number.isNaN(geo.yStar), `${gs} geometry yStar ${geo.yStar}`);
  check('E1 root-correctly-rounded', x ? geo.xStar === floatOf(x) : Number.isNaN(geo.xStar), `${gs} geometry xStar ${geo.xStar}`);

  // E2 interior-classification: a mixed NE is listed iff BOTH exact roots are strictly inside (0,1).
  const mn = computeMixedNE(g);
  const both = interior(x) && interior(y);
  check('E2 interior-classification', !!mn === both, `${gs} computeMixedNE=${JSON.stringify(mn)} exact x=${x && floatOf(x)} y=${y && floatOf(y)}`);
  if (mn && both) check('E1 root-correctly-rounded', mn.x === floatOf(x!) && mn.y === floatOf(y!), `${gs} mixed ${mn.x},${mn.y}`);
  check('E2 interior-classification', geo.xStarInRange === interior(x) && geo.yStarInRange === interior(y),
    `${gs} geometry inRange x=${geo.xStarInRange} y=${geo.yStarInRange}`);

  // E3 set-membership: equilibriumSet agrees with the exact NE set on a breakpoint+midpoint grid.
  const Q = (x?.d ?? 1n) * (y?.d ?? 1n) * 2n;   // common denominator, midpoints included
  const brk = (r: typeof x, other: typeof x) => {
    const pts = [0n, Q];
    if (interior(r)) pts.splice(1, 0, (r!.n * Q) / r!.d);
    void other;
    const out: bigint[] = [];
    pts.forEach((p, i) => { out.push(p); if (i + 1 < pts.length) out.push((p + pts[i + 1]) / 2n); });
    return out;
  };
  const rects = equilibriumSet(g);
  const gx = brk(x, y), gy = brk(y, x);
  for (const px of gx) for (const py of gy) {
    const ex = isNEexact(m, px, py, Q);
    const fl = rects.some((r) => pointInRect(r, Number(px) / Number(Q), Number(py) / Number(Q)));
    check('E3 set-membership', ex === fl, `${gs} at (${Number(px) / Number(Q)}, ${Number(py) / Number(Q)}) exact=${ex} solver=${fl}`);
  }
  // Interior rect endpoints are the exact roots, so every continuum rendering prints the same digits.
  for (const r of rects) for (const [v, rt] of [[r.x0, x], [r.x1, x], [r.y0, y], [r.y1, y]] as const) {
    if (v !== 0 && v !== 1) check('E1 root-correctly-rounded', !!rt && v === floatOf(rt), `${gs} rect endpoint ${v}`);
  }

  // E4 list-sound-complete: every listed NE is exact; every exact isolated breakpoint NE is listed.
  const nes = computeAllNE(g);
  for (const ne of nes) if (ne.type === 'pure') {
    check('E4 list-sound-complete', isNEexact(m, BigInt(ne.x) * Q, BigInt(ne.y) * Q, Q), `${gs} ${ne.label}`);
  }
  for (const px of gx) for (const py of gy) {
    if (!isNEexact(m, px, py, Q)) continue;
    const fx = Number(px) / Number(Q), fy = Number(py) / Number(Q);
    const onCont = rects.some((r) => kindOf(r) !== 'point' && pointInRect(r, fx, fy));
    const isBreak = gx.indexOf(px) % 2 === 0 && gy.indexOf(py) % 2 === 0;
    if (isBreak && !onCont) check('E4 list-sound-complete', nes.some((n) => n.x === fx && n.y === fy), `${gs} unlisted (${fx}, ${fy})`);
  }

  // E5 display-honest: the mixed label's digits sit within half a unit of the exact value, and a
  // sub-resolution phrase appears exactly when the exact value is not 0/1 but rounds onto it.
  if (mn) for (const [r, shown] of [[x!, fmtProb(mn.x)], [y!, fmtProb(mn.y)]] as const) {
    const lt = 2000n * r.n < r.d, gt = 2000n * r.n > 1999n * r.d;
    if (shown === 'less than 0.001') check('E5 display-honest', 2000n * r.n <= r.d, `${gs} "${shown}" for ${floatOf(r)}`);
    else if (shown === 'more than 0.999') check('E5 display-honest', 2000n * r.n >= 1999n * r.d, `${gs} "${shown}" for ${floatOf(r)}`);
    else {
      const S = BigInt(Math.round(Number(shown) * 1000));
      const err = S * r.d - 1000n * r.n;
      check('E5 display-honest', !lt && !gt && 2n * (err < 0n ? -err : err) <= r.d, `${gs} "${shown}" for ${floatOf(r)}`);
    }
    check('E5 display-honest', nes.some((n) => n.type === 'mixed' && n.label === `Mixed NE (x*=${fmtProb(mn.x)}, y*=${fmtProb(mn.y)})`), `${gs} label`);
  }

  if (!heavy) return;
  // E6 briefing-words-exact: a fraction word is attached only to an exactly equal root, and the
  // digits printed beside it are that fraction's digits (F3: "y = 0.5005 (a half)").
  const brief = geometryBriefing(g);
  for (const hit of brief.matchAll(/(-?\d+(?:\.\d+)?) \(([a-z-]+(?: [a-z-]+)?)\)/g)) {
    const w = WORDS.find(([, , word]) => word === hit[2]);
    if (!w) continue;
    const exactHere = [x, y].some((r) => r && r.n * BigInt(w[1]) === BigInt(w[0]) * r.d);
    wordHits++;
    check('E6 briefing-words-exact', exactHere && fmtProb(w[0] / w[1]) === hit[1],
      `${gs} briefing "${hit[0]}"`);
  }
  // E7 payload-agrees: the grounding payload states the mixed point with the panel's own digits.
  if (mn && !rects.some((r) => kindOf(r) !== 'point')) {
    const pl = buildGroundingPayload(g);
    payloadHits++;
    check('E7 payload-agrees', pl.includes(`x=${fmtProb(floatOf(x!))}, y=${fmtProb(floatOf(y!))}`), `${gs} payload`);
  }
}

// ── fixtures: the defects this file was built on (each must be IN its class) ──
const F1: GamePayoffs = { a11: 0.2, a12: -0.1, a21: -0.1, a22: 0.7, b11: 0.2, b12: 0.2, b21: -0.1, b22: 0.1 };
const F2a: GamePayoffs = { a11: 0.05, a12: 0.1, a21: 0.1, a22: -0.01, b11: 0.03, b12: -0.06, b21: -0.06, b22: 0 };
const F2b: GamePayoffs = { a11: 0.08, a12: -0.07, a21: -0.03, a22: -0.02, b11: 0.07, b12: -0.09, b21: -0.09, b22: -0.05 };
const F3: GamePayoffs = { a11: 0.999, a21: 0, a12: -1.001, a22: 0, b11: 1, b12: 0, b21: 0, b22: 1 };
// Preconditions that keep the fixtures from passing by coincidence.
check('fixture F1: B root is exactly x = 1 (b11 == b12)', rootsOf(F1).x!.n === rootsOf(F1).x!.d);
check('fixture F1: the old float quotient is NOT 1', (F1.b22 - F1.b21) / (F1.b11 - F1.b21 - F1.b12 + F1.b22) !== 1);
check('fixture F2a: exact y* = 11/16 and the old quotient misrounds it',
  floatOf(rootsOf(F2a).y!) === 0.6875 && (F2a.a22 - F2a.a12) / (F2a.a11 - F2a.a12 - F2a.a21 + F2a.a22) !== 0.6875);
check('fixture F2b: exact y* = 5/16 and the old quotient misrounds it',
  floatOf(rootsOf(F2b).y!) === 0.3125 && (F2b.a22 - F2b.a12) / (F2b.a11 - F2b.a12 - F2b.a21 + F2b.a22) !== 0.3125);
check('fixture F3: A root 0.5005 is within the old 5e-4 word window of 1/2', Math.abs(floatOf(rootsOf(F3).y!) - 0.5) < 5e-4);
// The defects themselves, verbatim.
check('F1 no mixed NE at a boundary root', !computeAllNE(F1).some((n) => n.type === 'mixed'),
  computeAllNE(F1).map((n) => n.label).join(' | '));
check('F2 panel label and converged box print one y*', computeAllNE(F2a).some((n) => n.label === 'Mixed NE (x*=0.4, y*=0.688)')
  && computeAllNE(F2b).some((n) => /y\*=0\.313\)/.test(n.label)), computeAllNE(F2a).map((n) => n.label).join(' | '));
check('F3 briefing never prints "0.5005 (a half)"', !geometryBriefing(F3).includes('0.5005 (a half)')
  && geometryBriefing(F3).includes(`y = ${fmtProb(0.5005)} —`), geometryBriefing(F3));
for (const g of [F1, F2a, F2b, F3]) checkGame(g, true);

// ── sweep ─────────────────────────────────────────────────────────────────────
const N = Number(process.env.MATHEXACT_N ?? 6000);   // per kind
let games = 0, mixed = 0, continua = 0, boundary = 0;
for (const [kind, cell] of Object.entries(KINDS)) {
  for (let i = 0; i < N; i++) {
    const g = Object.fromEntries(K.map((k) => [k, cell()])) as unknown as GamePayoffs;
    const { x, y } = rootsOf(g);
    if (computeMixedNE(g)) mixed++;
    if (equilibriumSet(g).some((r) => kindOf(r) !== 'point')) continua++;
    if ([x, y].some((r) => r && (r.n === 0n || r.n === r.d))) boundary++;
    checkGame(g, i % 8 === 0);
    games++;
    void kind;
  }
}
// Reach: the sweep must actually exercise each class, or a pass means nothing.
check('reach: mixed equilibria exercised', mixed > games / 20, `${mixed}/${games}`);
check('reach: continua exercised', continua > games / 20, `${continua}/${games}`);
check('reach: exact boundary roots exercised (the F1 class)', boundary > 200, `${boundary}`);
check('reach: briefing fraction words exercised (E6)', wordHits > 100, `${wordHits}`);
check('reach: grounding payload mixed points exercised (E7)', payloadHits > 100, `${payloadHits}`);

const failed = Object.keys(fails);
if (failed.length) {
  for (const k of failed) console.error(`  ✗ ${k}: ${fails[k]} failure(s); first: ${firstFail[k]}`);
  process.exit(1);
}
console.log(`✓ mathexact: ${checks} checks over ${games} games (${mixed} mixed, ${continua} continua, ${boundary} boundary roots, ${wordHits} fraction words, ${payloadHits} payloads) agree with the exact rational oracle`);

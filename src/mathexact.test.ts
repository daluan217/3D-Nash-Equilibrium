/**
 * Exact-rational oracle for the solver (math-loop-22). Payoffs ship as 3dp (commitPayoffInput,
 * server cleanPayoffs), so ×1000 makes every quantity an integer and BigInt decides each
 * question exactly. Fixtures F1–F3 are the defects this file was built on; each names the
 * check that caught it. Sweep sizes are fixed seeds, so a pass is reproducible, not luck.
 *
 *   npx tsx src/mathexact.test.ts
 */
import { computeAllNE, computeMixedNE, equilibriumSet, pointInRect, kindOf, fmtProb, indifferenceRoot,
  EA, EB, fmtPayoff, payoffTexRhs, formatConvergenceLogLine, commitStartCoordinate, parseNumericInput, r3, commitPayoffs } from './utils/gameEngine';
import { readFileSync } from 'node:fs';
import { neValues, indifferenceLines } from './components/equilibriumPanel';
import { tieProse } from './utils/tieProse';
import { describeGeometry, geometryBriefing } from './utils/geometry';
import { buildGroundingPayload } from './utils/report';
import { validateProseDirections } from './utils/nashValidator';
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

// ── exact payoff display (E9) ────────────────────────────────────────────────
type Q = [bigint, bigint];
type Q2 = { n: bigint; d: bigint };
/** fmtPayoff's reading of n/d: "0" iff zero, a phrase iff it rounds to 0, else 3dp (both roundings at an exact half). */
function exactShown(n: bigint, d: bigint): string[] {
  if (n === 0n) return ['0'];
  const t = 1000n * n, fl = t / d - (t % d < 0n ? 1n : 0n), rem = t - fl * d;
  return (2n * rem < d ? [fl] : 2n * rem > d ? [fl + 1n] : [fl, fl + 1n])
    .map((r) => r === 0n ? (n > 0n ? 'less than 0.001' : 'greater than -0.001') : (Number(r) / 1000).toFixed(3));
}
/** Exact payoff of player p at (xn/xd, yn/yd) over milli cells m, and its display options. */
function exactPay(m: Record<(typeof K)[number], bigint>, p: 'a' | 'b', [xn, xd]: Q, [yn, yd]: Q): [Q2, string[]] {
  const c = (k: string) => m[`${p}${k}` as (typeof K)[number]];
  const n = xn * yn * c('11') + xn * (yd - yn) * c('12') + (xd - xn) * yn * c('21') + (xd - xn) * (yd - yn) * c('22');
  return [{ n, d: xd * yd * 1000n }, exactShown(n, xd * yd * 1000n)];
}
const tex = (s: string) => s === '0' ? '= 0' : s === 'less than 0.001' ? '< 0.001' : s === 'greater than -0.001' ? '> -0.001' : `= ${s}`;
/** The bilinear form as plain float arithmetic: the dust F10 printed. */
const rawE = (x: number, y: number, g: GamePayoffs, p: 'a' | 'b') => {
  const c = (k: string) => g[`${p}${k}` as keyof GamePayoffs];
  return x * y * c('11') + x * (1 - y) * c('12') + (1 - x) * y * c('21') + (1 - x) * (1 - y) * c('22');
};
const e9 = { dust: 0, sub: 0, mid: 0, prose: 0 };
/** fmtProb's reading of n/d (0 < n/d < 1): a phrase at the ends, else 3dp without trailing zeros (both at a half). */
function probShown(n: bigint, d: bigint): string[] {
  const t = 1000n * n, fl = t / d, rem = t - fl * d;
  return (2n * rem < d ? [fl] : 2n * rem > d ? [fl + 1n] : [fl, fl + 1n])
    .map((r) => r === 0n ? 'less than 0.001' : r === 1000n ? 'more than 0.999' : String(Number(r) / 1000));
}
const e11 = { half: 0, echo: 0 };
const ECHO = ['A plays Hold with probability P and Fold with probability Q.', 'B plays Raise with probability P and Call with probability Q.'];
const ECHO_L = { row1: 'Hold', row2: 'Fold', col1: 'Raise', col2: 'Call' };

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

  // E8 set-shape: the components are maximal and distinct, and each is named by its exact dimension
  // (endpoints are exact roots per E1, so == on floats is exact here; NE_EPS must not blur a 3dp root).
  rects.forEach((r, i) => {
    const w = r.x1 > r.x0, h = r.y1 > r.y0;
    check('E8 set-shape: kindOf is the exact dimension', kindOf(r) === (w && h ? 'area' : w || h ? 'segment' : 'point'), `${gs} ${JSON.stringify(r)} ${kindOf(r)}`);
    check('E8 set-shape: no component is a duplicate of, or inside, another', !rects.some((o, j) => j !== i
      && o.x0 <= r.x0 && o.x1 >= r.x1 && o.y0 <= r.y0 && o.y1 >= r.y1), `${gs} ${JSON.stringify(rects)}`);
  });

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

  // E9 payoff-display-exact (F10): every payoff printed at a point the app holds exactly — a listed NE,
  // a continuum endpoint or midpoint — is the exact payoff's display: "0" iff it is exactly 0.
  const ratAt = (v: number, r: typeof x): Q | null => v === 0 ? [0n, 1n] : v === 1 ? [1n, 1n] : r && v === floatOf(r) ? [r.n, r.d] : null;
  const pts: { px: number; py: number; rx: Q; ry: Q; ne?: (typeof nes)[number]; mid?: boolean }[] = [];
  for (const ne of nes) {
    const rx = ratAt(ne.x, x), ry = ratAt(ne.y, y);
    check('E9 payoff-display-exact', !!rx && !!ry, `${gs} ${ne.label} is not at an exact root`);
    if (rx && ry) pts.push({ px: ne.x, py: ne.y, rx, ry, ne });
  }
  for (const r of rects) if (kindOf(r) !== 'point') {
    const [x0, x1, y0, y1] = [ratAt(r.x0, x), ratAt(r.x1, x), ratAt(r.y0, y), ratAt(r.y1, y)];
    if (!x0 || !x1 || !y0 || !y1) { check('E9 payoff-display-exact', false, `${gs} continuum endpoint off its root`); continue; }
    const mid = (a: Q, b: Q): Q => [a[0] * b[1] + b[0] * a[1], 2n * a[1] * b[1]];
    // The midpoint is the tie paragraph's point; the panel only ever shows resolveProfile's output
    // (0, 1, a root, or a 3dp grid point), so its lines are checked at the nearest such grid point.
    const gx = Math.min(r.x1, Math.max(r.x0, Math.round((r.x0 + r.x1) * 500) / 1000)), gy = Math.min(r.y1, Math.max(r.y0, Math.round((r.y0 + r.y1) * 500) / 1000));
    const grid = (v: number, lo: number, hi: number, qlo: Q, qhi: Q): Q => v === lo ? qlo : v === hi ? qhi : [BigInt(Math.round(v * 1000)), 1000n];
    pts.push({ px: r.x0, py: r.y0, rx: x0, ry: y0 }, { px: r.x1, py: r.y1, rx: x1, ry: y1 },
      { px: (r.x0 + r.x1) / 2, py: (r.y0 + r.y1) / 2, rx: mid(x0, x1), ry: mid(y0, y1), mid: true },
      { px: gx, py: gy, rx: grid(gx, r.x0, r.x1, x0, x1), ry: grid(gy, r.y0, r.y1, y0, y1) });
    e9.mid++;
  }
  for (const { px, py, rx, ry, ne, mid } of pts) {
    const [nA, wA] = exactPay(m, 'a', rx, ry), [nB, wB] = exactPay(m, 'b', rx, ry);
    const eA = EA(px, py, g), eB = EB(px, py, g), at = `${gs} at (${px}, ${py})`;
    for (const [n, raw] of [[nA, rawE(px, py, g, 'a')], [nB, rawE(px, py, g, 'b')]] as const) {
      if (n.n === 0n && raw !== 0) e9.dust++;
      if (n.n !== 0n && Math.abs(Number(n.n) / Number(n.d)) < 5e-4) e9.sub++;
    }
    check('E9 payoff-display-exact: fmtPayoff(EA/EB)', wA.includes(fmtPayoff(eA)) && wB.includes(fmtPayoff(eB)),
      `${at}: "${fmtPayoff(eA)}"/"${fmtPayoff(eB)}" want ${wA}/${wB}`);
    check('E9 payoff-display-exact: headline payoffTexRhs', wA.map(tex).includes(payoffTexRhs(eA)) && wB.map(tex).includes(payoffTexRhs(eB)),
      `${at}: "${payoffTexRhs(eA)}" want ${wA.map(tex)}`);
    const log = formatConvergenceLogLine(g, px, py, true, eA, eB, 0).match(/E\[A\]=(.+?)  E\[B\]=(.+)$/);
    check('E9 payoff-display-exact: convergence log', !!log && wA.includes(log[1]) && wB.includes(log[2]), `${at}: ${log?.[0]}`);
    if (ne) { const v = neValues(ne, g); check('E9 payoff-display-exact: NE list', wA.includes(v.a) && wB.includes(v.b), `${at}: ${v.a}/${v.b}`); }
    // Panel lines: an ≈ line states the point's own payoff; a strict side prints all zeros iff it is exactly 0.
    if (mid) continue;
    const L = indifferenceLines(g, px, py);
    for (const [l, w, rowP, rowQ] of [[L.a, wA, exactPay(m, 'a', [1n, 1n], ry)[0], exactPay(m, 'a', [0n, 1n], ry)[0]],
      [L.b, wB, exactPay(m, 'b', rx, [1n, 1n])[0], exactPay(m, 'b', rx, [0n, 1n])[0]]] as const) {
      check('E9 payoff-display-exact: panel line p / q are 0 iff the exact row payoff is 0', (l.p === 0) === (rowP.n === 0n) && (l.q === 0) === (rowQ.n === 0n),
        `${at}: p=${l.p} q=${l.q}`);
      if (l.indifferent) check('E9 payoff-display-exact: panel ≈ line', [...w.map(tex), ...(w[0] === '0' ? ['\\approx 0'] : [])].includes(`${l.pRel} ${l.pStr}`), `${at}: ${l.tex}`);
      else check('E9 payoff-display-exact: panel strict side is all zeros iff exactly 0', [[l.pStr, rowP], [l.qStr, rowQ]].every(([s, e]) =>
        /^0(\.0+)?$/.test(s as string) === ((e as Q2).n === 0n) && !/^-0(\.0+)?$/.test(s as string)), `${at}: ${l.tex}`);
    }
  }

  // E7 payload-agrees: the grounding payload states the mixed point with the panel's own digits.
  if (mn && !rects.some((r) => kindOf(r) !== 'point')) {
    const pl = buildGroundingPayload(g);
    payloadHits++;
    check('E7 payload-agrees', pl.includes(`x=${fmtProb(floatOf(x!))}, y=${fmtProb(floatOf(y!))}`), `${gs} payload`);
    // E11 payload-split-sums: each player's "option 1 P and option 2 Q" is a correct display of the exact
    // root and its complement, AND the printed pair sums to 1 (F13: "0.063 and 0.938" at x* = 1/16).
    const sp = /plays Row 1 with probability (.+?) and Row 2 with probability (.+?); B plays Col 1 with probability (.+?) and Col 2 with probability (.+)$/m.exec(pl);
    check('E11 payload-split-sums: the payload spells out both splits', !!sp, `${gs} payload`);
    for (const [r, p, q, say] of sp ? [[x!, sp[1], sp[2], ECHO[0]], [y!, sp[3], sp[4], ECHO[1]]] as const : []) {
      const pm = p.includes('than') ? null : Math.round(Number(p) * 1000), qm = q.includes('than') ? null : Math.round(Number(q) * 1000);
      if (2n * ((1000n * r.n) % r.d) === r.d) e11.half++;
      check('E11 payload-split-sums: option 2 is a correct display of the exact complement',
        probShown(r.d - r.n, r.d).includes(q) && p === fmtProb(floatOf(r)), `${gs} "${p}" / "${q}"`);
      check('E11 payload-split-sums: the two printed probabilities sum to 1',
        pm !== null && qm !== null ? pm + qm === 1000 : (p === 'less than 0.001') === (q === 'more than 0.999'), `${gs} "${p}" + "${q}"`);
      if (heavy && pm !== null && qm !== null) {
        e11.echo++;
        const echo = validateProseDirections(say.replace('P', p).replace('Q', q), ECHO_L, g);
        check('E11 payload-split-sums: echoing the payload split verbatim passes the validator', !echo.some((i) => i.includes('sum to')), `${gs} ${echo}`);
      }
    }
  }

  if (!heavy) return;
  // E9 continued: the tie paragraph's "at a representative point" payoffs (set[0]'s midpoint).
  const rep = rects[0], rp = rep && pts.find((p) => p.px === (rep.x0 + rep.x1) / 2 && p.py === (rep.y0 + rep.y1) / 2);
  if (rp) {
    const sent = tieProse(g).match(/E\[A\] = (.+?) and E\[B\] = (.+?)\.\s*$/);
    const prose = (s: string) => /^-?\d+\.\d+$/.test(s) ? s.replace(/\.?0+$/, '') : s;
    check('E9 payoff-display-exact: tie paragraph', !!sent && exactPay(m, 'a', rp.rx, rp.ry)[1].map(prose).includes(sent[1])
      && exactPay(m, 'b', rp.rx, rp.ry)[1].map(prose).includes(sent[2]), `${gs} "${sent?.[0]}"`);
    e9.prose++;
  }
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
// F10: an EXACT zero payoff printed as "less than 0.001" (float dust from the bilinear form).
const F10: GamePayoffs = { a11: -3, a12: 6, a21: -2, a22: 4, b11: -7, b12: -6, b21: 7, b22: 2 };   // y* = 2/3: (2/3)(-3)+(1/3)6 = 0
const F10b: GamePayoffs = { a11: 1, a12: 1, a21: 3, a22: 1, b11: -1, b12: -2, b21: -1, b22: 1 };  // segment x∈[0,2/3], y=0: E[B] = 2x−1·… = 0 at x=1/3
const F10c: GamePayoffs = { a11: -2, a12: 3, a21: -1, a22: -1, b11: 1, b12: 1, b21: 0, b22: 2 };  // endpoint (1, 0.6): 0.6(−2)+0.4(3) = 0
const m10 = computeAllNE(F10).find((n) => n.type === 'mixed')!;
check('fixture F10: mixed NE (5/6, 2/3), raw float E[A] is dust, not 0', m10.x === 5 / 6 && m10.y === 2 / 3 && rawE(m10.x, m10.y, F10, 'a') !== 0);
check('fixture F10b: the tie paragraph\'s representative point (1/3, 0) carries dust in E[B]', rawE(1 / 3, 0, F10b, 'b') !== 0
  && equilibriumSet(F10b).length === 1 && equilibriumSet(F10b)[0].x1 === 2 / 3 && equilibriumSet(F10b)[0].y1 === 0);
check('fixture F10c: (1, 0.6) is on the continuum and Row 1 carries dust', rawE(1, 0.6, F10c, 'a') !== 0
  && equilibriumSet(F10c).some((r) => pointInRect(r, 1, 0.6)));
check('F10 verbatim: NE list, headline, log and panel print E[A]=0 at the mixed NE, never "less than 0.001"',
  neValues(m10, F10).a === '0' && payoffTexRhs(EA(m10.x, m10.y, F10)) === '= 0'
  && formatConvergenceLogLine(F10, m10.x, m10.y, true, EA(m10.x, m10.y, F10), EB(m10.x, m10.y, F10), 0) === '━━ Mixed NE: x=0.833, y=0.667  E[A]=0  E[B]=-4.667'
  && indifferenceLines(F10, m10.x, m10.y).a.tex === '\\mathbb{E}[\\text{Row 1}] = 0 \\approx \\mathbb{E}[\\text{Row 2}] = 0',
  `${neValues(m10, F10).a} | ${indifferenceLines(F10, m10.x, m10.y).a.tex}`);
check('F10 verbatim: tie paragraph "E[A] = 1 and E[B] = 0." at the representative point, never "less than 0.001"',
  tieProse(F10b).endsWith('the expected payoffs are E[A] = 1 and E[B] = 0.'), tieProse(F10b).slice(-80));
check('F10 verbatim: continuum endpoint (1, 0.6) headline "= 0" and panel Row 1 "0.000" (exact)',
  payoffTexRhs(EA(1, 0.6, F10c)) === '= 0' && indifferenceLines(F10c, 1, 0.6).a.tex === '\\mathbb{E}[\\text{Row 1}] = 0.000 > \\mathbb{E}[\\text{Row 2}] = -1.000',
  indifferenceLines(F10c, 1, 0.6).a.tex);
// F13: B indifferent at x* = 1/(9+6+1) = 1/16 = 0.0625, an exact half-thousandth, so x and 1 - x both
// rounded up and the payload said "0.063 and 0.938"; the validator rejected that echo as summing to 1.001.
const F13: GamePayoffs = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 9, b12: -6, b21: 0, b22: 1 };
check('fixture F13: exact x* = 1/16 and 1 - x* rounds half-up past the complement',
  rootsOf(F13).x!.n * 16n === rootsOf(F13).x!.d && fmtProb(1 - 0.0625) === '0.938' && fmtProb(0.0625) === '0.063');
check('F13 verbatim: the payload splits A as 0.063 / 0.937, never 0.063 / 0.938',
  buildGroundingPayload(F13).includes('A plays Row 1 with probability 0.063 and Row 2 with probability 0.937;')
  && !buildGroundingPayload(F13).includes('0.938'), buildGroundingPayload(F13));
for (const g of [F1, F2a, F2b, F3, F10, F10b, F10c, F13]) checkGame(g, true);
// F14: E[A] = 1 - 3x for any y. The float of a typed "0.3333333333333333" is within 2^-50 of 1/3, so EA
// read it as 1/3 and the readout printed "0" for a payoff that is not zero.
const F14: GamePayoffs = { a11: -2, a12: -2, a21: 1, a22: 1, b11: 0, b12: 0, b21: 0, b22: 0 };
check('fixture F14: the unquantised typed float is the one EA reads as exactly 1/3',
  EA(parseNumericInput('0.3333333333333333')!, 0.5, F14) === 0);
check('F14 verbatim: typed x0 "0.3333333333333333" reads E[A] = less than 0.001, never 0',
  fmtPayoff(EA(commitStartCoordinate('0.3333333333333333'), 0.5, F14)) === 'less than 0.001',
  fmtPayoff(EA(commitStartCoordinate('0.3333333333333333'), 0.5, F14)));
const e12 = { typed: 0, preFix: 0, zero: 0 };
// E1b edge-cross (sweep 7): every 4-cell combination of the range-edge, tie and near-zero thousandths
// through the cell door. The root is -d2/(d1 - d2) in whole thousandths, and a mixed NE is listed iff it
// is strictly inside (0, 1): 390,625 games, about 30,000 of them with the root exactly ON 0 or 1.
{
  const r1b = mulberry(0xe1b), cells = [-100, -99.999, -99.998, -50.001, -33.333, -1, -0.002, -0.001, 0, 0.001, 0.002, 0.5, 33.333, 66.667, 99.998, 99.999, 100];
  for (let i = 0; i < 8; i++) cells.push(Math.round(r1b() * 200000 - 100000) / 1000);
  const reach = { games: 0, interior: 0, onEdge: 0 }, ms = (v: number) => Math.round(v * 1000);
  for (const a11 of cells) for (const a21 of cells) for (const a12 of cells) for (const a22 of cells) {
    const g = commitPayoffs({ a11, a21, a12, a22, b11: a11, b12: a21, b21: a12, b22: a22 });   // B mirrors A: x* = y*
    const d2 = ms(g.a12) - ms(g.a22), den = ms(g.a11) - ms(g.a21) - d2, want = den === 0 ? NaN : -d2 / den, inside = want > 0 && want < 1;
    const got = indifferenceRoot(g.a11 - g.a21, g.a12 - g.a22), mn = computeMixedNE(g);
    reach.games++; if (inside) reach.interior++; if (want === 0 || want === 1) reach.onEdge++;
    check('E1b edge-cross: the root is the exact thousandths quotient, NaN when level', Number.isNaN(want) ? Number.isNaN(got) : got === want, `${JSON.stringify(g)} got ${got} want ${want}`);
    check('E1b edge-cross: a mixed NE is listed iff the root is strictly inside (0, 1), at that root', !!mn === inside && (!mn || (mn.x === want && mn.y === want)), `${JSON.stringify(g)} ${JSON.stringify(mn)} want ${want}`);
  }
  check('E1b reach: the full edge cross product, interior roots and roots exactly on the square\'s edge', reach.games === 25 ** 4 && reach.interior >= 100000 && reach.onEdge >= 10000, JSON.stringify(reach));
}
// E12 typed-start: whatever is typed, the start coordinate held is a plain decimal of at most 6 places
// (what the box shows after blur), and EA/EB at it are 0 iff the payoff at THAT decimal is exactly 0.
{
  const r12 = mulberry(0xe12);
  const decQ = (s: string): Q => { const [i, f = ''] = s.split('.'); return [BigInt(i + f), 10n ** BigInt(f.length)]; };
  const QS = [2, 3, 7, 9, 11, 13, 16, 64, 125, 625, 999, 1000, 1024, 3125, 4096, 99999, 100000];
  for (let i = 0; i < 6000; i++) {
    const q = i % 3 ? QS[i % QS.length] : 2 + Math.floor(r12() * 99999), p = 1 + Math.floor(r12() * (q - 1));
    const lo = (p - q) / 1000, hi = p / 1000;   // E_A(x) = (p - xq)/1000 and E_B(y) = (p - yq)/1000: zero at p/q
    const g: GamePayoffs = { a11: lo, a12: lo, a21: hi, a22: hi, b11: lo, b12: hi, b21: lo, b22: hi };
    const mm = rootsOf(g).m, other = BigInt(Math.floor(r12() * 1001));
    for (const S of [String(p / q), ...[3, 4, 5, 6, 7, 9, 12, 15].map((k) => (p / q).toFixed(k))]) {
      const c = commitStartCoordinate(S), box = String(c), t = parseNumericInput(S)!;
      e12.typed++;
      if (EA(t, 0.5, g) === 0 && exactPay(mm, 'a', decQ(S), [1n, 2n])[0].n !== 0n) e12.preFix++;
      check('E12 typed-start: the held coordinate is a plain decimal of at most 6 places', /^(0|1|0\.\d{1,6})$/.test(box), `${S} -> ${box}`);
      if (!/^\d\.?\d*$/.test(box)) { check('E12 typed-start: the held coordinate prints as a plain decimal', false, box); continue; }
      for (const p2 of ['a', 'b'] as const) {
        const [ex, shown] = p2 === 'a' ? exactPay(mm, 'a', decQ(box), [other, 1000n]) : exactPay(mm, 'b', [other, 1000n], decQ(box));
        const v = p2 === 'a' ? EA(c, Number(other) / 1000, g) : EB(Number(other) / 1000, c, g);
        if (ex.n === 0n) e12.zero++;
        check('E12 typed-start: EA/EB at a typed start are 0 iff the payoff at the held decimal is exactly 0',
          (v === 0) === (ex.n === 0n) && shown.includes(fmtPayoff(v)), `${p}/${q} typed ${S} held ${box} ${p2}: ${v} "${fmtPayoff(v)}" want ${shown}`);
      }
    }
  }
  // Odd typed shapes (sweep 7): the box App writes back after blur is a fixed point of the door, in [0, 1].
  const appBox = (c: number) => (c === r3(c) ? c.toFixed(3) : String(c));   // App.tsx commitStartField, verbatim
  check('E12 the box text is App.tsx\'s own expression', readFileSync(new URL('./App.tsx', import.meta.url), 'utf8').includes('committed === r3(committed) ? committed.toFixed(3) : String(committed)'));
  for (const S of ['1e-7', '5e-7', '4.9999999e-7', '0.0000015', '0.9999995', '0.99999949', '1.0000001', '-0', '-0.0000001', '.5', ' 0.3 ',
    '0.3333335', '0.1234565', '1E-3', '0x1', 'Infinity', '', '1/3', '0,5', '2', '-2', '1e400', '1e-400', '9.99999e-7', '0.' + '9'.repeat(30)]) {
    const c = commitStartCoordinate(S), b = appBox(c);
    check('E12 typed-start: any typed text holds a value in [0, 1] whose box re-commits to itself',
      c >= 0 && c <= 1 && !Object.is(c, -0) && /^[01](\.\d{1,6})?$/.test(b) && commitStartCoordinate(b) === c, `${JSON.stringify(S)} -> ${c} box ${b}`);
  }
  check('E12 reach: typed floats the unquantised door read as an exact root (the F14 class), and exact roots typed',
    e12.preFix >= 1000 && e12.zero >= 500, JSON.stringify(e12));
}
// E10 zero-iff-exact: at every coordinate the app holds (0, 1, the 3dp grid, the game's own roots and
// their midpoints), EA/EB are 0 exactly when the exact payoff is 0, and a genuinely nonzero payoff below
// the 1e-9 dust band (±0.001 cells at roots near 5e-6) is never zeroed.
{
  const r10 = mulberry(0xe10), K3 = [-100, -99.999, -1, -0.001, 0, 0, 0.001, 1, 99.999, 100];
  const reach = { pts: 0, dustZero: 0, tinyNonzero: 0 };
  const mid = (a: Q, b: Q): Q => [a[0] * b[1] + b[0] * a[1], 2n * a[1] * b[1]];
  for (let i = 0; i < 12000; i++) {
    const g = Object.fromEntries(K.map((k) => [k, K3[Math.floor(r10() * K3.length)]])) as unknown as GamePayoffs;
    const { m: mm, x: rx, y: ry } = rootsOf(g);
    const held = (r: typeof rx): Q[] => {
      const base: Q[] = [[0n, 1n], [1n, 1n], [1n, 1000n], [999n, 1000n], [BigInt(Math.floor(r10() * 1001)), 1000n]];
      if (interior(r)) base.push([r!.n, r!.d], mid([0n, 1n], [r!.n, r!.d]), mid([r!.n, r!.d], [1n, 1n]));
      return base;
    };
    for (const qx of held(rx)) for (const qy of held(ry)) {
      const x = Number(qx[0]) / Number(qx[1]), y = Number(qy[0]) / Number(qy[1]);
      for (const p of ['a', 'b'] as const) {
        const [ex, shown] = exactPay(mm, p, qx, qy), v = p === 'a' ? EA(x, y, g) : EB(x, y, g), raw = rawE(x, y, g, p);
        reach.pts++;
        if (ex.n === 0n && raw !== 0) reach.dustZero++;
        if (ex.n !== 0n && Math.abs(raw) < 1e-9) reach.tinyNonzero++;
        check('E10 zero-iff-exact: EA/EB are 0 iff the exact payoff is 0', (v === 0) === (ex.n === 0n) && shown.includes(fmtPayoff(v)),
          `${JSON.stringify(g)} ${p} at ${qx[0]}/${qx[1]}, ${qy[0]}/${qy[1]}: ${v} "${fmtPayoff(v)}" want ${shown}`);
      }
    }
  }
  check('E10 reach: exact zeros under dust and nonzero payoffs below the 1e-9 band both occurred',
    reach.dustZero >= 1000 && reach.tinyNonzero >= 200, JSON.stringify(reach));
}
// E10b snap width (sweep 7): EA reads a float as the rational p/d (d <= 1e6) within 2^-50 and no wider.
// Cells -(d-p)/1000, p/1000 make the payoff (p - d x)/1000, zero only at p/d, so at a float x offset
// from p/d, EA is 0 iff |x - p/d| <= 2^-50 (exact BigInt distance); offsets 2^-53..2^-40 straddle it.
{
  const rb = mulberry(0xe10b), reach = { snapped: 0, keptNear: 0 };
  const bin = (v: number): Q => { let d = 1n; while (!Number.isInteger(v)) { v *= 2; d *= 2n; } return [BigInt(v), d]; };
  for (let i = 0; i < 20000; i++) {
    const d = 1000 + Math.floor(rb() * 199000), p = 1 + Math.floor(rb() * (d - 1));
    if (d - p > 100000 || p > 100000) continue;
    const g = { a11: -(d - p) / 1000, a12: -(d - p) / 1000, a21: p / 1000, a22: p / 1000, b11: 0, b12: 0, b21: 0, b22: 0 }, y = Math.round(rb() * 1000) / 1000;
    for (const e of [53, 52, 51, 50, 49, 48, 46, 44, 40]) for (const sg of [1, -1]) {
      const x = p / d + sg * 2 ** -e, [xn, xd] = bin(x), dist = xn * BigInt(d) - BigInt(p) * xd, near = (dist < 0n ? -dist : dist) * 2n ** 50n <= xd * BigInt(d);
      if (!(x > 0 && x < 1)) continue;
      if (near && dist !== 0n) reach.snapped++; if (!near && (dist < 0n ? -dist : dist) * 2n ** 44n <= xd * BigInt(d)) reach.keptNear++;
      check('E10b a float reads as p/d only within 2^-50 of it: EA is 0 iff |x - p/d| <= 2^-50', (EA(x, y, g) === 0) === near, `${p}/${d} ${sg}2^-${e} x=${x}: ${EA(x, y, g)}`);
    }
  }
  check('E10b reach: off-rational floats inside the snap and nonzero payoffs just outside it both occurred', reach.snapped >= 5000 && reach.keptNear >= 5000, JSON.stringify(reach));
}

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
// Exhaustive: EVERY game over three 3-value alphabets (unit, ±0.001 band edge, ±100 range edge), so
// each tie / level / edge-root shape is present by construction, not by the seed's luck.
let shapes = 0;
for (const alpha of [[-1, 0, 1], [-0.001, 0, 0.001], [-100, 0.001, 100]]) for (let c = 0; c < 6561; c++) {
  let t = c;
  const g = Object.fromEntries(K.map((k) => { const v = alpha[t % 3]; t = Math.floor(t / 3); return [k, v]; })) as unknown as GamePayoffs;
  if (equilibriumSet(g).length > 1) shapes++;
  checkGame(g, false);
}
check('reach: exhaustive alphabets ran with multi-component sets', shapes > 5000, `${shapes}`);
// Constructed: every half-thousandth root p/2000 (p odd) on each axis, x* = b22/(b11+b22), y* = a22/(a11+a22).
for (let p = 1; p < 2000; p += 2) {
  const jm = 2 * ((p * 7) % 1000) + 1, k = (2000 - p) / 1000, q = p / 1000, j = (2000 - jm) / 1000, jq = jm / 1000;
  checkGame({ a11: j, a12: 0, a21: 0, a22: jq, b11: k, b12: 0, b21: 0, b22: q }, p % 16 === 1);
  checkGame({ a11: k, a12: 0, a21: 0, a22: q, b11: 1, b12: 0, b21: 0, b22: 1 }, p % 16 === 9);
}
// Reach: the sweep must actually exercise each class, or a pass means nothing.
check('reach: mixed equilibria exercised', mixed > games / 20, `${mixed}/${games}`);
check('reach: continua exercised', continua > games / 20, `${continua}/${games}`);
check('reach: exact boundary roots exercised (the F1 class)', boundary > 200, `${boundary}`);
check('reach: briefing fraction words exercised (E6)', wordHits > 100, `${wordHits}`);
check('reach: grounding payload mixed points exercised (E7)', payloadHits > 100, `${payloadHits}`);
check('reach: E11 exact half-thousandth roots (the F13 class) and validator echoes', e11.half >= 50 && e11.echo >= 500, JSON.stringify(e11));
check('reach: E9 exact zeros under float dust, nonzero sub-resolution payoffs, continuum midpoints and tie paragraphs',
  e9.dust >= 150 && e9.sub >= 1000 && e9.mid >= 10000 && e9.prose >= 1000, JSON.stringify(e9));

const failed = Object.keys(fails);
if (failed.length) {
  for (const k of failed) console.error(`  ✗ ${k}: ${fails[k]} failure(s); first: ${firstFail[k]}`);
  process.exit(1);
}
console.log(`✓ mathexact: ${checks} checks over ${games} games (${mixed} mixed, ${continua} continua, ${boundary} boundary roots, ${wordHits} fraction words, ${payloadHits} payloads, E9 ${JSON.stringify(e9)}, E11 ${JSON.stringify(e11)}, E12 ${JSON.stringify(e12)}) agree with the exact rational oracle`);

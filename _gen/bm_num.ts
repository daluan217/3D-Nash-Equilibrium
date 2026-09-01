/**
 * BLUE-MATH's OWN measurement of the tieProse section-4 payoff formatter.
 *
 * Independent of RED-MATH's oracle: the exact rep point is recovered by SNAPPING
 * the solver's float coordinate onto the only rationals a 2x2 equilibrium
 * rectangle midpoint can be — {0, 1, root, 1/2, root/2, (1+root)/2} — and the
 * expected payoff is then a BigInt fraction over the 1000-scaled matrix. A game
 * whose coordinate does not snap is COUNTED, not silently skipped, so the
 * instrument cannot quietly measure nothing.
 *
 *   npx tsx _gen/bm_num.ts none|fmtPayoff|strip|always0
 */
import { equilibriumSet, EA, EB, fmtPayoff } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

const ARM = process.argv[2] || 'none';

const legacy = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, ''));
const strip = (v: number) => { const s = fmtPayoff(v); return /^-?\d+\.\d+$/.test(s) ? s.replace(/\.?0+$/, '') : s; };
const render = (v: number): string =>
  ARM === 'always0' ? '0' : ARM === 'fmtPayoff' ? fmtPayoff(v) : ARM === 'strip' ? strip(v) : legacy(v);

// ---- exact rationals over BigInt -------------------------------------------
type Q = { n: bigint; d: bigint };                       // d > 0, not necessarily reduced
const Qm = (n: bigint, d: bigint): Q => (d < 0n ? { n: -n, d: -d } : { n, d });
const qadd = (a: Q, b: Q): Q => Qm(a.n * b.d + b.n * a.d, a.d * b.d);
const qsub = (a: Q, b: Q): Q => Qm(a.n * b.d - b.n * a.d, a.d * b.d);
const qmul = (a: Q, b: Q): Q => Qm(a.n * b.n, a.d * b.d);
const qnum = (a: Q): number => Number(a.n) / Number(a.d);
const qzero = (a: Q) => a.n === 0n;

/** payoff -> exact integer numerator over 1000. Asserts the value really is 3-dp. */
function k(v: number): bigint {
  const s = Math.round(v * 1000);
  if (Math.abs(s / 1000 - v) > 1e-12) throw new Error(`payoff ${v} is not a 3-dp multiple`);
  return BigInt(s);
}

/** E_A / E_B at exact (X, Y), exactly. */
function Eq(g: GamePayoffs, X: Q, Y: Q, who: 'A' | 'B'): Q {
  const p = (r: 1 | 2, c: 1 | 2) => k(who === 'A'
    ? (r === 1 ? (c === 1 ? g.a11 : g.a12) : c === 1 ? g.a21 : g.a22)
    : (r === 1 ? (c === 1 ? g.b11 : g.b12) : c === 1 ? g.b21 : g.b22));
  const one: Q = { n: 1n, d: 1n };
  const nx = qsub(one, X), ny = qsub(one, Y);
  let acc: Q = { n: 0n, d: 1n };
  acc = qadd(acc, qmul(qmul(X, Y), { n: p(1, 1), d: 1000n }));
  acc = qadd(acc, qmul(qmul(X, ny), { n: p(1, 2), d: 1000n }));
  acc = qadd(acc, qmul(qmul(nx, Y), { n: p(2, 1), d: 1000n }));
  acc = qadd(acc, qmul(qmul(nx, ny), { n: p(2, 2), d: 1000n }));
  return acc;
}

const ZERO: Q = { n: 0n, d: 1n }, ONE: Q = { n: 1n, d: 1n }, HALF: Q = { n: 1n, d: 2n };

/** Candidate exact values for a rectangle-midpoint coordinate. */
function candidates(root: Q | null): Q[] {
  const out = [ZERO, ONE, HALF];
  if (root) out.push(root, qmul(root, HALF), qmul(qadd(ONE, root), HALF));
  return out;
}
function snap(v: number, cands: Q[]): Q | null {
  for (const c of cands) if (Math.abs(qnum(c) - v) < 1e-9) return c;
  return null;
}

function roots(g: GamePayoffs): { xs: Q | null; ys: Q | null } {
  const tA = k(g.a11) - k(g.a12) - k(g.a21) + k(g.a22);
  const tB = k(g.b11) - k(g.b12) - k(g.b21) + k(g.b22);
  return {
    ys: tA === 0n ? null : Qm(k(g.a22) - k(g.a12), tA),
    xs: tB === 0n ? null : Qm(k(g.b22) - k(g.b21), tB),
  };
}

// ---- corpora ---------------------------------------------------------------
const ri = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const gens: Record<string, () => GamePayoffs> = {
  'int[-9,9]': () => { const c = () => ri(-9, 9); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
  'dec3[-9,9]': () => { const c = () => ri(-9000, 9000) / 1000; return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
  'dec3[-1,1]': () => { const c = () => ri(-1000, 1000) / 1000; return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
  'dec3[-0.1,0.1]': () => { const c = () => ri(-100, 100) / 1000; return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
};

const N = Number(process.env.BM_N || 200000);
console.log(`arm = ${ARM}   N = ${N} per distribution`);
let grand = { negZero: 0, falseZero: 0, wrong3dp: 0, unsnapped: 0, changed: 0, changedOnClean: 0 };
for (const [name, gen] of Object.entries(gens)) {
  let n = 0, negZero = 0, falseZero = 0, wrong3dp = 0, unsnapped = 0, changed = 0, changedOnClean = 0;
  let vagueOnExactZero = 0, tieShift = 0, other = 0;
  for (let i = 0; i < N; i++) {
    const g = gen();
    const set = equilibriumSet(g);
    if (!set.length) continue;
    const rep = set[0];
    const fx = (rep.x0 + rep.x1) / 2, fy = (rep.y0 + rep.y1) / 2;
    const { xs, ys } = roots(g);
    const X = snap(fx, candidates(xs)), Y = snap(fy, candidates(ys));
    if (!X || !Y) { unsnapped++; continue; }
    n++;
    for (const who of ['A', 'B'] as const) {
      const v = who === 'A' ? EA(fx, fy, g) : EB(fx, fy, g);
      const exact = Eq(g, X, Y, who);
      const s = render(v), old = legacy(v);
      // was this rendering DEFECTIVE under the current shipped renderer?
      const oldBad = old === '-0' || (old === '0' && !qzero(exact));
      if (s !== old) {
        changed++;
        if (!oldBad) {
          changedOnClean++;
          // classify the regression, if any: an exactly-zero payoff that used to
          // print "0" and now prints a threshold phrase is TRUE but vaguer.
          if (qzero(exact) && !/^-?\d/.test(s)) vagueOnExactZero++;
          else if (/^-?\d/.test(s) && /^-?\d/.test(old)) tieShift++;
          else other++;
        }
      }
      if (s === '-0') { negZero++; continue; }
      if (s === '0' && !qzero(exact)) { falseZero++; continue; }
      if (/^-?\d+(?:\.\d+)?$/.test(s) && Math.abs(Number(s) - qnum(exact)) > 5.001e-4) wrong3dp++;
    }
  }
  const pct = (x: number) => `${x} (${(100 * x / n).toFixed(4)}%)`;
  console.log(`  ${name.padEnd(16)} n=${n} unsnapped=${unsnapped}  "-0": ${pct(negZero)}  FALSE "0": ${pct(falseZero)}  wrong-to-3dp: ${wrong3dp}  changed-vs-shipped: ${changed} (on NON-defective: ${changedOnClean} = vague-on-exact-zero ${vagueOnExactZero} + 3dp-tie-shift ${tieShift} + other ${other})`);
  grand = { negZero: grand.negZero + negZero, falseZero: grand.falseZero + falseZero, wrong3dp: grand.wrong3dp + wrong3dp, unsnapped: grand.unsnapped + unsnapped, changed: grand.changed + changed, changedOnClean: grand.changedOnClean + changedOnClean };
}
console.log(`TOTAL  "-0": ${grand.negZero}  FALSE "0": ${grand.falseZero}  wrong-to-3dp: ${grand.wrong3dp}  unsnapped games: ${grand.unsnapped}  changed: ${grand.changed}  changed-on-clean: ${grand.changedOnClean}`);

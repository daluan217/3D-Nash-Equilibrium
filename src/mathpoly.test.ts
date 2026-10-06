/**
 * The E[A] / E[B] polynomials under the payoff matrix print EXACTLY the expected payoff (BLUE-LOOP-MATH-22 sweep 2).
 * Truth is integer thousandths (inputs are 3dp), so a float-noise coefficient, a dropped ±0.001 term, a flipped
 * sign or an elided constant 1 cannot match by coincidence. The App call site is gated to the same coefficients.
 *
 *   npx tsx src/mathpoly.test.ts
 */
import { readFileSync } from 'node:fs';
import { buildPolyStr, EA, EB } from './utils/gameEngine';
import type { GamePayoffs } from './types';

const fails: Record<string, number> = {}, firstFail: Record<string, string> = {};
let checks = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  checks++; if (ok) return; fails[name] = (fails[name] ?? 0) + 1; firstFail[name] ??= detail;
};
const K = ['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const;
let seed = 23; const R = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const T = (v: number) => Math.round(v * 1000);
/** "c xy + c x - c y + c" -> integer-thousandths coefficients, or the token that does not parse. */
const parse = (s: string): Record<string, number> | { bad: string } => {
  if (s === '0') return { xy: 0, x: 0, y: 0, '': 0 };
  const c: Record<string, number> = { xy: 0, x: 0, y: 0, '': 0 };
  if (!/^-?[\d.]*(xy|x|y)?( [+-] [\d.]*(xy|x|y)?)*$/.test(s)) return { bad: s };
  for (const t of s.replace(/ /g, '').match(/[+-]?[^+-]+/g) ?? []) {
    const m = t.match(/^([+-]?)((?:0|[1-9]\d*)(?:\.\d{0,2}[1-9])?|)(xy|x|y|)$/);   // shortest decimal: no 2.000, no 07
    if (!m || (m[2] === '' && m[3] === '') || (m[2] === '1' && m[3] !== '')) return { bad: t };
    c[m[3]] += (m[1] === '-' ? -1 : 1) * T(m[2] === '' ? 1 : Number(m[2]));
  }
  return c;
};
const reach = { polys: 0, zero: 0, unitElided: 0, thousandth: 0, edge100: 0, constOne: 0 };
const gens: [string, () => number][] = [
  ['int[-3,3]', () => Math.floor(R() * 7) - 3],
  ['3dp ±100', () => Math.round((R() * 200 - 100) * 1000) / 1000],
  ['range edges', () => [100, -100, 99.999, -99.999, 0.001, -0.001, 0, 1, -1][Math.floor(R() * 9)]],
  ['near zero', () => Math.round(R() * 6 - 3) / 1000],
];
// Fixed shapes a random sweep may miss: the zero polynomial, unit coefficients (printed bare), a lone constant.
const FIXED = [[0, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [-1, 1, 1, -1], [0.001, 0, 0, -0.001], [100, -100, -100, 100]];
const games: [string, GamePayoffs][] = FIXED.map((f) => ['fixed', Object.fromEntries(K.map((k, i) => [k, f[i % 4]])) as unknown as GamePayoffs]);
for (const [tag, gen] of gens) for (let i = 0; i < 40000; i++) games.push([tag, Object.fromEntries(K.map((k) => [k, gen()])) as unknown as GamePayoffs]);
for (const [tag, g] of games) {
  for (const [P, f] of [['a', EA], ['b', EB]] as const) {
    const v = (k: string) => (g as unknown as Record<string, number>)[P + k];
    const s = buildPolyStr(v('11') - v('12') - v('21') + v('22'), v('12') - v('22'), v('21') - v('22'), v('22'));
    const t = { xy: T(v('11')) - T(v('12')) - T(v('21')) + T(v('22')), x: T(v('12')) - T(v('22')), y: T(v('21')) - T(v('22')), '': T(v('22')) };
    reach.polys++; if (s === '0') reach.zero++; if (/(^|[ -])(xy|x|y)/.test(s)) reach.unitElided++;
    if (/\b0\.001/.test(s)) reach.thousandth++; if (/\b(100|99\.999)\b/.test(s)) reach.edge100++; if (t[''] === 1000 || t[''] === -1000) reach.constOne++;
    const c = parse(s);
    const at = `${tag} ${JSON.stringify(g)} ${P}: "${s}"`;
    check('P1 the polynomial is plain ASCII, shortest decimals of at most 3 places (no float noise, no 1e-7, no 2.000)',
      !('bad' in c) && /^[\dxy .+-]+$/.test(s), at);
    if ('bad' in c) continue;
    check('P2 every printed coefficient is exactly the expected-payoff coefficient (integer thousandths)',
      JSON.stringify(c) === JSON.stringify(t), `${at} want ${JSON.stringify(t)}`);
    const [x, y] = [R(), R()];
    check('P3 the printed polynomial evaluates to E[A]/E[B] at a random (x, y)',
      Math.abs((x * y * c.xy + x * c.x + y * c.y + c['']) / 1000 - f(x, y, g)) < 1e-6, at);
  }
}
check('reach: zero polys, elided unit coefficients, 0.001 terms, ±100 edges and a constant ±1 all printed',
  reach.polys === 320016 && reach.zero >= 2 && reach.unitElided >= 5000 && reach.thousandth >= 5000 && reach.edge100 >= 5000 && reach.constOne >= 1000,
  JSON.stringify(reach));

// ── Call site: App feeds buildPolyStr the expansion of E = xy·p11 + x(1-y)·p12 + (1-x)y·p21 + (1-x)(1-y)·p22 ──
const app = readFileSync('src/App.tsx', 'utf8').replace(/\s+/g, ' ');
for (const p of ['a', 'b']) {
  const want = `buildPolyStr( payoffs.${p}11 - payoffs.${p}12 - payoffs.${p}21 + payoffs.${p}22, payoffs.${p}12 - payoffs.${p}22, payoffs.${p}21 - payoffs.${p}22, payoffs.${p}22 )`;
  check(`C1 App's E[${p.toUpperCase()}] line passes buildPolyStr the expected-payoff coefficients`, app.includes(want), want);
}

const failed = Object.keys(fails);
for (const n of failed) console.log(`FAIL ${n} x${fails[n]} — ${firstFail[n]}`);
console.log(`mathpoly: ${checks - failed.reduce((s, n) => s + fails[n], 0)}/${checks} checks, reach ${JSON.stringify(reach)}`);
if (failed.length) process.exit(1);

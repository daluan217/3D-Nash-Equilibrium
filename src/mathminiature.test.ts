/**
 * The drawer / preset card miniature draws the solver's best-reply sets (BLUE-LOOP-MATH-22 sweep 2, F7).
 *
 * GameGraphMiniature solved the best replies with its own formula: a player indifferent at EVERY strategy of
 * the other (a11=a21, a12=a22) was drawn as "always Row 2", and an indifference root at an edge (y*=0 or 1)
 * was not drawn at all, so a card showed a pure best reply where the solver has a whole segment or square.
 *
 *   npx tsx src/mathminiature.test.ts
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { GameGraphMiniature } from './components/GameGraphMiniature';
import { continuumComponents, indifferenceRoot, kindOf, PRESETS, splitEquilibriaByContinuum } from './utils/gameEngine';
import type { GamePayoffs } from './types';
import { seededRandom } from './testing/prng';

let checks = 0;
const fails: Record<string, number> = {};
const firstFail: Record<string, string> = {};
const check = (name: string, ok: boolean, detail = ''): void => {
  checks++;
  if (ok) return;
  fails[name] = (fails[name] ?? 0) + 1;
  firstFail[name] ??= detail;
};
const K = ['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const;
const ROSE = '#f43f5e', BLUE = '#3b82f6';
type Iv = [number, number];
const ux = (px: number) => (px - 15) / 90, uy = (py: number) => (105 - py) / 90;
const attr = (el: string, a: string) => { const m = el.match(new RegExp(`\\b${a}="([^"]*)"`)); return m ? m[1] : null; };

/** Every stroke / fill of one colour as unit-square segments [x0,y0,x1,y1]; a filled rect is its box. */
function drawn(svg: string, colour: string): { segs: number[][]; boxes: number[][] } {
  const segs: number[][] = [], boxes: number[][] = [];
  for (const el of svg.match(/<(?:path|line|rect|polyline|polygon)\b[^>]*>/g) ?? []) {
    if (attr(el, 'stroke') !== colour && attr(el, 'fill') !== colour) continue;
    if (el.startsWith('<rect')) {
      const x = ux(+attr(el, 'x')!), y = uy(+attr(el, 'y')!), w = +attr(el, 'width')! / 90, h = +attr(el, 'height')! / 90;
      boxes.push([x, y - h, x + w, y]);
    } else if (el.startsWith('<line')) {
      segs.push([ux(+attr(el, 'x1')!), uy(+attr(el, 'y1')!), ux(+attr(el, 'x2')!), uy(+attr(el, 'y2')!)]);
    } else {
      const raw = attr(el, 'd') ?? attr(el, 'points') ?? '';
      const pts = [...raw.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((m) => [ux(+m[1]), uy(+m[2])]);
      for (let i = 0; i + 1 < pts.length; i++) segs.push([...pts[i], ...pts[i + 1]]);
    }
  }
  return { segs, boxes };
}

/** The drawn set's cross-section at t (y for A's curve, x for B's), as sorted merged intervals of the other axis. */
function section(d: { segs: number[][]; boxes: number[][] }, t: number, aIsRow: boolean): Iv[] {
  const tol = 1e-9;
  const out: Iv[] = [];
  for (const [x0, y0, x1, y1] of d.segs) {
    const [s0, s1, o0, o1] = aIsRow ? [y0, y1, x0, x1] : [x0, x1, y0, y1];   // s = section axis, o = other
    if (t < Math.min(s0, s1) - tol || t > Math.max(s0, s1) + tol) continue;
    if (Math.abs(s1 - s0) < tol) out.push([Math.min(o0, o1), Math.max(o0, o1)]);
    else { const o = o0 + ((t - s0) / (s1 - s0)) * (o1 - o0); out.push([o, o]); }
  }
  for (const [x0, y0, x1, y1] of d.boxes) {
    const [s0, s1, o0, o1] = aIsRow ? [y0, y1, x0, x1] : [x0, x1, y0, y1];
    if (t >= s0 - tol && t <= s1 + tol) out.push([o0, o1]);
  }
  out.sort((p, q) => p[0] - q[0]);
  const merged: Iv[] = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + tol) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged.map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]);
}

/** Best-reply set where the payoff gap is v*d1 + (1-v)*d2, at v = k/8, in exact integer thousandths. */
const truth = (d1: number, d2: number, k: number): Iv[] => {
  const s = k * Math.round(d1 * 1000) + (8 - k) * Math.round(d2 * 1000);
  return s === 0 ? [[0, 1]] : s > 0 ? [[1, 1]] : [[0, 0]];
};

/** Compare the miniature with the truth at every grid point, both edges, and each root. */
function compare(g: GamePayoffs, tag: string): boolean {
  const svg = renderToStaticMarkup(createElement(GameGraphMiniature, { payoffs: g }));
  let ok = true;
  for (const [who, colour, d1, d2, aIsRow] of [
    ['A', ROSE, g.a11 - g.a21, g.a12 - g.a22, true],
    ['B', BLUE, g.b11 - g.b12, g.b21 - g.b22, false],
  ] as const) {
    const d = drawn(svg, colour);
    const r = indifferenceRoot(d1, d2);
    // grid points k/8, then the root itself (indifferent there by definition); a 3dp root that is not
    // k/8 sits >= 1/3200000 from it, far outside section()'s 1e-9 tolerance
    const ts: [number, Iv[]][] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => [k / 8, truth(d1, d2, k)]);
    if (r >= 0 && r <= 1) ts.push([r, [[0, 1]]]);
    for (const [t, w] of ts) {
      const got = JSON.stringify(section(d, t, aIsRow)), want = JSON.stringify(w);
      if (got !== want) {
        ok = false;
        check(`${tag}: ${who}'s drawn best reply equals the solver's at every point of the square`, false,
          `${JSON.stringify(g)} ${who} at ${aIsRow ? 'y' : 'x'}=${t}: drawn ${got}, best reply ${want}`);
        break;
      }
    }
  }
  return ok;
}

// ── F7 verbatim (each fixture carries ONE defect signal) ──────────────────────
// A indifferent everywhere; B strictly prefers Col 2 (so B's line is plain and only A's drawing can fail).
const F7_FULL: GamePayoffs = { a11: 2, a12: 2, a21: 2, a22: 2, b11: 0, b12: 1, b21: 0, b22: 1 };
// A's root at the edge y*=1 (a11=a21, a12<a22): A indifferent only at y=1; B strictly prefers Col 1.
const F7_EDGE: GamePayoffs = { a11: 1, a12: 0, a21: 1, a22: 2, b11: 1, b12: 0, b21: 1, b22: 0 };
// B indifferent everywhere (the same defect on the other player); A strictly prefers Row 1.
const F7_FULL_B: GamePayoffs = { a11: 1, a12: 1, a21: 0, a22: 0, b11: 3, b12: 3, b21: -1, b22: -1 };
check('F7 precondition: A is indifferent at every y', F7_FULL.a11 === F7_FULL.a21 && F7_FULL.a12 === F7_FULL.a22);
check('F7 precondition: A is indifferent exactly at y=1', indifferenceRoot(F7_EDGE.a11 - F7_EDGE.a21, F7_EDGE.a12 - F7_EDGE.a22) === 1);
check('F7 precondition: B is indifferent at every x', F7_FULL_B.b11 === F7_FULL_B.b12 && F7_FULL_B.b21 === F7_FULL_B.b22);
check('F7 full: the card draws every x as a best reply for A, not "always Row 2"', compare(F7_FULL, 'F7 full'));
check('F7 edge: the card draws A\'s indifference at y = 1', compare(F7_EDGE, 'F7 edge'));
check('F7 full B: the card draws every y as a best reply for B', compare(F7_FULL_B, 'F7 full B'));

// ── F9: the card's equilibrium marks are the solver's equilibrium SET (sweep 3) ─────────────────────
// The card dotted computeAllNE's corners only: a continuum (x=0, y in [0.5,1]) showed as ONE isolated pure-NE
// dot at its corner, while the card's own list and the main plot draw the whole component.
const MIXED = '#a855f7';
/** Core NE dots (r 3 / 3.5) and continuum strokes (dashed, mixed colour) as unit-square geometry. */
function marks(svg: string): { dots: number[][]; comps: number[][] } {
  const dots: number[][] = [], comps: number[][] = [];
  for (const el of svg.match(/<(?:circle|line|rect|path|polyline|polygon)\b[^>]*>/g) ?? []) {
    if (el.startsWith('<circle') && /^(3|3\.5)$/.test(attr(el, 'r') ?? '') && attr(el, 'fill') !== 'none')
      dots.push([ux(+attr(el, 'cx')!), uy(+attr(el, 'cy')!)]);
    else if (attr(el, 'stroke') === MIXED && attr(el, 'stroke-dasharray')) {
      // [x0, x1, y0, y1, 1 if drawn as an area outline]: a diagonal across the square is not the square
      if (el.startsWith('<line')) {
        const [x0, y0, x1, y1] = [ux(+attr(el, 'x1')!), uy(+attr(el, 'y1')!), ux(+attr(el, 'x2')!), uy(+attr(el, 'y2')!)];
        comps.push([Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1), 0]);
      } else if (el.startsWith('<rect')) {
        const x = ux(+attr(el, 'x')!), y = uy(+attr(el, 'y')!), w = +attr(el, 'width')! / 90, h = +attr(el, 'height')! / 90;
        comps.push([x, x + w, y - h, y, 1]);
      } else comps.push([NaN, NaN, NaN, NaN, NaN]);   // any other dashed shape is unmeasured -> fails the match
    }
  }
  return { dots, comps };
}
const key = (v: number[]) => v.map((c) => Math.round(c * 1e6) / 1e6).join(',');
function compareSet(g: GamePayoffs, tag: string): boolean {
  const m = marks(renderToStaticMarkup(createElement(GameGraphMiniature, { payoffs: g })));
  const want = continuumComponents(g).map((r) => key([r.x0, r.x1, r.y0, r.y1, kindOf(r) === 'area' ? 1 : 0])).sort();
  const wantDots = splitEquilibriaByContinuum(g).stray.map((e) => key([e.x, e.y])).sort();
  const okC = JSON.stringify(m.comps.map(key).sort()) === JSON.stringify(want);
  const okD = JSON.stringify(m.dots.map(key).sort()) === JSON.stringify(wantDots);
  check(`${tag}: every continuum component is drawn, exactly (segment as a line, area as its outline)`, okC,
    `${JSON.stringify(g)} drawn ${JSON.stringify(m.comps.map(key))} set ${JSON.stringify(want)}`);
  check(`${tag}: a dot marks each isolated equilibrium and nothing else (no corner of a continuum)`, okD,
    `${JSON.stringify(g)} dots ${JSON.stringify(m.dots.map(key))} isolated ${JSON.stringify(wantDots)}`);
  return okC && okD;
}
const F9: GamePayoffs = { a11: 0, a12: 1, a21: 1, a22: 0, b11: 2, b12: -1, b21: 2, b22: 2 };
const F9_AREA: GamePayoffs = { a11: 1, a12: 1, a21: 1, a22: 1, b11: 0, b12: 0, b21: 0, b22: 0 };
check('F9 precondition: the set is the segment x=0, y in [0.5,1], whose corner (0,1) computeAllNE lists',
  key(Object.values(continuumComponents(F9)[0])) === key([0, 0, 0.5, 1]) && splitEquilibriaByContinuum(F9).onContinuum.length === 1);
check('F9 precondition: both players indifferent everywhere -> the whole square', kindOf(continuumComponents(F9_AREA)[0]) === 'area');
compareSet(F9, 'F9 segment');
compareSet(F9_AREA, 'F9 area');

// ── Sweeps: every preset, small integers (ties are common), 3-dp, near-level slopes ──
const R = seededRandom(2207);
const reach = { games: 0, fullA: 0, fullB: 0, edgeRoot: 0, interiorRoot: 0, continuum: 0 };
const sweep = (g: GamePayoffs, tag: string) => {
  reach.games++;
  if (g.a11 === g.a21 && g.a12 === g.a22) reach.fullA++;
  if (g.b11 === g.b12 && g.b21 === g.b22) reach.fullB++;
  for (const r of [indifferenceRoot(g.a11 - g.a21, g.a12 - g.a22), indifferenceRoot(g.b11 - g.b12, g.b21 - g.b22)]) {
    if (r === 0 || r === 1) reach.edgeRoot++;
    else if (r > 0 && r < 1) reach.interiorRoot++;
  }
  compare(g, tag);
  compareSet(g, tag);
  if (continuumComponents(g).length) reach.continuum++;
};
for (const p of Object.values(PRESETS)) sweep(Object.fromEntries(K.map((k) => [k, p[k]])) as unknown as GamePayoffs, 'S1 presets');
for (let i = 0; i < 6000; i++) sweep(Object.fromEntries(K.map((k) => [k, Math.floor(R() * 5) - 2])) as unknown as GamePayoffs, 'S2 int[-2,2]');
for (let i = 0; i < 3000; i++) sweep(Object.fromEntries(K.map((k) => [k, Math.round((R() * 200 - 100) * 1000) / 1000])) as unknown as GamePayoffs, 'S3 3dp');
for (let i = 0; i < 2000; i++) {   // slopes of 0.001 next to level: the old 1e-5 cut-off and NE_EPS must agree
  const g = Object.fromEntries(K.map((k) => [k, Math.floor(R() * 3) - 1])) as unknown as GamePayoffs;
  g.a11 = Math.round((g.a21 + (R() < 0.5 ? 0.001 : -0.001) * Math.floor(R() * 3)) * 1000) / 1000;
  g.b22 = Math.round((g.b21 + g.b12 - g.b11 + (R() < 0.5 ? 0.001 : 0)) * 1000) / 1000;
  sweep(g, 'S4 near-level');
}
check('reach: presets + 11000 games, with full and edge indifference on both players and continua',
  reach.games >= 11000 && reach.fullA >= 100 && reach.fullB >= 100 && reach.edgeRoot >= 500 && reach.interiorRoot >= 2000 && reach.continuum >= 1000,
  JSON.stringify(reach));

// ── Source gate: the miniature has no root formula of its own ──
const src = readFileSync('src/components/GameGraphMiniature.tsx', 'utf8');
check('R1 GameGraphMiniature draws from the solver\'s best-reply sets, not its own quotient',
  /bestReplySets\(/.test(src) && !/\/\s*den\b|1e-5/.test(src));

const failed = Object.keys(fails);
for (const n of failed) console.log(`FAIL ${n} x${fails[n]} — ${firstFail[n]}`);
console.log(`mathminiature: ${checks - failed.reduce((s, n) => s + fails[n], 0)}/${checks} checks, reach ${JSON.stringify(reach)}`);
if (failed.length) process.exit(1);

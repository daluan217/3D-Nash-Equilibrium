/**
 * GROUND TRUTH for "is a player's surface level along their OWN axis somewhere
 * in the interior", computed from E_A / E_B and never from the closed form.
 *
 * BLUE's warning, verified below rather than taken on trust: a grid scan for
 * |slope| < eps cannot see a transversal zero crossing between samples and
 * reports the shipped predicate wrong ~30% of the time. A SIGN CHANGE between
 * consecutive samples (plus the exact-zero case) is the correct instrument.
 */
import { EA, EB } from '../src/utils/gameEngine';
import { describeGeometry } from '../src/utils/geometry';
import type { GamePayoffs } from '../src/types';

const H = 1e-6;
const slopeA = (y: number, g: GamePayoffs) => (EA(0.5 + H, y, g) - EA(0.5 - H, y, g)) / (2 * H);
const slopeB = (x: number, g: GamePayoffs) => (EB(x, 0.5 + H, g) - EB(x, 0.5 - H, g)) / (2 * H);

/** level at some INTERIOR opponent mix, by sign change or exact zero */
function levelSomewhereInterior(f: (t: number) => number): boolean {
  const N = 400;
  let prev = f(1 / (N + 1));
  if (Math.abs(prev) < 1e-7) return true;
  for (let i = 2; i <= N; i++) {
    const t = i / (N + 1);
    const v = f(t);
    if (Math.abs(v) < 1e-7) return true;
    if ((prev < 0) !== (v < 0)) return true;          // transversal crossing
    prev = v;
  }
  return false;
}
/** the BROKEN instrument BLUE warned about, kept as a control */
function levelByGridMagnitude(f: (t: number) => number): boolean {
  for (let i = 1; i <= 400; i++) if (Math.abs(f(i / 401)) < 1e-7) return true;
  return false;
}

const candFlatA = (g: GamePayoffs) => {
  const t = g.a11 - g.a12 - g.a21 + g.a22, E = 1e-9;
  const yS = Math.abs(t) < E ? NaN : (g.a22 - g.a12) / t;
  return Math.abs(t) >= E ? (Number.isFinite(yS) && yS > E && yS < 1 - E) : Math.abs(g.a11 - g.a21) < E;
};
const candFlatB = (g: GamePayoffs) => {
  const t = g.b11 - g.b12 - g.b21 + g.b22, E = 1e-9;
  const xS = Math.abs(t) < E ? NaN : (g.b22 - g.b21) / t;
  return Math.abs(t) >= E ? (Number.isFinite(xS) && xS > E && xS < 1 - E) : Math.abs(g.b11 - g.b12) < E;
};

const ri = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
for (const [name, lim] of [['int[-9,9]', 9], ['int[-3,3]', 3]] as const) {
  let shippedShelfWrong = 0, shippedSpotWrong = 0, candShelfWrong = 0, candSpotWrong = 0, gridWrong = 0, nonDegenChanged = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const c = () => ri(-lim, lim);
    const g: GamePayoffs = { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() };
    const truthA = levelSomewhereInterior((y) => slopeA(y, g));
    const truthB = levelSomewhereInterior((x) => slopeB(x, g));
    const geo = describeGeometry(g);
    if (geo.yStarInRange !== truthA) shippedShelfWrong++;
    if (geo.hasInteriorFlatSpot !== (truthA && truthB)) shippedSpotWrong++;
    if (candFlatA(g) !== truthA) candShelfWrong++;
    if ((candFlatA(g) && candFlatB(g)) !== (truthA && truthB)) candSpotWrong++;
    if (levelByGridMagnitude((y) => slopeA(y, g)) !== truthA) gridWrong++;
    const nonDegen = Math.abs(g.a11 - g.a12 - g.a21 + g.a22) >= 1e-9 && Math.abs(g.b11 - g.b12 - g.b21 + g.b22) >= 1e-9;
    if (nonDegen && (candFlatA(g) !== geo.yStarInRange || (candFlatA(g) && candFlatB(g)) !== geo.hasInteriorFlatSpot)) nonDegenChanged++;
  }
  const p = (x: number) => `${x} (${(100 * x / N).toFixed(3)}%)`;
  console.log(`${name} n=${N}`);
  console.log(`  SHIPPED yStarInRange-as-shelf wrong ${p(shippedShelfWrong)};  hasInteriorFlatSpot wrong ${p(shippedSpotWrong)}`);
  console.log(`  CANDIDATE shelf wrong ${p(candShelfWrong)};  joint flat spot wrong ${p(candSpotWrong)}`);
  console.log(`  candidate differs from shipped on NON-degenerate games: ${nonDegenChanged}`);
  console.log(`  CONTROL, the magnitude-grid instrument BLUE warned about: disagrees with sign-change truth ${p(gridWrong)}`);
}

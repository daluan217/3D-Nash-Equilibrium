/**
 * Named-case readout of the geometry predicates against the solver.
 *
 * REWRITTEN. This file used to re-implement the predicates inline, including
 * `x* = (a22 - a21) / T_A` — the zero-sum-only shortcut that geometry.ts exists
 * to correct. So the "verification" script carried the exact bug it was meant to
 * catch, and would have reported DISAGREE on Battle of the Sexes forever.
 *
 * It now calls describeGeometry, the shipped function. A diagnostic that
 * duplicates the logic it checks verifies nothing; it only tells you whether two
 * copies drifted.
 *
 * This is a readout for eyeballing named games. The actual regression guard is
 * testGeometryOracleAgreesWithSolver in src/test.ts, which fuzzes 20,000 games
 * on every `npm test`.
 */
import { computeAllNE } from '../src/utils/gameEngine';
import { describeGeometry } from '../src/utils/geometry';
import type { GamePayoffs } from '../src/types';

const CASES: { id: string; g: GamePayoffs; expect: string }[] = [
  { id: 'no interaction (A flat)', expect: 'twistA = 0, no shelf, no flat spot',
    g: { a11: 2, a12: 2, a21: 5, a22: 5, b11: -2, b12: -3, b21: -4, b22: -5 } },
  { id: 'y* outside [0,1]', expect: 'no shelf on the board',
    g: { a11: 3, a12: 2, a21: 0, a22: 0, b11: -3, b12: -2, b21: 0, b22: 0 } },
  { id: "prisoner's dilemma", expect: 'corner NE, not zero-sum, no interior flat spot',
    g: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 } },
  { id: 'battle of the sexes', expect: 'interior flat spot at x*=2/3, NOT zero-sum',
    g: { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 } },
  { id: 'matching pennies', expect: 'zero-sum + interior flat spot at (1/2, 1/2)',
    g: { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 } },
];

const interior = (v: number) => v > 1e-9 && v < 1 - 1e-9;

for (const c of CASES) {
  const geo = describeGeometry(c.g);
  const ne = computeAllNE(c.g);
  const solverMixed = ne.find((n) => n.type === 'mixed' && interior(n.x) && interior(n.y));

  // Two independent routes to the same point: the closed form and the solver.
  const agree =
    geo.hasInteriorFlatSpot === !!solverMixed &&
    (!solverMixed ||
      (Math.abs(solverMixed.x - geo.xStar) < 1e-3 && Math.abs(solverMixed.y - geo.yStar) < 1e-3));

  console.log(
    `${c.id}\n  expect: ${c.expect}\n` +
    `  twistA=${geo.twistA} twistB=${geo.twistB}  x*=${geo.xStar} y*=${geo.yStar}\n` +
    `  zero-sum=${geo.zeroSum} constant-sum=${geo.constantSum} shelf=${geo.yStarInRange} flatspot=${geo.hasInteriorFlatSpot}\n` +
    `  solver: ${ne.map((n) => `${n.type}(${n.x},${n.y})`).join(' ') || '(none)'}  -> ${agree ? 'AGREE' : '*** DISAGREE ***'}\n`,
  );
}

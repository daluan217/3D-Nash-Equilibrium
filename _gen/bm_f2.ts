/**
 * Does `bm_f.ts`'s "mismatches: none" MEAN anything?
 *
 * BLUE's harness passed `equilibria: []` where validateReport wants
 * `claimedEquilibria`, so it returned early on the shape guard and reported "no
 * geometry mismatch" for truthful AND negated claims alike. That reads exactly
 * like a clean pass. This runs each report BOTH ways: if negating the claim does
 * not produce a mismatch, the harness is not reaching checkGeometry.
 */
import { validateReport } from '../src/utils/nashValidator';
import { describeGeometry } from '../src/utils/geometry';
import { computeAllNE } from '../src/utils/gameEngine';
import type { GamePayoffs, LlmReport } from '../src/types';

function geoMismatches(g: GamePayoffs, geo: any): string[] {
  const ne = computeAllNE(g);
  const rep = {
    prose: 'The equilibrium is as computed.',
    claimedEquilibria: ne.map((n) => ({ type: n.type, x: n.x, y: n.y })),
    geometryClaims: geo,
  } as unknown as LlmReport;
  const v = validateReport(rep, g);
  return (v.mismatches ?? []).filter((m: any) => String(m.kind).startsWith('geometry')).map((m: any) => m.kind);
}

const CASES: [string, GamePayoffs][] = [
  ['f1  a=[[-5,-1],[-5,-1]]', { a11: -5, a12: -1, a21: -5, a22: -1, b11: -6, b12: -6, b21: 0, b22: 6 }],
  ['f2  b=[[3,3],[4,4]]', { a11: -2, a12: 2, a21: 4, a22: -5, b11: 3, b12: 3, b21: 4, b22: 4 }],
  ["BLUE's 3rd  a=[[5,4],[1,0]]", { a11: 5, a12: 4, a21: 1, a22: 0, b11: 2, b12: -3, b21: -1, b22: 4 }],
];
for (const [name, g] of CASES) {
  const d = describeGeometry(g);
  const truthful = {
    surfacesInteract: Math.abs(d.twistA) >= 1e-9, opponentSurfaceIsMirror: d.zeroSum || d.constantSum,
    hasFlatShelfForA: d.hasFlatShelfForA, equilibriumIsInteriorFlatSpot: d.hasInteriorFlatSpot,
    invokesMinimax: false, claimsDominantStrategy: false,
  };
  const negated = { ...truthful, hasFlatShelfForA: !truthful.hasFlatShelfForA, equilibriumIsInteriorFlatSpot: !truthful.equilibriumIsInteriorFlatSpot };
  const t = geoMismatches(g, truthful), n = geoMismatches(g, negated);
  console.log(`${name}
   twistA=${d.twistA} twistB=${d.twistB} shelfA=${d.hasFlatShelfForA} shelfB=${d.hasFlatShelfForB} spot=${d.hasInteriorFlatSpot} yStarInRange=${d.yStarInRange}
   TRUTHFUL claim -> ${t.length ? t.join(',') : 'no mismatch'}
   NEGATED  claim -> ${n.length ? n.join(',') : 'NO MISMATCH  <-- harness never reached checkGeometry, the clean pass above is VACUOUS'}`);
}

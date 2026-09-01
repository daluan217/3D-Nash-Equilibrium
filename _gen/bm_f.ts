/** BLUE-MATH's reproduction of the checkGeometry findings for BLUE. */
import { validateReport } from '../src/utils/nashValidator';
import { describeGeometry } from '../src/utils/geometry';
import { computeAllNE, regretA, regretB } from '../src/utils/gameEngine';
import type { GamePayoffs, LlmReport } from '../src/types';

function probe(name: string, g: GamePayoffs, geo: any) {
  const ne = computeAllNE(g);
  const rep = {
    prose: 'The equilibrium is as computed.',
    claimedEquilibria: ne.map((n) => ({ type: n.type, x: n.x, y: n.y })),
    geometryClaims: geo,
  } as unknown as LlmReport;
  const v = validateReport(rep, g);
  const geoIssues = (v.mismatches ?? []).filter((m: any) => String(m.kind).startsWith('geometry'));
  console.log(`${name}\n  describeGeometry: twistA=${describeGeometry(g).twistA} yStarInRange=${describeGeometry(g).yStarInRange} hasInteriorFlatSpot=${describeGeometry(g).hasInteriorFlatSpot}`);
  console.log(`  geometry mismatches: ${geoIssues.length ? geoIssues.map((m: any) => `${m.kind}: ${m.detail}`).join(' | ') : 'none'}`);
}

// (f1) A is indifferent between the rows EVERYWHERE — the whole surface is a shelf.
const g1: GamePayoffs = { a11: -5, a12: -1, a21: -5, a22: -1, b11: -6, b12: -6, b21: 0, b22: 6 };
console.log('A row payoffs equal in both columns:', g1.a11 === g1.a21, g1.a12 === g1.a22);
probe('(f1) hasFlatShelfForA: true on a board that is ENTIRELY level along A\'s axis', g1,
  { surfacesInteract: false, opponentSurfaceIsMirror: false, hasFlatShelfForA: true, equilibriumIsInteriorFlatSpot: false, invokesMinimax: false, claimsDominantStrategy: false });

// (f2) both surfaces level at interior points, but xStar is NaN so the flag is false.
const g2: GamePayoffs = { a11: -2, a12: 2, a21: 4, a22: -5, b11: 3, b12: 3, b21: 4, b22: 4 };
console.log(`\nB indifferent between columns against BOTH rows: ${g2.b11 === g2.b12 && g2.b21 === g2.b22}`);
console.log(`regret at (0.5, 7/13): A=${regretA(0.5, 7 / 13, g2)} B=${regretB(0.5, 7 / 13, g2)}`);
probe('(f2) equilibriumIsInteriorFlatSpot: true where both surfaces ARE level at (0.5, 7/13)', g2,
  { surfacesInteract: true, opponentSurfaceIsMirror: false, hasFlatShelfForA: true, equilibriumIsInteriorFlatSpot: true, invokesMinimax: false, claimsDominantStrategy: false });

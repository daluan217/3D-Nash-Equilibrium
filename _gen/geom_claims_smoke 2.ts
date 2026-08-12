/**
 * Does adding geometryClaims to the schema break the SHIPPED report path?
 *
 * The checks are only worth having if the model can actually fill the field.
 * Two ways this could go wrong and neither is visible from a unit test:
 *   - the extra required property makes the structured output fail to parse,
 *     which drops every user to the deterministic panel;
 *   - the model fills it in but gets it wrong, which would turn the new checks
 *     into a permanent red light on correct explanations.
 *
 * So this runs the real production entry point (generateReport with nothing but
 * a model) across games chosen to exercise every branch of the geometry, and
 * reports parse rate and check outcomes separately. A failure here means the
 * feature is not shippable regardless of what the unit tests say.
 */
import 'dotenv/config';
import { generateReport } from '../src/utils/report';
import { validateReport } from '../src/utils/nashValidator';
import { describeGeometry } from '../src/utils/geometry';
import type { GamePayoffs } from '../src/types';

const GAMES: { name: string; g: GamePayoffs }[] = [
  { name: 'matching pennies (zero-sum, interior flat spot)',
    g: { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 } },
  { name: "prisoner's dilemma (corner NE, not zero-sum, no shelf)",
    g: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 } },
  { name: 'battle of the sexes (not zero-sum, interior flat spot)',
    g: { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 } },
  { name: 'flat A (no interaction, no shelf)',
    g: { a11: 2, a12: 2, a21: 5, a22: 5, b11: -2, b12: -3, b21: -4, b22: -5 } },
  { name: 'constant-sum (mirror up to an offset)',
    g: { a11: 4, a12: 1, a21: 1, a22: 3, b11: 1, b12: 4, b21: 4, b22: 2 } },
];

// Random games on top of the hand-picked ones. The five above are chosen to hit
// every branch; these are here purely to put a bigger denominator under the
// parse rate, which is the number that decides shippability.
const N_RANDOM = Number(process.env.G_RANDOM || 0);
let seed = 20260812;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = () => Math.round(rnd() * 20 - 10);
for (let i = 0; i < N_RANDOM; i++) {
  GAMES.push({
    name: `random #${i + 1}`,
    g: { a11: pick(), a12: pick(), a21: pick(), a22: pick(),
         b11: pick(), b12: pick(), b21: pick(), b22: pick() },
  });
}

(async () => {
  let parsed = 0, declared = 0, geomClean = 0, fullyOk = 0;

  for (const { name, g } of GAMES) {
    const truth = describeGeometry(g);
    const r = await generateReport(g);
    if (!r.report) {
      console.log(`FAIL  ${name}\n      no report (${r.failure}, stop=${r.stopReason})\n`);
      continue;
    }
    parsed++;

    const c = r.report.geometryClaims;
    const v = validateReport(r.report, g);
    const geoFails = v.mismatches.filter((m) => m.kind.startsWith('geometry-'));
    const otherFails = v.mismatches.filter((m) => !m.kind.startsWith('geometry-'));
    if (c) declared++;
    if (geoFails.length === 0) geomClean++;
    if (v.ok) fullyOk++;

    console.log(`${geoFails.length === 0 ? 'ok  ' : 'GEOM'}  ${name}`);
    console.log(`      truth    interact=${Math.abs(truth.twistA) >= 1e-9} mirror=${truth.zeroSum || truth.constantSum}`
      + ` shelf=${truth.yStarInRange} flatspot=${truth.hasInteriorFlatSpot}`);
    console.log(`      declared ${c ? `interact=${c.surfacesInteract} mirror=${c.opponentSurfaceIsMirror}`
      + ` shelf=${c.hasFlatShelfForA} flatspot=${c.equilibriumIsInteriorFlatSpot}` : '(null — declined)'}`);
    for (const m of geoFails) console.log(`      *** ${m.kind}: ${m.detail}`);
    for (const m of otherFails) console.log(`      (non-geometry) ${m.kind}: ${m.detail}`);
    console.log(`      prose: ${r.report.prose.slice(0, 150)}...\n`);
  }

  console.log('='.repeat(60));
  console.log(`parsed            ${parsed}/${GAMES.length}   <- if this drops, the schema change is not shippable`);
  console.log(`declared claims   ${declared}/${parsed}`);
  console.log(`geometry clean    ${geomClean}/${parsed}   <- if this is low, the checks would red-light correct output`);
  console.log(`fully valid       ${fullyOk}/${parsed}`);
})();

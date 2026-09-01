/* BLUE TRIAGE of RED 1 F1 (anti-coordination games get no coordination screen)
 * and F10 (actorA/actorB never declared locally, so the misattribution guard
 * never executes). Reproduced independently of red's harness. */
const { validateScenario, scenarioIsClaimFree } = await import('../src/utils/nashValidator.ts');
const { computeAllNE } = await import('../src/utils/gameEngine.ts');
import { readFileSync } from 'node:fs';

// ── F1: the shape gate ──────────────────────────────────────────────────────
const antiGame = { a11:0,a12:3,a21:2,a22:0, b11:0,b12:2,b21:3,b22:0 };
const pure = computeAllNE(antiGame).filter(t => t.type === 'pure');
const diag = pure.filter(t => (t.x===1&&t.y===1)||(t.x===0&&t.y===0)).length;
const anti = pure.filter(t => (t.x===1&&t.y===0)||(t.x===0&&t.y===1)).length;
console.log(`F1 matrix A=[[0,3],[2,0]] B=[[0,2],[3,0]]`);
console.log(`   pure NE: ${pure.length}  on matching diagonal: ${diag}  on mismatching: ${anti}`);
console.log(`   coordinationShape (as coded) = ${pure.length>=2 && (diag===pure.length||anti===pure.length)}  <- TRUE, so the COORD screen is skipped`);

const sc = (desc) => ({ name:'X', description:desc, row1:'Morning Harvest', row2:'Evening Harvest', col1:'Shared Window', col2:'Separate Window' });
const probes = [
  ['explicit COORD_TALK vocabulary', 'Both cooperatives want to match the opponent\'s choice for the drying season.'],
  ['the wording the model actually writes', 'A seaweed-drying cooperative chooses Morning Harvest or Evening Harvest. A neighboring company chooses a Shared Window or a Separate Window. The two players coordinate their choices for the same drying season.'],
];
for (const [what, desc] of probes) {
  const v = validateScenario(sc(desc), antiGame);
  const cf = scenarioIsClaimFree(sc(desc));
  console.log(`   [${what}] validateScenario.ok=${v.ok} claimFree.ok=${cf.ok}  issues=${JSON.stringify(v.issues)}`);
}
// control: the SAME sentence on a genuine matching-coordination game must stay clean
const coordGame = { a11:2,a12:0,a21:0,a22:1, b11:2,b12:0,b21:0,b22:1 };
const cp = computeAllNE(coordGame).filter(t=>t.type==='pure');
console.log(`   CONTROL matching game: pure=${cp.length}  validateScenario.ok=${validateScenario(sc(probes[0][1]), coordGame).ok}  <- must stay true`);

// ── F10: does the local model ever declare actorA/actorB? ───────────────────
for (const [label, path] of [['LOCAL','/tmp/rt2_local.jsonl'],['CLOUD','/tmp/rt2_cloud.jsonl']]) {
  let rows; try { rows = readFileSync(path,'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { continue; }
  const ok = rows.filter(r=>r.sc);
  const withActors = ok.filter(r=>Array.isArray(r.sc.actorA)&&r.sc.actorA.length&&Array.isArray(r.sc.actorB)&&r.sc.actorB.length);
  const withClaims = ok.filter(r=>r.sc.storyClaims);
  console.log(`F10 ${label}: n=${ok.length}  declares actorA AND actorB: ${withActors.length}  storyClaims non-null: ${withClaims.length}`);
}

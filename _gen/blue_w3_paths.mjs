/**
 * BLUE — WINDOW 3: WHICH GATE DOES EACH PRODUCTION PATH ACTUALLY RUN?
 *
 * Found while reading server.ts for the label-channel window, and it is the
 * larger finding, so it is measured before anything is changed.
 *
 * /api/report invents a scenario on THREE mutually exclusive paths, and they do
 * not run the same gate:
 *
 *   P1  rung-3, non-tie, not scenarioOnly      server.ts:897-934
 *         validateScenario + scenarioIsClaimFree + validateProseDirections
 *   P2  tie game, NASH_LLM_TIES=template        server.ts:963-990
 *         validateScenario + scenarioIsClaimFree + validateProseDirections
 *   P3  scenarioOnly === true, NON-TIE          server.ts:1023-1054
 *         validateScenario + validateProseDirections        <-- NO CLAIM-FREE
 *
 * P3 is the "New AI scenario" button. The rung-3 block excludes it explicitly
 * (`!isTie && req.body?.scenarioOnly !== true`), so on a non-tie game — the
 * common case; the code's own comment puts ties at 12.7% of a random sample —
 * the button falls through to a gate that is missing the entire claim-free
 * screen: the digit rule and all six CLAIMY rules.
 *
 * NOTHING HERE IS ANSWERED FROM A DETECTOR OF MINE. Each predicate below is
 * transcribed from the server line it models, and calls the shipping functions.
 *
 *   npx tsx _gen/blue_w3_paths.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');

// Transcribed from server.ts. Direction checks are ON in production
// (NASH_DIRECTION_CHECKS=1, Cloud Run revision 00170-czp).
const P1 = (sc, g) => V.validateScenario(sc, g).ok
  && V.scenarioIsClaimFree(sc).ok !== false
  && V.validateProseDirections(sc.description ?? '', sc, g).length === 0;
const P3 = (sc, g) => V.validateScenario(sc, g).ok
  && V.validateProseDirections(sc.description ?? '', sc, g).length === 0;

// ── Known positives: draws P1 rejects. If P3 accepts them, P3 is the hole. ──
const NONTIE = { a11: 3, a12: 0, a21: 0, a22: 2, b11: 1, b12: 4, b21: 5, b22: 0 };
const POSITIVES = [
  { id: 'the real "Col1 or Col2" draw (stakes-local #13, rejected in the wild)',
    sc: { name: 'Coffee Roastery Sourcing', row1: 'Full Harvest', row2: 'Early Harvest',
      col1: 'Open Market', col2: 'Reserved Market',
      description: 'A coffee roastery chooses whether to Harvest its beans in Full Harvest or Early Harvest. Its neighboring brewer chooses whether to place its same or different brews into the market in Col1 or Col2.' } },
  { id: 'the round-2 draw the tie-path comment was written for ("when responding to")',
    sc: { name: 'Records Review', row1: 'Open Records', row2: 'Restrict Records',
      col1: 'Full Audit', col2: 'Spot Audit',
      description: 'The shop owner chooses between Open Records and Restrict Records when responding to the review. An auditor chooses between Full Audit and Spot Audit.' } },
  { id: 'a move-order claim',
    sc: { name: 'Berth Assignment', row1: 'Open Berth', row2: 'Hold Berth',
      col1: 'Early Call', col2: 'Late Call',
      description: 'A dock supervisor chooses before a port manager chooses the call time for the same tide window.' } },
  { id: 'an equilibrium word',
    sc: { name: 'Kiln Firing', row1: 'Long Firing', row2: 'Short Firing',
      col1: 'Wide Draw', col2: 'Narrow Draw',
      description: 'A pottery works and a clay supplier settle into an equilibrium over the same kiln week.' } },
];
console.log('── KNOWN POSITIVES: P1 rejects, does P3? ──');
let hole = 0;
for (const p of POSITIVES) {
  const a = P1(p.sc, NONTIE), b = P3(p.sc, NONTIE);
  if (!a) { if (b) hole++; console.log(`  P1 rejects · P3 ${b ? 'ACCEPTS  <-- reaches the user' : 'rejects'}   ${p.id}`); }
  else console.log(`  P1 ACCEPTS (not a positive — fixture is wrong)          ${p.id}`);
}
console.log(`\n  ${hole}/${POSITIVES.length} reach the user through "New AI scenario" on a non-tie game.\n`);

// ── FALSE-POSITIVE COST of making P3 match P1 ──────────────────────────────
// The screen being added is already LIVE on P1 and P2 against the same models,
// the same prompt and the same distribution, so its cost is measurable rather
// than hypothetical: it is the number of stored draws that pass P3 and fail P1.
const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const rows = [];
for (const [f, tag] of [[`${S}/rt1.jsonl`, 'rt1'], [`${S}/rt2.jsonl`, 'rt2'], [`${S}/pilot.jsonl`, 'rt1pilot'],
  ['/tmp/rt2_local.jsonl', 'r2local'], ['/tmp/rt2_cloud.jsonl', 'r2cloud'],
  ['/tmp/rt2_pilot.jsonl', 'r2pilot'], ['/tmp/rt2_cloudpilot.jsonl', 'r2cloudpilot'],
  ['/tmp/rt2_stakes_local.jsonl', 'stlocal'], ['/tmp/rt2_stakes_cloud.jsonl', 'stcloud'],
  ['/tmp/rt2_stakes_cloud_hint.jsonl', 'sthint'], ['/tmp/rt2_stakes_pilot.jsonl', 'stpilot']]) {
  if (!existsSync(f)) continue;
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r.sc) continue;
    const g = r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null);
    if (!g) continue;
    rows.push({ src: tag, i: r.i ?? r.pair, sc: r.sc, g });
  }
}
console.log(`── COST: over ${rows.length} stored real draws (matrix reconstructed for the stakes arms) ──`);
let p3ok = 0, newlyWithheld = 0; const ex = [];
for (const r of rows) {
  let a, b;
  try { a = P1(r.sc, r.g); b = P3(r.sc, r.g); } catch (e) { console.log(`  THREW ${r.src}#${r.i}: ${e.message}`); continue; }
  if (b) p3ok++;
  if (b && !a) { newlyWithheld++; ex.push({ r, why: V.scenarioIsClaimFree(r.sc).reason }); }
}
console.log(`  pass P3 today            : ${p3ok}`);
console.log(`  P3 would newly WITHHOLD  : ${newlyWithheld}  (${(100 * newlyWithheld / p3ok).toFixed(2)}% of what the button ships today)\n`);
for (const e of ex) {
  console.log(`   ${e.r.src}#${e.r.i} "${e.r.sc.name}"  — ${e.why}`);
  console.log(`      ${String(e.r.sc.description).slice(0, 240)}\n`);
}

/* WINDOW 2 mutation evidence for the F1-vocab screen. A fixture suite that
 * passes against the defect proves nothing; the camera-flash round shipped
 * three such assertions. So each side is checked against a mutant that gets it
 * wrong in the specific way a plausible author would.
 *
 * MUTANT A = the COMMITTED gate (no abstract-player screen at all)
 *            -> every POSITIVE must go undetected.
 * MUTANT B = the PROXIMITY draft, "subject … within 80 chars … coordinat"
 *            -> the job-title and activity CONTROLS must be wrongly flagged.
 * MUTANT C = the bare word list red measured at 11.9% precision
 *            -> the controls must be wrongly flagged, in bulk.
 *
 *   npx tsx _gen/blue_w2_mutation.mjs
 */
import { writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const { validateScenario } = await import('../src/utils/nashValidator.ts');
// MUTANT A is materialised from git rather than kept as a copy — a checked-in
// snapshot of "before" goes stale without saying so, and this mutant's whole
// job is to be genuinely the previous behaviour.
const BASE = process.env.BASE_REF || '31fa9b1';
const TMP = new URL('../src/utils/nashValidator.__baseline.ts', import.meta.url).pathname;
let OLD;
try {
  writeFileSync(TMP, execFileSync('git', ['show', `${BASE}:src/utils/nashValidator.ts`], { encoding: 'utf8' }));
  OLD = await import('../src/utils/nashValidator.__baseline.ts');
} finally { try { rmSync(TMP); } catch {} }
const ANTI = { a11:0,a12:3,a21:2,a22:0, b11:0,b12:2,b21:3,b22:0 };
const base = { name:'X', row1:'Early Slot', row2:'Late Slot', col1:'Shared Window', col2:'Separate Window', storyClaims:null };
const NOUN = String.raw`(?:players?|parties|sides|institutions?|participants?|agents?|actors?)`;
const MUT_B = new RegExp(String.raw`\b(?:the\s+two|both|the)\s+${NOUN}\b[^.!?]{0,80}?\bcoordinat`, 'i');
const MUT_C = /\bcoordinat/i;

const POSITIVES = [
  'The two players coordinate their choices for the drying season.',
  'The two institutions coordinate their choices in this short, concrete game setup.',
  'The two players are planning how to coordinate their harvest time across the season.',
  'The two players are planning a coordinated drying schedule for their racks.',
  'Both parties are coordinating their harvest and procurement plans.',
];
const CONTROLS = [
  ['red 2 load-bearing', 'A shipyards and a harbor coordinator are coordinating dredging operations for a shared canal.'],
  ['rt2#129 measured FP', 'The two players are choosing how their shared grid will respond to a coordinated demand period.'],
  ['abstract subj = job title', 'The two players are the shipyard and the harbor coordinator for the canal.'],
  ['are coordinators', 'The two players are coordinators at the same depot, and each picks a shift.'],
  ['the coordinating body', 'The two players are the coordinating body for the canal traffic.'],
  ['flat ACTIVITY tic', 'A ferry operator and a dock warden are coordinating a joint experiment for the season.'],
  ['job title alone', 'A harbor coordinator schedules the dredging window while a yard picks a slot.'],
  ['negated', 'The two players never coordinate their choices here.'],
];
const ISSUE = 'no pure equilibrium of this game sits on a matching pair';
const fires = (d) => validateScenario({ ...base, description: d }, ANTI).issues.some(i => i.includes(ISSUE));
let fail = 0;
const need = (cond, msg) => { if (!cond) { fail++; console.log(`FAIL  ${msg}`); } else console.log(`  ok  ${msg}`); };

console.log('MUTANT A — the COMMITTED gate. Every positive must slip through it,');
console.log('           or the screen is not what is catching them.');
for (const d of POSITIVES) {
  need(OLD.validateScenario({ ...base, description: d }, ANTI).ok && fires(d),
    `committed gate PASSES it, this one CATCHES it: "${d.slice(0,58)}…"`);
}
console.log('\nMUTANT B — the PROXIMITY draft. Each control it wrongly flags is a false');
console.log('           positive this shape had to be tightened to avoid.');
let bCaught = 0;
for (const [label, d] of CONTROLS) {
  const b = MUT_B.test(d);
  if (b) bCaught++;
  need(!fires(d), `shipped rule PASSES "${label}"${b ? '   <- proximity draft WRONGLY FLAGS it' : ''}`);
}
need(bCaught > 0, `the proximity draft is genuinely looser: it wrongly flags ${bCaught} of ${CONTROLS.length} controls`);
console.log('\nMUTANT C — the bare word list (11.9% precision as red measured it).');
const cCaught = CONTROLS.filter(([,d]) => MUT_C.test(d)).length;
need(cCaught >= CONTROLS.length - 1, `the bare word list wrongly flags ${cCaught} of ${CONTROLS.length} controls`);
console.log('\nDIRECTION — the shape half. The SAME sentence must flip on the matrix alone.');
const MATCH = { a11:2,a12:0,a21:0,a22:1, b11:2,b12:0,b21:0,b22:1 };
const ONE_MATCH = { a11:3,a12:0,a21:5,a22:1, b11:3,b12:5,b21:0,b22:1 };
for (const [label,g] of [['both pure NE MATCH',MATCH],['the one pure NE is a MATCH',ONE_MATCH]]) {
  const v = validateScenario({ ...base, description: POSITIVES[0] }, g);
  need(!v.issues.some(i=>i.includes(ISSUE)), `caught on ANTI, PASSES where ${label}`);
}
console.log(fail ? `\n${fail} MUTATION FAILURES` : '\nmutation evidence complete: both sides proven necessary');
process.exit(fail?1:0);

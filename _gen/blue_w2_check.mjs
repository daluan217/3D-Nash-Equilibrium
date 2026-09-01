/* WINDOW 2 acceptance for the F1-vocab screen: fixtures (BOTH sides), REACH
 * against the real corpora, and a pre/post replay for false positives — all in
 * ONE run, because a fixture proves a check CAN fire and only reach proves it
 * DOES. My own F1 predicate was correct, had a green fixture and a green
 * oracle, and matched 0 of 341 real draws.
 *
 *   npx tsx _gen/blue_w2_check.mjs
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const { validateScenario } = await import('../src/utils/nashValidator.ts');
// THE BASELINE IS DERIVED, NOT KEPT. A checked-in copy of the previous
// validator goes stale silently and the replay then measures the wrong
// difference. This materialises the pre-change file from git, next to its own
// relative imports, and removes it again — so "newly rejected" always means
// "newly rejected versus BASE", whatever the working tree has become.
const BASE = process.env.BASE_REF || '31fa9b1';
const TMP = new URL('../src/utils/nashValidator.__baseline.ts', import.meta.url).pathname;
let OLD;
try {
  writeFileSync(TMP, execFileSync('git', ['show', `${BASE}:src/utils/nashValidator.ts`], { encoding: 'utf8' }));
  OLD = await import('../src/utils/nashValidator.__baseline.ts');
} finally { try { rmSync(TMP); } catch {} }
const { computeAllNE } = await import('../src/utils/gameEngine.ts');

// Every fixture matrix is verified by shape here rather than asserted in a
// comment — a fixture that has drifted off its shape tests nothing.
const G = {
  ANTI:         { a11:0,a12:3,a21:2,a22:0, b11:0,b12:2,b21:3,b22:0 },  // 2 pure NE, both MISMATCH
  MATCH:        { a11:2,a12:0,a21:0,a22:1, b11:2,b12:0,b21:0,b22:1 },  // 2 pure NE, both MATCH
  ONE_MATCH:    { a11:3,a12:0,a21:5,a22:1, b11:3,b12:5,b21:0,b22:1 },  // 1 pure NE, a MATCH
  ONE_MISMATCH: { a11:0,a12:1,a21:3,a22:4, b11:3,b12:0,b21:4,b22:1 },  // 1 pure NE, a MISMATCH
  NO_PURE:      { a11:2,a12:0,a21:0,a22:1, b11:0,b12:1,b21:2,b22:0 },  // no pure NE at all
};
const SHAPE = { ANTI:[2,0,2], MATCH:[2,2,0], ONE_MATCH:[1,1,0], ONE_MISMATCH:[1,0,1], NO_PURE:[0,0,0] };
let fail = 0;
for (const [k,g] of Object.entries(G)) {
  const p = computeAllNE(g).filter(t=>t.type==='pure');
  const d = p.filter(t=>(t.x===1&&t.y===1)||(t.x===0&&t.y===0)).length;
  const a = p.filter(t=>(t.x===1&&t.y===0)||(t.x===0&&t.y===1)).length;
  const want = SHAPE[k], got = [p.length,d,a];
  if (want.join() !== got.join()) { fail++; console.log(`FAIL  fixture matrix ${k} is shape ${got} but the suite needs ${want}`); }
}

const base = { name:'X', row1:'Early Slot', row2:'Late Slot', col1:'Shared Window', col2:'Separate Window', storyClaims:null };
const ISSUE = 'no pure equilibrium of this game sits on a matching pair';
const t = (want, gk, label, d) => {
  const v = validateScenario({ ...base, description: d }, G[gk]);
  const mine = v.issues.some(i => i.includes(ISSUE));
  const got = mine ? 'CAUGHT' : (v.ok ? 'PASSES' : 'other-issue');
  if (got !== want) fail++;
  console.log(`${got===want?'  ok ':'FAIL'}  ${got.padEnd(11)} (want ${want.padEnd(6)}) [${gk}] ${label}`);
  if (got !== want) console.log(`            ${JSON.stringify(v.issues)}`);
};

console.log('── KNOWN POSITIVES: the five real claim sentences, on a matrix with no matching equilibrium ──');
const FIVE = [
 'The two players coordinate their choices for the crossing schedule.',
 'The two players coordinate how to handle the expected frost effects, and their choices define the game.',
 'The two institutions coordinate their choices in this short, concrete game setup.',
 'The two players are planning how to coordinate their harvest time across the season.',
 'The two players are planning a coordinated shift schedule for their goods.',
];
FIVE.forEach((d,i)=>t('CAUGHT','ANTI',`real claim ${i+1}`,d));
t('CAUGHT','NO_PURE','same claim where the game has NO pure equilibrium at all', FIVE[0]);
t('CAUGHT','ONE_MISMATCH','same claim where the only pure equilibrium is a MISMATCH', FIVE[0]);
t('CAUGHT','ANTI','the "both" subject arm — untested vocabulary is unshipped vocabulary',
  'Both parties coordinate their choices for the shared window.');
t('CAUGHT','ANTI','the progressive form', 'The two parties are coordinating their harvest and procurement plans.');

console.log('\n── CONTROLS: the matrix is the only thing that may change the verdict ──');
t('PASSES','MATCH','C2 the SAME sentence where both pure equilibria MATCH', FIVE[0]);
t('PASSES','ONE_MATCH','C2b the SAME sentence where the one pure equilibrium is a MATCH', FIVE[0]);
console.log('\n── CONTROLS: the job title and the flat ACTIVITY tic, on the strictest matrix ──');
t('PASSES','ANTI','C1 ACTIVITY form with named actors — the flat verbal tic',
  'A ferry operator and a dock warden are coordinating a joint experiment for the season.');
t('PASSES','ANTI','C3 LOAD-BEARING (red 2): job title AND named-actor coordination verb in one sentence',
  'A shipyards and a harbor coordinator are coordinating dredging operations for a shared canal.');
t('PASSES','MATCH','C3 the same, on an all-MATCH matrix',
  'A shipyards and a harbor coordinator are coordinating dredging operations for a shared canal.');
t('PASSES','ANTI','C4 the job title alone',
  'A harbor coordinator schedules the dredging window while a yard picks a slot.');
t('PASSES','ANTI','C5 plain scene-setting, no coordination word at all',
  'A seaweed cooperative picks a drying slot while a neighbouring firm picks a window.');
console.log('\n── CONTROLS: an abstract subject NEAR a coordination word it does not govern ──');
t('PASSES','ANTI','C6 MEASURED FALSE POSITIVE of the proximity draft (rt2#129): the players\' verb is "are choosing"',
  'The two players are choosing how their shared grid will respond to a coordinated demand period.');
t('PASSES','ANTI','C7 the abstract subject IS the job title',
  'The two players are the shipyard and the harbor coordinator for the canal.');
t('PASSES','ANTI','C8 predicate nominative plural',
  'The two players are coordinators at the same depot, and each picks a shift.');
t('PASSES','ANTI','C9 the players depend on a coordinator, they do not coordinate',
  'Both parties rely on a coordinator to schedule the dredging window.');
t('PASSES','ANTI','C10 "the coordinating body" — form 3 without a verb of intention',
  'The two players are the coordinating body for the canal traffic.');
t('PASSES','ANTI','C11 a coordinated object with no intention verb',
  'Both sides send a coordinated response to the harbour regulator.');
console.log('\n── CONTROLS: negation, which the closed bridge class excludes structurally ──');
for (const [lab,d] of [['C12 never','The two players never coordinate their choices here.'],
  ['C13 do not','The two players do not coordinate their choices.'],
  ['C14 cannot','The two players cannot coordinate their choices.'],
  ['C15 rather than','The two players act independently rather than coordinate their choices.']])
  t('PASSES','ANTI',lab,d);

// ── REACH + FALSE POSITIVES over every stored draw ──
console.log('\n── REACH and FALSE POSITIVES: pre/post replay over the real corpora ──');
const S='/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/';
// The stakes corpora store `spread`, not the matrix. It is fully recoverable —
// _gen/rt2_stakes_scale.mjs builds game(k) from it — and every one of those
// matrices is matching-pennies, i.e. diag === 0, so all 240 of those draws sit
// exactly where this screen CAN fire. Skipping them for want of a `game` key
// would have thrown away the corpus most able to produce a false positive.
const stakesGame = (r) => ({ a11:r.spread, a12:0, a21:0, a22:r.spread, b11:0, b12:r.spread, b21:r.spread, b22:0 });
const CORPORA=[['local  (rt2 local)','/tmp/rt2_local.jsonl',(r)=>r.game],['cloud  (rt2 cloud)','/tmp/rt2_cloud.jsonl',(r)=>r.game],
  ['rt1    (red 1)','' + S + 'rt1.jsonl',(r)=>r.g],['rt2    (red 2)','' + S + 'rt2.jsonl',(r)=>r.g],
  ['stakes local','/tmp/rt2_stakes_local.jsonl',stakesGame],['stakes cloud','/tmp/rt2_stakes_cloud.jsonl',stakesGame],
  ['stakes cloud+hint','/tmp/rt2_stakes_cloud_hint.jsonl',stakesGame]];
let N=0, newlyRejected=0, newlyAccepted=0, selfCheckFail=0, mine=0; const rejects=[];
for (const [label,path,getG] of CORPORA) {
  let rows; try { rows = readFileSync(path,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)); }
  catch { console.log(`  ${label.padEnd(20)} CORPUS MISSING (${path})`); continue; }
  let n=0,nr=0,na=0,skipped=0;
  for (const r of rows) {
    const g = getG(r); if (!r.sc || !g) { skipped++; continue; }
    n++; N++;
    const o = OLD.validateScenario(r.sc, g), v = validateScenario(r.sc, g);
    // Self-check: outside this one screen the two validators must agree, or the
    // replay is measuring something other than the change.
    const vWithout = { ...v, issues: v.issues.filter(i => !i.includes(ISSUE)) };
    if (o.ok !== (vWithout.issues.length === 0)) selfCheckFail++;
    if (v.issues.some(i => i.includes(ISSUE))) mine++;
    if (o.ok && !v.ok) { nr++; newlyRejected++; rejects.push({label, i:r.i??r.pair, d:r.sc.description??'', why:v.issues}); }
    if (!o.ok && v.ok) { na++; newlyAccepted++; }
  }
  console.log(`  ${label.padEnd(20)} n=${String(n).padStart(3)}   newly rejected ${nr}   newly accepted ${na}${skipped?`   (${skipped} rows had no scenario/matrix)`:''}`);
}
console.log(`\n  TOTAL stored draws replayed        : ${N}`);
console.log(`  self-check disagreements (must be 0): ${selfCheckFail}`);
console.log(`  REACH — draws this screen flags     : ${mine} (${(100*mine/N).toFixed(2)}%)`);
console.log(`  newly rejected vs the committed gate: ${newlyRejected}`);
console.log(`  newly ACCEPTED (must be 0)          : ${newlyAccepted}`);
if (selfCheckFail) fail++;
if (newlyAccepted) fail++;
if (!mine) { fail++; console.log('\nFAIL  the screen has ZERO reach on real output — a fixture-only check.'); }
console.log('\n  every draw this screen newly rejects, for hand classification:');
for (const r of rejects) console.log(`    [${r.label.trim()}#${r.i}] ${r.d}\n       -> ${JSON.stringify(r.why)}`);
console.log(fail ? `\n${fail} FAILURES` : '\nall fixtures behaved as specified');
process.exit(fail?1:0);

/**
 * BLUE — WINDOW 3: reach of the EXACT SHIPPED predicates, not an approximation.
 *
 * _gen/blue_w3_reach.mjs measured CANDIDATE regexes written in that file. This
 * one imports the real nashValidator and measures what the code that actually
 * ships does to real, gate-passing model output. The distinction is the rule
 * this campaign runs on: never answer "is that covered?" from an instrument.
 *
 * It reports, over every stored draw:
 *   - how many are newly rejected by the new screens (the false-positive bill)
 *   - how many labels carry a parenthetical at all (decides whether the
 *     annotation-exemption branch is live code or dead code)
 *
 *   npx tsx _gen/blue_w3_shipped.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const CORPORA = [
  [`${S}/rt1.jsonl`, 'rt1'], [`${S}/rt2.jsonl`, 'rt2'], [`${S}/pilot.jsonl`, 'rt1pilot'],
  ['/tmp/rt2_local.jsonl', 'r2local'], ['/tmp/rt2_cloud.jsonl', 'r2cloud'],
  ['/tmp/rt2_pilot.jsonl', 'r2pilot'], ['/tmp/rt2_cloudpilot.jsonl', 'r2cloudpilot'],
  ['/tmp/rt2_stakes_local.jsonl', 'stlocal'], ['/tmp/rt2_stakes_cloud.jsonl', 'stcloud'],
  ['/tmp/rt2_stakes_cloud_hint.jsonl', 'sthint'], ['/tmp/rt2_stakes_pilot.jsonl', 'stpilot'],
];
const rows = [];
for (const [f, tag] of CORPORA) {
  if (!existsSync(f)) continue;
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r.sc) continue;
    const g = r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null);
    rows.push({ src: tag, i: r.i ?? r.pair, sc: r.sc, g });
  }
}
console.log(`loaded ${rows.length} stored draws\n`);

// ── Is the annotation-exemption branch live code? ───────────────────────────
const FIELDS = ['name', 'row1', 'row2', 'col1', 'col2'];
let anyParen = 0, parenPair = 0, anyNumeral = 0;
const parenEx = [];
for (const r of rows) {
  for (const k of FIELDS) {
    const v = typeof r.sc[k] === 'string' ? r.sc[k] : '';
    if (/\p{N}/u.test(v)) anyNumeral++;
    const par = /\(([^)]*)\)/.exec(v);
    if (!par) continue;
    anyParen++;
    const nums = par[1].replace(/[−–]/g, '-').match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
    if (nums.length === 2) { parenPair++; parenEx.push(`${r.src}#${r.i} ${k}="${v}"`); }
  }
}
console.log('── Is the parenthetical-annotation exemption live code? ──');
console.log(`  name/label fields containing a numeral      : ${anyNumeral}`);
console.log(`  name/label fields containing a parenthetical: ${anyParen}`);
console.log(`  ... of those, a 2-number payoff annotation  : ${parenPair}`);
for (const e of parenEx.slice(0, 10)) console.log(`      ${e}`);
console.log('');

// ── The false-positive bill of the shipped screens ──────────────────────────
// Only output the gate ALREADY ACCEPTS can be newly rejected.
const gate = (sc, g) => V.validateScenario(sc, g).ok
  && V.scenarioIsClaimFree(sc).ok !== false
  && V.validateProseDirections(sc.description ?? '', sc, g).length === 0;

// The three rules this window ADDS, identified by the exact reason strings the
// shipping code returns. Written against the code as it stands, not from
// memory: a detector matching a reason string the validator no longer emits
// reports 0% forever, which is the same "instrument, not gate" error this
// campaign keeps finding. Asserted live below.
const NEW_REASON = /^(?:the scenario name|the option label ")|^the description asserts a multiple$/;
{
  // SELF-TEST: each new rule must be reachable through the real function, or
  // the 0% below means nothing.
  const probes = [
    [{ name: 'The 100000x Decision', row1: 'A', row2: 'B', col1: 'C', col2: 'D' }, 'name numeral'],
    [{ name: 'N', row1: 'Commit 1000 Units', row2: 'B', col1: 'C', col2: 'D' }, 'label numeral'],
    [{ name: 'N', row1: 'Hundredfold Expansion', row2: 'B', col1: 'C', col2: 'D' }, 'label multiple'],
    [{ name: 'N', row1: 'A', row2: 'B', col1: 'C', col2: 'D', description: 'One party stands to gain a hundred thousand times more than the other.' }, 'description multiple'],
  ];
  for (const [sc, tag] of probes) {
    const cf = V.scenarioIsClaimFree(sc);
    if (!(cf.ok === false && NEW_REASON.test(cf.reason ?? ''))) {
      console.error(`INSTRUMENT BROKEN — ${tag} not detected (ok=${cf.ok} reason=${cf.reason}). Run void.`);
      process.exit(1);
    }
  }
  console.log('  instrument self-test: all 4 new rules reachable through the real function\n');
}
let considered = 0, newlyRejected = 0;
const hits = [];
for (const r of rows) {
  considered++;
  let issues = [];
  try {
    const cf = V.scenarioIsClaimFree(r.sc);
    if (cf.ok === false && NEW_REASON.test(cf.reason ?? '')) issues.push(cf.reason);
  } catch (e) { console.log(`  THREW ${r.src}#${r.i}: ${e.message}`); continue; }
  if (issues.length) { newlyRejected++; hits.push({ r, issues }); }
}
console.log('── FALSE-POSITIVE BILL of the new screens, over real draws ──');
console.log(`  draws examined      : ${considered}`);
console.log(`  newly flagged       : ${newlyRejected}  (${(100 * newlyRejected / considered).toFixed(2)}%)`);
for (const h of hits) {
  const s = h.r.sc;
  console.log(`   ${h.r.src}#${h.r.i} "${s.name}"  ${s.row1} / ${s.row2} | ${s.col1} / ${s.col2}`);
  for (const i of h.issues) console.log(`      ${i}`);
}
if (!newlyRejected) console.log('  (none — the screens cost the current models nothing)');

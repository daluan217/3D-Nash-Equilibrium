/* WINDOW 4 mutation evidence for the two-chooser rules and the rivals fix.
 *
 * MUTANT A = the COMMITTED gate before this window (5d0a7c2)
 *            -> every POSITIVE must go undetected, or the fixtures are not new.
 * MUTANT B = the FIRST DRAFT of each rule, i.e. the bare vocabulary form
 *            -> must wrongly reject the real controls. These are not
 *               hypothetical mutants: each is what I actually wrote first, and
 *               each false positive below was MEASURED, not imagined.
 * MUTANT C = the bare `rivals?` that SHIPPED in window 3
 *            -> must reject the two real draws RED 1's newer corpus exposed.
 *
 *   npx tsx _gen/blue_w4_mutation.mjs
 */
import { writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const NEW = await import('../src/utils/nashValidator.ts');
const BASE = process.env.BASE_REF || '5d0a7c2';
const TMP = new URL('../src/utils/nashValidator.__w4base.ts', import.meta.url).pathname;
let OLD;
try {
  writeFileSync(TMP, execFileSync('git', ['show', `${BASE}:src/utils/nashValidator.ts`], { encoding: 'utf8' }));
  OLD = await import('../src/utils/nashValidator.__w4base.ts');
} finally { try { rmSync(TMP); } catch {} }

const ANTI = { a11: 0, a12: 3, a21: 2, a22: 0, b11: 0, b12: 2, b21: 3, b22: 0 };
const COMMON = { a11: 4, a12: 0, a21: 0, a22: 2, b11: 4, b12: 0, b21: 0, b22: 2 };
const S = (d) => ({ name: 'T', row1: 'Early Slot', row2: 'Late Slot', col1: 'Shared Window', col2: 'Separate Window', storyClaims: null, description: d });
const gate = (mod, d, g = ANTI) => mod.validateScenario(S(d), g).ok
  && mod.scenarioIsClaimFree(S(d)).ok !== false
  && mod.validateProseDirections(d, S(d), g).length === 0;
const why = (d, g = ANTI) => {
  const cf = NEW.scenarioIsClaimFree(S(d));
  if (cf.ok === false) return cf.reason;
  return (NEW.validateScenario(S(d), g).issues ?? []).join('; ');
};
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log(`  FAIL  ${m}`); } };

const POSITIVES = [
  ['C1 rt1#71', "A regional airport is planning a survey of a mountain range's glaciers and will either use an Early Survey or a Late Survey for that data set. The airport will also choose between sharing a route with the same survey team or taking a separate route for that same data set."],
  ['C1 rt2 stakes pilot', 'Two neighboring vineyard managers must each choose between Early Watering and Late Watering for their vines. Each manager also chooses between Deep Irrigation and Surface Irrigation for the shared vineyard water system.'],
  ['C2 rt1#116', "A dairy co-op is deciding between Premium Pricing and Cost-Plus Pricing for its seasonal milk product. It chooses either Local Sales or Online Sales for distribution, with each choice shaping the co-op's overall pricing and distribution plan."],
  ['C2 rt2 local#95', 'A dairy co-op is deciding whether to set its pricing at Premium Pricing or Cost-Plus Pricing. It must choose between Open Market and Stable Market for its main distribution channels.'],
  ["C4' rt1#117", 'A farm cooperative and a harvest coordinator are coordinating a saffron harvest. The cooperative chooses Early Harvest or Late Harvest, while the coordinator chooses the same timing.'],
  ['negotiation widening rt2cloud#11', 'A courier company chooses whether to submit a Premium Route or a Budget Route bid for a delivery contract. A logistics platform chooses whether to Accept Bid or Reject Bid.'],
];
console.log('── POSITIVES: new gate rejects, MUTANT A (committed) does not ──');
for (const [tag, d] of POSITIVES) {
  const n = gate(NEW, d), o = gate(OLD, d);
  console.log(`  new=${n ? 'PASS ' : 'block'}  baseline=${o ? 'PASS ' : 'block'}   ${tag}`);
  if (!n) console.log(`        -> ${why(d)}`);
  ok(!n, `${tag}: the new gate must reject it`);
  ok(o, `${tag}: MUTANT A must miss it, or this fixture is not a new positive`);
}

// The controls, each a real draw an earlier draft of MINE wrongly rejected.
const CONTROLS = [
  ['"also" = likewise, new actor', 'A major film studio is choosing when to release its season-defining feature, with its budget and reputation tied to the campaign. A smaller independent distributor is also choosing between an open slot and a crowded slot for a film whose release matters less to its annual plans.', ANTI],
  ['pronoun, second actor present', "A regional airline is planning a series of flights through a rapidly changing glacier route. It chooses between Early Survey and Late Survey for the flights, while the glacier manager chooses between Early Survey and Late Survey for the region's seasonal monitoring plan.", ANTI],
  ['"the same scheduling choice"', 'A textile mill and a nearby finishing mill each schedule its dyeing work for either an Early Shift or a Late Shift. The first mill chooses between Early Shift and Late Shift, while the second mill independently makes the same scheduling choice.', ANTI],
  ['"the same product"', 'A dairy co-op is deciding between Premium Pricing and Bulk Pricing for its seasonal product. The co-op chooses one, while the market buyer chooses the same product through the same season.', ANTI],
  ['attributive "rival" (rt3#7)', "A is a fisherman choosing between Open Fish and Keep Fish for the day's catch. B is a rival fisherman choosing between Open Fish and Keep Fish for the same catch.", COMMON],
  ['attributive "rival" (rt3#29)', 'A city marathon coordinator chooses whether to schedule the race with an Early Closure or a Late Closure. A rival event coordinator chooses whether to use a Peak Route or a Quiet Route.', COMMON],
  ['bids with no acceptance', 'Two courier firms are competing for the same delivery contract. Each firm chooses between a Priority Bid, which offers a faster route, and an Economy Bid, which offers a lower-cost route.', ANTI],
  ['plural pronoun', 'A mill chooses an Early Slot or a Late Slot. A haulier chooses a Shared Window or a Separate Window. They choose simultaneously, without seeing each other.', ANTI],
];
console.log('\n── CONTROLS: the new gate must accept every one ──');
for (const [tag, d, g] of CONTROLS) {
  const n = gate(NEW, d, g);
  console.log(`  new=${n ? 'pass ' : 'BLOCK'}   ${tag}`);
  if (!n) console.log(`        -> ${why(d, g)}`);
  ok(n, `${tag}: control wrongly rejected`);
}

// ── MUTANT B: the bare-vocabulary first drafts ─────────────────────────────
console.log('\n── MUTANT B: the first drafts, i.e. the vocabulary without the cast ──');
const MB = [
  ['bare "also chooses"', /\b(?:will\s+)?also\s+(?:choose|chooses|choosing|decide|decides|pick|picks|select|selects)\b/i, '"also" = likewise, new actor'],
  ['bare pronoun chooser', /\b(?:it|they|he|she)\s+(?:chooses?|choosing|picks?|decides?|selects?|opts?)\b/i, 'pronoun, second actor present'],
  ['bare "the same" + choose verb', /\b(?:chooses?|choosing|picks?|selects?|decides?|makes?)\b[^.;]{0,30}?\bthe\s+same\b/i, '"the same scheduling choice"'],
];
for (const [tag, re, ctrlTag] of MB) {
  const ctrl = CONTROLS.find(([t]) => t === ctrlTag);
  const caught = re.test(ctrl[1]);
  console.log(`  mutant "${tag}" ${caught ? 'WRONGLY REJECTS' : 'passes        '} the control: ${ctrlTag}`);
  ok(caught, `MUTANT B "${tag}" must be shown to reject a real control, or the cast condition is unmotivated`);
  ok(gate(NEW, ctrl[1], ctrl[2]), `the shipped rule must accept ${ctrlTag}`);
}

// ── MUTANT C: the bare `rivals?` that actually shipped in window 3 ─────────
console.log('\n── MUTANT C: the bare `rivals?` shipped in W3, caught by RED 1\'s new corpus ──');
{
  const bare = /\brivals?\b/i;
  for (const t of ['attributive "rival" (rt3#7)', 'attributive "rival" (rt3#29)']) {
    const c = CONTROLS.find(([x]) => x === t);
    console.log(`  mutant C ${bare.test(c[1]) ? 'WRONGLY REJECTS' : 'passes'} ${t}`);
    ok(bare.test(c[1]), 'MUTANT C must be shown to reject the real draw it did reject');
    ok(gate(NEW, c[1], c[2]), `the fixed rule must accept ${t}`);
  }
  const claim = 'A textile company and a competing manufacturer fight for the same order. Each books its own dyeing slot for the run.';
  ok(!gate(NEW, claim, COMMON), 'the rivalry CLAIM must still be caught — the fix must not have deleted the rule');
  console.log(`  the actual rivalry claim is still caught: ${!gate(NEW, claim, COMMON)}`);
}
console.log(`\n${fail ? `MUTATION FAILURES: ${fail}` : 'ALL MUTATION CHECKS PASSED'}`);
process.exit(fail ? 1 : 0);

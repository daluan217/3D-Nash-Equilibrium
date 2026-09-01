/**
 * BLUE-GATE — what the C3/C5/C6 narrowings ADMIT that the old rules rejected,
 * and whether the narrowed rules still catch what they are for.
 *
 * A narrowing is measured in two directions or not at all:
 *
 *   COST DIRECTION (rows newly ADMITTED): every row the old gate rejected and
 *   the new gate accepts, printed verbatim. If any of them is a real defect the
 *   narrowing is wrong, so they are hand-read rather than counted.
 *
 *   CAPABILITY DIRECTION (defects still CAUGHT): a planted positive for each
 *   narrowed member, asserted to STILL be rejected. A narrowing that quietly
 *   removed the rule would score perfectly on the cost direction alone — which
 *   is exactly the shape of a check that cannot fail.
 *
 *   npx tsx _gen/blue_gate_narrowcost.mjs
 */
import { loadCorpus, loadBank, describe } from './blue_gate_corpus.mjs';
import { scenarioIsClaimFree } from '../src/utils/nashValidator.ts';

/** The rules AS THEY SHIPPED, transcribed, so "before" is a real before. */
const OLD = [
  ['C3', /\b(?:respond(?:s|ing)?|reacts?(?:ing)?|depend(?:s|ing)?\s+on|hinges?\s+on|based\s+on|in\s+(?:response|reaction)(?:\s+to)?|in\s+turn|afterwards?|after\s+seeing|having\s+seen|once\s+(?:A|B|the\s+\w+)\s+(?:has\s+)?(?:chosen|picked|played|moved)|best\s+move|should\s+(?:choose|pick|play))\b/i],
  ['C5', /\b(?:before|after)\b[^.;]{0,45}?\b(?:chooses?|choosing|picks?|picking|decides?|deciding|selects?|selecting|plays?|playing|moves?|commits?)\b/i],
  ['C6-ordinal', /\b(?:goes?|moves?|chooses?|choosing|picks?|acts?|plays?)\s+(?:first|second)\b/i],
];
const normalizeProseMinus = (t) => t.replace(/[−﹣－]/g, '-');

const { rows, stats } = loadCorpus();
const bank = loadBank().map((e) => ({ src: 'SHIPPED_BANK', sc: e.s }));
const pool = [...rows, ...bank];
console.log(describe(stats));
console.log(`pool: ${pool.length} unique scenarios\n`);

const admitted = [];
for (const r of pool) {
  const d = normalizeProseMinus((r.sc.description ?? '').trim());
  if (!d) continue;
  const oldHits = OLD.filter(([, re]) => re.test(d)).map(([n]) => n);
  if (!oldHits.length) continue;
  const now = scenarioIsClaimFree(r.sc);
  if (now.ok) admitted.push({ r, oldHits, d });
}
console.log(`=== COST DIRECTION: rows the OLD rules rejected that the gate now ADMITS: ${admitted.length} ===`);
console.log('(every one printed verbatim — a rate whose hits have not been hand-read is not quotable here)\n');
const byRule = new Map();
for (const a of admitted) for (const n of a.oldHits) byRule.set(n, (byRule.get(n) ?? 0) + 1);
for (const [n, c] of byRule) console.log(`  ${n}: ${c}`);
console.log();
for (const a of admitted) console.log(`[${a.r.src}] ${a.oldHits.join('+')} :: ${a.d.slice(0, 240)}`);

/**
 * CAPABILITY. One planted positive per narrowed member, each written in the
 * shape the rule exists for, plus a NEGATIVE twin that must still pass — an
 * isolating pair, because a fixture that only ever asserts rejection cannot
 * tell a working rule from a rule that rejects everything.
 */
const sc = (description, over = {}) => ({ name: 'Ferry Slot', row1: 'Early Lift', row2: 'Late Lift', col1: 'Open Gate', col2: 'Hold Gate', description, ...over });
const ORDINAL_LABELS = { row1: 'First Slot', row2: 'Second Slot', col1: 'Open Early', col2: 'Open Late' };
const CASES = [
  // C3 respond: BY <verb-ing> and TO <the other> are claims; TO <an event> is not.
  ['C3 respond-by', sc('A masonry firm responds by choosing between Early Lift and Late Lift.'), false],
  ['C3 respond-by-preparing', sc('The ground-station network responds by preparing either Early Lift or Late Lift.'), false],
  ['C3 respond-to-other', sc('The ferry operator responds to the other yard by taking Early Lift.'), false],
  ['C3 respond-to-event OK', sc('Two neighbouring orchardists must decide how to respond to an approaching frost. One picks Early Lift or Late Lift; the other picks Open Gate or Hold Gate.'), true],
  // ARGUABLE, AND KEPT AS A REJECTION ON PURPOSE. I first read "procurement" as
  // a process, which would make this a false positive; RED-GATE read the trust
  // as player A and its procurement as A's own move, which places B's quote
  // after it. Checking the label slots says RED-GATE is right. Recorded here as
  // the one member of the eight where the two of us disagreed, so the next
  // person inherits the disagreement rather than the conclusion.
  ['C3 respond-to-possessive (arguable)', sc('A small masonry contractor picks Early Lift or Late Lift when responding to the trust’s procurement.'), false],
  ['C3 respond-to-same-situation OK', sc('The yard picks Early Lift or Late Lift. The keeper picks Open Gate or Hold Gate while responding to the same situation.'), true],
  // C3 afterward: a finite choosing verb makes it a sequence; a participial gloss does not.
  ['C3 afterward-finite', sc('The yard picks a slot, and the mill decides afterward.'), false],
  ['C3 afterward-gloss OK', sc('The consortium weighs Early Lift, launching before the thaw, and Late Lift, launching afterward. The gate keeper weighs Open Gate and Hold Gate.'), true],
  // C3 depends-on: deleted. Both readings must now pass.
  ['C3 depends-shared-resource OK', sc('Two vineyard owners depend on a shared reservoir during a hot season. One weighs Early Lift or Late Lift; the other weighs Open Gate or Hold Gate.'), true],
  ['C3 depends-joint-outcome OK', sc('Each grower weighs Early Lift or Late Lift while the keeper weighs Open Gate or Hold Gate; the result depends on the combination of the two.'), true],
  // C5: actor reading fires, event reading does not.
  ['C5 actor', sc('The yard settles its slot before a port manager chooses Open Gate.'), false],
  ['C5 actor-with-aside', sc('Before the shipper commits, the mill takes Early Lift.'), false],
  ['C5 event-comma OK', sc('Before the event, each operator weighs Early Lift or Late Lift, and the gate keeper weighs Open Gate or Hold Gate.'), true],
  ['C5 event-conjunction OK', sc('A hut operator is preparing the lifeline before a severe winter and weighs Early Lift against Late Lift. The keeper weighs Open Gate or Hold Gate.'), true],
  ['C5 event-colon OK', sc('Each must plan their section before winter: one weighs Early Lift or Late Lift, the other Open Gate or Hold Gate.'), true],
  // C6: the ordinal as a move order fires; the ordinal as this scenario's own label does not.
  ['C6 order', sc('The gardener chooses first, then the boat keeper settles the lock.', ORDINAL_LABELS), false],
  ['C6 label OK', sc('The gardener chooses First Slot or Second Slot, while the boat keeper weighs Open Early and Open Late.', ORDINAL_LABELS), true],
  ['C6 label-not-mine', sc('The gardener chooses First Slot for the lock, while the keeper weighs Open Gate and Hold Gate.'), false],
];
console.log('\n=== CAPABILITY DIRECTION: planted cases (expected = does the gate ACCEPT it?) ===');
let bad = 0;
for (const [name, s, expectOk] of CASES) {
  const v = scenarioIsClaimFree(s);
  const pass = v.ok === expectOk;
  if (!pass) bad++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} accepted=${v.ok}${v.ok ? '' : ` (${v.reason})`}`);
}
console.log(bad ? `\n${bad} CASES FAILED — the narrowing is wrong in at least one direction.` : '\nall planted cases behave as specified in BOTH directions.');
if (bad) process.exit(1);

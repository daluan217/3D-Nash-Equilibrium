/**
 * BLUE-GATE — per-MEMBER attribution inside `scenarioIsClaimFree`'s CLAIMY table.
 *
 * The gate reports the FIRST rule that fires, so a rule's cost is invisible
 * behind whichever rule precedes it. This harness asks the two questions a
 * narrowing decision actually needs:
 *
 *   1. which ALTERNATION MEMBER matched — not just which rule
 *   2. is this rule the SOLE reason the row is rejected (drop it and the row
 *      ships) or is the row already dead for another reason (drop it and
 *      nothing changes)
 *
 * A rule whose every hit is also caught elsewhere costs nothing to remove and
 * gains nothing to keep; only the SOLE column is a real price.
 *
 *   npx tsx _gen/blue_gate_claimy.mjs [rule-substring]
 */
import { loadCorpus, loadBank, describe } from './blue_gate_corpus.mjs';
import { scenarioIsClaimFree } from '../src/utils/nashValidator.ts';

const { rows, stats } = loadCorpus();
const bank = loadBank().map((e) => ({ src: 'SHIPPED_BANK', sc: e.s, g: null }));
const pool = [...rows, ...bank];
console.log(describe(stats));
console.log(`pool: ${rows.length} corpus + ${bank.length} shipped-bank = ${pool.length} unique scenarios\n`);

/**
 * The CLAIMY members, transcribed from nashValidator.ts one alternation branch
 * at a time. Transcription is a risk — a copy drifts from the shipped rule — so
 * `parityCheck` below asserts that the union of these reproduces the shipped
 * function's verdict on every row of the pool before any number is printed.
 */
const MEMBERS = [
  ['C1 comparative/payoff word', /\b(?:better|worse|best|worst|prefers?|favou?rs?|dominant|dominates?|optimal|advantage|equilibri(?:um|a)|indifferent|gains?\s+more|loses?\s+more)\b/i],
  ['C2 payoff word + comparison', /\b(?:payoffs?|returns?|rewards?)\b[^.;]{0,40}?\b(?:higher|lower|greater|larger|smaller|bigger|more|less|equal|same|highest|lowest|maximis\w*|maximiz\w*|minimis\w*|minimiz\w*|exceed\w*|outweigh\w*)\b|\b(?:higher|lower|greater|larger|smaller|bigger|highest|lowest|equal|same)\b[^.;]{0,40}?\b(?:payoffs?|returns?|rewards?)\b/i],
  ['C3 how one answers the other', /\b(?:respond(?:s|ing)?|reacts?(?:ing)?|depend(?:s|ing)?\s+on|hinges?\s+on|based\s+on|in\s+(?:response|reaction)(?:\s+to)?|in\s+turn|afterwards?|after\s+seeing|having\s+seen|once\s+(?:A|B|the\s+\w+)\s+(?:has\s+)?(?:chosen|picked|played|moved)|best\s+move|should\s+(?:choose|pick|play))\b/i],
  ['C4 conditional outcome', /\b(?:if|when|whenever|unless|whichever|whatever|regardless\s+of|no\s+matter)\b[^.;]{0,60}?\b(?:then\s+)?(?:gains?|loses?|wins?|earns?|is\s+better|does\s+better|pays?\s+off)\b/i],
  ['C5 before/after move order', /\b(?:before|after)\b[^.;]{0,45}?\b(?:chooses?|choosing|picks?|picking|decides?|deciding|selects?|selecting|plays?|playing|moves?|commits?)\b/i],
  ['C6 ordinal move order', /\b(?:goes?|moves?|chooses?|choosing|picks?|acts?|plays?)\s+(?:first|second)\b|\b(?:first|second)\s+(?:mover|player\s+to\s+(?:move|choose|act))\b|\bobserv\w+\b[^.;]{0,40}?\b(?:then|before)\b|\b(?:then|and)\s+(?:B|A|the\s+\w+)\s+(?:follows?|responds?|replies|counters?)\b|\bcommits?\s+(?:first|initially)\b|\b(?:follows?|replies|responds?)\s+(?:to\s+)?the\s+(?:first|other)\b/i],
  ['C7 offer/accept', /^(?=[\s\S]*\b(?:offer|propose|tender|submit)(?:s|ed|ing)?\b|[\s\S]*\bbids?\b)(?=[\s\S]*\b(?:accept|reject|decline|approve)(?:s|ed|ing)?\b)/i],
  ['C8 binding agreement', /\b(?:reach(?:es|ed)?|strikes?|struck|settles?\s+on|settled\s+on|comes?\s+to|came\s+to)\s+(?:an?\s+)?(?:agreement|deal|terms|accord)\b|\bcome\s+to\s+terms\b|\bagree(?:s|d)?\s+(?:on|to|upon)\b|\bbinding\b|\benforceabl\w*\b|\bin\s+(?:exchange|return)\b/i],
];

/** Sub-members of C3 and C6, the two rules under suspicion, split for pricing. */
const SUBMEMBERS = {
  'C3 how one answers the other': [
    ['respond/react', /\b(?:respond(?:s|ing)?|reacts?(?:ing)?)\b/i],
    ['depends on', /\bdepend(?:s|ing)?\s+on\b/i],
    ['hinges on', /\bhinges?\s+on\b/i],
    ['based on', /\bbased\s+on\b/i],
    ['in response/reaction', /\bin\s+(?:response|reaction)(?:\s+to)?\b/i],
    ['in turn', /\bin\s+turn\b/i],
    ['afterward(s)', /\bafterwards?\b/i],
    ['after seeing / having seen', /\b(?:after\s+seeing|having\s+seen)\b/i],
    ['once A/B has chosen', /\bonce\s+(?:A|B|the\s+\w+)\s+(?:has\s+)?(?:chosen|picked|played|moved)\b/i],
    ['best move', /\bbest\s+move\b/i],
    ['should choose/pick/play', /\bshould\s+(?:choose|pick|play)\b/i],
  ],
  'C6 ordinal move order': [
    ['verb + first/second', /\b(?:goes?|moves?|chooses?|choosing|picks?|acts?|plays?)\s+(?:first|second)\b/i],
    ['first/second mover', /\b(?:first|second)\s+(?:mover|player\s+to\s+(?:move|choose|act))\b/i],
    ['observ… then/before', /\bobserv\w+\b[^.;]{0,40}?\b(?:then|before)\b/i],
    ['then/and X follows', /\b(?:then|and)\s+(?:B|A|the\s+\w+)\s+(?:follows?|responds?|replies|counters?)\b/i],
    ['commits first', /\bcommits?\s+(?:first|initially)\b/i],
    ['follows/replies to the first', /\b(?:follows?|replies|responds?)\s+(?:to\s+)?the\s+(?:first|other)\b/i],
  ],
  'C8 binding agreement': [
    ['reach/strike an agreement', /\b(?:reach(?:es|ed)?|strikes?|struck|settles?\s+on|settled\s+on|comes?\s+to|came\s+to)\s+(?:an?\s+)?(?:agreement|deal|terms|accord)\b|\bcome\s+to\s+terms\b/i],
    ['agree on/to/upon', /\bagree(?:s|d)?\s+(?:on|to|upon)\b/i],
    ['binding', /\bbinding\b/i],
    ['enforceable', /\benforceabl\w*\b/i],
    ['in exchange/return', /\bin\s+(?:exchange|return)\b/i],
  ],
  'C5 before/after move order': [
    ['before…verb', /\bbefore\b[^.;]{0,45}?\b(?:chooses?|choosing|picks?|picking|decides?|deciding|selects?|selecting|plays?|playing|moves?|commits?)\b/i],
    ['after…verb', /\bafter\b[^.;]{0,45}?\b(?:chooses?|choosing|picks?|picking|decides?|deciding|selects?|selecting|plays?|playing|moves?|commits?)\b/i],
  ],
};

/** The file's own minus normaliser, so the transcription sees what the gate sees. */
const normalizeProseMinus = (t) => t.replace(/[−﹣－]/g, '-');

function descOf(sc) { return normalizeProseMinus((sc.description ?? '').trim()); }

/**
 * PARITY. Before any rate is printed, assert that this transcription agrees with
 * the shipped function: every row the union of MEMBERS rejects must be rejected
 * by the gate too. (The converse does not hold — the gate also has numeral,
 * META and STRUCTURAL rules — so the check is one-directional by design and the
 * direction is stated rather than implied.)
 */
let parityFails = 0;
for (const r of pool) {
  const d = descOf(r.sc);
  if (!d) continue;
  const fires = MEMBERS.some(([, re]) => re.test(d));
  if (fires && scenarioIsClaimFree(r.sc).ok) parityFails++;
}
console.log(parityFails === 0
  ? 'PARITY OK: every row my transcription rejects, the shipped gate also rejects.'
  : `PARITY FAILED on ${parityFails} rows — the transcription has drifted; numbers below are void.`);
/**
 * NEGATION CONTROL. A parity check that passes because the transcription never
 * fires is worthless, so a planted positive must fire — and a planted negative
 * must not. Both are asserted; a harness that "found no mismatch" for truthful
 * AND negated claims alike is a documented failure mode in this repo.
 */
{
  const plantedBad = { name: 'X', row1: 'P', row2: 'Q', col1: 'R', col2: 'S', description: 'The mill responds to the shipper by choosing Early Run.' };
  const plantedGood = { name: 'X', row1: 'P', row2: 'Q', col1: 'R', col2: 'S', description: 'A mill and a shipper each pick a slot for the week.' };
  const badFires = MEMBERS.some(([, re]) => re.test(descOf(plantedBad)));
  const goodFires = MEMBERS.some(([, re]) => re.test(descOf(plantedGood)));
  console.log(`NEGATION CONTROL: planted claim fires=${badFires} (must be true), planted clean fires=${goodFires} (must be false)`);
  if (!badFires || goodFires) { console.log('CONTROL FAILED — numbers below are void.'); process.exit(1); }
}
console.log();

const want = process.argv[2] ?? '';
for (const [name, re] of MEMBERS) {
  if (want && !name.includes(want)) continue;
  const hits = pool.filter((r) => { const d = descOf(r.sc); return d && re.test(d); });
  // SOLE: no other CLAIMY member fires on this row. The gate's other families
  // (numeral, META, STRUCTURAL) are excluded from "sole" on purpose — they are a
  // separate decision, and folding them in would let a CLAIMY rule look free
  // because META happens to cover it today.
  const sole = hits.filter((r) => { const d = descOf(r.sc); return !MEMBERS.some(([n2, re2]) => n2 !== name && re2.test(d)); });
  console.log(`\n=== ${name}: ${hits.length} hits, ${sole.length} SOLE (this rule alone rejects the row) ===`);
  const subs = SUBMEMBERS[name];
  if (subs) {
    for (const [sn, sre] of subs) {
      const sh = hits.filter((r) => sre.test(descOf(r.sc)));
      const ss = sole.filter((r) => sre.test(descOf(r.sc)));
      if (sh.length) console.log(`   member "${sn}": ${sh.length} hits, ${ss.length} sole`);
    }
  }
  const show = sole.length ? sole : hits;
  console.log(`   --- ${sole.length ? 'SOLE' : 'all'} hits verbatim (hand-read these) ---`);
  for (const r of show.slice(0, Number(process.env.N ?? 60))) {
    const d = descOf(r.sc);
    const m = re.exec(d);
    const i = m.index;
    console.log(`   [${r.src}] …${d.slice(Math.max(0, i - 70), i)}>>>${m[0]}<<<${d.slice(i + m[0].length, i + m[0].length + 70)}…`);
  }
  if (show.length > Number(process.env.N ?? 60)) console.log(`   … ${show.length - Number(process.env.N ?? 60)} more`);
}

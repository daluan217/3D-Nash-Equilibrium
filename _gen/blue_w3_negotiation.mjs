/**
 * BLUE — WINDOW 3: the NEGOTIATION form, RED 1's largest remaining oracle hole.
 *
 *   "The two yards negotiate over the rack calendar. One side offers an Early
 *    Slot or a Late Slot and the other accepts a Shared Window or a Separate
 *    Window in exchange."
 *
 * False about EVERY game this app models, not just this matrix: it asserts a
 * bargaining protocol, a sequence (offer then accept), and a binding agreement,
 * in a one-shot simultaneous non-cooperative game. That makes it the same family
 * as the move-order and "responds to" rules already in CLAIMY — decidable from
 * the sentence alone, with no matrix conditioning.
 *
 * DESIGN IS NOT THE FIRST STEP. MEASUREMENT IS. Every word in the obvious list
 * has an ordinary business sense the model uses constantly — "the bakery OFFERS
 * two loaf sizes", "a CONTRACT grower", "payment TERMS". This script prices each
 * candidate against the whole stored corpus and PRINTS EVERY HIT, so "is that a
 * false positive?" is answered by reading the sentence, not by trusting a rate.
 *
 *   npx tsx _gen/blue_w3_negotiation.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
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
    rows.push({ src: tag, i: r.i ?? r.pair, sc: r.sc, d: String(r.sc.description ?? '') });
  }
}
console.log(`corpus: ${rows.length} stored scenarios\n`);

// The two players as an ABSTRACT subject — the discriminator that made the
// F1-vocab screen shippable. Reused here rather than reinvented.
const ABSTRACT = String.raw`(?:the\s+two|both|the)\s+(?:players?|parties|sides|firms?|companies|operators?|institutions?|participants?|agents?|actors?|yards?|cooperatives?|teams?)`;

const CANDIDATES = [
  ['W1  bare "negotiat*"', /\bnegotiat/i],
  ['W2  bargain / haggle / barter', /\bbargain|\bhaggl|\bbarter/i],
  ['W3  bare "offer*"  (expected: the ordinary "provides" sense, in bulk)', /\boffers?\b|\boffering\b|\boffered\b/i],
  ['W4  bare "accept*"', /\baccepts?\b|\baccepting\b|\baccepted\b/i],
  ['W5  bare "agree*"', /\bagree(?:s|d|ing|ment|ments)?\b/i],
  ['W6  deal / contract / terms', /\bdeals?\b|\bcontracts?\b|\bterms\b/i],
  ['W7  "in exchange"', /\bin\s+exchange\b/i],
  ['W8  settle on / come to terms / strike a deal / reach an agreement',
    /\bsettles?\s+on\b|\bcome\s+to\s+terms\b|\bstrikes?\s+a\s+deal\b|\breach(?:es)?\s+an?\s+agreement\b/i],

  // ── STRUCTURAL candidates: the protocol, not the vocabulary ──
  ['S1  the two players NEGOTIATE (abstract subject + bargaining verb)',
    new RegExp(String.raw`\b${ABSTRACT}\b[^.!?]{0,40}?\b(?:negotiate|negotiates|negotiating|bargain|bargains|bargaining|haggle|haggles)\b`, 'i')],
  ['S2  OFFER and ACCEPT both present as MOVES (one side offers … the other accepts)',
    /\b(?:one\s+(?:side|party|player)|the\s+(?:first|other)\s+(?:side|party|player)|either\s+side)\b[^.!?]{0,80}?\boffers?\b[\s\S]{0,160}?\baccepts?\b/i],
  ['S3  offer-verb and accept-verb anywhere in the same description',
    (d) => /\boffers?\b/i.test(d) && /\baccepts?\b/i.test(d)],
  ['S4  agreement as an OUTCOME of this game (agree + on/to a choice)',
    /\bagree(?:s|d|ing)?\s+(?:on|to|upon)\b/i],
  ['S5  binding language',
    /\bbinding\b|\benforceabl|\bcommits?\s+(?:both|each other|the other)\b|\bcontract\s+(?:binds|obliges)/i],
];

for (const [label, pred] of CANDIDATES) {
  const test = typeof pred === 'function' ? pred : (d) => pred.test(d);
  const hits = rows.filter((r) => test(r.d));
  const pct = (100 * hits.length / rows.length).toFixed(2);
  console.log(`${label}\n    ${hits.length}/${rows.length} = ${pct}%`);
  for (const h of hits.slice(0, 12)) {
    console.log(`      ${h.src}#${h.i}: ${h.d.slice(0, 210)}`);
  }
  if (hits.length > 12) console.log(`      … ${hits.length - 12} more`);
  console.log('');
}

// ── REFINED ARMS: the shape actually proposed for the gate ──────────────────
console.log('══ REFINED: the two arms proposed for the gate ══\n');
const OFFER_NARROW = /\boffer(?:s|ed|ing)?\b/i;
const OFFER_WIDE = /\b(?:offer|propose|tender|bid|submit)(?:s|ted|ded|ed|ing)?\b/i;
const TAKE = /\b(?:accept|reject|decline|approve|turn\s+down)(?:s|ed|ing)?\b/i;
const BINDING = /\b(?:reach(?:es|ed)?|strike[sd]?|settle[sd]?\s+on|come[s]?\s+to)\s+(?:an?\s+)?(?:agreement|deal|terms|accord)\b|\bcome\s+to\s+terms\b|\bagree(?:s|d)?\s+(?:on|to|upon)\b|\bbinding\b|\benforceabl\w*\b|\bin\s+(?:exchange|return)\b/i;
const ARMS = [
  ['P1  offer-verb AND accept/reject-verb (the narrow conjunction)', (d) => OFFER_NARROW.test(d) && TAKE.test(d)],
  ['P2  WIDE offer/propose/bid/tender/submit AND accept/reject', (d) => OFFER_WIDE.test(d) && TAKE.test(d)],
  ['P3  binding-agreement arm', (d) => BINDING.test(d)],
  ['P1|P3  the proposed gate', (d) => (OFFER_NARROW.test(d) && TAKE.test(d)) || BINDING.test(d)],
  ['P2|P3  the widened gate', (d) => (OFFER_WIDE.test(d) && TAKE.test(d)) || BINDING.test(d)],
];
for (const [label, pred] of ARMS) {
  const hits = rows.filter((r) => pred(r.d));
  console.log(`${label}\n    ${hits.length}/${rows.length} = ${(100 * hits.length / rows.length).toFixed(2)}%`);
  for (const h of hits.slice(0, 8)) console.log(`      ${h.src}#${h.i}: ${h.d.slice(0, 230)}`);
  console.log('');
}
// And the target: RED 1's hole must be caught by whatever ships.
const RED1 = 'The two yards negotiate over the rack calendar. One side offers an Early Slot or a Late Slot and the other accepts a Shared Window or a Separate Window in exchange.';
console.log(`RED 1 hole caught by P1|P3 : ${(OFFER_NARROW.test(RED1) && TAKE.test(RED1)) || BINDING.test(RED1)}`);

/**
 * BLUE-GATE — has the defect the DEAD role-noun rule guards actually occurred?
 *
 * `validateScenario`'s role-noun misattribution check is gated on
 * `sc.actorA`/`sc.actorB`. The cloud schema (SCENARIO_SCHEMA -> REPORT_SCHEMA's
 * suggestedScenario) does not declare those fields and providers.ts grafts
 * `additionalProperties:false` with `strict:true`, so a cloud draw CANNOT carry
 * them; the local llama-server honours no schema but has never emitted them.
 * The rule therefore cannot fire, and its own comment calls the defect it guards
 * "the most common remaining error in this report".
 *
 * Deleting a rule because it cannot fire is only half an answer. The other half
 * is whether the DEFECT is there. So this measures the class WITHOUT the actor
 * mapping, using the two forms that are decidable from the scenario alone:
 *
 *   FORM 1 (decidable, no mapping needed): two DIFFERENT named subjects are each
 *     said to choose an option, and both named options come from the SAME
 *     player's pair. One of them is necessarily wrong whichever way the roles
 *     map, because the other player's pair is then unowned.
 *
 *   FORM 2 (decidable): ONE subject is said to choose an option from A's pair
 *     and, elsewhere, an option from B's pair. Whichever player it is, half of
 *     that is the other player's option.
 *
 * What is NOT decidable without actorA/actorB is the SWAP — "the gatekeeper
 * chooses Ford River" where the gatekeeper happens to be B. That is stated as a
 * limit rather than engineered around, and it is exactly why the rule needed the
 * declaration in the first place.
 *
 *   npx tsx _gen/blue_gate_misattr.mjs
 */
import { loadCorpus, loadBank, describe } from './blue_gate_corpus.mjs';

const { rows, stats } = loadCorpus();
const bank = loadBank().map((e) => ({ src: 'SHIPPED_BANK', sc: e.s }));
const pool = [...rows, ...bank];
console.log(describe(stats));
console.log(`pool: ${pool.length} unique scenarios\n`);

const VERB = String.raw`(?:chooses?|choosing|picks?|picking|selects?|selecting|uses?|plays?|takes?|opts?\s+for|goes?\s+(?:with|for))`;
/**
 * The subject slot excludes MODALS, and that was found by reading the output
 * rather than by reasoning: a lazy subject capture in front of "must choose
 * between X and Y" returns the subject "must", and the enumerating form then
 * reads as two different pairs claimed by one party. All five of the first
 * run's FORM 2 hits were that artefact and none was a defect. "between" is
 * likewise NOT consumed by the optional prefix, so the enumerating form can be
 * recognised and skipped instead of being silently parsed as an attribution.
 */
const MODAL = /^(?:must|will|can|should|would|could|may|might|shall|to|then|also|now|each|both|either|who|which|that|and|or|but|so|it|they|he|she|we)$/i;
const CLAUSE = new RegExp(
  String.raw`\b(?:the\s+|a\s+|an\s+)?([A-Za-z][\w'’ -]{2,34}?)\s+${VERB}\s+(?:the\s+|an?\s+)?([\w'’ -]{2,40}?)\s*(?=[,.;:]|\band\b|\bwhile\b|\bor\b|$)`,
  'gi',
);

const norm = (s) => (s ?? '').trim().toLowerCase().replace(/[“”"'’]/g, '').replace(/\s+/g, ' ');
/**
 * THE SUBJECT KEY MUST STRIP LEADING FUNCTION WORDS, and the first version did
 * not — which the CONTROL caught, not the corpus. "while the gatekeeper" and
 * "the gatekeeper" keyed as two different actors, and "later the traveller"
 * keyed as a third, so FORM 2 (one actor naming BOTH pairs) could never fire on
 * any sentence that reintroduced the actor with an adverb in front. The corpus
 * had reported a clean 0 through that hole.
 */
const subjKey = (s) => {
  let t = norm(s);
  for (;;) {
    const u = t.replace(/^(?:while|whereas|meanwhile|later|then|and|but|so|also|now|a|an|the|each|both|either|neither|its|their|his|her|our|second|first|other|another|same|nearby|local|regional|national|small|large|major|minor)\s+/, '');
    if (u === t) return t;
    t = u;
  }
};

let form1 = 0, form2 = 0, scanned = 0;
const hits1 = [], hits2 = [];

for (const r of pool) {
  const sc = r.sc;
  const d = (sc.description ?? '').trim();
  if (!d) continue;
  const aPair = [sc.row1, sc.row2].map(norm).filter(Boolean);
  const bPair = [sc.col1, sc.col2].map(norm).filter(Boolean);
  if (aPair.length !== 2 || bPair.length !== 2) continue;
  // A scenario whose two pairs OVERLAP cannot answer the question: an option
  // present in both pairs has no owner to be wrong about. Excluded, and counted,
  // rather than silently scored — label collision is 14.7% of this pool.
  if (aPair.some((x) => bPair.includes(x))) continue;
  scanned++;

  /** (subject -> set of pairs it was said to choose from) */
  const bySubject = new Map();
  for (const m of d.matchAll(CLAUSE)) {
    const subj = subjKey(m[1]);
    const named = norm(m[2]);
    if (MODAL.test(subj)) continue;
    // "between X and Y" enumerates a player's own pair — the correct shape.
    if (!named || /^between\b/.test(named)) continue;
    const owner = aPair.includes(named) ? 'A' : bPair.includes(named) ? 'B' : null;
    if (!owner) continue;
    if (!bySubject.has(subj)) bySubject.set(subj, new Set());
    bySubject.get(subj).add(owner);
  }
  const subjects = [...bySubject.entries()];
  if (subjects.length >= 2) {
    const owners = new Set(subjects.flatMap(([, s]) => [...s]));
    // Two distinct subjects, and between them they only ever name ONE player's
    // pair: the other pair is unowned by the prose.
    if (owners.size === 1) { form1++; hits1.push({ r, subjects, d }); }
  }
  for (const [subj, owners] of subjects) {
    if (owners.size === 2) { form2++; hits2.push({ r, subj, d }); break; }
  }
}

console.log(`scannable (distinct pairs, both labelled): ${scanned}\n`);
console.log(`FORM 1 — two subjects, both naming the SAME player's pair: ${form1} (${(100 * form1 / scanned).toFixed(3)}%)`);
for (const h of hits1.slice(0, 40)) {
  console.log(`  [${h.r.src}] ${h.r.sc.name} | A:${h.r.sc.row1}/${h.r.sc.row2} B:${h.r.sc.col1}/${h.r.sc.col2}`);
  console.log(`     subjects: ${h.subjects.map(([s, o]) => `"${s}"->${[...o]}`).join(', ')}`);
  console.log(`     ${h.d.slice(0, 260)}`);
}
if (hits1.length > 40) console.log(`  … ${hits1.length - 40} more`);

console.log(`\nFORM 2 — one subject naming options from BOTH pairs: ${form2} (${(100 * form2 / scanned).toFixed(3)}%)`);
for (const h of hits2.slice(0, 40)) {
  console.log(`  [${h.r.src}] ${h.r.sc.name} | A:${h.r.sc.row1}/${h.r.sc.row2} B:${h.r.sc.col1}/${h.r.sc.col2}`);
  console.log(`     subject "${h.subj}"`);
  console.log(`     ${h.d.slice(0, 260)}`);
}
if (hits2.length > 40) console.log(`  … ${hits2.length - 40} more`);

/**
 * CONTROL. A detector that reports zero on every corpus is indistinguishable
 * from a detector that cannot fire, and this repo has shipped one of those
 * (`equilibria` passed where `claimedEquilibria` was wanted; the harness bailed
 * at a shape guard and reported "no mismatch" for truthful AND negated claims
 * alike). So both forms are planted and must be detected, and a correct row
 * must not be.
 */
{
  const mk = (description) => ({ name: 'Ferry Crossing', row1: 'Ford River', row2: 'Use Bridge', col1: 'Open Gate', col2: 'Hold Gate', description });
  const probe = (sc) => {
    const aPair = [sc.row1, sc.row2].map(norm), bPair = [sc.col1, sc.col2].map(norm);
    const by = new Map();
    for (const m of (sc.description).matchAll(CLAUSE)) {
      const s = subjKey(m[1]), n = norm(m[2]);
      if (MODAL.test(s) || !n || /^between\b/.test(n)) continue;
      const o = aPair.includes(n) ? 'A' : bPair.includes(n) ? 'B' : null;
      if (!o) continue;
      if (!by.has(s)) by.set(s, new Set());
      by.get(s).add(o);
    }
    const subs = [...by.entries()];
    const f1 = subs.length >= 2 && new Set(subs.flatMap(([, x]) => [...x])).size === 1;
    const f2 = subs.some(([, x]) => x.size === 2);
    return { f1, f2, subs: subs.map(([s, x]) => `${s}->${[...x]}`) };
  };
  const good = probe(mk('The traveller chooses Ford River, while the gatekeeper chooses Open Gate.'));
  const bad1 = probe(mk('The traveller chooses Ford River, while the gatekeeper chooses Use Bridge.'));
  const bad2 = probe(mk('The traveller chooses Ford River. Later the traveller chooses Open Gate.'));
  console.log('\nCONTROLS (a zero result is only meaningful if the planted defects fire):');
  console.log(`  correct row          -> FORM1=${good.f1} FORM2=${good.f2}  [${good.subs}]   (both must be false)`);
  console.log(`  both subjects on A   -> FORM1=${bad1.f1} FORM2=${bad1.f2}  [${bad1.subs}]   (FORM1 must be true)`);
  console.log(`  one subject on both  -> FORM1=${bad2.f1} FORM2=${bad2.f2}  [${bad2.subs}]   (FORM2 must be true)`);
  if (good.f1 || good.f2 || !bad1.f1 || !bad2.f2) { console.log('  CONTROL FAILED — the zero above means nothing.'); process.exit(1); }
  console.log('  controls pass: the zero above is a real absence, not a dead instrument.');
}

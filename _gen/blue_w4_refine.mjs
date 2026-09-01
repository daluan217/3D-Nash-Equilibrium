/**
 * BLUE — WINDOW 4: the two-chooser rules, priced on EVERY corpus this campaign
 * has, old and new.
 *
 * The feasibility pass (blue_w4_twochooser.mjs) used bare vocabulary and showed
 * the family is worth doing. This one builds the STRUCTURAL discriminators the
 * real rules need, because reading the hits showed the bare forms are ambiguous
 * in a way the corpus alone cannot settle:
 *
 *   "also chooses"  ->  "The airport will ALSO choose"  is one actor taking a
 *                       second decision (the defect), but "the haulier also
 *                       chooses" is "the haulier, TOO, chooses" — the second
 *                       actor, which is correct and natural. The word is the
 *                       same. The discriminator is whether the subject is an
 *                       actor already seen.
 *   pronoun subject ->  "It chooses either Local Sales or Online Sales" is the
 *                       defect only because no second actor was ever named. A
 *                       pronoun referring to a properly introduced second
 *                       player is fine.
 *
 * So both rules are conditioned on the description's OWN cast, not on a word.
 *
 *   npx tsx _gen/blue_w4_refine.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const OLD = [`${S}/rt1.jsonl`, `${S}/rt2.jsonl`, `${S}/pilot.jsonl`, '/tmp/rt2_local.jsonl', '/tmp/rt2_cloud.jsonl',
  '/tmp/rt2_pilot.jsonl', '/tmp/rt2_cloudpilot.jsonl', '/tmp/rt2_stakes_local.jsonl', '/tmp/rt2_stakes_cloud.jsonl',
  '/tmp/rt2_stakes_cloud_hint.jsonl', '/tmp/rt2_stakes_pilot.jsonl'];
// RED 1's NEW draws — a distribution the 890 rows do not contain, including the
// stakes hint and the gap ladder. Measuring only on the corpus a rule was
// designed against is how a rule looks free and is not.
const NEW = ['/tmp/rt3_character_cloud.jsonl', '/tmp/rt3_character_local.jsonl', '/tmp/rt3_stakes_cloud.jsonl',
  '/tmp/rt3_stakes_local.jsonl', '/tmp/rt3_local_capability.jsonl', '/tmp/rt3_slot_control.jsonl',
  '/tmp/rt2_gapladder_g25.jsonl', '/tmp/rt2_gapladder_g25_rated.jsonl', '/tmp/rt3_yield_cost.jsonl',
  '/tmp/rt_stakes_leak_cloud.jsonl', '/tmp/rt_stakes_leak_local.jsonl',
  '/tmp/rt2_gap_cloud_w1_g25.jsonl', '/tmp/rt2_gap_cloud_w3_g25.jsonl', '/tmp/rt2_gap_cloud_w4_g25.jsonl'];
const load = (files, tag) => {
  const out = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const base = f.split('/').pop().replace('.jsonl', '');
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!r.sc) continue;
      out.push({ set: tag, src: base, i: r.i ?? r.pair, sc: r.sc, d: String(r.sc.description ?? ''), gate: r.gate });
    }
  }
  return out;
};
const oldRows = load(OLD, 'old');
const newRows = load(NEW, 'new');
const rows = [...oldRows, ...newRows];
// Only draws the gate ACCEPTS can be newly rejected by anything.
const passing = rows.filter((r) => r.gate?.ok !== false);
console.log(`corpus: ${rows.length} draws (${oldRows.length} old + ${newRows.length} NEW), ${passing.length} gate-passing\n`);

// ── Cast analysis: who, in this description, performs a choosing verb? ──────
const CHOOSE = String.raw`(?:chooses|choose|choosing|picks|pick|picking|decides|decide|deciding|selects|select|selecting|opts|opt|books|book)`;
const PRONOUN = /^(?:it|he|she|they|each|both)$/i;
// Split into clauses: sentence breaks, and before the connectives that start a
// new actor's clause ("X chooses A, WHILE Y chooses B" is two choosers).
const clausesOf = (d) => d.split(/(?<=[.;!?])\s+|\s*,?\s+(?=while\b|whereas\b)/i).filter((s) => s.trim());
const HEAD = /([A-Za-z][\w'’-]*)\s*$/;
const STOP = new Set(['the', 'a', 'an', 'its', 'their', 'his', 'her', 'this', 'that', 'these', 'those', 'same',
  'each', 'both', 'either', 'neither', 'must', 'will', 'also', 'then', 'and', 'or', 'independently', 'simultaneously']);

function cast(d) {
  const nounChoosers = new Set();
  const pronounChoosers = [];
  for (const c of clausesOf(d)) {
    const m = new RegExp(String.raw`^(.*?)\b(?:will\s+|must\s+|is\s+|are\s+|then\s+|also\s+|independently\s+|simultaneously\s+)*${CHOOSE}\b`, 'i').exec(c);
    if (!m) continue;
    const subj = m[1].trim();
    if (!subj) continue;
    const words = subj.split(/\s+/).filter(Boolean);
    const last = words[words.length - 1]?.replace(/[^A-Za-z'’-]/g, '') ?? '';
    if (PRONOUN.test(last) && words.length <= 2) { pronounChoosers.push(last.toLowerCase()); continue; }
    // Head noun of the subject, skipping determiners/modals.
    const h = HEAD.exec(subj.replace(/\s+(?:will|must|is|are|also|then|independently|simultaneously)\s*$/i, ''));
    if (h && !STOP.has(h[1].toLowerCase())) nounChoosers.add(h[1].toLowerCase().replace(/s$/, ''));
  }
  return { nounChoosers, pronounChoosers };
}

// ── THE THREE RULES, after reading every hit of the first draft. ───────────
// The first draft produced one false positive per rule, and each was MY bug,
// not the model's. They are recorded because each is a class:
//
//   C1  captured "is" as the subject of "…is ALSO choosing" and then stripped
//       its trailing s, so it compared the word "i" against the text and
//       matched everything. "A smaller independent distributor is also
//       choosing" is CORRECT output — "also" there means "likewise", a second
//       actor — and the rule flagged it.
//   C2  counted only CHOOSING verbs when counting the cast, so "A regional
//       airline is PLANNING a series of flights… It chooses… while the glacier
//       manager chooses…" looked like it had one actor. It has two.
//   C4' fired on "chooses the same PRODUCT through the same season", where the
//       thing shared is the object of the game, not the move.
const AUX = /^(?:is|are|was|were|will|must|can|could|would|should|may|might|has|have|had|been|be|also|then)$/i;

// C1: an "also choose" whose SUBJECT is an actor ALREADY SEEN. That is one
// actor taking a second decision. A newly introduced actor with "also" is the
// ordinary "likewise" reading and must pass.
const C1 = (d) => {
  const re = /\b([A-Za-z][\w'’-]*)\s+(?:is|are|will|must|can|would|should|may)?\s*also\s+(?:choose|chooses|choosing|decide|decides|deciding|pick|picks|picking|select|selects|selecting)\b/gi;
  for (const m of d.matchAll(re)) {
    const w = m[1];
    if (AUX.test(w) || STOP.has(w.toLowerCase())) continue;
    const head = w.toLowerCase();
    const sing = head.length > 3 ? head.replace(/s$/, '') : head;
    const before = d.slice(0, m.index);
    if (new RegExp(String.raw`\b${sing}s?\b`, 'i').test(before)) return true;
  }
  return false;
};

// C2: a SINGULAR pronoun performs a choosing verb while the description names
// fewer than two distinct actors. The cast is counted over actor-introducing
// verbs too, not only choosing verbs, because an actor is often introduced with
// "is planning" / "operates" / "runs" and only later chooses.
const ACTOR_VERB = String.raw`(?:chooses|choose|choosing|picks|pick|picking|decides|decide|deciding|selects|select|selecting|opts|opt|books|book|plans|plan|planning|operates|operate|operating|runs|run|running|schedules|schedule|scheduling|weighs|weigh|weighing|considers|consider|considering|manages|manage|managing|faces|face|facing|serves|serve|serving|sets|set|setting|holds|hold|holding|must|is|are)`;
function castOf(d) {
  const nouns = new Set(); const pronouns = [];
  for (const c of clausesOf(d)) {
    const m = new RegExp(String.raw`^(.*?)\b(?:will\s+|must\s+|then\s+|also\s+|independently\s+|simultaneously\s+)*${ACTOR_VERB}\b`, 'i').exec(c);
    if (!m) continue;
    let subj = m[1].trim().replace(/\s+(?:will|must|also|then|independently|simultaneously)\s*$/i, '');
    if (!subj) continue;
    const words = subj.split(/\s+/).filter(Boolean);
    const last = (words[words.length - 1] ?? '').replace(/[^A-Za-z'’-]/g, '');
    if (/^(?:it|he|she|they)$/i.test(last) && words.length <= 2) { pronouns.push(last.toLowerCase()); continue; }
    if (!last || AUX.test(last) || STOP.has(last.toLowerCase())) continue;
    nouns.add(last.toLowerCase().replace(/s$/, ''));
  }
  return { nouns, pronouns };
}
const C2 = (d) => {
  const { nouns, pronouns } = castOf(d);
  return pronouns.some((p) => /^(?:it|he|she)$/i.test(p)) && nouns.size < 2;
};

// C4': "chooses THE SAME <x>" where <x> has NOT been mentioned before. That is
// what makes "the same" anaphoric to the OTHER PLAYER'S CHOICE rather than to a
// thing already in the scene. "chooses the same product" (the product was named
// earlier) is scene-setting; "chooses the same timing" (timing appears nowhere
// else) asserts B's move IS A's move. Verbs kept to the explicit choosing ones:
// "makes the same scheduling choice" is the ordinary "faces the same kind of
// decision" reading and must pass.
const C4 = (d) => {
  const re = /\b(?:chooses?|choosing|picks?|picking|selects?|selecting)\s+(?:exactly\s+)?the\s+same\s+((?:[a-z'’-]+\s+){0,2}?)([a-z'’-]+)\b/gi;
  for (const m of d.matchAll(re)) {
    const noun = m[2].toLowerCase();
    if (/^(?:choices?|options?|decisions?|kinds?|types?|calls?|sorts?|ones?|way|ways)$/.test(noun)) continue;
    const before = d.slice(0, m.index);
    const stem = noun.length > 4 ? noun.replace(/(?:ing|s)$/, '') : noun;
    if (new RegExp(String.raw`\b${stem}`, 'i').test(before)) continue;   // anaphoric to a thing already in the scene
    // also skip when a modifier inside the span is itself already in the scene
    const mods = (m[1] || '').trim().split(/\s+/).filter(Boolean);
    if (mods.some((w) => new RegExp(String.raw`\b${w.slice(0, Math.max(4, w.length - 3))}`, 'i').test(before))) continue;
    return true;
  }
  return false;
};

const RULES = [['C1  one actor taking a SECOND decision', C1],
  ['C2  singular pronoun chooser with no second actor', C2],
  ["C4' \"chooses THE SAME <move>\" (not a thing already in the scene)", C4]];

for (const [label, pred] of RULES) {
  const hits = passing.filter((r) => { try { return pred(r.d); } catch { return false; } });
  const o = hits.filter((h) => h.set === 'old').length, n = hits.filter((h) => h.set === 'new').length;
  console.log(`${label}\n    ${hits.length}/${passing.length} = ${(100 * hits.length / passing.length).toFixed(2)}%   (old ${o}, NEW ${n})`);
  for (const h of hits) console.log(`      [${h.set}] ${h.src}#${h.i}: ${h.d.slice(0, 240)}`);
  console.log('');
}

// ── The four probes: which rules fire? C3 is out of scope this window. ─────
console.log('── RED 1 probes ──');
const PROBES = [
  ['ONE PLAYER holds both pairs', 'A regional airport is planning a glacier survey and will either use an Early Slot or a Late Slot for the data set. The airport will also choose between a Shared Window and a Separate Window for that same data set.'],
  ['SECOND decision to a pronoun', 'A dairy co-op is deciding between an Early Slot and a Late Slot for its seasonal milk sale. It chooses either a Shared Window or a Separate Window for distribution.'],
  ['TWO PLAYERS MAKE THE SAME MOVE', 'A farm cooperative books an Early Slot or a Late Slot for the saffron harvest, while the harvest coordinator chooses the same timing.'],
  ['(out of scope) OPTION PAIR WITH NO CHOOSER', 'A farm cooperative is deciding whether to book an Early Slot or a Late Slot for the harvest. The Shared Window and Separate Window available represent the workforce\'s availability for that period.'],
];
for (const [tag, d] of PROBES) {
  const fired = RULES.filter(([, p]) => { try { return p(d); } catch { return false; } }).map(([l]) => l.split(/\s+/)[0]);
  console.log(`  ${(fired.join(',') || '--').padEnd(6)} ${tag}`);
}

// ── CONTROLS: the exact sentences the first draft got wrong. ───────────────
console.log('\n── CONTROLS (real draws the first draft wrongly flagged) ──');
const CONTROLS = [
  ['"also" = likewise, a NEW actor (rt2_gapladder_g25)', 'A major film studio is choosing when to release its season-defining feature, with its budget and reputation tied to the campaign. A smaller independent distributor is also choosing between an open slot and a crowded slot for a film whose release matters less to its annual plans.'],
  ['pronoun for a properly introduced player (rt3_slot_control)', 'A regional airline is planning a series of flights through a rapidly changing glacier route. It chooses between Early Survey and Late Survey for the flights, while the glacier manager chooses between Early Survey and Late Survey for the region\'s seasonal monitoring plan.'],
  ['"the same kind of decision" (rt3_character_cloud)', 'A textile mill and a nearby finishing mill each schedule its dyeing work for either an Early Shift or a Late Shift. The first mill chooses between Early Shift and Late Shift, while the second mill independently makes the same scheduling choice.'],
  ['"the same PRODUCT", a thing in the scene (rt_stakes_leak_local)', 'A dairy co-op is deciding between Premium Pricing and Bulk Pricing for its seasonal product. The co-op chooses one, while the market buyer chooses the same product through the same season.'],
  ['plain two choosers', 'A freight operator chooses between Night Dispatch and Day Dispatch for a shipment schedule. A rail coordinator chooses between Northern Route and Southern Route for routing the same freight.'],
];
for (const [tag, d] of CONTROLS) {
  const fired = RULES.filter(([, p]) => { try { return p(d); } catch { return false; } }).map(([l]) => l.split(/\s+/)[0]);
  console.log(`  ${fired.length ? 'BLOCKED ' + fired.join(',') : 'ok      '}  ${tag}`);
}

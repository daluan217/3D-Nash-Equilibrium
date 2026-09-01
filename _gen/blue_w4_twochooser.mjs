/**
 * BLUE — WINDOW 4 FEASIBILITY (measurement only; nothing here is a gate).
 *
 * Four of RED 1's six remaining oracle holes are ONE property:
 *
 *   ONE PLAYER holds both option pairs      "The airport will ALSO choose
 *                                            between a Shared Window and a
 *                                            Separate Window"
 *   SECOND decision to a pronoun subject    "IT chooses either a Shared Window
 *                                            or a Separate Window"
 *   AN OPTION PAIR WITH NO CHOOSER          "The Shared Window and Separate
 *                                            Window available REPRESENT the
 *                                            workforce's availability"
 *   THE TWO PLAYERS MAKE THE SAME MOVE      "…while the coordinator chooses
 *                                            THE SAME timing"
 *
 * All four fail the same requirement: the description must present TWO DISTINCT
 * CHOOSERS, one per option pair. This is the most user-visible family left — the
 * reader is shown a game with one decision maker, or with options nobody picks.
 *
 * THE QUESTION THIS SCRIPT ANSWERS IS NOT "how do I catch them". It is "what
 * would a catch COST", because that is what killed the obvious fix in all three
 * of the last three windows. Each candidate is priced against every stored draw
 * and every hit is printed, so a false positive is found by reading rather than
 * by trusting a rate.
 *
 *   npx tsx _gen/blue_w4_twochooser.mjs
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

// Escape a label for use inside a regex.
const rx = (s) => String(s ?? '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CANDIDATES = [
  // ── "ALSO", which is how the one-player draw hands over the second pair ──
  ['C1  "will also choose" / "also chooses" / "also decides"',
    (r) => /\b(?:will\s+)?also\s+(?:choose|chooses|choosing|decide|decides|pick|picks|select|selects)\b/i.test(r.d)],

  // ── A PRONOUN as the subject of the second decision ──
  ['C2  pronoun subject choosing ("It chooses", "They choose", "He picks")',
    (r) => /\b(?:it|they|he|she)\s+(?:chooses?|choosing|picks?|decides?|selects?|opts?)\b/i.test(r.d)],

  // ── AN OPTION PAIR WITH NO CHOOSER: options as a state of nature ──
  ['C3  option labels as the SUBJECT of represent/reflect/are',
    (r) => {
      const pairs = [[r.sc.col1, r.sc.col2], [r.sc.row1, r.sc.row2]];
      return pairs.some(([a, b]) => a && b
        && new RegExp(String.raw`\b${rx(a)}\b[^.;]{0,25}\b(?:and|or)\b[^.;]{0,25}\b${rx(b)}\b[^.;]{0,40}?\b(?:represent|reflect|indicate|correspond|are|denote)\b`, 'i').test(r.d));
    }],
  ['C3b (looser) "represent" / "reflect" anywhere',
    (r) => /\b(?:represents?|reflects?|denotes?|indicates?)\b/i.test(r.d)],

  // ── THE TWO PLAYERS MAKE THE SAME MOVE ──
  ['C4  "the same" attached to a choice noun',
    (r) => /\b(?:chooses?|choosing|picks?|selects?|decides?)\b[^.;]{0,30}?\bthe\s+same\b/i.test(r.d)],
  ['C4b (looser) "the same" anywhere — the corpus\'s constant scene-setting tic',
    (r) => /\bthe\s+same\b/i.test(r.d)],

  // ── STRUCTURAL: does a SECOND distinct actor appear at all? ──
  // A cheap proxy for "two choosers": count how many distinct spans precede a
  // choosing verb. Printed as a distribution rather than a gate.
  ['C5  fewer than TWO distinct choosing-verb subjects detected',
    (r) => {
      const subs = new Set();
      for (const m of r.d.matchAll(/([A-Z][\w'’-]*(?:\s+[a-z][\w'’-]*){0,4}|\b(?:it|they|he|she)\b)\s+(?:chooses?|choosing|picks?|decides?|selects?|opts?|books?)\b/gi)) {
        subs.add(m[1].toLowerCase().trim());
      }
      return subs.size < 2;
    }],
];

for (const [label, pred] of CANDIDATES) {
  const hits = rows.filter((r) => { try { return pred(r); } catch { return false; } });
  const pct = (100 * hits.length / rows.length).toFixed(2);
  console.log(`${label}\n    ${hits.length}/${rows.length} = ${pct}%`);
  const show = pct > 5 ? 6 : hits.length;
  for (const h of hits.slice(0, show)) {
    console.log(`      ${h.src}#${h.i}: ${h.d.slice(0, 210)}`);
  }
  if (hits.length > show) console.log(`      … ${hits.length - show} more not printed`);
  console.log('');
}

// ── Do the candidates catch the oracle's four probes? ───────────────────────
console.log('── RED 1 probes against these candidates ──');
const PROBES = [
  ['ONE PLAYER holds both pairs', { row1: 'Early Slot', row2: 'Late Slot', col1: 'Shared Window', col2: 'Separate Window' },
    'A regional airport is planning a glacier survey and will either use an Early Slot or a Late Slot for the data set. The airport will also choose between a Shared Window and a Separate Window for that same data set.'],
  ['SECOND decision to a pronoun', { row1: 'Early Slot', row2: 'Late Slot', col1: 'Shared Window', col2: 'Separate Window' },
    'A dairy co-op is deciding between an Early Slot and a Late Slot for its seasonal milk sale. It chooses either a Shared Window or a Separate Window for distribution.'],
  ['OPTION PAIR WITH NO CHOOSER', { row1: 'Early Slot', row2: 'Late Slot', col1: 'Shared Window', col2: 'Separate Window' },
    'A farm cooperative is deciding whether to book an Early Slot or a Late Slot for the harvest. The Shared Window and Separate Window available represent the workforce\'s availability for that period.'],
  ['TWO PLAYERS MAKE THE SAME MOVE', { row1: 'Early Slot', row2: 'Late Slot', col1: 'Shared Window', col2: 'Separate Window' },
    'A farm cooperative books an Early Slot or a Late Slot for the saffron harvest, while the harvest coordinator chooses the same timing.'],
];
for (const [tag, labels, d] of PROBES) {
  const r = { sc: labels, d };
  const fired = CANDIDATES.filter(([, p]) => { try { return p(r); } catch { return false; } }).map(([l]) => l.split(/\s+/)[0]);
  console.log(`  ${fired.length ? fired.join(',').padEnd(14) : '--            '} ${tag}`);
}

// ── REFINEMENT PASS, after reading every hit above. ────────────────────────
// C3's only hit (r2local#168) was an INSTRUMENT ARTIFACT: the alternation
// included bare "are", which fired on "…payoffs ARE given in the matrix below"
// in a draw whose two choosers are perfectly distinct. Dropped.
// C4 is the interesting one: 13 hits, of which reading shows ONE is the defect
// ("the coordinator chooses THE SAME TIMING") and the rest are the adjunct
// form ("chooses Open Shift or Hold Shift FOR THE SAME PERIOD"), which is
// ordinary scene-setting. The discriminator is object vs prepositional phrase.
console.log('\n══ REFINED, after reading every hit ══\n');
const REFINED = [
  ['C3\'  option labels as subject of represent/reflect (no bare "are")',
    (r) => /\b(?:represents?|reflects?|denotes?|indicates?)\b/i.test(r.d)
      && /\b(?:available|offered|listed|shown)\b[^.;]{0,20}\b(?:represents?|reflects?|denotes?|indicates?)\b|\b(?:options?|choices?|shifts?|windows?|slots?)\b[^.;]{0,15}\b(?:available|offered)?\s*\b(?:represents?|reflects?|denotes?|indicates?)\b/i.test(r.d)],
  ['C4\'  "the same" as the OBJECT of the choosing verb (not "for/in/during the same")',
    (r) => /\b(?:chooses?|choosing|picks?|selects?|decides?\s+on|takes?)\s+(?:the\s+same|exactly\s+the\s+same)\b/i.test(r.d)],
  ['C4\'\' (rejected) "for/in/during the same" — the adjunct form, for contrast',
    (r) => /\b(?:for|in|during|over|across|on)\s+the\s+same\b/i.test(r.d)],
];
for (const [label, pred] of REFINED) {
  const hits = rows.filter((r) => { try { return pred(r); } catch { return false; } });
  console.log(`${label}\n    ${hits.length}/${rows.length} = ${(100 * hits.length / rows.length).toFixed(2)}%`);
  for (const h of hits.slice(0, label.startsWith("C4''") ? 4 : hits.length)) {
    console.log(`      ${h.src}#${h.i}: ${h.d.slice(0, 200)}`);
  }
  if (hits.length > (label.startsWith("C4''") ? 4 : hits.length)) console.log(`      … ${hits.length - 4} more`);
  console.log('');
}
console.log('── the four probes against the refined set ──');
for (const [tag, labels, d] of PROBES) {
  const r = { sc: labels, d };
  const fired = [['C1', CANDIDATES[0][1]], ['C2', CANDIDATES[1][1]], ["C3'", REFINED[0][1]], ["C4'", REFINED[1][1]]]
    .filter(([, p]) => { try { return p(r); } catch { return false; } }).map(([l]) => l);
  console.log(`  ${(fired.join(',') || '--').padEnd(12)} ${tag}`);
}

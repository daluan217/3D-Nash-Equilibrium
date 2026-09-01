/**
 * BLUE — WINDOW 7: THE HOLE v2 WALKED INTO, priced over every corpus.
 *
 * W4 shipped three two-chooser rules. One of them, `secondPairHandedToAPronoun`,
 * catches "A dairy co-op is deciding between X and Y… IT chooses either P or Q"
 * — the second pair given to a singular pronoun. v2 produces the same defect
 * with a COLLECTIVE subject instead:
 *
 *   "Two neighboring beekeepers are choosing winter apiary sited near their
 *    homes. THE BEEKEEPERS must choose either Roof Shed or Garden Shed for the
 *    apiary."          (labels: Roof Shed / Garden Shed / Drainage Line / Open Corridor)
 *
 *   "Two neighboring salt-marsh graziers are arranging their seasonal grazing
 *    rights… EACH chooses between Limited Rotation and Open Rotation."
 *                      (labels: Limited Rotation / Open Rotation / Early Access / Late Access)
 *
 * One pair is handed to both players and the other pair never appears. The
 * reader is shown a game with one set of options in it. Both draws PASS the
 * shipping gate today.
 *
 * The predicate is deliberately NOT "the description mentions fewer than four
 * labels" — that reads 3-4% on BOTH arms and a hand-read shows most of it is
 * ordinary PARAPHRASE ("plant cranberries early or late" for Early Planting /
 * Late Planting), which is good prose, not a defect. The defect needs the
 * collective subject as well.
 *
 *   npx tsx _gen/blue_w7_collective.mjs
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const REPO = '/Users/danielluan/Desktop/3D-Nash-Equilibrium';
const files = [];
for (const d of ['/tmp', S, `${REPO}/_gen`, `${REPO}/_gen/results`, `${S}/blue/_gen`]) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) if (f.endsWith('.jsonl') && !/^blue_w7_(?:out|.*_accepted)/.test(f)) files.push(`${d}/${f}`);
}
files.sort();
const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const rows = []; const seen = new Set();
for (const f of files) {
  const src = f.split('/').pop().replace('.jsonl', '');
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const sc = r.sc ?? r.scenario; if (!sc || typeof sc !== 'object') continue;
    const g = r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null); if (!g) continue;
    const key = `${src}|${sc.name} ${sc.description}`; if (seen.has(key)) continue; seen.add(key);
    rows.push({ src, sc, g });
  }
}
const live = rows.filter((r) => V.scenarioIsClaimFree(r.sc).ok && V.validateScenario(r.sc, r.g).issues.length === 0);
console.log(`${files.length} corpora - ${rows.length} unique draws - ${live.length} reach the user\n`);

// "The two parties, collectively, choose between <pair>" — and no other pair is
// in the story. `they` is included here where the W4 pronoun rule deliberately
// excludes it, and the difference is the second condition: "they choose
// simultaneously" is the CORRECT way to say both players move at once, so it is
// only a defect when the other pair is missing as well.
const COLLECTIVE = /\b(?:each|both|either\s+party|the\s+(?:two|both)\s+\w+|they)\s+(?:\w+\s+){0,2}?(?:choose|chooses|choosing|pick|picks|decide|decides|select|selects|must\s+choose|will\s+choose)\b/i;
// The plural of a noun the description has already used for BOTH parties:
// "TWO NEIGHBORING BEEKEEPERS are choosing… THE BEEKEEPERS must choose".
const collectiveNoun = (d) => {
  const m = /\b(?:two|both)\s+(?:\w+\s+){0,3}?([a-z][\w'-]{3,})s\b/i.exec(d);
  if (!m) return false;
  return new RegExp(String.raw`\bthe\s+${m[1]}s\s+(?:\w+\s+){0,2}?(?:choose|chooses|must\s+choose|will\s+choose|pick|picks|decide|decides|select|selects)\b`, 'i').test(d);
};
const onePairOnly = (sc) => {
  const d = (sc.description ?? '').toLowerCase();
  const has = (l) => !!l && d.includes(String(l).trim().toLowerCase());
  const a = [sc.row1, sc.row2].filter(Boolean), b = [sc.col1, sc.col2].filter(Boolean);
  if (a.length < 2 || b.length < 2) return false;
  const aIn = a.filter(has).length, bIn = b.filter(has).length;
  return (aIn === 2 && bIn === 0) || (bIn === 2 && aIn === 0);
};
const RULE = (sc) => onePairOnly(sc) && (COLLECTIVE.test(sc.description ?? '') || collectiveNoun(sc.description ?? ''));

// KNOWN-POSITIVE FIXTURES — both real, both gate-accepted, both from v2.
const FX = [
  { name: 'F1', row1: 'Roof Shed', row2: 'Garden Shed', col1: 'Drainage Line', col2: 'Open Corridor', storyClaims: null,
    description: 'Two neighboring beekeepers are choosing winter apiary sited near their homes. The beekeepers must choose either Roof Shed or Garden Shed for the apiary.' },
  { name: 'F2', row1: 'Limited Rotation', row2: 'Open Rotation', col1: 'Early Access', col2: 'Late Access', storyClaims: null,
    description: 'Two neighboring salt-marsh graziers are arranging their seasonal grazing rights on adjacent shared grazing rights. Each chooses between Limited Rotation and Open Rotation for its holding schedule.' },
];
// KNOWN-NEGATIVE FIXTURES — the good shapes this must not touch.
const NEG = [
  { name: 'N1 both pairs named, collective subject', sc: { name: 'n', row1: 'Early Slot', row2: 'Late Slot', col1: 'Full Crew', col2: 'Lean Crew', storyClaims: null,
    description: 'Two yards plan a season. Both choose at the same time: the first between Early Slot and Late Slot, the second between Full Crew and Lean Crew.' } },
  { name: 'N2 second pair PARAPHRASED, no collective subject', sc: { name: 'n', row1: 'Early Planting', row2: 'Late Planting', col1: 'Release Water', col2: 'Hold Water', storyClaims: null,
    description: 'A farm cooperative is deciding whether to plant cranberries early or late in the season. Its neighboring water district is deciding whether to Release Water or Hold Water during the same period.' } },
  { name: 'N3 one pair only, but each player named separately', sc: { name: 'n', row1: 'Early Watch', row2: 'Late Watch', col1: 'Confirm Rows', col2: 'Confirm Covers', storyClaims: null,
    description: 'A local orchard grower chooses whether to schedule an Early Watch or a Late Watch. A neighboring cider cooperative chooses whether to confirm its rows or its covers.' } },
];
let bad = 0;
for (const f of FX) if (!RULE(f)) { console.error(`KNOWN POSITIVE ${f.name} DOES NOT FIRE — the numbers below are meaningless.`); bad++; }
for (const nfx of NEG) if (RULE(nfx.sc)) { console.error(`KNOWN NEGATIVE ${nfx.name} WRONGLY FIRES.`); bad++; }
if (bad) process.exit(1);
console.log(`fixtures: ${FX.length} known positives fire, ${NEG.length} known negatives spared\n`);

// MUTATION: each half of the conjunction removed SEPARATELY. A half that
// changes nothing is reported as untested, never as a pass.
for (const [label, f] of [['collective-subject half removed', onePairOnly], ['one-pair-only half removed', (sc) => COLLECTIVE.test(sc.description ?? '') || collectiveNoun(sc.description ?? '')]]) {
  const n = live.filter((r) => f(r.sc)).length, s = live.filter((r) => RULE(r.sc)).length;
  console.log(`  mutation "${label}": ${n} hits vs ${s} shipped${n === s ? '   <-- HALF NOT TESTED (changes nothing here)' : `   (that half spares ${n - s} draws)`}`);
}

const hits = live.filter((r) => RULE(r.sc));
const bySrc = new Map();
for (const h of hits) bySrc.set(h.src, (bySrc.get(h.src) ?? 0) + 1);
console.log(`\nfires on ${hits.length}/${live.length} = ${(100 * hits.length / live.length).toFixed(3)}% of draws that reach the user`);
console.log(`sources: ${[...bySrc.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
writeFileSync('/tmp/blue_w7_out/collective.txt', hits.map((h) => `${h.src}\n  labels: ${[h.sc.row1, h.sc.row2, h.sc.col1, h.sc.col2].join(' / ')}\n  ${h.sc.description}\n`).join('\n'));
console.log(`\nEVERY hit -> /tmp/blue_w7_out/collective.txt. Hand-read all of them; no rate from this file is quotable until that is done.`);
for (const h of hits) console.log(`\n  ${h.src}\n    labels: ${[h.sc.row1, h.sc.row2, h.sc.col1, h.sc.col2].join(' / ')}\n    ${h.sc.description}`);

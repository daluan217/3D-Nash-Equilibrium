/**
 * BLUE — WINDOW 7: WHAT EACH GUARD IS WORTH ON THE NEW MODEL.
 *
 * "Does my rule false-positive on v2" has a sharper form than counting
 * rejections: every guard inside these rules exists to STOP a false positive
 * that a naive version produced, and v2's register is different, so each guard
 * is worth a different amount now. Removing one and measuring what the rule
 * would then reject on v2 output is the false-positive rate the guard is
 * currently preventing.
 *
 * This is also the mutation test for the guards, run against a corpus none of
 * them was tuned on. Each guard is mutated SEPARATELY, and a mutation that
 * changes nothing at all is reported as UNTESTED rather than as a pass — the
 * failure mode that made W6's first mutation harness report "all tests passed"
 * on a mutation that never applied.
 *
 *   npx tsx _gen/blue_w7_guardvalue.mjs
 */
import { readFileSync } from 'node:fs';

const load = (f, arm) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => JSON.parse(l)).filter((r) => r.scenario).map((r) => ({ arm, sc: r.scenario, domain: r.domain }));
const CORP = {
  v2: load('/tmp/blue_w7_v2.jsonl', 'v2'),
  v1: load('/tmp/blue_w7_v1.jsonl', 'v1'),
};
const text = (r) => {
  const f = ['name', 'row1', 'row2', 'col1', 'col2'].map((k) => (typeof r.sc[k] === 'string' ? r.sc[k] : ''));
  return [...f, r.sc.description ?? ''].join(' • ');
};

// Each entry: the SHIPPED predicate, and the same predicate with ONE guard
// removed. The gap is what that guard buys on this corpus.
const GUARDS = [
  {
    name: 'META bare letter: the negative lookbehind',
    why: 'without it, "Grower A chooses" — two indistinguishable parties given designations — reads as the prompt variable',
    shipped: /(?<![\p{L}\p{N}][ \t]|[\p{L}\p{N}])\b[AB]\b\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|prefers?|is|are|will|must|can|has|have)\b/u,
    naive: /\b[AB]\b\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|prefers?|is|are|will|must|can|has|have)\b/u,
  },
  {
    name: 'META "the game": the hyphen boundary',
    why: 'without it \\b sits happily before a hyphen and "the game-day menu" is rejected',
    shipped: /\bthe\s+game\b(?![-\w])/i,
    naive: /\bthe\s+game\b/i,
  },
  {
    name: 'BIG_SPELLED_QUANTITY: the three words RED\'s D4 had that this does not',
    why: 'twice = a twice-weekly delivery, dozens = ordinary scene-setting, \\w+fold = "Manifold"',
    shipped: /\b(?:hundreds?|thousands?|millions?|billions?|trillions?)\b/i,
    naive: /\b(?:hundreds?|thousands?|millions?|billions?|dozens?|twice|thrice|\w+fold)\b/i,
    scope: 'labels',
  },
  {
    name: 'META cast list: excluding bare "the players"',
    why: '"the players" is the acting company, and the domain rotation contains puppet theatre',
    shipped: /\b(?:the\s+two\s+players|both\s+players|each\s+player)\b/i,
    naive: /\b(?:the\s+two\s+players|both\s+players|each\s+player|the\s+players)\b/i,
  },
  {
    name: 'negotiation: the offer/accept CONJUNCTION rather than the word',
    why: 'gating "negotiate" alone rejects the good shape — two parties who each pick a stance simultaneously',
    shipped: /^(?=[\s\S]*\b(?:offer|propose|tender|submit)(?:s|ed|ing)?\b|[\s\S]*\bbids?\b)(?=[\s\S]*\b(?:accept|reject|decline|approve)(?:s|ed|ing)?\b)/i,
    naive: /\bnegotiat\w+\b/i,
  },
  {
    name: 'move order: requiring a CHOOSING verb after before/after',
    why: '"before the inspection" names an event; only "before X chooses" names the other player\'s move',
    shipped: /\b(?:before|after)\b[^.;]{0,45}?\b(?:chooses?|choosing|picks?|picking|decides?|deciding|selects?|selecting|plays?|playing|moves?|commits?)\b/i,
    naive: /\b(?:before|after)\b/i,
  },
];

const labelsOf = (r) => ['name', 'row1', 'row2', 'col1', 'col2'].map((k) => (typeof r.sc[k] === 'string' ? r.sc[k] : '')).join(' • ');

let untested = 0;
for (const g of GUARDS) {
  const target = g.scope === 'labels' ? labelsOf : text;
  console.log(`\n${g.name}`);
  console.log(`   ${g.why}`);
  let moved = 0;
  for (const arm of ['v1', 'v2']) {
    const rows = CORP[arm];
    const s = rows.filter((r) => g.shipped.test(target(r)));
    const nv = rows.filter((r) => g.naive.test(target(r)));
    const extra = nv.filter((r) => !g.shipped.test(target(r)));
    moved += extra.length;
    console.log(`   ${arm} (n=${rows.length}): shipped rejects ${s.length} (${(100 * s.length / rows.length).toFixed(1)}%)   guard removed rejects ${nv.length} (${(100 * nv.length / rows.length).toFixed(1)}%)   GUARD SPARES ${extra.length} (${(100 * extra.length / rows.length).toFixed(1)}%)`);
    for (const r of extra.slice(0, 3)) console.log(`        spared: ${String(r.sc.description ?? labelsOf(r)).slice(0, 150)}`);
  }
  if (moved === 0) { console.log('   GUARD NOT TESTED on this corpus — removing it changes nothing here, so this run proves nothing about it.'); untested++; }
}
console.log(`\n${GUARDS.length - untested}/${GUARDS.length} guards demonstrably still earn their place on v2 output; ${untested} untested here (no draw separates them).`);

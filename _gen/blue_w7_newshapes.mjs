/**
 * BLUE — WINDOW 7, QUESTION 3: what does v2 do that v1 did not?
 *
 * Paired on the SAME games and the SAME domains, so the model is the only
 * variable. Every feature here is DECIDABLE — a count, a set membership, a
 * punctuation test. Nothing here reads for sense; a separate blind coherence
 * read covers that, and this file must not be mistaken for it.
 *
 * The features are deliberately not limited to known defect classes. The point
 * is to find shapes NOBODY has a rule for, so it measures ordinary properties
 * of the output (length, repetition, label vocabulary, sentence count) as well
 * as the screens, and reports any where the two arms separate.
 *
 *   npx tsx _gen/blue_w7_newshapes.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');
const SCR = await import('/Users/danielluan/Desktop/3D-Nash-Equilibrium/_gen/trainset_screens.ts');

const load = (f, arm) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => JSON.parse(l)).filter((r) => r.scenario)
  .map((r) => ({ arm, i: r.i, domain: r.domain, sc: r.scenario, g: r.game }));

const V2 = load('/tmp/blue_w7_v2.jsonl', 'v2');
const V1 = load('/tmp/blue_w7_v1.jsonl', 'v1');
const n = Math.min(V2.length, V1.length);
const A = { v2: V2.slice(0, n), v1: V1.slice(0, n) };
console.log(`paired on ${n} identical (game, domain) cells\n`);

const labels = (s) => [s.row1, s.row2, s.col1, s.col2].map((x) => (x ?? '').trim());
const desc = (s) => (s.description ?? '').trim();
const sentences = (s) => desc(s).split(/(?<=[.!?])\s+/).filter((x) => x.trim());

// ── FEATURES. Each is a predicate on one draw; the report is a rate per arm. ──
const FEATURES = [
  ['gate rejects it', (r) => !V.scenarioIsClaimFree(r.sc).ok || V.validateScenario(r.sc, r.g).issues.length > 0],
  ['label >3 words (prompt says 1-3)', (r) => labels(r.sc).some((l) => l.split(/\s+/).filter(Boolean).length > 3)],
  ['label not Title Case', (r) => labels(r.sc).some((l) => l && l.split(/\s+/).some((w, k) => k === 0 && /^[a-z]/.test(w)))],
  ['label case MIXED within a pair', (r) => {
    const cap = (l) => /^[A-Z]/.test(l);
    const [r1, r2, c1, c2] = labels(r.sc);
    return (r1 && r2 && cap(r1) !== cap(r2)) || (c1 && c2 && cap(c1) !== cap(c2));
  }],
  ['a label repeats inside the other pair', (r) => SCR.labelCollision(r.sc)],
  ['a player\'s two labels identical', (r) => SCR.duplicateOptions(r.sc)],
  ['description sentences not 2 or 3', (r) => { const k = sentences(r.sc).length; return k < 2 || k > 3; }],
  ['description is a single sentence', (r) => sentences(r.sc).length === 1],
  ['description >=4 sentences', (r) => sentences(r.sc).length >= 4],
  ['description does not end in .!?', (r) => SCR.truncated(r.sc)],
  ['description names <4 of the 4 labels', (r) => labels(r.sc).filter((l) => l && desc(r.sc).toLowerCase().includes(l.toLowerCase())).length < 4],
  ['description names 0 labels', (r) => labels(r.sc).every((l) => !l || !desc(r.sc).toLowerCase().includes(l.toLowerCase()))],
  ['description repeats the name verbatim', (r) => !!r.sc.name && desc(r.sc).toLowerCase().includes(String(r.sc.name).toLowerCase())],
  ['storyClaims not null (rung 3 says omit)', (r) => r.sc.storyClaims != null],
  ['extra keys beyond the schema', (r) => Object.keys(r.sc).some((k) => !['name', 'row1', 'row2', 'col1', 'col2', 'description', 'storyClaims', 'actorA', 'actorB'].includes(k))],
  ['actorA/actorB present', (r) => r.sc.actorA != null || r.sc.actorB != null],
  ['a/an disagreement', (r) => SCR.articleDisagreement(r.sc)],
  ['persona leak (training screen)', (r) => SCR.personaLeak(r.sc)],
  ['meta leak (training screen)', (r) => SCR.metaLeak(r.sc)],
  ['foreign script', (r) => SCR.foreignScript(r.sc)],
  ['"chooses between" twice', (r) => SCR.doubledFrame(r.sc)],
  ['name is exactly the domain, title-cased', (r) => String(r.sc.name ?? '').toLowerCase().trim() === String(r.domain ?? '').toLowerCase().trim()],
  ['off-domain (no domain word in name+desc)', (r) => {
    const words = String(r.domain ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const t = `${r.sc.name} ${desc(r.sc)}`.toLowerCase();
    return words.length > 0 && !words.some((w) => t.includes(w.replace(/(?:ing|s|es)$/, '')));
  }],
];

const pct = (k, d) => `${k} (${(100 * k / d).toFixed(1)}%)`;
console.log(`${'feature'.padEnd(40)} ${'v1'.padStart(13)} ${'v2'.padStart(13)}   delta`);
const flagged = [];
for (const [name, f] of FEATURES) {
  const k1 = A.v1.filter(f).length, k2 = A.v2.filter(f).length;
  const d = (100 * (k2 - k1) / n);
  console.log(`${name.padEnd(40)} ${pct(k1, n).padStart(13)} ${pct(k2, n).padStart(13)}   ${d >= 0 ? '+' : ''}${d.toFixed(1)}pp${k2 > k1 ? '  <-- v2 WORSE' : ''}`);
  if (k2 > k1) flagged.push([name, f]);
}

// ── repetition: v2's register is narrower, so measure how much ──────────────
console.log('\n== REPETITION AND VOCABULARY ==');
for (const arm of ['v1', 'v2']) {
  const rows = A[arm];
  const names = rows.map((r) => String(r.sc.name ?? '').toLowerCase().trim());
  const descs = rows.map((r) => desc(r.sc).toLowerCase());
  const labs = rows.flatMap((r) => labels(r.sc).map((l) => l.toLowerCase()));
  const top = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const tn = top(names), tl = top(labs), td = top(descs);
  const firstWord = top(descs.map((d) => d.split(/\s+/).slice(0, 6).join(' ')));
  console.log(`  ${arm}: distinct names ${tn.length}/${rows.length}  top "${tn[0][0]}" ${tn[0][1]} (${(100 * tn[0][1] / rows.length).toFixed(1)}%)`);
  console.log(`      distinct descriptions ${td.length}/${rows.length}  exact repeats ${rows.length - td.length}`);
  console.log(`      distinct labels ${tl.length}/${labs.length}  top 5: ${tl.slice(0, 5).map(([k, v]) => `"${k}" ${v}`).join(', ')}`);
  console.log(`      commonest 6-word opening: "${firstWord[0][0]}" ${firstWord[0][1]}/${rows.length} (${(100 * firstWord[0][1] / rows.length).toFixed(1)}%)`);
  const lens = descs.map((d) => d.length).sort((a, b) => a - b);
  console.log(`      description chars p10/p50/p90: ${lens[Math.floor(lens.length * .1)]}/${lens[Math.floor(lens.length * .5)]}/${lens[Math.floor(lens.length * .9)]}`);
}

// ── the hand-read sample: 30 v2 draws chosen without looking at them ────────
let s = 424242; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const idx = [...Array(n).keys()].sort(() => rnd() - 0.5).slice(0, 30).sort((a, b) => a - b);
writeFileSync('/tmp/blue_w7_handread.txt', idx.map((k) => {
  const a = A.v1[k], b = A.v2[k];
  return `#${k}  domain: ${b.domain}\n  v1: ${a.sc.name} | ${labels(a.sc).join(' / ')}\n      ${desc(a.sc)}\n  v2: ${b.sc.name} | ${labels(b.sc).join(' / ')}\n      ${desc(b.sc)}\n`;
}).join('\n'));
console.log(`\n30 paired draws written to /tmp/blue_w7_handread.txt`);

// ── every draw hitting a feature where v2 got WORSE, for a hand-read ────────
writeFileSync('/tmp/blue_w7_worse.txt', flagged.map(([name, f]) => {
  const hits = A.v2.filter(f);
  return `=== ${name} : ${hits.length}/${n} on v2 ===\n` + hits.map((r) => `  [${r.i}] ${r.domain} | ${r.sc.name} | ${labels(r.sc).join(' / ')}\n    ${desc(r.sc)}`).join('\n') + '\n';
}).join('\n'));
console.log(`${flagged.length} features where v2 is worse -> /tmp/blue_w7_worse.txt`);

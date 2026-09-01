/**
 * BLUE — WINDOW 6: price META VOCABULARY, the prompt's own words and the
 * mathematical object appearing in user-facing fiction.
 *
 * FOUR SUB-FORMS, per the coordinator (the narrow predicate that caught only
 * the first under-reported the class by roughly a third):
 *   M1  "Player A" / "Player B"        — the prompt's own cast names
 *   M2  a BARE LETTER as a character   — "A chooses…", "B is a fisherman…"
 *   M3  "the two players" / "both players" / "each player"
 *   M4  the word "payoff"
 *   M5  "the game"                     — TRAPPED, see below
 *
 * TWO TRAPS, both handed to me measured, both of the collision kind this
 * campaign keeps hitting. They are built in from the first draft rather than
 * discovered later:
 *
 *   TRAP A — "THE GAME" IS A PRODUCT IN THIS CORPUS. Of 31 META hits in the old
 *   training data, TWELVE were video-game scenarios ("a small game studio
 *   chooses… for distributing the game", "give the game a Featured Slot") and
 *   not one was game-theoretic. The domain rotation contains game, film and
 *   software settings, so a bare "the game" rule deletes a whole domain. Scoped
 *   here: flag only when the sentence ALSO carries game-theory vocabulary AND
 *   does NOT carry game-product vocabulary.
 *
 *   TRAP B — THE BARE-LETTER FORM NEEDS A NEGATIVE LOOKBEHIND. `\b[AB]\s+chooses`
 *   matches "Operator A chooses… while Operator B chooses…", which is ordinary
 *   English for two indistinguishable parties and is CLOUD'S GOOD SHAPE (5.0%
 *   cloud, 0.0% local). RED 1's first draft reported 20.4% on cloud and 13 of 14
 *   hand-checked matches were that shape. "Mill A chooses" must pass.
 *
 * SURFACES ARE MEASURED SEPARATELY. This is NOT equal across surfaces — the
 * earlier "6.6% local / 5.7% cloud, so it is in the teacher too" reading came
 * from the narrow predicate. Do not pool them.
 *
 *   npx tsx _gen/blue_w6_metaprice.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const REPO = '/Users/danielluan/Desktop/3D-Nash-Equilibrium';
const files = [];
for (const d of ['/tmp', S, `${REPO}/_gen`, `${REPO}/_gen/results`]) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) if (f.endsWith('.jsonl')) files.push(`${d}/${f}`);
}
files.sort();

// Surface attribution: the row's own field first, the filename only as a
// fallback. A pooled number would hide the whole point of this window.
const surfaceOf = (r, src) => {
  const t = `${r.src ?? ''} ${r.source ?? ''} ${r.model ?? ''}`.toLowerCase();
  if (/local|qwen|gguf|llama/.test(t)) return 'local';
  if (/cloud|gpt|luna|azure|foundry/.test(t)) return 'cloud';
  if (/_local|local_/.test(src)) return 'local';
  if (/_cloud|cloud_/.test(src)) return 'cloud';
  return 'unknown';
};

const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const rows = []; const seen = new Set();
for (const f of files) {
  const src = f.split('/').pop().replace('.jsonl', '');
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const sc = r.sc ?? r.scenario;
    if (!sc || typeof sc.description !== 'string') continue;
    const key = `${sc.name} ${sc.description} ${sc.row1} ${sc.col1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ src, surface: surfaceOf(r, src), i: r.i ?? r.pair ?? r.line, sc,
      g: r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null) });
  }
}
const pass = rows.filter((r) => {
  if (V.scenarioIsClaimFree(r.sc).ok === false) return false;
  if (!r.g) return true;
  return !(V.validateScenario(r.sc, r.g).issues ?? []).length;
});
const bySurface = { local: pass.filter((r) => r.surface === 'local'), cloud: pass.filter((r) => r.surface === 'cloud'), unknown: pass.filter((r) => r.surface === 'unknown') };
console.log(`${files.length} files · ${rows.length} unique draws · ${pass.length} gate-passing`);
console.log(`  local ${bySurface.local.length} · cloud ${bySurface.cloud.length} · unattributed ${bySurface.unknown.length}\n`);

// All authored fields, because the NAME and LABELS are user-facing too and the
// name is a field no screen read at all before this campaign.
const allText = (sc) => [sc.name, sc.row1, sc.row2, sc.col1, sc.col2, sc.description]
  .filter((x) => typeof x === 'string').join(' • ');
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ── TRAP A vocabulary ──
const GAME_THEORY = /\b(?:payoffs?|equilibri\w+|strateg\w+|players?|matrix|matrices|dominant|zero[\s-]sum|simultaneous\w*|normal[\s-]form|best\s+response|move|moves)\b/i;
const GAME_PRODUCT = /\b(?:video\s?games?|game\s+studio|game\s+developer|gaming|console|arcade|board\s+games?|playtest\w*|launch|release|title|titles|publisher|distribut\w+|storefront|featured\s+slot|players?\s+(?:will|can|who)\s+(?:buy|play|download)|download\w*|app\s+store|steam)\b/i;

const SUBFORM = [
  ['M1  "Player A" / "Player B"', (t) => /\bplayers?\s+[AB]\b/i.test(t)],
  // TRAP B: the letter must NOT be preceded by a word (Operator A, Mill A,
  // Bakery A). JS supports variable-length lookbehind, so this is expressible
  // directly rather than as a post-filter.
  ['M2  bare LETTER as a character', (t) => /(?<![\p{L}\p{N}][ \t]|[\p{L}\p{N}])\b[AB]\b\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|prefers?|is|are|will|must|can|has|have)\b/u.test(t)],
  ['M3  "the two players" / "each player"', (t) => /\b(?:the\s+two\s+players|both\s+players|each\s+player|the\s+players|player\s+one|player\s+two)\b/i.test(t)],
  ['M4  the word "payoff"', (t) => /\bpayoffs?\b/i.test(t)],
  ['M5  "the game", SCOPED (theory vocab AND NOT product vocab)', (t) => {
    for (const s of t.split(/(?<=[.;•])\s+/)) {
      if (!/\bthe\s+game\b/i.test(s)) continue;
      if (GAME_PRODUCT.test(s)) continue;
      if (GAME_THEORY.test(s)) return true;
    }
    return false;
  }],
  ['M5x "the game" BARE (the trap, for comparison only)', (t) => /\bthe\s+game\b/i.test(t)],
  ['M4x "payoff" as a BARE noun only (no comparison attached)', (t) => /\bpayoffs?\b/i.test(t)],
];

console.log('── Rate of each sub-form, BY SURFACE, among gate-passing draws ──\n');
console.log(`  ${'sub-form'.padEnd(52)} ${'local'.padStart(14)} ${'cloud'.padStart(14)} ${'unattrib'.padStart(12)}`);
const hits = new Map();
for (const [tag, pred] of SUBFORM) {
  const h = { local: [], cloud: [], unknown: [] };
  for (const r of pass) if (pred(allText(r.sc))) h[r.surface].push(r);
  hits.set(tag, h);
  const f = (k) => bySurface[k].length ? `${h[k].length} = ${(100 * h[k].length / bySurface[k].length).toFixed(1)}%` : 'n/a';
  console.log(`  ${tag.padEnd(52)} ${f('local').padStart(14)} ${f('cloud').padStart(14)} ${f('unknown').padStart(12)}`);
}

// UNION of the four shippable sub-forms (M5 scoped, M5x excluded).
const UNION = (t) => SUBFORM.slice(0, 5).some(([, p]) => p(t));
const u = { local: [], cloud: [], unknown: [] };
for (const r of pass) if (UNION(allText(r.sc))) u[r.surface].push(r);
console.log(`\n  ${'UNION of M1-M5 (scoped)'.padEnd(52)} ${`${u.local.length} = ${(100 * u.local.length / bySurface.local.length).toFixed(1)}%`.padStart(14)} ${`${u.cloud.length} = ${(100 * u.cloud.length / bySurface.cloud.length).toFixed(1)}%`.padStart(14)}`);

// ── Hand-reading material. Every trap case printed in full. ──
for (const tag of ['M2  bare LETTER as a character', 'M5x "the game" BARE (the trap, for comparison only)', 'M4  the word "payoff"', 'M3  "the two players" / "each player"']) {
  const h = hits.get(tag);
  const all = [...h.local, ...h.cloud, ...h.unknown];
  console.log(`\n════ ${tag} — ${all.length} draws ════`);
  for (const r of all.slice(0, 14)) console.log(`  [${r.surface}] ${r.src}#${r.i}: ${norm(allText(r.sc)).slice(0, 210)}`);
}

// TRAP B evidence: how many bare-letter matches would a NAIVE predicate make?
const NAIVE_LETTER = (t) => /\b[AB]\b\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|is|are)\b/.test(t);
const naive = { local: [], cloud: [] };
for (const r of pass) if (r.surface !== 'unknown' && NAIVE_LETTER(allText(r.sc))) naive[r.surface].push(r);
console.log(`\n════ TRAP B — the NAIVE bare-letter predicate (no lookbehind) ════`);
console.log(`  local ${naive.local.length} = ${(100 * naive.local.length / bySurface.local.length).toFixed(1)}%   cloud ${naive.cloud.length} = ${(100 * naive.cloud.length / bySurface.cloud.length).toFixed(1)}%`);
const naiveOnly = [...naive.local, ...naive.cloud].filter((r) => !SUBFORM[1][1](allText(r.sc)));
console.log(`  draws the naive form catches that the LOOKBEHIND form correctly spares: ${naiveOnly.length}`);
for (const r of naiveOnly.slice(0, 10)) console.log(`    [${r.surface}] ${r.src}#${r.i}: ${norm(r.sc.description).slice(0, 175)}`);

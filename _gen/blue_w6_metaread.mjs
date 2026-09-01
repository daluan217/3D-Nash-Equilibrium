/**
 * BLUE — WINDOW 6: hand-reading material for the META sub-forms.
 *
 * The first draft of the pricing harness printed the head of each draw
 * truncated to 210 characters, and several sub-forms match a phrase that sits
 * LATER in the description — so the "examples" it printed did not contain the
 * thing being judged. Fixed here: every row prints the MATCHING SENTENCE with
 * the match marked. Judging a predicate from output that does not show its
 * match is the same class of mistake as reading a reach number off the corpus a
 * rule was written on.
 *
 *   npx tsx _gen/blue_w6_metaread.mjs <M1|M2|M3|M4|M5|M5x|TRAPB> [limit]
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

const GAME_THEORY = /\b(?:payoffs?|equilibri\w+|strateg\w+|players?|matrix|matrices|dominant|zero[\s-]sum|simultaneous\w*|normal[\s-]form|best\s+response|moves?)\b/i;
const GAME_PRODUCT = /\b(?:video\s?games?|game\s+studio|game\s+developer|gaming|console|arcade|board\s+games?|playtest\w*|launch|release|title|titles|publisher|distribut\w+|storefront|featured\s+slot|download\w*|app\s+store|steam)\b/i;
const RE = {
  M1: /\bplayers?\s+[AB]\b/i,
  M2: /(?<![\p{L}\p{N}][ \t]|[\p{L}\p{N}])\b[AB]\b\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|prefers?|is|are|will|must|can|has|have)\b/u,
  M3: /\b(?:the\s+two\s+players|both\s+players|each\s+player|the\s+players|player\s+one|player\s+two)\b/i,
  M4: /\bpayoffs?\b/i,
  M5x: /\bthe\s+game\b/i,
  TRAPB: /\b[AB]\b\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|is|are)\b/,
};
const allText = (sc) => [sc.name, sc.row1, sc.row2, sc.col1, sc.col2, sc.description].filter((x) => typeof x === 'string').join(' • ');
const sentences = (t) => t.split(/(?<=[.;•])\s+/);

const which = process.argv[2] ?? 'M2';
const limit = Number(process.argv[3] ?? 40);
const pred = which === 'M5'
  ? (t) => sentences(t).some((s) => RE.M5x.test(s) && !GAME_PRODUCT.test(s) && GAME_THEORY.test(s))
  : (t) => RE[which].test(t);

const hits = pass.filter((r) => pred(allText(r.sc)));
const byS = { local: 0, cloud: 0, unknown: 0 };
for (const r of hits) byS[r.surface]++;
console.log(`${which}: ${hits.length} gate-passing draws  (local ${byS.local} · cloud ${byS.cloud} · unattributed ${byS.unknown})\n`);

const re = which === 'M5' ? RE.M5x : RE[which];
for (const r of hits.slice(0, limit)) {
  const t = allText(r.sc);
  const hit = sentences(t).filter((s) => re.test(s));
  console.log(`[${r.surface}] ${r.src}#${r.i}  «${r.sc.name}»`);
  for (const s of hit) {
    const m = s.match(re);
    console.log(`    ${s.replace(/\s+/g, ' ').trim().slice(0, 240)}`);
    if (which === 'M5') console.log(`      product-vocab=${GAME_PRODUCT.test(s)}  theory-vocab=${GAME_THEORY.test(s)}  -> ${!GAME_PRODUCT.test(s) && GAME_THEORY.test(s) ? 'FLAGGED' : 'spared'}`);
    else console.log(`      match: «${m?.[0]}»`);
  }
}

/**
 * BLUE — WINDOW 6: the design decisions for the META gate, each priced.
 *
 * Four questions the shipping shape depends on:
 *   Q1  TRAP B — what does the negative lookbehind actually buy? The naive
 *       bare-letter predicate must be shown to over-reach on THIS corpus, not
 *       just asserted to.
 *   Q2  Does the bare "the players" member earn its place? It is the one member
 *       of M3 with a genuine non-game meaning ("the players" = the acting
 *       company), and the rotation contains "puppet theatre touring". Zero
 *       occurrences today is NOT sufficient grounds — the D4 refusal in W5 was
 *       decided on the SHAPE of the word after its rate measured zero.
 *   Q3  TRAP A — does the "the game" scoping spare the product uses, and does
 *       the hyphen boundary matter? ("the game-day menu" is a real cloud draw.)
 *   Q4  What does the UNION cost per surface, and how much of it is overlap?
 *
 *   npx tsx _gen/blue_w6_metadesign.mjs
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
const N = { local: pass.filter((r) => r.surface === 'local').length, cloud: pass.filter((r) => r.surface === 'cloud').length, unknown: pass.filter((r) => r.surface === 'unknown').length };
const allText = (sc) => [sc.name, sc.row1, sc.row2, sc.col1, sc.col2, sc.description].filter((x) => typeof x === 'string').join(' • ');
const sentences = (t) => t.split(/(?<=[.;•])\s+/);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
console.log(`${pass.length} gate-passing (local ${N.local} · cloud ${N.cloud} · unattributed ${N.unknown})\n`);

const rate = (tag, pred) => {
  const h = { local: [], cloud: [], unknown: [] };
  for (const r of pass) if (pred(allText(r.sc))) h[r.surface].push(r);
  const f = (k) => N[k] ? `${String(h[k].length).padStart(3)} = ${(100 * h[k].length / N[k]).toFixed(1)}%` : 'n/a';
  console.log(`  ${tag.padEnd(46)} local ${f('local')}   cloud ${f('cloud')}   unattrib ${f('unknown')}`);
  return h;
};

// ── Q1  TRAP B ──
console.log('── Q1  the negative lookbehind on the bare-letter form ──');
const NAIVE = /\b[AB]\b\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|prefers?|is|are|will|must|can|has|have)\b/;
const LOOKBEHIND = /(?<![\p{L}\p{N}][ \t]|[\p{L}\p{N}])\b[AB]\b\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|prefers?|is|are|will|must|can|has|have)\b/u;
const hn = rate('M2 NAIVE (no lookbehind)', (t) => NAIVE.test(t));
const hl = rate('M2 with the negative lookbehind', (t) => LOOKBEHIND.test(t));
const spared = [...hn.local, ...hn.cloud, ...hn.unknown].filter((r) => !LOOKBEHIND.test(allText(r.sc)));
console.log(`\n  draws the naive form would REJECT and the lookbehind correctly SPARES: ${spared.length}`);
for (const r of spared.slice(0, 12)) {
  const s = sentences(allText(r.sc)).find((x) => NAIVE.test(x));
  console.log(`    [${r.surface}] ${r.src}#${r.i}: ${norm(s).slice(0, 165)}`);
}

// ── Q2  does bare "the players" earn its place? ──
console.log('\n── Q2  the members of M3, priced individually ──');
rate('"the two players" / "both players"', (t) => /\b(?:the\s+two\s+players|both\s+players)\b/i.test(t));
rate('"each player" / "player one|two"', (t) => /\b(?:each\s+player|player\s+one|player\s+two)\b/i.test(t));
const bare = rate('"the players" BARE (theatrical/sporting risk)', (t) => /\bthe\s+players\b/i.test(t));
const bareOnly = [...bare.local, ...bare.cloud, ...bare.unknown]
  .filter((r) => !/\b(?:the\s+two\s+players|both\s+players|each\s+player|player\s+one|player\s+two|players?\s+[AB])\b/i.test(allText(r.sc)));
console.log(`\n  draws that ONLY the bare "the players" member would catch: ${bareOnly.length}`);
for (const r of bareOnly.slice(0, 10)) {
  const s = sentences(allText(r.sc)).find((x) => /\bthe\s+players\b/i.test(x));
  console.log(`    [${r.surface}] ${r.src}#${r.i}: ${norm(s).slice(0, 175)}`);
}

// ── Q3  TRAP A ──
console.log('\n── Q3  "the game": the hyphen boundary and the product scoping ──');
const GAME_THEORY = /\b(?:payoffs?|equilibri\w+|strateg\w+|players?|matrix|matrices|dominant|zero[\s-]sum|simultaneous\w*|normal[\s-]form|best\s+response|moves?)\b/i;
const GAME_PRODUCT = /\b(?:video\s?games?|game\s+studio|game\s+developer|gaming|console|arcade|board\s+games?|playtest\w*|publisher|storefront|featured\s+slot|download\w*|app\s+store|steam)\b/i;
rate('"the game" BARE (matches "the game-day")', (t) => /\bthe\s+game\b/i.test(t));
rate('"the game" + hyphen boundary', (t) => /\bthe\s+game\b(?![-\w])/i.test(t));
const scoped = (t) => sentences(t).some((s) => /\bthe\s+game\b(?![-\w])/i.test(s) && !GAME_PRODUCT.test(s) && GAME_THEORY.test(s));
rate('"the game" + boundary + theory AND NOT product', scoped);
// The known product draw must be spared by BOTH guards independently.
const GAMEDAY = 'A concession vendor chooses between Joint Promotion and Solo Sales for the game-day menu.';
console.log(`\n  "game-day" draw: bare matches=${/\bthe\s+game\b/i.test(GAMEDAY)}  hyphen-guarded matches=${/\bthe\s+game\b(?![-\w])/i.test(GAMEDAY)}  fully scoped flags=${scoped(GAMEDAY)}`);
const VG = 'A small game studio chooses whether to give the game a Featured Slot or a Standard Slot for the launch.';
console.log(`  video-game draw: hyphen-guarded matches=${/\bthe\s+game\b(?![-\w])/i.test(VG)}  fully scoped flags=${scoped(VG)}  (product-vocab=${GAME_PRODUCT.test(VG)})`);

// ── Q4  the union ──
console.log('\n── Q4  the shipping union ──');
const M1 = (t) => /\bplayers?\s+[AB]\b/i.test(t);
const M2 = (t) => LOOKBEHIND.test(t);
const M3 = (t) => /\b(?:the\s+two\s+players|both\s+players|each\s+player|player\s+one|player\s+two)\b/i.test(t);
const M4 = (t) => /\bpayoffs?\b/i.test(t);
const M5 = scoped;
const U = (t) => M1(t) || M2(t) || M3(t) || M4(t) || M5(t);
rate('UNION M1|M2|M3(no bare)|M4|M5', U);
const sum = [M1, M2, M3, M4, M5].reduce((a, p) => a + pass.filter((r) => p(allText(r.sc))).length, 0);
const un = pass.filter((r) => U(allText(r.sc))).length;
console.log(`\n  sum of the five sub-forms: ${sum} · union: ${un} · overlap: ${sum - un} (${(100 * (sum - un) / sum).toFixed(0)}% of hits match more than one form)`);
const resid = (p) => `${(p * 0.15).toFixed(1)}%-${(p * 0.25).toFixed(1)}%`;
console.log(`  one reroll at 75-90% removal leaves roughly: local ${resid(100 * pass.filter((r) => r.surface === 'local' && U(allText(r.sc))).length / N.local)}, cloud ${resid(100 * pass.filter((r) => r.surface === 'cloud' && U(allText(r.sc))).length / N.cloud)}`);

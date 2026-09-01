/**
 * BLUE — WINDOW 5: the repeated-play VERDICT, in one run so every number shares
 * a denominator. Red is still writing corpora, so the two exploratory scripts
 * were measured against slightly different totals; this is the citable one.
 *
 * Three questions, in the order that decides build-or-refuse:
 *
 *   Q1  Is the FALSE claim present at all? The false claim is not "a season
 *       exists" — it is that THE GAME REPEATS, i.e. the folk-theorem machinery:
 *       future rounds, retaliation, punishment, reputation carried ACROSS
 *       plays, tit-for-tat. Counted per token so a zero cannot hide inside an
 *       alternation.
 *   Q2  Would the candidate rule catch anything real? Its hits are printed in
 *       full and hand-classified.
 *   Q3  Is the class merely CONTAINED rather than absent? Same nets over the
 *       draws the gate REJECTS. If repeated-play claims are being produced and
 *       stopped by an existing screen, "zero on accepted output" would be the
 *       wrong reading.
 *
 *   npx tsx _gen/blue_w5_repeatverdict.mjs
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
    rows.push({ src, i: r.i ?? r.pair ?? r.line, sc, g: r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null) });
  }
}
const isPassing = (r) => {
  if (V.scenarioIsClaimFree(r.sc).ok === false) return false;
  if (!r.g) return true;
  return !(V.validateScenario(r.sc, r.g).issues ?? []).length;
};
const pass = rows.filter(isPassing);
const rej = rows.filter((r) => !isPassing(r));
const norm = (s) => s.replace(/\s+/g, ' ').trim();
console.log(`corpus: ${files.length} files · ${rows.length} unique draws · ${pass.length} gate-passing · ${rej.length} gate-rejected\n`);

// ── Q1: the folk-theorem machinery, TOKEN BY TOKEN ──
const FOLK = [
  ['retaliat*', /\bretaliat\w*/i], ['punish*', /\bpunish\w*/i], ['forgive*', /\bforgiv\w*/i],
  ['tit-for-tat', /\btit[\s-]?for[\s-]?tat\b/i], ['repeated game', /\brepeated\s+(?:game|play|interaction)/i],
  ['iterat*', /\biterat\w*/i], ['next round/season/year', /\bnext\s+(?:round|season|year|game|play|time)\b/i],
  ['future round/play', /\bfuture\s+(?:round|season|year|game|play|interaction)/i],
  ['later rounds', /\blater\s+rounds?\b/i], ['over many X', /\bover\s+(?:many|several|multiple)\s+\w+/i],
  ['again', /\bagain\b/i], ['season after season', /\b(?:season|year|round)\s+after\s+(?:season|year|round)\b/i],
  ['long run (adverbial)', /\bin\s+the\s+long[\s-]run\b/i],
  ['build a reputation', /\bbuild\w*\s+(?:a\s+)?reputation\b/i],
  ['reputation ACROSS plays', /\breputation\b[^.;]{0,40}\b(?:future|next|later|subsequent|over\s+time|long[\s-]run)\b/i],
];
console.log('── Q1  folk-theorem machinery (the actually-false claim), per token ──');
let folkTotal = 0;
for (const [tag, re] of FOLK) {
  const hp = pass.filter((r) => re.test(norm(r.sc.description)));
  const hr = rej.filter((r) => re.test(norm(r.sc.description)));
  folkTotal += hp.length;
  console.log(`  ${tag.padEnd(26)} passing ${String(hp.length).padStart(3)}   rejected ${String(hr.length).padStart(2)}`);
  for (const r of hp.slice(0, 3)) console.log(`        [${r.src}#${r.i}] ${norm(r.sc.description).slice(0, 175)}`);
}
console.log(`\n  TOTAL folk-theorem hits on gate-passing output: ${folkTotal}\n`);

// ── Q2: the candidate structural rule, every hit printed ──
const CAND = /\b(?:each|every)\s+(?:seasons?|years?|months?|weeks?|shifts?|cycles?|quarters?|days?|rounds?|times?)\b[^.;]{0,60}?\b(?:chooses?|choosing|picks?|picking|decides?|deciding|selects?|selecting|plays?|playing|opts?)\b|\b(?:chooses?|choosing|picks?|picking|decides?|deciding|selects?|selecting|plays?|playing|opts?)\b[^.;]{0,60}?\b(?:each|every)\s+(?:seasons?|years?|months?|weeks?|shifts?|cycles?|quarters?|days?|rounds?|times?)\b|\b(?:repeatedly|again\s+and\s+again|over\s+many\s+(?:rounds?|seasons?|years?))\b[^.;]{0,40}?\b(?:chooses?|choosing|picks?|decides?|plays?)\b/i;
// SELF-TEST — W4 policy: prove it fires before reporting its count.
const KP = 'Each season the co-op chooses between Early Harvest and Late Harvest.';
if (!CAND.test(KP)) { console.error('INSTRUMENT BROKEN — candidate rule does not fire on its known-positive. Run void.'); process.exit(1); }
console.log('── Q2  candidate rule "recurrence quantifier + choosing verb" ──');
console.log(`  self-test: fires on the hand-built positive ("${KP}")`);
const ch = pass.filter((r) => CAND.test(norm(r.sc.description)));
console.log(`  hits on gate-passing output: ${ch.length}/${pass.length} = ${(100 * ch.length / pass.length).toFixed(3)}%`);
for (const r of ch) console.log(`\n    [${r.src}#${r.i}] ${r.sc.name}\n      rows: ${r.sc.row1} / ${r.sc.row2}   cols: ${r.sc.col1} / ${r.sc.col2}\n      ${norm(r.sc.description)}`);

// ── Q3: what a LOOSER rule would cost, so the refusal is priced not asserted ──
console.log('\n── Q3  cost of each looser rule that was considered ──');
for (const [tag, re] of [
  ['any cycle noun (season/year/week/shift/day)', /\b(?:seasons?|years?|months?|weeks?|shifts?|cycles?|quarters?|days?)\b/i],
  ['any recurrence adverb (weekly/daily/recurring)', /\b(?:repeatedly|repeated|again|over\s+time|ongoing|recurring|routinely|annually|seasonally|weekly|daily|monthly)\b/i],
  ['the bare word "reputation"', /\breputations?\b/i],
  ['the bare word "round"', /\brounds?\b/i],
  ['the bare phrase "long run"', /\blong[\s-]run\b/i],
]) {
  const h = pass.filter((r) => re.test(norm(r.sc.description)));
  console.log(`  ${tag.padEnd(48)} would reject ${String(h.length).padStart(4)} / ${pass.length} = ${(100 * h.length / pass.length).toFixed(2)}%`);
}

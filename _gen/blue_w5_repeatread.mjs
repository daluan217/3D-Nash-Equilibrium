/**
 * BLUE — WINDOW 5: does the repeated-play DEFECT exist on observed output at all?
 *
 * blue_w5_repeatprice.mjs priced the candidate rule at 1/3063. A reach of ~0 is
 * only interesting once two other things are established, and this file
 * establishes both:
 *
 *   1. THE DETECTOR CAN FIRE. W4's lesson, now repo policy: a zero measured
 *      with an instrument nobody proved is a zero about the instrument. Every
 *      family here is run against hand-built known-positives FIRST and the run
 *      is void if any family fails to fire.
 *
 *   2. THE DEFECT IS ABSENT, not merely unmatched. A narrow rule finding
 *      nothing proves nothing if the claim is being made in vocabulary the rule
 *      does not cover. So this dumps EVERY draw in the adjacent families
 *      (recurrence adverbs, reputation/future) in full for hand reading, plus a
 *      deliberately over-broad net, and asks: is any of this a claim that THE
 *      GAME REPEATS?
 *
 *   npx tsx _gen/blue_w5_repeatread.mjs
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
const passing = rows.filter((r) => {
  if (V.scenarioIsClaimFree(r.sc).ok === false) return false;
  if (!r.g) return true;
  return !(V.validateScenario(r.sc, r.g).issues ?? []).length;
});
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const RECUR_ADVERB = /\b(?:repeatedly|repeated|again|over\s+time|ongoing|recurring|routinely|habitually|each\s+time|every\s+time|annually|seasonally|weekly|daily|monthly)\b/i;
const FUTURE = /\b(?:reputations?|future|next\s+(?:season|year|round|time|month|week)|subsequent|long\s+run|long-run|down\s+the\s+line|later\s+rounds?)\b/i;
// Deliberately OVER-BROAD: anything that could conceivably assert the game is
// played more than once. If the defect exists in vocabulary the narrow rule
// missed, it is in here.
const WIDE = /\b(?:repeat\w*|iterat\w*|rounds?|again|re-?play\w*|每|multiple\s+times|many\s+times|several\s+times|time\s+after\s+time|season\s+after\s+season|year\s+after\s+year|each\s+(?:season|year|round|week|month|day|time)|every\s+(?:season|year|round|week|month|day|time)|reputations?|future\s+(?:round|season|year|game|play)|long[\s-]run|tit[\s-]for[\s-]tat|punish\w*|retaliat\w*|forgive\w*|cooperat\w*\s+over)\b/i;

// ── 1. SELF-TEST: prove each detector fires before trusting any zero ──
const POS = [
  ['narrow-F style', 'Each season the co-op chooses between Early Harvest and Late Harvest, and the mill chooses again the following season.'],
  ['recurrence adverb', 'The two operators repeatedly choose between Dawn Grooming and Night Grooming.'],
  ['future/reputation', 'A firm that undercuts today damages its reputation in future rounds.'],
  ['wide net', 'The game is played over many rounds, and each side can retaliate next year.'],
];
const DET = [['RECUR_ADVERB', RECUR_ADVERB], ['FUTURE', FUTURE], ['WIDE', WIDE]];
let broken = 0;
for (const [name, re] of DET) {
  const fired = POS.filter(([, s]) => re.test(s)).length;
  if (!fired) { console.error(`INSTRUMENT BROKEN — ${name} fires on none of the known-positives`); broken++; }
}
if (broken) { console.error('Run void.'); process.exit(1); }
console.log(`self-test: all ${DET.length} detectors fire on hand-built repeated-play positives\n`);
console.log(`${passing.length} gate-passing draws\n`);

for (const [label, re] of [['RECURRENCE ADVERB', RECUR_ADVERB], ['REPUTATION / FUTURE', FUTURE], ['WIDE NET', WIDE]]) {
  const h = passing.filter((r) => re.test(norm(r.sc.description)));
  console.log(`\n════════ ${label} — ${h.length}/${passing.length} = ${(100 * h.length / passing.length).toFixed(2)}% ════════`);
  for (const r of h) {
    const d = norm(r.sc.description);
    const m = d.match(re);
    console.log(`  «${m ? m[0] : '?'}» [${r.src}#${r.i}] ${d.slice(0, 230)}`);
  }
}

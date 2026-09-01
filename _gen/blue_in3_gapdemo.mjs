/**
 * BLUE-INPUT — end-to-end check that withholding the conflicting playerGap line
 * removes the authored falsehood.
 *
 * RED-INPUT's case: A = [[-8, 6], [-8, 7]], B = [[3, 8], [4, 3]]. A's outcomes
 * span -8..7, B's span 3..8 — B cannot lose. swingA=1, swingB=5, so the OLD
 * line told the model "Player B has far more riding on this than Player A", and
 * 8 of 9 draws duly built the column party as the exposed one, all passing every
 * shipped screen.
 *
 * Run in the pristine worktree and in the candidate worktree with the same
 * domains. The candidate must not send the line at all; the question here is
 * whether the stories stop asserting the false comparison once it is gone.
 *
 *   REPORT_MODEL=gpt-5.6-luna N=10 npx tsx _gen/blue_in3_gapdemo.mjs
 */
import 'dotenv/config';
import { generateScenario, DEFAULT_MODEL } from '../src/utils/report.ts';
import { stakesHint } from '../src/utils/scenarioStakes.ts';
import { validateScenario, scenarioIsClaimFree } from '../src/utils/nashValidator.ts';

const G = { a11: -8, a12: 6, a21: -8, a22: 7, b11: 3, b12: 8, b21: 4, b22: 3 };
const N = Number(process.env.N || 10);
// Fixed domains so the two arms are comparable and neither gets a lucky draw.
const DOMAINS = ['sawmill kiln booking', 'orchard frost protection', 'avalanche patrol routes',
  'nature tour scheduling', 'academic press printing', 'dairy silage clamps', 'island ferry crossings',
  'radio telescope time', 'coppice cutting cycles', 'salt marsh grazing rights'];

const hint = stakesHint(G);
console.log(`GAP LINE SENT: ${/Player [AB] has far more riding/.exec(hint)?.[0] ?? 'NONE — withheld'}`);
console.log(`full hint: ${hint}\n`);

// "More exposed" language pointing at either party. Deliberately generous: this
// is a HAND-CHECK aid, and the verdict below is the printed prose, not this regex.
const EXPOSURE = /\b(more|larger|greater|most|heavily|bigger)\b[^.]{0,60}\b(exposed|exposure|riding|at stake|depends|dependent|relies|reliant|commitment|livelihood)\b|\b(exposed|depends|relies|reliant|dependent)\b[^.]{0,40}\b(more|heavily|larger|most)\b/i;

let n = 0; let flagged = 0; let passed = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  for (;;) {
    const k = n++; if (k >= N) return;
    let sc = null;
    try { sc = (await generateScenario(G, { model: DEFAULT_MODEL, domain: DOMAINS[k % DOMAINS.length], stakes: true })).scenario; } catch { /* counted as no draw */ }
    if (!sc) { console.log(`[${k}] no draw`); continue; }
    const gated = validateScenario(sc, G).ok && scenarioIsClaimFree(sc).ok;
    if (gated) passed++;
    const d = (sc.description ?? '');
    const hit = EXPOSURE.test(d);
    if (hit) flagged++;
    console.log(`[${k}] ${DOMAINS[k % DOMAINS.length]}  gates=${gated ? 'PASS' : 'fail'}  exposure-language=${hit ? 'YES' : 'no'}\n     ${d}`);
  }
}));
console.log(`\n${passed} passed the shipped screens; ${flagged} of ${N} contain an exposure comparison.`);
console.log('Read the prose above: the question is whether any of them names the party that CANNOT LOSE as the more exposed one.');

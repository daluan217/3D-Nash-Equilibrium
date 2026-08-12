/**
 * DISCRIMINATION TEST — the only defensible way to score "voice".
 *
 * Style similarity has no ground truth, so a 1-5 similarity rating is
 * unfalsifiable and drifts with the rater's mood. This instead asks a question
 * with a null hypothesis: shown one real passage and one model passage, can a
 * blind judge tell which is which?
 *
 *   50% accuracy  = indistinguishable (the target)
 *   100% accuracy = obviously different
 *
 * WHY THE JUDGE IS NOT TRUSTED BY DEFAULT. An LLM judge is itself an
 * instrument, and this project has been burned repeatedly by instruments that
 * looked fine. Two guards:
 *   - POSITION IS RANDOMISED per trial, and the tally is reported per position.
 *     A judge that simply always answers "A" scores 50% while knowing nothing;
 *     the position breakdown exposes that.
 *   - A CONTROL CONDITION pits two REAL passages against each other. The judge
 *     should be at chance there BY CONSTRUCTION. If it is not, the judge is
 *     keying on something other than authorship (length, formatting, topic) and
 *     the main number means nothing.
 *
 * The human-label check is still required before publishing any figure: the
 * author should label a sample and the judge's agreement with those labels
 * reported. An LLM judge validated against nothing is not evidence.
 *
 * USAGE
 *   1. Put held-out passages from the paper in exemplars/heldout.json
 *      (an array of strings). These must NOT be the same passages used as
 *      few-shot exemplars, or the test measures memorisation.
 *   2. Put the few-shot exemplars in exemplars/exemplars.json.
 *   3. Run. Neither file is committed -- see .gitignore note below.
 *
 * ANONYMITY: these files contain manuscript prose. The paper is under
 * double-anonymous review, so they must never reach the review-mirror branch or
 * any build served from it.
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';

// Exemplars are gated off by default in report.ts so they cannot ship. This is
// the experiment, so it opts in explicitly — and nothing else does.
process.env.ALLOW_STYLE_EXEMPLARS = '1';
import { callProvider } from '../src/utils/providers';
import { generateReport } from '../src/utils/report';
import { validateReport } from '../src/utils/nashValidator';
import { PRESETS } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

const JUDGE = process.env.D_JUDGE || 'gpt-5.6-sol-1';
const DIR = process.env.D_DIR || '_gen/exemplars';

function loadJson(name: string): string[] {
  const path = `${DIR}/${name}`;
  if (!existsSync(path)) {
    console.error(`missing ${path}. See the header of this file for what it should contain.`);
    process.exit(1);
  }
  const v = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    console.error(`${path} must be a JSON array of strings`);
    process.exit(1);
  }
  return v as string[];
}

/**
 * Games to generate model passages about.
 *
 * TOPIC IS A CONFOUND AND IS CONTROLLED HERE. The held-out passages describe
 * Matching Pennies and the "search game" (left door worth 2, right worth 1,
 * equilibrium one-third). If the model wrote about entirely different games, a
 * judge could separate the two sides on SUBJECT rather than voice — and the
 * real-vs-real control would not catch it, because both sides there are real.
 * So both of those games are included, and the search game is exactly the
 * zero-sum [[2,0],[0,1]] whose equilibrium is 1/3.
 *
 * The other two are kept so the arm is not tuned to the exemplars' subject
 * matter alone.
 */
const GAMES = (['search', 'spy', 'bos', 'pd'] as const).map((k) => {
  const p = PRESETS[k];
  return {
    name: p.name,
    g: { a11: p.a11!, a12: p.a12!, a21: p.a21!, a22: p.a22!,
         b11: p.b11!, b12: p.b12!, b21: p.b21!, b22: p.b22! } as GamePayoffs,
    // Scenario nouns are part of the condition now: without them the model can
    // only say "Player A plays Row 1", which a judge separates on subject matter
    // rather than voice.
    scenario: { name: p.name, row1: p.row1Label, row2: p.row2Label,
                col1: p.col1Label, col2: p.col2Label },
  };
});

/**
 * ARM 3 — the SHIPPABLE alternative: the habits, paraphrased, with no manuscript
 * text. If this matches few-shot, the voice gain can go to production without
 * putting verbatim passages in a deployed prompt while the paper is under
 * double-anonymous review.
 *
 * Worth stating the prior: the framing pilot found that INSTRUCTIONS do not take
 * on this model, only material does. These are mechanical directives (use second
 * person, spell numbers as words) rather than claims to deploy, so they may
 * transfer where the earlier slogans did not — but that is a hypothesis, and
 * this arm is how it gets tested rather than assumed.
 */
const HABITS = `Write in this explanatory voice:
- Give the picture before the algebra. State the intuitive fact in plain words first; numbers arrive only to confirm it. Never open with a computation.
- If the game contains something counterintuitive, state it flatly and deadpan, then resolve it. Do not soften the paradox.
- Second person throughout. The reader is a player, not an observer: "you" choose, "your opponent" responds.
- Put any hedge AFTER the strong claim, as one calm sentence. Never open with a qualification.
- Spell numbers as words — "a third", "two-thirds", "fifty-fifty" — so the prose stays prose.
- Name the equilibrium as a place or a thing, not only as a coordinate.
- Let short sentences carry the turns in the argument.`;

const JUDGE_SYS = `You will see two short passages explaining game theory, labelled A and B.
Exactly one was written by a specific human author; the other was produced by a language model.
Answer with JSON only: {"human":"A"} or {"human":"B"}. Guess if unsure.`;

async function judge(p1: string, p2: string): Promise<'A' | 'B' | null> {
  const r = await callProvider({
    model: JUDGE,
    systemPrompt: JUDGE_SYS,
    userPrompt: `Passage A:\n${p1}\n\nPassage B:\n${p2}`,
    schema: { type: 'object', required: ['human'], properties: { human: { type: 'string', enum: ['A', 'B'] } } },
    maxOutputTokens: 4096,
  });
  if (!r.text) return null;
  try {
    const v = String(JSON.parse(r.text).human).trim().toUpperCase();
    return v === 'A' || v === 'B' ? (v as 'A' | 'B') : null;
  } catch { return null; }
}

/** One trial with randomised position; returns whether the judge was right. */
async function trial(real: string, other: string, rng: () => number) {
  const realFirst = rng() < 0.5;
  const pick = await judge(realFirst ? real : other, realFirst ? other : real);
  if (pick === null) return null;
  const correct = realFirst ? pick === 'A' : pick === 'B';
  return { correct, realPosition: realFirst ? 'A' : 'B' as 'A' | 'B' };
}

(async () => {
  const exemplars = loadJson('exemplars.json');
  const heldout = loadJson('heldout.json');
  if (heldout.length < 2) { console.error('need >= 2 held-out passages'); process.exit(1); }

  let seed = 20260812;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  console.log(`judge=${JUDGE}  exemplars=${exemplars.length}  held-out=${heldout.length}\n`);

  // ── Generate model passages, both arms ────────────────────────────────────
  const arms: Record<string, string[]> = { baseline: [], 'few-shot': [], habits: [] };
  for (const { name, g, scenario } of GAMES) {
    for (const arm of ['baseline', 'few-shot', 'habits'] as const) {
      const opts = arm === 'few-shot' ? { scenario, styleExemplars: exemplars }
                 : arm === 'habits' ? { scenario, framingGuidance: HABITS }
                 : { scenario };
      const r = await generateReport(g, opts);
      if (!r.report) { console.log(`  ${arm}/${name}: no report (${r.failure})`); continue; }
      const v = validateReport(r.report, g);
      // GUARDRAIL: style work must not cost correctness.
      if (!v.ok) console.log(`  *** ${arm}/${name}: VALIDATOR FAIL (${v.mismatches.length}) ***`);
      arms[arm].push(r.report.prose);
    }
  }
  console.log(`generated: baseline=${arms.baseline.length}  few-shot=${arms['few-shot'].length}  habits=${arms.habits.length}\n`);

  // ── Control: two REAL passages. Judge should be at chance by construction. ──
  let cOk = 0, cN = 0;
  for (let i = 0; i + 1 < heldout.length; i += 2) {
    const t = await trial(heldout[i], heldout[i + 1], rng);
    if (t) { cN++; if (t.correct) cOk++; }
  }
  console.log(`CONTROL (real vs real): ${cOk}/${cN} "correct" — should be ~50%; far from it means the judge keys on something other than authorship\n`);

  // ── Main: real vs model, per arm ──────────────────────────────────────────
  for (const arm of ['baseline', 'few-shot', 'habits'] as const) {
    let ok = 0, n = 0; const byPos: Record<string, number> = { A: 0, B: 0 };
    for (const model of arms[arm]) {
      for (const real of heldout) {
        const t = await trial(real, model, rng);
        if (!t) continue;
        n++; if (t.correct) ok++; byPos[t.realPosition]++;
      }
    }
    const pct = n ? ((ok / n) * 100).toFixed(0) : 'n/a';
    console.log(`${arm.padEnd(10)} judge identified the human ${ok}/${n} = ${pct}%   (real appeared as A ${byPos.A}, B ${byPos.B})`);
  }
  console.log(`\n50% = indistinguishable. Report the human-label agreement before publishing any of this.`);
})();

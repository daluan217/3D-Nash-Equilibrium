/**
 * PHASE 2 PILOT — does teaching the explainer the paper's framings make it
 * assert them where their precondition FAILS?
 *
 * WHY THIS IS THE MEASURABLE HALF. "Sound like the author" has no ground truth,
 * so any metric is an unfalsifiable preference rating. But the paper's
 * interpretive claims are CONDITIONALS whose antecedents are exactly computable
 * from the payoff matrix — is the game zero-sum, is there an interior mixed
 * equilibrium, is there a dominant strategy. So "was this framing applicable
 * here?" is decidable even though "did it sound right?" is not.
 *
 * WHY IT MATTERS FOR THE PRODUCT. nashValidator checks the numbers INSIDE a
 * claim; it never checks whether the claim's precondition holds. Its seven
 * checks are out-of-range, nonzero-regret, not-in-solver, wrong-type, omitted,
 * prose-bad-coordinate, prose-bad-payoff. A report asserting "this is the
 * minimax value" about a NON-zero-sum game passes all seven, because every
 * number in it is correct. Framing injection can therefore introduce a class of
 * error the shipped gate is blind to.
 *
 * ASSERTION DETECTION IS NOT AUTOMATED HERE, ON PURPOSE. This codebase already
 * built a lexical prose check ("does this assert a pure equilibrium?") as a
 * regex over \bpure\b minus a negation window, and deleted it because it flagged
 * correct prose — "if the opponent played a single pure strategy" and "neither
 * side can commit to a single pure action" both misfired. Distinguishing an
 * assertion from a counterfactual or a negation is semantic, not lexical.
 * Keyword hits below are therefore printed as CANDIDATES for human adjudication
 * and are never scored. The precondition half IS computed exactly.
 */
import 'dotenv/config';
import { generateReport } from '../src/utils/report';
import { validateReport } from '../src/utils/nashValidator';
import { computeAllNE } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

const isZeroSum = (g: GamePayoffs) =>
  (['a11:b11', 'a12:b12', 'a21:b21', 'a22:b22'] as const)
    .every((pair) => {
      const [x, y] = pair.split(':') as [keyof GamePayoffs, keyof GamePayoffs];
      return Math.abs((g[x] as number) + (g[y] as number)) < 1e-9;
    });

const hasInteriorMixed = (g: GamePayoffs) =>
  computeAllNE(g).some((n: { type: string; x: number; y: number }) =>
    n.type === 'mixed' && n.x > 0 && n.x < 1 && n.y > 0 && n.y < 1);

/**
 * The paper's framings, paraphrased from the paper session's summary — claim
 * statements and conditions, not manuscript text. This is the injected arm.
 */
const FRAMING = `When it helps the reader, you may use these framings:
- A mixed strategy can be understood as a pure strategy in disguise: expected payoff is a weighted average of the pure payoffs, so mixing only ever matters when the player is exactly indifferent.
- An equilibrium mixture is chosen to keep the OPPONENT indifferent, not to maximise one's own payoff, so a player's own self-interest does not point toward it.
- The indifference structure of such a game is von Neumann's minimax: it defines the value of the game.
Use these where they illuminate the game in front of you.`;

/**
 * MANDATORY DOSE — the same framings, demanded rather than offered.
 *
 * The permissive arm above has a validity hole that makes its null result
 * unreadable: if the model simply declined the invitation, then nothing was
 * injected and "framing injection does not cause false assertions" is a
 * statement about an experiment that never happened. This project has already
 * established that models use the MATERIAL you hand them and ignore the
 * PERMISSIONS you grant, which is precisely the failure mode that would produce
 * a spurious null here.
 *
 * So this arm removes the opt-out. If uptake is high here and the false-assertion
 * rate stays at zero, the earlier null is real and the framings are safe. If
 * false assertions appear only here, the earlier null was a dosage artifact and
 * the permissive arm was measuring nothing.
 *
 * Deliberately NOT hedged: no "where applicable", no "if it fits". A hedge would
 * reintroduce the escape hatch this arm exists to close. That makes this arm an
 * ADVERSARIAL probe rather than a shippable prompt — the point is to find out
 * whether the model will assert a framing off-precondition when pushed, not to
 * propose that anyone deploy this wording.
 */
const FRAMING_MANDATORY = `You MUST work at least one of these framings into your explanation:
- A mixed strategy can be understood as a pure strategy in disguise: expected payoff is a weighted average of the pure payoffs, so mixing only ever matters when the player is exactly indifferent.
- An equilibrium mixture is chosen to keep the OPPONENT indifferent, not to maximise one's own payoff, so a player's own self-interest does not point toward it.
- The indifference structure of such a game is von Neumann's minimax: it defines the value of the game.
Name the framing you used explicitly in the prose.`;

interface Case { name: string; g: GamePayoffs; claim: string; precondition: string; holds: boolean }

const CASES: Case[] = [
  {
    name: 'matching-pennies',
    g: { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 },
    claim: 'minimax / value of the game', precondition: 'zero-sum', holds: true,
  },
  {
    name: 'zero-sum-ugly (7,-3,-6,1)',
    g: { a11: 7, a12: -3, a21: -6, a22: 1, b11: -7, b12: 3, b21: 6, b22: -1 },
    claim: 'minimax / value of the game', precondition: 'zero-sum', holds: true,
  },
  {
    name: 'battle-of-sexes  [NEGATIVE]',
    g: { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 },
    claim: 'minimax / value of the game', precondition: 'zero-sum', holds: false,
  },
  {
    name: 'non-zero-sum mixed (3,0,0,2 / 1,0,0,4)  [NEGATIVE]',
    g: { a11: 3, a12: 0, a21: 0, a22: 2, b11: 1, b12: 0, b21: 0, b22: 4 },
    claim: 'minimax / value of the game', precondition: 'zero-sum', holds: false,
  },
  {
    name: 'prisoners-dilemma  [NEGATIVE]',
    g: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 },
    claim: 'mixed-as-disguised-pure / opponent-indifference', precondition: 'interior mixed NE exists', holds: false,
  },
];

/**
 * Two probe lists, because one list cannot measure uptake.
 *
 * The first version of this pooled them and reported 80% "uptake" on the
 * BASELINE arm — an arm with no framing injected at all, where real uptake must
 * be near zero. The pooled list was dominated by 'indifferen', which the
 * PRODUCTION system prompt and the geometry briefing already mandate ("that flat
 * shelf is A's indifference"). So the metric was mostly counting the model using
 * the vocabulary it is always told to use, and the arm-to-arm comparison it fed
 * was meaningless.
 *
 * GENERIC words are ones the base prompt already produces. They are still
 * printed, because a sentence like "rather than a mirror-image zero-sum
 * structure" is a CORRECT denial and is worth seeing — but they are not uptake.
 *
 * DISTINCTIVE words appear nowhere in the base prompt, the schema, or the
 * geometry briefing. Only the injected framing supplies them, so their presence
 * is attributable. Uptake is measured on these alone.
 */
const GENERIC_PROBES = ['indifferen', 'zero-sum', 'zero sum', 'strictly competitive'];
const DISTINCTIVE_PROBES = ['minimax', 'value of the game', "game's value",
                            'in disguise', 'disguise', 'saddle'];
const PROBES = [...DISTINCTIVE_PROBES, ...GENERIC_PROBES];

const PASSES = Number(process.env.F_N || 2);

const ARMS = ['baseline', 'framing-injected', 'framing-mandatory'] as const;
type Arm = typeof ARMS[number];

const guidanceFor = (arm: Arm) =>
  arm === 'framing-injected' ? { framingGuidance: FRAMING }
  : arm === 'framing-mandatory' ? { framingGuidance: FRAMING_MANDATORY }
  : {};

/**
 * Per-arm tallies. `uptake` counts passes whose prose MENTIONS a framing topic.
 *
 * Read that as "was the arm dosed?", never as "did it assert the framing?".
 * Presence of a topic word is decidable; whether a sentence asserts a claim or
 * merely negates or supposes it is not, which is the whole reason the keyword
 * hits stay CANDIDATES for human adjudication. The distinction matters most in
 * the negative rows, where an assertion would be an error and a negation would
 * be correct — and only a human can tell those apart.
 */
interface Tally { n: number; ok: number; uptake: number; generic: number; negN: number; negUptake: number; geomFail: number }

(async () => {
  console.log(`FRAMING PILOT — ${CASES.length} games x ${PASSES} passes x ${ARMS.length} arms\n`);
  const tally: Record<Arm, Tally> = Object.fromEntries(
    ARMS.map((a) => [a, { n: 0, ok: 0, uptake: 0, generic: 0, negN: 0, negUptake: 0, geomFail: 0 }]),
  ) as Record<Arm, Tally>;
  const flagged: string[] = [];

  for (const arm of ARMS) {
    console.log(`\n################ ARM: ${arm} ################`);
    for (const c of CASES) {
      const zs = isZeroSum(c.g), im = hasInteriorMixed(c.g);
      console.log(`\n=== ${c.name}`);
      console.log(`    precondition [${c.precondition}] -> ${c.holds ? 'HOLDS' : 'FAILS'}   (zero-sum=${zs}, interior-mixed=${im})`);
      for (let p = 0; p < PASSES; p++) {
        const r = await generateReport(c.g, guidanceFor(arm));
        if (!r.report) { console.log(`    pass ${p + 1}: no report (failure=${r.failure})`); continue; }
        const v = validateReport(r.report, c.g);
        const prose = r.report.prose || '';
        const lower = prose.toLowerCase();
        const dist = DISTINCTIVE_PROBES.filter((t) => lower.includes(t));
        const gen = GENERIC_PROBES.filter((t) => lower.includes(t));

        const t = tally[arm];
        t.n++;
        if (v.ok) t.ok++;
        // Uptake counts DISTINCTIVE markers only -- see the PROBES comment.
        if (dist.length) t.uptake++;
        if (gen.length) t.generic++;
        if (v.mismatches.some((m) => m.kind.startsWith('geometry-'))) t.geomFail++;
        if (!c.holds) { t.negN++; if (dist.length) t.negUptake++; }

        console.log(`    pass ${p + 1}: validator=${v.ok ? 'PASS' : 'FAIL'}  framing=[${dist.join(', ') || 'none'}]  generic=[${gen.join(', ') || 'none'}]`);
        console.log(`      ${prose.replace(/\n/g, ' ')}`);
        // A DISTINCTIVE marker on a game whose precondition FAILS is the only
        // place a false assertion can live. Collected for human adjudication.
        if (!c.holds && dist.length) flagged.push(`[${arm}] ${c.name} p${p + 1}: ${prose.replace(/\n/g, ' ')}`);
      }
    }
  }

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : 'n/a');
  console.log(`\n${'='.repeat(70)}\nSUMMARY`);
  console.log('arm                 n   validator   geom-fail   FRAMING uptake   generic vocab   framing on NEGATIVES');
  for (const arm of ARMS) {
    const t = tally[arm];
    console.log(
      `${arm.padEnd(18)} ${String(t.n).padStart(2)}   ${pct(t.ok, t.n).padStart(9)}   `
      + `${String(t.geomFail).padStart(9)}   ${pct(t.uptake, t.n).padStart(14)}   `
      + `${pct(t.generic, t.n).padStart(13)}   ${pct(t.negUptake, t.negN).padStart(20)}`,
    );
  }
  console.log(`
HOW TO READ THIS
  FRAMING uptake counts only words the base prompt never supplies (minimax,
  in disguise, saddle). BASELINE uptake is the control and should be ~0%; if it
  is not, the probe list is confounded and no arm comparison is readable.
  "generic vocab" is the base prompt's own vocabulary (indifference, zero-sum)
  and is shown only for context -- it is NOT uptake.
  If framing-injected uptake is LOW, its earlier null result is vacuous — nothing
  was injected, so nothing was tested. framing-mandatory removes that escape
  hatch; its uptake should be high by construction.
  "uptake on NEGATIVES" is a CANDIDATE count, not an error count. A passage may
  mention minimax in order to say the idea does NOT apply here, which is correct.
  Only human adjudication of the passages below can separate those.`);

  console.log(`\n${'-'.repeat(70)}\nFOR HUMAN ADJUDICATION — topic mentioned where the precondition FAILS (${flagged.length}):`);
  for (const f of flagged) console.log(`\n  ${f}`);
})();

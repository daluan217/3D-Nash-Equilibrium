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

const PROBES = ['minimax', 'value of the game', "game's value", 'in disguise',
                'disguise', 'indifferen', 'zero-sum', 'zero sum', 'strictly competitive', 'saddle'];

const PASSES = Number(process.env.F_N || 2);

(async () => {
  console.log(`FRAMING PILOT — ${CASES.length} games x ${PASSES} passes x 2 arms\n`);

  for (const arm of ['baseline', 'framing-injected'] as const) {
    console.log(`\n################ ARM: ${arm} ################`);
    for (const c of CASES) {
      const zs = isZeroSum(c.g), im = hasInteriorMixed(c.g);
      console.log(`\n=== ${c.name}`);
      console.log(`    precondition [${c.precondition}] -> ${c.holds ? 'HOLDS' : 'FAILS'}   (zero-sum=${zs}, interior-mixed=${im})`);
      for (let p = 0; p < PASSES; p++) {
        const r = await generateReport(c.g, arm === 'framing-injected' ? { framingGuidance: FRAMING } : {});
        if (!r.report) { console.log(`    pass ${p + 1}: no report (failure=${r.failure})`); continue; }
        const v = validateReport(r.report, c.g);
        const prose = r.report.prose || '';
        const hits = PROBES.filter((t) => prose.toLowerCase().includes(t));
        console.log(`    pass ${p + 1}: validator=${v.ok ? 'PASS' : 'FAIL'}  candidates=[${hits.join(', ') || 'none'}]`);
        console.log(`      ${prose.replace(/\n/g, ' ')}`);
      }
    }
  }
})();

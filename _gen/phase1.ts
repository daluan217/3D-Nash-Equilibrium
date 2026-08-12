/**
 * PHASE 1 — repeated play, not equilibrium computation.
 *
 * Phase 0 established that five models compute x* exactly (100% on all three
 * arms of the golden set). That makes the one-shot task useless for ranking
 * them, and it leaves the more interesting question untouched: computing an
 * equilibrium and PLAYING one against an adversary are different capabilities.
 *
 * Three things are measured, each of which the one-shot task cannot see:
 *
 *   1. RANDOMIZATION. Emitting the number 0.4118 is not the same as producing
 *      an unpredictable action sequence. Measured by lag-1 autocorrelation and
 *      by how well a trivial online predictor guesses the next action.
 *
 *   2. EXPLOITATION. Against a predictable opponent the correct play is NOT the
 *      equilibrium — it is the best response. An agent that "plays the NE mix"
 *      regardless is pattern-matching, not reasoning. This arm has a unique
 *      right answer that differs from the equilibrium, which is the same
 *      falsification logic as the golden set's three-arm split.
 *
 *   3. EXPLOITABILITY. What an adversary could take from the agent's own
 *      empirical mix, in payoff units. >= 0 by construction.
 *
 * OPPONENTS (an LLM-vs-LLM arm alone cannot separate these):
 *   ne-bot       plays the exact NE mix. Every response earns the same expected
 *                payoff, so any drift is unforced and randomization is visible.
 *   pattern-bot  plays a fixed cycle. Highly exploitable; the discriminating arm.
 *   llm          another model, for emergent joint behaviour.
 *
 * DESIGN NOTE — why agents choose an ACTION, not a probability: sampling a
 * probability the model reports would measure its BELIEF and let OUR rng do the
 * randomizing. Asking for the action makes the model own the sequence, which is
 * the thing under test.
 */
import 'dotenv/config';
import { callProvider, type ReasoningEffort } from '../src/utils/providers';

type Mat = number[][];
type Action = 0 | 1;

/** x* on action 0 that makes the OPPONENT indifferent, for zero-sum A. */
const mixOf = (A: Mat) => (A[1][1] - A[1][0]) / (A[0][0] - A[0][1] - A[1][0] + A[1][1]);
/** Payoff to the row player if the opponent best-responds to mix p. */
const guaranteed = (A: Mat, p: number) =>
  Math.min(A[0][0] * p + A[1][0] * (1 - p), A[0][1] * p + A[1][1] * (1 - p));
/** Best payoff available against a KNOWN opponent mix q (prob on their action 0). */
const bestResponseValue = (A: Mat, q: number) =>
  Math.max(A[0][0] * q + A[0][1] * (1 - q), A[1][0] * q + A[1][1] * (1 - q));

/** The column player's game, re-expressed so they are a row player too. */
const asRowGame = (A: Mat): Mat => [[-A[0][0], -A[1][0]], [-A[0][1], -A[1][1]]];

interface Agent {
  name: string;
  /** Choose an action given this agent's own history. */
  play(hist: { me: Action; opp: Action }[], A: Mat): Promise<Action | null>;
}

// ── Bots ─────────────────────────────────────────────────────────────────────

/** Unexploitable reference: plays the exact equilibrium mix. */
function neBot(A: Mat, rng: () => number): Agent {
  const p = mixOf(A);
  return { name: `ne-bot`, play: async () => (rng() < p ? 0 : 1) };
}

/**
 * Deliberately exploitable: a fixed repeating cycle. An agent that best-responds
 * should converge on the single action that beats the cycle's majority.
 */
function patternBot(cycle: Action[]): Agent {
  let i = 0;
  return { name: `pattern-bot[${cycle.join('')}]`, play: async () => cycle[i++ % cycle.length] };
}

// ── LLM agent ────────────────────────────────────────────────────────────────

const SCHEMA = {
  type: 'object',
  required: ['action'],
  properties: { action: { type: 'string', enum: ['A', 'B'], description: 'Your action this round: "A" or "B".' } },
};

const SYS = `You are playing the SAME two-player simultaneous game repeatedly against the same opponent.
Each round you choose action A or action B. Your goal is to MAXIMIZE YOUR OWN TOTAL PAYOFF over all rounds.
You may exploit any pattern you detect in the opponent's play.
Respond with JSON only, exactly: {"action": "A"} or {"action": "B"}.`;

function llmAgent(model: string, reasoning: ReasoningEffort | undefined): Agent {
  return {
    name: model,
    async play(hist, A) {
      const table = [
        'Payoff table (your payoff first, opponent payoff second):',
        `  you A, opponent A -> (${A[0][0]}, ${-A[0][0]})`,
        `  you A, opponent B -> (${A[0][1]}, ${-A[0][1]})`,
        `  you B, opponent A -> (${A[1][0]}, ${-A[1][0]})`,
        `  you B, opponent B -> (${A[1][1]}, ${-A[1][1]})`,
      ].join('\n');
      const recent = hist.slice(-20);
      const historyText = recent.length
        ? ['', `History (most recent ${recent.length} of ${hist.length} rounds):`,
           ...recent.map((h, i) => `  round ${hist.length - recent.length + i + 1}: you ${h.me ? 'B' : 'A'}, opponent ${h.opp ? 'B' : 'A'}, you scored ${A[h.me][h.opp]}`)].join('\n')
        : '\nThis is round 1. No history yet.';

      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await callProvider({
          model, systemPrompt: SYS, userPrompt: table + historyText,
          schema: SCHEMA, maxOutputTokens: 4096, reasoning,
        });
        if (r.failure === 'rate-limited') { await new Promise((z) => setTimeout(z, 1200 * 2 ** attempt)); continue; }
        if (!r.text) return null;
        try {
          const a = String(JSON.parse(r.text).action).trim().toUpperCase();
          if (a === 'A') return 0;
          if (a === 'B') return 1;
        } catch { /* fall through to retry */ }
        return null;
      }
      return null;
    },
  };
}

// ── Randomization diagnostics ────────────────────────────────────────────────

/** Lag-1 autocorrelation. ~0 = unpredictable; +ve = streaky; -ve = alternating. */
function autocorr(seq: Action[]): number {
  if (seq.length < 3) return NaN;
  const m = seq.reduce((a, b) => a + b, 0) / seq.length;
  let num = 0, den = 0;
  for (let i = 0; i < seq.length; i++) den += (seq[i] - m) ** 2;
  for (let i = 0; i < seq.length - 1; i++) num += (seq[i] - m) * (seq[i + 1] - m);
  return den === 0 ? NaN : num / den;
}

/**
 * How well a trivial online predictor guesses the next action from the history
 * so far (most frequent action, ties -> 0). 0.5 = unpredictable. A genuinely
 * mixed strategy should sit near max(p, 1-p) and no higher.
 */
function predictability(seq: Action[]): number {
  let hits = 0, n = 0, c0 = 0, c1 = 0;
  for (let i = 0; i < seq.length; i++) {
    if (i > 0) { n++; if ((c0 >= c1 ? 0 : 1) === seq[i]) hits++; }
    seq[i] === 0 ? c0++ : c1++;
  }
  return n ? hits / n : NaN;
}

// ── Match ────────────────────────────────────────────────────────────────────

async function playMatch(A: Mat, rowAgent: Agent, colAgent: Agent, rounds: number) {
  const colA = asRowGame(A);
  const rowHist: { me: Action; opp: Action }[] = [];
  const colHist: { me: Action; opp: Action }[] = [];
  const rowSeq: Action[] = [], colSeq: Action[] = [];
  let rowPayoff = 0, aborted = 0;

  for (let t = 0; t < rounds; t++) {
    const [r, c] = await Promise.all([rowAgent.play(rowHist, A), colAgent.play(colHist, colA)]);
    if (r === null || c === null) { aborted++; continue; }
    rowHist.push({ me: r, opp: c });
    colHist.push({ me: c, opp: r });
    rowSeq.push(r); colSeq.push(c);
    rowPayoff += A[r][c];
  }
  return { rowSeq, colSeq, rowPayoff, aborted };
}

/**
 * Payoff a perfect predictor earns against a DETERMINISTIC opponent: it knows
 * each round's action and best-responds to it individually. This is the correct
 * ceiling for the exploitation metric — best-responding to the opponent's
 * marginal frequency is strictly weaker, and using it as the denominator let
 * "captured" exceed 100% whenever an agent actually tracked the cycle.
 */
const oracleVsCycle = (A: Mat, cycle: Action[]) =>
  cycle.reduce((s, c) => s + Math.max(A[0][c], A[1][c]), 0) / cycle.length;

function report(
  label: string, A: Mat, seq: Action[], oppSeq: Action[], avgPayoff: number,
  /** Ceiling for exploitation; omitted when the opponent is not exploitable. */
  oracle?: number,
) {
  const xStar = mixOf(A);
  const p = seq.length ? seq.filter((a) => a === 0).length / seq.length : NaN;
  const q = oppSeq.length ? oppSeq.filter((a) => a === 0).length / oppSeq.length : NaN;
  const neValue = guaranteed(A, xStar);
  const exploitability = neValue - guaranteed(A, p);       // what an adversary could take
  const brValue = bestResponseValue(A, q);                 // best available vs opponent's marginal
  // Only meaningful against an exploitable opponent: vs ne-bot every response
  // earns the same expected payoff, so the ratio would be dividing noise by noise.
  const capture = oracle !== undefined && oracle - neValue > 1e-9
    ? (avgPayoff - neValue) / (oracle - neValue)
    : NaN;
  console.log(
    `  ${label.padEnd(34)} p=${p.toFixed(3)} (x*=${xStar.toFixed(3)})  ` +
    `exploitability=${exploitability.toFixed(3)}  autocorr=${autocorr(seq).toFixed(2)}  ` +
    `predictable=${(predictability(seq) * 100).toFixed(0)}%  avgPayoff=${avgPayoff.toFixed(2)} ` +
    `(NE ${neValue.toFixed(2)}, ` +
    `${oracle !== undefined ? `perfect ${oracle.toFixed(2)}, captured ${(capture * 100).toFixed(0)}%` : `best-vs-marginal ${brValue.toFixed(2)}`})`,
  );
}

// ── Runner ───────────────────────────────────────────────────────────────────

const GAMES: { name: string; A: Mat }[] = [
  { name: 'matching-pennies', A: [[1, -1], [-1, 1]] },        // x* = 0.5, symmetric
  { name: 'asymmetric-7317', A: [[7, -3], [-6, 1]] },         // x* = 7/17 ≈ 0.4118
];

const MODELS = (process.env.P1_MODELS || 'gpt-5.4-nano,claude-haiku-4-5,DeepSeek-V4-Flash').split(',');
const ROUNDS = Number(process.env.P1_ROUNDS || 30);
const REASONING = (process.env.P1_REASONING || 'high') as ReasoningEffort;

(async () => {
  let seed = 12345;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  console.log(`PHASE 1 — repeated play   rounds=${ROUNDS}  reasoning=${REASONING}  models=${MODELS.join(', ')}\n`);
  console.log('KEY: p = agent\'s empirical freq of action A. exploitability = payoff an adversary');
  console.log('     could take vs the agent\'s own mix (0 = unexploitable). captured = fraction of');
  console.log('     the AVAILABLE exploitation the agent actually took (vs a predictable opponent).\n');

  // P1_GAMES filters which games to run. This is a RUNNER convenience for
  // completing a partial grid — it changes nothing about the conditions a model
  // plays under, so cells run separately stay comparable to cells run together.
  const only = (process.env.P1_GAMES || '').split(',').filter(Boolean);
  for (const g of GAMES.filter((x) => !only.length || only.includes(x.name))) {
    console.log(`=== ${g.name}  A=[[${g.A[0]}],[${g.A[1]}]]  x*=${mixOf(g.A).toFixed(4)} ===`);
    for (const model of MODELS) {
      const reasoning = process.env[`P1_REASONING_${model}`] as ReasoningEffort | undefined ?? REASONING;

      const arms = (process.env.P1_ARMS || '').split(',').filter(Boolean);
      const runArm = (a: string) => !arms.length || arms.includes(a);

      // Arm 1 — vs equilibrium bot: unforced drift + randomization quality.
      if (runArm('ne')) {
        const m = await playMatch(g.A, llmAgent(model, reasoning), neBot(asRowGame(g.A), rng), ROUNDS);
        report(`${model} vs ne-bot`, g.A, m.rowSeq, m.colSeq, m.rowPayoff / Math.max(1, m.rowSeq.length));
        if (m.aborted) console.log(`      (${m.aborted} rounds dropped: no parseable action)`);
      }
      // Arm 2 — vs exploitable cycle: does it ABANDON the equilibrium to exploit?
      if (runArm('pattern')) {
        const cycle: Action[] = [0, 0, 1];
        const m = await playMatch(g.A, llmAgent(model, reasoning), patternBot(cycle), ROUNDS);
        report(`${model} vs pattern-bot[001]`, g.A, m.rowSeq, m.colSeq, m.rowPayoff / Math.max(1, m.rowSeq.length),
          oracleVsCycle(g.A, cycle));
        if (m.aborted) console.log(`      (${m.aborted} rounds dropped: no parseable action)`);
      }
    }
    console.log('');
  }
})();

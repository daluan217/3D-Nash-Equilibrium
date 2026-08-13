/**
 * ABSTRACTION LADDER AT 3x3 — does formalization finally break?
 *
 * The 2x2 ladder found formalization essentially free (100% in 19 of 20 cells)
 * and solving to be the entire bottleneck. That result has one honest weakness:
 * recovering FOUR numbers from a fixed narrative skeleton is easy, so the
 * instrument was validated but never stressed.
 *
 * At 3x3 the model must recover NINE numbers, and prior work reports accuracy
 * collapsing 34% -> 18% -> 2% across 2x2 -> 3x3 -> 5x5 on anonymous matrices.
 * If formalization breaks here, the three-way decomposition finally earns its
 * keep by showing WHICH half broke; if it holds, "models read game descriptions
 * reliably" is a much stronger statement than the 2x2 run could support.
 *
 * SIZE IS THE ONLY VARIABLE CHANGED vs the 2x2 ladder: same five rungs, same
 * scenario skeleton, same models, same reasoning levels, zero-sum throughout.
 *
 * SCORING is deliberately kept comparable to the 2x2 run. Games are restricted
 * to a UNIQUE completely-mixed equilibrium, so x* is well defined and the
 * primary score is the same element-wise coordinate match within 0.02. A
 * continuous exploitability figure is reported alongside, since at 3x3 "how
 * wrong" is more informative than "wrong".
 */
import 'dotenv/config';
import { callProvider, type ReasoningEffort } from '../src/utils/providers';
import { enumerateNE, type MNGame } from './mnsolver';

type Mat = number[][];

/** Row player's guaranteed payoff against a best-responding opponent. */
function guaranteed(A: Mat, x: number[]): number {
  const n = A[0].length;
  let worst = Infinity;
  for (let j = 0; j < n; j++) {
    let v = 0;
    for (let i = 0; i < A.length; i++) v += x[i] * A[i][j];
    worst = Math.min(worst, v);
  }
  return worst;
}
const rangeOf = (A: Mat) => Math.max(...A.flat()) - Math.min(...A.flat());
const zeroSumOf = (A: Mat): MNGame => ({ A, B: A.map((r) => r.map((v) => -v)) });

/** The unique completely-mixed equilibrium of a zero-sum A, or null. */
function uniqueInteriorNE(A: Mat): number[] | null {
  const eq = enumerateNE(zeroSumOf(A));
  if (eq.length !== 1) return null;
  const e = eq[0];
  if (e.supportX.length !== A.length || e.supportY.length !== A[0].length) return null;
  if (e.x.some((v) => v <= 1e-6) || e.y.some((v) => v <= 1e-6)) return null;
  return e.x;
}

/** The unique equilibrium of a zero-sum A whatever its support, or null. */
function uniqueNEAnySupport(A: Mat): { x: number[]; supX: number; supY: number } | null {
  const eq = enumerateNE(zeroSumOf(A));
  if (eq.length !== 1) return null;
  const e = eq[0];
  return { x: e.x, supX: e.supportX.length, supY: e.supportY.length };
}

/**
 * WHICH equilibria the game set contains — the difficulty axis that size is not.
 *
 *   'full'    (default) completely mixed: every action carries positive weight.
 *   'partial'           unique, but at least one action sits OUT of the support.
 *
 * Full support is the case with a closed-form route. If every row is known to be
 * in the support, the answer is the solution of one linear system — m equations
 * saying every row earns the same, no search anywhere. Growing m only makes that
 * system bigger, which is why 4x4, 5x5 and 6x6 all came back at 100%: the task
 * never changed KIND, only size.
 *
 * Partial support removes the closed form. The model must first work out which
 * subset of actions is in the support — a 2^m search — and only then solve the
 * smaller system. Same board size, same prompt, same scoring; the one thing that
 * changes is whether a search is required.
 *
 * Note this makes the games no less well defined: uniqueness is still enforced,
 * so there is exactly one correct answer to compare against.
 */
const SUPPORT = process.env.L_SUPPORT === 'partial' ? 'partial' : 'full';

/** Generation filter: does this matrix belong in the set under SUPPORT? */
function acceptGame(A: Mat): number[] | null {
  if (SUPPORT !== 'partial') return uniqueInteriorNE(A);
  const u = uniqueNEAnySupport(A);
  if (!u) return null;
  if (u.supX === A.length && u.supY === A[0].length) return null;  // that is the full case
  // A support of one is a saddle point: read the value straight off the matrix,
  // no mixing at all. Requiring two or more keeps this a genuine mixing problem
  // whose support has to be FOUND, rather than a lookup.
  if (u.supX < 2 || u.supY < 2) return null;
  return u.x;
}

interface Game { name: string; A: Mat; xStar: number[]; value: number }

/**
 * Output-token budget. Thinking tokens count against this on every provider, so
 * the cap has to scale with problem size, not stay fixed.
 *
 * At 4x4 with reasoning='high', gpt-5.4-nano spends ~9,400 tokens thinking —
 * more than the old hardcoded 8192 — so it hit the cap mid-thought and returned
 * NOTHING. That produced cells with 0/26 and 1/26 parsed, which would have read
 * as a capability cliff at 4x4. It was our budget, not the model.
 *
 * Raising it does not affect the 'none' rows (they use ~20-300 output tokens),
 * so cells run at different caps remain comparable as long as the cap never
 * binds.
 */
const MAX_TOKENS = Number(process.env.L_MAXTOK || 8192);

const SIZE = Number(process.env.L_SIZE || 3);
const COUNT = Number(process.env.L_GAMES || 13);

/**
 * Same seeded-PRNG style and payoff range as _gen/probe.ts, so the games differ
 * from the 2x2 set only in dimension.
 */
function buildSet(): Game[] {
  const games: Game[] = [];
  let seed = Number(process.env.GEN_SEED || 20260811);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ri = () => { let v = 0; while (v === 0) v = Math.round(-9 + rnd() * 18); return v; };

  for (let guard = 0; guard < 500000 && games.length < COUNT; guard++) {
    const A: Mat = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, ri));
    const x = acceptGame(A);
    if (!x) continue;                                   // unique, and matching SUPPORT
    games.push({ name: `mn-${games.length + 1}`, A, xStar: x, value: guaranteed(A, x) });
  }
  return games;
}

// ── The ladder (same five rungs as _gen/ladder.ts, generalised) ──────────────

type Level = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

/**
 * Route names for the L2+ scenario, one per row and per column.
 *
 * APPEND ONLY. `ROADS.slice(0, m)` means the first five entries are what every
 * 3x3/4x4/5x5 run already used; reordering or renaming them would silently
 * change prompts that have already been measured, and cross-size comparison
 * would be comparing two instruments.
 *
 * The list must be at least as long as the largest SIZE. It held exactly five
 * names, so at 6x6 `roads[5]` was undefined and the scenario rendered "Send
 * undefined while the checkpoint is undefined" -- a broken prompt that would
 * have read as the model cracking at 6x6. Same class of bug as the hardcoded
 * three-row JSON example noted below.
 */
const ROADS = ['North', 'Central', 'South', 'East', 'West', 'Ridge', 'Hollow', 'Marsh'];

/**
 * Fee + settlement summing to the payoff, so L3 requires real arithmetic.
 * Offsets are >= 11 and vary per cell: an offset that lands on 0 would silently
 * collapse the rung back into L2, which is a bug this harness already hit once
 * at 2x2 and is why renderings are inspected before any call is spent.
 */
const split = (n: number, cell: number): [number, number] => {
  const k = 11 + cell;
  return [n + k, -k];
};

function render(level: Level, A: Mat): string {
  const m = A.length, n = A[0].length;
  const cells: [number, number, number][] = [];
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) cells.push([i, j, A[i][j]]);

  if (level === 'L0') {
    return [
      'Payoffs (your payoff, opponent payoff). This is a strictly competitive game.',
      ...cells.map(([i, j, v]) => `  You Row ${i + 1}, opponent Col ${j + 1} -> (${v}, ${-v})`),
    ].join('\n');
  }

  if (level === 'L1') {
    return [
      'You and one opponent each choose secretly, at the same time. Whatever you gain, the opponent loses.',
      ...cells.map(([i, j, v]) => `If you choose Row ${i + 1} and the opponent chooses Column ${j + 1}, you gain ${v}.`),
    ].join('\n');
  }

  const roads = ROADS.slice(0, m), posts = ROADS.slice(0, n);
  const intro =
    `You run a courier service moving cargo through a valley. Each night you send the shipment along `
    + `one of ${m} roads (${roads.map((r, i) => `${r} = Row ${i + 1}`).join(', ')}). A rival inspector, at the `
    + `same time and without seeing your choice, sets up a checkpoint on one of ${n} roads `
    + `(${posts.map((r, j) => `${r} = Column ${j + 1}`).join(', ')}). Whatever you gain on a given night, the `
    + `inspector loses exactly the same amount.`;

  if (level === 'L2') {
    return [intro,
      ...cells.map(([i, j, v]) => `Send ${roads[i]} while the checkpoint is ${posts[j]}: your night nets ${v}.`),
    ].join('\n');
  }

  const l3 = [intro,
    'Each night your result is the cargo fee you collect plus the settlement you exchange with the inspector (a negative settlement means you pay).',
    ...cells.map(([i, j, v], k) => {
      const [fee, set] = split(v, k);
      return `Send ${roads[i]}, checkpoint ${posts[j]}: you collect a fee of ${fee} and the settlement is ${set}.`;
    }),
  ].join('\n');

  if (level === 'L3') return l3;

  return [l3, '',
    'Other details from the logbook: the North road is 14 kilometres longer, the depot opens at 6 a.m., '
    + 'last quarter you ran 231 shipments, two of the three vans were repainted in March, and the valley '
    + 'sees roughly 9 days of fog per month. None of this changes what a night is worth.',
  ].join('\n');
}

// ── Model interface ──────────────────────────────────────────────────────────

/**
 * The JSON example must show EXACTLY m rows and m probabilities.
 *
 * An earlier version hardcoded up to three, so at 4x4 it asked for four options
 * while showing a three-row example. That would have produced malformed answers
 * at 4x4 and 5x5 and read as a capability cliff -- the precise failure this
 * ladder exists to rule out. Caught by printing the prompt before running.
 */

/**
 * REASONING FRAMING — the experiment this file was extended for.
 *
 * The abstraction ladder (L0..L4) varies how the GAME IS DESCRIBED. This varies
 * how the MODEL IS TOLD TO THINK, holding the game fixed. The two are
 * orthogonal, so runs here hold the rendering at L0 (the raw matrix): with
 * formalization made trivial, any difference between arms is attributable to
 * solving rather than to reading.
 *
 * The question is the paper's own thesis, turned into something measurable.
 * The paper claims a geometric re-description of mixed equilibria -- expected
 * payoff as a surface, indifference as the surface going level -- conveys
 * intuition that the algebra does not. That is a claim about human learners. It
 * is also, now, a claim that can be tested on a model: give it the same
 * mathematics in two descriptions and see whether accuracy moves.
 *
 * THE TWO ARMS DESCRIBE IDENTICAL MATHEMATICS. That is the point, not a flaw.
 * "Solve the indifference equations" and "find where the surface stops tilting"
 * pick out the same mixture. If accuracy differs, the re-description carries
 * information; if it does not, the geometry is pedagogy rather than content.
 * Both outcomes are worth reporting.
 *
 * SYMMETRY IS THE LOAD-BEARING CONTROL. Both arms are imperative ("Method:"),
 * matched in structure -- name the object, state the equilibrium condition,
 * state the action, state the check -- and close in length. An arm that was
 * merely more forceful or more actionable would win for that reason and the
 * result would be about instruction strength, not geometry. Related: the
 * framing pilot found PERMISSIVE guidance gets 0% uptake, so neither arm is
 * phrased as an invitation.
 *
 * 'none' is the baseline and is not optional: without it, a difference between
 * the two framings cannot be read as either one HELPING.
 */
type Frame = 'none' | 'algebraic' | 'geometric';

const FRAME_TEXT: Record<Frame, string> = {
  none: '',
  algebraic:
    `Method: your expected payoff from each of your options is a linear function of the opponent's mixing probabilities. `
    + `At equilibrium your mixture must leave the opponent indifferent among every column they use with positive probability, `
    + `so the opponent's expected payoff is equal across all of those columns. `
    + `Set up that system of equations and solve it for your probabilities, then check they are non-negative and sum to one.`,
  geometric:
    `Method: think of each player's expected payoff as a surface lying over the space of mixtures. `
    + `The opponent's surface tilts one way or the other as your mixture changes, and it goes exactly level `
    + `when they are indifferent among every column they use with positive probability. `
    + `Find the mixture where the opponent's surface stops tilting, then check the probabilities are non-negative and sum to one.`,
};

const FRAMES = (process.env.L_FRAMES || 'none').split(',') as Frame[];

const sysFor = (m: number, n: number, frame: Frame = 'none') => {
  const rows = Array.from({ length: m }, (_, i) => `[<row ${i + 1}>]`).join(',');
  const probs = Array.from({ length: m }, (_, i) => `"<p${i + 1}>"`).join(',');
  return `You are analysing a two-player, simultaneous, strictly competitive (zero-sum) game.
You have ${m} options (Row 1..Row ${m}); the opponent has ${n} options (Column 1..Column ${n}).
Work out YOUR payoff for every combination, then report your equilibrium mixed strategy: the probability you place on each of your ${m} options, in order, summing to 1.
Respond with JSON only, exactly:
{"payoffs":[${rows}],"strategy":[${probs}]}
where each row is ${n} numbers (YOUR payoff for that cell), and each probability is a decimal such as "0.4118" or an exact fraction such as "7/17".`
    + (FRAME_TEXT[frame] ? `\n${FRAME_TEXT[frame]}` : '');
};

const schemaFor = (m: number, n: number): Record<string, unknown> => ({
  type: 'object',
  required: ['payoffs', 'strategy'],
  properties: {
    payoffs: {
      type: 'array', minItems: m, maxItems: m,
      items: { type: 'array', minItems: n, maxItems: n, items: { type: 'number' } },
      description: `Your payoff matrix, ${m} rows of ${n} numbers.`,
    },
    strategy: {
      type: 'array', minItems: m, maxItems: m,
      items: { type: 'string' },
      description: 'Your probability on each row, as decimals or exact fractions, summing to 1.',
    },
  },
});

function parseProb(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const f = /^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  const v = f ? Number(f[1]) / Number(f[2]) : Number(s);
  return Number.isFinite(v) ? v : null;
}

interface Row {
  parsed: boolean; formalOk: boolean; solutionOk: boolean;
  consistentOk: boolean | null; exploit: number | null;
  /** The normalised answer, kept so a detail run can show WHERE a miss landed. */
  x?: number[];
  /** Per-component deviation from x*, for diagnosing tolerance-vs-capability. */
  dev?: number[];
  /**
   * Tokens the model actually spent THINKING, and whether the budget bound.
   *
   * providers.ts tries each request shape with `reasoning_effort` and then, as a
   * fallback, the same shape WITHOUT it — so a deployment that rejects the
   * parameter succeeds silently as a non-thinking call while the log still says
   * effort=high. That is the confound behind this study's second retracted
   * ranking, and providers.ts:98 says outright to "check usage.reasoningTokens
   * > 0 to confirm thinking actually happened rather than assuming it did."
   *
   * This harness did not record it, so for every cell already published the
   * check was UNVERIFIED rather than verified — confirming it afterwards needed
   * a separate probe. Recording it per row makes an effort=high cell that never
   * thought visible in its own log.
   *
   * `capBound` is the neighbouring failure: thinking that runs into
   * MAX_TOKENS returns nothing on this stack, so a cell can read as a
   * capability cliff when it was the budget. Cheap to record, and it is the
   * defect that already faked a 4x4 cliff once.
   */
  reasoningTokens?: number;
  outputTokens?: number;
  capBound?: boolean;
}

async function askOne(model: string, level: Level, g: Game, reasoning: ReasoningEffort | undefined, frame: Frame = 'none'): Promise<Row> {
  const miss: Row = { parsed: false, formalOk: false, solutionOk: false, consistentOk: null, exploit: null };
  const m = g.A.length, n = g.A[0].length;

  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await callProvider({
      model, systemPrompt: sysFor(m, n, frame), userPrompt: render(level, g.A),
      schema: schemaFor(m, n), maxOutputTokens: MAX_TOKENS, reasoning,
    });
    if (r.failure === 'rate-limited') { await new Promise((z) => setTimeout(z, 1500 * 2 ** attempt)); continue; }
    // Attached to EVERY return below, including the failures. A row that did not
    // parse is exactly the row where you need to know whether the budget bound.
    const use = {
      reasoningTokens: r.usage?.reasoningTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      capBound: /length|max_tokens/i.test(r.stopReason ?? '')
        || (r.usage?.outputTokens ?? 0) >= MAX_TOKENS,
    };
    if (!r.text) return { ...miss, ...use };
    try {
      const o = JSON.parse(r.text);
      const M: Mat = (o.payoffs ?? []).map((row: unknown[]) => row.map(Number));
      const xs = (o.strategy ?? []).map(parseProb);
      const shapeOk = M.length === m && M.every((row) => row.length === n && row.every(Number.isFinite));
      if (!shapeOk || xs.length !== m || xs.some((v: number | null) => v === null)) return { ...miss, ...use };

      const x = xs as number[];
      const total = x.reduce((a, b) => a + b, 0);
      // Renormalise only for rounding drift; a genuinely non-normalised answer
      // is a wrong answer, not a formatting quirk.
      if (!(total > 0.98 && total < 1.02)) return { ...miss, ...use, parsed: true };
      const xn = x.map((v) => v / total);
      if (xn.some((v) => v < -1e-6)) return { ...miss, ...use, parsed: true };

      const formalOk = M.every((row, i) => row.every((v, j) => v === g.A[i][j]));
      const solutionOk = xn.every((v, i) => Math.abs(v - g.xStar[i]) <= 0.02);
      const exploit = g.value - guaranteed(g.A, xn);

      // Consistency: is the answer the equilibrium of the matrix IT extracted?
      // Undefined when its own matrix has no unique interior equilibrium —
      // there is no coordinate for the answer to agree with.
      // Under 'partial' the model's own matrix is expected to have a partially
      // supported equilibrium, so requiring an INTERIOR one would report null for
      // nearly every game. Full mode keeps the original test untouched, so its
      // consistency column stays comparable with every run already banked.
      const own = SUPPORT === 'partial' ? uniqueNEAnySupport(M)?.x ?? null : uniqueInteriorNE(M);
      const consistentOk = own ? xn.every((v, i) => Math.abs(v - own[i]) <= 0.02) : null;

      const dev = xn.map((v, i) => v - g.xStar[i]);
      return { parsed: true, formalOk, solutionOk, consistentOk, exploit, x: xn, dev, ...use };
    } catch { return { ...miss, ...use }; }
  }
  return miss;
}

// ── Runner ───────────────────────────────────────────────────────────────────

const MODELS = (process.env.L_MODELS || 'gpt-5.4-nano,gpt-5.6-sol-1').split(',');
const LEVELS = (process.env.L_LEVELS || 'L0,L1,L2,L3,L4').split(',') as Level[];
const EFFORTS = (process.env.L_EFFORTS || 'none,high').split(',') as ReasoningEffort[];
const PASSES = Number(process.env.L_N || 2);

(async () => {
  const games = buildSet();
  if (games.length < COUNT) { console.error(`only found ${games.length}/${COUNT} qualifying games`); }

  if (process.env.L_PRINT) {
    console.log(`GAMES (${SIZE}x${SIZE}, zero-sum, unique ${SUPPORT === 'partial' ? 'PARTIALLY-supported' : 'completely-mixed'} equilibrium):`);
    for (const g of games) {
      console.log(`  ${g.name.padEnd(6)} A=${JSON.stringify(g.A)}`);
      console.log(`         x*=[${g.xStar.map((v) => v.toFixed(4)).join(', ')}]  value=${g.value.toFixed(3)}  range=${rangeOf(g.A)}`);
    }
    const s = games[0];
    console.log('\nSAMPLE RENDERINGS (first game):');
    for (const L of LEVELS) console.log(`\n--- ${L} ---\n${render(L, s.A)}`);
    for (const fr of FRAMES) console.log(`\n--- SYSTEM (frame=${fr}) ---\n${sysFor(s.A.length, s.A[0].length, fr)}`);
    return;
  }

  console.log(`ABSTRACTION LADDER ${SIZE}x${SIZE}   games=${games.length}  passes=${PASSES}  levels=${LEVELS.join(',')}  efforts=${EFFORTS.join(',')}  support=${SUPPORT}  maxtok=${MAX_TOKENS}\n`);
  console.log(`${'model'.padEnd(15)}${'effort'.padEnd(8)}${'lvl'.padEnd(5)}${'frame'.padEnd(11)}${'formalize'.padStart(10)}${'solve'.padStart(8)}${'consistent'.padStart(12)}${'exploit'.padStart(10)}${'parsed'.padStart(8)}${'think'.padStart(9)}`);

  /**
   * Per-(frame, game) mean exploitability, for the PAIRED comparison below.
   *
   * Comparing raw means across arms wastes the design. Every arm is shown the
   * SAME games, and exploitability varies far more between games (payoff ranges
   * differ) than between framings, so that between-game variance swamps the
   * effect being measured. Pairing by game removes it entirely.
   */
  const paired: Record<string, Record<string, number[]>> = {};

  for (const model of MODELS) {
    for (const eff of EFFORTS) {
      for (const level of LEVELS) {
       for (const frame of FRAMES) {
        let f = 0, s = 0, c = 0, cN = 0, ok = 0, n = 0;
        const ex: number[] = [];
        // Thinking actually spent, and whether the budget bound. Aggregated so a
        // cell that never reasoned, or one that ran into the cap, is visible in
        // its own summary line instead of needing a separate probe afterwards.
        const think: number[] = [];
        let capHits = 0;
        for (const g of games) {
          for (let p = 0; p < PASSES; p++) {
            const r = await askOne(model, level, g, eff, frame);
            n++;
            if (process.env.L_DETAIL) {
              if (!r.parsed) {
                console.log(
                  `    ${g.name.padEnd(6)} p${p + 1}  UNPARSEABLE` +
                  `  think=${r.reasoningTokens ?? '?'}  out=${r.outputTokens ?? '?'}` +
                  `${r.capBound ? '  CAP-BOUND (budget, not capability)' : '  cap not bound'}`,
                );
              } else {
                const worst = Math.max(...(r.dev ?? [0]).map(Math.abs));
                console.log(
                  `    ${g.name.padEnd(6)} p${p + 1}  ${r.solutionOk ? 'ok  ' : 'MISS'}` +
                  `  x=[${(r.x ?? []).map((v) => v.toFixed(4)).join(', ')}]` +
                  `  x*=[${g.xStar.map((v) => v.toFixed(4)).join(', ')}]` +
                  `  maxDev=${worst.toFixed(4)}  exploit=${(r.exploit ?? 0).toFixed(3)}` +
                  `  formalize=${r.formalOk ? 'ok' : 'WRONG'}` +
                  `  think=${r.reasoningTokens ?? '?'}${r.capBound ? ' CAP-BOUND' : ''}`,
                );
              }
            }
            // Recorded for EVERY call, including unparsed ones: an unparsed row
            // is exactly where the cap-bound question matters most.
            if (r.reasoningTokens !== undefined) think.push(r.reasoningTokens);
            if (r.capBound) capHits++;
            if (!r.parsed) continue;
            ok++;
            if (r.formalOk) f++;
            if (r.solutionOk) s++;
            if (r.consistentOk !== null) { cN++; if (r.consistentOk) c++; }
            if (r.exploit !== null) {
              ex.push(r.exploit);
              // Normalised by payoff range: an exploitability of 2 means
              // something different in a game spanning 4 than in one spanning 20,
              // and un-normalised means are dominated by the widest games.
              ((paired[frame] ??= {})[g.name] ??= []).push(r.exploit / rangeOf(g.A));
            }
          }
        }
        const pct = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(0)}%` : 'n/a');
        const meanEx = ex.length ? (ex.reduce((a, b) => a + b, 0) / ex.length).toFixed(2) : 'n/a';
        const meanThinkN = think.length ? think.reduce((a, b) => a + b, 0) / think.length : 0;
        const meanThink = think.length ? String(Math.round(meanThinkN)) : 'n/a';
        const thoughtNothing = eff !== 'none' && think.length > 0 && meanThinkN === 0;
        console.log(
          `${model.padEnd(15)}${String(eff).padEnd(8)}${level.padEnd(5)}${frame.padEnd(11)}` +
          `${pct(f, ok).padStart(10)}${pct(s, ok).padStart(8)}${pct(c, cN).padStart(12)}${meanEx.padStart(10)}${`${ok}/${n}`.padStart(8)}` +
          // A cell claiming effort=high with mean think 0 did NOT think: providers.ts
          // falls back to the same request shape without reasoning_effort when a
          // deployment rejects it, and the run label would still say high.
          `${meanThink.padStart(9)}${capHits ? `  CAP-BOUND x${capHits}` : ''}` +
          `${thoughtNothing ? '  <-- effort requested but NO thinking recorded' : ''}`,
        );
       }
      }
    }
  }

  // ── paired comparison against the no-method baseline ──────────────────────
  if (FRAMES.includes('none') && FRAMES.length > 1) {
    const meanOf = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const base = paired['none'] ?? {};
    console.log(`\n${'='.repeat(72)}\nPAIRED vs baseline — normalised exploitability (lower = closer to equilibrium)`);
    console.log(`${'frame'.padEnd(12)}${'games'.padStart(6)}${'better'.padStart(8)}${'worse'.padStart(7)}${'mean Δ'.padStart(10)}${'median Δ'.padStart(11)}`);
    for (const frame of FRAMES) {
      if (frame === 'none') continue;
      const arm = paired[frame] ?? {};
      const deltas: number[] = [];
      for (const game of Object.keys(base)) {
        if (!arm[game]) continue;
        deltas.push(meanOf(arm[game]) - meanOf(base[game]));   // negative = framing helped
      }
      if (!deltas.length) continue;
      const sorted = [...deltas].sort((a, b) => a - b);
      const med = sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      const better = deltas.filter((d) => d < 0).length;
      console.log(
        `${frame.padEnd(12)}${String(deltas.length).padStart(6)}${String(better).padStart(8)}`
        + `${String(deltas.filter((d) => d > 0).length).padStart(7)}`
        + `${meanOf(deltas).toFixed(4).padStart(10)}${med.toFixed(4).padStart(11)}`,
      );
    }
    console.log(`
  Negative Δ means the framing moved the answer CLOSER to equilibrium than no
  method at all. "better/worse" is the per-game sign count: with n games a
  split near half is consistent with no effect regardless of the mean, and a
  mean driven by one game is visible as a lopsided median.`);
  }
})();

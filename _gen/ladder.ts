/**
 * ABSTRACTION LADDER — where does the error actually happen?
 *
 * Every experiment so far hands the model the payoff matrix. Real strategic
 * reasoning requires FORMALIZING a situation first, then solving it. Those are
 * separable capabilities, and because every narrative here is generated FROM a
 * known matrix, they can be scored separately:
 *
 *   FORMALIZATION   did it recover the right payoffs from the prose?
 *   SOLUTION        is its answer right for the TRUE matrix?
 *   CONSISTENCY     is its answer right for the matrix IT extracted?
 *
 * That separates "misread the story" from "botched the algebra" from "did both
 * correctly but didn't connect them". Crossed with reasoning effort, it answers
 * a question with a practical payoff: does thinking repair comprehension, or
 * only arithmetic? If only the latter, buying reasoning tokens is the wrong
 * purchase for narrative-input tasks.
 *
 * PREDICTION, recorded before running (prior work finds named games score far
 * higher than anonymous matrices — 34%/18%/2% on random 2x2/3x3/5x5): accuracy
 * may RISE with more narrative, not fall. Semantic scaffolding appears to help.
 *
 * SIZE IS HELD AT 2x2 ON PURPOSE. Prior work shows matrix size alone drives
 * 34% -> 2%. Varying abstraction and size together would confound them, and the
 * whole point of this harness is not to do that. Size becomes factor two once
 * the ladder is calibrated.
 */
import 'dotenv/config';
import { callProvider, type ReasoningEffort } from '../src/utils/providers';
import { computeAllNE } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

type Mat = number[][];

const xStarOf = (A: Mat) => (A[1][1] - A[1][0]) / (A[0][0] - A[0][1] - A[1][0] + A[1][1]);

function agreesWithShippedSolver(A: Mat, xStar: number): boolean {
  const g: GamePayoffs = {
    a11: A[0][0], a12: A[0][1], a21: A[1][0], a22: A[1][1],
    b11: -A[0][0], b12: -A[0][1], b21: -A[1][0], b22: -A[1][1],
  };
  const ne = computeAllNE(g);
  const mixed = ne.find((n) => n.type === 'mixed');
  return !!mixed && ne.every((n) => n.type === 'mixed') && Math.abs(mixed.x - xStar) < 0.0025;
}

/**
 * Same generator and seed as _gen/probe.ts, so the games are identical to every
 * earlier sweep. Verified by --print rather than assumed: a silently divergent
 * golden set would make this ladder incomparable to the rest of the study.
 */
function buildSet(): { name: string; A: Mat; xStar: number }[] {
  const games: { name: string; A: Mat; xStar: number }[] = [];
  for (const k of [2, 5, 10]) {
    const A: Mat = [[k, 0], [0, 1]];
    games.push({ name: `template-${k}to1`, A, xStar: xStarOf(A) });
  }
  let seed = Number(process.env.GEN_SEED || 20260810);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ri = () => { let v = 0; while (v === 0) v = Math.round(-9 + rnd() * 18); return v; };
  let round = 0, ugly = 0;
  const isRound = (x: number) => Math.abs(x * 20 - Math.round(x * 20)) < 1e-6;
  for (let guard = 0; guard < 200000 && (round < 5 || ugly < 5); guard++) {
    const A: Mat = [[ri(), ri()], [ri(), ri()]];
    if (Math.abs(A[0][0] - A[0][1] - A[1][0] + A[1][1]) < 1e-9) continue;
    const x = xStarOf(A);
    if (!(x > 0.05 && x < 0.95)) continue;
    if (!agreesWithShippedSolver(A, x)) continue;
    const r = isRound(x);
    if (r && round < 5) { games.push({ name: `gen-round-${++round}`, A, xStar: x }); }
    else if (!r && ugly < 5) { games.push({ name: `gen-ugly-${++ugly}`, A, xStar: x }); }
  }
  return games;
}

// ── The ladder ───────────────────────────────────────────────────────────────
//
// Every rung encodes the SAME matrix exactly. The scenario skeleton is held
// constant within a rung so that abstraction is the only thing that varies;
// narrative *domain* is a separate factor and is not tested here.
//
// A fixed skeleton is safe in a way the original golden set was not: there the
// matrix SHAPE was fixed, so the answer had a closed form and could be recalled.
// Here the matrices are the already-randomised set, so knowing the skeleton
// tells you nothing about the answer.

type Level = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

/**
 * Split n into a positive fee and a negative settlement that sum to it, so L3
 * genuinely requires arithmetic.
 *
 * An earlier version halved n, which produced a settlement of 0 whenever n was
 * even-ish — collapsing those cells silently back to L2 and making the rung
 * measure nothing. Offsets are >= 11 so the fee stays positive across the
 * payoff range, and vary per cell so the correction is not a constant the model
 * can apply without reading.
 */
const split = (n: number, cell: number): [number, number] => {
  const k = 11 + cell;              // 11..14
  return [n + k, -k];               // fee (positive) + settlement (negative) = n
};

function render(level: Level, A: Mat): string {
  const [a, b, c, d] = [A[0][0], A[0][1], A[1][0], A[1][1]];

  if (level === 'L0') {
    return [
      'Payoffs (your payoff, opponent payoff). This is a strictly competitive game.',
      `  You Row 1, opponent Col 1 -> (${a}, ${-a})`,
      `  You Row 1, opponent Col 2 -> (${b}, ${-b})`,
      `  You Row 2, opponent Col 1 -> (${c}, ${-c})`,
      `  You Row 2, opponent Col 2 -> (${d}, ${-d})`,
    ].join('\n');
  }

  if (level === 'L1') {
    return [
      'You and one opponent each choose secretly, at the same time. Whatever you gain, the opponent loses.',
      `If you choose Row 1 and the opponent chooses Column 1, you gain ${a}.`,
      `If you choose Row 1 and the opponent chooses Column 2, you gain ${b}.`,
      `If you choose Row 2 and the opponent chooses Column 1, you gain ${c}.`,
      `If you choose Row 2 and the opponent chooses Column 2, you gain ${d}.`,
    ].join('\n');
  }

  const intro =
    'You run a courier service moving cargo through a valley. Each night you send the shipment '
    + 'along either the North road (Row 1) or the South road (Row 2). A rival inspector, at the same '
    + 'time and without seeing your choice, sets up a checkpoint on either North (Column 1) or South '
    + '(Column 2). Whatever you gain on a given night, the inspector loses exactly the same amount.';

  if (level === 'L2') {
    return [intro,
      `Send North while the checkpoint is North: your night nets ${a}.`,
      `Send North while the checkpoint is South: your night nets ${b}.`,
      `Send South while the checkpoint is North: your night nets ${c}.`,
      `Send South while the checkpoint is South: your night nets ${d}.`,
    ].join('\n');
  }

  // L3 — payoffs must be COMPUTED from two stated components.
  const [a1, a2] = split(a, 0), [b1, b2] = split(b, 1), [c1, c2] = split(c, 2), [d1, d2] = split(d, 3);
  const l3 = [intro,
    'Each night your result is the cargo fee you collect plus the settlement you exchange with the inspector (a negative settlement means you pay).',
    `Send North, checkpoint North: you collect a fee of ${a1} and the settlement is ${a2}.`,
    `Send North, checkpoint South: you collect a fee of ${b1} and the settlement is ${b2}.`,
    `Send South, checkpoint North: you collect a fee of ${c1} and the settlement is ${c2}.`,
    `Send South, checkpoint South: you collect a fee of ${d1} and the settlement is ${d2}.`,
  ].join('\n');

  if (level === 'L3') return l3;

  // L4 — L3 plus irrelevant detail, including numbers that must NOT be used.
  return [l3,
    '',
    'Other details from the logbook: the North road is 14 kilometres longer, the depot opens at 6 a.m., '
    + 'last quarter you ran 231 shipments, two of the three vans were repainted in March, and the valley '
    + 'sees roughly 9 days of fog per month. None of this changes what a night is worth.',
  ].join('\n');
}

// ── Model interface ──────────────────────────────────────────────────────────

const SYS = `You are analysing a two-player, simultaneous, strictly competitive (zero-sum) game.
Work out the payoff each of your two options gives against each of the opponent's two options.
Then report the equilibrium probability you place on your FIRST option (Row 1 / North).
Respond with JSON only, exactly:
{"payoffs":{"r1c1":<n>,"r1c2":<n>,"r2c1":<n>,"r2c2":<n>},"probabilityRow1":"<value>"}
where each <n> is YOUR payoff for that cell as a number, and <value> is a decimal such as "0.4118" or an exact fraction such as "7/17".`;

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['payoffs', 'probabilityRow1'],
  properties: {
    payoffs: {
      type: 'object',
      required: ['r1c1', 'r1c2', 'r2c1', 'r2c2'],
      properties: {
        r1c1: { type: 'number' }, r1c2: { type: 'number' },
        r2c1: { type: 'number' }, r2c2: { type: 'number' },
      },
    },
    probabilityRow1: { type: 'string', description: 'Decimal such as "0.4118" or exact fraction such as "7/17".' },
  },
};

function parseProb(raw: unknown): number | null {
  if (typeof raw === 'number') return raw >= 0 && raw <= 1 ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const f = /^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  const v = f ? Number(f[1]) / Number(f[2]) : Number(s);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

interface Row { formalOk: boolean; solutionOk: boolean; consistentOk: boolean | null; parsed: boolean }

async function askOne(model: string, level: Level, A: Mat, reasoning: ReasoningEffort | undefined): Promise<Row> {
  const miss: Row = { formalOk: false, solutionOk: false, consistentOk: null, parsed: false };
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await callProvider({
      model, systemPrompt: SYS, userPrompt: render(level, A),
      schema: SCHEMA, maxOutputTokens: 8192, reasoning,
    });
    if (r.failure === 'rate-limited') { await new Promise((z) => setTimeout(z, 1500 * 2 ** attempt)); continue; }
    if (!r.text) return miss;
    try {
      const o = JSON.parse(r.text);
      const p = parseProb(o.probabilityRow1);
      const pf = o.payoffs ?? {};
      const M: Mat = [[Number(pf.r1c1), Number(pf.r1c2)], [Number(pf.r2c1), Number(pf.r2c2)]];
      const finite = M.flat().every((v) => Number.isFinite(v));
      if (p === null || !finite) return { ...miss, parsed: false };

      const formalOk = M[0][0] === A[0][0] && M[0][1] === A[0][1] && M[1][0] === A[1][0] && M[1][1] === A[1][1];
      const solutionOk = Math.abs(p - xStarOf(A)) <= 0.02;
      // Consistency is undefined when the model's own matrix has no interior
      // mixed equilibrium — there is no coordinate for its answer to agree with.
      const denom = M[0][0] - M[0][1] - M[1][0] + M[1][1];
      let consistentOk: boolean | null = null;
      if (Math.abs(denom) > 1e-9) {
        const own = xStarOf(M);
        if (own > 0 && own < 1) consistentOk = Math.abs(p - own) <= 0.02;
      }
      return { formalOk, solutionOk, consistentOk, parsed: true };
    } catch { return miss; }
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
  if (process.env.L_PRINT) {
    console.log('GAMES (must match _gen/probe.ts exactly):');
    for (const g of games) console.log(`  ${g.name.padEnd(16)} A=[[${g.A[0]}],[${g.A[1]}]]  x*=${g.xStar.toFixed(4)}`);
    console.log('\nSAMPLE RENDERINGS (gen-ugly-2):');
    const s = games.find((g) => g.name === 'gen-ugly-2')!;
    for (const L of LEVELS) console.log(`\n--- ${L} ---\n${render(L, s.A)}`);
    return;
  }

  console.log(`ABSTRACTION LADDER   games=${games.length}  passes=${PASSES}  levels=${LEVELS.join(',')}  efforts=${EFFORTS.join(',')}\n`);
  console.log(`${'model'.padEnd(15)}${'effort'.padEnd(8)}${'lvl'.padEnd(5)}${'formalize'.padStart(10)}${'solve'.padStart(8)}${'consistent'.padStart(12)}${'parsed'.padStart(8)}`);

  for (const model of MODELS) {
    for (const eff of EFFORTS) {
      for (const level of LEVELS) {
        let f = 0, s = 0, c = 0, cN = 0, ok = 0, n = 0;
        for (const g of games) {
          for (let p = 0; p < PASSES; p++) {
            const r = await askOne(model, level, g.A, eff);
            n++;
            if (!r.parsed) continue;
            ok++;
            if (r.formalOk) f++;
            if (r.solutionOk) s++;
            if (r.consistentOk !== null) { cN++; if (r.consistentOk) c++; }
          }
        }
        const pct = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(0)}%` : 'n/a');
        console.log(
          `${model.padEnd(15)}${String(eff).padEnd(8)}${level.padEnd(5)}` +
          `${pct(f, ok).padStart(10)}${pct(s, ok).padStart(8)}${pct(c, cN).padStart(12)}${`${ok}/${n}`.padStart(8)}`,
        );
      }
    }
  }
})();

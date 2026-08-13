import 'dotenv/config';
import { callProvider, type ReasoningEffort } from '../src/utils/providers';
// EXACT prompt the benchmark uses, on the exact game that disagreed.
const A = [[7,-3],[-6,1]];
const SYS = `You are playing a two-player simultaneous game as the ROW player.
Choose the strategy that is optimal for you.
Report the probability you place on Row 1 (a number from 0 to 1).`;
const prompt = [
  'Payoffs (your payoff, opponent payoff). This is a strictly competitive game.',
  `  You Row 1, opponent Col 1 -> (${A[0][0]}, ${-A[0][0]})`,
  `  You Row 1, opponent Col 2 -> (${A[0][1]}, ${-A[0][1]})`,
  `  You Row 2, opponent Col 1 -> (${A[1][0]}, ${-A[1][0]})`,
  `  You Row 2, opponent Col 2 -> (${A[1][1]}, ${-A[1][1]})`,
].join('\n');
const SCHEMA = { type:'object', required:['probabilityRow1'],
  properties:{ probabilityRow1:{ type:'number', description:'Probability of Row 1, 0 to 1.' } } };
const TERSE = 'A zero-sum game has row payoffs [[7,-3],[-6,1]]. Give the equilibrium probability on Row 1 as "x".';
const TSCHEMA = { type:'object', required:['x'], properties:{ x:{type:'number'} } };

(async () => {
  console.log('true x* = 0.4118\n');
  for (const mode of ['none','high'] as ReasoningEffort[]) {
    for (const [label, sys, up, sc] of [
      ['BENCHMARK prompt', SYS, prompt, SCHEMA],
      ['TERSE prompt    ', 'Answer with JSON only.', TERSE, TSCHEMA],
    ] as const) {
      const r = await callProvider({ model:'gpt-5.6-sol-1', systemPrompt:sys, userPrompt:up,
        schema: sc as Record<string,unknown>, maxOutputTokens: 8192, reasoning: mode });
      console.log(`${label}  effort=${mode.padEnd(5)} reasonTok=${String(r.usage?.reasoningTokens).padEnd(5)} -> ${r.text}`);
    }
  }
})();

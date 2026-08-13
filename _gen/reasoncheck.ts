import 'dotenv/config';
import { callProvider, type ReasoningEffort } from '../src/utils/providers';

const MODELS = (process.env.RC_MODELS ||
  'gpt-5.6-sol-1,gpt-5.4-nano,DeepSeek-V4-Pro,DeepSeek-V4-Flash,claude-haiku-4-5,gemini-3.5-flash-lite').split(',');

const SCHEMA = { type: 'object', required: ['x'], properties: { x: { type: 'number' } } };

(async () => {
  console.log('model                 mode      failure      outTok  reasonTok  text');
  for (const model of MODELS) {
    for (const mode of [undefined, 'high'] as (ReasoningEffort | undefined)[]) {
      const r = await callProvider({
        model,
        systemPrompt: 'Answer with JSON only.',
        userPrompt: 'A zero-sum game has row payoffs [[7,-3],[-6,1]]. Give the equilibrium probability on Row 1 as "x".',
        schema: SCHEMA,
        maxOutputTokens: 8192,
        reasoning: mode,
      });
      console.log(
        `${model.padEnd(21)} ${(mode ?? 'default').padEnd(9)} ${(r.failure ?? 'none').padEnd(12)} ` +
        `${String(r.usage?.outputTokens ?? '-').padEnd(7)} ${String(r.usage?.reasoningTokens ?? '-').padEnd(10)} ${(r.text ?? '').slice(0, 40)}`,
      );
    }
  }
})();

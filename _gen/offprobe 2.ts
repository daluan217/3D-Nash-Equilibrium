import 'dotenv/config';
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: process.env.AZURE_FOUNDRY_ENDPOINT, apiKey: process.env.AZURE_FOUNDRY_API_KEY });
const model = 'gpt-5.6-sol-1';
const msgs = [
  { role: 'system' as const, content: 'Answer with JSON only.' },
  { role: 'user' as const, content: 'A zero-sum game has row payoffs [[7,-3],[-6,1]]. Give the equilibrium probability on Row 1 as "x".' },
];
const rf = { type: 'json_schema' as const, json_schema: { name: 'r', strict: true, schema: { type: 'object', required: ['x'], properties: { x: { type: 'number' } }, additionalProperties: false } } };
async function t(label: string, extra: Record<string, unknown>) {
  try {
    const r: any = await client.chat.completions.create({ model, messages: msgs, response_format: rf, max_completion_tokens: 8192, ...extra } as any);
    const d = r.usage?.completion_tokens_details;
    console.log(`${label.padEnd(26)} reasonTok=${String(d?.reasoning_tokens ?? '-').padEnd(6)} outTok=${String(r.usage?.completion_tokens).padEnd(6)} content=${String(r.choices?.[0]?.message?.content).slice(0,32)}`);
  } catch (e: any) {
    console.log(`${label.padEnd(26)} ERROR ${String(e?.message).slice(0, 170)}`);
  }
}
(async () => {
  for (const v of ['none', 'minimal', 'low', 'medium', 'high']) await t(`reasoning_effort=${v}`, { reasoning_effort: v });
  await t('(omitted / default)', {});
})();

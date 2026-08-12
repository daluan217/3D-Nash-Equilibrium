import 'dotenv/config';
import OpenAI from 'openai';
const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT!;
const client = new OpenAI({ baseURL: endpoint, apiKey: process.env.AZURE_FOUNDRY_API_KEY });
const model = 'DeepSeek-V4-Pro';
const msgs = [
  { role: 'system' as const, content: 'Answer with JSON only.' },
  { role: 'user' as const, content: 'A zero-sum game has row payoffs [[7,-3],[-6,1]]. Give the equilibrium probability on Row 1 as "x".' },
];
const rf = {
  type: 'json_schema' as const,
  json_schema: { name: 'r', strict: true, schema: { type: 'object', required: ['x'], properties: { x: { type: 'number' } }, additionalProperties: false } },
};
async function t(label: string, extra: Record<string, unknown>) {
  try {
    const r: any = await client.chat.completions.create({ model, messages: msgs, response_format: rf, max_completion_tokens: 8192, ...extra } as any);
    const c = r.choices?.[0];
    console.log(`${label.padEnd(34)} finish=${String(c?.finish_reason).padEnd(10)} reasonTok=${r.usage?.completion_tokens_details?.reasoning_tokens ?? '-'}  content=${String(c?.message?.content).slice(0,45)}`);
    if (c?.message?.reasoning_content) console.log(`   -> has reasoning_content (${String(c.message.reasoning_content).length} chars)`);
  } catch (e: any) {
    console.log(`${label.padEnd(34)} ERROR ${String(e?.message).slice(0, 150)}`);
  }
}
(async () => {
  await t('baseline (no reasoning field)', {});
  await t('reasoning_effort=low', { reasoning_effort: 'low' });
  await t('reasoning_effort=medium', { reasoning_effort: 'medium' });
  await t('reasoning_effort=high', { reasoning_effort: 'high' });
  await t('chat_template_kwargs thinking', { chat_template_kwargs: { thinking: true } });
})();

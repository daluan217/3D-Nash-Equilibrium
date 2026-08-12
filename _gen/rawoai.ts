import 'dotenv/config';
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: process.env.AZURE_FOUNDRY_ENDPOINT, apiKey: process.env.AZURE_FOUNDRY_API_KEY });
const model = process.argv[2];
const msgs = [{ role:'system' as const, content:'Answer with JSON only.' }, { role:'user' as const, content:'What is 2+2? field "n".' }];
const schema = { type:'object', required:['n'], properties:{ n:{type:'number'} }, additionalProperties:false };
(async () => {
  for (const [label, body] of [
    ['json_schema strict', { response_format:{ type:'json_schema', json_schema:{ name:'r', strict:true, schema } } }],
    ['json_schema loose ', { response_format:{ type:'json_schema', json_schema:{ name:'r', strict:false, schema } } }],
    ['json_object       ', { response_format:{ type:'json_object' } }],
    ['no response_format', {}],
  ] as const) {
    try {
      const r: any = await client.chat.completions.create({ model, messages: msgs, max_completion_tokens: 2048, ...(body as any) } as any);
      console.log(`${label}  OK -> ${String(r.choices?.[0]?.message?.content).slice(0,60)}`);
    } catch (e: any) {
      console.log(`${label}  ERR ${String(e?.message).slice(0,160)}`);
    }
  }
})();

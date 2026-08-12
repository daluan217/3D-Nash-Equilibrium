import 'dotenv/config';
import OpenAI from 'openai';
import { buildGroundingPayload } from '../src/utils/report';
const client = new OpenAI({ baseURL: process.env.AZURE_FOUNDRY_ENDPOINT, apiKey: process.env.AZURE_FOUNDRY_API_KEY });
// mirror what report.ts sends
const mod = await import('../src/utils/report');
const g = { a11:7,a12:-3,a21:-6,a22:1, b11:-7,b12:3,b21:6,b22:-1 };
try {
  await client.chat.completions.create({
    model: 'gpt-5.4-nano',
    messages: [{ role: 'user', content: buildGroundingPayload(g) }],
    response_format: { type: 'json_schema', json_schema: { name: 'r', strict: true, schema: {
      type:'object', additionalProperties:false,
      required:['claimedEquilibria','prose'],
      properties:{
        claimedEquilibria:{type:'array',items:{type:'object',additionalProperties:false,required:['type','x','y'],properties:{type:{type:'string'},x:{type:'number'},y:{type:'number'}}}},
        suggestedScenario:{type:'object',additionalProperties:false,properties:{name:{type:'string'}}},
        prose:{type:'string'},
      }}}},
    max_completion_tokens: 2048,
  } as never);
  console.log('accepted');
} catch (e: any) { console.log('ERROR:', String(e?.message).slice(0, 300)); }

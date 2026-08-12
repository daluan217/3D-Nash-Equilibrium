import 'dotenv/config';
import { callProvider, resolveProvider } from '../src/utils/providers';
const model = process.argv[2];
(async () => {
  console.log(model, '-> provider', resolveProvider(model));
  const r = await callProvider({
    model,
    systemPrompt: 'Answer with JSON only.',
    userPrompt: 'What is 2+2? Put the answer in field "n".',
    schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
    maxOutputTokens: 2048,
  });
  console.log('failure:', r.failure ?? 'none');
  console.log('text:', r.text);
  console.log('usage:', JSON.stringify(r.usage));
})();

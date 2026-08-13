import 'dotenv/config';
import AnthropicFoundry from '@anthropic-ai/foundry-sdk';
const model = process.argv[2];
const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT!;
const resource = new URL(endpoint).hostname.split('.')[0];
const client = new AnthropicFoundry({ resource, apiKey: process.env.AZURE_FOUNDRY_API_KEY });
(async () => {
  try {
    const m = await client.messages.create({
      model, max_tokens: 1024,
      messages: [{ role: 'user', content: 'Say hi.' }],
    } as any);
    console.log('OK', JSON.stringify(m).slice(0, 300));
  } catch (e: any) {
    console.log('STATUS :', e?.status);
    console.log('NAME   :', e?.name);
    console.log('MESSAGE:', e?.message);
    console.log('ERROR  :', JSON.stringify(e?.error ?? null));
  }
})();

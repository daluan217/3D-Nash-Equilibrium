import 'dotenv/config';
import { callProvider } from '../src/utils/providers';
const A = [[-2,9,4,7],[5,4,4,6],[4,6,6,-6],[-5,2,8,6]];
const cells: string[] = [];
for (let i=0;i<4;i++) for (let j=0;j<4;j++) cells.push(`  You Row ${i+1}, opponent Col ${j+1} -> (${A[i][j]}, ${-A[i][j]})`);
const user = ['Payoffs (your payoff, opponent payoff). This is a strictly competitive game.', ...cells].join('\n');
const sys = `You are analysing a two-player, simultaneous, strictly competitive (zero-sum) game.
You have 4 options (Row 1..Row 4); the opponent has 4 options (Column 1..Column 4).
Report your equilibrium mixed strategy.
Respond with JSON only, exactly:
{"payoffs":[[<row 1>],[<row 2>],[<row 3>],[<row 4>]],"strategy":["<p1>","<p2>","<p3>","<p4>"]}`;
const schema = { type:'object', required:['payoffs','strategy'], properties:{
  payoffs:{type:'array',minItems:4,maxItems:4,items:{type:'array',minItems:4,maxItems:4,items:{type:'number'}}},
  strategy:{type:'array',minItems:4,maxItems:4,items:{type:'string'}} } };
(async () => {
  for (const cap of [8192, 16384, 32768]) {
    const r = await callProvider({ model:'gpt-5.4-nano', systemPrompt:sys, userPrompt:user,
      schema: schema as Record<string,unknown>, maxOutputTokens: cap, reasoning:'high' });
    console.log(`cap=${String(cap).padEnd(6)} failure=${String(r.failure ?? 'none').padEnd(12)} stop=${String(r.stopReason).padEnd(10)} out=${r.usage?.outputTokens ?? '-'} think=${r.usage?.reasoningTokens ?? '-'}  text=${String(r.text).slice(0,60)}`);
  }
})();

import 'dotenv/config';
import { callProvider } from '../src/utils/providers';
const A=[[-3,5,-1,-6,1],[-3,3,-5,-3,2],[2,-3,-4,-1,-1],[-1,-7,2,8,-1],[2,3,2,-8,-8]];
const roads=['North','Central','South','East','West'];
const lines:string[]=[];
for(let i=0;i<5;i++)for(let j=0;j<5;j++)lines.push(`Send ${roads[i]} while the checkpoint is ${roads[j]}: your night nets ${A[i][j]}.`);
const user=[`You run a courier service moving cargo through a valley. Each night you send the shipment along one of 5 roads (${roads.map((r,i)=>`${r} = Row ${i+1}`).join(', ')}). A rival inspector, at the same time and without seeing your choice, sets up a checkpoint on one of 5 roads (${roads.map((r,j)=>`${r} = Column ${j+1}`).join(', ')}). Whatever you gain on a given night, the inspector loses exactly the same amount.`,...lines].join('\n');
const rows=Array.from({length:5},(_,i)=>`[<row ${i+1}>]`).join(',');
const probs=Array.from({length:5},(_,i)=>`"<p${i+1}>"`).join(',');
const sys=`You are analysing a two-player, simultaneous, strictly competitive (zero-sum) game.
You have 5 options (Row 1..Row 5); the opponent has 5 options (Column 1..Column 5).
Work out YOUR payoff for every combination, then report your equilibrium mixed strategy summing to 1.
Respond with JSON only, exactly:
{"payoffs":[${rows}],"strategy":[${probs}]}`;
const schema={type:'object',required:['payoffs','strategy'],properties:{
 payoffs:{type:'array',minItems:5,maxItems:5,items:{type:'array',minItems:5,maxItems:5,items:{type:'number'}}},
 strategy:{type:'array',minItems:5,maxItems:5,items:{type:'string'}}}};
(async()=>{
 for(const cap of [32768, 65536]){
  const t0=Date.now();
  const r=await callProvider({model:'gpt-5.4',systemPrompt:sys,userPrompt:user,schema:schema as Record<string,unknown>,maxOutputTokens:cap,reasoning:'high'});
  console.log(`cap=${String(cap).padEnd(6)} ${((Date.now()-t0)/1000).toFixed(0)}s failure=${String(r.failure??'none').padEnd(11)} stop=${String(r.stopReason).padEnd(8)} out=${r.usage?.outputTokens} think=${r.usage?.reasoningTokens}`);
  console.log(`   text=${String(r.text).slice(0,90)}`);
 }
})();

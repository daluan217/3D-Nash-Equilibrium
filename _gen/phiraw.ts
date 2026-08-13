import 'dotenv/config';
import { callProvider } from '../src/utils/providers';
const A=[[2,0],[0,1]];
const SYS=`You are playing a two-player simultaneous game as the ROW player.
Choose the strategy that is optimal for you.
Report the probability you place on Row 1 (a number from 0 to 1).`;
const p=['Payoffs (your payoff, opponent payoff). This is a strictly competitive game.',
 `  You Row 1, opponent Col 1 -> (${A[0][0]}, ${-A[0][0]})`,
 `  You Row 1, opponent Col 2 -> (${A[0][1]}, ${-A[0][1]})`,
 `  You Row 2, opponent Col 1 -> (${A[1][0]}, ${-A[1][0]})`,
 `  You Row 2, opponent Col 2 -> (${A[1][1]}, ${-A[1][1]})`].join('\n');
const S={type:'object',required:['probabilityRow1'],properties:{probabilityRow1:{type:'number',description:'Probability of Row 1, 0 to 1.'}}};
(async()=>{
  for (const m of ['Phi-4','Phi-4-reasoning']) {
    const r=await callProvider({model:m,systemPrompt:SYS,userPrompt:p,schema:S,maxOutputTokens:8192});
    console.log(`--- ${m} --- failure=${r.failure} stop=${r.stopReason}`);
    console.log(JSON.stringify(r.text)?.slice(0,400));
  }
})();

/* Does blue's blunt axis classifier agree with RED 2's hand classification?
 * Red: ROW axis TIME/SPEED = 83% local, 64% cloud; row/col share an axis 7.6%. */
import { readFileSync } from 'node:fs';
const AXIS_FAMILIES = [
  ['TIME/SPEED',     /\b(early|late|morning|evening|night|day|dawn|dusk|rush|slow|fast|quick|immediate|delay\w*|defer\w*|advance|prompt|seasonal|off-?peak|peak|now|later|spring|summer|autumn|winter)\b/i],
  ['ACCESS/SHARING', /\b(shared?|separate|open|closed|reserve[dt]?|private|public|exclusive|joint|independent|restrict\w*|hold|release|common|pooled)\b/i],
  ['SCOPE/EXTENT',   /\b(full|partial|minor|major|complete|limited|broad|narrow|selective|bulk|small|large|extended|minimal|whole|light|heavy|deep|shallow)\b/i],
  ['PRICE/TERMS',    /\b(premium|standard|discount\w*|budget|spot|contract|fixed|variable|cost-?plus|market|flat|tiered|priority|economy)\b/i],
];
const axisOf=(a,b)=>{const t=`${a??''} ${b??''}`;for(const[n,re]of AXIS_FAMILIES)if(re.test(t))return n;return'OTHER';};
for (const [label,path] of [['LOCAL','/tmp/rt2_local.jsonl'],['CLOUD','/tmp/rt2_cloud.jsonl']]) {
  let rows; try{rows=readFileSync(path,'utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{continue;}
  const ok=rows.filter(r=>r.sc&&(r.sc.row1||r.sc.row2)&&(r.sc.col1||r.sc.col2));
  const ra=ok.map(r=>axisOf(r.sc.row1,r.sc.row2)), ca=ok.map(r=>axisOf(r.sc.col1,r.sc.col2));
  const same=ok.filter((r,i)=>ra[i]===ca[i]&&ra[i]!=='OTHER').length;
  const n=ok.length, t=ra.filter(a=>a==='TIME/SPEED').length;
  const spread=[...new Set(ra)].map(a=>`${a} ${(100*ra.filter(x=>x===a).length/n).toFixed(0)}%`).join('  ');
  console.log(`${label} n=${n}`);
  console.log(`  ROW axis TIME/SPEED : ${t}/${n} = ${(100*t/n).toFixed(1)}%   (red hand-labelled: ${label==='LOCAL'?'83%':'64%'})`);
  console.log(`  ROW spread          : ${spread}`);
  console.log(`  row/col same axis   : ${same}/${n} = ${(100*same/n).toFixed(1)}%   (red: 7.6% local / 7.5% cloud)`);
}

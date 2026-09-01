/* BLUE TRIAGE of RED 2's "specialised domains drive the off-domain stories".
 * Reproduced from red's stated method, independently coded, plus a Fisher exact
 * so the p-value is not taken on trust. */
import { readFileSync } from 'node:fs';
const SPEC = /osier|apiary|coppice|silage|millpond|thatch|weir|scouring|dredg|sluice|marsh|bog|salt pan|kiln|clamp|falconry|herbarium|planetarium|beehive|cranberry|truffle|saffron|kelp|reindeer|glacier|letterpress|lighthouse|avalanche|dune|quarry|foundry/i;
const offDomain = (r) => {
  const words = r.domain.split(/[\s-]+/).filter(w => w.length > 3).map(w => w.replace(/s$/, ''));
  const body = ((r.sc.description || '') + ' ' + [r.sc.row1,r.sc.row2,r.sc.col1,r.sc.col2].filter(Boolean).join(' ')).toLowerCase();
  return !words.some(w => body.includes(w));
};
// Fisher exact, two-sided, computed here rather than quoted.
const lg = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
const hyp = (a,b,c,d) => Math.exp(lg(a+b)+lg(c+d)+lg(a+c)+lg(b+d)-lg(a)-lg(b)-lg(c)-lg(d)-lg(a+b+c+d));
function fisher(a,b,c,d){const obs=hyp(a,b,c,d);let p=0;const n=a+b+c+d;
  for(let i=0;i<=Math.min(a+b,a+c);i++){const j=a+b-i,k=a+c-i,l=n-i-j-k;
    if(j<0||k<0||l<0)continue;const q=hyp(i,j,k,l);if(q<=obs*1.0000001)p+=q;}return p;}

for (const [label, path] of [['LOCAL','/tmp/rt2_local.jsonl'],['CLOUD','/tmp/rt2_cloud.jsonl']]) {
  let rows; try{rows=readFileSync(path,'utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{continue;}
  const ok = rows.filter(r => r.sc && r.gate && r.gate.ok);
  const spec = ok.filter(r => SPEC.test(r.domain)), every = ok.filter(r => !SPEC.test(r.domain));
  const so = spec.filter(offDomain).length, eo = every.filter(offDomain).length;
  console.log(`\n${label}  (gate-passing n=${ok.length})`);
  console.log(`  SPECIALISED off-domain : ${so}/${spec.length} = ${(100*so/Math.max(1,spec.length)).toFixed(1)}%`);
  console.log(`  EVERYDAY    off-domain : ${eo}/${every.length} = ${(100*eo/Math.max(1,every.length)).toFixed(1)}%`);
  if (spec.length && every.length) console.log(`  Fisher two-sided p     : ${fisher(so, spec.length-so, eo, every.length-eo).toExponential(2)}`);
  const exact = ok.filter(r => /^early harvest$/i.test((r.sc.row1||'').trim()) && /^late harvest$/i.test((r.sc.row2||'').trim())).length;
  const coop = ok.filter(r => /\bco-?op(erative)?\b/i.test(r.sc.description||'')).length;
  console.log(`  row pair is EXACTLY Early/Late Harvest : ${exact}/${ok.length} = ${(100*exact/Math.max(1,ok.length)).toFixed(1)}%`);
  console.log(`  description says cooperative/co-op    : ${coop}/${ok.length} = ${(100*coop/Math.max(1,ok.length)).toFixed(1)}%`);
}

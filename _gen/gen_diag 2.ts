import { enumerateNE, type MNGame } from './mnsolver';
const zs = (A: number[][]): MNGame => ({ A, B: A.map(r => r.map(v => -v)) });
for (const S of [3,4,5]) {
  let seed = 20260811;
  const rnd = () => { seed = (seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
  const ri = () => { let v=0; while(v===0) v=Math.round(-9+rnd()*18); return v; };
  let tried=0, unique=0, fullSupport=0, both=0;
  const supportSizes: Record<number, number> = {};
  const t0 = Date.now();
  while (tried < 400 && Date.now()-t0 < 60000) {
    const A = Array.from({length:S},()=>Array.from({length:S},ri));
    tried++;
    const eq = enumerateNE(zs(A));
    if (eq.length === 1) unique++;
    for (const e of eq) supportSizes[e.supportX.length] = (supportSizes[e.supportX.length]||0)+1;
    const full = eq.filter(e => e.supportX.length===S && e.supportY.length===S);
    if (full.length) fullSupport++;
    if (eq.length===1 && full.length===1) both++;
  }
  console.log(`${S}x${S}: tried=${tried} in ${((Date.now()-t0)/1000).toFixed(1)}s | unique-NE=${unique} | has-full-support=${fullSupport} | BOTH=${both}`);
  console.log(`        support-size histogram: ${JSON.stringify(supportSizes)}`);
}

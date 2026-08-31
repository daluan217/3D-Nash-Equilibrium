/* Judge a domain-conditioned local model the way production will use it:
 * the grounding payload untouched, the domain line appended to the system
 * prompt in EXACTLY the training format, a fresh rotation each request.
 * Reports the deciding numbers (yield through the real gates, diversity,
 * domain adherence, latency).
 *
 * ── WHY THREE OF THE ORIGINAL FOUR NUMBERS WERE MEASURING THE HARNESS ──
 *
 * RED 2 filed that the model's scenario NAME is the injected domain, title-
 * cased, verbatim, 92.9% of the time locally. Auditing this harness against
 * its corpus (84 local draws) confirmed it and showed the damage is wider
 * than the one metric red named:
 *
 *   - `domain adherence` searched (name + description). Since the name IS the
 *     domain, the needle was in the field the harness itself supplied. It read
 *     100.0%; excluding the name it is 84.5%. 15.5 points of pure inflation,
 *     and the true failure — a description about a different industry than the
 *     domain — was invisible.
 *   - `distinct names` and `TOP share` are bounded by the ROTATION, not by the
 *     model. The run drew 80 distinct domains over 84 rows, so title-casing the
 *     domain and nothing else scores 95.2% distinct and 2.4% top-share
 *     automatically. Both numbers sail past the <=5% target no matter how
 *     uniform the model's actual invention is.
 *
 * That last point matters beyond the arithmetic: "diversity was fixed by
 * rotating the domain" was concluded from these numbers. Rotating the domain
 * demonstrably rotated the NAME. Whether it changed the STORY is a question
 * these metrics were structurally unable to ask — and red's separate reading
 * says it did not (69.0% of local row-label pairs are Early/Late).
 *
 * So the name-based numbers are kept, clearly marked as harness-bounded, and
 * the honest measurements are reported beside them. A metric that cannot fail
 * on the defect it names is worse than no metric; keeping both makes the
 * inflation visible instead of silently swapping one number for another.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const URL = process.env.LOCAL_URL || 'http://localhost:8099/v1/chat/completions';
const N = Number(process.env.N || 60);
const rows = readFileSync(join(homedir(),'Desktop','nash-finetune-data','data','test_raw.jsonl'),'utf8')
  .split('\n').filter(Boolean).map(l=>JSON.parse(l)).slice(0,N);
const { SCENARIO_SYSTEM_PROMPT, buildGroundingPayload } = await import('../src/utils/report.ts');
const { validateScenario, scenarioIsClaimFree } = await import('../src/utils/nashValidator.ts');
const { SCENARIO_DOMAINS } = await import('../src/utils/scenarioDomains.ts');

const squash = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** The leading word of an option label — the axis the model chose to contrast on. */
const modifier = (l) => (l ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';

/**
 * Which KIND of decision an option pair represents.
 *
 * RED 2 refuted blue's first reading of the monoculture. Blue proposed that the
 * model reuses one contrast axis for BOTH players; measured, row and column
 * share an axis in only 7.6% of local draws, so 92% already differ and a fix
 * aimed there would chase 8% and leave the 69% untouched. The real shape is
 * per-ROW-SLOT and corpus-level: player A is handed a TIMING decision in 83% of
 * local draws against 64% on cloud. That is the number to track, because it
 * discriminates local from cloud — unlike template share, where cloud scores
 * 47.5% against local's 52.8% and the finding indicts the prompt instead.
 *
 * This is a MEASUREMENT, never a gate. A word-list classifier is far too blunt
 * to reject anything with, and "Early/Late" is dull rather than false — but a
 * blunt instrument pointed at a 5%-target metric is exactly what was missing
 * while three of the four reported numbers were measuring the harness.
 */
const AXIS_FAMILIES = [
  ['TIME/SPEED',     /\b(early|late|morning|evening|night|day|dawn|dusk|rush|slow|fast|quick|immediate|delay\w*|defer\w*|advance|prompt|seasonal|off-?peak|peak|now|later|spring|summer|autumn|winter)\b/i],
  ['ACCESS/SHARING', /\b(shared?|separate|open|closed|reserve[dt]?|private|public|exclusive|joint|independent|restrict\w*|hold|release|common|pooled)\b/i],
  ['SCOPE/EXTENT',   /\b(full|partial|minor|major|complete|limited|broad|narrow|selective|bulk|small|large|extended|minimal|whole|light|heavy|deep|shallow)\b/i],
  ['PRICE/TERMS',    /\b(premium|standard|discount\w*|budget|spot|contract|fixed|variable|cost-?plus|market|flat|tiered|priority|economy)\b/i],
];
const axisOf = (l1, l2) => {
  const t = `${l1 ?? ''} ${l2 ?? ''}`;
  for (const [name, re] of AXIS_FAMILIES) if (re.test(t)) return name;
  return 'OTHER';
};

const names=[]; const lat=[]; const domainsSeen=[]; const rowMods=[]; const rowAxes=[]; const colAxes=[]; let sameAxis=0, axisPairs=0;
let ok=0, adherentWithName=0, adherentHonest=0, nameIsDomain=0, bad=0;
for (let i=0;i<rows.length;i++) {
  const g = rows[i].game ?? rows[i];
  const domain = SCENARIO_DOMAINS[i % SCENARIO_DOMAINS.length];
  const sys = `${SCENARIO_SYSTEM_PROMPT}\n\nSET THIS SCENARIO IN THIS DOMAIN: ${domain}. Use that domain and no other. Everything else above still applies.`;
  const t0=Date.now();
  try {
    const res=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({messages:[{role:'system',content:sys},
        {role:'user',content:JSON.stringify(buildGroundingPayload(g))}],
        temperature:0.8,top_p:0.95,max_tokens:700})});
    const j=await res.json(); lat.push(Date.now()-t0);
    const txt=j.choices?.[0]?.message?.content??'';
    const m=txt.match(/\{[\s\S]*\}/);
    const sc=m?JSON.parse(m[0]).suggestedScenario:null;
    if(!sc?.name){bad++;continue;}
    names.push(sc.name); domainsSeen.push(domain);
    if(validateScenario(sc,g).ok && scenarioIsClaimFree(sc).ok!==false) ok++;
    if(squash(sc.name)===squash(domain)) nameIsDomain++;
    const words=domain.split(/[\s-]+/).filter(w=>w.length>3);
    // As previously reported: needle allowed to hide in the name the harness
    // effectively dictated.
    if(words.some(w=>(sc.name+' '+(sc.description||'')).toLowerCase().includes(w))) adherentWithName++;
    // Honest: does the STORY land in the requested industry? Labels count —
    // they are the model's own invention and carry the setting legitimately.
    const body=((sc.description||'')+' '+[sc.row1,sc.row2,sc.col1,sc.col2].filter(Boolean).join(' ')).toLowerCase();
    if(words.some(w=>body.includes(w))) adherentHonest++;
    if(sc.row1||sc.row2) rowMods.push(modifier(sc.row1), modifier(sc.row2));
    if((sc.row1||sc.row2)&&(sc.col1||sc.col2)){
      const ra=axisOf(sc.row1,sc.row2), ca=axisOf(sc.col1,sc.col2);
      rowAxes.push(ra); colAxes.push(ca); axisPairs++;
      if(ra===ca&&ra!=='OTHER') sameAxis++;
    }
  } catch { bad++; }
}
const share=(arr)=>{const c={};for(const n of arr)if(n)c[n]=(c[n]||0)+1;
  return Object.entries(c).sort((a,b)=>b[1]-a[1])[0]??['(none)',0];};
const top=share(names), topMod=share(rowMods);
lat.sort((a,b)=>a-b);
const n=Math.max(1,names.length);
console.log(`MODEL ${process.env.LABEL||URL}`);
console.log(`  yield through the real gates : ${ok}/${rows.length} = ${(100*ok/rows.length).toFixed(1)}%   (unparseable ${bad})`);
console.log(`  latency                      : p50 ${(lat[Math.floor(lat.length*.5)]/1000).toFixed(2)}s  p90 ${(lat[Math.floor(lat.length*.9)]/1000).toFixed(2)}s`);
console.log(`  domain adherence (HONEST)    : ${adherentHonest}/${n} = ${(100*adherentHonest/n).toFixed(1)}%   <- description+labels, name excluded`);
console.log(`  option-axis TOP modifier     : "${topMod[0]}" x${topMod[1]} = ${(100*topMod[1]/Math.max(1,rowMods.length)).toFixed(1)}% of row labels   (target <= 5%)`);
const rowTime=rowAxes.filter(a=>a==='TIME/SPEED').length, ap=Math.max(1,axisPairs);
console.log(`  ROW axis is TIME/SPEED       : ${rowTime}/${axisPairs} = ${(100*rowTime/ap).toFixed(1)}%   (cloud reference 64%, local reference 83%)`);
console.log(`  ROW axis family spread       : ${[...new Set(rowAxes)].map(a=>`${a} ${(100*rowAxes.filter(x=>x===a).length/ap).toFixed(0)}%`).join('  ')}`);
// CALIBRATED against red's hand labels, and reported with the disagreement
// visible. ROW-axis TIME/SPEED lands at 80.7% local against red's 83% and 53.8%
// cloud against red's 64% — close enough local, same direction and a wider gap
// on cloud, so the metric tracks. The SAME-AXIS line does NOT agree: this
// classifier buckets into five coarse families, so two genuinely different
// decisions can land in one bucket, and it reads 23.6% where red's finer hand
// labelling says 7.6%. It is kept as an upper bound and explicitly NOT as red's
// number, because a series that quietly reports 23.6% under red's label would
// be the same category of error this whole file exists to correct.
console.log(`  row/col share an axis (COARSE): ${sameAxis}/${axisPairs} = ${(100*sameAxis/ap).toFixed(1)}%   <- UPPER BOUND; red's hand labels say 7.6%, trust theirs`);
console.log(`  --- harness-bounded, do not read as model quality ---`);
console.log(`  name IS the domain title-cased: ${nameIsDomain}/${n} = ${(100*nameIsDomain/n).toFixed(1)}%   <- why the three below are inflated`);
console.log(`  distinct names               : ${new Set(names).size}/${names.length}   (ceiling: ${new Set(domainsSeen).size} distinct domains drawn)`);
console.log(`  TOP name share               : "${top[0]}" x${top[1]} = ${(100*top[1]/n).toFixed(1)}%`);
console.log(`  domain adherence (as reported before): ${adherentWithName}/${n} = ${(100*adherentWithName/n).toFixed(1)}%   <- inflated by ${(100*(adherentWithName-adherentHonest)/n).toFixed(1)} pts`);

/* BLUE W2 — candidate discriminators for the abstract-player coordination claim.
 * Instrument only: measures REACH and prints every hit's matched span so each can
 * be hand-classified. Nothing here is a gate. */
import { readFileSync } from 'node:fs';
const { computeAllNE } = await import('../src/utils/gameEngine.ts');
const S='/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/';
const CORPORA=[['local','/tmp/rt2_local.jsonl','game'],['cloud','/tmp/rt2_cloud.jsonl','game'],
  ['rt1','' + S + 'rt1.jsonl','g'],['rt2','' + S + 'rt2.jsonl','g'],
  ['stakes_local','/tmp/rt2_stakes_local.jsonl','game'],['stakes_cloud','/tmp/rt2_stakes_cloud.jsonl','game']];

const NOUN   = String.raw`(?:players?|parties|sides|institutions?|participants?|agents?|actors?)`;
const SUBJ_N = String.raw`(?:the\s+two|both)\s+${NOUN}`;
const SUBJ_W = String.raw`(?:the\s+two|both|the)\s+${NOUN}`;
const AUX    = String.raw`(?:will|would|shall|should|must|can|could|may|might|are|is|were|was|also|then|now|still|already|simply|jointly|closely|each|both)`;
const INTENT = String.raw`(?:plan|plans|planning|try|tries|trying|aim|aims|aiming|seek|seeks|seeking|agree|agrees|agreeing|want|wants|need|needs|hope|hopes|hoping|intend|intends|attempt|attempts|attempting|prepare|prepares|preparing|arrange|arranges|arranging|decide|decides|deciding|choose|chooses|choosing|work|works|working)`;
const VERB   = String.raw`coordinat(?:e|es|ing)\b`;
const PART   = String.raw`coordinated\b`;
const LINK   = String.raw`(?:\s+(?:to|how|on|whether))*`;
const V3 = (subj) => new RegExp(String.raw`\b${subj}(?:\s+${AUX})*(?:\s+${VERB}|(?:\s+${INTENT})${LINK}(?:\s+${VERB}|\s+(?:a|an|the|their)\s+${PART}))`, 'i');
const BRIDGE = String.raw`(?:\s+(?:will|would|must|should|shall|can|could|may|might|are|is|be|been|being|then|also|now|each|need|needs|have|has|want|wants|try|tries|trying|aim|aims|aiming|agree|agrees|agreeing|plan|plans|planning|seek|seeks|seeking|hope|hopes|hoping|intend|intends|attempt|attempts|attempting|to|how|on|a|an|their|the))*`;

const CAND = {
  V0_draft:    { re: new RegExp(String.raw`\b${SUBJ_W}\b[^.!?]{0,80}?\bcoordinat`, 'i'), shape: 'notMatchingShape' },
  V2_bridge:   { re: new RegExp(String.raw`\b${SUBJ_W}${BRIDGE}\s+coordinat(?:e|es|ed|ing)\b`, 'i'), shape: 'notMatchingShape' },
  V3_forms:    { re: V3(SUBJ_W), shape: 'notMatchingShape' },
  V3n_narrow:  { re: V3(SUBJ_N), shape: 'notMatchingShape' },
  V3n_noMatchNE:{ re: V3(SUBJ_N), shape: 'noMatchingNE' },
};

const info=(g)=>{const p=computeAllNE(g).filter(t=>t.type==='pure');
  const d=p.filter(t=>(t.x===1&&t.y===1)||(t.x===0&&t.y===0)).length;
  const a=p.filter(t=>(t.x===1&&t.y===0)||(t.x===0&&t.y===1)).length;
  return {notMatchingShape: !(p.length>=2&&d===p.length), noMatchingNE: d===0,
    tag: p.length>=2&&a===p.length?'all-MISMATCH':p.length>=2&&d===p.length?'all-MATCH':`pure=${p.length},diag=${d},anti=${a}`};};

const all=[];
for (const [label,path,gk] of CORPORA){
  let rows; try{rows=readFileSync(path,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));}catch{ console.log('MISSING',path); continue; }
  for (const r of rows) if (r.sc && r[gk]) all.push({label, i:r.i??r.pair, sc:r.sc, g:r[gk]});
}
console.log(`corpus: ${all.length} stored scenarios with a matrix (local + cloud + rt1 + rt2 + stakes)\n`);
for (const [name,{re,shape}] of Object.entries(CAND)) {
  const hits = all.filter(r => info(r.g)[shape] && re.test(r.sc.description ?? ''));
  const byC = {}; for (const h of hits) byC[h.label]=(byC[h.label]||0)+1;
  console.log(`${name.padEnd(15)} reach ${String(hits.length).padStart(3)} / ${all.length}  (${(100*hits.length/all.length).toFixed(2)}%)  ${JSON.stringify(byC)}`);
}
console.log('\n──── hits, showing which candidates fire ────');
for (const r of all) {
  const d = r.sc.description ?? ''; const inf = info(r.g);
  const fires = Object.entries(CAND).filter(([,{re,shape}]) => inf[shape] && re.test(d)).map(([n])=>n);
  if (!fires.length) continue;
  const m = d.match(CAND.V0_draft.re) || d.match(CAND.V3n_narrow.re);
  console.log(`\n[${r.label}#${r.i}] shape=${inf.tag}`);
  console.log(`  fires: ${fires.join(' ')}`);
  console.log(`  SPAN  «${m?m[0]:'(n/a)'}»`);
  console.log(`  DESC  ${d}`);
}

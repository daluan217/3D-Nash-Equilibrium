/**
 * BLUE — WINDOW 8: reach and cost of the three debris rules, over EVERY corpus.
 *
 * "Newly rejected" is exact here: these three reasons did not exist before, so a
 * draw rejected ONLY for a debris reason is precisely what the change costs. The
 * draws it newly rejects are printed in full, because no rate in this campaign
 * is quotable until its hits have been hand-read.
 *
 *   npx tsx _gen/blue_w8_debris_reach.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');
const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const REPO = '/Users/danielluan/Desktop/3D-Nash-Equilibrium';
const files = [];
for (const d of ['/tmp', S, REPO + '/_gen', REPO + '/_gen/results', S + '/blue/_gen', S + '/debris/_gen']) {
  if (!existsSync(d)) continue;
  // The scan harnesses in this campaign write .jsonl into /tmp too; excluding
  // this file's own family stops the instrument from measuring itself, which
  // silently corrupted an arm count once already.
  for (const f of readdirSync(d)) if (f.endsWith('.jsonl') && !/^(blue_w[78]_(out|.*_accepted)|neg_|neg2_)/.test(f)) files.push(d + '/' + f);
}
const sg = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const rows = []; const seen = new Set();
for (const f of files.sort()) {
  const src = f.split('/').pop().replace('.jsonl', '');
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    const sc = r.sc ?? r.scenario; if (!sc || typeof sc !== 'object') continue;
    const g = r.g ?? r.game ?? (r.spread != null ? sg(r.spread) : null); if (!g) continue;
    const key = src + '|' + sc.name + ' ' + sc.description; if (seen.has(key)) continue; seen.add(key);
    rows.push({ src, sc, g });
  }
}
const DEBRIS = /outside the expected script|curly brace|talking to itself/;
const A = (sc) => ['name','row1','row2','col1','col2','description'].map((k)=>typeof sc[k]==='string'?sc[k]:'').join(' | ');

// INSTRUMENT SELF-TEST: a planted positive of each rule must be counted, or a
// zero below is a zero from a dead instrument.
const P = (o) => ({ name: 'N', row1: 'A', row2: 'B', col1: 'C', col2: 'D', storyClaims: null, description: 'x', ...o });
const G0 = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 0, b12: 1, b21: 1, b22: 0 };
const probes = [['script', P({ row2: '厚 coat' })], ['brace', P({ description: 'a }} b' })], ['self-talk', P({ description: 'wait invalid. Need clean JSON.' })]];
for (const [tag, sc] of probes) {
  if (!V.validateScenario(sc, G0).issues.some((i) => DEBRIS.test(i))) { console.error(`INSTRUMENT BROKEN — ${tag} probe not counted. Run void.`); process.exit(1); }
}
console.log(`instrument self-test: all ${probes.length} debris rules reachable through the real gate\n`);

let live = 0; const newly = [];
for (const r of rows) {
  const iss = V.validateScenario(r.sc, r.g).issues;
  const debris = iss.filter((i) => DEBRIS.test(i));
  const other = iss.filter((i) => !DEBRIS.test(i));
  const cfOk = V.scenarioIsClaimFree(r.sc).ok;
  const dirOk = V.validateProseDirections(r.sc.description ?? '', r.sc, r.g).length === 0;
  // Reached the user BEFORE this change = nothing but a debris reason stops it.
  if (other.length === 0 && cfOk && dirOk) { live++; if (debris.length) newly.push({ ...r, debris }); }
}
console.log(`${files.length} corpora - ${rows.length} unique draws - ${live} reached the user before this change`);
console.log(`NEWLY REJECTED: ${newly.length} = ${(100 * newly.length / live).toFixed(3)}%\n`);
const by = new Map(); for (const n of newly) by.set(n.src, (by.get(n.src) ?? 0) + 1);
console.log(`sources: ${[...by.entries()].map(([a, b]) => a + ' ' + b).join(', ') || '-'}\n`);
for (const n of newly) console.log(`  [${n.src}] ${n.debris.join(' + ')}\n     ${A(n.sc).slice(0, 240)}\n`);

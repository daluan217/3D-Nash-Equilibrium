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
// THE BANK IS THE CORPUS WITH THE MOST AT STAKE — it is what the desktop is
// about to ship — and it is the one arm the /tmp corpora could not cover: two
// of the four debris rows exist ONLY here, including the only Arabic one. It is
// also LIVE (bank_fill appends), so it is re-read on every run rather than
// cached, and the row count in any quoted figure is the count at that moment.
const BANK = '/Users/danielluan/nash-finetune-data/scenario_raw_v2.jsonl';
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
if (existsSync(BANK)) {
  let nulls = 0;
  for (const l of readFileSync(BANK, 'utf8').split('\n')) {
    if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    // `?? ` collapses a NULL scenario to undefined, so a `sc === null` test
    // counted zero against a hand count of 131. Read the field directly.
    if (r.scenario === null) { nulls++; continue; }
    const sc = r.scenario ?? r.sc; const g = r.game ?? r.g;
    // `scenario: null` rows are generation FAILURES the bank records, not
    // defects. They carry no scenario, so they cannot ship and cannot be
    // gated — counted and excluded, never silently dropped into the denominator.
    if (!sc || typeof sc !== 'object' || !g) continue;
    const key = sc.name + ' ' + sc.description; if (seen.has(key)) continue; seen.add(key);
    rows.push({ src: 'BANK(scenario_raw_v2)', sc, g });
  }
  console.log(`bank: ${rows.length} scannable rows, ${nulls} generation-failure rows (scenario null) excluded`);
}
for (const f of files.sort()) {
  const src = f.split('/').pop().replace('.jsonl', '');
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    const sc = r.sc ?? r.scenario; if (!sc || typeof sc !== 'object') continue;
    const g = r.g ?? r.game ?? (r.spread != null ? sg(r.spread) : null); if (!g) continue;
    // DEDUP ON CONTENT, NOT ON (source, content). Keyed by source, the same
    // scenario present in two files counts twice: the first run of this census
    // reported 8 rejections where there are 5 DISTINCT draws, because Regional
    // Triage and Mirror Recoating sit in both the bank and rt2d_fixpool, and
    // Wind-Farm Maintenance is in two /tmp files. The bank is loaded first so a
    // shared row is attributed to it.
    const key = sc.name + ' ' + sc.description; if (seen.has(key)) continue; seen.add(key);
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

// PER-RULE FIRING, and the subset coverage that settles which rules are load
// -bearing. A rule kept for "unique reach" it does not have is a comment that
// will mislead the next person; this prints the table rather than asserting it.
const fired = (n, re) => n.debris.some((d) => re.test(d));
console.log('FOREIGN  BRACE  SELFTALK   row');
for (const n of newly) {
  console.log(`${fired(n, /outside the expected script/) ? ' FOREIGN' : '    .   '} ${fired(n, /curly brace/) ? 'BRACE' : '  .  '} ${fired(n, /talking to itself/) ? 'SELFTALK' : '   .    '}   ${n.sc.name}`);
}
const S1 = (n) => fired(n, /outside the expected script/), S2 = (n) => fired(n, /curly brace/), S3 = (n) => fired(n, /talking to itself/);
console.log('\nsubset coverage:');
for (const [nm, f] of [['foreign only', S1], ['brace only', S2], ['self-talk only', S3],
  ['foreign + self-talk', (n) => S1(n) || S3(n)], ['foreign + brace', (n) => S1(n) || S2(n)],
  ['brace + self-talk', (n) => S2(n) || S3(n)], ['all three', (n) => S1(n) || S2(n) || S3(n)]]) {
  console.log(`  ${nm.padEnd(22)} ${newly.filter(f).length}/${newly.length}`);
}

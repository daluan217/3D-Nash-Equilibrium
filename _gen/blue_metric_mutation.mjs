/* MUTATION TEST for the corrected domain-adherence check.
 * OLD expression (name+desc) must be unable to fire on the known defect;
 * NEW expression (desc+labels) must fire on it. Run over red's corpus. */
import { readFileSync } from 'node:fs';
const load = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const squash = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
for (const [label, path] of [['LOCAL','/tmp/rt2_local.jsonl'],['CLOUD','/tmp/rt2_cloud.jsonl']]) {
  let rows; try { rows = load(path); } catch { continue; }
  const ok = rows.filter(r => r.sc && r.sc.name);
  let oldFires = 0, newFires = 0, nameIsDom = 0; const ex = [];
  for (const r of ok) {
    const d = (r.sc.description || ''), nm = r.sc.name;
    const labels = [r.sc.row1, r.sc.row2, r.sc.col1, r.sc.col2].filter(Boolean);
    const words = r.domain.split(/[\s-]+/).filter(w => w.length > 3);
    if (!words.length) continue;
    const OLD = !words.some(w => (nm + ' ' + d).toLowerCase().includes(w));
    const NEW = !words.some(w => (d + ' ' + labels.join(' ')).toLowerCase().includes(w));
    if (OLD) oldFires++;
    if (NEW) { newFires++; if (ex.length < 4) ex.push(`[${r.domain}] ${d.slice(0, 120)}`); }
    if (squash(nm) === squash(r.domain)) nameIsDom++;
  }
  const n = ok.length;
  console.log(`\n── ${label} n=${n} ──`);
  console.log(`  OLD check (name+desc) fires : ${oldFires}  = ${(100*oldFires/n).toFixed(1)}%`);
  console.log(`  NEW check (desc+labels) fires: ${newFires} = ${(100*newFires/n).toFixed(1)}%`);
  console.log(`  name-is-domain check fires   : ${nameIsDom} = ${(100*nameIsDom/n).toFixed(1)}%`);
  for (const e of ex) console.log('    ' + e);
}

/* AUDIT OF MY OWN INSTRUMENTS.
 * RED 2 filed that the scenario NAME is the injected domain title-cased 93% of
 * the time. If so, three of the four numbers domain_model_eval reports are
 * measured on a field the harness itself supplied, and cannot fail. */
import { readFileSync } from 'node:fs';
const load = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const title = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

for (const [label, path] of [['LOCAL', '/tmp/rt2_local.jsonl'], ['CLOUD', '/tmp/rt2_cloud.jsonl']]) {
  let rows; try { rows = load(path); } catch { continue; }
  const ok = rows.filter((r) => r.sc && r.sc.name);
  let nameIsDomain = 0, adhereWithName = 0, adhereWithoutName = 0;
  const names = [];
  for (const r of ok) {
    const dom = r.domain, nm = r.sc.name, desc = r.sc.description || '';
    const labels = [r.sc.row1, r.sc.row2, r.sc.col1, r.sc.col2].filter(Boolean).join(' ');
    names.push(nm);
    if (title(nm) === title(dom)) nameIsDomain++;
    const words = dom.split(/[\s-]+/).filter((w) => w.length > 3);
    const hayWith = (nm + ' ' + desc).toLowerCase();
    const hayWithout = (desc + ' ' + labels).toLowerCase();
    if (words.some((w) => hayWith.includes(w))) adhereWithName++;
    if (words.some((w) => hayWithout.includes(w))) adhereWithoutName++;
  }
  const c = {}; for (const n of names) c[n] = (c[n] || 0) + 1;
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  const n = ok.length;
  console.log(`\n── ${label}  (n=${n} with a name) ──`);
  console.log(`  name IS the domain, title-cased  : ${nameIsDomain}/${n} = ${(100*nameIsDomain/n).toFixed(1)}%`);
  console.log(`  distinct names (as reported)     : ${new Set(names).size}/${n} = ${(100*new Set(names).size/n).toFixed(1)}%`);
  console.log(`  TOP name share (as reported)     : "${top[0]}" x${top[1]} = ${(100*top[1]/n).toFixed(1)}%`);
  console.log(`  distinct DOMAINS drawn           : ${new Set(ok.map(r=>r.domain)).size}/${n}   <- the ceiling the harness itself sets`);
  console.log(`  adherence WITH name (as reported): ${adhereWithName}/${n} = ${(100*adhereWithName/n).toFixed(1)}%`);
  console.log(`  adherence WITHOUT name (honest)  : ${adhereWithoutName}/${n} = ${(100*adhereWithoutName/n).toFixed(1)}%`);
  console.log(`  >> inflation from including name : ${(100*(adhereWithName-adhereWithoutName)/n).toFixed(1)} points`);
}

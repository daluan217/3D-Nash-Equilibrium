#!/usr/bin/env node
// Regenerate src/e2e/shard-timings.json from one completed CI run's SECTION-PASS lines.
//   node scripts/shard-timings-from-run.mjs <run-id>      (gh CLI must be signed in)
// Keeps _default/_overhead_ms/_ceiling_ms; a section missing from the run keeps its old value.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
// Several run ids: each section keeps its MAX across the runs. CI timing per section varies
// run to run (first 24-shard run: median 0.95x the table, p90 1.35x, one section 1.76x), so
// packing from a single measurement leaves a shard one slow section away from the ceiling.
const runIds = process.argv.slice(2);
if (!runIds.length) { console.error('usage: shard-timings-from-run.mjs <run-id> [<run-id> ...]  (max per section across runs)'); process.exit(2); }
const runId = runIds.join('+');
const file = new URL('../src/e2e/shard-timings.json', import.meta.url);
const current = JSON.parse(readFileSync(file, 'utf8'));
const jobs = runIds.flatMap((id) => JSON.parse(execFileSync('gh', ['run', 'view', id, '--json', 'jobs'], { encoding: 'utf8' })).jobs
  .filter((j) => /^e2e smoke \(\d+\/\d+\)$/.test(j.name)));
const next = { ...current };
let seen = 0;
const reportedIds = new Set();
for (const job of jobs) {
  const log = execFileSync('gh', ['run', 'view', '--job', String(job.databaseId), '--log'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const m of log.matchAll(/SECTION-PASS ([0-9a-z]+) .*\((\d+)ms\)/g)) {
    const ms = Number(m[2]); const prev = reportedIds.has(m[1]) ? next[m[1]] : 0;
    next[m[1]] = Math.max(prev, ms); reportedIds.add(m[1]); seen++;
  }
}
// The run must have reported EVERY section registered in smoke.mjs, and none over budget —
// otherwise the table would be a mix of two suites (CodeRabbit on #157: a pre-split run
// reporting 66 at 275 s next to a retained 66b) and packing it would exceed the job ceiling.
const { validateTimings, assignShards, SHARD_COUNT } = await import('../src/e2e/selection.js');
const smoke = readFileSync(new URL('../src/e2e/smoke.mjs', import.meta.url), 'utf8');
const registered = [...smoke.matchAll(/section\('([^']+)',\s*'[^']*',\s*async/g)].map((m) => m[1]);
const fresh = Object.fromEntries(Object.entries(next).filter(([k]) => k.startsWith('_')));
for (const id of registered) if (typeof next[id] === 'number') fresh[id] = next[id];
const registeredSet = new Set(registered);
const budget = fresh._ceiling_ms - fresh._overhead_ms;
const packed = assignShards(registered.map((id) => ({ id })), fresh, SHARD_COUNT);
const problems = validateTimings(registered, fresh)
  .concat(registered.filter((id) => !reportedIds.has(id)).map((id) => `run ${runId} did not report section ${id} — refresh from a run of THIS tree`))
  // a run of a DIFFERENT tree (a removed or renamed section) is not a measurement of this suite
  .concat([...reportedIds].filter((id) => !registeredSet.has(id)).map((id) => `run ${runId} reported section ${id}, which is not registered in this tree`))
  // the table must also PACK under budget — per-section checks alone allow twenty 120 s sections
  .concat(packed.totals.map((t, i) => [t, i + 1]).filter(([t]) => t > budget).map(([t, n]) => `shard ${n} would pack ${Math.round(t / 1000)} s of sections, over the ${budget / 1000} s budget — raise SHARD_COUNT or split`));
if (problems.length) { console.error('refusing to write shard-timings.json:\n  ' + problems.join('\n  ')); process.exit(1); }
const keys = Object.keys(fresh).filter((k) => !k.startsWith('_')).sort((a, b) => a.length - b.length || a.localeCompare(b));
const out = {}; for (const k of Object.keys(fresh).filter((k) => k.startsWith('_'))) out[k] = fresh[k]; for (const k of keys) out[k] = fresh[k];
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`updated ${seen} section timings from run ${runId} → src/e2e/shard-timings.json`);

#!/usr/bin/env node
// Regenerate src/e2e/shard-timings.json from one completed CI run's SECTION-PASS lines.
//   node scripts/shard-timings-from-run.mjs <run-id>      (gh CLI must be signed in)
// Keeps _default/_overhead_ms/_ceiling_ms; a section missing from the run keeps its old value.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const runId = process.argv[2];
if (!runId) { console.error('usage: shard-timings-from-run.mjs <run-id>'); process.exit(2); }
const file = new URL('../src/e2e/shard-timings.json', import.meta.url);
const current = JSON.parse(readFileSync(file, 'utf8'));
const jobs = JSON.parse(execFileSync('gh', ['run', 'view', runId, '--json', 'jobs'], { encoding: 'utf8' })).jobs
  .filter((j) => /^e2e smoke \(\d+\/\d+\)$/.test(j.name));
const next = { ...current };
let seen = 0;
for (const job of jobs) {
  const log = execFileSync('gh', ['run', 'view', '--job', String(job.databaseId), '--log'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const m of log.matchAll(/SECTION-PASS ([0-9a-z]+) .*\((\d+)ms\)/g)) { next[m[1]] = Number(m[2]); seen++; }
}
const keys = Object.keys(next).filter((k) => !k.startsWith('_')).sort((a, b) => a.length - b.length || a.localeCompare(b));
const out = {}; for (const k of Object.keys(next).filter((k) => k.startsWith('_'))) out[k] = next[k]; for (const k of keys) out[k] = next[k];
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`updated ${seen} section timings from run ${runId} → src/e2e/shard-timings.json`);

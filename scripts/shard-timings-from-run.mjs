#!/usr/bin/env node
// Regenerate src/e2e/shard-timings.json AND src/e2e/tour-timings.json from completed CI runs of THIS tree:
//   node scripts/shard-timings-from-run.mjs <run-id> [<run-id> ...]      (gh CLI must be signed in)
// Each section and tour case keeps its MAX across the runs (one run's per-section times vary up to 1.76x). The jobs'
// fixed costs are measured too (TASK-18 F6): a hand-set 75 s overhead let a WebKit shard plan a 440 s job.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateTimings, assignShards, parseSections, SHARD_COUNT } from '../src/e2e/selection.js';
import { walkTags, scrollTags } from '../src/e2e/tour-cases.mjs';

const wallMs = (job) => Date.parse(job.completedAt) - Date.parse(job.startedAt);

// jobs: gh's { name, conclusion, startedAt, completedAt, steps } plus the job's log. A job's overhead is its wall minus every
// section (or tour case) it printed, retries and shard 24's §47 step included, so only fixed cost is left. outside: the
// time before its first step and after its last shard-cases check, which shard-cases.mjs's wall check cannot clock.
export function measure(jobs) {
  const sections = {}, tour = { walk: {}, scroll: {} }, problems = [];
  let overheadMs = 0, setupS = 0, outsideMs = 0;
  for (const job of jobs) {
    const smoke = /^e2e smoke \(\d+\/\d+\)$/.test(job.name), kind = /^e2e tour (walk|scroll) \(\d+\/\d+\)$/.exec(job.name)?.[1];
    if (!smoke && !kind) continue;
    if (job.conclusion !== 'success' || !(wallMs(job) > 0)) { problems.push(`${job.name} concluded ${job.conclusion} (wall ${wallMs(job)} ms): not a measurement`); continue; }
    let ran = 0;
    if (smoke) {
      for (const [, result, id, ms] of job.log.matchAll(/SECTION-(PASS|FAIL) (\S+) .*\((\d+)ms\)/g)) {
        ran += +ms;
        if (result === 'PASS') sections[id] = Math.max(sections[id] ?? 0, +ms);
      }
      overheadMs = Math.max(overheadMs, Math.ceil((wallMs(job) - ran) / 1000) * 1000);
      const steps = (job.steps ?? []).filter((s) => s.conclusion !== 'skipped'), at = (k, s) => Date.parse(s[k]);
      const first = Math.min(...steps.filter((s) => s.name !== 'Set up job').map((s) => at('startedAt', s)));
      const checked = Math.max(...steps.filter((s) => /^(Boot the production server|Exercise section 47)/.test(s.name)).map((s) => at('completedAt', s)));
      const outside = first - Date.parse(job.startedAt) + Date.parse(job.completedAt) - checked;
      if (Number.isFinite(outside) && outside >= 0) outsideMs = Math.max(outsideMs, outside); else problems.push(`${job.name}: no readable steps, so its time outside them is unknown`);
    } else {
      for (const [, tag, s] of job.log.matchAll(/ {2}· (\[[^\]\n]+\])[^\n]*? (\d+) s, load/g)) { ran += +s; tour[kind][tag] = Math.max(tour[kind][tag] ?? 0, +s); }
      setupS = Math.max(setupS, Math.ceil(wallMs(job) / 1000 - ran));
    }
  }
  return { sections, overheadMs, outsideMs, tour, setupS, problems };
}

// The two files' text, or why a refresh must refuse. Pure, so e2esharding runs measure() on verbatim CI jobs.
export function refresh(jobs, current, smokeSource, runIds) {
  const { sections, overheadMs, outsideMs, tour, setupS, problems } = measure(jobs), runs = runIds.join('+');
  const registered = parseSections(smokeSource).map(({ id }) => id), tags = { walk: walkTags(), scroll: scrollTags() };
  const meta = { ...Object.fromEntries(Object.entries(current).filter(([k]) => k.startsWith('_'))), _overhead_ms: overheadMs, _outside_ms: outsideMs };
  const fresh = { ...Object.fromEntries(registered.filter((id) => sections[id] !== undefined).map((id) => [id, sections[id]])), ...meta };
  const budget = fresh._ceiling_ms - overheadMs, { totals } = assignShards(registered.map((id) => ({ id })), fresh, SHARD_COUNT);
  // Every registered section and tour case, measured by these runs and none other (a mix of two suites is not a table),
  // and the sections must PACK under the measured budget: per-section checks alone allow twenty 120 s sections.
  problems.push(...validateTimings(registered, fresh),
    ...registered.filter((id) => sections[id] === undefined).map((id) => `run ${runs} did not report section ${id} — refresh from a run of THIS tree`),
    ...Object.keys(sections).filter((id) => !registered.includes(id)).map((id) => `run ${runs} reported section ${id}, which is not registered in this tree`),
    ...totals.flatMap((t, i) => (t > budget ? [`shard ${i + 1} would pack ${Math.round(t / 1000)} s of sections, over the ${budget / 1000} s budget — raise SHARD_COUNT or split`] : [])),
    ...Object.entries(tags).flatMap(([k, want]) => [...want.filter((t) => tour[k][t] === undefined).map((t) => `run ${runs} did not time tour ${k} case ${t}`),
      ...Object.keys(tour[k]).filter((t) => !want.includes(t)).map((t) => `run ${runs} timed tour ${k} case ${t}, which this tree does not run`)]));
  const ids = registered.filter((id) => fresh[id] !== undefined).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const why = `CI seconds per case in run order, max over CI ${runIds.join(', ')} (scripts/shard-timings-from-run.mjs). _setup_s: the most a tour `
    + 'job spent outside its cases (wall minus case seconds). Each job packs slowest-first (tour-cases.mjs packTour): its slowest shard plus _setup_s must fit 75% of the timeout.';
  return { problems, overheadMs, setupS,
    shard: JSON.stringify(Object.fromEntries([...ids, ...Object.keys(meta)].map((k) => [k, fresh[k]])), null, 1) + '\n',
    tour: `{\n"_why": ${JSON.stringify(why)},\n"_setup_s": ${setupS},\n${Object.entries(tags).map(([k, want]) =>
      `"tour-${k}": [\n${want.map((t) => `  [${JSON.stringify(t)}, ${tour[k][t]}]`).join(',\n')}\n]`).join(',\n')}\n}\n` };
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const runIds = process.argv.slice(2);
  if (!runIds.length) { console.error('usage: shard-timings-from-run.mjs <run-id> [<run-id> ...]  (max per section and case across runs)'); process.exit(2); }
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const jobs = runIds.flatMap((id) => JSON.parse(gh(['run', 'view', id, '--json', 'jobs'])).jobs.filter((j) => /^e2e (smoke|tour) /.test(j.name))
    .map((j) => ({ ...j, log: gh(['run', 'view', '--job', String(j.databaseId), '--log']) })));
  const file = new URL('../src/e2e/shard-timings.json', import.meta.url), tourFile = new URL('../src/e2e/tour-timings.json', import.meta.url);
  const out = refresh(jobs, JSON.parse(readFileSync(file, 'utf8')), readFileSync(new URL('../src/e2e/smoke.mjs', import.meta.url), 'utf8'), runIds);
  if (out.problems.length) { console.error('refusing to write the timing tables:\n  ' + out.problems.join('\n  ')); process.exit(1); }
  writeFileSync(file, out.shard); writeFileSync(tourFile, out.tour);
  console.log(`from run ${runIds.join('+')}: overhead ${out.overheadMs / 1000} s → shard-timings.json; tour setup ${out.setupS} s → tour-timings.json`);
}

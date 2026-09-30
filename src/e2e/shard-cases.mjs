/**
 * Which cases a CI e2e job must run, and whether its log shows it ran exactly those. test.yml runs
 * `node src/e2e/shard-cases.mjs <smoke|walk|scroll> <log>` after each runner, in the runner's env: a count or a
 * success line cannot see WHICH cases ran (TASK-18 sweeps 13, 14). smoke reuses selectSmokeSections, which is an
 * oracle only because e2esharding pins it to the packing for every one of the 35 shards.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { selectSmokeSections, measuredMs, SECTION_BUDGET_MS, EXTRA_STEP_SECTIONS } from './selection.js';
import { walkTags, scrollTags } from './tour-cases.mjs';

const TOUR = { walk: [walkTags, 'TOUR_WALK_SHARD'], scroll: [scrollTags, 'TOUR_SCROLL_SHARD'] };

export function shardCases(job, env, smoke = readFileSync(new URL('./smoke.mjs', import.meta.url), 'utf8')) {
  if (job === 'smoke') {
    const definitions = [...smoke.matchAll(/section\('([^']+)',\s*'([^']+)',\s*async\s*\(\)\s*=>/g)].map((m) => ({ id: m[1], name: m[2] }));
    return selectSmokeSections(definitions, env).selected.map(({ id }) => id);
  }
  if (!TOUR[job]) throw new Error(`unknown job ${JSON.stringify(job)}: smoke, walk or scroll`);
  const [tags, key] = TOUR[job], raw = env[key] ?? '1/1', m = /^(\d+)\/(\d+)$/.exec(raw);
  if (!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error(`${key} must look like 2/9; got ${JSON.stringify(raw)}`);
  return tags().filter((_, j) => j % +m[2] === +m[1] - 1);
}

// smoke: first attempts only. A retried section prints its header again after the RETRYING line, and a
// section that only ran as a retry never ran in the first pass. Tours: one "  · [tag]" line per case run.
export function logCases(job, log) {
  if (job !== 'smoke') return [...log.matchAll(/^ {2}· (\[[^\]\n]+\])/gm)].map((m) => m[1]);
  return [...log.split(/^════ RETRYING ONLY FAILED SECTIONS/m)[0].matchAll(/^════ SECTION (\S+) \[shard \d+\/\d+\] .* ════$/gm)].map((m) => m[1]);
}

export function checkLog(job, log, env) {
  const want = shardCases(job, env), got = logCases(job, log); // e2esharding: want is never empty in CI
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    const missing = want.filter((c) => !got.includes(c)), extra = got.filter((c) => !want.includes(c));
    return `${job}: the log ran ${got.length} case(s), the packing gives ${want.length}: missing ${JSON.stringify(missing)}, `
      + `not this job's ${JSON.stringify(extra)}, in order ${JSON.stringify(got)} vs ${JSON.stringify(want)}`;
  }
  // Per shard only: tour timeouts sit 1.33x over their budget, smoke's 25 min 3.6x its ceiling; E2E_SECTION has no shard.
  if (job !== 'smoke' || !env.E2E_SHARD) return '';
  // The packing's budget holds at run time: a stale table once ran a shard 1,228 s, green (PR #211). First attempts only
  // (a retry is its own signal). ponytail: shard 24's §47 step is charged its table value, not its own log.
  const results = [...log.split(/^════ RETRYING ONLY FAILED SECTIONS/m)[0].matchAll(/^SECTION-(?:PASS|FAIL) (\S+) .*\((\d+)ms\)$/gm)];
  if (JSON.stringify(results.map((m) => m[1])) !== JSON.stringify(got)) // an unread result line would sum to 0 s and pass
    return `smoke: result lines ${JSON.stringify(results.map((m) => m[1]))} do not match the sections run ${JSON.stringify(got)}: the time is unreadable`;
  const ms = results.reduce((a, m) => a + +m[2], 0);
  const step = EXTRA_STEP_SECTIONS[Number.parseInt(env.E2E_SHARD)], budget = SECTION_BUDGET_MS - (step ? measuredMs(step) : 0);
  return ms > budget ? `smoke: the first attempts ran ${ms / 1000} s of sections, over this shard's ${budget / 1000} s budget `
    + `(${SECTION_BUDGET_MS / 1000} s less its extra steps): refresh shard-timings.json with scripts/shard-timings-from-run.mjs, or split a section` : '';
}

// Node takes import.meta.url from the realpath: compare argv[1]'s, or a symlinked path skips the check, exit 0.
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [job, file] = process.argv.slice(2), problem = checkLog(job, readFileSync(file, 'utf8'), process.env);
  if (problem) { console.error(`::error::${problem}`); process.exit(1); }
  console.log(`✓ ${job}: the log ran exactly the ${logCases(job, readFileSync(file, 'utf8')).length} case(s) the packing gives this job`);
}

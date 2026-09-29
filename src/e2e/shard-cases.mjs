/**
 * Which cases a CI e2e job must run, and whether its log shows it ran exactly those. test.yml runs
 * `node src/e2e/shard-cases.mjs <smoke|walk|scroll> <log>` after each runner, in the runner's env: a count or a
 * success line cannot see WHICH cases ran (TASK-18 sweeps 13, 14). smoke reuses selectSmokeSections, which is an
 * oracle only because e2esharding pins it to the packing for every one of the 35 shards.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { selectSmokeSections } from './selection.js';
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
  if (JSON.stringify(got) === JSON.stringify(want)) return '';
  const missing = want.filter((c) => !got.includes(c)), extra = got.filter((c) => !want.includes(c));
  return `${job}: the log ran ${got.length} case(s), the packing gives ${want.length}: missing ${JSON.stringify(missing)}, `
    + `not this job's ${JSON.stringify(extra)}, in order ${JSON.stringify(got)} vs ${JSON.stringify(want)}`;
}

// Node takes import.meta.url from the realpath: compare argv[1]'s, or a symlinked path skips the check, exit 0.
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [job, file] = process.argv.slice(2), problem = checkLog(job, readFileSync(file, 'utf8'), process.env);
  if (problem) { console.error(`::error::${problem}`); process.exit(1); }
  console.log(`✓ ${job}: the log ran exactly the ${logCases(job, readFileSync(file, 'utf8')).length} case(s) the packing gives this job`);
}

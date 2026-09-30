/**
 * Which cases a CI e2e job must run, and whether its log shows it ran exactly those. test.yml runs
 * `node src/e2e/shard-cases.mjs <smoke|walk|scroll> <log>` after each runner, in the runner's env: a count or a
 * success line cannot see WHICH cases ran (TASK-18 sweeps 13, 14). smoke reuses selectSmokeSections, which is an
 * oracle only because e2esharding pins it to the packing for every one of the 35 shards.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseSections, selectSmokeSections, SECTION_BUDGET_MS, SHARD_TIMINGS } from './selection.js';
import { walkTags, scrollTags } from './tour-cases.mjs';

const TOUR = { walk: [walkTags, 'TOUR_WALK_SHARD'], scroll: [scrollTags, 'TOUR_SCROLL_SHARD'] };

export function shardCases(job, env, smoke = readFileSync(new URL('./smoke.mjs', import.meta.url), 'utf8')) {
  if (job === 'smoke') {
    return selectSmokeSections(parseSections(smoke), env).selected.map(({ id }) => id);
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

// A log's first-attempt section time, or null if a section run has no readable result line (it would sum to 0 s).
const RESULT = /^SECTION-(?:PASS|FAIL) (\S+) .*\((\d+)ms\)$/gm, retryMs = (log) => [...(log.split(/^════ RETRYING ONLY FAILED SECTIONS/m)[1] ?? '').matchAll(RESULT)].reduce((a, m) => a + +m[2], 0);
function sectionMs(log) {
  const first = log.split(/^════ RETRYING ONLY FAILED SECTIONS/m)[0], results = [...first.matchAll(RESULT)];
  return JSON.stringify(results.map((m) => m[1])) === JSON.stringify(logCases('smoke', first)) ? results.reduce((a, m) => a + +m[2], 0) : null;
}

// extraLogs: the same job's later steps (shard 24's §47 step), whose section time shares the shard's budget.
export function checkLog(job, log, env, extraLogs = [], now = Date.now()) {
  const want = shardCases(job, env), got = logCases(job, log); // e2esharding: want is never empty in CI
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    const missing = want.filter((c) => !got.includes(c)), extra = got.filter((c) => !want.includes(c));
    return `${job}: the log ran ${got.length} case(s), the packing gives ${want.length}: missing ${JSON.stringify(missing)}, `
      + `not this job's ${JSON.stringify(extra)}, in order ${JSON.stringify(got)} vs ${JSON.stringify(want)}`;
  }
  // Per shard only: tour timeouts sit 1.33x over their budget, smoke's 25 min 3.6x its ceiling; E2E_SECTION has no shard.
  if (job !== 'smoke' || !env.E2E_SHARD) return '';
  // The packing's budget holds at run time: a stale table once ran a shard 1,228 s, green (PR #211). First attempts only
  // (a retry is its own signal).
  const each = [log, ...extraLogs].map(sectionMs), ms = each.reduce((a, t) => a + (t ?? 0), 0);
  if (each.includes(null)) return `smoke: a section ran with no readable SECTION-PASS/FAIL (…ms) line, so the time is unreadable`;
  if (!(ms <= SECTION_BUDGET_MS)) return `smoke: the first attempts ran ${ms / 1000} s of sections${extraLogs.length ? ' with the extra steps' : ''}, over the `
    + `${SECTION_BUDGET_MS / 1000} s budget: refresh shard-timings.json with scripts/shard-timings-from-run.mjs, or split a section`;
  // The budget is the plan; the job's wall is the promise (sweep 3 F6: a hand-set 75 s overhead planned 440 s WebKit jobs).
  // Wall so far from test.yml's first-step clock, retries aside, plus what GitHub spends outside the steps, fits the ceiling.
  const t0 = /^\d+$/.test(env.E2E_JOB_T0 ?? '') ? +env.E2E_JOB_T0 * 1000 : NaN, { _ceiling_ms: ceiling, _outside_ms: outside } = SHARD_TIMINGS;
  if (!(t0 <= now)) return `smoke: E2E_JOB_T0 ${JSON.stringify(env.E2E_JOB_T0)} is not this job's start in epoch seconds, so its wall is unreadable`;
  const wall = now - t0 - [log, ...extraLogs].reduce((a, l) => a + retryMs(l), 0) + outside;
  return !(wall <= ceiling) ? `smoke: the job's first attempts ran ${Math.ceil(wall / 1000)} s (${outside / 1000} s of it outside the steps), over the `
    + `${ceiling / 1000} s ceiling: re-measure _overhead_ms with scripts/shard-timings-from-run.mjs` : '';
}

// Node takes import.meta.url from the realpath: compare argv[1]'s, or a symlinked path skips the check, exit 0.
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [job, file, ...extra] = process.argv.slice(2), problem = checkLog(job, readFileSync(file, 'utf8'), process.env, extra.map((f) => readFileSync(f, 'utf8')));
  if (problem) { console.error(`::error::${problem}`); process.exit(1); }
  console.log(`✓ ${job}: the log ran exactly the ${logCases(job, readFileSync(file, 'utf8')).length} case(s) the packing gives this job`);
}

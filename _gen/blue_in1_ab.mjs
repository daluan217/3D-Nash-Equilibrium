/**
 * BLUE-INPUT — the RUNG-3 trigger A/B.
 *
 * SCENARIO_SYSTEM_PROMPT opens with a paragraph conditional on "if the request
 * says the description must be claim-free". Nothing production sends ever says
 * it, so the paragraph has been inert since 0c22260. Meanwhile two LIVE
 * instructions ask for the opposite — the payload's invention block ("state
 * that cell's numbers and cite the cell") and system rule 2 (storyClaims) —
 * while `scenarioIsClaimFree` discards any description containing a numeral.
 *
 * This measures what that contradiction COSTS, so the fix is chosen on a number
 * instead of on taste.
 *
 *   CONTROL   exactly server.ts:84 — generateScenario(g, {model: DEFAULT_MODEL,
 *             domain: pickScenarioDomain(), stakes: true}), NO `reasoning`
 *             argument (REPORT_REASONING is absent from the deploy manifest, so
 *             production gets the provider default = thinking ON).
 *   TREATMENT identical plus the trigger appended to the REQUEST — the sentence
 *             says "if the REQUEST says", and the request is the user prompt.
 *
 * PAIRED: both arms see the SAME game and the SAME domain, drawn once from one
 * deterministic stream before either call, so arm is the only difference.
 *
 * The verdict per draw is the SHIPPED screen set that server.ts:1127 applies to
 * this exact path (validateScenario + scenarioIsClaimFree + directions when
 * NASH_DIRECTION_CHECKS=1, which production sets), and the claim-free reason is
 * bucketed so 'the description cites a number' — the one the contradiction
 * predicts — is reported on its own.
 *
 *   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
 *   REPORT_MODEL=gpt-5.6-luna NASH_DIRECTION_CHECKS=1 N=15 SEED=90101 \
 *     npx tsx _gen/blue_in1_ab.mjs
 */
import 'dotenv/config';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { generateScenario, DEFAULT_MODEL, hasCredentials } from '../src/utils/report.ts';
import { pickScenarioDomain } from '../src/utils/scenarioDomains.ts';
import { validateScenario, scenarioIsClaimFree, validateProseDirections } from '../src/utils/nashValidator.ts';

const N = Number(process.env.N || 15);
const SEED = Number(process.env.SEED || 90101);
const OUT = process.env.OUT || '/tmp/blue_in1_ab.jsonl';
const CONC = Number(process.env.CONC || 3);

// The literal trigger the dead conditional is waiting for, and nothing else.
// Minimal on purpose: a longer directive would measure the directive rather
// than the paragraph it unlocks.
const TRIGGER = process.env.TRIGGER || 'The description must be claim-free.';

if (!hasCredentials(DEFAULT_MODEL)) { console.error(`no credentials for ${DEFAULT_MODEL}`); process.exit(1); }
if (!existsSync(OUT)) writeFileSync(OUT, '');

let seed = SEED;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const r3 = (x) => Math.round(x * 1000) / 1000;

// Domains come from the SHIPPED picker, sampled once into a list so both arms
// of a pair get the identical string (the picker is random per call, so calling
// it twice would silently unpair the design).
const DOMAINS = [];
{ const s = new Set(); for (let i = 0; i < 6000 && s.size < 80; i++) s.add(pickScenarioDomain()); DOMAINS.push(...[...s].sort()); }

const cells = Array.from({ length: N }, (_, i) => {
  const mag = [0.5, 5, 30, 90][i % 4];
  const p = () => r3((rnd() * 2 - 1) * mag);
  return {
    i,
    g: { a11: p(), a12: p(), a21: p(), a22: p(), b11: p(), b12: p(), b21: p(), b22: p() },
    domain: DOMAINS[Math.floor(rnd() * DOMAINS.length)],
  };
});

const directionOn = process.env.NASH_DIRECTION_CHECKS === '1';

/** The shipped screen set for THIS path, verbatim from server.ts:1127. */
function verdict(sc, g) {
  const vs = validateScenario(sc, g);
  if (!vs.ok) return { pass: false, screen: 'validateScenario', reason: (vs.errors ?? []).join('; ').slice(0, 200) };
  const cf = scenarioIsClaimFree(sc);
  if (!cf.ok) return { pass: false, screen: 'claimFree', reason: cf.reason };
  if (directionOn) {
    const d = validateProseDirections(sc.description ?? '', sc, g);
    if (d.length) return { pass: false, screen: 'directions', reason: d.join('; ').slice(0, 200) };
  }
  return { pass: true, screen: null, reason: null };
}

async function draw(cell, arm) {
  const opts = { model: DEFAULT_MODEL, domain: cell.domain, stakes: true };
  if (arm === 'treat') opts.requestSuffix = TRIGGER;
  const t = Date.now();
  let sc = null, failure = null;
  try { const r = await generateScenario(cell.g, opts); sc = r.scenario; failure = r.failure; }
  catch (e) { failure = String((e && e.message) || e); }
  const v = sc ? verdict(sc, cell.g) : { pass: false, screen: 'no-draw', reason: failure ?? 'null' };
  appendFileSync(OUT, JSON.stringify({
    seed: SEED, i: cell.i, arm, variant: process.env.VARIANT || 'production',
    ms: Date.now() - t, game: cell.g, domain: cell.domain,
    failure, scenario: sc, ...v,
  }) + '\n');
  return v;
}

// Both arms of a pair are enqueued adjacently so provider-side conditions drift
// across pairs rather than across arms.
// ARMS lets one worktree run only the arm it embodies: the CANDIDATE arm is the
// candidate worktree's own 'control' (no requestSuffix), measured against the
// pristine origin/main worktree's 'control' on the identical seeded cells.
const ARMS = (process.env.ARMS || 'control,treat').split(',');
// The 'treat' arm needs a channel into the REQUEST. `generateScenario` has none
// on main — the scaffold that provided one was removed when the change it
// measured was refused. Fail LOUDLY rather than silently measuring the control
// twice: `_gen/eval_v2.ts` reported 0/160 by passing an option the function did
// not read, and tsx transpiles an unknown property without complaint.
if (ARMS.includes('treat') && !/requestSuffix/.test(generateScenario.toString())) {
  console.error('ARMS includes "treat" but generateScenario has no requestSuffix hook.\n'
    + 'That arm would send the CONTROL prompt and report a false null. Re-add the\n'
    + 'scaffold (see git history for blue-input) or drop the arm.');
  process.exit(2);
}

const jobs = [];
for (const c of cells) for (const a of ARMS) jobs.push([c, a]);

const tally = Object.fromEntries(ARMS.map((a) => [a, {}]));
const bump = (arm, k) => { tally[arm][k] = (tally[arm][k] || 0) + 1; };

let next = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  for (;;) {
    const k = next++; if (k >= jobs.length) return;
    const [c, arm] = jobs[k];
    const v = await draw(c, arm);
    bump(arm, v.pass ? 'pass' : `fail:${v.screen}`);
    if (v.screen === 'claimFree') bump(arm, `cf:${v.reason}`);
    process.stdout.write(`${k + 1}/${jobs.length} ${arm} ${v.pass ? 'PASS' : 'FAIL ' + v.screen}\n`);
  }
}));

console.log(`\n=== ${N} paired games, model ${DEFAULT_MODEL}, directions ${directionOn ? 'ON' : 'off'}, ${(Date.now() - t0) / 1000}s, ${jobs.length} calls`);
for (const arm of ARMS) {
  const t = tally[arm] ?? {};
  console.log(`\n${arm}: ${JSON.stringify(t)}`);
  console.log(`  pass ${t.pass || 0}/${N} = ${(((t.pass || 0) / N) * 100).toFixed(1)}%`);
}
console.log(`\nrows appended to ${OUT}`);

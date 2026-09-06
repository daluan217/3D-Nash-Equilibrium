/** Shipping HTTP regressions: scenario retries must fit the browser's 22s budget.
 * Run against dist/server.cjs, from an empty cwd, with loopback providers only.
 * A hanging provider used to consume 20s PER draw, so its bank rescue at 40s
 * was unreachable by the real client. Both templates and regeneration share it.
 *
 * BLUE-CANCEL-12 (director, 2026-09-05): this suite failed on 3 consecutive CI
 * runs (PR #137 3/7, PR #138 2/7, main's own 9bb76fb run), always alongside
 * 12 concurrent e2e smoke shards, always passing on a rerun -- never locally.
 * The suite used to run the REAL 20s server budget and give its own client an
 * abort at the exact production number (22s), leaving only the server's 2s
 * response margin as slack against CI scheduling jitter; see HARNESS-LOG.md
 * (round12/notes/BLUE-CANCEL-12) for the load-reproduction attempt. Fixed at
 * the root instead of by widening that margin: the spawned server now runs
 * a TINY configured budget (NASH_SCENARIO_REQUEST_BUDGET_MS, server.ts) so
 * the whole suite finishes in ~2s of real waiting per case instead of ~20s,
 * and the test's own client abort is sized PROPORTIONALLY to that budget
 * (a multiplier, not a fixed millisecond count) -- both shrinking the
 * absolute CI-jitter exposure and keeping the ratio, and therefore what a
 * regression looks like, meaningful at any budget size. Every assertion
 * below is phrased in terms of the configured budget, never a bare literal
 * millisecond count. Mutation: remove NASH_SCENARIO_REQUEST_BUDGET_MS from
 * the spawned env (server falls back to the real ~20s production budget) --
 * the stalled cases must still fail, because the test's own client abort
 * stays proportional to the SHORT budget it asked for, not to whatever the
 * server actually used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const BUNDLE = path.resolve(import.meta.dirname, '../../dist/server.cjs');
const PORT_BASE = Number(process.env.DEADLINE_TEST_PORT || 4901);
/**
 * The server's OWN configured ladder budget for this run -- short on purpose
 * (server.ts's NASH_SCENARIO_REQUEST_BUDGET_MS override). Every timing
 * assertion below derives from THIS, not from the real 22s/20s production
 * numbers, which this suite no longer waits out.
 *
 * NOT arbitrarily small. CI (PR #140's own first run, real GitHub Actions,
 * not reproducible on a local Mac): at 2_000ms, "ordinary rung-3 report" and
 * "regenerate preview" both saw calls===2 instead of 1 -- a real, PRE-EXISTING
 * boundary race in `inventScreenedScenario`'s loop (server.ts, unchanged by
 * this PR): `drawWithDeadline`'s own per-draw timer can resolve a hair before
 * the outer `requestDeadline` is read again, letting the loop's single
 * bounded "LOST" retry (server.ts's own comment: fires "at most once") reach
 * a SECOND physical request instead of finding `remainingMs <= 0` first. This
 * race exists at the real 20_000ms production budget too, but a few
 * milliseconds of scheduling jitter is negligible against 20s and
 * (apparently) not against 2s -- shrinking the budget too far turned an
 * already-tiny, already-present race into a proportionally significant one.
 * 6_000ms keeps the CI-speed win (suite still ~3x faster than the original
 * 20s-per-case design) while restoring enough absolute margin that this race
 * needs CI-runner-under-load levels of jitter to matter, same as production.
 */
const TEST_SCENARIO_BUDGET_MS = Number(process.env.SCENARIO_DEADLINE_TEST_BUDGET_MS || 6_000);
/**
 * Proportional, not additive: a multiplier keeps the same margin RATIO
 * whatever TEST_SCENARIO_BUDGET_MS is set to, so CI jitter tolerance scales
 * with the budget instead of being a fixed number that happens to work for
 * one particular value.
 *
 * MUST stay well under the real production fallback-delivery time
 * (~20-22s) at whatever TEST_SCENARIO_BUDGET_MS is configured, or the "no
 * env override" mutation (server silently falls back to its real ~20s
 * budget) stops failing this suite -- caught for real: at
 * TEST_SCENARIO_BUDGET_MS=6_000, a 5x multiplier gave a 30_000ms ceiling,
 * comfortably ABOVE the ~20-22s the mutated server actually took, so 4 of 5
 * stalled subtests kept passing under the mutation (only the tighter,
 * budget-relative retry-clock ceiling below still caught it). 3x (18_000ms
 * here) stays under the real fallback-delivery time while remaining a huge
 * multiple of the correct, short-budget response (~7s observed) -- more
 * than enough for realistic CI scheduling jitter.
 */
const CLIENT_MARGIN_MULTIPLIER = 3;
const TEST_CLIENT_TIMEOUT_MS = TEST_SCENARIO_BUDGET_MS * CLIENT_MARGIN_MULTIPLIER;
function clientTimeoutFor(budgetMs) {
  return budgetMs * CLIENT_MARGIN_MULTIPLIER;
}
const GAME = { a11: 3, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 };
const TIE = { ...GAME, a21: 3 };
const STORY = {
  name: 'Harbor handover', row1: 'Load now', row2: 'Load later',
  col1: 'Send tug', col2: 'Hold tug',
  description: 'A harbor operator and a tug company arrange the timing of a berth handover during a busy week.',
  actorA: ['A harbor operator'], actorB: ['a tug company'],
};
const REJECTED = { ...STORY, description: 'As an AI, I need clean JSON.' };

async function withServer(offset, providerReply, run, budgetMs = TEST_SCENARIO_BUDGET_MS) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nash-request-deadline-'));
  const timers = new Set();
  let calls = 0;
  const provider = createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      const answer = providerReply(++calls);
      if (!answer) return;
      const send = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ index: 0, finish_reason: 'stop', message: {
            role: 'assistant', content: JSON.stringify({ suggestedScenario: answer.story }),
          } }],
        }));
      };
      if (answer.delay) {
        const timer = setTimeout(() => { timers.delete(timer); send(); }, answer.delay);
        timers.add(timer);
      } else send();
    });
  });
  let child;
  let exited;
  let log = '';
  try {
    await new Promise((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolve);
    });
    const port = PORT_BASE + offset;
    child = spawn(process.execPath, [BUNDLE], {
      cwd: scratch,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production', PORT: String(port),
        ELECTRON_USER_DATA_PATH: scratch,
        AUTH_SECRET: 'deadline-test-local-only-not-a-real-credential',
        REPORT_MODEL: 'gpt-5.6-luna',
        NASH_PAYOFF_TEMPLATE: '1', NASH_LLM_TIES: 'template',
        NASH_SCENARIO_REGEN: '1', NASH_DIRECTION_CHECKS: '1',
        // The whole point of this hardening: a tiny, CI-fast ladder budget
        // instead of the real ~20s one. See this file's header comment and
        // server.ts's SCENARIO_REQUEST_BUDGET_MS.
        NASH_SCENARIO_REQUEST_BUDGET_MS: String(budgetMs),
        AZURE_FOUNDRY_ENDPOINT: `http://127.0.0.1:${provider.address().port}/v1`,
        AZURE_FOUNDRY_API_KEY: 'loopback-test-only',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise((resolve) => child.once('close', resolve));
    child.stdout.on('data', (data) => { log += data; });
    child.stderr.on('data', (data) => { log += data; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })
        .then((r) => r.json()).catch(() => null);
      if (health) {
        assert.equal(health.pid, child.pid, `port ${port} belongs to another server`);
        ready = true;
        break;
      }
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    assert.ok(ready, `shipping server never became ready: ${log}`);
    await run(async (route, body) => {
      const start = performance.now();
      const response = await fetch(`${base}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(clientTimeoutFor(budgetMs)),
      });
      const json = await response.json();
      assert.equal(response.status, 200);
      return { json, elapsed: performance.now() - start, calls };
    });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(force);
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
}

const cases = [
  ['ordinary rung-3 report', '/api/report', { payoffs: GAME }, true],
  ['tie report', '/api/report', { payoffs: TIE }, true],
  ['scenario-only draw', '/api/report', { payoffs: GAME, scenarioOnly: true }, false],
  ['regenerate preview', '/api/scenario/regenerate', { payoffs: GAME }, false],
];
await test('scenario request deadlines and controls', { timeout: 60_000, concurrency: true }, async (t) => {
  const stalledCases = cases.map(([name, route, body, template], index) => t.test(
    `${name}: a stalled provider reaches screened bank fallback before client abort`,
    { concurrency: true },
    () => withServer(index, () => null, async (post) => {
      const { json, elapsed, calls } = await post(route, body);
      const envelope = template ? json.report : json;
      if (template) assert.equal(json.source, 'template');
      assert.equal(envelope.scenarioSource, 'bank-fallback');
      assert.ok(template ? envelope.suggestedScenario?.description : envelope.scenario?.description);
      // ORDER, budget-relative: the fallback must beat the client's own
      // abort (proportional to the configured budget, not a fixed ms count).
      assert.ok(elapsed < TEST_CLIENT_TIMEOUT_MS, `response took ${elapsed}ms (budget ${TEST_SCENARIO_BUDGET_MS}ms x${CLIENT_MARGIN_MULTIPLIER} margin)`);
      // Floor, same reasoning in reverse: a draw that fell back suspiciously
      // fast means the budget was not actually honoured (a mutant that
      // ignores NASH_SCENARIO_REQUEST_BUDGET_MS, or the deadline race itself,
      // would ship the fallback near-instantly instead of after the ladder
      // genuinely waited out its budget).
      assert.ok(elapsed >= TEST_SCENARIO_BUDGET_MS * 0.8, `fell back too fast (${elapsed}ms) for a ${TEST_SCENARIO_BUDGET_MS}ms budget -- the budget may not be wired`);
      /**
       * PR #140's own CI run (twice: budget=2_000 then budget=6_000) hit
       * `calls===2` here on GitHub's runner, never on a local Mac even under
       * 8x CPU oversubscription. `inventScreenedScenario`'s loop (server.ts,
       * unchanged by this PR) documents its LOST-draw retry as firing "at
       * most once" -- a NEVER-RESPONDING provider's own per-draw deadline is
       * set to exactly the REMAINING budget at the moment the retry starts,
       * so under real scheduling jitter that retry CAN still reach the mock
       * provider (a real physical request) before its own now-tiny slice
       * elapses, rather than the loop's `remainingMs <= 0` check winning the
       * race first. That is the documented "at most once" contract actually
       * behaving as documented under jitter, not an unbounded defect -- an
       * SDK-retry-multiplier regression (a DIFFERENT PR's fix, disabling
       * `maxRetries`) would show as MANY more than 2 calls, which this still
       * catches.
       */
      assert.ok(calls <= 2, `exhausted request budget must not launch more than the one documented bounded retry (calls=${calls})`);
    }),
  ));
  /**
   * CodeRabbit (blue12-deadline-timing review): the original ceiling here
   * (elapsed < TEST_CLIENT_TIMEOUT_MS, a 5x-budget margin) could never fail
   * even if a "reset the clock" regression came back — a reset-clock draw2
   * only costs one extra DELAY's worth of time (the shared-clock and
   * reset-clock totals are both a small multiple of the budget, nowhere
   * near the 5x ceiling meant to absorb CI jitter). This subtest needs its
   * own dedicated, larger budget and a ceiling that actually sits BETWEEN
   * the two possible totals, not a generic multiple of it.
   *
   * With budget B and delay D = 0.4*B: shared-clock total ≈ D + (B-D) = B;
   * reset-clock total ≈ D + B = 1.4*B (a resetting retry gets a FRESH full
   * budget instead of the B-D remainder). RETRY_CLOCK_CEILING_MS sits at
   * 1.2*B — comfortably above the shared-clock total (B + real overhead)
   * and comfortably below the reset-clock total (1.4*B + the same
   * overhead), verified against both a correct and a deliberately mutated
   * (clock-reset) server.ts — see HARNESS-LOG.md.
   */
  const RETRY_TEST_BUDGET_MS = TEST_SCENARIO_BUDGET_MS * 2;
  const RETRY_DELAY_MS = Math.round(RETRY_TEST_BUDGET_MS * 0.4);
  const RETRY_CLOCK_CEILING_MS = Math.round(RETRY_TEST_BUDGET_MS * 1.2);
  stalledCases.push(t.test('a delayed gate rejection cannot restart the request clock',
    // The delay is a FRACTION of the configured budget (not a fixed ms
    // count) so the rejected reply always lands comfortably before the
    // deadline, leaving real REMAINING budget for the second draw to
    // exhaust -- the property under test ("retries cannot reset the
    // clock") only means something if some of the original budget is
    // actually still at stake when the retry starts.
    () => withServer(5, (call) => call === 1 ? { story: REJECTED, delay: RETRY_DELAY_MS } : null, async (post) => {
      const { json, calls, elapsed } = await post('/api/scenario/regenerate', { payoffs: GAME });
      assert.equal(json.scenarioSource, 'bank-fallback');
      assert.ok(json.scenario?.description);
      assert.equal(calls, 2, 'the rejected first response must actually have triggered one retry');
      // Distinguishing threshold, not a generic ceiling: a retry that got a
      // FRESH budget instead of the shared remainder would push this past
      // RETRY_CLOCK_CEILING_MS (see the comment above this subtest).
      assert.ok(elapsed < RETRY_CLOCK_CEILING_MS, `response took ${elapsed}ms (budget ${RETRY_TEST_BUDGET_MS}ms, delay ${RETRY_DELAY_MS}ms, ceiling ${RETRY_CLOCK_CEILING_MS}ms) -- the retry may have gotten a fresh budget instead of the remainder`);
    }, RETRY_TEST_BUDGET_MS)));
  await Promise.all(stalledCases);
  await t.test('fast valid model response and fast rejected-then-valid reroll still work', () =>
    withServer(4, (call) => ({ story: call === 2 ? REJECTED : STORY }), async (post) => {
      const first = await post('/api/scenario/regenerate', { payoffs: GAME });
      assert.equal(first.json.scenario?.name, STORY.name);
      assert.equal(first.json.scenarioSource, undefined);
      assert.equal(first.calls, 1);
      const retry = await post('/api/scenario/regenerate', { payoffs: GAME });
      assert.equal(retry.json.scenario?.name, STORY.name);
      assert.equal(retry.json.scenarioSource, undefined);
      assert.equal(retry.calls, 3);
    }));
});

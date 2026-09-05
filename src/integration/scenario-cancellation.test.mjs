/** BLUE-CANCEL-12: an abandoned scenario draw must be CANCELLED, not left to
 * keep making physical provider requests after nobody is waiting on it.
 *
 * Reproduced against the shipping bundle before this fix (own harness, not
 * reused unmodified from the handback's probe — see
 * round12/notes/BLUE-CANCEL-12/repro-before-fix.log for the raw numbers):
 *   429 storm (2 logical draws): 6 physical requests
 *   client abort mid-flight:     2 physical requests (1 after the client left)
 *   late 503 after fallback:     2 physical requests (1 orphaned retry)
 * After the fix (repro-after-fix.log): 2, 1, 1 respectively.
 *
 * Run against dist/server.cjs, from an empty cwd, with loopback providers only
 * — same shape as scenario-request-deadline.test.mjs, whose 6 subtests this
 * file does not repeat or replace.
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
const PORT_BASE = Number(process.env.CANCELLATION_TEST_PORT || 4800);
const GAME = { a11: 3, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 };
const GOOD = {
  choices: [{
    index: 0, finish_reason: 'stop',
    message: { role: 'assistant', content: JSON.stringify({ suggestedScenario: {
      name: 'Harbor handover', row1: 'Load now', row2: 'Load later',
      col1: 'Send tug', col2: 'Hold tug',
      description: 'A harbor operator and a tug company arrange the timing of a berth handover during a busy week.',
    } }) },
  }],
};

/**
 * Same production model/flags as scenario-request-deadline.test.mjs, plus a
 * loopback provider that records every PHYSICAL request with a timestamp and
 * asserts its body carries no `reasoning_effort` — pinned per COMMON.md/the
 * brief: REPORT_MODEL=gpt-5.6-luna, no reasoning override anywhere on this
 * path.
 */
async function withServer(offset, providerReply, run) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nash-cancellation-'));
  const timers = new Set();
  const events = [];
  const provider = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.model, 'gpt-5.6-luna', 'production model pin');
      assert.equal(body.reasoning_effort, undefined, 'no reasoning override on this path');
      const call = events.length + 1;
      events.push({ call, ms: Math.round(performance.now() - events.start) });
      const answer = providerReply(call);
      if (!answer) return; // connection accepted, never answered — the orphan case
      const send = () => {
        res.writeHead(answer.status || 200, { 'content-type': 'application/json', ...answer.headers });
        res.end(JSON.stringify(answer.body ?? GOOD));
      };
      if (answer.delay) {
        const timer = setTimeout(() => { timers.delete(timer); send(); }, answer.delay);
        timers.add(timer);
      } else send();
    });
  });
  events.start = 0;
  let child;
  let exited;
  let log = '';
  try {
    await new Promise((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolve);
    });
    events.start = performance.now();
    const port = PORT_BASE + offset;
    child = spawn(process.execPath, [BUNDLE], {
      cwd: scratch,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production', PORT: String(port),
        ELECTRON_USER_DATA_PATH: scratch,
        AUTH_SECRET: 'cancellation-test-local-only-not-a-real-credential',
        REPORT_MODEL: 'gpt-5.6-luna',
        NASH_PAYOFF_TEMPLATE: '1', NASH_LLM_TIES: 'template',
        NASH_SCENARIO_REGEN: '1', NASH_DIRECTION_CHECKS: '1',
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
    await run(base, events);
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

await test('scenario cancellation: abandoned draws stop making physical requests', { timeout: 60_000, concurrency: true }, async (t) => {
  await t.test('client disconnect mid-flight starts no further physical request', () =>
    withServer(0, (call) => (call === 1 ? { delay: 1500, status: 503, body: { error: { message: 'controlled retry' } } } : {}), async (base, events) => {
      // Mutation this fixture cannot pass by coincidence against: the client
      // genuinely leaves (500ms abort) well before the provider's own 1500ms
      // delayed 503 even arrives, so a passing "no second request" here can
      // only mean the ladder actually stopped retrying, not that the retry
      // never had a reason to fire.
      await assert.rejects(
        fetch(`${base}/api/scenario/regenerate`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payoffs: GAME }), signal: AbortSignal.timeout(500),
        }),
        /AbortError|TimeoutError/,
      );
      // Grace window: the pre-fix defect's own second request landed ~1.9s
      // after the client left (repro-before-fix.log call 2 at ms:2600 against
      // an abort at ms:500-ish) — this window would have caught it.
      await sleep(3500);
      assert.equal(events.length, 1, `expected exactly 1 physical request, got ${events.length}: ${JSON.stringify(events)}`);
    }));

  await t.test('a late response after the fallback was already sent starts no further request', () =>
    withServer(1, (call) => (call === 1 ? { delay: 21_000, status: 503, body: { error: { message: 'late retry' } } } : {}), async (base, events) => {
      const start = performance.now();
      const response = await fetch(`${base}/api/scenario/regenerate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payoffs: GAME }), signal: AbortSignal.timeout(22_000),
      });
      const json = await response.json();
      assert.equal(response.status, 200);
      assert.equal(json.scenarioSource, 'bank-fallback');
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 22_000, `response took ${elapsed}ms`);
      // Grace window: the pre-fix orphaned retry landed ~1.4s after the
      // delayed 503 actually arrived (well past when the fallback had
      // already gone out) — this window would have caught it.
      await sleep(3500);
      assert.equal(events.length, 1, `expected exactly 1 physical request, got ${events.length}: ${JSON.stringify(events)}`);
    }));

  await t.test('a 429 storm costs one physical request per logical draw, not the SDK retry multiplier', () =>
    withServer(2, () => ({ status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'local controlled limit' } } }), async (base, events) => {
      const response = await fetch(`${base}/api/scenario/regenerate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payoffs: GAME }), signal: AbortSignal.timeout(22_000),
      });
      const json = await response.json();
      assert.equal(response.status, 200);
      assert.equal(json.scenarioSource, 'bank-fallback');
      // The ladder's own "LOST" path retries exactly once (2 logical draws);
      // each must cost exactly ONE physical request now that the SDK's own
      // retry (maxRetries) is disabled. 6 physical requests (the pre-fix
      // number) would mean the multiplier is back.
      assert.equal(events.length, 2, `expected exactly 2 physical requests (one per logical draw), got ${events.length}: ${JSON.stringify(events)}`);
    }));

  await t.test('control: a fast valid draw costs exactly one physical request', () =>
    withServer(3, () => ({ body: GOOD }), async (base, events) => {
      const response = await fetch(`${base}/api/scenario/regenerate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payoffs: GAME }), signal: AbortSignal.timeout(22_000),
      });
      const json = await response.json();
      assert.equal(response.status, 200);
      assert.equal(json.scenario?.name, 'Harbor handover');
      assert.equal(json.scenarioSource, undefined);
      assert.equal(events.length, 1);
    }));

  await t.test('control: a fast rejected-then-valid reroll still recovers within budget', () =>
    withServer(4, (call) => (call === 1
      ? { body: { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ suggestedScenario: { name: 'Bad', row1: 'A', row2: 'B', col1: 'C', col2: 'D', description: 'As an AI, I need clean JSON.' } }) } }] } }
      : { body: GOOD }), async (base, events) => {
      const response = await fetch(`${base}/api/scenario/regenerate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payoffs: GAME }), signal: AbortSignal.timeout(22_000),
      });
      const json = await response.json();
      assert.equal(response.status, 200);
      assert.equal(json.scenario?.name, 'Harbor handover');
      assert.equal(json.scenarioSource, undefined);
      assert.equal(events.length, 2, 'the rejected first draw must actually have cost one retry');
    }));
});

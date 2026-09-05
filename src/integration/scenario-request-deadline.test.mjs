/** Shipping HTTP regressions: scenario retries must fit the browser's 22s budget.
 * Run against dist/server.cjs, from an empty cwd, with loopback providers only.
 * A hanging provider used to consume 20s PER draw, so its bank rescue at 40s
 * was unreachable by the real client. Both templates and regeneration share it.
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
const CLIENT_TIMEOUT_MS = 22_000;
const GAME = { a11: 3, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 };
const TIE = { ...GAME, a21: 3 };
const STORY = {
  name: 'Harbor handover', row1: 'Load now', row2: 'Load later',
  col1: 'Send tug', col2: 'Hold tug',
  description: 'A harbor operator and a tug company arrange the timing of a berth handover during a busy week.',
  actorA: ['A harbor operator'], actorB: ['a tug company'],
};
const REJECTED = { ...STORY, description: 'As an AI, I need clean JSON.' };

async function withServer(offset, providerReply, run) {
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
        body: JSON.stringify(body), signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
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
      assert.ok(elapsed < CLIENT_TIMEOUT_MS, `response took ${elapsed}ms`);
      assert.equal(calls, 1, 'exhausted request budget must not launch a second provider call');
    }),
  ));
  stalledCases.push(t.test('a delayed gate rejection cannot restart the request clock',
    () => withServer(5, (call) => call === 1 ? { story: REJECTED, delay: 6000 } : null, async (post) => {
      const { json, calls, elapsed } = await post('/api/scenario/regenerate', { payoffs: GAME });
      assert.equal(json.scenarioSource, 'bank-fallback');
      assert.ok(json.scenario?.description);
      assert.equal(calls, 2, 'the rejected first response must actually have triggered one retry');
      assert.ok(elapsed < CLIENT_TIMEOUT_MS);
    })));
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

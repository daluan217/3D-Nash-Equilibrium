/* INTEGRATION — RED-CLOUD-21 angle 3 (BLUE-LOOP-CLOUD-22): /api/report under a
 * faulty model provider, in the shipping condition (production bundle, empty
 * cwd, REPORT_MODEL=gpt-5.6-luna, cloudbuild's flags, no `reasoning`). Every
 * fault must still answer 200 with the solver's template report and a bank
 * scenario, never an error inside a 200, a stack, or the provider's key. A
 * hang must end inside the scenario budget. CONTROL: an answering provider's
 * scenario reaches the gate (its drop is logged), so the fake is really called.
 *
 * Mutation-proven: M54 (no scenario deadline), M55 (no bank fallback), M56c
 * (provider logs the upstream error, key included), M57 (regenerate refuses
 * the bank fallback) each fail a check below.
 *
 *   node src/integration/report-provider-faults.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForOwnServer } from './ownserver.mjs';

const serverDir = path.resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.RPF_TEST_PORT || 3182);
const STUB_PORT = Number(process.env.RPF_STUB_PORT || 3183);
const BASE = `http://127.0.0.1:${PORT}`;
const CANARY = 'sk-RPF-CANARY-7f3a91';
const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let mode = 'ok', calls = 0;
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const stub = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    calls++;
    if (mode === 'hang') return; // never answers
    if (mode === '500') return json(res, 500, { error: { message: 'internal server error (fault-injected)' } });
    if (mode === '429') return json(res, 429, { error: { message: 'rate limited (fault-injected)' } });
    if (mode === 'echo-key') return json(res, 500, { error: { message: `upstream key AZURE_FOUNDRY_API_KEY=${CANARY} rejected` } });
    if (mode === 'empty') return json(res, 200, { choices: [{ message: { role: 'assistant', content: '' } }], usage: {} });
    if (mode === 'truncated') return json(res, 200, { choices: [{ message: { role: 'assistant', content: '{"suggestedScenario": {"name": "Broken' } }], usage: {} });
    if (mode === 'not-json') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('not json at all <<<>>>'); }
    return json(res, 200, { id: 'rpf', object: 'chat.completion', created: 0, model: 'gpt-5.6-luna', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ suggestedScenario: {
        name: 'Fake Provider Scenario', row1: 'Option Alpha', row2: 'Option Beta', col1: 'Choice One', col2: 'Choice Two',
        description: 'A synthetic scenario for fault-injection testing, at least twelve words long so it counts as usable here.', storyClaims: null } }) } }] });
  });
});
const stop = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
  const t = setTimeout(() => child.kill('SIGKILL'), 4000); child.once('exit', () => { clearTimeout(t); resolve(); }); child.kill('SIGTERM');
});

await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
const cwd = mkdtempSync(path.join(tmpdir(), 'nash-rpf-'));
const child = spawn('node', [path.join(serverDir, 'dist/server.cjs')], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
  PATH: process.env.PATH, HOME: cwd, NODE_ENV: 'production', PORT: String(PORT), REPORT_MODEL: 'gpt-5.6-luna',
  NASH_PAYOFF_TEMPLATE: '1', NASH_LLM_TIES: 'template', NASH_DIRECTION_CHECKS: '1', NASH_SCENARIO_REGEN: '0', NASH_SCENARIO_TIMEOUT_MS: '3000',
  AZURE_FOUNDRY_ENDPOINT: `http://127.0.0.1:${STUB_PORT}/v1`, AZURE_FOUNDRY_API_KEY: CANARY } });
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
try {
  await waitForOwnServer(child, BASE, { timeoutMs: 10000 });
  const games = [{ a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 }, { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 }];
  const MODES = ['ok', 'hang', '500', '429', 'echo-key', 'empty', 'truncated', 'not-json'];
  const seen = [];
  for (const [k, m] of MODES.entries()) {
    mode = m; const c0 = calls, t = Date.now();
    const payoffs = { ...games[k % 2], a11: games[k % 2].a11 + k * 0.5 }; // distinct games: no cache hit
    let status = 0, text = '', body = null;
    try {
      const r = await fetch(`${BASE}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payoffs, bypassCache: true }), signal: AbortSignal.timeout(30000) });
      status = r.status; text = await r.text(); body = JSON.parse(text);
    } catch (e) { text = String(e); }
    seen.push({ m, status, ms: Date.now() - t, calls: calls - c0, source: body?.source, sc: body?.report?.scenarioSource, name: body?.report?.suggestedScenario?.name,
      leak: text.includes(CANARY) || /AZURE_FOUNDRY|fault-injected|\bat [\w.<>]+ \(|\.ts:\d+/.test(text), errIn200: status === 200 && (!!body?.error || !body?.report) });
  }
  // "New AI scenario" (scenarioOnly) under the same faults: a bank story, never
  // provider text. Its `failure` is typed ProviderFailure, so tsc (lint) is what
  // stops a provider's message being forwarded there.
  const only = [];
  for (const [k, m] of ['500', 'echo-key', 'not-json'].entries()) {
    mode = m;
    const payoffs = { ...games[0], a12: k + 0.25 };
    const r = await fetch(`${BASE}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payoffs, scenarioOnly: true, bypassCache: true }), signal: AbortSignal.timeout(30000) });
    const text = await r.text(); let b = null; try { b = JSON.parse(text); } catch {}
    only.push({ m, status: r.status, scenario: !!b?.scenario, failure: b?.failure ?? null, sc: b?.scenarioSource ?? null, leak: text.includes(CANARY) || /AZURE_FOUNDRY|fault-injected|\bat [\w.<>]+ \(/.test(text) });
  }
  const ok = seen[0];
  record('fixture: the fake provider was called in every mode, and the answering one reached the gate (logged drop)',
    seen.every((s) => s.calls >= 1) && /rung-3 scenario dropped/.test(log), JSON.stringify(seen.map((s) => [s.m, s.calls])));
  record('THE DEFECT: every provider fault answers 200 with the template report and a bank scenario, never an error inside a 200',
    seen.every((s) => s.status === 200 && s.source === 'template' && s.sc === 'bank-fallback' && typeof s.name === 'string' && s.name.length > 0 && !s.errIn200),
    JSON.stringify(seen.map((s) => [s.m, s.status, s.source, s.sc, !!s.name, s.errIn200])));
  record('THE DEFECT: no response body carries the provider key, its error text, or a stack; the server log never prints the key',
    seen.every((s) => !s.leak) && !log.includes(CANARY), JSON.stringify(seen.filter((s) => s.leak).map((s) => s.m)) + ` logKey=${log.includes(CANARY)}`);
  record('THE DEFECT: a provider that never answers is cut off inside the scenario budget (answer < 15s)',
    seen[1].ms < 15000 && seen[1].status === 200, `hang ${seen[1].ms}ms`);
  record('THE DEFECT: "New AI scenario" under a failing provider answers a bank scenario, never provider text',
    only.every((o) => o.status === 200 && !o.leak && o.scenario && o.sc === 'bank-fallback' && o.failure === null), JSON.stringify(only));
  record('CONTROL: an answering provider is fast (the fault timings are the faults, not the harness)', ok.ms < 5000, `ok ${ok.ms}ms`);
} finally {
  await stop(child); await new Promise((r) => stub.close(r)); rmSync(cwd, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length || results.length !== 6) process.exit(1);

/* INTEGRATION — RED-CLOUD-8/001: model-created scenarios must respect the
 * client/save field budgets before the hosted regenerate route returns them.
 *
 * The unfixed route returned a claim-free model scenario with a 1,979-character
 * description or a 96-character name as HTTP 200. The client preview showed
 * the raw value; Keep then silently cut it to 800/40, and the description could
 * end in the middle of a sentence. This test uses a local Foundry-compatible
 * stub, the real production bundle, an empty cwd and no `.env`/credentials.
 *
 *   node src/integration/cloud-output-boundary.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
const PORT = Number(process.env.COB_TEST_PORT || 3180);
const STUB_PORT = Number(process.env.COB_STUB_PORT || 3181);
const BASE = `http://127.0.0.1:${PORT}`;
const payoffs = { a11: 3, a12: -1, a21: -2, a22: 4, b11: -1, b12: 3, b21: 4, b22: -2 };
const valid = {
  name: 'Seasonal Exhibition', row1: 'Take Route', row2: 'Wait', col1: 'Open Gate', col2: 'Close Gate',
  description: 'The coastal studio prepares a seasonal exhibition. A venue manager considers a program for the coming season.',
};
const longDescription = Array.from({ length: 18 }, () => valid.description).join(' ');
const invalids = [
  { name: valid.name, row1: valid.row1, row2: valid.row2, col1: valid.col1, col2: valid.col2, description: longDescription },
  { name: 'A Scenario Name Deliberately Longer Than Eighty Characters To Probe The Shipping Output Boundary', row1: valid.row1, row2: valid.row2, col1: valid.col1, col2: valid.col2, description: valid.description },
  { name: valid.name, row1: `${'Take Route '.repeat(5)}long`, row2: valid.row2, col1: valid.col1, col2: valid.col2, description: valid.description },
];

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let stubCalls = 0;
const stub = createServer((req, res) => {
  const index = Math.floor(stubCalls / 2);
  const scenario = stubCalls % 2 === 0 ? invalids[index] : valid;
  stubCalls++;
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `cob-${stubCalls}`, object: 'chat.completion', created: 0, model: 'gpt-5.6-luna',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ suggestedScenario: scenario }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 40, total_tokens: 80 },
    }));
  });
});

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
async function call(body, ip) {
  const r = await fetch(`${BASE}/api/scenario/regenerate`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch { /* detail below */ }
  return { status: r.status, json };
}

await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
const cwd = mkdtempSync(path.join(tmpdir(), 'nash-cob-'));
const child = spawn('node', [BUNDLE], {
  cwd,
  env: {
    PATH: process.env.PATH, HOME: cwd, NODE_ENV: 'production', PORT: String(PORT), TRUST_PROXY: '1',
    REPORT_MODEL: 'gpt-5.6-luna', REPORT_REASONING: '', NASH_PAYOFF_TEMPLATE: '1', NASH_LLM_TIES: 'template', NASH_DIRECTION_CHECKS: '1',
    NASH_SCENARIO_REGEN: '1', NASH_SCENARIO_TIMEOUT_MS: '5000',
    AZURE_FOUNDRY_ENDPOINT: `http://127.0.0.1:${STUB_PORT}`, AZURE_FOUNDRY_API_KEY: 'integration-stub-only',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = ''; child.stdout.on('data', (d) => { serverLog += d; }); child.stderr.on('data', (d) => { serverLog += d; });

try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { ready = true; break; } } catch { /* boot */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  record('fixture: production bundle starts from an empty cwd', ready, serverLog.slice(-400));
  if (!ready) throw new Error(`server did not become ready\n${serverLog}`);

  for (let i = 0; i < invalids.length; i++) {
    const before = stubCalls;
    const response = await call({ payoffs }, `10.8.0.${i + 1}`);
    const sc = response.json?.scenario;
    record(`${invalids[i].description.length > 800 ? 'description' : invalids[i].name.length > 40 ? 'name' : 'label'} overflow is rerolled before response`,
      response.status === 200 && response.json?.scenarioSource === undefined && sc?.name === valid.name,
      `status=${response.status} source=${JSON.stringify(response.json?.scenarioSource)} returned=${JSON.stringify(sc)}`);
    record(`overflow case ${i + 1}: one invalid draw then one valid draw`, stubCalls - before === 2, `stubCalls=${stubCalls - before}`);
    record(`overflow case ${i + 1}: returned fields fit the client/save budgets`,
      !!sc && (sc.name?.length ?? 0) <= 40 && (sc.description?.length ?? 0) <= 800
        && [sc.row1, sc.row2, sc.col1, sc.col2].every((label) => (label?.length ?? 0) <= 40),
      sc ? `lengths=${JSON.stringify({ name: sc.name.length, description: sc.description.length, labels: [sc.row1, sc.row2, sc.col1, sc.col2].map((x) => x.length) })}` : 'no scenario');
  }
} finally {
  await stop(child); await new Promise((resolve) => stub.close(resolve)); rmSync(cwd, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);

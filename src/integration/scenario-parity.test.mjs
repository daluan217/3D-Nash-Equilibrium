/* INTEGRATION — every scenario-invention path draws, screens and REROLLS the
 * same way, and honours the same opt-out flag.
 *
 * WHY CALL COUNTS. A missing retry is invisible to any assertion on the
 * response body: a branch that draws once and a branch that draws twice both
 * return "no story" when both draws fail, and both return a story when the
 * first succeeds. The only thing that can see the difference is HOW MANY TIMES
 * THE PROVIDER WAS ASKED. So this suite counts calls against a mock provider
 * rather than inspecting prose. (The mock's response shapes are adapted from
 * RED-PIPELINE's harness, which is what found these.)
 *
 * WHAT DRIFTED, three times, always split on the MATRIX rather than on anything
 * the user does:
 *   SCREENING — unified in #56.
 *   THE RETRY — not unified, and with the polarity reversed so the 12.7% tie
 *     minority became the weak side. Measured on the shipped bank at n=3000 per
 *     cell: the SAME BUTTON returned no story for 1.30% of tie-game presses and
 *     0.00% of non-tie presses, z=6.3.
 *   THE OPT-OUT FLAG — `NASH_SCENARIO_CHECKS=0` was read only on paths
 *     production does not serve, so an operator flipping it to measure the
 *     scenario gate's effect on the report path saw no difference at all.
 *
 * The server is booted from a temp cwd so `dotenv` cannot load the repo's .env
 * and hand it real credentials; the only provider it can reach is the mock.
 *
 *   node src/integration/scenario-parity.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── the mock provider ───────────────────────────────────────────────────────
let calls = 0;
let mode = 'nullscenario';
const STORY = {
  name: 'Mock Harbor Run', row1: 'Load Now', row2: 'Load Later',
  col1: 'Send Tug', col2: 'Hold Tug', storyClaims: null,
  description: 'A harbor operator and a tug company settle on how to time a single berth handover during a busy week.',
};
// Well formed but fails the claim-free screen: the description cites a number.
const CLAIMY = { ...STORY, description: 'A harbor operator and a tug company settle a berth handover, and the operator earns 4 when the tug arrives early.' };

const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls++;
    // 'hang' accepts the POST and never answers and never closes — the shape
    // that held a user's request open for 13m18s with no timeout at any layer.
    if (mode === 'hang') return;
    const content = mode === 'nullscenario' ? JSON.stringify({ suggestedScenario: null })
      : mode === 'claimy' ? JSON.stringify({ suggestedScenario: CLAIMY })
      : JSON.stringify({ suggestedScenario: STORY });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }));
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = mock.address().port;

// ── the server under test ───────────────────────────────────────────────────
const userData = mkdtempSync(path.join(tmpdir(), 'nash-parity-'));
let child = null;
let PORT = Number(process.env.PARITY_PORT || 3251);

async function boot(extraEnv = {}) {
  child = spawn('node', [BUNDLE], {
    cwd: userData, // NOT the repo — no .env, so the mock is the only provider
    env: {
      PATH: process.env.PATH, HOME: userData,
      NODE_ENV: 'production', PORT: String(PORT),
      NASH_PAYOFF_TEMPLATE: '1', NASH_LLM_TIES: 'template', NASH_DIRECTION_CHECKS: '1',
      REPORT_MODEL: 'gpt-5.6-luna',
      AZURE_FOUNDRY_ENDPOINT: `http://127.0.0.1:${MOCK_PORT}/v1`,
      AZURE_FOUNDRY_API_KEY: 'mockkey',
      // NOT IS_ELECTRON: the bundled bank would answer without any provider
      // call at all and the counts would all be zero.
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became ready on ${PORT}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const t = setTimeout(() => child.kill('SIGKILL'), 4000);
  await ended; clearTimeout(t); child = null;
}
async function post(body) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/report`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// RED-BANK-2's band-matched fixtures. THE BAND MATTERS: `pickFromBank`'s ladder
// is band-locked in its first two tiers, so a game whose stakes band holds no
// rejectable row can never exercise the gate however many times it is drawn —
// an all-zero matrix looks like the perfect adversarial fixture and is in fact
// green whether or not the defect is present.
const TIE = { a11: 50, a12: -30, a21: 50, a22: 20, b11: 50, b12: -30, b21: 50, b22: 20 };
const NONTIE = { a11: 90, a12: -40, a21: -40, a22: 70, b11: 90, b12: -40, b21: -40, b22: 70 };

async function countCalls(body) {
  calls = 0;
  const res = await post(body);
  return { calls, res };
}

try {
  await boot();

  // ── 1. EVERY BRANCH REROLLS A LOST DRAW ───────────────────────────────────
  mode = 'nullscenario'; // the draw never comes back — the `max-tokens` shape
  for (const [label, body] of [
    ['rung-3 report path (non-tie)', { payoffs: NONTIE }],
    ['tie report path', { payoffs: TIE }],
    ['"New AI scenario" on a non-tie game', { payoffs: NONTIE, scenarioOnly: true }],
    ['"New AI scenario" on a TIE game', { payoffs: TIE, scenarioOnly: true }],
  ]) {
    const { calls: n } = await countCalls(body);
    record(`${label} draws twice when the first draw is lost`, n === 2, `${n} provider call(s), expected 2`);
  }

  // ── 2. EVERY BRANCH REROLLS A GATE REJECTION ──────────────────────────────
  mode = 'claimy'; // well formed, but the description cites a number
  for (const [label, body] of [
    ['rung-3 report path (non-tie)', { payoffs: NONTIE }],
    ['tie report path', { payoffs: TIE }],
    ['"New AI scenario" on a non-tie game', { payoffs: NONTIE, scenarioOnly: true }],
    ['"New AI scenario" on a TIE game', { payoffs: TIE, scenarioOnly: true }],
  ]) {
    const { calls: n, res } = await countCalls(body);
    const story = res.json?.report?.suggestedScenario ?? res.json?.scenario ?? null;
    record(`${label} draws twice when the first draw fails the gate`, n === 2, `${n} provider call(s), expected 2`);
    record(`${label} withholds the rejected story`, story === null || story === undefined, JSON.stringify(story)?.slice(0, 60));
  }

  // ── 3. A GOOD DRAW COSTS EXACTLY ONE CALL (the reroll is not unconditional) ─
  mode = 'ok';
  for (const [label, body] of [
    ['rung-3 report path', { payoffs: NONTIE }],
    ['tie report path', { payoffs: TIE }],
  ]) {
    const { calls: n, res } = await countCalls(body);
    record(`${label} spends one call when the first draw is good`, n === 1, `${n} provider call(s), expected 1`);
    record(`${label} ships that story`, res.json?.report?.suggestedScenario?.name === 'Mock Harbor Run',
      res.json?.report?.suggestedScenario?.name ?? 'none');
  }

  // ── 4. "SUPPLIED" MEANS USABLE, NOT MERELY PRESENT ────────────────────────
  // The save dialog requires only a NAME, and the server manufactures a
  // description for saved games, so a name-only scenario is the DEFAULT SAVE
  // PATH — four clicks from the front page. `cleanScenario` returns an object
  // whenever ANY field is non-empty, so a bare-truthy test treated that as "the
  // user already has a scenario" and rung 3 then neither used it nor replaced
  // it: generic Row/Col prose and no story, on every explain, forever.
  mode = 'ok';
  {
    const { calls: n, res } = await countCalls({ payoffs: NONTIE, scenario: { name: 'My Game' } });
    record('a NAME-ONLY scenario is not treated as a usable one', n === 1, `${n} provider call(s), expected 1`);
    record('a name-only scenario is offered a story',
      res.json?.report?.suggestedScenario?.name === 'Mock Harbor Run',
      res.json?.report?.suggestedScenario?.name ?? 'none');
    record('and the prose uses the invented labels rather than Row/Col',
      typeof res.json?.report?.prose === 'string' && res.json.report.prose.includes('Load Now')
      && !res.json.report.prose.includes('Row 1'),
      (res.json?.report?.prose ?? '').slice(0, 90));
  }
  // A FULLY USABLE scenario must still be left alone — the fix must not start
  // replacing scenarios the user really did supply.
  {
    const { calls: n, res } = await countCalls({
      payoffs: NONTIE,
      scenario: { name: 'Mine', row1: 'Ship early', row2: 'Ship late', col1: 'Accept', col2: 'Refuse' },
    });
    record('a fully-labelled scenario is left alone (no draw, no suggestion)',
      n === 0 && !res.json?.report?.suggestedScenario, `${n} call(s), suggestion=${!!res.json?.report?.suggestedScenario}`);
    record('and the prose uses the USER\'s labels', (res.json?.report?.prose ?? '').includes('Ship early'),
      (res.json?.report?.prose ?? '').slice(0, 70));
  }

  // ── 5. THE TIE BRANCH REPORTS WHAT ACTUALLY HAPPENED ──────────────────────
  {
    const { res } = await countCalls({ payoffs: TIE, scenarioOnly: true,
      scenario: { name: 'Mine', row1: 'Ship early', row2: 'Ship late', col1: 'Accept', col2: 'Refuse' } });
    record('tie + scenarioOnly + a usable scenario reports "scenario-supplied"',
      res.json?.failure === 'scenario-supplied', String(res.json?.failure));
  }

  await stop();

  // ── 6. NASH_SCENARIO_CHECKS=0 IS HONOURED ON THE REPORT PATHS ─────────────
  // The flag's own comment promises "each gate's effect is measurable in
  // isolation". It was read only on paths production does not serve, so
  // flipping it changed nothing on the two that it does — an instrument that
  // silently does not measure.
  PORT += 1;
  await boot({ NASH_SCENARIO_CHECKS: '0' });
  mode = 'claimy';
  for (const [label, body] of [
    ['rung-3 report path', { payoffs: NONTIE }],
    ['tie report path', { payoffs: TIE }],
  ]) {
    const { calls: n, res } = await countCalls(body);
    const story = res.json?.report?.suggestedScenario ?? null;
    record(`NASH_SCENARIO_CHECKS=0 lets the gated story through on the ${label}`,
      story?.name === 'Mock Harbor Run', story?.name ?? 'still withheld');
    record(`and it costs ONE call, not a wasted reroll (${label})`, n === 1, `${n} call(s)`);
  }
  await stop();

  // ── 7. A PROVIDER THAT NEVER ANSWERS MUST NOT HOLD THE REQUEST ────────────
  // Measured before the fix: a mock that accepts the POST and never responds
  // held /api/report open for 798 seconds — 13m18s — with exactly ONE provider
  // attempt and no timeout at any layer. The outer bound in production was
  // Cloud Run's 3600s request timeout, i.e. an hour of a spinning "Explain this
  // game" ending in "the deterministic report above still stands".
  //
  // The story is the OPTIONAL part: `suggestedScenario` may be absent on every
  // branch, and the templated report needs no model at all. So the right
  // failure is a storyless report, promptly.
  PORT += 1;
  await boot({ NASH_SCENARIO_TIMEOUT_MS: '1500' });
  mode = 'hang';
  {
    const t0 = Date.now();
    const res = await post({ payoffs: NONTIE });
    const ms = Date.now() - t0;
    // Two draws, each racing its own 1500ms deadline, so ~3s is the expected
    // shape. Anything near the SDK's own 600s budget means no deadline fired.
    record('a hung provider still returns a report, and quickly', res.status === 200 && ms < 12_000, `${ms}ms, status ${res.status}`);
    record('that report is the full templated one, just without a story',
      res.json?.source === 'template' && typeof res.json?.report?.prose === 'string'
      && res.json.report.prose.length > 40 && !res.json?.report?.suggestedScenario,
      `source=${res.json?.source} prose=${(res.json?.report?.prose ?? '').length} chars`);
    record('the deadline waited its full budget rather than firing instantly', ms > 1400, `${ms}ms`);
  }
  await stop();

  // ── 8. A MALFORMED NASH_SCENARIO_TIMEOUT_MS FALLS BACK, NOT TO AN INSTANT FIRE ──
  // Number('not-a-number') is NaN and Number('') is 0; setTimeout treats both
  // as fire-immediately, which would resolve the deadline before any provider
  // could ever answer — every draw on the whole box would silently lose its
  // scenario, with the report shipping anyway. Both malformed shapes must fall
  // back to the 20s default instead. So must a value setTimeout itself
  // normalizes to an immediate fire: anything under 1ms, and anything past
  // Node's 32-bit signed timer field (2147483647) — both passed a bare
  // `Number.isFinite && > 0` guard and fired just as instantly as NaN/0 did.
  for (const bad of ['not-a-number', '', '0.5', '2147483648']) {
    PORT += 1;
    await boot({ NASH_SCENARIO_TIMEOUT_MS: bad });
    mode = 'ok';
    const res = await post({ payoffs: NONTIE });
    record(`NASH_SCENARIO_TIMEOUT_MS=${JSON.stringify(bad)} still lets a fast draw through`,
      res.json?.report?.suggestedScenario?.name === 'Mock Harbor Run',
      res.json?.report?.suggestedScenario?.name ?? 'none (deadline fired instantly)');
    await stop();
  }
} finally {
  await stop();
  await new Promise((r) => mock.close(r));
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((f) => f.name).join(' | ')}`);
  process.exit(1);
}

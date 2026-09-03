/* INTEGRATION — FEATURE-REGEN's server route, POST /api/scenario/regenerate,
 * flag NASH_SCENARIO_REGEN (default OFF).
 *
 * The route reuses the SAME `inventScreenedScenario` ladder every other
 * invention site (rung-3 report, tie report, "New AI scenario") already goes
 * through, plus one extra reject-and-reroll rule: a draw that is the same
 * story as `current` is treated as a gate drop and rerolled, exactly like a
 * META/persona-leak drop. This suite proves, against the real built server
 * (dist/server.cjs) and a mock model provider (never the real network):
 *   - the flag actually gates the route (404 off; a real 200 on)
 *   - the capability bit on GET /api/health matches the flag AND canInvent()
 *   - the avoid gate causes an extra draw and the served story differs
 *   - ladder exhaustion falls back to the bank, re-screened, never repeating
 *     the current story
 *   - NOTHING is persisted by this route — a saved game is byte-identical
 *     after a regenerate call touches its payoffs, and the actual persist
 *     path (PATCH /api/games/:id) still clamps/strips exactly as it always
 *     has when a Keep-shaped body is sent through it
 *   - invalid input is 400; no credentials/no bank is an honest
 *     `{scenario:null, failure:'no-key'}`, never a 500
 *   - the route shares the "report" rate-limit bucket with /api/report, in
 *     BOTH directions
 *   - the desktop path never reaches the mock provider at all (bank first),
 *     and is never rate-limited (hosted-only lifts under IS_ELECTRON)
 *   - the per-draw deadline (NASH_SCENARIO_TIMEOUT_MS) is honoured on this
 *     route exactly like every other invention site
 *
 *   node src/integration/scenario-regen.test.mjs
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

// ── the mock model provider — same shape as scenario-parity.test.mjs ───────
let calls = 0;
let mode = 'story';
let sequence = null; // per-call mode, consumed by index, clamped past the end
const STORY = {
  name: 'Mock Harbor Run', row1: 'Load Now', row2: 'Load Later',
  col1: 'Send Tug', col2: 'Hold Tug',
  description: 'A harbor operator and a tug company settle on how to time a single berth handover during a busy week.',
  actorA: ['harbor operator'], actorB: ['tug company'],
};
const STORY2 = {
  name: 'Mock Kiln Slot', row1: 'Fire Early', row2: 'Fire Late',
  col1: 'Book Glaze', col2: 'Book Bisque',
  description: 'A potter and a kiln co-op are settling a shared firing slot for the week ahead.',
  actorA: ['potter'], actorB: ['co-op'],
};
// Well-formed but repeats the SAME story every draw — the avoid gate's target.
const SAME_AS_STORY = { ...STORY, description: STORY.description + ' Scheduling stays informal between them.' };

const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls++;
    const effectiveMode = sequence ? sequence[Math.min(calls - 1, sequence.length - 1)] : mode;
    if (effectiveMode === 'hang') return; // accepted, never answered — the timeout shape
    const content = effectiveMode === 'story2' ? JSON.stringify({ suggestedScenario: STORY2 })
      : effectiveMode === 'same' ? JSON.stringify({ suggestedScenario: SAME_AS_STORY })
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

// ── boot/stop the real server with whatever env this section needs ─────────
const userData = mkdtempSync(path.join(tmpdir(), 'nash-regen-'));
let child = null;
const PORT = Number(process.env.REGEN_TEST_PORT || 3160);

async function boot(extraEnv = {}) {
  child = spawn('node', [BUNDLE], {
    cwd: userData, // not the repo — dotenv finds no .env, so only what we pass exists
    env: {
      PATH: process.env.PATH, HOME: userData,
      NODE_ENV: 'production', PORT: String(PORT),
      ELECTRON_USER_DATA_PATH: userData, // auto-verify registration (persistence checks)
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) {
        const { pid } = await r.json();
        if (pid === child.pid) return;
        throw new Error(`port ${PORT} is held by pid ${pid}, not the spawned child ${child.pid}`);
      }
    } catch (err) {
      if (String(err?.message ?? '').includes('is held by pid')) throw err;
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became ready on ${PORT}\n${log}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const t = setTimeout(() => child.kill('SIGKILL'), 4000);
  await ended; clearTimeout(t); child = null;
}
async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

const PAYOFFS = { a11: 3, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 };

// Env recipe shared by every "flag ON, hosted" section — pinned per CLAUDE.md's
// harness rule (explicit REPORT_MODEL; no REPORT_REASONING override, matching
// what production actually passes).
const HOSTED_ON_ENV = {
  NASH_SCENARIO_REGEN: '1',
  REPORT_MODEL: 'gpt-5.6-luna',
  REPORT_REASONING: '',
  AZURE_FOUNDRY_ENDPOINT: `http://127.0.0.1:${MOCK_PORT}/v1`,
  AZURE_FOUNDRY_API_KEY: 'mockkey',
};

try {
  // ═══════════════════════════════════════════════════════════════════════
  // 1. FLAG OFF (default env) — the route and the capability bit agree
  // ═══════════════════════════════════════════════════════════════════════
  {
    calls = 0; mode = 'story';
    await boot({ REPORT_MODEL: 'gpt-5.6-luna', REPORT_REASONING: '',
      AZURE_FOUNDRY_ENDPOINT: `http://127.0.0.1:${MOCK_PORT}/v1`, AZURE_FOUNDRY_API_KEY: 'mockkey' });
    const health = await call('GET', '/api/health');
    record('flag OFF: /api/health capabilities.scenarioRegen is false',
      health.json?.capabilities?.scenarioRegen === false, `capabilities=${JSON.stringify(health.json?.capabilities)}`);
    const r = await call('POST', '/api/scenario/regenerate', { body: { payoffs: PAYOFFS } });
    record('flag OFF: POST /api/scenario/regenerate is 404', r.status === 404, `status=${r.status} body=${JSON.stringify(r.json)}`);
    record('flag OFF: the mock provider was never called', calls === 0, `calls=${calls}`);
    await stop();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2. FLAG ON, hosted, mock returns a clean story — one call, no fallback
  // ═══════════════════════════════════════════════════════════════════════
  {
    calls = 0; mode = 'story'; sequence = null;
    await boot(HOSTED_ON_ENV);
    const health = await call('GET', '/api/health');
    record('flag ON + credentials: /api/health capabilities.scenarioRegen is true',
      health.json?.capabilities?.scenarioRegen === true, `capabilities=${JSON.stringify(health.json?.capabilities)}`);
    const r = await call('POST', '/api/scenario/regenerate', { body: { payoffs: PAYOFFS } });
    record('flag ON: 200 with a scenario', r.status === 200 && !!r.json?.scenario, `status=${r.status} body=${JSON.stringify(r.json)}`);
    record('flag ON: scenarioSource is undefined on an ordinary model draw',
      r.json?.scenarioSource === undefined, `scenarioSource=${JSON.stringify(r.json?.scenarioSource)}`);
    record('flag ON: exactly one provider call for a clean draw', calls === 1, `calls=${calls}`);
    await stop();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3. THE AVOID GATE — a same-story draw is rerolled, not returned
  // ═══════════════════════════════════════════════════════════════════════
  {
    calls = 0; mode = null; sequence = ['same', 'story2']; // first draw repeats current, second is fresh
    await boot(HOSTED_ON_ENV);
    const r = await call('POST', '/api/scenario/regenerate', {
      body: { payoffs: PAYOFFS, current: { name: STORY.name, description: STORY.description } },
    });
    record('avoid gate: two provider calls (the same-story draw was rejected and rerolled)',
      calls === 2, `calls=${calls}`);
    record('avoid gate: the served scenario name differs from `current`',
      r.status === 200 && r.json?.scenario?.name && r.json.scenario.name !== STORY.name,
      `name=${JSON.stringify(r.json?.scenario?.name)}`);
    await stop();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 4. LADDER EXHAUSTION → BANK FALLBACK, still avoiding `current`
  // ═══════════════════════════════════════════════════════════════════════
  {
    calls = 0; mode = 'same'; sequence = null; // every draw repeats current — exhausts the reroll budget
    await boot(HOSTED_ON_ENV);
    const r = await call('POST', '/api/scenario/regenerate', {
      body: { payoffs: PAYOFFS, current: { name: STORY.name, description: STORY.description } },
    });
    record('exhaustion: the provider was asked 1 + NASH_SCENARIO_REROLLS (default 2) = 3 times',
      calls === 3, `calls=${calls}`);
    record('exhaustion: scenarioSource is exactly "bank-fallback"',
      r.json?.scenarioSource === 'bank-fallback', `scenarioSource=${JSON.stringify(r.json?.scenarioSource)}`);
    record('exhaustion: a scenario is still returned, with all four labels',
      r.status === 200 && !!(r.json?.scenario?.row1 && r.json?.scenario?.row2 && r.json?.scenario?.col1 && r.json?.scenario?.col2),
      `scenario=${JSON.stringify(r.json?.scenario)}`);
    record('exhaustion: the bank row served is NOT the same story as `current`',
      r.json?.scenario?.name !== STORY.name, `name=${JSON.stringify(r.json?.scenario?.name)}`);
    await stop();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 5. NOTHING IS PERSISTED by this route; the real Keep-shaped PATCH still
  //    clamps/strips exactly as it always has
  // ═══════════════════════════════════════════════════════════════════════
  {
    calls = 0; mode = 'story'; sequence = null;
    await boot(HOSTED_ON_ENV);
    const email = `regen-${Date.now()}@example.test`;
    const password = 'Sup3rSecret1';
    await call('POST', '/api/auth/register', { body: { username: `regen${Date.now()}`, email, password } });
    const login = await call('POST', '/api/auth/login', { body: { email, password } });
    const token = login.json?.token || '';
    const created = await call('POST', '/api/games', {
      token, body: { name: 'Regen fixture', description: 'original description', payoffs: PAYOFFS, row1Label: 'Original Row 1' },
    });
    const gameId = created.json?.game?.id || '';
    record('persistence setup: the fixture game saved', created.status === 200 && !!gameId, `status=${created.status}`);

    // A regenerate call using this game's payoffs — the route reads and
    // returns a preview; nothing about the saved row may change.
    const regen = await call('POST', '/api/scenario/regenerate', { body: { payoffs: PAYOFFS, current: { name: 'Regen fixture', description: 'original description' } } });
    record('regen route: 200 with a scenario (setup for the persistence check)', regen.status === 200 && !!regen.json?.scenario, `status=${regen.status}`);

    const after = await call('GET', '/api/games', { token });
    const stillThere = (after.json || []).find((g) => g.id === gameId);
    record('nothing persisted: the saved game is byte-identical after a regenerate call',
      stillThere?.description === 'original description' && stillThere?.row1Label === 'Original Row 1',
      `stored=${JSON.stringify({ description: stillThere?.description, row1Label: stillThere?.row1Label })}`);

    // Now actually KEEP it — simulate exactly what the client's Keep +
    // Save-Changes flow sends: PATCH with the regenerated text (deliberately
    // dirty — a bidi override, a 900-char description, a 45-char label, and
    // a colorTermsA carrying an actor noun plus a too-short one) and no
    // `payoffs` key at all, exactly like `keepFill`'s output.
    const RLO = String.fromCodePoint(0x202e);
    // A 45-char label WITH word boundaries, like keepFill's real output —
    // cutAtWordBoundary must cut at the last space under 40, not mid-word
    // (api.test.mjs's own fixture for the sibling POST/PATCH path).
    const longLabel = 'Escalate the dispute to the regional arbitration board immediately';
    const patched = await call('PATCH', `/api/games/${gameId}`, {
      token,
      body: {
        description: `${regen.json.scenario.description}${RLO} trailing`,
        row1Label: longLabel,
        colorTermsA: ['harbor operator', 'x'],
        colorTermsB: ['tug company'],
        // Deliberately hostile: a DIFFERENT matrix from PAYOFFS, so "ignored"
        // is PROVEN rather than assumed (CodeRabbit: a body with no payoffs
        // key at all can never fail this assertion, whatever the route
        // does). The client's real Keep flow never sends this key; a direct
        // caller can, and the route must still drop it.
        payoffs: { a11: -9, a12: -9, a21: -9, a22: -9, b11: -9, b12: -9, b21: -9, b22: -9 },
      },
    });
    const pg = patched.json?.game;
    record('Keep-shaped PATCH: 200 and the description is stripped of the bidi override',
      patched.status === 200 && typeof pg?.description === 'string' && !pg.description.includes(RLO),
      `status=${patched.status} description=${JSON.stringify(pg?.description)}`);
    record('Keep-shaped PATCH: the long label is clamped to <=40 chars at a word boundary, not mid-word',
      typeof pg?.row1Label === 'string' && pg.row1Label.length <= 40 && longLabel.startsWith(pg.row1Label)
        && (pg.row1Label.length === longLabel.length || longLabel[pg.row1Label.length] === ' '),
      `row1Label=${JSON.stringify(pg?.row1Label)} len=${pg?.row1Label?.length}`);
    record('Keep-shaped PATCH: colorTermsA is cleaned (the 1-char noun dropped, the real one kept)',
      Array.isArray(pg?.colorTermsA) && pg.colorTermsA.includes('harbor operator') && !pg.colorTermsA.includes('x'),
      `colorTermsA=${JSON.stringify(pg?.colorTermsA)}`);
    record('Keep-shaped PATCH: payoffs in the request body are ignored — the stored payoffs are untouched',
      pg?.payoffs?.a11 === PAYOFFS.a11 && pg?.payoffs?.a22 === PAYOFFS.a22,
      `payoffs=${JSON.stringify(pg?.payoffs)}`);

    await stop();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 6. INVALID INPUT and NO-CREDENTIALS — honest answers, never a 500
  // ═══════════════════════════════════════════════════════════════════════
  {
    calls = 0; mode = 'story';
    await boot(HOSTED_ON_ENV);
    const bad = await call('POST', '/api/scenario/regenerate', { body: { payoffs: { a11: 'not-a-number' } } });
    record('invalid payoffs → 400', bad.status === 400, `status=${bad.status} body=${JSON.stringify(bad.json)}`);
    const missing = await call('POST', '/api/scenario/regenerate', { body: {} });
    record('missing payoffs → 400', missing.status === 400, `status=${missing.status}`);
    await stop();

    // Flag ON, but NOT desktop and no credentials at all — canInvent() false.
    calls = 0;
    await boot({ NASH_SCENARIO_REGEN: '1' }); // no AZURE_FOUNDRY_* at all
    const health = await call('GET', '/api/health');
    record('no credentials, not desktop: capabilities.scenarioRegen is false',
      health.json?.capabilities?.scenarioRegen === false, `capabilities=${JSON.stringify(health.json?.capabilities)}`);
    const r = await call('POST', '/api/scenario/regenerate', { body: { payoffs: PAYOFFS } });
    record('no credentials: 200 with {scenario:null, failure:"no-key"}, never a 500',
      r.status === 200 && r.json?.scenario === null && r.json?.failure === 'no-key',
      `status=${r.status} body=${JSON.stringify(r.json)}`);
    record('no credentials: the mock provider was never called', calls === 0, `calls=${calls}`);
    await stop();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 7. SHARED "report" RATE LIMIT — the same 20/min bucket, both directions
  // ═══════════════════════════════════════════════════════════════════════
  {
    calls = 0; mode = 'story';
    await boot(HOSTED_ON_ENV);
    let sawReportBurst = true;
    for (let i = 0; i < 20; i++) {
      const r = await call('POST', '/api/report', { body: { payoffs: PAYOFFS } });
      if (r.status === 429) sawReportBurst = false;
    }
    record('rate limit setup: 20 /api/report calls all stayed under the cap', sawReportBurst);
    const regen21 = await call('POST', '/api/scenario/regenerate', { body: { payoffs: PAYOFFS } });
    record('rate limit shared (report -> regen): the 21st call, on the OTHER route, is 429',
      regen21.status === 429, `status=${regen21.status} body=${JSON.stringify(regen21.json)}`);
    await stop();

    // Fresh process, fresh rate bucket, other direction.
    await boot(HOSTED_ON_ENV);
    let sawRegenBurst = true;
    for (let i = 0; i < 20; i++) {
      const r = await call('POST', '/api/scenario/regenerate', { body: { payoffs: PAYOFFS } });
      if (r.status === 429) sawRegenBurst = false;
    }
    record('rate limit setup: 20 regenerate calls all stayed under the cap', sawRegenBurst);
    const report21 = await call('POST', '/api/report', { body: { payoffs: PAYOFFS } });
    record('rate limit shared (regen -> report): the 21st call, on the OTHER route, is 429',
      report21.status === 429, `status=${report21.status} body=${JSON.stringify(report21.json)}`);
    await stop();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 8. DESKTOP — bank first (0 provider calls even with credentials
  //    configured), reachable with NO credentials at all, never rate-limited
  // ═══════════════════════════════════════════════════════════════════════
  {
    calls = 0; mode = 'story';
    await boot({ ...HOSTED_ON_ENV, IS_ELECTRON: 'true' }); // credentials present, but desktop
    const r = await call('POST', '/api/scenario/regenerate', { body: { payoffs: PAYOFFS } });
    record('desktop with credentials configured: a scenario is served', r.status === 200 && !!r.json?.scenario, `status=${r.status}`);
    record('desktop: the bank served it, never the mock provider', calls === 0, `calls=${calls}`);
    await stop();

    // No endpoint/key configured at all — desktop must still work off the bank.
    await boot({ NASH_SCENARIO_REGEN: '1', IS_ELECTRON: 'true' });
    const health = await call('GET', '/api/health');
    record('desktop, no credentials: capabilities.scenarioRegen is true (bank makes canInvent() true)',
      health.json?.capabilities?.scenarioRegen === true, `capabilities=${JSON.stringify(health.json?.capabilities)}`);
    let none429 = true;
    for (let i = 0; i < 25; i++) {
      const rr = await call('POST', '/api/scenario/regenerate', { body: { payoffs: PAYOFFS } });
      if (rr.status === 429) none429 = false;
    }
    record('desktop: 25 regenerate calls, never a 429 (hosted-only rate limit lifted under IS_ELECTRON)', none429);
    await stop();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 9. TIMEOUT PARITY — the per-draw deadline applies to this route exactly
  //    like every other invention site
  // ═══════════════════════════════════════════════════════════════════════
  {
    calls = 0; mode = 'hang'; sequence = null;
    const deadlineMs = 1500;
    await boot({ ...HOSTED_ON_ENV, NASH_SCENARIO_TIMEOUT_MS: String(deadlineMs) });
    const started = Date.now();
    const r = await call('POST', '/api/scenario/regenerate', { body: { payoffs: PAYOFFS } });
    const elapsed = Date.now() - started;
    // Ladder: 1 lost draw + 1 timeout-retry (both governed by the SAME
    // per-draw deadline, never by NASH_SCENARIO_REROLLS) = 2 x deadline,
    // plus the bank fallback's own (near-instant) attempt. Generous margin
    // for CI scheduling jitter.
    record('timeout: the request returns well inside 2x the per-draw deadline plus slack',
      elapsed < deadlineMs * 2 + 5000, `elapsed=${elapsed}ms deadline=${deadlineMs}ms`);
    // Every draw times out, so the ladder is fully exhausted — the bank
    // fallback (always available, re-screened) rescues it, same as the
    // exhaustion case above. A scenario is still returned; scenarioSource
    // makes the rescue measurable rather than only inferred.
    record('timeout: ladder exhaustion is rescued by the bank fallback (a scenario is still returned)',
      r.status === 200 && !!r.json?.scenario && r.json?.scenarioSource === 'bank-fallback',
      `status=${r.status} body=${JSON.stringify(r.json)}`);
    await stop();
  }

} finally {
  await stop();
  rmSync(userData, { recursive: true, force: true });
  await new Promise((r) => mock.close(r));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

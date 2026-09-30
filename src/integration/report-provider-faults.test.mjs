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
 * the bank fallback), M58 (trust every X-Forwarded-For hop), M59 (proxy not
 * trusted: every client shares one bucket), M64 (IPv6 keyed per address), M65 (IPv4-mapped
 * keyed as an IPv6 /56) each fail a check below. S23-1 (gone-before-handler listener) fails the gzip hang-up check.
 * Sweep 22: M7 (payoff cell type check dropped) and M9 (cleanText coerces non-strings) fail the mistyped-field check.
 *
 *   node src/integration/report-provider-faults.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForOwnServer } from './ownserver.mjs';

const serverDir = path.resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.RPF_TEST_PORT || 3182);
const STUB_PORT = Number(process.env.RPF_STUB_PORT || 3183);
const TRUST_PROXY = /_TRUST_PROXY: '([^']+)'/.exec(readFileSync(path.join(serverDir, 'cloudbuild.yaml'), 'utf8'))?.[1];
if (!TRUST_PROXY) throw new Error('cloudbuild.yaml has no _TRUST_PROXY substitution');
const BASE = `http://127.0.0.1:${PORT}`;
const CANARY = 'sk-RPF-CANARY-7f3a91';
const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let mode = 'ok', calls = 0, open = 0;
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const stub = createServer((req, res) => {
  open++; res.on('close', () => { open--; });
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
  PATH: process.env.PATH, HOME: cwd, NODE_ENV: 'production', PORT: String(PORT), TRUST_PROXY, REPORT_MODEL: 'gpt-5.6-luna',
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
  // Sweep 23: a client that hangs up right after a gzip body is gone before the handler runs (express.json
  // inflates asynchronously), so a 'close' listener attached there never fired: 10 hang-ups cost 20 provider
  // calls, each held to the 3 s draw deadline and retried. Now every call a gone client starts is cut at once.
  mode = 'hang'; const g0 = calls;
  for (let i = 0; i < 3; i++) await new Promise((resolve) => {
    const body = gzipSync(JSON.stringify({ payoffs: { ...games[0], a22: 1.5 + i }, bypassCache: true }));
    const s = net.connect(PORT, '127.0.0.1', () => { s.write(Buffer.concat([Buffer.from(`POST /api/report HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 192.0.2.${60 + i}\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n`), body])); s.destroy(); });
    s.on('close', resolve); s.on('error', () => {});
  });
  await new Promise((r) => setTimeout(r, 1500)); const openAt1500 = open, callsAt1500 = calls - g0;
  await new Promise((r) => setTimeout(r, 3000)); // past the 3 s draw deadline: an uncancelled ladder retries here
  record('THE DEFECT: a client that hangs up after sending a gzip body starts no provider call that outlives it',
    openAt1500 === 0 && calls - g0 <= 3, `3 hang-ups: ${callsAt1500} provider calls by 1.5 s (${openAt1500} still open), ${calls - g0} by 4.5 s`);
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
  // Google's front end APPENDS the real client to X-Forwarded-For; a client can
  // prepend anything. Rotating the prepended hop must not buy a fresh report
  // budget (live 2026-09-24: #21 of 24 spoofed POSTs was 429).
  const post = (xff) => fetch(`${BASE}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: '{"payoffs":{"a11":"x"}}' }).then((r) => r.status);
  const spoofed = [];
  for (let i = 1; i <= 21; i++) spoofed.push(await post(`203.0.113.${i}, 198.51.100.7`));
  const other = await post('203.0.113.1, 198.51.100.8');
  record(`THE DEFECT: a rotated spoofed X-Forwarded-For hop does not reset the report limit (TRUST_PROXY=${TRUST_PROXY} from cloudbuild)`,
    spoofed.slice(0, 20).every((s) => s === 400) && spoofed[20] === 429 && other === 400, `spoofed=${spoofed.join(',')} otherClient=${other}`);
  // IPv6 (live, sweep 9): the real client is keyed by its /56, not its address.
  const burst = async (hops) => { const out = []; for (const h of hops) out.push(await post(h)); return out; };
  const n21 = [...Array(21).keys()];
  const v6 = await burst(n21.map((i) => `2001:db8:1:1${i.toString(16).padStart(2, '0')}::${i + 1}`));
  const v6other = await post('2001:db8:1:200::1');
  const v6spoof = await burst(n21.map((i) => `2001:db8:${i + 10}::1, 2001:db8:2:100::1`));
  const mapped = await burst(n21.slice(0, 20).map(() => '::ffff:198.51.100.9'));
  const mappedOther = await post('::ffff:198.51.100.10');
  record('THE DEFECT: an IPv6 client rotating addresses inside its /56 shares one report limit; another /56 does not',
    v6.slice(0, 20).every((s) => s === 400) && v6[20] === 429 && v6other === 400, `v6=${v6.join(',')} other56=${v6other}`);
  record('THE DEFECT: a spoofed IPv6 hop cannot pick its own /56; IPv4-mapped clients stay per-IPv4',
    v6spoof.slice(0, 20).every((s) => s === 400) && v6spoof[20] === 429 && mapped.every((s) => s === 400) && mappedOther === 400,
    `spoof=${v6spoof.join(',')} mapped=${mapped.join(',')} mappedOther=${mappedOther}`);
  record('CONTROL: an answering provider is fast (the fault timings are the faults, not the harness)', ok.ms < 5000, `ok ${ok.ms}ms`);
  // Sweep 22 (empty probe checked in): every report field mistyped, answering provider. A mistyped matrix
  // is a 400; anything else is a whole 200 report, never a 5xx. One client address per request (the last
  // hop, TRUST_PROXY=1) keeps the limiter out of it; the 200/400 counts prove the handler really ran.
  mode = 'ok';
  const P = games[0], S = { name: 'Price war', row1: 'Hold', row2: 'Cut', col1: 'Hold', col2: 'Cut', description: 'Two firms.' };
  const junk = [null, 5, true, [], ['x'], {}, { toString: 'x' }, { valueOf: 1 }, 'x'.repeat(5000), -0, 1e308, [[1]]];
  const cases = junk.flatMap((v) => [['payoffs', { payoffs: v, scenario: S }], ['scenario', { payoffs: P, scenario: v }], ['scenarioOnly', { payoffs: P, scenarioOnly: v }],
    ...Object.keys(S).map((k) => [`scenario.${k}`, { payoffs: P, scenario: { ...S, [k]: v } }]), ...Object.keys(P).map((k) => [`payoffs.${k}`, { payoffs: { ...P, [k]: v }, scenario: S }])]);
  const typed = { 200: 0, 400: 0 }, broken = []; // 84 = 12 whole matrices + 8 cells x 9 non-numbers (5, -0, 1e308 clamp)
  for (const [i, [field, body]] of cases.entries()) {
    const r = await fetch(`${BASE}/api/report`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.18.${i >> 8}.${i & 255}` } }).catch(() => null);
    const b = await r?.json().catch(() => null);
    if (r?.status in typed && (r.status === 400 || b?.report || b?.scenario !== undefined)) typed[r.status]++;
    else broken.push(`${field}=${JSON.stringify(body[field.split('.')[0]])?.slice(0, 20)} -> ${r?.status ?? 'no answer'}`);
  }
  record('THE DEFECT: a mistyped report field answers a 400 or a whole report, never a 5xx or a TypeError',
    broken.length === 0 && typed[200] === 120 && typed[400] === 84 && !/TypeError/.test(log), broken.slice(0, 4).join('; ') || JSON.stringify(typed));
} finally {
  await stop(child); await new Promise((r) => stub.close(r)); rmSync(cwd, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length || results.length !== 11) process.exit(1);

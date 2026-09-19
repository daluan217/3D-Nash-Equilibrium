// RED-DESKTOP-21 — angle 4 (offline/online report path honesty).
// electron-main.cjs unconditionally sets NASH_PAYOFF_TEMPLATE=1 and
// NASH_LLM_TIES=template on desktop. server.ts's own comment (line ~3385)
// claims everything below that point (the network-calling generateReport
// path) is UNREACHABLE given those two flags, and that desktop's scenario
// invention (inventScenario) is gated to the LOCAL bank via
// `IS_ELECTRON === 'true' && bankAvailable()`, with pickFromBank's 4-tier
// widening ladder structurally guaranteed to return non-null for any
// non-empty bank (tier 4 is "anything at all"). If true, NO desktop report
// or scenario request should ever open an outbound (non-loopback) TCP
// connection, regardless of network state. This empirically verifies that
// on the wire against the real binary: fire a burst of report/scenarioOnly/
// tie/regen requests and snapshot `lsof -p <pid> -i` throughout for any
// non-127.0.0.1 connection, plus check every response's source/scenarioSource
// field is honest and never mixes cloud+template.
import { spawn, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const APP_BINARY = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22/dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const UDD = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/red21-offline-report-userdata';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(logGetter, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = /Express server running on http:\/\/127\.0\.0\.1:(\d+)/.exec(logGetter());
    if (m) return Number(m[1]);
    await sleep(200);
  }
  throw new Error('server did not start:\n' + logGetter());
}

function snapshotConns(pid) {
  try {
    // Red STATE fix (3): `lsof -p X -i` ORs the selectors, so without -a an
    // unmatched -p silently degrades to SYSTEM-WIDE `lsof -i`. Scope to our
    // own process tree (same shape bg-network already uses) — strictly
    // narrower, never softer.
    const kids = execSync(`pgrep -P ${pid} 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
    const grandkids = kids.flatMap((k) => execSync(`pgrep -P ${k} 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean));
    const pidList = [pid, ...kids, ...grandkids].join(',');
    const out = execSync(`lsof -a -p ${pidList} -i -n -P 2>/dev/null || true`).toString();
    const lines = out.split('\n').filter((l) => l.includes('->'));
    const nonLoopback = lines.filter((l) => !l.includes('127.0.0.1') && !l.includes('localhost'));
    return { total: lines.length, nonLoopback };
  } catch { return { total: 0, nonLoopback: [] }; }
}

async function main() {
  let log = '';
  const child = spawn(APP_BINARY, [`--user-data-dir=${UDD}`], {
    cwd: '/tmp',
    env: { IS_ELECTRON: 'true', NODE_ENV: 'production', PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  console.log('spawned pid', child.pid);

  const allConnSnapshots = [];
  const poller = setInterval(() => {
    allConnSnapshots.push({ t: Date.now(), ...snapshotConns(child.pid) });
  }, 150);

  try {
    const port = await waitForPort(() => log);
    console.log('port:', port);

    // Payoffs designed to hit varied bands (tiny/huge/negative/mixed) and both
    // tie and non-tie shapes, to exercise as many code paths as possible.
    const matrices = [
      { name: 'tiny', a11: 0.01, a12: 0, a21: 0, a22: 0.02, b11: 0.01, b12: 0, b21: 0, b22: 0.02 },
      { name: 'huge', a11: 100, a12: -100, a21: -100, a22: 100, b11: 100, b12: -100, b21: -100, b22: 100 },
      { name: 'tie', a11: 5, a12: 3, a21: 5, a22: 1, b11: 2, b12: 2, b21: 4, b22: 4 },
      { name: 'mixed', a11: 3, a12: -2, a21: 7, a22: 0, b11: -4, b12: 6, b21: 1, b22: 2 },
      { name: 'zero', a11: 0, a12: 0, a21: 0, a22: 0, b11: 0, b12: 0, b21: 0, b22: 0 },
    ];

    const results = [];
    for (let round = 0; round < 6; round++) {
      for (const m of matrices) {
        const { name, ...payoffs } = m;
        for (const scenarioOnly of [false, true]) {
          const t0 = Date.now();
          const res = await fetch(`http://127.0.0.1:${port}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payoffs, scenarioOnly, bypassCache: true }),
          });
          const body = await res.json().catch(() => ({ parseError: true }));
          const dt = Date.now() - t0;
          results.push({ round, matrix: name, scenarioOnly, status: res.status, dt, source: body.source, scenarioSource: body.report?.scenarioSource ?? body.scenarioSource, failure: body.failure ?? body.report?.fallbackReason, hasProse: !!body.report?.prose, hasScenario: !!(body.scenario || body.report?.suggestedScenario) });
        }
      }
    }

    await sleep(500);
    clearInterval(poller);

    const maxDt = Math.max(...results.map((r) => r.dt));
    const sources = [...new Set(results.map((r) => r.source))];
    const scenarioSources = [...new Set(results.map((r) => r.scenarioSource))];
    const anyNonLoopback = allConnSnapshots.some((s) => s.nonLoopback.length > 0);

    console.log('total requests:', results.length);
    console.log('max response time (ms):', maxDt);
    console.log('distinct source values:', JSON.stringify(sources));
    console.log('distinct scenarioSource values:', JSON.stringify(scenarioSources));
    console.log('connection snapshots taken:', allConnSnapshots.length);
    console.log('any non-loopback connection ever seen:', anyNonLoopback);
    if (anyNonLoopback) {
      console.log('NON-LOOPBACK DETAIL:', JSON.stringify(allConnSnapshots.filter((s) => s.nonLoopback.length > 0)));
    }
    console.log('any status != 200:', results.some((r) => r.status !== 200));
    console.log('any failure field with source llm-ish or mixed content:', results.filter((r) => r.source && r.source !== 'template' && r.source !== 'deterministic'));

    writeFileSync('/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/red21-desktop/offline-report-results.json', JSON.stringify({ results, allConnSnapshots, maxDt, sources, scenarioSources, anyNonLoopback }, null, 2));
    console.log('DONE');
  } finally {
    clearInterval(poller);
    child.kill('SIGKILL');
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
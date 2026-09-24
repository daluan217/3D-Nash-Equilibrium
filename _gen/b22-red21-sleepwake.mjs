// RED-DESKTOP-21 — angle 3 (lifecycle): sleep/wake (SIGSTOP/SIGCONT) mid-save,
// real packaged binary, shipping condition. Fires a burst of concurrent save
// requests, freezes the whole process with SIGSTOP partway through (simulating
// laptop sleep during a write), waits, SIGCONTs it, and checks: process still
// alive, all in-flight requests eventually resolve sanely, db.json stays valid
// JSON with no duplicate/corrupted rows, and the app keeps serving afterward.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const APP_BINARY = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const UDD = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/red21-sleepwake-userdata';
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

  try {
    const port = await waitForPort(() => log);
    console.log('port:', port);

    // Fire a burst of 10 concurrent save requests (unawaited).
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        fetch(`http://127.0.0.1:${port}/api/games`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `sleepwake-${i}`, payoffs: { a11: i, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }),
        }).then(async (res) => ({ i, status: res.status, body: await res.json().catch(() => null) }))
          .catch((e) => ({ i, error: String(e) }))
      );
    }

    // Freeze the process almost immediately — simulates the OS suspending it
    // (laptop lid close) while at least some of these requests are in flight.
    await sleep(15);
    console.log('SIGSTOP pid', child.pid, 'at', Date.now());
    process.kill(child.pid, 'SIGSTOP');

    // "Asleep" for 3s — nothing should complete while stopped; a frozen
    // process cannot service the event loop, so this is also implicitly
    // checking that the fetches just wait rather than erroring out.
    await sleep(3000);

    console.log('SIGCONT pid', child.pid, 'at', Date.now());
    process.kill(child.pid, 'SIGCONT');

    const results = await Promise.race([
      Promise.all(promises),
      sleep(15000).then(() => 'TIMEOUT'),
    ]);
    console.log('burst results:', JSON.stringify(results));

    if (results === 'TIMEOUT') {
      console.log('FATAL: requests never resolved after SIGCONT (hang)');
    } else {
      const ok = results.filter((r) => r.status === 200).length;
      const failed = results.filter((r) => r.status && r.status !== 200).length;
      const errored = results.filter((r) => r.error).length;
      console.log(`ok=${ok} failed=${failed} errored=${errored} total=${results.length}`);
    }

    // Confirm the process is still alive and the server still responds normally.
    await sleep(500);
    const health = await fetch(`http://127.0.0.1:${port}/api/games`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    console.log('post-wake GET /api/games:', JSON.stringify(health).slice(0, 2000));
    console.log('games count:', Array.isArray(health) ? health.length : 'N/A');
    if (Array.isArray(health)) {
      const ids = health.map((g) => g.id);
      console.log('duplicate ids?', new Set(ids).size !== ids.length);
    }

    // Validate db.json on disk parses cleanly (no torn/partial write survived).
    const dbPath = `${UDD}/db.json`;
    if (existsSync(dbPath)) {
      const raw = readFileSync(dbPath, 'utf-8');
      try {
        JSON.parse(raw);
        console.log('db.json on disk: VALID JSON, length', raw.length);
      } catch (e) {
        console.log('FATAL: db.json on disk is CORRUPT:', e.message, '\nraw:', raw.slice(0, 500));
      }
    } else {
      console.log('db.json does not exist on disk (unexpected if any save succeeded)');
    }

    // Process still alive check via a distinct probe.
    try {
      process.kill(child.pid, 0);
      console.log('process still alive: true');
    } catch {
      console.log('process still alive: false (exited/crashed)');
    }
  } finally {
    child.kill('SIGKILL');
  }
  console.log('DONE');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

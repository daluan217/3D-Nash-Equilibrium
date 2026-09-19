// RED-DESKTOP-21 — invented angle B: Chromium background network egress in a
// desktop app whose whole point is local/offline math (see repo memory:
// "Local offline explainer", "DMG ships the model in one package -
// offline-out-of-the-box"). Spawns the real binary, touches NOTHING (no HTTP
// requests to the app's own server at all — not even one), and watches for
// any outbound non-loopback connection from the app's own process tree for
// 20s of pure idle. electron-main.cjs applies zero app.commandLine hardening
// flags (grep confirmed), so Chromium's own background services (component
// updater / Safe Browsing / network quality estimator / etc.) run with
// their defaults.
import { spawn, execSync } from 'node:child_process';

const APP_BINARY = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const UDD = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/red21-bg-network-userdata';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshotConns(pid) {
  try {
    const kids = execSync(`pgrep -P ${pid} 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
    const grandkids = kids.flatMap((k) => execSync(`pgrep -P ${k} 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean));
    const pidList = [pid, ...kids, ...grandkids].join(',');
    const out = execSync(`lsof -a -p ${pidList} -i -n -P 2>/dev/null || true`).toString();
    const lines = out.split('\n').filter((l) => l.includes('->'));
    const nonLoopback = lines.filter((l) => !l.includes('127.0.0.1') && !l.includes('localhost'));
    return { total: lines.length, nonLoopback, pidList };
  } catch (e) { return { total: 0, nonLoopback: [], error: String(e) }; }
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
  console.log('spawned pid', child.pid, 'at', Date.now());

  try {
    // NO fetch() to the app's own server at all — pure idle, from launch.
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const snap = snapshotConns(child.pid);
      if (snap.nonLoopback.length) {
        console.log(`t=${i * 500}ms pidList=${snap.pidList} NONLOOPBACK:`, JSON.stringify(snap.nonLoopback));
      } else {
        console.log(`t=${i * 500}ms clean (total conns=${snap.total})`);
      }
    }
  } finally {
    child.kill('SIGKILL');
  }
  console.log('DONE');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
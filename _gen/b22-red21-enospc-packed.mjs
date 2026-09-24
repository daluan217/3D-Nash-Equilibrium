// RED-DESKTOP-21 — angle 2 (persistence integrity): disk-full (ENOSPC) mid-write.
// Real packaged binary, shipping condition (cwd /tmp, IS_ELECTRON=true,
// NODE_ENV=production, throwaway ELECTRON_USER_DATA_PATH on a tiny HFS+ image
// filled to capacity). Hits POST /api/games directly (desktop auto-authenticates
// the local owner, no cookie needed) and checks the response is an honest
// failure, not a false "success" that later evaporates.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const APP_BINARY = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22/dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const UDD = '/Volumes/RED21FULL/userdata';
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
  // PRECONDITION. Without the tiny volume mounted the app writes to a normal
  // disk and ENOSPC is never exercised — the run would look like a startup
  // failure (what it did on 2026-09-19) or, worse, pass. Say so out loud.
  if (!existsSync('/Volumes/RED21FULL')) {
    throw new Error('PRECONDITION: /Volumes/RED21FULL not mounted. Run:\n'
      // 40m, not 2m: Electron's own Cache/Cookies/blob_storage fill a 2MB
      // volume during startup, so the control save 500s before the fill and
      // the post-fill 500 proves nothing about ENOSPC.
      + '  hdiutil create -size 40m -fs HFS+ -volname RED21FULL /tmp/red21full.dmg -quiet\n'
      + '  hdiutil attach /tmp/red21full.dmg -nobrowse && mkdir -p /Volumes/RED21FULL/userdata');
  }
  // Red STATE lesson (4): electron-main.cjs OVERWRITES ELECTRON_USER_DATA_PATH
  // from app.getPath('userData'), which only --user-data-dir steers. Pointing
  // the flag anywhere but the full volume means db.json lands on a normal disk
  // and ENOSPC is never exercised at all.
  const child = spawn(APP_BINARY, [`--user-data-dir=${UDD}`], {
    cwd: '/tmp', // shipping condition — empty cwd so dotenv cannot find the repo's .env
    env: { ELECTRON_USER_DATA_PATH: UDD, IS_ELECTRON: 'true', NODE_ENV: 'production', PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  console.log('spawned pid', child.pid);

  try {
    const port = await waitForPort(() => log);
    console.log('port:', port);
    console.log('env-injection line:', log.split('\n').find((l) => l.includes('injected env')));

    // Let it settle, confirm db.json exists (first-boot write).
    await sleep(1500);
    console.log('db.json exists pre-fill:', existsSync(`${UDD}/db.json`));
    console.log('pre-fill db.json content:', existsSync(`${UDD}/db.json`) ? readFileSync(`${UDD}/db.json`, 'utf-8') : '(none)');

    const { execSync } = await import('node:child_process');
    // POSITIVE CONTROL, before the fill: the same request must SUCCEED while
    // the volume has room. Without it a 500 below could be any failure at all
    // (bad payload shape, auth, a crashed server) rather than the disk.
    const ctl = await fetch(`http://127.0.0.1:${port}/api/games`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ENOSPC control', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }),
    });
    console.log('CONTROL POST (volume has room) status:', ctl.status);
    if (ctl.status !== 200 && ctl.status !== 201) {
      throw new Error(`CONTROL FAILED: save rejected (${ctl.status}) with space free — a 500 after the fill would prove nothing`);
    }

    // Fill the volume to capacity.
    try {
      execSync(`dd if=/dev/zero of=/Volumes/RED21FULL/pad bs=1024 2>/dev/null`, { stdio: 'ignore' });
    } catch { /* dd exits nonzero on ENOSPC by design, that's the point */ }
    console.log('df after fill:', execSync('df -h /Volumes/RED21FULL').toString());

    // Attempt a save — must get an honest failure, not false success.
    const res = await fetch(`http://127.0.0.1:${port}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The route's real payoff shape (cleanPayoffs wants flat a11..b22); the
      // nested-array form 400s at validation and never reaches the disk write,
      // which would make this probe pass without testing ENOSPC at all.
      body: JSON.stringify({ name: 'ENOSPC probe', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }),
    });
    const body = await res.json().catch(() => ({ parseError: true }));
    console.log('POST /api/games status:', res.status, 'body:', JSON.stringify(body));

    // Confirm no false persistence: re-fetch the list.
    const res2 = await fetch(`http://127.0.0.1:${port}/api/games`);
    const body2 = await res2.json().catch(() => ({ parseError: true }));
    console.log('GET /api/games status:', res2.status, 'body:', JSON.stringify(body2));

    // Check server logs for the error line + no crash.
    console.log('server still responsive after ENOSPC attempt:', res2.status === 200 || res2.status === 401);

    writeFileSync('/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/red21-desktop/enospc-report.json', JSON.stringify({
      port, postStatus: res.status, postBody: body, getStatus: res2.status, getBody: body2, log,
    }, null, 2));
    console.log('DONE');
  } finally {
    child.kill('SIGKILL');
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

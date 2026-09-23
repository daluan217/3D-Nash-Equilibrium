/* PACKAGED (macOS) — S75-009 (1): the "Startup Blocked" dialog must be SEEN.
 * The lock-failure hook fires inside require('./dist/server.cjs'), before
 * 'ready'; a showMessageBox called then never appears (measured on the real
 * .app: no window, headless forever, Dock click does nothing). Launched the way
 * a user or login item does (LaunchServices `open -g`), with the dialog wrap
 * installed at --inspect-brk before electron-main.cjs runs, so an early call
 * is recorded, not missed. Needs a fresh `electron-builder --dir` build.
 *   node src/integration/desktop-lock-dialog-packaged.test.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const macDir = ['mac-arm64', 'mac', 'mac-x64'].map((d) => join(REPO, 'dist-electron', d)).find((d) => existsSync(d));
if (!macDir) { console.error('no packaged .app under dist-electron/'); process.exit(1); }
const BUNDLE = join(macDir, 'Nash Equilibrium Simulator.app');
const BIN = join(BUNDLE, 'Contents/MacOS/Nash Equilibrium Simulator');
const INSPECT = Number(process.env.LOCK_DIALOG_INSPECT_PORT || 4871);
const results = [];
const rec = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };

// Freshness: the electron-main.cjs inside app.asar must be this tree's, or a
// stale .app would test code that is not the one under review.
{
  const { extractFile } = await import('@electron/asar');
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const same = sha(extractFile(join(BUNDLE, 'Contents/Resources/app.asar'), 'electron-main.cjs')) === sha(readFileSync(join(REPO, 'electron-main.cjs')));
  if (!same) { console.error('STALE ARTIFACT: app.asar electron-main.cjs differs from the tree; repackage first.'); process.exit(1); }
}

const udd = mkdtempSync(join(tmpdir(), 'nash-lockdlg-'));
// A live NODE holder: proof (b) says "ours", so the server must refuse.
const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
writeFileSync(join(udd, '.server.lock'), String(holder.pid));
const winDir = mkdtempSync(join(tmpdir(), 'nash-onscreen-'));
const winBin = join(winDir, 'onscreen');
execFileSync('/usr/bin/swiftc', ['-O', '-o', winBin, join(REPO, 'src/desktop/onscreen-windows.swift')]);

let appPid = null;
let ws = null;
try {
  execFileSync('/usr/bin/open', ['-g', '-n', BUNDLE, '--args', `--inspect-brk=${INSPECT}`, `--user-data-dir=${udd}`]);
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    target = await fetch(`http://127.0.0.1:${INSPECT}/json/list`).then((r) => r.json()).then((l) => l[0]).catch(() => null);
    if (!target) await new Promise((r) => setTimeout(r, 250));
  }
  appPid = Number(execFileSync('/usr/bin/pgrep', ['-f', `^${BIN} --inspect-brk=${INSPECT} --user-data-dir=${udd}$`], { encoding: 'utf8' }).trim().split('\n')[0]);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map(); let paused = null;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    if (msg.method === 'Debugger.paused' && !paused) paused = msg.params.callFrames[0].callFrameId;
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Runtime.enable'); await send('Debugger.enable'); await send('Runtime.runIfWaitingForDebugger');
  for (let i = 0; i < 40 && !paused; i++) await new Promise((r) => setTimeout(r, 100));
  const wrap = await send('Debugger.evaluateOnCallFrame', { callFrameId: paused, expression: `(() => {
    const { dialog, app } = require('electron'); globalThis.__dialogs = [];
    const orig = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = (...a) => { globalThis.__dialogs.push({ title: a[a.length - 1].title, ready: app.isReady() }); return orig(...a); };
    return 'wrapped'; })()` });
  rec('fixture: the dialog wrap is installed before electron-main.cjs runs', wrap.result?.result?.value === 'wrapped', JSON.stringify(wrap.result?.result ?? wrap.error));
  await send('Debugger.resume');

  let dialogs = []; let onscreen = 0;
  for (let i = 0; i < 40 && !(dialogs.length && onscreen); i++) {
    await new Promise((r) => setTimeout(r, 250));
    dialogs = JSON.parse((await send('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__dialogs || [])' })).result?.result?.value || '[]');
    onscreen = Number(execFileSync(winBin, [String(appPid)], { encoding: 'utf8' }).trim());
  }
  const blocked = dialogs.find((d) => /Startup Blocked/.test(d.title));
  rec('THE DEFECT: the Startup Blocked dialog is requested', !!blocked, JSON.stringify(dialogs));
  rec('THE DEFECT: it is requested only after app ready (a pre-ready request never appears)', blocked?.ready === true, JSON.stringify(blocked));
  rec('THE DEFECT: the app owns an ON-SCREEN native window (the dialog is visible)', onscreen >= 1, `on-screen windows of pid ${appPid}: ${onscreen}`);
  rec('the refused app left the lock with its live holder', readFileSync(join(udd, '.server.lock'), 'utf8').trim() === String(holder.pid));
} finally {
  try { ws?.close(); } catch {}
  if (appPid) { try { process.kill(appPid, 'SIGKILL'); } catch {} }
  holder.kill('SIGKILL');
  rmSync(udd, { recursive: true, force: true });
}

// S75-009 (2) on the SHIPPING binary: the reboot case itself. The lock names a
// live FOREIGN process (/bin/sleep, like Passwords.app holding pid 672): the app
// must start, take the lock and put its window on screen, not refuse.
{
  const udd2 = mkdtempSync(join(tmpdir(), 'nash-reusedpid-'));
  const foreign = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  writeFileSync(join(udd2, '.server.lock'), String(foreign.pid));
  let pid = null;
  try {
    execFileSync('/usr/bin/open', ['-g', '-n', BUNDLE, '--args', `--user-data-dir=${udd2}`]);
    let lockNow = ''; let onscreen = 0;
    for (let i = 0; i < 60 && !(pid && lockNow === String(pid) && onscreen); i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { pid = Number(execFileSync('/usr/bin/pgrep', ['-f', `^${BIN} --user-data-dir=${udd2}$`], { encoding: 'utf8' }).trim().split('\n')[0]); } catch { continue; }
      lockNow = readFileSync(join(udd2, '.server.lock'), 'utf8').trim();
      onscreen = Number(execFileSync(winBin, [String(pid)], { encoding: 'utf8' }).trim());
    }
    rec('S75-009 (2): a lock naming a live FOREIGN pid is taken over by the packaged app', lockNow === String(pid), `lock holds ${lockNow}, app pid ${pid}, foreign ${foreign.pid}`);
    // Not a window count: the refusal dialog is an on-screen window too. The
    // app's OWN server answering with its pid is what "started" means.
    let health = null;
    for (let i = 0; i < 40 && health?.pid !== pid; i++) {
      let listing = ''; // lsof exits 1 when the pid listens on nothing (a refused app)
      try { listing = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }); } catch {}
      const ports = listing.split('\n').filter((l) => l.startsWith('n')).map((l) => l.split(':').pop());
      for (const port of ports) {
        const h = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json()).catch(() => null);
        if (h && pid === h.pid) { health = h; break; }
      }
      if (health?.pid !== pid) await new Promise((r) => setTimeout(r, 250));
    }
    rec('S75-009 (2): the packaged app\'s own server answers /api/health with its pid, window on screen',
      health?.pid === pid && onscreen >= 1, `health pid ${health?.pid}, app pid ${pid}, on-screen windows ${onscreen}`);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    foreign.kill('SIGKILL');
    rmSync(udd2, { recursive: true, force: true });
  }
}

const EXPECTED_CHECKS = 7;
if (results.length < EXPECTED_CHECKS) {
  console.error(`FAILED: only ${results.length} checks ran, expected ${EXPECTED_CHECKS}`);
  process.exit(1);
}
rmSync(winDir, { recursive: true, force: true });
const failed = results.filter((p) => !p).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exit(1);

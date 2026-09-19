// RED-DESKTOP-21 — angle 3 remainder: window-close vs app.quit() semantics,
// activate/reopen honest-restore, and quit-during-a-single-in-flight-save
// (a more surgical companion to the already-completed sleep/wake burst test).
// Real packaged binary, CDP for the renderer, Node Inspector protocol for the
// main process — same substitution-for-OS-input pattern as finding 001's
// harness (no osascript keystrokes/mouse events, which are banned).
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_BINARY = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const CDP_PORT = 4893;
const INSPECT_PORT = 4894;
const SHOT_DIR = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/red21-desktop';
mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(url); if (res.ok) return await res.json(); } catch {}
    await sleep(250);
  }
  throw new Error(`not ready: ${url}`);
}

class InspectorClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    };
  }
  async ready() { return new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = (e) => rej(e); }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.exception?.description || JSON.stringify(res.result.exceptionDetails) };
    return { value: res.result?.result?.value };
  }
  close() { try { this.ws.close(); } catch {} }
}

function childPids(pid) {
  try { return execSync(`pgrep -P ${pid} 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean); }
  catch { return []; }
}
function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function main() {
  const udd = mkdtempSync(join(tmpdir(), 'nash-red21-lifecycle-udd-'));
  console.log('userDataDir:', udd);
  const mainLogs = [];
  const child = spawn(APP_BINARY, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--inspect=${INSPECT_PORT}`,
    `--user-data-dir=${udd}`,
  ], {
    cwd: '/tmp',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, IS_ELECTRON: 'true', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { mainLogs.push(d.toString()); });
  child.stderr.on('data', (d) => { mainLogs.push(d.toString()); });
  console.log('spawned pid', child.pid);

  const report = { pid: child.pid, uddir: udd };

  try {
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 15000);
    const inspectList = await waitHttp(`http://127.0.0.1:${INSPECT_PORT}/json/list`, 15000);
    const insp = new InspectorClient(inspectList[0].webSocketDebuggerUrl);
    await insp.ready();
    await insp.send('Runtime.enable');

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    let mainPage = null;
    for (let i = 0; i < 30 && !mainPage; i++) {
      for (const p of ctx.pages()) if (p.url().startsWith('http://127.0.0.1:')) { mainPage = p; break; }
      if (!mainPage) await sleep(300);
    }
    if (!mainPage) throw new Error('main page not found');
    await mainPage.waitForLoadState('domcontentloaded');
    await sleep(2000);

    const helpersBefore = childPids(child.pid);
    console.log('helper pids before close:', helpersBefore);
    report.helpersBeforeClose = helpersBefore;

    // ---------- PART 1: window.close() must NOT quit the app on macOS ----------
    // This is the win.close() a user's red traffic-light button or Cmd+W triggers
    // (BrowserWindow#close(), the same call Electron's own accelerator uses).
    const closeResult = await insp.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        win.close();
        return 'called';
      })()
    `);
    console.log('win.close() call result:', JSON.stringify(closeResult));
    await sleep(1500);

    const afterCloseWinCount = await insp.evaluate(`
      (() => { const { BrowserWindow } = process.mainModule.require('electron'); return BrowserWindow.getAllWindows().length; })()
    `);
    console.log('window count after close:', JSON.stringify(afterCloseWinCount));
    report.windowCountAfterClose = afterCloseWinCount;

    const mainProcessAliveAfterClose = isAlive(child.pid);
    console.log('main process alive after window close:', mainProcessAliveAfterClose);
    report.mainProcessAliveAfterClose = mainProcessAliveAfterClose;

    // Server must keep running (window close != app quit on darwin) — probe it
    // directly, independent of any window.
    let serverAliveAfterClose = false;
    let serverPort = null;
    try {
      const m = /Express server running on http:\/\/127\.0\.0\.1:(\d+)/.exec(mainLogs.join(''));
      serverPort = m ? Number(m[1]) : null;
      if (serverPort) {
        const res = await fetch(`http://127.0.0.1:${serverPort}/api/games`);
        serverAliveAfterClose = res.status === 200 || res.status === 401;
      }
    } catch (e) { report.serverProbeError = String(e); }
    console.log('server responsive after window close:', serverAliveAfterClose, 'port', serverPort);
    report.serverAliveAfterClose = serverAliveAfterClose;
    report.serverPort = serverPort;

    // ---------- PART 2: activate (dock-icon-click equivalent) reopens honestly ----------
    // Simulate what a dock-icon click does: Electron's `app.on('activate', ...)`
    // handler, invoked here via the same event Electron itself emits — not a
    // synthetic OS click.
    const activateResult = await insp.evaluate(`
      (() => {
        const { app } = process.mainModule.require('electron');
        app.emit('activate', {}, true);
        return 'emitted';
      })()
    `);
    console.log('activate emit result:', JSON.stringify(activateResult));
    await sleep(2500);

    const afterActivateWinCount = await insp.evaluate(`
      (() => { const { BrowserWindow } = process.mainModule.require('electron'); return BrowserWindow.getAllWindows().length; })()
    `);
    console.log('window count after activate:', JSON.stringify(afterActivateWinCount));
    report.windowCountAfterActivate = afterActivateWinCount;

    // Re-find the (new) main page via CDP and check it shows the honest default
    // board (this app has NO board-state persistence across windows — payoffs
    // is a hardcoded useState default, confirmed by source read — so "restoring
    // honestly" here means: shows the same known default board, not a blank/
    // corrupted/stale page, and not a false claim of restoring a prior session).
    let newPage = null;
    for (let i = 0; i < 30 && !newPage; i++) {
      for (const p of ctx.pages()) if (p.url().startsWith('http://127.0.0.1:') && !p.isClosed()) { newPage = p; break; }
      if (!newPage) await sleep(300);
    }
    let reopenBoardState = null;
    if (newPage) {
      try {
        await newPage.waitForLoadState('domcontentloaded');
        await sleep(1500);
        await newPage.screenshot({ path: join(SHOT_DIR, '04-after-activate-reopen.png') });
        reopenBoardState = await newPage.evaluate(() => {
          const bodyText = document.body.innerText.slice(0, 300);
          return { url: location.href, hasReactRoot: !!document.getElementById('root')?.children.length, bodyPreview: bodyText };
        });
      } catch (e) { reopenBoardState = { error: String(e) }; }
    } else {
      reopenBoardState = { error: 'no page found after activate' };
    }
    console.log('reopen board state:', JSON.stringify(reopenBoardState));
    report.reopenBoardState = reopenBoardState;

    // ---------- PART 3: quit-during-a-single-save (surgical, not a burst) ----------
    // Fire exactly one save POST and call app.quit() as close to immediately
    // as possible after, to try to catch the write mid-flight. Distinct from
    // the sleep/wake burst test (which froze the whole process via SIGSTOP,
    // not a real quit sequence going through Electron's before-quit/will-quit
    // machinery).
    if (serverPort) {
      const savePromise = fetch(`http://127.0.0.1:${serverPort}/api/games`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'quit-during-save-probe', payoffs: { a11: 9, a12: 0, a21: 0, a22: 9, b11: 9, b12: 0, b21: 0, b22: 9 } }),
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })).catch((e) => ({ error: String(e) }));

      // Give the request a couple ms to reach the server, then quit.
      await sleep(5);
      // Red STATE false-lead lesson (load-bearing): NEVER `await` a quit()-
      // adjacent Runtime.evaluate over a live Inspector socket — awaiting the
      // reply keeps Node's event loop open inside the target and makes a
      // perfectly normal quit look hung. Fire-and-forget, then close the
      // debugger socket ~30ms later, which is what a real (un-inspected) user
      // process does. Assertions below are unchanged.
      insp.send('Runtime.evaluate', {
        expression: `(() => { const { app } = process.mainModule.require('electron'); app.quit(); return 'quit-called'; })()`,
        returnByValue: true,
      }).catch(() => {});
      await sleep(30);
      insp.close();
      console.log('app.quit() call result: fire-and-forget (inspector socket closed)');

      const saveOutcome = await Promise.race([savePromise, sleep(8000).then(() => 'TIMEOUT')]);
      console.log('quit-during-save outcome:', JSON.stringify(saveOutcome));
      report.quitDuringSaveOutcome = saveOutcome;

      // Whole process tree must actually be gone within a reasonable window.
      await sleep(2000);
      const mainAliveAfterQuit = isAlive(child.pid);
      const helpersAfterQuit = childPids(child.pid);
      console.log('main process alive after app.quit():', mainAliveAfterQuit, 'remaining helper pids:', helpersAfterQuit);
      report.mainAliveAfterQuit = mainAliveAfterQuit;
      report.helpersAfterQuit = helpersAfterQuit;

      // Validate db.json on disk is still parseable (no torn write survived).
      const dbPath = `${udd}/db.json`;
      if (existsSync(dbPath)) {
        const raw = readFileSync(dbPath, 'utf-8');
        try { JSON.parse(raw); report.dbJsonValidAfterQuit = true; report.dbJsonLength = raw.length; }
        catch (e) { report.dbJsonValidAfterQuit = false; report.dbJsonParseError = e.message; report.dbJsonRawPreview = raw.slice(0, 500); }
      } else {
        report.dbJsonExistsAfterQuit = false;
      }
    } else {
      report.quitDuringSaveSkipped = 'no server port captured';
    }

    console.log('FULL REPORT:', JSON.stringify(report, null, 2));
    console.log('DONE');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    // Best-effort cleanup of any surviving helper processes this harness spawned.
    for (const pid of childPids(child.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

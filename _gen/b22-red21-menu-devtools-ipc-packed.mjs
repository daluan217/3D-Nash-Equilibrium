// RED-DESKTOP-21 — angle 3 (menu/shortcuts/devtools) + angle 1 (IPC/preload fuzz)
// Real packaged binary, CDP for the renderer, Node Inspector protocol (a launch
// flag we choose ourselves, same category as --remote-debugging-port) for the
// main process, so we can invoke the EXACT API a menu role/accelerator would
// call without ever sending an OS-level keystroke or mouse event (banned).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_BINARY = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22/dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const CDP_PORT = 4891;
const INSPECT_PORT = 4892;
const SHOT_DIR = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/notes/BLUE-LOOP-DESKTOP-22/out/red21-desktop';
mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`not ready: ${url}`);
}

// Minimal Node-Inspector (== CDP wire format) client over the native WebSocket.
class InspectorClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
  }
  async ready() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) {
      return { error: res.result.exceptionDetails.exception?.description || JSON.stringify(res.result.exceptionDetails) };
    }
    return { value: res.result?.result?.value };
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  const udd = mkdtempSync(join(tmpdir(), 'nash-red21-udd-'));
  console.log('userDataDir:', udd);

  const mainLogs = [];
  const child = spawn(APP_BINARY, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--inspect=${INSPECT_PORT}`,
    `--user-data-dir=${udd}`,
  ], {
    cwd: '/tmp',
    env: { ...process.env, ELECTRON_USER_DATA_PATH: udd, IS_ELECTRON: 'true', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { const t = d.toString(); mainLogs.push({ t: Date.now(), s: 'out', text: t }); process.stdout.write('[OUT] ' + t); });
  child.stderr.on('data', (d) => { const t = d.toString(); mainLogs.push({ t: Date.now(), s: 'err', text: t }); process.stderr.write('[ERR] ' + t); });
  console.log('spawned pid', child.pid);

  const report = { pid: child.pid, uddir: udd };

  try {
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 15000);
    const inspectList = await waitHttp(`http://127.0.0.1:${INSPECT_PORT}/json/list`, 15000);
    console.log('inspector targets:', JSON.stringify(inspectList));
    const mainTarget = inspectList[0]; // Electron main process is the sole Node target
    const insp = new InspectorClient(mainTarget.webSocketDebuggerUrl);
    await insp.ready();
    await insp.send('Runtime.enable');

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    let mainPage = null;
    for (let i = 0; i < 30 && !mainPage; i++) {
      for (const p of ctx.pages()) {
        if (p.url().startsWith('http://127.0.0.1:') || p.url().startsWith('http://localhost:')) { mainPage = p; break; }
      }
      if (!mainPage) await sleep(300);
    }
    if (!mainPage) throw new Error('main page not found: ' + ctx.pages().map(p => p.url()).join(','));
    await mainPage.waitForLoadState('domcontentloaded');
    await sleep(2000);
    await mainPage.screenshot({ path: join(SHOT_DIR, '00-initial.png') });
    console.log('main page url:', mainPage.url());

    // ---------- ANGLE 3: Menu / DevTools ----------
    const menuDump = await insp.evaluate(`
      (() => {
        const { Menu } = process.mainModule.require('electron');
        const m = Menu.getApplicationMenu();
        if (!m) return 'NULL_MENU';
        return JSON.stringify(m.items.map(top => ({
          label: top.label,
          role: top.role,
          submenu: top.submenu ? top.submenu.items.map(si => ({ label: si.label, role: si.role, accelerator: si.accelerator })) : null,
        })));
      })()
    `);
    console.log('MENU DUMP:', JSON.stringify(menuDump));
    report.menuDump = menuDump;

    const devToolsPrefCheck = await insp.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        return JSON.stringify({
          isDevToolsOpened: win.webContents.isDevToolsOpened(),
          count: BrowserWindow.getAllWindows().length,
        });
      })()
    `);
    console.log('DEVTOOLS PRE-STATE:', JSON.stringify(devToolsPrefCheck));
    report.devToolsPreState = devToolsPrefCheck;

    // Invoke the EXACT API Electron's `role: 'toggleDevTools'` menu accelerator
    // calls internally (webContents.toggleDevTools / openDevTools) — proves
    // reachability of the capability without any OS-level input.
    const openResult = await insp.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        win.webContents.openDevTools({ mode: 'detach' });
        return 'called';
      })()
    `);
    console.log('openDevTools() call result:', JSON.stringify(openResult));
    await sleep(2000);
    const devToolsPostState = await insp.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        return JSON.stringify({
          isDevToolsOpened: win.webContents.isDevToolsOpened(),
          count: BrowserWindow.getAllWindows().length,
        });
      })()
    `);
    console.log('DEVTOOLS POST-STATE:', JSON.stringify(devToolsPostState));
    report.devToolsPostState = devToolsPostState;

    // Confirm from the CDP side too: a NEW page/target should now exist.
    await sleep(500);
    const pagesAfter = ctx.pages().map((p) => p.url());
    console.log('pages after openDevTools:', JSON.stringify(pagesAfter));
    report.pagesAfterOpenDevTools = pagesAfter;
    // Screenshot whichever page looks like the devtools frontend.
    for (const p of ctx.pages()) {
      if (p.url().includes('devtools')) {
        try { await p.screenshot({ path: join(SHOT_DIR, '01-devtools-open.png') }); } catch (e) { console.log('devtools screenshot failed', e.message); }
      }
    }
    await mainPage.screenshot({ path: join(SHOT_DIR, '01b-mainpage-after-devtools.png') });

    // Close devtools again (cleanup) before continuing.
    await insp.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        BrowserWindow.getAllWindows()[0].webContents.closeDevTools();
        return 'closed';
      })()
    `);
    await sleep(500);

    // ---------- ANGLE 1: IPC/preload fuzz ----------
    const preloadSurface = await mainPage.evaluate(() => Object.keys(window.nashDesktop || {}));
    console.log('preload surface keys:', preloadSurface);
    report.preloadSurface = preloadSurface;

    const fuzzStart = Date.now();
    const fuzzResult = await mainPage.evaluate(() => {
      const attempts = [];
      const payloads = [
        undefined, null, 123, true, {}, [], () => {}, Symbol('x'),
        '#zzzzzz', '#12345', '#1234567', 'red', '',
        'a'.repeat(10_000_000), // 10MB string
        { toString() { throw new Error('boom'); } },
      ];
      for (const p of payloads) {
        // Red STATE decision (2): label computed ONCE, defensively, before the
        // try/catch — a toString-throwing payload otherwise throws a SECOND
        // time inside the catch handler and kills the whole evaluate.
        let label;
        try { label = String(p).slice(0, 30); } catch { label = '<toString threw>'; }
        try {
          window.nashDesktop.setBackgroundColor(p);
          attempts.push({ payload: label, ok: true });
        } catch (e) {
          let errLabel; try { errLabel = String(e); } catch { errLabel = '<err toString threw>'; }
          attempts.push({ payload: label, ok: false, err: errLabel });
        }
      }
      // rapid-fire repeats
      let rapidErr = null;
      try {
        for (let i = 0; i < 5000; i++) window.nashDesktop.setBackgroundColor('#' + (i % 16).toString(16).repeat(6));
      } catch (e) { rapidErr = String(e); }
      return { attempts, rapidErr, stillAlive: true };
    });
    console.log('IPC fuzz result:', JSON.stringify(fuzzResult).slice(0, 2000));
    report.ipcFuzz = fuzzResult;

    await sleep(1000);
    // Verify renderer still alive/responsive after the fuzz.
    const aliveCheck = await mainPage.evaluate(() => document.title + '|' + document.readyState);
    console.log('renderer alive check:', aliveCheck);
    report.aliveAfterFuzz = aliveCheck;
    await mainPage.screenshot({ path: join(SHOT_DIR, '02-after-ipc-fuzz.png') });

    // Preload leak check: same-origin srcdoc iframe should NOT see window.nashDesktop
    // (Electron preload scripts only inject into the top frame by default).
    const iframeLeak = await mainPage.evaluate(async () => {
      const iframe = document.createElement('iframe');
      iframe.srcdoc = '<script>window.parent.postMessage({hasNashDesktop: !!window.nashDesktop}, "*")<' + '/script>';
      const p = new Promise((resolve) => {
        window.addEventListener('message', function h(ev) {
          if (ev.data && typeof ev.data.hasNashDesktop === 'boolean') {
            window.removeEventListener('message', h);
            resolve(ev.data.hasNashDesktop);
          }
        });
        setTimeout(() => resolve('TIMEOUT'), 3000);
      });
      document.body.appendChild(iframe);
      const result = await p;
      iframe.remove();
      return result;
    });
    console.log('iframe nashDesktop leak check (should be false):', iframeLeak);
    report.iframeLeak = iframeLeak;

    // Check main process logs since fuzz start for uncaught exceptions/crashes.
    const relevantLogs = mainLogs.filter((l) => l.t >= fuzzStart).map((l) => l.text).join('');
    report.mainLogsAfterFuzz = relevantLogs.slice(0, 4000);
    console.log('main logs after fuzz (first 2000 chars):', relevantLogs.slice(0, 2000));

    insp.close();
    await browser.close();
  } finally {
    child.kill('SIGKILL');
  }

  const fs = await import('node:fs');
  fs.writeFileSync(join(SHOT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('DONE. report at', join(SHOT_DIR, 'report.json'));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

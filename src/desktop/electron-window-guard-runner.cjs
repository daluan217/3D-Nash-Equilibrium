/**
 * Runner for src/integration/electron-window-guard.test.mjs.
 *
 * RED-DESKTOP-5/002: electron-main.cjs's 800ms "slow boot sequence" fallback
 * (and app.on('activate')) used to call createWindow() unconditionally once
 * mainWindow was still null, with no awareness that a desktop-lock failure
 * was in progress — server.ts's lock-failure path deliberately never binds a
 * port, so that window loaded Chromium's own chrome-error://chromewebdata/,
 * a stray blank window appearing right alongside the correct native
 * "Startup Blocked" dialog. Fixed by cancelling the fallback timer outright
 * inside global.onDesktopLockFailure, plus a `lockFailurePending` guard on
 * `app.on('activate')`.
 *
 * Stubs `electron` totally (Proxy-based, like require-probe.cjs) but
 * INTERCEPTS the few calls this test cares about: `app.on(event, cb)`
 * captures the callback by event name; `new BrowserWindow(...)` increments a
 * counter instead of doing anything real; `dialog.showMessageBox` returns an
 * already-resolved promise (so `global.onDesktopLockFailure` completes
 * synchronously-ish, matching the fix's `lockFailurePending = true` line
 * running before the promise even settles). `dist/server.cjs`'s require is
 * stubbed to `{}` so nothing real binds a port — this test drives
 * `global.onDesktopLockFailure` and the captured `app.on` callbacks itself.
 *
 * Usage: node electron-window-guard-runner.cjs <mainCjsPath> <mode>
 *   mode = 'lockfail'      — simulate a lock failure BEFORE 'ready' fires
 *                            (the real ordering: require(dist/server.cjs)
 *                            runs before Electron's own 'ready' event),
 *                            then fire 'ready', wait past 800ms, then fire
 *                            'activate'. Expect ZERO windows ever created.
 *   mode = 'data-conflict' — same startup-blocked timing, but with the
 *                            explicit database-conflict kind (2 candidates).
 *                            Captures the native dialog options so the
 *                            integration test can assert its backup-first
 *                            recovery hint (plural wording).
 *   mode = 'data-conflict-single' — same, but with candidateCount: 1 (a
 *                            conflict copy with no primary db.json yet).
 *                            Captures the dialog options so the test can
 *                            assert the singular wording never claims a
 *                            nonexistent second file.
 *   mode = 'slowboot-normal' — do NOT simulate a lock failure (genuine slow
 *                            boot: serverStarted stays false with no lock
 *                            issue). Fire 'ready', wait past 800ms. Expect
 *                            EXACTLY ONE window created — the regression
 *                            guard that the fix does not break the
 *                            legitimate fallback it was built for.
 * Prints one line `RUNNER_RESULT <json>` and exits 0.
 */
const Module = require('module');
const path = require('path');

const mainCjsPath = process.argv[2];
const mode = process.argv[3];
const VALID_MODES = ['lockfail', 'data-conflict', 'data-conflict-single', 'slowboot-normal'];
if (!mainCjsPath || !VALID_MODES.includes(mode)) {
  console.log(`usage: electron-window-guard-runner.cjs <mainCjsPath> <${VALID_MODES.join('|')}>`);
  process.exit(2);
}

let windowCount = 0;
let dialogShown = 0;
let dialogOptions = null;
const onHandlers = {};

function totalStub(name) {
  const fn = function () {};
  fn.__stub = name;
  return new Proxy(fn, {
    get(t, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return () => `[stub ${name}]`;
      if (prop === 'toString') return () => `[stub ${name}]`;
      if (prop in t) return t[prop];
      return totalStub(`${name}.${String(prop)}`);
    },
    apply() { return totalStub(`${name}()`); },
    construct() { return totalStub(`new ${name}`); },
    has() { return true; },
  });
}

class FakeBrowserWindow {
  constructor() {
    windowCount++;
    this.webContents = { setZoomFactor() {}, executeJavaScript: () => Promise.resolve(), setWindowOpenHandler() {} };
  }
  loadURL() {}
  on() {}
  isMinimized() { return false; }
  restore() {}
  focus() {}
  static fromWebContents() { return null; }
}

const fakeApp = {
  isReady: () => true,
  on(event, cb) { onHandlers[event] = cb; },
  quit() {},
  exit() {},
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  getPath: () => '/tmp',
  setName() {},
};

const fakeDialog = {
  showMessageBox(options) {
    dialogShown++;
    dialogOptions = options;
    // Never resolves within this test's real-time window — matches the
    // real UX (a modal dialog sits open until the user clicks something),
    // and specifically exercises that `lockFailurePending`/the timer
    // cancellation happen SYNCHRONOUSLY inside onDesktopLockFailure, not
    // inside this promise's .then().
    return new Promise(() => {});
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: fakeApp,
      BrowserWindow: FakeBrowserWindow,
      ipcMain: { on() {} },
      dialog: fakeDialog,
      shell: totalStub('shell'),
      nativeTheme: { shouldUseDarkColors: false, on() {} },
      Menu: totalStub('Menu'),
      autoUpdater: totalStub('autoUpdater'),
    };
  }
  if (/dist[/\\]server\.cjs$/.test(request)) return {};
  return originalLoad.call(this, request, parent, isMain);
};

require(path.resolve(mainCjsPath));

if (mode === 'lockfail' || mode === 'data-conflict' || mode === 'data-conflict-single') {
  // The real ordering: server.ts calls this synchronously during the
  // top-level require() above (which already ran), i.e. BEFORE Electron's
  // own 'ready' event ever fires.
  let payload;
  if (mode === 'data-conflict') {
    payload = { message: 'test database conflict', lockFile: '/tmp/x/db.json 2', kind: 'data-conflict', candidateCount: 2 };
  } else if (mode === 'data-conflict-single') {
    payload = { message: 'test database conflict (copy only)', lockFile: '/tmp/x/db.json 2', kind: 'data-conflict', candidateCount: 1 };
  } else {
    payload = { message: 'test lock failure', lockFile: '/tmp/x/.server.lock' };
  }
  globalThis.onDesktopLockFailure(payload);
  if (typeof onHandlers.ready === 'function') onHandlers.ready();
  setTimeout(() => {
    if (typeof onHandlers.activate === 'function') onHandlers.activate();
    setTimeout(() => {
      console.log(`RUNNER_RESULT ${JSON.stringify({ windowCount, dialogShown, dialogOptions })}`);
      process.exit(0);
    }, 50);
  }, 900); // past the 800ms fallback
} else {
  // Genuine slow boot: no lock failure at all.
  if (typeof onHandlers.ready === 'function') onHandlers.ready();
  setTimeout(() => {
    console.log(`RUNNER_RESULT ${JSON.stringify({ windowCount, dialogShown })}`);
    process.exit(0);
  }, 900);
}

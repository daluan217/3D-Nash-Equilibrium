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
 *   mode = 'openexternal'  — fire 'ready', let the window be created, then drive
 *                            the installed setWindowOpenHandler AND every
 *                            will-navigate handler with renderer-chosen URLs,
 *                            plus the app-level web-contents-created hook.
 *                            Reports what reached shell.openExternal, which
 *                            navigations were prevented, and the handler counts.
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
const VALID_MODES = ['lockfail', 'data-conflict', 'data-conflict-single', 'slowboot-normal', 'openexternal'];
if (!mainCjsPath || !VALID_MODES.includes(mode)) {
  console.log(`usage: electron-window-guard-runner.cjs <mainCjsPath> <${VALID_MODES.join('|')}>`);
  process.exit(2);
}

let windowCount = 0;
let capturedOpenHandler = null;
let mainContents = null;
let loadedUrl = null;
const openedUrls = [];
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

// The stub records handlers as LISTS, so a guard registered twice (the real risk
// once `web-contents-created` also hardens contents) shows up as a duplicate here
// instead of hiding — and every recorded handler is executed by the probes below.
class FakeWebContents {
  constructor() { this.handlers = {}; this.openHandler = null; }
  setZoomFactor() {}
  executeJavaScript() { return Promise.resolve(); }
  setWindowOpenHandler(h) { this.openHandler = h; capturedOpenHandler = h; }
  on(event, cb) { (this.handlers[event] = this.handlers[event] || []).push(cb); return this; }
}

class FakeBrowserWindow {
  constructor() {
    windowCount++;
    this.webContents = new FakeWebContents();
    mainContents = this.webContents;
  }
  loadURL(u) { loadedUrl = String(u); }
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
      shell: new Proxy(totalStub('shell'), {
        get(target, prop) {
          // Record what the app actually asks the OS to open; delegate everything
          // else to totalStub's OWN trap, which keeps `then` undefined (a callable
          // `then` would make `await shell` hang forever).
          if (prop === 'openExternal') return (u) => { openedUrls.push(String(u)); return Promise.resolve(); };
          return target[prop];
        },
        has() { return true; },
      }),
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
} else if (mode === 'openexternal') {
  // Drive the REAL handlers with the URLs a renderer could hand them. Nothing here
  // is a source scan: every probe executes a handler the app installed, and reports
  // what reached shell.openExternal and whether the navigation was prevented.
  if (typeof onHandlers.ready === 'function') onHandlers.ready();
  setTimeout(() => {
    const windowOpenProbes = [
      'https://nash-equilibrium-simulator.com/api/download/dmg',
      'https://mathematics-magazine.example/paper',
      'http://127.0.0.1:9/health',
      'file:///etc/passwd',
      'javascript:alert(document.domain)',
      'data:text/html,<script>alert(1)</script>',
      'smb://attacker.example/share',
      'vscode://file/etc/passwd',
      'not a url at all',
    ];
    const probes = windowOpenProbes.map((url) => {
      const before = openedUrls.length;
      let action = 'NO_HANDLER';
      if (typeof capturedOpenHandler === 'function') {
        try { action = (capturedOpenHandler({ url }) || {}).action ?? null; }
        catch (err) { action = `THREW ${err && err.message}`; }
      }
      return { url, action, opened: openedUrls.length > before };
    });

    // The same-window door: <a href> / location.href, which setWindowOpenHandler
    // never sees. Every registered will-navigate handler runs, so a handler
    // registered twice would show up as a second entry in openedUrls.
    const navHandlers = (mainContents && mainContents.handlers['will-navigate']) || [];
    const driveNav = (url) => {
      const before = openedUrls.length;
      let prevented = false;
      const event = { preventDefault() { prevented = true; }, url };
      for (const cb of navHandlers) {
        try { cb(event, url); }
        catch (err) { return { url, prevented, opened: openedUrls.length > before, threw: String(err && err.message) }; }
      }
      return { url, prevented, opened: openedUrls.length > before };
    };
    const navigation = [
      `${loadedUrl}/library`,
      'https://attacker.example/phish',
      'http://127.0.0.1:9/not-this-app',
      'file:///etc/passwd',
      'javascript:alert(document.domain)',
      'not a url at all',
    ].map(driveNav);

    // Snapshot BEFORE the re-hardening below, so "one handler is installed" and
    // "re-hardening does not add a second" fail for their own reasons, not each other's.
    const navHandlerCount = navHandlers.length;
    const frameNavHandlerCount = ((mainContents && mainContents.handlers['will-frame-navigate']) || []).length;

    // The family sweep: a webContents created later must get the same policy, and
    // re-hardening the main window must NOT register a second handler.
    let createdContentsGuards = null;
    let mainNavHandlersAfterRehardening = null;
    if (typeof onHandlers['web-contents-created'] === 'function') {
      const fresh = new FakeWebContents();
      onHandlers['web-contents-created']({}, fresh);
      createdContentsGuards = {
        openHandler: typeof fresh.openHandler === 'function',
        willNavigate: (fresh.handlers['will-navigate'] || []).length,
        willFrameNavigate: (fresh.handlers['will-frame-navigate'] || []).length,
      };
      onHandlers['web-contents-created']({}, mainContents);
      mainNavHandlersAfterRehardening = (mainContents.handlers['will-navigate'] || []).length;
    }

    console.log(`RUNNER_RESULT ${JSON.stringify({
      handlerInstalled: typeof capturedOpenHandler === 'function',
      loadedUrl,
      navHandlerCount,
      frameNavHandlerCount,
      webContentsCreatedHooked: typeof onHandlers['web-contents-created'] === 'function',
      createdContentsGuards,
      mainNavHandlersAfterRehardening,
      probes,
      navigation,
      openedUrls,
    })}`);
    process.exit(0);
  }, 900);
} else {
  // Genuine slow boot: no lock failure at all.
  if (typeof onHandlers.ready === 'function') onHandlers.ready();
  setTimeout(() => {
    console.log(`RUNNER_RESULT ${JSON.stringify({ windowCount, dialogShown })}`);
    process.exit(0);
  }, 900);
}

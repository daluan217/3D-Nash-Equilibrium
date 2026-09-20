/**
 * BEHAVIORAL runner for src/integration/electron-behavior.test.mjs.
 *
 * WHY THIS EXISTS. Three consecutive independent reviews defeated the same
 * class of guard: source-text regexes over electron-main.cjs / electron-preload.cjs.
 * Each time the product was correct and the CHECK was wrong, and each time the
 * fix was a better regex that the next review beat with a new spelling —
 * `send: () => ipcRenderer.send`, `ALLOWED_PERMISSIONS.add('media')`,
 * `new Set([..., ...EXTRA])`, `const { openExternal } = shell`,
 * `ipcRenderer.send('ok', v), ipcRenderer.send('secret', v)`.
 *
 * A regex asks how the code is SPELLED. These checks ask what it DOES: load the
 * real modules under fake electron, capture the real handlers, invoke them, and
 * judge by IDENTITY and by recorded effect. Spelling becomes irrelevant, so the
 * whole family of evasions above dies at once rather than one variant at a time.
 *
 * Usage: node electron-behavior-runner.cjs <repoRoot> <mode>
 *   mode = 'permissions' — capture the handlers handed to
 *       session.setPermissionRequestHandler / setPermissionCheckHandler and
 *       invoke them with every documented Electron permission name.
 *   mode = 'bridge' — load electron-preload.cjs under a fake contextBridge and
 *       a fake ipcRenderer whose methods are identity-tagged; report the exposed
 *       key set, whether any exposed value (or its return value) IS the fake
 *       ipcRenderer or one of its methods, and every channel actually sent.
 *   mode = 'egress' — record every network-capable call made while loading
 *       electron-main.cjs and driving checkForUpdates, plus the exact set of
 *       module names it requires.
 *   mode = 'openexternal' — drive every navigation door with hostile schemes and
 *       report every argument that reached shell.openExternal, however it was
 *       spelled or aliased.
 *
 * Prints one line `RUNNER_RESULT <json>` and exits 0.
 */
const Module = require('module');
const path = require('path');

const repoRoot = process.argv[2];
const mode = process.argv[3];
const VALID = ['permissions', 'bridge', 'egress', 'openexternal'];
if (!repoRoot || !VALID.includes(mode)) {
  console.error(`usage: electron-behavior-runner.cjs <repoRoot> <${VALID.join('|')}>`);
  process.exit(2);
}
const mainCjs = path.join(repoRoot, 'electron-main.cjs');
const preloadCjs = path.join(repoRoot, 'electron-preload.cjs');

const out = (payload) => {
  console.log(`RUNNER_RESULT ${JSON.stringify(payload)}`);
  process.exit(0);
};

// ── mode: bridge ────────────────────────────────────────────────────────────
// Load the REAL preload with a fake contextBridge and a fake ipcRenderer whose
// every method is a distinct, tagged function. Identity comparison then answers
// "did the renderer get a live IPC handle?" regardless of how it was written.
if (mode === 'bridge') {
  const sent = [];
  const invoked = [];
  const ipcRenderer = {};
  const IPC_METHODS = ['send', 'invoke', 'sendSync', 'postMessage', 'on', 'once',
    'removeListener', 'removeAllListeners', 'sendTo', 'sendToHost'];
  for (const m of IPC_METHODS) {
    const fn = (...args) => {
      if (m === 'send' || m === 'sendSync' || m === 'postMessage') sent.push(args[0]);
      if (m === 'invoke') invoked.push(args[0]);
      return undefined;
    };
    fn.__isFakeIpcMethod = m;
    ipcRenderer[m] = fn;
  }
  ipcRenderer.__isFakeIpcRenderer = true;

  let exposed = null;
  let exposedKey = null;
  const contextBridge = {
    exposeInMainWorld(key, api) { exposedKey = key; exposed = api; },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { contextBridge, ipcRenderer };
    return originalLoad.call(this, request, parent, isMain);
  };
  require(path.resolve(preloadCjs));
  Module._load = originalLoad;

  // Is this value a live IPC handle — the module object itself, or any of its
  // methods? Identity, not text: an alias, a rename, a property copy and a
  // returned method all compare equal here and are all equally dangerous.
  const isLiveIpc = (v) => v === ipcRenderer
    || (typeof v === 'function' && typeof v.__isFakeIpcMethod === 'string')
    || (v !== null && typeof v === 'object' && v.__isFakeIpcRenderer === true);

  // DEEP, not just the top level. Self-review found a surviving mutant:
  //   setBackgroundColor: (c) => { ipcRenderer.send('set-background-color', c);
  //                                return { raw: ipcRenderer }; }
  // It sends legitimately (so the "must reach ipcRenderer" control is happy),
  // keeps the key set unchanged (so the exact-keys check is happy), and the
  // handle is one level down (so a top-level identity check is happy) — while
  // the renderer still gets a live IPC object. Walk the whole returned graph.
  const findLiveIpc = (v, depth = 0, seen = new Set()) => {
    if (isLiveIpc(v)) return true;
    if (depth > 4 || v === null || typeof v !== 'object' || seen.has(v)) return false;
    seen.add(v);
    for (const key of Reflect.ownKeys(v)) {
      let child;
      try { child = v[key]; } catch { continue; } // a throwing getter hides nothing
      if (findLiveIpc(child, depth + 1, seen)) return true;
    }
    return false;
  };

  // The detector's own self-test, reported so the test can assert it. A walker
  // that found everything (or nothing) would make every member verdict below
  // meaningless, and a cyclic object must not hang it.
  const cyc = {}; cyc.self = cyc;
  const walkerSelfTest = {
    findsTopLevel: findLiveIpc(ipcRenderer),
    findsMethod: findLiveIpc(ipcRenderer.send),
    findsNested: findLiveIpc({ raw: ipcRenderer }),
    findsDeep: findLiveIpc({ a: { b: { c: ipcRenderer.send } } }),
    ignoresClean: findLiveIpc({ ok: true, n: 1, s: 'ipcRenderer' }) === false,
    survivesCycle: findLiveIpc(cyc) === false,
  };

  const members = [];
  for (const [name, value] of Object.entries(exposed || {})) {
    const entry = { name, type: typeof value, leaksDirectly: findLiveIpc(value) };
    if (typeof value === 'function') {
      // Invoke it and inspect the RETURN value too: `() => ipcRenderer.send`
      // hands back the generic sender without ever being one itself.
      const before = sent.length + invoked.length;
      let returned;
      try { returned = value('#000000'); entry.threw = false; } catch (e) { entry.threw = true; }
      entry.leaksViaReturn = findLiveIpc(returned);
      entry.calledIpc = (sent.length + invoked.length) > before;
    }
    members.push(entry);
  }
  out({ exposedKey, keys: Object.keys(exposed || {}), members, sent, invoked, walkerSelfTest });
}

// ── shared fakes for the main-process modes ─────────────────────────────────
const openedUrls = [];
const networkCalls = [];
const requiredModules = [];
const onHandlers = {};
const permissionRequestHandlers = [];
const permissionCheckHandlers = [];
const devicePermissionHandlers = [];
let capturedWindowOpenHandler = null;
const willNavigateHandlers = [];
let mainContents = null;

function totalStub(name) {
  return new Proxy(function () {}, {
    get(target, prop) {
      if (prop === 'then' || prop === Symbol.toPrimitive || typeof prop === 'symbol') return undefined;
      if (prop === '__stubName') return name;
      return totalStub(`${name}.${String(prop)}`);
    },
    apply() { return totalStub(`${name}()`); },
    construct() { return totalStub(`new ${name}`); },
    has() { return true; },
  });
}

// One fake session, shared the way Electron shares a default session.
const fakeSession = {
  setPermissionRequestHandler(fn) { permissionRequestHandlers.push(fn); },
  setPermissionCheckHandler(fn) { permissionCheckHandlers.push(fn); },
  setDevicePermissionHandler(fn) { devicePermissionHandlers.push(fn); },
  webRequest: { onBeforeRequest() {}, onHeadersReceived() {} },
  setSpellCheckerEnabled() {},
};

class FakeWebContents {
  constructor() {
    this.session = fakeSession;
    this._on = {};
  }
  on(event, cb) { (this._on[event] ||= []).push(cb); if (event === 'will-navigate') willNavigateHandlers.push(cb); }
  setWindowOpenHandler(fn) { capturedWindowOpenHandler = fn; }
  openDevTools() {}
  closeDevTools() {}
  isDevToolsOpened() { return false; }
  send() {}
  getURL() { return 'http://127.0.0.1:14322/'; }
  setZoomFactor() {}
  setZoomLevel() {}
  setVisualZoomLevelLimits() {}
  insertCSS() { return Promise.resolve(''); }
  executeJavaScript() { return Promise.resolve(undefined); }
  reload() {}
  removeAllListeners() {}
  once(event, cb) { return this.on(event, cb); }
  setUserAgent() {}
  getUserAgent() { return 'fake'; }
}

class FakeBrowserWindow {
  constructor() { this.webContents = new FakeWebContents(); mainContents = this.webContents; }
  loadURL() {}
  on() {}
  once() {}
  show() {}
  isMinimized() { return false; }
  restore() {}
  focus() {}
  setBackgroundColor() {}
  static fromWebContents() { return null; }
  static getAllWindows() { return []; }
}

const fakeApp = {
  isReady: () => true,
  on(event, cb) { (onHandlers[event] ||= []).push(cb); },
  quit() {}, exit() {},
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  getPath: () => '/tmp',
  getVersion: () => '0.0.224',
  setName() {},
  commandLine: { appendSwitch() {}, appendArgument() {}, hasSwitch: () => false, getSwitchValue: () => '' },
};

// shell.openExternal is recorded on the FUNCTION, so destructuring it
// (`const { openExternal } = shell`) or aliasing it still records every call.
const recordingOpenExternal = (u) => { openedUrls.push(String(u)); return Promise.resolve(); };
const fakeShell = {
  openExternal: recordingOpenExternal,
  openPath: (p) => { openedUrls.push(`openPath:${String(p)}`); return Promise.resolve(''); },
  showItemInFolder: (p) => { openedUrls.push(`showItemInFolder:${String(p)}`); },
  trashItem: () => Promise.resolve(),
  beep() {},
};

const fakeElectron = {
  app: fakeApp,
  BrowserWindow: FakeBrowserWindow,
  ipcMain: { on() {}, handle() {} },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }), showErrorBox() {} },
  shell: fakeShell,
  session: { defaultSession: fakeSession, fromPartition: () => fakeSession },
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
  autoUpdater: totalStub('autoUpdater'),
  net: {
    request: (...a) => { networkCalls.push(['net.request', String(a[0]?.url ?? a[0])]); return totalStub('net.request()'); },
    connect: (...a) => { networkCalls.push(['net.connect', JSON.stringify(a[0])]); return totalStub('net.connect()'); },
  },
};

// Record every network-capable module the main process pulls in, and make each
// one recording rather than real.
const NET_MODULE_FAKES = {
  net: { connect: (...a) => { networkCalls.push(['net.connect', JSON.stringify(a[0])]); return totalStub('sock'); },
    createConnection: (...a) => { networkCalls.push(['net.createConnection', JSON.stringify(a[0])]); return totalStub('sock'); } },
  tls: { connect: (...a) => { networkCalls.push(['tls.connect', JSON.stringify(a[0])]); return totalStub('sock'); } },
  http: { get: (...a) => { networkCalls.push(['http.get', String(a[0])]); return totalStub('req'); },
    request: (...a) => { networkCalls.push(['http.request', String(a[0])]); return totalStub('req'); } },
  https: { get: (...a) => { networkCalls.push(['https.get', String(a[0])]); return totalStub('req'); },
    request: (...a) => { networkCalls.push(['https.request', String(a[0])]); return totalStub('req'); } },
  http2: { connect: (...a) => { networkCalls.push(['http2.connect', String(a[0])]); return totalStub('sess'); } },
  dgram: { createSocket: () => { networkCalls.push(['dgram.createSocket', '']); return totalStub('sock'); } },
  dns: { lookup: (h) => { networkCalls.push(['dns.lookup', String(h)]); },
    resolve: (h) => { networkCalls.push(['dns.resolve', String(h)]); } },
  child_process: {
    exec: (c) => { networkCalls.push(['child_process.exec', String(c)]); },
    execSync: (c) => { networkCalls.push(['child_process.execSync', String(c)]); },
    execFile: (c) => { networkCalls.push(['child_process.execFile', String(c)]); },
    spawn: (c) => { networkCalls.push(['child_process.spawn', String(c)]); return totalStub('proc'); },
    spawnSync: (c) => { networkCalls.push(['child_process.spawnSync', String(c)]); },
  },
};

// fetch is a global, not a module: wrap it before the app loads.
globalThis.fetch = (url, init) => {
  networkCalls.push(['fetch', String(url)]);
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ version: '9.9.9' }),
    text: async () => '{"version":"9.9.9"}',
  });
};
globalThis.WebSocket = function (url) { networkCalls.push(['WebSocket', String(url)]); return totalStub('ws'); };
globalThis.XMLHttpRequest = function () { networkCalls.push(['XMLHttpRequest', '']); return totalStub('xhr'); };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  // Only record what electron-main itself pulls in, not transitive deps.
  if (parent && parent.filename === path.resolve(mainCjs)) requiredModules.push(request);
  if (request === 'electron') return fakeElectron;
  if (/dist[/\\]server\.cjs$/.test(request)) return {};
  const bare = request.replace(/^node:/, '');
  if (Object.prototype.hasOwnProperty.call(NET_MODULE_FAKES, bare)) return NET_MODULE_FAKES[bare];
  if (bare === 'ws') return globalThis.WebSocket;
  return originalLoad.call(this, request, parent, isMain);
};

require(path.resolve(mainCjs));

const fire = (event, ...args) => {
  for (const cb of onHandlers[event] || []) { try { cb(...args); } catch { /* handler's own error */ } };
};

fire('ready');
// The policy is installed by hardenWebContents(), which runs inside
// createWindow() — so the window must actually be created, by the same door
// the shipping app uses: server.ts calls global.onExpressListening(port) once
// Express binds. Without this the handlers are never installed and every
// "granted: []" below would be the harness measuring nothing.
if (typeof globalThis.onExpressListening === 'function') {
  // A throw here means the fake is missing a method the real code calls. That
  // MUST be loud: a half-created window installs no handlers, and every
  // "granted: []" would then be the harness measuring nothing.
  try { globalThis.onExpressListening(14322); } catch (e) {
    out({ error: `createWindow threw under the fake: ${e.message}. The fake electron surface is `
      + 'incomplete, so this run measured nothing.' });
  }
} else {
  out({ error: 'global.onExpressListening was never defined — the app never reached its '
    + 'window-creation door, so nothing below measures the real policy.' });
}

if (mode === 'permissions') {
  // Every documented Electron permission name, plus one that does not exist.
  const ALL = ['clipboard-read', 'clipboard-sanitized-write', 'display-capture', 'fullscreen',
    'geolocation', 'hid', 'idle-detection', 'keyboardLock', 'media', 'mediaKeySystem',
    'midi', 'midiSysex', 'notifications', 'openExternal', 'pointerLock', 'serial',
    'speaker-selection', 'storage-access', 'top-level-storage-access', 'usb',
    'window-management', 'fileSystem', 'background-sync', 'unknown-permission'];
  const granted = [];
  const checked = [];
  const reqHandler = permissionRequestHandlers[permissionRequestHandlers.length - 1];
  const chkHandler = permissionCheckHandlers[permissionCheckHandlers.length - 1];
  for (const p of ALL) {
    if (typeof reqHandler === 'function') {
      reqHandler({}, p, (allow) => { if (allow) granted.push(p); });
    }
    if (typeof chkHandler === 'function') {
      try { if (chkHandler({}, p)) checked.push(p); } catch { /* ignore */ }
    }
  }
  let deviceGranted = null;
  if (devicePermissionHandlers.length) {
    try { deviceGranted = devicePermissionHandlers[0]({ deviceType: 'hid', device: {} }); } catch { deviceGranted = 'threw'; }
  }
  out({
    requestHandlerInstalled: typeof reqHandler === 'function',
    checkHandlerInstalled: typeof chkHandler === 'function',
    deviceHandlerInstalled: devicePermissionHandlers.length > 0,
    granted, checked, deviceGranted, probed: ALL.length,
  });
}

if (mode === 'egress') {
  // Drive the update check the way the app does, then report every call.
  // The update check is scheduled 3000ms after the first window opens, so wait
  // past it. The test asserts the fetch DID happen: a run that records nothing
  // would otherwise "prove" the app makes no calls by never letting it try.
  const done = () => out({
    networkCalls,
    requiredModules: [...new Set(requiredModules)],
    openedUrls,
  });
  fire('browser-window-created', {}, { webContents: mainContents });
  setTimeout(done, 4200);
}

if (mode === 'openexternal') {
  const HOSTILE = ['file:///etc/passwd', 'smb://evil/share', 'javascript:alert(1)',
    'data:text/html,<script>1</script>', 'tel:+15551234', 'vscode://evil/x',
    'http://plain.example/x', 'https://ok.example/x'];
  const windowOpenVerdicts = [];
  const navigationPrevented = [];
  for (const url of HOSTILE) {
    if (typeof capturedWindowOpenHandler === 'function') {
      let v; try { v = capturedWindowOpenHandler({ url }); } catch { v = 'threw'; }
      windowOpenVerdicts.push([url, v && v.action ? v.action : String(v)]);
    }
    for (const cb of willNavigateHandlers) {
      let prevented = false;
      try { cb({ preventDefault() { prevented = true; } }, url); } catch { /* ignore */ }
      navigationPrevented.push([url, prevented]);
    }
  }
  setTimeout(() => out({
    openedUrls,
    windowOpenVerdicts,
    navigationPrevented,
    windowOpenHandlerInstalled: typeof capturedWindowOpenHandler === 'function',
    willNavigateHandlerCount: willNavigateHandlers.length,
  }), 300);
}

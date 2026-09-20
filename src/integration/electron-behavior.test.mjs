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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = join(repo, 'src', 'desktop', 'electron-behavior-runner.cjs');

let checks = 0;
function ok(cond, msg) { checks++; assert(cond, msg); }

function run(mode) {
  const stdout = execFileSync('node', [RUNNER, repo, mode], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_ENV: 'test' },
  });
  const line = stdout.split('\n').find((l) => l.startsWith('RUNNER_RESULT '));
  assert(line, `runner (${mode}) printed no RUNNER_RESULT:\n${stdout}`);
  const result = JSON.parse(line.slice('RUNNER_RESULT '.length));
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

// ─────────────────────────────────────────────────────────────────────────────
// 2. BRIDGE — identity, not text. Nothing exposed may BE a live IPC handle.
// ─────────────────────────────────────────────────────────────────────────────
const bridge = run('bridge');
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
ok(Object.keys(bridge.walkerSelfTest || {}).length >= 6,
  'SELF-TEST: the walker self-test must actually report its cases — an empty object would make the '
  + 'loop above iterate over nothing.');

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
// The module list IS the egress surface: a network module that is never
// required cannot be called, whatever the call-site text looks like.
const ALLOWED_MODULES = ['electron', 'path', 'fs', './dist/server.cjs'];
assert.deepStrictEqual(egress.requiredModules.slice().sort(), ALLOWED_MODULES.slice().sort(),
  `electron-main.cjs must require exactly ${JSON.stringify(ALLOWED_MODULES)} (got `
  + `${JSON.stringify(egress.requiredModules)}). Adding net/tls/http2/dgram/dns/child_process/ws here `
  + 'is the precondition for any egress route that does not go through fetch.');
checks++;

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
for (const [url, prevented] of ext.navigationPrevented) {
  ok(prevented === true,
    `a will-navigate to ${JSON.stringify(url)} was NOT prevented. The window must stay on its own `
    + 'origin; anything else is navigated externally through the scheme gate or not at all.');
}
ok(ext.openedUrls.length > 0,
  'CONTROL: at least one URL must reach shell.openExternal during the run, or the scheme assertions '
  + 'below are checking an empty list — which is exactly how a broken harness looks like a pass.');
for (const u of ext.openedUrls) {
  ok(u.startsWith('https://'),
    `shell.openExternal received ${JSON.stringify(u)}, which is not https. Recorded on the fake `
    + 'function itself, so destructuring (`const { openExternal } = shell`), aliasing, or calling it '
    + 'from inside a template interpolation records identically — the spelling cannot hide the call. '
    + 'file:// opens Finder on an arbitrary path; javascript:/data: execute.');
}

console.log(`electron-behavior.test.mjs: ${checks} checks passed`);

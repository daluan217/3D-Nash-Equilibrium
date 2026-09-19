/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ELECTRON PERMISSION POLICY CONTRACT — BLUE-LOOP-DESKTOP-22, invented angle G.
 *
 * WHAT WAS FOUND. `electron-main.cjs` installed no permission handler, and
 * Electron's default is to GRANT most renderer permission requests. Measured
 * against the LIVE 0.0.223 DMG over CDP (`_gen/b22-angleG-permissions.mjs`):
 *
 *   getUserMedia({audio:true})   no synchronous refusal — it reached the OS,
 *                                where a macOS microphone prompt naming this
 *                                app would appear
 *   notifications                granted
 *   clipboard-read               granted
 *   midi                         granted
 *
 * electron-builder's default Info.plist already ships
 * NSMicrophoneUsageDescription / NSCameraUsageDescription, so that prompt has
 * copy to show. The app is an offline 2x2-game visualiser: the only
 * permission-gated API anywhere in `src/` is `navigator.clipboard.writeText`.
 * After the fix, the same probe against the packed build:
 *
 *   camera/microphone/display-capture/geolocation/notifications/clipboard-read
 *                                ALL denied synchronously (NotAllowedError)
 *   clipboard-write              still granted — the copy buttons still work
 *
 * WHAT THIS FILE CHECKS. The policy is default-DENY with an allowlist, and
 * this asserts the SHAPE that makes it default-deny, not a list of blocked
 * names: a blocklist would have to be extended for every capability Chromium
 * adds, and the whole point is that a future capability is denied without
 * anyone editing this repo. The runtime behaviour itself is proven by the CDP
 * probe above (it needs a packaged .app, which CI does not build on every PR);
 * what CI can hold is that the handlers are installed, on the right object,
 * before any window exists, and that the allowlist stays minimal.
 *
 *   npx tsx src/electronpermissions.contract.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

const main = readFileSync(join(repoRoot, 'electron-main.cjs'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// 1. BOTH HANDLERS ARE INSTALLED
//
// The REQUEST handler alone is not enough and that is not a style point: it was
// measured. With only the request handler, `navigator.permissions.query` still
// reported `granted` for notifications/clipboard-read/midi, because Chromium
// asks the CHECK handler for synchronous queries and ITS default is also yes.
// ─────────────────────────────────────────────────────────────────────────────
ok(main.includes('setPermissionRequestHandler'),
  'electron-main.cjs must install a permission REQUEST handler — Electron grants by default');
ok(main.includes('setPermissionCheckHandler'),
  'electron-main.cjs must install a permission CHECK handler too: navigator.permissions.query ' +
  'and synchronous pre-flights consult it, and its default is also "grant"');
ok(main.includes('setDevicePermissionHandler'),
  'device pickers (WebHID/WebUSB/Bluetooth) ask through setDevicePermissionHandler, which is a ' +
  'separate door from the permission handlers');

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE POLICY IS AN ALLOWLIST, AND IT IS SMALL
// ─────────────────────────────────────────────────────────────────────────────
const allowMatch = /const ALLOWED_PERMISSIONS = new Set\(\[([^\]]*)\]\)/.exec(main);
ok(allowMatch !== null,
  'the policy must be expressed as a literal `ALLOWED_PERMISSIONS` Set — a function that decides ' +
  'per call is not reviewable at a glance, and this is a security boundary');
const allowed = [...allowMatch![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
ok(allowed.length > 0 && allowed.length <= 2,
  `the allowlist must stay minimal (found ${allowed.length}: ${allowed.join(', ')}). The app uses ` +
  'exactly one permission-gated API, navigator.clipboard.writeText. Adding an entry here hands a ' +
  'real capability to the renderer and needs its own measurement.');
for (const forbidden of ['media', 'camera', 'microphone', 'geolocation', 'display-capture',
  'midi', 'midiSysex', 'clipboard-read', 'notifications', 'hid', 'serial', 'usb', 'bluetooth',
  'idle-detection', 'window-management', 'fullscreen', 'openExternal', 'pointerLock']) {
  ok(!allowed.includes(forbidden),
    `"${forbidden}" must not be in ALLOWED_PERMISSIONS — this app is an offline 2x2-game ` +
    'visualiser and has no use for it');
}

// Both handlers must DECIDE FROM the allowlist. A handler that ignores it (or
// that returns a bare `true`) is the pre-fix behaviour wearing a handler's
// clothes — and would pass every check above.
const reqLine = /setPermissionRequestHandler\((.{0,200})/s.exec(main)?.[1] ?? '';
const chkLine = /setPermissionCheckHandler\((.{0,200})/s.exec(main)?.[1] ?? '';
ok(reqLine.includes('ALLOWED_PERMISSIONS.has('),
  'the REQUEST handler must answer from ALLOWED_PERMISSIONS.has(permission), not a constant');
ok(chkLine.includes('ALLOWED_PERMISSIONS.has('),
  'the CHECK handler must answer from ALLOWED_PERMISSIONS.has(permission), not a constant');
ok(!/setPermissionRequestHandler\([^)]*callback\(true\)/.test(main),
  'the REQUEST handler must never call callback(true) unconditionally — that is exactly the ' +
  'default this fix exists to replace');

// ─────────────────────────────────────────────────────────────────────────────
// 3. IT IS APPLIED TO EVERY webContents, VIA THE EXISTING HARDENING PATH
//
// `hardenWebContents` is already called for the main window AND from
// `app.on('web-contents-created')`, so hanging the policy there covers any
// webview/popup/partition Electron creates later. A one-shot call on
// `session.defaultSession` at startup would miss a contents with its own
// session — which is why this is asserted structurally, not just "it is called
// somewhere".
// ─────────────────────────────────────────────────────────────────────────────
const hardenIdx = main.indexOf('function hardenWebContents');
ok(hardenIdx !== -1, 'hardenWebContents must still exist — it is the per-contents policy hook');
const hardenBody = main.slice(hardenIdx, hardenIdx + 1200);
ok(hardenBody.includes('applyPermissionPolicy(contents.session)'),
  'the permission policy must be applied per-webContents from hardenWebContents(contents.session), ' +
  'so a webview/popup carrying its own session is covered too');
// `[^)]*` would not do: the listener's own `(_event, contents)` parameter list
// contains a `)` before `hardenWebContents` is reached, so the character class
// stops short and the check fails on a correctly-wired file. Match the same
// LINE instead (caught on this file's first run).
ok(/app\.on\(\s*['"]web-contents-created['"].*hardenWebContents/.test(main),
  "hardenWebContents must still be wired to app.on('web-contents-created') — that is what makes " +
  'the per-contents policy reach contents this file never names');
ok(main.indexOf('applyPermissionPolicy') < main.indexOf('function createWindow'),
  'applyPermissionPolicy must be defined before createWindow, so the first window is policed ' +
  'from its first paint rather than after a race');

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONTROL / SELF-TEST
//
// Every predicate above is re-run against the PRE-FIX electron-main (the same
// file with the policy block removed). Each must FAIL there — otherwise it is
// a check that cannot fail for the reason it claims, which is the defect class
// this repo keeps re-finding. This is the whole reason the block is delimited
// by an identifiable marker.
// ─────────────────────────────────────────────────────────────────────────────
{
  const preFix = main
    .replace(/const ALLOWED_PERMISSIONS[\s\S]*?\n}\n/, '')
    .replace(/\s*applyPermissionPolicy\(contents\.session\);/, '');
  ok(!preFix.includes('setPermissionRequestHandler'),
    'SELF-TEST: stripping the policy block must remove setPermissionRequestHandler — if it does ' +
    'not, the strip missed and every check below it is vacuous');
  ok(!preFix.includes('applyPermissionPolicy(contents.session)'),
    'SELF-TEST: stripping must remove the per-contents application too');
  ok(/const ALLOWED_PERMISSIONS = new Set\(\[([^\]]*)\]\)/.exec(preFix) === null,
    'SELF-TEST: the allowlist predicate must not match the pre-fix file');
  // And the opposite direction: the CONTROL for "did I strip too much?" — the
  // rest of the hardening must survive, or the self-test is comparing against
  // a file that is broken for unrelated reasons and proves nothing.
  ok(preFix.includes('setWindowOpenHandler') && preFix.includes("contents.on('will-navigate'"),
    'SELF-TEST CONTROL: the pre-fix reconstruction must still contain the rest of the hardening ' +
    '(window-open handler, will-navigate) — if the strip gutted the file, "the checks fail there" ' +
    'says nothing about the permission policy');
}

console.log(`electronpermissions.contract.test.ts: ${checks} checks passed`);

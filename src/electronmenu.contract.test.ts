/**
 * The packaged desktop app must not ship a DevTools/reload surface.
 *
 * WHY THIS EXISTS. RED-DESKTOP-21/001: `electron-main.cjs` never called
 * `Menu.setApplicationMenu` (`Menu` was not even imported) and its sole
 * `webPreferences` block had no `devTools: false`, so Electron installed its
 * DEFAULT application menu — whose View submenu carries live `toggleDevTools`,
 * `reload` and `forceReload` roles — on the real shipped .app. Reproduced
 * against the installed 0.0.214 binary over the Node Inspector protocol:
 * `Menu.getApplicationMenu()` listed all three roles, and
 * `webContents.openDevTools()` (exactly what the `toggledevtools` role calls
 * internally) flipped `isDevToolsOpened` false -> true with a live
 * `devtools://` page appearing in the CDP target list.
 *
 * Nothing in CI could see it: `npm run lint` is `tsc --noEmit` with `allowJs`
 * and no `checkJs`, there is no ESLint, and no test boots the packaged app, so
 * a `.cjs` file is invisible to every job. This is a TEXT contract for the same
 * reason `src/electronenv.contract.test.ts` is: importing `electron-main.cjs`
 * would construct Electron's `app` and start a browser process, and the failure
 * mode here is DELETION, not malfunction.
 *
 * MUTATION-TESTED — each of these, applied to the fixed tree, fails this file
 * by name (see the round-21 REPORT for the recorded output):
 *   M1  remove `devTools: false` from webPreferences      -> check 2 fails
 *   M2  add `{ role: 'reload' }` to the View submenu      -> check 4 fails
 *   M3  delete the `Menu.setApplicationMenu(...)` call    -> check 3 fails
 *   M4  swap the explicit View submenu for `{ role: 'viewMenu' }` -> check 5 fails
 *   M5  drop the `Menu` import from require('electron')   -> check 1 fails
 *   M6  make devTools conditional (`devTools: !app.isPackaged`) -> check 2 fails
 *
 *   npx tsx src/electronmenu.contract.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

const main = readFileSync(join(repo, 'electron-main.cjs'), 'utf8');
const indexHtml = readFileSync(join(repo, 'index.html'), 'utf8');

// A comment must never satisfy this contract — a rule a comment can pass is not
// a rule, and this file's own header names `toggleDevTools`/`reload` in prose.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
ok(!stripComments("// Menu.setApplicationMenu(x);").includes('setApplicationMenu'),
  'the comment stripper must remove a line comment');
ok(!stripComments("/* devTools: false */").includes('devTools'),
  'the comment stripper must remove a block comment');
ok(stripComments("devTools: false,").includes('devTools: false'),
  'the comment stripper must keep real code');

const code = stripComments(main);

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1 — `Menu` is actually imported from electron.
// Without the import, `Menu.setApplicationMenu` is a ReferenceError at runtime
// and the default menu survives; a text check for the CALL alone would pass on
// a file that throws on every launch.
// ─────────────────────────────────────────────────────────────────────────────
const electronRequire = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]electron['"]\s*\)/.exec(code);
ok(electronRequire !== null, 'electron-main.cjs must destructure its imports from require("electron")');
const imported = (electronRequire as RegExpExecArray)[1].split(',').map((s) => s.split(':')[0].trim());
ok(imported.includes('Menu'),
  `electron-main.cjs must import Menu from electron (found: ${imported.join(', ')}). `
  + 'Without it setApplicationMenu throws and Electron keeps its default menu, '
  + 'which ships live Toggle Developer Tools / Reload / Force Reload (RED-DESKTOP-21/001).');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2 — every webPreferences block sets `devTools: false`, UNCONDITIONALLY.
// This is the capability-level kill: with it, openDevTools() is a no-op no
// matter which menu item, accelerator or stray call reaches it. `devTools:
// !app.isPackaged` or `devTools: someFlag` must NOT pass — a dev-only escape
// hatch is exactly the shape that ships enabled when a build flag drifts.
// ─────────────────────────────────────────────────────────────────────────────
const webPrefBlocks = [...code.matchAll(/webPreferences\s*:\s*\{/g)];
ok(webPrefBlocks.length > 0, 'electron-main.cjs must declare webPreferences for its BrowserWindow');
/** Read a property declared at the TOP level of an object literal body. */
function topLevelProp(body: string, key: string): string | null {
  let depth = 0;
  const re = new RegExp(`\\b${key}\\s*:`, 'g');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(body);
      if (m && m.index === i) {
        const rest = body.slice(i + m[0].length);
        const value = /^\s*([^,\n}]+)/.exec(rest);
        return value ? value[1].trim() : '';
      }
    }
  }
  return null;
}
// Prove the reader ignores NESTED keys — otherwise `{ a: { devTools: false },
// devTools: true }` would pass a naive whole-block search (reviewer finding).
ok(topLevelProp('a: { devTools: false }, devTools: true', 'devTools') === 'true',
  'topLevelProp must read the TOP-LEVEL devTools, not one nested inside another object');
ok(topLevelProp('sandbox: true, devTools: false', 'devTools') === 'false',
  'topLevelProp must read a real top-level devTools');
ok(topLevelProp('sandbox: true', 'devTools') === null,
  'topLevelProp must report a missing key as null');
for (const m of webPrefBlocks) {
  // Walk braces from the opening `{` so a nested object cannot truncate the block.
  let depth = 0;
  let end = m.index! + m[0].length;
  for (let i = m.index! + m[0].length - 1; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = code.slice(m.index! + m[0].length, end);
  const devToolsValue = topLevelProp(body, 'devTools');
  ok(devToolsValue === 'false',
    'every webPreferences block in electron-main.cjs must set devTools: false at its TOP level, '
    + `unconditionally (found: ${devToolsValue === null ? 'no devTools key at all' : devToolsValue}). `
    + 'Without it the shipped renderer can be inspected: RED-DESKTOP-21/001 flipped '
    + 'isDevToolsOpened false -> true on the real 0.0.214 binary.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3 — an application menu is installed explicitly.
// Electron installs its default menu whenever none is set, so "no call" is not
// "no menu" — it is the DEFAULT menu, the one that carries the devtools role.
// ─────────────────────────────────────────────────────────────────────────────
ok(/Menu\.setApplicationMenu\s*\(/.test(code),
  'electron-main.cjs must call Menu.setApplicationMenu(...). With no call at all Electron '
  + 'installs its DEFAULT menu, whose View submenu has toggleDevTools/reload/forceReload.');
ok(/Menu\.buildFromTemplate\s*\(/.test(code),
  'electron-main.cjs must build its menu with Menu.buildFromTemplate(...) so the template '
  + 'below is auditable by this test.');
// The call must be reachable at startup, not merely defined: it has to be
// invoked somewhere other than its own declaration.
const installerName = /function\s+(\w+)\s*\(\s*\)\s*\{[^]*?Menu\.setApplicationMenu/.exec(code);
if (installerName) {
  const calls = [...code.matchAll(new RegExp(`\\b${installerName[1]}\\s*\\(`, 'g'))];
  ok(calls.length >= 2,
    `${installerName[1]}() defines the menu but is never called — a menu installer that no `
    + 'startup path invokes leaves Electron\'s default menu in place.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 4 — the template names none of the banned roles.
// Case-insensitive because Electron accepts both `toggleDevTools` and
// `toggledevtools`; a case-sensitive check would miss half the spellings.
// ─────────────────────────────────────────────────────────────────────────────
for (const banned of ['toggleDevTools', 'reload', 'forceReload']) {
  const re = new RegExp(`role\\s*:\\s*['"]${banned}['"]`, 'i');
  ok(!re.test(code),
    `electron-main.cjs must not declare a menu role '${banned}'. toggleDevTools opens an `
    + 'inspector on the production renderer; reload/forceReload silently discard the user\'s '
    + 'in-memory game state in this SPA (RED-DESKTOP-21/001).');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 5 — no `viewMenu` shorthand.
// `{ role: 'viewMenu' }` passes check 4 (it does not spell the banned roles)
// while expanding at runtime into EXACTLY reload + forceReload + toggleDevTools.
// This is the mutant that a naive banned-word test cannot catch.
// ─────────────────────────────────────────────────────────────────────────────
ok(!/role\s*:\s*['"]viewMenu['"]/i.test(code),
  "electron-main.cjs must not use the `viewMenu` role shorthand: Electron expands it into "
  + 'Reload, Force Reload and Toggle Developer Tools. Spell the View submenu out with only '
  + 'the zoom/fullscreen roles.');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6 — no direct devtools API calls anywhere in the main process.
// devTools:false already neuters these, but a call here means someone intended
// an inspector, and intent plus one reverted line is how the defect returns.
// ─────────────────────────────────────────────────────────────────────────────
for (const api of ['openDevTools', 'toggleDevTools', 'inspectElement']) {
  ok(!new RegExp(`\\.${api}\\s*\\(`).test(code),
    `electron-main.cjs must not call ${api}() — the packaged app never opens an inspector.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 7 — the roles users actually need survive the replacement.
// The fix's own regression risk: replacing the default menu removes Cmd+C/V/Z,
// Cmd+Q, Cmd+W and fullscreen unless the template keeps them. Verified live on
// the fixed binary (edit + window roles still present in the menu dump); this
// check is what keeps a future edit from quietly dropping them.
// ─────────────────────────────────────────────────────────────────────────────
for (const keep of ['appMenu', 'editMenu', 'windowMenu']) {
  ok(new RegExp(`role\\s*:\\s*['"]${keep}['"]`, 'i').test(code),
    `electron-main.cjs's menu template must keep the '${keep}' role. Dropping it removes `
    + 'clipboard/undo/select-all, or minimize/zoom/close, from an app that has no other '
    + 'way to reach them.');
}
ok(/role\s*:\s*['"]togglefullscreen['"]/i.test(code),
  "the menu template must keep 'togglefullscreen' — the app listens for "
  + "enter-full-screen/leave-full-screen and tells the renderer about them.");

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 8 — Chromium's background network services are switched off.
//
// RED-DESKTOP-21/002: the packaged app is an offline math tool, but Chromium's
// variations/field-trial seed fetch, component updater, Safe Browsing and domain
// reliability are ON by default, and reached Google from process spawn — 39 of 40
// idle snapshots carried a live non-loopback connection (142.250.190.238,
// 142.250.68.200) before any window painted. MEASURED, not guessed: with these
// switches the same harness shows 5/40 snapshots and a single remaining IP,
// 216.239.36.21 = nash-equilibrium-simulator.com, held by the MAIN process at
// t=3500ms — the disclosed checkForUpdates call, which stays.
// ─────────────────────────────────────────────────────────────────────────────
ok(/appendSwitch\s*\(\s*['"]disable-background-networking['"]\s*\)/.test(code),
  "electron-main.cjs must appendSwitch('disable-background-networking') — the documented "
  + "primary guard for Chromium's own background services (RED-DESKTOP-21/002).");
// Only switches with a MEASURED effect ship. `variations-server-url` with an empty
// value falls back to the default Google URL (reviewer, verified by ablation: removing
// it changed nothing), and the rest showed no measured effect on the egress harness, so
// the contract actively forbids re-adding them unmeasured.
for (const dead of ['variations-server-url', 'safebrowsing-disable-auto-update', 'ChromeVariations']) {
  ok(!new RegExp(`['"]${dead}['"]`).test(code),
    `electron-main.cjs must not pass '${dead}': it has no measured effect here, and an empty `
    + 'variations-server-url falls back to the DEFAULT Google variations URL — worse than absent. '
    + 'Anything re-added must first show a difference on _gen/blue21-bg-network.mjs.');
}

// The switches must be appended BEFORE the app becomes ready: Chromium reads its
// command line during startup, so a switch added afterwards is silently ignored
// and this whole block would be decorative. EVERY call is checked, not just the
// first — one late appendSwitch among several early ones is exactly the drift
// this guards, and a first-index-only check cannot see it.
const switchCalls = [...code.matchAll(/app\.commandLine\.appendSwitch\s*\(/g)].map((m) => m.index!);
ok(switchCalls.length > 0, 'electron-main.cjs must call app.commandLine.appendSwitch(...)');
const readyMarkers = [/app\.whenReady\s*\(/, /app\.on\s*\(\s*['"]ready['"]/];
for (const marker of readyMarkers) {
  const at = code.search(marker);
  if (at === -1) continue;
  const late = switchCalls.filter((i) => i > at);
  ok(late.length === 0,
    `every app.commandLine.appendSwitch(...) must come BEFORE app ready — Chromium reads its `
    + `command line at startup, so a switch appended later has no effect at all `
    + `(${late.length} call(s) found after it).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 9 — analytics is gated off under Electron, and still live on the web.
//
// The packaged renderer's ONE non-loopback host was www.google-analytics.com,
// loaded by a static <script> tag in index.html with no Electron gating. The gate
// must be a real runtime branch, not a deleted tag: measured on the SAME built
// dist/, a web UA still resolves googletagmanager + google-analytics with
// typeof gtag === 'function', while an Electron UA resolves neither and leaves
// gtag undefined (/tmp/blue21-desktop/gtag-web.log).
// ─────────────────────────────────────────────────────────────────────────────
ok(indexHtml.includes('googletagmanager.com'),
  'index.html must still load Google Analytics for the WEBSITE — this gate is desktop-only, '
  + 'and deleting analytics outright is a different (unrequested) change.');
const gtagScriptTag = /<script[^>]*\ssrc\s*=\s*["'][^"']*googletagmanager[^"']*["']/i.test(indexHtml);
ok(!gtagScriptTag,
  'index.html must not load googletagmanager from a STATIC <script src> tag: a static tag '
  + 'fetches before any JavaScript can gate it, so the packaged desktop app hits Google '
  + 'regardless (RED-DESKTOP-21/002). Insert the script from the gated branch instead.');
ok(/userAgent/.test(indexHtml) && /electron/i.test(indexHtml),
  'index.html must gate analytics on an Electron check (userAgent contains "electron", the '
  + "same test App.tsx uses for isElectron) before inserting the tag.");
// The gate must RETURN before the insertion — an `if (...)` that only logs would
// pass the two checks above while still loading the script. Paren-WALK rather
// than a regex: the real condition contains its own parentheses
// (`ua.indexOf('electron') !== -1 || window.nashDesktop`), which `[^)]*` cannot
// span, and loosening that pattern is how a check stops meaning anything.
function gatedReturnBeforeAnalytics(html: string): boolean {
  const insertAt = html.search(/googletagmanager/i);
  if (insertAt === -1) return false;
  for (const m of html.matchAll(/\bif\s*\(/gi)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < html.length; i++) {
      if (html[i] === '(') depth++;
      else if (html[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close === -1 || close > insertAt) continue;
    const cond = html.slice(open, close + 1);
    if (!/electron/i.test(cond) && !/nashDesktop/.test(cond)) continue;
    // What the taken branch does: a bare `return;` or a block whose first
    // statement is `return;`.
    const after = html.slice(close + 1, close + 120);
    if (/^\s*return\s*;/.test(after) || /^\s*\{\s*return\s*;/.test(after)) return true;
  }
  return false;
}
ok(gatedReturnBeforeAnalytics(indexHtml),
  'the Electron branch in index.html must RETURN before the analytics script is inserted; '
  + 'a branch that merely detects Electron and carries on still loads the tag.');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 10 — POLARITY. The text checks above cannot see which way the gate points:
// `if (!ua.includes('electron')) return;` passes every one of them while doing the
// exact opposite (analytics on desktop, none on the web). So RUN the gate, in a
// real JS context, under three identities, and assert the outcome (reviewer item 5).
//
// The script body is executed with a stub `document`/`window`, which is also what
// makes this cheap enough for the unit job — no browser. The end-to-end version of
// the same assertion (real Chromium, real built dist/) is
// _gen/blue21-gtag-web-check.mjs: web UA -> googletagmanager + google-analytics
// requested, typeof gtag === 'function'; Electron UA -> neither, gtag undefined.
// ─────────────────────────────────────────────────────────────────────────────
const gateBody = (() => {
  const m = /<script>\s*\(function \(\) \{([\s\S]*?)\}\)\(\);\s*<\/script>/.exec(indexHtml);
  return m ? m[1] : null;
})();
ok(gateBody !== null, 'index.html must wrap the analytics gate in an IIFE this test can execute');

const ELECTRON_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0.0.0 '
  + 'Electron/31.7.7 Safari/537.36';
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Run the gate against a stub DOM; return the script src it tried to insert. */
function runGate(userAgent: string, bridge: unknown): string | null {
  let inserted: string | null = null;
  const win: Record<string, unknown> = {
    navigator: { userAgent },
    dataLayer: undefined,
    nashDesktop: bridge,
  };
  const doc = {
    createElement: () => ({ set src(v: string) { inserted = v; }, get src() { return inserted ?? ''; }, async: false }),
    head: { appendChild: () => {} },
  };
  // `window` and the bare globals the snippet uses both resolve to the same stub.
  const fn = new Function('window', 'document', 'navigator',
    `with (window) { ${gateBody as string} }`);
  fn(win, doc, win.navigator);
  return inserted;
}

// The web keeps analytics...
ok(runGate(WEB_UA, undefined) !== null,
  'a normal web visitor must still get the analytics script inserted — the gate is desktop-only.');
ok(String(runGate(WEB_UA, undefined)).includes('googletagmanager'),
  'the inserted script must be the googletagmanager tag');
// ...and every desktop identity does not. Two independent signals, so a UA
// override alone cannot re-enable analytics in the packaged app.
ok(runGate(ELECTRON_UA, undefined) === null,
  'an Electron user-agent must NOT get the analytics script (RED-DESKTOP-21/002).');
ok(runGate(WEB_UA, { setBackgroundColor: () => {} }) === null,
  'the preload bridge alone must suppress analytics, even with a spoofed/overridden web UA.');
ok(runGate(ELECTRON_UA, { setBackgroundColor: () => {} }) === null,
  'Electron UA plus bridge must not get analytics');
// A non-callable lookalike must NOT count as the bridge (reviewer item 6): the
// check is a capability, so a site setting window.nashDesktop = {} keeps analytics.
ok(runGate(WEB_UA, {}) !== null,
  'a window.nashDesktop without a callable setBackgroundColor is not the desktop bridge; '
  + 'analytics must still load for that web visitor.');

console.log(`electronmenu.contract.test.ts: ${checks} checks passed`);

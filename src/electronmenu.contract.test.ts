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
for (const m of webPrefBlocks) {
  // Walk braces from the opening `{` so a nested object cannot truncate the block.
  let depth = 0;
  let end = m.index! + m[0].length;
  for (let i = m.index! + m[0].length - 1; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const block = code.slice(m.index!, end);
  const devToolsValue = /devTools\s*:\s*([^,\n}]+)/.exec(block);
  ok(devToolsValue !== null && devToolsValue[1].trim() === 'false',
    'every webPreferences block in electron-main.cjs must set devTools: false, unconditionally '
    + `(found: ${devToolsValue ? devToolsValue[1].trim() : 'no devTools key at all'}). `
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

console.log(`electronmenu.contract.test.ts: ${checks} checks passed`);

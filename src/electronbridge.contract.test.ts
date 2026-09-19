/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PRELOAD / IPC BRIDGE CONTRACT — BLUE-LOOP-DESKTOP-22, invented angle I.
 *
 * WHAT WAS MEASURED (`_gen/b22-angleI-bridge.mjs`, against a packed build over
 * CDP — the probe came back EMPTY, and this file is what keeps it empty):
 *
 *   window.nashDesktop in the top frame        object     <- the feature
 *   ... in a srcdoc child                      undefined
 *   ... in an about:blank child                undefined
 *   ... in a data: child                       never loaded
 *   ... in a sandboxed child                   SecurityError on access
 *   ... in a Worker                            undefined
 *   11 hostile payloads + 2000 rapid repeats   renderer responsive, main alive,
 *                                              no uncaught exception, /api/health 200
 *
 * Nothing in the suite asserted WHY any of that holds, so every one of those
 * properties could be deleted without a test going red: contextIsolation, the
 * sandbox, nodeIntegration, the single-channel bridge, and the hex validator
 * on the IPC handler were all unguarded. An EMPTY probe that protects nothing
 * is not a passed round (Daniel, 2026-09-15), so this file checks in the
 * conditions the probe measured.
 *
 *   npx tsx src/electronbridge.contract.test.ts
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
const preload = readFileSync(join(repoRoot, 'electron-preload.cjs'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE RENDERER ISOLATION THAT KEEPS THE BRIDGE OUT OF CHILD CONTEXTS
//
// `contextIsolation: true` is why a srcdoc/about:blank child reads `undefined`
// rather than inheriting the exposed object, and `sandbox: true` is why the
// sandboxed child throws SecurityError instead. `nodeIntegration: false` is
// why a payload cannot reach `require`. These are read as TOP-LEVEL keys of a
// webPreferences block: a nested `{ contextIsolation: true }` inside some other
// object must not satisfy the check.
// ─────────────────────────────────────────────────────────────────────────────
function topLevelProp(block: string, key: string): string | null {
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (depth === 0) {
      const m = new RegExp(`^${key}\\s*:\\s*([A-Za-z0-9_'".]+)`).exec(block.slice(i));
      if (m && (i === 0 || /[\s,{]/.test(block[i - 1]))) return m[1];
    }
  }
  return null;
}
// The reader itself, proven on both polarities before it is trusted.
ok(topLevelProp('a: { contextIsolation: false }, contextIsolation: true', 'contextIsolation') === 'true',
  'topLevelProp must read the TOP-LEVEL key, not one nested in another object');
ok(topLevelProp('a: { contextIsolation: true }', 'contextIsolation') === null,
  'topLevelProp must report a key that exists only nested as missing');

const wpIdx = main.indexOf('webPreferences');
ok(wpIdx !== -1, 'electron-main.cjs must still configure webPreferences for the main window');
let depth = 0, wpEnd = wpIdx;
for (let i = main.indexOf('{', wpIdx); i < main.length; i++) {
  if (main[i] === '{') depth++;
  else if (main[i] === '}') { depth--; if (depth === 0) { wpEnd = i; break; } }
}
const wp = main.slice(main.indexOf('{', wpIdx) + 1, wpEnd);

ok(topLevelProp(wp, 'contextIsolation') === 'true',
  'webPreferences.contextIsolation must be true — it is what keeps window.nashDesktop out of a ' +
  'srcdoc/about:blank child (measured: undefined there, object in the top frame)');
ok(topLevelProp(wp, 'sandbox') === 'true',
  'webPreferences.sandbox must be true — measured: a sandboxed child throws SecurityError on ' +
  'contentWindow access instead of reading the bridge');
ok(topLevelProp(wp, 'nodeIntegration') === 'false',
  'webPreferences.nodeIntegration must be false — with it on, a bridge payload reaches require()');
ok(topLevelProp(wp, 'preload') !== null,
  'webPreferences.preload must be set, or there is no bridge at all and every check here is vacuous');
ok(topLevelProp(wp, 'webSecurity') !== 'false',
  'webPreferences.webSecurity must never be disabled');
ok(topLevelProp(wp, 'nodeIntegrationInSubFrames') !== 'true',
  'nodeIntegrationInSubFrames must not be enabled — that is precisely the child-frame door this ' +
  'angle attacked');
ok(topLevelProp(wp, 'allowRunningInsecureContent') !== 'true',
  'allowRunningInsecureContent must not be enabled');

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE BRIDGE SURFACE IS ONE FUNCTION, AND NOTHING RAW
//
// The risk is not this function; it is the next one. `ipcRenderer` itself, or
// a generic `send(channel, ...)`, hands the renderer every channel the main
// process has — the "trusting the IPC sender" defect class in the brief.
// ─────────────────────────────────────────────────────────────────────────────
ok(preload.includes('contextBridge.exposeInMainWorld'),
  'the preload must expose through contextBridge, never by assigning to window directly');
const exposedCalls = [...preload.matchAll(/contextBridge\.exposeInMainWorld\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
ok(exposedCalls.length === 1 && exposedCalls[0] === 'nashDesktop',
  `exactly one bridge object may be exposed (found: ${exposedCalls.join(', ') || 'none'}) — each ` +
  'one is a permanent piece of renderer-reachable API surface');
// Read the EXPOSED OBJECT and require every value to be a call expression.
// The first draft pattern-matched `: ipcRenderer` and a direct second argument,
// and the mutation run caught it: adding `ipcRenderer,` as an ES6 shorthand
// property inside the object survived both patterns while handing the renderer
// every channel in the app. So assert the shape — each member is `name: (…) =>`
// — instead of blacklisting the spellings of one leak.
const exposedBody = /exposeInMainWorld\([^,]+,\s*\{([\s\S]*?)\n\}\s*\)/.exec(preload)?.[1] ?? null;
ok(exposedBody !== null, 'the exposed bridge object must be an inline object literal, so it can be read here');
const members = exposedBody!
  .split('\n')
  .map((l) => l.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '').trim())
  .filter((l) => l.length > 0 && l !== ',');
ok(members.length > 0, 'the exposed bridge object must have at least one member, or nothing is bridged');
// Being a function expression is NECESSARY BUT NOT SUFFICIENT: `getRaw: () =>
// ipcRenderer` is a perfectly good arrow function that RETURNS the live object,
// so one call from the renderer has every channel in the app. So judge each
// member's BODY as well as its shape, and do it per member rather than by
// scanning the whole literal for `ipcRenderer` followed by `,` or `}` — that
// blacklist missed a FINAL member with no trailing comma (reviewer finding,
// reproduced: `getRaw: () => ipcRenderer` as the last entry passed).
const memberBody = (m: string) => m.replace(/^[A-Za-z_$][\w$]*\s*:\s*/, '')
  .replace(/^\([^)]*\)\s*=>\s*/, '').replace(/^[A-Za-z_$][\w$]*\s*=>\s*/, '')
  .replace(/[,;]\s*$/, '').trim();
const leaksRaw = (m: string) => {
  const body = memberBody(m);
  // A bare reference to the module object, however it is wrapped or returned.
  return /^\{?\s*(?:return\s+)?ipcRenderer\s*;?\s*\}?$/.test(body) || /\bipcRenderer\s*(?:[,}\]);]|$)/.test(body);
};
for (const member of members) {
  ok(/^[A-Za-z_$][\w$]*\s*:\s*\(?[^:]*\)?\s*=>/.test(member),
    `every bridge member must be a function expression (\`name: (…) => …\`); found ${JSON.stringify(member.slice(0, 60))}. ` +
    'A bare identifier — `ipcRenderer,` as an ES6 shorthand — hands the renderer a live object ' +
    'rather than one narrow call, which is the "trusting the IPC sender" defect class.');
  ok(!leaksRaw(member),
    `bridge member ${JSON.stringify(member.slice(0, 60))} hands the renderer the raw ipcRenderer ` +
    'object. Being an arrow function is not enough: one call to it returns every channel in the app.');
}
// Self-test on the reviewer's exact shapes plus the legitimate member, because
// a leak detector that fires on everything (or nothing) proves nothing.
for (const leak of ['getRaw: () => ipcRenderer', 'getRaw: () => ipcRenderer,',
  'raw: () => { return ipcRenderer; }', 'ipcRenderer,', 'ipcRenderer: ipcRenderer,',
  'send: ipcRenderer.send,']) {
  ok(leaksRaw(leak) || !/^[A-Za-z_$][\w$]*\s*:\s*\(?[^:]*\)?\s*=>/.test(leak),
    `SELF-TEST: ${JSON.stringify(leak)} must be rejected by one of the two member checks — it hands ` +
    'the renderer the raw ipcRenderer. A detector that misses it cannot fail for its stated reason.');
}
ok(!leaksRaw("setBackgroundColor: (color) => ipcRenderer.send('set-background-color', color),"),
  "SELF-TEST CONTROL: the app's own legitimate member (a narrow .send call) must NOT be flagged — " +
  'a detector that rejects everything would pass every check above and ban the feature.');
for (const raw of ['ipcRenderer.invoke', 'ipcRenderer.sendSync', 'ipcRenderer.postMessage',
  'exposeInIsolatedWorld', 'require(', 'process.']) {
  if (raw === 'require(') {
    // The preload's own top-level `require('electron')` is legitimate and is
    // not renderer-reachable; what must not happen is `require` crossing the
    // bridge. Check the exposed object literal, not the whole file.
    const exposed = /exposeInMainWorld\([^,]+,\s*\{([\s\S]*?)\n\}\s*\)/.exec(preload)?.[1] ?? '';
    ok(!exposed.includes('require('),
      'the exposed bridge object must not carry require()');
    continue;
  }
  ok(!preload.includes(raw),
    `the preload must not use ${raw} — the bridge is one fire-and-forget channel by design`);
}
const channels = [...preload.matchAll(/ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
ok(channels.length === 1 && channels[0] === 'set-background-color',
  `the preload may send exactly one channel (found: ${channels.join(', ') || 'none'})`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE MAIN-PROCESS HANDLER VALIDATES, AND ITS VALIDATOR ACTUALLY WORKS
//
// Not "a regex is present": the validator is EXTRACTED and EXECUTED, so a
// wrong polarity or a loosened pattern fails here. The measured payload set
// from the probe is replayed through it verbatim.
// ─────────────────────────────────────────────────────────────────────────────
const handlerIdx = main.indexOf("ipcMain.on('set-background-color'");
ok(handlerIdx !== -1, "the 'set-background-color' handler must still exist");
const handler = main.slice(handlerIdx, handlerIdx + 600);
ok(/typeof color !== 'string'/.test(handler),
  'the handler must reject a non-string before anything else — measured payloads include a number, ' +
  'an object with a toString, an array and null');
ok(handler.includes('BrowserWindow.fromWebContents(event.sender)'),
  'the handler must resolve the window from event.sender, never from a renderer-supplied id');
ok(/if \(win\)/.test(handler),
  'the handler must null-check the resolved window — fromWebContents returns null for a destroyed ' +
  'window, which is reachable by closing during an IPC storm');

const reMatch = /\/\^#\[0-9a-fA-F\]\{6\}\$\//.exec(handler);
ok(reMatch !== null,
  'the handler must validate the colour against an anchored 6-digit hex pattern');
const colourRe = new RegExp(reMatch![0].slice(1, -1));
const accept = (v: unknown) => typeof v === 'string' && colourRe.test(v);
// Replayed verbatim from the angle-I probe. Every one of these was SENT.
for (const [label, value] of [
  ['a number', 123], ['an object with toString', { toString() { return '#ff0000'; } }],
  ['null', null], ['an array', ['#ff0000']],
  ['a 5MB string', '#' + 'a'.repeat(5_000_000)],
  ['a CSS injection', '#000000; background: url(http://evil.invalid/x)'],
  ['a colour name', 'red'], ['short hex', '#fff'],
  ['a newline smuggle', '#000000\n#ff0000'],
  ['a leading-newline smuggle', '\n#000000'],
  ['a tab smuggle', '#000000\t'],
] as Array<[string, unknown]>) {
  ok(!accept(value), `the validator must reject ${label}`);
}
// CONTROL: it must still accept what the app itself sends, or "rejects
// everything" would pass every line above while breaking the feature.
for (const good of ['#020617', '#FFFFFF', '#0a0A0a']) {
  ok(accept(good), `the validator must still ACCEPT the app's own colour ${good} — a validator that ` +
    'rejects everything passes every rejection check and ships a broken feature');
}
// And the anchoring, specifically: `#000000\n#ff0000` is rejected only because
// the pattern is $-anchored. A mutant dropping the anchors must fail here.
ok(!accept('#000000\n'), 'the pattern must be end-anchored (a trailing newline must not pass)');
ok(!accept('x#000000'), 'the pattern must be start-anchored');

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE SINGLE-INSTANCE LOCK — BLUE-LOOP-DESKTOP-22, invented angle K
//
// MEASURED (`_gen/b22-angleK-twoinstances.mjs`, the real packaged binary
// launched TWICE against one user-data directory): instance B exited with code
// 0, bound no port, and A kept both its games — `db.json` ended
// ["K-A-first","K-A-second"]. No rival writer, no data loss.
//
// The SERVER half of this is already guarded end-to-end
// (desktop-concurrent-lock.test.mjs: a second dist/server.cjs refuses a
// directory another live process owns). The ELECTRON half was checked only by
// `desktop.contract.test.ts` requiring the module to LOAD — which passes just
// as well if the lock's result is ignored entirely. These are the semantics
// that make a second launch harmless, and they are what the probe measured:
//   - the lock is requested, and a FAILED lock quits immediately. Requesting
//     without acting is the whole defect: two live mains, two servers, two
//     diverging in-memory databases, last writer wins.
//   - the quit is UNCONDITIONAL on that branch. A quit behind a further
//     condition is how a second instance survives in some states.
//   - nothing in the losing branch creates a window or starts the server.
// ─────────────────────────────────────────────────────────────────────────────
ok(main.includes('app.requestSingleInstanceLock()'),
  'electron-main.cjs must request the single-instance lock — without it a second launch is a ' +
  'second server against the same db.json, and the last writer wins');
const lockVar = /const\s+([A-Za-z_$][\w$]*)\s*=\s*app\.requestSingleInstanceLock\(\)/.exec(main)?.[1];
ok(!!lockVar, 'the lock result must be captured in a constant, not discarded');
const loseIdx = main.indexOf(`if (!${lockVar})`);
ok(loseIdx !== -1,
  `the lock result (${lockVar}) must be BRANCHED ON — requesting the lock and ignoring the answer ` +
  'leaves two live main processes, which is the defect itself');
const loseBranch = main.slice(loseIdx, main.indexOf('} else {', loseIdx) + 1);
ok(/app\.quit\(\)\s*;/.test(loseBranch),
  'the losing branch must call app.quit() — measured: the second instance exits with code 0 and ' +
  'binds no port');
ok(!/if\s*\(/.test(loseBranch.slice(loseBranch.indexOf('{') + 1)),
  'the quit must be UNCONDITIONAL inside the losing branch; a further condition is how a second ' +
  `instance survives in some states. Branch was: ${JSON.stringify(loseBranch.slice(0, 120))}`);
for (const forbidden of ['new BrowserWindow', "require('./dist/server.cjs')", 'createWindow(']) {
  ok(!loseBranch.includes(forbidden),
    `the losing branch must not ${forbidden} — a second instance must never start a window or a server`);
}
// The winning side must still do the work, or "no second instance" would be
// satisfied by an app that never starts at all.
const winIdx = main.indexOf('} else {', loseIdx);
// Comments stripped FIRST. electron-main.cjs:310 mentions
// "`require('./dist/server.cjs')` call below" inside a comment, so a bare
// substring search stays green after the real call at :366 is deleted —
// a control that cannot fail (reviewer finding, reproduced: the check passed
// with the call removed and the comment intact).
const codeOnly = main
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const winCode = winIdx === -1 ? '' : codeOnly.slice(codeOnly.indexOf('} else {', codeOnly.indexOf(`if (!${lockVar})`)));
ok(winIdx !== -1 && /(?:^|[^.\w])require\(\s*'\.\/dist\/server\.cjs'\s*\)\s*;/m.test(winCode),
  'CONTROL: the branch that HOLDS the lock must still start the server — otherwise these checks ' +
  'are satisfied by an app that never runs. Matched as a CALL in comment-stripped source, not as ' +
  'a substring: electron-main.cjs names this require inside a comment too.');
// Self-test: the comment alone must NOT satisfy it.
{
  const COMMENT_ONLY = "  // the `require('./dist/server.cjs')` call below runs before ready\n  startSomethingElse();";
  const stripped = COMMENT_ONLY.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  ok(!/(?:^|[^.\w])require\(\s*'\.\/dist\/server\.cjs'\s*\)\s*;/m.test(stripped),
    'SELF-TEST: a source file whose ONLY mention of the server require is a comment must fail this ' +
    'control. If it passes, the control cannot fail for the reason it claims.');
}
ok(/app\.on\(\s*['"]second-instance['"]/.test(main),
  "a 'second-instance' handler must exist so a second launch focuses the existing window rather " +
  'than doing nothing visible');

console.log(`electronbridge.contract.test.ts: ${checks} checks passed`);

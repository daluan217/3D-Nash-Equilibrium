/**
 * The desktop auto-update path must never offer a downgrade, and must never
 * take its download URL from the version manifest.
 *
 * WHY THIS EXISTS. `checkForUpdates()` (electron-main.cjs) is the app's ONE
 * disclosed outbound call and its only self-modifying affordance: it fetches
 * `/api/version`, compares the reported version with `app.getVersion()`, and
 * on "newer" shows a dialog whose accept button hands a URL to the operating
 * system via `shell.openExternal`. Nothing in CI looked at it. Rounds 19-21
 * probed `app-version.json` drift and the update-check FAILURE modes, but no
 * guard ever asserted the two properties that decide whether a compromised or
 * merely wrong manifest can do damage:
 *
 *   1. A manifest reporting an OLDER or EQUAL version must not produce an
 *      offer. An app that offers whatever the server names will happily walk a
 *      user back onto a version with a known hole.
 *   2. The download URL must be a hardcoded constant, never a field read out
 *      of the manifest. If `data.url` could reach `openExternal`, whoever
 *      controls (or MITMs) the manifest chooses what the user is told to
 *      install — and `https:` alone does not make an attacker's host safe.
 *
 * MEASURED FIRST, against the LIVE 0.0.223 DMG (BLUE-LOOP-DESKTOP-22,
 * `_gen/b22-update.mjs`): the shipped `checkForUpdates` was driven through 12
 * manifest shapes with `fetch`, `dialog.showMessageBox` and
 * `shell.openExternal` instrumented inside the packaged main process.
 * older(0.0.1)/same(0.0.223)/null/missing/non-object/500/json-throws/
 * fetch-rejects all produced `offered=false`; every accept path opened exactly
 * `https://nash-equilibrium-simulator.com/api/download/dmg`, including the
 * shape that carried `url:'http://evil.invalid/x.dmg'` and
 * `downloadUrl:'file:///etc/passwd'`. This file is that measurement frozen as
 * a contract.
 *
 * TEXT CONTRACT, same reason as `electronmenu.contract.test.ts`: importing
 * `electron-main.cjs` constructs Electron's `app` and spawns a browser
 * process. The failure mode here is DELETION or a one-character flip, both of
 * which text and an extracted-function run can see. `compareVersions` is
 * extracted from the real source and EXECUTED, so polarity is checked, not
 * just presence.
 *
 * MUTATION-TESTED — each of these, applied to the fixed tree, fails this file:
 *   M1  `compareVersions(latest, current) <= 0` -> `< 0`   (equal version now
 *       offers an update)                                   -> check 3 fails
 *   M2  `<= 0` -> `>= 0` (offers every OLDER version)       -> checks 2,3 fail
 *   M3  swap the comparison operands                        -> check 2 fails
 *   M4  `${UPDATE_BASE_URL}/api/download/dmg` -> `data.url` -> check 5 fails
 *   M5  add `'http:'` to EXTERNAL_URL_SCHEMES               -> check 7 fails
 *   M6  drop the `if (!latest) return;` guard               -> check 4 fails
 *
 *   npx tsx src/electronupdate.contract.test.ts
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
/** A comment must never satisfy this contract — this file's own header quotes
 *  `data.url` and `http:` in prose, and so does electron-main.cjs's. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
ok(!stripComments("// const UPDATE_BASE_URL = 'http://evil';").includes('evil'),
  'the comment stripper must remove a line comment');
ok(stripComments("const UPDATE_BASE_URL = 'https://x';").includes('UPDATE_BASE_URL'),
  'the comment stripper must keep real code');
const code = stripComments(main);

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1 — compareVersions exists and is EXECUTABLE from the shipped source.
// Extracting and running it is what makes checks 2-3 about behaviour rather
// than about the presence of a word.
// ─────────────────────────────────────────────────────────────────────────────
// compareVersions leans on VERSION_RE/isVersion, so the eval'd scope needs all
// three. Each is required separately: a missing one must fail here loudly, not
// quietly yield a comparator built from half the shipped logic.
const cvDeps = [
  /const VERSION_RE = [^\n]+/,
  /function isVersion\([^\n]+/,
  /function compareVersions[\s\S]*?\n\}/,
].map((re) => {
  const m = re.exec(code);
  ok(m !== null, `electron-main.cjs must define ${String(re)}`);
  return (m as RegExpExecArray)[0];
});
const compareVersions = new Function(
  `${cvDeps.join('\n')}\nreturn compareVersions;`,
)() as (a: string, b: string) => number;
// The extracted function must actually discriminate, or every later assertion
// would be reading a constant.
ok(compareVersions('1.0.0', '0.9.9') > 0 && compareVersions('0.9.9', '1.0.0') < 0,
  'the extracted compareVersions must order two obviously different versions');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2 — the offer condition, as the shipped code spells it.
// `checkForUpdates` returns early unless compareVersions(latest, current) > 0.
// Replicate that exact expression and drive it, so an operand swap or a
// flipped operator shows up as a wrong ANSWER, not a missing string.
// ─────────────────────────────────────────────────────────────────────────────
const offerExpr = /compareVersions\s*\(\s*latest\s*,\s*current\s*\)\s*<=\s*0\s*\)\s*return/.test(code);
ok(offerExpr,
  'checkForUpdates must bail out on `compareVersions(latest, current) <= 0` — i.e. offer ONLY a '
  + 'strictly newer version. A `< 0` re-offers the installed version forever; a `>= 0` or swapped '
  + 'operands offer DOWNGRADES, which is how a user gets walked back onto an old build.');

// Read from package.json, never a literal: the version hook bumps package.json
// on EVERY commit, so a hardcoded CURRENT rots immediately. It had already
// rotted to 0.0.223 against a 0.0.224 package, which made the control loop
// below assert that 0.0.224 — the INSTALLED version — must be offered, i.e.
// the exact forever-reappearing dialog the equal-version check forbids.
const CURRENT = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).version as string;
ok(/^\d+\.\d+\.\d+$/.test(CURRENT),
  `package.json version must be x.y.z for this contract to mean anything (found ${CURRENT})`);
const offersUpdate = (latest: string) => compareVersions(latest, CURRENT) > 0;
// The runtime compares against app.getVersion(), which IS package.json's
// version in a packaged build. Pin that it reads the live value rather than a
// baked-in constant — a stale operand re-offers the installed build forever.
ok(/const\s+current\s*=\s*app\.getVersion\(\)/.test(code),
  'checkForUpdates must take the installed version from app.getVersion(), not a literal: a baked-in '
  + 'operand goes stale on the next release and offers the installed build to every user, forever.');
// One FIXED pair, independent of whatever package.json says today, so the
// compare semantics are still pinned if the version-derived checks above ever
// degenerate (e.g. both operands becoming the same string).
ok(compareVersions('0.0.224', '0.0.223') > 0 && compareVersions('0.0.223', '0.0.224') < 0
  && compareVersions('0.0.223', '0.0.223') === 0,
  'FIXED-PAIR: 0.0.224 > 0.0.223 > equal must hold regardless of the current package version.');

// Derived from CURRENT, not written down: any literal list goes stale the next
// time the version hook bumps package.json, and a "newer" entry that has since
// become the installed version asserts the forever-reappearing dialog.
const [MAJ, MIN, PAT] = CURRENT.split('.').map((n) => parseInt(n, 10));
// Built by DECREMENTING, never by assuming a component is non-zero: at a
// `x.y.0` release `${MAJ}.${MIN}.0` IS the current version and a naive list
// would assert the installed build must not be offered *as an older one* —
// and would trip the "no list may contain CURRENT" check below on release day.
const older = (n: number) => {
  if (PAT >= n) return `${MAJ}.${MIN}.${PAT - n}`;
  if (MIN >= n) return `${MAJ}.${MIN - n}.0`;
  if (MAJ >= n) return `${MAJ - n}.0.0`;
  return null; // 0.0.0 has nothing below it
};
const OLDER = [older(1), older(2), MAJ + MIN + PAT > 0 ? '0.0.0' : null,
  older(1) === null ? null : `${older(1)}.9`].filter((v): v is string => v !== null);
const NEWER = [`${MAJ}.${MIN}.${PAT + 1}`, `${MAJ}.${MIN + 1}.0`, `${MAJ + 1}.0.0`, `${MAJ + 10}.0.0`];
ok(!OLDER.includes(CURRENT) && !NEWER.includes(CURRENT),
  'CONTROL: neither the older nor the newer list may contain the installed version itself — that is '
  + `exactly how this check rotted before (CURRENT=${CURRENT}).`);
ok(OLDER.length >= 3 && NEWER.length >= 3,
  `CONTROL: both lists must be non-trivial (older=${JSON.stringify(OLDER)}, newer=${JSON.stringify(NEWER)}). `
  + 'A shrunken list is a loop that iterates over nothing, which passes for free — the version is '
  + `${CURRENT}; only a 0.0.0 build can legitimately have no older version, and that is not shippable.`);

// Older versions: never offered. This is the downgrade-protection assertion.
for (const older of OLDER) {
  ok(!offersUpdate(older),
    `a manifest reporting ${older} (older than ${CURRENT}) must NOT produce an update offer — `
    + 'offering it is a downgrade prompt driven by whoever controls the manifest.');
}
// Equal: never offered (otherwise the dialog reappears on every launch forever).
ok(!offersUpdate(CURRENT),
  `a manifest reporting the INSTALLED version (${CURRENT}) must not produce an offer.`);

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3 — CONTROL. Genuinely newer versions MUST still be offered.
// Without this arm, `return false` in compareVersions would pass every check
// above: an instrument that rejects everything is measuring itself.
// ─────────────────────────────────────────────────────────────────────────────
for (const newer of NEWER) {
  ok(offersUpdate(newer),
    `CONTROL: ${newer} is genuinely newer than ${CURRENT} and MUST still be offered — `
    + 'an update path that never offers anything is broken in the other direction.');
}

// Junk manifests must not be read as "newer". Measured against the live binary
// (b22-update.mjs); frozen here so a future parse change cannot regress it.
//
// THIS LIST WAS VACUOUS UNTIL 2026-09-19 (reviewer finding, reproduced): every
// entry had a numeric prefix <= 0.0.223 or none at all, so the whole block
// passed on the UNFIXED `parseInt` compare and never tested the class it names.
// `parseInt` accepts a LEADING integer and discards the rest, so the pre-fix
// code read '0.0.224abc' as 0.0.224 and '999junk.0.0' as 999.0.0 — both
// "newer", both prompting every install to download from a corrupted manifest.
// The four entries marked below are the ones that fail on the pre-fix compare;
// without at least one of them this loop is decoration.
// NEWER_JUNK is derived from CURRENT: written as literals these rot the moment
// the version hook bumps package.json, and a "newer junk" string that has since
// become <= the installed version stops testing the class it names. That is the
// same rot that made the ORIGINAL list vacuous.
const NEWER_JUNK = [
  `${MAJ}.${MIN}.${PAT + 1}abc`,   // numeric prefix NEWER than current
  `${MAJ + 999}junk.${MIN}.0`,     // ditto, via a junk leading component
  `${MAJ}.${MIN}.${PAT + 1}-rc1`,  // a prerelease tag is not an x.y.z release
  `${MAJ + 1}.0.0-beta.1`,         // ditto, and far "newer" by prefix
  `${MAJ}.${MIN}.${PAT + 1}.1`,    // four components is not this project's shape
];
for (const junk of [
  'abc', '', 'NaN.NaN.NaN', `${MAJ}.${MIN}.${PAT}abc`, '-1.0.0', '0x10.0.0', '0.0.1e3',
  ...NEWER_JUNK,
]) {
  ok(!offersUpdate(junk),
    `a junk version string ${JSON.stringify(junk)} must not be treated as newer than ${CURRENT}. `
    + 'A version is exactly three dot-separated integers; parseInt-style leading-number parsing '
    + 'turns a corrupted manifest into an update prompt for every installed copy.');
}
// The validator must be in the SHIPPED source, not just implied by behaviour,
// and it must be anchored — an unanchored /\d+\.\d+\.\d+/ matches '0.0.224abc'.
ok(/VERSION_RE\s*=\s*\/\^\\d\+\\\.\\d\+\\\.\\d\+\$\//.test(code),
  'electron-main.cjs must carry an ANCHORED three-integer version pattern (/^\\d+\\.\\d+\\.\\d+$/). '
  + 'Unanchored, it matches "0.0.224abc" and the fix is undone.');
ok(/if\s*\(!isVersion\(a\)\s*\|\|\s*!isVersion\(b\)\)\s*return 0;/.test(code),
  'compareVersions must refuse to compare anything that is not a version, returning 0 (= "no '
  + 'update") rather than letting parseInt decide.');
// SELF-TEST: the four new entries must genuinely fail the PRE-FIX compare, or
// this block is still decoration. The pre-fix function, verbatim.
{
  const preFix = (a: string, b: string) => {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  };
  for (const regressor of NEWER_JUNK.filter((v) => !v.endsWith('.1') || v.includes('-'))) {
    ok(preFix(regressor, CURRENT) > 0,
      `SELF-TEST: ${JSON.stringify(regressor)} must be OFFERED by the pre-fix parseInt compare — `
      + 'if it is not, it does not discriminate and this loop cannot have caught the defect.');
  }
  ok(preFix(`${MAJ}.${MIN}.${PAT}abc`, CURRENT) === 0,
    'SELF-TEST: the ORIGINAL list entries did not fail the pre-fix compare — that is why the list '
    + 'was vacuous, and recording it here keeps the lesson attached to the check.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 4 — a missing/empty version short-circuits before the comparison.
// Without this, `compareVersions(undefined, current)` decides the outcome by
// accident of parseInt rather than by intent.
// ─────────────────────────────────────────────────────────────────────────────
ok(/if\s*\(\s*!\s*latest\s*\)\s*return/.test(code),
  'checkForUpdates must return early when the manifest carries no version, before comparing.');
ok(/if\s*\(\s*!\s*res\.ok\s*\)\s*return/.test(code),
  'checkForUpdates must return early on a non-OK response rather than parsing an error page.');
ok(/catch\s*\([\s\S]{0,40}\)\s*\{/.test(code) && /Update check failed/.test(main),
  'checkForUpdates must wrap its fetch in try/catch — an offline launch must never disrupt the app '
  + '(an unhandled rejection in the main process is a crash, not a missed update).');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 5 — the download URL is a CONSTANT, never manifest-derived.
// This is the property that makes a hostile manifest harmless: the worst a
// compromised /api/version can do is offer an update the user already has.
// ─────────────────────────────────────────────────────────────────────────────
ok(/openExternalIfSafe\s*\(\s*`\$\{UPDATE_BASE_URL\}\/api\/download\/dmg`\s*\)/.test(code),
  'the update dialog\'s accept path must open the hardcoded '
  + '`${UPDATE_BASE_URL}/api/download/dmg`, not a URL from the response body.');
// Nothing anywhere in the main process may hand a manifest field to the OS.
const manifestFields = ['data.url', 'data.downloadUrl', 'data.dmg', 'data.href', 'data.link'];
for (const field of manifestFields) {
  ok(!code.includes(field),
    `electron-main.cjs must not read '${field}' from the version manifest: any manifest field that `
    + 'reaches shell.openExternal lets whoever serves (or MITMs) /api/version choose what the user '
    + 'is told to install.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6 — the update endpoint is https and is the app's own domain.
// ─────────────────────────────────────────────────────────────────────────────
const baseMatch = /const\s+UPDATE_BASE_URL\s*=\s*['"]([^'"]+)['"]/.exec(code);
ok(baseMatch !== null, 'electron-main.cjs must declare UPDATE_BASE_URL as a literal constant');
const updateBase = (baseMatch as RegExpExecArray)[1];
ok(updateBase.startsWith('https://'),
  `UPDATE_BASE_URL must be https (found ${updateBase}): the update check is the one call this `
  + 'offline app makes, and a plaintext one is trivially rewritten on a hostile network.');
ok(updateBase === 'https://nash-equilibrium-simulator.com',
  `UPDATE_BASE_URL must be the app's own domain (found ${updateBase}).`);
ok(/cache:\s*['"]no-store['"]/.test(code),
  "the version fetch must pass cache: 'no-store' — a cached manifest can pin a user to a stale "
  + 'answer about whether an update exists.');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6b — the update check is the app's ONLY outbound call.
// Checks 5/6 pin WHERE that one call goes, but nothing stopped a SECOND call
// being added to somewhere else entirely. This matters for a desktop app sold
// as offline: on 2026-09-19 a live probe caught the packaged main process
// opening HTTPS to a Google IP, and it took a net-log + DNS check to establish
// that the IP *was* nash-equilibrium-simulator.com (Google-hosted, and made
// over Node's fetch, so invisible to Chromium's net-log). A second endpoint
// would have looked identical. Enumerate the call sites instead.
// ─────────────────────────────────────────────────────────────────────────────
// Every family that can open a socket, not just fetch: a reviewer pointed out
// that `new WebSocket(...)`, `net.connect`, `tls.connect`, a DNS lookup or a
// child process with curl would all have been invisible to a fetch-only scan,
// leaving the list empty and this check green while the invariant was broken.
// `[\s\S]{0,80}` rather than `[^\n)]*` so a call whose arguments wrap across
// lines cannot hide either.
const EGRESS_FAMILIES: Array<[string, RegExp]> = [
  ['fetch', /\bfetch\s*\(([\s\S]{0,80})/g],
  ['http(s)', /\bhttps?\.(?:get|request)\s*\(([\s\S]{0,80})/g],
  ['net.request', /\bnet\.request\s*\(([\s\S]{0,80})/g],
  ['WebSocket', /\bnew\s+WebSocket\s*\(([\s\S]{0,80})/g],
  ['net.connect', /\bnet\.(?:connect|createConnection)\s*\(([\s\S]{0,80})/g],
  ['tls.connect', /\btls\.connect\s*\(([\s\S]{0,80})/g],
  ['dgram', /\bdgram\.createSocket\s*\(([\s\S]{0,80})/g],
  ['dns', /\bdns(?:\.promises)?\.(?:lookup|resolve\w*)\s*\(([\s\S]{0,80})/g],
  ['child_process', /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(([\s\S]{0,80})/g],
];
const outboundCalls: Array<[string, string]> = [];
for (const [family, re] of EGRESS_FAMILIES) {
  for (const m of code.matchAll(re)) outboundCalls.push([family, m[1].trim()]);
}
ok(outboundCalls.some(([f]) => f === 'fetch'),
  'CONTROL: the outbound-call scan must find the update fetch — zero matches would make this '
  + 'check pass by scanning nothing.');
const nonUpdateCalls = outboundCalls.filter(([, arg]) => !arg.includes('UPDATE_BASE_URL'));
ok(nonUpdateCalls.length === 0,
  'the update check must be the ONLY outbound call in electron-main.cjs. Found: '
  + JSON.stringify(nonUpdateCalls)
  + ' — every other network destination in an offline desktop app is a data-egress question, and '
  + 'main-process fetches do not appear in a Chromium net-log, so they are near-invisible.');
// The scanner must SEE each family, or widening it was cosmetic. Run the same
// patterns over a synthetic source carrying one call from each.
{
  const synthetic = `
    fetch('https://a.example');
    https.get('https://b.example');
    net.request('https://c.example');
    new WebSocket('wss://d.example');
    net.connect(443, 'e.example');
    tls.connect({ host: 'f.example' });
    dgram.createSocket('udp4');
    dns.lookup('g.example');
    execSync('curl https://h.example');
  `;
  for (const [family, re] of EGRESS_FAMILIES) {
    ok([...synthetic.matchAll(new RegExp(re.source, 'g'))].length > 0,
      `SELF-TEST: the ${family} pattern must match its own family — a pattern that matches nothing `
      + 'silently exempts that entire egress route.');
  }
  // And a wrapped-argument call must not slip through the multi-line window.
  ok([...`fetch(\n  'https://wrapped.example',\n  {}\n)`.matchAll(/\bfetch\s*\(([\s\S]{0,80})/g)]
    .some((m) => m[1].includes('wrapped.example')),
    'SELF-TEST: a call whose arguments wrap across lines must still be seen — the previous '
    + 'single-line `[^\\n)]*` window let one hide.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6c — shell.openExternal is called EXACTLY ONCE, inside the wrapper.
// Check 7 below proves openExternalIfSafe gates schemes correctly, but nothing
// stopped a SECOND, direct `shell.openExternal(...)` elsewhere in the file from
// bypassing that gate entirely — the wrapper would still look perfect.
// ─────────────────────────────────────────────────────────────────────────────
const openExternalSites = [...code.matchAll(/\bshell\.openExternal\s*\(/g)];
ok(openExternalSites.length === 1,
  `shell.openExternal must appear exactly once in electron-main.cjs (found ${openExternalSites.length}). `
  + 'Every hand-off to the OS must go through openExternalIfSafe; a direct call elsewhere skips the '
  + 'scheme allowlist, and file:// opens Finder on an arbitrary path.');
{
  const gate = /function openExternalIfSafe[\s\S]*?\n\}/.exec(code);
  ok(gate !== null && gate[0].includes('shell.openExternal'),
    'the one shell.openExternal call must be INSIDE openExternalIfSafe — outside it, the scheme '
    + 'allowlist is not consulted at all.');
  // CONTROL: the count check must be able to fail.
  ok([...`${code}\nshell.openExternal('file:///tmp');`.matchAll(/\bshell\.openExternal\s*\(/g)].length === 2,
    'SELF-TEST: adding one direct call must make the scan see two sites — otherwise the count '
    + 'above cannot fail for the reason it claims.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 7 — the scheme allowlist that gates EVERY openExternal call.
// `openExternalIfSafe` is the single door to the OS; https must be the only
// scheme through it. Measured on the live binary: smb:// and tel: are refused
// with a log, file:// never even reaches it (Chromium blocks the navigation
// first), and window.open/target=_blank/location.href all route here.
// ─────────────────────────────────────────────────────────────────────────────
const schemeSet = /EXTERNAL_URL_SCHEMES\s*=\s*new Set\(\s*\[([^\]]*)\]/.exec(code);
ok(schemeSet !== null, 'electron-main.cjs must declare EXTERNAL_URL_SCHEMES as a Set literal');
const schemes = (schemeSet as RegExpExecArray)[1]
  .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
ok(schemes.length === 1 && schemes[0] === 'https:',
  `EXTERNAL_URL_SCHEMES must be exactly ['https:'] (found ${JSON.stringify(schemes)}). `
  + 'shell.openExternal launches the OS default handler for whatever it is given: file:// opens '
  + 'Finder on an arbitrary path, smb:// reaches for a network share, and macOS resolves any '
  + 'custom scheme an installed app registered. Every caller takes a renderer-chosen URL.');

// And the allowlist must actually GATE the call, not merely exist beside it.
const gateFn = /function openExternalIfSafe[\s\S]*?\n\}/.exec(code);
ok(gateFn !== null, 'openExternalIfSafe must be defined');
const gateBody = (gateFn as RegExpExecArray)[0];
ok(/EXTERNAL_URL_SCHEMES\.has\s*\(/.test(gateBody),
  'openExternalIfSafe must consult EXTERNAL_URL_SCHEMES.has(...) — a declared-but-unread allowlist '
  + 'is decoration.');
ok(/return false/.test(gateBody),
  'openExternalIfSafe must refuse (return false) on a disallowed scheme rather than falling '
  + 'through to shell.openExternal.');
// The refusal must come BEFORE the openExternal call in the function body.
const refuseAt = gateBody.search(/return false/);
const openAt = gateBody.search(/shell\.openExternal/);
ok(refuseAt !== -1 && openAt !== -1 && refuseAt < openAt,
  'openExternalIfSafe must refuse before it reaches shell.openExternal — a check placed after the '
  + 'call cannot prevent anything (an assertion after an exit is the classic version of this bug).');

console.log(`electronupdate.contract.test.ts: ${checks} checks passed`);

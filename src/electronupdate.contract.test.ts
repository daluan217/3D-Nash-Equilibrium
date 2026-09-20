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

const CURRENT = '0.0.223';
const offersUpdate = (latest: string) => compareVersions(latest, CURRENT) > 0;

// Older versions: never offered. This is the downgrade-protection assertion.
for (const older of ['0.0.222', '0.0.1', '0.0.0', '0.0.222.9']) {
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
for (const newer of ['0.0.224', '0.1.0', '1.0.0', '10.0.0']) {
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
for (const junk of [
  'abc', '', 'NaN.NaN.NaN', '0.0.223abc', '-1.0.0', '0x10.0.0', '0.0.1e3',
  '0.0.224abc',      // <- numeric prefix NEWER than current: passed before the fix
  '999junk.0.0',     // <- ditto, via a junk middle component
  '0.0.224-rc1',     // <- a prerelease tag is not an x.y.z release
  '1.0.0-beta.1',    // <- ditto, and far "newer" by prefix
  '0.0.224.1',       // <- four components is not this project's version shape
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
  for (const regressor of ['0.0.224abc', '999junk.0.0', '0.0.224-rc1', '1.0.0-beta.1']) {
    ok(preFix(regressor, CURRENT) > 0,
      `SELF-TEST: ${JSON.stringify(regressor)} must be OFFERED by the pre-fix parseInt compare — `
      + 'if it is not, it does not discriminate and this loop cannot have caught the defect.');
  }
  ok(preFix('0.0.223abc', CURRENT) === 0,
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
const outboundCalls = [...code.matchAll(/\b(?:fetch|net\.request|https?\.(?:get|request))\s*\(\s*([^\n)]*)/g)]
  .map((m) => m[1].trim());
ok(outboundCalls.length > 0,
  'CONTROL: the outbound-call scan must find the update fetch — zero matches would make this '
  + 'check pass by scanning nothing.');
const nonUpdateCalls = outboundCalls.filter((arg) => !arg.includes('UPDATE_BASE_URL'));
ok(nonUpdateCalls.length === 0,
  'the update check must be the ONLY outbound call in electron-main.cjs. Found: '
  + JSON.stringify(nonUpdateCalls)
  + ' — every other network destination in an offline desktop app is a data-egress question, and '
  + 'main-process fetches do not appear in a Chromium net-log, so they are near-invisible.');

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

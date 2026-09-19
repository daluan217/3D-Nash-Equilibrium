/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DOWNLOAD MODAL CONTRACT — a text contract on `DownloadModal.tsx`, the same
 * shape as `electronenv.contract.test.ts`: there is no component-test harness
 * in this repo (no React Testing Library, no *.test.tsx anywhere), so the
 * thing worth asserting is that the SOURCE still says these words, because
 * the failure mode is deletion/regression, not a runtime crash a build would
 * catch.
 *
 * WHY THIS EXISTS. `/api/download/dmg`'s 404 ("nobody has built a DMG yet")
 * and its 500 ("GCS is unreachable right now") used to render the exact same
 * UI: a fabricated "this is an ephemeral cloud sandbox" story with a
 * self-build guide whose git-clone command pointed at a literal placeholder
 * `your-username` repo that does not exist. A transient server error told a
 * real user to go compile the app from source instead of "try again in a
 * moment" — and the guide it pointed to didn't even work. Three separate
 * regressions this guards against:
 *
 *   1. THE PLACEHOLDER URL. `your-username` must never reappear in the
 *      clone command; the real, public repo URL must be there instead.
 *   2. THE CONFLATION. A 500/network failure and a 404 must map to
 *      DIFFERENT `errorKind`s, and the "unavailable" branch must not render
 *      the self-build guide (copy commands, terminal steps) — that would be
 *      the conflation creeping back in a different shape.
 *   3. THE FALSE NARRATIVE. The old "active cloud web sandbox" / "ephemeral
 *      cloud containers" claim (untrue of a real, deployed Cloud Run
 *      service) must not reappear anywhere in shipped UI text.
 *
 *   npx tsx src/downloadmodal.contract.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '.');
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

const src = readFileSync(join(repo, 'components/DownloadModal.tsx'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// 1. NO PLACEHOLDER URL, EVER
// ─────────────────────────────────────────────────────────────────────────────
ok(!src.includes('your-username'),
  'DownloadModal.tsx must not contain the placeholder git-clone URL "your-username" — ' +
  'it points at a repo that does not exist');
ok(src.includes('github.com/daluan217/3D-Nash-Equilibrium'),
  'DownloadModal.tsx must clone the REAL, public repo, not a placeholder');

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE FALSE "CLOUD SANDBOX" NARRATIVE MUST NOT REAPPEAR
// ─────────────────────────────────────────────────────────────────────────────
for (const falseClaim of ['active cloud web sandbox', 'ephemeral cloud containers']) {
  ok(!src.toLowerCase().includes(falseClaim.toLowerCase()),
    `DownloadModal.tsx must not claim "${falseClaim}" — this is a real, deployed Cloud Run service, not a sandbox`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 404 AND 500 MAP TO DIFFERENT errorKinds, AND EACH RENDERS DIFFERENTLY
// ─────────────────────────────────────────────────────────────────────────────
ok(/res\.status === 404[\s\S]{0,80}setErrorKind\('not-built'\)/.test(src),
  "a 404 response must set errorKind to 'not-built' (the self-build guide is the RIGHT advice there)");
ok(/setErrorKind\('unavailable'\)/.test(src),
  "some non-404 failure path must set errorKind to 'unavailable'");
// The catch block (network failure / fetch threw) must also be 'unavailable',
// not silently left as 'not-built' or unset — a thrown fetch is not evidence
// the DMG was never built.
{
  const catchIdx = src.indexOf('} catch (err: any) {');
  ok(catchIdx > 0, 'handleDownloadDmg must have a catch block');
  const catchBlock = src.slice(catchIdx, catchIdx + 300);
  ok(catchBlock.includes("setErrorKind('unavailable')"),
    "the catch block (fetch threw / offline) must set errorKind to 'unavailable', not leave the self-build guide showing");
}

// The two JSX blocks must exist, be gated on DIFFERENT errorKind values, and
// the 'unavailable' block must NOT render the self-build guide (that would
// be the conflation regressing in a different shape than before).
{
  const unavailableIdx = src.indexOf("errorKind === 'unavailable' && (");
  const notBuiltIdx = src.indexOf("errorKind === 'not-built' && (");
  ok(unavailableIdx > 0 && notBuiltIdx > 0,
    'both the "unavailable" and "not-built" JSX branches must exist');
  ok(unavailableIdx < notBuiltIdx,
    'the "unavailable" branch must be declared before "not-built" (a stable position to slice between them)');

  const unavailableBlock = src.slice(unavailableIdx, notBuiltIdx);
  for (const guideMarker of ['cloneCommands', 'installCommands', 'buildCommands', 'Self-Service Desktop Compiler']) {
    ok(!unavailableBlock.includes(guideMarker),
      `the "unavailable" (transient failure) branch must NOT render the self-build guide (found "${guideMarker}") — ` +
      'that is the exact conflation this contract exists to prevent');
  }

  const notBuiltBlock = src.slice(notBuiltIdx, notBuiltIdx + 4000);
  ok(notBuiltBlock.includes('Self-Service Desktop Compiler'),
    'the "not-built" (genuine 404) branch must still render the self-build guide');
  // `cloneCommands` (like `installCommands`/`buildCommands`) must be
  // RENDERED (a `{cloneCommands}` JSX interpolation), not merely referenced
  // in a copy-button handler — `cloneCommands` was DEFINED from the start
  // but never interpolated anywhere, so a user on an un-cloned machine hit
  // "Step 1: npm install" with no repository to install into. A check for
  // the bare substring "cloneCommands" would pass on the handler reference
  // alone and miss exactly this regression.
  ok(notBuiltBlock.includes('{cloneCommands}'),
    'the "not-built" branch must actually RENDER {cloneCommands}, not just reference it in a copy handler — ' +
    'the self-build guide is useless without a step to get the source first');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE GATEKEEPER BLOCK NAMES ONLY BUTTONS macOS ACTUALLY SHOWS
//
// BLUE-LOOP-DESKTOP-22, invented angle F. The block told users to click
// "Cancel" on the first-launch warning. MEASURED on the shipping condition —
// a quarantined copy of the LIVE 0.0.223 DMG launched on macOS 26.0 and
// screencaptured — the sheet is:
//     headline  "Nash Equilibrium Simulator" Not Opened
//     body      Apple could not verify ... free of malware ...
//     buttons   [Move to Trash]  (highlighted default)   [Done]
// There is no Cancel. macOS 15 replaced the old "unidentified developer"
// sheet with this one; the copy was written for macOS <= 14 and drifted. So
// the only dismiss button the page named was absent, and the button a user
// would land on instead DELETES the download. Corroborated from the OS's own
// string tables, not the pixels alone: CoreServicesUIAgent's
// Quarantine/QuarantineHeadlines loctables carry Q_BUTTON_MOVE_TO_TRASH,
// Q_BUTTON_DONE and Q_HEADLINE_SUNFISH_NOT_VERIFIED ('"%@" Not Opened'),
// and SecurityPrivacyExtension's Localizable.loctable carries
// '"%@" was blocked to protect your Mac' for the System Settings row.
//
// These are SOURCE-TEXT assertions for the same reason as the rest of this
// file. What they cannot do is notice the next macOS renaming its buttons —
// nothing in CI can; that is what the screenshot + loctable procedure in this
// comment is for when the copy is next touched.
// ─────────────────────────────────────────────────────────────────────────────
const GK_START = '{/* macOS Gatekeeper notice';
const gkIdx = src.indexOf(GK_START);
ok(gkIdx !== -1, 'the macOS Gatekeeper notice block must still exist in DownloadModal.tsx');
const gkEnd = src.indexOf('{/* Offline DB note', gkIdx);
ok(gkEnd > gkIdx, 'the Gatekeeper block must still be followed by the offline-DB note (slice boundary)');
// JSX comments are stripped before any predicate runs. A comment is not shipped
// text, so it can neither satisfy nor violate a claim about what the user reads —
// and the explanatory comment in the block quotes the very wording ("unidentified
// developer") one predicate forbids. Caught by that predicate firing on the first
// run, which is also evidence the predicate discriminates on content, not position.
const stripJsxComments = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const gk = stripJsxComments(src.slice(gkIdx, gkEnd));

// The predicates. Each is exercised twice: once against the shipped block
// (below) and once against the PRE-FIX text (the self-test at the end), so a
// predicate that cannot fail is caught here rather than in a red round.
const gkChecks: Array<[string, (t: string) => boolean, string]> = [
  ['names Done as the dismiss button',
    (t) => /click <strong[^>]*>Done<\/strong>/.test(t),
    'the Gatekeeper steps must tell the user to click Done — the button macOS 15+ actually shows'],
  ['does not send the user to a bare "click Cancel"',
    (t) => !/click <strong[^>]*>Cancel<\/strong>/.test(t),
    'the steps must not instruct "click Cancel" as THE action: macOS 15+ shows no Cancel button, ' +
    'so the user lands on Move to Trash, which deletes the download'],
  ['warns against Move to Trash explicitly',
    (t) => /not<\/strong> click Move to Trash/.test(t),
    'the steps must warn against Move to Trash by name — it is the HIGHLIGHTED default button'],
  ['quotes the measured "could not verify" wording',
    (t) => t.includes('could not verify'),
    'the steps must quote the sheet the user actually sees ("could not verify"), not the ' +
    'pre-macOS-15 "unidentified developer" sheet'],
  ['does not promise the old unidentified-developer warning',
    (t) => !t.includes('"unidentified developer"'),
    'macOS 15+ does not show an "unidentified developer" headline for this app; promising it ' +
    'is a UI string that is a lie about state'],
  ['quotes the measured System Settings row',
    (t) => t.includes('was blocked to protect your Mac'),
    'step 4 must quote the row macOS actually renders ("... was blocked to protect your Mac")'],
  // Not `!t.includes('was blocked')` and not a tag-shape regex (the first
  // draft used /was blocked<\/em>/ and the self-test below caught it: the
  // pre-fix text is `was blocked"</em>`, with a quote in between, so the
  // predicate silently passed on the very defect it named). Assert the
  // invariant instead: EVERY occurrence of "was blocked" must be the
  // measured row, i.e. continue into "to protect your Mac".
  ['does not quote the old System Settings row',
    (t) => t.split('was blocked').slice(1).every((rest) => rest.startsWith(' to protect your Mac')),
    'the old "<app> was blocked" row text is not what Privacy & Security shows; the measured row ' +
    'is "... was blocked to protect your Mac"'],
  // CONTROL ARM. Without this, every check above is satisfied by DELETING the
  // whole block — an empty string passes six of the seven. This one fails on
  // an empty or gutted block, so the suite cannot be "fixed" by removal.
  ['CONTROL: the block still carries the full opening procedure',
    (t) => t.includes('Applications') && t.includes('System Settings') &&
           t.includes('Open Anyway') && t.includes('xattr -dr com.apple.quarantine'),
    'the Gatekeeper block must still contain the whole procedure (Applications drag, System ' +
    'Settings, Open Anyway, and the xattr terminal alternative) — a check-set that an empty ' +
    'block could satisfy is not a check-set'],
];
for (const [name, pred, msg] of gkChecks) ok(pred(gk), `${msg} [${name}]`);

// SELF-TEST: the pre-fix text, verbatim from git (main @ daad73d). Every
// predicate that is supposed to catch this defect must FAIL on it, and the
// CONTROL must still PASS (the pre-fix block was complete, just wrong) — that
// is what distinguishes "this check found the defect" from "this check cannot
// fail". A guard whose deletion changes no result is the defect class this
// repo keeps re-finding.
{
  const PRE_FIX = `{/* macOS Gatekeeper notice — always visible */}
      Because this app is not notarized through Apple, macOS will show an <strong className="text-slate-700 dark:text-slate-300">"unidentified developer"</strong> warning on first launch. Follow these steps to open it:
      <>Drag <strong className="text-slate-700 dark:text-slate-300">Nash Equilibrium Simulator</strong> from the DMG into your <strong className="text-slate-700 dark:text-slate-300">Applications</strong> folder.</>,
      <>Double-click the app. When the warning appears, click <strong className="text-slate-700 dark:text-slate-300">Cancel</strong> (not Move to Trash).</>,
      <>Open <strong className="text-slate-700 dark:text-slate-300">System Settings → Privacy &amp; Security</strong>.</>,
      <>Scroll down to find <em>"Nash Equilibrium Simulator was blocked"</em> and click <strong className="text-slate-700 dark:text-slate-300">Open Anyway</strong>.</>,
      xattr -dr com.apple.quarantine`;
  const mustFail = gkChecks.filter(([n]) => !n.startsWith('CONTROL'));
  for (const [name, pred] of mustFail) {
    ok(!pred(PRE_FIX),
      `SELF-TEST: "${name}" passes on the PRE-FIX Gatekeeper text — it cannot be what caught ` +
      'the defect. Rewrite the predicate so it discriminates.');
  }
  const control = gkChecks.find(([n]) => n.startsWith('CONTROL'))!;
  ok(control[1](PRE_FIX),
    'SELF-TEST: the CONTROL arm must PASS on the pre-fix text — the old block was complete, ' +
    'just wrong. A control that fails there is testing the fix, not the block\'s existence.');
}

console.log(`downloadmodal.contract.test.ts: ${checks} checks passed`);

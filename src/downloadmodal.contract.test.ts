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

console.log(`downloadmodal.contract.test.ts: ${checks} checks passed`);

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DESKTOP COPY CONTRACT — a text contract on `MenuDrawer.tsx`'s "Database
 * Sync Mode" panel, the one place inside the RUNNING desktop app (not just
 * the website's download page) that explains what Local Offline Mode does.
 *
 * WHY THIS EXISTS. round3/BLUE-SERVER-DESKTOP.md queue item 3: "the desktop
 * must tell the user their data never leaves the machine (the capability
 * nobody can find is not an advantage)." Before this fix the copy for BOTH
 * modes was the same generic sentence ("Choose whether the application
 * saves... to your offline local computer database, or synchronizes live
 * with the central website hub") — accurate but never actually STATES the
 * privacy property as an explicit fact the user can rely on. Confirmed
 * accurate before writing the copy: `initDB`/`saveDB` in server.ts both gate
 * on `ELECTRON_USER_DATA_PATH` FIRST, so the GCS branch is unreachable
 * whenever it is set (i.e., whenever running as the packaged desktop app in
 * Local mode) — there is no code path where local-mode data reaches a
 * REMOTE server.
 *
 * TWO ROUNDS OF FIXES HERE (CodeRabbit, both on the same PR):
 *   1. The FIRST version overclaimed: "no server ever sees your data." The
 *      Electron renderer still talks to the app's OWN local server
 *      (127.0.0.1) to read and write that file — that IS a server, just not
 *      a remote one. Reworded to "no remote server ever receives your data"
 *      / "nothing leaves this machine", which is what's actually true.
 *   2. The check itself was too loose: `src.includes(claim)` matches the
 *      claim ANYWHERE in the file — a comment, or the CLOUD-mode branch —
 *      so it could keep passing after the local-mode branch itself lost the
 *      claim. Now extracts ONLY the local-mode ternary branch's string
 *      literal and checks against that specifically.
 *
 *   npx tsx src/desktopcopy.contract.test.ts
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

const src = readFileSync(join(repo, 'components/MenuDrawer.tsx'), 'utf8');

// The panel must be conditioned on dbMode === 'local' at all (not a single
// static sentence for both modes — that was the original defect: a claim
// this specific is only true in one of the two modes).
const branchMatch = /dbMode === 'local'\s*\n?\s*\?\s*'([^']+)'/.exec(src);
ok(branchMatch !== null,
  "MenuDrawer.tsx's Database Sync Mode description must branch on dbMode === 'local' " +
  "with a ?-ternary string literal immediately following — a single sentence for both " +
  "modes cannot make a claim specific to one of them, and this test cannot isolate the " +
  "local-mode text without that shape");

// EVERYTHING below is checked against ONLY the extracted local-mode branch
// text, not the whole file — a claim present in a comment, in the cloud-mode
// branch, or anywhere else does not satisfy these checks. This is the fix
// for the second CodeRabbit finding: `src.includes(claim)` against the whole
// file could pass even after the local-mode branch itself lost the claim.
const localModeText = branchMatch ? branchMatch[1] : '';

// The local-mode sentence itself must make the explicit claim, not just
// imply it. Three independent phrasings, so a partial rewrite that keeps
// only one still counts, but deleting the substance of all three does not.
const localModeClaims = [
  'only in a database file on this computer',
  'Nothing leaves this machine',
  'no internet connection',
];
for (const claim of localModeClaims) {
  ok(localModeText.includes(claim),
    `MenuDrawer.tsx's Local Offline Mode branch must state "${claim}" (or an equivalent explicit claim) — ` +
    'a capability nobody can find is not an advantage');
}

// The claim must be about a REMOTE server, not "no server at all" — the
// Electron renderer still talks to the app's OWN local server (127.0.0.1)
// to persist that file. Overclaiming "no server ever sees your data" is the
// FIRST CodeRabbit finding this file guards against a regression to.
ok(/no remote server/i.test(localModeText),
  'the local-mode claim must say "no REMOTE server" specifically — the app does have its ' +
  'own local server, and claiming otherwise is the exact overclaim CodeRabbit caught');
ok(!/no server ever/i.test(localModeText),
  'the local-mode branch must not claim "no server ever ..." (unqualified) — the desktop ' +
  'app talks to its own local server; only a REMOTE server is absent');

console.log(`desktopcopy.contract.test.ts: ${checks} checks passed`);

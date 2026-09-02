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
 * Local mode) — there is no code path where local-mode data reaches a server.
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
// static sentence for both modes — that was the actual defect: a claim this
// specific is only true in one of the two modes).
ok(/dbMode === 'local'\s*\n?\s*\?/.test(src),
  "MenuDrawer.tsx's Database Sync Mode description must branch on dbMode === 'local' " +
  '— a single sentence for both modes cannot make a claim specific to one of them');

// The local-mode sentence itself must make the explicit claim, not just imply
// it. Three independent phrasings, so a partial rewrite that keeps only one
// still counts, but deleting the substance of all three does not.
const localModeClaims = [
  'only in a database file on this computer',
  'Nothing is sent anywhere',
  'no internet connection',
];
for (const claim of localModeClaims) {
  ok(src.includes(claim),
    `MenuDrawer.tsx's Local Offline Mode description must state "${claim}" (or an equivalent explicit claim) — ` +
    'a capability nobody can find is not an advantage');
}

console.log(`desktopcopy.contract.test.ts: ${checks} checks passed`);

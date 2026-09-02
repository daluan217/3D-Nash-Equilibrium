/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTHER-ACCOUNTS-NOTICE CONTRACT — a text contract on
 * `OtherAccountsNotice.tsx`, same shape as `downloadmodal.contract.test.ts`
 * and `desktopcopy.contract.test.ts`: no component-test harness exists in
 * this repo, so this asserts the source still says the right words.
 *
 * WHY THIS EXISTS. CodeRabbit caught a real gap: the component's very first
 * version checked only `nash_sim_token_local` to decide "already signed
 * in," which meant a Cloud Sync user (a valid `nash_sim_token_cloud`, no
 * local token) still read as "not signed in" and could be shown a notice
 * about recovering LOCAL games — which has nothing to do with Cloud Sync
 * mode, since `/api/auth/desktop-hint` reads the local `db.json`, not the
 * hosted service. The fix gates the whole check on `dbMode === 'local'`.
 *
 *   npx tsx src/otheraccountsnotice.contract.test.ts
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

const src = readFileSync(join(repo, 'components/OtherAccountsNotice.tsx'), 'utf8');

ok(src.includes("localStorage.getItem('nash_sim_db_mode')"),
  'OtherAccountsNotice must read the ACTUAL db mode from localStorage, not assume local mode');

// The gate must run BEFORE the fetch to /api/auth/desktop-hint, and BEFORE
// setVisible could ever be reached — a check placed after the fetch would
// not stop the wasted/irrelevant request, only hide its result.
{
  const dbModeIdx = src.indexOf("dbMode !== 'local'");
  const fetchIdx = src.indexOf("fetch('/api/auth/desktop-hint')");
  ok(dbModeIdx > 0, "the effect must bail out early when dbMode !== 'local'");
  ok(fetchIdx > 0, 'the component must still call /api/auth/desktop-hint (in local mode)');
  ok(dbModeIdx < fetchIdx,
    "the dbMode gate must run BEFORE the fetch — gating only the RESULT would still spend " +
    "the request in cloud mode");
}

// Self-contained design (director's requirement): no props, still reads its
// own state from localStorage/window rather than App.tsx threading dbMode
// in — the gate must be an localStorage read, not a new prop.
ok(!/dbMode\s*:\s*['"]local['"]\s*\|\s*['"]cloud['"]/.test(src) && !src.includes('React.FC<'),
  'OtherAccountsNotice must stay a zero-prop component (React.FC, no props interface) — ' +
  'the dbMode fix must read localStorage, not add a prop');

console.log(`otheraccountsnotice.contract.test.ts: ${checks} checks passed`);

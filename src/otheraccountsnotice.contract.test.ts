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
 * TWO ROUNDS OF CodeRabbit FIXES HERE, ON THE SAME COMPONENT:
 *
 *   1. The FIRST version checked only `nash_sim_token_local` for "already
 *      signed in," so a Cloud Sync user (a valid `nash_sim_token_cloud`, no
 *      local token) still read as "not signed in." Fixed by gating on
 *      `dbMode === 'local'` — but that version read `dbMode` from
 *      `localStorage` inside a MOUNT-ONLY effect (`useEffect(..., [])`),
 *      deliberately zero-prop to keep App.tsx's touch to one line.
 *
 *   2. That mount-only design was ITSELF the second finding: App updates
 *      `dbMode` and auth state continuously while this component stays
 *      mounted, but the effect never re-ran, so switching from Cloud Sync
 *      to Local mode never started the check at all, and signing in while
 *      the notice was showing left it visibly stale. Fixed by taking
 *      `dbMode`/`signedIn` as PROPS (dropping the zero-prop constraint —
 *      correctness beats that self-imposed design limit) and re-running /
 *      re-clearing the effect on every change to either.
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
const appSrc = readFileSync(join(repo, 'App.tsx'), 'utf8');

// The component must take dbMode and signedIn as PROPS now (not read them
// from localStorage internally) — that internal-read design is exactly what
// made it impossible to react to a LIVE change.
ok(/interface\s+OtherAccountsNoticeProps\b/.test(src),
  'OtherAccountsNotice must declare a real props interface');
ok(/dbMode\s*:\s*'local'\s*\|\s*'cloud'/.test(src),
  'OtherAccountsNoticeProps must include dbMode');
ok(/signedIn\s*:\s*boolean/.test(src),
  'OtherAccountsNoticeProps must include signedIn');
ok(/OtherAccountsNotice:\s*React\.FC<OtherAccountsNoticeProps>\s*=\s*\(\s*\{\s*dbMode,\s*signedIn\s*\}/.test(src),
  'the component must actually DESTRUCTURE dbMode and signedIn from its props, not just declare the type');

// THE ACTUAL FIX: the effect's dependency array must include BOTH props —
// `useEffect(..., [])` (mount-only) is exactly the defect CodeRabbit found,
// so this must not regress back to it.
ok(/\},\s*\[dbMode,\s*signedIn\]\)/.test(src),
  'the useEffect that decides visibility must depend on [dbMode, signedIn] — a mount-only ' +
  '`[]` dependency array cannot react to a live mode switch or sign-in');

// Ineligibility must ACTIVELY clear an already-visible notice (setVisible(false)),
// not merely skip showing a NEW one — a passive "return" alone would leave a
// stale notice on screen after the user signs in or switches modes.
ok(/dbMode !== 'local' \|\| signedIn \|\|[\s\S]{0,80}setVisible\(false\)/.test(src),
  'the ineligibility branch must call setVisible(false), not just return, so an already-visible ' +
  'notice is cleared the instant it becomes stale');

// The async-boundary re-check: eligibility must be re-verified INSIDE the
// fetch's .then() before setVisible(true), in case dbMode/signedIn changed
// while the request was in flight — a stale response landing late must not
// resurrect a notice that is no longer appropriate.
{
  const fetchIdx = src.indexOf("fetch('/api/auth/desktop-hint')");
  const setVisibleTrueIdx = src.indexOf('setVisible(true)');
  ok(fetchIdx > 0 && setVisibleTrueIdx > fetchIdx, 'setVisible(true) must be reachable only after the fetch');
  const betweenFetchAndShow = src.slice(fetchIdx, setVisibleTrueIdx);
  ok(/dbMode !== 'local' \|\| signedIn/.test(betweenFetchAndShow),
    'eligibility must be RE-CHECKED between the fetch starting and setVisible(true) — otherwise a ' +
    'stale in-flight response can show the notice after the user already signed in or switched modes');
}

// App.tsx must actually PASS both props on the mount line — declaring them
// on the component with nothing supplying them would be a silent no-op
// (both props undefined, effect deps always the same reference-unstable
// undefined/undefined, no re-runs).
ok(/<OtherAccountsNotice\s+dbMode=\{dbMode\}\s+signedIn=\{!!authToken\}\s*\/>/.test(appSrc),
  'App.tsx must mount <OtherAccountsNotice dbMode={dbMode} signedIn={!!authToken} /> — ' +
  'declaring the props on the component alone does nothing without a caller supplying them');

console.log(`otheraccountsnotice.contract.test.ts: ${checks} checks passed`);

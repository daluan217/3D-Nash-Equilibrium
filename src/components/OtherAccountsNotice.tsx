/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { safeGetItem, safeSetItem } from '../utils/safeStorage';

const DISMISS_KEY = 'nash_sim_dismissed_desktop_hint';

interface OtherAccountsNoticeProps {
  /** The app's current sync mode. The hint is meaningless outside 'local' —
   * server.ts's /api/auth/desktop-hint reads db.json (the local database),
   * not the hosted service, so a Cloud Sync user's session tells us nothing
   * about it either way. */
  dbMode: 'local' | 'cloud';
  /** Is there a valid session for the CURRENT dbMode right now? Once true,
   * whatever that account owns is already visible; nothing to recover. */
  signedIn: boolean;
}

/**
 * Desktop-only notice: tells a returning user whose saved games live under a
 * real (non-local-owner) account that signing in will recover them.
 *
 * WHY THIS EXISTS. `GET /api/games` on an unauthenticated desktop request
 * returns 200 [] both for a brand-new install and for a machine that has a
 * real pre-existing account with saved games nobody is signed into right
 * now — the two are indistinguishable from that response alone, and nothing
 * else in the app tells the user a sign-in would help (`/api/auth/me`
 * correctly 401s the same request; `/api/games` does not). See
 * `server.ts`'s `GET /api/auth/desktop-hint` and
 * `round3/findings/RED-DESKTOP-3/002-upgrade-hides-old-account-games-silently.md`.
 *
 * TAKES PROPS, ON PURPOSE, REVISED FROM THE ORIGINAL PROP-FREE DESIGN.
 * The first version read `dbMode`/the local token from `localStorage`
 * itself, entirely inside a mount-only effect, to keep App.tsx's touch to a
 * single mount line. CodeRabbit caught the real cost of that: App updates
 * `dbMode` and auth state continuously while this stays mounted, but the
 * effect ran ONCE — so switching from Cloud Sync to Local mode never
 * started the check at all (the component had already decided "not
 * eligible" on first mount and never looked again), and signing in after
 * the notice was already showing left it visibly wrong (still telling a
 * now-signed-in user to sign in). `localStorage` also has no same-tab
 * change event to react to even if the effect DID re-run on some interval.
 * Taking `dbMode`/`signedIn` as props and re-running the effect on every
 * change fixes both: eligibility is re-evaluated live, and `visible` is
 * explicitly cleared the instant either prop makes the notice moot.
 */
export const OtherAccountsNotice: React.FC<OtherAccountsNoticeProps> = ({ dbMode, signedIn }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const isElectron = typeof window !== 'undefined'
      && window.navigator?.userAgent?.toLowerCase().includes('electron');
    if (!isElectron) return;

    // Re-evaluate eligibility on EVERY dependency change, not just at mount:
    // a mode switch away from 'local', or a fresh sign-in, must clear an
    // already-visible notice immediately rather than leave it stale.
    if (dbMode !== 'local' || signedIn || safeGetItem(DISMISS_KEY) === '1') {
      setVisible(false);
      return;
    }

    let cancelled = false;
    fetch('/api/auth/desktop-hint')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        // Re-check eligibility on the async boundary too: dbMode/signedIn
        // (or a dismissal) could have changed while this request was in
        // flight, and a stale response landing after that must not
        // resurrect a notice that is no longer appropriate.
        if (cancelled) return;
        if (dbMode !== 'local' || signedIn || safeGetItem(DISMISS_KEY) === '1') return;
        if (data?.hasOtherAccounts) setVisible(true);
      })
      .catch(() => { /* offline or unreachable: say nothing, never disrupt */ });
    return () => { cancelled = true; };
  }, [dbMode, signedIn]);

  if (!visible) return null;

  const dismiss = () => {
    safeSetItem(DISMISS_KEY, '1');
    setVisible(false);
  };

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-md w-[calc(100%-2rem)] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-lg p-3.5 text-xs text-slate-600 dark:text-slate-400 flex items-start gap-2.5"
    >
      <span className="flex-1 leading-relaxed">
        <strong className="text-slate-800 dark:text-white">Used this app before?</strong> Games saved under an
        account on this device aren&apos;t shown until you sign in. Open the menu to sign in and recover them.
      </span>
      <button
        onClick={dismiss}
        className="shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
};

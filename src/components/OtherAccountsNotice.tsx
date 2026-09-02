/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';

const DISMISS_KEY = 'nash_sim_dismissed_desktop_hint';

/**
 * Desktop-only, self-contained notice: tells a returning user whose saved
 * games live under a real (non-local-owner) account that signing in will
 * recover them.
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
 * Deliberately reads its own Electron/auth/dismissal state from
 * window.navigator/localStorage rather than taking props (the same
 * `isElectron` User-Agent check App.tsx already uses), so mounting it is a
 * single `<OtherAccountsNotice />` line with nothing else to keep in sync as
 * App.tsx's own auth state changes shape.
 */
export const OtherAccountsNotice: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const isElectron = typeof window !== 'undefined'
      && window.navigator?.userAgent?.toLowerCase().includes('electron');
    if (!isElectron) return;
    if (localStorage.getItem(DISMISS_KEY) === '1') return;
    // The hint is about the LOCAL database only (server.ts's
    // /api/auth/desktop-hint reads db.json, not the hosted service) — in
    // Cloud Sync mode the app's data comes from the remote server instead,
    // so this notice would be irrelevant at best. Checked ONLY the local
    // token before, which meant a cloud-mode user (a valid
    // nash_sim_token_cloud, no nash_sim_token_local) still read as
    // "not signed in" and could be shown a notice about local games that
    // has nothing to do with what they are looking at.
    const dbMode = localStorage.getItem('nash_sim_db_mode') || 'local';
    if (dbMode !== 'local') return;
    // Already signed in locally -> whatever the account owns is already
    // visible; nothing to recover.
    const signedIn = !!(localStorage.getItem('nash_sim_token_local') || localStorage.getItem('nash_sim_token'));
    if (signedIn) return;

    let cancelled = false;
    fetch('/api/auth/desktop-hint')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.hasOtherAccounts) setVisible(true);
      })
      .catch(() => { /* offline or unreachable: say nothing, never disrupt */ });
    return () => { cancelled = true; };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* best effort */ }
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

import React, { useEffect, useRef, useState } from 'react';
import { Users, GamepadIcon, ShieldCheck, ShieldX, TrendingUp, RefreshCw, LogOut, X } from 'lucide-react';
import { ModalSurface } from './ModalSurface';
import { labelFor } from '../utils/a11y';

interface AdminStats {
  totalUsers: number;
  verifiedUsers: number;
  unverifiedUsers: number;
  totalGames: number;
  signupsToday: number;
  signupsThisWeek: number;
  users: { username: string; email: string; isVerified: boolean; gamesCount: number }[];
}

interface AdminDashboardProps {
  open: boolean;
  onClose: () => void;
  isDark: boolean;
  isElectron: boolean;
  apiBaseUrl: string;
}

/** RED-APP-15/002: this overlay used to hand-roll `fixed inset-0` with no
 *  role, no Escape, no Tab trap and no ModalRegistry membership — reachable
 *  by a real triple-click on the header icon (App.tsx), it let its own
 *  keystrokes drive the guided tour underneath it and let a second dialog
 *  (the drawer) open stacked behind it. Now goes through <ModalSurface> like
 *  every other overlay in the app (see docs/MODAL-SURFACE.md). */
export const AdminDashboard: React.FC<AdminDashboardProps> = ({ open, onClose, isDark, isElectron, apiBaseUrl }) => {
  const adminUrl = (path: string) =>
    isElectron ? `${apiBaseUrl.trim().replace(/\/$/, '') || 'https://nash-equilibrium-simulator.com'}${path}` : path;
  const [password, setPassword] = useState('');
  const [authed, setAuthed] = useState(false);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // CodeRabbit CLI: the component now stays mounted across opens (ModalSurface
  // hides it, App.tsx renders it unconditionally) — without this, closing kept
  // the admin secret in memory and reopening (a triple-click anyone at the
  // machine can do) showed the cached user table with no password prompt.
  //
  // CodeRabbit CLI (PR #162 follow-up): resetting state on close is not
  // enough on its own — an in-flight fetchStats() started before the close
  // can still resolve AFTER it and write stats/authed right back in. A
  // request-generation ref, bumped on close and checked before every
  // post-await state update, makes a stale continuation a no-op.
  const requestGenRef = useRef(0);
  useEffect(() => {
    if (open) return;
    requestGenRef.current += 1;
    setAuthed(false); setPassword(''); setStats(null); setError(''); setLoading(false);
  }, [open]);

  const fetchStats = async (secret: string) => {
    // CodeRabbit CLI (this review): a bare read (no bump) let two concurrent
    // calls — e.g. a double-clicked Refresh, nothing here disables it while
    // loading — share the SAME generation, so neither's post-await check
    // could tell an older, slower response apart from a newer one; a stale
    // response landing last could overwrite fresher stats or clobber a
    // fresher error. Pre-incrementing gives every call its own generation.
    const gen = ++requestGenRef.current;
    // RED-APP-16/005: distinguishes an initial-login failure from an authed
    // Refresh failure, captured before either `await` — after the fetch,
    // `authed` in the closure is still the value from render time, exactly
    // what tells the two cases apart.
    const wasAuthed = authed;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(adminUrl('/api/admin/stats'), {
        headers: { 'x-admin-secret': secret },
      });
      if (gen !== requestGenRef.current) return;
      if (res.status === 401) {
        // A 401 on an authed Refresh means the secret this session is using
        // no longer works (rotated/revoked) — mirror Sign-out's reset (same
        // generation bump, so a concurrent stale Refresh can't re-auth the
        // panel after this) rather than leaving stale numbers on screen
        // under a secret the server just rejected. Unlike Sign-out, the
        // message SURVIVES the reset, so the password prompt it falls back
        // to explains why the user landed back here.
        //
        // OPUS-REVIEW-APP16 N-2: on a REFRESH (wasAuthed), the user typed
        // nothing this time — "Incorrect password." blamed a password they
        // never entered. Only the initial Login attempt (the one where the
        // user actually just typed a password) gets that copy; a Refresh
        // 401 names what actually happened (the session/secret expired).
        requestGenRef.current += 1;
        setAuthed(false); setStats(null); setPassword('');
        setError(wasAuthed ? 'Your admin session is no longer valid. Sign in again.' : 'Incorrect password.');
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error('Server error');
      const data = await res.json();
      if (gen !== requestGenRef.current) return;
      setStats(data);
      setAuthed(true);
    } catch {
      // RED-APP-16/005: every non-401 failure (429 rate limit, a dropped
      // connection) used to be silent when it happened on an authed
      // Refresh — `error` rendered only in the `!authed` branch, so this
      // state had nothing to display it. Now rendered in BOTH branches
      // (below), with wording that names which thing failed rather than
      // reusing the login-screen copy for a Refresh that never touched a
      // password.
      if (gen === requestGenRef.current) setError(wasAuthed ? 'Could not refresh the stats.' : 'Could not reach the server.');
    }
    if (gen === requestGenRef.current) setLoading(false);
  };

  const StatCard = ({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: number; sub?: string }) => (
    <div className={`rounded-xl border p-4 flex items-center gap-3 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
      <div className={`p-2 rounded-lg ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>{icon}</div>
      <div>
        <div className="text-2xl font-bold text-slate-900 dark:text-white">{value}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
        {sub && <div className="text-xs text-muted dark:text-muted-dark">{sub}</div>}
      </div>
    </div>
  );

  return (
    <ModalSurface
      id="admin"
      open={open}
      onClose={onClose}
      ariaLabel="Admin dashboard"
      // OPUS-REVIEW-MODAL16 N3: same as OVERLAY_CLASS (ModalSurface.tsx) MINUS
      // select-none — this panel's whole reason to exist is a table of user
      // emails and counts an operator wants to copy. Keeps z-[65] (NOT
      // DownloadModal's z-50): that is what puts Admin above the guided tour's
      // z-[60] (OPUS-REVIEW-MODAL16 note 7) — copying DownloadModal's overlay
      // class verbatim would silently drop Admin back under the tour.
      overlayClassName="fixed inset-0 z-[65] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs"
      panelClassName={`relative w-full max-w-3xl rounded-2xl border shadow-2xl flex flex-col max-h-[90vh] ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'}`}
    >
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-accent-500" />
            <h2 className="font-bold text-slate-900 dark:text-white text-sm">Admin Dashboard</h2>
          </div>
          <div className="flex items-center gap-2">
            {authed && (
              <button onClick={() => fetchStats(password)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-accent-500 cursor-pointer">
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            )}
            {authed && (
              // OPUS-REVIEW-MODAL16 N4 + CodeRabbit CLI (PR #162 follow-up):
              // Sign out must invalidate the same generation an in-flight
              // Refresh checks (else a Refresh started just before Sign out
              // still lands and re-auths the panel), AND reset loading/error
              // the same way the close effect does — otherwise a Refresh
              // in flight at Sign-out time skips its own setLoading(false)
              // (the generation check returns early) and the Login button
              // stays disabled until the whole panel closes.
              <button onClick={() => { requestGenRef.current += 1; setAuthed(false); setStats(null); setPassword(''); setLoading(false); setError(''); }} className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-500 cursor-pointer">
                <LogOut className="w-3.5 h-3.5" /> Sign out
              </button>
            )}
            {/* OPUS-REVIEW-MODAL16 F1: this button is the panel's first
                focusable (the trap parks open-time focus here), so it needs
                a real accessible name — an icon-only button announces
                nothing and a screen-reader user has no idea what it does. */}
            <button onClick={onClose} aria-label="Close admin dashboard" className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {!authed ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <ShieldCheck className="w-10 h-10 text-accent-400" />
              {/* OPUS-REVIEW-APP16 FBM-1: was a bare <p>, so this input's
                  ONLY name source was `placeholder` — labelFor pairs them. */}
              <label htmlFor={labelFor('admin', 'password')} className="text-sm text-slate-500 dark:text-slate-400">Enter admin password to view stats</label>
              <div className="flex gap-2 w-full max-w-xs">
                <input
                  id={labelFor('admin', 'password')}
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && fetchStats(password)}
                  placeholder="Admin password"
                  // OPUS-REVIEW-MODAL16 F1: without this, the trap's open-time
                  // focus lands on the close X (first in DOM order) instead —
                  // autoFocus wins over that because it commits in the SAME
                  // phase, strictly before the trap's passive effect runs.
                  autoFocus
                  className={`flex-1 px-3 py-2 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-accent-300 ${isDark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-800'}`}
                />
                <button
                  onClick={() => fetchStats(password)}
                  disabled={loading}
                  className="px-4 py-2 bg-accent-600 hover:bg-accent-700 text-white text-sm font-semibold rounded-xl cursor-pointer disabled:opacity-50"
                >
                  {loading ? '...' : 'Login'}
                </button>
              </div>
              {/* CodeRabbit CLI (this review): role="alert" so a screen
                  reader announces the message the moment it appears — a
                  plain <p>/<span> has no live-region semantics at all. */}
              {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
            </div>
          ) : stats ? (
            <>
              {/* RED-APP-16/005: mirrors the `!authed` branch's error slot
                  above — a failed Refresh (429/network/etc.) used to set
                  `error` into a state nothing here could render. */}
              {error && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                  <span role="alert">{error}</span>
                  <button onClick={() => fetchStats(password)} disabled={loading} className="font-semibold underline hover:no-underline cursor-pointer shrink-0 disabled:opacity-50">
                    Retry
                  </button>
                </div>
              )}
              {/* Stat cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <StatCard icon={<Users className="w-4 h-4 text-accent-500" />} label="Total Users" value={stats.totalUsers} />
                <StatCard icon={<ShieldCheck className="w-4 h-4 text-emerald-500" />} label="Verified" value={stats.verifiedUsers} />
                <StatCard icon={<ShieldX className="w-4 h-4 text-amber-500" />} label="Unverified" value={stats.unverifiedUsers} />
                <StatCard icon={<GamepadIcon className="w-4 h-4 text-ne-mixed-500" />} label="Saved Games" value={stats.totalGames} />
                <StatCard icon={<TrendingUp className="w-4 h-4 text-blue-500" />} label="Signups Today" value={stats.signupsToday} />
                <StatCard icon={<TrendingUp className="w-4 h-4 text-cyan-500" />} label="Signups This Week" value={stats.signupsThisWeek} />
              </div>

              {/* User table */}
              <div>
                <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">All Users</h3>
                <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                  <table className="w-full text-xs">
                    <thead className={isDark ? 'bg-slate-800' : 'bg-slate-100'}>
                      <tr>
                        <th className="text-left px-3 py-2 text-slate-500 dark:text-slate-400 font-semibold">Username</th>
                        <th className="text-left px-3 py-2 text-slate-500 dark:text-slate-400 font-semibold">Email</th>
                        <th className="text-center px-3 py-2 text-slate-500 dark:text-slate-400 font-semibold">Verified</th>
                        <th className="text-center px-3 py-2 text-slate-500 dark:text-slate-400 font-semibold">Games</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.users.map((u, i) => (
                        <tr key={i} className={`border-t ${isDark ? 'border-slate-700 hover:bg-slate-800' : 'border-slate-100 hover:bg-slate-50'}`}>
                          <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">@{u.username}</td>
                          <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{u.email}</td>
                          <td className="px-3 py-2 text-center">
                            {u.isVerified
                              ? <span className="text-emerald-500 font-bold">✓</span>
                              : <span className="text-amber-500 font-bold">–</span>}
                          </td>
                          <td className="px-3 py-2 text-center text-slate-600 dark:text-slate-300">{u.gamesCount}</td>
                        </tr>
                      ))}
                      {stats.users.length === 0 && (
                        <tr><td colSpan={4} className="px-3 py-4 text-center text-slate-400">No users yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </div>
    </ModalSurface>
  );
};

import React, { useState } from 'react';
import { Users, GamepadIcon, ShieldCheck, ShieldX, TrendingUp, RefreshCw, LogOut, X } from 'lucide-react';

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
  onClose: () => void;
  isDark: boolean;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ onClose, isDark }) => {
  const [password, setPassword] = useState('');
  const [authed, setAuthed] = useState(false);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchStats = async (secret: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { 'x-admin-secret': secret },
      });
      if (res.status === 401) { setError('Incorrect password.'); setLoading(false); return; }
      if (!res.ok) throw new Error('Server error');
      const data = await res.json();
      setStats(data);
      setAuthed(true);
    } catch {
      setError('Could not reach the server.');
    }
    setLoading(false);
  };

  const StatCard = ({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: number; sub?: string }) => (
    <div className={`rounded-xl border p-4 flex items-center gap-3 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
      <div className={`p-2 rounded-lg ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>{icon}</div>
      <div>
        <div className="text-2xl font-bold text-slate-900 dark:text-white">{value}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
        {sub && <div className="text-[10px] text-slate-400 dark:text-slate-500">{sub}</div>}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full max-w-3xl rounded-2xl border shadow-2xl flex flex-col max-h-[90vh] ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>

        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-500" />
            <h2 className="font-bold text-slate-900 dark:text-white text-sm">Admin Dashboard</h2>
          </div>
          <div className="flex items-center gap-2">
            {authed && (
              <button onClick={() => fetchStats(password)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-indigo-500 cursor-pointer">
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            )}
            {authed && (
              <button onClick={() => { setAuthed(false); setStats(null); setPassword(''); }} className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-500 cursor-pointer">
                <LogOut className="w-3.5 h-3.5" /> Sign out
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {!authed ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <ShieldCheck className="w-10 h-10 text-indigo-400" />
              <p className="text-sm text-slate-500 dark:text-slate-400">Enter admin password to view stats</p>
              <div className="flex gap-2 w-full max-w-xs">
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && fetchStats(password)}
                  placeholder="Admin password"
                  className={`flex-1 px-3 py-2 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-indigo-300 ${isDark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-800'}`}
                />
                <button
                  onClick={() => fetchStats(password)}
                  disabled={loading}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl cursor-pointer disabled:opacity-50"
                >
                  {loading ? '...' : 'Login'}
                </button>
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
          ) : stats ? (
            <>
              {/* Stat cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <StatCard icon={<Users className="w-4 h-4 text-indigo-500" />} label="Total Users" value={stats.totalUsers} />
                <StatCard icon={<ShieldCheck className="w-4 h-4 text-emerald-500" />} label="Verified" value={stats.verifiedUsers} />
                <StatCard icon={<ShieldX className="w-4 h-4 text-amber-500" />} label="Unverified" value={stats.unverifiedUsers} />
                <StatCard icon={<GamepadIcon className="w-4 h-4 text-purple-500" />} label="Saved Games" value={stats.totalGames} />
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
      </div>
    </div>
  );
};

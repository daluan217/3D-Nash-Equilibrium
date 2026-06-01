/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { GamePayoffs, PresetGame } from '../types';
import { PRESETS, computeAllNE } from '../utils/gameEngine';
import { GameGraphMiniature } from './GameGraphMiniature';
import {
  X,
  HelpCircle,
  BookOpen,
  Trash2,
  LogIn,
  Sliders,
  AlertTriangle,
  Mail,
  Key,
  CheckCircle2,
  Loader2,
  Compass,
  FileText,
  Database
} from 'lucide-react';

interface MenuDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  user: { id: string; username: string; email: string } | null;
  authToken: string | null;
  userCustomGames: any[];
  onDeleteCustomGame: (id: string) => void;
  onLoadPreset: (key: string) => void;
  activePreset: string;
  isDark: boolean;
  onLogout: () => void;
  onOpenAuth: () => void;
  getApiUrl: (path: string) => string;
  dbMode: 'local' | 'cloud';
  apiBaseUrl: string;
  onSwitchDbMode: (mode: 'local' | 'cloud') => void;
  onUpdateApiBaseUrl: (url: string) => void;
}

export const MenuDrawer: React.FC<MenuDrawerProps> = ({
  isOpen,
  onClose,
  user,
  authToken,
  userCustomGames,
  onDeleteCustomGame,
  onLoadPreset,
  activePreset,
  isDark,
  onLogout,
  onOpenAuth,
  getApiUrl,
  dbMode,
  apiBaseUrl,
  onSwitchDbMode,
  onUpdateApiBaseUrl,
}) => {
  const isElectron = typeof window !== 'undefined' && window.navigator?.userAgent?.toLowerCase().includes('electron');
  const [activeTab, setActiveTab] = useState<'help' | 'library' | 'account'>('help');

  // Account deletion states
  const [deleteStep, setDeleteStep] = useState<'initial' | 'confirm' | 'inputCode' | 'success'>('initial');
  const [deleteCode, setDeleteCode] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteSuccess, setDeleteSuccess] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Retrieve default presets (excluding 'custom' raw definition)
  const defaultPresets = useMemo(() => {
    return Object.keys(PRESETS)
      .filter((k) => k !== 'custom')
      .map((k) => {
        const p = PRESETS[k];
        return {
          key: k,
          name: p.name,
          desc: p.desc,
          payoffs: {
            a11: p.a11 ?? 0,
            a12: p.a12 ?? 0,
            a21: p.a21 ?? 0,
            a22: p.a22 ?? 0,
            b11: p.b11 ?? 0,
            b12: p.b12 ?? 0,
            b21: p.b21 ?? 0,
            b22: p.b22 ?? 0,
          } as GamePayoffs,
        };
      });
  }, []);

  // Format custom games for visual list listing
  const formattedCustomGames = useMemo(() => {
    return userCustomGames.map((g) => ({
      id: g.id,
      name: g.name,
      desc: g.description,
      payoffs: g.payoffs as GamePayoffs,
    }));
  }, [userCustomGames]);

  // Handle deletion request (API call to dispatch email)
  const handleDeleteRequest = async () => {
    if (!authToken) return;
    setDeleteLoading(true);
    setDeleteError('');
    try {
      const res = await fetch(getApiUrl('/api/auth/delete-request'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });
      
      let data;
      try {
        data = await res.json();
      } catch (e) {
        data = { error: `Server returned invalid response (Status ${res.status}).` };
      }

      if (!res.ok) {
        throw new Error(data.error || 'Failed to initialize deletion request.');
      }
      setDeleteStep('inputCode');
      setDeleteSuccess(data.message || 'Verification code sent.');
      if (data.deleteCode) {
        setDeleteCode(data.deleteCode);
      }
    } catch (err: any) {
      setDeleteError(err.message);
    } finally {
      setDeleteLoading(false);
    }
  };

  // Handle deletion verification and execution
  const handleDeleteConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !deleteCode) return;
    setDeleteLoading(true);
    setDeleteError('');
    try {
      const res = await fetch(getApiUrl('/api/auth/delete-confirm'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code: deleteCode }),
      });
      
      let data;
      try {
        data = await res.json();
      } catch (e) {
        data = { error: `Server returned invalid response (Status ${res.status}).` };
      }

      if (!res.ok) {
        throw new Error(data.error || 'Incorrect security verification code.');
      }
      setDeleteStep('success');
      setDeleteCode('');
      // Trigger logout in App after a small delay
      setTimeout(() => {
        onLogout();
        onClose();
        // Reset deletion states
        setDeleteStep('initial');
      }, 3500);
    } catch (err: any) {
      setDeleteError(err.message);
    } finally {
      setDeleteLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end select-none">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/40 dark:bg-black/50 backdrop-blur-xs transition-opacity cursor-pointer duration-300"
        onClick={onClose}
      />

      {/* Slideout sliding panel */}
      <div className={`relative w-full max-w-2xl bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 h-full flex flex-col shadow-2xl z-10 animate-in slide-in-from-right duration-300`}>
        {/* Panel Header */}
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-950/40">
          <div className="flex items-center gap-2">
            <Compass className="w-5 h-5 text-indigo-500 animate-spin-slow" />
            <span className="font-bold text-slate-800 dark:text-slate-100 text-base">
              Simulator Workspace Center
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 px-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Selection Row */}
        <div className="flex border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900">
          <button
            type="button"
            onClick={() => setActiveTab('help')}
            className={`flex-1 py-3 text-xs sm:text-sm font-semibold border-b-2 flex items-center justify-center gap-1.5 transition-all cursor-pointer ${activeTab === 'help'
                ? 'border-indigo-600 text-indigo-650 dark:text-indigo-400 dark:border-indigo-400 bg-indigo-50/10'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-450 hover:bg-slate-50/50 dark:hover:bg-slate-800/10'
              }`}
          >
            <HelpCircle className="w-4 h-4" />
            Help Guides & Visuals
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('library')}
            className={`flex-1 py-3 text-xs sm:text-sm font-semibold border-b-2 flex items-center justify-center gap-1.5 transition-all cursor-pointer ${activeTab === 'library'
                ? 'border-indigo-600 text-indigo-650 dark:text-indigo-400 dark:border-indigo-400 bg-indigo-50/10'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-450 hover:bg-slate-50/50 dark:hover:bg-slate-800/10'
              }`}
          >
            <BookOpen className="w-4 h-4" />
            Presets & Custom Library
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('account')}
            className={`flex-1 py-3 text-xs sm:text-sm font-semibold border-b-2 flex items-center justify-center gap-1.5 transition-all cursor-pointer ${activeTab === 'account'
                ? 'border-indigo-600 text-indigo-650 dark:text-indigo-400 dark:border-indigo-400 bg-indigo-50/10'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-450 hover:bg-slate-50/50 dark:hover:bg-slate-800/10'
              }`}
          >
            <Sliders className="w-4 h-4" />
            Danger Zone
          </button>
        </div>

        {/* Sliding Panel Content (with scroll) */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">

          {/* ──────────────── TAB 1: HELP SECTION ──────────────── */}
          {activeTab === 'help' && (
            <div className="space-y-7 text-slate-650 dark:text-slate-300 text-xs md:text-sm leading-relaxed">

              {/* SECTION 1: How to Decipher the 3D Graph */}
              <div className="space-y-4">
                <h3 className="text-sm md:text-base font-bold text-slate-800 dark:text-white flex items-center gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
                  <span className="p-1 px-2.5 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-500 rounded-lg text-xs md:text-sm font-extrabold">1</span>
                  How to Decipher the 3D Graph
                </h3>

                <div className="space-y-4">
                  <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-950/20">
                    <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-1.5 flex items-center gap-2 text-xs md:text-sm">
                      <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 shadow-xs" />
                      The 3D Surface
                    </h4>
                    <p className="text-[11px] md:text-xs text-slate-600 dark:text-slate-350 leading-relaxed font-semibold">
                      The graph shows expected payoffs for each player at different strategy combinations. The X and Y axes represent the probability of each action, and the Z-axis (height) shows the payoff.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-950/20">
                    <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2 text-xs md:text-sm">
                      <span className="w-2.5 h-2.5 rounded-full bg-rose-500 shadow-xs" />
                      Colored Paths
                    </h4>
                    <div className="text-[11px] md:text-xs text-slate-600 dark:text-slate-350 leading-relaxed font-semibold space-y-1">
                      <p><span className="text-blue-500 font-bold">Blue path:</span> Player A's strategy evolution over time.</p>
                      <p><span className="text-rose-500 font-bold">Red path:</span> Player B's strategy evolution over time.</p>
                      <p className="pt-1.5 text-slate-550 dark:text-slate-400">The paths show how each player's best responses zigzag through strategy space.</p>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-950/20">
                    <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-1.5 flex items-center gap-2 text-xs md:text-sm">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-xs" />
                      Equilibrium Points
                    </h4>
                    <p className="text-[11px] md:text-xs text-slate-600 dark:text-slate-350 leading-relaxed font-semibold">
                      Where the colored paths converge to flat regions or specific points on the payoff surface are Nash Equilibria. These are the stable end states of the game.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-950/20">
                    <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-1.5 flex items-center gap-2 text-xs md:text-sm">
                      <span className="w-2.5 h-2.5 rounded-full bg-purple-500 shadow-xs" />
                      Corridor Shrinkage
                    </h4>
                    <p className="text-[11px] md:text-xs text-slate-600 dark:text-slate-350 leading-relaxed font-semibold">
                      The "shrink step" parameter gradually narrows the search range, simulating how players become more confident in their strategy choices over time, forcing convergence to equilibrium.
                    </p>
                  </div>
                </div>

                {/* VISUAL AIDS GRID */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  {/* Fig 1 */}
                  <div className="bg-slate-50/50 dark:bg-slate-950/40 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 flex flex-col items-center">
                    <span className="text-[10px] uppercase tracking-wider font-extrabold text-slate-450 dark:text-slate-500 mb-4 text-center">
                      Fig 1. Coordinate Grid & Strategy Axes
                    </span>
                    <svg width="200" height="200" viewBox="0 0 200 200" className="overflow-visible select-none">
                      {/* Grid Background Box */}
                      <rect x="25" y="25" width="150" height="150" rx="12" fill={isDark ? '#020617' : '#f8fafc'} stroke={isDark ? '#334155' : '#cbd5e1'} strokeWidth="1.5" />

                      {/* Dotted grid lines */}
                      <line x1="62.5" y1="25" x2="62.5" y2="175" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />
                      <line x1="100" y1="25" x2="100" y2="175" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />
                      <line x1="137.5" y1="25" x2="137.5" y2="175" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />

                      <line x1="25" y1="62.5" x2="175" y2="62.5" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />
                      <line x1="25" y1="100" x2="175" y2="100" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />
                      <line x1="25" y1="137.5" x2="175" y2="137.5" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />

                      {/* Axis Labels */}
                      <text x="14" y="24" fill={isDark ? '#94a3b8' : '#475569'} fontSize="11" fontWeight="bold">Y</text>
                      <text x="182" y="186" fill={isDark ? '#94a3b8' : '#475569'} fontSize="11" fontWeight="bold">X</text>

                      {/* Coordinates */}
                      <text x="14" y="180" fill={isDark ? '#64748b' : '#94a3b8'} fontSize="9" fontWeight="medium">0,0</text>
                      <text x="180" y="24" fill={isDark ? '#64748b' : '#94a3b8'} fontSize="9" fontWeight="medium">1,1</text>

                      {/* Equilibrium Node */}
                      <circle cx="137.5" cy="100" r="14" fill={isDark ? 'rgba(16, 185, 129, 0.15)' : 'rgba(16, 185, 129, 0.08)'} />
                      <circle cx="137.5" cy="100" r="8" fill="none" stroke="#10b981" strokeWidth="2.5" className="animate-pulse" />
                      <circle cx="137.5" cy="100" r="4.5" fill="#10b981" />

                      <text x="137.5" y="80" fill="#10b981" fontSize="9.5" fontWeight="bold" textAnchor="middle">equilibrium core</text>
                    </svg>
                  </div>

                  {/* Fig 2 */}
                  <div className="bg-slate-50/50 dark:bg-slate-950/40 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 flex flex-col items-center">
                    <span className="text-[10px] uppercase tracking-wider font-extrabold text-slate-450 dark:text-slate-500 mb-4 text-center">
                      Fig 2. Best-Response Intersections
                    </span>
                    <svg width="200" height="200" viewBox="0 0 200 200" className="overflow-visible select-none">
                      {/* Grid Background Box */}
                      <rect x="25" y="25" width="150" height="150" rx="12" fill={isDark ? '#020617' : '#f8fafc'} stroke={isDark ? '#334155' : '#cbd5e1'} strokeWidth="1.5" />

                      {/* Dotted grid lines */}
                      <line x1="62.5" y1="25" x2="62.5" y2="175" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />
                      <line x1="100" y1="25" x2="100" y2="175" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />
                      <line x1="137.5" y1="25" x2="137.5" y2="175" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />

                      <line x1="25" y1="62.5" x2="175" y2="62.5" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />
                      <line x1="25" y1="100" x2="175" y2="100" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />
                      <line x1="25" y1="137.5" x2="175" y2="137.5" stroke={isDark ? '#1e293b' : '#e2e8f0'} strokeWidth="0.75" strokeDasharray="3,3" />

                      {/* X and Y labels */}
                      <text x="14" y="24" fill={isDark ? '#94a3b8' : '#475569'} fontSize="11" fontWeight="bold">Y</text>
                      <text x="182" y="186" fill={isDark ? '#94a3b8' : '#475569'} fontSize="11" fontWeight="bold">X</text>

                      {/* Coordinates */}
                      <text x="14" y="180" fill={isDark ? '#64748b' : '#94a3b8'} fontSize="9" fontWeight="medium">0,0</text>
                      <text x="180" y="24" fill={isDark ? '#64748b' : '#94a3b8'} fontSize="9" fontWeight="medium">1,1</text>

                      {/* Player A BR (Red path) */}
                      <path
                        d="M 25 175 L 25 100 L 175 100 L 175 25"
                        fill="none"
                        stroke="#f43f5e"
                        strokeWidth="3.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />

                      {/* Player B BR (Blue path) */}
                      <path
                        d="M 25 25 L 137.5 25 L 137.5 175 L 175 175"
                        fill="none"
                        stroke="#3b82f6"
                        strokeWidth="3.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />

                      {/* Purple intersecting node */}
                      <circle cx="137.5" cy="100" r="14" fill={isDark ? 'rgba(168, 85, 247, 0.15)' : 'rgba(168, 85, 247, 0.08)'} />
                      <circle cx="137.5" cy="100" r="8" fill="none" stroke="#c084fc" strokeWidth="2.5" />
                      <circle cx="137.5" cy="100" r="4.5" fill="#a855f7" />

                      {/* Labels */}
                      <text x="85" y="92" fill="#f43f5e" fontSize="9" fontWeight="extrabold" textAnchor="middle">Player A BR</text>
                      <text x="146" y="145" fill="#3b82f6" fontSize="9" fontWeight="extrabold" textAnchor="start">Player B BR</text>
                      <text x="151" y="115" fill="#a855f7" fontSize="8" fontWeight="black" textAnchor="start">NASH INTERSECT</text>
                    </svg>
                  </div>
                </div>
              </div>

              {/* SECTION 2: How the Simulation Works */}
              <div className="space-y-4 pt-2">
                <h3 className="text-sm md:text-base font-bold text-slate-800 dark:text-white flex items-center gap-2 pb-2 border-b border-b-slate-100 dark:border-b-slate-800">
                  <span className="p-1 px-2.5 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-500 rounded-lg text-xs md:text-sm font-extrabold">2</span>
                  How the Simulation Works
                </h3>

                <div className="grid grid-cols-1 gap-4">
                  <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-950/20 shadow-xs space-y-1">
                    <h4 className="font-bold text-slate-800 dark:text-slate-100 text-xs md:text-sm">
                      Starting Point
                    </h4>
                    <p className="text-[11px] md:text-xs text-slate-600 dark:text-slate-350 leading-relaxed font-semibold">
                      The simulation begins at a mix strategy (a point between 0 and 1 on each axis representing probability of each action).
                    </p>
                  </div>

                  <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-950/20 shadow-xs space-y-1">
                    <h4 className="font-bold text-slate-800 dark:text-slate-100 text-xs md:text-sm">
                      Best Response Dynamics
                    </h4>
                    <p className="text-[11px] md:text-xs text-slate-600 dark:text-slate-350 leading-relaxed font-semibold">
                      Players take turns playing their best response to the opponent's current strategy. The simulation tracks how strategies evolve over time as players react to each other.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-950/20 shadow-xs space-y-1">
                    <h4 className="font-bold text-slate-800 dark:text-slate-100 text-xs md:text-sm">
                      Convergence
                    </h4>
                    <p className="text-[11px] md:text-xs text-slate-600 dark:text-slate-350 leading-relaxed font-semibold">
                      When the simulation reaches a Nash Equilibrium, both players are playing optimal strategies and the system stabilizes. The simulation shows "Converged" in the top right when this happens.
                    </p>
                  </div>
                </div>

                {/* Sub-section: Controls & Settings */}
                <div className="p-4 border border-indigo-100 dark:border-indigo-950/40 rounded-xl bg-indigo-50/10 dark:bg-indigo-950/5 space-y-3">
                  <h4 className="font-bold text-indigo-600 dark:text-indigo-400 text-xs md:text-sm">
                    Controls & Settings
                  </h4>

                  <div className="space-y-3.5 text-[11px] md:text-xs">
                    <div>
                      <strong className="text-slate-750 dark:text-slate-200 block mb-0.5">Run / Step / Reset</strong>
                      <ul className="list-disc pl-5 mt-1 space-y-1 text-slate-550 dark:text-slate-400">
                        <li><strong>Step:</strong> Execute one round of best responses.</li>
                        <li><strong>Run:</strong> Continuously play until convergence.</li>
                        <li><strong>Reset:</strong> Return to the starting point.</li>
                      </ul>
                    </div>

                    <div>
                      <strong className="text-slate-750 dark:text-slate-200 block mb-0.5">Back</strong>
                      <p className="text-slate-550 dark:text-slate-400">
                        Rewind one round/step of best responses to explore alternative trajectories backward in time.
                      </p>
                    </div>

                    <div>
                      <strong className="text-slate-750 dark:text-slate-200 block mb-0.5">First Mover</strong>
                      <p className="text-slate-550 dark:text-slate-400">
                        Choose which player plays their best response first. This can significantly affect the path to equilibrium!
                      </p>
                    </div>

                    <div>
                      <strong className="text-slate-750 dark:text-slate-200 block mb-0.5">Speed</strong>
                      <p className="text-slate-550 dark:text-slate-400">
                        Controls how fast the animation runs during the simulation. Higher speeds mean faster convergence visualization.
                      </p>
                    </div>

                    <div>
                      <strong className="text-slate-750 dark:text-slate-200 block mb-0.5">Step-size</strong>
                      <p className="text-slate-550 dark:text-slate-400">
                        Simulates learning rate modifications, altering how responsive players' beliefs adapt to opponent strategies.
                      </p>
                    </div>

                    <div>
                      <strong className="text-slate-750 dark:text-slate-200 block mb-0.5">Initial Position</strong>
                      <p className="text-slate-550 dark:text-slate-400">
                        Set where the simulation starts. Since initial position does not determine the Nash Equilibrium in most standard games, this feature is moreso simply for visual aesthetics for the user, illustrating alternative pathways and trajectories to convergence.
                      </p>
                    </div>

                    <div>
                      <strong className="text-slate-750 dark:text-slate-200 block mb-0.5">Pan / Zoom</strong>
                      <p className="text-slate-550 dark:text-slate-400">
                        Navigate the 3D graph representation to inspect convergence surfaces and trajectory paths from different angles.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* SECTION 3: Education/Learning Tips Section */}
              <div className="space-y-4 pt-2">
                <h3 className="text-sm md:text-base font-bold text-slate-800 dark:text-white flex items-center gap-2 pb-2 border-b border-b-slate-100 dark:border-b-slate-800">
                  <span className="p-1 px-2.5 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-500 rounded-lg text-xs md:text-sm font-extrabold">3</span>
                  Tips for Learning
                </h3>

                <div className="space-y-4">
                  <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-950/20 shadow-xs space-y-1">
                    <h4 className="font-bold text-slate-800 dark:text-slate-100 text-xs md:text-sm">
                      What is Nash Equilibrium?
                    </h4>
                    <p className="text-[11px] md:text-xs text-slate-650 dark:text-slate-300 leading-relaxed font-semibold">
                      A Nash Equilibrium is a state in a game where no player can improve their outcome by changing their strategy, given the other player's strategy. It represents a stable situation where both players are making optimal decisions.
                    </p>
                  </div>

                  <ul className="space-y-2 text-[11px] md:text-xs pl-5 list-disc text-slate-600 dark:text-slate-350 font-semibold direct-tips">
                    <li>
                      <span className="text-slate-800 dark:text-slate-200 font-bold">Experiment with payoffs:</span> Change the game payoffs and watch how equilibria shift.
                    </li>
                    <li>
                      <span className="text-slate-800 dark:text-slate-200 font-bold">Watch the logs:</span> The terminal shows exactly what's happening at each step of the simulation.
                    </li>
                    <li>
                      <span className="text-slate-800 dark:text-slate-200 font-bold">Compare games:</span> Switch between the preset scenarios to see how different games behave.
                    </li>
                    <li>
                      <span className="text-slate-800 dark:text-slate-200 font-bold">Save your findings:</span> Create custom games and save them to analyze later.
                    </li>
                  </ul>
                </div>
              </div>

            </div>
          )}

          {/* ──────────────── TAB 2: LIBRARY SECTION ──────────────── */}
          {activeTab === 'library' && (
            <div className="space-y-6">

              {/* Default Presets Segment */}
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-3.5 flex items-center gap-1">
                  <FileText className="w-3.5 h-3.5" /> Core Preset Profiles
                </div>

                <div className="grid grid-cols-1 gap-4">
                  {defaultPresets.map((preset) => {
                    const eqList = computeAllNE(preset.payoffs);
                    const isSelected = activePreset === preset.key;

                    return (
                      <div
                        key={preset.key}
                        className={`border rounded-2xl p-4 flex flex-col sm:flex-row gap-4 transition-all duration-200 ${isSelected
                            ? 'bg-indigo-50/15 dark:bg-indigo-950/10 border-indigo-400 dark:border-indigo-800 shadow-md ring-1 ring-indigo-400/20'
                            : 'bg-white dark:bg-slate-950/30 border-slate-100 dark:border-slate-800/80 hover:border-slate-200 dark:hover:border-slate-700 shadow-sm'
                          }`}
                      >
                        {/* Dynamic Miniature SVG representing strategy space */}
                        <div className="flex justify-center items-center">
                          <GameGraphMiniature payoffs={preset.payoffs} isDark={isDark} />
                        </div>

                        {/* Content description & equilibria stats */}
                        <div className="flex-1 flex flex-col justify-between">
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-bold text-slate-800 dark:text-slate-100 text-xs sm:text-sm">
                                {preset.name}
                              </span>
                              {isSelected && (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-900">
                                  Simulation Active
                                </span>
                              )}
                            </div>
                            <p
                              className="text-[11px] text-slate-500 dark:text-slate-400 mb-2.5 leading-relaxed"
                              dangerouslySetInnerHTML={{ __html: preset.desc }}
                            />

                            {/* Dynamically Plotted Nash Equilibria */}
                            <div className="bg-slate-50 dark:bg-slate-950/50 rounded-xl p-2.5 border border-slate-100 dark:border-slate-800/85">
                              <div className="text-[10px] font-bold text-slate-450 dark:text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                                Computed Nash Equilibria:
                              </div>
                              <ul className="text-[10px] md:text-xs text-slate-600 dark:text-slate-300 pl-4 list-disc space-y-0.5">
                                {eqList.map((eq, i) => (
                                  <li key={i}>
                                    <strong className={eq.type === 'mixed' ? 'text-purple-650 dark:text-purple-400 font-bold' : 'text-slate-705 dark:text-slate-200'}>
                                      {eq.label}
                                    </strong>{' '}
                                    val (E[A]={eq.eA.toFixed(2)}, E[B]={eq.eB.toFixed(2)})
                                  </li>
                                ))}
                                {eqList.length === 0 && (
                                  <li className="text-red-500">No classic NE in real plane</li>
                                )}
                              </ul>
                            </div>
                          </div>

                          <div className="mt-4 flex justify-end">
                            <button
                              type="button"
                              onClick={() => {
                                onLoadPreset(preset.key);
                                onClose();
                              }}
                              disabled={isSelected}
                              className={`w-full sm:w-auto px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${isSelected
                                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 border border-transparent cursor-not-allowed'
                                  : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs'
                                }`}
                            >
                              {isSelected ? 'Currently Loaded' : 'Load Game Layout'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Custom Games Saved Segment */}
              <div className="border-t border-slate-100 dark:border-slate-800 pt-6">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-3.5 flex items-center justify-between">
                  <span>Custom User Profiles ({formattedCustomGames.length})</span>
                  {!user && (
                    <span className="text-[10px] text-indigo-500 normal-case font-medium">
                      🔒 Log in to persist custom profiles
                    </span>
                  )}
                </div>

                {user && formattedCustomGames.length > 0 ? (
                  <div className="grid grid-cols-1 gap-4">
                    {formattedCustomGames.map((game) => {
                      const eqList = computeAllNE(game.payoffs);
                      const isSelected = activePreset === game.id;

                      return (
                        <div
                          key={game.id}
                          className={`border rounded-2xl p-4 flex flex-col sm:flex-row gap-4 transition-all duration-200 ${isSelected
                              ? 'bg-indigo-50/15 dark:bg-indigo-950/10 border-indigo-400 dark:border-indigo-800 shadow-md ring-1 ring-indigo-400/20'
                              : 'bg-white dark:bg-slate-950/30 border-slate-100 dark:border-slate-800/80 hover:border-slate-200 dark:hover:border-slate-700 shadow-sm'
                            }`}
                        >
                          {/* Miniature */}
                          <div className="flex justify-center items-center">
                            <GameGraphMiniature payoffs={game.payoffs} isDark={isDark} />
                          </div>

                          {/* Detail Content */}
                          <div className="flex-1 flex flex-col justify-between">
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <span className="font-bold text-slate-800 dark:text-slate-100 text-xs sm:text-sm truncate max-w-[180px]">
                                  {game.name}
                                </span>
                                <div className="flex items-center gap-1.5">
                                  {isSelected && (
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-900">
                                      Active
                                    </span>
                                  )}
                                  <button
                                    onClick={() => onDeleteCustomGame(game.id)}
                                    className="p-1 px-1.5 hover:bg-rose-50 dark:hover:bg-rose-955/25 text-slate-400 hover:text-rose-500 rounded-lg transition-colors cursor-pointer"
                                    title="Delete custom layout"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-2.5 leading-relaxed">
                                {game.desc}
                              </p>

                              {/* Plotted NE */}
                              <div className="bg-slate-50 dark:bg-slate-950/50 rounded-xl p-2.5 border border-slate-100 dark:border-slate-800/85">
                                <div className="text-[10px] font-bold text-slate-450 dark:text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                                  Computed Nash Equilibria:
                                </div>
                                <ul className="text-[10px] md:text-xs text-slate-600 dark:text-slate-300 pl-4 list-disc space-y-0.5">
                                  {eqList.map((eq, i) => (
                                    <li key={i}>
                                      <strong className={eq.type === 'mixed' ? 'text-purple-650 dark:text-purple-400 font-bold' : 'text-slate-705 dark:text-slate-200'}>
                                        {eq.label}
                                      </strong>{' '}
                                      val (E[A]={eq.eA.toFixed(2)}, E[B]={eq.eB.toFixed(2)})
                                    </li>
                                  ))}
                                  {eqList.length === 0 && (
                                    <li className="text-red-500">No classic NE in real plane</li>
                                  )}
                                </ul>
                              </div>
                            </div>

                            <div className="mt-4 flex justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  onLoadPreset(game.id);
                                  onClose();
                                }}
                                disabled={isSelected}
                                className={`w-full sm:w-auto px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${isSelected
                                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 border border-transparent cursor-not-allowed'
                                    : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs'
                                  }`}
                              >
                                {isSelected ? 'Currently Loaded' : 'Load Game Layout'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="bg-slate-50 dark:bg-slate-950/20 border border-slate-150 dark:border-slate-800 rounded-2xl p-5 text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    {user ? (
                      <p>
                        No saved custom game presets. Customize payoffs in the main board and click{' '}
                        <strong className="text-indigo-600 dark:text-indigo-400">Save payoffs</strong> to record your own scenarios!
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <p>You must be signed in to view and save custom game profiles.</p>
                        <button
                          onClick={() => {
                            onClose();
                            onOpenAuth();
                          }}
                          className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-xl font-bold text-xs cursor-pointer shadow-xs transition-all"
                        >
                          <LogIn className="w-3 h-3" /> Sign In / Sign Up
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ──────────────── TAB 3: ACCOUNT & DANGER ZONE ──────────────── */}
          {activeTab === 'account' && (
            <div className="space-y-6">
              {isElectron && (
                <div className="border border-indigo-100 dark:border-indigo-950 rounded-2xl p-5 bg-indigo-50/10 dark:bg-indigo-950/10 shadow-sm space-y-3 text-xs">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                      <Database className="w-5 h-5 text-indigo-500" />
                      Database Sync Mode
                    </h4>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${dbMode === 'cloud'
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-300/30'
                        : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-300/30'
                      }`}>
                      {dbMode === 'cloud' ? 'Cloud Sync Online' : 'Local Standalone Offline'}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-normal">
                    Choose whether the application saves game presets and user accounts to your offline local computer database, or synchronizes live with the central website hub.
                  </p>

                  <div className="grid grid-cols-2 gap-2.5 pt-1">
                    <button
                      type="button"
                      onClick={() => onSwitchDbMode('local')}
                      className={`py-2 px-3 rounded-xl border text-center font-bold text-xs transition-all cursor-pointer ${dbMode === 'local'
                          ? 'bg-white dark:bg-slate-900 border-indigo-500 text-indigo-600 dark:text-indigo-400 shadow-xs'
                          : 'bg-slate-50 hover:bg-slate-100 dark:bg-slate-950/40 dark:hover:bg-slate-950/80 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                        }`}
                    >
                      Local Offline Mode
                    </button>
                    <button
                      type="button"
                      onClick={() => onSwitchDbMode('cloud')}
                      className={`py-2 px-3 rounded-xl border text-center font-bold text-xs transition-all cursor-pointer ${dbMode === 'cloud'
                          ? 'bg-white dark:bg-slate-900 border-indigo-500 text-indigo-600 dark:text-indigo-400 shadow-xs'
                          : 'bg-slate-50 hover:bg-slate-100 dark:bg-slate-950/40 dark:hover:bg-slate-950/80 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                        }`}
                    >
                      Cloud Sync Mode
                    </button>
                  </div>

                  {dbMode === 'cloud' && (
                    <div className="pt-2.5 space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-450 dark:text-slate-500 uppercase tracking-wide">
                        Central Hub Website URL
                      </label>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={apiBaseUrl}
                          onChange={(e) => onUpdateApiBaseUrl(e.target.value)}
                          placeholder="e.g., https://nash-equilibrium.run.app"
                          className="flex-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl px-2.5 py-1.5 text-xs text-slate-850 dark:text-slate-100 font-mono focus:outline-none focus:border-indigo-500 transition-colors"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const trimmedBase = apiBaseUrl.trim().replace(/\/$/, '');
                              const res = await fetch(`${trimmedBase}/api/health`);
                              if (res.ok) {
                                alert("Connection successful! The central hub is online and reached successfully.");
                              } else {
                                alert(`Server reached but failed with status: ${res.status}`);
                              }
                            } catch (err: any) {
                              alert(`Connection failed! Please verify the URL and your internet connection. Detail: ${err.message}`);
                            }
                          }}
                          className="px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-300 font-bold transition-all cursor-pointer text-xs"
                        >
                          Test
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-normal pl-0.5">
                        Prefilled with your active digital workspace server URL. Saving custom games in Cloud Sync Mode will instantly sync them across any browser or app linked to your account!
                      </p>
                    </div>
                  )}
                </div>
              )}

              {!user ? (
                <div className="bg-slate-50 dark:bg-slate-950/20 border border-slate-150 dark:border-slate-800 rounded-2xl p-6 text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  <p className="mb-3">You are not logged in. Sign in to view account profiles and manage deletion preferences.</p>
                  <button
                    onClick={() => {
                      onClose();
                      onOpenAuth();
                    }}
                    className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl font-bold text-xs cursor-pointer shadow-xs transition-all"
                  >
                    <LogIn className="w-3.5 h-3.5" /> Sign In to Your Account
                  </button>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="border border-slate-100 dark:border-slate-800 rounded-2xl p-5 bg-white dark:bg-slate-950/20 shadow-sm space-y-3 text-xs">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100">
                      Active User Profile Information
                    </h4>
                    <div className="grid grid-cols-2 gap-4 pt-1.5 border-t border-slate-100 dark:border-slate-800">
                      <div>
                        <span className="text-slate-400 dark:text-slate-500 block">Username badge</span>
                        <strong className="text-slate-700 dark:text-slate-200 block text-xs md:text-sm">@{user.username}</strong>
                      </div>
                      <div>
                        <span className="text-slate-400 dark:text-slate-500 block">Registered Email</span>
                        <strong className="text-slate-700 dark:text-slate-200 block text-xs md:text-sm">{user.email}</strong>
                      </div>
                    </div>
                  </div>

                  {/* Danger Zone */}
                  <div className="border border-red-200/60 dark:border-red-950/50 rounded-2xl p-5 bg-red-50/5 dark:bg-red-950/5 shadow-subtle space-y-4">
                    <div className="flex items-center gap-1.5 text-red-700 dark:text-red-400 font-bold text-sm">
                      <AlertTriangle className="w-4 h-4 text-red-600" />
                      Danger Zone Operations
                    </div>

                    <p className="text-xs text-slate-550 dark:text-slate-400 leading-relaxed">
                      Wipe out your profile credentials, saved customs, history logs, and everything else in this simulator immediately. This action cannot be undone.
                    </p>

                    {deleteError && (
                      <div className="bg-rose-50 dark:bg-rose-955/20 border border-rose-200 dark:border-rose-900/40 text-rose-750 dark:text-rose-350 text-xs rounded-xl p-3 flex gap-2 font-medium">
                        <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                        <span>{deleteError}</span>
                      </div>
                    )}

                    {deleteStep === 'initial' && (
                      <div className="pt-2">
                        <button
                          type="button"
                          onClick={() => setDeleteStep('confirm')}
                          className="bg-red-600 hover:bg-red-700 text-white font-semibold text-xs py-2 px-4 rounded-xl transition-all shadow-xs cursor-pointer inline-flex items-center gap-1.5"
                        >
                          Delete Account Permanent
                        </button>
                      </div>
                    )}

                    {deleteStep === 'confirm' && (
                      <div className="bg-red-50/50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 rounded-xl p-4 space-y-3.5">
                        <p className="text-xs font-bold text-red-800 dark:text-red-300">
                          ⚠️ Are you absolutely sure? This cannot be undone!
                        </p>
                        <p className="text-xs text-slate-600 dark:text-slate-450 leading-relaxed">
                          Clicking below sends a 6-digit confirmation key to your primary address{' '}
                          <strong>{user.email}</strong>. Entering the correct code will trigger immediate deletion.
                        </p>
                        <div className="flex flex-wrap gap-2.5">
                          <button
                            type="button"
                            onClick={handleDeleteRequest}
                            disabled={deleteLoading}
                            className="bg-red-600 hover:bg-red-700 text-white font-semibold text-xs py-2 px-4 rounded-xl transition-all shadow-xs cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50"
                          >
                            {deleteLoading ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                Transmitting Code...
                              </>
                            ) : (
                              'Confirm and Request Verification Code'
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteStep('initial')}
                            className="bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-semibold py-2 px-4 rounded-xl cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {deleteStep === 'inputCode' && (
                      <form onSubmit={handleDeleteConfirm} className="space-y-4">
                        <div className="bg-emerald-50 dark:bg-emerald-955/15 border border-emerald-200 dark:border-emerald-900/40 text-emerald-800 dark:text-emerald-300 text-xs rounded-xl p-3 flex gap-2 font-medium">
                          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-500" />
                          <span>{deleteSuccess || 'Check your email inbox for a confirmation security code.'}</span>
                        </div>

                        <div>
                          <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">
                            6-Digit Security Confirmation Code
                          </label>
                          <div className="relative">
                            <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                            <input
                              type="text"
                              maxLength={6}
                              required
                              placeholder="123456"
                              value={deleteCode}
                              onChange={(e) => setDeleteCode(e.target.value.replace(/\D/g, ''))}
                              className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-105 focus:border-red-400 text-slate-800 dark:text-slate-200 tracking-widest font-mono font-bold text-center"
                            />
                          </div>
                        </div>

                        <div className="flex gap-2.5">
                          <button
                            type="submit"
                            disabled={deleteLoading || deleteCode.length !== 6}
                            className="bg-red-600 hover:bg-red-700 text-white font-bold text-xs py-2 px-4 rounded-xl transition-all shadow-xs cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50"
                          >
                            {deleteLoading ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                Terminating account...
                              </>
                            ) : (
                              'Verify & Permanently Terminate Account'
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteStep('initial');
                              setDeleteCode('');
                            }}
                            className="bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-semibold py-2 px-4 rounded-xl cursor-pointer"
                          >
                            Cancel Deletion
                          </button>
                        </div>
                      </form>
                    )}

                    {deleteStep === 'success' && (
                      <div className="bg-emerald-50 dark:bg-emerald-995/10 border border-emerald-200 dark:border-emerald-900 rounded-xl p-5 text-center text-emerald-800 dark:text-emerald-350 space-y-2">
                        <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-500" />
                        <h5 className="font-bold text-sm">Account Wiped Successfully</h5>
                        <p className="text-xs">
                          Your profile details and all saved games have been permanently destroyed. Signing out...
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

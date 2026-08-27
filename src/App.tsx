/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { GamePayoffs, SimState, PresetGame, NashEquilibrium, PathSegment, ReportEnvelope, type SuggestedScenario } from './types';
import {
  PRESETS,
  EA,
  EB,
  r3,
  computeAllNE,
  computeIndifference,
  doStep,
  buildPolyStr,
  generateRandomGame,
} from './utils/gameEngine';
import { PlotlyView } from './components/PlotlyView';
import { Walkthrough, type TourStep } from './components/Walkthrough';
import { CAMERA, TRACE, moveCamera } from './components/PlotlyView';
import {
  Play,
  Pause,
  RotateCcw,
  SkipForward,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  BookOpen,
  Sliders,
  Award,
  Terminal,
  Compass,
  CheckCircle2,
  Lock,
  AlertTriangle,
  User,
  LogIn,
  LogOut,
  Plus,
  Trash2,
  Pencil,
  Key,
  Mail,
  Info,
  Check,
  X,
  UserCheck,
  Sun,
  Moon,
  Menu,
  Download,
  MessageSquare,
  Star,
  Send,
  Sparkles,
  ShieldCheck,
  Maximize2,
  Minimize2
} from 'lucide-react';

import { MenuDrawer } from './components/MenuDrawer';
import { DownloadModal } from './components/DownloadModal';
import { AdminDashboard } from './components/AdminDashboard';
import katex from 'katex';

// Typeset LaTeX inline via KaTeX (self-hosted, works offline)
function MathTex({ tex, className }: { tex: string; className?: string }) {
  const html = useMemo(
    () => katex.renderToString(tex, { throwOnError: false }),
    [tex]
  );
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Color player-relevant phrases in model- or user-written PLAIN TEXT.
 *
 * Built-in preset descriptions carry trusted app-authored HTML spans, but the
 * AI explanation and user descriptions are rendered as text precisely so they
 * cannot inject markup. This applies the same player-a / player-b coloring as
 * a deterministic post-pass: known terms are matched (case-insensitively, at
 * word boundaries, longest first) and wrapped in React elements — the text
 * itself is never interpreted as HTML.
 */
function ColorCoded({ text, aTerms, bTerms }: { text: string; aTerms: string[]; bTerms: string[] }) {
  const nodes = useMemo(() => {
    const entries = [
      ...aTerms.map((t) => ({ t, cls: 'text-player-a-600 dark:text-player-a-400 font-semibold' })),
      ...bTerms.map((t) => ({ t, cls: 'text-player-b-600 dark:text-player-b-400 font-semibold' })),
    ]
      // Single characters ("A") are ambiguous with articles; require 2+ chars.
      .filter((e) => e.t && e.t.trim().length >= 2)
      .sort((p, q) => q.t.length - p.t.length);
    if (entries.length === 0 || !text) return [text];
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\w])(?:${entries.map((e) => esc(e.t)).join('|')})(?![\\w])`, 'gi');
    const out: React.ReactNode[] = [];
    let last = 0;
    let k = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const hit = m[0];
      const entry = entries.find((e) => e.t.toLowerCase() === hit.toLowerCase());
      out.push(<span key={k++} className={entry?.cls}>{hit}</span>);
      last = m.index + hit.length;
    }
    out.push(text.slice(last));
    return out;
  }, [text, aTerms, bTerms]);
  return <>{nodes}</>;
}

interface ThinSnapshot {
  cx: number; cy: number;
  calcX: number | null; calcY: number | null;
  discoveredMixedX: number | null; discoveredMixedY: number | null;
  foundAxis: 'x' | 'y' | null;
  domainLo: number; domainHi: number;
  converged: boolean; stepCount: number; cycleCount: number;
}

function toThin(s: SimState): ThinSnapshot {
  return {
    cx: s.cx, cy: s.cy, calcX: s.calcX, calcY: s.calcY,
    discoveredMixedX: s.discoveredMixedX, discoveredMixedY: s.discoveredMixedY,
    foundAxis: s.foundAxis,
    domainLo: s.domainLo, domainHi: s.domainHi,
    converged: s.converged, stepCount: s.stepCount, cycleCount: s.cycleCount,
  };
}

function precomputeThinHistory(
  initState: SimState,
  payoffs: GamePayoffs, firstMover: 'A' | 'B', shrinkStep: number,
  allNE: NashEquilibrium[], committedNE: NashEquilibrium | null,
  stepMode: 'shrink' | 'regret' = 'shrink'
): { snaps: ThinSnapshot[], neState: SimState | null } {
  const snaps: ThinSnapshot[] = [toThin(initState)];
  const state: SimState = {
    ...initState,
    visitedPositions: [...initState.visitedPositions],
    ghostVisitedPositions: [...initState.ghostVisitedPositions],
    pathSegmentsA: initState.pathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
    pathSegmentsB: initState.pathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
    phase1PtsA: null, phase1PtsB: null,
    ghostPathSegmentsA: [], ghostPathSegmentsB: [], historyStack: []
  };
  let neState: SimState | null = null;
  const MAX_STEPS = 5000;
  while (!state.converged && snaps.length < MAX_STEPS) {
    doStep(payoffs, state, firstMover, shrinkStep, allNE, committedNE, () => {}, () => {}, () => { state.running = false; }, stepMode);
    snaps.push(toThin(state));
    if (neState === null && (state.discoveredMixedX !== null || state.discoveredMixedY !== null)) {
      neState = {
        ...state,
        visitedPositions: [...state.visitedPositions],
        ghostVisitedPositions: [...state.ghostVisitedPositions],
        pathSegmentsA: state.pathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        pathSegmentsB: state.pathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        ghostPathSegmentsA: [], ghostPathSegmentsB: [], historyStack: [], running: false
      };
    }
  }
  return { snaps, neState };
}

function replayToStep(
  initState: SimState, targetStep: number,
  payoffs: GamePayoffs, firstMover: 'A' | 'B', shrinkStep: number,
  allNE: NashEquilibrium[], committedNE: NashEquilibrium | null,
  stepMode: 'shrink' | 'regret' = 'shrink'
): SimState {
  const state: SimState = {
    ...initState,
    visitedPositions: [...initState.visitedPositions],
    ghostVisitedPositions: [...initState.ghostVisitedPositions],
    pathSegmentsA: initState.pathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
    pathSegmentsB: initState.pathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
    phase1PtsA: null, phase1PtsB: null,
    ghostPathSegmentsA: [], ghostPathSegmentsB: [], historyStack: []
  };
  for (let i = 0; i < targetStep; i++) {
    doStep(payoffs, state, firstMover, shrinkStep, allNE, committedNE, () => {}, () => {}, () => { state.running = false; }, stepMode);
  }
  return state;
}

export default function App() {
  const isElectron = typeof window !== 'undefined' && window.navigator?.userAgent?.toLowerCase().includes('electron');
  const isElectronMac = isElectron && window.navigator?.userAgent?.toLowerCase().includes('mac');
  // Touch devices (phones + tablets) get the compact 2-row header; desktops get the flex row
  const isTouchDevice = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

  // ── Fullscreen detection (Electron macOS — hide traffic-light spacer when fullscreen) ──
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isElectronMac) return;
    const handler = (e: Event) => setIsFullscreen((e as CustomEvent).detail as boolean);
    window.addEventListener('electron-fullscreen-change', handler);
    return () => window.removeEventListener('electron-fullscreen-change', handler);
  }, [isElectronMac]);

  // ── Web display scale ────────────────────────────────────────────────────
  // The site historically rendered at 133% via a non-standard `zoom` hack.
  // Scaling the root font-size instead scales every rem-based size (text,
  // spacing, panels) together without breaking Plotly's pointer hit-testing.
  // 125% on top of the 15px type-scale base matches the old effective sizes.
  useEffect(() => {
    if (!isElectron) {
      document.documentElement.style.fontSize = '125%';
    }
  }, [isElectron]);

  // ── Theme State ────────────────────────────────────────────────────────────
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return localStorage.getItem('nash_sim_theme') === 'dark';
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('nash_sim_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('nash_sim_theme', 'light');
    }
    // Desktop app: keep the NATIVE window background in step with the theme.
    // It is what shows through when a drag-resize outpaces the repaint, so a
    // stale value flashes a white strip in dark mode. Colors mirror the page
    // root (bg-slate-50 / dark:bg-slate-950). No-op in the browser.
    (window as { nashDesktop?: { setBackgroundColor: (c: string) => void } })
      .nashDesktop?.setBackgroundColor(darkMode ? '#020617' : '#f8fafc');
  }, [darkMode]);

  // ── Authentication & Saved Games States ────────────────────────────────────
  const [dbMode, setDbMode] = useState<'local' | 'cloud'>(() => {
    return (localStorage.getItem('nash_sim_db_mode') as 'local' | 'cloud') || 'local';
  });
  const [apiBaseUrl, setApiBaseUrl] = useState<string>(() => {
    const cached = localStorage.getItem('nash_sim_api_base');
    if (cached && (cached.includes('ais-pre-') || cached.includes('243079162760') || cached.includes('988056159702') || cached.includes('194708291738'))) {
      localStorage.setItem('nash_sim_api_base', 'https://nash-equilibrium-simulator.com');
      return 'https://nash-equilibrium-simulator.com';
    }
    return cached || 'https://nash-equilibrium-simulator.com';
  });

  const getApiUrl = (path: string) => {
    if (isElectron && dbMode === 'cloud') {
      const base = apiBaseUrl.trim().replace(/\/$/, '');
      return `${base || 'https://nash-equilibrium-simulator.com'}${path}`;
    }
    return path;
  };

  const [authToken, setAuthToken] = useState<string | null>(() => {
    const key = (localStorage.getItem('nash_sim_db_mode') || 'local') === 'cloud' ? 'nash_sim_token_cloud' : 'nash_sim_token_local';
    return localStorage.getItem(key) || localStorage.getItem('nash_sim_token');
  });

  const updateAuthToken = (token: string | null) => {
    setAuthToken(token);
    const key = dbMode === 'cloud' ? 'nash_sim_token_cloud' : 'nash_sim_token_local';
    if (token) {
      localStorage.setItem(key, token);
    } else {
      localStorage.removeItem(key);
      localStorage.removeItem('nash_sim_token'); // clear legacy as well
    }
  };

  const handleSwitchDbMode = (mode: 'local' | 'cloud') => {
    setDbMode(mode);
    localStorage.setItem('nash_sim_db_mode', mode);
    const key = mode === 'cloud' ? 'nash_sim_token_cloud' : 'nash_sim_token_local';
    const savedToken = localStorage.getItem(key);
    setAuthToken(savedToken);

    // Reset basic session users or load correct data
    if (!savedToken) {
      setUser(null);
      setUserCustomGames([]);
    }
  };

  const [user, setUser] = useState<{ id: string; username: string; email: string } | null>(null);
  const [userCustomGames, setUserCustomGames] = useState<any[]>([]);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);

  // Auth Modal States
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'verify' | 'forgot' | 'reset-password'>('login');

  // Save Game Modal States
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDesc, setSaveDesc] = useState('');
  /** Option names for the save dialog: typed by the user, or prefilled from an
   *  invented scenario the user chose to keep. */
  const [saveLabels, setSaveLabels] = useState({ row1: '', row2: '', col1: '', col2: '' });
  // "Generate a game for me" inside the save modal: which equilibrium
  // structure to roll, whether a roll+AI-description round trip is in flight,
  // and the outcome line shown under the controls.
  const [generateKind, setGenerateKind] = useState<'pure' | 'mixed'>('pure');
  const [generateLoading, setGenerateLoading] = useState(false);
  const [generateNote, setGenerateNote] = useState('');

  // Edit dialog for an already-saved game. Separate state from the save dialog
  // rather than shared: the two are open in different situations and reusing
  // one set of fields would let a half-typed new game leak into an edit.
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editGameId, setEditGameId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editLabels, setEditLabels] = useState({ row1: '', row2: '', col1: '', col2: '' });
  const [editError, setEditError] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);
  /**
   * Set when the visitor jumps from the save modal to sign in. The save modal
   * has to CLOSE for that jump (both modals sit at z-50, so the later-rendered
   * save dialog would paint over the auth dialog), and this is what brings it
   * back — fields intact — the moment a token lands. Cleared whenever the auth
   * modal is dismissed without signing in.
   */
  const resumeSaveAfterAuthRef = useRef(false);
  useEffect(() => {
    // Watching the token rather than any one success handler means the save
    // modal comes back regardless of which path produced the sign-in (login,
    // or register + verification).
    if (authToken && resumeSaveAfterAuthRef.current) {
      resumeSaveAfterAuthRef.current = false;
      setSaveError('');
      setIsSaveModalOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  // Feedback Modal States
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackEmail, setFeedbackEmail] = useState('');
  const [feedbackRating, setFeedbackRating] = useState(0);
  const [feedbackHoverRating, setFeedbackHoverRating] = useState(0);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackSuccess, setFeedbackSuccess] = useState('');
  const feedbackSubmittedRef = useRef(false);
  const feedbackLastClosedRef = useRef(0);

  // Auth Inputs
  const [authUsername, setAuthUsername] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Fetch Session User and Games
  useEffect(() => {
    if (authToken) {
      fetch(getApiUrl('/api/auth/me'), {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error('Session invalid');
        })
        .then((data) => {
          setUser(data);
        })
        .catch(() => {
          updateAuthToken(null);
          setUser(null);
        });
    } else {
      setUser(null);
    }
  }, [authToken, dbMode, apiBaseUrl]);

  useEffect(() => {
    if (authToken && user) {
      fetch(getApiUrl('/api/games'), {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
        .then((res) => res.ok ? res.json() : [])
        .then((data) => {
          setUserCustomGames(data);
        })
        .catch((err) => console.error('Error fetching custom games:', err));
    } else {
      setUserCustomGames([]);
    }
  }, [authToken, user, dbMode, apiBaseUrl]);

  // ── Preset Selector State ──────────────────────────────────────────────────
  const [activePreset, setActivePreset] = useState<string>('bos');

  // ── Payoff Values State ────────────────────────────────────────────────────
  const [payoffs, setPayoffs] = useState<GamePayoffs>({
    a11: 2, b11: 1, a12: 0, b12: 0,
    a21: 0, b21: 0, a22: 1, b22: 2,
  });

  const [rawPayoffs, setRawPayoffs] = useState<Record<keyof GamePayoffs, string>>({
    a11: '2', b11: '1', a12: '0', b12: '0',
    a21: '0', b21: '0', a22: '1', b22: '2',
  });

  // Timer ref to reset empty/partial inputs to "0" after 2 seconds of inaction
  const inactiveTimersRef = useRef<Record<string, any>>({});

  useEffect(() => {
    return () => {
      if (inactiveTimersRef.current) {
        Object.values(inactiveTimersRef.current).forEach(clearTimeout);
      }
    };
  }, []);

  // ── Simulation Settings State ──────────────────────────────────────────────
  const [firstMover, setFirstMover] = useState<'A' | 'B'>('A');
  const [trackingMode, setTrackingMode] = useState<'A' | 'B' | 'both'>('A');
  const [shrinkStep, setShrinkStep] = useState<number>(0.1);
  const [shrinkStepRaw, setShrinkStepRaw] = useState<string>('0.100');
  // Convergence method: fixed domain-shrink/bisection vs opponent's-regret stepping
  const [stepMode, setStepMode] = useState<'shrink' | 'regret'>('shrink');
  const [speed, setSpeed] = useState<number>(5);

  // Initial Coordinates States
  const [x0, setX0] = useState<string>('0.217');
  const [y0, setY0] = useState<string>('0.217');

  // Custom stepper for the start-point fields (replaces the native spinners)
  const stepStartPoint = (axis: 'x' | 'y', dir: 1 | -1) => {
    const cur = parseFloat(axis === 'x' ? x0 : y0);
    const base = isNaN(cur) ? 0.217 : cur;
    const next = Math.max(0, Math.min(1, Math.round((base + dir * 0.01) * 1000) / 1000));
    (axis === 'x' ? setX0 : setY0)(next.toFixed(3));
    setInitialized(false);
  };

  // Initialize simulation running flag
  const [initialized, setInitialized] = useState<boolean>(false);

  // ── Core Simulator State ───────────────────────────────────────────────────
  const [simState, setSimState] = useState<SimState>({
    cx: 0.217,
    cy: 0.217,
    calcX: 0.217,
    calcY: 0.217,
    displayX: 0.217,
    displayY: 0.217,
    startX: 0.217,
    startY: 0.217,
    domainLo: 0,
    domainHi: 1,
    domXLo: 0,
    domXHi: 1,
    domYLo: 0,
    domYHi: 1,
    stratX: 0.217,
    stratY: 0.217,
    cycleCount: 0,
    visitedPositions: [],
    ghostVisitedPositions: [],
    discoveredMixedX: null,
    discoveredMixedY: null,
    foundAxis: null,
    running: false,
    converged: false,
    stepCount: 0,
    pathSegmentsA: [{
      xs: [0.217], ys: [0.217], zs: [r3(EA(0.217, 0.217, {
        a11: 2, b11: 1, a12: 0, b12: 0,
        a21: 0, b21: 0, a22: 1, b22: 2,
      }))], mover: 'A'
    }],
    pathSegmentsB: [{
      xs: [0.217], ys: [0.217], zs: [r3(EB(0.217, 0.217, {
        a11: 2, b11: 1, a12: 0, b12: 0,
        a21: 0, b21: 0, a22: 1, b22: 2,
      }))], mover: 'A'
    }],
    phase1PtsA: null, phase1PtsB: null,
    ghostPathSegmentsA: [],
    ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false,
    bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false,
    ghostBisectGoodLo: 0, ghostBisectGoodHi: 1, ghostBisectBadLo: 0, ghostBisectBadHi: 1,
    historyStack: []
  });

  const [logEntries, setLogEntries] = useState<string[]>([
    'Set starting point and first mover, then click Run or Step.'
  ]);

  // ── Timeline state ─────────────────────────────────────────────────────────
  const [thinHistory, setThinHistory] = useState<ThinSnapshot[]>([]);
  const thinHistoryRef = useRef<ThinSnapshot[]>([]);
  const scrubPosRef = useRef<number>(0);
  const initStateRef = useRef<SimState | null>(null);
  const simStateRef = useRef<SimState>(simState);
  useEffect(() => { simStateRef.current = simState; }, [simState]);

  // Single snapshot saved when the first NE coordinate is discovered
  const [neSnapshot, setNeSnapshot] = useState<SimState | null>(null);
  const neSnapshotRef = useRef<SimState | null>(null);

  const [jumpInput, setJumpInput] = useState<string>('');

  const logsContainerRef = useRef<HTMLDivElement>(null);
  // The expanded overlay renders a SECOND copy of the log, so it needs its own
  // ref — a single ref would be overwritten by whichever copy mounted last and
  // the auto-scroll would silently follow the wrong one.
  const logsExpandedRef = useRef<HTMLDivElement>(null);
  const [logExpanded, setLogExpanded] = useState(false);

  // Auto-scroll the logs browser to the bottom on new entries
  useEffect(() => {
    for (const container of [logsContainerRef.current, logsExpandedRef.current]) {
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [logEntries, logExpanded]);

  // Escape closes the expanded log, matching the other modals in the app.
  useEffect(() => {
    if (!logExpanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLogExpanded(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [logExpanded]);

  // ── Simulation-log placement ───────────────────────────────────────────────
  // The log lives in the right column with an explicit height so its bottom lines
  // up with the bottom of the "Simulation Coordinates & Parameters" panel in the
  // left column. We size it to the room between the report panel's bottom and the
  // params panel's bottom (minus the column gap). Once converged, the Equilibrium
  // Reached box can grow tall enough that this room collapses; when it drops below
  // the height the log needs to render, we move it to a full-width band below.
  const paramsPanelRef = useRef<HTMLDivElement>(null);
  const reportPanelRef = useRef<HTMLDivElement>(null);
  const [logBelow, setLogBelow] = useState(false);
  const [inlineLogHeight, setInlineLogHeight] = useState<number | null>(null);
  /**
   * The smallest inline log worth rendering, in REM so it tracks the responsive
   * root font-size — the same reason columnGap is derived rather than hardcoded.
   *
   * This is a real floor, not a taste threshold. The card cannot render shorter
   * than its own chrome (padding + header + gap) plus the console's minimum box,
   * and that box does not shrink to nothing: `flex-1 min-h-0` lets the console's
   * CONTENT reach zero height, but its padding and borders still occupy space —
   * 42px at a 20px root.
   *
   * The previous value was 120px, floored with Math.max so the card could be
   * assigned a height SMALLER than the panel's own minimum. At 1512x945 that
   * produced a 101px card: 50px padding + 24px header + 15px gap left about 9px
   * for a box that cannot go below 42, and the log spilled 29px out through the
   * bottom of its card. The escape hatch to the full-width band never fired,
   * because the threshold was below the height at which rendering breaks.
   */
  const MIN_LOG_REM = 9;

  useLayoutEffect(() => {
    const measure = () => {
      const params = paramsPanelRef.current;
      const report = reportPanelRef.current;
      // Side-by-side only at lg; stacked layout doesn't need bottom-alignment.
      const sideBySide = window.matchMedia('(min-width: 1024px)').matches;
      if (!params || !report || !sideBySide) {
        setLogBelow(false);
        setInlineLogHeight(null);
        return;
      }
      // The flex gap above the log (`gap-6` = 1.5rem) scales with the root
      // font-size, which is responsive (e.g. 20px on the web layout, 16px in the
      // Electron window). Derive it from the live root font-size instead of
      // hardcoding 24px, otherwise the log's bottom drifts below the params panel
      // whenever the root font-size isn't 16px.
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const columnGap = remPx * 1.5;
      const room = params.getBoundingClientRect().bottom - report.getBoundingClientRect().bottom;
      // Drop to the full-width band whenever the room is gone — regardless of
      // WHY it is gone. This used to also require simState.converged, on the
      // assumption that only the "Equilibrium Reached" box could grow the report
      // panel that far, and that box only appears after convergence. The LLM
      // explanation broke that assumption: a long explanation, or the invented
      // scenario card, makes the report tall before the simulation is ever run.
      // The old condition then could not fire, and the log was clamped to the
      // 90px floor — a squashed stub holding a single line.
      // `room` spans from the report's bottom to the params' bottom; the log's own
      // header + padding sit inside that, so the scroll area gets the remainder.
      const inlineHeight = room - columnGap;
      // Compare the height the card would ACTUALLY get against the height it
      // needs. The old test compared `room` to a constant and then clamped with
      // Math.max, which could hand the card a height it cannot render in — the
      // clamp defeated the very check it was part of.
      if (inlineHeight < remPx * MIN_LOG_REM) {
        setLogBelow(true);
        setInlineLogHeight(null);
        return;
      }
      setLogBelow(false);
      setInlineLogHeight(inlineHeight);
    };
    let cancelled = false;
    const safeMeasure = () => { if (!cancelled) measure(); };
    measure();
    const ro = new ResizeObserver(measure);
    if (paramsPanelRef.current) ro.observe(paramsPanelRef.current);
    if (reportPanelRef.current) ro.observe(reportPanelRef.current);
    window.addEventListener('resize', measure);
    // A ResizeObserver only fires on element SIZE changes, not POSITION shifts.
    // On initial open, the 3D Plotly chart renders asynchronously above the
    // report panel and pushes it down (a position change), and web fonts can
    // reflow the panels — neither re-triggers the observer, so the first measure
    // is stale until the user resizes the window (which is why full-screening
    // "fixes" the alignment). Re-measure once those settle.
    const raf = requestAnimationFrame(() => requestAnimationFrame(safeMeasure));
    const settleTimers = [setTimeout(safeMeasure, 250), setTimeout(safeMeasure, 800)];
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(safeMeasure).catch(() => {});
    }
    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(raf);
      settleTimers.forEach(clearTimeout);
    };
  }, [simState.converged, simState.cx, simState.cy, logEntries]);

  // ── Memoized Nash Equilibria ───────────────────────────────────────────────
  const allNE = useMemo<NashEquilibrium[]>(() => {
    return computeAllNE(payoffs);
  }, [payoffs]);

  const indifferenceStatus = useMemo(() => computeIndifference(payoffs), [payoffs]);

  // ── Grounded LLM explanation ───────────────────────────────────────────────
  // On demand, never reactive: payoffs change on every slider drag, so fetching
  // per change would fire a model call per keystroke. The user asks for it.
  const [llmEnvelope, setLlmEnvelope] = useState<ReportEnvelope | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  // Tracked separately: without it a failed request clears the envelope and
  // renders identically to "never asked", so the user cannot tell a dead
  // request from an untouched panel.
  const [llmError, setLlmError] = useState(false);

  // Model prose renders ONLY when the server validated it against the solver.
  // Every other outcome — refusal, truncation, rate limit, hallucinated
  // equilibrium, or no API key at all — leaves the deterministic report above as
  // the only answer shown. The fallback is the default, not the exception.
  const llmVerified =
    llmEnvelope?.source === 'llm' && llmEnvelope.validation?.ok === true && !!llmEnvelope.report;

  // Any edit to the game invalidates prose written about the previous one.
  useEffect(() => { setLlmEnvelope(null); setLlmError(false); }, [payoffs]);

  /**
   * Keep an invented scenario ON the game, labels and all.
   *
   * The four option labels are the half that makes reuse reliable.
   * `scenarioIsUsable` accepts four labels OR a description of at least twelve
   * words, and only the labels are unconditionally sufficient — a terse
   * description silently falls under the word threshold and triggers a fresh
   * invention next time, which would make the text the user just kept a dead
   * letter.
   *
   * They used to be crammed into the description as a sentence ("A chooses
   * between X and Y…") because SavedGame had nowhere to put them. It does now,
   * so they go in the label fields, where the UI can show them as the matrix
   * headers too. The sentence survives only as a fallback for a suggestion that
   * arrives with labels missing.
   */
  const useSuggestedScenario = async (sc: SuggestedScenario) => {
    const hasAllLabels = [sc.row1, sc.row2, sc.col1, sc.col2].every(Boolean);
    // Only when the labels have no field of their own to live in. With all four
    // present they are saved structurally and the description stays prose.
    const labelSentence = hasAllLabels
      ? ''
      : ` A chooses between ${sc.row1} and ${sc.row2}; B chooses between ${sc.col1} and ${sc.col2}.`;
    const description = `${sc.description ?? ''}${
      [sc.row1, sc.row2, sc.col1, sc.col2].some(Boolean) ? labelSentence : ''
    }`.trim();
    const labelFields = {
      row1Label: sc.row1,
      row2Label: sc.row2,
      col1Label: sc.col1,
      col2Label: sc.col2,
    };

    // Already a saved game of this user's: update it in place, so the scenario
    // sticks to the game they have rather than spawning a duplicate.
    const existing = userCustomGames.find((g) => g.id === activePreset);
    if (existing && authToken) {
      try {
        const res = await fetch(getApiUrl(`/api/games/${existing.id}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          // `name` was missing here, so accepting a suggestion on an ALREADY
          // SAVED game kept its story and its option labels but silently threw
          // away the title the model proposed — the game stayed "Untitled" while
          // its description talked about couriers. The save-as-new path had
          // always used sc.name, so the two routes disagreed about what
          // "keep this scenario" means. They now save the same four things.
          body: JSON.stringify({ name: sc.name, description, ...labelFields }),
        });
        const data = await res.json();
        if (res.ok) {
          setUserCustomGames((prev) => prev.map((g) => (g.id === existing.id ? data.game : g)));
          const renamed = sc.name && sc.name !== existing.name;
          setLogEntries((prev) => [
            ...prev,
            `✓ Scenario saved to "${data.game.name}"`
            + `${renamed ? ` (renamed from "${existing.name}")` : ''}`
            + `${hasAllLabels ? ' — options renamed to match.' : '.'}`,
          ]);
          return;
        }
        setLogEntries((prev) => [...prev, `✗ Couldn't save scenario: ${data.error ?? 'unknown error'}`]);
        return;
      } catch {
        setLogEntries((prev) => [...prev, "✗ Couldn't reach the server to save the scenario."]);
        return;
      }
    }

    // Preset or unsaved matrix: there is nothing to patch, so route through the
    // existing save-as-new flow with the story prefilled. Clamped to the
    // textarea/server limit: prefilling PAST maxLength locks the field (a
    // controlled textarea over its cap rejects every keystroke).
    setSaveName(sc.name ?? '');
    setSaveDesc(description.slice(0, 800));
    setSaveLabels({
      row1: sc.row1 ?? '', row2: sc.row2 ?? '',
      col1: sc.col1 ?? '', col2: sc.col2 ?? '',
    });
    setSaveError('');
    setIsSaveModalOpen(true);
  };

  /**
   * `freshScenario` is the user OPTING IN to a brand-new invented story: the
   * request simply omits the scenario, so the model writes as if the game had
   * none and returns its invention in suggestedScenario — which the UI then
   * offers, never applies. The default path always sends the scenario, and the
   * server hard-drops any suggestion the model returns despite one being
   * supplied, so an existing description is only ever replaced by choice.
   */
  const fetchLlmExplanation = async (freshScenario = false) => {
    setLlmLoading(true);
    setLlmError(false);
    try {
      const res = await fetch(getApiUrl('/api/report'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(freshScenario ? { payoffs } : { payoffs, scenario: scenarioForReport }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setLlmEnvelope((await res.json()) as ReportEnvelope);
    } catch {
      // Offline, unreachable server, or a non-2xx. The deterministic report
      // above still stands; we just say so instead of failing silently.
      setLlmEnvelope(null);
      setLlmError(true);
    } finally {
      setLlmLoading(false);
    }
  };

  const pureNEs = useMemo<NashEquilibrium[]>(() => {
    return allNE.filter((n) => n.type === 'pure');
  }, [allNE]);

  const mixedNE = useMemo<NashEquilibrium | undefined>(() => {
    return allNE.find((n) => n.type === 'mixed');
  }, [allNE]);

  // Player-committed pure equilibrium under turn priority
  const committedNE = useMemo<NashEquilibrium | null>(() => {
    if (pureNEs.length === 0) return null;
    if (pureNEs.length === 1) return pureNEs[0];

    // Multi-pure NE: Mover selects their preferred choice
    return pureNEs.reduce((best, ne) => {
      const myScore = firstMover === 'A' ? ne.eA : ne.eB;
      const bestScore = firstMover === 'A' ? best.eA : best.eB;
      return myScore > bestScore ? ne : best;
    });
  }, [pureNEs, firstMover]);

  // Expected equations text
  const eqAStr = useMemo(() => {
    return buildPolyStr(
      payoffs.a11 - payoffs.a12 - payoffs.a21 + payoffs.a22,
      payoffs.a12 - payoffs.a22,
      payoffs.a21 - payoffs.a22,
      payoffs.a22
    );
  }, [payoffs]);

  const eqBStr = useMemo(() => {
    return buildPolyStr(
      payoffs.b11 - payoffs.b12 - payoffs.b21 + payoffs.b22,
      payoffs.b12 - payoffs.b22,
      payoffs.b21 - payoffs.b22,
      payoffs.b22
    );
  }, [payoffs]);

  // Nearest calculated equilibrium details for final report
  const nearestNE = useMemo<NashEquilibrium | null>(() => {
    if (allNE.length === 0) return null;
    return allNE.reduce((best, ne) => {
      const d = Math.hypot(ne.x - simState.cx, ne.y - simState.cy);
      const dBest = Math.hypot(best.x - simState.cx, best.y - simState.cy);
      return d < dBest ? ne : best;
    }, allNE[0]);
  }, [allNE, simState.cx, simState.cy]);



  // ── Interactive Single-Step Engine ─────────────────────────────────────────
  const handleStep = (startRunningAfter = false) => {
    if (!initialized) {
      const startValX = Math.max(0, Math.min(1, parseFloat(x0) || 0.217));
      const startValY = Math.max(0, Math.min(1, parseFloat(y0) || 0.217));

      const initSegA = { xs: [startValX], ys: [startValY], zs: [r3(EA(startValX, startValY, payoffs))], mover: 'A' as const };
      const initSegB = { xs: [startValX], ys: [startValY], zs: [r3(EB(startValX, startValY, payoffs))], mover: 'A' as const };

      const initState: SimState = {
        ...simState,
        cx: startValX, cy: startValY,
        calcX: startValX, calcY: startValY,
        displayX: startValX, displayY: startValY,
        startX: startValX, startY: startValY,
        domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1, stratX: startValX, stratY: startValY, cycleCount: 0,
        visitedPositions: [], ghostVisitedPositions: [],
        discoveredMixedX: null, discoveredMixedY: null, foundAxis: null,
        running: false, converged: false, stepCount: 0,
        pathSegmentsA: [initSegA], pathSegmentsB: [initSegB],
        phase1PtsA: null, phase1PtsB: null,
        ghostPathSegmentsA: [], ghostPathSegmentsB: [],
        cyclePattern: null, bisecting: false,
        bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
        ghostCyclePattern: null, ghostBisecting: false,
        ghostBisectGoodLo: 0, ghostBisectGoodHi: 1, ghostBisectBadLo: 0, ghostBisectBadHi: 1,
        historyStack: []
      };

      setInitialized(true);
      setLogEntries([`Start (${startValX.toFixed(3)}, ${startValY.toFixed(3)}) — Player ${firstMover} moves first`]);
      initStateRef.current = initState;
      neSnapshotRef.current = null;
      setNeSnapshot(null);
      setJumpInput('');

      // Pre-compute thin snapshots — used for total step count and NE snapshot
      const { snaps, neState } = precomputeThinHistory(initState, payoffs, firstMover, shrinkStep, allNE, committedNE, stepMode);
      thinHistoryRef.current = snaps;
      setThinHistory(snaps);
      if (neState) {
        neSnapshotRef.current = neState;
        setNeSnapshot(neState);
      }

      // Do the first actual step incrementally
      const next: SimState = {
        ...initState,
        visitedPositions: [], ghostVisitedPositions: [],
        pathSegmentsA: [{ ...initSegA, xs: [...initSegA.xs], ys: [...initSegA.ys], zs: [...initSegA.zs] }],
        pathSegmentsB: [{ ...initSegB, xs: [...initSegB.xs], ys: [...initSegB.ys], zs: [...initSegB.zs] }],
        phase1PtsA: null, phase1PtsB: null,
    ghostPathSegmentsA: [], ghostPathSegmentsB: [], historyStack: []
      };
      const stepLogs: string[] = [];
      doStep(payoffs, next, firstMover, shrinkStep, allNE, committedNE,
        (msg) => stepLogs.push(msg), () => {}, () => { next.running = false; }, stepMode);
      if (!next.converged) next.running = startRunningAfter;

      simStateRef.current = next;
      setSimState(next);
      scrubPosRef.current = 1;

      if (stepLogs.length > 0) {
        setLogEntries(prev => {
          let updated = [...prev];
          if (updated.length === 1 && updated[0].startsWith('Set starting')) updated = [];
          return [...updated, ...stepLogs];
        });
      }
      return;
    }

    // Subsequent step — incremental doStep on live simState
    const prev = simStateRef.current;
    if (prev.converged || scrubPosRef.current >= thinHistoryRef.current.length - 1) return;

    const next: SimState = {
      ...prev,
      visitedPositions: [...prev.visitedPositions],
      ghostVisitedPositions: [...prev.ghostVisitedPositions],
      pathSegmentsA: prev.pathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
      pathSegmentsB: prev.pathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
      ghostPathSegmentsA: prev.ghostPathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
      ghostPathSegmentsB: prev.ghostPathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
      historyStack: []
    };
    const stepLogs: string[] = [];
    doStep(payoffs, next, firstMover, shrinkStep, allNE, committedNE,
      (msg) => stepLogs.push(msg), () => {}, () => { next.running = false; }, stepMode);

    simStateRef.current = next;
    setSimState(next);
    const nextPos = scrubPosRef.current + 1;
    scrubPosRef.current = nextPos;
    if (stepLogs.length > 0) setLogEntries(prev => [...prev, ...stepLogs]);
  };

  // Recursive play runner trigger
  useEffect(() => {
    if (!simState.running) return;

    const thin = thinHistoryRef.current;
    if (thin.length > 0 && scrubPosRef.current >= thin.length - 1) {
      setSimState(prev => ({ ...prev, running: false }));
      return;
    }

    const intervalMs = Math.max(30, Math.round(550 / speed));
    const timer = setTimeout(() => {
      const pos = scrubPosRef.current;
      const snaps = thinHistoryRef.current;
      if (snaps.length === 0 || pos >= snaps.length - 1) {
        setSimState(prev => ({ ...prev, running: false }));
        return;
      }
      const prev = simStateRef.current;
      const next: SimState = {
        ...prev,
        visitedPositions: [...prev.visitedPositions],
        ghostVisitedPositions: [...prev.ghostVisitedPositions],
        pathSegmentsA: prev.pathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        pathSegmentsB: prev.pathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        ghostPathSegmentsA: prev.ghostPathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        ghostPathSegmentsB: prev.ghostPathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        historyStack: []
      };
      const stepLogs: string[] = [];
      doStep(payoffs, next, firstMover, shrinkStep, allNE, committedNE,
        (msg) => stepLogs.push(msg), () => {}, () => { next.running = false; }, stepMode);
      simStateRef.current = next;
      setSimState(next);
      const nextPos = pos + 1;
      scrubPosRef.current = nextPos;
      if (stepLogs.length > 0) setLogEntries(prev => [...prev, ...stepLogs]);
    }, intervalMs);

    return () => clearTimeout(timer);
  }, [simState.running, simState.stepCount, speed]);

  // ── Authentication & Custom Game Handlers ──────────────────────────────────
  const handleLogout = () => {
    updateAuthToken(null);
    setUser(null);
    setUserCustomGames([]);
    setActivePreset('bos');
    setLogEntries(['Logged out successfully.']);
  };

  /**
   * Open the edit dialog for a saved game, prefilled with what it already says.
   *
   * Until now a saved game was write-once: the only way to fix a name, a
   * description or an option label was to delete the game and save it again,
   * which loses the id every explanation is keyed to.
   */
  const openEditGame = (game: any) => {
    setEditGameId(game.id);
    setEditName(game.name ?? '');
    setEditDesc(game.description ?? '');
    setEditLabels({
      row1: game.row1Label ?? '', row2: game.row2Label ?? '',
      col1: game.col1Label ?? '', col2: game.col2Label ?? '',
    });
    setEditError('');
    setIsEditModalOpen(true);
  };

  const handleEditGameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editGameId || !authToken) return;
    if (!editName.trim()) { setEditError('Please enter a game name.'); return; }
    setEditError('');
    setEditLoading(true);
    try {
      const res = await fetch(getApiUrl(`/api/games/${editGameId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({
          name: editName.trim(),
          description: editDesc.trim(),
          // Sent even when blank so CLEARING a label is possible. The server
          // ignores empty strings on create, but an edit dialog that cannot
          // remove a wrong label is only half an edit dialog — see the
          // allowClear flag on the PATCH route.
          row1Label: editLabels.row1.trim(),
          row2Label: editLabels.row2.trim(),
          col1Label: editLabels.col1.trim(),
          col2Label: editLabels.col2.trim(),
          allowClear: true,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setUserCustomGames((prev) => prev.map((g) => (g.id === editGameId ? data.game : g)));
        setIsEditModalOpen(false);
        setLogEntries((prev) => [...prev, `✓ Updated "${data.game.name}".`]);
        // The explanation was written about the OLD story, so it no longer
        // describes what the panel now says. Same reasoning as clearing it when
        // the payoffs change.
        setLlmEnvelope(null);
      } else {
        setEditError(data.error || 'Failed to update game.');
      }
    } catch {
      setEditError('Network error. Failed to update game.');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDeleteGame = async (gameId: string) => {
    if (!authToken) return;
    try {
      const res = await fetch(getApiUrl(`/api/games/${gameId}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.ok) {
        setUserCustomGames(prev => prev.filter(g => g.id !== gameId));
        if (activePreset === gameId) {
          handleLoadPreset('bos');
        }
        setLogEntries(prev => [...prev, `🗑 Deleted custom game.`]);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to delete game.');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Stale-note guard: reopening the save modal should not resurrect the
  // outcome line from a generation done minutes ago.
  useEffect(() => { if (isSaveModalOpen) setGenerateNote(''); }, [isSaveModalOpen]);

  /**
   * Roll a fresh random game with the chosen equilibrium structure, put it on
   * the board, then ask the AI to invent a scenario for it (the same
   * omit-the-scenario request "New AI scenario" uses) and prefill the save
   * form with the invention. The matrix is applied BEFORE the model call and
   * kept even if that call fails — the game is real either way; only the
   * story is best-effort.
   */
  const handleGenerateGame = async () => {
    setGenerateLoading(true);
    setGenerateNote('');
    setSaveError('');
    const g = generateRandomGame(generateKind);
    // Mirror handleLoadPreset: board payoffs, their editable string twins,
    // preset highlight off, sim rebuilt from the start point.
    setActivePreset('custom');
    setPayoffs(g);
    setRawPayoffs({
      a11: String(g.a11), b11: String(g.b11),
      a12: String(g.a12), b12: String(g.b12),
      a21: String(g.a21), b21: String(g.b21),
      a22: String(g.a22), b22: String(g.b22),
    });
    handleReset();
    const kindLabel = generateKind === 'mixed' ? 'mixed-strategy' : 'pure-strategy';
    try {
      const res = await fetch(getApiUrl('/api/report'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payoffs: g }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const env = (await res.json()) as ReportEnvelope;
      // Prefill only from a validated invention — an unvalidated story could
      // contradict the very equilibria the user just asked for.
      const sc = env.source === 'llm' && env.validation?.ok ? env.report?.suggestedScenario : null;
      if (sc) {
        setSaveName((sc.name ?? '').slice(0, 40));
        setSaveDesc((sc.description ?? '').slice(0, 800));
        setSaveLabels({
          row1: sc.row1 ?? '', row2: sc.row2 ?? '',
          col1: sc.col1 ?? '', col2: sc.col2 ?? '',
        });
        setGenerateNote(`New ${kindLabel} game on the board, scenario written by AI — edit anything below, then save.`);
      } else {
        setGenerateNote(`New ${kindLabel} game is on the board. The AI scenario isn't available right now — name and describe it yourself below.`);
      }
      setLogEntries((prev) => [...prev, `✓ Generated a random game with a ${kindLabel} equilibrium.`]);
    } catch {
      setGenerateNote(`New ${kindLabel} game is on the board. The AI scenario isn't available right now — name and describe it yourself below.`);
      setLogEntries((prev) => [...prev, `✓ Generated a random game with a ${kindLabel} equilibrium (AI description unavailable).`]);
    } finally {
      setGenerateLoading(false);
    }
  };

  const handleSaveGameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!saveName.trim()) {
      setSaveError('Please enter a game name.');
      return;
    }
    // Signed out: don't send a doomed request whose 401 surfaces as the
    // baffling "Invalid or expired session." — say what to actually do.
    // The banner renders this case as an invitation with a Sign In button,
    // not an error (see the !authToken branch at the saveError render).
    if (!authToken) {
      setSaveError('Sign in or create an account to save this game.');
      return;
    }
    setSaveError('');
    setSaveLoading(true);
    try {
      const res = await fetch(getApiUrl('/api/games'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          name: saveName.trim(),
          description: saveDesc.trim(),
          payoffs,
          row1Label: saveLabels.row1.trim(),
          row2Label: saveLabels.row2.trim(),
          col1Label: saveLabels.col1.trim(),
          col2Label: saveLabels.col2.trim()
        })
      });
      const data = await res.json();
      if (res.ok) {
        setUserCustomGames(prev => [...prev, data.game]);
        setActivePreset(data.game.id);
        setIsSaveModalOpen(false);
        setSaveName('');
        setSaveDesc('');
        setSaveLabels({ row1: '', row2: '', col1: '', col2: '' });
        setLogEntries(prev => [...prev, `✓ Saved custom game "${data.game.name}" successfully!`]);
      } else {
        setSaveError(data.error || 'Failed to save game.');
      }
    } catch (err) {
      setSaveError('Network error. Failed to save game.');
    } finally {
      setSaveLoading(false);
    }
  };

  const openFeedback = () => {
    setFeedbackError('');
    setFeedbackSuccess('');
    setIsFeedbackOpen(true);
  };

  const closeFeedback = () => {
    setIsFeedbackOpen(false);
    feedbackLastClosedRef.current = Date.now();
  };

  const handleFeedbackSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedbackText.trim()) {
      setFeedbackError('Please enter your feedback before sending.');
      return;
    }
    setFeedbackError('');
    setFeedbackSuccess('');
    setFeedbackLoading(true);
    try {
      const res = await fetch(getApiUrl('/api/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: feedbackText.trim(),
          email: feedbackEmail.trim() || undefined,
          rating: feedbackRating || undefined
        })
      });
      const data = await res.json();
      if (res.ok) {
        feedbackSubmittedRef.current = true;
        setFeedbackSuccess(data.message || 'Thank you! Your feedback has been sent.');
        setFeedbackText('');
        setFeedbackEmail('');
        setFeedbackRating(0);
        setFeedbackHoverRating(0);
      } else {
        setFeedbackError(data.error || 'Failed to send feedback.');
      }
    } catch (err) {
      setFeedbackError('Network error. Failed to send feedback. Please try again.');
    } finally {
      setFeedbackLoading(false);
    }
  };

  // Close whichever foreground modal is open on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isFeedbackOpen) closeFeedback();
      else if (isSaveModalOpen) { setIsSaveModalOpen(false); setSaveError(''); }
      else if (isAuthModalOpen) { setIsAuthModalOpen(false); setAuthError(''); setAuthSuccess(''); resumeSaveAfterAuthRef.current = false; }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isFeedbackOpen, isSaveModalOpen, isAuthModalOpen]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthSuccess('');
    setAuthLoading(true);

    if (authMode === 'login') {
      if (!authEmail || !authPassword) {
        setAuthError('Email and password are required.');
        setAuthLoading(false);
        return;
      }
      try {
        const res = await fetch(getApiUrl('/api/auth/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail, password: authPassword })
        });
        
        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = { error: `Server returned invalid response (Status ${res.status}).` };
        }

        if (res.ok) {
          updateAuthToken(data.token);
          setIsAuthModalOpen(false);
          setAuthEmail('');
          setAuthPassword('');
          setLogEntries(prev => [...prev, `✓ Welcome back, @${data.user.username}! Connected to server database.`]);
        } else if (data.needVerification) {
          setAuthMode('verify');
          setAuthSuccess('Please complete email verification first.');
        } else {
          setAuthError(data.error || 'Invalid credentials.');
        }
      } catch (err) {
        setAuthError('Connection error.');
      } finally {
        setAuthLoading(false);
      }
    } else if (authMode === 'register') {
      if (!authUsername || !authEmail || !authPassword || !authConfirmPassword) {
        setAuthError('All registration fields are required.');
        setAuthLoading(false);
        return;
      }

      // Client-side validations
      if (authPassword !== authConfirmPassword) {
        setAuthError('Passwords do not match. Please ensure both fields are identical.');
        setAuthLoading(false);
        return;
      }

      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
      if (!passwordRegex.test(authPassword)) {
        setAuthError('Password must be at least 8 characters long and contain at least one uppercase and one lowercase letter.');
        setAuthLoading(false);
        return;
      }

      try {
        const res = await fetch(getApiUrl('/api/auth/register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: authUsername, email: authEmail, password: authPassword })
        });
        
        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = { error: `Server returned invalid response (Status ${res.status}).` };
        }

        if (res.ok) {
          if (data.autoVerified) {
            setAuthMode('login');
            setAuthSuccess(data.message || 'Account created successfully inside local database! You are ready to log in.');
          } else {
            setAuthMode('verify');
            setAuthSuccess(data.message || 'Registration successful! A 6-digit confirmation code has been sent to your email address.');
            if (data.verificationCode) {
              setAuthCode(data.verificationCode);
            }
          }
        } else {
          setAuthError(data.error || 'Registration failed.');
        }
      } catch (err) {
        setAuthError('Connection error.');
      } finally {
        setAuthLoading(false);
      }
    } else if (authMode === 'verify') {
      if (!authCode) {
        setAuthError('Please enter the 6-digit confirmation code.');
        setAuthLoading(false);
        return;
      }
      try {
        const res = await fetch(getApiUrl('/api/auth/verify'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail, code: authCode })
        });

        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = { error: `Server returned invalid response (Status ${res.status}).` };
        }

        if (res.ok) {
          setAuthMode('login');
          setAuthSuccess('Account verified successfully! You can now log in.');
          setAuthCode('');
        } else {
          setAuthError(data.error || 'Incorrect confirmation code.');
        }
      } catch (err) {
        setAuthError('Connection error.');
      } finally {
        setAuthLoading(false);
      }
    } else if (authMode === 'forgot') {
      if (!authEmail) {
        setAuthError('Please enter your email address.');
        setAuthLoading(false);
        return;
      }
      try {
        const res = await fetch(getApiUrl('/api/auth/forgot-password'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail })
        });

        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = { error: `Server returned invalid response (Status ${res.status}).` };
        }

        if (res.ok) {
          setAuthMode('reset-password');
          setAuthSuccess(data.message || 'Recovery code sent! Check your email.');
          if (data.recoveryCode) setAuthCode(data.recoveryCode);
        } else {
          setAuthError(data.error || 'Failed to send recovery code.');
        }
      } catch (err) {
        setAuthError('Connection error.');
      } finally {
        setAuthLoading(false);
      }
    } else if (authMode === 'reset-password') {
      if (!authCode || !authPassword || !authConfirmPassword) {
        setAuthError('Recovery code, new password, and confirmation are all required.');
        setAuthLoading(false);
        return;
      }
      if (authPassword !== authConfirmPassword) {
        setAuthError('Passwords do not match.');
        setAuthLoading(false);
        return;
      }
      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
      if (!passwordRegex.test(authPassword)) {
        setAuthError('Password must be at least 8 characters long and contain at least one uppercase and one lowercase letter.');
        setAuthLoading(false);
        return;
      }
      try {
        const res = await fetch(getApiUrl('/api/auth/reset-password'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail, code: authCode, newPassword: authPassword })
        });

        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = { error: `Server returned invalid response (Status ${res.status}).` };
        }

        if (res.ok) {
          setAuthMode('login');
          setAuthSuccess(data.message || 'Password reset successfully! You can now log in.');
          setAuthCode('');
          setAuthPassword('');
          setAuthConfirmPassword('');
        } else {
          setAuthError(data.error || 'Failed to reset password.');
        }
      } catch (err) {
        setAuthError('Connection error.');
      } finally {
        setAuthLoading(false);
      }
    }
  };

  // ── Dynamic Presets Mapping ────────────────────────────────────────────────
  const mergedPresets = useMemo(() => {
    const merged: Record<string, PresetGame> = { ...PRESETS };
    userCustomGames.forEach((g) => {
      merged[g.id] = {
        key: g.id,
        name: g.name,
        a11: g.payoffs.a11, b11: g.payoffs.b11,
        a12: g.payoffs.a12, b12: g.payoffs.b12,
        a21: g.payoffs.a21, b21: g.payoffs.b21,
        a22: g.payoffs.a22, b22: g.payoffs.b22,
        desc: g.description || '',
        // Saved games carry option labels exactly like presets do. Merging them
        // here rather than reading them separately downstream keeps ONE source
        // of labels, so the headers above the payoff inputs and the nouns sent
        // to the explainer can never disagree about what Row 1 is called.
        row1Label: g.row1Label,
        row2Label: g.row2Label,
        col1Label: g.col1Label,
        col2Label: g.col2Label,
      };
    });
    return merged;
  }, [userCustomGames]);

  const selectedPreset = mergedPresets[activePreset];
  const selectedCustomGame = userCustomGames.find((g) => g.id === activePreset);

  // The nouns this game already has. Without them the explainer can only say
  // "Player A plays Row 1" — the Search Game has "Search L"/"Hide R" sitting
  // unused in its preset, and a saved custom game has whatever story the user
  // wrote. The server decides whether it is enough to use or whether to invent
  // one, so this just hands over everything available.
  const scenarioForReport = useMemo(() => {
    const p = mergedPresets[activePreset];
    const custom = userCustomGames.find((g) => g.id === activePreset);
    // Only if the matrix still MATCHES the selected game. Editing the payoffs
    // does not clear activePreset, so without this check a tweaked Battle of the
    // Sexes would still be explained in terms of opera and football — a story
    // those numbers no longer tell. When they diverge, send nothing and let the
    // model invent a scenario that fits what is actually on screen.
    const matches = p
      && p.a11 === payoffs.a11 && p.a12 === payoffs.a12
      && p.a21 === payoffs.a21 && p.a22 === payoffs.a22
      && p.b11 === payoffs.b11 && p.b12 === payoffs.b12
      && p.b21 === payoffs.b21 && p.b22 === payoffs.b22;
    if (!matches) return undefined;

    const sc = {
      name: custom?.name ?? p?.name,
      row1: p?.row1Label,
      row2: p?.row2Label,
      col1: p?.col1Label,
      col2: p?.col2Label,
      description: custom?.description ?? p?.desc,
    };
    return Object.values(sc).some(Boolean) ? sc : undefined;
  }, [activePreset, mergedPresets, userCustomGames, payoffs]);

  /**
   * What to CALL each option in the UI, falling back to "Row 1" / "Col 2".
   *
   * Derived from scenarioForReport rather than read fresh off the preset, so it
   * inherits that memo's matches-the-matrix gate for free: edit the payoffs away
   * from the saved game and the headers revert to generic names in the same
   * instant the explainer stops being told the story. Reading the labels
   * independently would leave "Undercut" sitting above a matrix that is no
   * longer the undercutting game.
   */
  const activeLabels = useMemo(() => ({
    row1: scenarioForReport?.row1 || 'Row 1',
    row2: scenarioForReport?.row2 || 'Row 2',
    col1: scenarioForReport?.col1 || 'Col 1',
    col2: scenarioForReport?.col2 || 'Col 2',
  }), [scenarioForReport]);

  /**
   * Terms ColorCoded highlights in AI/user text, per player. Inherits
   * scenarioForReport's matches-the-matrix gate the same way activeLabels
   * does: edit the payoffs away from the preset and the actor nouns stop
   * being colored in the same instant the story stops being sent.
   */
  const colorTerms = useMemo(() => {
    const a = ['Player A', 'Row 1', 'Row 2'];
    const b = ['Player B', 'Col 1', 'Col 2'];
    if (scenarioForReport) {
      for (const t of [scenarioForReport.row1, scenarioForReport.row2]) if (t) a.push(t);
      for (const t of [scenarioForReport.col1, scenarioForReport.col2]) if (t) b.push(t);
      const p = mergedPresets[activePreset];
      if (p?.actorA) a.push(...p.actorA);
      if (p?.actorB) b.push(...p.actorB);
    }
    return { a, b };
  }, [scenarioForReport, mergedPresets, activePreset]);


  // ── Preset loader action ───────────────────────────────────────────────────
  const handleLoadPreset = (key: string) => {
    setActivePreset(key);
    if (key !== 'custom') {
      const preset = mergedPresets[key];
      if (preset) {
        const payload: GamePayoffs = {
          a11: preset.a11 ?? 0, b11: preset.b11 ?? 0,
          a12: preset.a12 ?? 0, b12: preset.b12 ?? 0,
          a21: preset.a21 ?? 0, b21: preset.b21 ?? 0,
          a22: preset.a22 ?? 0, b22: preset.b22 ?? 0,
        };
        setPayoffs(payload);
        setRawPayoffs({
          a11: String(payload.a11), b11: String(payload.b11),
          a12: String(payload.a12), b12: String(payload.b12),
          a21: String(payload.a21), b21: String(payload.b21),
          a22: String(payload.a22), b22: String(payload.b22),
        });
      }
    }
    handleReset();
  };

  // ── Reset entire simulation ────────────────────────────────────────────────
  const handleReset = () => {
    const startValX = Math.max(0, Math.min(1, parseFloat(x0) || 0.217));
    const startValY = Math.max(0, Math.min(1, parseFloat(y0) || 0.217));

    const initSegA = { xs: [startValX], ys: [startValY], zs: [r3(EA(startValX, startValY, payoffs))], mover: 'A' as const };
    const initSegB = { xs: [startValX], ys: [startValY], zs: [r3(EB(startValX, startValY, payoffs))], mover: 'A' as const };

    setSimState({
      cx: startValX,
      cy: startValY,
      calcX: startValX,
      calcY: startValY,
      displayX: startValX,
      displayY: startValY,
      startX: startValX,
      startY: startValY,
      domainLo: 0,
      domainHi: 1,
      domXLo: 0,
      domXHi: 1,
      domYLo: 0,
      domYHi: 1,
      stratX: startValX,
      stratY: startValY,
      cycleCount: 0,
      visitedPositions: [],
      ghostVisitedPositions: [],
      discoveredMixedX: null,
      discoveredMixedY: null,
      foundAxis: null,
      running: false,
      converged: false,
      stepCount: 0,
      pathSegmentsA: [initSegA],
      pathSegmentsB: [initSegB],
      phase1PtsA: null, phase1PtsB: null,
      ghostPathSegmentsA: [],
      ghostPathSegmentsB: [],
      cyclePattern: null, bisecting: false,
      bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
      ghostCyclePattern: null, ghostBisecting: false,
      ghostBisectGoodLo: 0, ghostBisectGoodHi: 1, ghostBisectBadLo: 0, ghostBisectBadHi: 1,
      historyStack: []
    });

    setLogEntries(['Set starting point and first mover, then click Run or Step.']);
    setInitialized(false);
    // A reset is a fresh picture — restart the idle spin immediately, even if
    // earlier graph activity had halted it or its countdown was mid-flight.
    // (Covers preset loads too: handleLoadPreset funnels through here.)
    setTourSpinNonce((n) => n + 1);
    thinHistoryRef.current = [];
    scrubPosRef.current = 0;
    initStateRef.current = null;
    neSnapshotRef.current = null;
    setThinHistory([]);
    setNeSnapshot(null);
    setJumpInput('');
  };

  /**
   * Re-freeze the simulation whenever the start point is edited.
   *
   * Typing a new x0/y0 only cleared `initialized`, which tells the NEXT run to
   * start fresh but leaves the picture showing the OLD position — so the markers
   * sat at the previous start until you pressed Run or Reset, and the number in
   * the box disagreed with the dot on the surface. handleReset rebuilds the
   * frozen, ready-to-run state from the current fields, which is exactly what
   * the edit is asking for.
   *
   * Runs after the state update rather than inside the input handler, because
   * handleReset reads x0/y0 from the render it was created in and would
   * otherwise reset to the value being replaced.
   */
  useEffect(() => {
    handleReset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x0, y0]);

  // ── Play/Pause toggle ──────────────────────────────────────────────────────
  const togglePlay = () => {
    if (!initialized) {
      handleStep(true);
      return;
    }
    const snaps = thinHistoryRef.current;
    if (snaps.length > 0 && scrubPosRef.current >= snaps.length - 1) {
      setLogEntries(prev => [...prev, '✓ Equilibrium reached. Choose Reset to restart.']);
      return;
    }
    setSimState((prev: SimState) => ({ ...prev, running: !prev.running }));
  };

  /* ── Guided tour ──────────────────────────────────────────────────────────
   *
   * A general introduction to mixed equilibria, staged on a concrete game. The
   * point it exists to land is the one the picture makes and prose usually
   * cannot: a player's equilibrium mixture is computed from the OPPONENT's
   * payoffs, so it holds the opponent indifferent rather than serving the
   * player's own interest.
   *
   * Steps point at live elements by `data-tour`, and a couple of them drive the
   * app so the visitor sees the thing being described rather than reading about
   * it. Shown once, then remembered — the header keeps a control to replay it.
   */
  const [tourOpen, setTourOpen] = useState(false);
  /**
   * Points the tour is currently talking about, drawn on the surfaces with each
   * player's payoff labelled. Empty except while a step is discussing one.
   */
  const [tourPoints, setTourPoints] = useState<{ x: number; y: number; accent?: 'gold' | 'purple' }[]>([]);
  /** Trace names the current tour step wants switched off. Held in state (not
   *  rebuilt inline) so its identity is stable between steps. */
  const [tourHiddenTraces, setTourHiddenTraces] = useState<string[]>([]);
  /** Bumped on every step so the idle spin restarts; and cleared on the one step
   *  that runs the simulation, where a turning camera would fight the markers. */
  const [tourSpinNonce, setTourSpinNonce] = useState(0);
  const [tourSpinAllowed, setTourSpinAllowed] = useState(true);

  /**
   * Runs on EVERY load, including a refresh — but not for a signed-in visitor.
   *
   * Gated on `authToken` rather than on `user`, because the token is read from
   * localStorage synchronously while `user` only arrives after /api/auth/me
   * answers. Waiting for `user` would flash the tour at returning members for a
   * few hundred milliseconds on every page load.
   */
  useEffect(() => {
    if (authToken) return;
    const t = setTimeout(() => setTourOpen(true), 700);
    return () => clearTimeout(t);
  }, [authToken]);

  /**
   * Armed only by the tour's run step: stop the simulation the moment either
   * NE coordinate is discovered, so the frame the visitor is left looking at
   * is the first line going flat — and the next step's caption explains the
   * thing that just happened rather than something long past. Watching state
   * rather than hooking the playback loop means it works no matter how the
   * run was started, and clicking Next before the pause fires is fine: the
   * flat-line step stages its own picture anyway.
   */
  const [tourPauseAtFirstFind, setTourPauseAtFirstFind] = useState(false);
  useEffect(() => {
    if (!tourPauseAtFirstFind || !simState.running) return;
    // Fire on the DECLARATION itself. Regret mode now declares coordinates
    // individually, so the moment a coordinate is found is one frame: the log
    // line prints, the corridor collapses, the line snaps level, and the
    // 1st-NE-Coord snapshot points here — pausing on the same frame keeps
    // every indicator telling one story. (An older version watched the
    // rename thresholds because declaration only happened at convergence.)
    if ((simState.discoveredMixedX !== null) !== (simState.discoveredMixedY !== null)) {
      setSimState((prev) => ({ ...prev, running: false }));
    }
  }, [tourPauseAtFirstFind, simState, payoffs]);

  /* Deferred work scheduled by tour steps (delayed handleStep, delayed
   * resume). Every timer goes through tourDefer so that entering ANY step
   * first cancels whatever a previous step left in flight — otherwise a
   * leftover "start running" or "take the first step" callback fires into the
   * frame the NEW step just staged, and what the visitor sees depends on how
   * fast they clicked. Determinism rule: a step's onEnter must fully own
   * everything that happens until the next onEnter. */
  const tourTimersRef = useRef<number[]>([]);
  const tourDefer = (fn: () => void, ms: number) => {
    tourTimersRef.current.push(window.setTimeout(fn, ms));
  };
  const clearTourTimers = () => {
    tourTimersRef.current.forEach((t) => window.clearTimeout(t));
    tourTimersRef.current = [];
  };

  /* Request that the sim be staged AT the first-find frame (the step the
   * "1st NE Coord" button names — 24 on the tour's Penalty Kick run), with an
   * optional resume. Steps 14/15 must show the SAME animation no matter how
   * the visitor arrived — waited out the pause, clicked past it early, or came
   * Back from a later step — so they never reuse whatever the live run left
   * behind: they reset and rebuild through this request instead.
   *
   * It is a state+effect rather than a direct call chain because onEnter's own
   * render can still have initialized=true (entering from a live run): a
   * handleStep captured in THAT closure takes the incremental branch and
   * no-ops against the just-cleared history. The effect below runs after the
   * reset commits, with fresh closures. */
  const [tourFirstFindReq, setTourFirstFindReq] = useState<{ resume: boolean; nonce: number } | null>(null);

  const closeTour = useCallback(() => {
    tourTimersRef.current.forEach((t) => window.clearTimeout(t));
    tourTimersRef.current = [];
    setTourFirstFindReq(null);
    setTourOpen(false);
    setTourPoints([]);
    setTourHiddenTraces([]);
    setTourPauseAtFirstFind(false);
    // Restart the idle spin: the click that closed the tour may have landed
    // inside the plot and taken the wheel, and the effect's deps don't change
    // on tour exit — without a nonce bump the always-on spin would stay dead.
    setTourSpinNonce((n) => n + 1);
    setTourSpinAllowed(true);
    setSpeed(5);
    setShrinkStep(0.1);
    setShrinkStepRaw('0.100');
  }, []);

  /**
   * Rebuilt every render ON PURPOSE — do not memoise this.
   *
   * The steps close over handleReset/handleStep/handleLoadPreset, which in turn
   * read the CURRENT payoffs, start coordinates and equilibria. Wrapping the
   * array in useMemo with an empty dependency list froze the first render's
   * closures, so the "watch greedy play" step ran the simulation against the
   * preset that happened to be loaded at mount (Battle of the Sexes) instead of
   * the game the tour had just switched to. It converged to a corner in three
   * steps and the chase sat motionless — the one step whose entire job is to
   * move. Walkthrough keeps the active index in its own state and keys its
   * effects on step.target, so a fresh array each render costs nothing.
   */
  /**
   * Put the app into the state an act ASSUMES, from whatever state it is in.
   *
   * Act setup used to live only on the first step of each act, which worked
   * going forwards and broke going back: stepping back into the dilemma left
   * the mixed game's payoffs and surfaces on screen, because nothing on those
   * earlier steps ever said "be the Prisoner's Dilemma". Every step now declares
   * its act, so each one is reachable from either direction.
   *
   * The preset is only reloaded when it is actually wrong — reloading on every
   * step would throw away the discovered-equilibrium state that the indifference
   * steps deliberately stage.
   */
  const FROZEN_HIDDEN = [TRACE.startPoint, TRACE.posA, TRACE.posB];

  const enterDilemmaAct = () => {
    // A step owns everything until the next step: kill any delayed
    // handleStep/resume a previous step scheduled, or it fires into the
    // frame this step is about to stage.
    clearTourTimers();
    setTourFirstFindReq(null);
    setTourSpinNonce((n) => n + 1);
    setTourSpinAllowed(true);
    setTourPauseAtFirstFind(false);
    if (activePreset !== 'pd') {
      handleLoadPreset('pd');
    }
    // ALWAYS re-assert the start point and mover — not just on preset switch.
    // The visitor can edit them mid-tour, and a step's animation must not
    // depend on that: same entry, same run, every time. (Setting the same
    // value is a no-op; a changed value triggers the re-freeze reset, which
    // the staged steps do anyway.)
    setX0('0.217');
    setY0('0.217');
    setFirstMover('A');
    setStepMode('shrink');
    setTrackingMode('both');
    setTourPoints([]);
    setSimState((prev) => ({ ...prev, discoveredMixedX: null, discoveredMixedY: null, foundAxis: null }));
    setTourHiddenTraces(FROZEN_HIDDEN);
  };

  /**
   * The mixed act, frozen. Position markers stay hidden here for the same reason
   * they do in the dilemma: nothing is running, so a pair of dots parked at the
   * start point is furniture. The final step turns them back on, because there
   * they are the thing being watched.
   */
  const enterMixedAct = (extraHidden: string[] = []) => {
    // Same ownership rule as enterDilemmaAct: cancel anything in flight.
    clearTourTimers();
    setTourFirstFindReq(null);
    setTourSpinNonce((n) => n + 1);
    setTourSpinAllowed(true);
    setTourPauseAtFirstFind(false);
    // λ = 0.3 for the whole act — ONE value, set here and nowhere else. The
    // run, the scrub history, the jump-box replay and the 1st-NE-Coord
    // snapshot all step with the live shrinkStep, so two different λs in the
    // act put the button, the pause and the replay on different timelines
    // (measured: jump-to-47 landed on a converged frame 30 because the replay
    // contracted faster than the history it replayed).
    setShrinkStep(0.3);
    setShrinkStepRaw('0.300');
    if (activePreset !== 'penalty') {
      handleLoadPreset('penalty');
    }
    // ALWAYS re-assert start point and mover, not just on preset switch —
    // mid-tour edits must not change what a step's animation looks like.
    // Far from the equilibrium at (0.1, 0.3), so the chase has distance to
    // run and the position markers start well clear of the NE diamonds.
    setX0('0.800');
    setY0('0.200');
    setFirstMover('A');
    // Deliberately does NOT set the convergence method. It used to force
    // 'shrink' here, so every step had to re-assert 'regret' or be silently
    // flipped back — which is what happened on the last step and left the
    // visitor in Domain Shrink after the tour ended. Each step now says what it
    // needs, and the method is left alone otherwise.
    setTrackingMode('both');
    setSimState((prev) => ({ ...prev, discoveredMixedX: null, discoveredMixedY: null, foundAxis: null }));
    setTourHiddenTraces([...FROZEN_HIDDEN, ...extraHidden]);
  };

  const tourSteps: TourStep[] = [
    // ── Act 1: the familiar game ─────────────────────────────────────────────
    // Almost everyone has met the Prisoner's Dilemma, so it costs nothing to
    // explain and buys a reader who already knows the answer — and can therefore
    // check the PICTURE against what they already believe. It also sets up the
    // contrast the rest depends on: its surface never goes level, so there is
    // nothing to balance and no reason to mix.
    {
      target: 'matrix',
      title: 'Start somewhere familiar',
      body:
        'The Prisoner\'s Dilemma. Two suspects, each choosing to stay silent or confess, with no chance to '
        + 'talk first. Look at the four cells: that table is the whole game.',
      onEnter: () => {
        enterDilemmaAct();
        moveCamera(CAMERA.overview, 600);
      },
    },
    {
      target: 'plot',
      title: 'The same game, as a shape',
      body:
        'Here is that table drawn as a surface. Height is what a player expects to earn, and the two floor '
        + 'axes are how often each of them stays silent. The plot draws both players\' surfaces together, '
        + 'so you can see what one choice does to each of them.',
      onEnter: () => {
        enterDilemmaAct();
        moveCamera(CAMERA.overview, 800);
      },
    },
    {
      // Sits between the surface being introduced and the corners being toured,
      // because "where does that shape come from" is the question a reader asks
      // the moment they see it, and every later step leans on the answer.
      target: 'ep',
      title: 'Where the shape comes from',
      body:
        'Each player\'s height is one formula. Take every cell of the table, multiply its payoff by how likely '
        + 'that cell is (x times y for the top-left, and so on for the other three), and add the four up. '
        + 'That single expression in x and y is what gets plotted. It is why the surface is straight along '
        + 'each axis on its own and only bends where the two probabilities multiply together.',
      onEnter: () => {
        enterDilemmaAct();
        moveCamera(CAMERA.overview, 700);
      },
    },
    {
      target: 'plot',
      title: 'The corner where they cooperate',
      body:
        'Swing round to the corner where both stay silent. Both surfaces sit high here, three each, the best '
        + 'combined outcome in the game. Remember this corner.',
      onEnter: () => {
        enterDilemmaAct();
        setTourPoints([{ x: 1, y: 1 }]);
        moveCamera(CAMERA.cornerRow1Col1, 1100);
      },
    },
    {
      target: 'plot',
      title: 'And the corner they actually reach',
      body:
        'Now the opposite corner, where both confess. Both surfaces are lower, one each. This is the '
        + 'equilibrium: the only cell where neither player can improve by changing their mind alone.',
      onEnter: () => {
        enterDilemmaAct();
        setTourPoints([{ x: 0, y: 0 }]);
        moveCamera(CAMERA.cornerRow2Col2, 1300);
      },
    },
    {
      // Targets the PLOT, not the equilibrium readout. The claim here is a
      // comparison between two heights, and pointing at the text panel scrolls
      // the surfaces off screen — leaving the labelled corners, which are the
      // entire evidence for the sentence, invisible.
      target: 'plot',
      title: 'The stable corner is the worse corner',
      body:
        'Both players would rather be at the first corner, and neither can get there. An equilibrium is just '
        + 'the cell where nobody can gain by moving alone. Nothing about that makes it a good outcome, and '
        + 'here it is the worse one.',
      onEnter: () => {
        enterDilemmaAct();
        setTourPoints([{ x: 1, y: 1 }, { x: 0, y: 0 }]);
        moveCamera(CAMERA.overview, 900);
      },
    },

    // ── Act 2: no dominant move, so the surface must go level ────────────────
    {
      target: 'matrix',
      title: 'Now take the dominance away',
      body:
        'A penalty kick: the kicker picks a side to shoot, the goalie picks a side to dive, at the same '
        + 'instant. This time neither side has a move that is always best, and what helps one hurts the '
        + 'other, so no corner can hold still.',
      onEnter: () => {
        enterMixedAct();
        // Shrink here only because the regret renderer would draw strategy lines,
        // and these two steps are introducing the surface, not the method.
        setStepMode('shrink');
        setTourPoints([]);
        moveCamera(CAMERA.mixedOpen, 900);
      },
    },
    {
      target: 'plot',
      title: 'A surface with a twist in it',
      body:
        'Same kind of picture, different shape. This one runs straight along each axis but bends through a '
        + 'single twist. The twist is where the two players\' choices interact.',
      onEnter: () => {
        enterMixedAct();
        // Shrink here only because the regret renderer would draw strategy lines,
        // and these two steps are introducing the surface, not the method.
        setStepMode('shrink');
        setTourPoints([]);
        moveCamera(CAMERA.mixedOpen, 900);
      },
    },
    // ── Act 3: regret — teach the lean BEFORE naming it ──────────────────────
    // The order is deliberate: show one leaning line, then both, then give the
    // lean its name at the method toggle, run the search and watch the leans
    // flatten, and only then present flatness as indifference. An earlier cut
    // presented the flat lines first and mentioned "the lean" afterwards — a
    // reference to something the reader had never been shown.
    {
      target: 'plot',
      title: 'A leaning line is an instruction',
      body:
        'Take an example point, away from any equilibrium: both players at an even half-half mix, the marked '
        + 'spot. This line is A\'s payoff as A alone varies their mix, with B held still there. It leans, '
        + 'and a leaning line is an instruction: slide to its high end. The high end is always a corner, '
        + 'all-in on one option, never a blend. As long as the line leans, A wants a corner.',
      onEnter: () => {
        // Regret mode with NOTHING solved: the strategy lines render at the
        // domain midpoints, tilted. B's line is hidden so the first lean is
        // read on its own; running:false because the visitor may arrive here
        // by stepping Back from the run.
        enterMixedAct([TRACE.strategyB]);
        setStepMode('regret');
        // Full reset, not just running:false — arriving here by stepping Back
        // from the run otherwise keeps its path stripes and corridor residue
        // on screen, burying the one line this step exists to show.
        handleReset();
        // The example point the caption talks through, marked with its payoffs
        // exactly like the dilemma corners were. After a reset the strategy
        // lines are drawn at the domain midpoints, so (0.5, 0.5) is not a
        // stand-in for the example — it IS the point the lines pass through.
        setTourPoints([{ x: 0.5, y: 0.5 }]);
        moveCamera(CAMERA.edgeOn, 1100);
      },
    },
    {
      target: 'plot',
      title: 'The other line leans too',
      body:
        'Through the same marked point, B\'s line does the same job along B\'s own axis. It also leans, so B '
        + 'is pulled to a corner at its own high end. Two leaning lines through one point, two players each '
        + 'pulled away from the middle. Nothing in this picture, so far, would ever produce a mixture.',
      onEnter: () => {
        enterMixedAct();
        setStepMode('regret');
        handleReset();
        setTourPoints([{ x: 0.5, y: 0.5 }]);
        moveCamera(CAMERA.mixedOpen, 1100);
      },
    },
    {
      target: 'method',
      title: 'The lean has a name',
      body:
        'That lean is Opponent Regret: how much better a player could still do against what the other one is '
        + 'actually playing. The steeper the line, the more is left on the table. This method watches the lean '
        + 'itself, and moves the players step by step so that it shrinks.',
      onEnter: () => {
        enterMixedAct();
        setStepMode('regret');
        handleReset();
        setTourPoints([]);
      },
    },
    {
      target: 'coords',
      title: 'Each player gets a shrinking corridor',
      body:
        'Every player also carries a boundary: a range of mixes still worth considering. As regret falls, '
        + 'both corridors contract from both sides at once. But they do not finish together.',
      onEnter: () => {
        enterMixedAct();
        setStepMode('regret');
        handleReset();
        setTourPoints([]);
        moveCamera(CAMERA.topDown, 900);
      },
    },
    {
      // Points at the GRAPH: the run starts itself, so the thing to look at is
      // the lines losing their lean, not the button that started it.
      target: 'plot',
      title: 'Watch the leans flatten',
      body:
        'The search is running. Self-interest alone always points at a corner (the best reply to any opponent '
        + 'mix is a pure strategy, never a blend), so it can never name an interior point. The contracting '
        + 'boundaries carry the search inward instead: both lines flatten together, and the one that began '
        + 'nearer level reaches indifference first. The moment it does, the run pauses.',
      onEnter: () => {
        enterMixedAct();
        setStepMode('regret');
        setTourPoints([]);
        setTourPauseAtFirstFind(true);
        // 1x so the few-dozen-step run (λ = 0.3, set by enterMixedAct) plays
        // at a readable pace. Restored on tour close.
        setSpeed(1);
        // The markers come back ON here: this is the only step where anything is
        // moving, and they are what the visitor is being asked to watch — and
        // the idle spin stays off for the same reason, including after the run
        // converges, so the result can be read against a still camera.
        setTourHiddenTraces([]);
        setTourSpinAllowed(false);
        // Side-on rather than top-down: the flattening the caption promises is
        // a change in TILT, which a straight-down camera cannot show.
        moveCamera(CAMERA.mixedOpen, 800);
        handleReset();
        tourDefer(() => handleStep(true), 350);
      },
    },
    {
      target: 'plot',
      title: 'The first lean disappears',
      body:
        'The run paused the moment this happened: one line has gone completely flat, and its coordinate is '
        + 'found. No lean means no regret left; every mix now pays that player exactly the same. That is '
        + 'indifference, found rather than declared. The other line still leans, its corridor is still '
        + 'closing, and the search carries on there.',
      onEnter: () => {
        // Unconditional: ALWAYS rebuild the run and jump to the first-find
        // frame — the exact step the pause on the previous step lands on
        // (the run is deterministic, so this IS that frame, contracted
        // corridors and drawn paths included, not a staged lookalike).
        // Earlier versions kept the live frame when the pause had fired and
        // staged an approximation otherwise, which meant what this step
        // showed depended on how fast the visitor clicked.
        enterMixedAct();
        setStepMode('regret');
        setTourPoints([]);
        setSpeed(1);
        handleReset();
        setTourFirstFindReq({ resume: false, nonce: Date.now() });
        moveCamera(CAMERA.edgeOn, 1100);
      },
    },
    {
      target: 'plot',
      title: 'Now watch the second coordinate',
      body:
        'The first coordinate is locked, and its corridor is closed for good. The run resumes: the other '
        + 'corridor keeps contracting, its line eases the rest of the way down, and the moment it lands '
        + 'flat the second coordinate is discovered too. The equilibrium is now fully found.',
      onEnter: () => {
        // Start EXACTLY at the first-find frame — the same step the
        // "1st NE Coord" button names (24 on this game) — then resume and
        // play to the second discovery. Unconditional rebuild, same as the
        // previous step: earlier versions reused the live run's snapshot
        // when one existed and ran afresh from step 0 otherwise, so clicking
        // past the run early produced a different animation than waiting.
        enterMixedAct();
        setStepMode('regret');
        setTourPoints([]);
        setTourHiddenTraces([]);
        setTourSpinAllowed(false);
        setSpeed(1);
        handleReset();
        setTourFirstFindReq({ resume: true, nonce: Date.now() });
      },
    },
    {
      target: 'plot',
      title: 'Both flat: the crossing is the equilibrium',
      body:
        'Now the second coordinate locks and the other line lies flat as well. Follow the two flat lines to '
        + 'where they cross in the xy-plane below. That crossing is the mixed Nash equilibrium: no lean '
        + 'left for anyone, so nobody can gain by moving alone.',
      onEnter: () => {
        enterMixedAct();
        setStepMode('regret');
        handleReset();
        if (mixedNE) {
          setSimState((prev) => ({
            ...prev,
            running: false,
            converged: false,
            discoveredMixedX: mixedNE.x,
            discoveredMixedY: mixedNE.y,
            foundAxis: 'y',
          }));
          setTourPoints([{ x: mixedNE.x, y: mixedNE.y, accent: 'purple' }]);
        }
        moveCamera(CAMERA.interior, 1200);
      },
    },
    {
      target: 'ne',
      title: 'The coordinates come out crossed',
      body:
        'The probability that flattens your surface is built from your opponent\'s payoffs. Your own numbers '
        + 'never enter your own equilibrium mix.',
    },
    {
      target: 'ne',
      title: 'Your mixing is for them',
      body:
        'So equilibrium mixing does nothing for you. It is a service you perform for your opponent, holding '
        + 'them perfectly balanced, while their mixing does the same for you.',
      onEnter: () => {
        enterMixedAct();
        setStepMode('regret');
        handleReset();
        if (mixedNE) {
          setSimState((prev) => ({
            ...prev,
            running: false,
            converged: false,
            discoveredMixedX: mixedNE.x,
            discoveredMixedY: mixedNE.y,
            foundAxis: 'y',
          }));
          setTourPoints([{ x: mixedNE.x, y: mixedNE.y, accent: 'purple' }]);
        }
        moveCamera(CAMERA.interior, 700);
      },
    },
    {
      target: 'matrix',
      title: 'Now change the game',
      body:
        'The equilibrium sits exactly where each player\'s own incentive goes quiet. Edit any payoff and watch '
        + 'the flat spot move somewhere new.',
      onEnter: () => {
        enterMixedAct();
        setStepMode('regret');
        setTourHiddenTraces([]);
        setTourPoints([]);
        moveCamera(CAMERA.overview, 900);
      },
    },
  ];

  // ── Trajectory Backstep ───────────────────────────────────────────────────
  const handleBackstep = () => {
    if (simState.running || !initStateRef.current || simState.stepCount <= 0) return;
    const targetStep = simState.stepCount - 1;
    const replayed = replayToStep(initStateRef.current, targetStep, payoffs, firstMover, shrinkStep, allNE, committedNE, stepMode);
    simStateRef.current = replayed;
    setSimState(replayed);
    scrubPosRef.current = targetStep;
    setLogEntries(prev => [...prev, `⏮ Stepped back to step ${targetStep}`]);
  };

  // ── Jump to NE snapshot ────────────────────────────────────────────────────
  const handleJumpToNE = () => {
    const snap = neSnapshotRef.current;
    if (!snap) return;
    const paused = { ...snap, running: false };
    simStateRef.current = paused;
    setSimState(paused);
    scrubPosRef.current = paused.stepCount;
    setJumpInput(String(paused.stepCount));
    setLogEntries(prev => [...prev, `→ Jumped to step ${paused.stepCount} (first NE coordinate found)`]);
  };

  // Fulfil a pending first-find staging request (see the comment at the
  // declaration). Waits for initialized=false so it runs strictly after the
  // requesting step's handleReset — and after the x0/y0 re-freeze effect,
  // which is declared earlier and therefore runs first in the same commit.
  useEffect(() => {
    if (!tourFirstFindReq || initialized) return;
    const { resume } = tourFirstFindReq;
    setTourFirstFindReq(null);
    handleStep(false);   // initialize: precomputes the run + the NE snapshot
    handleJumpToNE();    // land on the first-find frame, paths and all
    if (resume) {
      // A beat on the found frame before it moves, so the viewer can see
      // where the playback picks up from.
      tourDefer(() => setSimState((prev) => ({ ...prev, running: true })), 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourFirstFindReq, initialized]);

  // ── Step-input Jump ────────────────────────────────────────────────────────
  const handleJump = () => {
    if (!initStateRef.current || thinHistoryRef.current.length === 0) return;
    const parsed = parseInt(jumpInput, 10);
    if (isNaN(parsed)) return;
    const clamped = Math.max(0, Math.min(thinHistoryRef.current.length - 1, parsed));
    const replayed = replayToStep(initStateRef.current, clamped, payoffs, firstMover, shrinkStep, allNE, committedNE, stepMode);
    simStateRef.current = replayed;
    setSimState(replayed);
    scrubPosRef.current = clamped;
    setJumpInput(String(clamped));
    setLogEntries(prev => [...prev, `→ Jumped to step ${clamped} of ${thinHistoryRef.current.length - 1}`]);
  };

  // ── Matrix Editor Input Clamps ─────────────────────────────────────────────
  const updatePayoffField = (field: keyof GamePayoffs, valStr: string) => {
    setActivePreset('custom');
    setRawPayoffs((prev) => ({ ...prev, [field]: valStr }));

    let v = parseFloat(valStr);
    if (isNaN(v)) v = 0;
    const clamped = Math.max(-100, Math.min(100, r3(v)));
    setPayoffs((prev: GamePayoffs) => ({ ...prev, [field]: clamped }));
    setInitialized(false);

    // Cancel any existing inactivity timer for this field
    if (inactiveTimersRef.current[field]) {
      clearTimeout(inactiveTimersRef.current[field]);
    }

    // Set interactive timeout: if user clears the input completely or leaves just a minus/plus sign,
    // reset to "0" after 2 seconds of inaction
    if (valStr === '' || valStr === '-' || valStr === '+' || valStr === '.') {
      inactiveTimersRef.current[field] = setTimeout(() => {
        setRawPayoffs((prev) => {
          if (prev[field] === '' || prev[field] === '-' || prev[field] === '+' || prev[field] === '.') {
            return { ...prev, [field]: '0' };
          }
          return prev;
        });
        setPayoffs((prev: GamePayoffs) => {
          if (prev[field] === 0) {
            return { ...prev, [field]: 0 };
          }
          return prev;
        });
      }, 2000); // 2 seconds of inaction
    }
  };

  const handlePayoffBlur = (field: keyof GamePayoffs) => {
    // Cancel the inactivity timer immediately when blurred
    if (inactiveTimersRef.current[field]) {
      clearTimeout(inactiveTimersRef.current[field]);
    }

    let v = parseFloat(rawPayoffs[field]);
    if (isNaN(v)) v = 0;
    const clamped = Math.max(-100, Math.min(100, r3(v)));
    setPayoffs((prev: GamePayoffs) => ({ ...prev, [field]: clamped }));
    setRawPayoffs((prev) => ({ ...prev, [field]: String(clamped) }));
  };

  // ── Simulation log panel ──────────────────────────────────────────────────
  // Lives in the right column with an explicit height (see the placement effect)
  // so its bottom lines up with the params panel's bottom; when the converged
  // report leaves no room, it drops to a full-width band beneath both columns.
  const useFlexLog = !logBelow && inlineLogHeight != null;

  // Rendered once and used by BOTH the inline panel and the expanded overlay, so
  // the two can never drift apart in colouring or content.
  const logLines = logEntries.map((line, idx) => {
    let colClass = 'text-slate-600 dark:text-slate-300';
    if (line.includes('✓')) {
      colClass = 'text-emerald-600 dark:text-emerald-400 font-semibold';
    } else if (line.includes('↺')) {
      if (line.includes('Ghost cycle')) {
        if (line.includes('(A)')) {
          colClass = 'text-rose-500 dark:text-rose-300 font-medium';
        } else if (line.includes('(B)')) {
          colClass = 'text-player-b-600 dark:text-player-b-300 font-medium';
        } else {
          colClass = 'text-amber-600 dark:text-amber-300 font-medium';
        }
      } else {
        colClass = 'text-amber-600 dark:text-amber-400 font-semibold';
      }
    } else if (line.includes('━━') || line.includes('Start')) {
      colClass = 'text-accent-600 dark:text-accent-400 font-semibold';
    } else if (line.includes('(A)')) {
      colClass = 'text-player-a-600 dark:text-player-a-400 font-semibold';
    } else if (line.includes('(B)')) {
      colClass = 'text-player-b-600 dark:text-player-b-400 font-semibold';
    }
    return (
      <p key={idx} className={colClass}>
        {line}
      </p>
    );
  });

  const simulationLogPanel = (
    <div
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-2xl flex flex-col gap-3 text-slate-700 dark:text-slate-200 shadow-sm"
      style={useFlexLog ? { height: inlineLogHeight! } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold flex items-center gap-1.5">
          <Terminal className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
          Simulation Log
        </span>
        <button
          type="button"
          onClick={() => setLogExpanded(true)}
          title="Expand log"
          aria-label="Expand simulation log"
          className="shrink-0 p-1.5 -m-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:focus:ring-emerald-900"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div ref={logsContainerRef} className={`w-full overflow-y-auto bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-600 dark:text-slate-300 space-y-1 block leading-relaxed select-text ${useFlexLog ? 'flex-1 min-h-0' : (simState.converged ? 'h-44' : 'h-80')}`}>
        {logLines}
      </div>
    </div>
  );

  // ── Expanded log overlay ───────────────────────────────────────────────────
  // Fills most of the viewport over a blurred backdrop. The backdrop closes on
  // click; the dialog stops propagation so selecting log text does not dismiss
  // it — the whole point of expanding is to read and copy from it.
  const expandedLogOverlay = logExpanded && (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 bg-slate-900/60 backdrop-blur-md"
      onClick={() => setLogExpanded(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Simulation log"
    >
      <div
        className="w-full max-w-5xl h-[90vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl flex flex-col gap-3 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold flex items-center gap-1.5">
            <Terminal className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
            Simulation Log
            <span className="normal-case tracking-normal text-slate-400 dark:text-slate-500 font-normal">
              — {logEntries.length} {logEntries.length === 1 ? 'line' : 'lines'}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setLogExpanded(false)}
            title="Collapse log (Esc)"
            aria-label="Collapse simulation log"
            className="shrink-0 p-1.5 -m-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:focus:ring-emerald-900"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>
        <div
          ref={logsExpandedRef}
          className="flex-1 min-h-0 w-full overflow-y-auto bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-5 font-mono text-xs sm:text-sm text-slate-600 dark:text-slate-300 space-y-1 block leading-relaxed select-text"
        >
          {logLines}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col antialiased">
      {/* ── Heading Banner ── */}
      <header
        className={`bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30 shadow-subtle${tourOpen ? ' [@media(max-height:560px)]:!static' : ''}`}
        style={isElectron ? { WebkitAppRegion: 'drag' } as React.CSSProperties : undefined}
      >
        {/* Vertical space for macOS traffic-light buttons — title sits below them, no horizontal offset needed */}
        {isElectronMac && !isFullscreen && <div className="h-9" />}
        <div className={`w-full flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 ${isElectronMac ? 'px-6 py-2' : 'px-4 py-3 sm:px-6 sm:py-4'}`}
          style={isElectron ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : undefined}
        >
          <div>
            <div className="flex items-center gap-2.5">
              <span
                className="p-2 bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 rounded-xl cursor-pointer select-none"
                onClick={e => { if (e.detail === 3) setIsAdminOpen(true); }}
                title=""
              >
                <Compass className="w-5.5 h-5.5" />
              </span>
              <h1 className="text-lg md:text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                Nash Equilibrium Simulator
              </h1>
            </div>
            {/* Tagline is hidden on phones — the header would otherwise dominate the viewport */}
            <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Best-response dynamics on 3D expected-payoff surfaces — watch the search corridor contract onto the Nash equilibrium.
              {' '}
              <button
                type="button"
                onClick={() => setTourOpen(true)}
                className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
              >
                Take the tour
              </button>
            </p>
          </div>
          {isTouchDevice ? (
            /* ── TOUCH (phones + tablets): single compact row ── */
            <div className="flex items-center justify-end gap-2 w-full flex-wrap">
              {!isElectron && (
                <button
                  aria-label="Get the desktop app"
                  onClick={() => setIsDownloadModalOpen(true)}
                  className="inline-flex items-center gap-1.5 bg-accent-50 hover:bg-slate-100 text-accent-700 dark:bg-accent-950/45 dark:hover:bg-accent-900/40 dark:text-accent-400 border border-accent-100 dark:border-accent-900 font-bold text-xs p-2 sm:px-3 sm:py-1.5 rounded-xl transition-all shadow-xs cursor-pointer"
                >
                  <Download className="w-4 h-4 sm:w-3.5 sm:h-3.5" /><span className="hidden sm:inline">Get Desktop App</span>
                </button>
              )}
              <button
                aria-label="Toggle dark mode" onClick={() => setDarkMode(!darkMode)}
                className="p-2 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-accent-500" />}
              </button>
              <button
                aria-label="Open workspace menu" onClick={() => setIsMenuOpen(true)}
                className="p-2 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                <Menu className="w-4 h-4" />
              </button>
              {user ? (
                <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 pl-2.5 pr-1 py-1 rounded-xl">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate max-w-[100px]" title={user.email}>@{user.username}</span>
                  <button onClick={handleLogout} className="text-xs font-medium text-slate-400 hover:text-danger-500 hover:bg-danger-50/50 dark:hover:bg-danger-950/50 px-2.5 py-1 rounded-lg transition-colors cursor-pointer">Log out</button>
                </div>
              ) : (
                <button
                  onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthMode('login'); setIsAuthModalOpen(true); }}
                  className="inline-flex items-center gap-1.5 bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs px-3.5 py-1.5 rounded-xl transition-all shadow-xs cursor-pointer"
                >
                  <LogIn className="w-3.5 h-3.5" /> Sign In<span className="hidden sm:inline">&nbsp;/ Sign Up</span>
                </button>
              )}
            </div>
          ) : (
            /* ── NON-TOUCH (desktops/laptops): original flex row ── */
            <div className="flex items-center flex-wrap gap-2.5">
              {!isElectron && (
                <button
                  onClick={() => setIsDownloadModalOpen(true)}
                  className="inline-flex items-center gap-1.5 bg-accent-50 hover:bg-slate-100 text-accent-700 dark:bg-accent-950/45 dark:hover:bg-accent-900/40 dark:text-accent-400 border border-accent-100 dark:border-accent-900 font-bold text-xs px-3 py-1.5 rounded-xl transition-all shadow-xs cursor-pointer"
                  title="Download macOS Desktop App"
                >
                  <Download className="w-3.5 h-3.5" /><span>Get Desktop App</span>
                </button>
              )}
              <button
                aria-label="Toggle dark mode" onClick={() => setDarkMode(!darkMode)}
                className="p-2 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
              >
                {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-accent-500" />}
              </button>
              <button
                id="menu-toggle-btn"
                aria-label="Open workspace menu" onClick={() => setIsMenuOpen(true)}
                className="p-2 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer animate-pulse-once"
                title="Open Workspace Center"
              >
                <Menu className="w-4 h-4" />
              </button>
              {user ? (
                <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 pl-2.5 pr-1 py-1 rounded-xl">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate max-w-[120px]" title={user.email}>@{user.username}</span>
                  <button onClick={handleLogout} className="text-xs font-medium text-slate-400 dark:text-slate-400 hover:text-danger-500 hover:bg-danger-50/50 dark:hover:bg-danger-950/50 px-2.5 py-1 rounded-lg transition-colors cursor-pointer">Log out</button>
                </div>
              ) : (
                <button
                  onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthMode('login'); setIsAuthModalOpen(true); }}
                  className="inline-flex items-center gap-1.5 bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs px-3.5 py-1.5 rounded-xl transition-all shadow-xs cursor-pointer"
                >
                  <LogIn className="w-3.5 h-3.5" /> Sign In / Sign Up
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {/* ── Main Layout Body ── */}
      <main className="flex-1 max-w-[100rem] w-full mx-auto px-4 lg:px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* ── Left Sidebar Settings Panel (5 cols) ── */}
        <div className="lg:col-span-5 flex flex-col gap-6">

          {/* Preset Buttons Block */}
          <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-4">
            <div className="flex items-center gap-2 text-slate-800 dark:text-slate-200 font-semibold text-xs uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pb-2">
              <BookOpen className="w-4 h-4 text-rose-500" />
              Standard Scenarios
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {(['search', 'bos', 'pd', 'cnr', 'spy', 'penalty'] as const).map((key) => {
                const isSelected = activePreset === key;
                return (
                  <button
                    key={key}
                    onClick={() => handleLoadPreset(key)}
                    className={`py-2 px-3 text-xs font-semibold rounded-xl border transition-all text-center cursor-pointer ${isSelected
                        ? 'bg-accent-600 text-white border-accent-600 shadow-xs'
                        : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white'
                      }`}
                  >
                    {PRESETS[key].name}
                  </button>
                );
              })}
            </div>

            {/* User Custom Saved Games Segment */}
            <div className="flex items-center justify-between text-slate-800 dark:text-slate-200 font-semibold text-xs uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pt-1.5 pb-2">
              <div className="flex items-center gap-2">
                <Award className="w-4 h-4 text-accent-500" />
                Custom Game Presets
              </div>
              {user && (
                <button
                  onClick={() => {
                    setSaveError('');
                    // Prefill from whatever the current game already calls its
                    // options, so saving a copy of a named game keeps the names.
                    // Read from scenarioForReport, not activeLabels, because the
                    // latter substitutes the literal "Row 1" and prefilling that
                    // would save a placeholder as if it were a real label.
                    setSaveLabels({
                      row1: scenarioForReport?.row1 ?? '', row2: scenarioForReport?.row2 ?? '',
                      col1: scenarioForReport?.col1 ?? '', col2: scenarioForReport?.col2 ?? '',
                    });
                    setIsSaveModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-bold text-accent-600 dark:text-accent-400 bg-accent-50 dark:bg-accent-950/40 hover:bg-accent-100 dark:hover:bg-accent-900/50 border border-accent-200/50 dark:border-accent-800/60 px-2.5 py-1 rounded-lg transition-all cursor-pointer"
                >
                  <Plus className="w-3 h-3" /> Save Preset
                </button>
              )}
            </div>

            {!user ? (
              <div className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/30 border border-slate-200/60 dark:border-slate-800/80 rounded-xl p-3 text-center">
                <span>Want to name and save custom presets? </span>
                <button
                  onClick={() => {
                    setAuthError('');
                    setAuthSuccess('');
                    setAuthMode('login');
                    setIsAuthModalOpen(true);
                  }}
                  className="font-bold text-accent-600 dark:text-accent-400 hover:underline cursor-pointer"
                >
                  Sign in here
                </button>
              </div>
            ) : userCustomGames.length === 0 ? (
              <div className="text-xs text-slate-400 dark:text-slate-500 bg-slate-50/70 dark:bg-slate-950/20 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl p-4 text-center">
                No saved custom games. Adapt payoffs and click <strong className="text-accent-600 dark:text-accent-400">Save Preset</strong> to persist your first game!
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[160px] overflow-y-auto pr-1">
                {userCustomGames.map((game) => {
                  const isSelected = activePreset === game.id;
                  return (
                    <div
                      key={game.id}
                      className={`group flex items-center justify-between p-2 pl-3 rounded-xl border transition-all ${isSelected
                          ? 'bg-accent-500 border-accent-500 text-white shadow-xs'
                          : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:bg-slate-100/80 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
                        }`}
                    >
                      <button
                        onClick={() => handleLoadPreset(game.id)}
                        className="flex-1 text-left text-xs font-semibold truncate cursor-pointer mr-1"
                        title={`${game.name} - ${game.description}`}
                      >
                        {game.name}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditGame(game);
                        }}
                        className={`p-1 rounded-md transition-colors cursor-pointer ${isSelected
                            ? 'text-accent-100 hover:text-white hover:bg-accent-600'
                            : 'text-slate-400 hover:text-accent-600 dark:text-slate-500 dark:hover:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-950/40'
                          }`}
                        title="Edit name, description and option names"
                        aria-label={`Edit ${game.name}`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteGame(game.id);
                        }}
                        className={`p-1 rounded-md transition-colors cursor-pointer ${isSelected
                            ? 'text-accent-100 hover:text-white hover:bg-accent-600'
                            : 'text-slate-400 hover:text-danger-500 dark:text-slate-500 dark:hover:text-danger-400 hover:bg-danger-50 dark:hover:bg-danger-950/40'
                          }`}
                        title="Delete this saved game"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Selected Preset Narrative Card */}
            {selectedPreset?.desc && (
              selectedCustomGame ? (
                <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-900/45 rounded-xl p-3">
                  <strong>Custom - {selectedCustomGame.name}:</strong>{' '}
                  <ColorCoded text={selectedPreset.desc} aTerms={colorTerms.a} bTerms={colorTerms.b} />
                </div>
              ) : (
                <div
                  className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-900/45 rounded-xl p-3"
                  dangerouslySetInnerHTML={{ __html: selectedPreset.desc }}
                />
              )
            )}
          </div>

          {/* Payoff Matrix Editor Block */}
          <div className="bg-slate-50 dark:bg-slate-950/40 p-5 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
              <div className="flex items-center gap-2 text-slate-800 dark:text-slate-200 font-semibold text-sm">
                <Sliders className="w-4 h-4 text-player-b-500" />
                <span>
                  Payoff Matrix — (
                  <span className="text-player-a-500 font-semibold font-mono">A</span>,{' '}
                  <span className="text-player-b-600 dark:text-player-b-400 font-semibold font-mono">B</span>)
                </span>
              </div>
              <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">Range: [-100, 100]</span>
            </div>

            <div data-tour="matrix" className="grid grid-cols-[auto_1fr_1fr] gap-3 text-center items-center">
              <div className="text-xs font-bold text-slate-400 dark:text-slate-500 pr-2 text-left">Tactics</div>
              <div className="text-xs font-bold text-player-b-600 dark:text-player-b-400 break-words" title={activeLabels.col1}>B: {activeLabels.col1}</div>
              <div className="text-xs font-bold text-player-b-600 dark:text-player-b-400 break-words" title={activeLabels.col2}>B: {activeLabels.col2}</div>

              {/* Row 1 inputs */}
              <div className="text-xs font-bold text-player-a-500 text-left pr-2 break-words" title={activeLabels.row1}>A: {activeLabels.row1}</div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 dark:border-slate-700 rounded-xl p-1.5 bg-white dark:bg-slate-950 focus-within:ring-2 focus-within:ring-accent-100/50 dark:focus-within:ring-slate-800 focus-within:border-slate-300 dark:focus-within:border-slate-700 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.a11}
                  onChange={(e) => updatePayoffField('a11', e.target.value)}
                  onBlur={() => handlePayoffBlur('a11')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-a-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 dark:text-slate-600 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.b11}
                  onChange={(e) => updatePayoffField('b11', e.target.value)}
                  onBlur={() => handlePayoffBlur('b11')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-b-600 dark:text-player-b-400 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 dark:border-slate-700 rounded-xl p-1.5 bg-white dark:bg-slate-950 focus-within:ring-2 focus-within:ring-accent-100/50 dark:focus-within:ring-slate-800 focus-within:border-slate-300 dark:focus-within:border-slate-700 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.a12}
                  onChange={(e) => updatePayoffField('a12', e.target.value)}
                  onBlur={() => handlePayoffBlur('a12')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-a-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 dark:text-slate-600 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.b12}
                  onChange={(e) => updatePayoffField('b12', e.target.value)}
                  onBlur={() => handlePayoffBlur('b12')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-b-600 dark:text-player-b-400 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>

              {/* Row 2 inputs */}
              <div className="text-xs font-bold text-player-a-500 text-left pr-2 break-words" title={activeLabels.row2}>A: {activeLabels.row2}</div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 dark:border-slate-700 rounded-xl p-1.5 bg-white dark:bg-slate-950 focus-within:ring-2 focus-within:ring-accent-100/50 dark:focus-within:ring-slate-800 focus-within:border-slate-300 dark:focus-within:border-slate-700 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.a21}
                  onChange={(e) => updatePayoffField('a21', e.target.value)}
                  onBlur={() => handlePayoffBlur('a21')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-a-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 dark:text-slate-600 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.b21}
                  onChange={(e) => updatePayoffField('b21', e.target.value)}
                  onBlur={() => handlePayoffBlur('b21')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-b-600 dark:text-player-b-400 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 dark:border-slate-700 rounded-xl p-1.5 bg-white dark:bg-slate-950 focus-within:ring-2 focus-within:ring-accent-100/50 dark:focus-within:ring-slate-800 focus-within:border-slate-300 dark:focus-within:border-slate-700 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.a22}
                  onChange={(e) => updatePayoffField('a22', e.target.value)}
                  onBlur={() => handlePayoffBlur('a22')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-a-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 dark:text-slate-600 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.b22}
                  onChange={(e) => updatePayoffField('b22', e.target.value)}
                  onBlur={() => handlePayoffBlur('b22')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-b-600 dark:text-player-b-400 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>
            </div>
          </div>

          {/* Expected math formulations */}
          <div data-tour="ep" className="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Expected-Payoff Functions
            </span>
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/50 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800">
                <MathTex tex="\mathbb{E}[A]" className="text-player-a-600 dark:text-player-a-400" />
                <MathTex tex={`= ${eqAStr}`} className="text-slate-700 dark:text-slate-200" />
              </div>
              <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/50 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800">
                <MathTex tex="\mathbb{E}[B]" className="text-player-b-600 dark:text-player-b-400" />
                <MathTex tex={`= ${eqBStr}`} className="text-slate-700 dark:text-slate-200" />
              </div>
            </div>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              <MathTex tex="x = P(\text{A plays Row 1}), \quad y = P(\text{B plays Col 1})" />
            </span>
          </div>

          {/* Configuration Parameters Panel */}
          <div ref={paramsPanelRef} data-tour="coords" className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-4">
            <div className="text-slate-800 dark:text-slate-200 font-semibold text-sm border-b border-slate-100 dark:border-slate-800 pb-2">
              Simulation Coordinates & Parameters
            </div>

            {/* Starting coordinate fields */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-player-a-500 font-semibold mb-1">Row Start Point (x₀)</label>
                <div className="relative">
                  <input
                    type="number"
                    min="0.0"
                    max="1.0"
                    step="0.01"
                    value={x0}
                    onChange={(e) => {
                      setX0(e.target.value);
                      setInitialized(false);
                    }}
                    className="no-native-spinner w-full font-mono text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 p-2 pr-8 rounded-xl focus:ring-rose-200 focus:outline-none"
                  />
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex flex-col">
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Increase x₀"
                      onClick={() => stepStartPoint('x', 1)}
                      className="px-1 py-0.5 rounded-md leading-none text-slate-400 hover:text-player-a-500 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Decrease x₀"
                      onClick={() => stepStartPoint('x', -1)}
                      className="px-1 py-0.5 rounded-md leading-none text-slate-400 hover:text-player-a-500 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs text-player-b-600 dark:text-player-b-400 font-semibold mb-1">Col Start Point (y₀)</label>
                <div className="relative">
                  <input
                    type="number"
                    min="0.0"
                    max="1.0"
                    step="0.01"
                    value={y0}
                    onChange={(e) => {
                      setY0(e.target.value);
                      setInitialized(false);
                    }}
                    className="no-native-spinner w-full font-mono text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 p-2 pr-8 rounded-xl focus:ring-accent-100 focus:outline-none"
                  />
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex flex-col">
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Increase y₀"
                      onClick={() => stepStartPoint('y', 1)}
                      className="px-1 py-0.5 rounded-md leading-none text-slate-400 hover:text-player-b-500 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Decrease y₀"
                      onClick={() => stepStartPoint('y', -1)}
                      className="px-1 py-0.5 rounded-md leading-none text-slate-400 hover:text-player-b-500 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Who moves first choice */}
            <div>
              <label className="block text-xs text-slate-600 dark:text-slate-300 font-medium mb-1.5">Who moves first?</label>
              <div className="grid grid-cols-2 gap-2">
                {(['A', 'B'] as const).map((player) => {
                  const active = firstMover === player;
                  return (
                    <button
                      key={player}
                      onClick={() => {
                        setFirstMover(player);
                        setInitialized(false);
                      }}
                      className={`py-2 px-3 text-xs font-semibold rounded-xl border transition-all ${active
                          ? player === 'A'
                            ? 'bg-player-a-500 text-white border-player-a-500'
                            : 'bg-player-b-600 text-white border-player-b-600'
                          : 'bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }`}
                    >
                      Player {player}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* visual tracking choice */}
            <div>
              <label className="block text-xs text-slate-600 dark:text-slate-300 font-medium mb-1.5">Expected Payoff Surface Tracking</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['A', 'B', 'both'] as const).map((m) => {
                  const active = trackingMode === m;
                  return (
                    <button
                      key={m}
                      onClick={() => setTrackingMode(m)}
                      className={`py-2 px-1 text-xs font-semibold rounded-xl border transition-all text-center ${active
                          ? m === 'A'
                            ? 'bg-player-a-500 text-white border-player-a-500'
                            : m === 'B'
                              ? 'bg-player-b-600 text-white border-player-b-600'
                              : 'bg-ne-mixed-600 text-white border-ne-mixed-600'
                          : 'bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }`}
                    >
                      {m === 'both' ? 'Both Plots' : `Player ${m}`}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Convergence method */}
            <div data-tour="method">
              <label className="block text-xs text-slate-600 dark:text-slate-300 font-medium mb-1.5">Convergence Method</label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { key: 'shrink', label: 'Domain Shrink' },
                  { key: 'regret', label: 'Opponent Regret' },
                ] as const).map(({ key, label }) => {
                  const active = stepMode === key;
                  return (
                    <button
                      key={key}
                      onClick={() => { setStepMode(key); setInitialized(false); }}
                      className={`py-2 px-2 text-xs font-semibold rounded-xl border transition-all text-center ${active
                          ? 'bg-accent-600 text-white border-accent-600 shadow-xs'
                          : 'bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <span className="text-xs text-slate-400 dark:text-slate-500 mt-1.5 block">
                {stepMode === 'regret'
                  ? "Steps each player's strategy by the opponent's regret, animating the strategy line flattening into the indifference line (mixed-strategy games only)."
                  : 'Contracts the search corridor by a fixed step, bisecting when a coordinate is overshot.'}
              </span>
            </div>

            {/* Step size / regret weight */}
            <div>
              <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 font-medium mb-1">
                <span>{stepMode === 'regret' ? 'Regret Step Weight (λ)' : 'Initial Domain Shrink Step Size'}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={shrinkStepRaw}
                  onChange={(e) => {
                    setShrinkStepRaw(e.target.value);
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v) && v > 0) setShrinkStep(Math.min(0.999, Math.max(0.001, Math.round(v * 1000) / 1000)));
                  }}
                  onBlur={() => {
                    const v = parseFloat(shrinkStepRaw);
                    const clamped = isNaN(v) || v <= 0 ? shrinkStep : Math.min(0.999, Math.max(0.001, Math.round(v * 1000) / 1000));
                    setShrinkStep(clamped);
                    setShrinkStepRaw(clamped.toFixed(3));
                  }}
                  className="w-20 font-mono font-semibold text-accent-600 dark:text-accent-400 text-right bg-transparent border-b border-accent-300 dark:border-accent-700 focus:outline-none focus:border-accent-500"
                />
              </div>
              <input
                type="range"
                min="0.001"
                max="0.999"
                step="0.001"
                value={shrinkStep}
                onChange={(e) => { const v = parseFloat(e.target.value); setShrinkStep(v); setShrinkStepRaw(v.toFixed(3)); }}
                className="w-full accent-accent-600 h-1 bg-slate-100 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer"
              />
              <span className="text-xs text-slate-400 dark:text-slate-500 mt-1 block">
                {stepMode === 'regret'
                  ? 'Larger λ glides in faster; keep it modest so the line flattens smoothly without overshooting. As the opponent’s regret → 0, the steps shrink and the line eases into the flat shelf.'
                  : 'Sets how much the search corridor contracts per detected cycle; switches to bisection method when a Player overshoots a mixed equilibrium coordinate.'}
              </span>
            </div>
          </div>
        </div>

        {/* ── Right Panel Simulation Console & Plots (7 cols) ── */}
        <div className="lg:col-span-7 flex flex-col gap-6">

          {/* Plot Legend Info Line */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 items-center text-xs text-slate-500 justify-center lg:justify-start">
            <span className="flex items-center gap-1">🔴 E[A] Surface</span>
            <span className="flex items-center gap-1">🔵 E[B] Surface</span>
            <span className="flex items-center gap-1 text-player-a-500 font-medium">─ A Moves</span>
            <span className="flex items-center gap-1 text-player-b-600 font-medium">─ B Moves</span>
            <span className="flex items-center gap-1 font-semibold text-ne-pure">◆ Pure NE</span>
            <span className="flex items-center gap-1 text-ne-mixed-600 font-bold">🟣 Mixed NE</span>
            <span className="flex items-center gap-1 text-emerald-600">⬚ Domain</span>
            <span className="flex items-center gap-1 text-orange-500">⬚ Search Corridor</span>
            <span className="flex items-center gap-1 text-orange-500">○ Ghost positions</span>
          </div>

          {/* Plotly 3D visual component */}
          <PlotlyView
            payoffs={payoffs}
            simState={simState}
            trackingMode={trackingMode}
            tourPoints={tourPoints}
            hiddenTraces={tourHiddenTraces}
            // The spin runs whenever the simulation isn't — in the tour it is
            // additionally gated per-step (tourSpinAllowed). Outside the tour
            // nothing is permanent: graph activity halts the spin and it
            // returns by itself after 10s of inactivity. A fresh or newly
            // loaded game spins straight away (spinDelayMs 0 — handleReset
            // bumps the nonce so this restarts on every load); a PAUSED or
            // finished run first waits out the same 10s, since the visitor
            // is likely mid-inspection.
            idleSpin={tourOpen ? tourSpinAllowed && !simState.running : !simState.running}
            spinNonce={tourSpinNonce}
            spinDelayMs={!tourOpen && initialized ? 10000 : 0}
            spinAutoResumeMs={tourOpen ? 0 : 10000}
            // Pressing anywhere on the graph pauses a running simulation —
            // reaching into the picture means the visitor wants to inspect
            // it, not race the markers. No auto-resume (unlike the spin's
            // countdown): Run continues exactly where it stopped. Gated off
            // during the tour, whose scripted playback a stray press would
            // desync.
            onGraphPress={() => {
              if (!tourOpen && simStateRef.current.running) {
                setSimState((prev) => ({ ...prev, running: false }));
              }
            }}
            allNE={allNE}
            isDark={darkMode}
            stepMode={stepMode}
          />

          {/* Progress bar + step input + NE jump — always visible once simulation starts */}
          <div className={`flex flex-col gap-2 px-3 py-2.5 rounded-xl border ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
            {/* Bar row — only shown after first step */}
            {thinHistory.length > 1 && (
              <div className="flex items-center gap-3">
                <span className={`text-xs font-medium shrink-0 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Progress</span>
                <div className={`flex-1 h-2 rounded-full overflow-hidden ${darkMode ? 'bg-slate-700' : 'bg-slate-200'}`}>
                  <div
                    className="h-full rounded-full bg-accent-500 transition-all duration-150"
                    style={{ width: `${Math.min(100, (simState.stepCount / (thinHistory.length - 1)) * 100)}%` }}
                  />
                </div>
                <span className="text-xs font-mono shrink-0 text-amber-500 font-semibold">
                  {simState.stepCount} / {thinHistory.length - 1}
                </span>
              </div>
            )}
            {/* Step input row + NE button + converged status */}
            <div className="flex items-center gap-2 flex-wrap">
              {thinHistory.length > 1 && (
                <>
                  <span className={`text-xs font-medium shrink-0 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Go to step</span>
                  <input
                    type="number"
                    min={0}
                    max={thinHistory.length - 1}
                    value={jumpInput}
                    onChange={e => setJumpInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleJump(); }}
                    placeholder={`0 – ${thinHistory.length - 1}`}
                    className={`no-native-spinner w-28 px-2 py-1 text-xs rounded-lg border font-mono ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-600' : 'bg-white border-slate-300 text-slate-700 placeholder-slate-400'}`}
                  />
                  <button
                    onClick={handleJump}
                    className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-700 text-white transition-all"
                  >
                    Go
                  </button>
                </>
              )}
              {/* Enabled in BOTH modes: regret used to lock the two coordinates
                  atomically (so this marker coincided with convergence and was
                  hidden there), but it now declares them individually — the
                  first find is a real, distinct moment in either mode. */}
              {mixedNE && (
                <button
                  onClick={handleJumpToNE}
                  disabled={!neSnapshot}
                  className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all ${
                    neSnapshot
                      ? darkMode ? 'border-ne-mixed-700 text-ne-mixed-400 hover:bg-ne-mixed-900/30 cursor-pointer' : 'border-ne-mixed-300 text-ne-mixed-700 hover:bg-ne-mixed-50 cursor-pointer'
                      : darkMode ? 'border-slate-700 text-slate-600 cursor-not-allowed' : 'border-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  {neSnapshot ? `1st NE Coord (step ${neSnapshot.stepCount})` : '1st NE Coord'}
                </button>
              )}
              {simState.converged && (
                <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium bg-emerald-100/95 dark:bg-emerald-950/90 text-emerald-800 dark:text-emerald-300 py-1 px-2.5 rounded-full border border-emerald-200 dark:border-emerald-800 animate-fade-in">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Converged
                </span>
              )}
            </div>
          </div>

          {/* Simulation Controls Dashboard */}
          <div data-tour="controls" className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-4">

            {/* Play trigger buttons row */}
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <button
                  onClick={togglePlay}
                  className={`flex items-center gap-1 mt-0.5 py-2 px-3 sm:px-5 text-xs sm:text-sm font-semibold rounded-xl text-white transition-all shadow-xs ${simState.running
                      ? 'bg-yellow-500 hover:bg-yellow-600'
                      : 'bg-accent-600 hover:bg-accent-700'
                    }`}
                >
                  {simState.running ? (
                    <>
                      <Pause className="w-3.5 h-3.5 fill-white" /> Pause
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-white" /> Run
                    </>
                  )}
                </button>

                <button
                  onClick={() => handleStep()}
                  disabled={simState.running || (thinHistory.length > 0 && simState.stepCount >= thinHistory.length - 1)}
                  className="flex items-center gap-1 mt-0.5 py-2 px-2.5 sm:px-4 text-xs sm:text-sm font-semibold rounded-xl border border-slate-200 dark:border-slate-700 text-accent-600 dark:text-accent-400 bg-accent-50/50 dark:bg-accent-950/20 hover:bg-accent-50 dark:hover:bg-accent-950/40 transition-all disabled:opacity-50 disabled:bg-slate-50 dark:disabled:bg-slate-800 disabled:text-slate-400 disabled:border-slate-200 dark:disabled:border-slate-700"
                >
                  <SkipForward className="w-3.5 h-3.5" /> Step
                </button>

                <button
                  onClick={handleBackstep}
                  disabled={simState.running || !initStateRef.current || simState.stepCount === 0}
                  className="flex items-center gap-1 mt-0.5 py-2 px-2 sm:px-3 text-xs sm:text-sm font-medium rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all disabled:opacity-40"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Back
                </button>

                <button
                  onClick={handleReset}
                  className="flex items-center gap-1 mt-0.5 py-2 px-2 sm:px-3 text-xs sm:text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Reset
                </button>
              </div>

              {/* Speed slider */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Loop Speed</span>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={speed}
                  onChange={(e) => setSpeed(parseInt(e.target.value))}
                  className="w-20 accent-accent-600 h-1 bg-slate-100 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
                <span className="text-xs font-mono text-slate-400 font-semibold">{speed}x</span>
              </div>
            </div>

            {/* Realtime coordinates outputs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                <span className="text-xs text-player-a-500 font-bold uppercase block tracking-wider">
                  x: P(A playing Row 1)
                </span>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200 font-mono">
                  {simState.cx.toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                <span className="text-xs text-player-b-600 dark:text-player-b-400 font-semibold uppercase block tracking-wider">
                  y: P(B playing Col 1)
                </span>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200 font-mono">
                  {simState.cy.toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                <span className="text-xs text-slate-500 dark:text-slate-400 block tracking-wider">
                  Expected Payoff E[A]
                </span>
                <span className="text-sm font-bold text-player-a-500 font-mono">
                  {r3(EA(simState.cx, simState.cy, payoffs)).toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                <span className="text-xs text-slate-500 dark:text-slate-400 block tracking-wider">
                  Expected Payoff E[B]
                </span>
                <span className="text-sm font-bold text-player-b-600 dark:text-player-b-400 font-mono">
                  {r3(EB(simState.cx, simState.cy, payoffs)).toFixed(3)}
                </span>
              </div>
            </div>
          </div>
          {simState.converged && nearestNE && (
            <div className={`p-5 rounded-2xl border flex flex-col gap-3 shadow-xs animate-fade-in ${nearestNE.type === 'mixed'
                ? 'bg-ne-mixed-50 dark:bg-ne-mixed-950/20 border-ne-mixed-200 dark:border-ne-mixed-800/60'
                : 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60'
              }`}>
              <div className="flex items-center gap-2">
                <span className={`p-1.5 rounded-lg ${nearestNE.type === 'mixed' ? 'bg-ne-mixed-100 dark:bg-ne-mixed-900/60 text-ne-mixed-700 dark:text-ne-mixed-300' : 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300'
                  }`}>
                  <Award className="w-5 h-5" />
                </span>
                <span className={`text-sm font-bold uppercase tracking-wider ${nearestNE.type === 'mixed' ? 'text-ne-mixed-900 dark:text-ne-mixed-200' : 'text-emerald-900 dark:text-emerald-200'
                  }`}>
                  {nearestNE.type === 'mixed' ? 'Mixed' : 'Pure'} Strategy Nash Equilibrium Reached
                </span>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 py-3 bg-white/75 dark:bg-slate-900/65 px-4 rounded-xl border border-slate-100 dark:border-slate-800 text-xs shadow-3xs">
                <span className="text-player-a-600 dark:text-player-a-400">
                  <MathTex tex={`x^* = ${simState.cx.toFixed(3)}`} />
                </span>
                <span className="text-player-b-600 dark:text-player-b-400">
                  <MathTex tex={`y^* = ${simState.cy.toFixed(3)}`} />
                </span>
                <span className="text-slate-700 dark:text-slate-200">
                  <MathTex tex={`\\mathbb{E}[A] = ${r3(EA(simState.cx, simState.cy, payoffs)).toFixed(3)}`} />
                </span>
                <span className="text-slate-700 dark:text-slate-200">
                  <MathTex tex={`\\mathbb{E}[B] = ${r3(EB(simState.cx, simState.cy, payoffs)).toFixed(3)}`} />
                </span>
              </div>

              <div className="bg-white/50 dark:bg-slate-900/30 p-3.5 rounded-xl border border-slate-100 dark:border-slate-800 text-xs font-mono text-slate-600 dark:text-slate-300 space-y-1">
                {nearestNE.type === 'mixed' ? (
                  <>
                    <div>
                      <span className="font-sans font-semibold text-player-a-600 dark:text-player-a-400 mr-2">A indifferent:</span>
                      <MathTex tex={`\\mathbb{E}[\\text{Row 1}] = ${r3(simState.cy * payoffs.a11 + (1 - simState.cy) * payoffs.a12).toFixed(3)} \\approx \\mathbb{E}[\\text{Row 2}] = ${r3(simState.cy * payoffs.a21 + (1 - simState.cy) * payoffs.a22).toFixed(3)}`} />
                    </div>
                    <div>
                      <span className="font-sans font-semibold text-player-b-600 dark:text-player-b-400 mr-2">B indifferent:</span>
                      <MathTex tex={`\\mathbb{E}[\\text{Col 1}] = ${r3(simState.cx * payoffs.b11 + (1 - simState.cx) * payoffs.b21).toFixed(3)} \\approx \\mathbb{E}[\\text{Col 2}] = ${r3(simState.cx * payoffs.b12 + (1 - simState.cx) * payoffs.b22).toFixed(3)}`} />
                    </div>
                    <div className="text-xs text-slate-400 dark:text-slate-500 mt-2 font-sans font-medium">
                      Resolved via {simState.cycleCount} contraction cycles of search corridors.
                    </div>
                  </>
                ) : (
                  <div className="font-sans text-xs">
                    Mover priority settled. Player {firstMover === 'A' ? 'A' : 'B'} moved first, committing to their optimal pure NE payoff of {firstMover === 'A' ? nearestNE.eA.toFixed(3) : nearestNE.eB.toFixed(3)}.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Game situation description box */}
          <div ref={reportPanelRef} className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300 h-fit">
            <div className="text-slate-800 dark:text-slate-100 font-semibold text-sm border-b border-rose-100/50 dark:border-slate-800 pb-2 flex items-center gap-1.5">
              <Compass className="w-4 h-4 text-emerald-500" />
              Game-Theoretic Report
            </div>

            <div className="space-y-3">
              <div data-tour="ne">
                <strong className="text-slate-700 dark:text-slate-200">Calculated Nash Equilibria:</strong>
                <ul className="list-disc pl-5 mt-1 text-slate-600 dark:text-slate-300 space-y-1">
                  {allNE.map((ne, idx) => (
                    <li key={idx}>
                      <span className={`font-semibold ${ne.type === 'mixed' ? 'text-ne-mixed-600 dark:text-ne-mixed-400' : 'text-slate-800 dark:text-slate-100'}`}>
                        {ne.label}
                      </span>{' '}
                      with values E[A]={ne.eA.toFixed(3)}, E[B]={ne.eB.toFixed(3)}
                    </li>
                  ))}
                  {allNE.length === 0 && (
                    <li className="text-rose-500 font-medium">No standard NE found in real dimensions.</li>
                  )}
                </ul>
              </div>

              {indifferenceStatus.any && (
                <div className="bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-900/30 rounded-xl p-3.5 text-xs text-amber-800 dark:text-amber-300 space-y-1.5 shadow-sm leading-relaxed">
                  <div className="font-semibold flex items-center gap-1.5 text-amber-900 dark:text-amber-100">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                    Flat Payoffs & Indifference Notice
                  </div>
                  {indifferenceStatus.both ? (
                    <p>
                      Because all choices yield identical payoffs, <strong>every single point</strong> in the continuous [0, 1] × [0, 1] strategy space is a Nash Equilibrium! Neither player has any incentive to deviate. Any active path movement is simply an artifact of default tie-breaking direction or step sizes.
                    </p>
                  ) : indifferenceStatus.aIndifferent ? (
                    <p>
                      <strong>Player A's options yield flat payoffs.</strong> Since Player A's strategy does not affect their payoff, they have no relative incentive to shift rows. This produces entire lines/ranges of equilibria and causes neutral best-response drift.
                    </p>
                  ) : (
                    <p>
                      <strong>Player B's options yield flat payoffs.</strong> Since Player B's strategy does not affect their payoff, they have no relative incentive to shift columns. This produces entire lines/ranges of equilibria and causes neutral best-response drift.
                    </p>
                  )}
                </div>
              )}

              <div className="text-slate-500 dark:text-slate-400">
                {pureNEs.length === 0 && mixedNE ? (
                  <p>
                    No pure strategy NE coordinates exist. The best-response trajectory forms stable cyclic loops, letting our domain-shrinking algorithm narrow down the search corridor boundaries until they safely contract and lock directly onto the <strong className="text-ne-mixed-600 dark:text-ne-mixed-400 font-bold">Mixed NE</strong>.
                  </p>
                ) : pureNEs.length === 1 && !mixedNE ? (
                  <p>
                    Exactly one pure NE exists. Best response trajectories will always converge towards the unique pure attracter point.
                  </p>
                ) : pureNEs.length >= 1 && mixedNE ? (
                  <div>
                    <p className="mb-2">
                      Multiple pure equilibria exist as well as a mixed NE which is unstable under best-response dynamics.
                    </p>
                    {committedNE && (
                      <p className="font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/20 rounded-xl p-2.5 border border-emerald-100 dark:border-emerald-800">
                        Player {firstMover} initiates and commits to: {committedNE.label} (payoff A = {committedNE.eA.toFixed(3)}, B = {committedNE.eB.toFixed(3)}).
                      </p>
                    )}
                  </div>
                ) : pureNEs.length > 1 ? (
                  <div>
                    <p className="mb-2">
                      Multiple pure equilibria coexist. The first-mover can secure a first-mover advantage, committing to play the target Row or Column that maximizes their own payoffs.
                    </p>
                    <p>
                      Over time, any best-response steps from outer starting sectors migrate away from the mixed NE and lock into the <strong className="text-slate-800 dark:text-slate-200 font-medium">{pureNEs[0].label}</strong>.
                    </p>
                  </div>
                ) : null}
              </div>

              {/* Plain-English explanation. The solver computes; the model only
                  narrates, and its claims are checked against the solver before
                  a single word of it is shown. */}
              <div className="border-t border-slate-100 dark:border-slate-800 pt-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
                    Plain-English Explanation
                  </strong>
                  <div className="flex items-center gap-1.5">
                    {/*
                      Opt-in path to a NEW invented story for a game that already
                      has one: the request omits the scenario, so the model
                      invents and the suggestion card below offers it — nothing
                      is replaced unless the user saves it.
                    */}
                    {scenarioForReport && (
                      <button
                        onClick={() => fetchLlmExplanation(true)}
                        disabled={llmLoading}
                        title="Invent a brand-new scenario for these payoffs — you choose whether to keep it."
                        className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-slate-50/60 dark:bg-slate-900/40 hover:bg-slate-100 dark:hover:bg-slate-800/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        New AI scenario
                      </button>
                    )}
                    <button
                      onClick={() => fetchLlmExplanation()}
                      disabled={llmLoading}
                      className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 bg-indigo-50/60 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {llmLoading ? 'Analyzing…' : llmEnvelope ? 'Regenerate' : 'Explain this game'}
                    </button>
                  </div>
                </div>

                {llmLoading && (
                  <p className="italic text-slate-400 dark:text-slate-500">
                    Writing an explanation and checking it against the solver…
                  </p>
                )}

                {!llmLoading && llmVerified && llmEnvelope?.report && (
                  <div className="space-y-2">
                    <p className="text-slate-600 dark:text-slate-300">
                      {/* A fresh invention's prose uses the suggestion's own
                          option names, so those join the highlight terms. */}
                      <ColorCoded
                        text={llmEnvelope.report.prose}
                        aTerms={[
                          ...colorTerms.a,
                          ...(llmEnvelope.report.suggestedScenario
                            ? [llmEnvelope.report.suggestedScenario.row1, llmEnvelope.report.suggestedScenario.row2].filter(Boolean)
                            : []),
                        ]}
                        bTerms={[
                          ...colorTerms.b,
                          ...(llmEnvelope.report.suggestedScenario
                            ? [llmEnvelope.report.suggestedScenario.col1, llmEnvelope.report.suggestedScenario.col2].filter(Boolean)
                            : []),
                        ]}
                      />
                    </p>
                    <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                      <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Every equilibrium named above was verified against the solver
                        {llmEnvelope.validation ? ` (${llmEnvelope.validation.checks.length} checks passed)` : ''}.
                      </span>
                    </div>

                    {/*
                      Appears when the explanation above was written against an
                      INVENTED story: either the game had no scenario of its own,
                      or the user pressed "New AI scenario" to ask for one. Saving
                      is always the user's choice — for a saved game it replaces
                      the description in place, for a preset it saves a custom
                      copy; declining leaves everything untouched.
                    */}
                    {llmEnvelope.report.suggestedScenario && (
                      <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900/60 dark:bg-indigo-950/30">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
                          Scenario written for this game
                        </p>
                        <p className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
                          {llmEnvelope.report.suggestedScenario.name}
                        </p>
                        <p className="mt-0.5 text-[12px] text-slate-600 dark:text-slate-300">
                          <ColorCoded
                            text={llmEnvelope.report.suggestedScenario.description ?? ''}
                            aTerms={['Player A', llmEnvelope.report.suggestedScenario.row1, llmEnvelope.report.suggestedScenario.row2].filter(Boolean) as string[]}
                            bTerms={['Player B', llmEnvelope.report.suggestedScenario.col1, llmEnvelope.report.suggestedScenario.col2].filter(Boolean) as string[]}
                          />
                        </p>
                        <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                          <span className="text-player-a-600 dark:text-player-a-400 font-semibold">
                            A: {llmEnvelope.report.suggestedScenario.row1} / {llmEnvelope.report.suggestedScenario.row2}
                          </span>
                          {'  ·  '}
                          <span className="text-player-b-600 dark:text-player-b-400 font-semibold">
                            B: {llmEnvelope.report.suggestedScenario.col1} / {llmEnvelope.report.suggestedScenario.col2}
                          </span>
                        </p>
                        <button
                          type="button"
                          onClick={() => useSuggestedScenario(llmEnvelope.report!.suggestedScenario!)}
                          className="mt-2.5 rounded-md bg-indigo-600 px-2.5 py-1.5 text-[12px] font-semibold text-white transition hover:bg-indigo-700"
                        >
                          Save this scenario with the game
                        </button>
                        <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                          Keeps these names for future explanations instead of inventing new ones.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {!llmLoading && llmEnvelope && !llmVerified && (
                  <p className="text-slate-400 dark:text-slate-500 italic">
                    No verified explanation available
                    {llmEnvelope.fallbackReason ? ` (${llmEnvelope.fallbackReason})` : ''} — the computed
                    report above is authoritative.
                  </p>
                )}

                {!llmLoading && !llmEnvelope && llmError && (
                  <p className="text-amber-700 dark:text-amber-400">
                    Couldn't reach the explanation service. The computed report above is unaffected —
                    try again in a moment.
                  </p>
                )}

                {!llmLoading && !llmEnvelope && !llmError && (
                  <p className="text-slate-400 dark:text-slate-500">
                    Get a written walkthrough of what each player is trading off. The equilibria are
                    always computed exactly; the explanation is checked against them before it appears.
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Log sits in the right column, sized to align with the params panel */}
          {!logBelow && simulationLogPanel}
        </div>

        {/* When the converged report leaves no room, the log spans full width */}
        {logBelow && (
          <div className="lg:col-span-12">
            {simulationLogPanel}
          </div>
        )}
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 py-4 px-6 text-center">
        <p className="text-xs text-slate-400 dark:text-slate-500">© 2026 Daniel Luan</p>
      </footer>

      {expandedLogOverlay}

      <Walkthrough steps={tourSteps} open={tourOpen} onClose={closeTour} />

      {isAuthModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none"
          onClick={() => { setIsAuthModalOpen(false); setAuthError(''); setAuthSuccess(''); resumeSaveAfterAuthRef.current = false; }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Account"
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-xl animate-modal-in">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-accent-50 dark:bg-accent-950/40 text-accent-600 rounded-lg">
                  <User className="w-4 h-4" />
                </span>
                <span className="font-bold text-slate-800 dark:text-slate-100 text-sm md:text-base">
                  {authMode === 'login' ? 'Sign In' : authMode === 'register' ? 'Create Account' : authMode === 'verify' ? 'Verify Email' : authMode === 'forgot' ? 'Forgot Password' : 'Reset Password'}
                </span>
              </div>
              <button
                onClick={() => {
                  setIsAuthModalOpen(false);
                  setAuthError('');
                  setAuthSuccess('');
                  resumeSaveAfterAuthRef.current = false;
                }}
                aria-label="Close dialog" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {authError && (
              <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-300 text-xs rounded-xl p-3 flex gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                <span>{authError}</span>
              </div>
            )}

            {authSuccess && (
              <div className="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-xs rounded-xl p-3 flex gap-3 font-medium">
                <Check className="w-4 h-4 shrink-0 text-emerald-500" />
                <span>{authSuccess}</span>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="flex flex-col gap-3.5">
              {authMode === 'register' && (
                <div>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Username</label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                      placeholder="game_theorist"
                      value={authUsername}
                      onChange={(e) => setAuthUsername(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}

              {(authMode === 'login' || authMode === 'register') && (
                <>
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">
                      {authMode === 'login' ? 'Email or Username' : 'Email Address'}
                    </label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type={authMode === 'login' ? 'text' : 'email'}
                        className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder={authMode === 'login' ? 'john@example.com or username' : 'john@example.com'}
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="password"
                        className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder="••••••••"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        required
                      />
                    </div>
                    {authMode === 'register' && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-normal">
                        Password requirement: <strong className="text-accent-600 dark:text-accent-400 font-semibold">Min 8 characters</strong> with at least <strong className="text-accent-600 dark:text-accent-400 font-semibold">one uppercase</strong> and <strong className="text-accent-600 dark:text-accent-400 font-semibold">one lowercase</strong> letter.
                      </p>
                    )}
                  </div>

                  {authMode === 'register' && (
                    <div>
                      <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Retype Password</label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input
                          type="password"
                          className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-300 dark:focus:ring-slate-700 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                          placeholder="••••••••"
                          value={authConfirmPassword}
                          onChange={(e) => setAuthConfirmPassword(e.target.value)}
                          required
                        />
                      </div>
                      {authPassword && authConfirmPassword && (
                        <div className="text-xs mt-1 font-semibold">
                          {authPassword === authConfirmPassword ? (
                            <span className="text-emerald-600 flex items-center gap-1">✓ Passwords match</span>
                          ) : (
                            <span className="text-rose-500 flex items-center gap-1">✗ Passwords do not match</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {authMode === 'verify' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">6-Digit Confirmation Code</label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        maxLength={6}
                        className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm tracking-widest font-mono font-bold bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-center text-slate-800 dark:text-slate-200"
                        placeholder="123456"
                        value={authCode}
                        onChange={(e) => setAuthCode(e.target.value.replace(/\D/g, ''))}
                        required
                      />
                    </div>
                  </div>
                </div>
              )}

              {authMode === 'forgot' && (
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-3 leading-relaxed">
                    Enter the email address associated with your account and we'll send you a 6-digit recovery code.
                  </p>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Email Address</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="email"
                      className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                      placeholder="john@example.com"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}

              {authMode === 'reset-password' && (
                <div className="space-y-3.5">
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">6-Digit Recovery Code</label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        maxLength={6}
                        className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm tracking-widest font-mono font-bold bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-100 focus:border-slate-300 text-center text-slate-800 dark:text-slate-200"
                        placeholder="123456"
                        value={authCode}
                        onChange={(e) => setAuthCode(e.target.value.replace(/\D/g, ''))}
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">New Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="password"
                        className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder="••••••••"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        required
                      />
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-normal">
                      Min 8 characters with at least one <strong className="text-orange-600 dark:text-orange-400">uppercase</strong> and one <strong className="text-orange-600 dark:text-orange-400">lowercase</strong> letter.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Confirm New Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="password"
                        className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder="••••••••"
                        value={authConfirmPassword}
                        onChange={(e) => setAuthConfirmPassword(e.target.value)}
                        required
                      />
                    </div>
                    {authPassword && authConfirmPassword && (
                      <div className="text-xs mt-1 font-semibold">
                        {authPassword === authConfirmPassword ? (
                          <span className="text-emerald-600 flex items-center gap-1">✓ Passwords match</span>
                        ) : (
                          <span className="text-rose-500 flex items-center gap-1">✗ Passwords do not match</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={authLoading}
                className={`w-full text-white font-bold text-xs sm:text-sm py-2.5 rounded-xl transition-all cursor-pointer shadow-xs disabled:opacity-50 inline-flex items-center justify-center gap-1.5 ${authMode === 'forgot' || authMode === 'reset-password' ? 'bg-orange-500 hover:bg-orange-600' : 'bg-accent-600 hover:bg-accent-700'}`}
              >
                {authLoading ? 'Please wait...' : authMode === 'login' ? 'Login' : authMode === 'register' ? 'Register Account' : authMode === 'verify' ? 'Verify & Setup Account' : authMode === 'forgot' ? 'Send Recovery Code' : 'Reset Password'}
              </button>
            </form>

            <div className="border-t border-slate-100 dark:border-slate-800 pt-3.5 text-center text-xs text-slate-500 dark:text-slate-400 font-medium flex flex-col gap-1.5">
              {authMode === 'login' ? (
                <>
                  <span>
                    Don't have an account?{' '}
                    <button
                      onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthMode('register'); }}
                      className="font-bold text-accent-600 hover:underline cursor-pointer"
                    >
                      Sign Up
                    </button>
                  </span>
                  <span>
                    <button
                      onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthCode(''); setAuthMode('forgot'); }}
                      className="font-bold text-orange-500 hover:underline cursor-pointer"
                    >
                      Forgot your password?
                    </button>
                  </span>
                </>
              ) : authMode === 'register' ? (
                <span>
                  Already have an account?{' '}
                  <button
                    onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthMode('login'); }}
                    className="font-bold text-accent-600 hover:underline cursor-pointer"
                  >
                    Log In
                  </button>
                </span>
              ) : authMode === 'forgot' || authMode === 'reset-password' ? (
                <span>
                  Remember your password?{' '}
                  <button
                    onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthCode(''); setAuthPassword(''); setAuthConfirmPassword(''); setAuthMode('login'); }}
                    className="font-bold text-accent-600 hover:underline cursor-pointer"
                  >
                    Back to Login
                  </button>
                </span>
              ) : (
                <span>
                  Back to{' '}
                  <button
                    onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthMode('register'); }}
                    className="font-bold text-accent-600 hover:underline cursor-pointer"
                  >
                    Registration
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Save Custom Game Modal ── */}
      {/* Edit an already-saved game: name, description, option names.
          Payoffs are deliberately absent — the server refuses to update them
          here, because changing the numbers silently invalidates the story
          written about them, which is the exact mismatch the scenario feature
          exists to prevent. Editing a matrix stays a save-as-new operation. */}
      {isEditModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none"
          onClick={() => { setIsEditModalOpen(false); setEditError(''); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Edit saved game"
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-xl animate-modal-in max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Pencil className="w-4 h-4 text-accent-500" />
                <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">Edit Game</h3>
              </div>
              <button
                type="button"
                onClick={() => { setIsEditModalOpen(false); setEditError(''); }}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xs cursor-pointer"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleEditGameSubmit} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Game Name</label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={40}
                  required
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Game Description</label>
                <textarea
                  className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 h-24 resize-none text-slate-800 dark:text-slate-200"
                  placeholder="What is this game about?"
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  // Same 800 as the save modal and the server clamp — an
                  // AI-kept description can legitimately be this long, and a
                  // lower cap here would lock editing of exactly those games.
                  maxLength={800}
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">
                  Option Names <span className="font-normal text-slate-400 dark:text-slate-500">(optional)</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['row1', "A's Row 1", 'e.g. Undercut'],
                    ['row2', "A's Row 2", 'e.g. Hold price'],
                    ['col1', "B's Col 1", 'e.g. Match'],
                    ['col2', "B's Col 2", 'e.g. Ignore'],
                  ] as const).map(([key, label, placeholder]) => (
                    <div key={key}>
                      <span className={`block text-[10px] font-semibold mb-0.5 ${key.startsWith('row') ? 'text-player-a-500' : 'text-player-b-600 dark:text-player-b-400'}`}>
                        {label}
                      </span>
                      <input
                        type="text"
                        className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder={placeholder}
                        value={editLabels[key]}
                        onChange={(e) => setEditLabels((prev) => ({ ...prev, [key]: e.target.value }))}
                        maxLength={40}
                      />
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
                  Naming all four lets the AI explainer reuse this scenario instead of inventing a new one.
                  Clear a box to remove that name.
                </p>
              </div>

              <p className="text-[10px] text-slate-400 dark:text-slate-500 -mt-1">
                To change the payoff numbers, edit them on the board and save as a new game — the
                description here would no longer match.
              </p>

              {editError && <p className="text-xs text-danger-500 font-semibold">{editError}</p>}

              <div className="flex gap-2 justify-end border-t border-slate-100 dark:border-slate-800 pt-3.5">
                <button
                  type="button"
                  onClick={() => { setIsEditModalOpen(false); setEditError(''); }}
                  className="px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editLoading}
                  className="bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs py-2 px-4 rounded-xl transition-all shadow-xs cursor-pointer disabled:opacity-50"
                >
                  {editLoading ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isSaveModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none"
          onClick={() => { setIsSaveModalOpen(false); setSaveError(''); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Save custom game"
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-xl animate-modal-in max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-accent-50 dark:bg-accent-950/40 text-accent-600 rounded-lg">
                  <Award className="w-4 h-4" />
                </span>
                <span className="font-bold text-slate-800 dark:text-slate-100 text-sm md:text-base">
                  Save Custom Game
                </span>
              </div>
              <button
                onClick={() => {
                  setIsSaveModalOpen(false);
                  setSaveError('');
                }}
                aria-label="Close dialog" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {saveError && (
              // Signed out, any save problem: the remedy is signing in, so this
              // renders as an invitation with the door held open — not a red
              // error about sessions the visitor never had.
              !authToken ? (
                <div className="bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 text-indigo-800 dark:text-indigo-200 text-xs rounded-xl p-3 flex gap-2 font-medium">
                  <LogIn className="w-4 h-4 shrink-0 text-indigo-500 dark:text-indigo-400 mt-0.5" />
                  <div className="flex flex-col items-start gap-2">
                    <span>{saveError} Your matrix, name and description will stay right here.</span>
                    <button
                      type="button"
                      onClick={() => {
                        resumeSaveAfterAuthRef.current = true;
                        setIsSaveModalOpen(false);
                        setAuthError(''); setAuthSuccess(''); setAuthMode('login'); setIsAuthModalOpen(true);
                      }}
                      className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-indigo-700"
                    >
                      Sign In / Sign Up
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-300 text-xs rounded-xl p-3 flex gap-2 font-medium">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                  <span>{saveError}</span>
                </div>
              )
            )}

            <div className="bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800 rounded-xl p-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Payload to be saved:</span>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                <div>(Row 1, Col 1) = ({payoffs.a11}, {payoffs.b11})</div>
                <div>(Row 1, Col 2) = ({payoffs.a12}, {payoffs.b12})</div>
                <div>(Row 2, Col 1) = ({payoffs.a21}, {payoffs.b21})</div>
                <div>(Row 2, Col 2) = ({payoffs.a22}, {payoffs.b22})</div>
              </div>
            </div>

            {/* Generate-a-game-for-me. Rolls a solver-verified random matrix
                with the chosen equilibrium structure onto the board (replacing
                the payload above), then prefills the form from an AI-invented
                scenario. Styled indigo like the app's other AI affordances. */}
            <div className="bg-indigo-50/40 dark:bg-indigo-950/20 border border-indigo-200 dark:border-indigo-900/50 rounded-xl p-3 flex flex-col gap-2">
              <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                …or generate a new game
              </span>
              <p className="text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
                Rolls a fresh random matrix with the equilibrium type you pick and has the AI write
                a scenario for it. Replaces the matrix shown above.
              </p>
              <div className="flex gap-2">
                <select
                  value={generateKind}
                  onChange={(e) => setGenerateKind(e.target.value as 'pure' | 'mixed')}
                  disabled={generateLoading}
                  aria-label="Equilibrium type to generate"
                  className="flex-1 px-2.5 py-1.5 text-xs bg-white dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-700 dark:text-slate-200 cursor-pointer disabled:opacity-50"
                >
                  <option value="pure">Pure-strategy equilibrium</option>
                  <option value="mixed">Mixed-strategy equilibrium</option>
                </select>
                <button
                  type="button"
                  onClick={handleGenerateGame}
                  disabled={generateLoading}
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 bg-indigo-50/60 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {generateLoading ? 'Generating…' : 'Generate'}
                </button>
              </div>
              {generateNote && (
                <p className="text-[10px] leading-relaxed font-semibold text-indigo-700 dark:text-indigo-300">
                  {generateNote}
                </p>
              )}
            </div>

            <form onSubmit={handleSaveGameSubmit} className="flex flex-col gap-3.5">
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Game Name</label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                  placeholder="e.g. Battle of the Sexes 2.0"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  maxLength={40}
                  required
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Game Description</label>
                <textarea
                  className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 h-24 resize-none text-slate-800 dark:text-slate-200"
                  placeholder="Explain the background storyline or payoff choices of this strategic profile."
                  value={saveDesc}
                  onChange={(e) => setSaveDesc(e.target.value)}
                  // Matches the server's clamp (cleanText(description, 800)).
                  // A cap BELOW what prefill can supply locks the field: a
                  // controlled textarea already over maxLength rejects every
                  // keystroke, which read as "can't edit the description"
                  // when an AI-invented scenario prefilled ~300+ chars.
                  maxLength={800}
                />
              </div>

              {/* Option names. Optional, but the most valuable thing a user can
                  fill in: four labels are enough on their own for the explainer
                  to reuse this game's story instead of inventing a new one, and
                  they replace "Row 1"/"Col 2" in the matrix headers. */}
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">
                  Option Names <span className="font-normal text-slate-400 dark:text-slate-500">(optional)</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['row1', "A's Row 1", 'e.g. Undercut'],
                    ['row2', "A's Row 2", 'e.g. Hold price'],
                    ['col1', "B's Col 1", 'e.g. Match'],
                    ['col2', "B's Col 2", 'e.g. Ignore'],
                  ] as const).map(([key, label, placeholder]) => (
                    <div key={key}>
                      <span className={`block text-[10px] font-semibold mb-0.5 ${key.startsWith('row') ? 'text-player-a-500' : 'text-player-b-600 dark:text-player-b-400'}`}>
                        {label}
                      </span>
                      <input
                        type="text"
                        className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder={placeholder}
                        value={saveLabels[key]}
                        onChange={(e) => setSaveLabels((prev) => ({ ...prev, [key]: e.target.value }))}
                        maxLength={40}
                      />
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
                  Naming all four lets the AI explainer reuse this scenario instead of inventing a new one.
                </p>
              </div>

              <div className="flex gap-2 justify-end border-t border-slate-100 dark:border-slate-800 pt-3.5">
                <button
                  type="button"
                  onClick={() => setIsSaveModalOpen(false)}
                  className="px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saveLoading}
                  className="bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs py-2 px-4 rounded-xl transition-all shadow-xs cursor-pointer disabled:opacity-50"
                >
                  {saveLoading ? 'Saving...' : 'Save Game Profile'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Slideout workspace center menu drawer */}
      <MenuDrawer
        isOpen={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
        user={user}
        authToken={authToken}
        userCustomGames={userCustomGames}
        onDeleteCustomGame={handleDeleteGame}
        onLoadPreset={handleLoadPreset}
        activePreset={activePreset}
        isDark={darkMode}
        onLogout={handleLogout}
        onOpenAuth={() => {
          setAuthError('');
          setAuthSuccess('');
          setAuthMode('login');
          setIsAuthModalOpen(true);
        }}
        getApiUrl={getApiUrl}
        dbMode={dbMode}
        apiBaseUrl={apiBaseUrl}
        onSwitchDbMode={handleSwitchDbMode}
        onUpdateApiBaseUrl={(url) => {
          setApiBaseUrl(url);
          localStorage.setItem('nash_sim_api_base', url);
        }}
      />

      <DownloadModal
        isOpen={isDownloadModalOpen}
        onClose={() => setIsDownloadModalOpen(false)}
      />

      {isAdminOpen && (
        <AdminDashboard
          onClose={() => setIsAdminOpen(false)}
          isDark={darkMode}
          isElectron={isElectron}
          apiBaseUrl={apiBaseUrl}
        />
      )}

      {/* Bottom-left feedback launcher. Hidden during the tour: it floats over
          the corner of the plot the spotlight keeps landing on, and a stray
          call-to-action inside a guided walkthrough reads as part of the tour. */}
      {!tourOpen && (
      <button
        onClick={openFeedback}
        title="Send feedback"
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 px-3.5 py-2.5 rounded-full bg-accent-600 hover:bg-accent-700 text-white text-xs font-semibold shadow-lg shadow-accent-600/20 transition-all cursor-pointer select-none"
      >
        <MessageSquare className="w-4 h-4" />
        <span className="hidden sm:inline">Feedback</span>
      </button>
      )}

      {isFeedbackOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none"
          onClick={closeFeedback}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Send feedback"
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-xl animate-modal-in">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-accent-50 dark:bg-accent-950/40 text-accent-600 rounded-lg">
                  <MessageSquare className="w-4 h-4" />
                </span>
                <span className="font-bold text-slate-800 dark:text-slate-100 text-sm md:text-base">
                  Send Feedback
                </span>
              </div>
              <button
                onClick={closeFeedback}
                aria-label="Close dialog" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {feedbackSuccess ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <span className="p-2.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 rounded-full">
                  <CheckCircle2 className="w-7 h-7" />
                </span>
                <p className="text-sm text-slate-700 dark:text-slate-200 font-medium px-2">{feedbackSuccess}</p>
                <button
                  onClick={closeFeedback}
                  className="mt-1 bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs py-2 px-5 rounded-xl transition-all cursor-pointer"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                {feedbackError && (
                  <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-300 text-xs rounded-xl p-3 flex gap-2 font-medium">
                    <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                    <span>{feedbackError}</span>
                  </div>
                )}

                <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Share any questions, concerns, or ideas. Your email is optional — leave it blank to send anonymously.
                </p>

                <form onSubmit={handleFeedbackSubmit} className="flex flex-col gap-3.5">
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1.5">Rating <span className="font-normal text-slate-400">(optional)</span></label>
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setFeedbackRating(n === feedbackRating ? 0 : n)}
                          onMouseEnter={() => setFeedbackHoverRating(n)}
                          onMouseLeave={() => setFeedbackHoverRating(0)}
                          className="p-0.5 cursor-pointer"
                          aria-label={`${n} star${n > 1 ? 's' : ''}`}
                        >
                          <Star
                            className={`w-6 h-6 transition-colors ${
                              n <= (feedbackHoverRating || feedbackRating)
                                ? 'text-amber-400 fill-amber-400'
                                : 'text-slate-300 dark:text-slate-600'
                            }`}
                          />
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Your feedback</label>
                    <textarea
                      className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 h-28 resize-none text-slate-800 dark:text-slate-200"
                      placeholder="Questions, concerns, or feedback…"
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      maxLength={5000}
                      autoFocus
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Email <span className="font-normal text-slate-400">(optional — for a reply)</span></label>
                    <input
                      type="email"
                      className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                      placeholder="you@example.com (leave blank to stay anonymous)"
                      value={feedbackEmail}
                      onChange={(e) => setFeedbackEmail(e.target.value)}
                    />
                  </div>

                  <div className="flex gap-2 justify-end border-t border-slate-100 dark:border-slate-800 pt-3.5">
                    <button
                      type="button"
                      onClick={closeFeedback}
                      className="px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={feedbackLoading}
                      className="flex items-center gap-1.5 bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs py-2 px-4 rounded-xl transition-all shadow-xs cursor-pointer disabled:opacity-50"
                    >
                      <Send className="w-3.5 h-3.5" />
                      {feedbackLoading ? 'Sending…' : 'Send Feedback'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { GamePayoffs, SimState, PresetGame, NashEquilibrium, PathSegment } from './types';
import {
  PRESETS,
  EA,
  EB,
  r3,
  computeAllNE,
  doStep,
  buildPolyStr,
} from './utils/gameEngine';
import { PlotlyView } from './components/PlotlyView';
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
  Send
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
  allNE: NashEquilibrium[], committedNE: NashEquilibrium | null
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
    doStep(payoffs, state, firstMover, shrinkStep, allNE, committedNE, () => {}, () => {}, () => { state.running = false; });
    snaps.push(toThin(state));
    if (neState === null && state.discoveredMixedX !== null) {
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
  allNE: NashEquilibrium[], committedNE: NashEquilibrium | null
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
    doStep(payoffs, state, firstMover, shrinkStep, allNE, committedNE, () => {}, () => {}, () => { state.running = false; });
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
  const [saveError, setSaveError] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);

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

  // Auto-scroll the logs browser to the bottom on new entries
  useEffect(() => {
    const container = logsContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [logEntries]);

  // ── Memoized Nash Equilibria ───────────────────────────────────────────────
  const allNE = useMemo<NashEquilibrium[]>(() => {
    return computeAllNE(payoffs);
  }, [payoffs]);

  const indifferenceStatus = useMemo(() => {
    const aIndifferent = payoffs.a11 === payoffs.a21 && payoffs.a12 === payoffs.a22;
    const bIndifferent = payoffs.b11 === payoffs.b12 && payoffs.b21 === payoffs.b22;
    return {
      aIndifferent,
      bIndifferent,
      any: aIndifferent || bIndifferent,
      both: aIndifferent && bIndifferent
    };
  }, [payoffs]);

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
        domainLo: 0, domainHi: 1, cycleCount: 0,
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
      const { snaps, neState } = precomputeThinHistory(initState, payoffs, firstMover, shrinkStep, allNE, committedNE);
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
        (msg) => stepLogs.push(msg), () => {}, () => { next.running = false; });
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
      (msg) => stepLogs.push(msg), () => {}, () => { next.running = false; });

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
        (msg) => stepLogs.push(msg), () => {}, () => { next.running = false; });
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

  const handleSaveGameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!saveName.trim()) {
      setSaveError('Please enter a game name.');
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
          payoffs
        })
      });
      const data = await res.json();
      if (res.ok) {
        setUserCustomGames(prev => [...prev, data.game]);
        setActivePreset(data.game.id);
        setIsSaveModalOpen(false);
        setSaveName('');
        setSaveDesc('');
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
      else if (isAuthModalOpen) { setIsAuthModalOpen(false); setAuthError(''); setAuthSuccess(''); }
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
        desc: `<strong>Custom - ${g.name}:</strong> ${g.description}`
      };
    });
    return merged;
  }, [userCustomGames]);

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
    thinHistoryRef.current = [];
    scrubPosRef.current = 0;
    initStateRef.current = null;
    neSnapshotRef.current = null;
    setThinHistory([]);
    setNeSnapshot(null);
    setJumpInput('');
  };

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

  // ── Trajectory Backstep ───────────────────────────────────────────────────
  const handleBackstep = () => {
    if (simState.running || !initStateRef.current || simState.stepCount <= 0) return;
    const targetStep = simState.stepCount - 1;
    const replayed = replayToStep(initStateRef.current, targetStep, payoffs, firstMover, shrinkStep, allNE, committedNE);
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

  // ── Step-input Jump ────────────────────────────────────────────────────────
  const handleJump = () => {
    if (!initStateRef.current || thinHistoryRef.current.length === 0) return;
    const parsed = parseInt(jumpInput, 10);
    if (isNaN(parsed)) return;
    const clamped = Math.max(0, Math.min(thinHistoryRef.current.length - 1, parsed));
    const replayed = replayToStep(initStateRef.current, clamped, payoffs, firstMover, shrinkStep, allNE, committedNE);
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
  // Lives under the Game-Theoretic Report (filling the right column) until the
  // simulation converges; then it moves to a full-width band beneath both
  // columns, where the equilibrium report needs the extra vertical room.
  const simulationLogPanel = (
    <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col gap-3 text-slate-200">
      <span className="text-xs uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-1.5">
        <Terminal className="w-4 h-4 text-emerald-400" />
        Simulation Log
      </span>
      <div ref={logsContainerRef} className={`w-full overflow-y-auto bg-slate-950/70 border border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-300 space-y-1 block leading-relaxed select-text ${simState.converged ? 'h-44' : 'h-80'}`}>
        {logEntries.map((line, idx) => {
          let colClass = 'text-slate-300';
          if (line.includes('✓')) {
            colClass = 'text-emerald-400 font-semibold';
          } else if (line.includes('↺')) {
            if (line.includes('Ghost cycle')) {
              if (line.includes('(A)')) {
                colClass = 'text-rose-300 font-medium';
              } else if (line.includes('(B)')) {
                colClass = 'text-player-b-300 font-medium';
              } else {
                colClass = 'text-amber-300 font-medium';
              }
            } else {
              colClass = 'text-amber-400 font-semibold';
            }
          } else if (line.includes('━━') || line.includes('Start')) {
            colClass = 'text-accent-400 font-semibold';
          } else if (line.includes('(A)')) {
            colClass = 'text-player-a-400 font-semibold';
          } else if (line.includes('(B)')) {
            colClass = 'text-player-b-400 font-semibold';
          }
          return (
            <p key={idx} className={colClass}>
              {line}
            </p>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col antialiased">
      {/* ── Heading Banner ── */}
      <header
        className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30 shadow-subtle"
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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(['bos', 'pd', 'cnr', 'spy'] as const).map((key) => {
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
            {mergedPresets[activePreset]?.desc && (
              <div
                className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-900/45 rounded-xl p-3"
                dangerouslySetInnerHTML={{ __html: mergedPresets[activePreset].desc }}
              />
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

            <div className="grid grid-cols-[auto_1fr_1fr] gap-3 text-center items-center">
              <div className="text-xs font-bold text-slate-400 dark:text-slate-500 pr-2 text-left">Tactics</div>
              <div className="text-xs font-bold text-player-b-600 dark:text-player-b-400">B: Col 1</div>
              <div className="text-xs font-bold text-player-b-600 dark:text-player-b-400">B: Col 2</div>

              {/* Row 1 inputs */}
              <div className="text-xs font-bold text-player-a-500 text-left pr-2">A: Row 1</div>
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
              <div className="text-xs font-bold text-player-a-500 text-left pr-2">A: Row 2</div>
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
          <div className="bg-slate-900 text-slate-100 p-5 rounded-2xl shadow-sm flex flex-col gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Expected-Payoff Functions
            </span>
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex items-center gap-2 bg-slate-800/50 px-3 py-2.5 rounded-lg border border-slate-800">
                <MathTex tex="\mathbb{E}[A]" className="text-player-a-400" />
                <MathTex tex={`= ${eqAStr}`} className="text-slate-200" />
              </div>
              <div className="flex items-center gap-2 bg-slate-800/50 px-3 py-2.5 rounded-lg border border-slate-800">
                <MathTex tex="\mathbb{E}[B]" className="text-player-b-400" />
                <MathTex tex={`= ${eqBStr}`} className="text-slate-200" />
              </div>
            </div>
            <span className="text-xs text-slate-400">
              <MathTex tex="x = P(\text{A plays Row 1}), \quad y = P(\text{B plays Col 1})" />
            </span>
          </div>

          {/* Configuration Parameters Panel */}
          <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-4">
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

            {/* Domain Shrink Value */}
            <div>
              <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 font-medium mb-1">
                <span>Initial Domain Shrink Step Size</span>
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
                Sets how much the search corridor contracts per detected cycle; switches to bisection method when a Player overshoots a mixed equilibrium coordinate.
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
            allNE={allNE}
            isDark={darkMode}
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
          <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-4">

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
          <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300 h-fit">
            <div className="text-slate-800 dark:text-slate-100 font-semibold text-sm border-b border-rose-100/50 dark:border-slate-800 pb-2 flex items-center gap-1.5">
              <Compass className="w-4 h-4 text-emerald-500" />
              Game-Theoretic Report
            </div>

            <div className="space-y-3">
              <div>
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
            </div>
          </div>

          {/* Log sits in the right column until convergence frees up the bottom */}
          {!simState.converged && simulationLogPanel}
        </div>

        {/* Once converged, the log spans full width beneath both columns */}
        {simState.converged && (
          <div className="lg:col-span-12">
            {simulationLogPanel}
          </div>
        )}
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 py-4 px-6 text-center">
        <p className="text-xs text-slate-400 dark:text-slate-500">© 2026 Daniel Luan</p>
      </footer>

      {isAuthModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none"
          onClick={() => { setIsAuthModalOpen(false); setAuthError(''); setAuthSuccess(''); }}
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
            className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-xl animate-modal-in">
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
              <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-300 text-xs rounded-xl p-3 flex gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                <span>{saveError}</span>
              </div>
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
                  maxLength={250}
                />
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

      {/* Bottom-left feedback launcher */}
      <button
        onClick={openFeedback}
        title="Send feedback"
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 px-3.5 py-2.5 rounded-full bg-accent-600 hover:bg-accent-700 text-white text-xs font-semibold shadow-lg shadow-accent-600/20 transition-all cursor-pointer select-none"
      >
        <MessageSquare className="w-4 h-4" />
        <span className="hidden sm:inline">Feedback</span>
      </button>

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
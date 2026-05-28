/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useEffect, useRef } from 'react';
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
  BookOpen,
  Sliders,
  Award,
  Terminal,
  Compass,
  CheckCircle2,
  Lock,
  AlertTriangle
} from 'lucide-react';

export default function App() {
  // ── Preset Selector State ──────────────────────────────────────────────────
  const [activePreset, setActivePreset] = useState<string>('bos');

  // ── Payoff Values State ────────────────────────────────────────────────────
  const [payoffs, setPayoffs] = useState<GamePayoffs>({
    a11: 2, b11: 1,  a12: 0, b12: 0,
    a21: 0, b21: 0,  a22: 1, b22: 5,
  });

  const [rawPayoffs, setRawPayoffs] = useState<Record<keyof GamePayoffs, string>>({
    a11: '2', b11: '1',  a12: '0', b12: '0',
    a21: '0', b21: '0',  a22: '1', b22: '5',
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
  const [shrinkStep, setShrinkStep] = useState<number>(0.010);
  const [speed, setSpeed] = useState<number>(5);

  // Initial Coordinates States
  const [x0, setX0] = useState<string>('0.217');
  const [y0, setY0] = useState<string>('0.217');

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
    pathSegmentsA: [{ xs: [0.217], ys: [0.217], zs: [r3(EA(0.217, 0.217, {
      a11: 2, b11: 1,  a12: 0, b12: 0,
      a21: 0, b21: 0,  a22: 1, b22: 5,
    }))], mover: 'A' }],
    pathSegmentsB: [{ xs: [0.217], ys: [0.217], zs: [r3(EB(0.217, 0.217, {
      a11: 2, b11: 1,  a12: 0, b12: 0,
      a21: 0, b21: 0,  a22: 1, b22: 5,
    }))], mover: 'A' }],
    ghostPathSegmentsA: [],
    ghostPathSegmentsB: [],
    historyStack: []
  });

  const [logEntries, setLogEntries] = useState<string[]>([
    'Set starting point and first mover, then click Run or Step.'
  ]);

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
  const handleStep = () => {
    let currentReady = simState;

    if (!initialized) {
      const startValX = Math.max(0, Math.min(1, parseFloat(x0) || 0.217));
      const startValY = Math.max(0, Math.min(1, parseFloat(y0) || 0.217));

      const initSegA = { xs: [startValX], ys: [startValY], zs: [r3(EA(startValX, startValY, payoffs))], mover: 'A' as const };
      const initSegB = { xs: [startValX], ys: [startValY], zs: [r3(EB(startValX, startValY, payoffs))], mover: 'A' as const };

      setInitialized(true);
      setLogEntries([`Start (${startValX.toFixed(3)}, ${startValY.toFixed(3)}) — Player ${firstMover} moves first`]);

      currentReady = {
        ...simState,
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
        converged: false,
        stepCount: 0,
        pathSegmentsA: [initSegA],
        pathSegmentsB: [initSegB],
        ghostPathSegmentsA: [],
        ghostPathSegmentsB: [],
        historyStack: []
      };
    }

    if (currentReady.converged) return;

    // Deep clone working state
    const next: SimState = {
      ...currentReady,
      visitedPositions: [...currentReady.visitedPositions],
      ghostVisitedPositions: [...currentReady.ghostVisitedPositions],
      pathSegmentsA: currentReady.pathSegmentsA.map((seg): PathSegment => ({ ...seg, xs: [...seg.xs], ys: [...seg.ys], zs: [...seg.zs] })),
      pathSegmentsB: currentReady.pathSegmentsB.map((seg): PathSegment => ({ ...seg, xs: [...seg.xs], ys: [...seg.ys], zs: [...seg.zs] })),
      ghostPathSegmentsA: currentReady.ghostPathSegmentsA.map((seg): PathSegment => ({ ...seg, xs: [...seg.xs], ys: [...seg.ys], zs: [...seg.zs] })),
      ghostPathSegmentsB: currentReady.ghostPathSegmentsB.map((seg): PathSegment => ({ ...seg, xs: [...seg.xs], ys: [...seg.ys], zs: [...seg.zs] })),
      historyStack: [...currentReady.historyStack]
    };

    const logsCollected: string[] = [];

    doStep(
      payoffs,
      next,
      firstMover,
      shrinkStep,
      allNE,
      committedNE,
      (msg) => {
        logsCollected.push(msg);
      },
      () => {}, // Ghost cycle triggers
      () => {
        // Convergence callback
        next.running = false;
      }
    );

    setSimState(next);

    if (logsCollected.length > 0) {
      setLogEntries((prevLogs: string[]) => {
        let updated = [...prevLogs];
        if (updated.length === 1 && updated[0].startsWith('Set starting')) {
          updated = [];
        }
        return [...updated, ...logsCollected];
      });
    }
  };

  // Recursive play runner trigger
  useEffect(() => {
    if (!simState.running || simState.converged) return;

    const intervalMs = Math.max(30, Math.round(550 / speed));
    const timer = setTimeout(() => {
      handleStep();
    }, intervalMs);

    return () => clearTimeout(timer);
  }, [simState.running, simState.converged, simState.stepCount, speed]);

  // ── Preset loader action ───────────────────────────────────────────────────
  const handleLoadPreset = (key: string) => {
    setActivePreset(key);
    if (key !== 'custom') {
      const preset = PRESETS[key];
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
      ghostPathSegmentsA: [],
      ghostPathSegmentsB: [],
      historyStack: []
    });

    setLogEntries(['Set starting point and first mover, then click Run or Step.']);
    setInitialized(false);
  };

  // ── Play/Pause toggle ──────────────────────────────────────────────────────
  const togglePlay = () => {
    if (simState.converged) {
      setLogEntries(prev => [...prev, '✓ Equilibrium reached. Choose Reset to restart.']);
      return;
    }
    setSimState((prev: SimState) => ({ ...prev, running: !prev.running }));
  };

  // ── Trajectory Backstep pop ────────────────────────────────────────────────
  const handleBackstep = () => {
    if (simState.historyStack.length === 0 || simState.running) return;
    
    setSimState((prev: SimState) => {
      const history = [...prev.historyStack];
      const prevSnap = history.pop();
      if (!prevSnap) return prev;

      setLogEntries((prevLogs: string[]) => [...prevLogs, `⏮ Stepped back to step ${prevSnap.stepCount}`]);

      return {
        ...prevSnap,
        running: false,
        historyStack: history
      } as SimState;
    });
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

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col antialiased">
      {/* ── Heading Banner ── */}
      <header className="bg-white border-b border-slate-200 py-5 px-6 sticky top-0 z-30 shadow-xs">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="p-2 bg-red-50 text-red-600 rounded-lg">
                <Compass className="w-6 h-6" />
              </span>
              <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">
                Nash Equilibrium Simulator
              </h1>
            </div>
            <p className="text-xs md:text-sm text-slate-500 mt-1">
              Visualise Best-Response dynamics, 3D expected payoff surfaces, and mixed strategy search corridor shrinkage algorithms.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-slate-400 bg-slate-100 py-1 px-2.5 rounded-md">
              Vite | TS
            </span>
            {simState.converged && (
              <span className="flex items-center gap-1 text-xs font-medium bg-emerald-100 text-emerald-800 py-1 px-3 rounded-full border border-emerald-200">
                <CheckCircle2 className="w-3.5 h-3.5" /> Converged
              </span>
            )}
          </div>
        </div>
      </header>

      {/* ── Main Layout Body ── */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* ── Left Sidebar Settings Panel (5 cols) ── */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          
          {/* Preset Buttons Block */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
            <div className="flex items-center gap-2 text-slate-800 font-semibold text-sm border-b border-slate-100 pb-2">
              <BookOpen className="w-4 h-4 text-rose-500" />
              Preset Game Scenarios
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2">
              {(['bos', 'pd', 'cnr', 'spy', 'custom'] as const).map((key) => {
                const isSelected = activePreset === key;
                return (
                  <button
                    key={key}
                    onClick={() => handleLoadPreset(key)}
                    className={`py-2 px-3 text-xs font-medium rounded-xl border transition-all text-center ${
                      isSelected
                        ? 'bg-rose-500 text-white border-rose-500 shadow-xs'
                        : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    {PRESETS[key].name}
                  </button>
                );
              })}
            </div>

            {/* Selected Preset Narrative Card */}
            {PRESETS[activePreset]?.desc && (
              <div
                className="text-xs text-slate-600 leading-relaxed bg-amber-50/50 border border-amber-200/50 rounded-xl p-3"
                dangerouslySetInnerHTML={{ __html: PRESETS[activePreset].desc }}
              />
            )}
          </div>

          {/* Payoff Matrix Editor Block */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <div className="flex items-center gap-2 text-slate-800 font-semibold text-sm">
                <Sliders className="w-4 h-4 text-blue-500" />
                Payoff Settings Grid — (
                <span className="text-red-500 font-semibold font-mono">A</span>,{' '}
                <span className="text-blue-600 font-semibold font-mono">B</span>)
              </div>
              <span className="text-[10px] text-slate-400 font-mono">Range: [-100, 100]</span>
            </div>

            <div className="grid grid-cols-[auto_1fr_1fr] gap-3 text-center items-center">
              <div className="text-xs font-bold text-slate-400 pr-2 text-left">Tactics</div>
              <div className="text-xs font-bold text-blue-600">B: Col 1</div>
              <div className="text-xs font-bold text-blue-600">B: Col 2</div>

              {/* Row 1 inputs */}
              <div className="text-xs font-bold text-red-500 text-left pr-2">A: Row 1</div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 rounded-xl p-1.5 bg-slate-50 focus-within:ring-2 focus-within:ring-blue-100 focus-within:border-slate-300 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.a11}
                  onChange={(e) => updatePayoffField('a11', e.target.value)}
                  onBlur={() => handlePayoffBlur('a11')}
                  className="w-full min-w-0 text-center font-mono font-medium text-red-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.b11}
                  onChange={(e) => updatePayoffField('b11', e.target.value)}
                  onBlur={() => handlePayoffBlur('b11')}
                  className="w-full min-w-0 text-center font-mono font-medium text-blue-600 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 rounded-xl p-1.5 bg-slate-50 focus-within:ring-2 focus-within:ring-blue-100 focus-within:border-slate-300 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.a12}
                  onChange={(e) => updatePayoffField('a12', e.target.value)}
                  onBlur={() => handlePayoffBlur('a12')}
                  className="w-full min-w-0 text-center font-mono font-medium text-red-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.b12}
                  onChange={(e) => updatePayoffField('b12', e.target.value)}
                  onBlur={() => handlePayoffBlur('b12')}
                  className="w-full min-w-0 text-center font-mono font-medium text-blue-600 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>

              {/* Row 2 inputs */}
              <div className="text-xs font-bold text-red-500 text-left pr-2">A: Row 2</div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 rounded-xl p-1.5 bg-slate-50 focus-within:ring-2 focus-within:ring-blue-100 focus-within:border-slate-300 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.a21}
                  onChange={(e) => updatePayoffField('a21', e.target.value)}
                  onBlur={() => handlePayoffBlur('a21')}
                  className="w-full min-w-0 text-center font-mono font-medium text-red-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.b21}
                  onChange={(e) => updatePayoffField('b21', e.target.value)}
                  onBlur={() => handlePayoffBlur('b21')}
                  className="w-full min-w-0 text-center font-mono font-medium text-blue-600 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 rounded-xl p-1.5 bg-slate-50 focus-within:ring-2 focus-within:ring-blue-100 focus-within:border-slate-300 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.a22}
                  onChange={(e) => updatePayoffField('a22', e.target.value)}
                  onBlur={() => handlePayoffBlur('a22')}
                  className="w-full min-w-0 text-center font-mono font-medium text-red-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.-]*"
                  value={rawPayoffs.b22}
                  onChange={(e) => updatePayoffField('b22', e.target.value)}
                  onBlur={() => handlePayoffBlur('b22')}
                  className="w-full min-w-0 text-center font-mono font-medium text-blue-600 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>
            </div>
          </div>

          {/* Expected math formulations */}
          <div className="bg-slate-900 text-slate-100 p-5 rounded-2xl shadow-sm flex flex-col gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Polynomial Payoff Equations
            </span>
            <div className="flex flex-col gap-2 font-mono text-xs">
              <div className="flex items-center gap-1.5 bg-slate-800/50 p-2.5 rounded-lg border border-slate-800">
                <span className="text-red-400 font-bold">E[A]</span>
                <span className="text-slate-400">=</span>
                <span className="text-slate-300">{eqAStr}</span>
              </div>
              <div className="flex items-center gap-1.5 bg-slate-800/50 p-2.5 rounded-lg border border-slate-800">
                <span className="text-blue-400 font-bold">E[B]</span>
                <span className="text-slate-400">=</span>
                <span className="text-slate-300">{eqBStr}</span>
              </div>
            </div>
            <span className="text-[10px] text-slate-500 font-mono">
              x = P(A handles Row 1), &nbsp;y = P(B handles Col 1)
            </span>
          </div>

          {/* Configuration Parameters Panel */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
            <div className="text-slate-800 font-semibold text-sm border-b border-slate-100 pb-2 pb-2">
              Simulation Coordinates & Parameters
            </div>

            {/* Starting coordinate fields */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-red-500 font-semibold mb-1">Row Start Point (x₀)</label>
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
                  className="w-full font-mono text-sm bg-slate-50 border border-slate-200 p-2 rounded-xl focus:ring-rose-200 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-blue-600 font-semibold mb-1">Col Start Point (y₀)</label>
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
                  className="w-full font-mono text-sm bg-slate-50 border border-slate-200 p-2 rounded-xl focus:ring-blue-100 focus:outline-none"
                />
              </div>
            </div>

            {/* Who moves first choice */}
            <div>
              <label className="block text-xs text-slate-600 font-medium mb-1.5">Who moves first?</label>
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
                      className={`py-2 px-3 text-xs font-semibold rounded-xl border transition-all ${
                        active
                          ? player === 'A'
                            ? 'bg-red-500 text-white border-red-500'
                            : 'bg-blue-600 text-white border-blue-600'
                          : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
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
              <label className="block text-xs text-slate-600 font-medium mb-1.5">Expected Payoff Surface Tracking</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['A', 'B', 'both'] as const).map((m) => {
                  const active = trackingMode === m;
                  return (
                    <button
                      key={m}
                      onClick={() => setTrackingMode(m)}
                      className={`py-2 px-1 text-[10px] md:text-xs font-semibold rounded-xl border transition-all text-center ${
                        active
                          ? m === 'A'
                            ? 'bg-red-500 text-white border-red-500'
                            : m === 'B'
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-purple-600 text-white border-purple-600'
                          : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
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
              <div className="flex items-center justify-between text-xs text-slate-600 font-medium mb-1">
                <span>Initial Domain Shrink Step Size</span>
                <span className="font-mono font-semibold text-rose-500">{shrinkStep.toFixed(3)}</span>
              </div>
              <input
                type="range"
                min="0.001"
                max="0.030"
                step="0.001"
                value={shrinkStep}
                onChange={(e) => setShrinkStep(parseFloat(e.target.value))}
                className="w-full accent-rose-500 h-1 bg-slate-100 rounded-lg appearance-none cursor-pointer"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                Shrinking step near equilibrium converges automatically to 0.001.
              </span>
            </div>
          </div>
        </div>

        {/* ── Right Panel Simulation Console & Plots (7 cols) ── */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          
          {/* Plot Legend Info Line */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 items-center text-[10px] text-slate-500 justify-center lg:justify-start">
            <span className="flex items-center gap-1">🔴 E[A] Surface</span>
            <span className="flex items-center gap-1">🔵 E[B] Surface</span>
            <span className="flex items-center gap-1 text-red-500 font-medium">─ A Moves</span>
            <span className="flex items-center gap-1 text-blue-600 font-medium">─ B Moves</span>
            <span className="flex items-center gap-1 text-slate-700 font-medium">⚫ Pure NE</span>
            <span className="flex items-center gap-1 text-purple-600 font-bold">🟣 Mixed NE</span>
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
          />

          {/* Simulation Controls Dashboard */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
            
            {/* Play trigger buttons row */}
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <button
                  onClick={togglePlay}
                  className={`flex items-center gap-1.5 py-2 px-5 text-sm font-semibold rounded-xl text-white transition-all shadow-xs ${
                    simState.running
                      ? 'bg-yellow-500 hover:bg-yellow-600'
                      : 'bg-indigo-600 hover:bg-indigo-700'
                  }`}
                >
                  {simState.running ? (
                    <>
                      <Pause className="w-4 h-4 fill-white" /> Pause
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-white" /> Run
                    </>
                  )}
                </button>

                <button
                  onClick={handleStep}
                  disabled={simState.running || simState.converged}
                  className="flex items-center gap-1.5 py-2 px-4 text-sm font-semibold rounded-xl border border-slate-200 text-indigo-600 bg-indigo-50/50 hover:bg-indigo-50 transition-all disabled:opacity-50 disabled:bg-slate-50 disabled:text-slate-400 disabled:border-slate-200"
                >
                  <SkipForward className="w-4 h-4" /> Step
                </button>

                <button
                  onClick={handleBackstep}
                  disabled={simState.running || simState.historyStack.length === 0}
                  className="flex items-center gap-1 py-2 px-3 text-sm font-medium rounded-xl border border-slate-300 text-slate-600 hover:bg-slate-50 transition-all disabled:opacity-40"
                >
                  <ChevronLeft className="w-4 h-4" /> Back
                </button>

                <button
                  onClick={handleReset}
                  className="flex items-center gap-1 py-2 px-3 text-sm font-medium rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 transition-all"
                >
                  <RotateCcw className="w-4 h-4" /> Reset
                </button>
              </div>

              {/* Speed slider */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 font-medium">Loop Speed</span>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={speed}
                  onChange={(e) => setSpeed(parseInt(e.target.value))}
                  className="w-20 accent-indigo-600 h-1 bg-slate-100 rounded-lg appearance-none cursor-pointer"
                />
                <span className="text-xs font-mono text-slate-400 font-semibold">{speed}x</span>
              </div>
            </div>

            {/* Realtime coordinates outputs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                <span className="text-[10px] text-red-500 font-bold uppercase block tracking-wider">
                  x: P(A playing Row 1)
                </span>
                <span className="text-sm font-bold text-slate-800 font-mono">
                  {simState.cx.toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                <span className="text-[10px] text-blue-600 font-semibold uppercase block tracking-wider">
                  y: P(B playing Col 1)
                </span>
                <span className="text-sm font-bold text-slate-800 font-mono">
                  {simState.cy.toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                <span className="text-[10px] text-slate-500 uppercase block tracking-wider">
                  Expected Payoff E[A]
                </span>
                <span className="text-sm font-bold text-red-500 font-mono">
                  {r3(EA(simState.cx, simState.cy, payoffs)).toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                <span className="text-[10px] text-slate-500 uppercase block tracking-wider">
                  Expected Payoff E[B]
                </span>
                <span className="text-sm font-bold text-blue-600 font-mono">
                  {r3(EB(simState.cx, simState.cy, payoffs)).toFixed(3)}
                </span>
              </div>
            </div>
          </div>

          {/* Converged banner card */}
          {simState.converged && nearestNE && (
            <div className={`p-5 rounded-2xl border flex flex-col gap-3 shadow-xs animate-fade-in ${
              nearestNE.type === 'mixed'
                ? 'bg-purple-50 border-purple-200'
                : 'bg-emerald-50 border-emerald-200'
            }`}>
              <div className="flex items-center gap-2">
                <span className={`p-1.5 rounded-lg ${
                  nearestNE.type === 'mixed' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'
                }`}>
                  <Award className="w-5 h-5" />
                </span>
                <span className={`text-sm font-bold uppercase tracking-wider ${
                  nearestNE.type === 'mixed' ? 'text-purple-900' : 'text-emerald-900'
                }`}>
                  {nearestNE.type === 'mixed' ? 'Mixed' : 'Pure'} Strategy Nash Equilibrium Reached
                </span>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 py-3 bg-white/75 px-4 rounded-xl border border-slate-100 text-xs shadow-3xs">
                <span>
                  x* = <strong className="text-red-500 font-mono">{simState.cx.toFixed(3)}</strong>
                </span>
                <span>
                  y* = <strong className="text-blue-600 font-mono">{simState.cy.toFixed(3)}</strong>
                </span>
                <span>
                  Payoff E[A] = <strong className="text-slate-800 font-mono">{r3(EA(simState.cx, simState.cy, payoffs)).toFixed(3)}</strong>
                </span>
                <span>
                  Payoff E[B] = <strong className="text-slate-800 font-mono">{r3(EB(simState.cx, simState.cy, payoffs)).toFixed(3)}</strong>
                </span>
              </div>

              <div className="bg-white/50 p-3.5 rounded-xl border border-slate-100 text-xs font-mono text-slate-600 space-y-1">
                {nearestNE.type === 'mixed' ? (
                  <>
                    <div>A Indifferent: E[Row1]={r3(simState.cy * payoffs.a11 + (1 - simState.cy) * payoffs.a12).toFixed(3)} &asymp; E[Row2]={r3(simState.cy * payoffs.a21 + (1 - simState.cy) * payoffs.a22).toFixed(3)}</div>
                    <div>B Indifferent: E[Col1]={r3(simState.cx * payoffs.b11 + (1 - simState.cx) * payoffs.b21).toFixed(3)} &asymp; E[Col2]={r3(simState.cx * payoffs.b12 + (1 - simState.cx) * payoffs.b22).toFixed(3)}</div>
                    <div className="text-[10px] text-slate-400 mt-2 font-sans font-medium">
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
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-3 text-xs leading-relaxed text-slate-600 h-fit">
            <div className="text-slate-800 font-semibold text-sm border-b border-rose-100/50 pb-2 flex items-center gap-1.5">
              <Compass className="w-4 h-4 text-emerald-500" />
              Game Theorist Situation Report
            </div>
            
            <div className="space-y-3">
              <div>
                <strong className="text-slate-700">Calculated Nash Equilibria:</strong>
                <ul className="list-disc pl-5 mt-1 text-slate-600 space-y-1">
                  {allNE.map((ne, idx) => (
                    <li key={idx}>
                      <span className={`font-semibold ${ne.type === 'mixed' ? 'text-purple-600' : 'text-slate-800'}`}>
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
                <div className="bg-amber-50/70 border border-amber-200/50 rounded-xl p-3.5 text-[11px] text-amber-800 space-y-1.5 shadow-sm leading-relaxed">
                  <div className="font-semibold flex items-center gap-1.5 text-amber-900">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
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

              <div className="text-slate-500">
                {pureNEs.length === 0 && mixedNE ? (
                  <p>
                    No pure strategy NE coordinates exist. The best-response trajectory forms stable cyclic loops, letting our domain-shrinking algorithm narrow down the search corridor boundaries until they safely contract and lock directly onto the <strong className="text-purple-600 font-bold">Mixed NE</strong>.
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
                      <p className="font-semibold text-emerald-700 bg-emerald-50/50 rounded-xl p-2.5 border border-emerald-100">
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
                      Over time, any best-response steps from outer starting sectors migrate away from the mixed NE and lock into the <strong className="text-slate-800 font-medium">{pureNEs[0].label}</strong>.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* Execution details logger browser */}
          <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col gap-3 text-slate-200">
            <span className="text-xs uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-1.5">
              <Terminal className="w-4 h-4 text-emerald-400" />
              Real-time Output Console Logs
            </span>
            <div ref={logsContainerRef} className="w-full h-44 overflow-y-auto bg-slate-950/70 border border-slate-800 rounded-xl p-4 font-mono text-[10px] md:text-xs text-slate-300 space-y-1 block leading-relaxed select-text">
              {logEntries.map((line, idx) => {
                let colClass = 'text-slate-300';
                if (line.includes('✓')) {
                  colClass = 'text-emerald-400 font-semibold';
                } else if (line.includes('↺')) {
                  if (line.includes('Ghost cycle')) {
                    if (line.includes('(A)')) {
                      colClass = 'text-rose-300 font-medium';
                    } else if (line.includes('(B)')) {
                      colClass = 'text-blue-300 font-medium';
                    } else {
                      colClass = 'text-amber-300 font-medium';
                    }
                  } else {
                    colClass = 'text-amber-400 font-semibold';
                  }
                } else if (line.includes('━━') || line.includes('Start')) {
                  colClass = 'text-indigo-400 font-semibold';
                } else if (line.includes('(A)')) {
                  colClass = 'text-red-400 font-semibold';
                } else if (line.includes('(B)')) {
                  colClass = 'text-blue-400 font-semibold';
                }
                return (
                  <p key={idx} className={colClass}>
                    {line}
                  </p>
                );
              })}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}


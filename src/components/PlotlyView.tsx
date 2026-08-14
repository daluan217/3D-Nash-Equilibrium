/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { GamePayoffs, SimState, NashEquilibrium } from '../types';
import { buildSurfaces, makeTraces, plotLayout } from '../utils/plotting';
import { EA, EB, r3 } from '../utils/gameEngine';
import { Rotate3d, Move, RefreshCw } from 'lucide-react';

interface PlotlyViewProps {
  payoffs: GamePayoffs;
  simState: SimState;
  trackingMode: 'A' | 'B' | 'both';
  allNE: NashEquilibrium[];
  isDark?: boolean;
  stepMode?: 'shrink' | 'regret';
  /**
   * Outcomes the guided tour is currently describing, marked on both surfaces
   * with each player's payoff spelled out. A caption that says "three each" is
   * only convincing if the reader can see the three.
   */
  tourPoints?: { x: number; y: number; accent?: 'gold' | 'purple' }[];
  /**
   * Traces the guided tour wants switched off, by name, as if the viewer had
   * clicked them out in the legend.
   *
   * Per-step rather than a fixed set: the dilemma act hides the position dots
   * because nothing is running yet, and the step where only ONE player is
   * indifferent hides the other player's still-tilted strategy line, because a
   * second line on screen argues against the sentence being read.
   */
  hiddenTraces?: string[];
  /**
   * Slowly orbit the camera about the vertical axis while nothing is happening.
   *
   * A still 3D render reads as a flat picture; a slow turn is what tells a
   * reader the shape has depth, which is the entire premise of showing these
   * surfaces at all. Only while frozen — during a run the moving markers are
   * the thing to watch, and a turning camera would fight them.
   */
  idleSpin?: boolean;
  /**
   * Bumped whenever the tour advances. The spin restarts on every step, so
   * taking manual control of one step does not silence the rest of the tour.
   */
  spinNonce?: number;
}

/** Trace names the tour switches on and off. Kept here so the strings cannot
 *  drift apart from the ones plotting.ts actually assigns. */
export const TRACE = {
  startPoint: 'Starting Point',
  posA: 'Current position (A)',
  posB: 'Current position (B)',
  strategyA: 'A strategy line (E[A] at current y)',
  strategyB: 'B strategy line (E[B] at current x)',
} as const;

const DEFAULT_CAMERA = { eye: { x: 1.6, y: -1.6, z: 1.1 } };

/** The one plot on the page. Shared so the guided tour can steer the camera. */
export const PLOT_ID = 'plotly-3d-market-simulation';

export interface CameraPose {
  eye: { x: number; y: number; z: number };
  center?: { x: number; y: number; z: number };
}

/** Where the tour parks the camera. Scene coordinates are normalised about the
 *  cube's centre, so a `center` of ±0.35 leans toward a corner without leaving
 *  the box, and a shorter `eye` vector is what reads as "zoomed in". */
export const CAMERA: Record<string, CameraPose> = {
  overview:   { eye: { x: 1.6,  y: -1.6, z: 1.1 },  center: { x: 0, y: 0, z: 0 } },
  /** x = P(A plays Row 1) = 1 and y = P(B plays Col 1) = 1 — the top-left cell. */
  cornerRow1Col1: { eye: { x: 1.15, y: 1.15, z: 0.72 }, center: { x: 0.3, y: 0.3, z: 0 } },
  /** x = 0, y = 0 — the bottom-right cell. */
  cornerRow2Col2: { eye: { x: -1.2, y: -1.2, z: 0.7 }, center: { x: -0.3, y: -0.3, z: 0 } },
  // ── The mixed act sits MUCH closer than the dilemma act ──────────────────
  // At the full-square distance the interesting features -- the two surfaces
  // crossing, the equilibrium diamonds, the two position markers -- all collapse
  // into a few pixels of each other and read as one blob. These poses trade away
  // the corners, which the mixed story does not need, to buy separation between
  // the things it does.
  /** Opening the mixed act: closer than `overview`, still whole-surface. */
  mixedOpen:  { eye: { x: 0.95, y: -0.95, z: 0.58 }, center: { x: 0, y: 0, z: 0 } },
  /** Low and close, but not dead level — enough elevation to read an
   *  indifference line as flat against the surface it lies on. */
  edgeOn:     { eye: { x: 0.92, y: -0.92, z: 0.28 }, center: { x: 0, y: 0, z: 0 } },
  /** Right in on the crossing point, centred near an interior equilibrium. */
  interior:   { eye: { x: 0.60, y: -0.60, z: 0.34 }, center: { x: -0.18, y: -0.09, z: 0 } },
  /** Straight down: the corridor contracting is a 2D story seen from above. */
  topDown:    { eye: { x: 0.05, y: -0.05, z: 2.1 }, center: { x: 0, y: 0, z: 0 } },
};

/**
 * Glide the camera to a pose.
 *
 * Eased by hand rather than through Plotly.animate: animating a 3D scene camera
 * is not reliably supported across Plotly versions, and a dropped animation
 * would leave the tour describing a view the visitor never sees. Interpolating
 * and calling relayout each frame always works. Each relayout emits
 * plotly_relayout, which the component listens for, so its cameraRef stays in
 * step and the next Plotly.react will not snap the view back.
 */
let cameraAnim = 0;
/** True while a step glide is running, so the idle spin yields to it. */
let cameraBusy = false;

/**
 * Hand input back to Plotly after driving the camera.
 *
 * Setting `scene.camera` by relayout leaves the scene's own drag controller out
 * of step: the canvas still receives the mousedown, but Plotly's handler no
 * longer acts on it. Re-issuing the CURRENT dragmode re-binds it. Plotly.react
 * does not (measured), so this is not interchangeable with a normal redraw.
 */
export function rebindPlotInput(): void {
  const Plotly = (window as any).Plotly;
  const el = document.getElementById(PLOT_ID) as any;
  if (!Plotly || !el) return;
  const mode = el?._fullLayout?.scene?.dragmode ?? 'turntable';
  Plotly.relayout(el, { 'scene.dragmode': mode });
}

export function moveCamera(pose: CameraPose, duration = 900): void {
  const Plotly = (window as any).Plotly;
  const el = document.getElementById(PLOT_ID) as any;
  if (!Plotly || !el) return;

  const from = el?._fullLayout?.scene?.camera ?? DEFAULT_CAMERA;
  const f = { eye: { ...from.eye }, center: { ...(from.center ?? { x: 0, y: 0, z: 0 }) } };
  const t = { eye: pose.eye, center: pose.center ?? { x: 0, y: 0, z: 0 } };

  const rebindInput = () => { cameraBusy = false; rebindPlotInput(); };

  cancelAnimationFrame(cameraAnim);
  cameraBusy = true;
  // Respect a reduced-motion preference by jumping straight to the pose.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    Plotly.relayout(el, { 'scene.camera': t });
    rebindInput();
    return;
  }

  const t0 = performance.now();
  const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / duration);
    const e = ease(p);
    Plotly.relayout(el, {
      'scene.camera': {
        eye:    { x: lerp(f.eye.x, t.eye.x, e),       y: lerp(f.eye.y, t.eye.y, e),       z: lerp(f.eye.z, t.eye.z, e) },
        center: { x: lerp(f.center.x, t.center.x, e), y: lerp(f.center.y, t.center.y, e), z: lerp(f.center.z, t.center.z, e) },
      },
    });
    if (p < 1) cameraAnim = requestAnimationFrame(tick);
    else rebindInput();
  };
  cameraAnim = requestAnimationFrame(tick);
}

export const PlotlyView: React.FC<PlotlyViewProps> = ({
  payoffs,
  simState,
  trackingMode,
  allNE,
  isDark = false,
  stepMode = 'shrink',
  tourPoints = [],
  hiddenTraces = [],
  idleSpin = false,
  spinNonce = 0
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotId = PLOT_ID;
  const [dragMode, setDragMode] = useState<'turntable' | 'pan'>('turntable');
  const [uiRevision, setUiRevision] = useState<number>(0);
  const pinchStartDist = useRef<number | null>(null);
  const pinchStartEye = useRef<{x: number; y: number; z: number} | null>(null);
  // Tracks the camera the user has rotated to so Plotly.react never overrides it
  const cameraRef = useRef<any>(DEFAULT_CAMERA);
  /** Spin paused because the visitor took the wheel. Mirrored in a ref so the
   *  animation loop can read it without being torn down and rebuilt. */
  const [spinPaused, setSpinPaused] = useState(false);
  const spinPausedRef = useRef(false);
  const pauseSpin = () => {
    if (spinPausedRef.current) return;
    spinPausedRef.current = true;
    setSpinPaused(true);
    rebindPlotInput();
  };
  const resumeSpin = () => {
    spinPausedRef.current = false;
    setSpinPaused(false);
  };

  // Set up robust ResizeObserver to force Plotly bounds to sync with fluid flex columns
  useEffect(() => {
    const Plotly = (window as any).Plotly;
    if (!containerRef.current) return;

    const observer = new ResizeObserver(() => {
      if (Plotly && document.getElementById(plotId)) {
        Plotly.Plots.resize(plotId);
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, []);


  // Pinch-to-zoom: scale camera eye vector on two-finger pinch
  useEffect(() => {
    const el = document.getElementById(plotId);
    if (!el) return;

    const getDist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      pinchStartDist.current = getDist(e.touches);
      const Plotly = (window as any).Plotly;
      const plotEl = document.getElementById(plotId) as any;
      const eye = plotEl?._fullLayout?.scene?.camera?.eye;
      pinchStartEye.current = eye
        ? { x: eye.x, y: eye.y, z: eye.z }
        : { x: 1.5, y: 1.5, z: 1.5 };
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || pinchStartDist.current === null || !pinchStartEye.current) return;
      e.preventDefault();
      const ratio = pinchStartDist.current / getDist(e.touches);
      const { x, y, z } = pinchStartEye.current;
      const Plotly = (window as any).Plotly;
      Plotly?.relayout(plotId, {
        'scene.camera.eye': { x: x * ratio, y: y * ratio, z: z * ratio }
      });
    };

    const onTouchEnd = () => {
      pinchStartDist.current = null;
      pinchStartEye.current = null;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  /**
   * Idle orbit: a slow turn about the vertical axis while nothing is running.
   *
   * Stops for good the first time the visitor presses on the plot — they have
   * taken the wheel, and a camera that wanders off again while they are reading
   * their own view is worse than one that never moved.
   *
   * Input has to be re-bound after EVERY frame, not just at the end. Driving the
   * camera by relayout desyncs Plotly's drag controller, so a spin without this
   * would leave the scene looking alive but refusing to be dragged. An earlier
   * attempt paused on hover instead; that failed because the tour's caption card
   * can sit over the plot, so the pointer "left" the container without ever
   * leaving the picture.
   */
  useEffect(() => {
    if (!idleSpin) return;
    const Plotly = (window as any).Plotly;
    const container = containerRef.current;
    if (!Plotly || !container) return;

    // Every step starts spinning again, which is why spinNonce is a dependency.
    spinPausedRef.current = false;
    setSpinPaused(false);

    let raf = 0;
    let last = performance.now();
    let since = 0;
    const RATE = 0.16;   // radians per second — a full turn takes about 40s
    const FRAME = 33;    // ms between relayouts; every frame would be wasteful

    /**
     * Listen on the DOCUMENT in the capture phase and hit-test by coordinate,
     * rather than binding to the container and trusting DOM containment.
     *
     * Containment was tried first and did not hold: Plotly's own handlers and
     * the tour's overlay meant a press over the picture did not reliably reach
     * a listener on the wrapping element, so the spin never stopped and then
     * fought the drag it was supposed to yield to. A rectangle test cannot be
     * fooled by whatever is layered in between.
     */
    const insidePlot = (x: number, y: number) => {
      const r = container.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const takeOver = (e: Event) => {
      // Once only. Re-issuing the relayout on every later press reapplied the
      // camera Plotly had stored at that moment, so a second click after
      // rotating snapped the view back to where the first click left it. After
      // the spin is off there is nothing left to hand back — the plot is just a
      // normal plot again, and this handler must keep its hands off it.
      if (spinPausedRef.current) return;
      const pt = e as MouseEvent & { touches?: TouchList };
      const x = pt.touches?.[0]?.clientX ?? pt.clientX;
      const y = pt.touches?.[0]?.clientY ?? pt.clientY;
      if (typeof x !== 'number' || !insidePlot(x, y)) return;
      pauseSpin();
    };
    document.addEventListener('mousedown', takeOver, true);
    document.addEventListener('touchstart', takeOver, true);
    document.addEventListener('wheel', takeOver, true);

    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      since += dt;
      if (!spinPausedRef.current && !cameraBusy && since >= FRAME) {
        const cam = (document.getElementById(plotId) as any)?._fullLayout?.scene?.camera;
        if (cam?.eye) {
          const a = RATE * (since / 1000);
          const { x, y, z } = cam.eye;
          Plotly.relayout(plotId, {
            'scene.camera.eye': {
              x: x * Math.cos(a) - y * Math.sin(a),
              y: x * Math.sin(a) + y * Math.cos(a),
              z,
            },
          });
          rebindPlotInput();
        }
        since = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', takeOver, true);
      document.removeEventListener('touchstart', takeOver, true);
      document.removeEventListener('wheel', takeOver, true);
      rebindPlotInput();
    };
  }, [idleSpin, spinNonce]);

  // Purge Plotly ONLY when component is unmounted
  useEffect(() => {
    return () => {
      const Plotly = (window as any).Plotly;
      try {
        if (Plotly) {
          Plotly.purge(plotId);
        }
      } catch (e) {
        // Safe bypass
      }
    };
  }, []);

  useEffect(() => {
    const Plotly = (window as any).Plotly;
    if (!Plotly || !containerRef.current) return;

    // Build the surfaces and coordinates
    const surf = buildSurfaces(payoffs);
    const isMobile = navigator.maxTouchPoints > 0 && window.innerWidth < 1400;
    const traces = makeTraces(surf, payoffs, simState, trackingMode, allNE, isMobile, stepMode);

    // 'legendonly' rather than dropping the traces: the legend entries stay put,
    // so the markers read as switched off and the legend does not reflow when
    // the tour turns them back on.
    if (hiddenTraces.length) {
      const hidden = new Set(hiddenTraces);
      for (const t of traces as any[]) {
        if (hidden.has(t.name)) t.visible = 'legendonly';
      }
    }

    /* Tour callouts.
     *
     * Appended AFTER makeTraces so they draw on top, and rebuilt through the
     * same Plotly.react path as everything else — a trace added out-of-band with
     * addTraces would be wiped by the next state change. Marker + text rather
     * than scene.annotations so the label is anchored in 3D and travels with the
     * surface as the camera rotates. */
    const goldAnnotations: any[] = [];
    for (const pt of tourPoints) {
      // When a callout sits exactly on an equilibrium marker — the mixed-NE
      // steps put it there on purpose, and the dilemma's corners ARE pure-NE
      // diamonds — the two billboards depth-tie and flicker against each other
      // as the idle spin turns. Lift A's callout a hair above and B's a hair
      // below; the labels already read top-left/bottom-right, so the split
      // matches how they are read.
      const onNE = allNE.some((n) => Math.abs(n.x - pt.x) < 1e-3 && Math.abs(n.y - pt.y) < 1e-3);
      const span = Math.max(payoffs.a11, payoffs.a12, payoffs.a21, payoffs.a22, payoffs.b11, payoffs.b12, payoffs.b21, payoffs.b22)
                 - Math.min(payoffs.a11, payoffs.a12, payoffs.a21, payoffs.a22, payoffs.b11, payoffs.b12, payoffs.b21, payoffs.b22) || 1;
      const zAraw = EA(pt.x, pt.y, payoffs);
      const zBraw = EB(pt.x, pt.y, payoffs);
      // Lift when the callout shares a point with an NE diamond — and also
      // when it shares one with ITS OWN TWIN: at a symmetric game's corners
      // EA = EB, so A's and B's callouts coincide and flicker against each
      // other exactly like the NE case.
      // Text glyphs are already offset in SCREEN space by textposition, so the
      // anchor lift only needs to break depth ties, same as the markers — keep
      // it a sliver so the numbers sit visually on the point they describe.
      let calloutLift = onNE ? span * 0.001 : 0;
      if (Math.abs(zAraw - zBraw) < span * 0.001) calloutLift = Math.max(calloutLift, span * 0.0006);
      // The lift positions the MARKER; the LABEL prints the true payoff. An
      // earlier cut fed the lifted height into the text and the equilibrium
      // read "A = 0.919" where the payoff is 0.727 — a made-up number on the
      // one element whose whole job is stating an exact value.
      const zA = r3(zAraw + calloutLift);
      const zB = r3(zBraw - calloutLift);
      const labelA = r3(zAraw);
      const labelB = r3(zBraw);
      // Two accents, chosen per step:
      // - 'purple' (mixed act): TEXT-ONLY in the Mixed-NE purple. The
      //   equilibrium diamonds already mark the spot, so a second glyph on the
      //   same point was one marker too many — and colouring the text like the
      //   diamonds says outright which markers the numbers belong to.
      // - 'gold' (default; dilemma act): gold diamond + text. Those points sit
      //   on plain surface corners with nothing else marking them, so the
      //   callout has to BE the marker. Deliberately not a player colour, so
      //   the note never reads as a data series.
      if (pt.accent === 'purple') {
        const callout = isDark ? '#c084fc' : '#8E44AD';
        // Off to the RIGHT, not stacked above and below. Centred labels landed on
        // top of the mixed-NE diamond once the mixed act zoomed in, and in a
        // symmetric game both players share a z, so 'top'/'bottom' would still
        // have collided with each other.
        // A goes up-LEFT and B down-RIGHT: splitting horizontally as well as
        // vertically, because on a wide payoff axis two callouts half a unit
        // apart land on the same pixel row and overprint into garbage.
        for (const [z, label, who, pos] of [[zA, labelA, 'A', 'top left'], [zB, labelB, 'B', 'bottom right']] as const) {
          traces.push({
            type: 'scatter3d', mode: 'text',
            x: [pt.x], y: [pt.y], z: [z],
            text: [`${who} = ${label}`], textposition: pos,
            textfont: { size: 13, color: callout, family: 'ui-monospace, monospace' },
            hoverinfo: 'skip', showlegend: false, cliponaxis: false,
          } as any);
        }
      } else {
        // Built EXACTLY like the pure/mixed NE markers in plotting.ts, so the
        // dilemma's callouts read as the same visual language: a twin-diamond
        // pair at A's and B's payoff heights, joined by a vertical connecting
        // line, at the SAME size as the NE diamonds. In a symmetric game both
        // heights coincide, the line degenerates to a point and the twins
        // overprint into one diamond — the identical-sprite tie is invisible,
        // same as the NE twins.
        //
        // Colour says what the point IS: a callout sitting ON an equilibrium
        // keeps the Pure-NE green — that point is the equilibrium, and
        // repainting it gold divorced it from the marker in the legend. The
        // opaque green twins overprint the translucent NE diamond beneath
        // seamlessly (same size, same colour). Non-equilibrium points — the
        // collaboration corner, the example point — stay gold.
        const diamondColor = onNE ? '#4ca47a' : (isDark ? '#FACC15' : '#CA8A04');
        const textColor = onNE
          ? (isDark ? '#4ca47a' : '#35855f')
          : (isDark ? '#FACC15' : '#CA8A04');
        const calloutRing = onNE ? '#ffffff' : (isDark ? '#1f2937' : '#ffffff');
        const ringWidth = onNE ? 1 : 2;
        const goldSize = isMobile ? 8.5 : 10.5;
        const zGa = r3(zAraw);
        const zGb = r3(zBraw);
        const zLo = Math.min(zGa, zGb);
        const zHi = Math.max(zGa, zGb);
        const GOLD_STEPS = 15;
        const lineZ: number[] = [], lineX: number[] = [], lineY: number[] = [];
        for (let si = 0; si <= GOLD_STEPS; si++) {
          lineZ.push(zLo + (zHi - zLo) * si / GOLD_STEPS);
          lineX.push(pt.x);
          lineY.push(pt.y);
        }
        traces.push({
          type: 'scatter3d', mode: 'lines',
          x: lineX, y: lineY, z: lineZ,
          line: { color: diamondColor, width: 6, dash: 'solid' },
          hoverinfo: 'skip', showlegend: false,
        } as any);
        traces.push({
          type: 'scatter3d', mode: 'markers',
          x: [pt.x, pt.x], y: [pt.y, pt.y], z: [zGa, zGb],
          marker: { size: goldSize, color: diamondColor, symbol: 'diamond', line: { color: calloutRing, width: ringWidth } },
          hoverinfo: 'skip', showlegend: false, cliponaxis: false,
        } as any);
        const goldPts: [number, string, boolean][] =
          [[zGa, `A = ${labelA}`, true], [zGb, `B = ${labelB}`, false]];
        for (const [z, label, isA] of goldPts) {
          // The labels are scene ANNOTATIONS, not trace text: gl3d perspective-
          // scales trace text glyphs with depth, so on the two-corner step the
          // far corner's "A = 1 / B = 1" rendered visibly smaller than the near
          // corner's "A = 3 / B = 3" at the same font size. Annotations anchor
          // to the 3D point (they still travel with rotation) but draw in
          // screen space at a fixed size — every label prints equally.
          // A reads directly ABOVE the diamond and B directly BELOW — centred,
          // not left/right-anchored: the tour cameras put corners at the plot
          // edge, and a side-anchored label there pushes its text clean off
          // the visible area. Centred, at worst half the label meets the edge.
          goldAnnotations.push({
            x: pt.x, y: pt.y, z,
            text: label, showarrow: false,
            xanchor: 'center',
            // Anchor the text EDGE nearest the diamond, then push off by the
            // glyph's half-height plus a margin — centre-anchoring left the
            // label straddling the diamond at some cameras.
            yanchor: isA ? 'bottom' : 'top',
            yshift: isA ? 12 : -12,
            font: { size: 16, color: textColor, family: 'ui-monospace, monospace' },
          });
        }
      }
    }

    // Merge custom dynamic interactions into layout
    const layout = {
      ...plotLayout,
      paper_bgcolor: isDark ? '#000000' : '#ffffff',
      plot_bgcolor: isDark ? '#000000' : '#ffffff',
      dragmode: dragMode,
      uirevision: 'camera_view_' + uiRevision,
      scene: {
        ...plotLayout.scene,
        // Always set (empty when no tour callouts) so stale labels from a
        // previous step are cleared on the next Plotly.react.
        annotations: goldAnnotations,
        camera: cameraRef.current,
        uirevision: 'camera_view_' + uiRevision,
        bgcolor: isDark ? '#000000' : '#ffffff',
        xaxis: {
          ...plotLayout.scene.xaxis,
          gridcolor: isDark ? '#334155' : '#e2e8f0',
          zerolinecolor: isDark ? '#475569' : '#cbd5e1',
          color: isDark ? '#cbd5e1' : '#475569',
          title: {
            ...plotLayout.scene.xaxis.title,
            font: {
              size: 10,
              color: isDark ? '#cbd5e1' : '#475569'
            }
          }
        },
        yaxis: {
          ...plotLayout.scene.yaxis,
          gridcolor: isDark ? '#334155' : '#e2e8f0',
          zerolinecolor: isDark ? '#475569' : '#cbd5e1',
          color: isDark ? '#cbd5e1' : '#475569',
          title: {
            ...plotLayout.scene.yaxis.title,
            font: {
              size: 10,
              color: isDark ? '#cbd5e1' : '#475569'
            }
          }
        },
        zaxis: {
          ...plotLayout.scene.zaxis,
          gridcolor: isDark ? '#334155' : '#e2e8f0',
          zerolinecolor: isDark ? '#475569' : '#cbd5e1',
          color: isDark ? '#cbd5e1' : '#475569',
          title: {
            ...plotLayout.scene.zaxis.title,
            font: {
              size: 10,
              color: isDark ? '#cbd5e1' : '#475569'
            }
          }
        }
      },
      legend: {
        ...plotLayout.legend,
        bgcolor: isDark ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)',
        bordercolor: isDark ? '#334155' : '#e2e8f0',
        borderwidth: 1,
        // `itemsizing` keeps glyph widths fixed so only text decides the box.
        itemsizing: 'constant',
        font: {
          size: 10,
          color: isDark ? '#f8fafc' : '#0f172a',
          /**
           * The family is PINNED, and that is the actual fix for the clipped
           * "Current position (A)" label on iOS. Plotly sizes the legend box by
           * measuring the label text, then the browser renders that text in
           * whatever the default stack resolves to — with no family set, those
           * two steps can resolve differently, and on iOS the rendered text came
           * out wider than the measured box and clipped through its border. It
           * never reproduced in desktop Chromium or WebKit, whose fallback
           * metrics happen to agree. Pinning one family makes measurement and
           * rendering identical everywhere, so the box cannot clip its own
           * contents. The A-vs-B asymmetry in the report was Plotly sizing the
           * box independently per tracking mode — the traces are symmetric.
           */
          family: 'Helvetica, Arial, sans-serif'
        }
      },
      font: {
        ...plotLayout.font,
        color: isDark ? '#cbd5e1' : '#475569'
      }
    };

    // Plot updating (incrementally with react, preserving camera configuration)
    Plotly.react(plotId, traces, layout, {
      responsive: true,
      displayModeBar: false
    });

    // Attach camera listener after Plotly has initialized the element's event system
    const el2 = document.getElementById(plotId) as any;
    if (el2 && typeof el2.on === 'function') {
      try { el2.removeAllListeners('plotly_relayout'); } catch {}
      el2.on('plotly_relayout', (eventData: any) => {
        if (eventData['scene.camera']) {
          cameraRef.current = eventData['scene.camera'];
        }
      });

      // The "A Moves"/"B Moves" legend entries are solid-color stub traces; the
      // actual path is a separate gradient trace sharing the same legendgroup.
      // Toggle the whole group so clicking the legend hides the real path too.
      try { el2.removeAllListeners('plotly_legendclick'); } catch {}
      el2.on('plotly_legendclick', (ev: any) => {
        const grp = ev?.data?.[ev.curveNumber]?.legendgroup;
        if (grp !== 'amoves' && grp !== 'bmoves') return true; // default toggle
        const indices: number[] = [];
        ev.data.forEach((t: any, i: number) => { if (t.legendgroup === grp) indices.push(i); });
        const cur = ev.data[ev.curveNumber].visible;
        const nextVisible = (cur === undefined || cur === true) ? 'legendonly' : true;
        (window as any).Plotly?.restyle(plotId, { visible: nextVisible }, indices);
        return false; // suppress Plotly's single-trace default
      });
    }
  }, [payoffs, simState, trackingMode, allNE, isDark, uiRevision, stepMode, tourPoints, hiddenTraces]);

  // Handle dragMode changes separately to preserve camera orientation
  useEffect(() => {
    const Plotly = (window as any).Plotly;
    if (!Plotly || !document.getElementById(plotId)) return;

    // Only update dragmode using relayout to preserve camera
    Plotly.relayout(plotId, { dragmode: dragMode });
  }, [dragMode]);

  return (
    <div ref={containerRef} data-tour="plot" className={`w-full relative border rounded-xl p-2 md:p-4 shadow-sm h-[16rem] sm:h-[24rem] lg:h-[28rem] ${isDark ? 'bg-black border-slate-800' : 'bg-white border-slate-200'}`}>
      {/* Floating 3D Navigation Controls */}
      <div className={`absolute top-3 right-3 z-10 flex items-center gap-0.5 sm:gap-1 border p-1 rounded-xl shadow-xs ${isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-white/95 border-slate-200'}`}>
        <button
          type="button"
          onClick={() => setDragMode('turntable')}
          className={`flex items-center gap-1 px-2.5 sm:px-3 py-1 sm:py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
            dragMode === 'turntable'
              ? isDark ? 'bg-accent-600/30 text-accent-400 border border-accent-500/30' : 'bg-accent-100 text-accent-700 border border-accent-200/50'
              : isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent' : 'text-slate-500 hover:bg-slate-100 border border-transparent'
          }`}
          title="Rotate view (Click & Drag)"
        >
          <Rotate3d className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Rotate</span>
        </button>
        <button
          type="button"
          onClick={() => setDragMode('pan')}
          className={`flex items-center gap-1 px-2.5 sm:px-3 py-1 sm:py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
            dragMode === 'pan'
              ? isDark ? 'bg-accent-600/30 text-accent-400 border border-accent-500/30' : 'bg-accent-100 text-accent-700 border border-accent-200/50'
              : isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent' : 'text-slate-500 hover:bg-slate-100 border border-transparent'
          }`}
          title="Pan / Move view (Click & Drag)"
        >
          <Move className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Pan</span>
        </button>
        <div className={`w-px h-5 mx-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />
        <button
          type="button"
          onClick={() => { cameraRef.current = DEFAULT_CAMERA; setUiRevision(prev => prev + 1); }}
          className={`flex items-center gap-1 px-2.5 sm:px-3 py-1 sm:py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
            isDark
              ? 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent'
              : 'text-slate-500 hover:bg-slate-100 border border-transparent'
          }`}
          title="Reset 3D camera to default perspective"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Reset View</span>
        </button>
      </div>

      {idleSpin && spinPaused && (
        <button
          type="button"
          onClick={resumeSpin}
          className={`absolute bottom-3 left-3 z-10 inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-xs transition-colors ${
            isDark
              ? 'bg-slate-900/90 border-slate-700 text-slate-200 hover:bg-slate-800'
              : 'bg-white/95 border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <RefreshCw className="w-3.5 h-3.5" /> Resume spinning
        </button>
      )}

      <div id={plotId} className="w-full h-full" />
    </div>
  );
};

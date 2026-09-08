/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GamePayoffs, SimState, NashEquilibrium } from '../types';
import { buildSurfaces, makeTraces, plotLayout } from '../utils/plotting';
import { EA, EB, r3, payoffProseRhs } from '../utils/gameEngine';
import { cameraBasis, zRangeOfSurface, shouldCollapseComponentAtCamera, shouldCollapseComponentAtCameraExact } from '../utils/cameraProjection';
import { Rotate3d, Move, RefreshCw } from 'lucide-react';

/**
 * RED-MATH-13/002: per-continuum-component trace bookkeeping, rebuilt every
 * time `makeTraces` runs (alongside `traces` itself) so the camera-aware
 * collapse below can restyle exactly the right trace indices without a full
 * Plotly.react. A component with no corner trace indices was already
 * collapsed by the STATIC (data-space, SHORT_CONTINUUM) rule in plotting.ts
 * — nothing for the dynamic rule to do.
 */
/**
 * RED-APP-14/006: the document-capture detectors below decide "the visitor
 * reached into the picture" by the plot's RECTANGLE, on purpose (the tour's
 * transparent overlay sits between the pointer and the plot, so a
 * `contains(e.target)` test alone would miss a real press). The rectangle
 * alone, though, also matched presses on a drawer tab, a dialog button or a
 * header control that merely OVERLAPS the plot — and silently paused a
 * running simulation. A press whose real target is interactive UI outside the
 * plot, or sits inside any dialog/overlay surface, is not a press on the plot.
 */
const UNRELATED_UI = 'button, a[href], input, select, textarea, [role="dialog"], [data-modal-surface], header, nav';
const INTERACTIVE_CONTROL = 'button, a[href], input, select, textarea';
function pressOnUnrelatedUi(e: Event, container: HTMLElement): boolean {
  const t = e.target;
  if (!(t instanceof Element)) return false;
  // An interactive control is never "the picture", whether it sits outside
  // the wrapper or INSIDE it (the plot's own Rotate / Pan / Reset View and
  // Resume buttons live inside `containerRef`, so a containment test alone
  // let each of them pause a running simulation — CodeRabbit on #153).
  if (t.closest(INTERACTIVE_CONTROL)) return true;
  return !container.contains(t) && !!t.closest(UNRELATED_UI);
}

interface ContinuumComponentMeta {
  componentIndex: number;
  midpointTraceIndex: number;
  cornerTraceIndices: number[];
  midpointBaseSize: number;
  midpointShortSize: number;
  cornerSize: number;
  zLo: number;
  zHi: number;
  surfaces: Array<{
    midpoint: { x: number; y: number; z: number };
    corners: Array<{ x: number; y: number; z: number }>;
  }>;
}

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
  /**
   * How long to wait before the FIRST turn each time the spin (re)starts.
   * 0 = spin straight away (fresh page, new game). Greater than 0 = hold off
   * that long first — used when a run pauses or finishes, where the visitor
   * is likely mid-inspection and the camera must not move the picture the
   * instant they stop it.
   */
  spinDelayMs?: number;
  /**
   * 0 (default): the first press on the plot takes the wheel for good and
   * only the Resume button brings the spin back (the tour's behaviour — a
   * camera that wanders off while a reader studies their own view is worse
   * than one that never moved). Greater than 0: nothing is permanent —
   * interacting with the graph just halts the spin and starts a countdown,
   * and after this many ms without further graph activity it turns again.
   */
  spinAutoResumeMs?: number;
  /**
   * Fired on any press (mousedown/touchstart) that lands over the plot,
   * using the same rectangle hit-test the idle spin relies on — Plotly's
   * own handlers and overlays make element-containment unreliable here.
   * The app uses it to pause a running simulation the moment the visitor
   * reaches into the picture.
   */
  onGraphPress?: () => void;
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
  /** Camera roll axis; Plotly's default is +z. Read back from the live scene so a rotate that tilted it survives a redraw. */
  up?: { x: number; y: number; z: number };
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
/**
 * Does this plotly_relayout payload represent a camera change?
 *
 * Pulled out as a pure function because getting it wrong is invisible at
 * runtime and expensive: Plotly reports camera interaction with GRANULAR keys —
 * a turntable drag and, crucially, a wheel/pinch zoom arrive as
 * `scene.camera.eye`, and `scene.camera` is never emitted at all. The original
 * listener tested only for `scene.camera`, so the stored pose silently stopped
 * tracking the user's view, and every Plotly.react shipped a stale camera in
 * its layout. `uirevision` normally makes Plotly ignore that, which is why it
 * survived in most situations — and why a browser test asserting "the view did
 * not move" passes against the defect. The decidable part is this predicate,
 * so it is tested directly (src/unit.test.ts).
 */
export function isCameraRelayout(eventData: Record<string, unknown> | null | undefined): boolean {
  if (!eventData) return false;
  return Object.keys(eventData).some((k) => k === 'scene.camera' || k.startsWith('scene.camera.'));
}

/**
 * The camera the user is LOOKING AT, read from the live GL scene — the only
 * source that is right on every input path. Plotly emits `plotly_relayout`
 * for a camera change only on mouse-up and wheel: a one-finger TOUCH rotate
 * moves the scene's camera and emits nothing (director repro, Pixel 7 profile,
 * 2026-09-05: live eye moved, `_fullLayout.scene.camera` did not), so a ref
 * fed by that event goes stale on phones and the next Plotly.react snaps the
 * view back — on Resume, on a report arriving, on a matrix edit, on a theme
 * switch. Falls back to Plotly's recorded camera where the scene is not up.
 */
export function readLiveCamera(plotId: string): CameraPose | null {
  const gd = document.getElementById(plotId) as any;
  const scene = gd?._fullLayout?.scene;
  const live = scene?._scene?.getCamera?.() ?? scene?.camera;
  if (!live?.eye) return null;
  return {
    eye: { ...live.eye },
    center: { ...(live.center ?? { x: 0, y: 0, z: 0 }) },
    up: { ...(live.up ?? { x: 0, y: 0, z: 1 }) },
  };
}

/**
 * Make Plotly's OWN record of the camera agree with the live scene. `uirevision`
 * keeps `_fullLayout.scene.camera` across a Plotly.react whenever the incoming
 * layout camera equals the previous input — so writing our ref, or even
 * `gd.layout`, is not enough after a touch rotate: the stale record wins the
 * next react. Only a relayout updates the record (it also emits
 * plotly_relayout, which refreshes cameraRef through the ordinary listener).
 * Returns true when a correction was needed.
 */
export function syncPlotlyCameraToScene(plotId: string): boolean {
  const Plotly = (window as any).Plotly;
  const gd = document.getElementById(plotId) as any;
  const recorded = gd?._fullLayout?.scene?.camera;
  const live = readLiveCamera(plotId);
  if (!Plotly || !gd || !live || !recorded?.eye) return false;
  const same = (a: any, b: any) => !!a && !!b && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) < 1e-9;
  if (same(live.eye, recorded.eye) && same(live.center, recorded.center ?? { x: 0, y: 0, z: 0 }) && same(live.up, recorded.up ?? { x: 0, y: 0, z: 1 })) return false;
  Plotly.relayout(gd, { 'scene.camera': live });
  return true;
}

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

/**
 * Stop a step glide where it is — for any control that sets the camera itself
 * while a glide may be running. `moveCamera` cancels a PRIOR glide at its own
 * start (above) but cannot know about an interrupting click, so the click has
 * to cancel the glide first. Releases `cameraBusy`; the CALLER re-binds input
 * (`rebindPlotInput`) AFTER its own camera relayout — a dragmode relayout
 * issued before the camera one made Plotly re-apply the pose it had recorded
 * and the reset never landed (director probe, RED-MATH-18/001 first attempt).
 */
export function cancelCameraGlide(): void {
  cancelAnimationFrame(cameraAnim);
  cameraAnim = 0;
  cameraBusy = false;
}

/**
 * OPUS-REVIEW-MATH17 FBM-1: waits for gl-plot3d's OWN rendered canvas
 * (`glplot.shape`, device px) to actually match the plot DIV's current CSS
 * box, rather than trusting `Plotly.Plots.resize`'s promise (measured: still
 * stale immediately after `await`) or a fixed delay. Polls via
 * `requestAnimationFrame`, BOUNDED — a shape that never settles within
 * `timeoutMs` still resolves (a decision on a possibly-stale shape is better
 * than a decision that never happens; the pre-fix code decided on an
 * ALWAYS-stale shape at this call site, which is strictly worse).
 * Pulled out as a standalone function (not inlined in the ResizeObserver
 * callback) so an e2e/unit fixture can `await` the exact same settling this
 * component relies on, rather than approximating it with a sleep.
 */
export function waitForGlplotShapeSettled(plotId: string, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const check = () => {
      const gd = document.getElementById(plotId) as any;
      const glplot = gd?._fullLayout?.scene?._scene?.glplot;
      const rect = typeof gd?.getBoundingClientRect === 'function' ? gd.getBoundingClientRect() : null;
      // cr review (CLI, this branch): the gl3d canvas is `margin.t` px
      // SHORTER than the plot DIV (plotting.ts's own `margin.t: 10`,
      // matching the SAME subtraction `applyContinuumCollapseAtCamera`'s own
      // `shapeFresh` check makes below) — comparing `cssH` against the RAW
      // `rect.height` here meant this function's "settled" check could
      // NEVER match early, always burning the full `timeoutMs` bound before
      // resolving via timeout rather than detecting real settlement.
      const marginTop = Number(gd?._fullLayout?.margin?.t) || 0;
      if (glplot?.shape && glplot.pixelRatio > 0 && rect && rect.width > 0 && rect.height > marginTop) {
        const cssW = glplot.shape[0] / glplot.pixelRatio;
        const cssH = glplot.shape[1] / glplot.pixelRatio;
        // A couple CSS px of slack for sub-pixel layout/DPR rounding — not a
        // tolerance on the COLLAPSE decision itself, only on "has the canvas
        // caught up to the box", so it stays tight.
        if (Math.abs(cssW - rect.width) < 2 && Math.abs(cssH - (rect.height - marginTop)) < 2) { resolve(); return; }
      }
      if (performance.now() - start > timeoutMs) { resolve(); return; }
      requestAnimationFrame(check);
    };
    check();
  });
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
  spinNonce = 0,
  spinDelayMs = 0,
  spinAutoResumeMs = 0,
  onGraphPress
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotId = PLOT_ID;
  const [dragMode, setDragMode] = useState<'turntable' | 'pan'>('turntable');
  const [uiRevision, setUiRevision] = useState<number>(0);
  const pinchStartDist = useRef<number | null>(null);
  const pinchStartEye = useRef<{x: number; y: number; z: number} | null>(null);
  // Tracks the camera the user has rotated to so Plotly.react never overrides it
  const cameraRef = useRef<any>(DEFAULT_CAMERA);
  /** RED-MATH-13/002: this render's continuum component bookkeeping (trace
   *  indices + data-space points), and which components the DYNAMIC
   *  camera-aware rule currently has collapsed — reset every time `traces`
   *  is rebuilt (see the data effect below) so a stale decision from a
   *  previous game/render can never suppress a needed restyle. */
  const continuumMetaRef = useRef<ContinuumComponentMeta[]>([]);
  const continuumCollapsedRef = useRef<Map<number, boolean>>(new Map());
  /** The idle spin emits one relayout per animation frame (~33ms); the spin
   *  fusing test only needs the decision to flip within roughly one visible
   *  frame, so re-evaluating on every 10th of a second is plenty and keeps a
   *  spin frame from paying for a restyle it does not need. */
  const lastContinuumEvalRef = useRef(0);
  /** CodeRabbit (this branch): a plain leading-edge throttle drops the LAST
   *  event of a burst if it lands inside the 100ms window — harmless for the
   *  idle spin (more relayouts keep coming), but a one-shot settle (Reset
   *  View, the end of a drag) could then leave a stale hide/show decision
   *  indefinitely. Holds the pending trailing-evaluation timer so it can be
   *  re-armed (only the latest camera matters) and cancelled on cleanup. */
  const trailingContinuumEvalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Legend entries the USER switched off. Every simulation step rebuilds the
   * traces from scratch, and a fresh trace carries no `visible`, so a legend
   * toggle used to last exactly until the next step (RED-MATH-12/002). The
   * click handler records the group; the redraw re-applies it.
   */
  const userHiddenGroupsRef = useRef<Set<string>>(new Set());

  /**
   * RED-MATH-13/002: the non-overlap guarantee (docs/CONTINUUM-RENDERING.md
   * clause 3) has to hold at every camera the app itself reaches, not just
   * the default one the STATIC SHORT_CONTINUUM rule was validated at — the
   * idle spin alone rotates past fusing angles within 1-2s of page load.
   * Projects each component's own corner/midpoint centers through the
   * CURRENT camera (the same helper the property-test sweep uses — one
   * projection, not two that could quietly disagree) and, only when a
   * component's decision actually FLIPS, restyles exactly its corner
   * traces (visibility) and its midpoint trace (marker.size) — never a
   * full Plotly.react, so this is safe to call on every relayout.
   *
   * Hoisted to the component body (CodeRabbit, this branch) rather than
   * defined inside the data-rebuild effect: it touches only REFS (always
   * current regardless of which render's closure created it) and `plotId`
   * (constant), so it is safe to call from the resize effect and the
   * legend-click handler too, not just the relayout listener that used to
   * be its only caller.
   */
  const applyContinuumCollapseAtCamera = (camera: any) => {
    const metas = continuumMetaRef.current;
    if (!metas.length) return;
    const eye = camera?.eye;
    if (!eye) return;
    const PlotlyNow = (window as any).Plotly;
    const gdNow = document.getElementById(plotId) as any;
    if (!PlotlyNow || !gdNow) return;
    // CodeRabbit (this branch): a fixed `fwd = normalize(0-eye)` ignored a
    // nonzero live `center` (some tour poses, e.g. cornerRow1Col1/interior,
    // use one), and `up` was always the default — both now flow through.
    const center = camera?.center ?? { x: 0, y: 0, z: 0 };
    const up = camera?.up ?? { x: 0, y: 0, z: 1 };
    // OPUS-REVIEW-MATH NOTE-1: the plot DIV's own rect is NOT the gl3d
    // canvas's actual rendered size — plotting.ts's `margin.t: 10` reserves
    // 10px at the top of the SVG/WebGL area for every subplot, so the real
    // scene is `rect.height - margin.t` tall (confirmed live: a 276x256 div
    // renders a 276x246 `glplot.shape`). Read the live margin rather than
    // hardcoding 10, so a future margin change stays correct for free.
    const marginTop = Number(gdNow._fullLayout?.margin?.t) || 0;

    // BLUE-MATH-17 (RED-MATH-17/001, RED-MATH-16/001): project through the
    // LIVE gl3d camera matrices whenever gl-plot3d has rendered at least one
    // frame — the EXACT transform that drew what's on screen right now, not
    // an estimate of it (cameraProjection.ts's own block comment above
    // `projectPointExact` has the full derivation + real-pixel verification:
    // both known-gap fixtures land within 0.3 CSS px of prediction). Only
    // missing before the first frame (a detached/not-yet-rendered node),
    // which is the one case the old FOCAL/lookAt estimate still covers.
    const sceneNow = gdNow._fullLayout?.scene?._scene;
    const glplotNow = sceneNow?.glplot;
    const cp = glplotNow?.cameraParams;
    const dataScaleNow = sceneNow?.dataScale;
    const shapeNow = glplotNow?.shape;
    const pixelRatioNow = glplotNow?.pixelRatio;
    // OPUS-REVIEW-MATH17 FBM-1 (structural, not a bounded-wait patch): reading
    // the live matrices is not enough on its own — `glplot.shape` can be
    // STALE (mid-resize: `Plots.resize` is debounced ~100ms and gl-plot3d's
    // own canvas resize lands later still) or, in some rendering
    // environments, effectively FROZEN at its very first value (observed:
    // headless Chromium without explicit WebGL/SwiftShader launch flags never
    // updates `glplot.shape` after the initial render at all — confirmed by
    // instrumenting this exact function and diffing against the live
    // container rect across a real resize). Precise math on a STALE viewport
    // is worse than imprecise math on the RIGHT one (the estimate below,
    // which reads `getBoundingClientRect()` FRESH every call) — so the exact
    // path is gated on the shape ACTUALLY MATCHING the container's current
    // box right now, not merely existing.
    const rect = typeof gdNow.getBoundingClientRect === 'function' ? gdNow.getBoundingClientRect() : null;
    const shapeFresh = !!(
      shapeNow && shapeNow.length === 2 && typeof pixelRatioNow === 'number' && pixelRatioNow > 0 &&
      rect && rect.width > 0 && rect.height > marginTop &&
      Math.abs(shapeNow[0] / pixelRatioNow - rect.width) < 2 &&
      Math.abs(shapeNow[1] / pixelRatioNow - (rect.height - marginTop)) < 2
    );
    const exactReady = !!(
      cp?.model && cp?.view && cp?.projection &&
      dataScaleNow && dataScaleNow.length === 3 &&
      shapeNow && shapeNow[0] > 0 && shapeNow[1] > 0 &&
      typeof pixelRatioNow === 'number' && pixelRatioNow > 0 &&
      shapeFresh
    );
    // Recorded on the DOM node (not just returned) so a fixture can assert
    // WHICH path actually decided — presence of a decision is not proof of
    // which math made it (COMMON v5 self-adversarial checklist, item (f) —
    // this is that discipline applied to a projection path, not a message).
    // `continuumDecidedAt` (director-routed cr review): an APP-side
    // timestamp (the same `performance.now()` clock a page-side test reads
    // for its own "resize started" mark), stamped on every evaluation —
    // lets a fixture measure the resize-to-decision latency directly rather
    // than inferring it from wall-clock time around Playwright round-trips
    // (network/IPC/CI-scheduler jitter that has nothing to do with this
    // component's own timing).
    if (gdNow.dataset) {
      gdNow.dataset.continuumProjectionPath = exactReady ? 'exact' : 'estimate';
      gdNow.dataset.continuumDecidedAt = String(performance.now());
    }

    let basis: ReturnType<typeof cameraBasis> | undefined;
    let viewport: { w: number; h: number } | undefined;
    if (!exactReady) {
      basis = cameraBasis([eye.x, eye.y, eye.z], [center.x, center.y, center.z], [up.x, up.y, up.z]);
      // CodeRabbit (this branch): marker SIZE is fixed CSS px, but the
      // projected GAP between two points scales with the container's actual
      // pixel size — the STATIC test's fixed 700x500 canonical viewport
      // under-predicts real fusion risk on a narrower live container (e.g.
      // mobile) and over-predicts it on a wider one. Read the plot's OWN
      // current rendered size (the SAME `rect` the freshness check above
      // just read — always current, computed once per call) instead of
      // assuming the canonical one; the canonical viewport stays the STATIC
      // threshold's calibration (untouched default in cameraProjection.ts),
      // used only if the live rect is unavailable too (e.g. a detached node
      // mid-teardown).
      viewport = rect && rect.width > 0 && rect.height > marginTop
        ? { w: rect.width, h: rect.height - marginTop }
        : undefined;
    }
    // CodeRabbit (this branch): un-collapsing must restore the corner
    // traces' BASELINE visibility, not force `true` unconditionally — the
    // user may have hidden the whole 'continuumNE' legend group
    // (userHiddenGroupsRef, set as 'legendonly' on every trace in that
    // group by the trace-rebuild effect above). Forcing `true` here would
    // silently re-show corners the user just switched off.
    const baselineVisible: boolean | 'legendonly' = userHiddenGroupsRef.current.has('continuumNE') ? 'legendonly' : true;
    const cornerIdx: number[] = [];
    const cornerVis: (boolean | 'legendonly')[] = [];
    const midIdx: number[] = [];
    const midSize: number[] = [];
    for (const m of metas) {
      const collapse = m.surfaces.some((s) => exactReady
        ? shouldCollapseComponentAtCameraExact(
            s.midpoint, s.corners, m.midpointBaseSize, m.cornerSize,
            cp, [dataScaleNow[0], dataScaleNow[1], dataScaleNow[2]],
            { w: shapeNow[0], h: shapeNow[1] }, pixelRatioNow, marginTop)
        : shouldCollapseComponentAtCamera(s.midpoint, s.corners, m.midpointBaseSize, m.cornerSize, m.zLo, m.zHi, basis, viewport));
      const was = continuumCollapsedRef.current.get(m.componentIndex) ?? false;
      if (collapse === was) continue;
      continuumCollapsedRef.current.set(m.componentIndex, collapse);
      // 'legendonly' rather than a bare `false` when collapsing (CodeRabbit,
      // this branch): using the SAME value Plotly's own legend-visibility
      // state machine uses means a corner this rule hides reads as
      // indistinguishable from a legend-hidden one, so the legend-click
      // handler's own restyle (which now owns the WHOLE continuumNE toggle,
      // see below) never has to reconcile two different "off" values.
      for (const ci of m.cornerTraceIndices) { cornerIdx.push(ci); cornerVis.push(collapse ? 'legendonly' : baselineVisible); }
      midIdx.push(m.midpointTraceIndex);
      midSize.push(collapse ? m.midpointShortSize : m.midpointBaseSize);
    }
    if (cornerIdx.length) PlotlyNow.restyle(gdNow, { visible: cornerVis }, cornerIdx);
    if (midIdx.length) PlotlyNow.restyle(gdNow, { 'marker.size': midSize }, midIdx);
  };

  /** Spin paused because the visitor took the wheel. Mirrored in a ref so the
   *  animation loop can read it without being torn down and rebuilt. */
  const [spinPaused, setSpinPaused] = useState(false);
  const spinPausedRef = useRef(false);
  /** `rebind` false: the caller is about to set the camera itself and re-binds
   *  AFTER its own relayout (RED-MATH-18/001 — a dragmode relayout issued
   *  before a camera relayout made Plotly re-apply its recorded pose). */
  const pauseSpin = (rebind = true) => {
    if (spinPausedRef.current) return;
    spinPausedRef.current = true;
    setSpinPaused(true);
    if (rebind) rebindPlotInput();
  };
  const resumeSpin = () => {
    spinPausedRef.current = false;
    setSpinPaused(false);
    // In auto-resume mode the button is a "skip the wait" shortcut.
    nextSpinAtRef.current = 0;
    setSpinWaiting(false);
    spinWaitingRef.current = false;
  };
  /** Auto-resume mode: the clock time before which the spin may not turn.
   *  Graph activity pushes it forward; the Resume button zeroes it. */
  const nextSpinAtRef = useRef(0);
  /** True while the spin is halted awaiting the inactivity countdown — this
   *  is what shows the Resume button in auto-resume mode. Mirrored in a ref
   *  so the rAF loop and event handlers can flip it without re-render races. */
  const [spinWaiting, setSpinWaiting] = useState(false);
  const spinWaitingRef = useRef(false);
  /**
   * RED-MATH-18/001: an explicit camera control is the visitor taking the
   * wheel. The document-capture detectors below deliberately ignore presses
   * on buttons (`pressOnUnrelatedUi` — a toolbar click must not pause a
   * running simulation), so "Reset View" never registered as activity: the
   * idle spin — on from the first frame during the tour, and after 10 s of
   * idleness otherwise — kept turning FROM the reset pose, and the camera was
   * at the default for exactly one frame (director probe: eye 0.49 from the
   * default 1.5 s after the click; the tour's glide, if one is in flight,
   * would overwrite it as well). Same effect as a press on the picture:
   * take-over mode pauses until Resume; auto-resume mode restarts the
   * countdown. Declared below `reducedMotion`, which gates it.
   */
  /**
   * `prefers-reduced-motion: reduce`, tracked reactively (RED-APP-4, round 4).
   *
   * The idle-spin effect below used to never check this at all — only the
   * tour's camera-glide transition (`moveCamera`, below) did, so a visitor
   * who had asked the OS to suppress ambient motion still got a continuous,
   * unbounded ~40s/turn rotation on every fresh load, reset and pause,
   * needing no interaction to start (confirmed: eye vector moved by a
   * similar amount in each of two consecutive 6s idle windows with the
   * preference active). React STATE rather than a one-shot `matches` read so
   * a live OS-setting change (the `change` event) stops or starts the spin
   * without a reload — the same guarantee `moveCamera`'s one-shot check
   * cannot give a continuous animation.
   */
  const [reducedMotion, setReducedMotion] = useState<boolean>(
    () => (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const holdSpinRef = useRef<() => void>(() => {});
  const holdSpinForCameraControl = () => {
    // OPUS-REVIEW-170/A: mirror the spin effect's own gates. Under reduced
    // motion (or with the spin off) the effect never runs, so nothing would
    // ever clear the flags set below — the Resume button would advertise a
    // spin that cannot run and stick for the whole session.
    if (reducedMotion || !idleSpin) return;
    if (spinAutoResumeMs > 0) {
      nextSpinAtRef.current = performance.now() + spinAutoResumeMs;
      if (!spinWaitingRef.current) {
        spinWaitingRef.current = true;
        setSpinWaiting(true);
      }
      return;
    }
    pauseSpin(false);
  };
  // CodeRabbit on #177: published from a layout effect, never during render —
  // React may replay or discard a render, and the document-level touch
  // listener must only ever call a closure that actually committed.
  useLayoutEffect(() => { holdSpinRef.current = holdSpinForCameraControl; });

  /**
   * Deadline until which the idle spin must stay quiet because the container
   * is mid-resize. The spin's per-frame relayout is normally a few ms, but
   * during a live drag-resize it becomes a 200ms+ synchronous re-render —
   * the page then can't produce frames at the new window size and the
   * browser fills the exposed strip with its own canvas color (white/gray,
   * Firefox-private purple) for the whole drag. Measured: with the spin
   * running a resize storm shows 200–260ms frames; with it quiet, zero.
   */
  const resizeBusyUntilRef = useRef(0);
  /** OPUS-REVIEW-MATH17 FBM-1 follow-up (self-adversarial check (b) —
   *  every async continuation must check its generation before touching
   *  state): `waitForGlplotShapeSettled` is a BOUNDED poll (up to 1000ms), so
   *  a resize event that fires again before an earlier one's poll resolves
   *  leaves TWO settle-waits in flight. Without a generation check, the
   *  earlier (now-stale) one can resolve LATER than the newer one and apply
   *  a decision computed at an intermediate, no-longer-current shape —
   *  confirmed to corrupt an UNRELATED later screenshot (e2e section 71's
   *  CONTROL row, a viewport-sensitive length-0.2-boundary fixture) when
   *  this guard was first tried without it. Only the LATEST resize's
   *  settle-wait may apply its decision. */
  const resizeSettleGenRef = useRef(0);

  // Set up robust ResizeObserver to force Plotly bounds to sync with fluid flex columns
  useEffect(() => {
    const Plotly = (window as any).Plotly;
    if (!containerRef.current) return;

    /**
     * Debounced on purpose — this is the drag-resize "color flash" fix.
     *
     * A gl3d Plots.resize costs ~100ms+, and a live drag fires this observer
     * continuously. Resizing the plot on every event starves the main thread,
     * the page stops producing frames at the new window size, and the browser
     * fills the exposed strip with its own canvas color for the WHOLE drag —
     * white/gray in most engines, Firefox-private purple. No CSS can style
     * that canvas; the only real fix is keeping mid-drag repaints cheap so
     * the browser never falls behind. The plot holds its stale size until
     * events go quiet (its panel's own themed background covers the gap),
     * then does one real resize.
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Signal the idle spin to hold: its relayout mid-resize is what starves
    // the frame budget (see resizeBusyUntilRef). Cleared by time, so a
    // one-off layout change costs at most a quarter-second of spin.
    const holdSpin = () => { resizeBusyUntilRef.current = performance.now() + 250; };
    const observer = new ResizeObserver(() => {
      holdSpin();
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (Plotly && document.getElementById(plotId)) {
          Plotly.Plots.resize(plotId);
          // OPUS-REVIEW-MATH17 FBM-1: `Plots.resize` is internally debounced
          // (~100ms setTimeout) and gl-plot3d resizes its OWN canvas later
          // still — calling `applyContinuumCollapseAtCamera` right after (even
          // `await`ing the resize promise) reads a STALE `glplot.shape`
          // (measured: [1306,1016] before/synchronously-after/awaited,
          // [516,1016] once actually settled — precise math on the WRONG
          // viewport is worse than the old estimate on the RIGHT one, which
          // is what this call site regressed from). Poll the live shape
          // until it actually matches the container's own box (bounded, so a
          // shape that never settles still gets a decision, just a possibly
          // stale one — never blocks forever) before deciding.
          const gen = ++resizeSettleGenRef.current;
          waitForGlplotShapeSettled(plotId).then(() => {
            // A NEWER resize started while this poll was in flight — its OWN
            // settle-wait owns the next decision; applying this stale one now
            // would risk stomping a correct, more-current one (see
            // `resizeSettleGenRef`'s own comment above).
            if (resizeSettleGenRef.current !== gen) return;
            applyContinuumCollapseAtCamera(cameraRef.current);
          });
        }
      }, 150);
    });
    observer.observe(containerRef.current);
    // The observer callback runs AFTER the frame's rAF callbacks, so the
    // first drag step would still pay one expensive spin frame. The window
    // resize event dispatches BEFORE rAF in the same frame, closing that
    // gap for window drags (panel-only resizes keep the one-frame cost).
    window.addEventListener('resize', holdSpin);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener('resize', holdSpin);
    };
  }, []);

  // Latest onGraphPress without re-registering the document listeners below.
  const onGraphPressRef = useRef(onGraphPress);
  useEffect(() => { onGraphPressRef.current = onGraphPress; }, [onGraphPress]);

  /**
   * Press-anywhere-on-the-graph notifications. Independent of the idle spin's
   * listeners on purpose: those only exist while the spin is eligible (sim
   * frozen), and this must fire precisely when it is not — mid-run, so the
   * app can pause playback the moment the visitor reaches into the picture.
   * Same document-capture + rectangle hit-test approach as the spin, for the
   * same reason: Plotly's handlers and overlays swallow element-level events.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onPress = (e: Event) => {
      if (!onGraphPressRef.current) return;
      const pt = e as MouseEvent & { touches?: TouchList };
      const x = pt.touches?.[0]?.clientX ?? pt.clientX;
      const y = pt.touches?.[0]?.clientY ?? pt.clientY;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      if (pressOnUnrelatedUi(e, container)) return; // RED-APP-14/006
      const r = container.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
      onGraphPressRef.current();
    };
    document.addEventListener('mousedown', onPress, true);
    document.addEventListener('touchstart', onPress, true);
    // ZOOM counts as reaching into the picture, exactly like a press.
    //
    // A trackpad pinch is not a touch gesture on the desktop: the browser
    // delivers it as a `wheel` event with ctrlKey set, and a mouse wheel over
    // the scene zooms the camera too. Listening only for mousedown/touchstart
    // meant a pinch-zoom adjusted the view while the run kept stepping
    // underneath it — the markers moved on while the visitor was trying to
    // look. The spin's take-over handler has always included `wheel` for this
    // same reason; pausing simply did not, which is the inconsistency.
    //
    // passive: a listener that only reads coordinates must never block the
    // scroll or zoom it is observing.
    document.addEventListener('wheel', onPress, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mousedown', onPress, true);
      document.removeEventListener('touchstart', onPress, true);
      document.removeEventListener('wheel', onPress, { capture: true } as any);
    };
  }, []);


  /**
   * Pinch-to-zoom: scale the camera's eye vector on a two-finger gesture.
   *
   * Registered on the DOCUMENT in the capture phase and hit-tested by
   * coordinate — the same approach as the press-to-pause handler above and the
   * spin's take-over, for the same reason. Plotly's own gl3d touch handlers sit
   * on the canvas inside this element and stop propagation, so listeners bound
   * to the container never see the gesture: bound that way this handler was
   * attached but silently never fired, and pinch did nothing at all, whether a
   * run was going or not. Capture phase runs before Plotly can swallow it, and
   * a rectangle test cannot be fooled by whatever is layered in between.
   *
   * Pausing a running simulation is NOT done here — the press handler above
   * already fires on the same touchstart, so a pinch pauses exactly the way a
   * tap does, and that behaviour is defined in one place.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const insidePlot = (t: TouchList) => {
      const r = container.getBoundingClientRect();
      // Both fingers must be on the picture, or a pinch that happens to graze
      // the plot while zooming the PAGE would drive the camera.
      for (let i = 0; i < 2; i++) {
        const { clientX: x, clientY: y } = t[i];
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
      }
      return true;
    };

    const onTouchStart = (e: Event) => {
      const te = e as TouchEvent;
      if (te.touches.length !== 2 || !insidePlot(te.touches)) return;
      // RED-MATH-19/001: a pinch is a camera WRITER like Reset View (#170). If
      // the tour's step glide is mid-flight, its next frame would overwrite
      // every pinch relayout for the rest of the glide — the gesture became a
      // silent no-op — and once the glide ended, the idle spin resumed at ITS
      // stored radius and erased the pinch a second time (director timeline:
      // glide ~150 ms, then the spin turning at the original radius). The
      // latest intent wins: stop the glide where it is and hold the spin, the
      // two things Reset View does before writing the camera (#170). The hold
      // goes through a ref because this effect has no deps and the helper reads
      // render state (reducedMotion / idleSpin / spinAutoResumeMs).
      cancelCameraGlide();
      holdSpinRef.current();
      pinchStartDist.current = dist(te.touches);
      const eye = (document.getElementById(plotId) as any)?._fullLayout?.scene?.camera?.eye;
      pinchStartEye.current = eye ? { x: eye.x, y: eye.y, z: eye.z } : { x: 1.5, y: 1.5, z: 1.5 };
    };

    const onTouchMove = (e: Event) => {
      const te = e as TouchEvent;
      if (te.touches.length !== 2 || pinchStartDist.current === null || !pinchStartEye.current) return;
      if (!insidePlot(te.touches)) return;
      const now = dist(te.touches);
      if (now <= 0) return;
      // Stop the browser turning this into a page zoom now that it is ours.
      if (te.cancelable) te.preventDefault();
      const ratio = pinchStartDist.current / now;
      const { x, y, z } = pinchStartEye.current;
      const Plotly = (window as any).Plotly;
      Plotly?.relayout(plotId, {
        'scene.camera.eye': { x: x * ratio, y: y * ratio, z: z * ratio },
      });
    };

    const onTouchEnd = () => {
      pinchStartDist.current = null;
      pinchStartEye.current = null;
      // A one-finger rotate emits no relayout: record where the finger left
      // the camera in Plotly's own record (the relayout this issues refreshes
      // cameraRef through the listener), or the next react snaps the view back.
      syncPlotlyCameraToScene(plotId);
    };

    document.addEventListener('touchstart', onTouchStart, true);
    // passive:false so preventDefault is honoured; capture so Plotly cannot
    // consume the move first.
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', onTouchEnd, true);
    return () => {
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('touchmove', onTouchMove, { capture: true } as any);
      document.removeEventListener('touchend', onTouchEnd, true);
      document.removeEventListener('touchcancel', onTouchEnd, true);
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
    // Same guarantee `moveCamera` already gives the tour's camera glide —
    // never move the camera on the app's own initiative under this
    // preference. Early-return rather than starting the rAF loop and holding
    // it still: no frame, no relayout, no main-thread cost at all.
    if (reducedMotion) {
      // CodeRabbit on #170: a pause or auto-resume countdown entered BEFORE
      // the preference flipped on would otherwise keep the Resume button up
      // for a spin that can no longer run (same family as OPUS-REVIEW-170/A).
      // Under reduced motion no spin flag may stay set.
      spinPausedRef.current = false;
      setSpinPaused(false);
      spinWaitingRef.current = false;
      setSpinWaiting(false);
      return;
    }
    const Plotly = (window as any).Plotly;
    const container = containerRef.current;
    if (!Plotly || !container) return;

    // Every step starts spinning again, which is why spinNonce is a dependency.
    spinPausedRef.current = false;
    setSpinPaused(false);
    nextSpinAtRef.current = performance.now() + spinDelayMs;
    spinWaitingRef.current = spinDelayMs > 0;
    setSpinWaiting(spinDelayMs > 0);

    let raf = 0;
    let last = performance.now();
    let since = 0;
    /** Adaptive back-off: no frame before this clock time (see tick). */
    let coolUntil = 0;
    const RATE = 0.16;   // radians per second — a full turn takes about 40s
    const FRAME = 33;    // ms between relayouts; every frame would be wasteful
    // The gap is a multiple of the frame's MEASURED cost, but the measurement
    // only sees the synchronous slice — Plotly also queues style/paint work
    // that lands after the call returns (observed: the true long-task cost is
    // about twice the synchronous one). 5× the synchronous slice ≈ 2.5× the
    // real cost, which holds the spin near a third of the main thread.
    //
    // Touch devices only. On desktop a frame costs ~3ms and the fixed 33ms
    // cadence never saturated anything, so it keeps the original ungated
    // spin (spread 0 → coolUntil is always in the past) — same gate as the
    // marker sizing, not window width alone, so a narrow desktop window
    // doesn't lose smoothness.
    const COST_SPREAD = navigator.maxTouchPoints > 0 && window.innerWidth < 1400 ? 5 : 0;

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
      if (pressOnUnrelatedUi(e, container)) return; // RED-APP-14/006
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
    /**
     * Auto-resume mode has no permanent takeover: activity over the GRAPH —
     * the same coordinate hit-test as takeOver, so overlays can't swallow it —
     * halts the spin and restarts the countdown, and the spin quietly returns
     * once the graph has been left alone for the full interval.
     *
     * Cursor movement only counts while the spin is already waiting: a
     * pointer merely crossing the picture must not stop an active turn (and
     * must not undo the Resume button the instant the cursor leaves it), but
     * while the countdown runs, hovering the graph keeps pushing it back —
     * the visitor is still looking.
     */
    const noteActivity = (e: Event) => {
      if (pressOnUnrelatedUi(e, container)) return; // RED-APP-14/006
      const pt = e as MouseEvent & { touches?: TouchList };
      const x = pt.touches?.[0]?.clientX ?? pt.clientX;
      const y = pt.touches?.[0]?.clientY ?? pt.clientY;
      if (typeof x !== 'number' || !insidePlot(x, y)) return;
      const now = performance.now();
      if (e.type === 'mousemove' && now >= nextSpinAtRef.current) return;
      nextSpinAtRef.current = now + spinAutoResumeMs;
      if (!spinWaitingRef.current) {
        spinWaitingRef.current = true;
        setSpinWaiting(true);
      }
    };
    if (spinAutoResumeMs > 0) {
      document.addEventListener('mousemove', noteActivity, true);
      document.addEventListener('mousedown', noteActivity, true);
      document.addEventListener('wheel', noteActivity, true);
      document.addEventListener('touchstart', noteActivity, true);
      document.addEventListener('touchmove', noteActivity, true);
    } else {
      document.addEventListener('mousedown', takeOver, true);
      document.addEventListener('touchstart', takeOver, true);
      document.addEventListener('wheel', takeOver, true);
    }

    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      since += dt;
      const held = now < nextSpinAtRef.current;
      if (!held && spinWaitingRef.current) {
        spinWaitingRef.current = false;
        setSpinWaiting(false);
      }
      // While ineligible (visitor active, camera glide in flight, taken over)
      // the accumulator must stay flat — otherwise the first eligible frame
      // applies the whole banked interval as one violent jump. A COOLDOWN is
      // different: the accumulator keeps counting there, so the next frame
      // rotates by the full elapsed angle and the turn stays time-true.
      const resizeBusy = now < resizeBusyUntilRef.current;
      if (spinPausedRef.current || cameraBusy || held || resizeBusy) since = 0;
      if (!spinPausedRef.current && !cameraBusy && !held && !resizeBusy && now >= coolUntil && since >= FRAME) {
        const cam = (document.getElementById(plotId) as any)?._fullLayout?.scene?.camera;
        if (cam?.eye) {
          const a = RATE * (since / 1000);
          const { x, y, z } = cam.eye;
          const t0 = performance.now();
          Plotly.relayout(plotId, {
            'scene.camera.eye': {
              x: x * Math.cos(a) - y * Math.sin(a),
              y: x * Math.sin(a) + y * Math.cos(a),
              z,
            },
          });
          rebindPlotInput();
          /**
           * Pay for what the frame actually cost. Both relayouts above are
           * SYNCHRONOUS full re-renders; on a desktop they take a couple of
           * milliseconds, but on a phone — worse with scene annotations,
           * which are re-projected on every relayout — a single frame can
           * cost 100–240ms. At a fixed 33ms cadence the spin then owns ~100%
           * of the main thread and taps on the page queue for seconds (the
           * tour's Next button on mobile went dead exactly this way). Waiting
           * out COST_SPREAD× the measured cost before the next frame caps the
           * spin's share of the thread at ~1/(1+COST_SPREAD) ≈ 30% on ANY
           * device, while a fast machine still gets the full frame rate.
           */
          coolUntil = performance.now() + (performance.now() - t0) * COST_SPREAD;
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
      document.removeEventListener('mousemove', noteActivity, true);
      document.removeEventListener('mousedown', noteActivity, true);
      document.removeEventListener('wheel', noteActivity, true);
      document.removeEventListener('touchstart', noteActivity, true);
      document.removeEventListener('touchmove', noteActivity, true);
      rebindPlotInput();
    };
  }, [idleSpin, spinNonce, spinDelayMs, spinAutoResumeMs, reducedMotion]);

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
    // CodeRabbit (this branch): guards the post-react collapse evaluation
    // below against running after THIS effect has been invalidated (a
    // later render's cleanup already fired) — set true in that cleanup.
    let cancelled = false;

    // Build the surfaces and coordinates
    const surf = buildSurfaces(payoffs);
    const isMobile = navigator.maxTouchPoints > 0 && window.innerWidth < 1400;
    const traces = makeTraces(surf, payoffs, simState, trackingMode, allNE, isMobile, stepMode);

    // RED-MATH-13/002: index the continuum corner/midpoint traces plotting.ts
    // tagged with `meta.continuumComponentIndex`, so the camera-aware
    // collapse below can restyle by trace index after Plotly.react. A
    // component whose corner traces plotting.ts never drew (the STATIC,
    // data-space SHORT_CONTINUUM rule already collapsed it) is left out —
    // there is nothing left for the dynamic rule to hide.
    {
      const [zLo, zHi] = zRangeOfSurface(surf);
      const byComponent = new Map<number, { midpointIdx?: number; cornerIdxs: number[] }>();
      traces.forEach((t: any, idx: number) => {
        const m = t.meta;
        if (!m || m.continuumComponentIndex === undefined) return;
        let entry = byComponent.get(m.continuumComponentIndex);
        if (!entry) { entry = { cornerIdxs: [] }; byComponent.set(m.continuumComponentIndex, entry); }
        if (m.continuumRole === 'midpoint') entry.midpointIdx = idx;
        else if (m.continuumRole === 'corner') entry.cornerIdxs.push(idx);
      });
      const contMeta: ContinuumComponentMeta[] = [];
      byComponent.forEach((entry, componentIndex) => {
        if (entry.midpointIdx === undefined || !entry.cornerIdxs.length) return;
        const midTrace: any = traces[entry.midpointIdx];
        const cornerTraces: any[] = entry.cornerIdxs.map((i) => traces[i]);
        const numSurfaces = midTrace.x.length;
        const surfaces: ContinuumComponentMeta['surfaces'] = [];
        for (let si = 0; si < numSurfaces; si++) {
          surfaces.push({
            midpoint: { x: midTrace.x[si], y: midTrace.y[si], z: midTrace.z[si] },
            corners: cornerTraces.map((ct) => ({ x: ct.x[si], y: ct.y[si], z: ct.z[si] })),
          });
        }
        contMeta.push({
          componentIndex,
          midpointTraceIndex: entry.midpointIdx,
          cornerTraceIndices: entry.cornerIdxs,
          midpointBaseSize: midTrace.meta.continuumBaseSize,
          midpointShortSize: midTrace.meta.continuumShortSize,
          cornerSize: cornerTraces[0]?.marker?.size ?? 0,
          zLo, zHi,
          surfaces,
        });
      });
      continuumMetaRef.current = contMeta;
      // A fresh react always redraws corners at their STATIC (baseline)
      // visibility, so "currently collapsed by the dynamic rule" resets to
      // false for every component — a stale decision carried over from a
      // previous game/render must never suppress a restyle this render
      // actually needs (see applyContinuumCollapseAtCamera below).
      continuumCollapsedRef.current = new Map();
    }

    // 'legendonly' rather than dropping the traces: the legend entries stay put,
    // so the markers read as switched off and the legend does not reflow when
    // the tour turns them back on.
    if (hiddenTraces.length) {
      const hidden = new Set(hiddenTraces);
      for (const t of traces as any[]) {
        if (hidden.has(t.name)) t.visible = 'legendonly';
      }
    }
    // What the user switched off in the legend stays off across redraws.
    if (userHiddenGroupsRef.current.size) {
      for (const t of traces as any[]) {
        if (userHiddenGroupsRef.current.has(t.legendgroup ?? t.name)) t.visible = 'legendonly';
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
      // STRUCT-MATH-19 class 1: the callout label is a RENDERED PAYOFF, so it
      // goes through the payoff formatter like every other one. `r3(zAraw)`
      // interpolated a bare number: a payoff of 0.00025 printed "A = 0" (an
      // exact zero asserted for a value that is not), and a tiny negative
      // printed "A = 0" too because `${-0}` is "0". Prose register, not the
      // padded one — this is a label on a picture, and `fmtPayoffProse` trims
      // the trailing zeros `r3` never added, so every integer/2-dp payoff the
      // tour's presets produce is unchanged (verified in unit.test.ts).
      // Relation included ("A < 0.001", never "A = less than 0.001"): the
      // prose twin of payoffTexRhs; integer/2-dp presets still read "A = 2".
      const labelA = payoffProseRhs(zAraw);
      const labelB = payoffProseRhs(zBraw);
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
            text: [`${who} ${label}`], textposition: pos,
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
        const goldSize = isMobile ? 7 : 10.5;
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
          type: 'scatter3d', mode: 'markers',
          x: [pt.x, pt.x], y: [pt.y, pt.y], z: [zGa, zGb],
          marker: { size: goldSize, color: diamondColor, symbol: 'diamond', line: { color: calloutRing, width: ringWidth } },
          hoverinfo: 'skip', showlegend: false, cliponaxis: false,
        } as any);
        // Translucent (0.99) so the line renders in the translucent pass and
        // loses depth ties to the OPAQUE callout diamonds — the line reads as
        // passing behind/through the diamonds, never over their faces.
        traces.push({
          type: 'scatter3d', mode: 'lines',
          x: lineX, y: lineY, z: lineZ,
          opacity: 0.99,
          line: { color: diamondColor, width: 6, dash: 'solid' },
          hoverinfo: 'skip', showlegend: false,
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

    // Plotly's record and our ref must reflect what is on screen NOW, not the
    // last relayout event — a touch rotate emits none (see readLiveCamera).
    if (document.getElementById(plotId)) {
      syncPlotlyCameraToScene(plotId);
      const liveNow = readLiveCamera(plotId);
      if (liveNow) cameraRef.current = liveNow;
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
    }).then(() => {
      // CodeRabbit (this branch): `Plotly.react` returns a promise; the
      // collapse evaluation now runs after it resolves (not immediately
      // after the call returns), and the `cancelled` guard drops it if a
      // LATER render's cleanup already fired before this one resolved —
      // never restyle traces belonging to a react call this effect has
      // since superseded.
      if (cancelled) return;
      // RED-MATH-13/002: the camera this render's react just painted with
      // may already be a fusing angle (a running simulation's per-step
      // redraw, or the idle spin resuming on the same pose it left off at)
      // — evaluate once immediately rather than waiting for the next
      // relayout.
      lastContinuumEvalRef.current = performance.now();
      applyContinuumCollapseAtCamera(cameraRef.current);
    });

    // Attach camera listener after Plotly has initialized the element's event system
    const el2 = document.getElementById(plotId) as any;
    if (el2 && typeof el2.on === 'function') {
      try { el2.removeAllListeners('plotly_relayout'); } catch {}
      el2.on('plotly_relayout', (eventData: any) => {
        /*
         * Plotly reports camera interaction with GRANULAR keys: a turntable
         * drag and a wheel/pinch zoom both arrive as `scene.camera.eye`, and
         * `scene.camera` is never emitted at all (verified against this build —
         * the only keys the scene ever produced were `scene.camera.eye` and
         * `scene.dragmode`).
         *
         * Listening only for `scene.camera` therefore meant this ref NEVER
         * updated: it held DEFAULT_CAMERA for the life of the page, and every
         * Plotly.react shipped that stale pose in the layout. `uirevision`
         * normally makes Plotly ignore a supplied camera, which is why the view
         * usually survived — but on a render where it does not, the plot jumps
         * to the default angle for a frame before the live camera reasserts
         * itself. That is the flash when resuming a paused run after rotating
         * or zooming: the adjusted view, one frame of the default view, then
         * the adjusted view again.
         *
         * Reading the pose back off _fullLayout rather than trusting the event
         * payload keeps this correct whatever granularity Plotly reports, and
         * captures center/up as well as eye — a pan changes center, and only
         * eye was ever being stored.
         */
        if (!isCameraRelayout(eventData)) return;
        const live = readLiveCamera(plotId);
        if (!live) return;
        cameraRef.current = live;

        // RED-MATH-13/002: re-evaluate the camera-aware continuum collapse
        // on every relayout — this is what catches the idle spin drifting
        // into a fusing angle. Throttled to ~100ms: the spin emits one
        // relayout per animation frame (~33ms) and applyContinuumCollapseAt
        // Camera itself only restyles when a component's decision flips, so
        // the throttle just caps how often the (cheap) re-projection runs.
        {
          const nowTs = performance.now();
          if (nowTs - lastContinuumEvalRef.current >= 100) {
            if (trailingContinuumEvalTimerRef.current) {
              clearTimeout(trailingContinuumEvalTimerRef.current);
              trailingContinuumEvalTimerRef.current = null;
            }
            lastContinuumEvalRef.current = nowTs;
            applyContinuumCollapseAtCamera(live);
          } else {
            // CodeRabbit (this branch): a plain throttle silently drops an
            // event landing inside the window — fine for the idle spin
            // (another relayout follows within ~33ms), but a ONE-SHOT settle
            // (Reset View, the end of a drag) that happens to land here would
            // otherwise never get evaluated at all. Schedule a trailing
            // evaluation at the throttle boundary for the LATEST camera
            // (`cameraRef.current`, not the possibly-stale `live` this
            // particular event carried — a later event before the timer
            // fires re-arms it with the newer pose instead of stacking timers).
            if (trailingContinuumEvalTimerRef.current) clearTimeout(trailingContinuumEvalTimerRef.current);
            const delay = Math.max(0, 100 - (nowTs - lastContinuumEvalRef.current));
            trailingContinuumEvalTimerRef.current = setTimeout(() => {
              trailingContinuumEvalTimerRef.current = null;
              lastContinuumEvalRef.current = performance.now();
              applyContinuumCollapseAtCamera(cameraRef.current);
            }, delay);
          }
        }

        /*
         * Correct Plotly's OWN memory of the camera, in place.
         *
         * `uirevision` tells Plotly to keep the view IT recorded across a
         * Plotly.react and ignore whatever camera the layout carries. It does
         * not record a wheel/pinch zoom, so its memory is the pose from before
         * the zoom; the next react re-applies that older pose, it paints, and
         * only the react after that restores the real view — the flash when a
         * paused run is resumed. Keeping our own ref accurate is necessary but
         * not sufficient, precisely because uirevision means Plotly never reads
         * it.
         *
         * The memory Plotly consults is the graph div's own `layout`, so
         * writing the live pose there makes it agree with the screen. This is a
         * plain assignment: no relayout, no react, no React state change. An
         * earlier attempt bumped `uirevision` instead, which worked but forced
         * a full re-render after every gesture and made dragging feel like it
         * caught — the cost has to be zero here, because this runs on every
         * frame of every rotate.
         */
        const gd = document.getElementById(plotId) as any;
        if (gd?.layout) {
          if (!gd.layout.scene) gd.layout.scene = {};
          gd.layout.scene.camera = {
            eye: { ...live.eye },
            center: { ...(live.center ?? { x: 0, y: 0, z: 0 }) },
            up: { ...(live.up ?? { x: 0, y: 0, z: 1 }) },
          };
        }
      });

      // The "A Moves"/"B Moves" legend entries are solid-color stub traces; the
      // actual path is a separate gradient trace sharing the same legendgroup.
      // Toggle the whole group so clicking the legend hides the real path too.
      try { el2.removeAllListeners('plotly_legendclick'); } catch {}
      el2.on('plotly_legendclick', (ev: any) => {
        const clicked = ev?.data?.[ev.curveNumber];
        const grp = clicked?.legendgroup;
        if (grp === 'continuumNE') {
          // CodeRabbit (this branch): Plotly's own default `groupclick:
          // 'togglegroup'` behavior restores EVERY trace in this group —
          // including a component's corner traces the DYNAMIC rule had
          // hidden at a fusing camera — with no knowledge of
          // continuumCollapsedRef, leaving corners visibly fused until some
          // LATER camera event happens to correct it. Two things had to be
          // fixed together, both found by instrumenting a real click:
          // (1) `ev.data[ev.curveNumber].visible` — what the rest of this
          //     handler uses for `cur`/`nextVisible` — measurably DISAGREES
          //     with `document.getElementById(plotId).data`'s own live
          //     value for the SAME clicked trace at click time (Plotly
          //     appears to snapshot/derive it differently for a grouped
          //     legend entry). Direction must come from the LIVE dom data,
          //     not `ev.data`.
          // (2) A first attempt reapplied the collapse via
          //     `setTimeout(..., 0)` AFTER letting Plotly's own toggle run —
          //     but Plotly's own internal restyle for the toggle is
          //     asynchronous too, and RACES our reapply: the reapply's
          //     restyle landed BEFORE Plotly's own toggle-to-'legendonly'
          //     pass, and Plotly's pass then EXCLUDED those already-touched
          //     traces entirely, permanently desyncing them from the group.
          // Fixed by becoming the ONLY writer: suppress Plotly's own
          // default (`return false` below) and restyle the WHOLE group
          // ourselves, direction decided from the live DOM — hide:
          // everything to 'legendonly' uniformly (matches what a
          // still-fusing collapse already uses, so no future toggle ever
          // has to distinguish the two); show: everything to visible first
          // (what the user asked for), then immediately re-run the
          // camera-aware decision, which re-hides only the corners of a
          // component that is STILL fusing at the CURRENT camera —
          // synchronous, no timer, no race.
          const gdNow = document.getElementById(plotId) as any;
          const groupTraces: any[] = (gdNow?.data ?? []).filter((t: any) => t.legendgroup === 'continuumNE');
          const groupIdx: number[] = [];
          (gdNow?.data ?? []).forEach((t: any, i: number) => { if (t.legendgroup === 'continuumNE') groupIdx.push(i); });
          const anyCurrentlyShown = groupTraces.some((t) => t.visible === undefined || t.visible === true);
          if (anyCurrentlyShown) {
            userHiddenGroupsRef.current.add('continuumNE');
            (window as any).Plotly?.restyle(plotId, { visible: 'legendonly' }, groupIdx);
          } else {
            userHiddenGroupsRef.current.delete('continuumNE');
            continuumCollapsedRef.current = new Map();
            (window as any).Plotly?.restyle(plotId, { visible: true }, groupIdx);
            applyContinuumCollapseAtCamera(cameraRef.current);
          }
          return false; // we handled the WHOLE continuumNE toggle ourselves
        }
        const cur = clicked?.visible;
        const nextVisible = (cur === undefined || cur === true) ? 'legendonly' : true;
        // Record the user's choice by group (or name for ungrouped entries) so
        // the next redraw keeps it (RED-MATH-12/002).
        const key = grp ?? clicked?.name;
        if (key) { if (nextVisible === 'legendonly') userHiddenGroupsRef.current.add(key); else userHiddenGroupsRef.current.delete(key); }
        if (grp && grp !== 'amoves' && grp !== 'bmoves') return true; // Plotly's own group toggle
        // amoves/bmoves: the legend entry is a stub trace and the real path a
        // separate trace in the same group. Ungrouped entries: toggle every trace
        // sharing the clicked NAME (Plotly's default would flip just the one
        // clicked; the redraw re-applies by name — CodeRabbit).
        const indices: number[] = [];
        ev.data.forEach((t: any, i: number) => {
          if (grp ? t.legendgroup === grp : (t.name ?? '').toLowerCase() === (clicked?.name ?? '').toLowerCase()) indices.push(i);
        });
        (window as any).Plotly?.restyle(plotId, { visible: nextVisible }, indices);
        return false; // suppress Plotly's single-trace default
      });
    }

    // CodeRabbit (this branch): cancel a pending trailing continuum-collapse
    // evaluation before this effect's next run (or unmount) — the timer
    // reads refs only, so leaving it would not misbehave, but a rebuild
    // that already re-evaluates via the immediate post-react call above
    // makes an old one redundant, and unmount should not leave ANY timer
    // outstanding.
    return () => {
      cancelled = true;
      if (trailingContinuumEvalTimerRef.current) {
        clearTimeout(trailingContinuumEvalTimerRef.current);
        trailingContinuumEvalTimerRef.current = null;
      }
    };
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
          onClick={() => {
            // Reset must move the LIVE scene camera as well as our ref: the
            // pre-react sync reads the scene, so a ref-only reset would be
            // overwritten by the rotated live pose (CodeRabbit, #129).
            const Plotly = (window as any).Plotly;
            const gd = document.getElementById(plotId) as any;
            // RED-MATH-18/001: a running tour glide or the idle spin would
            // move the camera off the default on its next frame — stop both
            // before setting it, re-bind input after (order matters; see
            // cancelCameraGlide / holdSpinForCameraControl).
            cancelCameraGlide();
            holdSpinForCameraControl();
            if (Plotly && gd) Plotly.relayout(gd, { 'scene.camera': DEFAULT_CAMERA });
            rebindPlotInput();
            cameraRef.current = DEFAULT_CAMERA;
            setUiRevision(prev => prev + 1);
          }}
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

      {idleSpin && (spinPaused || spinWaiting) && (
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

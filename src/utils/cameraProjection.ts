/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared lookAt + pinhole-perspective camera helper for the equilibrium-
// continuum non-overlap contract (docs/CONTINUUM-RENDERING.md, clause 3).
//
// RED-MATH-13/002: clause 3 was validated ONLY at the default camera, but the
// app's own idle-spin animation (PlotlyView.tsx, on by default whenever the
// simulation is not running) rotates the camera within 1-2s of page load —
// at some azimuths a near-SHORT_CONTINUUM-threshold segment's corner/midpoint
// markers fuse even though they were clear at the default eye. This module is
// the ONE projection both the runtime (PlotlyView.tsx's camera-aware collapse)
// and the property-test sweep (payoffhonesty.test.ts) use, so a fix validated
// in the test is the exact same math running in the browser — previously the
// test had its own private copy of this geometry and the runtime had none.
//
// SCOPE (unchanged from the original default-camera-only helper): reliable
// only for a single 'segment' component's own corner/midpoint pairs, which
// differ along ONE axis at a time. An 'area' component's 4 corners (a true
// diagonal) and any CROSS-component pair are demonstrated mis-ranked by this
// projection (docs/CONTINUUM-RENDERING.md, "Known gaps") and are NOT gated
// here at any camera.

export const CAM_UP: [number, number, number] = [0, 0, 1];

/** plotting.ts's own default camera.eye — the app's resting pose. */
export const DEFAULT_EYE: [number, number, number] = [1.6, -1.6, 1.1];

// BLUE-MATH-15: the real bug RED-MATH-15/001 found is `x`'s scale using
// `viewport.w/2` instead of `viewport.h/2` (below, confirmed against
// Plotly's own live projection matrix: gl3d uses a FIXED vertical FOV,
// exactly Math.PI/4 per `glplot.fovy` — the `w` cancels out of the
// horizontal term algebraically, so x and y share ONE scale factor). FOCAL
// stays 3 (OPUS-REVIEW-MATH FBM-2, 2026-09-06): a fitted 3.1 was tried and
// reverted — against RED-MATH-15/001's own 24 real-pixel rows (embedded in
// payoffhonesty.test.ts's REAL_PIXEL_GROUND_TRUTH, evaluated at the REAL
// runtime viewport 276x246), F=3.0 and F=3.1 both score 18/24, while F=3.0
// leaves the widest margin on the 700x500
// static sweep (only ONE game excepted below, vs re-tuning the knob to
// paper over it) and errs toward collapsing MORE often, the safer direction
// (raising FOCAL trades toward under-collapse — the exact defect class
// RED-MATH-15/001 reported — with no check in this file bounding that
// direction before FBM-2; `testDynamicCollapseAgreesWithRealPixels`'s
// under-collapse bound is that check now). The mathematically exact value
// (1/tan(pi/8) ~= 2.41421, matching the live fovy) scores best on real
// pixels (20/24) but regresses the 700x500 static sweep far more broadly
// (52/300000 games, not one) — left for a future round alongside a
// corresponding SHORT_CONTINUUM/tolerance study, not fitted in under this
// brief.
export const FOCAL = 3.0;
export const VIEW_W = 700;
export const VIEW_H = 500;

/** A projection's target pixel dimensions. The STATIC test/threshold below
 *  is calibrated to the fixed `{VIEW_W, VIEW_H}` canonical viewport (see
 *  "Screen-space, in detail") and must never change. The RUNTIME dynamic
 *  collapse (PlotlyView.tsx) passes the LIVE plot container's own rendered
 *  size instead (CodeRabbit, this branch: marker `size` is fixed CSS px,
 *  but the projected GAP between two points scales with container width —
 *  a fixed 700x500 assumption under-predicts real fusion risk on a
 *  narrower-than-700px container, e.g. mobile, and over-predicts it on a
 *  wider one). */
export interface Viewport { w: number; h: number; }
export const DEFAULT_VIEWPORT: Viewport = { w: VIEW_W, h: VIEW_H };

/** Screen-space separation, in px, at or below which two continuumNE glyphs
 *  read as touching/fused rather than two distinct diamonds (clause 3's X). */
export const OVERLAP_TOLERANCE_PX = 1;

function v3sub(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function v3dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function v3cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function v3norm(a: readonly number[]): [number, number, number] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export interface CameraBasis {
  eye: [number, number, number];
  fwd: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
}

/** Derive the lookAt basis (forward/right/up) for an arbitrary eye vector,
 *  looking at `center` (default the scene origin — the idle spin never
 *  changes `scene.camera.center` off origin, so this default matches its
 *  own motion exactly) — the same construction Plotly's own turntable
 *  camera uses. Any camera the app reaches (idle spin, Reset View, the
 *  tour's moveCamera poses — SOME of which use a nonzero `center`, e.g.
 *  `cornerRow1Col1`/`interior` — a user drag) is just a different `eye`/
 *  `center`/`up`. CodeRabbit (this branch): a fixed `fwd = normalize(0-eye)`
 *  silently ignored a nonzero live `center`, so a collapse decision taken
 *  mid-tour on one of those close-up poses could disagree with what is
 *  actually rendered (the camera is not really looking at the origin then). */
export function cameraBasis(
  eye: readonly number[] = DEFAULT_EYE,
  center: readonly number[] = [0, 0, 0],
  up: readonly number[] = CAM_UP,
): CameraBasis {
  const e: [number, number, number] = [eye[0], eye[1], eye[2]];
  const c: [number, number, number] = [center[0], center[1], center[2]];
  const fwd = v3norm(v3sub(c, e));
  let crossVec = v3cross(fwd, up);
  // CodeRabbit (this branch): a camera looking straight down/up the `up`
  // axis makes `fwd` parallel to `up`, so cross(fwd, up) is ~0 — naively
  // normalizing that (v3norm's `|| 1` guard only catches EXACTLY zero)
  // yields a right/up pair that silently projects every point onto the SAME
  // screen position, manufacturing a FALSE "everything overlaps" reading
  // rather than a real one. Falls back to a different reference axis to get
  // a valid (if arbitrarily rolled) perpendicular basis instead.
  if (Math.hypot(crossVec[0], crossVec[1], crossVec[2]) < 1e-6) {
    const altUp: [number, number, number] = Math.abs(fwd[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    crossVec = v3cross(fwd, altUp);
  }
  const right = v3norm(crossVec);
  const up2 = v3cross(right, fwd);
  return { eye: e, fwd, right, up: up2 };
}

export const DEFAULT_CAMERA_BASIS = cameraBasis(DEFAULT_EYE);

/**
 * Approximate screen position of a data point (x,y in [0,1]; z in the game's
 * own payoff units) under the given camera basis and z-normalization range.
 * Standard lookAt+pinhole perspective over aspectmode:'cube' 's own
 * per-axis-independent normalization: x,y already span [0,1]; z is
 * centered/scaled by the SAME range `buildSurfaces` produces.
 */
export function projectPoint(
  x: number, y: number, z: number,
  zLo: number, zHi: number,
  basis: CameraBasis = DEFAULT_CAMERA_BASIS,
  viewport: Viewport = DEFAULT_VIEWPORT,
): [number, number] {
  const zSpan = (zHi - zLo) || 1e-9;
  const world: [number, number, number] = [x - 0.5, y - 0.5, (z - (zLo + zHi) / 2) / zSpan];
  const rel = v3sub(world, basis.eye);
  const vx = v3dot(rel, basis.right);
  const vy = v3dot(rel, basis.up);
  const vz = v3dot(rel, basis.fwd);
  // CodeRabbit (this branch): a point at or behind the camera plane (vz<=0)
  // would flip sign or blow up through the perspective divide, manufacturing
  // a spurious screen position. NaN drops safely out of every
  // worstPairGapPx comparison below (NaN < x is always false in JS), so a
  // pair involving it is silently excluded rather than treated as evidence
  // either way — never a false collapse, never a missed one from a bad
  // divide.
  if (vz <= 0) return [NaN, NaN];
  const sx = (vx / vz) * FOCAL;
  const sy = (vy / vz) * FOCAL;
  // BLUE-MATH-15 (RED-MATH-15/001): `sx` used to be scaled by `viewport.w / 2`,
  // matching `sy`'s `viewport.h / 2` — i.e. x and y used DIFFERENT scale
  // factors whenever the viewport isn't square. Real gl3d cameras use a FIXED
  // vertical FOV (confirmed above): the projection matrix's horizontal term
  // is `(f/aspect)*vx`, and `aspect = w/h`, so `f/aspect = f*(h/w)` — the `w`
  // cancels out algebraically and BOTH x and y end up scaled by the SAME
  // `h/2` factor (only the horizontal CENTER offset stays `w/2`). At the
  // canonical 700x500 viewport (aspect 1.4) the old w/2-scaled x was ~40%
  // too large, silently absorbed into FOCAL=3's own empirical fudge; at a
  // narrower/portrait viewport (aspect far from 1.4) the SAME fudge no longer
  // cancels, which is exactly why RED's over/under-collapse pairs were
  // viewport-specific. Verified against real rendered pixels (blob centroids)
  // at 700x500/318x298/360x640/240x400: this form's residual error is a
  // uniform ~5px at every viewport, vs up to ~90px with the old w/2 term.
  return [viewport.w / 2 + sx * (viewport.h / 2), viewport.h / 2 - sy * (viewport.h / 2)];
}

/** z-normalization range for a built surface: the payoff extrema padded by
 *  the same ±0.3 makeTraces' own bounding-box lines add (what Plotly's
 *  zaxis actually autoranges over — CodeRabbit, PR #134). */
export function zRangeOfSurface(surf: { zA: number[][]; zB: number[][] }): [number, number] {
  const all = ([] as number[]).concat(...surf.zA, ...surf.zB);
  return [Math.min(...all) - 0.3, Math.max(...all) + 0.3];
}

/**
 * Worst (most negative) projected screen-space gap among a set of markers
 * (2 corners + 1 midpoint, in the validated single-'segment'-component
 * scope) at the given camera. +Infinity when fewer than 2 points are given
 * (nothing to overlap).
 */
export function worstPairGapPx(
  points: Array<{ x: number; y: number; z: number; size: number }>,
  zLo: number, zHi: number,
  basis: CameraBasis = DEFAULT_CAMERA_BASIS,
  viewport: Viewport = DEFAULT_VIEWPORT,
): number {
  let worst = Infinity;
  const proj = points.map((p) => ({ px: projectPoint(p.x, p.y, p.z, zLo, zHi, basis, viewport), size: p.size }));
  for (let i = 0; i < proj.length; i++) {
    for (let j = i + 1; j < proj.length; j++) {
      const d = Math.hypot(proj[i].px[0] - proj[j].px[0], proj[i].px[1] - proj[j].px[1]);
      const gap = d - (proj[i].size / 2 + proj[j].size / 2);
      if (gap < worst) worst = gap;
    }
  }
  return worst;
}

export interface ContinuumPoint { x: number; y: number; z: number; }

/**
 * The ONE decision both the runtime (PlotlyView.tsx) and the property-test
 * sweep (payoffhonesty.test.ts) make: at this camera, on THIS surface, do
 * this component's own midpoint and corner markers overlap beyond clause
 * 3's tolerance? `corners` empty means the STATIC (data-space) rule already
 * collapsed this component — nothing for the dynamic rule to decide, always
 * false (never "un-collapse" something the static rule already hid; no
 * corner traces exist to show).
 */
export function shouldCollapseComponentAtCamera(
  midpoint: ContinuumPoint,
  corners: ContinuumPoint[],
  midpointSize: number,
  cornerSize: number,
  zLo: number, zHi: number,
  basis: CameraBasis = DEFAULT_CAMERA_BASIS,
  viewport: Viewport = DEFAULT_VIEWPORT,
): boolean {
  if (!corners.length) return false;
  const points = [
    { ...midpoint, size: midpointSize },
    ...corners.map((c) => ({ ...c, size: cornerSize })),
  ];
  return worstPairGapPx(points, zLo, zHi, basis, viewport) < -OVERLAP_TOLERANCE_PX;
}

// ════════════════════════════════════════════════════════════════════════
// BLUE-MATH-17 (RED-MATH-17/001, RED-MATH-16/001): everything above this
// line is the FOCAL/lookAt ESTIMATE — one fixed vertical FOV, a hand-rolled
// lookAt basis, and a manual z-normalization (`zRangeOfSurface`) that this
// round confirmed does NOT match Plotly's own live z-axis autorange (a real
// fixture's live `dataScale[2]` measured 0.08620689655172414, implying an
// axis span of 11.6 data-units; the SAME fixture's live `zaxis.range` is
// [-6.6625, 5.6625], span 12.325 — a ~6% mismatch this module has no rule
// to reproduce, since Plotly's exact autorange/padding is not published
// arithmetic). That residual is exactly why the estimate under/over-collapses
// near the tolerance boundary (docs/CONTINUUM-RENDERING.md "Known gaps"):
// no FOCAL value papers over an error that is not a focal-length error.
//
// This section is the STRUCTURAL fix: project through the LIVE gl3d camera
// matrices Plotly itself computed for the frame actually on screen —
// `gd._fullLayout.scene._scene.glplot.cameraParams` (model/view/projection,
// column-major, gl-matrix/WebGL convention) plus `scene._scene.dataScale`
// (the live x/y/z axis-to-cube scale — reads Plotly's OWN autorange instead
// of re-deriving it) and `glplot.shape`/`pixelRatio` (device px, Plotly's
// internal supersample factor). No FOCAL, no lookAt re-derivation, no
// z-range guess: every number comes from the same pipeline that drew the
// pixels.
//
// Verified against REAL rendered pixels (round16/notes/BLUE-MATH-17/,
// `_bluescratch/validate_exact.mjs` + `exact_validation.json`): per-marker
// isolation (fresh page per marker, RED-MATH-16/17's own method) at BOTH
// RED-MATH-17/001's fixture (CAMERA.overview, real 320px-mobile viewport)
// and RED-MATH-16/001's fixture (az105, 700x500) — all 6 markers (3 per
// fixture) land within 0.3 CSS px of this formula's prediction, camera- and
// viewport-independent. The two known-gap real-pixel disagreements this
// module previously could not resolve are gone at the camera/viewport that
// exposed them (see the new real-pixel e2e rows, smoke.mjs #71).
//
// Kept ONLY as a fallback (`applyContinuumCollapseAtCamera` in
// PlotlyView.tsx) for the one case it must cover: before gl-plot3d's first
// frame exists (`glplot`/`cameraParams` not yet on the DOM node). The
// runtime logs which path decided (`gd.dataset.continuumProjectionPath`)
// so a fixture can assert the exact path actually fired, not merely that a
// decision was made.

/** A 16-element column-major 4x4 matrix (WebGL/gl-matrix convention,
 *  translation in elements 12/13/14) — the exact shape of
 *  `glplot.cameraParams.model` / `.view` / `.projection`. */
export type Mat4 = ArrayLike<number>;

export interface LiveCameraParams {
  model: Mat4;
  view: Mat4;
  projection: Mat4;
}

/** `glplot.shape` — the gl3d canvas's own rendered size, in DEVICE px
 *  (already scaled by `glplot.pixelRatio`, independent of
 *  `window.devicePixelRatio`). */
export interface LiveCanvasShape { w: number; h: number; }

function mat4MulVec4(m: Mat4, v: readonly [number, number, number, number]): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) {
    out[row] = m[row] * v[0] + m[4 + row] * v[1] + m[8 + row] * v[2] + m[12 + row] * v[3];
  }
  return out;
}

/**
 * Exact screen position of a data point (x,y in [0,1]; z in the game's own
 * payoff units — RAW, not pre-normalized: `dataScale` does that, reading
 * Plotly's own live axis range) under the camera matrices gl-plot3d itself
 * used to draw this frame. `marginTop` (plotting.ts's `margin.t`, read live
 * off `_fullLayout.margin.t`) shifts the result from canvas-relative to
 * plot-DIV-relative CSS px, matching what `getBoundingClientRect()`-based
 * hit testing expects; pass 0 to get canvas-relative px (the two cancel out
 * of any GAP between two points either way, since both share the offset).
 */
export function projectPointExact(
  x: number, y: number, z: number,
  cam: LiveCameraParams,
  dataScale: readonly [number, number, number],
  shape: LiveCanvasShape,
  pixelRatio: number,
  marginTop = 0,
): [number, number] {
  const world = mat4MulVec4(cam.model, [x * dataScale[0], y * dataScale[1], z * dataScale[2], 1]);
  const eye = mat4MulVec4(cam.view, world);
  const clip = mat4MulVec4(cam.projection, eye);
  const w = clip[3];
  // Same discipline as `projectPoint`'s `vz <= 0` guard (there in eye-space;
  // here in clip-space, since a standard OpenGL perspective matrix folds
  // `w = -eye.z`): a point at or behind the camera plane must never produce
  // a spurious on-screen position. NaN drops out of every gap comparison
  // below (`NaN < x` is always false), so a bad divide silently excludes
  // that pair rather than manufacturing evidence either way.
  if (!(w > 0)) return [NaN, NaN];
  const ndcX = clip[0] / w;
  const ndcY = clip[1] / w;
  const devX = (ndcX * 0.5 + 0.5) * shape.w;
  const devY = (1 - (ndcY * 0.5 + 0.5)) * shape.h; // NDC +Y is up; device px +Y is down
  return [devX / pixelRatio, devY / pixelRatio + marginTop];
}

/** Exact-projection counterpart of `worstPairGapPx`. */
export function worstPairGapPxExact(
  points: Array<{ x: number; y: number; z: number; size: number }>,
  cam: LiveCameraParams,
  dataScale: readonly [number, number, number],
  shape: LiveCanvasShape,
  pixelRatio: number,
  marginTop = 0,
): number {
  let worst = Infinity;
  const proj = points.map((p) => ({
    px: projectPointExact(p.x, p.y, p.z, cam, dataScale, shape, pixelRatio, marginTop),
    size: p.size,
  }));
  for (let i = 0; i < proj.length; i++) {
    for (let j = i + 1; j < proj.length; j++) {
      const d = Math.hypot(proj[i].px[0] - proj[j].px[0], proj[i].px[1] - proj[j].px[1]);
      const gap = d - (proj[i].size / 2 + proj[j].size / 2);
      if (gap < worst) worst = gap;
    }
  }
  return worst;
}

/** Exact-projection counterpart of `shouldCollapseComponentAtCamera` — the
 *  PRIMARY runtime decision path (PlotlyView.tsx); `shouldCollapseComponentAtCamera`
 *  above is now the pre-first-render fallback only. */
export function shouldCollapseComponentAtCameraExact(
  midpoint: ContinuumPoint,
  corners: ContinuumPoint[],
  midpointSize: number,
  cornerSize: number,
  cam: LiveCameraParams,
  dataScale: readonly [number, number, number],
  shape: LiveCanvasShape,
  pixelRatio: number,
  marginTop = 0,
): boolean {
  if (!corners.length) return false;
  const points = [
    { ...midpoint, size: midpointSize },
    ...corners.map((c) => ({ ...c, size: cornerSize })),
  ];
  return worstPairGapPxExact(points, cam, dataScale, shape, pixelRatio, marginTop) < -OVERLAP_TOLERANCE_PX;
}

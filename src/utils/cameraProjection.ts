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

// The ONE free calibration knob (with the canonical 700x500 viewport below),
// chosen so every independently-found real fixture agrees with real reach
// evidence — see docs/CONTINUUM-RENDERING.md's "Screen-space, in detail".
export const FOCAL = 3;
export const VIEW_W = 700;
export const VIEW_H = 500;

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
 *  looking at the scene origin — the same construction Plotly's own
 *  turntable camera uses. Any camera the app reaches (idle spin, Reset View,
 *  the tour's moveCamera poses, a user drag) is just a different `eye`. */
export function cameraBasis(eye: readonly number[] = DEFAULT_EYE, up: readonly number[] = CAM_UP): CameraBasis {
  const e: [number, number, number] = [eye[0], eye[1], eye[2]];
  const fwd = v3norm(v3sub([0, 0, 0], e));
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
  return [VIEW_W / 2 + sx * (VIEW_W / 2), VIEW_H / 2 - sy * (VIEW_H / 2)];
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
): number {
  let worst = Infinity;
  const proj = points.map((p) => ({ px: projectPoint(p.x, p.y, p.z, zLo, zHi, basis), size: p.size }));
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
): boolean {
  if (!corners.length) return false;
  const points = [
    { ...midpoint, size: midpointSize },
    ...corners.map((c) => ({ ...c, size: cornerSize })),
  ];
  return worstPairGapPx(points, zLo, zHi, basis) < -OVERLAP_TOLERANCE_PX;
}

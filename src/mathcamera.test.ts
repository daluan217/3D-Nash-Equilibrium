/**
 * cameraProjection properties (BLUE-LOOP-MATH-22 sweep 7, empty probe checked in). For any eye/center/up,
 * including up within 1e-12 rad of the view axis: the basis is orthonormal and looks at the center, the
 * center projects to the viewport centre, overlap gaps do not change when the camera rolls, and a point
 * behind the camera is NaN, never a screen position. The exact path is driven by WebGL lookAt/perspective
 * matrices built here (column-major) and must agree with the same properties.   npx tsx src/mathcamera.test.ts
 */
import { cameraBasis, projectPoint, worstPairGapPx, projectPointExact, worstPairGapPxExact } from './utils/cameraProjection';
import { seededRandom } from './testing/prng';

const rnd = seededRandom(0xca3);
const fails: Record<string, string> = {};
let checks = 0;
const check = (name: string, ok: boolean, detail = '') => { checks++; if (!ok) fails[name] ??= detail; };
type V = [number, number, number];
const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u: number[], v: number[]): V => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const norm = (u: number[]): V => { const l = Math.hypot(u[0], u[1], u[2]); return [u[0] / l, u[1] / l, u[2] / l]; };
const rot = (v: number[], k: number[], th: number): V => { const c = Math.cos(th), s = Math.sin(th), kv = cross(k, v), kd = dot(k, v); return [0, 1, 2].map((i) => v[i] * c + kv[i] * s + k[i] * kd * (1 - c)) as V; };
// gl-matrix lookAt / perspective, column-major (what glplot.cameraParams holds)
const lookAt = (e: V, f: V, r: V, u: V) => [r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, e), -dot(u, e), dot(f, e), 1];
const persp = (fovy: number, aspect: number, n: number, far: number) => {
  const t = 1 / Math.tan(fovy / 2), nf = 1 / (n - far);
  return [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + n) * nf, -1, 0, 0, 2 * far * n * nf, 0];
};
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const close = (a: number, b: number) => (Number.isFinite(a) ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a)) : a === b);
const reach = { cams: 0, nearAxis: 0, behind: 0, rolled: 0 };

for (let i = 0; i < 20000; i++) {
  const eye: V = [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3], center: V = rnd() < 0.5 ? [0, 0, 0] : [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
  if (Math.hypot(eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]) < 0.3) continue;
  const f = norm([center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]]);
  const up: V = i % 4 === 0 ? [0, 0, 1] : i % 4 === 1
    ? rot(f, norm(cross(f, [rnd(), rnd(), rnd()])), 10 ** -(3 + rnd() * 9)).map((c) => c * (rnd() < 0.5 ? 1 : -1)) as V   // within 1e-3..1e-12 rad of the view axis
    : [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
  if (i % 4 === 1) reach.nearAxis++;
  const B = cameraBasis(eye, center, up), at = JSON.stringify({ eye, center, up });
  reach.cams++;
  check('the basis is orthonormal for any eye/center/up', [dot(B.fwd, B.right), dot(B.fwd, B.up), dot(B.right, B.up)].every((d) => Math.abs(d) < 1e-9)
    && [B.fwd, B.right, B.up].every((v) => Math.abs(Math.hypot(v[0], v[1], v[2]) - 1) < 1e-9), at);
  check('the camera looks at its center', dot(B.fwd, f) > 1 - 1e-9, at);
  if (Math.hypot(...cross(f, norm(up))) > 1e-3) check('the camera keeps the requested up (screen-up is the side up points to)', dot(B.up, up) > 0 && dot(B.right, cross(f, up)) > 0, at);
  const vp = { w: 200 + Math.floor(rnd() * 1200), h: 200 + Math.floor(rnd() * 900) }, zLo = -rnd() * 100, zHi = zLo + 0.001 + rnd() * 200;
  const cz = (zLo + zHi) / 2 + center[2] * (zHi - zLo), [sx, sy] = projectPoint(center[0] + 0.5, center[1] + 0.5, cz, zLo, zHi, B, vp);
  check('the center projects to the viewport centre', Math.abs(sx - vp.w / 2) < 1e-6 && Math.abs(sy - vp.h / 2) < 1e-6, `${at} ${sx},${sy} ${JSON.stringify(vp)}`);
  // handedness (gaps cannot see a mirror): a step along the camera's right goes right on screen, along its up goes up
  const d = 0.01, pr0 = (v: V) => projectPoint(center[0] + v[0] * d + 0.5, center[1] + v[1] * d + 0.5, cz + v[2] * d * (zHi - zLo), zLo, zHi, B, vp);
  check('the screen is not mirrored: camera-right is screen-right, camera-up is screen-up', pr0(B.right)[0] > vp.w / 2 + 1e-9 && pr0(B.up)[1] < vp.h / 2 - 1e-9, at);
  const pts = Array.from({ length: 3 }, () => ({ x: rnd(), y: rnd(), z: zLo + rnd() * (zHi - zLo), size: 4 + rnd() * 20 }));
  const g0 = worstPairGapPx(pts, zLo, zHi, B, vp);
  if (Number.isFinite(g0)) reach.rolled++;
  check('overlap gaps do not change when the camera rolls', close(g0, worstPairGapPx(pts, zLo, zHi, cameraBasis(eye, center, rot(B.up, B.fwd, rnd() * 2 * Math.PI)), vp)), at);
  check('overlap gaps with up exactly on the view axis (fallback basis) match the upright camera', close(g0, worstPairGapPx(pts, zLo, zHi, cameraBasis(eye, center, B.fwd), vp)), at);
  // behind the camera: eye - fwd * t in data coords (x,y shifted by 0.5, z unnormalised)
  const t = 0.01 + rnd() * 3, bw = [eye[0] - B.fwd[0] * t, eye[1] - B.fwd[1] * t, eye[2] - B.fwd[2] * t];
  const behind = projectPoint(bw[0] + 0.5, bw[1] + 0.5, (zLo + zHi) / 2 + bw[2] * (zHi - zLo), zLo, zHi, B, vp);
  reach.behind++;
  check('a point behind the camera has no screen position', behind.every(Number.isNaN), `${at} ${behind}`);

  // exact path: model = identity, dataScale = 1, so a data point is a world point; same camera via matrices
  const shape = { w: vp.w * 2, h: vp.h * 2 }, pr = 2, cam = { model: ID, view: lookAt(eye, B.fwd, B.right, B.up), projection: persp(0.2 + rnd() * 1.2, vp.w / vp.h, 0.001, 1000) };
  const [ex, ey] = projectPointExact(center[0], center[1], center[2], cam, [1, 1, 1], shape, pr, 7);
  check('exact path: the center lands on the canvas centre (plus the top margin)', Math.abs(ex - vp.w / 2) < 1e-6 && Math.abs(ey - vp.h / 2 - 7) < 1e-6, `${at} ${ex},${ey}`);
  const prE = (v: V) => projectPointExact(center[0] + v[0] * d, center[1] + v[1] * d, center[2] + v[2] * d, cam, [1, 1, 1], shape, pr, 7);
  check('exact path: the screen is not mirrored', prE(B.right)[0] > vp.w / 2 + 1e-9 && prE(B.up)[1] < vp.h / 2 + 7 - 1e-9, at);
  const wp = pts.map((p) => ({ x: p.x - 0.5, y: p.y - 0.5, z: (p.z - (zLo + zHi) / 2) / (zHi - zLo), size: p.size }));
  const e0 = worstPairGapPxExact(wp, cam, [1, 1, 1], shape, pr);
  const B2 = cameraBasis(eye, center, rot(B.up, B.fwd, rnd() * 2 * Math.PI));
  check('exact path: overlap gaps do not change when the camera rolls', close(e0, worstPairGapPxExact(wp, { ...cam, view: lookAt(eye, B2.fwd, B2.right, B2.up) }, [1, 1, 1], shape, pr)), at);
  check('exact path: a point behind the camera has no screen position', projectPointExact(bw[0], bw[1], bw[2], cam, [1, 1, 1], shape, pr).every(Number.isNaN), at);
}
check('reach: cameras, up near the view axis, finite gaps and behind-camera points all occurred',
  reach.cams >= 19000 && reach.nearAxis >= 4500 && reach.rolled >= 15000 && reach.behind >= 19000, JSON.stringify(reach));
const failed = Object.entries(fails);
if (failed.length) { for (const [n, d] of failed) console.error(`✗ ${n}: ${d.slice(0, 400)}`); process.exit(1); }
console.log(`✓ mathcamera: ${checks} checks ${JSON.stringify(reach)}`);

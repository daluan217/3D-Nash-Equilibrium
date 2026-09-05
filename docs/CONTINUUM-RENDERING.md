# Continuum rendering contract

Four rounds of red-team attacks (RED-MATH-9 through RED-MATH-12) each found the next
presentation gap in the same block of `src/utils/plotting.ts`'s `makeTraces`: a corner
hidden by the sphere, then an outline too small to poke out, then outlines fusing on
short segments, then a legend toggle discarded on redraw. Each fix was correct and each
created the next case. This is the contract those fixes converge on, stated once so the
next change can be checked against it instead of against the next screenshot.

## The contract

For every 2×2 game, in every rendered plot:

1. **Every point of every equilibrium-continuum component lies on a drawn glyph or the
   drawn dashed line.** A settled current-position sphere anywhere on a component —
   corner or interior — always has something under it that says "equilibrium." Enforced
   by `testContinuumSettledPointAlwaysOnDrawnGlyph` (300k-game sweep, data-space).
2. **A sphere pinned to a corner sits inside a visible outline larger than itself.** The
   corner marker's symbol/size (`diamond-open`, `diamondSize * 2`) must protrude around
   the sphere the way the Pure/Mixed NE diamonds do (`>= 1.3x` the sphere's own size).
   Enforced by `testContinuumCornerMarkersVisibleUniqueAndNamed`.
3. **No two continuum glyphs of one plot overlap by more than X = 1px at the default
   camera, within one component.** Marker *size* is a fixed screen-space quantity; a
   component's *length* is data-space. A component shorter than **L = 0.2** collapses to
   its single enlarged midpoint marker instead of drawing corners that would fuse with
   it. See "Screen-space, in detail" below for L's derivation and this clause's own
   validated scope.
4. **A component shorter than L draws one glyph; at or above L it draws corners +
   midpoint.** `SHORT_CONTINUUM` in `plotting.ts`, currently `0.2`.
5. **Shared corners draw once.** Two components meeting at an exact point (an L-shaped
   or chained equilibrium set) push that corner's marker a single time, not once per
   component (`drawnCorners` deduped across the whole `continuumRects.forEach`, not
   reset per component).
6. **Hover never shows an internal name.** Every continuum marker carries the real name
   `'Equilibrium continuum'`; every purely decorative trace (`name: '_'`) sets
   `hoverinfo: 'skip'`.
7. **Legend group toggles persist across redraws.** Hiding the `continuumNE` legend
   group (or any group) survives the next `Plotly.react` call triggered by a running
   simulation, not just a same-data re-render (`PlotlyView.tsx`'s `userHiddenGroupsRef` +
   `plotly_legendclick` handler).
8. **Mobile sizes scale the same contract.** `isMobile` halves marker sizes
   (`diamondSize`, `sphereSize` and their multipliers) uniformly; clauses 2–4 hold at
   both size sets, checked in `testContinuumCornerMarkersVisibleUniqueAndNamed` and
   `testShortContinuumCollapsesToOneMarker`.

## Screen-space, in detail — deriving L and X

Clause 3 needs a way to compare a data-space length (a component's own extent) against a
screen-space marker size, which needs *some* model of the camera. `plotting.ts`'s
`plotLayout.scene` uses `camera: { eye: { x: 1.6, y: -1.6, z: 1.1 } }` and
`aspectmode: 'cube'` (each axis independently normalized — confirmed by reading the
source, not assumed). `payoffhonesty.test.ts`'s `projectDefaultCamera` is a standard
lookAt + pinhole-perspective projection over that same per-axis normalization: x, y
already span `[0,1]`; z is centered/scaled by the game's own payoff-surface range, padded
by the same ±0.3 `makeTraces`' own bounding-box lines add at the extrema (`zRangeOfSurface`
— what Plotly's zaxis actually autoranges over, not just the bare surface grid;
CodeRabbit caught this test undercounting it on PR #134). `FOCAL = 3` and a canonical
700×500 viewport are the
one free calibration knob, chosen so every independently-found real fixture agrees with
real reach evidence (below).

**This projection is deliberately approximate** — not a byte-for-byte reproduction of
Plotly's WebGL pipeline, which lives only in the real browser (e2e section 47;
`round9/review/vis_continuum_shot.mjs`). Building it surfaced two things worth recording
plainly:

- **It found a real defect.** `#130` shipped `SHORT_CONTINUUM = 0.12` as a guess between
  RED-MATH-12/001's own two measured points (0.053 long: fused; 0.2 long: clearly
  legible) — never itself checked against real render output. The property test's sweep,
  restricted to single-`segment` components (see scope below), found real fusion —
  confirmed by hand in an actual browser screenshot, the identical "nested flower"
  pattern as the original finding — at lengths up to **0.1429**, and a hand-verified
  photographed case at exactly **0.125**. `SHORT_CONTINUUM` is now **0.2**: the red's own
  directly-observed safe bound, with zero violations found above it in the same sweep.
- **It has a validated scope, and two demonstrated failure modes outside it.** The
  helper is reliable for a single `segment` component's own corner/midpoint pairs, which
  differ along only ONE axis (the other is pinned) — exactly clause 3's target shape.
  Applied to a pair that differs along BOTH x and y at once (a true diagonal), it
  mis-ranks distance: an `'area'` component's own 4 corners, and a CROSS-component pair
  from two different components, both produced a wrong answer (a false positive on one
  pair, a false negative on the actual close pair, confirmed by a real browser
  screenshot — see "Known gaps"). Clause 3 is gated ONLY for the validated shape;
  clause 5's exact-coincidence dedup is unaffected and covers shared corners separately.

## Known gaps (found, reproduced, intentionally not gated)

**Cross-component screen-adjacency has no data-space correlate.** Two full-length,
right-angle-meeting components (an L-shaped equilibrium set — RED-MATH-11/003's own
fixture, `a11:-3,a12:4,a21:-3,a22:1,b11:1,b12:1,b21:6,b22:-2`) each draw their own
midpoint marker; at the default camera these two markers project only ~1.5 CSS px apart
— confirmed by hand (build `dist`, load the fixture, screenshot `[data-tour="plot"]`,
zoom the shared edge: two hollow diamonds touching, still individually legible, not one
fused blob). The two midpoints are 0.707 data-units apart — i.e. genuinely far; the
closeness is pure camera-angle perspective with no data-space threshold that could catch
it. Closing this needs `makeTraces` to reason about the live camera, which it does not
do anywhere today. Given the SAME projection helper demonstrably mis-ranks this exact
shape (diagonal pairs), a fix could not be validated with the tooling in hand — left
open rather than shipped as an unvalidated architecture change. A future round: either
build a WebGL-accurate projection (real `cameraParams`, not an approximation) before
attempting a fix, or accept this as a rare, borderline (not a "blob"), multi-component-
only case.

## What each fix's mutation test proves

Relax any one clause and name what fails:

- Drop the corner-outline size (`diamondSize * 2` → `* 0.85`): the sphere-protrusion
  check in `testContinuumCornerMarkersVisibleUniqueAndNamed` fails.
- Drop the cross-component corner dedup (reset `drawnCorners` per component): the
  uniqueness check in the same test fails on the L-shape fixture.
- Drop the short-component collapse (`SHORT_CONTINUUM = 0.2` → `0.12`, or `isShort ?
  [] : cornersRaw` → always `cornersRaw`): `testShortContinuumCollapsesToOneMarker`'s
  marker-count assertions fail, and independently so does the new screen-space sweep's
  marker-count and overlap assertions on the 0.125/0.1429/0.1905-length fixtures.
- Drop the legend re-apply (`userHiddenGroupsRef` check in the trace-rebuild effect):
  e2e section 47 fails ("the continuum group is still hidden after the simulation
  redraw").
- Drop the `hoverinfo: 'skip'` on decorative traces: the hover-name check in
  `testContinuumCornerMarkersVisibleUniqueAndNamed` fails.

All verified by actually reverting each fix and re-running the named check.

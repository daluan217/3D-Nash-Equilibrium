# Continuum rendering contract

Four rounds of red-team attacks (RED-MATH-9 through RED-MATH-12) each found the next
presentation gap in the same block of `src/utils/plotting.ts`'s `makeTraces`: a corner
hidden by the sphere, then an outline too small to poke out, then outlines fusing on
short segments, then a legend toggle discarded on redraw. Each fix was correct and each
created the next case. This is the contract those fixes converge on, stated once so the
next change can be checked against it instead of against the next screenshot.

## The contract

For every 2×2 game, in every rendered plot:

1. **Every point of every equilibrium-continuum `segment` lies on a drawn glyph or the
   drawn dashed line.** A settled current-position sphere anywhere on a segment —
   corner or interior — always has something under it that says "equilibrium." Enforced
   by `testContinuumSettledPointAlwaysOnDrawnGlyph` (300k-game sweep, data-space).
   An `area` component is drawn as its dashed perimeter plus its corner and midpoint
   markers; a point in its interior (e.g. `(0.25, 0.25)` of the full square) has the
   perimeter around it but no glyph under it — see "Known gaps".
2. **A sphere pinned to a corner sits inside a visible outline larger than itself.** The
   corner marker's symbol/size (`diamond-open`, `diamondSize * 2`) must protrude around
   the sphere the way the Pure/Mixed NE diamonds do (`>= 1.3x` the sphere's own size).
   Enforced by `testContinuumCornerMarkersVisibleUniqueAndNamed`.
3. **No two continuum glyphs of one component overlap by more than X = 1px AT ANY
   CAMERA THE APP ITSELF REACHES** — the default camera, Reset View, the tour's
   `moveCamera` poses, a user drag/pinch, and the idle spin (RED-MATH-13/002: this
   clause used to read "at the default camera" only, and the idle spin — on by default
   whenever the simulation is not running, `App.tsx`'s `idleSpin`/`spinDelayMs` — drifts
   past fusing angles within 1-2s of a fresh page, with no user action). Two layers
   enforce it: a STATIC, data-space one (below) that is right on the FIRST paint before
   any camera has moved, and a DYNAMIC, camera-aware one that keeps it right as the
   camera moves.
   - **Static**: marker *size* is a fixed screen-space quantity; a component's *length*
     is data-space. A component shorter than **L = 0.2** collapses to its single
     enlarged midpoint marker instead of drawing corners that would fuse with it. See
     "Screen-space, in detail" below for L's derivation and this clause's own validated
     scope.
   - **Dynamic**: `src/utils/cameraProjection.ts` (shared by `PlotlyView.tsx`'s runtime
     collapse and `payoffhonesty.test.ts`'s property sweep — ONE projection, so a camera
     the test proves safe is the exact math the browser runs) projects each component's
     own corner/midpoint centers through the CURRENT `scene.camera.eye` on every
     `plotly_relayout` (throttled ~100ms; the idle spin emits one relayout per frame).
     When the projected corner↔midpoint separation for a component falls below X, its
     corner traces are hidden (`Plotly.restyle` visibility, by the stable
     `meta.continuumComponentIndex`/`continuumRole` plotting.ts tags each trace with) and
     its midpoint marker is enlarged to the same size the static collapse uses — restyled
     only when a component's decision actually flips, never a full `Plotly.react`. Scoped
     identically to the static rule's own validated geometry (single `segment` components
     — see "Screen-space, in detail"); an `area` component or a cross-component pair is
     the same pre-existing "Known gap" below, unchanged by this clause.
     **Validated viewport range (BLUE-MATH-15, RED-MATH-15/001):** the dynamic rule reads
     the LIVE plot container's own rendered size and passes it into `projectPoint`
     (`PlotlyView.tsx`'s `applyContinuumCollapseAtCamera`) — RED-MATH-15/001 found this
     genuinely disagreed with real rendered pixels at a narrow live viewport (318x298,
     360x640, 240x400), never checked before against pixels at anything but the canonical
     700x500. Root cause and fix: see "Screen-space, in detail" below and its "Known gaps"
     addition — one class (aspect-ratio-dependent scaling) is fixed and validated at all
     four viewports; a second, near-`SHORT_CONTINUUM`-boundary class remains open.
     **OPUS-REVIEW-MATH NOTE-1:** the height passed in is the plot DIV's own
     `getBoundingClientRect()` height MINUS `plotting.ts`'s own `margin.t: 10` — the gl3d
     canvas itself renders `margin.t` px shorter than the div (confirmed live:
     `glplot.shape` for a 276×256 div is 276×246), so feeding the raw div height
     over-predicts the scale factor by ~4% at this size (~2% at 700x500). Free improvement,
     not neutral: it moves real-pixel agreement from 17/24 to 18/24 at this exact fixture.
4. **A component shorter than L draws one glyph; at or above L it draws corners +
   midpoint.** `SHORT_CONTINUUM` in `plotting.ts`, currently `0.2`, compared with a
   `1e-9` tolerance: the contract is on the EXACT length, so a component whose length is
   1/5 (e.g. `A=[[1,0],[0,4]]`, `B=[[0,0],[1,0]]`, computed as `0.19999999999999996`) is AT
   the threshold and keeps its corners, and relabelling a game (rows, columns, players)
   can never move it across the branch. Guarded by
   `testShortContinuumCutoffIsExactAndRelabelInvariant` on both size sets.
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
8. **Mobile sizes scale the same contract.** `isMobile` selects a smaller size set —
   `diamondSize` 10.5 → 7, `sphereSize` 8 → 5.5, `ghostSize` 6.5 → 5 (roughly two thirds,
   not half). Clauses 2–4 constrain RATIOS between a marker and the sphere (a corner
   outline is `diamondSize * 2`: 21 vs 8 on desktop, 14 vs 5.5 on mobile, both well above
   the `>= 1.3x` bar), so they hold at either set; the named tests
   (`testContinuumCornerMarkersVisibleUniqueAndNamed`, `testShortContinuumCollapsesToOneMarker`)
   run at the desktop set only. The mobile set has no separate automated check.

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
CodeRabbit caught this test undercounting it on PR #134). `FOCAL = 3` and the SCALE FACTOR
applied to a viewport `{w,h}` are the two free calibration knobs, chosen so every
independently-found real fixture agrees with real reach evidence (below); the canonical
700×500 viewport is `DEFAULT_VIEWPORT`, used when no live container size is available (the
STATIC test) or for a caller that has none. **Note (OPUS-REVIEW-MATH NOTE-6): this
constant is untouched, but `FOCAL` is a SHARED knob — a change to it (as below) moves the
static rule's own predicted gaps even though `DEFAULT_VIEWPORT` never does. "Must never
change" describes the viewport, not the calibration it feeds into.**

**BLUE-MATH-15 (RED-MATH-15/001):** `projectPoint`'s screen-space x used to scale by
`viewport.w/2`, independently of y's `viewport.h/2` — correct only by coincidence at the
canonical viewport's own 700:500 aspect ratio. Read live from Plotly's own gl3d state
(`glplot.fovy`, `glplot.cameraParams.{view,projection,model}`) at the default camera AND at
every RED-MATH-15/001 narrow viewport: the real vertical field of view is a HARDCODED
constant, exactly `Math.PI / 4`, independent of aspect ratio or data — a standard
fixed-vertical-FOV perspective camera, where the horizontal projection term is `f/aspect`
with `aspect = w/h`; the `w` cancels out of that term algebraically, so x and y share
the SAME scale factor, `viewport.h/2` (only the horizontal CENTER offset stays `w/2`).
`cameraBasis`'s own right/up/forward vectors were independently confirmed to match
Plotly's live view matrix to 10+ decimal places at two different rotated cameras — the
basis construction is not implicated by this or the open finding below.

**The evidence for the fix is `payoffhonesty.test.ts`'s `testDynamicCollapseAgreesWithRealPixels`**
— RED-MATH-15/001's own 24 real-pixel-verified rows (`groundtruthFused`, a real
screenshot's connected-components count) embedded literally, compared against the
module's own decision at the fixture/viewport/azimuths those pixels were read from. This
IS the reproducible number the fix stands on (a prior draft cited an untracked
calibration script's own "~5px residual" claim as the justification — OPUS-REVIEW-MATH
NOTE-8 — which is not reproducible from the repo and has been dropped in favor of this
embedded, checked number): **14/24 agree before the x-scale fix, 18/24 after** (at the
CORRECT runtime viewport, 276×246 — see NOTE-1 below; a prior draft of this document said
"17/24 both before and after," measured at the wrong viewport, 276×256, which also
undercounts the fix's own improvement — OPUS-REVIEW-MATH NOTE-4). The three azimuths that
flip (195, 210, 315) all flip TOWARD the pixels; none flips away.

**FOCAL stays 3** (OPUS-REVIEW-MATH FBM-2, 2026-09-06 — a fitted `3.1` was tried and
reverted). The x-scale fix alone leaves exactly ONE game, out of the existing 300,000-draw
static (default-camera, 700x500) sweep's 42,151 single-component continuum games, at
-1.074px — 0.074px past tolerance, on a game whose continuum sits EXACTLY at
`SHORT_CONTINUUM`'s own boundary length (0.2), which the sweep's own history already
treats as razor-thin by design (chosen with "zero violations found ABOVE it," never a
padded margin). Hand-verified in a real render (a11:1,a12:-1,a21:-2,a22:-1,b11:4,b12:0,
b21:-8,b22:-7, 700x500 default camera): the corners are clearly separated, not fused — a
false positive from the approximation at this one razor-thin length, EXCEPTED (not swept
under a widened `OVERLAP_TOLERANCE_PX`, which would loosen every other collapse decision
app-wide) in `testContinuumMarkersDoNotOverlapOnScreen`. Against the real-pixel ground
truth: raising FOCAL to 3.1 does not change the 18/24 agreement (still 18 at 276×246, and
strictly worse at 318×298 and the non-runtime 276×256 viewport), while raising it further
(3.5, 4) makes it steadily WORSE (13/24, 12/24) — FOCAL enlarges every projected gap,
trading toward UNDER-collapse, the exact defect class RED-MATH-15/001 reported (the fused
"X"). `testDynamicCollapseAgreesWithRealPixels`'s `underCollapse <= 4` bound is the guard
on that direction FOCAL had none of before. The mathematically exact value
(`1 / tan(Math.PI / 8)` ≈ 2.41421, matching the live `fovy` precisely) scores BEST on real
pixels (20/24) but regresses the 700x500 static sweep far more broadly (52/42,151 games,
not one) — left for a future round alongside a corresponding `SHORT_CONTINUUM`/tolerance
study, not fitted in under this brief.

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

**Near-`SHORT_CONTINUUM`-boundary over-collapse at a narrow viewport (BLUE-MATH-15,
RED-MATH-15/001, OPEN, PRE-EXISTING).** RED-MATH-15/001's own two hand-verified pixel
trials, both on the exact length-0.2 fixture (`A=[[0,1],[4,0]]`, `B=[[0,0],[0,1]]`) at
318x298 (real plot div, minus `margin.t`: 276x246): az195 (under-collapse) is now fixed by
the x-scale correction above — confirmed by pixels (e2e section 71) and data-space
(`payoffhonesty.test.ts`'s `testDynamicCollapseAgreesWithRealPixels`). **az225
(over-collapse) is NOT fixed, and is NOT introduced by this PR either** (OPUS-REVIEW-MATH
NOTE-5): the un-fixed formula ALREADY hides at az225 on `main` (worst pair -1.55px there;
-2.07px after this fix — worse in degree, not in kind). Real pixels there show two corner
diamonds with a clean, generous gap (RED's own screenshot, hand-confirmed) — the module
still hides both. Diagnosed: at az225, `worstPairGapPx`'s worst PAIR is midpoint-vs-corner
(a healthy +5.5-6.6px for corner-vs-corner alone on both `main` and this fix, matching the
real gap) — the midpoint's own predicted screen position lands implausibly close to a
corner's for this configuration. Tried FOCAL from 2.5 to 4 and both the live plot div
(276x256) and its underlying WebGL sub-shape (276x246, from `glplot.shape/pixelRatio`) —
no combination flips az225 correct without reopening az195 or regressing the wider
real-pixel agreement count (`testDynamicCollapseAgreesWithRealPixels`'s own
`overCollapse === 2` bound tracks this exactly: az225 and az240). Left open rather than
shipped as a fabricated pass: a future round should build (or read live from Plotly, per
the module's own preference for that) an EXACT projection — this linear pinhole
approximation's residual error is evidently large enough, specifically for
midpoint-to-corner distances near this length's own geometry, to flip a decision the
corner-to-corner distance alone gets right.

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
- Drop the dynamic (camera-aware) collapse's relayout hook (disable the
  `plotly_relayout` handler's `applyContinuumCollapseAtCamera` call in
  `PlotlyView.tsx`): e2e section 62's fusing-eye check fails (corner traces stay
  visible and overlapping at the spin-sampled fusing camera; the default-camera
  check in the same section still passes, since the static rule alone is
  correct there).
- Drop the x-scale fix (`viewport.h / 2` → `viewport.w / 2` for x, BLUE-MATH-15): both
  `payoffhonesty.test.ts`'s `testDynamicCollapseAgreesWithRealPixels` (14/24 agree, fails
  the `agree >= 18` bound) and e2e section 71's two pixel checks (the collapse precondition
  and the FIX check) fail.

All verified by actually reverting each fix and re-running the named check.

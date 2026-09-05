/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GamePayoffs, SimState, NashEquilibrium } from '../types';
import { EA, EB, r3, equilibriumSet, kindOf, pointInRect } from './gameEngine';

export interface SurfaceData {
  xs: number[];
  ys: number[];
  zA: number[][];
  zB: number[][];
}

// ── Surface data generator ──────────────────────────────────────────────────
export function buildSurfaces(g: GamePayoffs): SurfaceData {
  const N = 28;
  const xs: number[] = [];
  const ys: number[] = [];
  const zA: number[][] = [];
  const zB: number[][] = [];
  
  for (let i = 0; i <= N; i++) xs.push(i / N);
  for (let j = 0; j <= N; j++) ys.push(j / N);
  
  for (let yi = 0; yi <= N; yi++) {
    const rA: number[] = [];
    const rB: number[] = [];
    for (let xi = 0; xi <= N; xi++) {
      rA.push(EA(xi / N, yi / N, g));
      rB.push(EB(xi / N, yi / N, g));
    }
    zA.push(rA);
    zB.push(rB);
  }
  return { xs, ys, zA, zB };
}

// ── Trace builder for Plotly 3D graph ────────────────────────────────────────
export function makeTraces(
  surf: SurfaceData,
  g: GamePayoffs,
  s: SimState,
  trackingMode: 'A' | 'B' | 'both',
  allNE: NashEquilibrium[],
  isMobile = false,
  stepMode: 'shrink' | 'regret' = 'shrink'
): any[] {
  // The NE diamond is the PRECISE marker for the equilibrium coordinate, so it
  // stays small (the surfaces' domain/range is tight — a large marker would hide
  // exactly where the NE sits). The current-position sphere is drawn a touch
  // smaller than the diamond and rendered AFTER it, so at convergence the sphere
  // sits on top with just the diamond's corners poking out around it — the
  // equilibrium stays pinpointed and both markers are visible.
  const diamondSize = isMobile ? 7 : 10.5;
  const sphereSize = isMobile ? 5.5 : 8;
  // Phase 2 ghost (search) markers stay smaller than the current-position
  // spheres so the size hierarchy reads ghost < sphere < diamond at every
  // breakpoint.
  const ghostSize = isMobile ? 5 : 6.5;
  // GEOMETRY comes from the exact coordinate, never the r3-rounded one.
  //
  // cx/displayX are rounded for READOUT. Positioning a marker with them puts
  // the current-position sphere up to 5e-4 away from where the simulation
  // actually is — and at convergence that is 5e-4 away from the NE diamond,
  // which sits on the exact equilibrium. Two visible symptoms came from it:
  // the sphere and the diamond were plainly not concentric at convergence, and
  // because their depths then differed by a hair instead of being identical,
  // the depth test flipped between frames at some camera angles and the sphere
  // flickered inside the diamond. types.ts says it directly: display from
  // cx/cy, decide anything true from exactX/exactY — and where a marker sits
  // in space is a truth, not a display.
  let px = s.exactX ?? s.displayX ?? s.cx;
  let py = s.exactY ?? s.displayY ?? s.cy;
  // At CONVERGENCE, pin the marker to the equilibrium it converged on.
  //
  // Every step's coordinate goes through r3 for readout, and the next step is
  // computed from that rounded value, so the settled position sits up to 5e-4
  // from the exact equilibrium. The NE diamond is drawn on the exact
  // coordinate, so the two markers were visibly off-centre — and, being at
  // slightly different depths rather than the same one, which of them won the
  // depth test flipped as the idle spin orbited the camera. That is the
  // flicker: the sphere blinking inside the diamond while the graph turns.
  //
  // 1e-3 is deliberately just above r3's worst case (5e-4): it can only ever
  // absorb the rounding the pipeline itself introduced, never bridge a real
  // gap between where the run stopped and where the equilibrium is. The run
  // has already declared it converged on this equilibrium; at a distance the
  // readout cannot express, drawing them as one point is what that means.
  if (s.converged) {
    const settled = allNE.find((n) => Math.abs(n.x - px) < 1e-3 && Math.abs(n.y - py) < 1e-3);
    if (settled) { px = settled.x; py = settled.y; }
  }
  // Current-position sphere z: use the SAME unrounded EA/EB the NE diamond uses
  // (not r3-rounded). At convergence the sphere and diamond share coordinates, so
  // matching the z computation makes their depths bit-identical — then draw order
  // (spheres are pushed last) puts the sphere on top, instead of a ~0.0003 z gap
  // from rounding letting the opaque diamond win the depth test and hide it.
  const eA = EA(px, py, g);
  const eB = EB(px, py, g);

  let aMoveLegendShown = false;
  let bMoveLegendShown = false;

  const traces: any[] = [
    {
      type: 'surface',
      name: 'E[A]',
      x: surf.xs,
      y: surf.ys,
      z: surf.zA,
      colorscale: 'Reds',
      // Reverse so low payoff (which sits nearer the default camera) renders
      // dark and high/far payoff fades lighter — the conventional depth cue.
      reversescale: true,
      opacity: 0.6,
      showscale: false
    },
    {
      type: 'surface',
      name: 'E[B]',
      x: surf.xs,
      y: surf.ys,
      z: surf.zB,
      colorscale: 'Blues',
      reversescale: true,
      opacity: 0.45,
      showscale: false
    },
  ];

  // ── Domain / search-corridor bounding box ─────────────────────────────────
  {
    const regretBox = stepMode === 'regret'
      && allNE.some(n => n.type === 'mixed') && !allNE.some(n => n.type === 'pure');
    // Regret mode brackets each player with their own domain, so the box is the
    // rectangle [A's x-domain] × [B's y-domain], contracting onto the NE.
    const loX = regretBox ? s.domXLo : s.domainLo;
    const hiX = regretBox ? s.domXHi : s.domainHi;
    const loY = regretBox ? s.domYLo : s.domainLo;
    const hiY = regretBox ? s.domYHi : s.domainHi;
    const zC = [
      EA(loX, loY, g), EA(loX, hiY, g), EA(hiX, loY, g), EA(hiX, hiY, g),
      EB(loX, loY, g), EB(loX, hiY, g), EB(hiX, loY, g), EB(hiX, hiY, g)
    ];
    const zMax = Math.max(...zC) + 0.3;
    const zMin = Math.min(...zC) - 0.3;

    // XOR: exactly one coordinate discovered -> phase 2 (search corridor)
    const oneFound = (s.discoveredMixedX !== null) !== (s.discoveredMixedY !== null);
    const boxColor = oneFound ? '#e67e22' : '#27ae60';
    const boxName  = oneFound ? 'Search corridor' : 'Domain boundary';

    // Top and bottom 2D bounding boxes
    [[loX, hiX, hiX, loX, loX], [loX, loX, hiX, hiX, loX]].forEach((xA, idx) => {
      const yA = idx === 0 ? [loY, loY, hiY, hiY, loY] : [loY, hiY, hiY, loY, loY];
      
      // Bottom flat square
      traces.push({
        type: 'scatter3d',
        mode: 'lines',
        name: idx === 0 ? boxName : '_',
        showlegend: idx === 0,
        x: xA,
        y: yA,
        z: [zMin, zMin, zMin, zMin, zMin],
        line: { color: boxColor, width: 3, dash: 'dot' }
      });
      
      // Top flat square
      traces.push({
        type: 'scatter3d',
        mode: 'lines',
        name: '_',
        hoverinfo: 'skip', // RED-MATH-11/002: decorative line, never a hover label
        showlegend: false,
        x: xA,
        y: yA,
        z: [zMax, zMax, zMax, zMax, zMax],
        line: { color: boxColor, width: 3, dash: 'dot' }
      });
    });

    // Vertical pillars of the bounding box
    [[loX, loY], [hiX, loY], [hiX, hiY], [loX, hiY]].forEach(c => {
      traces.push({
        type: 'scatter3d',
        mode: 'lines',
        name: '_',
        hoverinfo: 'skip', // RED-MATH-11/002: decorative line, never a hover label
        showlegend: false,
        x: [c[0], c[0]],
        y: [c[1], c[1]],
        z: [zMin, zMax],
        line: { color: boxColor, width: 3, dash: 'dot' }
      });
    });

    // ── Phase 2 extra graphics: ghost spheres + search-range surface line ──
    if (oneFound && stepMode !== 'regret') {
      const gx = s.calcX ?? px;
      const gy = s.calcY ?? py;

      let ghostAMovesLegendShown = false;
      let ghostBMovesLegendShown = false;

      // --- Rendering on surface A ---
      if (trackingMode === 'A' || trackingMode === 'both') {
        const zCurrentA = r3(EA(gx, gy, g));

        // Connecting lines for Ghost path segments on surface A
        s.ghostPathSegmentsA.forEach(seg => {
          const isMoverA = seg.mover === 'A';
          const color = isMoverA ? 'rgba(231, 76, 60, 0.45)' : '#B6C7ED';
          const legendName = isMoverA ? 'A moves (Ghost)' : 'B moves (Ghost)';
          const showLegend = isMoverA ? !ghostAMovesLegendShown : !ghostBMovesLegendShown;
          if (isMoverA) ghostAMovesLegendShown = true;
          else ghostBMovesLegendShown = true;

          traces.push({
            type: 'scatter3d',
            mode: 'lines',
            name: showLegend ? legendName : '_',
            showlegend: showLegend,
            x: seg.xs,
            y: seg.ys,
            z: seg.zs,
            line: { color, width: 3 }
          });
        });

        // Current ghost position marker on Surface A (should represent A's ghost as a light red sphere)
        const ghostName = 'Search position (Ghost A)';
        const ghostColor = 'rgba(213,44,26,0.35)';
        const ghostLineColor = 'rgba(213,44,26,0.6)';

        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: ghostName,
          showlegend: true,
          x: [gx],
          y: [gy],
          z: [zCurrentA],
          marker: {
            size: ghostSize,
            color: ghostColor,
            symbol: 'circle',
            line: { color: ghostLineColor, width: 1.5 }
          }
        });
      }

      // --- Rendering on surface B ---
      if (trackingMode === 'B' || trackingMode === 'both') {
        const zCurrentB = r3(EB(gx, gy, g));

        // Connecting lines for Ghost path segments on surface B
        s.ghostPathSegmentsB.forEach(seg => {
          const isMoverA = seg.mover === 'A';
          const color = isMoverA ? 'rgba(231, 76, 60, 0.45)' : '#B6C7ED';
          const legendName = isMoverA ? 'A moves (Ghost)' : 'B moves (Ghost)';
          const showLegend = isMoverA ? !ghostAMovesLegendShown : !ghostBMovesLegendShown;
          if (isMoverA) ghostAMovesLegendShown = true;
          else ghostBMovesLegendShown = true;

          traces.push({
            type: 'scatter3d',
            mode: 'lines',
            name: showLegend ? legendName : '_',
            showlegend: showLegend,
            x: seg.xs,
            y: seg.ys,
            z: seg.zs,
            line: { color, width: 3 }
          });
        });

        // Current ghost position marker on Surface B (should represent B's ghost as a matte light blue sphere)
        const ghostName = 'Search position (Ghost B)';
        const ghostColor = '#B6C7ED';
        const ghostLineColor = '#B6C7ED';

        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: trackingMode === 'B' ? ghostName : '_',
          showlegend: trackingMode === 'B',
          x: [gx],
          y: [gy],
          z: [zCurrentB],
          marker: {
            size: ghostSize,
            color: ghostColor,
            symbol: 'circle',
            line: { color: ghostLineColor, width: 1.5 }
          }
        });
      }

    }
  }

  // ── Flatness lines + anchor curtains at mixed NE (only after both coords locked) ─
  if (s.discoveredMixedX !== null && s.discoveredMixedY !== null) {
    const xStar = s.discoveredMixedX;
    const yStar = s.discoveredMixedY;
    const FLAT_STEPS = 50;

    // E[A](x, y*) swept over x: flat because A is indifferent at y* — dark red
    const fXa: number[] = [], fYa: number[] = [], fZa: number[] = [];
    for (let i = 0; i <= FLAT_STEPS; i++) {
      const xi = i / FLAT_STEPS;
      fXa.push(xi); fYa.push(yStar); fZa.push(r3(EA(xi, yStar, g)));
    }
    // White casing under the indifference/strategy lines. They lie on top of
    // the A-Moves/B-Moves path stripes and were getting lost in them; a halo
    // separates them from any clutter, on either theme, without dimming or
    // removing the movement paths themselves.
    // The casing carries the SAME name as its line (with showlegend off) so
    // the tour's hide-by-name treats them as one object — a casing named '_'
    // stayed behind as an orphan white stripe when its line was hidden.
    traces.push({
      type: 'scatter3d', mode: 'lines', name: 'A indifferent (y = y*)', showlegend: false,
      hoverinfo: 'skip', x: fXa, y: fYa, z: fZa,
      line: { color: 'rgba(255,255,255,0.9)', width: 16 }
    });
    traces.push({
      type: 'scatter3d',
      mode: 'lines',
      name: 'A indifferent (y = y*)',
      showlegend: true,
      x: fXa,
      y: fYa,
      z: fZa,
      line: { color: '#7B241C', width: 10 }
    });

    // E[B](x*, y) swept over y: flat because B is indifferent at x* — dark blue
    const fXb: number[] = [], fYb: number[] = [], fZb: number[] = [];
    for (let i = 0; i <= FLAT_STEPS; i++) {
      const yi = i / FLAT_STEPS;
      fXb.push(xStar); fYb.push(yi); fZb.push(r3(EB(xStar, yi, g)));
    }
    traces.push({
      type: 'scatter3d', mode: 'lines', name: 'B indifferent (x = x*)', showlegend: false,
      hoverinfo: 'skip', x: fXb, y: fYb, z: fZb,
      line: { color: 'rgba(255,255,255,0.9)', width: 16 }
    });
    traces.push({
      type: 'scatter3d',
      mode: 'lines',
      name: 'B indifferent (x = x*)',
      showlegend: true,
      x: fXb,
      y: fYb,
      z: fZb,
      line: { color: '#2563eb', width: 10 }
    });
  }

  // ── Regret mode: live "strategy line" that flattens into the indifference line ─
  // E[A](x, y_cur) swept over x has slope sA(y_cur); it is flat exactly when
  // y_cur = y* (A indifferent). E[B](x_cur, y) over y is flat when x_cur = x*.
  // The tilt magnitude IS the opponent's regret, so the line eases flat as the
  // regret steps shrink. Shown until both coordinates lock (then the block above
  // draws the final flat lines).
  // Only for mixed-ONLY games (regret mode auto-falls back to shrink when a pure
  // NE exists, so the strategy lines must not appear there either).
  const hasMixed = allNE.some(n => n.type === 'mixed');
  const hasPure = allNE.some(n => n.type === 'pure');
  const bothLocked = s.discoveredMixedX !== null && s.discoveredMixedY !== null;
  if (stepMode === 'regret' && hasMixed && !hasPure && !bothLocked) {
    const FLAT_STEPS = 50;
    // Representative mix = each player's domain midpoint (hi+lo)/2, which eases
    // toward its own NE coordinate as that domain contracts — so each line
    // flattens gradually, one cycle at a time, instead of snapping.
    const xRep = s.discoveredMixedX ?? r3((s.domXLo + s.domXHi) / 2);
    const yRep = s.discoveredMixedY ?? r3((s.domYLo + s.domYHi) / 2);
    const Dy = g.a11 - g.a12 - g.a21 + g.a22;
    const Dx = g.b11 - g.b12 - g.b21 + g.b22;
    const sA = yRep * (g.a11 - g.a21) + (1 - yRep) * (g.a12 - g.a22);
    const sB = xRep * (g.b11 - g.b12) + (1 - xRep) * (g.b21 - g.b22);
    const aFlat = Math.abs(sA) < Math.max(1e-4, Math.abs(Dy) * 0.01);
    const bFlat = Math.abs(sB) < Math.max(1e-4, Math.abs(Dx) * 0.01);

    if (trackingMode === 'A' || trackingMode === 'both') {
      const xs: number[] = [], ys: number[] = [], zs: number[] = [];
      for (let i = 0; i <= FLAT_STEPS; i++) {
        const xi = i / FLAT_STEPS;
        xs.push(xi); ys.push(yRep); zs.push(r3(EA(xi, yRep, g)));
      }
      traces.push({
        type: 'scatter3d', mode: 'lines',
        name: aFlat ? 'A indifferent (y = y*)' : 'A strategy line (E[A] at current y)',
        showlegend: false,
        hoverinfo: 'skip', x: xs, y: ys, z: zs,
        line: { color: 'rgba(255,255,255,0.9)', width: aFlat ? 16 : 13 }
      });
      traces.push({
        type: 'scatter3d', mode: 'lines',
        name: aFlat ? 'A indifferent (y = y*)' : 'A strategy line (E[A] at current y)',
        showlegend: true,
        x: xs, y: ys, z: zs,
        line: { color: '#7B241C', width: aFlat ? 10 : 8 }
      });
    }
    if (trackingMode === 'B' || trackingMode === 'both') {
      const xs: number[] = [], ys: number[] = [], zs: number[] = [];
      for (let i = 0; i <= FLAT_STEPS; i++) {
        const yi = i / FLAT_STEPS;
        xs.push(xRep); ys.push(yi); zs.push(r3(EB(xRep, yi, g)));
      }
      traces.push({
        type: 'scatter3d', mode: 'lines',
        name: bFlat ? 'B indifferent (x = x*)' : 'B strategy line (E[B] at current x)',
        showlegend: false,
        hoverinfo: 'skip', x: xs, y: ys, z: zs,
        line: { color: 'rgba(255,255,255,0.9)', width: bFlat ? 16 : 13 }
      });
      traces.push({
        type: 'scatter3d', mode: 'lines',
        name: bFlat ? 'B indifferent (x = x*)' : 'B strategy line (E[B] at current x)',
        showlegend: true,
        x: xs, y: ys, z: zs,
        line: { color: '#2563eb', width: bFlat ? 10 : 8 }
      });
    }
  }

  // ── Starting point marker ──────────────────────────────────────────────────
  if (s.startX !== null && s.startY !== null) {
    if (trackingMode === 'A' || trackingMode === 'both') {
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        name: 'Starting Point',
        showlegend: true,
        x: [s.startX],
        y: [s.startY],
        z: [EA(s.startX, s.startY, g)],
        // Semi-transparent so the (opaque, drawn-last) current-position sphere is
        // never fully hidden by the start marker, whatever the camera angle: even
        // when the start point sits nearer the camera, the current position shows
        // through it instead of being occluded.
        marker: { size: 7, color: '#7F8C8D', symbol: 'circle', opacity: 0.5, line: { color: 'white', width: 1 } }
      });
    }
    if (trackingMode === 'B' || trackingMode === 'both') {
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        name: 'Starting Point',
        showlegend: trackingMode === 'B',
        x: [s.startX],
        y: [s.startY],
        z: [EB(s.startX, s.startY, g)],
        // Semi-transparent so the (opaque, drawn-last) current-position sphere is
        // never fully hidden by the start marker, whatever the camera angle: even
        // when the start point sits nearer the camera, the current position shows
        // through it instead of being occluded.
        marker: { size: 7, color: '#7F8C8D', symbol: 'circle', opacity: 0.5, line: { color: 'white', width: 1 } }
      });
    }
  }

  // ── Trajectory path segs — x-changes=red, y-changes=blue; old=light, new=dark ──
  // When Phase 2 is active, freeze the gradient at the Phase 1 point count so
  // Phase 2 additions don't make Phase 1 edges lighter.
  const mergeSegments = (segs: any[], frozenTotal: number | null) => {
    const drawable = segs.filter((seg: any) => seg.xs.length >= 2);
    if (drawable.length === 0) return null;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    const colors: number[] = [];
    const totalPts = drawable.reduce((n: number, seg: any) => n + seg.xs.length, 0);
    // Use frozenTotal (Phase 1 count) as the denominator so Phase 1 colors don't
    // shift lighter as Phase 2 adds more points. Points beyond frozenTotal get 1.0 (darkest).
    const denom = Math.max((frozenTotal ?? totalPts) - 1, 1);
    let ptIdx = 0;
    drawable.forEach((seg: any, si: number) => {
      if (si > 0) {
        xs.push(NaN); ys.push(NaN); zs.push(NaN);
        colors.push(Math.min(1, ptIdx / denom));
      }
      seg.xs.forEach((_: number, i: number) => {
        xs.push(seg.xs[i]); ys.push(seg.ys[i]); zs.push(seg.zs[i]);
        colors.push(Math.min(1, ptIdx / denom));
        ptIdx++;
      });
    });
    return { xs, ys, zs, colors };
  };

  const drawPaths = (segments: any[], phase1PtsTotal: number | null) => {
    // In Phase 2, reclassify segments beyond phase1PtsTotal to the axis that is
    // actually moving (foundAxis='x' means x is locked → y moves → 'B';
    // foundAxis='y' means y is locked → x moves → 'A').
    const phase2Mover = s.foundAxis === 'x' ? 'B' : s.foundAxis === 'y' ? 'A' : null;

    let cumPts = 0;
    const processed = segments.map((seg: any) => {
      const isPhase2 = phase1PtsTotal !== null && cumPts >= phase1PtsTotal && phase2Mover !== null;
      cumPts += seg.xs.length;
      return isPhase2 ? { ...seg, mover: phase2Mover } : seg;
    });

    // Compute Phase 1 point counts per mover (segments before phase1PtsTotal boundary)
    let p1Cum = 0;
    const p1xPts = segments.reduce((n: number, seg: any) => {
      if (phase1PtsTotal === null || p1Cum < phase1PtsTotal) {
        const pts = seg.mover === 'A' ? seg.xs.length : 0;
        p1Cum += seg.xs.length;
        return n + pts;
      }
      return n;
    }, 0);
    let p1Cum2 = 0;
    const p1yPts = segments.reduce((n: number, seg: any) => {
      if (phase1PtsTotal === null || p1Cum2 < phase1PtsTotal) {
        const pts = seg.mover === 'B' ? seg.xs.length : 0;
        p1Cum2 += seg.xs.length;
        return n + pts;
      }
      return n;
    }, 0);

    const xSegs = processed.filter((seg: any) => seg.mover === 'A');
    const ySegs = processed.filter((seg: any) => seg.mover === 'B');

    const xMerged = mergeSegments(xSegs, phase1PtsTotal !== null ? p1xPts : null);
    if (xMerged) {
      if (!aMoveLegendShown) {
        aMoveLegendShown = true;
        // Legend-only trace with solid color (NaN data = invisible in plot)
        traces.push({
          type: 'scatter3d', mode: 'lines',
          name: '─ A Moves (x)', showlegend: true, legendgroup: 'amoves',
          x: [NaN], y: [NaN], z: [NaN],
          line: { color: 'rgb(192,57,43)', width: 4 }
        });
      }
      traces.push({
        type: 'scatter3d', mode: 'lines',
        name: '_', hoverinfo: 'skip', showlegend: false, legendgroup: 'amoves',
        x: xMerged.xs, y: xMerged.ys, z: xMerged.zs,
        line: { color: xMerged.colors, colorscale: [[0, 'rgb(245,184,184)'], [1, 'rgb(192,57,43)']], width: 4 }
      });
    }

    const yMerged = mergeSegments(ySegs, phase1PtsTotal !== null ? p1yPts : null);
    if (yMerged) {
      if (!bMoveLegendShown) {
        bMoveLegendShown = true;
        // Legend-only trace with solid color (NaN data = invisible in plot)
        traces.push({
          type: 'scatter3d', mode: 'lines',
          name: '─ B Moves (y)', showlegend: true, legendgroup: 'bmoves',
          x: [NaN], y: [NaN], z: [NaN],
          line: { color: 'rgb(26,82,118)', width: 4 }
        });
      }
      traces.push({
        type: 'scatter3d', mode: 'lines',
        name: '_', hoverinfo: 'skip', showlegend: false, legendgroup: 'bmoves',
        x: yMerged.xs, y: yMerged.ys, z: yMerged.zs,
        line: { color: yMerged.colors, colorscale: [[0, 'rgb(184,204,245)'], [1, 'rgb(26,82,118)']], width: 4 }
      });
    }
  };

  if (trackingMode === 'A' || trackingMode === 'both') drawPaths(s.pathSegmentsA, s.phase1PtsA);
  if (trackingMode === 'B' || trackingMode === 'both') drawPaths(s.pathSegmentsB, s.phase1PtsB);

  // ── Nash Equilibrium markers ───────────────────────────────────────────────
  // Computed once, up here, so BOTH the isolated-diamond loop below and the
  // continuum-marker loop further down (which used to recompute the same
  // `equilibriumSet(g).filter(...)`) share one list.
  //
  // RED-MATH-9/002: on 29,372/29,372 continuum games in a 200k sweep, at
  // least one `computeAllNE` "pure"/"mixed" point lands INSIDE the same
  // rectangle the continuum marker already covers (the full-square case —
  // both players flat — is the sharpest example: 4 solid "Pure NE" diamonds
  // at the corners of a face where every interior point is equally an
  // equilibrium). That directly works against the continuum marker's own
  // stated design intent (see its comment below): a solid, opaque diamond on
  // top of the exact region the hollow marker exists to say "not a discrete
  // finding" reintroduces the reading the hollow glyph was built to avoid.
  // Skip drawing an isolated diamond for any point that is already a member
  // of a continuum component — the SAME `continuumComponents`/`pointInRect`
  // classification `splitEquilibriaByContinuum` uses (report.ts, App.tsx's
  // bullet list) so the plot's markers and the panel's/payload's text can
  // never disagree about which points are "stray" (get their own marker/
  // bullet) versus "on the continuum" (represented only by the continuum
  // marker/bullet).
  const continuumRects = equilibriumSet(g).filter((r) => kindOf(r) !== 'point');
  const onContinuum = (ne: NashEquilibrium) => continuumRects.some((r) => pointInRect(r, ne.x, ne.y));
  let pureShown = false;
  let mixedShown = false;
  allNE.forEach(ne => {
    if (onContinuum(ne)) return;
    if (ne.type === 'pure') {
      if (trackingMode === 'both') {
        // In a symmetric game both surfaces pay the same at a pure NE, so the
        // trace's two diamonds land on the identical 3D point and depth-tie.
        // That tie is invisible: both sprites are the same glyph, colour and
        // size, so whichever fragment wins looks the same. Exact coincidence
        // is the spec — no split.
        const zAp = EA(ne.x, ne.y, g);
        const zBp = EB(ne.x, ne.y, g);
        const zLo = Math.min(zAp, zBp);
        const zHi = Math.max(zAp, zBp);
        const COORD_STEPS = 15;
        const lineZ: number[] = [], lineX: number[] = [], lineY: number[] = [];
        for (let si = 0; si <= COORD_STEPS; si++) {
          lineZ.push(zLo + (zHi - zLo) * si / COORD_STEPS);
          lineX.push(ne.x);
          lineY.push(ne.y);
        }
        // The connecting line must render BEHIND the diamonds, never through
        // them. Both are translucent (opacity 0.99 → translucent pass, strict
        // LESS depth test), so the tie-break is draw order: the diamonds are
        // pushed FIRST and write their depth, and the line — drawn second —
        // is culled wherever it ties with a diamond sprite. An opaque line
        // (the old order) won every tie and punched through the diamond face.
        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: pureShown ? '_' : 'Pure NE',
          showlegend: !pureShown,
          legendgroup: 'pureNE',
          x: [ne.x, ne.x],
          y: [ne.y, ne.y],
          z: [zAp, zBp],
          marker: { size: diamondSize, color: '#4ca47a', symbol: 'diamond', opacity: 0.99, line: { color: 'white', width: 1 } }
        });
        // Vertical line connecting payoff A and payoff B for pure NE
        traces.push({
          type: 'scatter3d',
          mode: 'lines',
          name: '_',
          hoverinfo: 'skip', // RED-MATH-11/002: decorative line, never a hover label
          showlegend: false,
          legendgroup: 'pureNE',
          x: lineX,
          y: lineY,
          z: lineZ,
          opacity: 0.99,
          line: { color: '#4ca47a', width: 6, dash: 'solid' }
        });
      } else {
        const zP = trackingMode === 'B' ? EB(ne.x, ne.y, g) : EA(ne.x, ne.y, g);
        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: pureShown ? '_' : 'Pure NE',
          showlegend: !pureShown,
          legendgroup: 'pureNE',
          x: [ne.x],
          y: [ne.y],
          z: [zP],
          marker: { size: diamondSize, color: '#4ca47a', symbol: 'diamond', opacity: 0.99, line: { color: 'white', width: 1 } }
        });
      }
      pureShown = true;
    } else {
      // Same-glyph coincidence as the pure-NE twins above: a depth tie between
      // two identical purple diamonds cannot be seen, so keep the exact z.
      const zA = EA(ne.x, ne.y, g);
      const zB = EB(ne.x, ne.y, g);
      if (trackingMode === 'both') {
        const zLo = Math.min(zA, zB);
        const zHi = Math.max(zA, zB);
        const COORD_STEPS = 15;
        const lineZ: number[] = [], lineX: number[] = [], lineY: number[] = [];
        for (let si = 0; si <= COORD_STEPS; si++) {
          lineZ.push(zLo + (zHi - zLo) * si / COORD_STEPS);
          lineX.push(ne.x);
          lineY.push(ne.y);
        }
        // Diamonds BEFORE the line — same draw-order tie-break as the pure-NE
        // markers above: the translucent line drawn second loses depth ties
        // to the diamond sprites instead of punching through them.
        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: mixedShown ? '_' : 'Mixed NE',
          showlegend: !mixedShown,
          legendgroup: 'mixedNE',
          x: [ne.x, ne.x],
          y: [ne.y, ne.y],
          z: [zA, zB],
          marker: { size: diamondSize, color: '#8E44AD', symbol: 'diamond', opacity: 0.99, line: { color: 'white', width: 1 } }
        });
        // Vertical dashed line connecting payoff A and payoff B for mixed NE
        traces.push({
          type: 'scatter3d',
          mode: 'lines',
          name: '_',
          hoverinfo: 'skip', // RED-MATH-11/002: decorative line, never a hover label
          showlegend: false,
          legendgroup: 'mixedNE',
          x: lineX,
          y: lineY,
          z: lineZ,
          opacity: 0.99,
          line: { color: '#8E44AD', width: 6, dash: 'solid' }
        });
      } else {
        const zVal = trackingMode === 'B' ? zB : zA;
        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: mixedShown ? '_' : 'Mixed NE',
          showlegend: !mixedShown,
          legendgroup: 'mixedNE',
          x: [ne.x],
          y: [ne.y],
          z: [zVal],
          marker: { size: diamondSize, color: '#8E44AD', symbol: 'diamond', opacity: 0.99, line: { color: 'white', width: 1 } }
        });
      }
      mixedShown = true;
    }
  });

  // ── Equilibrium CONTINUUM markers ──────────────────────────────────────────
  // RED-MATH-7/001: `allNE` (the caller's `computeAllNE(g)`) enumerates only
  // the finitely many corners/interior point computeAllNE's model can find —
  // on a payoff tie the true equilibrium set can be a whole edge, and the
  // corner-only diamonds above then draw a strict subset of the truth with
  // no visual hint that more exists (the same class App.tsx's on-screen
  // panel, MenuDrawer.tsx's lists, and report.ts's grounding payload were
  // all separately hardened against — see those files' own comments). One
  // small hollow diamond at the MIDPOINT of each non-point component, in the
  // same colour as a Mixed NE marker but a distinct open symbol so it never
  // reads as an extra discrete equilibrium the solver found: it marks
  // "a continuum lives here," not a specific point.
  // `continuumRects` computed once, above (the isolated-diamond loop's
  // `onContinuum` check reuses it too — RED-MATH-9/002).
  let continuumShown = false;
  // RED-MATH-11/003: corners are deduplicated ACROSS components — two segments
  // meeting at a shared corner (an L-shaped equilibrium set) drew that corner
  // twice, one marker per component.
  const drawnCorners: [number, number][] = [];
  continuumRects.forEach((r) => {
    const mx = (r.x0 + r.x1) / 2;
    const my = (r.y0 + r.y1) / 2;
    // RED-MATH-12/001: marker size is screen-space, the component's length is
    // data-space. On a SHORT component the two 2x corner outlines and the
    // midpoint marker fuse into one blob. Below this length the component is
    // drawn as ONE 2x outline at its midpoint (which then covers both corners
    // and the sphere pinned to either) plus the dashed line.
    // #130 shipped 0.12 as a conservative GUESS between the red's own two
    // measured points (0.053 fused, 0.2 clearly legible) without checking
    // anywhere in between. BLUE-CONTINUUM-SPEC's screen-space property test
    // (payoffhonesty.test.ts, projecting corner/midpoint centers through the
    // real default camera) found real, hand-verified-in-a-real-browser fusion
    // as far up as length 0.1429 (screenshot: a segment at 0.125 renders as
    // the SAME nested "flower" blob as the original 0.053 fixture) — 0.12 was
    // never actually safe. 0.2 is the red's own directly-observed safe bound;
    // the same sweep finds zero violations at or above it.
    const SHORT_CONTINUUM = 0.2;
    const isShort = Math.hypot(r.x1 - r.x0, r.y1 - r.y0) < SHORT_CONTINUUM;
    const zAc = EA(mx, my, g);
    const zBc = EB(mx, my, g);
    const zVal = trackingMode === 'B' ? zBc : zAc;
    traces.push({
      type: 'scatter3d',
      mode: 'markers',
      name: 'Equilibrium continuum',
      showlegend: !continuumShown,
      legendgroup: 'continuumNE',
      x: trackingMode === 'both' ? [mx, mx] : [mx],
      y: trackingMode === 'both' ? [my, my] : [my],
      z: trackingMode === 'both' ? [zAc, zBc] : [zVal],
      marker: {
        size: diamondSize * (isShort ? 2 : 0.85), color: '#8E44AD', symbol: 'diamond-open', opacity: 0.95,
        line: { color: '#8E44AD', width: 2 },
      },
    });
    continuumShown = true;

    // RED-MATH-10/001: `computeAllNE`'s pin-to-nearest-point logic (~line 92,
    // untouched by RED-MATH-9/002's fix) still snaps the current-position
    // sphere onto a genuine computeAllNE point even when that point is a
    // CORNER of this very component — a pure-strategy vertex on an otherwise
    // mixed-strategy segment. #114 correctly stopped drawing that corner's
    // own solid diamond (it duplicated the hollow marker above), but left the
    // component's only remaining glyph at the MIDPOINT, which measured a mean
    // 0.38 (up to 0.71) plot-units away from where the sphere actually
    // settles on 70.1% of real converged runs on continuum games. Draw the
    // SAME hollow glyph at the component's own corners too, joined by a thin
    // dashed line tracing the component itself, so a settled point anywhere
    // on the component — corner or interior — always sits on a drawn glyph
    // or the drawn line, not on bare surface. `kindOf(r)` (the same
    // classification `describeContinuumRect` uses) distinguishes the ordinary
    // 'segment' case (exactly 2 distinct corners: one axis is fixed) from the
    // rare fully-degenerate 'area' case (4 corners; both axes free — the
    // whole [0,1]×[0,1] square, reachable only when both players are
    // indifferent everywhere) so the line traces the actual shape either way:
    // a straight run between the 2 endpoints, or the rectangle's perimeter.
    const cornersRaw: [number, number][] = isShort ? [] : [[r.x0, r.y0], [r.x0, r.y1], [r.x1, r.y0], [r.x1, r.y1]];
    const corners: [number, number][] = [];
    cornersRaw.forEach(([cx, cy]) => {
      if (!drawnCorners.some(([ex, ey]) => Math.abs(ex - cx) < 1e-9 && Math.abs(ey - cy) < 1e-9)) {
        corners.push([cx, cy]);
        drawnCorners.push([cx, cy]);
      }
    });
    corners.forEach(([ex, ey]) => {
      const zAe = EA(ex, ey, g);
      const zBe = EB(ex, ey, g);
      const zValE = trackingMode === 'B' ? zBe : zAe;
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        // RED-MATH-11/002: a real name, so hover never shows a literal "_".
        name: 'Equilibrium continuum',
        showlegend: false,
        legendgroup: 'continuumNE',
        x: trackingMode === 'both' ? [ex, ex] : [ex],
        y: trackingMode === 'both' ? [ey, ey] : [ey],
        z: trackingMode === 'both' ? [zAe, zBe] : [zValE],
        // RED-MATH-11/001: the outline must PROTRUDE around the settled sphere
        // that pins to this very corner (70% of converged continuum runs): the
        // Pure/Mixed diamonds manage it at ~1.3x the sphere; a thin outline
        // ring needs more, so 2x diamondSize (~2.6x the sphere; 1.35x still vanished behind the sphere sprite) — 0.85x hid
        // it completely in both GL backends.
        marker: {
          size: diamondSize * 2, color: '#8E44AD', symbol: 'diamond-open', opacity: 0.95,
          line: { color: '#8E44AD', width: 2 },
        },
      });
    });

    // Dashed line tracing the component. Pushed AFTER the corner/midpoint
    // diamonds (same draw-order tie-break already used for the Pure/Mixed NE
    // diamond+connector pattern above: both are translucent (opacity < 1), so
    // whichever is pushed FIRST wins a depth tie against whichever is pushed
    // SECOND — diamonds first means the line never punches through one) and
    // is itself translucent so it still loses any depth tie against the
    // opaque current-position sphere drawn last.
    const pathPts: [number, number][] = kindOf(r) === 'area'
      ? [[r.x0, r.y0], [r.x0, r.y1], [r.x1, r.y1], [r.x1, r.y0], [r.x0, r.y0]]
      : [[r.x0, r.y0], [r.x1, r.y1]];
    const drawContinuumLine = (which: 'A' | 'B') => {
      const lx = pathPts.map((p) => p[0]);
      const ly = pathPts.map((p) => p[1]);
      const lz = pathPts.map((p) => (which === 'A' ? EA(p[0], p[1], g) : EB(p[0], p[1], g)));
      traces.push({
        type: 'scatter3d',
        mode: 'lines',
        name: '_',
        hoverinfo: 'skip', // RED-MATH-11/002: decorative line, never a hover label
        showlegend: false,
        legendgroup: 'continuumNE',
        x: lx,
        y: ly,
        z: lz,
        opacity: 0.95,
        line: { color: '#8E44AD', width: 3, dash: 'dash' },
      });
    };
    if (trackingMode === 'A' || trackingMode === 'both') drawContinuumLine('A');
    if (trackingMode === 'B' || trackingMode === 'both') drawContinuumLine('B');
  });

  // ── Tracking spheres (the large display balls) ────────────────────────────
  // Drawn LAST so that at convergence they render on top of the NE diamond,
  // leaving only the diamond's corners protruding (see diamondSize note above).
  //
  // When a sphere sits EXACTLY on an equilibrium diamond the two billboards
  // depth-tie, and which fragment wins can flip with the camera angle — the
  // sphere flickered in and out of the diamond while the view spun. Geometry
  // offsets were tried and rejected: ANY nonzero z-lift reads as a visible
  // hover at sufficient zoom, and the spec is that the sphere's centre sits
  // exactly on the diamond's. The deterministic fix is opacity 0.99 on the
  // DIAMONDS (visually identical to opaque): it routes them through
  // gl-plot3d's translucent pass, which draws after the opaque spheres and
  // depth-tests with strict LESS. Inside the sphere's disc the depths are
  // equal, so the diamond loses there; outside the disc it wins against the
  // background — sphere in the middle, corners protruding, no tie left to
  // race. (Making the SPHERE the translucent one fails for the same reason:
  // strict LESS at equal depth culls whichever is drawn second.)
  if (trackingMode === 'A' || trackingMode === 'both') {
    traces.push({
      type: 'scatter3d',
      mode: 'markers',
      name: 'Current position (A)',
      showlegend: trackingMode === 'A' || trackingMode === 'both',
      x: [px],
      y: [py],
      z: [eA],
      marker: { size: sphereSize, color: '#d52c1a', line: { color: 'white', width: 2 } }
    });
  }
  if (trackingMode === 'B' || trackingMode === 'both') {
    traces.push({
      type: 'scatter3d',
      mode: 'markers',
      name: 'Current position (B)',
      showlegend: trackingMode === 'B' || trackingMode === 'both',
      x: [px],
      y: [py],
      z: [eB],
      marker: { size: sphereSize, color: '#2980B9', line: { color: 'white', width: 2 } }
    });
  }

  // RED-MATH-11/002: '_' is the legend-dedupe name, never something to show a
  // user. Any '_'-named trace that did not choose its own hover gets coordinates
  // only (markers, surfaces) or no hover at all (decorative lines).
  for (const t of traces as Array<{ name?: string; hoverinfo?: string; mode?: string; type?: string }>) {
    if (t.name === '_' && t.hoverinfo === undefined) {
      t.hoverinfo = t.mode === 'markers' || t.type === 'surface' ? 'x+y+z' : 'skip';
    }
  }
  return traces;
}

// ── Layout (static) ──────────────────────────────────────────────────────────
export const plotLayout = {
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  margin: { l: 0, r: 0, t: 10, b: 0 },
  scene: {
    xaxis: { title: { text: 'x: P(A plays Row 1)', font: { size: 10 } }, range: [0, 1] },
    yaxis: { title: { text: 'y: P(B plays Col 1)', font: { size: 10 } }, range: [0, 1] },
    zaxis: { title: { text: 'Expected Payoff', font: { size: 10 } } },
    camera: { eye: { x: 1.6, y: -1.6, z: 1.1 } },
    bgcolor: 'rgba(0,0,0,0)',
    aspectmode: 'cube'
  },
  legend: { x: 0, y: 1, bgcolor: 'rgba(255,255,255,0.7)', font: { size: 10 } },
  font: { family: 'Inter, system-ui, sans-serif', size: 11 }
};

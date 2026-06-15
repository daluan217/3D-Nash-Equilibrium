/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GamePayoffs, SimState, NashEquilibrium } from '../types';
import { EA, EB, r3 } from './gameEngine';

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
  isMobile = false
): any[] {
  const diamondSize = isMobile ? 5 : 10;
  const px = s.displayX ?? s.cx;
  const py = s.displayY ?? s.cy;
  const eA = r3(EA(px, py, g));
  const eB = r3(EB(px, py, g));

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
    const lo = s.domainLo;
    const hi = s.domainHi;
    const zC = [
      EA(lo, lo, g), EA(lo, hi, g), EA(hi, lo, g), EA(hi, hi, g),
      EB(lo, lo, g), EB(lo, hi, g), EB(hi, lo, g), EB(hi, hi, g)
    ];
    const zMax = Math.max(...zC) + 0.3;
    const zMin = Math.min(...zC) - 0.3;

    // XOR: exactly one coordinate discovered -> phase 2 (search corridor)
    const oneFound = (s.discoveredMixedX !== null) !== (s.discoveredMixedY !== null);
    const boxColor = oneFound ? '#e67e22' : '#27ae60';
    const boxName  = oneFound ? 'Search corridor' : 'Domain boundary';

    // Top and bottom 2D bounding boxes
    [[lo, hi, hi, lo, lo], [lo, lo, hi, hi, lo]].forEach((xA, idx) => {
      const yA = idx === 0 ? [lo, lo, hi, hi, lo] : [lo, hi, hi, lo, lo];
      
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
        showlegend: false,
        x: xA,
        y: yA,
        z: [zMax, zMax, zMax, zMax, zMax],
        line: { color: boxColor, width: 3, dash: 'dot' }
      });
    });

    // Vertical pillars of the bounding box
    [[lo, lo], [hi, lo], [hi, hi], [lo, hi]].forEach(c => {
      traces.push({
        type: 'scatter3d',
        mode: 'lines',
        name: '_',
        showlegend: false,
        x: [c[0], c[0]],
        y: [c[1], c[1]],
        z: [zMin, zMax],
        line: { color: boxColor, width: 3, dash: 'dot' }
      });
    });

    // ── Phase 2 extra graphics: ghost spheres + search-range surface line ──
    if (oneFound) {
      const xFound = s.discoveredMixedX !== null;
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
            size: 6.5,
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
            size: 6.5,
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
    traces.push({
      type: 'scatter3d',
      mode: 'lines',
      name: 'A indifferent (y = y*)',
      showlegend: true,
      x: fXa,
      y: fYa,
      z: fZa,
      line: { color: '#7B241C', width: 7 }
    });

    // E[B](x*, y) swept over y: flat because B is indifferent at x* — dark blue
    const fXb: number[] = [], fYb: number[] = [], fZb: number[] = [];
    for (let i = 0; i <= FLAT_STEPS; i++) {
      const yi = i / FLAT_STEPS;
      fXb.push(xStar); fYb.push(yi); fZb.push(r3(EB(xStar, yi, g)));
    }
    traces.push({
      type: 'scatter3d',
      mode: 'lines',
      name: 'B indifferent (x = x*)',
      showlegend: true,
      x: fXb,
      y: fYb,
      z: fZb,
      line: { color: '#1A3A5C', width: 7 }
    });
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
        marker: { size: 7, color: '#7F8C8D', symbol: 'circle', line: { color: 'white', width: 1 } }
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
        marker: { size: 7, color: '#7F8C8D', symbol: 'circle', line: { color: 'white', width: 1 } }
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
        name: '_', showlegend: false, legendgroup: 'amoves',
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
        name: '_', showlegend: false, legendgroup: 'bmoves',
        x: yMerged.xs, y: yMerged.ys, z: yMerged.zs,
        line: { color: yMerged.colors, colorscale: [[0, 'rgb(184,204,245)'], [1, 'rgb(26,82,118)']], width: 4 }
      });
    }
  };

  if (trackingMode === 'A' || trackingMode === 'both') drawPaths(s.pathSegmentsA, s.phase1PtsA);
  if (trackingMode === 'B' || trackingMode === 'both') drawPaths(s.pathSegmentsB, s.phase1PtsB);

  // ── Tracking spheres (the large display balls) ────────────────────────────
  if (trackingMode === 'A' || trackingMode === 'both') {
    traces.push({
      type: 'scatter3d',
      mode: 'markers',
      name: 'Current position (A)',
      showlegend: trackingMode === 'A' || trackingMode === 'both',
      x: [px],
      y: [py],
      z: [eA],
      marker: { size: 9, color: '#d52c1a', line: { color: 'white', width: 2 } }
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
      marker: { size: 9, color: '#2980B9', line: { color: 'white', width: 2 } }
    });
  }

  // ── Nash Equilibrium markers ───────────────────────────────────────────────
  let pureShown = false;
  let mixedShown = false;
  allNE.forEach(ne => {
    if (ne.type === 'pure') {
      if (trackingMode === 'both') {
        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: pureShown ? '_' : 'Pure NE',
          showlegend: !pureShown,
          x: [ne.x, ne.x],
          y: [ne.y, ne.y],
          z: [EA(ne.x, ne.y, g), EB(ne.x, ne.y, g)],
          marker: { size: diamondSize, color: '#4ca47a', symbol: 'diamond', line: { color: 'white', width: 1 } }
        });
      } else {
        const zP = trackingMode === 'B' ? EB(ne.x, ne.y, g) : EA(ne.x, ne.y, g);
        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: pureShown ? '_' : 'Pure NE',
          showlegend: !pureShown,
          x: [ne.x],
          y: [ne.y],
          z: [zP],
          marker: { size: diamondSize, color: '#4ca47a', symbol: 'diamond', line: { color: 'white', width: 1 } }
        });
      }
      pureShown = true;
    } else {
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
        // Vertical dashed line connecting payoff A and payoff B for mixed NE
        traces.push({
          type: 'scatter3d',
          mode: 'lines',
          name: mixedShown ? '_' : 'Mixed NE',
          showlegend: !mixedShown,
          x: lineX,
          y: lineY,
          z: lineZ,
          line: { color: '#8E44AD', width: 6, dash: 'solid' }
        });
        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: '_',
          showlegend: false,
          x: [ne.x, ne.x],
          y: [ne.y, ne.y],
          z: [zA, zB],
          marker: { size: diamondSize, color: '#8E44AD', symbol: 'diamond', line: { color: 'white', width: 1 } }
        });
      } else {
        const zVal = trackingMode === 'B' ? zB : zA;
        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: mixedShown ? '_' : 'Mixed NE',
          showlegend: !mixedShown,
          x: [ne.x],
          y: [ne.y],
          z: [zVal],
          marker: { size: diamondSize, color: '#8E44AD', symbol: 'diamond', line: { color: 'white', width: 1 } }
        });
      }
      mixedShown = true;
    }
  });

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

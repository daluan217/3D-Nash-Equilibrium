/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { GamePayoffs } from '../types';
import { bestReplySets, continuumComponents, kindOf, splitEquilibriaByContinuum } from '../utils/gameEngine';

interface GameGraphMiniatureProps {
  payoffs: GamePayoffs;
  isDark?: boolean;
}

export const GameGraphMiniature: React.FC<GameGraphMiniatureProps> = ({ payoffs, isDark = false }) => {
  // The solver's equilibrium SET: a continuum is drawn whole and only isolated points get a dot. Corner
  // dots alone showed an edge of equilibria as one pure NE, the square as four (BLUE-LOOP-MATH-22 F9).
  const { comps, allNE } = useMemo(() => {
    try {
      return { comps: continuumComponents(payoffs), allNE: splitEquilibriaByContinuum(payoffs).stray };
    } catch {
      return { comps: [], allNE: [] };
    }
  }, [payoffs]);

  // The solver's best-reply sets, not a quotient of our own: that one drew a player indifferent
  // everywhere as "always Row 2" and dropped an indifference at an edge (BLUE-LOOP-MATH-22 F7).
  const replies = useMemo(() => bestReplySets(payoffs), [payoffs]);

  // Coordinates mapping: Grid is 0..1 in x, 0..1 in y
  // SVG viewport size: 120x120. Boundary padding is 15px.
  // Effective drawing coordinate box is [15, 15] to [105, 105].
  // x = 0 is left (15), x = 1 is right (105)
  // y = 0 is bottom (105), y = 1 is top (15) (Inverted for SVG coordinate space)
  const mapX = (x: number) => 15 + x * 90;
  const mapY = (y: number) => 105 - y * 90;

  // Render stylized contour grids to represent expected payoffs
  const gridLines = [0.25, 0.5, 0.75];

  return (
    <div className={`relative w-[130px] h-[130px] shrink-0 border rounded-xl overflow-hidden p-1 flex items-center justify-center ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
      <svg width="120" height="120" viewBox="0 0 120 120" className="opacity-90">
        <defs>
          <linearGradient id="gridGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={isDark ? '#2e1065' : '#f5f3ff'} />
            <stop offset="100%" stopColor={isDark ? '#020617' : '#fafafa'} />
          </linearGradient>
        </defs>

        {/* Topography payoff surface background */}
        <rect x="15" y="15" width="90" height="90" fill="url(#gridGrad)" rx="6" />

        {/* Grid lines */}
        {gridLines.map((v) => (
          <React.Fragment key={v}>
            {/* Horizontal line */}
            <line
              x1={mapX(0)}
              y1={mapY(v)}
              x2={mapX(1)}
              y2={mapY(v)}
              stroke={isDark ? '#1e293b' : '#e2e8f0'}
              strokeWidth="0.75"
              strokeDasharray="2,2"
            />
            {/* Vertical line */}
            <line
              x1={mapX(v)}
              y1={mapY(0)}
              x2={mapX(v)}
              y2={mapY(1)}
              stroke={isDark ? '#1e293b' : '#e2e8f0'}
              strokeWidth="0.75"
              strokeDasharray="2,2"
            />
          </React.Fragment>
        ))}

        {/* Boundary of strategies box */}
        <rect
          x="15"
          y="15"
          width="90"
          height="90"
          fill="none"
          stroke={isDark ? '#334155' : '#cbd5e1'}
          strokeWidth="1.5"
          rx="6"
        />

        {/* Stylized Best-Response Curves */}
        {/* Player A (Row, rose) picks x; Player B (Col, blue) picks y. An area = indifferent everywhere. */}
        {(['A', 'B'] as const).map((p) => replies[p].map((r, i) => {
          const colour = p === 'A' ? '#f43f5e' : '#3b82f6';
          return kindOf(r) === 'area' ? (
            <rect key={p + i} x={mapX(r.x0)} y={mapY(r.y1)} width={(r.x1 - r.x0) * 90} height={(r.y1 - r.y0) * 90}
              fill={colour} fillOpacity="0.18" rx="6" />
          ) : (
            <line key={p + i} x1={mapX(r.x0)} y1={mapY(r.y0)} x2={mapX(r.x1)} y2={mapY(r.y1)}
              stroke={colour} strokeWidth="1.75" strokeLinecap="round" />
          );
        }))}

        {/* Equilibrium continua (segment or the whole square), dashed in the mixed-NE colour */}
        {comps.map((r, i) => kindOf(r) === 'area' ? (
          <rect key={'c' + i} x={mapX(r.x0)} y={mapY(r.y1)} width={(r.x1 - r.x0) * 90} height={(r.y1 - r.y0) * 90}
            fill="none" stroke="#a855f7" strokeWidth="2" strokeDasharray="5 3" rx="6" />
        ) : (
          <line key={'c' + i} x1={mapX(r.x0)} y1={mapY(r.y0)} x2={mapX(r.x1)} y2={mapY(r.y1)}
            stroke="#a855f7" strokeWidth="3.5" strokeDasharray="5 3" />
        ))}

        {/* Draw plotted Nash Equilibria */}
        {allNE.map((ne, idx) => {
          const cx = mapX(ne.x);
          const cy = mapY(ne.y);
          const isMixed = ne.type === 'mixed';
          return (
            <g key={idx}>
              {/* Outer pulse */}
              <circle
                cx={cx}
                cy={cy}
                r={isMixed ? '6' : '5'}
                fill="none"
                stroke={isMixed ? '#a855f7' : '#10b981'}
                strokeWidth="1"
                className="animate-pulse"
              />
              {/* Core dot */}
              <circle
                cx={cx}
                cy={cy}
                r={isMixed ? '3.5' : '3'}
                fill={isMixed ? '#a855f7' : '#10b981'}
              />
            </g>
          );
        })}

        {/* Axis Labels */}
        <text x="110" y="112" fontSize="7" fontWeight="bold" fill={isDark ? '#64748b' : '#94a3b8'} textAnchor="start">X</text>
        <text x="5" y="12" fontSize="7" fontWeight="bold" fill={isDark ? '#64748b' : '#94a3b8'} textAnchor="start">Y</text>
      </svg>
    </div>
  );
};

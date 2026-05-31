/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { GamePayoffs } from '../types';
import { computeAllNE } from '../utils/gameEngine';

interface GameGraphMiniatureProps {
  payoffs: GamePayoffs;
  isDark?: boolean;
}

export const GameGraphMiniature: React.FC<GameGraphMiniatureProps> = ({ payoffs, isDark = false }) => {
  const allNE = useMemo(() => {
    try {
      return computeAllNE(payoffs);
    } catch {
      return [];
    }
  }, [payoffs]);

  // Compute indifference thresholds for the stylized best response lines
  // Player A is indifferent at y_indiff
  const yIndiff = useMemo(() => {
    const num = payoffs.a22 - payoffs.a12;
    const den = payoffs.a11 - payoffs.a21 - payoffs.a12 + payoffs.a22;
    if (Math.abs(den) < 1e-5) return null;
    const val = num / den;
    return val >= 0 && val <= 1 ? val : null;
  }, [payoffs]);

  // Player B is indifferent at x_indiff
  const xIndiff = useMemo(() => {
    const num = payoffs.b22 - payoffs.b21;
    const den = payoffs.b11 - payoffs.b12 - payoffs.b21 + payoffs.b22;
    if (Math.abs(den) < 1e-5) return null;
    const val = num / den;
    return val >= 0 && val <= 1 ? val : null;
  }, [payoffs]);

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
        {/* Player A (Row): controls x (Row 1 is x=1, Row 2 is x=0) */}
        {yIndiff !== null ? (
          // Under indifferent threshold: one side x=0, other side x=1
          <path
            d={`M ${mapX(payoffs.a12 > payoffs.a22 ? 1 : 0)} 105 L ${mapX(payoffs.a12 > payoffs.a22 ? 1 : 0)} ${mapY(yIndiff)} L ${mapX(payoffs.a11 > payoffs.a21 ? 1 : 0)} ${mapY(yIndiff)} L ${mapX(payoffs.a11 > payoffs.a21 ? 1 : 0)} 15`}
            fill="none"
            stroke="#f43f5e"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          // Dominant strategy or flat
          <line
            x1={mapX(payoffs.a11 + payoffs.a12 > payoffs.a21 + payoffs.a22 ? 1 : 0)}
            y1="15"
            x2={mapX(payoffs.a11 + payoffs.a12 > payoffs.a21 + payoffs.a22 ? 1 : 0)}
            y2="105"
            stroke="#f43f5e"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        )}

        {/* Player B (Col): controls y (Col 1 is y=1, Col 2 is y=0) */}
        {xIndiff !== null ? (
          <path
            d={`M 15 ${mapY(payoffs.b21 > payoffs.b22 ? 1 : 0)} L ${mapX(xIndiff)} ${mapY(payoffs.b21 > payoffs.b22 ? 1 : 0)} L ${mapX(xIndiff)} ${mapY(payoffs.b11 > payoffs.b12 ? 1 : 0)} L 105 ${mapY(payoffs.b11 > payoffs.b12 ? 1 : 0)}`}
            fill="none"
            stroke="#3b82f6"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <line
            x1="15"
            y1={mapY(payoffs.b11 + payoffs.b21 > payoffs.b12 + payoffs.b22 ? 1 : 0)}
            x2="105"
            y2={mapY(payoffs.b11 + payoffs.b21 > payoffs.b12 + payoffs.b22 ? 1 : 0)}
            stroke="#3b82f6"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        )}

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

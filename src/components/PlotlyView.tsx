/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { GamePayoffs, SimState, NashEquilibrium } from '../types';
import { buildSurfaces, makeTraces, plotLayout } from '../utils/plotting';
import { Rotate3d, Move, RefreshCw } from 'lucide-react';

interface PlotlyViewProps {
  payoffs: GamePayoffs;
  simState: SimState;
  trackingMode: 'A' | 'B' | 'both';
  allNE: NashEquilibrium[];
  isDark?: boolean;
}

export const PlotlyView: React.FC<PlotlyViewProps> = ({
  payoffs,
  simState,
  trackingMode,
  allNE,
  isDark = false
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotId = 'plotly-3d-market-simulation';
  const [dragMode, setDragMode] = useState<'orbit' | 'pan'>('orbit');
  const [uiRevision, setUiRevision] = useState<number>(0);

  // Set up robust ResizeObserver to force Plotly bounds to sync with fluid flex columns
  useEffect(() => {
    const Plotly = (window as any).Plotly;
    if (!containerRef.current) return;

    const observer = new ResizeObserver(() => {
      if (Plotly && document.getElementById(plotId)) {
        Plotly.Plots.resize(plotId);
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, []);

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

    // Build the surfaces and coordinates
    const surf = buildSurfaces(payoffs);
    const traces = makeTraces(surf, payoffs, simState, trackingMode, allNE);

    // Merge custom dynamic interactions into layout
    const layout = {
      ...plotLayout,
      paper_bgcolor: isDark ? '#000000' : '#ffffff',
      plot_bgcolor: isDark ? '#000000' : '#ffffff',
      dragmode: dragMode,
      uirevision: 'camera_view_' + uiRevision,
      scene: {
        ...plotLayout.scene,
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
        font: {
          size: 10,
          color: isDark ? '#f8fafc' : '#0f172a'
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
    });
  }, [payoffs, simState, trackingMode, allNE, isDark, uiRevision]);

  // Handle dragMode changes separately to preserve camera orientation
  useEffect(() => {
    const Plotly = (window as any).Plotly;
    if (!Plotly || !document.getElementById(plotId)) return;

    // Only update dragmode using relayout to preserve camera
    Plotly.relayout(plotId, { dragmode: dragMode });
  }, [dragMode]);

  return (
    <div ref={containerRef} className={`w-full relative border rounded-xl p-2 md:p-4 shadow-sm h-[450px] ${isDark ? 'bg-black border-slate-800' : 'bg-white border-slate-200'}`}>
      {/* Floating 3D Navigation Controls */}
      <div className={`absolute top-3 right-3 z-10 flex items-center gap-1 border p-1 rounded-xl shadow-xs ${isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-white/95 border-slate-200'}`}>
        <button
          type="button"
          onClick={() => setDragMode('orbit')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
            dragMode === 'orbit'
              ? isDark ? 'bg-blue-600/30 text-blue-400 border border-blue-500/30' : 'bg-blue-100 text-blue-700 border border-blue-200/50'
              : isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent' : 'text-slate-500 hover:bg-slate-100 border border-transparent'
          }`}
          title="Rotate view (Click & Drag)"
        >
          <Rotate3d className="w-3.5 h-3.5" />
          <span>Rotate</span>
        </button>
        <button
          type="button"
          onClick={() => setDragMode('pan')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
            dragMode === 'pan'
              ? isDark ? 'bg-blue-600/30 text-blue-400 border border-blue-500/30' : 'bg-blue-100 text-blue-700 border border-blue-200/50'
              : isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent' : 'text-slate-500 hover:bg-slate-100 border border-transparent'
          }`}
          title="Pan / Move view (Click & Drag)"
        >
          <Move className="w-3.5 h-3.5" />
          <span>Pan</span>
        </button>
        <div className={`w-px h-5 mx-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />
        <button
          type="button"
          onClick={() => setUiRevision(prev => prev + 1)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
            isDark
              ? 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent'
              : 'text-slate-500 hover:bg-slate-100 border border-transparent'
          }`}
          title="Reset 3D camera to default perspective"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Reset View</span>
        </button>
      </div>

      <div id={plotId} className="w-full h-full" />
    </div>
  );
};

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { GamePayoffs, SimState, NashEquilibrium } from '../types';
import { buildSurfaces, makeTraces, plotLayout } from '../utils/plotting';
import { Rotate3d, Move } from 'lucide-react';

interface PlotlyViewProps {
  payoffs: GamePayoffs;
  simState: SimState;
  trackingMode: 'A' | 'B' | 'both';
  allNE: NashEquilibrium[];
}

export const PlotlyView: React.FC<PlotlyViewProps> = ({
  payoffs,
  simState,
  trackingMode,
  allNE
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotId = 'plotly-3d-market-simulation';
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [dragMode, setDragMode] = useState<'orbit' | 'pan'>('orbit');

  useEffect(() => {
    const Plotly = (window as any).Plotly;
    if (!Plotly || !containerRef.current) return;

    // Build the surfaces and coordinates
    const surf = buildSurfaces(payoffs);
    const traces = makeTraces(surf, payoffs, simState, trackingMode, allNE);

    // Merge custom dynamic interactions into layout
    const layout = {
      ...plotLayout,
      dragmode: dragMode
    };

    // Initial plot assembly
    Plotly.react(plotId, traces, layout, {
      responsive: true,
      displayModeBar: false
    });

    // Cleanup resize observers when component shifts
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
    }

    // Set up robust ResizeObserver to force Plotly bounds to sync with fluid flex columns
    resizeObserverRef.current = new ResizeObserver(() => {
      if (Plotly && document.getElementById(plotId)) {
        Plotly.Plots.resize(plotId);
      }
    });
    
    resizeObserverRef.current.observe(containerRef.current);

    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
      try {
        if (Plotly) {
          Plotly.purge(plotId);
        }
      } catch (e) {
        // Safe bypass if container is already gone on fast cycles
      }
    };
  }, [payoffs, simState, trackingMode, allNE, dragMode]);

  return (
    <div ref={containerRef} className="w-full relative bg-white border border-slate-200 rounded-xl p-2 md:p-4 shadow-sm h-[450px]">
      {/* Floating 3D Navigation Controls */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1 bg-white/95 backdrop-blur-xs border border-slate-200 p-1 rounded-xl shadow-xs">
        <button
          type="button"
          onClick={() => setDragMode('orbit')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
            dragMode === 'orbit'
              ? 'bg-blue-100 text-blue-700 border border-blue-200/50'
              : 'text-slate-500 hover:bg-slate-100 border border-transparent'
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
              ? 'bg-blue-100 text-blue-700 border border-blue-200/50'
              : 'text-slate-500 hover:bg-slate-100 border border-transparent'
          }`}
          title="Pan / Move view (Click & Drag)"
        >
          <Move className="w-3.5 h-3.5" />
          <span>Pan</span>
        </button>
      </div>

      <div id={plotId} className="w-full h-full" />
    </div>
  );
};

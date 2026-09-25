/**
 * Red 15 break A, measured by memory instead of time. doStep once deep-cloned
 * the whole trajectory every step (O(N^2): 2.7 GB at 3000 steps, OOM at 5000).
 * test.ts's timing ratio (< 4) guards it, but measured on the defect put back
 * (M73) it read 23.4/6.3/10.0/7.4/4.4x: a miss is 10% away. Heap growth per
 * step after a forced GC is deterministic: fixed 1.58 -> 1.19 KB/step, M73
 * 76.5 -> 526 KB/step. Needs --expose-gc and FAILS without it.
 *
 *   tsx --expose-gc src/breakaheap.test.ts   (tsx forwards the flag to node)
 */
import assert from 'node:assert';
import { computeAllNE, doStep } from './utils/gameEngine';
import type { GamePayoffs } from './types';
import { createInitialState } from './test.ts';

const gc = (globalThis as { gc?: () => void }).gc;
assert(typeof gc === 'function', 'break-A heap check needs global.gc: run with node --expose-gc (a skipped check cannot fail)');
const g: GamePayoffs = { a11: 7, b11: -7, a12: -6, b12: -4, a21: -7, b21: 1, a22: 0, b22: -6 };
const all = computeAllNE(g);
const st = createInitialState(0.217, 0.217, g);
const step = () => doStep(g, st, 'A', 0.001, all, null, () => {}, () => {}, () => { st.running = false; }, 'shrink');
const heapAfter = (k: number) => { for (let i = 0; i < k && !st.converged; i++) step(); gc!(); gc!(); return process.memoryUsage().heapUsed; };
const h0 = heapAfter(0), h300 = heapAfter(300), h900 = heapAfter(600), h1200 = heapAfter(300);
assert(st.stepCount === 1200 && !st.converged, `fixture: 1200 unconverged steps of the crash game (got ${st.stepCount}, converged=${st.converged})`);
const early = (h300 - h0) / 300 / 1024, late = (h1200 - h900) / 300 / 1024;
assert(late < 16, `break A: per-step heap growth late in the run is ${late.toFixed(1)} KB (early ${early.toFixed(1)} KB); `
  + 'the fixed engine keeps ~1.2 KB/step and the O(N^2) snapshot clone costs ~526 KB/step');
console.log(`breakaheap.test.ts: 2 checks passed (early ${early.toFixed(2)} KB/step, late ${late.toFixed(2)} KB/step, bound 16)`);

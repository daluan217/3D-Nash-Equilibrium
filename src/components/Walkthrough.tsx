/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A guided, arrow-pointing tour of the visualiser.
 *
 * The app shows something most explanations of mixed equilibria can only assert:
 * indifference is a LEVEL SHELF on the expected-payoff surface, and the mixed
 * equilibrium is the point where both surfaces go level at once. A first-time
 * visitor has no reason to know that the picture is the argument, so this walks
 * them through it in a handful of captions and then gets out of the way.
 *
 * Steps target live DOM nodes by `data-tour="..."` rather than by position, so
 * the tour follows the layout instead of drifting when the responsive grid
 * reflows. A step whose target is missing is skipped rather than pointed at
 * nothing — see `resolveTarget`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';

export interface TourStep {
  /** Value of the `data-tour` attribute on the element to point at. */
  target: string;
  title: string;
  body: string;
  /** Run when the step becomes active — used to drive the app itself. */
  onEnter?: () => void;
}

interface Rect { top: number; left: number; width: number; height: number }

/** Gap between the spotlight and the caption card. */
const GAP = 16;
/** How far the highlight ring sits outside the target. */
const PAD = 8;

const readRect = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
};

export function Walkthrough({
  steps,
  open,
  onClose,
}: {
  steps: TourStep[];
  open: boolean;
  onClose: () => void;
}) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(0);

  const step = steps[i];
  const last = i === steps.length - 1;

  const close = useCallback(() => { setI(0); onClose(); }, [onClose]);

  // Fire the step's side effect once per step, not on every re-measure.
  useEffect(() => {
    if (!open || !step) return;
    step.onEnter?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, i]);

  /**
   * Track the target's box.
   *
   * Measured on a rAF loop rather than only on scroll/resize because the thing
   * being pointed at can move for reasons neither event reports: the 3D plot
   * resizes itself, the simulation grows the log, and the report panel expands
   * when an explanation arrives. A cheap identity check keeps this from causing
   * a render every frame.
   */
  useLayoutEffect(() => {
    if (!open || !step) return;
    let raf = 0;
    let prev = '';
    const tick = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        const r = readRect(el);
        const key = `${r.top}|${r.left}|${r.width}|${r.height}`;
        if (key !== prev) { prev = key; setRect(r); }
      } else if (prev !== 'none') {
        prev = 'none';
        setRect(null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Keyed on the TARGET, not the step object: App rebuilds the step array on
    // every render (so the steps' closures stay current), and depending on the
    // object identity would tear down and restart this loop each time.
  }, [open, step?.target]);

  // Bring the target into view when the step changes.
  useEffect(() => {
    if (!open || !step) return;
    document.querySelector(`[data-tour="${step.target}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [open, step?.target]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [i, rect, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') setI((n) => Math.min(n + 1, steps.length - 1));
      else if (e.key === 'ArrowLeft') setI((n) => Math.max(n - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, steps.length]);

  if (!open || !step) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const CARD_W = Math.min(520, vw - 32);
  const h = cardH || 280;

  // Put the card wherever there is room, preferring below the target. Without a
  // target (element not on screen) it centres, so a missing anchor degrades to a
  // plain caption instead of an arrow pointing into empty space.
  let cardTop: number;
  let cardLeft: number;
  let place: 'below' | 'above' | 'right' | 'left' | 'center' = 'center';
  if (rect) {
    const below = vh - (rect.top + rect.height) - GAP;
    const above = rect.top - GAP;
    const right = vw - (rect.left + rect.width) - GAP;
    const left = rect.left - GAP;
    // Below and above first because a caption reads most naturally stacked with
    // what it describes. LEFT/RIGHT exist for the tall targets — the 3D plot
    // fills most of the viewport height, so without them the card fell back to
    // centre and the step lost its arrow, which is the one thing the tour is
    // supposed to do.
    if (below >= h) { place = 'below'; cardTop = rect.top + rect.height + GAP; cardLeft = rect.left + rect.width / 2 - CARD_W / 2; }
    else if (above >= h) { place = 'above'; cardTop = rect.top - GAP - h; cardLeft = rect.left + rect.width / 2 - CARD_W / 2; }
    else if (right >= CARD_W) { place = 'right'; cardLeft = rect.left + rect.width + GAP; cardTop = rect.top + rect.height / 2 - h / 2; }
    else if (left >= CARD_W) { place = 'left'; cardLeft = rect.left - GAP - CARD_W; cardTop = rect.top + rect.height / 2 - h / 2; }
    else { place = 'center'; cardTop = Math.max(GAP, (vh - h) / 2); cardLeft = rect.left + rect.width / 2 - CARD_W / 2; }
    cardLeft = Math.max(GAP, Math.min(cardLeft, vw - CARD_W - GAP));
    cardTop = Math.max(GAP, Math.min(cardTop, vh - h - GAP));
  } else {
    cardTop = Math.max(GAP, (vh - h) / 2);
    cardLeft = (vw - CARD_W) / 2;
  }

  // Arrow: from the card's edge to the nearest edge of the spotlight.
  let arrow: { x1: number; y1: number; x2: number; y2: number } | null = null;
  if (rect && place !== 'center') {
    if (place === 'below' || place === 'above') {
      const x = Math.max(rect.left + 12, Math.min(cardLeft + CARD_W / 2, rect.left + rect.width - 12));
      arrow = place === 'below'
        ? { x1: x, y1: cardTop - 4, x2: x, y2: rect.top + rect.height + 3 }
        : { x1: x, y1: cardTop + h + 4, x2: x, y2: rect.top - 3 };
    } else {
      const y = Math.max(rect.top + 12, Math.min(cardTop + h / 2, rect.top + rect.height - 12));
      arrow = place === 'right'
        ? { x1: cardLeft - 4, y1: y, x2: rect.left + rect.width + 3, y2: y }
        : { x1: cardLeft + CARD_W + 4, y1: y, x2: rect.left - 3, y2: y };
    }
  }

  return (
    /* pointer-events-none on the container, auto on just the card and the exit
       button. The tour is an overlay to READ, not a modal that seizes the app:
       the visitor can rotate, pan, zoom and click the plot underneath while a
       step is on screen, which is the whole point of a tour of an interactive
       toy. aria-modal is deliberately NOT set for the same reason -- claiming
       modality while the page stays live would be a lie to a screen reader.
       Advancing is by the Next button or the arrow keys; a click-to-advance
       backdrop would have fought every drag of the 3D scene. */
    <div className="fixed inset-0 z-[60] pointer-events-none" role="dialog" aria-label="Guided tour">

      {/* Spotlight: an enormous ring shadow dims everything except the target. */}
      {rect && (
        <div
          className="absolute rounded-xl pointer-events-none transition-all duration-300 ease-out"
          style={{
            top: rect.top, left: rect.left, width: rect.width, height: rect.height,
            boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.72)',
            outline: '2px solid rgba(99, 102, 241, 0.9)',
            outlineOffset: '-1px',
          }}
        />
      )}
      {!rect && <div className="absolute inset-0 bg-slate-900/72 pointer-events-none" />}

      {/* Always-available exit, anchored to the viewport rather than to the
          caption card. The card's own X moves with the step, so on a step
          pointing at something near the top of the page it can end up
          somewhere unexpected; this one never moves. */}
      <button
        type="button"
        onClick={close}
        aria-label="Exit tour"
        className="pointer-events-auto absolute top-4 right-4 z-10 inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-slate-900/80 px-4 py-2.5 text-[15px] font-semibold text-white shadow-lg backdrop-blur-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-colors"
      >
        <X className="w-4 h-4" /> Exit tour
      </button>

      {arrow && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
          <defs>
            <marker id="tour-head" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
              <path d="M0,0 L9,4.5 L0,9 z" fill="rgb(129,140,248)" />
            </marker>
          </defs>
          <line
            x1={arrow.x1} y1={arrow.y1} x2={arrow.x2} y2={arrow.y2}
            stroke="rgb(129,140,248)" strokeWidth="2.5" strokeLinecap="round"
            markerEnd="url(#tour-head)"
          />
        </svg>
      )}

      <div
        ref={cardRef}
        className="pointer-events-auto absolute rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl p-6 sm:p-7 flex flex-col gap-3.5"
        style={{ top: cardTop, left: cardLeft, width: CARD_W }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="text-[13px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
            {i + 1} / {steps.length}
          </span>
          <button
            type="button"
            onClick={close}
            aria-label="Close tour"
            className="shrink-0 -m-1.5 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <h3 className="text-2xl font-bold text-slate-800 dark:text-slate-100 leading-snug tracking-tight">{step.title}</h3>
        <p className="text-[17px] leading-relaxed text-slate-600 dark:text-slate-300" aria-live="polite">{step.body}</p>

        <div className="flex items-center justify-between gap-3 pt-3 mt-1 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            onClick={close}
            className="text-[15px] font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setI((n) => Math.max(n - 1, 0))}
              disabled={i === 0}
              className="inline-flex items-center gap-1 rounded-xl px-4 py-2.5 text-[15px] font-semibold text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <button
              type="button"
              onClick={() => (last ? close() : setI((n) => n + 1))}
              className="inline-flex items-center gap-1 rounded-xl px-5 py-2.5 text-[15px] font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
            >
              {last ? 'Explore on your own' : <>Next <ArrowRight className="w-4 h-4" /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

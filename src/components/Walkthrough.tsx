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
/** Below this viewport width the caption docks to the bottom as a sheet. */
const COMPACT_MAX = 900;
/** Ceiling on the sheet's height, so it can never swallow the picture. */
const SHEET_MAX_VH = 0.38;
/** Short screens give the sheet less, because the strip above it is the scarce
 *  resource there — a 667px phone spends 161px on a sticky header before the
 *  picture gets any room at all. */
const SHEET_MAX_VH_SHORT = 0.32;
const SHORT_VH = 720;
const sheetMaxVh = (vh: number) => (vh < SHORT_VH ? SHEET_MAX_VH_SHORT : SHEET_MAX_VH);

/** Bottom edge of the sticky header, which overlays the top of the page. */
function headerOffset(): number {
  const el = document.querySelector('header');
  if (!el) return 0;
  const r = el.getBoundingClientRect();
  // Only counts while it is actually pinned over the content.
  return r.top <= 1 ? Math.max(0, r.bottom) : 0;
}
/**
 * Fixed size estimates for the FLOATING card, used only to ask "would it fit
 * beside the target?".
 *
 * Deliberately constants rather than the measured height: the sheet is shorter
 * than the floating card, so testing with the live measurement flip-flops —
 * sheet fits, so switch to floating, which no longer fits, so switch back.
 */
// Must be >= the real floating card, which measures ~405px at the desktop type
// scale. An optimistic 300 made the fit test disagree with the placement that
// followed it: the test said "fits", placement then found no side with 405px of
// room and fell back to a centred card sitting across 79% of its own target.
const FLOAT_H_EST = 420;
const FLOAT_W_EST = 520;

/** Would a floating card fit on some side of this rect? */
function floatingFits(r: Rect, vw: number, vh: number): boolean {
  return (vh - (r.top + r.height) - GAP) >= FLOAT_H_EST
      || (r.top - GAP) >= FLOAT_H_EST
      || (vw - (r.left + r.width) - GAP) >= FLOAT_W_EST
      || (r.left - GAP) >= FLOAT_W_EST;
}

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
  /**
   * Viewport, tracked in state so a rotation or resize re-lays-out the card.
   * Read during render otherwise, which would go stale on orientation change.
   */
  const [vp, setVp] = useState(() => ({
    w: typeof window === 'undefined' ? 1280 : window.innerWidth,
    h: typeof window === 'undefined' ? 800 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

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

  /**
   * Bring the target into view when the step changes.
   *
   * On a phone the card is a bottom sheet, so `block: 'center'` centres the
   * target in the FULL viewport — which is underneath the sheet. Measured
   * before this fix: the card covered 85-90% of the very element it was
   * pointing at. Small screens instead centre the target in the strip of
   * screen left above the sheet.
   */
  useEffect(() => {
    if (!open || !step) return;
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    const asRect: Rect = { top: r0.top, left: r0.left, width: r0.width, height: r0.height };
    const isLand = window.innerWidth > window.innerHeight;
    const willSheet = !isLand && (window.innerWidth < COMPACT_MAX
      || !floatingFits(asRect, window.innerWidth, window.innerHeight));
    if (!willSheet && !isLand) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // The sticky header sits OVER the top of the page, so the usable strip
    // starts below it. Without this the target was scrolled to the top of the
    // viewport and the header covered 123-137px of it on a phone.
    const top = headerOffset();
    // In landscape the card sits BESIDE the target, so the whole below-header
    // strip is available; only the portrait sheet eats vertical room.
    const sheetH = isLand ? 0 : (cardH || Math.round(window.innerHeight * sheetMaxVh(window.innerHeight)));
    const room = Math.max(120, window.innerHeight - sheetH - top - GAP * 2);
    // Centre it when it fits; when the target is TALLER than the strip -- the
    // 3D plot on a phone is -- centring pushes its bottom under the sheet and
    // its top off screen at once. Align the top instead, so the part of the
    // picture being described is the part that stays visible.
    const delta = r0.height > room
      ? r0.top - top - GAP
      : (r0.top + r0.height / 2) - (top + room / 2);
    window.scrollBy({ top: delta, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const vw = vp.w;
  const vh = vp.h;
  /**
   * Orientation decides the layout FAMILY, and it is the viewport's aspect —
   * never the device class. A phone rotated sideways, an iPad in landscape and
   * a desktop browser at full width are all `landscape`; the same desktop
   * snapped into a half-screen split taller than it is wide is `portrait`.
   * Keying on user-agent or touch would get every one of those wrong somewhere.
   *
   * LANDSCAPE: the card always sits horizontally adjacent to its target — left
   * or right, whichever side has more room — so the arrow is always horizontal.
   * PORTRAIT: the previous behaviour — a bottom sheet on narrow screens or
   * wherever a floating card cannot fit, the free-floating card otherwise.
   */
  const landscape = vw > vh;
  const sheet = !landscape && (vw < COMPACT_MAX || (!!rect && !floatingFits(rect, vw, vh)));

  /** Landscape card width: whatever the roomier side offers, clamped sane. */
  const sideAvail = rect
    ? Math.max(vw - (rect.left + rect.width) - GAP * 2, rect.left - GAP * 2)
    : vw - GAP * 2;
  const CARD_W = landscape
    ? Math.max(280, Math.min(520, Math.min(sideAvail, vw - GAP * 2)))
    : sheet
      ? vw - GAP * 2
      : Math.min(520, vw - 32);
  const h = cardH
    || (sheet ? Math.round(vh * sheetMaxVh(vh))
      : landscape ? Math.min(300, vh - GAP * 2)
      : 280);

  // Put the card wherever there is room, preferring below the target. Without a
  // target (element not on screen) it centres, so a missing anchor degrades to a
  // plain caption instead of an arrow pointing into empty space.
  /** Small-type treatment: the portrait sheet, or a landscape card that is
   *  narrow or on a short screen (a phone held sideways is ~390px tall). */
  const dense = sheet || (landscape && (CARD_W < 420 || vh < 560));
  let cardTop: number;
  let cardLeft: number;
  let place: 'below' | 'above' | 'right' | 'left' | 'center' = 'center';
  if (landscape) {
    if (rect) {
      // Horizontal by decree, not by search: the roomier side wins, and when
      // even that side is too narrow the card docks at the screen edge and is
      // allowed to overlap the target's edge rather than abandon the layout.
      // A phone in landscape has full-width targets, so "fits beside" is often
      // impossible — a right-docked panel with a horizontal arrow is still the
      // reading the user asked for, and beats a sheet covering the bottom half.
      const rightSpace = vw - (rect.left + rect.width) - GAP * 2;
      const leftSpace = rect.left - GAP * 2;
      place = rightSpace >= leftSpace ? 'right' : 'left';
      cardLeft = place === 'right'
        ? Math.min(rect.left + rect.width + GAP, vw - CARD_W - GAP)
        : Math.max(GAP, rect.left - GAP - CARD_W);
      cardTop = Math.max(GAP, Math.min(rect.top + rect.height / 2 - h / 2, vh - h - GAP));
    } else {
      cardTop = Math.max(GAP, (vh - h) / 2);
      cardLeft = (vw - CARD_W) / 2;
    }
  } else if (sheet) {
    // Docked to the bottom, full width. `place = 'below'` is not a guess about
    // free space here -- the sheet IS below, and the scroll effect above has
    // put the target in the strip over it, so the existing arrow geometry
    // (card top -> target bottom) is correct by construction.
    cardLeft = GAP;
    cardTop = vh - h - GAP;
    place = rect ? 'below' : 'center';
  } else if (rect) {
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
      // Clamped so the head always sits at least 8px on the target's side of
      // the card edge. In landscape the card may legitimately overlap a
      // full-width target (a phone held sideways); without the clamp the two
      // endpoints swap and the arrow points INTO the card.
      if (place === 'right') {
        const x1 = cardLeft - 4;
        arrow = { x1, y1: y, x2: Math.min(rect.left + rect.width + 3, x1 - 8), y2: y };
      } else {
        const x1 = cardLeft + CARD_W + 4;
        arrow = { x1, y1: y, x2: Math.max(rect.left - 3, x1 + 8), y2: y };
      }
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
        className={`pointer-events-auto absolute top-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-slate-900/80 font-semibold text-white shadow-lg backdrop-blur-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-colors ${dense ? 'px-3 py-1.5 text-[12px]' : 'px-4 py-2.5 text-[15px]'}`}
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
        className={`pointer-events-auto absolute rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl flex flex-col ${
          dense ? 'p-4 gap-2' : 'p-6 sm:p-7 gap-3.5'
        }`}
        style={{
          top: cardTop,
          left: cardLeft,
          width: CARD_W,
          // Capped rather than fixed: a long caption scrolls inside the sheet
          // instead of growing over the diagram it is describing.
          maxHeight: sheet ? `${Math.round(sheetMaxVh(vh) * 100)}vh` : landscape ? `${vh - GAP * 2}px` : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <span className={`font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 ${dense ? 'text-[11px]' : 'text-[13px]'}`}>
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

        <h3 className={`font-bold text-slate-800 dark:text-slate-100 leading-snug tracking-tight ${dense ? 'text-[17px]' : 'text-2xl'}`}>{step.title}</h3>
        <p
          className={`leading-relaxed text-slate-600 dark:text-slate-300 ${dense ? 'text-[14px]' : 'text-[17px]'}${sheet || landscape ? ' overflow-y-auto min-h-0' : ''}`}
          aria-live="polite"
        >
          {step.body}
        </p>

        <div className={`flex items-center justify-between gap-3 border-t border-slate-100 dark:border-slate-800 ${dense ? 'pt-2 mt-0.5' : 'pt-3 mt-1'} shrink-0`}>
          <button
            type="button"
            onClick={close}
            className={`font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors ${dense ? 'text-[13px]' : 'text-[15px]'}`}
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setI((n) => Math.max(n - 1, 0))}
              disabled={i === 0}
              className={`inline-flex items-center gap-1 rounded-xl font-semibold text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors ${dense ? 'px-3 py-2 text-[13px]' : 'px-4 py-2.5 text-[15px]'}`}
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <button
              type="button"
              onClick={() => (last ? close() : setI((n) => n + 1))}
              className={`inline-flex items-center gap-1 rounded-xl font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors ${dense ? 'px-3.5 py-2 text-[13px]' : 'px-5 py-2.5 text-[15px]'}`}
            >
              {last ? 'Explore on your own' : <>Next <ArrowRight className="w-4 h-4" /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

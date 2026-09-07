/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

/**
 * WAI-ARIA APG "Tab is confined to the dialog while it is open" — the same
 * rule #90 already implemented once, inline, for App.tsx's expand-log dialog
 * (out of this component's scope; it keeps its own hand-rolled trap).
 *
 * RED-APP-5 finding 002 (round 5): the app's other four `role="dialog"
 * aria-modal="true"` surfaces (Feedback, Auth, Save, Edit) had NO trap at
 * all, so repeatedly pressing Tab walked focus off the dialog and onto the
 * page behind the backdrop — concretely, onto the floating "Feedback"
 * button, where an Enter press opened a SECOND `aria-modal="true"` dialog on
 * top of the still-open first one. `aria-modal="true"` exists specifically
 * to promise assistive tech that the rest of the document is inert while a
 * modal is open; a real Tab trap is what makes that promise true, not just
 * declared.
 *
 * `useModalTabTrap` itself deliberately does NOT handle Escape — `ModalSurface`
 * below does, per-instance, once a surface is registered active. (round15:
 * every caller, including the local-games offer and the expand-log overlay,
 * now goes through `ModalSurface` — see docs/MODAL-SURFACE.md.)
 *
 * DOES move initial focus into the dialog on open (CodeRabbit review on PR
 * #91, after the RED-APP-5/002 fix above shipped): only Feedback sets its
 * own `autoFocus` field; Auth, Save and Edit have none, so on those three
 * focus was left stranded on the background opener until the user's FIRST
 * Tab press — no signal at all that a modal had opened, for a screen reader
 * or for someone tabbing who has not yet reached the dialog. Fixed by
 * focusing the first enabled control ONLY when focus is not ALREADY inside
 * the dialog: React commits an element's `autoFocus` during the SAME commit
 * phase as this effect's dependency change, strictly before this PASSIVE
 * effect runs, so by the time this checks `document.activeElement`,
 * Feedback's textarea is already focused and this is a no-op for it — the
 * existing in-dialog autofocus behavior is unchanged, exactly what
 * CodeRabbit asked for. Does not restore focus on close (unmeasured,
 * narrower than this finding).
 */
export function getModalFocusables(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"]), input, select, textarea, a[href]'),
  ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
}

/** RED-APP-15/001: the panel itself and any `tabIndex={-1}` landmark inside it
 *  (e.g. SavedGamesList's `[data-focus-fallback]` wrappers) can become
 *  `document.activeElement` via a mouse click but are never in `focusables`.
 *  Route Tab by DOM order relative to `from` rather than a fixed boundary, so
 *  a landmark with real controls nested after it (a populated list) still
 *  advances into them; only wrap when there is nothing after/before it. */
function focusableAfter(focusables: HTMLElement[], from: Node): HTMLElement {
  for (const el of focusables) {
    if (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) return el;
  }
  return focusables[0];
}
function focusableBefore(focusables: HTMLElement[], from: Node): HTMLElement {
  for (let i = focusables.length - 1; i >= 0; i--) {
    if (from.compareDocumentPosition(focusables[i]) & Node.DOCUMENT_POSITION_PRECEDING) return focusables[i];
  }
  return focusables[focusables.length - 1];
}

/** A real interactive control — never a `tabIndex={-1}` container used only
 *  as a focus-parking landmark or panel (see RED-APP-14/005 below). */
const REAL_CONTROL_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The control the user last focused or pressed, so a dialog can hand focus
 * back to what opened it. `pointerdown`/`keydown` are the sources of record
 * for a real user interaction; `focusin` only ever CONFIRMS the same thing
 * for pure keyboard Tab-navigation (moving into a control with no press) and
 * is filtered to real controls so it can never clobber a correct value with
 * a landmark. Installed once, lazily, by the first dialog that opens.
 *
 * RED-APP-14/005: WebKit does not focus a clicked `<button>` — it focuses
 * the nearest MOUSE-FOCUSABLE ANCESTOR instead, which for a row inside
 * `SavedGamesList`'s `[data-focus-fallback]` wrapper (kept mounted with
 * `tabIndex={-1}`, BLUE-LIST-14) is that wrapper, not the button the user
 * actually pressed. The `focusin` this produces used to win (it fires AFTER
 * `pointerdown`) and overwrite the correct value with the wrapper, so
 * `focusAfterDialog` returned focus to the landmark instead of the button on
 * every engine but Chromium. Filtering `focusin` to `REAL_CONTROL_SELECTOR`
 * (never a bare `[tabindex="-1"]` match) removes the clobber; `pointerdown`
 * and `keydown` (mouse press and keyboard activation, respectively) are
 * exactly the events WebKit still fires on the real control itself.
 */
let lastInteractedControl: HTMLElement | null = null;
let openerTrackingInstalled = false;
function installOpenerTracking(): void {
  if (openerTrackingInstalled || typeof document === 'undefined') return;
  openerTrackingInstalled = true;
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLElement && e.target !== document.body && e.target.matches(REAL_CONTROL_SELECTOR)) lastInteractedControl = e.target;
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const control = (e.target as HTMLElement | null)?.closest?.(REAL_CONTROL_SELECTOR);
    if (control instanceof HTMLElement) lastInteractedControl = control;
  }, true);
  document.addEventListener('keydown', (e) => {
    const control = (e.target as HTMLElement | null)?.closest?.(REAL_CONTROL_SELECTOR);
    if (control instanceof HTMLElement) lastInteractedControl = control;
  }, true);
  // RED-APP-12/001: a focused control that is REMOVED from the DOM (the header's
  // Sign-In button when the signed-in controls replace it moments after the
  // Account dialog closed; a row's Delete button once its row is gone) leaves
  // focus on <body>. Chromium reports the removal as a `focusout` with no
  // relatedTarget (measured in the trace that found this); once the commit
  // that removed the element is over, if focus really is on <body> and the
  // element really is gone, hand focus to the landmark it belonged to, else to
  // the page's focus home.
  document.addEventListener('focusout', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || e.relatedTarget) return;
    const landmark = el.closest('[data-focus-fallback]')?.getAttribute('data-focus-fallback') ?? null;
    requestAnimationFrame(() => {
      if (el.isConnected || document.activeElement !== document.body) return;
      // RED-APP-13/002 (round14): a control this passive fallback would
      // otherwise refocus can sit BEHIND an open ModalSurface's backdrop
      // (the header account landmark, while Save/Edit/Auth/Feedback/the
      // drawer is open) — the same "focus escaped an open dialog" shape as
      // the [user] effect this round also guards. No-op while any surface
      // is registered; the surface's own trap/focus-return owns focus then.
      if (ModalRegistry.isAnyOpen()) return;
      const target = (landmark ? firstVisible(`[data-focus-fallback="${landmark}"] button, [data-focus-fallback="${landmark}"]`) : null)
        ?? firstVisible('[data-focus-home]');
      target?.focus();
    });
  }, true);
}

/** First visible, enabled element matching `selector` (or null). */
export function firstVisible(selector: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (el.hasAttribute('disabled')) continue;
    // Only something that can actually take focus: a landmark container
    // without tabindex matched here once and `.focus()` on it did nothing,
    // leaving focus on <body> (measured while fixing RED-APP-12/001).
    if (!el.matches('button, [href], input, select, textarea, [tabindex]')) continue;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue; // display:none / hidden branch of a responsive pair
    return el;
  }
  return null;
}

/**
 * Where focus goes when a dialog closes and its opener is gone (RED-APP-12/001:
 * the header's Sign-In button is replaced by the signed-in controls the moment
 * a sign-in succeeds; an Edit button vanishes when its row is deleted; the
 * desktop adopt dialog's opener — the Login button — unmounts with the Account
 * dialog). `fallback` is a selector for the dialog's own landmark; the final
 * resort is the page's focus home (`[data-focus-home]`), never <body>.
 */
export function focusAfterDialog(opener: HTMLElement | null, fallback?: string): void {
  const active = document.activeElement;
  const focusLost = !active || active === document.body || !document.contains(active);
  if (!focusLost) return; // something else (another dialog) already took focus on purpose
  const target = (opener && opener.isConnected && (opener.offsetParent !== null || getComputedStyle(opener).position === 'fixed'))
    ? opener
    : (fallback ? firstVisible(fallback) : null) ?? firstVisible('[data-focus-home]');
  target?.focus();
}

export function useModalTabTrap(open: boolean, containerRef: RefObject<HTMLElement | null>, fallback?: string) {
  // Tracking must exist BEFORE the click that opens the dialog, so it is
  // installed on mount, not on open.
  useEffect(() => { installOpenerTracking(); }, []);
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    // RED-APP-11/004: every close path (Escape, Cancel, a successful Save)
    // dropped focus to <body> — a keyboard user was thrown back to the top
    // of the page. Remember what opened the dialog and, on close, return
    // focus there if it still exists and nothing else has claimed focus.
    const opener = lastInteractedControl && container && !container.contains(lastInteractedControl)
      ? lastInteractedControl : null;
    if (container && !container.contains(document.activeElement)) {
      const focusables = getModalFocusables(container);
      // RED-APP-14/002: every control disabled at open time parks focus on
      // the panel itself rather than doing nothing (kept symmetric with the
      // mid-dialog case below, even though today's callers always have at
      // least one control enabled when they first open).
      (focusables[0] ?? container).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = getModalFocusables(container);
      if (focusables.length === 0) {
        // RED-APP-14/002: every control is disabled (a request mid-flight
        // disabled the whole dialog). The trap used to give up here — `return`
        // let the browser's own Tab traversal continue onto the page behind
        // the backdrop. Swallow the key and keep focus parked on the panel
        // (`tabIndex={-1}`, never in the natural Tab order) instead.
        e.preventDefault();
        if (document.activeElement !== container) container.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      // Also catches focus already OUTSIDE the container (the exact leak
      // this finding reproduced: N tabs in, focus lands past `last` on a
      // background element) — not just the two boundary elements, so a
      // focus that has already escaped is pulled back in rather than only
      // preventing the NEXT escape (RED-APP-5/002). `Node.contains()` returns
      // true for the node itself, so this alone does not catch the panel.
      if (!container.contains(document.activeElement)) {
        // Already fully outside the dialog — DOM order to a node outside it
        // is meaningless, so land at the near boundary same as before.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      const active = document.activeElement as HTMLElement;
      if (!focusables.includes(active)) {
        // RED-APP-15/001: `active` is not in `focusables` — either the panel
        // itself (never matched by getModalFocusables' selector, so this
        // covers OPUS-REVIEW-MODAL BLOCK 1's `=== container` case too) or a
        // `tabIndex={-1}` landmark inside it (SavedGamesList's
        // data-focus-fallback wrappers). Route by DOM position instead of a
        // fixed boundary (see focusableAfter/Before above) — for the
        // container every focusable already follows it, so this reduces to
        // the old first/last behaviour unchanged.
        e.preventDefault();
        (e.shiftKey ? focusableBefore(focusables, active) : focusableAfter(focusables, active)).focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    // RED-APP-13/002 (round14): a control INSIDE the dialog that becomes
    // `disabled` while it holds focus (e.g. a submit button during its own
    // in-flight request) is blurred straight to <body> by the browser — no
    // keydown involved, so `onKey` above never runs. Previously the app's
    // global `[user]` focus effect "caught" this by accident and threw focus
    // at a HEADER control hidden under this dialog's own backdrop (002's
    // reproduction); now that effect no-ops while a surface is open, so
    // without this, focus would simply be abandoned on <body>, still wrong.
    // Bring it back into THIS dialog — never to a landmark elsewhere — as
    // long as the dialog is still open and nothing else has since claimed
    // focus on purpose (another registered surface, or a real Tab escape
    // already handled above).
    const onFocusOut = (e: FocusEvent) => {
      const current = containerRef.current;
      if (!current || !(e.target instanceof Node) || !current.contains(e.target)) return;
      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container || container.contains(document.activeElement)) return;
        if (document.activeElement !== document.body) return;
        // RED-APP-14/002: previously `?.focus()` on an undefined [0] (every
        // control disabled) was a silent no-op — focus stayed abandoned on
        // <body>. Park on the panel itself instead, same as `onKey` above.
        const focusables = getModalFocusables(container);
        (focusables[0] ?? container).focus();
      });
    };
    container?.addEventListener('focusout', onFocusOut);
    // RED-APP-14/002: once every control was disabled and focus parked on the
    // panel, nothing previously noticed controls becoming re-enabled again
    // (e.g. a failed in-flight request that leaves the dialog open for a
    // retry). Watch for that and hand focus to the first control the moment
    // it is enabled — but only while focus is still exactly where THIS trap
    // parked it, never stealing focus the user has since moved elsewhere.
    const reenableObserver = new MutationObserver(() => {
      const c = containerRef.current;
      if (!c || document.activeElement !== c) return;
      const focusables = getModalFocusables(c);
      if (focusables.length > 0) focusables[0].focus();
    });
    if (container) reenableObserver.observe(container, { attributes: true, subtree: true, attributeFilter: ['disabled'] });
    return () => {
      window.removeEventListener('keydown', onKey);
      container?.removeEventListener('focusout', onFocusOut);
      reenableObserver.disconnect();
      focusAfterDialog(opener, fallback);
    };
  }, [open, containerRef, fallback]);
}

/**
 * round14 structural pass (STRUCTURAL.md): a module-level stack of every
 * currently-open `ModalSurface`. RED-APP-13/002+004 were both the SAME shape
 * — a second `role="dialog"` overlay opening (or Enter reaching a background
 * control) while a first was still open, because nothing enforced "only one
 * at a time." A non-stacking surface now REFUSES to open while another is
 * already registered, so the two-dialogs-at-once state is unreachable rather
 * than patched per finding. `allowsStack` is the one declared exception
 * (reserved for the guided tour, which does not use this registry today —
 * no caller in this file currently passes `allowsStack: true`).
 *
 * RED-APP-14/004 (round15): a surface refused at open time used to stay
 * refused FOREVER, even after the blocker closed — `ModalSurface`'s own
 * registration effect keyed only on `[open, id, allowsStack]`, none of which
 * change when some OTHER surface's registration changes. `subscribe` lets a
 * refused-but-still-`open` surface retry the moment the stack changes, so
 * two surfaces racing to open in the same commit (the local-games offer and
 * a resumed Save dialog, both triggered by the same sign-in) settle into
 * "the one that registered first shows now; the other opens the instant the
 * first closes" — sequenced, never stacked — with no caller-side coordination.
 */
interface ModalRegistryEntry { id: string; allowsStack: boolean }
let modalStack: ModalRegistryEntry[] = [];
let stackListeners: Set<() => void> = new Set();
function notifyStackChanged(): void { for (const listener of stackListeners) listener(); }
export const ModalRegistry = {
  /** True if `id` may become (or remain) the active surface: nothing else is
   *  open, or every OTHER currently-open entry declares `allowsStack`. */
  canOpen(id: string): boolean {
    return modalStack.every((e) => e.id === id || e.allowsStack);
  },
  open(id: string, allowsStack: boolean): void {
    if (!modalStack.some((e) => e.id === id)) { modalStack = [...modalStack, { id, allowsStack }]; notifyStackChanged(); }
  },
  close(id: string): void {
    if (modalStack.some((e) => e.id === id)) { modalStack = modalStack.filter((e) => e.id !== id); notifyStackChanged(); }
  },
  /** True while at least one surface (other than `excludeId`) is open — the
   *  guard App's global focus effects check before acting (RED-APP-13/002):
   *  the [user]-keyed header focus effect, and the focusout landmark
   *  fallback above. */
  isAnyOpen(excludeId?: string): boolean {
    return modalStack.some((e) => e.id !== excludeId);
  },
  isRegistered(id: string): boolean {
    return modalStack.some((e) => e.id === id);
  },
  depth(): number { return modalStack.length; },
  /** Called whenever the stack changes (an open or a close) for ANY id — a
   *  refused surface uses this to retry, not to be told who moved. */
  subscribe(listener: () => void): () => void {
    stackListeners.add(listener);
    return () => stackListeners.delete(listener);
  },
  /** Test-only: clear all registrations between cases. */
  _resetForTests(): void { modalStack = []; stackListeners = new Set(); },
};

const OVERLAY_CLASS = 'fixed inset-0 z-[65] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none';
const PANEL_CLASS = 'bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-xl animate-modal-in max-h-[90vh] overflow-y-auto';
const DRAWER_OVERLAY_CLASS = 'fixed inset-0 z-50 flex justify-end select-none';
const DRAWER_BACKDROP_CLASS = 'fixed inset-0 bg-slate-900/40 dark:bg-black/50 backdrop-blur-xs transition-opacity cursor-pointer duration-300';

export interface ModalSurfaceProps {
  /** Stable registry key — one per surface (e.g. 'account', 'drawer'). */
  id: string;
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  /** Selector for the surface's own landmark, passed straight to
   *  `useModalTabTrap`/`focusAfterDialog` as the close-time fallback. */
  fallbackSelector?: string;
  /** Only the guided tour is meant to set this (see the registry doc above);
   *  no current caller does. */
  allowsStack?: boolean;
  /** 'centered' (the four card dialogs) or 'drawer' (the slide-in workspace
   *  menu) — visual chrome only. Role, trap, Escape, focus and the registry
   *  are identical either way. */
  layout?: 'centered' | 'drawer';
  panelClassName?: string;
  /** The drawer's Electron no-drag region; unused by the centered dialogs. */
  panelStyle?: CSSProperties;
  overlayClassName?: string;
  children: ReactNode;
}

/**
 * round14 structural pass: the one primitive every `role="dialog"` overlay in
 * this app (Account, Save, Edit, Feedback, and the workspace drawer) renders
 * through. Owns registry membership, the Tab trap, Escape-to-close, open-time
 * focus and focus-return — a caller supplies only its chrome and content.
 */
export function ModalSurface({
  id, open, onClose, ariaLabel, fallbackSelector, allowsStack = false,
  layout = 'centered', panelClassName, panelStyle, overlayClassName, children,
}: ModalSurfaceProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pointerDownOnOverlayRef = useRef(false);
  // Registration happens in a layout effect so a refused surface never
  // paints (RED-APP-13/002+004: two dialogs stacked at once) — the extra
  // render this costs is synchronous, before the browser gets to show
  // anything, not a visible flash.
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    if (!open) { setActive(false); return; }
    // RED-APP-14/004: try now, and again every time the stack changes while
    // this surface is still `open` but not yet registered — the queueing
    // that lets "close the blocker, then open" happen with no caller-side
    // sequencing (see the registry doc above).
    const tryRegister = () => {
      if (ModalRegistry.isRegistered(id)) return;
      const canOpen = ModalRegistry.canOpen(id);
      setActive(canOpen);
      if (canOpen) ModalRegistry.open(id, allowsStack);
    };
    tryRegister();
    const unsubscribe = ModalRegistry.subscribe(tryRegister);
    return () => { unsubscribe(); ModalRegistry.close(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id, allowsStack]);

  useModalTabTrap(active, panelRef, fallbackSelector);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, onClose]);

  if (!active) return null;

  if (layout === 'drawer') {
    return (
      <div data-modal-surface={id} className={overlayClassName ?? DRAWER_OVERLAY_CLASS}>
        <div className={DRAWER_BACKDROP_CLASS} onClick={onClose} />
        <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={ariaLabel} className={panelClassName} style={panelStyle}>
          {children}
        </div>
      </div>
    );
  }
  return (
    <div
      data-modal-surface={id}
      className={overlayClassName ?? OVERLAY_CLASS}
      // RED-APP-14/007: a drag that STARTS inside the panel (selecting text in
      // a field) and ends over the backdrop fires `click` on the overlay — the
      // common ancestor — which used to dismiss the dialog and lose the typed
      // text. Close only when the pointer went DOWN on the backdrop itself.
      onPointerDown={(e) => { pointerDownOnOverlayRef.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pointerDownOnOverlayRef.current) onClose(); pointerDownOnOverlayRef.current = false; }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
        className={panelClassName ?? PANEL_CLASS}
      >
        {children}
      </div>
    </div>
  );
}

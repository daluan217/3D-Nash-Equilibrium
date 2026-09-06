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
 * below does, per-instance, once a surface is registered active. (App.tsx's
 * `localGamesOffer` dialog is the one caller that still uses this hook
 * directly, outside `ModalSurface`, round14 being out of scope for it; its
 * own central Escape chain is unchanged.)
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

/**
 * The control the user last focused or pressed, so a dialog can hand focus
 * back to what opened it. `focusin` covers keyboard users; `pointerdown`
 * covers browsers (Safari, Firefox on macOS) where clicking a button does
 * not focus it. Installed once, lazily, by the first dialog that opens.
 */
let lastInteractedControl: HTMLElement | null = null;
let openerTrackingInstalled = false;
function installOpenerTracking(): void {
  if (openerTrackingInstalled || typeof document === 'undefined') return;
  openerTrackingInstalled = true;
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLElement && e.target !== document.body) lastInteractedControl = e.target;
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const control = (e.target as HTMLElement | null)?.closest?.('button, [href], input, select, textarea, [tabindex]');
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
      getModalFocusables(container)[0]?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = getModalFocusables(container);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      // Also catches focus already OUTSIDE the container (the exact leak
      // this finding reproduced: N tabs in, focus lands past `last` on a
      // background element) — not just the two boundary elements, so a
      // focus that has already escaped is pulled back in rather than only
      // preventing the NEXT escape.
      if (!container.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
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
        getModalFocusables(container)[0]?.focus();
      });
    };
    container?.addEventListener('focusout', onFocusOut);
    return () => {
      window.removeEventListener('keydown', onKey);
      container?.removeEventListener('focusout', onFocusOut);
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
 */
interface ModalRegistryEntry { id: string; allowsStack: boolean }
let modalStack: ModalRegistryEntry[] = [];
export const ModalRegistry = {
  /** True if `id` may become (or remain) the active surface: nothing else is
   *  open, or every OTHER currently-open entry declares `allowsStack`. */
  canOpen(id: string): boolean {
    return modalStack.every((e) => e.id === id || e.allowsStack);
  },
  open(id: string, allowsStack: boolean): void {
    if (!modalStack.some((e) => e.id === id)) modalStack = [...modalStack, { id, allowsStack }];
  },
  close(id: string): void {
    if (modalStack.some((e) => e.id === id)) modalStack = modalStack.filter((e) => e.id !== id);
  },
  /** True while at least one surface (other than `excludeId`) is open — the
   *  guard App's global focus effects check before acting (RED-APP-13/002):
   *  the [user]-keyed header focus effect, and the focusout landmark
   *  fallback above. */
  isAnyOpen(excludeId?: string): boolean {
    return modalStack.some((e) => e.id !== excludeId);
  },
  depth(): number { return modalStack.length; },
  /** Test-only: clear all registrations between cases. */
  _resetForTests(): void { modalStack = []; },
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
  // Registration happens in a layout effect so a refused surface never
  // paints (RED-APP-13/002+004: two dialogs stacked at once) — the extra
  // render this costs is synchronous, before the browser gets to show
  // anything, not a visible flash.
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    if (!open) { setActive(false); return; }
    const canOpen = ModalRegistry.canOpen(id);
    setActive(canOpen);
    if (canOpen) ModalRegistry.open(id, allowsStack);
    return () => ModalRegistry.close(id);
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
        <div ref={panelRef} role="dialog" aria-modal="true" aria-label={ariaLabel} className={panelClassName} style={panelStyle}>
          {children}
        </div>
      </div>
    );
  }
  return (
    <div data-modal-surface={id} className={overlayClassName ?? OVERLAY_CLASS} onClick={onClose}>
      <div
        ref={panelRef}
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

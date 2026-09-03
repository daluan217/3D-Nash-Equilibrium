/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RED-APP-8/004: `localStorage.getItem`/`setItem`/`removeItem` can throw for
 * reasons entirely outside this app's control — the most realistic being a
 * genuine `QuotaExceededError` (old Safari private-browsing sets the quota
 * to 0 for every write; a shared/managed machine or a profile with years of
 * other sites' data can hit the real per-origin cap). Several call sites in
 * `App.tsx` run inside a `useState` initializer or an effect that fires
 * UNCONDITIONALLY on the very first mount (the theme sync in particular),
 * and with no error boundary anywhere in the app, an uncaught exception
 * there took down the WHOLE React tree before it ever painted anything —
 * a permanently blank page on first load, for a condition that has nothing
 * to do with the app's own correctness.
 *
 * These wrappers are the single choke point for every localStorage access:
 * a failure degrades to "this session doesn't persist" (silent, in-memory
 * behavior keeps working) rather than "the app doesn't render at all".
 * Shared home, one file, so nobody has to remember to wrap a new call site
 * by hand — analogous to `clampGraphemeSafe`'s shared home in this same
 * utils directory for the grapheme-safety class of defect.
 */
export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemoveItem(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

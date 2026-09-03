/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * RED-APP-8/004: belt-and-braces alongside the `safeStorage` wrappers. This
 * app had NO error boundary anywhere (`src/main.tsx` mounted `<App/>`
 * directly) — any single uncaught throw anywhere in the render tree, not
 * only the `localStorage` case that motivated this, blanked the entire page
 * with zero visible content and no way for a visitor to recover short of
 * knowing to hard-refresh. This is the one place in the app that owns "if
 * rendering itself fails, show SOMETHING actionable instead of nothing".
 *
 * `componentDidCatch`/`getDerivedStateFromError` only catch errors thrown
 * during render, lifecycle methods, and constructors of the tree below this
 * boundary (React's documented scope — not event handlers, not async
 * callbacks, not effects that run outside render) — it is a backstop for
 * "the app failed to paint", not a substitute for handling expected
 * failures (network errors, storage failures) at their own call sites the
 * way `safeStorage.ts` does.
 */
export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // Best-effort visibility only — must never itself throw or block render.
    // eslint-disable-next-line no-console
    console.error('Nash Equilibrium Simulator crashed and was caught by the error boundary:', error);
  }

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 p-6">
        <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl p-6 flex flex-col gap-3 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            The app hit an unexpected error and could not continue. Reloading
            usually fixes this.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 self-center"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

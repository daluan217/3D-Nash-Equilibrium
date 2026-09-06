/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ONE saved-games list, rendered by both the sidebar (App.tsx) and the
 * drawer's Library tab (MenuDrawer.tsx) as two call sites with a `variant`
 * prop. Round14 structural pass (BLUE-LIST-14), retiring two duplicated
 * findings: RED-DESKTOP-13/001 (the drawer gated on `user` instead of
 * `canOwnGames` and hid every no-account desktop user's games) and
 * RED-APP-13/003 (the drawer's Delete button had no in-flight
 * disabled/aria-busy state the sidebar's identical control already had).
 * Both were the SAME predicate re-implemented twice and drifting; this file
 * makes the drift structurally unreachable — there is exactly one place
 * that renders a saved-game row, one place that decides the empty-state
 * copy, and one place that gates ownership.
 *
 * `variant` changes classes/layout and how much of a game's detail is shown
 * (the sidebar's compact strip vs. the drawer's full card with a miniature
 * plot and its equilibria) — never the ownership gate, the in-flight Delete
 * state, or which actions (Load/Edit/Delete) are reachable.
 */
import React from 'react';
import { GamePayoffs } from '../types';
import { splitEquilibriaByContinuum, describeContinua, fmtPayoff, EA, EB } from '../utils/gameEngine';
import { savedGameColorTerms } from '../utils/colorTerms';
import { GameGraphMiniature } from './GameGraphMiniature';
import { ColorCoded } from './ColorCoded';
import { Pencil, Trash2, LogIn, CheckCircle2 } from 'lucide-react';

/** A saved game, shaped for display. `raw` is the untouched server record —
 *  `onEdit` hands it straight to App's `openEditGame`, which reads fields
 *  (`row1Label`, `colorTermsA`, ...) this display shape does not carry. */
export interface SavedGameListItem {
  id: string;
  name: string;
  desc: string;
  payoffs: GamePayoffs;
  terms: { a: string[]; b: string[] };
  raw: any;
}

/** The ONE mapping from a raw server game record to display shape. Both
 *  call sites use this — never their own inline `.map`, which is exactly how
 *  the drawer's card and the sidebar's row silently grew different
 *  descriptions/color terms before. */
export function formatSavedGames(games: any[]): SavedGameListItem[] {
  return (games ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    desc: g.description,
    payoffs: g.payoffs as GamePayoffs,
    terms: savedGameColorTerms(g),
    raw: g,
  }));
}

export interface SavedGamesListProps {
  games: SavedGameListItem[];
  /** RED-DESKTOP-13/001: whether THIS session can own saved games — a
   *  signed-in account OR the desktop app's local owner. Never `user`: a
   *  local-owner session has no `user` object at all, yet owns its games. */
  canOwnGames: boolean;
  /** RED-APP-13/003: game ids with a DELETE in flight (App's shared
   *  `deletingGamesRef` guard) — read identically by both variants. */
  deletingGameIds: string[];
  activePreset: string;
  onLoad: (id: string) => void;
  onEdit: (game: any) => void;
  onDelete: (id: string, rowEl: HTMLElement | null) => void;
  onSignIn: () => void;
  isDark: boolean;
  variant: 'sidebar' | 'drawer';
}

const LANDMARK: Record<'sidebar' | 'drawer', string> = {
  sidebar: 'saved-games',
  drawer: 'drawer-games',
};
/** Kept distinct per variant on purpose: e2e sections 45/53/56/60 locate the
 *  Delete button by this exact title, and section 56/45 tell the two rows
 *  apart by it. Alias, never rename. */
const DELETE_TITLE: Record<'sidebar' | 'drawer', string> = {
  sidebar: 'Delete this saved game',
  drawer: 'Delete custom layout',
};

export const SavedGamesList: React.FC<SavedGamesListProps> = ({
  games,
  canOwnGames,
  deletingGameIds,
  activePreset,
  onLoad,
  onEdit,
  onDelete,
  onSignIn,
  isDark,
  variant,
}) => {
  const landmark = LANDMARK[variant];
  const deleteTitle = DELETE_TITLE[variant];

  if (!canOwnGames) {
    return (
      <div
        data-focus-fallback={landmark}
        tabIndex={-1}
        aria-label={variant === 'sidebar' ? 'Saved games' : 'Saved custom games'}
        className={variant === 'sidebar'
          ? 'text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/30 border border-slate-200/60 dark:border-slate-800/80 rounded-xl p-3 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400'
          : 'bg-slate-50 dark:bg-slate-950/20 border border-slate-100 dark:border-slate-800 rounded-2xl p-5 text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400'}
      >
        {/* Copy is PER-VARIANT here on purpose (OPUS-REVIEW-LIST F4, round14
            director review of #150): the sidebar's inline-link tone and the
            drawer's fuller "must sign in" card are existing public-product
            copy, not a decision this refactor gets to make — only the
            landmark/gating MECHANISM is the invariant, never the wording. */}
        {variant === 'sidebar' ? (
          <>
            <span>Want to name and save custom presets? </span>
            <button onClick={onSignIn} className="tap-24 font-bold text-accent-600 dark:text-accent-400 hover:underline cursor-pointer">
              Sign in here
            </button>
          </>
        ) : (
          <div className="space-y-2">
            <p>You must be signed in to view and save custom game profiles.</p>
            <button onClick={onSignIn} className="inline-flex items-center gap-1.5 bg-accent-600 hover:bg-accent-700 text-white px-3 py-1.5 rounded-xl font-bold text-xs cursor-pointer shadow-xs transition-all">
              <LogIn className="w-3 h-3" /> Sign In / Sign Up
            </button>
          </div>
        )}
      </div>
    );
  }

  if (games.length === 0) {
    return (
      <div
        data-focus-fallback={landmark}
        tabIndex={-1}
        aria-label={variant === 'sidebar' ? 'Saved games' : 'Saved custom games'}
        className={variant === 'sidebar'
          ? 'text-xs text-muted dark:text-muted-dark bg-slate-50/70 dark:bg-slate-950/20 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl p-4 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400'
          : 'bg-slate-50 dark:bg-slate-950/20 border border-slate-100 dark:border-slate-800 rounded-2xl p-5 text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400'}
      >
        {variant === 'sidebar' ? (
          <>No saved custom games. Adapt payoffs and click <strong className="text-accent-600 dark:text-accent-400">Save Preset</strong> to persist your first game!</>
        ) : (
          <p>
            {/* CodeRabbit on #150: "Save payoffs" named no real control —
                the actual button is "Save Preset". Fixed independent of the
                per-variant copy revert above; this was a real accuracy bug. */}
            No saved custom game presets. Customize payoffs in the main board and click{' '}
            <strong className="text-accent-600 dark:text-accent-400">Save Preset</strong> to record your own scenarios!
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      data-focus-fallback={landmark}
      tabIndex={-1}
      aria-label={variant === 'sidebar' ? 'Saved games' : 'Saved custom games'}
      className={variant === 'sidebar'
        ? 'grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[160px] overflow-y-auto pr-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 rounded-xl'
        : 'grid grid-cols-1 gap-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 rounded-xl'}
    >
      {games.map((game) => {
        const isSelected = activePreset === game.id;
        const isDeleting = deletingGameIds.includes(game.id);

        if (variant === 'sidebar') {
          return (
            <div
              key={game.id}
              data-saved-game
              className={`group flex items-center justify-between p-2 pl-3 rounded-xl border transition-all ${isSelected
                  ? 'bg-accent-500 border-accent-500 text-white shadow-xs'
                  : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:bg-slate-100/80 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
                }`}
            >
              <button
                onClick={() => onLoad(game.id)}
                className="flex-1 text-left text-xs font-semibold truncate cursor-pointer mr-1"
                title={`${game.name} - ${game.desc}`}
              >
                {game.name}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(game.raw); }}
                className={`p-1 rounded-md transition-colors cursor-pointer ${isSelected
                    ? 'text-accent-100 hover:text-white hover:bg-accent-600'
                    : 'text-slate-400 hover:text-accent-600 dark:text-slate-500 dark:hover:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-950/40'
                  }`}
                title="Edit name, description and option names"
                aria-label={`Edit ${game.name}`}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(game.id, (e.currentTarget as HTMLElement).closest('.group') as HTMLElement | null); }}
                disabled={isDeleting}
                aria-busy={isDeleting || undefined}
                className={`p-1 rounded-md transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait ${isSelected
                    ? 'text-accent-100 hover:text-white hover:bg-accent-600'
                    : 'text-slate-400 hover:text-danger-500 dark:text-slate-500 dark:hover:text-danger-400 hover:bg-danger-50 dark:hover:bg-danger-950/40'
                  }`}
                title={deleteTitle}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        }

        // 'drawer': the rich card — miniature, description, this game's own
        // equilibria (continuum-aware: RED-MATH-6/001, -7/001, -9/002).
        const eqList = splitEquilibriaByContinuum(game.payoffs).stray;
        const continua = describeContinua(game.payoffs);
        return (
          <div
            data-saved-game
            data-drawer-game
            key={game.id}
            className={`border rounded-2xl p-4 flex flex-col sm:flex-row gap-4 transition-all duration-200 ${isSelected
                ? 'bg-accent-50/15 dark:bg-accent-950/10 border-accent-400 dark:border-accent-800 shadow-md ring-1 ring-accent-400/20'
                : 'bg-white dark:bg-slate-950/30 border-slate-100 dark:border-slate-800/80 hover:border-slate-200 dark:hover:border-slate-700 shadow-sm'
              }`}
          >
            <div className="flex justify-center items-center">
              <GameGraphMiniature payoffs={game.payoffs} isDark={isDark} />
            </div>
            <div className="flex-1 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-slate-800 dark:text-slate-100 text-xs sm:text-sm truncate max-w-[180px]">
                    {game.name}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {isSelected && (
                      <span className="text-xs font-bold px-1.5 py-0.5 rounded-full bg-accent-50 dark:bg-accent-950/60 text-accent-600 dark:text-accent-400 border border-accent-200 dark:border-accent-900">
                        Active
                      </span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); onEdit(game.raw); }}
                      className="p-1 px-1.5 hover:bg-accent-50 dark:hover:bg-accent-950/40 text-slate-400 hover:text-accent-600 dark:hover:text-accent-400 rounded-lg transition-colors cursor-pointer"
                      title="Edit name, description and option names"
                      aria-label={`Edit ${game.name}`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => onDelete(game.id, (e.currentTarget as HTMLElement).closest('[data-drawer-game]') as HTMLElement | null)}
                      disabled={isDeleting}
                      aria-busy={isDeleting || undefined}
                      className="p-1 px-1.5 hover:bg-rose-50 dark:hover:bg-rose-950/25 text-slate-400 hover:text-rose-500 rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                      title={deleteTitle}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-2.5 leading-relaxed break-words">
                  <ColorCoded text={game.desc} aTerms={game.terms.a} bTerms={game.terms.b} />
                </p>
                <div className="bg-slate-50 dark:bg-slate-950/50 rounded-xl p-2.5 border border-slate-100 dark:border-slate-800/85">
                  <div className="text-xs font-bold text-slate-400 dark:text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    Computed Nash Equilibria:
                  </div>
                  <ul className="text-xs text-slate-600 dark:text-slate-300 pl-4 list-disc space-y-0.5">
                    {eqList.map((eq, i) => (
                      <li key={i}>
                        <strong className={eq.type === 'mixed' ? 'text-ne-mixed-600 dark:text-ne-mixed-400 font-bold' : 'text-slate-700 dark:text-slate-200'}>
                          <ColorCoded text={eq.label} />
                        </strong>{' '}
                        val (<ColorCoded text={`E[A]=${fmtPayoff(EA(eq.x, eq.y, game.payoffs))}, E[B]=${fmtPayoff(EB(eq.x, eq.y, game.payoffs))}`} />)
                      </li>
                    ))}
                    {continua.map((line, i) => (
                      <li key={`cont-${i}`} className="text-ne-mixed-600 dark:text-ne-mixed-400">
                        <ColorCoded text={line} />
                      </li>
                    ))}
                    {eqList.length === 0 && continua.length === 0 && (
                      <li className="text-red-500">No classic NE in real plane</li>
                    )}
                  </ul>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => onLoad(game.id)}
                  disabled={isSelected}
                  className={`w-full sm:w-auto px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${isSelected
                      ? 'bg-slate-100 dark:bg-slate-800 text-muted dark:text-muted-dark border border-transparent cursor-not-allowed'
                      : 'bg-accent-600 hover:bg-accent-700 text-white shadow-xs'
                    }`}
                >
                  {isSelected ? 'Currently Loaded' : 'Load Game Layout'}
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

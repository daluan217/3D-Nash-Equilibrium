# SavedGamesList

One component (`src/components/SavedGamesList.tsx`) for the saved-custom-game
list, rendered by both the sidebar (App.tsx) and the workspace drawer's
Library tab (MenuDrawer.tsx). Round14 structural pass (BLUE-LIST-14),
replacing two hand-rolled, drifting copies of the same list.

## What it guarantees

- **Ownership gating on `canOwnGames`, never `user`.** A signed-in account
  OR the desktop app's local owner (no account) — the identical predicate on
  both surfaces, threaded as a prop. It never receives a `user` prop at all,
  so a `user`-keyed gate is not just wrong, it is a type error.
- **The row markup**: `[data-saved-game]` on every row (plus the pre-existing
  `div.group` on the sidebar and `[data-drawer-game]` on the drawer — kept as
  aliases, never renamed, because e2e sections 45/53/56/60 locate rows by
  them), the Load/Edit/Delete actions, and the in-flight Delete state
  (`disabled` + `aria-busy`, from one shared `deletingGameIds` array — not a
  per-surface copy).
- **The focus landmark** (`data-focus-fallback`, `saved-games` for the
  sidebar and `drawer-games` for the drawer), kept MOUNTED in every state
  (not-owner, owner-with-zero-games, populated) so focus restoration always
  finds a fallback inside the surface that is open.
- **The empty-state copy is byte-identical between variants** for a given
  ownership state — the sidebar's own previous wording ("Want to name and
  save custom presets?", "No saved custom games...") is retired in favor of
  the drawer's, which e2e section 45 already locks in place ("No saved
  custom game presets", "You must be signed in to view and save custom game
  profiles").
- **`variant: 'sidebar' | 'drawer'` changes classes/layout and how much
  detail a row shows** (the sidebar's compact strip vs. the drawer's rich
  card with a miniature plot, description and this game's own equilibria,
  continuum-aware: RED-MATH-6/001, -7/001, -9/002) — never the ownership
  gate, the in-flight Delete state, the landmark, or which actions are
  reachable. The drawer's row gained an Edit action to match the sidebar's.
- **`formatSavedGames`**, the ONE mapping from a raw server game record to
  display shape (id/name/desc/payoffs/terms, plus the untouched `raw` record
  for `onEdit`), exported and used by both call sites — never their own
  inline `.map`.

## What it fixes (round13, closed as a class, not two patches)

- **RED-DESKTOP-13/001**: the drawer's Library tab gated its list, lock hint
  and empty-state copy on `user` (a real signed-in account), so a no-account
  desktop local owner saw a correct game count next to "you must be signed
  in to view" and zero rendered cards — while the sidebar, gated correctly,
  showed every game. (This instance had already been patched on `main` before
  this round — see `493f6b8` — but the FIX lived only in MenuDrawer.tsx's own
  copy of the gate, leaving the duplication that produced the finding intact.)
- **RED-APP-13/003**: the drawer's Delete button carried no `disabled`/
  `aria-busy` while a delete was in flight, unlike the sidebar's identical
  control on identical data (same handler, same `deletingGameIds`). Both are
  now structurally the same code path — there is only one Delete button
  implementation, used by both variants.

## Evidence

- `src/savedgameslist.test.ts`: structural (`App.tsx`/`MenuDrawer.tsx` contain
  no inline saved-game row markup — the "Delete this saved game" / "Delete
  custom layout" title literals exist ONLY in this file; both call sites
  render `<SavedGamesList>` and call the shared `formatSavedGames()`) plus a
  behavioural SSR test: for the same props, both variants render the same row
  count, the same landmark mechanism, the same disabled/aria-busy state, and
  byte-identical empty-state copy for `canOwnGames` true/false. Three
  mutations verified by hand (reverting the drawer's `canOwnGames` gate to
  `!!user`; dropping the drawer row's `disabled`/`aria-busy`; reintroducing an
  inline `title="Delete this saved game"` in App.tsx) each fail the check
  naming them.
- `src/localowner.test.ts` and `src/a11yfixes.test.ts`: updated to check
  `SavedGamesList.tsx` (and the call sites' props) instead of MenuDrawer's old
  inline markup.
- `src/e2e/smoke.mjs` section 68 (shard 7): with a real desktop local-owner
  server AND a signed-in-account session (the two ownership paths), the
  sidebar and drawer agree on names and count; a DELETE started from the
  sidebar and left in flight is shown disabled/aria-busy on the DRAWER's row
  for the same game when the drawer is opened mid-request (proof the guard is
  one shared array, not two); after the last delete, both surfaces show the
  identical empty-state landmark and copy. Mutation-verified: dropping the
  drawer row's in-flight state fails the cross-surface disabled check; the
  `canOwnGames`→`user` regression fails three checks in the existing section
  45.

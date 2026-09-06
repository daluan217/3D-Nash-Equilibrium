# ModalSurface

One primitive (`src/components/ModalSurface.tsx`) for **every** overlay that
must behave like a modal dialog: Account, Save custom game, Edit saved
game, Send feedback, the workspace drawer, the local-games offer, and the
expanded simulation-log dialog. Round14 (BLUE-MODAL-14) converted the first
five; round15 (BLUE-MODAL-15) converted the last two, so there is no longer
a caller that hand-rolls `role="dialog"` anywhere in the app.

## What it guarantees

- `role="dialog" aria-modal="true" aria-label`, backdrop click-to-close
  (only when the pointer went DOWN on the backdrop itself — RED-APP-14/007),
  Escape-to-close, a Tab trap (`useModalTabTrap`), open-time focus (first
  focusable, or whatever the dialog's own `autoFocus` already claimed),
  and focus-return to the opener on close (`focusAfterDialog`).
- A `[data-modal-surface]` marker and a shared z-index token per layout:
  the centered dialogs default to `OVERLAY_CLASS` (z-[65], above the guided
  tour — see the RED-APP-5/003 history in `src/a11yfixes.test.ts`) but may
  override it (the expand-log overlay keeps its own backdrop-blur/padding
  via `overlayClassName`, still z-[65]); the drawer keeps its own, lower
  `DRAWER_OVERLAY_CLASS` (z-50, its pre-existing layer — it was never part
  of that finding).
- **`ModalRegistry`**: a module-level stack of every currently-open
  surface. Opening a second, non-stacking surface while one is already
  open is refused (`allowsStack` is the one declared exception, reserved
  for the guided tour — no current caller sets it). This makes "two
  dialogs open at once" structurally unreachable instead of a per-caller
  check: the second `<ModalSurface>` simply never registers, so it never
  renders. A surface refused at open time is not stuck forever: `subscribe`
  lets it retry the instant the stack changes, so a caller that opens two
  surfaces from the same event (round15, RED-APP-14/004) gets "the first
  shows now, the second opens the moment the first closes" — sequenced,
  never stacked — with no coordination of its own.
- A focused control that becomes `disabled` while it holds focus (a
  submit button mid-request) is blurred to `<body>` by the browser with
  no keydown involved. `useModalTabTrap` recaptures focus back into its
  own container when this happens while the dialog is still open, rather
  than leaving it stranded. If EVERY control is disabled (round15,
  RED-APP-14/002), the trap does not give up: Tab/Shift+Tab are swallowed
  and focus parks on the panel itself (`tabIndex={-1}`), and a
  `MutationObserver` hands focus back to the first control the instant one
  re-enables.
- Opener tracking (`pointerdown`/`keydown` as the source of record,
  `focusin` only confirming the same control) survives WebKit's habit of
  focusing the nearest mouse-focusable ANCESTOR instead of a clicked button
  (round15, RED-APP-14/005) — `focusin` is filtered to real controls so it
  can never overwrite a correct value with a `tabIndex={-1}` landmark.

## What it fixes (RED-APP-13, round13)

- **002**: a global `[user]`-keyed focus effect (App.tsx, meant only for
  the header's Sign-In↔Log-out swap) fired on every `user` change with no
  guard for "some other dialog is open" — a 401 inside Save/Edit cleared
  the token while the dialog stayed open, and the effect threw focus at a
  header control hidden under the still-open dialog's backdrop; Enter
  there opened a second (Account) dialog on top. Fixed two ways: the
  effect now no-ops while `ModalRegistry.isAnyOpen()`, and the disabled-
  blur recapture above independently keeps focus inside the dialog in
  this exact reproduction.
- **003**: the drawer's Delete button had no in-flight `disabled`/
  `aria-busy` state, unlike the sidebar's identical control on identical
  data. Fixed by threading `deletingGameIds` into `MenuDrawerProps`.
- **004**: the drawer was a full-screen overlay with no `role="dialog"`,
  no `aria-modal`, and no Tab trap — Tab could walk onto the page's
  floating Feedback button and Enter there opened Feedback on top of the
  still-open drawer. Fixed by rendering the drawer through
  `<ModalSurface layout="drawer">`, the same primitive as the four
  dialogs (visual chrome — a slide-in panel vs. a centered card — is the
  only thing that differs by `layout`).

## What it fixes (RED-APP-14, round15 — BLUE-MODAL-15)

- **002**: `getModalFocusables()` returning `[]` (every control disabled
  mid-request) disabled BOTH halves of the trap — no recapture on the
  disabled-blur, and the next Tab escaped to the page behind the backdrop,
  where Enter opened a second dialog. The one surface this reached
  (`localGamesOffer`, excluded from `ModalRegistry` at the time) is now
  IN the registry, and the trap itself no longer has an "everything
  disabled" escape hatch at all — it parks focus on the panel and swallows
  Tab/Shift+Tab, on every surface, not just this one.
- **003**: `MenuDrawer.tsx`'s two Danger Zone requests
  (`delete-request`/`delete-confirm`) were the one authenticated call in
  the app that did not clear the token on a 401 — the header, the account
  panel and the saved-games list all kept claiming a live session the
  server had already rejected. Fixed with one `clearTokenIfExpired(res)`
  helper, backed by a new `updateAuthToken` prop threaded from App.tsx (the
  same setter Save/Edit/Delete already call), used by both call sites.
- **004**: the local-games offer and a resumed Save/Edit dialog could both
  be triggered by the SAME sign-in — with the offer outside the registry,
  both mounted, and their two independently-mounted Tab traps fought over
  focus (Escape was the only key that responded, and it meant "leave the
  games on this device," answering the offer with the one key the user
  pressed to escape a stuck UI). Fixed by bringing the offer into the
  registry AND adding a retry-on-stack-change mechanism (`subscribe`, see
  above) so the loser of the race opens itself once the winner closes,
  with no caller-side sequencing.
- **005**: WebKit does not focus a clicked `<button>` — it focuses the
  nearest mouse-focusable ancestor, which for any control inside
  `SavedGamesList`'s `[data-focus-fallback]` landmark (kept mounted at
  `tabIndex={-1}`) is that landmark, not the button. The `focusin` this
  produced fired AFTER `pointerdown` and clobbered the correct opener.
  Fixed by filtering `focusin` to real controls (never a bare
  `tabIndex={-1}` match) and adding a `keydown` tracker alongside
  `pointerdown`, so WebKit and Chromium now agree.
- **CodeRabbit CLI (self-inflicted by the FIX-BEFORE-MERGE 2 fix above)**:
  `mountLogRegion`'s own `el.focus()` on the log region — a REAL control
  (`tabIndex={0}`), not a `tabIndex={-1}` landmark — fires a real `focusin`
  in the SAME commit that mounts it, before `useModalTabTrap`'s effect ever
  reads `lastInteractedControl`. That overwrites the correctly-recorded
  opener (the "Expand log" button, from its own `pointerdown` moments
  earlier) with the log region itself, which the trap's container already
  contains — `opener` then resolves to `null` and Escape returned focus to
  `[data-focus-home]` instead of the button. Fixed with an explicit
  `fallbackSelector` naming the one real opener directly (there is only ever
  one for this dialog, so a fixed selector is exact, not a guess).

## Known gaps (OPUS-REVIEW-MODAL, round15)

- The re-enable `MutationObserver` (RED-APP-14/002) only watches the `disabled`
  attribute. A future dialog that re-enables a control by remounting it, or via
  `aria-disabled`/`hidden`/`inert`/`display:none` instead of toggling
  `disabled`, would strand focus parked on the panel — every current call site
  toggles `disabled`, so this is a gap, not a defect today.
- In development, `<StrictMode>` (`src/main.tsx`) double-invokes layout
  effects on mount (create → destroy → create). The simulated destroy calls
  `ModalRegistry.close(id)`, which can let a *queued* surface grab the slot in
  that gap before the remounting surface re-registers — dev-only (production
  does not double-invoke), but worth knowing before chasing a "wrong dialog
  opened" report that only reproduces in `npm run dev`.
- OPUS-REVIEW-MODAL2 NOTE 6: the Tab-trap's boundary check (BLOCK 1) only
  treats `activeElement === container` as "at the edge" — a `tabIndex={-1}`
  landmark *inside* the container (today: `SavedGamesList`'s
  `[data-focus-fallback]` wrappers) still reaches `onKey` with no branch
  matching, so the browser's own navigation runs. Safe today only because
  every such wrapper has a real control before it in its dialog (the
  drawer's Close button and its three tabs, `MenuDrawer.tsx`). A future
  dialog whose first content is such a landmark would reopen BLOCK 1's
  shape. The general fix — treat "`activeElement` is not in the focusables
  list" as the edge, not just "is the container" — would close the class,
  but forward Tab from a mid-list landmark should arguably keep going
  forward, so it needs its own design thought; not done here.

## Evidence

- `src/modalsurface.test.ts`: structural checks (every `role="dialog"` /
  fixed-inset overlay in App.tsx and MenuDrawer.tsx renders through
  `<ModalSurface>`, and App.tsx has ZERO hand-rolled `role="dialog"` left;
  the `[user]` effect is guarded; the drawer threads `deletingGameIds`;
  the Tab-trap-never-gives-up and re-enable-recapture shapes; the
  `REAL_CONTROL_SELECTOR` opener-tracking filter; every `Authorization:
  Bearer` fetch in `src/components` runs through `clearTokenIfExpired`)
  plus a functional test of the registry's single-active-modal rule, its
  `allowsStack` exception, and the round15 `subscribe`/retry-on-close
  queueing. Mutations tried by hand (dropping the `[user]` guard, dropping
  the drawer's `disabled` prop, `canOpen()` forced `true`, renaming a
  `ModalSurface` id, reverting the Tab trap's empty-focusables branch to a
  bare `return`, widening `REAL_CONTROL_SELECTOR` back to `[tabindex]`,
  deleting a `clearTokenIfExpired` call site, dropping `notifyStackChanged`,
  dropping the `|| document.activeElement === container` disjunct
  (OPUS-REVIEW-MODAL BLOCK 1), and reverting `mountLogRegion` to focus-only
  (OPUS-REVIEW-MODAL FIX-BEFORE-MERGE 2)) each fail the check they should.
- `src/e2e/smoke.mjs` section 66 (shard 6) / 67 (shard 2): for each of
  Account/Save/Edit/Feedback/the drawer, 60 Tab presses stay inside and
  Escape returns focus to the opener (Feedback's own `autoFocus` races
  opener-tracking — pre-existing, not a RED-APP-13 shape, checked more
  loosely); Save and Edit's own 401-mid-submit reproduction; the drawer's
  role/aria-modal, Tab containment, Escape, and in-flight Delete; Feedback
  unreachable by keyboard while the drawer is open.
- `src/e2e/smoke.mjs` section 70 (round15, shard 8, ~107s internal / ~140s
  wall including server boot): Part A — the local-games offer with every
  control disabled by a route-delayed request: Tab is swallowed, focus stays
  parked, and returns to the first control once a failure re-enables both
  buttons. Part B — the Escape-returns-focus-to-opener check on a saved-game
  row's Edit button, run on BOTH chromium and webkit (guarded by webkit's
  availability), PLUS a dead-space click on the reopened Edit dialog followed
  by both Shift+Tab and forward Tab, staying inside on both engines
  (OPUS-REVIEW-MODAL BLOCK 1). Part C — the expanded log opens scrolled to
  the newest lines under a forced-overflow short viewport (OPUS-REVIEW-MODAL
  FIX-BEFORE-MERGE 2).
- `round13/notes/DIRECTOR/repro-app13.mjs` (round13's independent harness
  for 002/003/004): 6 FAIL on main `bc546d0` → all PASS from round14.
- `round14/notes/DIRECTOR/repro-app14-003.mjs` and `repro-app14-005.mjs`
  (round15's independent harnesses, the latter on playwright webkit): both
  FAIL on main `118818d`/`0f3388f` → PASS on this branch.
- `_gen/repro-modal15-block1.mjs` (OPUS-REVIEW-MODAL's independent harness
  for BLOCK 1): DEFECT on this branch's own `8fbc534` → PASS after the fix.

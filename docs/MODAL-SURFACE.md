# ModalSurface

One primitive (`src/components/ModalSurface.tsx`) for every overlay that
must behave like a modal dialog: Account, Save custom game, Edit saved
game, Send feedback, and the workspace drawer. Round14 structural pass
(BLUE-MODAL-14), replacing four hand-rolled dialogs plus an untrapped
drawer with one implementation.

## What it guarantees

- `role="dialog" aria-modal="true" aria-label`, backdrop click-to-close,
  Escape-to-close, a Tab trap (`useModalTabTrap`), open-time focus (first
  focusable, or whatever the dialog's own `autoFocus` already claimed),
  and focus-return to the opener on close (`focusAfterDialog`).
- A `[data-modal-surface]` marker and one shared z-index token
  (`OVERLAY_CLASS`), so every converted surface paints above the guided
  tour (see the RED-APP-5/003 history in `src/a11yfixes.test.ts`).
- **`ModalRegistry`**: a module-level stack of every currently-open
  surface. Opening a second, non-stacking surface while one is already
  open is refused (`allowsStack` is the one declared exception, reserved
  for the guided tour — no current caller sets it). This makes "two
  dialogs open at once" structurally unreachable instead of a per-caller
  check: the second `<ModalSurface>` simply never registers, so it never
  renders.
- A focused control that becomes `disabled` while it holds focus (a
  submit button mid-request) is blurred to `<body>` by the browser with
  no keydown involved. `useModalTabTrap` recaptures focus back into its
  own container when this happens while the dialog is still open, rather
  than leaving it stranded.

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

## Out of scope this round

`localGamesOffer` (the "games saved on this device" offer) and the
expand-log overlay still call `useModalTabTrap` directly and do not
participate in `ModalRegistry`. Converting them is future work, not a
regression: neither was named in RED-APP-13's findings, and both keep
their pre-existing behavior unchanged.

## Evidence

- `src/modalsurface.test.ts`: structural checks (every converted
  `role="dialog"` renders through `<ModalSurface>`; the `[user]` effect
  is guarded; the drawer threads `deletingGameIds`) plus a functional
  test of the registry's single-active-modal rule and its `allowsStack`
  exception. Four mutations tried by hand (dropping the `[user]` guard,
  dropping the drawer's `disabled` prop, `canOpen()` forced `true`,
  renaming a `ModalSurface` id) each fail the check they should.
- `src/e2e/smoke.mjs` section 66 (shard 12): for each of
  Account/Save/Edit/Feedback, 60 Tab presses stay inside and Escape
  returns focus to the opener (Feedback's own `autoFocus` races opener-
  tracking — pre-existing, not a RED-APP-13 shape, checked more loosely);
  Save and Edit's own 401-mid-submit reproduction, each in its own
  session (a shared session would be signed out globally after the first
  401); the drawer's role/aria-modal, Tab containment, Escape, and
  in-flight Delete; Feedback unreachable by keyboard while the drawer is
  open. Two mutations verified at this level too (dropping the drawer's
  `disabled` prop fails the one check naming it; dropping the `[user]`
  guard alone does NOT fail section 66 — the disabled-blur recapture
  above independently closes this reproduction's window, which is why
  both fixes ship rather than either alone).
- `round13/notes/DIRECTOR/repro-app13.mjs` (the director's independent
  harness for 002/003/004): 6 FAIL on main `bc546d0` → all PASS on this
  branch.

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One shared source of `<label htmlFor>` / control `id` pairs (RED-APP-16/003:
 * 24 of the app's 25 `<label>` elements were unassociated — no `htmlFor`/`id`
 * pair and no wrapping — so most of them relied on the field's `placeholder`
 * as its only accessible name, and one (the Edit dialog's "Game Name" field,
 * which has no placeholder) had NO accessible name at all).
 *
 * `scope` disambiguates identical field names used in more than one dialog
 * (e.g. "Game Name" appears in both the Edit and Save-Preset dialogs) so ids
 * stay unique across the whole document even though only one dialog is
 * normally mounted at a time — `ModalSurface` unmounts its children on
 * close, but a static id must not depend on that holding forever.
 *
 * Also used (as a plain id generator, not paired with `htmlFor`) for
 * `aria-labelledby` on the few headings that caption a GROUP of buttons
 * rather than a single form control ("Who moves first?", "Convergence
 * Method", …) — those were never candidates for `htmlFor` in the first
 * place, so they were converted from `<label>` to a plain heading element
 * instead of forced into an association that does not exist.
 */
export function labelFor(scope: string, field: string): string {
  return `field-${scope}-${field}`;
}

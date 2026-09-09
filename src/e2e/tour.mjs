/**
 * The ONE way to dismiss the guided tour (STRUCT-APP-19/003).
 *
 * Daniel, 2026-09-08: the tour had three controls doing the same thing — Skip,
 * the card's X, and a viewport-anchored "Exit tour" pill. Only the card's X
 * remains, so every suite and harness closes the tour through this helper.
 *
 * Two things this centralises, both measured rather than assumed:
 *
 *  - `untested-controls.json` used to record that suites avoided the card's X
 *    because "step 1's smooth-scroll can leave it off-screen". That is real:
 *    the pill was anchored to the viewport and clickable immediately, while the
 *    X rides the card and needs the scroll to finish. Measured on the fixed
 *    tree, the click lands in 2.2-4.7 s (22/22 at 1280x900, 390x844, 900x300) —
 *    comfortably reliable, but longer than the `timeout: 5000` several call
 *    sites used to pass. One generous timeout here beats 30 different ones.
 *  - `getByRole` matches the accessibility tree, so it cannot hit the offscreen
 *    measuring probe that renders the same card contents (a raw
 *    `[aria-label="Close tour"]` CSS selector matches BOTH and every call site
 *    dies of a strict-mode violation).
 *
 * Returns true if the tour is gone, false if it was never there.
 */
export const closeTour = async (page, { timeout = 20000 } = {}) => {
  const x = page.getByRole('button', { name: /close tour/i });
  if (!(await x.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await x.click({ timeout }).catch(() => {});
  const gone = () => page.waitForFunction(
    () => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
    null, { timeout: 8000 },
  ).then(() => true).catch(() => false);
  if (await gone()) return true;
  // Escape is the tour's other documented dismissal; used only as a fallback so
  // a missed click cannot leave the overlay swallowing the rest of a section.
  await page.keyboard.press('Escape');
  return gone();
};

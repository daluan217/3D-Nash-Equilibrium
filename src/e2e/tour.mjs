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
 * Returns `{ closed, via }` where `via` is 'click' | 'escape' | 'absent'.
 */
export const closeTour = async (page, { timeout = 20000 } = {}) => {
  const x = page.getByRole('button', { name: /close tour/i });
  // OPUS-REVIEW-180 FIX-FIRST 1: `isVisible({ timeout })` is DOCUMENTED AS
  // IGNORED in Playwright 1.61 (types.d.ts: "@deprecated This option is
  // ignored") — it returns immediately. The tour opens on a 700 ms timer from
  // mount (App.tsx), and `goto(..., 'networkidle')` can resolve before that, so
  // the old gate raced the timer and returned "never there" while the tour was
  // still coming. The caller's next line then asserts the tour is absent and
  // records a PASSING precondition — vacuously — before the tour opens on top
  // of the section. `waitFor` actually waits.
  // Director (merge of #180 with main, CI run 34311756205): a flat 3 s was
  // measured on a warm laptop, not on the shipping condition. On the GitHub
  // runner a fresh page can take longer than that to MOUNT, and mobile.mjs's
  // 4x-CPU-throttled arm longer still, so the helper answered "absent" while
  // the tour was still coming and every later click died under its scrim
  // (shards 3/21/18/19 + mobile, all on the merged head). So: wait for React
  // to mount first (bounded by `timeout`), THEN give the 700 ms timer a buffer
  // sized for a throttled runner. A page where the tour never opens pays the
  // buffer once; a page where it does pays nothing extra.
  await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, null, { timeout })
    .catch(() => {});
  const up = await x.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!up) return { closed: false, via: 'absent' };
  const gone = () => page.waitForFunction(
    () => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'),
    null, { timeout: 8000 },
  ).then(() => true).catch(() => false);
  await x.click({ timeout }).catch(() => {});
  // OPUS-REVIEW-180 FIX-FIRST 2: report WHICH path closed it. The Escape
  // fallback keeps sections robust, but it also means every call site passes
  // whether or not the X was actually hit — so nothing in CI could see the
  // class of defect 003 was (the one exit covered or unclickable). §90 asserts
  // `via === 'click'` at the viewports where 003 showed.
  if (await gone()) return { closed: true, via: 'click' };
  await page.keyboard.press('Escape');
  return { closed: await gone(), via: 'escape' };
};

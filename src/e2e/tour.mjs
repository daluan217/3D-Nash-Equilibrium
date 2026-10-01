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
 * `closeTour` is the assertion helper: when a tour is present, it only
 * succeeds when the card's Close button really dismisses it.  A suite that
 * merely needs an unobscured page must say so through
 * `dismissTourForSetup(page, reason)`.  That separate, reason-bearing escape
 * hatch may press Escape after a failed click; it must never stand in for a
 * claim that the Close button works.
 *
 * Both helpers return `{ closed, via }`, where `via` is 'click' | 'escape' |
 * 'absent'.  The strict helper never returns `via: 'escape'`.
 */
const TOUR_DECISION_BOUND_MS = 180000;
const attemptTourClose = async (page, { timeout = 20000, allowEscapeFallback = false } = {}) => {
  const dialog = page.getByRole('dialog', { name: /guided tour/i });
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
  // to mount first (bounded by `timeout`), THEN for the app's tour decision.
  await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, null, { timeout })
    .catch(() => {});
  // TASK-18 H6: never proceed while the tour can still open. A fixed wait for the dialog lost
  // at 32x CPU throttle ("absent" 51 s in; the tour opened just after). App.tsx publishes its
  // decision as data-tour-auto: 'skip' (will not open) or 'shown' (opened, in that commit).
  // A dialog seen before it may be a manual open the auto timer can still re-open over.
  const decision = await page.waitForFunction(() => document.documentElement.dataset.tourAuto || false,
    null, { timeout: TOUR_DECISION_BOUND_MS }).then((handle) => handle.jsonValue()).catch(() => null);
  if (!decision) throw new Error('the app never published its tour decision (no data-tour-auto on <html>)');
  if (!(await dialog.count())) return { closed: false, via: 'absent' };
  // The DIALOG, not its Close control, decides whether the tour is absent. If
  // the dialog is visible but the button is missing/hidden, that is precisely
  // a broken product control: strict callers must fail, while setup callers
  // may take their explicitly documented Escape path.
  const up = await dialog.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!up) return { closed: false, via: 'absent' };
  const gone = () => dialog.waitFor({ state: 'hidden', timeout: 8000 })
    .then(() => true).catch(() => false);
  let clickFailure = null;
  const closeReady = await x.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (closeReady) {
    await x.click({ timeout }).catch((error) => { clickFailure = error; });
    if (!clickFailure && await gone()) return { closed: true, via: 'click' };
  } else {
    clickFailure = new Error('Close tour button was not visible while the guided tour dialog was open');
  }
  // OPUS-REVIEW-180 FIX-FIRST 2: report WHICH path closed it. The Escape
  // Do not silently turn a failed Close-button click into an Escape pass.  The
  // strict public helper reports that failure; only the explicitly named setup
  // helper below is permitted to use Escape so a test can reach the state it
  // is actually about.  It still clears the modal before throwing so a failed
  // assertion cannot leave its browser page hanging under the scrim.
  if (!allowEscapeFallback) {
    await page.keyboard.press('Escape').catch(() => {});
    await gone();
    const detail = clickFailure ? ` (${String(clickFailure.message || clickFailure).slice(0, 160)})` : '';
    throw new Error(`guided tour did not close through its Close button${detail}`);
  }
  await page.keyboard.press('Escape');
  const closed = await gone();
  if (!closed) throw new Error('guided tour remained open after the setup-only Escape fallback');
  return { closed: true, via: 'escape' };
};

/**
 * Assert the product control itself is usable.  A visible tour whose close
 * button is covered, disabled, or otherwise ineffective is a test failure,
 * not an Escape-assisted pass.
 */
export const closeTour = async (page, options = {}) =>
  attemptTourClose(page, { ...options, allowEscapeFallback: false });

/**
 * Clear a possible first-run tour before a test exercises another surface.
 * The required reason makes the weaker assertion visible at the exact call
 * site.  Do not use this helper to test tour behavior.
 */
export const dismissTourForSetup = async (page, reason, options = {}) => {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new TypeError('dismissTourForSetup requires a non-empty setup reason');
  }
  return attemptTourClose(page, { ...options, allowEscapeFallback: true });
};

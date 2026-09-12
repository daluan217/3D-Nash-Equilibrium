/**
 * Wait until an animated panel has held the same bounding rectangle across
 * consecutive animation-frame polls.  A non-zero height alone is not a
 * settled signal: a drawer can be translating while its height is constant.
 *
 * This deliberately stores the sample on the element. Playwright runs the
 * predicate repeatedly in the page, so the state is scoped to this element
 * and this wait rather than to the Node-side test process.
 */
let nextObservation = 0;

export const waitForStableGeometry = async (
  page,
  selector,
  { timeout = 8000, stableFrames = 2, tolerance = 0.5 } = {},
) => {
  // A panel can be observed more than once in a suite.  Keep observations
  // separate so a completed earlier wait cannot make a later wait pass on its
  // first poll from stale element state.
  const observationKey = `__nashStableGeometry${++nextObservation}`;
  return page.waitForFunction(({ selector, stableFrames, tolerance, observationKey }) => {
  const panel = document.querySelector(selector);
  if (!panel) return false;

  const rect = panel.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const current = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const previous = panel[observationKey];
  // The first sample must establish a baseline, never count as settled.  The
  // pre-#195 §92 oracle assigned `__h` and compared that same value in one
  // expression, so it returned true on its first poll.
  if (!previous) {
    panel[observationKey] = { rect: current, frames: 0 };
    return false;
  }

  const changed = ['x', 'y', 'width', 'height'].some((key) =>
    Math.abs(current[key] - previous.rect[key]) > tolerance,
  );
  if (changed) {
    panel[observationKey] = { rect: current, frames: 0 };
    return false;
  }

  const frames = previous.frames + 1;
  panel[observationKey] = { rect: current, frames };
  return frames >= stableFrames;
  }, { selector, stableFrames, tolerance, observationKey }, { timeout });
};

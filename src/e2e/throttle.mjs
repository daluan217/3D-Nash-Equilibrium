// E2E_CPU_THROTTLE=<n>: slow EVERY chromium page n-fold to replay a loaded CI runner locally (off
// unless set; S93's race reproduced at 32). Wrapped where contexts make pages, so no page escapes
// (browser.newPage() makes its context through newContext too): it used to live in newTrackedPage
// only, and every ctx.newPage() page ran at full speed (TASK-18 H16). Guard: throttle.test.mjs.
// The STANDARD local tier: the smallest rate whose section times reach CI's for most sections
// (4x: 8 of 12 at or above the slower of two CI runs; 3x: 3 of 12). SWEEPS.md sweep 8 has the table.
// A retry here or on CI is a hit. STRESS_CPU_THROTTLE runs slower than CI (11x: 1.7-4.5x CI time),
// so a retry there is logged and becomes a hit only if it reproduces at 4x or on CI.
export const STANDARD_CPU_THROTTLE = 4;
export const STRESS_CPU_THROTTLE = 11;
export function throttleEveryPage(browser, rate = Number(process.env.E2E_CPU_THROTTLE || 0)) {
  if (rate <= 1) return browser;
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const ctx = await newContext(...args);
    const newPage = ctx.newPage.bind(ctx);
    ctx.newPage = async (...a) => {
      const page = await newPage(...a);
      await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate });
      return page;
    };
    return ctx;
  };
  return browser;
}

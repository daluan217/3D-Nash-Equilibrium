// E2E_CPU_THROTTLE=<n>: slow EVERY chromium page n-fold to replay a loaded CI runner locally (off
// unless set; S93's race reproduced at 32). Wrapped where contexts make pages, so no page escapes
// (browser.newPage() makes its context through newContext too): it used to live in newTrackedPage
// only, and every ctx.newPage() page ran at full speed (TASK-18 H16). Guard: throttle.test.mjs.
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

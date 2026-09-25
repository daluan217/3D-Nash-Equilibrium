// TASK-18 H19: the tour's step-1 scroll must be IDEMPOTENT. The scroll effect re-runs when the target
// rect and card height are measured, often while its own smooth scroll is still moving. As a relative
// scrollBy, WebKit stacked the re-run onto the pending scroll (y=996, target off-screen, card clamped
// to the top); a repeated smooth scrollTo cancelled it instead (y=0). Checked in chromium AND webkit,
// at normal frames and 550 ms frames (a slow device), plus a mid-scroll layout shift (re-target):
// the page settles with the target inside the strip below the header and the card beside it.
// MUTANTS (each fails here): restore `scrollBy({ top: delta, behavior })`; drop the tourScrollIsRepeat skip.
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { waitForOwnServer } from '../integration/ownserver.mjs';

const PORT = Number(process.env.TOUR_SCROLL_PORT || 4746);
const base = `http://localhost:${PORT}`;
const server = spawn('node', ['dist/server.cjs'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) }, stdio: 'ignore' });

// The shipping condition's slow device: every frame costs `ms` of main-thread time.
const hog = (ms) => { (function f() { const t = performance.now(); while (performance.now() - t < ms) {} requestAnimationFrame(f); })(); };
// Counts the tour's programmatic scrolls; optionally moves the target down 51px (the measured onEnter
// shift) 100 ms after the first one, so the effect must re-target while that scroll is still moving.
const instrument = (shift) => {
  window.__tourScrolls = 0;
  for (const name of ['scrollTo', 'scrollBy']) {
    const f = window[name];
    window[name] = function (...a) {
      if (++window.__tourScrolls === 1 && shift) setTimeout(() => {
        const s = document.createElement('div'); s.style.height = '51px';
        document.querySelector('[data-tour="matrix"]').closest('main > div > div').before(s);
      }, 100);
      return f.apply(this, a);
    };
  }
};
// Settled = scroll offset, target and card unchanged for 10 consecutive frames AND 500 ms (either alone
// is fooled by long frames or by a quick run of identical frames). Bounded by a timer, not rAF.
const settled = (page) => page.evaluate(() => new Promise((resolve) => {
  let prev = null; let frames = 0; let since = 0;
  const done = setTimeout(() => resolve(null), 60000);
  const read = () => {
    const t = document.querySelector('[data-tour="matrix"]').getBoundingClientRect();
    const c = document.querySelector('[role="dialog"][aria-label="Guided tour"] button[aria-label="Close tour"]')?.closest('div[style]');
    const r = c?.getBoundingClientRect();
    const h = document.querySelector('header').getBoundingClientRect();
    return { y: scrollY, vh: innerHeight, header: h.bottom, t: [t.top, t.bottom, t.left, t.right], c: r && [r.top, r.bottom, r.left, r.right] };
  };
  const tick = () => {
    const now = performance.now(); const cur = read(); const key = JSON.stringify(cur);
    if (prev === key) { frames++; } else { frames = 0; since = now; prev = key; }
    if (frames >= 10 && now - since >= 500) { clearTimeout(done); resolve({ ...cur, calls: window.__tourScrolls }); } else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

const failures = [];
const check = (ok, name) => { if (!ok) { failures.push(name); console.error(`  ✗ ${name}`); } };
const cases = [['normal frames', 0, false], ['550 ms frames', 550, false], ['mid-scroll re-target', 0, true]];
try {
  await waitForOwnServer(server, base);
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    try {
      for (const [label, hogMs, shift] of cases) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        await page.addInitScript(instrument, shift);
        if (hogMs) await page.addInitScript(hog, hogMs);
        await page.goto(base, { waitUntil: 'networkidle' });
        await page.getByRole('dialog', { name: /guided tour/i }).waitFor({ state: 'visible', timeout: 180000 });
        const s = await settled(page);
        await ctx.close();
        const tag = `[${engineName} ${label}]`;
        check(s && s.c, `${tag} the tour settles with its card on screen (${JSON.stringify(s)})`);
        if (!s || !s.c) continue;
        const [tTop, tBottom, , tRight] = s.t; const [cTop, cBottom, cLeft] = s.c;
        check(tTop >= s.header - 1 && tBottom <= s.vh + 1,
          `${tag} the step-1 target is inside the usable strip below the header (target ${tTop}..${tBottom}, strip ${s.header}..${s.vh}, scrollY ${s.y})`);
        check(cLeft >= tRight && cTop < tBottom && cBottom > tTop,
          `${tag} the card sits beside the target (card ${cTop}..${cBottom} x>=${cLeft}, target ${tTop}..${tBottom} x<=${tRight})`);
        check(s.calls <= (shift ? 2 : 1),
          `${tag} the tour issues one scroll per placement (${s.calls} calls; a re-run for the same target must not scroll again)`);
        console.log(`  · ${tag} scrollY ${s.y}, target ${Math.round(tTop)}..${Math.round(tBottom)}, card top ${Math.round(cTop)}, ${s.calls} scroll call(s)`);
      }
    } finally { await browser.close(); }
  }
  if (failures.length) { console.error(`✗ tour scroll: ${failures.length} check(s) failed`); process.exitCode = 1; }
  else console.log('✓ tour scroll: idempotent in chromium and webkit at normal and 550 ms frames, and re-targets on a mid-scroll shift');
} finally { server.kill(); }

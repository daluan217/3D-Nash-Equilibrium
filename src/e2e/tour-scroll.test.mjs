// TASK-18 H19/H20: the tour's step-1 scroll is IDEMPOTENT. The effect re-runs mid-scroll when rect/cardH are
// measured; WebKit stacked a relative scrollBy (y=996) and cancelled a repeated smooth scrollIntoView (y=0).
// Chromium + webkit, normal and 550 ms frames, every branch: landscape strip (+ mid-scroll re-target), portrait
// scrollIntoView (1024x1366), bottom sheet (390x844) and a sheet shorter than the target (320x568). Asserts are
// model-derived (target in the usable strip, card clear of it); no scroll call may repeat the previous target.
// MUTANTS: the pre-H19 effect fails 22 checks; dropping the strip skip 18; dropping the scrollIntoView skip 5.
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { waitForOwnServer } from '../integration/ownserver.mjs';

const PORT = Number(process.env.TOUR_SCROLL_PORT || 4746);
const base = `http://localhost:${PORT}`;
const server = spawn('node', ['dist/server.cjs'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) }, stdio: 'ignore' });

// The shipping condition's slow device: every frame costs `ms` of main-thread time.
const hog = (ms) => { window.__hogMs = ms; (function f() { const t = performance.now(); while (performance.now() - t < ms) {} requestAnimationFrame(f); })(); };
// Counts the tour's programmatic scrolls; optionally moves the target down 51px (the measured onEnter
// shift) 100 ms after the first one, so the effect must re-target while that scroll is still moving.
const instrument = (shift) => {
  window.__tourScrolls = 0; window.__tourTargets = [];
  const record = (target) => {
    window.__tourTargets.push(Math.max(0, Math.round(target)));
    if (++window.__tourScrolls === 1 && shift) setTimeout(() => {
      const s = document.createElement('div'); s.style.height = '51px';
      document.querySelector('[data-tour="matrix"]').closest('main > div > div').before(s);
    }, 100);
  };
  const by = { scrollTo: (a) => a[0].top, scrollBy: (a) => scrollY + a[0].top };
  for (const name of ['scrollTo', 'scrollBy']) {
    const f = window[name];
    window[name] = function (...a) { record(by[name](a)); return f.apply(this, a); };
  }
  const siv = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...a) {
    const r = this.getBoundingClientRect(); record(scrollY + r.top + r.height / 2 - innerHeight / 2);
    return siv.apply(this, a);
  };
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
    if (frames >= 10 && now - since >= 500) { clearTimeout(done); resolve({ ...cur, calls: window.__tourScrolls, targets: window.__tourTargets, hogMs: window.__hogMs ?? 0 }); } else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

const failures = [];
const check = (ok, name) => { if (!ok) { failures.push(name); console.error(`  ✗ ${name}`); } };
const LAND = { width: 1440, height: 900 }, PORTRAIT = { width: 1024, height: 1366 }, SHEET = { width: 390, height: 844 }, SHORT = { width: 320, height: 568 };
const cases = [['normal frames', 0, false, LAND], ['550 ms frames', 550, false, LAND], ['mid-scroll re-target', 0, true, LAND],
  ['portrait normal frames', 0, false, PORTRAIT], ['portrait 550 ms frames', 550, false, PORTRAIT],
  ['sheet normal frames', 0, false, SHEET], ['sheet 550 ms frames', 550, false, SHEET], ['short sheet 550 ms frames', 550, false, SHORT]];
try {
  await waitForOwnServer(server, base);
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    try {
      for (const [label, hogMs, shift, viewport] of cases) {
        const ctx = await browser.newContext({ viewport });
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
        // A throwing init script silently skips every later one in WebKit, which would turn this case into normal frames.
        check(s.hogMs === hogMs, `${tag} the slow-frame hog really ran (${s.hogMs} ms, want ${hogMs})`);
        const [tTop, tBottom, , tRight] = s.t; const [cTop, cBottom, cLeft] = s.c;
        check(tTop >= s.header - 1 && tBottom <= s.vh + 1,
          `${tag} the step-1 target is inside the usable strip below the header (target ${tTop}..${tBottom}, strip ${s.header}..${s.vh}, scrollY ${s.y})`);
        if (viewport === LAND) check(cLeft >= tRight && cTop < tBottom && cBottom > tTop,
          `${tag} the card sits beside the target (card ${cTop}..${cBottom} x>=${cLeft}, target ${tTop}..${tBottom} x<=${tRight})`);
        // Sheet: the strip is header..sheet top. A target that fits sits inside it; a taller one is top-aligned
        // under the header (tourTargetScrollDelta), so the part being described stays visible.
        else if (viewport !== PORTRAIT) check(tBottom - tTop <= cTop - s.header ? cTop >= tBottom - 1 : Math.abs(tTop - s.header) <= 2 && cTop > tTop,
          `${tag} the target sits in the strip above the sheet, or top-aligned under the header when taller (target ${tTop}..${tBottom}, header ${s.header}, sheet top ${cTop}, scrollY ${s.y})`);
        else check((cBottom <= tTop + 1 || cTop >= tBottom - 1) && Math.abs((tTop + tBottom) / 2 - s.vh / 2) <= 2,
          `${tag} the target is centred with the card clear of it (target ${tTop}..${tBottom}, viewport ${s.vh}, card ${cTop}..${cBottom}, scrollY ${s.y})`);
        const repeats = s.targets.filter((t, k) => k > 0 && Math.abs(t - s.targets[k - 1]) < 1).length;
        check(repeats === 0 && s.calls <= (shift ? 2 : viewport === PORTRAIT ? 3 : 1),
          `${tag} the tour issues one scroll per placement (${s.calls} calls to [${s.targets}]; a re-run for the same target must not scroll again)`);
        console.log(`  · ${tag} scrollY ${s.y}, target ${Math.round(tTop)}..${Math.round(tBottom)}, card top ${Math.round(cTop)}, ${s.calls} scroll call(s) to [${s.targets}]`);
      }
    } finally { await browser.close(); }
  }
  if (failures.length) { console.error(`✗ tour scroll: ${failures.length} check(s) failed`); process.exitCode = 1; }
  else console.log('✓ tour scroll: idempotent in chromium and webkit at normal and 550 ms frames, landscape and portrait, and re-targets on a mid-scroll shift');
} finally { server.kill(); }

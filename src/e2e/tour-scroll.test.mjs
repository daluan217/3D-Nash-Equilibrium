// TASK-18 H19-H21: the tour's step-1 scroll is IDEMPOTENT. The effect re-runs mid-scroll when rect/cardH are
// measured; WebKit stacked a relative scrollBy (y=996) and cancelled a repeated smooth scrollIntoView (y=0).
// Chromium + webkit, normal and 550 ms frames: landscape strip (+ mid-scroll re-target), portrait scrollIntoView,
// bottom sheet, and a sheet shorter than the target. Model-derived asserts: target in the usable strip, card clear.
// ONE call per placement (two with the shift, at every layout and frame rate), also after a < 1px re-layout across
// .5 or a whole pixel, and again on a reopen after a scroll-away. MUTANTS (each fails by name): pre-H19 effect,
// either skip dropped, a round/floor/trunc/|0 key (H21: 522.30 -> 522.52).
import { spawn } from 'node:child_process';
import { loadavg } from 'node:os';
import { chromium, webkit } from 'playwright';
import { waitForOwnServer } from '../integration/ownserver.mjs';
import { SCROLL_CASES as cases, SCROLL_VIEWPORTS, tourShards } from './tour-cases.mjs';

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
    window.__tourTargets.push(Math.max(0, target));
    if (++window.__tourScrolls > 1) return;
    const el = document.querySelector('[data-tour="matrix"]');
    // The model's unquantised key (Walkthrough's centring target) at the moment the first scroll was issued.
    window.__modelKey = () => { const r = el.getBoundingClientRect(), hd = document.querySelector('header').getBoundingClientRect().bottom;
      return scrollY + r.top + r.height / 2 - (innerWidth > innerHeight ? hd + Math.max(120, innerHeight - 16 - hd) / 2 : innerHeight / 2); };
    window.__key0 = window.__modelKey();
    if (shift === true) setTimeout(() => {
      const s = document.createElement('div'); s.style.height = '51px'; el.closest('main > div > div').before(s);
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
const { LAND, PORTRAIT } = SCROLL_VIEWPORTS;
const [SHARD, SHARDS] = (process.env.TOUR_SCROLL_SHARD || '1/1').split('/').map(Number); // CI: test.yml's e2e_tour_scroll matrix (its want counts each shard's share)
const ONLY = new RegExp(process.env.TOUR_SCROLL_ONLY || '.'); // local mutant runs; CI runs every case
try {
  await waitForOwnServer(server, base);
  let ran = 0;
  const mine = new Set(tourShards('scroll', SHARDS)[SHARD - 1]);
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    try {
      for (const [label, hogMs, shift, viewport] of cases) {
        if (!mine.has(`[${engineName} ${label}]`) || !ONLY.test(`[${engineName} ${label}]`)) continue; ran++;
        const t0 = Date.now(), load = loadavg()[0].toFixed(1);
        const ctx = await browser.newContext({ viewport });
        const page = await ctx.newPage();
        await page.addInitScript(instrument, shift);
        if (hogMs) await page.addInitScript(hog, hogMs);
        await page.goto(base, { waitUntil: 'networkidle' });
        await page.getByRole('dialog', { name: /guided tour/i }).waitFor({ state: 'visible', timeout: 180000 });
        let s = await settled(page);
        const tag = `[${engineName} ${label}]`;
        let n0 = 0; // calls before this placement: a reopen is a second placement, scrolled away first
        if (shift === 'reopen' && s) {
          await page.getByRole('button', { name: 'Close tour' }).click();
          await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
          await page.waitForTimeout(300);
          n0 = await page.evaluate(() => window.__tourScrolls);
          await page.getByRole('button', { name: /take the tour/i }).first().click();
          await page.getByRole('dialog', { name: /guided tour/i }).waitFor({ state: 'visible', timeout: 60000 });
          s = await settled(page);
          check(n0 === 1, `${tag} fixture: the first open placed the tour with one scroll before the reopen (${n0})`);
        } else if (typeof shift === 'string' && s) {
          // H21: re-lay the target out by < 1px so the issued key crosses a boundary a quantised key would see:
          // .5 (Math.round), or a whole pixel up or down (floor/trunc/|0). The move is measured after layout.
          const mv = await page.evaluate(async (kind) => {
            const key0 = window.__key0, f = key0 - Math.floor(key0), base = Math.floor(key0);
            const want = kind === 'half' ? base + (f < 0.5 ? 0.55 : 0.45) : kind === 'up' ? base + 1 + Math.min(0.05, f / 2) : base - Math.min(0.05, (1 - f) / 2);
            document.querySelector('[data-tour="matrix"]').closest('main > div > div').style.marginTop = `${want - window.__modelKey()}px`;
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            return { key0, issued: window.__tourTargets[0], k1: window.__modelKey() };
          }, shift);
          const cross = shift === 'half' ? Math.round(mv.k1) !== Math.round(mv.key0)
            : Math.floor(mv.k1) !== Math.floor(mv.key0) && (shift === 'up') === (mv.k1 > mv.key0);
          check(Math.abs(mv.k1 - mv.key0) < 1 && cross && Math.abs(mv.issued - mv.key0) < 1,
            `${tag} fixture: the re-layout moved the key by < 1px across the boundary (model ${mv.key0} -> ${mv.k1}, issued ${mv.issued})`);
          s = await settled(page);
        }
        await ctx.close();
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
        const mine = s.targets.slice(n0), repeats = mine.filter((t, k) => k > 0 && Math.abs(t - mine[k - 1]) < 1).length;
        check(repeats === 0 && mine.length <= (shift === true ? 2 : 1),
          `${tag} the tour issues one scroll per placement (${mine.length} calls to [${mine.map((t) => t.toFixed(2))}]; a re-run for the same target must not scroll again)`);
        console.log(`  · ${tag} scrollY ${s.y}, target ${Math.round(tTop)}..${Math.round(tBottom)}, card top ${Math.round(cTop)}, ${s.calls} scroll call(s) to [${s.targets.map(Math.round)}], ${Math.round((Date.now() - t0) / 1000)} s, load ${load} at start`);
      }
    } finally { await browser.close(); }
  }
  if (failures.length) { console.error(`✗ tour scroll: ${failures.length} check(s) failed`); process.exitCode = 1; }
  else console.log(`✓ tour scroll: shard ${SHARD}/${SHARDS}, ${ran} cases: idempotent in chromium and webkit at normal and 550 ms frames, every layout, re-targets on a mid-scroll shift and re-places on a reopen`);
} finally { server.kill(); }

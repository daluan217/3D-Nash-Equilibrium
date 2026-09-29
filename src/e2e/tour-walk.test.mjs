// TASK-18 H22: the whole tour, not only step 1. Every context runs with scrollend REMOVED (Safari < 26.2 has none).
// WALK: all 19 steps at the three layout families, the page scrolled away before each Next (by key, by click) or
// left alone (IN VIEW: a same-target step must not move the page). FLIGHT: a second Next 300 ms into a flight.
// INTERRUPT: the visitor's PageDown stops a flight short, then Next to a same-target step must still land. LONG FRAME:
// one 1.5 s frame after the tour's call. SLOW: 550 ms frames. HELD START: the scroll starts 2 frames late. Mutants
// (old deps, top-only key, nostall, or, nostop, noinput; kill table in PR #211) each fail by name.
import { spawn } from 'node:child_process';
import { loadavg } from 'node:os';
import { chromium, webkit } from 'playwright';
import { waitForOwnServer } from '../integration/ownserver.mjs';
import { throttleEveryPage } from './throttle.mjs';

const PORT = Number(process.env.TOUR_WALK_PORT || 4749);
const base = `http://localhost:${PORT}`;
const server = spawn('node', ['dist/server.cjs'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) }, stdio: 'ignore' });
const TARGETS = ['matrix', 'plot', 'ep', 'plot', 'plot', 'plot', 'matrix', 'plot', 'plot', 'plot', 'method', 'coords', 'plot', 'plot', 'plot', 'plot', 'ne', 'ne', 'matrix'];

// One init script (a throwing one silently skips later ones in WebKit): no scrollend, the tour's scroll calls, the hog.
const init = (hogMs) => {
  for (const o of [window, Window.prototype, Document.prototype, Element.prototype, HTMLElement.prototype]) delete o.onscrollend;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (t, ...a) { return t === 'scrollend' ? undefined : add.call(this, t, ...a); };
  window.__calls = [];
  // __longFrame [[frame, ms], ...]: once, block the main thread in the tour's call (frame 0) and/or in the k-th frame
  // after it, behind the tour's own watcher (measured: 1 frame of 2437 ms, Chromium 1x; 2 frames of 416 ms, WebKit).
  const block = (ms) => { const t = performance.now(); while (performance.now() - t < ms) {} };
  const later = (k, f) => (k ? requestAnimationFrame(() => later(k - 1, f)) : f());
  // __hold [n, ms]: once, the scroll starts only after n frames of ms each, behind the tour's watcher: the unmoved
  // pre-start WebKit showed after a Next (qframes-wk1440: 2 frames, 416 ms) that ended v2c's flights early.
  // A later call supersedes a held one, as a new scrollTo supersedes an unstarted smooth scroll.
  const rec = (top, call, kind) => { window.__calls.push([Math.round(scrollY), Math.max(0, top), kind]); const lf = window.__longFrame, hold = window.__hold;
    const token = window.__held = hold ? {} : null;
    if (hold) { window.__hold = 0; for (let j = 1; j <= hold[0]; j++) later(j, () => { block(hold[1]); if (j === hold[0] && window.__held === token) call(); }); return undefined; }
    const r = call();
    if (lf) { window.__longFrame = 0; for (const [k, ms] of lf) later(k, () => block(ms)); } return r; };
  const st = window.scrollTo; window.scrollTo = function (...a) { return rec(a[0].top, () => st.apply(this, a), 'to'); };
  const sb = window.scrollBy; window.scrollBy = function (...a) { return rec(scrollY + a[0].top, () => sb.apply(this, a), 'by'); };
  const si = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...a) { const r = this.getBoundingClientRect(); return rec(scrollY + r.top + r.height / 2 - innerHeight / 2, () => si.apply(this, a), 'centre'); };
  window.__hogMs = hogMs;
  if (hogMs) (function f() { const t = performance.now(); while (performance.now() - t < hogMs) {} requestAnimationFrame(f); })();
};
// Settled = step, scroll offset, card and every tour target unchanged for 10 frames AND 500 ms; 60 s cap.
const settled = (page) => page.evaluate(() => new Promise((resolve) => {
  const read = () => {
    const d = document.querySelector('[role="dialog"][aria-label="Guided tour"]');
    const c = d?.querySelector('button[aria-label="Close tour"]')?.closest('div[style]')?.getBoundingClientRect();
    const box = (r) => [r.top, r.bottom, r.left, r.right].map(Math.round);
    return { step: d?.textContent.match(/(\d+)\s*\/\s*19/)?.[1], y: Math.round(scrollY), hd: Math.round(document.querySelector('header').getBoundingClientRect().bottom),
      c: c && box(c), spot: [...document.querySelectorAll('[data-tour]')].map((e) => [e.dataset.tour, ...box(e.getBoundingClientRect())]) };
  };
  let prev = null, frames = 0, since = performance.now();
  const extra = () => ({ vh: innerHeight, vw: innerWidth, max: document.scrollingElement.scrollHeight - innerHeight, calls: window.__calls.slice(), se: 'onscrollend' in window, hogMs: window.__hogMs });
  const done = setTimeout(() => resolve({ ...read(), ...extra(), timeout: true }), 60000);
  const tick = () => {
    const now = performance.now(), cur = read(), k = JSON.stringify(cur);
    if (k === prev) frames++; else { frames = 0; since = now; prev = k; }
    if (frames >= 10 && now - since >= 500) { clearTimeout(done); resolve({ ...cur, ...extra() }); } else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

const failures = [];
const check = (ok, name) => { if (!ok) { failures.push(name); console.error(`  ✗ ${name}`); } return ok; };
const big = (s, t) => s.spot.filter(([n]) => n === t).sort((a, b) => (b[2] - b[1]) - (a[2] - a[1]))[0];
// The usable strip: header..viewport, or header..sheet top when a portrait card sits below the target's top.
const place = (s, t, portrait) => {
  const r = big(s, t); if (!r) return { r, ok: false, clear: false, why: 'no target' };
  const [, tt, tb, tl, tr] = r; const bottom = portrait && s.c && s.c[0] > tt ? s.c[0] : s.vh;
  const fits = tb - tt <= bottom - s.hd;
  const ok = fits ? tt >= s.hd - 2 && tb <= bottom + 2 : Math.abs(tt - s.hd) <= 2;
  const clear = !fits || !s.c || !(s.c[0] < tb - 1 && s.c[1] > tt + 1 && s.c[2] < tr - 1 && s.c[3] > tl + 1);
  return { r, ok, clear, why: `target ${tt}..${tb}x${tl}..${tr} strip ${s.hd}..${bottom} card ${s.c} scrollY ${s.y}/${s.max}` };
};
// The placement's inputs: the target's document box, plus the card height when a portrait strip scroll placed it
// (sheetH = cardH off landscape); a centring scroll and landscape ignore the card (iv1024-{head,v2d}.txt).
const docBox = (s, t, card) => { const r = big(s, t); return r && [r[1] + s.y, r[2] + s.y, card && s.c ? s.c[1] - s.c[0] : 0]; };
const unmoved = (a, b, t) => { const card = a.vh > a.vw && a.calls.at(-1)?.[2] !== 'centre';
  const x = docBox(a, t, card), y = docBox(b, t, card); return !!x && !!y && x.every((v, j) => Math.abs(v - y[j]) <= 1); };
const repeats = (calls) => calls.filter((c, j) => j > 0 && Math.abs(c[1] - calls[j - 1][1]) < 1).length;
const farFrom = (s, t) => { const r = big(s, t); return r && r[1] + s.y > s.max / 2 ? 0 : s.max; };
const awayTo = (page, y) => page.evaluate((v) => { document.scrollingElement.scrollTop = v; }, y); // instant, unrecorded
const jump = (page, n) => page.evaluate((m) => { document.activeElement?.blur(); for (let j = 0; j < m; j++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); }, n);
const press = async (page, key) => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(key); };

const LAND = [1440, 900], PORTRAIT = [1024, 1366], SHEET = [390, 844];
const ENGINES = (process.env.TOUR_WALK_ENGINES || 'chromium,webkit').split(',');
const ONLY = new RegExp(process.env.TOUR_WALK_ONLY || '.'); // local mutant runs; CI runs every case
const [SHARD, SHARDS] = (process.env.TOUR_WALK_SHARD || '1/1').split('/').map(Number); // CI: 6 runners, 8 cases each
const LONG = (process.env.TOUR_WALK_LONG || '0:1500').split(',').map((p) => p.split(':').map(Number)); // frame:ms,...
const HOLD = (process.env.TOUR_WALK_HOLD || '2:208').split(':').map(Number); // frames:ms each
const CASES = [
  ...[['away', 'key'], ['away', 'click'], ['in view', 'click']].flatMap(([mode, adv]) => [LAND, PORTRAIT, SHEET].map((v) => ['walk', v, 0, mode, adv])),
  ['flight', LAND, 0, [3, 14]], ['flight', PORTRAIT, 0, [14]], ['flight', SHEET, 0, [3, 14]],
  ...[LAND, PORTRAIT, SHEET].flatMap((v) => [['interrupt', v, 0, v === SHEET ? [4, 14] : [14]], ['long frame', v, 0, [14]], ['slow', v, 550, [14]],
    ['held start', v, 0, [14]]]),
];

async function walk(page, dlg, tag, portrait, mode, adv) {
  let s = await settled(page);
  let p = place(s, TARGETS[0], portrait);
  let held = 0;
  check(s.step === '1' && p.ok && p.clear, `${tag} step 1 (matrix): the target is in place and clear of the card (${p.why})`);
  for (let k = 1; k < 19; k++) {
    const t = TARGETS[k], same = TARGETS[k - 1] === t, at = `${tag} step ${k}->${k + 1} (${TARGETS[k - 1]}->${t})`;
    if (mode === 'away') { await awayTo(page, farFrom(s, t)); s = await settled(page); }
    const n0 = s.calls.length, y0 = s.y, before = s;
    if (adv === 'key') await press(page, 'ArrowRight');
    else await dlg.getByRole('button', { name: /^Next/ }).click({ timeout: 60000 });
    s = await settled(page);
    if (!check(s.step === String(k + 1) && !s.timeout, `${at}: the tour reached step ${k + 1} and settled (shown ${s.step}, timeout ${!!s.timeout})`)) return;
    const nc = s.calls.slice(n0); p = place(s, t, portrait);
    check(p.ok, `${at}: the ${t} target is in the usable strip, or top-aligned under the header when taller (${p.why}, calls ${JSON.stringify(nc)})`);
    check(p.clear, `${at}: the card is clear of the ${t} target (${p.why})`);
    check(repeats(nc) === 0, `${at}: no repeated scroll to the same place (calls ${JSON.stringify(nc)})`);
    // Nothing to re-place = same target, same document box, same card height; else the step's layout moved it.
    if (mode === 'in view' && same && unmoved(before, s, t)) { held++;
      check(Math.abs(s.y - y0) <= 1 && nc.length <= 1,
        `${at}: the target was already in place, so the page does not move (y ${y0} -> ${s.y}, calls ${JSON.stringify(nc)})`); }
    else if (mode === 'in view' && same) console.log(`    ${at} re-placed: ${t} box ${docBox(before, t)} -> ${docBox(s, t)}`);
  }
  if (mode === 'in view') check(held >= 2, `${tag} fixture: at least 2 same-target steps had nothing to re-place (${held})`);
  console.log(`    ${tag} walked 19 steps${mode === 'in view' ? `, ${held} same-target steps held still` : ''}`);
}

// Settle at k, scroll away from k+1's target, Next, then the extra action, then Next to k+2 (same target).
async function pair(page, tag, portrait, kind, k, at) {
  if (at < k) { await jump(page, k - at); }
  let s = await settled(page);
  if (!check(s.step === String(k), `${tag} ${k}: the jump reached step ${k} (shown ${s.step})`)) return 0;
  const t = TARGETS[k], name = `${tag} ${k}->${k + 1}->${k + 2} (${TARGETS[k - 1]}->${t}->${TARGETS[k + 1]})`;
  const away = farFrom(s, t); await awayTo(page, away); s = await settled(page);
  const n0 = s.calls.length;
  // The tour's first call after n0, then its first moved frame: the extra action lands inside the flight.
  const moving = page.evaluate((n) => new Promise((r) => { const t0 = performance.now(); const f = () => {
    const c = window.__calls[n]; if (c && Math.abs(scrollY - c[0]) >= 1) r({ top: c[1], y: Math.round(scrollY) });
    else if (performance.now() - t0 > 20000) r(null); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n0);
  let n1 = 0; const second = async () => { n1 = await page.evaluate(() => window.__calls.length); await press(page, 'ArrowRight'); };
  // Arms the next tour call: one long frame after it, or a start held for HOLD frames.
  const arm = () => page.evaluate(([k, lf, hold]) => { if (k === 'long frame') window.__longFrame = lf; if (k === 'held start') window.__hold = hold; }, [kind, LONG, HOLD]);
  await arm();
  await press(page, 'ArrowRight');
  if (kind === 'flight') { await page.waitForTimeout(300); await second(); }
  else if (kind !== 'interrupt') {
    s = await settled(page); const p1 = place(s, t, portrait);
    check(s.step === String(k + 1) && p1.ok, `${name}: ${kind}: step ${k + 1}'s ${t} target lands after a scroll-away (${p1.why}, calls ${JSON.stringify(s.calls.slice(n0))})`);
    await awayTo(page, farFrom(s, TARGETS[k + 1])); s = await settled(page);
    await arm();
    await second();
  } else {
    const m = await moving; await page.keyboard.press('PageDown'); s = await settled(page);
    // Fixture: the PageDown really landed mid-flight and stopped it short (so a live flight is what Next meets).
    check(m && Math.abs(m.y - m.top) >= 1 && Math.abs(s.y - m.top) >= 1 && !s.se,
      `${name}: fixture: PageDown stopped the flight short, scrollend absent (moved at ${m?.y}, headed ${m?.top}, stopped ${s.y}, scrollend ${s.se})`);
    // The visitor's own scroll is respected: no re-place yanks the page back while the step is unchanged.
    check(s.step === String(k + 1) && Math.abs(s.y - (m?.top ?? -9)) >= 1,
      `${name}: the visitor's PageDown is respected, the tour does not scroll back on its own (y ${s.y}, target ${m?.top}, calls ${JSON.stringify(s.calls.slice(n0))})`);
    await second();
  }
  s = await settled(page);
  const p = place(s, TARGETS[k + 1], portrait), nc = s.calls.slice(n0);
  const placements = [nc.slice(0, n1 - n0), s.calls.slice(n1)]; // repeats count within one placement, not across Nexts
  check(s.step === String(k + 2) && p.ok, `${name}: ${kind}: step ${k + 2}'s ${TARGETS[k + 1]} target lands in place (${p.why}, away ${away}, calls ${JSON.stringify(nc)})`);
  check(placements.every((c) => repeats(c) === 0), `${name}: ${kind}: no repeated scroll to the same place within a step (calls ${JSON.stringify(placements)})`);
  console.log(`    ${name} ${kind} y ${s.y}, ${nc.length} call(s)`);
  return k + 2;
}

try {
  await waitForOwnServer(server, base);
  const jobs = ENGINES.flatMap((en) => CASES.map((c) => [en, ...c])).filter((_, j) => j % SHARDS === SHARD - 1);
  let ran = 0;
  for (const [en, engine] of [['chromium', chromium], ['webkit', webkit]].filter(([n]) => ENGINES.includes(n))) {
    const browser = en === 'chromium' ? throttleEveryPage(await engine.launch()) : await engine.launch();
    try {
      for (const [, kind, [w, h], hogMs, a, b] of jobs.filter(([e]) => e === en)) {
        const tag = `[${en} ${w}x${h}${hogMs ? ` ${hogMs} ms frames` : ''} ${kind === 'walk' ? `${a} ${b}` : kind}]`;
        if (!ONLY.test(tag)) continue;
        const t0 = Date.now(), load = loadavg()[0].toFixed(1);
        const ctx = await browser.newContext({ viewport: { width: w, height: h } });
        const page = await ctx.newPage();
        await page.addInitScript(init, hogMs);
        await page.goto(base, { waitUntil: 'networkidle' });
        const dlg = page.getByRole('dialog', { name: /guided tour/i });
        await dlg.waitFor({ state: 'visible', timeout: 180000 });
        const s0 = await settled(page);
        check(s0.hogMs === hogMs && !s0.se, `${tag} fixture: the hog ran (${s0.hogMs}, want ${hogMs}) and scrollend is absent (${s0.se})`);
        if (kind === 'walk') await walk(page, dlg, tag, h > w, a, b);
        else { let at = 1; for (const k of a) at = await pair(page, tag, h > w, kind, k, at) || 99; }
        await ctx.close(); ran++;
        console.log(`  · ${tag} ${Math.round((Date.now() - t0) / 1000)} s, load ${load} at start`); // ONE line per case: CI counts them
      }
    } finally { await browser.close(); }
  }
  if (failures.length) { console.error(`✗ tour walk: ${failures.length} check(s) failed`); process.exitCode = 1; }
  else console.log(`✓ tour walk: shard ${SHARD}/${SHARDS}, ${ran} cases: every step lands in chromium and webkit, scrolled away or in view, mid-flight, interrupted, after a long frame, at 550 ms frames and from a held start`);
} finally { server.kill(); }

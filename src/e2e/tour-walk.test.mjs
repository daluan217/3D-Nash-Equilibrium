// TASK-18 H22: the whole tour, every context with scrollend REMOVED (Safari < 26.2). WALK: all 19 steps at the three
// layout families, scrolled away before each Next (key, click) or left alone (IN VIEW: a same-target step holds still).
// FLIGHT: a second Next 300 ms into a flight. INTERRUPT: a visitor's key stops a flight short; the next same-target step
// still lands. LONG FRAME: one 1.5 s frame. SLOW: 550 ms frames. HELD START: 2 frames late. PAGE CANCELS: the page, no
// input, stops flights short. Mutants (old deps, top-only key, nostall, or, nostop, noinput, D3, D4, a 3 s re-place
// delay) fail by name (PR #211).
import { spawn } from 'node:child_process';
import { loadavg } from 'node:os';
import { chromium, webkit } from 'playwright';
import { waitForOwnServer } from '../integration/ownserver.mjs';
import { throttleEveryPage } from './throttle.mjs';
import { WALK_CASES as CASES, walkTag } from './tour-cases.mjs';

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
  // __cancel [act, ...] per next call, or __cancelAll: the PAGE stops the flight halfway in the call's own task with a
  // scrollTop write (no input event; __inputs counts every one). 'next' first presses __nextKey and holds the start
  // __nextHold ([n, ms], 0 = same task). __cuts: [from, to, at, inputs, calls, step]. __next [before, after, frame]:
  // the first frame after that Next whose step label changed (after null if none in 10), read after React commits.
  window.__inputs = 0; window.__cancel = []; window.__cuts = [];
  for (const t of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(t, () => { window.__inputs++; }, { capture: true });
  // Frames delivered: calls and cuts end [frame, ms]; while __yt is an array, each frame appends [frame, ms, scrollY].
  window.__frame = 0; (function fr() { window.__frame++; window.__yt?.push([window.__frame, performance.now(), scrollY]); requestAnimationFrame(fr); })();
  const now = () => [window.__frame, Math.round(performance.now())];
  const label = () => document.querySelector('[role="dialog"]')?.textContent.match(/(\d+)\s*\/\s*19/)?.[1];
  const watchNext = (l0, k = 1) => requestAnimationFrame(() => { const l = label();
    if (l !== l0 || k >= 10) window.__next = [l0, l !== l0 ? l : null, k]; else watchNext(l0, k + 1); });
  const cut = (top) => { const se = document.scrollingElement, from = window.__calls.at(-1)[0], to = Math.min(Math.max(0, top), se.scrollHeight - se.clientHeight);
    const c0 = window.__cancelAll && window.__cuts[0]; // repeated cuts alternate 24 px about the first: never converge
    se.scrollTop = c0 ? c0[2] + (window.__cuts.length % 2) * 24 * Math.sign(c0[2] - c0[1]) : Math.round((from + to) / 2);
    window.__cuts.push([from, to, Math.round(scrollY), window.__inputs, window.__calls.length, label(), ...now()]); };
  const rec = (top, call, kind) => { window.__calls.push([Math.round(scrollY), Math.max(0, top), kind, window.__inputs, ...now()]); const lf = window.__longFrame;
    const act = window.__cancelAll ? 'cancel' : window.__cancel.shift(), go = () => { const v = call(); if (act) cut(top); return v; };
    if (act === 'next') { window.__hold = window.__nextHold; watchNext(label());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: window.__nextKey, bubbles: true })); }
    const hold = window.__hold, token = window.__held = hold ? {} : null;
    if (hold) { window.__hold = 0; for (let j = 1; j <= hold[0]; j++) later(j, () => { block(hold[1]); if (j === hold[0] && window.__held === token) go(); }); return undefined; }
    const r = go();
    // __interrupt: once, a visitor's key (keydown, then the page scrolls halfway) stops the flight in the call's own
    // task: polling frames for mid-flight flaked when the first frame had already arrived (CI 36524167108, WebKit).
    if (window.__interrupt) { window.__interrupt = 0; const se = document.scrollingElement, from = window.__calls.at(-1)[0];
      const to = Math.min(Math.max(0, top), se.scrollHeight - se.clientHeight), live = Math.round(scrollY);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: to < from ? 'PageUp' : 'PageDown', bubbles: true }));
      se.scrollTop = Math.round((from + to) / 2); window.__interrupted = { from, top: to, live, at: Math.round(scrollY) }; }
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
  const extra = () => ({ vh: innerHeight, vw: innerWidth, max: document.scrollingElement.scrollHeight - innerHeight, calls: window.__calls.slice(), se: 'onscrollend' in window, hogMs: window.__hogMs,
    inputs: window.__inputs, cuts: window.__cuts.slice() });
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
// The product's signal: the n-th tour call. Timer-bounded, so a missing re-place fails by name, not by a hung rAF.
const replaced = (page, n) => page.evaluate((m) => new Promise((res) => { const t0 = performance.now();
  const poll = () => (window.__calls.length >= m ? res(true) : performance.now() - t0 > 30000 ? res(false) : setTimeout(poll, 20)); poll(); }), n);
// Re-place latency [frames, ms] from the page's cut and from the product's STOP, rebuilt from literals (never imported:
// e2esharding pins them to Walkthrough.tsx): 2 frames AND 150 ms after the last >= 1 px move since the flight's call.
const STILL = [2, 150, 1];
const lag = (a, call) => (a && call ? [call[4] - a[0], Math.round(call[5] - a[1])] : [NaN, NaN]); // NaN fails the bound
const stopOf = (yt, from, cut, call) => { if (!from || !cut || !call) return null; let y = from[0], at = null;
  for (const [f, ms, cy] of yt) if (f > cut[6] && f <= call[4]) {
    if (Math.abs(cy - y) >= STILL[2]) { y = cy; at = [f, ms]; } else if (at && f - at[0] >= STILL[0] && ms - at[1] >= STILL[1]) return [f, ms]; }
  return null; };
const REPLACE_FRAMES = 5;

const ENGINES = (process.env.TOUR_WALK_ENGINES || 'chromium,webkit').split(',');
const ONLY = new RegExp(process.env.TOUR_WALK_ONLY || '.'); // local mutant runs; CI runs every case
const [SHARD, SHARDS] = (process.env.TOUR_WALK_SHARD || '1/1').split('/').map(Number); // CI: 9 runners, 6 cases each
const LONG = (process.env.TOUR_WALK_LONG || '0:1500').split(',').map((p) => p.split(':').map(Number)); // frame:ms,...
const HOLD = (process.env.TOUR_WALK_HOLD || '2:208').split(':').map(Number); // frames:ms each

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
  let n1 = 0; const second = async () => { n1 = await page.evaluate(() => window.__calls.length); await press(page, 'ArrowRight'); };
  // Arms the next tour call: one long frame after it, the visitor's key in it, or a start held for HOLD frames.
  const arm = () => page.evaluate(([k, lf, hold]) => { if (k === 'long frame') window.__longFrame = lf;
    if (k === 'interrupt') { window.__interrupt = 1; window.__interrupted = null; } if (k === 'held start') window.__hold = hold; }, [kind, LONG, HOLD]);
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
    const m = await page.waitForFunction(() => window.__interrupted, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null);
    s = await settled(page);
    // Fixture: the key landed while the flight was live (not instant) and stopped it short of its target mid-way.
    check(m && Math.abs(m.live - m.top) >= 1 && Math.abs(m.at - m.top) >= 1 && Math.abs(m.at - m.from) >= 1 && Math.abs(s.y - m.top) >= 1 && !s.se,
      `${name}: fixture: the visitor's key stopped the flight short, scrollend absent (from ${m?.from}, live ${m?.live}, at ${m?.at}, headed ${m?.top}, stopped ${s.y}, scrollend ${s.se})`);
    // The visitor's own scroll is respected: no re-place yanks the page back while the step is unchanged.
    check(s.step === String(k + 1) && Math.abs(s.y - (m?.top ?? -9)) >= 1,
      `${name}: the visitor's key is respected, the tour does not scroll back on its own (y ${s.y}, target ${m?.top}, calls ${JSON.stringify(s.calls.slice(n0))})`);
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

// PAGE CANCELS: the page stops tour flights short itself, with no input. 1) Step s's flight is cut and re-placed; the page
// presses Next into same-target s+1 before that re-place starts, s+1 adopts it (no call of its own), the page cuts it:
// s+1 must re-place it, once. 2) The page cuts EVERY tour scroll: one re-place, then quiet. Mutants D3, D4 in PR #211.
// Next per kind: its key, then the start's hold (0: the cut shares the keydown's task, before React commits).
const NEXT = { 'page cancels': ['ArrowRight', [4, 208]], 'page cancels same task': ['ArrowRight', 0], 'page cancels next frame Enter': ['Enter', [1, 0]] };
async function cancels(page, tag, portrait, s, kind) {
  const [key, hold] = NEXT[kind];
  await jump(page, s - 2);
  let st = await settled(page);
  if (!check(st.step === String(s - 1), `${tag} ${s - 1}: the jump reached step ${s - 1} (shown ${st.step})`)) return;
  const t = TARGETS[s - 1], name = `${tag} ${s - 1}->${s}->${s + 1} (${TARGETS[s - 2]}->${t}->${TARGETS[s]})`;
  if (!check(TARGETS[s] === t, `${name}: fixture: steps ${s} and ${s + 1} share a target`)) return;
  const short = (cuts) => cuts.every(([from, to, at]) => Math.abs(at - to) >= 1 && Math.abs(at - from) >= 1);
  await awayTo(page, farFrom(st, t)); st = await settled(page);
  const n0 = st.calls.length;
  await page.evaluate(([k, h]) => { window.__cuts = []; window.__cancel = ['cancel', 'next']; window.__yt = []; window.__nextKey = k; window.__nextHold = h; window.__next = null; }, [key, hold]);
  await press(page, 'ArrowRight');
  // Settle only after the product's signal, s+1's re-place (call 3): the held start's stillness settled first (CI 36552468990).
  const got = await replaced(page, n0 + 3);
  st = await settled(page);
  const [yt, nx] = await page.evaluate(() => [window.__yt, window.__next]);
  const nc = st.calls.slice(n0), [c0, c1] = st.cuts, p = place(st, t, portrait), log = `calls ${JSON.stringify(nc)}, cuts ${JSON.stringify(st.cuts)}, inputs ${st.inputs}`;
  const lat = [[nc[0], c0, nc[1]], [nc[1], c1, nc[2]]].map(([a, c, b]) => [lag(c?.slice(6), b), lag(stopOf(yt, a, c, b), b)]);
  check(got, `${name}: page cancels: step ${s + 1} re-places after the page's cut (no 3rd call in 30 s, ${log})`);
  check(lat.every(([, [f]]) => f <= REPLACE_FRAMES), `${name}: page cancels: each re-place follows the flight's stop within ${REPLACE_FRAMES} frames, nothing timed between (cut/stop -> re-place frames,ms ${JSON.stringify(lat)})`);
  // Inputs: none from step s's call to its cut and re-place; then only the page's own Next, before the adoption.
  check(!!nx?.[1], `${name}: page cancels: the page's ${key} advances the step mid-flight (label never changed in 10 frames after the keydown: ${JSON.stringify(nx)})`);
  check(!nx?.[1] || (nx[0] === String(s) && nx[1] === String(s + 1)), `${name}: page cancels: the page's ${key} advances ${s} -> ${s + 1} (changed to the wrong step: ${JSON.stringify(nx)})`);
  // The cut reads the label in its own task: step s+1 after a held start, still s when it shares the keydown's task.
  check(st.cuts.length === 2 && c0[5] === String(s) && c1[5] === String(hold ? s + 1 : s) && short(st.cuts) && nc.length >= 2
    && nc[0][3] === c0[3] && nc[1][3] === c0[3] && c1[3] === c0[3] + 1 && st.inputs === c1[3],
  `${name}: fixture: the page cut step ${s}'s flight, then the re-place step ${s + 1} took over, each short, no input but the page's Next (${log})`);
  check(c1?.[4] === n0 + 2, `${name}: fixture: step ${s + 1} adopted the live re-place, no call of its own before the cut (${log})`);
  check(st.step === String(s + 1) && !st.timeout && p.ok && nc.length === 3 && Math.abs(nc[2][1] - nc[1][1]) < 1,
    `${name}: page cancels: step ${s + 1} re-places the flight it adopted, once, and its ${t} target lands (${p.why}, ${log})`);
  // 2) Every tour scroll is cut. Settled, then 3 s more (3x the unmoved stop's 1000 ms): a 3rd call would show.
  await awayTo(page, farFrom(st, TARGETS[s + 1])); st = await settled(page);
  const n1 = st.calls.length;
  await page.evaluate(() => { window.__cuts = []; window.__cancelAll = 1; window.__yt = []; });
  await press(page, key);
  const got2 = await replaced(page, n1 + 2); // the same signal: its one re-place, then settled and 3 s more
  st = await settled(page); await page.waitForTimeout(3000);
  const end = await page.evaluate(() => ({ calls: window.__calls.slice(), cuts: window.__cuts.slice(), inputs: window.__inputs, yt: window.__yt }));
  const all = end.calls.slice(n1), log2 = `calls ${JSON.stringify(all)}, cuts ${JSON.stringify(end.cuts.slice(0, 4))}, inputs ${end.inputs}`;
  lat.push([lag(end.cuts[0]?.slice(6), all[1]), lag(stopOf(end.yt, all[0], end.cuts[0], all[1]), all[1])]);
  check(end.cuts.length >= 2 && end.cuts[0][5] === String(s + 2) && short(end.cuts) && all.every((c) => c[3] === end.inputs) && end.cuts.every((c) => c[3] === end.inputs),
    `${name}->${s + 2}: fixture: the page cut every tour scroll short with no input (${log2})`);
  check(got2 && lat[2][1][0] <= REPLACE_FRAMES, `${name}->${s + 2}: page cancels: step ${s + 2} re-places within ${REPLACE_FRAMES} frames of the flight's stop (cut/stop -> re-place frames,ms ${JSON.stringify(lat[2])}, ${log2})`);
  check(all.length === 2 && !st.timeout, `${name}->${s + 2}: the page cancels every tour scroll: step ${s + 2} re-places once, then leaves the page alone (settled ${!st.timeout}, ${log2})`);
  console.log(`    ${name} ${key} held ${JSON.stringify(hold)}, step shown ${nx?.[2]} frame(s) after it, adopted at call ${c1?.[4]}, ${nc.length} call(s); cut-every ${all.length} call(s), ${end.cuts.length} cut(s); re-place frames/ms after cut|stop ${lat.map(([c, p]) => `${c.join('/')}|${p.join('/')}`).join(' ')}`);
}

try {
  await waitForOwnServer(server, base);
  const jobs = ENGINES.flatMap((en) => CASES.map((c) => [en, ...c])).filter((_, j) => j % SHARDS === SHARD - 1);
  let ran = 0;
  for (const [en, engine] of [['chromium', chromium], ['webkit', webkit]].filter(([n]) => ENGINES.includes(n))) {
    const browser = en === 'chromium' ? throttleEveryPage(await engine.launch()) : await engine.launch();
    try {
      for (const [, kind, [w, h], hogMs, a, b] of jobs.filter(([e]) => e === en)) {
        const tag = walkTag(en, [kind, [w, h], hogMs, a, b]);
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
        else if (kind in NEXT) await cancels(page, tag, h > w, a, kind);
        else { let at = 1; for (const k of a) at = await pair(page, tag, h > w, kind, k, at) || 99; }
        await ctx.close(); ran++;
        console.log(`  · ${tag} ${Math.round((Date.now() - t0) / 1000)} s, load ${load} at start`); // ONE line per case: CI counts them
      }
    } finally { await browser.close(); }
  }
  if (failures.length) { console.error(`✗ tour walk: ${failures.length} check(s) failed`); process.exitCode = 1; }
  else console.log(`✓ tour walk: shard ${SHARD}/${SHARDS}, ${ran} cases: every step lands in chromium and webkit, scrolled away or in view, mid-flight, interrupted, after a long frame, at 550 ms frames and from a held start`);
} finally { server.kill(); }

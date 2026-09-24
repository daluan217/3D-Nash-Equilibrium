// TASK-18 H16: E2E_CPU_THROTTLE once reached only newTrackedPage's pages, so a "green at 11x" for
// any ctx.newPage() section measured nothing. Measured here, not assumed: the same busy loop on a
// page from every creation path smoke.mjs uses must run >= 3x slower than the unwrapped browser's
// page (unapplied reads ~1x), and every chromium launch in smoke.mjs must go through the wrapper.
// MUTANTS (each fails a named check): drop the ctx.newPage wrap; drop throttleEveryPage from
// either launch in smoke.mjs; move the rate back into newTrackedPage only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { throttleEveryPage } from './throttle.mjs';

const RATE = 11;
const MIN_RATIO = 3;
// ~20 ms unthrottled: long enough to span the throttler's suspend slices (a 3 ms loop can land
// in an unsuspended slice), and the MEDIAN of 5 so one lucky or unlucky run decides nothing.
const busy = () => { const t = performance.now(); let x = 0; for (let i = 0; i < 2e7; i++) x += Math.sqrt(i); return performance.now() - t + (x < 0 ? 1 : 0); };
const ms = async (page) => { await page.evaluate(busy); const runs = []; for (let i = 0; i < 5; i++) runs.push(await page.evaluate(busy)); return runs.sort((a, b) => a - b)[2]; };

const smoke = readFileSync(new URL('./smoke.mjs', import.meta.url), 'utf8');
const launches = [...smoke.matchAll(/(\S+\()?await chromium\.launch\(/g)].map((m) => m[1] ?? '');
assert.ok(launches.length >= 2 && launches.every((w) => w === 'throttleEveryPage('),
  `every chromium.launch in smoke.mjs is wrapped by throttleEveryPage (${JSON.stringify(launches)})`);
assert.doesNotMatch(smoke, /setCPUThrottlingRate/, 'smoke.mjs sets no throttle of its own (one wrapper, no page escapes)');

const plain = await chromium.launch();
const wrapped = throttleEveryPage(await chromium.launch(), RATE);
try {
  const base = await ms(await plain.newPage());
  const ctx = await wrapped.newContext();
  const paths = {
    'browser.newPage()': await wrapped.newPage(),
    'browser.newContext().newPage()': await ctx.newPage(),
    'second page of one context': await ctx.newPage(),
    'context with options': await (await wrapped.newContext({ viewport: { width: 320, height: 256 } })).newPage(),
  };
  const ratios = {};
  for (const [path, page] of Object.entries(paths)) ratios[path] = (await ms(page)) / base;
  if (process.env.THROTTLE_PROBE) console.log(JSON.stringify(ratios));
  // Unapplied reads ~1x; applied read 5.1-12x at rate 11 (loaded laptop and idle, SWEEPS.md H16).
  for (const [path, r] of Object.entries(ratios)) {
    assert.ok(r >= MIN_RATIO, `${path} runs throttled (${r.toFixed(1)}x slower than an unwrapped page, need >= ${MIN_RATIO}x at rate ${RATE})`);
  }
  assert.equal(throttleEveryPage(plain, 0), plain, 'rate 0 leaves the browser untouched');
  console.log(`✓ CPU throttle reaches every page-creation path (${Object.keys(paths).length} paths, rate ${RATE}, base ${base.toFixed(1)} ms)`);
} finally {
  await plain.close();
  await wrapped.close();
}

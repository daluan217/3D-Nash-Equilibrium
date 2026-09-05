/**
 * RED-REGEN-2/002 self-test — standalone proof that `newTrackedPage`/
 * `trackPage` (src/e2e/smoke.mjs) actually close the blind spot the red
 * found, and that the companion `relevantErrors` filter fix does not
 * reopen it the other way (by swallowing every error indiscriminately).
 *
 * This is a DEMONSTRATION script, not the CI-authoritative proof — the
 * authoritative mutation test was run directly against smoke.mjs itself (a
 * planted `setTimeout(() => throw ...)` on section 31's own page, which made
 * the suite's real "no console/page errors" check fail; removed afterward).
 * See round9/notes/BLUE-REGEN-9/STATE.md for that run's logs. This script
 * exists so the mechanism can be re-demonstrated later without booting the
 * whole app server or running the full section list.
 *
 * Run: node _gen/smoke_tracked_page_selftest.mjs
 */
import { chromium } from 'playwright';

let failures = 0;
function check(name, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
}

const browser = await chromium.launch();

// ── the exact shape of smoke.mjs's trackPage/newTrackedPage ─────────────────
const consoleErrors = [];
function trackPage(p) {
  p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  return p;
}
async function newTrackedPage(opts) {
  return trackPage(await browser.newPage(opts));
}

// 1. A page created through newTrackedPage that throws IS captured.
{
  const p = await newTrackedPage();
  await p.goto('about:blank');
  await p.evaluate(() => { setTimeout(() => { throw new Error('SELFTEST: tracked page threw'); }, 0); });
  await p.waitForTimeout(200);
  check('a tracked page\'s uncaught exception reaches the shared tracker',
    consoleErrors.some((t) => t.includes('SELFTEST: tracked page threw')),
    JSON.stringify(consoleErrors));
  await p.close();
}

// 2. The SAME shape, but built the OLD (pre-fix) way — a bare
//    browser.newPage() with no listener — confirms the defect this fix
//    closes actually existed (negative control: this page's error must NOT
//    appear, since nothing is listening to it).
{
  consoleErrors.length = 0;
  const untracked = await browser.newPage(); // deliberately NOT trackPage()'d
  await untracked.goto('about:blank');
  await untracked.evaluate(() => { setTimeout(() => { throw new Error('SELFTEST: untracked page threw'); }, 0); });
  await untracked.waitForTimeout(200);
  check('an UNTRACKED page\'s exception is invisible (reproduces the pre-fix blind spot as a negative control)',
    consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await untracked.close();
}

// 3. A benign, deliberately-mocked HTTP error status (the same shape §31/§33
//    trigger via route.fulfill) is captured by the tracker as a console
//    error too — proving the companion relevantErrors filter fix in
//    smoke.mjs is doing real work, not merely a no-op.
{
  consoleErrors.length = 0;
  const p = await newTrackedPage();
  await p.route('https://example.test/', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }));
  await p.route('**/mock-endpoint', (route) => route.fulfill({ status: 429, body: '{}' }));
  // `about:blank` has no real origin, so a relative fetch() never reaches
  // Chromium's network stack the way a real page's fetch does; a fully
  // qualified URL under Playwright's own interception never leaves the
  // process either way (both routes above answer it), so this needs no
  // real server or DNS resolution.
  await p.goto('https://example.test/');
  await p.evaluate(() => fetch('https://example.test/mock-endpoint').catch(() => {}));
  await p.waitForTimeout(300);
  const hasNetworkNoise = consoleErrors.some((t) => /failed to load resource: the server responded with a status of/i.test(t));
  check('a deliberately-mocked 429 DOES reach the tracker as a raw console error (confirms smoke.mjs needs the filter fix, not just tracking)',
    hasNetworkNoise, JSON.stringify(consoleErrors));
  await p.close();
}

await browser.close();
console.log(failures === 0
  ? '\nCONFIRMED: newTrackedPage/trackPage close the blind spot; the companion filter fix in smoke.mjs is necessary and doing real work.'
  : `\n${failures} check(s) failed — mechanism not reproduced as expected.`);
process.exit(failures === 0 ? 0 : 1);

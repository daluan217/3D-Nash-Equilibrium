/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `fetchWithTimeout` (App.tsx, RED-APP-6/003) exists to bound a report
 * request that neither resolves nor rejects. CodeRabbit finding (this
 * branch): a first draft chained the abort timer's `clearTimeout` directly
 * onto the `fetch()` promise via `.finally()` — which fires the instant
 * RESPONSE HEADERS arrive, not once the body is fully read. A server that
 * answers promptly with headers and then stalls mid-body (a slow proxy, a
 * connection that drops packets partway through) would have its timer
 * cancelled before the caller ever calls `res.json()`, so the exact failure
 * mode this fix exists for — a request that never completes — would sail
 * straight through with no protection.
 *
 * This drives the REAL exported `fetchWithTimeout` against a REAL local HTTP
 * server that sends headers immediately and then never writes or ends the
 * body, mirroring the real call sites' usage: `clear()` is called from the
 * CALLER's own cleanup, after attempting to read the body — never chained
 * onto the fetch promise itself. If a future edit reintroduces the premature
 * `.finally()` pattern, `res.json()` below would hang forever instead of
 * rejecting near the (short, test-only) timeout, and this test times out.
 *
 *   npx tsx src/fetchtimeout.test.ts
 */
import assert from 'node:assert';
import http from 'node:http';
import { fetchWithTimeout } from './App';

let checks = 0;
function ok(cond: unknown, msg: string): asserts cond {
  checks++;
  assert(cond, msg);
}

async function withStalledBodyServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const server = http.createServer((_req, res) => {
    // Headers sent immediately (this is the part `fetch()`'s own promise
    // resolves on) -- then nothing further, ever. No res.write, no res.end.
    // `flushHeaders()` is required: `writeHead()` alone does not actually
    // put bytes on the wire until Node has more to send (confirmed
    // empirically -- without it, `fetch()` itself hangs, which would make
    // this harness indistinguishable from the connection-never-answers
    // case the smoke.mjs e2e check already covers, not the header-arrives-
    // then-body-stalls case this file exists to isolate).
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a port');
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    return await fn(url);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testTimerStaysArmedThroughBodyRead() {
  await withStalledBodyServer(async (url) => {
    const controller = new AbortController();
    const TEST_TIMEOUT_MS = 800; // short: this must stay a fast unit test
    const { promise, clear } = fetchWithTimeout(url, {}, controller, TEST_TIMEOUT_MS);

    // The fetch promise resolves once HEADERS arrive -- fast, well under the
    // timeout, exactly the case CodeRabbit's finding is about. `clear()` is
    // deliberately NOT called here (real callers only call it in their own
    // `finally`, after the body attempt) -- this is the crux of the test.
    const start = Date.now();
    const res = await promise;
    ok(res.ok, 'headers must arrive promptly (this is the response, not the body)');
    const headersElapsed = Date.now() - start;
    ok(headersElapsed < TEST_TIMEOUT_MS,
      `headers arrived at ${headersElapsed}ms, expected well under the ${TEST_TIMEOUT_MS}ms timeout -- `
      + 'if this fails the server harness itself is slow, not the code under test');

    // The body never arrives. If the timer were (incorrectly) already
    // cleared on header arrival, this would hang forever and the test
    // process itself would time out -- the mutation signal. With the fix,
    // the still-armed timer aborts the controller and res.json() rejects.
    let rejected = false;
    let rejectedWithAbort = false;
    try {
      await res.json();
    } catch (err) {
      rejected = true;
      rejectedWithAbort = err instanceof Error && err.name === 'AbortError';
    } finally {
      clear();
    }
    const totalElapsed = Date.now() - start;
    ok(rejected, `res.json() on a stalled body must eventually reject (it did not within ${totalElapsed}ms) -- `
      + 'if the abort timer was cleared prematurely (on header arrival, not body completion), this hangs forever');
    ok(rejectedWithAbort, 'the rejection must be the abort (AbortError), not some other failure');
    ok(totalElapsed >= TEST_TIMEOUT_MS - 50 && totalElapsed < TEST_TIMEOUT_MS + 5000,
      `the abort must fire close to the configured timeout (${TEST_TIMEOUT_MS}ms), got ${totalElapsed}ms`);
  });
}

async function testClearBeforeBodyReadPreventsTheAbort() {
  // The complementary case, so this file does not only prove "the timer can
  // fire" -- also confirms `clear()` genuinely disarms it when a caller DOES
  // finish (or abandon) the read before the deadline, so the fix does not
  // (over-correct into) leaking a live abort against a controller nobody is
  // using any more.
  await withStalledBodyServer(async (url) => {
    const controller = new AbortController();
    const TEST_TIMEOUT_MS = 400;
    const { promise, clear } = fetchWithTimeout(url, {}, controller, TEST_TIMEOUT_MS);
    await promise;
    clear(); // caller finished with the response object; disarm.
    await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUT_MS + 300));
    ok(!controller.signal.aborted, 'clear() must actually disarm the timer -- the controller must not abort after it was called');
  });
}

async function main() {
  await testTimerStaysArmedThroughBodyRead();
  await testClearBeforeBodyReadPreventsTheAbort();
  console.log(`✓ fetchtimeout.test.ts: ${checks} assertions passed`);
}

// A watchdog, not just a hope: if the exact regression this file exists to
// catch (the abort timer cleared on header arrival, not body completion)
// reappears, `res.json()` in testTimerStaysArmedThroughBodyRead hangs
// FOREVER (verified: the pre-fix code does exactly this against this same
// harness) -- which, unguarded, would hang `npm test` and the CI job until
// its own timeout-minutes, rather than reporting a fast, clear failure.
const WATCHDOG_MS = 10_000;
const watchdog = setTimeout(() => {
  console.error(`fetchtimeout.test.ts: TIMED OUT after ${WATCHDOG_MS}ms -- this is itself the failure `
    + '(the abort timer likely fired too early or never at all; see the file docstring)');
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

main()
  .then(() => clearTimeout(watchdog))
  .catch((e) => { clearTimeout(watchdog); console.error(e); process.exit(1); });

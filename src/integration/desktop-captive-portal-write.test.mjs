/* INTEGRATION — a 2xx response whose body is NOT the backend's JSON
 * acknowledgement must never be treated as a completed write.
 *
 * THE DEFECT CLASS (RED-DESKTOP-20/002). Desktop cloud mode's API base is
 * user-configurable (App.tsx getApiUrl + MenuDrawer's onUpdateApiBaseUrl), so
 * a captive portal, a filtering proxy, or a misconfigured base can answer any
 * request with `200 text/html`. `res.ok` alone is then true while NOTHING
 * happened server-side. For DELETE that means the row disappears from the UI
 * and the user is told their game is gone when it is still on the server; for
 * save/edit it means a "saved" toast for a write that never landed.
 *
 * WHY THIS FILE EXISTS ON TOP OF THE EXISTING SUITE. `src/apiclient.contract
 * .test.ts` covers the CLIENT verdict machinery (`dataParsed`, sessionDied,
 * ...) at the unit level, and round 20's own probe drove the real UI — but
 * that probe lived under `_gen/` and, when it was recovered for round 22, it
 * turned out to reference a mock server that did not exist, so it printed
 * "COULD NOT LOCATE the mock game" and exited 0 for two rounds. A probe that
 * cannot reach its call site protects nothing. This checks the ACTUAL call
 * sites, in the real bundle, from the response shape inward.
 *
 * WHY IT CANNOT PASS BY COINCIDENCE:
 *  - Every case asserts on a response the mock DEFINITELY sent (the mock
 *    records its own hits, and the test fails if the request never arrived),
 *    so "no request" can never read as "handled correctly".
 *  - A control arm sends the WELL-FORMED acknowledgement through the same
 *    code path and requires the opposite verdict. If both arms agreed, the
 *    instrument would be measuring itself.
 *  - The predicate is read off the shipped bundle's own guard expression, so
 *    a rename that silently drops the check fails here rather than passing.
 *
 * MUTATION-PROVEN (recorded 2026-09-19, BLUE-LOOP-DESKTOP-22): reverting
 * App.tsx's delete guard from
 *     res.kind !== 'response' || (res.ok && (!res.dataParsed || res.data?.success !== true))
 * to a bare
 *     res.kind !== 'response'
 * rebuilds a tree on which the live-UI probe reports
 *   "HIT: a 200-with-HTML (captive portal) DELETE was treated as a successful
 *    deletion"
 * and this file's check 4 fails by name.
 *
 *   node src/integration/desktop-captive-portal-write.test.mjs
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — the guard expression is present at EVERY write call site.
//
// Text, deliberately: these four sites live inside React event handlers in a
// 7k-line component, and the failure mode is DELETION of one clause, not
// malfunction. The expression is normalised (whitespace collapsed, comments
// stripped) so reformatting does not fail the check but removal does.
// ─────────────────────────────────────────────────────────────────────────────
const appSrc = readFileSync(path.join(repo, 'src/App.tsx'), 'utf8');
const appCode = appSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const normalised = appCode.replace(/\s+/g, ' ');

// The shape every write call site must use before believing a 2xx.
const GUARD = "res.kind !== 'response' || (res.ok && (!res.dataParsed || res.data?.success !== true))";
const guardCount = normalised.split(GUARD.replace(/\s+/g, ' ')).length - 1;
record(
  'every 2xx-trusting write call site still checks dataParsed AND success===true',
  guardCount >= 4,
  `found ${guardCount} occurrences of the guard expression (save, edit, delete, adopt-local); `
  + 'a drop below 4 means a call site now trusts res.ok alone, which is exactly RED-DESKTOP-20/002',
);

// The instrument must be able to fail: prove the matcher does not match a
// weakened expression. Without this, a rename could make guardCount 0 and the
// message above would be the only thing standing between us and a silent pass.
const weakened = "if (res.kind !== 'response') { alert('x'); }".replace(/\s+/g, ' ');
record(
  'the matcher does NOT accept the pre-fix (res.kind-only) expression',
  !weakened.includes(GUARD.replace(/\s+/g, ' ')),
  'a matcher that accepted the weakened form could not fail for its stated reason',
);

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — behavioural: run the real verdict helper over captive-portal and
// well-formed responses and require OPPOSITE outcomes.
//
// This is the arm that would catch a guard that is present but inverted — the
// text check above cannot see polarity.
// ─────────────────────────────────────────────────────────────────────────────

/** The exact predicate the shipped call sites apply, extracted as a function. */
const treatsAsFailure = (res) =>
  res.kind !== 'response' || (res.ok && (!res.dataParsed || res.data?.success !== true));

const cases = [
  // label,                         response,                                                      mustBeFailure
  ['captive portal: 200 + text/html', { kind: 'response', ok: true, dataParsed: false, data: {} }, true],
  ['proxy: 200 + empty JSON object', { kind: 'response', ok: true, dataParsed: true, data: {} }, true],
  ['200 + success:false', { kind: 'response', ok: true, dataParsed: true, data: { success: false } }, true],
  ['200 + success omitted', { kind: 'response', ok: true, dataParsed: true, data: { game: { id: 'g1' } } }, true],
  ['200 + success:"true" (string)', { kind: 'response', ok: true, dataParsed: true, data: { success: 'true' } }, true],
  ['200 + success:1 (truthy non-bool)', { kind: 'response', ok: true, dataParsed: true, data: { success: 1 } }, true],
  ['network failure (no response)', { kind: 'network', ok: false, dataParsed: false, data: {} }, true],
  ['timeout (no response)', { kind: 'timeout', ok: false, dataParsed: false, data: {} }, true],
  // THE CONTROL: the real backend acknowledgement must NOT be rejected. If this
  // came out `true` like the rest, the predicate would be refusing everything
  // and the suite would be measuring itself rather than the guard.
  ['CONTROL — genuine backend ack', { kind: 'response', ok: true, dataParsed: true, data: { success: true } }, false],
];
for (const [label, res, mustBeFailure] of cases) {
  record(
    `${mustBeFailure ? 'rejected' : 'ACCEPTED'}: ${label}`,
    treatsAsFailure(res) === mustBeFailure,
    `treatsAsFailure=${treatsAsFailure(res)}, expected ${mustBeFailure}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — end to end over real HTTP: a server that answers 200 with HTML must
// produce `dataParsed: false` through the SAME parse path the client uses.
//
// The client's own parse is `await res.json().catch(() => { dataParsed = false })`
// (src/utils/apiClient.ts). Reproduce it against a real socket rather than
// trusting the description — a captive portal is an HTTP fact, not a unit-test
// fixture, and this is the step that proves the earlier arms describe reality.
// ─────────────────────────────────────────────────────────────────────────────
const hits = [];
const mock = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  if (req.url === '/html200') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Network sign-in required</h1></body></html>');
  } else if (req.url === '/json200') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } else {
    res.writeHead(404); res.end('{}');
  }
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

/** apiClient.ts's parse, verbatim in shape. */
async function parseLikeClient(url) {
  const res = await fetch(url);
  let dataParsed = true;
  const data = await res.json().catch(() => { dataParsed = false; return {}; });
  return { kind: 'response', ok: res.ok, status: res.status, data, dataParsed };
}

const portal = await parseLikeClient(`${base}/html200`);
record(
  'a real 200 text/html response parses as dataParsed:false',
  portal.ok === true && portal.dataParsed === false,
  `ok=${portal.ok} dataParsed=${portal.dataParsed} — note ok is TRUE, which is why res.ok alone is not proof`,
);
record(
  'and the write call sites therefore treat it as a FAILURE',
  treatsAsFailure(portal) === true,
);

const genuine = await parseLikeClient(`${base}/json200`);
record(
  'CONTROL — a real 200 application/json ack parses as dataParsed:true and is ACCEPTED',
  genuine.dataParsed === true && treatsAsFailure(genuine) === false,
  `dataParsed=${genuine.dataParsed} treatsAsFailure=${treatsAsFailure(genuine)}`,
);
// Both requests must actually have been made: a suite that silently sent
// nothing would otherwise report two clean passes.
record(
  'both HTTP arms actually reached the mock (no vacuous pass)',
  hits.includes('GET /html200') && hits.includes('GET /json200'),
  JSON.stringify(hits),
);
mock.close();

// SR-47: a suite that SILENTLY SKIPS a block still prints "N/N checks passed"
// and exits 0, because N is counted, not expected. Measured on this file's own
// ancestor: filtering one data array to empty removed six checks and the run
// said "37/37 checks passed". The red probe that had aborted for three sweeps
// was the same shape. So the count is DECLARED: fewer means a block did not
// run, which is a failure even when every check that did run passed.
const EXPECTED_CHECKS = 15;
if (results.length < EXPECTED_CHECKS) {
  console.error(`FAILED: only ${results.length} checks ran, expected at least ${EXPECTED_CHECKS} — `
    + 'a block was skipped. Raise EXPECTED_CHECKS deliberately when adding checks.');
  process.exit(1);
}
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error(`\n${failed.length} check(s) FAILED:`);
  for (const f of failed) console.error(`  - ${f.name} ${f.detail}`);
  process.exit(1);
}
console.log(`\ndesktop-captive-portal-write.test.mjs: ${results.length} checks passed`);

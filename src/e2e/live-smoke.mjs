/* LIVE-SITE smoke — the post-deploy layer of the testing pyramid.
 *
 * Everything else in the pyramid runs on GitHub runners against the build
 * artifact. This script verifies what the USER actually gets: the live
 * nash-equilibrium-simulator.com after the Netlify/Cloud Run deploy lands.
 * Read-only by design — no accounts are created and no game is saved. The
 * default pass calls no model either (the report route is probed with an
 * INVALID matrix, which exercises routing and validation without spending a
 * token). LIVE_DEEP=1 adds the deploy-config checks, which DO spend two small
 * model calls; the deploy-verify run sets it, the nightly monitor does not.
 *
 * Deploy verification: when EXPECTED_INDEX points at the index.html built by
 * the triggering Test run, the script polls the live site until it serves
 * THAT build's hashed asset (the deploy landed), then checks the live
 * surfaces. Without it (nightly monitor mode) the checks run immediately.
 *
 *   LIVE_BASE=https://nash-equilibrium-simulator.com \
 *   EXPECTED_INDEX=dist/index.html node src/e2e/live-smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = (process.env.LIVE_BASE || 'https://nash-equilibrium-simulator.com').replace(/\/$/, '');
// how long to wait for the deploy to land after the merge (minutes)
const WAIT_MINUTES = Number(process.env.LIVE_WAIT_MINUTES || 15);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function getText(path, opts) {
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text().catch(() => '');
  return { status: r.status, text, headers: r.headers };
}

// ── wait for the deploy: the live index.html must reference the SAME hashed
//    asset as the build we are verifying (a stale deploy serves the old hash)
let expectedAsset = null;
if (process.env.EXPECTED_INDEX) {
  const built = readFileSync(process.env.EXPECTED_INDEX, 'utf8');
  expectedAsset = (built.match(/assets\/[\w.-]+\.js/) || [])[0] || null;
  if (!expectedAsset) throw new Error(`could not find an asset reference in ${process.env.EXPECTED_INDEX}`);
  console.log(`waiting for the live site to serve this build's asset: ${expectedAsset}`);
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  let live = null;
  while (Date.now() < deadline) {
    live = await getText('/');
    if (live.status === 200 && live.text.includes(expectedAsset)) break;
    live = null;
    await sleep(15_000);
  }
  record('the live site serves THIS commit\'s build (by asset hash)', !!live,
    live ? expectedAsset : `still not serving ${expectedAsset} after ${WAIT_MINUTES}min`);
  if (!live) {
    // nothing else is meaningful against a stale/not-yet-deployed site
    const fails = results.filter((r) => !r.pass);
    console.log(`\n══════ LIVE SMOKE: ${results.length - fails.length}/${results.length} checks passed ══════`);
    fails.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
    process.exit(1);
  }
}

// ══ 1. the page itself
{
  const home = await getText('/');
  const ok = home.status === 200 && /Nash Equilibrium/i.test(home.text) && /assets\//.test(home.text);
  record('the live site serves the app page', ok, `status=${home.status}`);
}

// ══ 2. the page's own bundle resolves (catches a deploy where index.html
//      references a chunk that did not upload)
{
  const home = await getText('/');
  const asset = (home.text.match(/assets\/[\w.-]+\.js/) || [])[0];
  if (asset) {
    const js = await getText(`/${asset}`);
    record('the live page\'s JS bundle resolves', js.status === 200 && js.text.length > 1000,
      `status=${js.status} bytes=${js.text.length}`);
  } else {
    record('the live page\'s JS bundle resolves', false, 'no asset reference found in the page');
  }
}

// ══ 3. API liveness behind the same domain
{
  const r = await getText('/api/health');
  record('live /api/health is 200', r.status === 200, `status=${r.status}`);
  const nosniff = r.headers.get('x-content-type-options');
  const xfo = r.headers.get('x-frame-options');
  record('live security headers present', nosniff === 'nosniff' && xfo === 'DENY',
    `nosniff=${nosniff} xfo=${xfo}`);
}

// ══ 4. build metadata (informational: the version source updates with the
//      desktop release pipeline, which lags the web deploy — never a failure)
{
  const r = await getText('/api/version');
  let version = null;
  try { version = JSON.parse(r.text).version; } catch { /* not json */ }
  console.log(`INFO live /api/version → ${version} (repo: ${process.env.EXPECTED_VERSION || 'unknown'})`);
  record('live /api/version answers 200 JSON', r.status === 200 && version !== undefined,
    `status=${r.status} version=${version}`);
}

// ══ 5. the report route is wired and validating BEFORE any model call —
//      an invalid matrix must 400 without spending a token
{
  const r = await fetch(`${BASE}/api/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payoffs: { a11: 'not-a-number' } }),
  });
  record('live /api/report rejects an invalid matrix with 400 (no model call)',
    r.status === 400, `status=${r.status}`);
}

// ══ 6. CORS preflight still answers PATCH (the desktop save path — the exact
//      header that once broke every cross-origin save in production)
{
  const r = await fetch(`${BASE}/api/games`, {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'PATCH' },
  });
  const methods = r.headers.get('access-control-allow-methods') || '';
  record('live CORS preflight allows PATCH (desktop save path)',
    r.status === 200 && methods.includes('PATCH'), `status=${r.status} methods=${methods}`);
}

// ══ 7. the DMG download path — status-only, NEVER downloads the ~137 MB
//      file. Added 2026-09-02 after a real ~3.5-hour production outage that
//      no existing check (here or in CI) could see: a Content-Length >=
//      Cloud Run's documented 32 MiB HTTP/1 response cap made every PLAIN
//      GET (and every well-formed Range spanning >=32 MiB) of the live DMG
//      come back as a bare, header-less Google-Frontend HTTP 500 — while a
//      HEAD probe (headers only, never a body) and a small Range probe both
//      stayed comfortably under the cap and answered fine. So a check that
//      only ever reads headers, or only ever asks for a few bytes, cannot
//      reach this failure mode regardless of how many of them run — the bug
//      lives specifically in the FULL, UNRANGED download path. This is why
//      the fix (setContentLengthIfUnderCloudRunLimit in server.ts, ~line
//      1441) is verified here by an actual full GET, aborted right after the
//      response headers arrive so the check never pays for 137 MB of egress.
//
//      Deliberately asserted on STATUS ONLY: the fix's correct behaviour for
//      a large file is to OMIT Content-Length entirely once size is >= the
//      cap (falls back to chunked transfer, which Cloud Run's limit exempts)
//      — so a check that required Content-Length to be present would fail
//      against the FIXED server, not just the broken one. Content-Length is
//      still logged for diagnostics, never asserted on.
{
  // CodeRabbit (this round): neither fetch() call here had any bound, so a
  // connection that accepts and sends headers but then stalls (never sends
  // a body chunk, never closes) would hang this whole script — and by
  // extension the CI job's own timeout — rather than failing this ONE check
  // quickly with a clear reason. Verified a single AbortSignal passed to
  // fetch() itself also aborts a body read made AFTER fetch() already
  // resolved (Node 22 / undici): a local server that sends 200 headers then
  // never writes a body made `reader.read()` reject with TimeoutError at
  // the signal's own deadline, not hang. 15s is generous — the real
  // production endpoint answers in ~3s for this whole section.
  const DMG_BODY_TIMEOUT_MS = 15000;
  // The real DMG is ~137 MB (see this section's own header comment). A
  // Content-Range total this small could only mean a corrupted/degenerate
  // deploy (an empty or near-empty file uploaded by mistake) — CodeRabbit's
  // own suggested fix only excluded exactly 1, which a 2-byte "DMG" would
  // still pass; this floor is comfortably below the real size but far
  // enough above any degenerate case to have a real sanity meaning.
  const DMG_MIN_SANE_TOTAL_BYTES = 50_000_000;

  async function statusOnlyGet(path, headers) {
    let r;
    try {
      r = await fetch(`${BASE}${path}`, {
        ...(headers ? { headers } : {}),
        signal: AbortSignal.timeout(DMG_BODY_TIMEOUT_MS),
      });
    } catch (err) {
      // A connection that never even sends headers within the bound also
      // hits this same signal — degrade to a clean, assertable "failed"
      // result instead of an uncaught rejection crashing the whole script.
      return { status: 0, contentLength: null, contentRange: null, firstChunkBytes: 0, error: String(err) };
    }
    const status = r.status;
    const contentLength = r.headers.get('content-length');
    const contentRange = r.headers.get('content-range');
    // "Status-only" for the full, unranged request means never pulling the
    // (potentially 137 MB) body off the wire — but CodeRabbit is right that
    // cancelling WITHOUT reading anything first means a 200 status alone
    // doesn't prove data actually flowed: Express/Cloud Run can send
    // response headers before the GCS upstream stream produces its first
    // chunk, and if that upstream then fails or ends immediately, this
    // check would never see it. Read exactly the FIRST chunk the stream
    // hands back (whatever size the platform buffers — typically well under
    // 1 MB, nowhere near the 137 MB file), then cancel the rest. This proves
    // real bytes flowed without downloading anything close to the full file.
    let firstChunkBytes = 0;
    if (r.body) {
      const reader = r.body.getReader();
      try {
        const { value } = await reader.read();
        if (value) firstChunkBytes = value.byteLength;
      } catch { /* timeout/abort or any other read error; status is already captured */ }
      try { await reader.cancel(); } catch { /* best-effort */ }
    }
    return { status, contentLength, contentRange, firstChunkBytes };
  }

  /** Like statusOnlyGet, but actually reads the (bounded, small) body and
   * returns its total byte length instead of cancelling it immediately.
   * CodeRabbit (this round): the earlier version called `r.arrayBuffer()`
   * unconditionally — if a misbehaving server/proxy ignored the Range
   * header and returned the FULL 137 MB body (status 206 or 200), this
   * would buffer the entire file into memory before the assertion below
   * ever got to fail, defeating this whole section's own "NEVER downloads
   * the ~137 MB file" design goal. Reads incrementally instead and stops
   * as soon as it has proof the body is bigger than the single byte we
   * asked for (more than 1 byte accumulated) or the stream ends — whichever
   * comes first — then cancels, so at most a little over 1 extra chunk is
   * ever read regardless of how large the real body is. */
  async function boundedRangeGet(path, headers) {
    let r;
    try {
      r = await fetch(`${BASE}${path}`, {
        ...(headers ? { headers } : {}),
        signal: AbortSignal.timeout(DMG_BODY_TIMEOUT_MS),
      });
    } catch (err) {
      return { status: 0, contentLength: null, contentRange: null, bodyByteLength: 0, error: String(err) };
    }
    const status = r.status;
    const contentLength = r.headers.get('content-length');
    const contentRange = r.headers.get('content-range');
    let bodyByteLength = 0;
    if (r.body) {
      const reader = r.body.getReader();
      try {
        while (bodyByteLength <= 1) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) bodyByteLength += value.byteLength;
        }
      } catch { /* timeout/abort or any other read error; status is already captured */ }
      try { await reader.cancel(); } catch { /* best-effort */ }
    }
    return { status, contentLength, contentRange, bodyByteLength };
  }

  const full = await statusOnlyGet('/api/download/dmg');
  record('live DMG plain GET (no Range) is 200 with real data actually flowing, not a bare Cloud Run 500 or a stalled stream',
    full.status === 200 && full.firstChunkBytes > 0,
    `status=${full.status} firstChunkBytes=${full.firstChunkBytes} content-length=${full.contentLength ?? '(unset — expected once the file is >= the Cloud Run cap)'}`);

  const range = await boundedRangeGet('/api/download/dmg', { Range: 'bytes=0-0' });
  // CodeRabbit (this round, three times now): a bare status===206 check
  // could pass on a malformed or wrong partial response (some server/proxy
  // shapes return 206 without honoring the requested range) while resume
  // downloads stay broken — assert Content-Range echoes the exact 1-byte
  // span requested AND a sane total file size AND that the body actually
  // delivered is exactly that one byte, not 0 bytes or more.
  const rangeMatch = /^bytes 0-0\/(\d+)$/.exec(range.contentRange || '');
  const rangeTotal = rangeMatch ? Number(rangeMatch[1]) : null;
  // CodeRabbit (this round): a decimal digit string long enough (e.g. 310
  // nines) makes Number(...) overflow to Infinity, and `Infinity >=
  // DMG_MIN_SANE_TOTAL_BYTES` is true — a malformed Content-Range with an
  // absurd total would have passed. Number.isSafeInteger rejects Infinity
  // (and NaN, and anything beyond 2^53-1) before the size comparison.
  const hasSaneRangeTotal = Number.isSafeInteger(rangeTotal) && rangeTotal >= DMG_MIN_SANE_TOTAL_BYTES;
  record('live DMG 1-byte Range GET is 206 with a matching Content-Range, a sane total file size, and exactly 1 body byte (resumable downloads still work)',
    range.status === 206 && hasSaneRangeTotal && range.bodyByteLength === 1,
    `status=${range.status} content-range=${range.contentRange ?? '(unset)'} total=${rangeTotal ?? '(no match)'} bodyByteLength=${range.bodyByteLength}`);
}

// ══ 8. DEPLOY CONFIG, verified by behaviour rather than by reading env vars
//      (LIVE_DEEP=1 — spends two small model calls, so the deploy-verify run
//      sets it and the nightly monitor does not).
//
//      This is the only check in the pyramid that can see an env-var
//      regression. `gcloud run deploy --set-env-vars` REPLACES the service's
//      whole environment, so a name dropped from cloudbuild.yaml disappears
//      from production silently — the site still loads, /api/health still
//      answers 200, and the report surface just quietly falls back a rung.
//      src/cloudbuild.contract.test.ts guards the FILE; this guards the
//      SERVICE, which the Cloud Build trigger UI can still override.
if (process.env.LIVE_DEEP === '1') {
  // A non-tie fixture: reaches the payoff-template path, so `template` here
  // can only mean NASH_PAYOFF_TEMPLATE=1 is actually set on the revision.
  const rep = await fetch(`${BASE}/api/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payoffs: { a11: -2, a12: 1, a21: 1, a22: 0, b11: 1, b12: -2, b21: -2, b22: 1 } }),
  });
  const j = await rep.json().catch(() => ({}));
  record('live report runs the rung-3 templated path (NASH_PAYOFF_TEMPLATE=1)',
    rep.status === 200 && j.source === 'template', `status=${rep.status} source=${j.source}`);

  // A scenario comes back only when the provider credentials survived the
  // deploy AND REPORT_MODEL names a reachable model. "template prose, no
  // scenario" is the exact shape production degraded to on 2026-08-31.
  //
  // Check the SHAPE, not just truthiness: every field of SuggestedScenario is
  // optional and validateScenario does not require them, so `{}` and `[]` are
  // both truthy and would let this check pass on a scenario the UI cannot use.
  // The four option names are the load-bearing ones — they label the matrix and
  // drive the color-coding — so they must be non-empty strings.
  const sc = j.report?.suggestedScenario;
  const scLabels = ['row1', 'row2', 'col1', 'col2'];
  const scOk = !!sc && typeof sc === 'object' && !Array.isArray(sc)
    && scLabels.every((k) => typeof sc[k] === 'string' && sc[k].trim().length > 0);
  record('live report still invents a usable scenario (provider creds + REPORT_MODEL intact)',
    scOk,
    scOk ? `scenario "${sc.name ?? '(unnamed)'}" with all four labels`
      : `UNUSABLE — got ${JSON.stringify(sc)?.slice(0, 120) ?? 'nothing'}; creds or REPORT_MODEL may be lost in the deploy`);

  // b11 === b12 forces the tie branch, which a different flag governs.
  const tie = await fetch(`${BASE}/api/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payoffs: { a11: 2, a12: 0, a21: 1, a22: 3, b11: 1, b12: 1, b21: 0, b22: 2 } }),
  });
  const tj = await tie.json().catch(() => ({}));
  record('live tie game takes the templated tie path (NASH_LLM_TIES=template)',
    tie.status === 200 && tj.source === 'template', `status=${tie.status} source=${tj.source}`);
}

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ LIVE SMOKE: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length) fails.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
process.exit(fails.length ? 1 : 0);

/* INTEGRATION — /api/download/dmg against the real production bundle, streaming
 * from a FAKE GCS object (the shipping condition for the Cloud Run web path:
 * `GCS_BUCKET_NAME` set, `ELECTRON_USER_DATA_PATH` unset).
 *
 * THE DEFECT THIS GUARDS: `file.createReadStream().pipe(res)` shipped with NO
 * Content-Length header. The response streams ~120MB with no declared size, so
 * the browser shows an unknown-size download (no progress bar, no ETA) and a
 * client that checks Content-Length to detect a truncated transfer cannot tell
 * a good download from a dropped one. `getMetadata()` gives the real size
 * before the pipe starts; the GCS JSON API returns it as a STRING, which is
 * exactly the kind of value a careless `res.setHeader` would mis-serialize.
 *
 * A REAL GCS bucket needs credentials this harness must not have (and must not
 * spend Daniel's GCS bill on every CI run). `@google-cloud/storage` reads
 * `STORAGE_EMULATOR_HOST` and switches to it with NO auth — verified against
 * the real client (7.22.0): `exists()`/`getMetadata()` hit
 * `GET /b/<bucket>/o/<object>`, `createReadStream()` hits the same URL with
 * `?alt=media`, and a connection failure THROWS rather than resolving to
 * `exists() === false` (checked directly: ECONNREFUSED throws). So the fake
 * server below is not a guess about the wire format — it was probed.
 *
 * WHY cwd IS AN EMPTY TEMP DIR: `dotenv.config()` reads `.env` from the
 * server's cwd; running from the repo would load real credentials and stop
 * measuring the shipping condition. `env` is built from scratch, not spread
 * from `process.env`, for the same reason `desktop-persistence.test.mjs` does
 * it: a dev machine's exported GOOGLE_APPLICATION_CREDENTIALS must not leak in
 * and make this pass against a real bucket instead of the fake one.
 *
 *   node src/integration/dmg-download.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
const port = Number(process.env.DMG_TEST_PORT || 3109);
const fakeGcsPort = Number(process.env.DMG_TEST_GCS_PORT || 3110);
const BUCKET = 'fake-nash-bucket';
const DMG_OBJECT = 'Nash Equilibrium Simulator.dmg';
const DMG_CONTENT = Buffer.from('FAKE DMG BYTES '.repeat(500)); // 8000 bytes, distinctive

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

/**
 * A fake GCS JSON API: only the two calls this endpoint makes.
 *
 * `reportedSize`, when given, overrides the `size` field getMetadata() sees
 * WITHOUT changing how many bytes ?alt=media actually streams. That's what
 * lets the >=32 MiB Cloud Run threshold (below) be exercised without this
 * suite actually moving 32 MiB per test run: the app only ever reads the
 * declared size to decide whether to set Content-Length; it never compares
 * that against what the stream really delivers.
 */
function startFakeGcs({ dmgExists, reportedSize }) {
  const objectPath = `/b/${BUCKET}/o/${encodeURIComponent(DMG_OBJECT)}`;
  // Counts requests that actually fetch OBJECT BYTES (?alt=media) — the
  // thing a HEAD probe must never trigger. Exposed on the returned server so
  // the HEAD test below can assert on it directly, not infer it from timing.
  let mediaRequests = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === objectPath && u.searchParams.get('alt') === 'media') mediaRequests++;
    // db.json's own exists() check at startup (initDB) — always "not found" so
    // the server falls back to a fresh in-memory DB without touching disk.
    if (u.pathname !== objectPath) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 404, message: 'not found' } }));
      return;
    }
    if (!dmgExists) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 404, message: 'not found' } }));
      return;
    }
    if (u.searchParams.get('alt') === 'media') {
      // Real GCS honors a Range header on object media downloads; the fake
      // must too, or the "206 works end-to-end" checks below would pass for
      // the wrong reason (the real client's own slicing, not the server's).
      const range = req.headers.range;
      const m = typeof range === 'string' ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      if (m) {
        const start = Number(m[1]), end = Number(m[2]);
        res.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${start}-${end}/${DMG_CONTENT.length}`,
        });
        res.end(DMG_CONTENT.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(DMG_CONTENT);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      name: DMG_OBJECT, bucket: BUCKET,
      size: String(reportedSize ?? DMG_CONTENT.length),
      contentType: 'application/octet-stream',
    }));
  });
  server.mediaRequestCount = () => mediaRequests;
  return new Promise((resolve) => server.listen(fakeGcsPort, () => resolve(server)));
}

/**
 * `server.close()` is ASYNCHRONOUS (it stops accepting new connections and
 * resolves once existing ones finish) — an un-awaited close raced the very
 * next `startFakeGcs` call rebinding the SAME `fakeGcsPort`, which could fail
 * EADDRINUSE if the OS had not yet released the port (CodeRabbit caught
 * this). Await the real 'close' event instead of the synchronous call.
 */
function stopFakeGcs(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function boot(cwd, gcsEmulatorHost) {
  const child = spawn('node', [BUNDLE], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      NODE_ENV: 'production',
      PORT: String(port),
      GCS_BUCKET_NAME: BUCKET,
      STORAGE_EMULATOR_HOST: gcsEmulatorHost,
      GOOGLE_CLOUD_PROJECT: 'fake-project',
      // Deliberately NOT set: ELECTRON_USER_DATA_PATH, IS_ELECTRON — this is
      // the CLOUD RUN path, the only one that streams from GCS at all.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming ready (code ${child.exitCode})\n${log}`);
    }
    try {
      // Bounded: an UNBOUNDED fetch here could hang past this loop's own
      // 80-attempt/~20s retry budget if the health endpoint accepted the
      // connection but never completed the response (CodeRabbit caught
      // this) — the loop's timeout logic literally cannot run while this
      // one `await` is still pending.
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok && (await r.json())?.pid === child.pid) return child;
    } catch { /* not up yet, or the health check itself timed out */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready on ${port}\n${log}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((res) => child.once('exit', res));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  await ended;
  clearTimeout(timer);
}

const userData = mkdtempSync(path.join(tmpdir(), 'nash-dmg-'));
let srv = null;
let fakeGcs = null;

try {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. THE DEFECT: Content-Length is present and correct when the DMG exists
  // ───────────────────────────────────────────────────────────────────────────
  fakeGcs = await startFakeGcs({ dmgExists: true });
  srv = await boot(userData, `http://127.0.0.1:${fakeGcsPort}`);

  const res1 = await fetch(`http://127.0.0.1:${port}/api/download/dmg`);
  const cl = res1.headers.get('content-length');
  record('THE DEFECT: Content-Length header is present on the GCS-streamed DMG',
    cl !== null, `content-length: ${cl}`);
  record('Content-Length equals the real object size',
    cl === String(DMG_CONTENT.length), `got ${cl}, expected ${DMG_CONTENT.length}`);

  const body1 = Buffer.from(await res1.arrayBuffer());
  record('the streamed bytes match the declared Content-Length',
    body1.length === Number(cl), `streamed ${body1.length} bytes, declared ${cl}`);
  record('the streamed bytes are the real object content',
    body1.equals(DMG_CONTENT), `${body1.length} bytes`);
  record('Content-Disposition still names the file',
    (res1.headers.get('content-disposition') || '').includes('Nash Equilibrium Simulator.dmg'),
    res1.headers.get('content-disposition'));
  record('THE DEFECT (live-verified against production, curl -r 0-0): Accept-Ranges is advertised',
    res1.headers.get('accept-ranges') === 'bytes', res1.headers.get('accept-ranges'));

  // ── Resumable downloads: a real byte-range request (curl -r 0-0's shape) ──
  const rangeRes = await fetch(`http://127.0.0.1:${port}/api/download/dmg`, {
    headers: { range: 'bytes=0-0' },
  });
  const rangeBody = Buffer.from(await rangeRes.arrayBuffer());
  record('THE DEFECT (live-verified: curl -r 0-0 got a full 200 stream, range ignored): a Range request gets 206',
    rangeRes.status === 206, `status ${rangeRes.status}`);
  record('the 206 response carries a correct Content-Range',
    rangeRes.headers.get('content-range') === `bytes 0-0/${DMG_CONTENT.length}`,
    rangeRes.headers.get('content-range'));
  record('the 206 body is EXACTLY the requested single byte, not the whole file',
    rangeBody.length === 1 && rangeBody[0] === DMG_CONTENT[0],
    `${rangeBody.length} bytes`);

  // A mid-file range and an out-of-bounds range.
  const midRes = await fetch(`http://127.0.0.1:${port}/api/download/dmg`, {
    headers: { range: 'bytes=10-19' },
  });
  const midBody = Buffer.from(await midRes.arrayBuffer());
  record('a mid-file range returns exactly those 10 bytes',
    midRes.status === 206 && midBody.equals(DMG_CONTENT.subarray(10, 20)),
    `status ${midRes.status}, ${midBody.length} bytes`);

  const badRes = await fetch(`http://127.0.0.1:${port}/api/download/dmg`, {
    headers: { range: `bytes=${DMG_CONTENT.length + 100}-${DMG_CONTENT.length + 200}` },
  });
  record('a range entirely past the end of the file gets 416, not a silent 200',
    badRes.status === 416, `status ${badRes.status}`);

  // RFC 9110 §14.1.2 (CodeRabbit caught the pre-fix behavior): an explicit
  // last-byte-pos AT OR PAST the object's length is NOT an error — the
  // server must clamp it to size-1 and serve the rest of the file, not 416.
  // Only a first-byte-pos beyond the length is unsatisfiable.
  const overshootRes = await fetch(`http://127.0.0.1:${port}/api/download/dmg`, {
    headers: { range: `bytes=0-${DMG_CONTENT.length + 999999}` },
  });
  const overshootBody = Buffer.from(await overshootRes.arrayBuffer());
  record('THE DEFECT: an explicit range end past the object length is CLAMPED to size-1, not 416',
    overshootRes.status === 206
      && overshootRes.headers.get('content-range') === `bytes 0-${DMG_CONTENT.length - 1}/${DMG_CONTENT.length}`
      && overshootBody.equals(DMG_CONTENT),
    `status ${overshootRes.status}, content-range ${overshootRes.headers.get('content-range')}, ${overshootBody.length} bytes`);

  // DownloadModal.tsx's own existence check is a HEAD request — it must get
  // the same headers a GET would, WITHOUT opening a GCS read stream (that
  // would defeat the whole point of checking before downloading).
  const mediaCountBeforeHead = fakeGcs.mediaRequestCount();
  const headRes = await fetch(`http://127.0.0.1:${port}/api/download/dmg`, { method: 'HEAD' });
  const headBody = await headRes.arrayBuffer();
  record('THE DEFECT: a HEAD request gets a 200 with the real Content-Length, no body',
    headRes.status === 200 && headRes.headers.get('content-length') === String(DMG_CONTENT.length) && headBody.byteLength === 0,
    `status ${headRes.status}, content-length ${headRes.headers.get('content-length')}, body ${headBody.byteLength} bytes`);
  record('THE DEFECT: a HEAD request never opens a GCS media (?alt=media) read stream',
    fakeGcs.mediaRequestCount() === mediaCountBeforeHead,
    `media requests before: ${mediaCountBeforeHead}, after: ${fakeGcs.mediaRequestCount()}`);

  await stop(srv); srv = null;
  await stopFakeGcs(fakeGcs); fakeGcs = null;

  // ───────────────────────────────────────────────────────────────────────────
  // 1b. THE DEFECT (RED-DESKTOP-4/003): a >=32 MiB response must NOT carry a
  // fixed Content-Length, or Cloud Run's own documented HTTP/1 response-size
  // limit rejects it with a bare, header-less Google-Frontend 500 — verified
  // live (2026-09-02) against production: a plain GET with NO Range header
  // at all (not just a malformed one) 500s the exact same way once the DMG
  // exceeded 32 MiB, and pulling Cloud Run request logs by x-cloud-trace-
  // context confirmed the message "Response size was too large." This fake
  // GCS object reports a size at/above the 32 MiB threshold (via
  // `reportedSize`, NOT by actually streaming 32 MiB) so the boundary is
  // exercised without this suite moving real gigabytes.
  // ───────────────────────────────────────────────────────────────────────────
  const LIMIT = 32 * 1024 * 1024;
  fakeGcs = await startFakeGcs({ dmgExists: true, reportedSize: LIMIT });
  srv = await boot(userData, `http://127.0.0.1:${fakeGcsPort}`);

  const bigFull = await fetch(`http://127.0.0.1:${port}/api/download/dmg`);
  record('THE FIX: a full-file response AT the 32 MiB threshold has NO Content-Length',
    bigFull.status === 200 && bigFull.headers.get('content-length') === null,
    `status ${bigFull.status}, content-length ${bigFull.headers.get('content-length')}`);
  record('THE FIX: that response is chunked, which Cloud Run\'s 32 MiB limit exempts',
    (bigFull.headers.get('transfer-encoding') || '').includes('chunked'),
    bigFull.headers.get('transfer-encoding'));
  // drain the body so the socket can be reused for the next request
  await bigFull.arrayBuffer();

  const bigRange = await fetch(`http://127.0.0.1:${port}/api/download/dmg`, {
    headers: { range: `bytes=0-${LIMIT - 1}` }, // exactly 32 MiB requested
  });
  record('THE FIX: a 32 MiB RANGE response also has no Content-Length (still a real 206)',
    bigRange.status === 206 && bigRange.headers.get('content-length') === null
      && bigRange.headers.get('content-range') === `bytes 0-${LIMIT - 1}/${LIMIT}`,
    `status ${bigRange.status}, content-length ${bigRange.headers.get('content-length')}, `
    + `content-range ${bigRange.headers.get('content-range')}`);
  await bigRange.arrayBuffer();

  // A SMALL range on the SAME huge object must keep its Content-Length —
  // the common resumable-download-manager case must not lose its progress
  // bar just because the FILE happens to be large.
  const smallRangeOnBigFile = await fetch(`http://127.0.0.1:${port}/api/download/dmg`, {
    headers: { range: 'bytes=0-99' },
  });
  record('a small range on a huge file KEEPS Content-Length (progress bar preserved)',
    smallRangeOnBigFile.status === 206 && smallRangeOnBigFile.headers.get('content-length') === '100',
    `status ${smallRangeOnBigFile.status}, content-length ${smallRangeOnBigFile.headers.get('content-length')}`);
  await smallRangeOnBigFile.arrayBuffer();

  // ── RED-DESKTOP-4/003 + director's follow-up, live-reproduced (2026-09-02):
  // `bytes=0-0` alone already 206'd correctly on production (PR #82) — but
  // `bytes=0-0,5-5` (multi-range), `bytes=abc` (malformed), `items=0-1`
  // (wrong unit), and `bytes=-` (both sides empty) each got a bare, header-
  // less Cloud-Run/Google-Frontend 500 on the live 137 MB DMG. Read by hand,
  // server.ts's OWN Range regex (`^bytes=(\d*)-(\d*)$`, anchored) already
  // fails to match all four — none of them can EVER be `m`, so all four
  // ALREADY fell through to the graceful "ignore the header, serve the
  // whole file" branch per RFC 9110 §14.1.2 (unparseable/unsupported Range
  // -> ignore, not an error). The parser was never the bug: what turned
  // that graceful fallback into a live 500 was the SAME 32 MiB Cloud Run
  // response-size limit fixed above — the full-file branch unconditionally
  // declared Content-Length before this session's fix. Proven here by
  // running the identical five shapes against the >=32 MiB fake object: the
  // four "ignore" shapes must resolve 200 with NO Content-Length (the fix,
  // reused) and complete without a socket/protocol error; the one valid
  // shape must still 206 with the correct single-byte Content-Range.
  const rangeShapes = [
    { label: 'multi-range (bytes=0-0,5-5)', header: 'bytes=0-0,5-5', expectIgnored: true },
    { label: 'malformed (bytes=abc)', header: 'bytes=abc', expectIgnored: true },
    { label: 'wrong unit (items=0-1)', header: 'items=0-1', expectIgnored: true },
    { label: 'both sides empty (bytes=-)', header: 'bytes=-', expectIgnored: true },
    { label: 'valid single range (bytes=0-0), control', header: 'bytes=0-0', expectIgnored: false },
  ];
  for (const shape of rangeShapes) {
    let r;
    let threw = null;
    try {
      r = await fetch(`http://127.0.0.1:${port}/api/download/dmg`, { headers: { range: shape.header } });
      await r.arrayBuffer(); // must fully resolve — a Content-Length/actual-bytes mismatch throws here
    } catch (err) {
      threw = err;
    }
    record(`${shape.label}: request completes without a socket/protocol error`,
      threw === null, threw ? String(threw?.cause || threw) : 'ok');
    if (threw) continue;
    if (shape.expectIgnored) {
      record(`${shape.label}: ignored -> full file, 200, no Content-Length (Cloud Run limit exempt)`,
        r.status === 200 && r.headers.get('content-length') === null,
        `status ${r.status}, content-length ${r.headers.get('content-length')}`);
    } else {
      record(`${shape.label}: still honored as a real range -> 206 with a correct Content-Range`,
        r.status === 206 && r.headers.get('content-range') === `bytes 0-0/${LIMIT}`
          && r.headers.get('content-length') === '1',
        `status ${r.status}, content-range ${r.headers.get('content-range')}, content-length ${r.headers.get('content-length')}`);
    }
  }

  await stop(srv); srv = null;
  await stopFakeGcs(fakeGcs); fakeGcs = null;

  // Boundary: one byte UNDER the limit must still carry Content-Length —
  // proves this is a >= comparison, not an off-by-one that starts omitting
  // the header a byte too early for an otherwise-fine ~32 MiB download.
  fakeGcs = await startFakeGcs({ dmgExists: true, reportedSize: LIMIT - 1 });
  srv = await boot(userData, `http://127.0.0.1:${fakeGcsPort}`);
  const justUnder = await fetch(`http://127.0.0.1:${port}/api/download/dmg`);
  record('one byte UNDER the 32 MiB threshold still gets a real Content-Length',
    justUnder.status === 200 && justUnder.headers.get('content-length') === String(LIMIT - 1),
    `status ${justUnder.status}, content-length ${justUnder.headers.get('content-length')}`);
  // Deliberately NOT draining the body here: the declared Content-Length
  // (LIMIT - 1, ~32 MiB) is real and correct per the app's own logic, but
  // the FAKE GCS object behind it only actually streams the small
  // DMG_CONTENT buffer (see startFakeGcs's own doc comment) — a real
  // 32 MiB object would have no such mismatch, but making this fixture
  // stream true 32 MiB just to read past this header check would slow the
  // suite for nothing this check needs. Killing the server (below) closes
  // the socket outright rather than waiting out a body that will never
  // reach its declared length.
  await stop(srv); srv = null;
  await stopFakeGcs(fakeGcs); fakeGcs = null;

  // ───────────────────────────────────────────────────────────────────────────
  // 2. GCS says the object does not exist -> the existing 404 contract holds
  // ───────────────────────────────────────────────────────────────────────────
  fakeGcs = await startFakeGcs({ dmgExists: false });
  srv = await boot(userData, `http://127.0.0.1:${fakeGcsPort}`);
  const res2 = await fetch(`http://127.0.0.1:${port}/api/download/dmg`);
  const json2 = await res2.json().catch(() => null);
  record('a genuinely missing DMG object still 404s with the build-it-yourself message',
    res2.status === 404 && typeof json2?.message === 'string' && json2.message.includes('electron:dist'),
    `status ${res2.status}, ${JSON.stringify(json2)}`);
  await stop(srv); srv = null;
  await stopFakeGcs(fakeGcs); fakeGcs = null;

  // ───────────────────────────────────────────────────────────────────────────
  // 3. GCS IS UNREACHABLE (connection refused, not "object missing") — this
  // must be DISTINGUISHABLE from case 2. `file.exists()` throws on a network
  // failure (verified directly against the real client), so the outer
  // try/catch produces a 500 with no `message` field. A client that reuses
  // the 404 case's UI for this status would tell a real user hitting a
  // transient GCS outage "you must compile it yourself" — wrong, and the
  // fix for that lives in DownloadModal.tsx (see its own commit).
  // ───────────────────────────────────────────────────────────────────────────
  srv = await boot(userData, `http://127.0.0.1:${fakeGcsPort}`); // nothing listening on fakeGcsPort now
  const res3 = await fetch(`http://127.0.0.1:${port}/api/download/dmg`);
  const json3 = await res3.json().catch(() => null);
  record('an unreachable GCS backend answers 500, not the "not compiled" 404',
    res3.status === 500 && res3.status !== 404, `status ${res3.status}, ${JSON.stringify(json3)}`);
  record('the 500 case is shaped differently from the 404 case (no build-it-yourself message)',
    !(typeof json3?.message === 'string' && json3.message.includes('electron:dist')),
    JSON.stringify(json3));
  await stop(srv); srv = null;

} finally {
  await stop(srv);
  if (fakeGcs) await stopFakeGcs(fakeGcs);
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

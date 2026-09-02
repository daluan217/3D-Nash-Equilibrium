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

/** A fake GCS JSON API: only the two calls this endpoint makes. */
function startFakeGcs({ dmgExists }) {
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
      name: DMG_OBJECT, bucket: BUCKET, size: String(DMG_CONTENT.length),
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

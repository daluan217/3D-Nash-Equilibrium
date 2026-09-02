/* INTEGRATION — two concurrent game mutations on the HOSTED (GCS) path must
 * not silently clobber each other.
 *
 * THE DEFECT CodeRabbit found on THIS PR (2026-09-02, second CLI review
 * round): awaiting the real GCS write (so a save/update/delete route can
 * finally report a genuine failure instead of a false 200 — see
 * desktop-unwritable-save.test.mjs) opened a NEW race the old fire-and-
 * forget code never had. The desktop/local-file branch is a SYNCHRONOUS
 * write with no yield point, so two concurrent requests on that branch
 * cannot interleave at all on Node's single-threaded event loop — but the
 * GCS branch has a REAL network `await`, which is a genuine yield point:
 * request B's `loadDB()` can run while request A's write is still in
 * flight, both build a candidate off the SAME stale snapshot, and whichever
 * commits LAST silently overwrites the other's change in both GCS and
 * `inMemoryDb`.
 *
 * THE FIX: `serializeGameWrite` (server.ts) queues the ENTIRE read-build-
 * save sequence for all three game routes into one in-process chain — safe
 * because `cloudbuild.yaml`'s `--max-instances=1` (this same PR) guarantees
 * exactly one process ever runs, so there is no second process this queue
 * would need to coordinate with.
 *
 * WHY A CUSTOM FAKE GCS SERVER, not dmg-download.test.mjs's: `.save()` uses
 * the RESUMABLE upload protocol (POST .../o?uploadType=resumable to obtain
 * a session Location, then PUT the body to that Location) — probed directly
 * against the real client (7.22.0) rather than guessed, the same way
 * dmg-download.test.mjs's own fake GCS was built. An artificial delay on
 * the PUT step is what forces two concurrent requests to actually overlap;
 * without it, real localhost round-trips are fast enough that the race
 * window would rarely if ever open in a test run.
 *
 *   node src/integration/gcs-game-write-race.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path2 from 'node:path';

// The exact CRC32C (Castagnoli) implementation the real client validates a
// finalized upload against — NOT exported from the package's public entry
// point (its own package.json "exports" map blocks a bare-specifier deep
// import for any subpath). Resolve only the BARE specifier (which IS
// exported, via "main") to find the package's real on-disk location, then
// reach crc32c.js by a plain filesystem path from there — path-based
// resolution isn't governed by "exports", only specifier resolution is. No
// new dependency added.
const require = createRequire(import.meta.url);
const storageMainPath = require.resolve('@google-cloud/storage');
const crc32cModulePath = path2.join(path2.dirname(storageMainPath), 'crc32c.js');
const { CRC32C } = await import(`file://${crc32cModulePath}`);

// Reimplements server.ts's own hashPassword (server.ts:816, PASSWORD_ITERATIONS
// = 210_000) so a verified user can be SEEDED directly into the fake GCS's
// db.json — skipping the registration/email-verification flow entirely
// (hosted registration needs real SMTP, which is out of scope for this
// race-focused suite; auto-verify is desktop-only, gated by the SAME
// ELECTRON_USER_DATA_PATH that would also switch this test off the GCS
// branch it exists to exercise).
function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 210_000, 32, 'sha256');
  return `pbkdf2$210000$${b64url(salt)}$${b64url(hash)}`;
}

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
const PORT = process.env.GCS_RACE_PORT || '3121';
const BASE = `http://localhost:${PORT}`;
const GCS_PORT = Number(process.env.GCS_RACE_GCS_PORT || 3122);
const BUCKET = 'fake-nash-race-bucket';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// A verified user, seeded straight into the fake GCS's db.json (see the
// hashPassword note above) — skips registration/email-verification.
const PASSWORD = 'Racecondition1!';
const EMAIL = 'gcsrace@example.test';
const seedDb = {
  users: [{
    id: 'u_seed', username: 'gcsrace', email: EMAIL,
    passwordHash: hashPassword(PASSWORD), isVerified: true,
    verificationCode: '', verificationCodeExpires: 0,
  }],
  games: [],
};
const seedDbBytes = Buffer.from(JSON.stringify(seedDb), 'utf-8');

// ── fake GCS: exists()/getMetadata()/download() serve the SEEDED db.json
//    (probed shape, same as dmg-download.test.mjs's own fake — plain GET is
//    metadata, GET+?alt=media is the object's actual bytes); the
//    resumable-upload two-step write, with a controllable delay on the PUT
//    step so two concurrent server-side writes can be forced to overlap.
let putDelayMs = 0;
let writeCount = 0;
let lastWriteBody = null;
const sessions = new Map();
const fakeGcs = createServer((req, res) => {
  const u = new URL(req.url, `http://x`);
  if (req.method === 'GET' && u.pathname === `/b/${BUCKET}/o/db.json`) {
    if (u.searchParams.get('alt') === 'media') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(seedDbBytes);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      name: 'db.json', bucket: BUCKET, size: String(seedDbBytes.length),
      contentType: 'application/json',
    }));
    return;
  }
  if (req.method === 'POST' && u.pathname === `/upload/storage/v1/b/${BUCKET}/o`) {
    const sessionId = randomUUID();
    sessions.set(sessionId, true);
    res.writeHead(200, { Location: `http://127.0.0.1:${GCS_PORT}/upload-session/${sessionId}` });
    res.end();
    return;
  }
  if (req.method === 'PUT' && u.pathname.startsWith('/upload-session/')) {
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); });
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks);
      const finish = () => {
        writeCount++;
        lastWriteBody = bodyBuf.toString('utf-8');
        // The client validates upload integrity against the finalize
        // response's crc32c (its DEFAULT validation mode — base64 CRC32C,
        // Castagnoli, NOT the standard CRC32 any Node builtin computes)
        // — without a MATCHING one it treats a perfectly good upload as
        // corrupted, tries to auto-delete the object, and throws. Computed
        // from the ACTUAL bytes received via the client's own CRC32C class,
        // so it is always correct, never a fixed stub.
        const crc = new CRC32C();
        crc.update(bodyBuf);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          name: 'db.json', bucket: BUCKET, generation: String(writeCount), crc32c: crc.toString(),
        }));
      };
      if (putDelayMs > 0) setTimeout(finish, putDelayMs);
      else finish();
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 404, message: 'not found' } }));
});
await new Promise((r) => fakeGcs.listen(GCS_PORT, '127.0.0.1', r));

const userData = mkdtempSync(path.join(tmpdir(), 'nash-gcs-race-'));
let child = null;
async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        const { pid } = await r.json();
        if (pid === child.pid) return true;
      }
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}
child = spawn('node', [BUNDLE], {
  cwd: userData,
  env: {
    PATH: process.env.PATH, HOME: userData,
    NODE_ENV: 'production', PORT,
    GCS_BUCKET_NAME: BUCKET,
    STORAGE_EMULATOR_HOST: `http://127.0.0.1:${GCS_PORT}`,
    GOOGLE_CLOUD_PROJECT: 'fake-project',
    ADMIN_SECRET: 'ci-admin-secret-for-tests',
    // Deliberately NOT set: ELECTRON_USER_DATA_PATH, IS_ELECTRON — this is
    // the hosted/Cloud Run path, the only one that writes to GCS at all.
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
child.stdout.on('data', (d) => { bootLog += d; });
child.stderr.on('data', (d) => { bootLog += d; });

const MP = { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 };
async function call(method, url, body, token) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

try {
  if (!(await waitReady())) {
    console.error(`FAIL server never became ready\n${bootLog}`);
    process.exit(2);
  }

  const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  const token = login.json?.token;
  record('setup: logged in as the SEEDED verified user against the hosted (GCS) path',
    !!token, `status=${login.status} token present: ${!!token}`);

  // ══ Force two concurrent POSTs to overlap on the GCS write, by delaying
  //    the PUT step: fire both, only THEN let the writes complete.
  putDelayMs = 800;
  writeCount = 0;
  const postA = call('POST', '/api/games', { name: 'Race Game A', payoffs: MP }, token);
  await new Promise((r) => setTimeout(r, 100)); // let A's read/build run first, before its (delayed) write completes
  const postB = call('POST', '/api/games', { name: 'Race Game B', payoffs: MP }, token);
  const [resA, resB] = await Promise.all([postA, postB]);
  putDelayMs = 0;

  record('both concurrent POSTs report success',
    resA.status === 200 && resB.status === 200, `A=${resA.status} B=${resB.status}`);
  record('the fake GCS actually received two SEPARATE writes (the race window really opened)',
    writeCount === 2, `writeCount=${writeCount}`);

  const listed = await call('GET', '/api/games', undefined, token);
  const names = (listed.json ?? []).map((g) => g.name).sort();
  record('THE FIX: BOTH concurrent games survive — neither write silently clobbered the other',
    names.includes('Race Game A') && names.includes('Race Game B') && names.length === 2,
    `names=${JSON.stringify(names)}`);

  // The LAST thing actually written to the fake GCS must itself contain
  // BOTH games — proving the queue re-read the committed state before
  // building the second candidate, not just that both HTTP responses
  // happened to look fine.
  let lastWriteGameCount = -1;
  try { lastWriteGameCount = JSON.parse(lastWriteBody ?? '{}')?.games?.length ?? -1; } catch { /* leave -1 */ }
  record('the FINAL write to GCS itself contains both games, not just one overwriting the other',
    lastWriteGameCount === 2, `games in last write: ${lastWriteGameCount}`);
} finally {
  if (child && child.exitCode === null) {
    const ended = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), 4000);
    await ended; clearTimeout(t);
  }
  await new Promise((r) => fakeGcs.close(r));
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n══════ GCS GAME-WRITE RACE: ${results.length - failed.length}/${results.length} checks passed ══════`);
if (failed.length > 0) {
  console.error(`\n${failed.length} FAILURE(S):`);
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

/* INTEGRATION — server.ts's GCS persistence path (`saveDB`/`initDB`) against
 * a FAKE `@google-cloud/storage` object, over real HTTP requests against the
 * real production artifact, under the HOSTED shipping condition
 * (`GCS_BUCKET_NAME` set, `ELECTRON_USER_DATA_PATH` unset).
 *
 * THE DEFECT THIS GUARDS (round3/findings/RED-DESKTOP-3/
 * 003-cloud-gcs-save-races.md): `saveDB()`'s GCS branch was an un-awaited,
 * unserialized `import(...).then(save).catch(log)` fired fresh on EVERY
 * call, with NO `ifGenerationMatch` precondition. Two consequences, both
 * silent (the request that triggered each save always returned success):
 *
 *   1. SINGLE-INSTANCE: N saves in quick succession fire N independent,
 *      overlapping upload requests with no ordering guarantee between them.
 *   2. MULTI-INSTANCE: production runs `maxScale=20` with no minScale, so a
 *      deploy rollover (or any burst) runs the old and new revisions —
 *      TWO INSTANCES, two independent `inMemoryDb` snapshots — concurrently.
 *      With no precondition, whichever instance's upload lands last wins
 *      OUTRIGHT: the whole object is replaced, silently erasing whatever
 *      the other instance had just saved.
 *
 * THE FIX: `scheduleGcsSave()` coalesces saves per process (never more than
 * one upload in flight; extra saves while one is in flight just mark "send
 * once more" rather than firing their own upload) and `uploadDbToGcs` sets
 * `preconditionOpts.ifGenerationMatch`, re-downloading/union-merging/
 * retrying once on a 412 conflict.
 *
 * WHY A FAKE GCS, NOT A REAL BUCKET: no real credentials, no real spend, and
 * deterministic control over generation numbers and response timing that a
 * real bucket would not give a CI run. `STORAGE_EMULATOR_HOST` is the same
 * mechanism `dmg-download.test.mjs` uses; the upload wire format
 * (`resumable:false` -> a single `multipart/related` POST,
 * `ifGenerationMatch` as a QUERY PARAMETER, 412 on mismatch, `validation:
 * false` skips the client's own MD5 check) was probed directly against the
 * real `@google-cloud/storage` client (7.22.0) before writing this fake.
 *
 * REPRODUCED FIRST AGAINST UNFIXED CODE (see this round's STATE.md /
 * REPORT): with `git stash` reverting server.ts to `origin/main`, case (a)
 * showed N saves firing N independent upload requests (no coalescing), and
 * case (b) showed the losing instance's game silently absent from the fake
 * bucket's final stored content — both exactly as this suite asserts should
 * NOT happen on the fixed tree.
 *
 *   node src/integration/gcs-db-saves.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
const BUCKET = 'fake-nash-db-bucket';
const OBJECT = 'db.json';
const VERSION_OBJECT = 'app-version.json';

// 12 pre-existing + 9 deadline (section 4) + 3 hung-re-sync (section 5)
// + 2 unread-store gate (section 3) + 12 shape/legacy-warning (6) + 12 merge (7, 7b, 7c incl. rename visibility, 7d) + 3 outage/drain (8) + 4 abandoned (9, 9b) + 2 no-generation (10) + 3 SMTP deadline + feedback injection (11) + 2 fresh reads (12) + 2 auth field types (13) + 2 412 storm (14) + 2 provider hang (15) + 2 re-check straddle (16) + 2 generation race (17) + 2 re-check cost (18) + 2 dropped-read peer write (19) + 2 backoff freshness (20) + 2 account conflict (21) + 1 suite-wide precondition.
// Calibrated by RUNNING the suite, not by counting by eye — this constant has
// now been wrong twice (22 vs 21, then 21 vs 23) and the floor caught it both
// times, which is the whole point of declaring rather than counting.
const EXPECTED_CHECKS = 109;
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function parseMultipart(contentType, rawBody) {
  const m = /boundary=([^;]+)/.exec(contentType || '');
  if (!m) return [];
  const boundary = m[1];
  const parts = rawBody.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== '--');
  const out = [];
  for (const part of parts) {
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    let content = part.slice(idx + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    out.push(content);
  }
  return out;
}

/**
 * A fake GCS JSON/upload API for exactly one object (`db.json`): the four
 * calls server.ts's GCS path makes — `exists()`/`getMetadata()`/
 * `download()` (all GET, `?alt=media` distinguishes download) and
 * `save()` (POST, `uploadType=multipart`, optional `ifGenerationMatch`
 * query param).
 */
// Every db.json upload any fake saw without a numeric generation precondition.
// What GCS does with `ifGenerationMatch=` (empty) is not something this suite
// can know, so SENDING one is the defect: an unread store written blindly.
const unconditionalUploads = [];
function startFakeGcsDb({ port, initialContent, initialGeneration = 1, deferListen = false }) {
  let stored = initialContent; // null = object does not exist
  let generation = initialGeneration;
  const uploadLog = []; // { atMs, ifGenerationMatch, body }
  let uploadDelayMs = 0, omitGeneration = false, dropUploads = false, afterStoreOnce = null, n412 = 0;
  let readDelay = { meta: 0, media: 0 }, metaGets = 0, stale404s = 0, afterMetaOnce = null, failUploads = false;
  const readLog = []; // media GETs: { arrivedGen, want, atMs, doneMs }
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const objectPath = `/b/${BUCKET}/o/${encodeURIComponent(OBJECT)}`;

    if (req.method === 'GET' && u.pathname === objectPath) {
      // Metadata: `meta` delay is inbound latency (read AFTER it). Download:
      // read on arrival, `media` delay is a slow transfer, so a download can
      // straddle a write. A generation no longer live on arrival is a 404.
      const media = u.searchParams.get('alt') === 'media', want = u.searchParams.get('generation');
      const answer = (seen, seenGen, entry) => {
        if (entry) entry.doneMs = Date.now() - startedAt;
        if (seen === null || (media && want !== null && want !== String(seenGen))) {
          if (media && seen !== null) stale404s += 1;
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 404, message: 'not found' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(media ? seen : JSON.stringify({ name: OBJECT, bucket: BUCKET, generation: String(seenGen), size: String(seen.length) }));
        if (!media && afterMetaOnce) { const f = afterMetaOnce; afterMetaOnce = null; stored = f(stored); generation += 1; }
      };
      if (media) {
        const entry = { arrivedGen: generation, want, atMs: Date.now() - startedAt };
        readLog.push(entry);
        const seen = stored, seenGen = generation;
        if (readDelay.media > 0) setTimeout(() => answer(seen, seenGen, entry), readDelay.media); else answer(seen, seenGen, entry);
      } else {
        metaGets += 1;
        const now = () => answer(stored, generation, null);
        if (readDelay.meta > 0) setTimeout(now, readDelay.meta); else now();
      }
      return;
    }

    if (req.method === 'POST' && u.pathname === `/upload/storage/v1/b/${BUCKET}/o`) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const parts = parseMultipart(req.headers['content-type'], body);
        const content = parts[1] ?? ''; // part 0 = metadata JSON, part 1 = the actual data
        const ifGenerationMatch = u.searchParams.get('ifGenerationMatch');
        if (!/^\d+$/.test(ifGenerationMatch ?? '')) unconditionalUploads.push({ port, ifGenerationMatch });

        if (uploadDelayMs > 0) await new Promise((r) => setTimeout(r, uploadDelayMs));
        if (dropUploads) { uploadLog.push({ atMs: Date.now() - startedAt, ifGenerationMatch, body: content, dropped: true }); return; }

        uploadLog.push({ atMs: Date.now() - startedAt, ifGenerationMatch, body: content });
        if (failUploads) { uploadLog.at(-1).failed = true; res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 503, message: 'Service Unavailable' } })); return; }

        if (ifGenerationMatch !== null) {
          const want = ifGenerationMatch === '0' ? null : String(generation);
          const have = stored === null ? null : String(generation);
          const matches = ifGenerationMatch === '0' ? stored === null : ifGenerationMatch === have;
          if (!matches) {
            n412 += 1;
            res.writeHead(412, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 412, message: 'Precondition Failed' } }));
            return;
          }
        }
        stored = content;
        generation += 1;
        uploadLog.at(-1).landedGen = generation;
        res.writeHead(200, { 'content-type': 'application/json' });
        const answer = { name: OBJECT, bucket: BUCKET, generation: String(generation), size: String(stored.length) };
        if (omitGeneration) { omitGeneration = false; delete answer.generation; }
        res.end(JSON.stringify(answer));
        if (afterStoreOnce) { const f = afterStoreOnce; afterStoreOnce = null; stored = f(stored); generation += 1; } // a peer writes right after us
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 404 } }));
  });

  const controls = {
    close: () => new Promise((r) => server.close(() => r())),
    getStored: () => stored,
    setStored: (v) => { stored = v; },
    getGeneration: () => generation,
    uploadCount: () => uploadLog.length,
    uploadLog: () => uploadLog,
    setUploadDelayMs: (ms) => { uploadDelayMs = ms; },
    omitGenerationOnce: () => { omitGeneration = true; },
    dropUploads: (v) => { dropUploads = v; }, // accept, never store, never answer
    peerWrite: (content) => { stored = content; generation += 1; },
    afterStoreOnce: (f) => { afterStoreOnce = f; },
    count412: () => n412,
    failUploads: (v) => { failUploads = v; }, // every upload answers 503 (the pump backs off)
    setReadDelayMs: (meta, media) => { readDelay = { meta, media }; },
    afterMetaOnce: (f) => { afterMetaOnce = f; }, // a peer writes right after our metadata GET is answered
    metaGets: () => metaGets, stale404s: () => stale404s, readLog: () => readLog,
    // For the "GCS was unreachable at boot, comes back later" case: the
    // server object exists (so a spawned process pointed at `port` gets
    // ECONNREFUSED, not a slow timeout) but does not accept connections
    // until this is called.
    listen: () => new Promise((r) => server.listen(port, () => r())),
  };
  if (deferListen) return controls;
  return new Promise((resolve) => { server.listen(port, () => resolve(controls)); });
}

function startDeadlineGcs(port, initialContent) {
  let stored = initialContent, generation = 1, hungObject = null, delayedObject = null;
  let readDelayMs = 0, hangUploads = false;
  const reads = [], uploads = [], sockets = new Set(), timers = new Set();
  const base = `/b/${BUCKET}/o/`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.pathname.startsWith(base) ? decodeURIComponent(u.pathname.slice(base.length)) : null;
    const reply = () => {
      if (req.method === 'GET' && name === OBJECT) {
        if (u.searchParams.get('alt') === 'media') { res.writeHead(200); res.end(stored); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name, bucket: BUCKET, generation: String(generation), size: String(stored.length) })); return;
      }
      if (req.method === 'GET' && name === VERSION_OBJECT) {
        if (u.searchParams.get('alt') === 'media') { res.writeHead(200); res.end('{"version":"0.0.225"}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name, bucket: BUCKET, size: '21' })); return;
      }
      if (req.method === 'POST' && u.pathname === `/upload/storage/v1/b/${BUCKET}/o`) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          uploads.push(parseMultipart(req.headers['content-type'], body)[1] ?? '');
          if (!/^\d+$/.test(u.searchParams.get('ifGenerationMatch') ?? '')) unconditionalUploads.push({ port, ifGenerationMatch: u.searchParams.get('ifGenerationMatch') });
          if (hangUploads) return;
          stored = uploads.at(-1); generation += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            name: OBJECT, bucket: BUCKET, generation: String(generation), size: String(stored.length),
          }));
        });
        return;
      }
      res.writeHead(404); res.end();
    };
    if (req.method === 'GET' && name) reads.push({ name, alt: u.searchParams.get('alt') });
    if (req.method === 'GET' && name === hungObject) return;
    if (req.method === 'GET' && name === delayedObject && readDelayMs > 0) {
      const timer = setTimeout(() => { timers.delete(timer); reply(); }, readDelayMs);
      timers.add(timer); return;
    }
    reply();
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return new Promise((resolve) => server.listen(port, () => resolve({
    close: () => new Promise((done) => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      server.close(done);
    }),
    reads: () => reads, uploads: () => uploads,
    stored: () => stored,
    hang: (name) => { hungObject = name; },
    delay: (name, ms) => { delayedObject = name; readDelayMs = ms; },
    hangUploads: (v) => { hangUploads = v; },
  })));
}

function spawnServer(cwd, thePort, gcsPort, extraEnv = {}) {
  return spawn('node', [BUNDLE], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      NODE_ENV: 'production',
      PORT: String(thePort),
      GCS_BUCKET_NAME: BUCKET,
      STORAGE_EMULATOR_HOST: `http://127.0.0.1:${gcsPort}`,
      GOOGLE_CLOUD_PROJECT: 'fake-project',
      // Deliberately NOT set: ELECTRON_USER_DATA_PATH, IS_ELECTRON — this is
      // the CLOUD RUN path, the only one that ever writes db.json to GCS.
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady(child, thePort) {
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming ready on ${thePort} (code ${child.exitCode})\n${log}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${thePort}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok && (await r.json())?.pid === child.pid) return { child, log: () => log };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready on ${thePort}\n${log}`);
}

async function stop(child) {
  // A child that already left by SIGNAL has exitCode === null but signalCode set;
  // waiting on its 'exit' event again would never resolve (unsettled top-level await).
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise((res) => child.once('exit', res));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  await ended;
  clearTimeout(timer);
}

async function waitUntil(predicate, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

// Hosted registration requires real SMTP (500s without it — no auto-verify
// fallback on this path, unlike desktop). Seeding a pre-verified user
// directly into the fake GCS object's initial content sidesteps that
// entirely: a LEGACY base64 password hash, the exact shape
// desktop-recovery-hint.test.mjs already proved server.ts accepts and
// transparently rehashes to pbkdf2 on first login.
function seededUser(id, username, email, password) {
  return {
    id, username, email,
    passwordHash: Buffer.from(password).toString('base64'),
    isVerified: true, verificationCode: '', verificationCodeExpires: 0,
  };
}

const gcsPortA = Number(process.env.GCS_DB_TEST_GCS_PORT || 3130);
let srv = null, fakeGcs = null;
// Every child process, fake bucket and temp dir is registered here as it is
// created, so `finally` can release ALL of them — not just the two variables
// that happen to be in scope — when an assertion throws mid-run (otherwise
// orphans hold ports 3131-3151 and the rerun fails for a confusing second reason).
const children = [], fakes = [], tmpDirs = [];
const track = (c) => { children.push(c); return c; };
const trackFake = (f) => { fakes.push(f); return f; };
const trackDir = (d) => { tmpDirs.push(d); return d; };

try {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. SINGLE-PROCESS: N rapid saves must COALESCE, not fire N independent
  // uploads. The fake server holds the FIRST upload response for a while, so
  // several more saves pile up behind it before any second upload can start.
  // ───────────────────────────────────────────────────────────────────────────
  const seededDb1 = { users: [seededUser('u_gcsrace', 'gcsraceuser', 'gcsraceuser@example.test', 'Sup3rSecret!23')], games: [] };
  fakeGcs = await trackFake(startFakeGcsDb({ port: gcsPortA, initialContent: JSON.stringify(seededDb1) }));
  const port1 = Number(process.env.GCS_DB_TEST_PORT || 3131);
  srv = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcsdb-'))), port1, gcsPortA)), port1);

  // Login (not register — see the seededUser comment above) ALSO calls
  // saveDB internally (it rehashes the legacy password on first use) — let
  // that settle cleanly, undelayed, before measuring the 4 games' own
  // upload count, or it would inflate it and make the assertion below
  // about something other than what it claims to be about.
  const login = await fetch(`http://127.0.0.1:${port1}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'gcsraceuser@example.test', password: 'Sup3rSecret!23' }),
  });
  const token = (await login.json())?.token;
  record('fixture precondition: login with the seeded (legacy-hash) user returns a token',
    typeof token === 'string' && token.length > 0, `status ${login.status}`);
  await new Promise((r) => setTimeout(r, 500)); // let register+login's own uploads fully settle
  const uploadsBeforeGames = fakeGcs.uploadCount();

  const saveGameAuthed = (name) => fetch(`http://127.0.0.1:${port1}/api/games`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }),
  });

  fakeGcs.setUploadDelayMs(1200);
  const saveResults = await Promise.all(
    ['Game-1', 'Game-2', 'Game-3', 'Game-4'].map((n) => saveGameAuthed(n))
  );
  record('all 4 rapid saves are accepted (200) regardless of GCS upload timing',
    saveResults.every((r) => r.status === 200), saveResults.map((r) => r.status).join(','));

  // The saves are accepted: drop the artificial delay so the coalesced
  // follow-up lands quickly, then POLL for the final content with a deadline
  // instead of sleeping a fixed margin (~100 ms of slack on a loaded runner).
  fakeGcs.setUploadDelayMs(0);
  {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      let names = null;
      try { names = JSON.parse(fakeGcs.getStored()).games.map((g) => g.name); } catch { /* not parseable yet */ }
      if (names && names.length >= 4) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const gameUploadCount = fakeGcs.uploadCount() - uploadsBeforeGames;
  record('THE DEFECT: 4 rapid saves produce at most 2 NEW upload requests (coalesced), not 4',
    gameUploadCount <= 2, `${gameUploadCount} upload request(s) for the 4 games: ${JSON.stringify(fakeGcs.uploadLog().slice(uploadsBeforeGames))}`);

  // Parsed defensively: on unfixed code the uploads use the RESUMABLE
  // protocol (no `resumable:false`), which this fake does not implement, so
  // `stored` can end up empty/unparseable there — that failure mode is
  // itself evidence of the same underlying problem (no serialization means
  // no control over what shape lands), not something worth crashing the
  // whole suite over.
  let finalNames = null;
  try {
    const finalStored = JSON.parse(fakeGcs.getStored());
    finalNames = finalStored.games.map((g) => g.name).sort();
  } catch { /* see comment above */ }
  record('the final persisted content has ALL 4 games, not just the first',
    JSON.stringify(finalNames) === JSON.stringify(['Game-1', 'Game-2', 'Game-3', 'Game-4']),
    JSON.stringify(finalNames));

  await stop(srv.child); srv = null;
  await fakeGcs.close(); fakeGcs = null;

  // ───────────────────────────────────────────────────────────────────────────
  // 2. MULTI-INSTANCE: two REAL server.cjs processes, same fake bucket, each
  // saves a DIFFERENT game. On unfixed code (no precondition) whichever
  // instance's upload lands last wins OUTRIGHT — the other's game vanishes.
  // The fake server is told to delay instance X's upload so instance Y's
  // lands first, forcing X into exactly the generation-conflict path.
  // ───────────────────────────────────────────────────────────────────────────
  // Both instances boot from the SAME seeded object, so BOTH users must be
  // present in it from the start — each instance's own initDB() reads the
  // whole thing regardless of which user that instance will act as.
  const seededDb2 = {
    users: [
      seededUser('u_x', 'userx', 'userx@example.test', 'Sup3rSecret!23'),
      seededUser('u_y', 'usery', 'usery@example.test', 'Sup3rSecret!23'),
    ],
    games: [],
  };
  // Offset by 2, not 1: with the CI env values (GCS_DB_TEST_GCS_PORT=3130,
  // GCS_DB_TEST_PORT=3131) a +1 offset collides with port1 — the section-1
  // SERVER's own port, not another fake-GCS port. That only "worked" because
  // section 1's server is stopped before this runs; any change to either env
  // var, or a lingering socket, would make the bind fail (CodeRabbit caught
  // this). +2 stays clear of both the port1 server and the portX/portY range
  // below (port1 + 10 / + 11).
  const gcsPortB = gcsPortA + 2;
  fakeGcs = await trackFake(startFakeGcsDb({ port: gcsPortB, initialContent: JSON.stringify(seededDb2) }));

  const portX = port1 + 10, portY = port1 + 11;
  const cwdX = trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcsdb-x-')));
  const cwdY = trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcsdb-y-')));
  const childX = track(spawnServer(cwdX, portX, gcsPortB));
  const childY = track(spawnServer(cwdY, portY, gcsPortB));
  const readyX = await waitReady(childX, portX);
  const readyY = await waitReady(childY, portY);

  async function loginAs(port, email) {
    const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Sup3rSecret!23' }),
    });
    return (await r.json())?.token;
  }
  const tokenX = await loginAs(portX, 'userx@example.test');
  const tokenY = await loginAs(portY, 'usery@example.test');
  record('fixture precondition: both instances have a usable token',
    typeof tokenX === 'string' && typeof tokenY === 'string', `X:${typeof tokenX} Y:${typeof tokenY}`);

  // Let both instances' login-triggered rehash saves fully settle before
  // controlling the game-save race — otherwise their own upload timing
  // adds noise to a race this test needs to control deterministically.
  await new Promise((r) => setTimeout(r, 800));

  // X's game-save upload is held (deterministically forcing it to be the
  // LOSING side of the generation race), then Y's lands cleanly while X's
  // is still in flight, THEN X's held request finally completes and hits
  // its precondition mismatch — the exact interleaving, not a timing hope.
  fakeGcs.setUploadDelayMs(800);
  const resX = await fetch(`http://127.0.0.1:${portX}/api/games`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenX}` },
    body: JSON.stringify({ name: 'Game-X', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }),
  });
  record('X\'s save is accepted (the HTTP response never waits on the GCS upload)', resX.status === 200, `status ${resX.status}`);
  // X's own GCS upload request needs a moment to actually reach the fake
  // server and start its 800ms hold before Y's (undelayed) request fires —
  // otherwise Y's could race ahead of X's arriving at all, which would
  // test nothing about the conflict path this section exists to exercise.
  await new Promise((r) => setTimeout(r, 250));
  // A second X save lands WHILE X's first upload is held. The 412 merge used
  // the snapshot that upload started with and wrote it over the current
  // state, so this game vanished from memory and from GCS.
  const resX2 = await fetch(`http://127.0.0.1:${portX}/api/games`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenX}` },
    body: JSON.stringify({ name: 'Game-X2', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }),
  });
  fakeGcs.setUploadDelayMs(0);
  const resY = await fetch(`http://127.0.0.1:${portY}/api/games`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenY}` },
    body: JSON.stringify({ name: 'Game-Y', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }),
  });
  record('Y\'s save is accepted', resY.status === 200, `status ${resY.status}`);

  // Give X's delayed upload (and its conflict-retry, if any) time to land.
  await new Promise((r) => setTimeout(r, 2500));

  let finalMultiNames = null;
  try {
    const finalMulti = JSON.parse(fakeGcs.getStored());
    finalMultiNames = finalMulti.games.map((g) => g.name).sort();
  } catch { /* unfixed code may use the resumable protocol this fake doesn't implement */ }
  record('THE DEFECT: BOTH instances\' games survive after the conflict (union merge), not just the last writer',
    ['Game-X', 'Game-Y'].every((n) => finalMultiNames?.includes(n)), JSON.stringify(finalMultiNames));
  const listX = await fetch(`http://127.0.0.1:${portX}/api/games`, { headers: { authorization: `Bearer ${tokenX}` } })
    .then((r) => r.json()).catch(() => null);
  record('a save committed DURING the conflicted upload survives the 412 merge, on GCS and in memory',
    resX2.status === 200 && JSON.stringify(finalMultiNames) === JSON.stringify(['Game-X', 'Game-X2', 'Game-Y'])
      && Array.isArray(listX) && listX.some((g) => g.name === 'Game-X2'),
    `X2=${resX2.status} stored=${JSON.stringify(finalMultiNames)} listX=${JSON.stringify(Array.isArray(listX) ? listX.map((g) => g.name) : listX)}`);

  await stop(childX);
  await stop(childY);
  await fakeGcs.close(); fakeGcs = null;

  // ───────────────────────────────────────────────────────────────────────────
  // 3. THE NULL-GENERATION HAZARD (CodeRabbit): `initDB`'s GCS read can throw
  // (network error, GCS genuinely unreachable at boot) and falls back to
  // `loadDBFromFile()` — in hosted mode that reads a LOCAL file that does not
  // exist on Cloud Run, so `inMemoryDb` becomes an EMPTY database while
  // `gcsGeneration` stays null. An unconditional upload in that state (no
  // precondition at all, since there is no generation to match against)
  // would REPLACE the real remote object — every other user's data — with
  // that empty fallback the moment this process saves anything.
  //
  // Reproduced via a fake GCS server that is constructed but NOT listening
  // yet: the spawned server's boot-time GCS read gets a real, immediate
  // ECONNREFUSED (not a slow timeout), so it takes the exact fallback path.
  // The fake is THEN started, pre-seeded with a game that only ever existed
  // on "GCS" — never seen by this process — before the process's own save
  // fires, so a defect here shows up as that pre-existing game vanishing.
  // ───────────────────────────────────────────────────────────────────────────
  const gcsPortC = gcsPortA + 4;
  const fakeGcsDeferred = trackFake(startFakeGcsDb({
    port: gcsPortC,
    initialContent: JSON.stringify({
      users: [seededUser('u_z', 'userz', 'userz@example.test', 'Sup3rSecret!23')],
      games: [{ id: 'g_preexisting', userId: 'u_z', name: 'Preexisting-Game', description: '', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, createdAt: new Date().toISOString() }],
    }),
    deferListen: true,
  }));

  const portZ = port1 + 20;
  const childZ = track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcsdb-z-'))), portZ, gcsPortC));
  await waitReady(childZ, portZ); // boots fine even though its GCS read just failed — falls back to an empty local DB

  const healthZ = await fetch(`http://127.0.0.1:${portZ}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  record('fixture precondition: the process is up despite GCS being unreachable at boot (falls back, does not crash)',
    healthZ?.status === 200, `status ${healthZ?.status}`);
  // Hit b: the empty stand-in must not answer for the store. userz exists
  // only on GCS; before the fix this login was a 401 ("no such account").
  const loginDown = await fetch(`http://127.0.0.1:${portZ}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'userz@example.test', password: 'Sup3rSecret!23' }), signal: AbortSignal.timeout(30000),
  }).catch(() => null);
  record('THE DEFECT: while the store is unread, a DB route answers 503 + Retry-After, not the empty stand-in\'s 401',
    loginDown?.status === 503 && loginDown.headers.get('retry-after') === '30', `status ${loginDown?.status}`);

  // Now "GCS comes back" — the fake starts accepting connections, already
  // holding the pre-existing game this process never saw. Registration is
  // the write trigger: even without SMTP
  // configured (this hosted path 500s on the email step), server.ts's own
  // register handler calls saveDB() to ADD the new user BEFORE attempting
  // to send the verification email. The pending row stays after the failed
  // send (sweep 6: a retry re-sends its code), so that write must land
  // merged with what GCS already held.
  await fakeGcsDeferred.listen();

  const regZ = await fetch(`http://127.0.0.1:${portZ}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'freshz', email: 'freshz@example.test', password: 'Sup3rSecret!23' }),
  });
  record('fixture precondition: registration reaches the (expected, no-SMTP) 500 — proves the save attempts actually ran',
    regZ.status === 500, `status ${regZ.status}`);

  await new Promise((r) => setTimeout(r, 1500)); // let the async GCS re-sync + both uploads land

  let finalZNames = null, finalZUsernames = null;
  try {
    const finalZ = JSON.parse(fakeGcsDeferred.getStored());
    finalZNames = finalZ.games.map((g) => g.name).sort();
    finalZUsernames = finalZ.users.map((u) => u.username).sort();
  } catch { /* see the try/catch note in section 1 */ }
  record('THE DEFECT: the pre-existing game (that this process never read) SURVIVES the save, not silently erased',
    JSON.stringify(finalZNames) === JSON.stringify(['Preexisting-Game']), JSON.stringify(finalZNames));
  record('the failed registration\'s pending row is kept and merged beside the GCS-only account (the write is not broken by the merge)',
    JSON.stringify(finalZUsernames) === JSON.stringify(['freshz', 'userz']), JSON.stringify(finalZUsernames));
  const loginBack = await fetch(`http://127.0.0.1:${portZ}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'userz@example.test', password: 'Sup3rSecret!23' }),
  });
  record('THE DEFECT: once GCS answers, the GCS-only user logs in (the route read the store first)',
    loginBack.status === 200, `status ${loginBack.status}`);

  await stop(childZ);
  await fakeGcsDeferred.close();

  // 4. A GCS peer can accept a socket then never answer. Storage's `timeout`
  // option is only a query parameter, so these use a purpose-built hung fake:
  // boot must fall back, /api/version must 500, and save N+1 must escape N.
  const deadlinePort = gcsPortA + 6, deadlineAppPort = port1 + 30;
  const deadlineDb = JSON.stringify({
    users: [seededUser('u_deadline', 'deadlineuser', 'deadline@example.test', 'Sup3rSecret!23')], games: [],
  });
  const deadlineFake = await trackFake(startDeadlineGcs(deadlinePort, deadlineDb));
  deadlineFake.hang(OBJECT);
  const deadlineBoot = await waitReady(track(spawnServer(
    trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-deadline-'))), deadlineAppPort, deadlinePort,
    { GCS_DEADLINE_MS: '500' },
  )), deadlineAppPort);
  record('fixture: initDB reached the accepted-but-silent db.json peer',
    deadlineFake.reads().some((r) => r.name === OBJECT), JSON.stringify(deadlineFake.reads()));
  record('THE DEFECT: a hung GCS boot falls back and binds instead of hanging dark',
    /GCS deadline exceeded after 500ms: db\.json getMetadata\(\) never answered/.test(deadlineBoot.log()), deadlineBoot.log().slice(-500));
  await stop(deadlineBoot.child); await deadlineFake.close();

  const slowPort = gcsPortA + 8, slowAppPort = port1 + 40;
  const slowFake = await trackFake(startDeadlineGcs(slowPort, deadlineDb));
  slowFake.delay(OBJECT, 1000);
  const slowBoot = await waitReady(track(spawnServer(
    trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-slow-'))), slowAppPort, slowPort,
    { GCS_DEADLINE_MS: '1500' },
  )), slowAppPort);
  // Two reads since the boot read dropped its exists() (metadata, then the
  // generation-bound download): each delayed 1s, so 2s against a 1.5s deadline.
  record('fixture: slow control delayed every boot db.json read by 1 second',
    slowFake.reads().filter((r) => r.name === OBJECT).length >= 2, JSON.stringify(slowFake.reads()));
  const loginSlow = await fetch(`http://127.0.0.1:${slowAppPort}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'deadline@example.test', password: 'Sup3rSecret!23' }),
  });
  const slowToken = (await loginSlow.json()).token;
  record('a 1-second db.json response is a control: seeded data loads, no deadline fires',
    loginSlow.status === 200 && typeof slowToken === 'string' && !/GCS deadline exceeded/.test(slowBoot.log()),
    `status ${loginSlow.status}, ${slowBoot.log().slice(-350)}`);

  slowFake.delay(VERSION_OBJECT, 1000);
  const slowVersion = await fetch(`http://127.0.0.1:${slowAppPort}/api/version`, { signal: AbortSignal.timeout(5000) });
  const slowVersionBody = await slowVersion.json().catch(() => null);
  record('the 1-second /api/version control returns the real version payload',
    slowVersion.status === 200 && slowVersionBody?.version === '0.0.225', `status ${slowVersion.status}, ${JSON.stringify(slowVersionBody)}`);
  slowFake.hang(VERSION_OBJECT);
  const versionAt = Date.now();
  // The hang is the defect, so it must be REPORTED, not thrown: without the
  // catch, an unbounded /api/version aborts this fetch and takes the whole
  // suite down with an unhandled TimeoutError — rc=1 for a reason no reader
  // can name. Measured on mutant M2 (deadline reverted at that call site).
  let hungVersion = null, hungVersionBody = null, hungVersionErr = null;
  try {
    hungVersion = await fetch(`http://127.0.0.1:${slowAppPort}/api/version`, { signal: AbortSignal.timeout(5000) });
    hungVersionBody = await hungVersion.json().catch(() => null);
  } catch (err) { hungVersionErr = err?.name || String(err); }
  const versionMs = Date.now() - versionAt;
  record('a hung /api/version read returns the existing finite 500 shape, not a hung desktop update check',
    hungVersionErr === null && hungVersion.status === 500
      && hungVersionBody?.error === 'Internal Server Error' && versionMs >= 1400 && versionMs < 4000,
    hungVersionErr
      ? `the request never completed (${hungVersionErr}) after ${versionMs}ms — the update poll hangs`
      : `status ${hungVersion.status}, ${versionMs}ms, ${JSON.stringify(hungVersionBody)}`);
  slowFake.hang(null); slowFake.delay(null, 0);

  const settledLoginUpload = await waitUntil(() => slowFake.uploads().length >= 1);
  record('fixture: ordinary login rehash upload settled before save N is hung', settledLoginUpload, `${slowFake.uploads().length} uploads`);
  const postGame = (name) => fetch(`http://127.0.0.1:${slowAppPort}/api/games`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${slowToken}` },
    body: JSON.stringify({ name, payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }),
  });
  const beforeHungUpload = slowFake.uploads().length;
  slowFake.hangUploads(true);
  const saveN = await postGame('Hung-save-N');
  const hungUploadReached = await waitUntil(() => slowFake.uploads().length > beforeHungUpload);
  record('fixture: save N reaches the silent upload peer after returning 200', saveN.status === 200 && hungUploadReached,
    `status ${saveN.status}, uploads ${slowFake.uploads().length}`);
  await new Promise((r) => setTimeout(r, 3200));
  slowFake.hangUploads(false);
  const saveN1 = await postGame('Recovered-save-N-plus-1');
  const recovered = await waitUntil(() => {
    try {
      const names = JSON.parse(slowFake.stored()).games.map((g) => g.name).sort();
      return JSON.stringify(names) === JSON.stringify(['Hung-save-N', 'Recovered-save-N-plus-1']);
    } catch { return false; }
  }, 6000);
  record('THE DEFECT: deadline releases the pump so save N+1 persists the latest shared state',
    saveN1.status === 200 && recovered && /GCS deadline exceeded after 1500ms: db\.json save\(\) never answered/.test(slowBoot.log()),
    `status ${saveN1.status}, ${slowFake.stored().slice(-300)}`);
  await stop(slowBoot.child); await slowFake.close();

  // 5. The RE-SYNC read, hung. Section 3 covers re-sync after ECONNREFUSED;
  // a peer that accepts and never answers is the other half, and it is only
  // reachable BECAUSE the boot deadline now lets the process serve at all.
  // Unbounded, this await never returns: gcsUploadInFlight stays pinned and
  // no save ever persists again, even once GCS is healthy. Offsets +12/+50
  // dodge this suite's own claimed ports (gcsPortA+10 would be portY).
  const resyncPort = gcsPortA + 12, resyncAppPort = port1 + 50;
  const resyncFake = await trackFake(startDeadlineGcs(resyncPort, JSON.stringify({ users: [], games: [] })));
  resyncFake.hang(OBJECT);
  const resyncBoot = await waitReady(track(spawnServer(
    trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-resync-'))), resyncAppPort, resyncPort,
    { GCS_DEADLINE_MS: '800' },
  )), resyncAppPort);
  const readsAfterBoot = resyncFake.reads().length;
  // Registration is the write trigger for the same reason section 3 uses it:
  // saveDB() runs before the (no-SMTP) email step, so the outer 500 is expected.
  const regDuringHang = () => fetch(`http://127.0.0.1:${resyncAppPort}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'resync1', email: 'resync1@example.test', password: 'Sup3rSecret!23' }),
  }).catch(() => null);
  const regHung = await regDuringHang();
  const resyncReached = await waitUntil(() => resyncFake.reads().length > readsAfterBoot);
  record('fixture: the re-sync read reached the accepted-but-silent peer after the boot fallback',
    resyncReached, `${readsAfterBoot} reads at boot, ${resyncFake.reads().length} after the write`);

  // FAIL-SAFE, scoped to the hung window. The log lines alone prove nothing:
  // the console.error above the `return` prints either way, and an upload made
  // WHILE hung still counts under an unscoped `uploads().length > 0`. Gate
  // review #11 deleted the `return` and this section stayed 23/23 green while
  // the mutant blindly overwrote an object it had never read — the exact
  // blind-overwrite bug the fail-safe exists to prevent. So assert the
  // ABSENCE of a write during the hang, separately from the recovery write.
  const uploadsWhileHung = resyncFake.uploads().length;
  // The write route now waits for that read and refuses (503) instead of
  // committing to a store it never read; the pump's own re-sync guard stays
  // behind it (mutation M-resync in SWEEPS.md).
  record('THE DEFECT: a re-sync that never answered writes NOTHING — no blind overwrite of state it never read',
    uploadsWhileHung === 0 && regHung?.status === 503
      && /GCS deadline exceeded after 800ms: db\.json getMetadata\(\) never answered/.test(resyncBoot.log()),
    `${uploadsWhileHung} upload(s) during the hang, register ${regHung?.status}; log: ${resyncBoot.log().slice(-300)}`);

  resyncFake.hang(null); // GCS recovers
  await fetch(`http://127.0.0.1:${resyncAppPort}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'resync2', email: 'resync2@example.test', password: 'Sup3rSecret!23' }),
  }).catch(() => null);
  const persistedAfterRecovery = await waitUntil(
    () => resyncFake.uploads().length > uploadsWhileHung, 8000,
  );
  record('THE DEFECT: the deadline released the pump, so a save AFTER recovery still reaches GCS',
    persistedAfterRecovery,
    `${uploadsWhileHung} upload(s) while hung, ${resyncFake.uploads().length} after recovery`);
  await stop(resyncBoot.child); await resyncFake.close();

  // ───────────────────────────────────────────────────────────────────────────
  // 6. THE BUCKET'S OWN SHAPE (BLUE-LOOP-CLOUD-22, carry-in 1 + hit a). The
  // boot read did JSON.parse straight into memory: `users:[null]`/`users:"x"`
  // 500'd every login, and a legacy `{games:[...]}` (no "users" key) threw
  // AFTER the generation was adopted, so the first register replaced the
  // bucket with `{"users":[],"games":[]}`. Now: same normalizeDbShape as the
  // local path; a malformed object blocks the DB routes (503) and nothing is
  // written, while the rest of the site serves. CONTROLS on the same path:
  // the legacy shape keeps every record, and a user whose passwordHash is ''
  // (the desktop local owner's shape) is legal, so neither assertion can pass
  // by a validator that simply rejects more.
  // ───────────────────────────────────────────────────────────────────────────
  const shapeGcsPort = gcsPortA + 14, shapeAppPort = port1 + 2;
  const register = (appPort, email) => fetch(`http://127.0.0.1:${appPort}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `r${Math.random().toString(36).slice(2, 8)}`, email, password: 'Sup3rSecret!23' }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);
  for (const [label, doc, why] of [
    ['users:[null]', { users: [null], games: [] }, /"users\[0\]" is null, not an object/],
    ['users is a string', { users: 'x', games: [] }, /"users" is present but is a string, not an array/],
    ['a user without an email', { users: [{ id: 'u1', username: 'a', passwordHash: 'h' }], games: [] }, /"users\[0\]\.email" is not a string/],
    ['a top-level array', [], /does not contain a JSON object at its top level/],
  ]) {
    const original = JSON.stringify(doc);
    const fake = await trackFake(startFakeGcsDb({ port: shapeGcsPort, initialContent: original }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-shape-'))), shapeAppPort, shapeGcsPort)), shapeAppPort);
    const reg = await register(shapeAppPort, 'shape@example.test');
    const version = await fetch(`http://127.0.0.1:${shapeAppPort}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await new Promise((r) => setTimeout(r, 600));
    record(`THE DEFECT, malformed bucket (${label}): DB routes 503, nothing uploaded, bytes untouched`,
      reg?.status === 503 && fake.uploadCount() === 0 && fake.getStored() === original,
      `register ${reg?.status}, ${fake.uploadCount()} upload(s), stored ${String(fake.getStored()).slice(0, 80)}`);
    record(`malformed bucket (${label}): the refusal is logged with its cause, and non-DB routes still answer`,
      why.test(boot.log()) && /GCS store BLOCKED/.test(boot.log()) && version.status === 400 && boot.child.exitCode === null,
      `report ${version.status}; ${boot.log().slice(-300)}`);
    await stop(boot.child); await fake.close();
  }
  for (const [label, doc, keeps] of [
    ['legacy {games} with no "users" key', { games: [{ id: 'g_old', userId: 'u_gone', name: 'Old-Game', description: '', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, createdAt: '2026-01-01' }] },
      (db) => db.games.some((g) => g.id === 'g_old')],
    ['a user whose passwordHash is \'\' (the local-owner shape)', { users: [{ ...seededUser('u_blank', 'blank', 'blank@example.test', 'x'), passwordHash: '' }], games: [] },
      (db) => db.users.some((u) => u.id === 'u_blank')],
  ]) {
    const fake = await trackFake(startFakeGcsDb({ port: shapeGcsPort, initialContent: JSON.stringify(doc) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-shape-ok-'))), shapeAppPort, shapeGcsPort)), shapeAppPort);
    const reg = await register(shapeAppPort, 'control@example.test');
    const landed = await waitUntil(() => fake.uploadCount() >= 1, 5000);
    let stored = null; try { stored = JSON.parse(fake.getStored()); } catch { /* reported below */ }
    record(`CONTROL (${label}): boots unblocked, and the first save KEEPS the existing record`,
      reg?.status === 500 && landed && !!stored && keeps(stored) && !/GCS store BLOCKED/.test(boot.log()),
      `register ${reg?.status} (500 = no SMTP), uploads ${fake.uploadCount()}, stored ${String(fake.getStored()).slice(0, 160)}`);
    await stop(boot.child); await fake.close();
  }

  // A PEER writes a malformed object mid-life; our next save takes the 412
  // merge. On main that path merged `users:"x"` character by character and
  // uploaded the result. It must refuse and block exactly like the boot read.
  {
    const good = JSON.stringify({ users: [seededUser('u_mid', 'mid', 'mid@example.test', 'Sup3rSecret!23')], games: [] });
    const fake = await trackFake(startFakeGcsDb({ port: shapeGcsPort, initialContent: good }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-mid-'))), shapeAppPort, shapeGcsPort)), shapeAppPort);
    const tok = (await (await fetch(`http://127.0.0.1:${shapeAppPort}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'mid@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    const bad = JSON.stringify({ users: 'x', games: [] });
    fake.peerWrite(bad);
    const n = fake.uploadCount();
    const save = await fetch(`http://127.0.0.1:${shapeAppPort}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: 'After-Peer-Garbage', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }) });
    await waitUntil(() => /GCS store BLOCKED/.test(boot.log()), 5000);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await fetch(`http://127.0.0.1:${shapeAppPort}/api/games`, { headers: { authorization: `Bearer ${tok}` } });
    record('THE DEFECT: a malformed object a peer wrote mid-life is never merged over: bucket untouched, DB routes now 503',
      save.status === 200 && fake.getStored() === bad && fake.uploadCount() === n + 1 && after.status === 503,
      `save ${save.status}, uploads ${fake.uploadCount() - n} after the peer write, stored ${String(fake.getStored()).slice(0, 80)}, then GET ${after.status}`);
    await stop(boot.child); await fake.close();
  }

  // The legacy-hash SECURITY warning counted users BEFORE initDB loaded any,
  // so it could never fire. The fixture seeds one base64 hash.
  {
    const fake = await trackFake(startFakeGcsDb({ port: shapeGcsPort, initialContent: JSON.stringify({ users: [seededUser('u_leg', 'leg', 'leg@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-legacy-'))), shapeAppPort, shapeGcsPort)), shapeAppPort);
    record('THE DEFECT: the legacy-password SECURITY warning counts the LOADED users',
      /SECURITY: 1 account\(s\) still use legacy/.test(boot.log()), boot.log().slice(0, 300));
    await stop(boot.child); await fake.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 7. TWO INSTANCES, THREE-WAY MERGE (hit c). Y deletes account U (and U's
  // game) and rehashes V's password; X loaded U and V before and never
  // touched either. X then saves an unrelated game and takes the 412 merge.
  // The 2-way merge put U and U's game back and reverted V's hash. CONTROL:
  // X's OWN new game survives the same merge.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const mGcs = gcsPortA + 16, mX = port1 + 4, mY = port1 + 6;
    const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
    const fake = await trackFake(startFakeGcsDb({ port: mGcs, initialContent: JSON.stringify({
      users: [{ ...seededUser('u_U', 'userU', 'u@example.test', 'Sup3rSecret!23'), deleteCode: '123456', deleteCodeExpires: Date.now() + 600000 },
        seededUser('u_V', 'userV', 'v@example.test', 'Sup3rSecret!23'), seededUser('u_W', 'userW', 'w@example.test', 'Sup3rSecret!23')],
      games: [{ id: 'g_U', userId: 'u_U', name: 'U-Game', description: '', payoffs: pay, createdAt: '2026-01-01' }],
    }) }));
    const X = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-3wx-'))), mX, mGcs)), mX);
    const Y = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-3wy-'))), mY, mGcs)), mY);
    const loginOn = async (p, email) => (await (await fetch(`http://127.0.0.1:${p}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Sup3rSecret!23' }) })).json()).token;
    const onGcs = () => { try { return JSON.parse(fake.getStored()); } catch { return { users: [], games: [] }; } };
    const tokenW = await loginOn(mX, 'w@example.test'); // X rehashes W: X is on the latest generation
    await waitUntil(() => onGcs().users.find((u) => u.id === 'u_W')?.passwordHash.startsWith('pbkdf2$'), 6000);
    const tokenU = await loginOn(mY, 'u@example.test');
    await waitUntil(() => onGcs().users.find((u) => u.id === 'u_U')?.passwordHash.startsWith('pbkdf2$'), 6000);
    const del = await fetch(`http://127.0.0.1:${mY}/api/auth/delete-confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenU}` }, body: JSON.stringify({ code: '123456' }) });
    await waitUntil(() => !onGcs().users.some((u) => u.id === 'u_U'), 6000);
    await loginOn(mY, 'v@example.test');
    await waitUntil(() => onGcs().users.find((u) => u.id === 'u_V')?.passwordHash.startsWith('pbkdf2$'), 6000);
    const before = onGcs();
    const postX = await fetch(`http://127.0.0.1:${mX}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenW}` },
      body: JSON.stringify({ name: 'W-Game', payoffs: pay }) });
    await waitUntil(() => onGcs().games.some((g) => g.name === 'W-Game'), 8000);
    const fin = onGcs();
    record('THE DEFECT: an account deleted on one instance stays deleted after a stale instance saves (user AND games)',
      del.status === 200 && !before.users.some((u) => u.id === 'u_U')
        && !fin.users.some((u) => u.id === 'u_U') && !fin.games.some((g) => g.id === 'g_U'),
      `delete ${del.status}; final users ${JSON.stringify(fin.users.map((u) => u.id))} games ${JSON.stringify(fin.games.map((g) => g.name))}`);
    const vBefore = before.users.find((u) => u.id === 'u_V')?.passwordHash;
    record('THE DEFECT: a stale instance\'s UNTOUCHED copy does not revert another instance\'s change (V\'s rehash)',
      !!vBefore?.startsWith('pbkdf2$') && fin.users.find((u) => u.id === 'u_V')?.passwordHash === vBefore,
      `V before ${vBefore?.slice(0, 7)}, after ${fin.users.find((u) => u.id === 'u_V')?.passwordHash?.slice(0, 7)}`);
    record('CONTROL: X\'s own new game survives the same 412 merge', postX.status === 200 && fin.games.some((g) => g.name === 'W-Game'),
      JSON.stringify(fin.games.map((g) => g.name)));
    await stop(X.child); await stop(Y.child); await fake.close();
  }

  // 7b. DELETION WINS OVER A CONCURRENT EDIT ON THE STALE INSTANCE. Y deletes
  // accounts U and U2; X, not knowing, CHANGES U2 (a forgot-password code)
  // and saves a new game for U, both inside one 412 merge. Neither account
  // may come back, and no game may be left owned by a deleted account.
  // CONTROL: the fixture's deletions reached GCS before X's merge.
  {
    const dGcs = gcsPortA + 28, dX = port1 + 24, dY = port1 + 26;
    const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
    const code = { deleteCode: '654321', deleteCodeExpires: Date.now() + 600000 };
    const fake = await trackFake(startFakeGcsDb({ port: dGcs, initialContent: JSON.stringify({
      users: [{ ...seededUser('u_D1', 'del1', 'd1@example.test', 'Sup3rSecret!23'), ...code }, { ...seededUser('u_D2', 'del2', 'd2@example.test', 'Sup3rSecret!23'), ...code }],
      games: [],
    }) }));
    const X = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-dwx-'))), dX, dGcs)), dX);
    const Y = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-dwy-'))), dY, dGcs)), dY);
    const loginOn = async (p, email) => (await (await fetch(`http://127.0.0.1:${p}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Sup3rSecret!23' }) })).json()).token;
    const onGcs = () => { try { return JSON.parse(fake.getStored()); } catch { return { users: [], games: [] }; } };
    const settle = async () => { let last = null; await waitUntil(() => { const now = fake.getStored(); const same = now === last; last = now; return same && fake.uploadCount() > 0; }, 6000); };
    const tokX = await loginOn(dX, 'd1@example.test'); await settle();
    const tokY1 = await loginOn(dY, 'd1@example.test'); await settle();
    const tokY2 = await loginOn(dY, 'd2@example.test'); await settle();
    // X re-reads GCS at most every 2s: open X's window NOW, so the deletions
    // and X's writes below fit inside it and X is still stale (a slow run
    // used to let X re-read first: orphan POST 401, fixture failed).
    await new Promise((r) => setTimeout(r, 2100));
    await fetch(`http://127.0.0.1:${dX}/api/auth/me`); const xWindow = Date.now();
    for (const t of [tokY1, tokY2]) {
      await fetch(`http://127.0.0.1:${dY}/api/auth/delete-confirm`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ code: '654321' }) });
      await settle();
    }
    const deletedFirst = onGcs().users.length === 0;
    fake.setUploadDelayMs(1500); // X's first upload is held, then 412s: both changes below land in ONE merge
    await fetch(`http://127.0.0.1:${dX}/api/auth/forgot-password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'd2@example.test' }) });
    const orphan = await fetch(`http://127.0.0.1:${dX}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokX}` },
      body: JSON.stringify({ name: 'Orphan-Game', payoffs: pay }) });
    const xStaleMs = Date.now() - xWindow;
    fake.setUploadDelayMs(0);
    await new Promise((r) => setTimeout(r, 2500)); await settle();
    const fin = onGcs();
    record('fixture: both deletions reached GCS before the stale instance merged, and X accepted its writes',
      deletedFirst && orphan.status === 200, `users on GCS before: ${deletedFirst ? 0 : 'some'}, orphan POST ${orphan.status}, X window used ${xStaleMs}ms of 2000`);
    record('THE DEFECT: an account deleted elsewhere stays deleted even though THIS instance changed it (deletion wins)',
      !fin.users.some((u) => u.id === 'u_D2') && !fin.users.some((u) => u.id === 'u_D1'), JSON.stringify(fin.users.map((u) => u.id)));
    record('THE DEFECT: no game is left owned by a deleted account', !fin.games.some((g) => g.userId === 'u_D1'), JSON.stringify(fin.games));
    await stop(X.child); await stop(Y.child); await fake.close();
  }

  // 7c. ONE EMAIL, TWO ACCOUNTS. In a rollover both instances answer "that
  // email is free" from their own memory. Measured before the fix: two rows
  // for one email on GCS, the second account could neither verify nor log in.
  // Now one account survives and the dropped one's game moves to it; a SECOND
  // pair shares only a username, which is two people, so one is renamed and
  // both keep their accounts. CONTROL: both registrations were accepted and
  // both instances really wrote (4 accounts reached GCS in total).
  {
    const eGcs = gcsPortA + 30, eX = port1 + 28, eY = port1 + 32, smtpPort = gcsPortA + 32;
    const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
    const codes = [];
    const smtp = net.createServer((sock) => {
      let inData = false, buf = '';
      sock.write('220 t ESMTP\r\n');
      sock.on('data', (c) => {
        for (const line of c.toString().split(/\r?\n/)) {
          if (inData) { if (line === '.') { inData = false; codes.push(buf.match(/\b(\d{6})\b/)?.[1]); buf = ''; sock.write('250 ok\r\n'); } else buf += `${line}\n`; continue; }
          const v = line.split(' ')[0].toUpperCase();
          if (!v) continue;
          if (v === 'EHLO' || v === 'HELO') sock.write('250-t\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (v === 'AUTH') sock.write('235 ok\r\n');
          else if (v === 'DATA') { inData = true; sock.write('354 go\r\n'); }
          else if (v === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((r) => smtp.listen(smtpPort, '127.0.0.1', r));
    const mailEnv = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'x@example.invalid' };
    const fake = await trackFake(startFakeGcsDb({ port: eGcs, initialContent: JSON.stringify({ users: [], games: [] }) }));
    const X = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-dupx-'))), eX, eGcs, mailEnv)), eX);
    const Y = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-dupy-'))), eY, eGcs, mailEnv)), eY);
    const call = (p, route, body, token) => fetch(`http://127.0.0.1:${p}${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const onGcs = () => { try { return JSON.parse(fake.getStored()); } catch { return { users: [], games: [] }; } };
    const settle = async () => { let last = null; await waitUntil(() => { const now = fake.getStored(); const same = now === last; last = now; return same; }, 6000); };
    const signUp = async (p, username, email, password) => {
      const r = await call(p, '/api/auth/register', { username, email, password });
      const code = codes.at(-1);
      const v = await call(p, '/api/auth/verify', { email, code, password });
      const t = (await (await call(p, '/api/auth/login', { email, password })).json()).token;
      return { r: r.status, v: v.status, t };
    };
    // Uploads are held so every step below happens on both instances before
    // either write lands: the rollover race, not "register an email GCS has".
    // Sequential, not Promise.all: the fake SMTP's last code must be this call's.
    fake.setUploadDelayMs(6000);
    const a = await signUp(eX, 'alice', 'same@example.test', 'Sup3rSecretX');
    const b = await signUp(eY, 'bob', 'SAME@example.test', 'Sup3rSecretY');
    const c = await signUp(eX, 'carol', 'carol@example.test', 'Sup3rSecretC');
    const d = await signUp(eY, 'Carol', 'dave@example.test', 'Sup3rSecretD');
    const ga = await call(eX, '/api/games', { name: 'Alice-Game', payoffs: pay }, a.t);
    const gb = await call(eY, '/api/games', { name: 'Bob-Game', payoffs: pay }, b.t);
    const beforeLanding = fake.uploadCount();
    fake.setUploadDelayMs(0);
    await waitUntil(() => onGcs().games.length >= 2, 15000); await settle(); await new Promise((r) => setTimeout(r, 1500)); await settle();
    const seenIds = new Set(fake.uploadLog().flatMap((u) => { try { return JSON.parse(u.body).users.map((x) => x.id); } catch { return []; } }));
    const fin = onGcs();
    const same = fin.users.filter((u) => u.email.toLowerCase() === 'same@example.test');
    const carols = fin.users.filter((u) => u.username.toLowerCase().startsWith('carol'));
    record('fixture: all four sign-ups and both games were accepted before any upload landed, and 4 accounts reached GCS',
      [a, b, c, d].every((x) => x.r === 200 && x.v === 200 && typeof x.t === 'string') && ga.status === 200 && gb.status === 200
        && beforeLanding === 0 && seenIds.size === 4,
      JSON.stringify([a, b, c, d].map((x) => [x.r, x.v, typeof x.t])) + ` games ${ga.status}/${gb.status}, landed early ${beforeLanding}, ids seen ${seenIds.size}`);
    record('THE DEFECT: one email ends as ONE account, holding BOTH instances\' games',
      same.length === 1 && ['Alice-Game', 'Bob-Game'].every((n) => fin.games.some((g) => g.name === n && g.userId === same[0]?.id)),
      `accounts ${same.length}; games ${JSON.stringify(fin.games.map((g) => [g.name, g.userId === same[0]?.id]))}`);
    record('THE DEFECT: one username shared by two people ends as two accounts with distinct names',
      carols.length === 2 && new Set(carols.map((u) => u.username.toLowerCase())).size === 2, JSON.stringify(carols.map((u) => u.username)));
    // As the renamed user sees it, on BOTH instances (each re-reads GCS within
    // 2s): sign-in by email still works, and the name the app shows — the
    // login response and /api/auth/me, the header's `@username` — is the NEW one.
    const renamed = carols.find((u) => u.username !== 'carol' && u.username !== 'Carol');
    await new Promise((r) => setTimeout(r, 2100));
    const seen = [];
    for (const p of [eX, eY]) {
      const who = renamed?.email === 'dave@example.test' ? ['dave@example.test', 'Sup3rSecretD'] : ['carol@example.test', 'Sup3rSecretC'];
      const lr = await call(p, '/api/auth/login', { email: who[0], password: who[1] });
      const lj = await lr.json().catch(() => ({}));
      const me = await (await fetch(`http://127.0.0.1:${p}/api/auth/me`, { headers: { authorization: `Bearer ${lj.token}` } })).json().catch(() => ({}));
      seen.push({ login: lr.status, loginName: lj.user?.username, meName: me.username });
    }
    record('THE DEFECT: the renamed user signs in by email on both instances and every shown username is the NEW name',
      !!renamed && seen.every((x) => x.login === 200 && x.loginName === renamed.username && x.meName === renamed.username),
      `renamed to ${renamed?.username}; ${JSON.stringify(seen)}`);
    await stop(X.child); await stop(Y.child); await fake.close(); smtp.close();

    // 7d. THE FOLDED ID STILL OWNS WHAT ITS INSTANCE SAVES NEXT. Account A
    // lands on GCS unverified INSIDE Y's freshness window (Y re-checked just
    // before), so Y registers the same email as B and verifies it before its
    // merge; the merge keeps verified B and folds A. X, which loads A, then
    // verifies A and saves a game. That game must end up owned by the
    // surviving account, not by an id that no longer exists.
    const fGcs = gcsPortA + 34, fX = port1 + 34, fY = port1 + 36;
    const smtp2 = net.createServer((sock) => {
      let inData = false, buf = '';
      sock.write('220 t ESMTP\r\n');
      sock.on('data', (c) => {
        for (const line of c.toString().split(/\r?\n/)) {
          if (inData) { if (line === '.') { inData = false; codes.push(buf.match(/\b(\d{6})\b/)?.[1]); buf = ''; sock.write('250 ok\r\n'); } else buf += `${line}\n`; continue; }
          const v = line.split(' ')[0].toUpperCase();
          if (!v) continue;
          if (v === 'EHLO' || v === 'HELO') sock.write('250-t\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (v === 'AUTH') sock.write('235 ok\r\n');
          else if (v === 'DATA') { inData = true; sock.write('354 go\r\n'); }
          else if (v === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((r) => smtp2.listen(smtpPort, '127.0.0.1', r));
    const fake2 = await trackFake(startFakeGcsDb({ port: fGcs, initialContent: JSON.stringify({ users: [], games: [] }) }));
    const Y2 = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-foldy-'))), fY, fGcs, mailEnv)), fY);
    const X2 = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-foldx-'))), fX, fGcs)), fX);
    // 4.5s hold: X must re-read before Y's fold lands. At 2.5s the margin was
    // ~100ms and verify's password hashing (sweep 6) ate it: X saw the fold.
    fake2.setUploadDelayMs(4500);
    await fetch(`http://127.0.0.1:${fY}/api/auth/me`); // Y re-checks GCS now: its 2s freshness window starts
    const foldT0 = Date.now();
    fake2.peerWrite(JSON.stringify({ users: [{ ...seededUser('u_A', 'annie', 'fold@example.test', 'Sup3rSecretA'),
      isVerified: false, verificationCode: '111111', verificationCodeExpires: Date.now() + 600000 }], games: [] }));
    await call(fY, '/api/auth/register', { username: 'bella', email: 'fold@example.test', password: 'Sup3rSecretB' });
    const vB = await call(fY, '/api/auth/verify', { email: 'fold@example.test', code: codes.at(-1), password: 'Sup3rSecretB' });
    // X booted before A existed; its own 2s window must lapse so it re-reads
    // and sees A (Y's fold is still held by the 4.5s upload delay).
    await new Promise((r) => setTimeout(r, 2100));
    const vA = await call(fX, '/api/auth/verify', { email: 'fold@example.test', code: '111111', password: 'Sup3rSecretA' });
    const tA = (await (await call(fX, '/api/auth/login', { email: 'fold@example.test', password: 'Sup3rSecretA' })).json()).token;
    const late = await call(fX, '/api/games', { name: 'A-Late', payoffs: pay }, tA);
    const foldMargin = 4500 - (Date.now() - foldT0); // > 0: A-Late was saved before Y's fold could land
    const onGcs2 = () => { try { return JSON.parse(fake2.getStored()); } catch { return { users: [], games: [] }; } };
    // Settled = the fold has landed (u_A gone) and A-Late is on GCS. A fixed
    // wait read the TRANSIENT state (X's write, A still there) and passed with
    // no fold at all — so the fixture below also requires the fold to happen.
    const settled = await waitUntil(() => { const db = onGcs2(); return !db.users.some((u) => u.id === 'u_A') && db.games.some((g) => g.name === 'A-Late'); }, 30000);
    fake2.setUploadDelayMs(0);
    await new Promise((r) => setTimeout(r, 1500));
    const fin2 = onGcs2();
    const owners = fin2.users.filter((u) => u.email.toLowerCase() === 'fold@example.test');
    const aLate = fin2.games.find((g) => g.name === 'A-Late');
    const savedForA = fake2.uploadLog().some((u) => { try { return JSON.parse(u.body).games.some((g) => g.name === 'A-Late' && g.userId === 'u_A'); } catch { return false; } });
    record('fixture: B verified on Y; A verified and saved A-Late on X under u_A; the fold of u_A landed',
      vB.status === 200 && vA.status === 200 && typeof tA === 'string' && late.status === 200 && savedForA && settled,
      `verify B ${vB.status}, verify A ${vA.status}, game ${late.status}, sent under u_A ${savedForA}, settled ${settled}, margin ${foldMargin}ms; users ${JSON.stringify(fin2.users.map((u) => u.id))}`);
    record('THE DEFECT: a game saved under the folded account is owned by the surviving one',
      owners.length === 1 && owners[0].id !== 'u_A' && aLate?.userId === owners[0].id,
      `accounts ${owners.length}; A-Late owner ${aLate?.userId} vs ${owners[0]?.id}`);
    await stop(X2.child); await stop(Y2.child); await fake2.close(); smtp2.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 8. ACKNOWLEDGED SAVES SURVIVE AN OUTAGE AND A SHUTDOWN (hit d). Before:
  // after an upload failed nothing retried until the NEXT save (measured:
  // the game never reached GCS), and SIGTERM exited in ~7ms, dropping a save
  // queued behind an in-flight upload. CONTROL for the drain: the first,
  // already-in-flight save lands either way, so only the queued one can fail.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const oGcs = gcsPortA + 18, oApp = port1 + 8;
    const fake = await trackFake(startDeadlineGcs(oGcs, JSON.stringify({ users: [seededUser('u_o', 'outage', 'o@example.test', 'Sup3rSecret!23')], games: [] })));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-outage-'))), oApp, oGcs, { GCS_DEADLINE_MS: '600' })), oApp);
    const tok = (await (await fetch(`http://127.0.0.1:${oApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'o@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploads().length >= 1, 5000);
    fake.hangUploads(true);
    const save = await fetch(`http://127.0.0.1:${oApp}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: 'Acked-During-Outage', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }) });
    await waitUntil(() => (boot.log().match(/GCS write failed; the pending save stays queued/g) || []).length >= 2, 8000);
    fake.hangUploads(false); // GCS recovers; NO further save is made
    const persisted = await waitUntil(() => { try { return JSON.parse(fake.stored()).games.some((g) => g.name === 'Acked-During-Outage'); } catch { return false; } }, 10000);
    record('THE DEFECT: a save acknowledged during an outage reaches GCS once it recovers, with no later save to carry it',
      save.status === 200 && persisted, `status ${save.status}; stored ${fake.stored().slice(-200)}`);
    await stop(boot.child); await fake.close();
  }
  {
    const tGcs = gcsPortA + 20, tApp = port1 + 14;
    const fake = await trackFake(startFakeGcsDb({ port: tGcs, initialContent: JSON.stringify({ users: [seededUser('u_t', 'term', 't@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-term-'))), tApp, tGcs)), tApp);
    const tok = (await (await fetch(`http://127.0.0.1:${tApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 't@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    fake.setUploadDelayMs(1500);
    const g = (name) => fetch(`http://127.0.0.1:${tApp}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name, payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }) });
    const first = await g('In-Flight'); await new Promise((r) => setTimeout(r, 100));
    const second = await g('Queued-Behind');
    const exited = new Promise((r) => boot.child.once('exit', (code, sig) => r({ code, sig })));
    boot.child.kill('SIGTERM');
    const how = await exited;
    let names = [];
    await waitUntil(() => { try { names = JSON.parse(fake.getStored()).games.map((x) => x.name).sort(); } catch { /* reported */ } return names.length >= 2; }, 3000);
    record('CONTROL: the in-flight save lands either way', names.includes('In-Flight'), JSON.stringify(names));
    record('THE DEFECT: SIGTERM drains the queued save to GCS before exiting (code 0)',
      first.status === 200 && second.status === 200 && names.includes('Queued-Behind') && how.code === 0,
      `exit ${JSON.stringify(how)}; stored ${JSON.stringify(names)}`);
    await fake.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 9. AN ABANDONED WRITE THAT LANDS. An upload past the deadline is given up
  // on but may still land; a game created in it and deleted afterwards came
  // back, because the merge base did not know the game had ever reached GCS
  // (measured on main too). CONTROL: the game is on GCS before the delete.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const aGcs = gcsPortA + 22, aApp = port1 + 16;
    const fake = await trackFake(startFakeGcsDb({ port: aGcs, initialContent: JSON.stringify({ users: [seededUser('u_ab', 'aband', 'ab@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-aband-'))), aApp, aGcs, { GCS_DEADLINE_MS: '800' })), aApp);
    const tok = (await (await fetch(`http://127.0.0.1:${aApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ab@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    // Stored at 1.2s, after the 800ms deadline (the process never learns it
    // landed) but inside the save's 2s freshness window, so the delete below
    // is served without a re-read: only the unacked record says it landed.
    fake.setUploadDelayMs(1200);
    const made = await (await fetch(`http://127.0.0.1:${aApp}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: 'Created-Then-Deleted', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }) })).json();
    const landed = await waitUntil(() => { try { return JSON.parse(fake.getStored()).games.length === 1; } catch { return false; } }, 5000);
    fake.setUploadDelayMs(0);
    const metaBeforeDelete = fake.metaGets();
    const del = await fetch(`http://127.0.0.1:${aApp}/api/games/${made.game?.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    const deleteReRead = fake.metaGets() !== metaBeforeDelete;
    await new Promise((r) => setTimeout(r, 4000));
    const list = await (await fetch(`http://127.0.0.1:${aApp}/api/games`, { headers: { authorization: `Bearer ${tok}` } })).json();
    let storedGames = null; try { storedGames = JSON.parse(fake.getStored()).games.length; } catch { /* reported */ }
    record('fixture: the abandoned upload DID land on GCS before the delete, and the delete was served without a re-read',
      landed && !deleteReRead, `landed ${landed} reRead ${deleteReRead} ${fake.getStored().slice(0, 160)}`);
    record('THE DEFECT: a game deleted after its abandoned upload landed stays deleted, on GCS and in the list',
      del.status === 200 && storedGames === 0 && Array.isArray(list) && list.length === 0,
      `delete ${del.status}, stored games ${storedGames}, list ${JSON.stringify(list)}`);
    await stop(boot.child); await fake.close();
  }
  // 9b. THE OTHER HALF: an abandoned upload that did NOT land is no proof the
  // game is gone. A peer writes meanwhile, so the retry takes the 412 merge;
  // counting the unacked game as "known remotely" there would drop an
  // acknowledged save. CONTROL: the peer's game survives the same merge.
  {
    const bGcs = gcsPortA + 26, bApp = port1 + 22;
    const fake = await trackFake(startFakeGcsDb({ port: bGcs, initialContent: JSON.stringify({ users: [seededUser('u_nl', 'unland', 'nl@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-unland-'))), bApp, bGcs, { GCS_DEADLINE_MS: '800' })), bApp);
    const tok = (await (await fetch(`http://127.0.0.1:${bApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nl@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    fake.dropUploads(true);
    const save = await fetch(`http://127.0.0.1:${bApp}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: 'Never-Landed', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }) });
    const peer = JSON.parse(fake.getStored());
    peer.games.push({ id: 'g_peer2', userId: 'u_nl', name: 'Peer-Game-2', description: '', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, createdAt: '2026-01-01' });
    fake.peerWrite(JSON.stringify(peer));
    await waitUntil(() => /GCS write failed; the pending save stays queued/.test(boot.log()), 5000);
    fake.dropUploads(false);
    let names = [];
    await waitUntil(() => { try { names = JSON.parse(fake.getStored()).games.map((g) => g.name).sort(); } catch { /* reported */ } return names.length >= 2; }, 8000);
    record('CONTROL: the peer\'s game survives the merge that follows an unlanded upload', names.includes('Peer-Game-2'), JSON.stringify(names));
    record('THE DEFECT: an acknowledged save whose upload never landed survives the next 412 merge',
      save.status === 200 && names.includes('Never-Landed'), `save ${save.status}; stored ${JSON.stringify(names)}`);
    await stop(boot.child); await fake.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 10. THE PUMP NEVER WRITES WITHOUT A GENERATION. Routes re-read an unread
  // store at the gate, so the pump's own guard is reached by a save QUEUED
  // behind an upload whose answer carried no generation, with a peer writing
  // right after that upload. The queued save must re-read before writing.
  // CONTROL: the peer's write happened (checked below via the fake's hook).
  // ───────────────────────────────────────────────────────────────────────────
  {
    const nGcs = gcsPortA + 24, nApp = port1 + 18;
    const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
    const fake = await trackFake(startFakeGcsDb({ port: nGcs, initialContent: JSON.stringify({ users: [seededUser('u_n', 'nogen', 'n@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-nogen-'))), nApp, nGcs)), nApp);
    const tok = (await (await fetch(`http://127.0.0.1:${nApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'n@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    let peerRan = false;
    fake.setUploadDelayMs(800);
    fake.omitGenerationOnce();
    fake.afterStoreOnce((content) => {
      peerRan = true;
      const db = JSON.parse(content);
      db.games.push({ id: 'g_peer', userId: 'u_n', name: 'Peer-Game', description: '', payoffs: pay, createdAt: '2026-01-01' });
      return JSON.stringify(db);
    });
    const post = (name) => fetch(`http://127.0.0.1:${nApp}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name, payoffs: pay }) });
    const first = await post('First'); await new Promise((r) => setTimeout(r, 200));
    const queued = await post('Queued');
    fake.setUploadDelayMs(0);
    let names = [];
    await waitUntil(() => { try { names = JSON.parse(fake.getStored()).games.map((g) => g.name).sort(); } catch { /* reported */ } return names.includes('Queued'); }, 8000);
    record('fixture: a peer wrote right after the generation-less upload answered', peerRan, fake.getStored().slice(0, 200));
    record('THE DEFECT: with no known generation the queued save re-reads first, so the peer\'s game survives it',
      first.status === 200 && queued.status === 200 && JSON.stringify(names) === JSON.stringify(['First', 'Peer-Game', 'Queued']),
      `stored ${JSON.stringify(names)}; preconditions ${JSON.stringify(fake.uploadLog().slice(-3).map((u) => u.ifGenerationMatch))}`);
    await stop(boot.child); await fake.close();
  }

  // 11. A MAIL SERVER THAT ACCEPTS AND GOES QUIET (at DATA). Every mail route
  // waited on nodemailer's defaults (10 min idle): measured >90s for
  // register, forgot-password and feedback, while the client gives up at 22s.
  // CONTROL: the same routes against a mail server that answers are fast and
  // 200, so a 500 below cannot come from a broken fixture.
  {
    const qGcs = gcsPortA + 36, qApp = port1 + 38, qSmtp = gcsPortA + 38;
    let silent = true;
    const mails = []; // { rcpts, data } per delivered message (answering mode only)
    const smtp = net.createServer((sock) => {
      sock.write('220 t ESMTP\r\n');
      let inData = false, buf = '', rcpts = [];
      sock.on('data', (c) => {
        for (const line of c.toString().split(/\r?\n/)) {
          if (inData) { if (line === '.') { inData = false; mails.push({ rcpts, data: buf }); buf = ''; rcpts = []; sock.write('250 queued\r\n'); } else buf += `${line}\n`; continue; }
          const v = line.split(/[ :]/)[0].toUpperCase();
          if (!v) continue;
          if (v === 'RCPT') rcpts.push(line);
          if (v === 'EHLO' || v === 'HELO') sock.write('250-t\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (v === 'AUTH') sock.write('235 ok\r\n');
          else if (v === 'DATA') { if (!silent) { inData = true; sock.write('354 go\r\n'); } }
          else if (v === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else if (/^(MAIL|RCPT|RSET|NOOP)$/.test(v)) sock.write('250 ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((r) => smtp.listen(qSmtp, '127.0.0.1', r));
    const fake = await trackFake(startFakeGcsDb({ port: qGcs, initialContent: JSON.stringify({ users: [seededUser('u_q', 'quiet', 'q@example.test', 'Sup3rSecret!23'), seededUser('u_q2', 'quiet2', 'q2@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-smtp-'))), qApp, qGcs,
      { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(qSmtp), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'x@example.invalid', SMTP_DEADLINE_MS: '1500' })), qApp);
    const timed = async (route, body) => {
      const t = Date.now();
      try {
        const r = await fetch(`http://127.0.0.1:${qApp}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        return { status: r.status, ms: Date.now() - t };
      } catch (err) { return { status: err?.name ?? 'error', ms: Date.now() - t }; }
    };
    const routes = [
      ['/api/auth/register', () => ({ username: `q${Math.random().toString(36).slice(2, 7)}`, email: `q${Math.random().toString(36).slice(2, 7)}@example.test`, password: 'Sup3rSecret!23' })],
      ['/api/auth/forgot-password', () => ({ email: 'q@example.test' })],
      ['/api/feedback', () => ({ message: 'a quiet mail server test message' })],
    ];
    silent = false;
    const ok = [];
    for (const [route, body] of routes) ok.push(await timed(route, body()));
    // Feedback is anonymous public input mailed to the project inbox: nothing a
    // sender types may add a recipient or a header, or reach the HTML part as
    // markup (sweep 4 probe; held on main too, so a guard, not a fix).
    mails.length = 0;
    const hostile = [
      { message: 'hi\r\nBcc: evil@example.test\r\n\r\nbody', rating: '5\r\nCc: evil@example.test' },
      { message: '<script>alert(1)</script>', email: 'a@b.co' },
      { message: 'x', email: 'a@b.co\r\nBcc: evil@example.test' },
      { message: 'x', email: 'a@b.co,evil@example.test' },
    ];
    const hostileStatus = [];
    for (const body of hostile) hostileStatus.push((await fetch(`http://127.0.0.1:${qApp}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status);
    await waitUntil(() => mails.length >= 2, 3000);
    const headerOf = (m) => m.data.split('\n\n')[0];
    const qp = (t) => t.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const htmlOf = (m) => m.data.split(/\n--[^\n]+\n/).filter((p) => /content-type: text\/html/i.test(p))
      .map((p) => { const b = p.split('\n\n').slice(1).join('\n\n'); return /base64/i.test(p) ? Buffer.from(b.replace(/\s/g, ''), 'base64').toString() : qp(b); }).join('');
    record('THE DEFECT: hostile feedback adds no recipient or header and reaches the HTML part escaped; bad reply-to addresses are 400',
      JSON.stringify(hostileStatus) === '[200,200,400,400]' && mails.length === 2
        && mails.every((m) => m.rcpts.length === 1 && !/evil/.test(m.rcpts.join()) && !/^(?:bcc|cc):/im.test(headerOf(m)))
        && /&lt;script&gt;/.test(htmlOf(mails[1])) && !/<script>/i.test(htmlOf(mails[1])),
      `statuses ${JSON.stringify(hostileStatus)} mails ${mails.length} rcpts ${JSON.stringify(mails.map((m) => m.rcpts))}`);
    // Size bounds (sweep 12 probe, held on main): blank is refused, the cap is
    // on the TRIMMED text, so 5000 chars padded with spaces still sends. 9 of the 10/min.
    const fb = async (message) => { const r = await fetch(`http://127.0.0.1:${qApp}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
      return [r.status, (await r.json().catch(() => ({}))).error ?? ''].join(' '); };
    const bounds = [await fb('  \n '), await fb('y'.repeat(5001)), await fb(`  ${'z'.repeat(5000)} `)];
    record('feedback: blank and 5001 chars are 400 with their reason; exactly 5000 after trim is 200',
      /^400 .*cannot be empty/.test(bounds[0]) && /^400 .*too long/.test(bounds[1]) && bounds[2] === '200 ', JSON.stringify(bounds));
    silent = true;
    const hung = [];
    // A second account: q@ was just mailed, and a recovery mail per address per
    // minute is the cooldown (sweep 6), so a repeat there never reaches SMTP.
    routes[1][1] = () => ({ email: 'q2@example.test' });
    for (const [route, body] of routes) hung.push(await timed(route, body()));
    record('CONTROL: against an answering mail server, register / forgot-password / feedback are 200 and fast',
      ok.every((r) => r.status === 200 && r.ms < 5000), JSON.stringify(ok));
    record('THE DEFECT: a silent mail server gets an honest 500 inside the client\'s 22s, on every mail route',
      hung.every((r) => r.status === 500 && r.ms >= 1400 && r.ms < 8000) && /SMTP deadline exceeded after 1500ms/.test(boot.log()),
      JSON.stringify(hung));
    await stop(boot.child); await fake.close(); smtp.close();
  }

  // 12. READS ARE FRESH ACROSS INSTANCES. In a rollover the new instance read
  // GCS once at boot and never again until it wrote, so a game saved on the
  // old instance was missing from the new one's list without bound (sweep 1,
  // main too). CONTROL: the game is on GCS before the read.
  {
    const rGcs = gcsPortA + 40, rX = port1 + 42, rY = port1 + 44;
    const fake = await trackFake(startFakeGcsDb({ port: rGcs, initialContent: JSON.stringify({ users: [seededUser('u_r', 'fresh', 'r@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const X = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-freshx-'))), rX, rGcs)), rX);
    const Y = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-freshy-'))), rY, rGcs)), rY);
    const loginOn = async (p) => (await (await fetch(`http://127.0.0.1:${p}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'r@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    const tX = await loginOn(rX); await waitUntil(() => fake.uploadCount() >= 1, 5000);
    const tY = await loginOn(rY); await waitUntil(() => fake.uploadCount() >= 2, 5000);
    const saved = await fetch(`http://127.0.0.1:${rX}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tX}` },
      body: JSON.stringify({ name: 'Saved-On-X', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }) });
    const onGcs = await waitUntil(() => { try { return JSON.parse(fake.getStored()).games.some((g) => g.name === 'Saved-On-X'); } catch { return false; } }, 5000);
    await new Promise((r) => setTimeout(r, 2100)); // one freshness window
    const listY = await (await fetch(`http://127.0.0.1:${rY}/api/games`, { headers: { authorization: `Bearer ${tY}` } })).json().catch(() => null);
    record('fixture: the game saved on X reached GCS before Y lists', saved.status === 200 && onGcs, fake.getStored().slice(0, 160));
    record('THE DEFECT: the other instance lists it within one freshness window, with no write of its own',
      Array.isArray(listY) && listY.some((g) => g.name === 'Saved-On-X'), JSON.stringify(listY));
    await stop(X.child); await stop(Y.child); await fake.close();
  }

  // 13. A NON-STRING AUTH FIELD IS A CLIENT ERROR. Live on 0.0.226 (sweep 1),
  // `{"email":5}` on login/forgot/verify/reset and `{"password":{}}` on login
  // answered 500 "Internal server error": every route called string methods on
  // whatever JSON arrived. CONTROL: the same routes with string fields answer
  // their ordinary 4xx, so a 400 below cannot come from a broken route.
  {
    const vGcs = gcsPortA + 42, vApp = port1 + 46;
    const fake = await trackFake(startFakeGcsDb({ port: vGcs, initialContent: JSON.stringify({ users: [{ ...seededUser('u_v', 'valid', 'v@example.test', 'Sup3rSecret!23'), deleteCode: '123456', deleteCodeExpires: Date.now() + 600000 }, { ...seededUser('u_tp', 'tpend', 'tp@example.test', 'Sup3rSecret!23'), isVerified: false, verificationCode: '123456', verificationCodeExpires: Date.now() + 600000 }], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-types-'))), vApp, vGcs)), vApp);
    const tok = (await (await fetch(`http://127.0.0.1:${vApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'v@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    const cases = [
      ['/api/auth/login', { email: 5, password: 'x' }], ['/api/auth/login', { email: 'v@example.test', password: { a: 1 } }],
      ['/api/auth/register', { username: 'nn', email: ['x'], password: 'Sup3rSecretX' }], ['/api/auth/register', { username: 'nn', email: 'n@example.test', password: 7 }],
      ['/api/auth/verify', { email: true, code: '1' }], ['/api/auth/forgot-password', { email: { $ne: 1 } }],
      // verify's own password/username (sweep 8): a PENDING row, so the password reaches verifyPassword
      ['/api/auth/verify', { email: 'tp@example.test', code: '000000', password: { a: 1 }, username: 'nn' }], ['/api/auth/verify', { email: 'tp@example.test', code: '000000', password: 'N3wOwner!pass', username: 5 }], ['/api/auth/register', { username: 5, email: 'n@example.test', password: 'Sup3rSecretX' }],
      ['/api/auth/reset-password', { email: 'v@example.test', code: 123456, newPassword: 'Sup3rSecretX' }],
      ['/api/auth/delete-confirm', { code: 123456 }, true], ['/api/auth/login', []],
    ];
    const got = [];
    for (const [route, body, auth] of cases) {
      const r = await fetch(`http://127.0.0.1:${vApp}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
      got.push([route, r.status]);
    }
    // Account responses are never stored by a browser (sweep 11: live had no
    // Cache-Control, so /api/auth/me and /api/games could sit in a shared
    // machine's disk cache after sign-out). CONTROL: /api/health may cache.
    const hdr = async (route, init = {}) => (await fetch(`http://127.0.0.1:${vApp}${route}`, init)).headers.get('cache-control');
    const auth = { authorization: `Bearer ${tok}` };
    const noStore = { me: await hdr('/api/auth/me', { headers: auth }), games: await hdr('/api/games', { headers: auth }),
      login: await hdr('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'v@example.test', password: 'nope' }) }),
      admin: await hdr('/api/admin/stats'), health: await hdr('/api/health') };
    record('THE DEFECT: account responses (me, games, login, admin) are Cache-Control: no-store; the health probe is not forced',
      ['me', 'games', 'login', 'admin'].every((k) => /\bno-store\b/.test(noStore[k] ?? '')) && !/no-store/.test(noStore.health ?? ''), JSON.stringify(noStore));
    const control = await fetch(`http://127.0.0.1:${vApp}/api/auth/delete-confirm`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ code: '000000' }) });
    record('CONTROL: a string field on the same route gets its ordinary 4xx (wrong code -> 400)', control.status === 400, `status ${control.status}`);
    record('THE DEFECT: every non-string auth field is a 400, never a 500', got.every(([, st]) => st === 400), JSON.stringify(got));
    await stop(boot.child); await fake.close();
  }

  // 14. A 412 STORM. Three instances on one bucket, each user saving 8 games
  // concurrently and deleting every third, uploads slowed so they collide.
  // Every acknowledged save must end on GCS exactly once and every
  // acknowledged delete stay gone. FIXTURE: real 412s happened, so the
  // re-read + 3-way merge path ran, not three serial writers.
  {
    const sGcs = gcsPortA + 44, ports = [port1 + 48, port1 + 50, port1 + 52];
    const us = [0, 1, 2].map((i) => seededUser(`u_s${i}`, `storm${i}`, `s${i}@example.test`, 'Sup3rSecret!23'));
    const fake = await trackFake(startFakeGcsDb({ port: sGcs, initialContent: JSON.stringify({ users: us, games: [] }) }));
    const kids = [];
    for (const p of ports) kids.push((await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-storm-'))), p, sGcs)), p)).child);
    const tok = [];
    for (const [i, p] of ports.entries()) {
      tok.push((await (await fetch(`http://127.0.0.1:${p}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `s${i}@example.test`, password: 'Sup3rSecret!23' }) })).json()).token);
      await waitUntil(() => fake.uploadCount() >= i + 1, 5000);
    }
    fake.setUploadDelayMs(150);
    const acked = [], deleted = [];
    await Promise.all(ports.map(async (p, i) => {
      const mine = [];
      for (let k = 0; k < 8; k++) {
        const r = await fetch(`http://127.0.0.1:${p}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok[i]}` },
          body: JSON.stringify({ name: `S${i}-G${k}`, payoffs: { a11: k, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 200 && j.game?.id) { mine.push({ name: `S${i}-G${k}`, id: j.game.id }); acked.push(`S${i}-G${k}`); }
        if (k % 3 === 2 && mine.length >= 2) {
          const v = mine.at(-2);
          const d = await fetch(`http://127.0.0.1:${p}/api/games/${v.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${tok[i]}` } });
          if (d.status === 200) deleted.push(v.name);
        }
      }
    }));
    fake.setUploadDelayMs(0);
    const names = () => { try { return JSON.parse(fake.getStored()).games.map((g) => g.name); } catch { return []; } };
    const settled = () => { const n = new Set(names()); return acked.every((a) => deleted.includes(a) || n.has(a)) && deleted.every((d) => !n.has(d)); };
    await waitUntil(settled, 20000);
    const final = names(), set = new Set(final);
    const lost = acked.filter((a) => !deleted.includes(a) && !set.has(a)), back = deleted.filter((d) => set.has(d));
    record('fixture: 24 saves and 6 deletes acknowledged, and GCS answered real 412s (the merge path ran)',
      acked.length === 24 && deleted.length === 6 && fake.count412() > 0, `acked ${acked.length} deleted ${deleted.length} 412s ${fake.count412()}`);
    record('THE DEFECT: no acknowledged save lost, no acknowledged delete resurrected, no game twice, no user lost',
      lost.length === 0 && back.length === 0 && final.length === set.size && JSON.parse(fake.getStored()).users.length === 3,
      `lost ${JSON.stringify(lost)} back ${JSON.stringify(back)} dupes ${final.length - set.size}`);
    for (const c of kids) await stop(c);
    await fake.close();
  }

  // 15. A PROVIDER THAT NEVER ANSWERS CANNOT HOLD /api/report. With the rung-3
  // flags off, the full-report path awaited generateReport with no signal: 11
  // body shapes stayed open past 60s (sweep 1). CONTROL: the same hang with the
  // shipping flags on answers every shape by the scenario budget (template).
  {
    const hGcs = gcsPortA + 46, onApp = port1 + 54, offApp = port1 + 56, provPort = gcsPortA + 48;
    const provider = http.createServer((req) => { req.resume(); }); // accepts, never answers
    await new Promise((r) => provider.listen(provPort, '127.0.0.1', r));
    trackFake({ close: () => new Promise((r) => { provider.closeAllConnections?.(); provider.close(() => r()); }) });
    const fake = await trackFake(startFakeGcsDb({ port: hGcs, initialContent: JSON.stringify({ users: [], games: [] }) }));
    const llm = { REPORT_MODEL: 'gpt-5.6-luna', AZURE_FOUNDRY_ENDPOINT: `http://127.0.0.1:${provPort}/v1`, AZURE_FOUNDRY_API_KEY: 'loopback-test-only',
      NASH_SCENARIO_TIMEOUT_MS: '1500', NASH_SCENARIO_REQUEST_BUDGET_MS: '3000' };
    const on = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-hangon-'))), onApp, hGcs,
      { ...llm, NASH_PAYOFF_TEMPLATE: '1', NASH_LLM_TIES: 'template' })), onApp);
    const off = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-hangoff-'))), offApp, hGcs, llm)), offApp);
    const G = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
    const SC = { name: 'Harbour Pilots', row1: 'Wait', row2: 'Sail', col1: 'Hold', col2: 'Go', description: 'Two pilots choose whether to take a narrow channel first on a foggy morning.' };
    const shapes = [{ payoffs: G }, { payoffs: G, bypassCache: true }, { payoffs: G, scenario: SC }, { payoffs: { ...G, a21: 3 } }];
    const ask = (p, body) => { const t = Date.now(); return fetch(`http://127.0.0.1:${p}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
      .then(async (r) => ({ status: r.status, source: (await r.json()).source, ms: Date.now() - t }), (e) => ({ status: e.name, ms: Date.now() - t })); };
    const [onRes, offRes] = await Promise.all([Promise.all(shapes.map((b) => ask(onApp, b))), Promise.all(shapes.map((b) => ask(offApp, b)))]);
    record('CONTROL: with the shipping flags on, every shape answers 200 template within 8s under the same hang',
      onRes.every((r) => r.status === 200 && r.source === 'template' && r.ms < 8000), JSON.stringify(onRes));
    record('THE DEFECT: with the flags off, every shape answers 200 within 8s (deterministic), not held open',
      offRes.every((r) => r.status === 200 && r.ms < 8000), JSON.stringify(offRes));
    await stop(on.child); await stop(off.child); await fake.close();
  }

  // 16. A RE-CHECK READ THAT STRADDLES OUR OWN ACKED WRITE. The 2s re-check
  // finishes in the background; a write that commits and LANDS while its
  // download is in flight used to be undone by that older copy: a deleted
  // game came back, a new one vanished, a deleted account could sign in
  // (sweep 2, director angle). FIXTURE: the log proves the straddle.
  {
    const kGcs = gcsPortA + 50, kApp = port1 + 58;
    const seed = { ...seededUser('u_k', 'straddle', 'k@example.test', 'Sup3rSecret!23'), deleteCode: '123456', deleteCodeExpires: Date.now() + 600000 };
    const keepGame = { id: 'g_keep', userId: 'u_k', name: 'Keep', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, createdAt: '2026-01-01T00:00:00Z' };
    const fake = await trackFake(startFakeGcsDb({ port: kGcs, initialContent: JSON.stringify({ users: [seed], games: [keepGame, { ...keepGame, id: 'g_victim', name: 'Victim' }] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-straddle-'))), kApp, kGcs)), kApp);
    const url = (p) => `http://127.0.0.1:${kApp}${p}`;
    const tok = (await (await fetch(url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'k@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    const auth = { authorization: `Bearer ${tok}` }, json = { 'content-type': 'application/json', ...auth };
    await waitUntil(() => fake.uploadCount() >= 1, 5000); // login's rehash landed
    await new Promise((r) => setTimeout(r, 2200)); // freshness window over
    // A first save lands while the re-check's metadata GET is in flight, so
    // the generation moved and the re-check downloads; the write under test
    // then lands while that (slow) download is still in flight.
    const straddle = async (write, tag) => {
      fake.setReadDelayMs(600, 1800);
      const m0 = fake.metaGets(), r0 = fake.readLog().length;
      const trigger = fetch(url('/api/games'), { headers: auth });
      await waitUntil(() => fake.metaGets() > m0, 3000);
      const u0 = fake.uploadCount();
      await fetch(url('/api/games'), { method: 'POST', headers: json, body: JSON.stringify({ name: `Pre-${tag}`, payoffs: keepGame.payoffs }) });
      await waitUntil(() => fake.uploadLog().slice(u0).some((x) => x.landedGen), 3000);
      const downloading = await waitUntil(() => fake.readLog().length > r0, 3000);
      const read = fake.readLog().at(-1), before = fake.uploadCount();
      const w = await write();
      await waitUntil(() => fake.uploadLog().slice(before).some((x) => x.landedGen), 3000);
      const landedWhileReading = downloading && read.doneMs === undefined;
      await trigger; await waitUntil(() => read.doneMs !== undefined, 4000);
      fake.setReadDelayMs(0, 0);
      await new Promise((r) => setTimeout(r, 300));
      return { status: w.status, landedWhileReading };
    };
    const del = await straddle(() => fetch(url('/api/games/g_victim'), { method: 'DELETE', headers: auth }), 'del');
    const afterDel = await (await fetch(url('/api/games'), { headers: auth })).json();
    await new Promise((r) => setTimeout(r, 2200));
    const add = await straddle(() => fetch(url('/api/games'), { method: 'POST', headers: json, body: JSON.stringify({ name: 'Added', payoffs: keepGame.payoffs }) }), 'add');
    const afterAdd = await (await fetch(url('/api/games'), { headers: auth })).json();
    await new Promise((r) => setTimeout(r, 2200));
    const acct = await straddle(() => fetch(url('/api/auth/delete-confirm'), { method: 'POST', headers: json, body: JSON.stringify({ code: '123456' }) }), 'acct');
    const relogin = await fetch(url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'k@example.test', password: 'Sup3rSecret!23' }) });
    record('fixture: each acked write (delete, save, account delete) LANDED while the re-check download was in flight',
      [del, add, acct].every((x) => x.status === 200 && x.landedWhileReading), JSON.stringify([del, add, acct]));
    record('THE DEFECT: no acked write is undone by the older copy that re-check was reading',
      !afterDel.some((g) => g.name === 'Victim') && afterAdd.some((g) => g.name === 'Added') && relogin.status === 401
        && JSON.parse(fake.getStored()).users.length === 0,
      `afterDel ${JSON.stringify(afterDel.map((g) => g.name))} afterAdd ${JSON.stringify(afterAdd.map((g) => g.name))} relogin ${relogin.status}`);
    await stop(boot.child); await fake.close();
  }

  // 17. A PEER WRITE BETWEEN OUR METADATA GET AND OUR DOWNLOAD. The download
  // is bound to the generation the metadata named; once that generation is
  // gone GCS answers 404, and the re-read must follow rather than fail.
  {
    const jGcs = gcsPortA + 40, jApp = port1 + 42; // section 12's ports, released
    const fake = await trackFake(startFakeGcsDb({ port: jGcs, initialContent: JSON.stringify({ users: [seededUser('u_j', 'gen', 'j@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-genrace-'))), jApp, jGcs)), jApp);
    const url = (p) => `http://127.0.0.1:${jApp}${p}`;
    const tok = (await (await fetch(url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'j@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    await new Promise((r) => setTimeout(r, 2200));
    const db = JSON.parse(fake.getStored());
    db.games.push({ id: 'g_peer1', userId: 'u_j', name: 'Peer-1', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, createdAt: '2026-01-01T00:00:00Z' });
    fake.peerWrite(JSON.stringify(db)); // the generation moved: the re-check will download
    // A peer writes again the moment our metadata GET is answered, so the
    // download that follows names a generation that is already gone.
    fake.afterMetaOnce(() => { db.games.push({ ...db.games[0], id: 'g_peer2', name: 'Peer-2' }); return JSON.stringify(db); });
    const listing = fetch(url('/api/games'), { headers: { authorization: `Bearer ${tok}` } });
    const first = await listing; fake.setReadDelayMs(0, 0);
    await new Promise((r) => setTimeout(r, 2200));
    const after = await (await fetch(url('/api/games'), { headers: { authorization: `Bearer ${tok}` } })).json();
    record('fixture: GCS answered a stale-generation download 404 at least once', fake.stale404s() >= 1, `stale404s ${fake.stale404s()}`);
    record('THE DEFECT: the re-check follows the new generation: both peer games listed, the route never 5xx',
      first.status === 200 && after.some((g) => g.name === 'Peer-1') && after.some((g) => g.name === 'Peer-2'),
      `first ${first.status} after ${JSON.stringify(after.map?.((g) => g.name))}`);
    await stop(boot.child); await fake.close();
  }

  // 18. THE RE-CHECK'S COST AND LATENCY BOUND. Under 12 concurrent clients for
  // 6s: at most one metadata GET per 2s window and no download while the
  // generation is unchanged. With metadata taking 5s, a DB route waits about
  // 2s, never stacked, and a second wave inside that call waits no longer.
  {
    const cGcs = gcsPortA + 42, cApp = port1 + 46; // section 13's ports, released
    const fake = await trackFake(startFakeGcsDb({ port: cGcs, initialContent: JSON.stringify({ users: [seededUser('u_c', 'cost', 'c@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-cost-'))), cApp, cGcs, { TRUST_PROXY: '1' })), cApp);
    const url = (p) => `http://127.0.0.1:${cApp}${p}`;
    const tok = (await (await fetch(url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'c@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    await new Promise((r) => setTimeout(r, 2200));
    let ipn = 0; // one address per request: the route's own rate limit is not what this measures
    const get = () => fetch(url('/api/games'), { headers: { authorization: `Bearer ${tok}`, 'x-forwarded-for': `10.7.${(ipn >> 8) & 255}.${ipn++ & 255}` } });
    const m0 = fake.metaGets(), d0 = fake.readLog().length; let n = 0, ok = 0; const end = Date.now() + 6000;
    await Promise.all(Array.from({ length: 12 }, async () => { while (Date.now() < end) { const r = await get(); ok += r.status === 200; n += 1; } }));
    const metas = fake.metaGets() - m0, downloads = fake.readLog().length - d0;
    record('THE DEFECT: 12 clients for 6s cost at most 4 metadata GETs and no download (generation unchanged)',
      n > 100 && ok === n && metas <= 4 && downloads === 0, `requests ${n} ok ${ok} metadataGETs ${metas} downloads ${downloads}`);
    await new Promise((r) => setTimeout(r, 2100));
    fake.setReadDelayMs(5000, 0);
    const timed = async () => { const t = Date.now(); const r = await get(); return [r.status, Date.now() - t]; };
    const wave1 = await Promise.all(Array.from({ length: 12 }, timed));
    const wave2 = await Promise.all(Array.from({ length: 12 }, timed));
    fake.setReadDelayMs(0, 0);
    const worst = Math.max(...[...wave1, ...wave2].map((x) => x[1]));
    record('THE DEFECT: with 5s metadata, every DB request answers 200 within 3s (one 2s wait, not stacked)',
      [...wave1, ...wave2].every(([st, ms]) => st === 200 && ms < 3000), `worst ${worst}ms ${JSON.stringify([...wave1, ...wave2].map((x) => x[0]).filter((x) => x !== 200))}`);
    await stop(boot.child); await fake.close();
  }

  // 19. THE PEER WRITE A DROPPED OR PENDING READ CARRIED IS NOT LOST.
  // (i) Y writes while X's re-check downloads and X writes meanwhile: X's
  // upload is still conditioned on the old generation, so it must 412 and
  // merge. (ii) X's own ack overtakes its re-check and Y writes on top; s16
  // drops that read, so Y's game must arrive by X's next upload (412 merge)
  // and by the next re-check. Director, sweep 3.
  {
    const pGcs = gcsPortA + 52, pApp = port1 + 44; // s12's released app port
    const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
    const fake = await trackFake(startFakeGcsDb({ port: pGcs, initialContent: JSON.stringify({ users: [seededUser('u_p', 'peer', 'p@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-peerdrop-'))), pApp, pGcs)), pApp);
    const url = (p) => `http://127.0.0.1:${pApp}${p}`;
    const tok = (await (await fetch(url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'p@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    const auth = { authorization: `Bearer ${tok}` };
    const save = (name) => fetch(url('/api/games'), { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ name, payoffs: pay }) });
    const list = async () => (await (await fetch(url('/api/games'), { headers: auth })).json()).map((g) => g.name);
    const withGame = (stored, name) => { const db = JSON.parse(stored); db.games.push({ id: `g_${name}`, userId: 'u_p', name, payoffs: pay, createdAt: '2026-01-01T00:00:00Z' }); return JSON.stringify(db); };
    const onGcs = () => { try { return JSON.parse(fake.getStored()).games.map((g) => g.name); } catch { return []; } };
    const has = (names) => () => names.every((n) => onGcs().includes(n));
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    await new Promise((r) => setTimeout(r, 2200));

    // (i)
    fake.peerWrite(withGame(fake.getStored(), 'Y-Early')); // the generation moved: X's re-check downloads
    fake.setReadDelayMs(0, 1800);
    const r0 = fake.readLog().length, n0 = fake.count412();
    const trig1 = fetch(url('/api/games'), { headers: auth });
    await waitUntil(() => fake.readLog().length > r0, 3000);
    const read1 = fake.readLog().at(-1);
    fake.peerWrite(withGame(fake.getStored(), 'Y-Mid'));
    const s1 = await save('X-During');
    const refused1 = await waitUntil(() => fake.count412() > n0, 3000);
    const mid1 = read1.doneMs === undefined;
    await trig1; fake.setReadDelayMs(0, 0);
    await waitUntil(has(['Y-Early', 'Y-Mid', 'X-During']), 8000);
    await new Promise((r) => setTimeout(r, 2200));
    const list1 = await list(), gcs1 = onGcs();

    // (ii)
    await new Promise((r) => setTimeout(r, 2200));
    const u0 = fake.uploadCount(), n1 = fake.count412(), r1 = fake.readLog().length, m1 = fake.metaGets();
    fake.setReadDelayMs(600, 1800);
    fake.afterStoreOnce((stored) => withGame(stored, 'Y-Late')); // Y writes right on top of X's ack
    const trig2 = fetch(url('/api/games'), { headers: auth });
    await waitUntil(() => fake.metaGets() > m1, 3000);
    const s2 = await save('X-Acked');
    await waitUntil(() => fake.uploadLog().slice(u0).some((x) => x.landedGen), 3000);
    const ackGen = fake.uploadLog().slice(u0).find((x) => x.landedGen).landedGen;
    await waitUntil(() => fake.readLog().length > r1, 3000);
    const read2 = fake.readLog().at(-1);
    await trig2; await waitUntil(() => read2.doneMs !== undefined, 4000);
    fake.setReadDelayMs(0, 0);
    const s3 = await save('X-After'); // inside the window that read opened: no re-check first
    await waitUntil(has(['X-Acked', 'Y-Late', 'X-After']), 8000);
    const refused2 = fake.count412() - n1;
    await new Promise((r) => setTimeout(r, 2200));
    const list2 = await list(), gcs2 = onGcs();

    record('fixture: (i) Y wrote and X saved while X\'s re-check was downloading, and X\'s upload was refused (412); (ii) the read X dropped carried Y\'s write on top of X\'s ack',
      s1.status === 200 && mid1 && refused1 && s2.status === 200 && s3.status === 200 && read2.want === String(ackGen + 1),
      `s1 ${s1.status} mid ${mid1} 412 ${refused1}; s2 ${s2.status} s3 ${s3.status} ack ${ackGen} dropped-read gen ${read2.want}`);
    record('THE DEFECT: no peer write is lost: every game on GCS and in X\'s list, and X\'s next upload merged (412) rather than overwrote',
      ['Y-Early', 'Y-Mid', 'X-During', 'X-Acked', 'Y-Late', 'X-After'].every((n) => gcs2.includes(n) && list2.includes(n))
        && ['Y-Early', 'Y-Mid', 'X-During'].every((n) => gcs1.includes(n) && list1.includes(n)) && refused2 >= 1,
      `gcs ${JSON.stringify(gcs2)} list ${JSON.stringify(list2)} (ii) 412s ${refused2}`);
    await stop(boot.child); await fake.close();
  }

  // 20. READS STAY FRESH WHILE THE PUMP IS IN BACKOFF. The gate skipped its
  // re-check whenever an upload was in flight, and in backoff the pump stays
  // in flight for the whole outage: a peer's game stayed invisible on X until
  // X's own write landed (sweep 4; main too). CONTROL: after recovery both
  // writes are on GCS, so the pump still merges rather than overwrites.
  {
    const bGcs = gcsPortA + 40, bApp = port1 + 42; // s12's released ports
    const fake = await trackFake(startFakeGcsDb({ port: bGcs, initialContent: JSON.stringify({ users: [seededUser('u_bk', 'backoff', 'bk@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-backoff-'))), bApp, bGcs)), bApp);
    const url = (p) => `http://127.0.0.1:${bApp}${p}`;
    const tok = (await (await fetch(url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'bk@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    const auth = { authorization: `Bearer ${tok}` };
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    await new Promise((r) => setTimeout(r, 2200));
    fake.failUploads(true);
    const save = await fetch(url('/api/games'), { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ name: 'X-Pending', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }) });
    // Busy = the SDK retrying the 503s or the pump's own backoff; either way
    // gcsUploadInFlight stays true and X-Pending has not landed.
    const failing = await waitUntil(() => fake.uploadLog().some((u) => u.failed), 5000);
    const db = JSON.parse(fake.getStored());
    db.games.push({ id: 'g_peer_bk', userId: 'u_bk', name: 'Peer-During-Outage', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, createdAt: '2026-01-01T00:00:00Z' });
    fake.peerWrite(JSON.stringify(db));
    await new Promise((r) => setTimeout(r, 2200));
    const during = await (await fetch(url('/api/games'), { headers: auth })).json();
    const stillFailing = fake.uploadLog().at(-1)?.failed === true && !JSON.parse(fake.getStored()).games.some((g) => g.name === 'X-Pending');
    fake.failUploads(false);
    const both = await waitUntil(() => { const n = JSON.parse(fake.getStored()).games.map((g) => g.name); return n.includes('X-Pending') && n.includes('Peer-During-Outage'); }, 70000);
    record('fixture: X\'s save was acked, its uploads were failing and it had not landed when the peer wrote and X listed',
      save.status === 200 && failing && stillFailing, `save ${save.status} failing ${failing} stillPending ${stillFailing}`);
    record('THE DEFECT: X lists the peer\'s game within one freshness window during the outage; after recovery both are on GCS',
      during.some((g) => g.name === 'Peer-During-Outage') && both, `during ${JSON.stringify(during.map((g) => g.name))} both ${both}`);
    await stop(boot.child); await fake.close();
  }

  // 21. ONE ACCOUNT CHANGED ON BOTH INSTANCES. Y's copy is stale (inside its
  // 2s window) when it serves a second credential op after X's landed. Whole-
  // record local-wins reverted X's acked reset; a field mix let an attacker's
  // re-register password log in on a verified account (sweep 4). FIXTURE: Y
  // still saw the old state (its answer proves it) and its upload 412'd.
  {
    const aGcs = gcsPortA + 44, aX = port1 + 48, aY = port1 + 50, aSmtp = gcsPortA + 46;
    const mailed = []; // { to, code } per message, in order
    const smtp = net.createServer((sock) => {
      sock.write('220 t ESMTP\r\n'); let inData = false, body = '', to = '';
      sock.on('data', (c) => { for (const line of c.toString().split(/\r?\n/)) {
        if (inData) {
          if (line === '.') { inData = false; mailed.push({ to, code: (body.replace(/=\s*/g, '').match(/\b(\d{6})\b/) || [])[1] }); body = ''; sock.write('250 ok\r\n'); } else body += line + '\n';
          continue;
        }
        const v = line.split(/[ :]/)[0].toUpperCase(); if (!v) continue;
        if (v === 'RCPT') to = (line.match(/<([^>]+)>/) || [])[1] ?? '';
        if (v === 'EHLO' || v === 'HELO') sock.write('250-t\r\n250 AUTH PLAIN LOGIN\r\n'); else if (v === 'AUTH') sock.write('235 ok\r\n');
        else if (v === 'DATA') { inData = true; sock.write('354 go\r\n'); } else if (v === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 ok\r\n');
      } });
      sock.on('error', () => {});
    });
    await new Promise((r) => smtp.listen(aSmtp, '127.0.0.1', r));
    trackFake({ close: () => new Promise((r) => smtp.close(() => r())) });
    const mail = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(aSmtp), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'x@example.invalid' };
    const call = (port, route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const run = async (tag, seedUser, opX, opY) => {
      const fake = await trackFake(startFakeGcsDb({ port: aGcs, initialContent: JSON.stringify({ users: [seedUser], games: [] }) }));
      const X = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), `nash-gcs-acct-${tag}x-`))), aX, aGcs, mail)), aX);
      const Y = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), `nash-gcs-acct-${tag}y-`))), aY, aGcs, mail)), aY);
      await fetch(`http://127.0.0.1:${aX}/api/games`); await fetch(`http://127.0.0.1:${aY}/api/games`);
      await new Promise((r) => setTimeout(r, 2200));
      await fetch(`http://127.0.0.1:${aY}/api/games`); // Y's window opens on the pre-X state
      const u0 = fake.uploadCount(), n0 = fake.count412();
      const rx = await opX(aX);
      await waitUntil(() => fake.uploadLog().slice(u0).some((x) => x.landedGen), 3000);
      const ry = await opY(aY);
      const ryBody = await ry.json().catch(() => ({}));
      await waitUntil(() => fake.count412() > n0 && fake.uploadLog().at(-1)?.landedGen, 5000);
      // Past X's window, so X re-reads the MERGED record: logging in on X
      // any sooner answers from X's own copy and proves nothing about GCS.
      await new Promise((r) => setTimeout(r, 2200));
      const login = async (pw) => (await call(aX, '/api/auth/login', { email: seedUser.email, password: pw })).status;
      const out = { rx: rx.status, ry: ry.status, ryError: ryBody.error ?? '', refused: fake.count412() > n0, stored: JSON.parse(fake.getStored()).users[0], login };
      return { out, done: async () => { await stop(X.child); await stop(Y.child); await fake.close(); } };
    };
    const base = seededUser('u_acct', 'acct', 'acct@example.test', 'Sup3rSecret!23');
    // (a) reset on X, a wrong code on Y
    const a = await run('a', { ...base, recoveryCode: '123456', recoveryCodeExpires: Date.now() + 600000 },
      (p) => call(p, '/api/auth/reset-password', { email: base.email, code: '123456', newPassword: 'N3wSecret!pass' }),
      (p) => call(p, '/api/auth/reset-password', { email: base.email, code: '000000', newPassword: 'Oth3rSecret!pw' }));
    const aNew = await a.out.login('N3wSecret!pass'), aOld = await a.out.login('Sup3rSecret!23'); await a.done();
    // (b) owner verifies on X, someone re-registers the same unverified email on Y
    const b = await run('b', { ...base, isVerified: false, verificationCode: '111111', verificationCodeExpires: Date.now() + 600000 },
      (p) => call(p, '/api/auth/verify', { email: base.email, code: '111111', password: 'Sup3rSecret!23' }),
      (p) => call(p, '/api/auth/register', { username: 'intruder', email: base.email, password: 'Intrud3r!pass' }));
    const bIntruder = await b.out.login('Intrud3r!pass'), bOwner = await b.out.login('Sup3rSecret!23'); await b.done();
    // (c) one wrong code on each instance, 3 attempts already used: 3 + 1 + 1 = the lockout
    const c = await run('c', { ...base, recoveryCode: '123456', recoveryCodeExpires: Date.now() + 600000, recoveryCodeAttempts: 3 },
      (p) => call(p, '/api/auth/reset-password', { email: base.email, code: '000000', newPassword: 'N3wSecret!pass' }),
      (p) => call(p, '/api/auth/reset-password', { email: base.email, code: '000001', newPassword: 'N3wSecret!pass' }));
    await c.done();
    record('fixture: X\'s change landed first and Y answered from its stale copy (wrong code / re-register accepted); a/c uploads 412\'d, b\'s re-register wrote nothing',
      a.out.rx === 200 && a.out.ry === 400 && /Incorrect recovery code/.test(a.out.ryError) && a.out.refused
        && b.out.rx === 200 && b.out.ry === 200 && !b.out.refused && c.out.rx === 400 && c.out.ry === 400 && /Incorrect/.test(c.out.ryError) && c.out.refused,
      JSON.stringify([a, b, c].map((x) => [x.out.rx, x.out.ry, x.out.ryError.slice(0, 40), x.out.refused])));
    record('THE DEFECT: the acked reset stands, the intruder cannot sign in to the verified account, and attempts on both instances add up to the lockout',
      aNew === 200 && aOld === 401 && a.out.stored.tokenVersion === 1 && !a.out.stored.recoveryCode
        && bIntruder === 401 && bOwner === 200 && b.out.stored.isVerified === true
        && !c.out.stored.recoveryCode,
      `a new ${aNew} old ${aOld} tv ${a.out.stored.tokenVersion}; b intruder ${bIntruder} owner ${bOwner} verified ${b.out.stored.isVerified}; c code ${c.out.stored.recoveryCode ?? '-'} attempts ${c.out.stored.recoveryCodeAttempts ?? '-'}`);
    // (d) forgot on X (code mailed), a plain login on Y (legacy-hash rehash): the
    // mailed recovery code must survive whichever record wins (sweep 4, code loss).
    const mails0 = mailed.length;
    const d = await run('d', base,
      (p) => call(p, '/api/auth/forgot-password', { email: base.email }),
      (p) => call(p, '/api/auth/login', { email: base.email, password: 'Sup3rSecret!23' }));
    const dCode = mailed.slice(mails0).find((m) => m.to === base.email)?.code;
    const dReset = (await call(aX, '/api/auth/reset-password', { email: base.email, code: dCode, newPassword: 'N3wSecret!pass' })).status;
    await d.done();
    // (e) the ATTACKER registered first; the owner verifies on X (setting their
    // password and name), a wrong code is tried on Y: the owner's credentials
    // must win the merge (a verify is a credential change, sweep 6).
    const e = await run('e', { ...base, username: 'att', passwordHash: Buffer.from('Att4cker!pass').toString('base64'), isVerified: false, verificationCode: '111111', verificationCodeExpires: Date.now() + 600000 },
      (p) => call(p, '/api/auth/verify', { email: base.email, code: '111111', password: 'N3wOwner!pass', username: 'acct-owner' }),
      (p) => call(p, '/api/auth/verify', { email: base.email, code: '000000', password: 'Att4cker!pass', username: 'att3' }));
    const eOwner = await e.out.login('N3wOwner!pass'), eAtt = await e.out.login('Att4cker!pass');
    await e.done();
    record('fixture: (d) forgot mailed a code, (e) the owner verified on X and Y\'s wrong code was answered stale; both of Y\'s uploads 412\'d',
      d.out.rx === 200 && d.out.ry === 200 && d.out.refused && /^\d{6}$/.test(dCode ?? '')
        && e.out.rx === 200 && e.out.ry === 400 && /Incorrect/.test(e.out.ryError) && e.out.refused,
      JSON.stringify([[d.out.rx, d.out.ry, d.out.refused, !!dCode], [e.out.rx, e.out.ry, e.out.ryError.slice(0, 20), e.out.refused]]));
    record('THE DEFECT: a recovery code mailed on X works after Y\'s change merged; the owner\'s verify on X (password, name) survives Y\'s attempt',
      dReset === 200 && eOwner === 200 && eAtt === 401 && e.out.stored.isVerified === true && e.out.stored.username === 'acct-owner',
      `d reset ${dReset} stored ${d.out.stored.recoveryCode ? 'code' : 'none'}; e owner ${eOwner} attacker ${eAtt} verified ${e.out.stored.isVerified} name ${e.out.stored.username}`);

    // s22 — one instance, the pending-account family (sweeps 4-6). The owner's
    // code verified an ATTACKER's re-register password (pre-hijack), then each
    // re-register replaced the owner's code (loop DoS), a username login could
    // not verify, a username equal to someone's email shadowed them, and one
    // "email" could mail a code to a list or a Bcc. The code holder now owns the
    // account; a re-register only re-sends. FIXTURE: every code is read from the
    // mail actually sent, and every mail is counted per address.
    {
      const fake = await trackFake(startFakeGcsDb({ port: aGcs, initialContent: JSON.stringify({ users: [], games: [] }) }));
      let S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-pend-'))), aX, aGcs, mail)), aX);
      const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
      const codeFor = (to, from = 0) => mailed.slice(from).filter((m) => m.to === to).at(-1)?.code;
      const mailsTo = (to, from) => mailed.slice(from).filter((m) => m.to === to).length;
      const reg = async (u, email, pw) => j(await call(aX, '/api/auth/register', { username: u, email, password: pw }));
      const ver = async (body) => j(await call(aX, '/api/auth/verify', body));
      const login = async (email, password) => j(await call(aX, '/api/auth/login', { email, password }));
      const OWN = 'OwnerPass!23', ATT = 'Att4cker!pass';
      // Both orders; the attacker also re-registers AFTER the owner (the loop).
      const order = async (tag, attackerFirst) => {
        const email = `${tag}@example.test`, m0 = mailed.length;
        if (attackerFirst) await reg(`${tag}-att`, email, ATT);
        const own = await reg(`${tag}-owner`, email, OWN);
        const again = await reg(`${tag}-att2`, email, ATT);
        // Still pending: the owner's own password must reach verify (403), not
        // die as a 401 because a stranger's re-register replaced the hash.
        const pend = attackerFirst ? null : { o: (await login(email, OWN)).status, a: (await login(email, ATT)).status };
        const v = await ver({ email, code: codeFor(email, m0), password: OWN, username: `${tag}-owner` });
        return { mails: mailsTo(email, m0), own: own.status, again: again.status, pend, v, o: await login(email, OWN), a: await login(email, ATT) };
      };
      const ownerFirst = await order('of', false);
      const attFirst = await order('af', true);
      const reAfter = await reg('late-att', 'af@example.test', ATT);
      const verOnVerified = await ver({ email: 'af@example.test', code: codeFor('af@example.test'), password: ATT, username: 'late-att' });
      const afterBoth = { o: await login('af@example.test', OWN), a: await login('af@example.test', ATT) };
      const noPassword = await ver({ email: 'of@example.test', code: '123456' });
      const m5 = mailed.length;
      const fp1 = await j(await call(aX, '/api/auth/forgot-password', { email: 'of@example.test' }));
      const fp2 = await j(await call(aX, '/api/auth/forgot-password', { email: 'of@example.test' }));
      const fpMails = mailsTo('of@example.test', m5);
      await stop(S.child); // fresh process: register is limited to 8/min per IP
      S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-pend2-'))), aX, aGcs, mail)), aX);
      // Five wrong codes lock it; the right one then fails, and a re-register
      // inside the minute mails nothing (locking must not buy a fresh mail).
      const lk = 'lock@example.test', m1 = mailed.length;
      await reg('locker', lk, OWN);
      const lkCode = codeFor(lk, m1), tries = [];
      for (let i = 0; i < 5; i++) tries.push(await ver({ email: lk, code: lkCode === '000000' ? '000001' : '000000', password: OWN }));
      const lkAfter = await ver({ email: lk, code: lkCode, password: OWN });
      const lkResend = await reg('locker', lk, OWN);
      const lkMails = mailsTo(lk, m1);
      // A NEW password at verify meets the policy and names the account; both
      // are checked before the code, so neither costs an attempt.
      const po = 'policy@example.test', m2 = mailed.length;
      await reg('pol-att', po, ATT);
      const poCode = codeFor(po, m2);
      const weak = await ver({ email: po, code: poCode, password: 'weakpass', username: 'pol-owner' });
      const noName = await ver({ email: po, code: poCode, password: OWN });
      const poOk = await ver({ email: po, code: poCode, password: OWN, username: 'pol-owner' });
      // Verify by the username login used (login's 403 path sends no name).
      const un = 'uname@example.test', m3 = mailed.length;
      await reg('Unamed', un, OWN);
      const l403 = await login('unamed', OWN);
      const vByName = await ver({ email: 'unamed', code: codeFor(un, m3), password: OWN });
      // A username set to someone else's email does not shadow them.
      const sh = 'shadow@example.test', m4 = mailed.length;
      await reg(sh, 'squatter@example.test', ATT);
      await reg('shadowed', sh, OWN);
      const vSh = await ver({ email: sh, code: codeFor(sh, m4), password: OWN, username: 'shadowed' });
      const lSh = await login(sh, OWN);
      // One mailbox per address: a list, an angle-addr or a CRLF Bcc is a 400 and mails nothing.
      const m6 = mailed.length;
      const shapes = [];
      for (const bad of ['x@example.test, e@evil.test', '<e@evil.test>']) shapes.push((await reg('shape', bad, OWN)).status);
      shapes.push((await j(await call(aX, '/api/auth/forgot-password', { email: 'x@example.test\r\nBcc: e@evil.test' }))).status);
      const shapeMails = mailed.length - m6;
      await stop(S.child); await fake.close();
      record('fixture: every contested address got exactly ONE mail and its code; the lock loop ran 5 verifies; the username login got its 403',
        ownerFirst.mails === 1 && attFirst.mails === 1 && /^\d{6}$/.test(lkCode ?? '') && /^\d{6}$/.test(poCode ?? '') && tries.length === 5
          && l403.status === 403 && l403.body.needVerification === true,
        JSON.stringify({ of: ownerFirst.mails, af: attFirst.mails, lk: !!lkCode, po: !!poCode, l403: l403.status }));
      record('THE DEFECT (pre-hijack, loop): in both orders the code holder owns the account with their name; re-registers in between change nothing',
        [ownerFirst, attFirst].every((r) => r.own === 200 && r.again === 200 && r.v.status === 200 && r.o.status === 200 && r.a.status === 401)
          && ownerFirst.o.body.user?.username === 'of-owner' && attFirst.o.body.user?.username === 'af-owner'
          && ownerFirst.pend.o === 403 && ownerFirst.pend.a === 401,
        JSON.stringify([ownerFirst, attFirst].map((r) => [r.own, r.again, r.pend, r.v.status, r.o.status, r.o.body.user?.username, r.a.status])));
      record('THE DEFECT: after verify, re-register is refused and verify sets nothing (no reset path); verify without a password is a 400',
        reAfter.status === 400 && verOnVerified.status === 400 && /already verified/.test(verOnVerified.body.error ?? '')
          && afterBoth.o.status === 200 && afterBoth.a.status === 401 && noPassword.status === 400 && /password/.test(noPassword.body.error ?? ''),
        JSON.stringify({ reAfter: reAfter.status, verOnVerified: verOnVerified.status, owner: afterBoth.o.status, attacker: afterBoth.a.status, noPassword: noPassword.status }));
      record('THE DEFECT: 5 wrong codes lock it (then the right one fails) and a re-register inside the minute mails nothing (429)',
        tries.slice(0, 4).every((t) => /Incorrect/.test(t.body.error ?? '')) && /Too many/.test(tries[4].body.error ?? '')
          && lkAfter.status === 400 && lkResend.status === 429 && lkMails === 1,
        JSON.stringify({ tries: tries.map((t) => (t.body.error ?? '').slice(0, 12)), after: lkAfter.status, resend: lkResend.status, lkMails }));
      record('THE DEFECT: a new password at verify must meet the policy and bring a name, checked before the code (the code still verifies after)',
        weak.status === 400 && /at least 8 characters/.test(weak.body.error ?? '') && noName.status === 400 && /username/.test(noName.body.error ?? '')
          && poOk.status === 200 && poOk.body.username === 'pol-owner',
        JSON.stringify({ weak: [weak.status, (weak.body.error ?? '').slice(0, 30)], noName: noName.status, ok: [poOk.status, poOk.body.username] }));
      record('THE DEFECT: verify accepts the username login used; a username equal to another\'s email does not shadow them',
        vByName.status === 200 && vSh.status === 200 && lSh.status === 200 && lSh.body.user?.username === 'shadowed',
        JSON.stringify({ byName: vByName.status, shadowVerify: vSh.status, shadowLogin: [lSh.status, lSh.body.user?.username] }));
      record('THE DEFECT: one recovery mail per minute (second request 200, no mail); malformed addresses are a 400 and mail nothing',
        fp1.status === 200 && fp2.status === 200 && fpMails === 1 && shapes.every((st) => st === 400) && shapeMails === 0,
        JSON.stringify({ fp: [fp1.status, fp2.status], fpMails, shapes, shapeMails }));
    }

    // s23 — pending rows outlive a failed send now (sweep 6). (a) A squatter
    // registers the owner's email while mail is down: once mail is back the
    // owner's register re-sends at once, and the code holder owns the account.
    // (b) New sign-ups sweep pending rows whose code died a day ago and own no
    // games (db.json cannot grow without bound). (c) Locking a code and letting
    // the sweep take it does not buy a second mail inside the minute.
    {
      const day = 86400000, dead = Date.now() - 2 * day;
      const pend = (id, extra = {}) => ({ ...seededUser(id, id, `${id}@example.test`, 'Sup3rSecret!23'), isVerified: false, verificationCode: '1', verificationCodeExpires: dead, ...extra });
      const fake = await trackFake(startFakeGcsDb({ port: aGcs, initialContent: JSON.stringify({
        users: [pend('p_old'), pend('p_game'), pend('p_recent', { verificationCodeExpires: Date.now() - 1000 }), seededUser('p_ver', 'p_ver', 'p_ver@example.test', 'Sup3rSecret!23'),
          // Live codes this process never mailed (its cooldown is free), so a
          // re-register reaches the re-send path, not the cooldown (isolates it).
          pend('p_live', { verificationCode: '222222', verificationCodeExpires: Date.now() + 600000 }),
          pend('p_tried', { verificationCode: '333333', verificationCodeExpires: Date.now() + 600000, verificationCodeAttempts: 4 })],
        games: [{ id: 'g_p', userId: 'p_game', name: 'Kept', description: '', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, createdAt: '2026-01-01T00:00:00Z' }],
      }) }));
      // Mail "down": a closed port. The server answers 500 fast (connection refused).
      const S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-squat-'))), aX, aGcs, { ...mail, SMTP_PORT: String(gcsPortA + 53) })), aX); // nothing binds it: mail down
      const reg = (p, u, email, pw) => call(p, '/api/auth/register', { username: u, email, password: pw });
      const jv = async (body) => { const r = await call(aX, '/api/auth/verify', body); return { status: r.status, error: (await r.json().catch(() => ({}))).error ?? '' }; };
      const V = 'squatted@example.test';
      const squat = await reg(aX, 'squatter', V, 'Att4cker!pass');
      await stop(S.child);
      const S2 = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-squat2-'))), aX, aGcs, mail)), aX);
      // A stranger's re-register re-sends the SAME live code and leaves its attempts: the holder still verifies, 4 + 1 still locks.
      const liveM0 = mailed.length;
      const reLive = (await reg(aX, 'stranger', 'p_live@example.test', 'Att4cker!pass')).status;
      const reTried = (await reg(aX, 'stranger2', 'p_tried@example.test', 'Att4cker!pass')).status;
      const resent = mailed.slice(liveM0).map((m) => m.code);
      // Past the cooldown (this process never mailed p_live), a re-send still
      // changes no credential: the stored password reaches verify, the stranger's does not.
      const liveLogins = [(await call(aX, '/api/auth/login', { email: 'p_live@example.test', password: 'Sup3rSecret!23' })).status,
        (await call(aX, '/api/auth/login', { email: 'p_live@example.test', password: 'Att4cker!pass' })).status];
      const takenName = await jv({ email: 'p_live@example.test', code: '222222', password: 'OwnerPass!23', username: 'p_ver' });
      // Case variants of the verified p_ver (sweep 13 probe): a same-case repeat cannot tell a folded compare from an exact one.
      const errOf = async (r) => `${r.status} ${(await r.json().catch(() => ({}))).error ?? ''}`;
      const dupCase = [await errOf(await reg(aX, 'P_Ver', 'fresh-case@example.test', 'Sup3rSecret!23')),
        await errOf(await reg(aX, 'fresh-case', ' P_VER@Example.TEST ', 'Sup3rSecret!23'))];
      const liveOk = await jv({ email: 'p_live@example.test', code: '222222', password: 'OwnerPass!23', username: 'p_live-owner' });
      const triedLock = await jv({ email: 'p_tried@example.test', code: '000000', password: 'OwnerPass!23', username: 'p_tried-owner' });
      const m0 = mailed.length;
      const own = await reg(aX, 'squat-owner', V, 'OwnerPass!23');
      const vCode = mailed.slice(m0).filter((m) => m.to === V).at(-1)?.code;
      const v = await call(aX, '/api/auth/verify', { email: V, code: vCode, password: 'OwnerPass!23', username: 'squat-owner' });
      const lo = await call(aX, '/api/auth/login', { email: V, password: 'OwnerPass!23' }); const lj = await lo.json().catch(() => ({}));
      const la = (await call(aX, '/api/auth/login', { email: V, password: 'Att4cker!pass' })).status;
      await waitUntil(() => JSON.parse(fake.getStored()).users.some((u) => u.email === V && u.isVerified), 5000);
      const ids = JSON.parse(fake.getStored()).users.map((u) => u.id);
      const L = 'relock@example.test', m1 = mailed.length;
      await reg(aX, 'relock', L, 'OwnerPass!23');
      for (let i = 0; i < 5; i++) await call(aX, '/api/auth/verify', { email: L, code: '000000', password: 'OwnerPass!23' });
      const again = (await reg(aX, 'relock2', L, 'OwnerPass!23')).status;
      const lMails = mailed.slice(m1).filter((m) => m.to === L).length;
      await stop(S2.child); await fake.close();
      record('fixture: the squat register failed its send (500), the row stayed, and the owner\'s register mailed a code at once',
        squat.status === 500 && own.status === 200 && /^\d{6}$/.test(vCode ?? ''), JSON.stringify({ squat: squat.status, own: own.status, code: !!vCode }));
      record('THE DEFECT: a row squatted while mail was down never holds the owner: they verify and own it; the squatter\'s password never signs in',
        v.status === 200 && lo.status === 200 && lj.user?.username === 'squat-owner' && la === 401,
        JSON.stringify({ verify: v.status, owner: [lo.status, lj.user?.username], squatter: la }));
      record('THE DEFECT: a stranger\'s re-register re-sends the same live code (holder verifies) and keeps its attempts (4 + 1 locks); a taken name is refused first',
        reLive === 200 && reTried === 200 && JSON.stringify(resent) === '["222222","333333"]' && JSON.stringify(liveLogins) === '[403,401]'
          && takenName.status === 400 && /already taken/.test(takenName.error)
          && liveOk.status === 200 && /Too many/.test(triedLock.error),
        JSON.stringify({ reLive, reTried, resent, liveLogins, takenName: takenName.status, liveOk: liveOk.status, triedLock: triedLock.error.slice(0, 20) }));
      record('register folds case: P_Ver is a taken name and P_VER@Example.TEST an existing account (400 with that reason, not a new row)',
        /^400 .*already taken/.test(dupCase[0]) && /^400 .*already exists/.test(dupCase[1]), JSON.stringify(dupCase));
      record('THE DEFECT: a sign-up sweeps pending rows dead a day with no games; recent, game-owning and verified rows stay; a locked code buys no second mail',
        !ids.includes('p_old') && ids.includes('p_game') && ids.includes('p_recent') && ids.includes('p_ver') && again === 429 && lMails === 1,
        JSON.stringify({ old: ids.includes('p_old'), game: ids.includes('p_game'), recent: ids.includes('p_recent'), ver: ids.includes('p_ver'), again, lMails }));
    }

    // s24 — the hosted account surface (sweep 12/13 angles, director audit 09-24):
    // a reset ends every earlier session; games are owner-only; /me and login
    // serialize no secret; adopt-local does not exist hosted, signed in or not.
    // FIXTURE: two verified seeded users and one game, the code read from the mail sent.
    {
      const fake = await trackFake(startFakeGcsDb({ port: aGcs, initialContent: JSON.stringify({
        users: [seededUser('h_a', 'h_a', 'h_a@example.test', 'Sup3rSecret!23'), seededUser('h_b', 'h_b', 'h_b@example.test', 'Sup3rSecret!23')],
        games: [{ id: 'g_ha', userId: 'h_a', name: 'A-own', description: '', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, createdAt: '2026-01-01T00:00:00Z' }] }) }));
      const S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-acct24-'))), aX, aGcs, mail)), aX);
      const req = async (method, route, token, body) => {
        const r = await fetch(`http://127.0.0.1:${aX}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      const signIn = (email, password) => req('POST', '/api/auth/login', null, { email, password });
      const la = await signIn('h_a@example.test', 'Sup3rSecret!23'), lb = await signIn('h_b@example.test', 'Sup3rSecret!23');
      const tA = la.body.token, tB = lb.body.token;
      const me = await req('GET', '/api/auth/me', tA);
      const bPatch = await req('PATCH', '/api/games/g_ha', tB, { name: 'hijack' });
      const bDelete = await req('DELETE', '/api/games/g_ha', tB);
      const bList = await req('GET', '/api/games', tB), aList = await req('GET', '/api/games', tA);
      const adopt = [(await req('POST', '/api/games/adopt-local', tA)).status, (await req('POST', '/api/games/adopt-local')).status];
      const m0 = mailed.length;
      await req('POST', '/api/auth/forgot-password', null, { email: 'h_a@example.test' });
      const rc = mailed.slice(m0).filter((m) => m.to === 'h_a@example.test').at(-1)?.code;
      const reset = await req('POST', '/api/auth/reset-password', null, { email: 'h_a@example.test', code: rc, newPassword: 'N3wSecret!pass' });
      const old = [(await req('GET', '/api/auth/me', tA)).status, (await req('GET', '/api/games', tA)).status];
      const fresh = await signIn('h_a@example.test', 'N3wSecret!pass');
      const after = [fresh.status, (await req('GET', '/api/auth/me', fresh.body.token)).status, (await req('GET', '/api/auth/me', tB)).status];
      await stop(S.child); await fake.close();
      record('fixture: both seeded users signed in, the recovery mail carried a code, and the reset answered 200',
        la.status === 200 && lb.status === 200 && /^\d{6}$/.test(rc ?? '') && reset.status === 200, JSON.stringify({ la: la.status, lb: lb.status, rc: !!rc, reset: reset.status }));
      record('a password reset ends every earlier session (old token 401 on /me and /games); the new password signs in; the other account stays signed in',
        JSON.stringify(old) === '[401,401]' && JSON.stringify(after) === '[200,200,200]', JSON.stringify({ old, after }));
      record('hosted games are owner-only: another account\'s PATCH and DELETE are 403 and its list omits the game; the owner keeps it, unrenamed',
        bPatch.status === 403 && bDelete.status === 403 && Array.isArray(bList.body) && !bList.body.some((g) => g.id === 'g_ha')
          && Array.isArray(aList.body) && aList.body.some((g) => g.id === 'g_ha' && g.name === 'A-own'),
        JSON.stringify({ patch: bPatch.status, del: bDelete.status, bSees: bList.body?.length, aHas: aList.body?.map?.((g) => g.name) }));
      const keys = (o) => Object.keys(o ?? {}).sort().join();
      record('/me and login carry only id, username, email: no hash, code or token version',
        keys(me.body) === 'email,id,username' && keys(la.body.user) === 'email,id,username'
          && !/passwordHash|Code|tokenVersion/.test(JSON.stringify([me.body, la.body])),
        JSON.stringify({ me: keys(me.body), login: keys(la.body.user), top: keys(la.body) }));
      record('adopt-local does not exist hosted: 404 signed in and signed out', JSON.stringify(adopt) === '[404,404]', JSON.stringify(adopt));
    }

    // s25 — hosted growth bounds (S14-1: a game flood OOM-crashed a 128 MB heap at
    // ~23 MB of db.json). (a) An account at the cap gets 409 with the reason; a
    // clientRequestId retry of an existing row still saves. (b) The store boots
    // ALREADY over budget (1000 bytes under the measured seed): a new game, a growing
    // edit and a sign-up are 507; a shrinking edit, a delete, login and a verify still
    // work while it stays over budget, and they reach GCS.
    {
      const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
      const capRows = Array.from({ length: 200 }, (_, i) => ({ id: `g_cap_${i}`, userId: 'u_cap', name: `Cap ${i}`, description: 'd', payoffs: pay,
        ...(i === 0 ? { clientRequestId: 'req_retry_0' } : {}), createdAt: '2026-01-01T00:00:00Z' }));
      const seed = { users: [seededUser('u_cap', 'capper', 'cap@example.test', 'Sup3rSecret!23'), seededUser('u_b', 'budget', 'b@example.test', 'Sup3rSecret!23'),
        { ...seededUser('u_pv', 'pendv', 'pv@example.test', 'Sup3rSecret!23'), isVerified: false, verificationCode: '424242', verificationCodeExpires: Date.now() + 600000 }],
        games: [...capRows, { id: 'g_b1', userId: 'u_b', name: 'B-one', description: 'x'.repeat(400), payoffs: pay, createdAt: '2026-01-01T00:00:00Z' }] };
      const seedBytes = Buffer.byteLength(JSON.stringify(seed, null, 2));
      const fake = await trackFake(startFakeGcsDb({ port: aGcs, initialContent: JSON.stringify(seed) }));
      // Over budget from boot; the shrink (~395 B) and the delete (~250 B) leave it over, so an
      // absolute "size > budget" check (not "grows past it") refuses them and fails this section.
      const budget = seedBytes - 1000;
      const S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-budget-'))), aX, aGcs, { ...mail, DB_MAX_BYTES: String(budget) })), aX);
      const req = async (method, route, token, body) => {
        const r = await fetch(`http://127.0.0.1:${aX}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, error: (await r.json().catch(() => ({}))).error ?? '' };
      };
      const tokOf = async (email) => (await (await fetch(`http://127.0.0.1:${aX}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Sup3rSecret!23' }) })).json()).token;
      const tCap = await tokOf('cap@example.test'), tB = await tokOf('b@example.test');
      const capNew = await req('POST', '/api/games', tCap, { name: 'One too many', payoffs: pay });
      const capRetry = await req('POST', '/api/games', tCap, { name: 'Cap 0', description: 'd', payoffs: pay, clientRequestId: 'req_retry_0' }); // same size: not growth
      const fullNew = await req('POST', '/api/games', tB, { name: 'B-two', description: 'y'.repeat(400), payoffs: pay });
      const grow = await req('PATCH', '/api/games/g_b1', tB, { description: 'z'.repeat(800) });
      const m0 = mailed.length;
      const signUp = await req('POST', '/api/auth/register', null, { username: 'late', email: 'late@example.test', password: 'Sup3rSecret!23' });
      const signUpMails = mailed.length - m0;
      const shrink = await req('PATCH', '/api/games/g_b1', tB, { description: 'short' });
      const del = await req('DELETE', '/api/games/g_cap_5', tCap);
      const login = (await req('POST', '/api/auth/login', null, { email: 'b@example.test', password: 'Sup3rSecret!23' })).status;
      const verify = await req('POST', '/api/auth/verify', null, { email: 'pv@example.test', code: '424242', password: 'Sup3rSecret!23' });
      const onGcs = await waitUntil(() => { try { const d = JSON.parse(fake.getStored()); return !d.games.some((g) => g.id === 'g_cap_5') && d.games.find((g) => g.id === 'g_b1')?.description === 'short'; } catch { return false; } }, 5000);
      const endBytes = Buffer.byteLength(JSON.stringify(JSON.parse(fake.getStored()), null, 2));
      await stop(S.child); await fake.close();
      record('fixture: the store booted and ended over budget (the shrink and delete ran while it was full); the cap account held exactly 200 games',
        seedBytes > budget && endBytes > budget && endBytes < seedBytes && capRows.length === 200, JSON.stringify({ seedBytes, budget, endBytes }));
      record('THE DEFECT (per-account cap): the 201st game is 409 with the limit named; a clientRequestId retry of an existing row still saves',
        capNew.status === 409 && /200 saved-game limit/.test(capNew.error) && /Delete a saved game/.test(capNew.error) && capRetry.status === 200,
        JSON.stringify({ capNew, capRetry: capRetry.status }));
      record('THE DEFECT (storage budget): past the budget a new game and a growing edit are 507 with the reason, and a sign-up is 507 and mails nothing',
        fullNew.status === 507 && /storage is full/.test(fullNew.error) && /Delete a saved game/.test(fullNew.error)
          && grow.status === 507 && /storage is full/.test(grow.error) && signUp.status === 507 && /sign-ups are paused/.test(signUp.error) && signUpMails === 0,
        JSON.stringify({ fullNew, grow, signUp, signUpMails }));
      record('over budget a shrinking edit, a delete, login and a verify still work, and the acked changes reach GCS',
        shrink.status === 200 && del.status === 200 && login === 200 && verify.status === 200 && onGcs,
        JSON.stringify({ shrink: shrink.status, del: del.status, login, verify: verify.status, onGcs }));
    }
  }

  record('THE DEFECT: across every section, no upload was sent without a numeric generation precondition',
    unconditionalUploads.length === 0, JSON.stringify(unconditionalUploads.slice(0, 5)));

} finally {
  for (const c of children) { try { await stop(c); } catch { /* already gone */ } }
  for (const f of fakes) { try { await f.close(); } catch { /* already closed */ } }
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

const failed = results.filter((r) => !r.pass);
if (results.length !== EXPECTED_CHECKS) {
  console.error(`CHECK FLOOR FAILED: ${results.length} checks ran, expected exactly ${EXPECTED_CHECKS}`);
  process.exit(1);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

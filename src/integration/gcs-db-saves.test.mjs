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
// + 2 unread-store gate (section 3) + 12 shape/legacy-warning (6) + 11 merge (7, 7b, 7c, 7d) + 3 outage/drain (8) + 4 abandoned (9, 9b) + 2 no-generation (10) + 1 suite-wide precondition.
// Calibrated by RUNNING the suite, not by counting by eye — this constant has
// now been wrong twice (22 vs 21, then 21 vs 23) and the floor caught it both
// times, which is the whole point of declaring rather than counting.
const EXPECTED_CHECKS = 60;
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
  let uploadDelayMs = 0, omitGeneration = false, dropUploads = false, afterStoreOnce = null;
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const objectPath = `/b/${BUCKET}/o/${encodeURIComponent(OBJECT)}`;

    if (req.method === 'GET' && u.pathname === objectPath) {
      if (u.searchParams.get('alt') === 'media') {
        if (stored === null) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(stored);
        return;
      }
      if (stored === null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 404, message: 'not found' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: OBJECT, bucket: BUCKET, generation: String(generation), size: String(stored.length) }));
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

        if (ifGenerationMatch !== null) {
          const want = ifGenerationMatch === '0' ? null : String(generation);
          const have = stored === null ? null : String(generation);
          const matches = ifGenerationMatch === '0' ? stored === null : ifGenerationMatch === have;
          if (!matches) {
            res.writeHead(412, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 412, message: 'Precondition Failed' } }));
            return;
          }
        }
        stored = content;
        generation += 1;
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
  // to send the verification email, then calls saveDB() AGAIN to remove it
  // once the email step fails — two real writes, both exercising the fix,
  // regardless of the outer HTTP response being a 500.
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
  record('the failed registration\'s user was still correctly removed again (the SECOND save is not itself broken by the merge)',
    JSON.stringify(finalZUsernames) === JSON.stringify(['userz']), JSON.stringify(finalZUsernames));
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
    /GCS deadline exceeded after 500ms: db\.json exists\(\) never answered/.test(deadlineBoot.log()), deadlineBoot.log().slice(-500));
  await stop(deadlineBoot.child); await deadlineFake.close();

  const slowPort = gcsPortA + 8, slowAppPort = port1 + 40;
  const slowFake = await trackFake(startDeadlineGcs(slowPort, deadlineDb));
  slowFake.delay(OBJECT, 1000);
  const slowBoot = await waitReady(track(spawnServer(
    trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-slow-'))), slowAppPort, slowPort,
    { GCS_DEADLINE_MS: '1500' },
  )), slowAppPort);
  record('fixture: slow control delayed every boot db.json read by 1 second',
    slowFake.reads().filter((r) => r.name === OBJECT).length >= 3, JSON.stringify(slowFake.reads()));
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
      && /GCS deadline exceeded after 800ms: db\.json exists\(\) never answered/.test(resyncBoot.log()),
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
    for (const t of [tokY1, tokY2]) {
      await fetch(`http://127.0.0.1:${dY}/api/auth/delete-confirm`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ code: '654321' }) });
      await settle();
    }
    const deletedFirst = onGcs().users.length === 0;
    fake.setUploadDelayMs(1500); // X's first upload is held, then 412s: both changes below land in ONE merge
    await fetch(`http://127.0.0.1:${dX}/api/auth/forgot-password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'd2@example.test' }) });
    const orphan = await fetch(`http://127.0.0.1:${dX}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokX}` },
      body: JSON.stringify({ name: 'Orphan-Game', payoffs: pay }) });
    fake.setUploadDelayMs(0);
    await new Promise((r) => setTimeout(r, 2500)); await settle();
    const fin = onGcs();
    record('fixture: both deletions reached GCS before the stale instance merged, and X accepted its writes',
      deletedFirst && orphan.status === 200, `users on GCS before: ${deletedFirst ? 0 : 'some'}, orphan POST ${orphan.status}`);
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
      const v = await call(p, '/api/auth/verify', { email, code });
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
    await stop(X.child); await stop(Y.child); await fake.close(); smtp.close();

    // 7d. THE FOLDED ID STILL OWNS WHAT ITS INSTANCE SAVES NEXT. Account A is
    // on GCS unverified; Y registers the same email as B and verifies it
    // before its merge, so the merge keeps verified B and folds A. X, which
    // still holds A, verifies A and saves a game in the same window. That
    // game must end up owned by the surviving account, not by an id that no
    // longer exists. CONTROL: X accepted the game (200).
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
    fake2.peerWrite(JSON.stringify({ users: [{ ...seededUser('u_A', 'annie', 'fold@example.test', 'Sup3rSecretA'),
      isVerified: false, verificationCode: '111111', verificationCodeExpires: Date.now() + 600000 }], games: [] }));
    const X2 = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-foldx-'))), fX, fGcs)), fX);
    fake2.setUploadDelayMs(2500);
    await call(fY, '/api/auth/register', { username: 'bella', email: 'fold@example.test', password: 'Sup3rSecretB' });
    const vB = await call(fY, '/api/auth/verify', { email: 'fold@example.test', code: codes.at(-1) });
    const vA = await call(fX, '/api/auth/verify', { email: 'fold@example.test', code: '111111' });
    const tA = (await (await call(fX, '/api/auth/login', { email: 'fold@example.test', password: 'Sup3rSecretA' })).json()).token;
    const late = await call(fX, '/api/games', { name: 'A-Late', payoffs: pay }, tA);
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
      `verify B ${vB.status}, verify A ${vA.status}, game ${late.status}, sent under u_A ${savedForA}, settled ${settled}; users ${JSON.stringify(fin2.users.map((u) => u.id))}`);
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
    fake.setUploadDelayMs(2000); // stored AFTER the 800ms deadline: the process never learns it landed
    const made = await (await fetch(`http://127.0.0.1:${aApp}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: 'Created-Then-Deleted', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }) })).json();
    const landed = await waitUntil(() => { try { return JSON.parse(fake.getStored()).games.length === 1; } catch { return false; } }, 5000);
    fake.setUploadDelayMs(0);
    const del = await fetch(`http://127.0.0.1:${aApp}/api/games/${made.game?.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    await new Promise((r) => setTimeout(r, 4000));
    const list = await (await fetch(`http://127.0.0.1:${aApp}/api/games`, { headers: { authorization: `Bearer ${tok}` } })).json();
    let storedGames = null; try { storedGames = JSON.parse(fake.getStored()).games.length; } catch { /* reported */ }
    record('fixture: the abandoned upload DID land on GCS before the delete', landed, fake.getStored().slice(0, 200));
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

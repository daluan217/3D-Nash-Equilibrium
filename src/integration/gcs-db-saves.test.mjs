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
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
const BUCKET = 'fake-nash-db-bucket';
const OBJECT = 'db.json';

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
function startFakeGcsDb({ port, initialContent, initialGeneration = 1 }) {
  let stored = initialContent; // null = object does not exist
  let generation = initialGeneration;
  const uploadLog = []; // { atMs, ifGenerationMatch, body }
  let uploadDelayMs = 0;
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

        if (uploadDelayMs > 0) await new Promise((r) => setTimeout(r, uploadDelayMs));

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
        res.end(JSON.stringify({ name: OBJECT, bucket: BUCKET, generation: String(generation), size: String(stored.length) }));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 404 } }));
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      close: () => new Promise((r) => server.close(() => r())),
      getStored: () => stored,
      getGeneration: () => generation,
      uploadCount: () => uploadLog.length,
      uploadLog: () => uploadLog,
      setUploadDelayMs: (ms) => { uploadDelayMs = ms; },
    }));
  });
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
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((res) => child.once('exit', res));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  await ended;
  clearTimeout(timer);
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

try {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. SINGLE-PROCESS: N rapid saves must COALESCE, not fire N independent
  // uploads. The fake server holds the FIRST upload response for a while, so
  // several more saves pile up behind it before any second upload can start.
  // ───────────────────────────────────────────────────────────────────────────
  const seededDb1 = { users: [seededUser('u_gcsrace', 'gcsraceuser', 'gcsraceuser@example.test', 'Sup3rSecret!23')], games: [] };
  fakeGcs = await startFakeGcsDb({ port: gcsPortA, initialContent: JSON.stringify(seededDb1) });
  const port1 = Number(process.env.GCS_DB_TEST_PORT || 3131);
  srv = await waitReady(spawnServer(mkdtempSync(path.join(tmpdir(), 'nash-gcsdb-')), port1, gcsPortA), port1);

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

  // Give the (delayed) in-flight upload and any coalesced follow-up time to land.
  await new Promise((r) => setTimeout(r, 2500));

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
  const gcsPortB = gcsPortA + 1;
  fakeGcs = await startFakeGcsDb({ port: gcsPortB, initialContent: JSON.stringify(seededDb2) });

  const portX = port1 + 10, portY = port1 + 11;
  const cwdX = mkdtempSync(path.join(tmpdir(), 'nash-gcsdb-x-'));
  const cwdY = mkdtempSync(path.join(tmpdir(), 'nash-gcsdb-y-'));
  const childX = spawnServer(cwdX, portX, gcsPortB);
  const childY = spawnServer(cwdY, portY, gcsPortB);
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
    JSON.stringify(finalMultiNames) === JSON.stringify(['Game-X', 'Game-Y']),
    JSON.stringify(finalMultiNames));

  await stop(childX);
  await stop(childY);
  await fakeGcs.close(); fakeGcs = null;

} finally {
  if (srv?.child) await stop(srv.child);
  if (fakeGcs) await fakeGcs.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

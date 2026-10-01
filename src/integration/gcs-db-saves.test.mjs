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
import zlib from 'node:zlib';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
const BUCKET = 'fake-nash-db-bucket';
const OBJECT = 'db.json';
const VERSION_OBJECT = 'app-version.json';

// 12 pre-existing + 9 deadline (section 4) + 3 hung-re-sync (section 5)
// + 2 unread-store gate (section 3) + 12 shape/legacy-warning (6) + 12 merge (7, 7b, 7c incl. rename visibility, 7d) + 3 outage/drain (8) + 4 abandoned (9, 9b) + 2 no-generation (10) + 3 SMTP deadline + feedback injection (11) + 2 fresh reads (12) + 2 auth field types (13) + 2 412 storm (14) + 2 provider hang (15) + 2 re-check straddle (16) + 2 generation race (17) + 2 re-check cost (18) + 2 dropped-read peer write (19) + 2 backoff freshness (20) + 2 account conflict (21) + 2 sybil fill (s31) + 5 legacy-games migration (s32) + 2 unfinished deletions (s33) + 1 suite-wide precondition.
// Calibrated by RUNNING the suite, not by counting by eye — this constant has
// now been wrong twice (22 vs 21, then 21 vs 23) and the floor caught it both
// times, which is the whole point of declaring rather than counting.
const EXPECTED_CHECKS = 148;
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
 * A fake GCS JSON/upload API holding any number of objects: `db.json` (the
 * accounts) and `games/<encodeURIComponent(userId)>.json` (each account's
 * saved games). The calls server.ts makes: metadata GET and a download bound
 * to a generation (`?alt=media&generation=`), a multipart upload (`name` and
 * `ifGenerationMatch` as query parameters, 412 on mismatch), a conditional
 * DELETE and a prefix LIST — each probed against the real
 * `@google-cloud/storage` client (7.22.0) before this fake was written.
 * Generations come from ONE increasing counter, as GCS's never repeat for a
 * name: a re-created object never satisfies an old precondition. Hooks given
 * no name apply to every object; controls given no name mean db.json.
 */
// Every upload any fake saw without a numeric generation precondition.
// What GCS does with `ifGenerationMatch=` (empty) is not something this suite
// can know, so SENDING one is the defect: an unread store written blindly.
const unconditionalUploads = [];
const gamesObject = (userId) => `games/${encodeURIComponent(userId)}.json`;
function startFakeGcsDb({ port, initialContent, initialGeneration = 1, deferListen = false, initialObjects = {} }) {
  let gen = initialGeneration;
  const objects = new Map(); // name -> { content, generation, custom } (custom: metadata the upload that wrote it set)
  if (initialContent !== null && initialContent !== undefined) objects.set(OBJECT, { content: initialContent, generation: gen, custom: null });
  for (const [name, content] of Object.entries(initialObjects)) objects.set(name, { content, generation: ++gen, custom: null });
  const write = (name, content, custom) => { gen += 1; objects.set(name, { content, generation: gen, custom }); };
  const uploadLog = []; // { name, atMs, ifGenerationMatch, body, landedGen?, dropped?, failed? }
  const removeLog = []; // { name, ifGenerationMatch, status }
  let uploadDelayMs = 0, omitGeneration = false, dropUploads = false, n412 = 0, failUploads = false, failNames = new Set();
  let readDelay = { meta: 0, media: 0 }, metaGets = 0, stale404s = 0, lists = 0;
  const metaGetsBy = new Map(), afterStore = [], afterMeta = []; // one-shot hooks: { name, f }
  const takeHook = (list, name) => { const i = list.findIndex((h) => h.name === null || h.name === name); return i === -1 ? null : list.splice(i, 1)[0]; };
  const readLog = []; // media GETs: { name, arrivedGen, want, atMs, doneMs }
  const startedAt = Date.now();
  const base = `/b/${BUCKET}/o`;
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === base) {
      lists += 1;
      const prefix = u.searchParams.get('prefix') ?? '';
      json(res, 200, { kind: 'storage#objects', items: [...objects].filter(([n]) => n.startsWith(prefix))
        .map(([name, o]) => ({ name, bucket: BUCKET, generation: String(o.generation), size: String(o.content.length), ...(o.custom ? { metadata: o.custom } : {}) })) });
      return;
    }
    const name = u.pathname.startsWith(`${base}/`) ? decodeURIComponent(u.pathname.slice(base.length + 1)) : null;

    if (req.method === 'GET' && name !== null) {
      // Metadata: `meta` delay is inbound latency (read AFTER it). Download:
      // read on arrival, `media` delay is a slow transfer, so a download can
      // straddle a write. A generation no longer live on arrival is a 404.
      const media = u.searchParams.get('alt') === 'media', want = u.searchParams.get('generation');
      const answer = (seen, entry) => {
        if (entry) entry.doneMs = Date.now() - startedAt;
        if (!seen || (media && want !== null && want !== String(seen.generation))) {
          if (media && seen) stale404s += 1;
          return json(res, 404, { error: { code: 404, message: 'not found' } });
        }
        if (media) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(seen.content); return; }
        json(res, 200, { name, bucket: BUCKET, generation: String(seen.generation), size: String(seen.content.length), ...(seen.custom ? { metadata: seen.custom } : {}) });
        const h = takeHook(afterMeta, name);
        if (h) write(name, h.f(seen.content), seen.custom);
      };
      if (media) {
        const seen = objects.get(name);
        const entry = { name, arrivedGen: seen?.generation ?? null, want, atMs: Date.now() - startedAt };
        readLog.push(entry);
        if (readDelay.media > 0) setTimeout(() => answer(seen, entry), readDelay.media); else answer(seen, entry);
      } else {
        metaGets += 1; metaGetsBy.set(name, (metaGetsBy.get(name) ?? 0) + 1);
        const now = () => answer(objects.get(name), null);
        if (readDelay.meta > 0) setTimeout(now, readDelay.meta); else now();
      }
      return;
    }

    if (req.method === 'DELETE' && name !== null) {
      const ifGenerationMatch = u.searchParams.get('ifGenerationMatch');
      const o = objects.get(name);
      const status = !o ? 404 : ifGenerationMatch !== null && ifGenerationMatch !== String(o.generation) ? 412 : 204;
      removeLog.push({ name, ifGenerationMatch, status });
      if (status === 412) n412 += 1;
      if (status === 204) { objects.delete(name); res.writeHead(204); res.end(); return; }
      json(res, status, { error: { code: status, message: status === 404 ? 'not found' : 'Precondition Failed' } });
      return;
    }

    if (req.method === 'POST' && u.pathname === `/upload/storage/v1/b/${BUCKET}/o`) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const parts = parseMultipart(req.headers['content-type'], body);
        const content = parts[1] ?? ''; // part 0 = metadata JSON, part 1 = the actual data
        const name = u.searchParams.get('name');
        const ifGenerationMatch = u.searchParams.get('ifGenerationMatch');
        if (!/^\d+$/.test(ifGenerationMatch ?? '')) unconditionalUploads.push({ port, name, ifGenerationMatch });

        if (uploadDelayMs > 0) await new Promise((r) => setTimeout(r, uploadDelayMs));
        const entry = { name, atMs: Date.now() - startedAt, ifGenerationMatch, body: content };
        uploadLog.push(entry);
        if (dropUploads) { entry.dropped = true; return; } // accept, never store, never answer
        if (failUploads || failNames.has(name)) { entry.failed = true; return json(res, 503, { error: { code: 503, message: 'Service Unavailable' } }); }

        if (ifGenerationMatch !== null) {
          const o = objects.get(name);
          const ok = ifGenerationMatch === '0' ? !o : !!o && ifGenerationMatch === String(o.generation);
          if (!ok) { n412 += 1; return json(res, 412, { error: { code: 412, message: 'Precondition Failed' } }); }
        }
        write(name, content, JSON.parse(parts[0] || '{}').metadata ?? null); // a write replaces the object's custom metadata
        entry.landedGen = gen;
        const answer = { name, bucket: BUCKET, generation: String(gen), size: String(content.length) };
        if (omitGeneration) { omitGeneration = false; delete answer.generation; }
        json(res, 200, answer);
        const h = takeHook(afterStore, name);
        if (h) write(name, h.f(content), objects.get(name).custom); // a peer writes right after us
      });
      return;
    }

    json(res, 404, { error: { code: 404 } });
  });

  const gamesIn = (o) => { try { return JSON.parse(o.content).games ?? []; } catch { return []; } };
  const controls = {
    close: () => new Promise((r) => server.close(() => r())),
    getStored: (name = OBJECT) => objects.get(name)?.content ?? null,
    // Replaces the bytes in place (same generation); null deletes the object, metadata with it.
    setStored: (v, name = OBJECT) => { if (v === null) objects.delete(name); else if (objects.has(name)) objects.get(name).content = v; else write(name, v, null); },
    getCustom: (name = OBJECT) => objects.get(name)?.custom ?? null,
    getGeneration: (name = OBJECT) => objects.get(name)?.generation ?? null,
    names: () => [...objects.keys()],
    /** One account's stored games ([] when it has no object). */
    games: (userId) => (objects.has(gamesObject(userId)) ? gamesIn(objects.get(gamesObject(userId))) : []),
    /** Every stored game across every account's object. */
    allGames: () => [...objects].filter(([n]) => n.startsWith('games/')).flatMap(([, o]) => gamesIn(o)),
    uploadCount: (name) => (name === undefined ? uploadLog.length : uploadLog.filter((x) => x.name === name).length),
    uploadLog: () => uploadLog,
    removeLog: () => removeLog,
    setUploadDelayMs: (ms) => { uploadDelayMs = ms; },
    omitGenerationOnce: () => { omitGeneration = true; },
    dropUploads: (v) => { dropUploads = v; },
    peerWrite: (content, meta, name = OBJECT) => write(name, content, meta ?? objects.get(name)?.custom ?? null), // meta: a peer's lineage
    afterStoreOnce: (f, name = null) => { afterStore.push({ name, f }); },
    afterMetaOnce: (f, name = null) => { afterMeta.push({ name, f }); }, // a peer writes right after our metadata GET is answered
    count412: () => n412,
    failUploads: (v) => { failUploads = v; }, // every upload answers 503
    failUploadsFor: (names) => { failNames = new Set(names); }, // only these objects' uploads answer 503
    setReadDelayMs: (meta, media) => { readDelay = { meta, media }; },
    metaGets: (name) => (name === undefined ? metaGets : metaGetsBy.get(name) ?? 0),
    stale404s: () => stale404s, readLog: () => readLog, lists: () => lists,
    // For the "GCS was unreachable at boot, comes back later" case: the
    // server object exists (so a spawned process pointed at `port` gets
    // ECONNREFUSED, not a slow timeout) but does not accept connections
    // until this is called.
    listen: () => new Promise((r) => server.listen(port, () => r())),
  };
  if (deferListen) return controls;
  return new Promise((resolve) => { server.listen(port, () => resolve(controls)); });
}

/** A peer that accepts and never answers, per object: `hang(name)` / `delay(name, ms)` / `hangUploads(true)`. */
function startDeadlineGcs(port, initialContent) {
  let gen = 1, hungObject = null, delayedObject = null, readDelayMs = 0, hangUploads = false;
  const objects = new Map([[OBJECT, { content: initialContent, generation: 1 }]]);
  const reads = [], uploads = [], sockets = new Set(), timers = new Set();
  const base = `/b/${BUCKET}/o`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.pathname.startsWith(`${base}/`) ? decodeURIComponent(u.pathname.slice(base.length + 1)) : null;
    const reply = () => {
      if (req.method === 'GET' && name === VERSION_OBJECT) {
        if (u.searchParams.get('alt') === 'media') { res.writeHead(200); res.end('{"version":"0.0.225"}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name, bucket: BUCKET, size: '21' })); return;
      }
      if (req.method === 'GET' && name !== null) {
        const o = objects.get(name);
        if (!o) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 404 } })); return; }
        if (u.searchParams.get('alt') === 'media') { res.writeHead(200); res.end(o.content); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name, bucket: BUCKET, generation: String(o.generation), size: String(o.content.length) })); return;
      }
      if (req.method === 'POST' && u.pathname === `/upload/storage/v1/b/${BUCKET}/o`) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const target = u.searchParams.get('name');
          uploads.push({ name: target, body: parseMultipart(req.headers['content-type'], body)[1] ?? '' });
          if (!/^\d+$/.test(u.searchParams.get('ifGenerationMatch') ?? '')) unconditionalUploads.push({ port, name: target, ifGenerationMatch: u.searchParams.get('ifGenerationMatch') });
          if (hangUploads) return;
          gen += 1; objects.set(target, { content: uploads.at(-1).body, generation: gen });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ name: target, bucket: BUCKET, generation: String(gen), size: String(uploads.at(-1).body.length) }));
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
    reads: () => reads,
    uploads: () => uploads.map((x) => x.body), uploadNames: () => uploads.map((x) => x.name),
    stored: (name = OBJECT) => objects.get(name)?.content ?? null,
    games: (userId) => { try { return JSON.parse(objects.get(gamesObject(userId))?.content ?? '{"games":[]}').games; } catch { return []; } },
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

// A 429's Retry-After must be the server's real remaining wait, ceil(s). The window
// opened between sent0..got0 and the 429 was answered between sent1..got1 (one clock),
// so it lies in [lo, hi]; hi < 60 proves a hardcoded 60 cannot pass (director audit s16).
function retryAfterIn(ra, [sent0, got0], [sent1, got1], windowMs = 60_000) {
  const lo = Math.ceil((windowMs - (got1 - sent0)) / 1000), hi = Math.ceil((windowMs - (sent1 - got0)) / 1000);
  return { ok: /^\d+$/.test(ra ?? '') && Number(ra) >= lo && Number(ra) <= hi && hi < windowMs / 1000, detail: `retry-after ${ra} in [${lo}, ${hi}]` };
}
// Sleep until `ms` past `t`, so a window-long constant is out of the bracket.
const pastBy = async (t, ms) => { while (Date.now() < t + ms) await new Promise((r) => setTimeout(r, t + ms - Date.now())); };

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
      names = fakeGcs.games('u_gcsrace').map((g) => g.name);
      if (names && names.length >= 4) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const gameUploadCount = fakeGcs.uploadCount() - uploadsBeforeGames;
  record('THE DEFECT: 4 rapid saves produce at most 2 NEW upload requests (coalesced), not 4',
    gameUploadCount <= 2, `${gameUploadCount} upload request(s) for the 4 games: ${JSON.stringify(fakeGcs.uploadLog().slice(uploadsBeforeGames))}`);

  // The account's own object (games/<id>.json) holds its games; db.json holds none.
  const finalNames = fakeGcs.games('u_gcsrace').map((g) => g.name).sort();
  record('the final persisted content has ALL 4 games, not just the first',
    JSON.stringify(finalNames) === JSON.stringify(['Game-1', 'Game-2', 'Game-3', 'Game-4']),
    JSON.stringify(finalNames));

  await stop(srv.child); srv = null;
  await fakeGcs.close(); fakeGcs = null;

  // ───────────────────────────────────────────────────────────────────────────
  // 2. MULTI-INSTANCE: two REAL server.cjs processes, same fake bucket, both
  // saving to the SAME account's object. On unfixed code (no precondition)
  // whichever instance's upload lands last wins OUTRIGHT — the other's game
  // vanishes. X's upload is held so Y's lands first, forcing X into exactly
  // the generation-conflict path: its upload 412s, it re-reads the object and
  // re-applies its save to it. (Two DIFFERENT accounts no longer share an
  // object, so they cannot conflict at all; the same account on two
  // instances — two tabs across a rollover — is the race that remains.)
  // ───────────────────────────────────────────────────────────────────────────
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
  const tokenY = await loginAs(portY, 'userx@example.test'); // the same account, on the other instance
  record('fixture precondition: both instances have a usable token',
    typeof tokenX === 'string' && typeof tokenY === 'string', `X:${typeof tokenX} Y:${typeof tokenY}`);

  // Let both instances' login-triggered rehash saves fully settle before
  // controlling the game-save race — otherwise their own upload timing
  // adds noise to a race this test needs to control deterministically.
  await new Promise((r) => setTimeout(r, 800));
  // Both instances read the (empty) object first, so each holds a generation to condition on.
  await fetch(`http://127.0.0.1:${portX}/api/games`, { headers: { authorization: `Bearer ${tokenX}` } });
  await fetch(`http://127.0.0.1:${portY}/api/games`, { headers: { authorization: `Bearer ${tokenY}` } });

  // X's game-save upload is held (deterministically forcing it to be the
  // LOSING side of the generation race), then Y's lands cleanly while X's
  // is still in flight, THEN X's held request finally completes and hits
  // its precondition mismatch — the exact interleaving, not a timing hope.
  const post = (port, token, name) => fetch(`http://127.0.0.1:${port}/api/games`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }),
  });
  const n412B = fakeGcs.count412();
  fakeGcs.setUploadDelayMs(800);
  const resXP = post(portX, tokenX, 'Game-X');
  // X's own GCS upload request needs a moment to actually reach the fake
  // server and start its 800ms hold before Y's (undelayed) request fires —
  // otherwise Y's could race ahead of X's arriving at all, which would
  // test nothing about the conflict path this section exists to exercise.
  await new Promise((r) => setTimeout(r, 250));
  // A second X save lands WHILE X's first upload is held: it waits its turn
  // behind that upload and must survive the conflict the first one meets.
  const resX2P = post(portX, tokenX, 'Game-X2');
  await new Promise((r) => setTimeout(r, 50));
  fakeGcs.setUploadDelayMs(0);
  const resY = await post(portY, tokenY, 'Game-Y');
  record('Y\'s save is accepted', resY.status === 200, `status ${resY.status}`);
  const [resX, resX2] = await Promise.all([resXP, resX2P]);
  record('X\'s save is accepted once it lands, after its upload lost the race (412) and was re-applied',
    resX.status === 200 && fakeGcs.count412() > n412B, `status ${resX.status}, 412s ${fakeGcs.count412() - n412B}`);

  const finalMultiNames = fakeGcs.games('u_x').map((g) => g.name).sort();
  record('THE DEFECT: BOTH instances\' games survive after the conflict, not just the last writer',
    ['Game-X', 'Game-Y'].every((n) => finalMultiNames.includes(n)), JSON.stringify(finalMultiNames));
  const listX = await fetch(`http://127.0.0.1:${portX}/api/games`, { headers: { authorization: `Bearer ${tokenX}` } })
    .then((r) => r.json()).catch(() => null);
  record('a save committed DURING the conflicted upload survives the 412 re-read, on GCS and in the list',
    resX2.status === 200 && JSON.stringify(finalMultiNames) === JSON.stringify(['Game-X', 'Game-X2', 'Game-Y'])
      && Array.isArray(listX) && ['Game-X', 'Game-X2', 'Game-Y'].every((n) => listX.some((g) => g.name === n)),
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

  let finalZUsernames = null, finalZRootGames = null;
  try {
    const finalZ = JSON.parse(fakeGcsDeferred.getStored());
    finalZRootGames = finalZ.games.length;
    finalZUsernames = finalZ.users.map((u) => u.username).sort();
  } catch { /* reported below */ }
  // The game sat in db.json's legacy array: the first read after GCS came back
  // moved it into its account's object, and the write cleared the array.
  const finalZNames = fakeGcsDeferred.games('u_z').map((g) => g.name).sort();
  record('THE DEFECT: the pre-existing game (that this process never read) SURVIVES the save, not silently erased',
    JSON.stringify(finalZNames) === JSON.stringify(['Preexisting-Game']) && finalZRootGames === 0, `${JSON.stringify(finalZNames)}, db.json games ${finalZRootGames}`);
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
  // A saved game is answered only once its upload lands: a silent peer makes
  // save N an honest 503 at the deadline, never a 200 for bytes GCS never took.
  const hungAt = Date.now();
  const saveN = await postGame('Hung-save-N');
  const hungMs = Date.now() - hungAt;
  const hungUploadReached = slowFake.uploadNames().slice(beforeHungUpload).includes('games/u_deadline.json');
  record('THE DEFECT: save N, whose upload the peer swallowed, is a 503 at the 1.5s deadline (never acknowledged), not a hang',
    saveN.status === 503 && saveN.headers.get('retry-after') === '30' && hungUploadReached && hungMs >= 1400 && hungMs < 4000,
    `status ${saveN.status} after ${hungMs}ms, uploads ${JSON.stringify(slowFake.uploadNames())}`);
  await new Promise((r) => setTimeout(r, 3200));
  slowFake.hangUploads(false);
  const saveN1 = await postGame('Recovered-save-N-plus-1');
  const recovered = await waitUntil(() => {
    const names = slowFake.games('u_deadline').map((g) => g.name).sort();
    return JSON.stringify(names) === JSON.stringify(['Recovered-save-N-plus-1']);
  }, 6000);
  record('THE DEFECT: the deadline frees the account\'s write queue, so save N+1 persists (and the unacknowledged save N is not claimed)',
    saveN1.status === 200 && recovered && /GCS deadline exceeded after 1500ms: games\/u_deadline\.json save\(\) never answered/.test(slowBoot.log()),
    `status ${saveN1.status}, ${String(slowFake.stored('games/u_deadline.json')).slice(-300)}`);
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
      // Kept = moved, byte-identical, into its account's object, and gone from db.json.
      (db, f) => f.games('u_gone').some((g) => g.id === 'g_old' && g.name === 'Old-Game') && db.games.length === 0],
    ['a user whose passwordHash is \'\' (the local-owner shape)', { users: [{ ...seededUser('u_blank', 'blank', 'blank@example.test', 'x'), passwordHash: '' }], games: [] },
      (db) => db.users.some((u) => u.id === 'u_blank')],
  ]) {
    const fake = await trackFake(startFakeGcsDb({ port: shapeGcsPort, initialContent: JSON.stringify(doc) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-shape-ok-'))), shapeAppPort, shapeGcsPort)), shapeAppPort);
    const reg = await register(shapeAppPort, 'control@example.test');
    const landed = await waitUntil(() => fake.uploadCount(OBJECT) >= 1, 5000);
    let stored = null; try { stored = JSON.parse(fake.getStored()); } catch { /* reported below */ }
    record(`CONTROL (${label}): boots unblocked, and the first save KEEPS the existing record`,
      reg?.status === 500 && landed && !!stored && keeps(stored, fake) && !/GCS store BLOCKED/.test(boot.log()),
      `register ${reg?.status} (500 = no SMTP), uploads ${fake.uploadCount()}, stored ${String(fake.getStored()).slice(0, 160)}`);
    await stop(boot.child); await fake.close();
  }

  // A PEER writes a malformed object mid-life; our next save takes the 412
  // merge. On main that path merged `users:"x"` character by character and
  // uploaded the result. It must refuse and block exactly like the boot read.
  // The save is a db.json write (a second legacy-hash login's rehash): a game
  // save writes only its account's object, never db.json.
  {
    const good = JSON.stringify({ users: [seededUser('u_mid', 'mid', 'mid@example.test', 'Sup3rSecret!23'), seededUser('u_mid2', 'mid2', 'mid2@example.test', 'Sup3rSecret!23')], games: [] });
    const fake = await trackFake(startFakeGcsDb({ port: shapeGcsPort, initialContent: good }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-mid-'))), shapeAppPort, shapeGcsPort)), shapeAppPort);
    const tok = (await (await fetch(`http://127.0.0.1:${shapeAppPort}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'mid@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    const bad = JSON.stringify({ users: 'x', games: [] });
    fake.peerWrite(bad);
    const n = fake.uploadCount();
    const save = await fetch(`http://127.0.0.1:${shapeAppPort}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mid2@example.test', password: 'Sup3rSecret!23' }) });
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
  // touched either. X then saves an unrelated game and writes db.json (T's
  // first login rehashes T's legacy hash), taking the 412 merge. The 2-way
  // merge put U and U's game back and reverted V's hash. CONTROL: X's OWN new
  // game survives. U's game sat in db.json's legacy array: both instances
  // moved it into U's object at boot, and U's deletion leaves a tombstone.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const mGcs = gcsPortA + 16, mX = port1 + 4, mY = port1 + 6;
    const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
    const fake = await trackFake(startFakeGcsDb({ port: mGcs, initialContent: JSON.stringify({
      users: [{ ...seededUser('u_U', 'userU', 'u@example.test', 'Sup3rSecret!23'), deleteCode: '123456', deleteCodeExpires: Date.now() + 600000 },
        seededUser('u_V', 'userV', 'v@example.test', 'Sup3rSecret!23'), seededUser('u_W', 'userW', 'w@example.test', 'Sup3rSecret!23'),
        seededUser('u_T', 'userT', 't7@example.test', 'Sup3rSecret!23')],
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
    await loginOn(mX, 't7@example.test'); // X writes db.json from its copy (merged on read or on a 412)
    await waitUntil(() => onGcs().users.find((u) => u.id === 'u_T')?.passwordHash.startsWith('pbkdf2$'), 8000);
    const fin = onGcs();
    record('THE DEFECT: an account deleted on one instance stays deleted after a stale instance saves (user AND games)',
      del.status === 200 && !before.users.some((u) => u.id === 'u_U')
        && !fin.users.some((u) => u.id === 'u_U') && fake.games('u_U').length === 0 && JSON.parse(fake.getStored('games/u_U.json') ?? '{}').deleted === true,
      `delete ${del.status}; final users ${JSON.stringify(fin.users.map((u) => u.id))} U's object ${fake.getStored('games/u_U.json')}`);
    const vBefore = before.users.find((u) => u.id === 'u_V')?.passwordHash;
    record('THE DEFECT: a stale instance\'s UNTOUCHED copy does not revert another instance\'s change (V\'s rehash)',
      !!vBefore?.startsWith('pbkdf2$') && fin.users.find((u) => u.id === 'u_V')?.passwordHash === vBefore,
      `V before ${vBefore?.slice(0, 7)}, after ${fin.users.find((u) => u.id === 'u_V')?.passwordHash?.slice(0, 7)}`);
    record('CONTROL: X\'s own new game survives the same 412 merge', postX.status === 200 && fake.games('u_W').some((g) => g.name === 'W-Game'),
      JSON.stringify(fake.allGames().map((g) => g.name)));
    await stop(X.child); await stop(Y.child); await fake.close();
  }

  // 7b. DELETION WINS OVER A CONCURRENT EDIT ON THE STALE INSTANCE. Y deletes
  // accounts U and U2; X, not knowing, CHANGES U2 (a forgot-password code,
  // a db.json write that takes the 412 merge) and tries to save a new game
  // for U from its stale copy. Neither account may come back, and no game may
  // be left owned by a deleted account: U's object is a tombstone, so X's save
  // meets it and is refused (401) instead of re-creating an object nobody
  // could reach. CONTROL: the fixture's deletions reached GCS before X acted.
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
    record('fixture: both deletions reached GCS before the stale instance acted, inside X\'s freshness window',
      deletedFirst && xStaleMs < 2000, `users on GCS before: ${deletedFirst ? 0 : 'some'}, X window used ${xStaleMs}ms of 2000`);
    record('THE DEFECT: an account deleted elsewhere stays deleted even though THIS instance changed it (deletion wins)',
      !fin.users.some((u) => u.id === 'u_D2') && !fin.users.some((u) => u.id === 'u_D1'), JSON.stringify(fin.users.map((u) => u.id)));
    record('THE DEFECT: no game is left owned by a deleted account: the stale save met U\'s tombstone (401) and wrote nothing',
      orphan.status === 401 && fake.games('u_D1').length === 0 && JSON.parse(fake.getStored('games/u_D1.json') ?? '{}').deleted === true
        && !fake.allGames().some((g) => g.name === 'Orphan-Game'),
      `orphan POST ${orphan.status}; U's object ${fake.getStored('games/u_D1.json')}`);
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
    // db.json uploads are held so every sign-up below happens on both
    // instances before either write lands: the rollover race, not "register
    // an email GCS has". Sequential, not Promise.all: the fake SMTP's last code
    // must be this call's. Each game is answered once its own object's upload
    // lands (held too); the hold is lifted once both have arrived.
    fake.setUploadDelayMs(6000);
    const a = await signUp(eX, 'alice', 'same@example.test', 'Sup3rSecretX');
    const b = await signUp(eY, 'bob', 'SAME@example.test', 'Sup3rSecretY');
    const c = await signUp(eX, 'carol', 'carol@example.test', 'Sup3rSecretC');
    const d = await signUp(eY, 'Carol', 'dave@example.test', 'Sup3rSecretD');
    const beforeLanding = fake.uploadLog().filter((u) => u.landedGen).length;
    const games = Promise.all([call(eX, '/api/games', { name: 'Alice-Game', payoffs: pay }, a.t), call(eY, '/api/games', { name: 'Bob-Game', payoffs: pay }, b.t)]);
    await new Promise((r) => setTimeout(r, 300)); // both game uploads are held; nothing after them is
    fake.setUploadDelayMs(0);
    const [ga, gb] = await games;
    await waitUntil(() => fake.allGames().length >= 2, 15000); await settle(); await new Promise((r) => setTimeout(r, 1500)); await settle();
    const seenIds = new Set(fake.uploadLog().filter((u) => u.name === OBJECT).flatMap((u) => { try { return JSON.parse(u.body).users.map((x) => x.id); } catch { return []; } }));
    const fin = onGcs();
    const same = fin.users.filter((u) => u.email.toLowerCase() === 'same@example.test');
    const carols = fin.users.filter((u) => u.username.toLowerCase().startsWith('carol'));
    record('fixture: all four sign-ups were accepted before any upload landed, both games were saved, and 4 accounts reached GCS',
      [a, b, c, d].every((x) => x.r === 200 && x.v === 200 && typeof x.t === 'string') && ga.status === 200 && gb.status === 200
        && beforeLanding === 0 && seenIds.size === 4,
      JSON.stringify([a, b, c, d].map((x) => [x.r, x.v, typeof x.t])) + ` games ${ga.status}/${gb.status}, landed early ${beforeLanding}, ids seen ${seenIds.size}`);
    // The kept account lists both instances' games: its own object and the
    // folded duplicate's (recorded in `mergedFrom`), on both instances.
    const keptKeys = same.length === 1 ? [same[0].id, ...(same[0].mergedFrom ?? [])] : [];
    const keptStored = keptKeys.flatMap((k) => fake.games(k)).map((g) => g.name);
    await new Promise((r) => setTimeout(r, 2100)); // both instances re-read the merged accounts
    const keptLists = [];
    for (const p of [eX, eY]) {
      const pw = same[0]?.username === 'bob' ? 'Sup3rSecretY' : 'Sup3rSecretX';
      const t = (await (await call(p, '/api/auth/login', { email: 'same@example.test', password: pw })).json().catch(() => ({}))).token;
      keptLists.push(await (await fetch(`http://127.0.0.1:${p}/api/games`, { headers: { authorization: `Bearer ${t}` } })).json().catch(() => null));
    }
    record('THE DEFECT: one email ends as ONE account, holding BOTH instances\' games',
      same.length === 1 && ['Alice-Game', 'Bob-Game'].every((n) => keptStored.includes(n) && keptLists.every((l) => Array.isArray(l) && l.some((g) => g.name === n))),
      `accounts ${same.length}; stored under ${JSON.stringify(keptKeys)}: ${JSON.stringify(keptStored)}; lists ${JSON.stringify(keptLists.map((l) => (Array.isArray(l) ? l.map((g) => g.name) : l)))}`);
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
    const settled = await waitUntil(() => { const db = onGcs2(); return !db.users.some((u) => u.id === 'u_A') && fake2.games('u_A').some((g) => g.name === 'A-Late'); }, 30000);
    fake2.setUploadDelayMs(0);
    await new Promise((r) => setTimeout(r, 2100)); // both instances re-read the fold
    const fin2 = onGcs2();
    const owners = fin2.users.filter((u) => u.email.toLowerCase() === 'fold@example.test');
    const savedForA = fake2.uploadLog().some((u) => u.name === 'games/u_A.json' && (() => { try { return JSON.parse(u.body).games.some((g) => g.name === 'A-Late' && g.userId === 'u_A'); } catch { return false; } })());
    // The surviving account (B) owns A-Late: it lists it, through the fold it records.
    const tB = (await (await call(fY, '/api/auth/login', { email: 'fold@example.test', password: 'Sup3rSecretB' })).json().catch(() => ({}))).token;
    const bList = await (await fetch(`http://127.0.0.1:${fY}/api/games`, { headers: { authorization: `Bearer ${tB}` } })).json().catch(() => null);
    const aLate = Array.isArray(bList) ? bList.find((g) => g.name === 'A-Late') : undefined;
    record('fixture: B verified on Y; A verified and saved A-Late on X under u_A; the fold of u_A landed',
      vB.status === 200 && vA.status === 200 && typeof tA === 'string' && late.status === 200 && savedForA && settled,
      `verify B ${vB.status}, verify A ${vA.status}, game ${late.status}, sent under u_A ${savedForA}, settled ${settled}, margin ${foldMargin}ms; users ${JSON.stringify(fin2.users.map((u) => u.id))}`);
    record('THE DEFECT: a game saved under the folded account is owned by the surviving one',
      owners.length === 1 && owners[0].id !== 'u_A' && (owners[0].mergedFrom ?? []).includes('u_A') && !!aLate,
      `accounts ${owners.length}; survivor ${owners[0]?.id} folded ${JSON.stringify(owners[0]?.mergedFrom)}; B lists ${JSON.stringify(Array.isArray(bList) ? bList.map((g) => g.name) : bList)}`);
    await stop(X2.child); await stop(Y2.child); await fake2.close(); smtp2.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 8. ACKNOWLEDGED SAVES SURVIVE AN OUTAGE AND A SHUTDOWN (hit d). Before:
  // after an upload failed nothing retried until the NEXT save (measured:
  // the game never reached GCS), and SIGTERM exited in ~7ms, dropping a save
  // queued behind an in-flight upload. db.json writes are still acknowledged
  // first and retried by the pump; a saved game is acknowledged only once its
  // object's upload lands, so during an outage it is an honest 503 that the
  // client retries. CONTROL for the drain: the first, already-in-flight save
  // lands either way, so only the queued one can fail.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const oGcs = gcsPortA + 18, oApp = port1 + 8;
    const fake = await trackFake(startDeadlineGcs(oGcs, JSON.stringify({ users: [seededUser('u_o', 'outage', 'o@example.test', 'Sup3rSecret!23'), seededUser('u_o2', 'outage2', 'o2@example.test', 'Sup3rSecret!23')], games: [] })));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-outage-'))), oApp, oGcs, { GCS_DEADLINE_MS: '600' })), oApp);
    const tok = (await (await fetch(`http://127.0.0.1:${oApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'o@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploads().length >= 1, 5000);
    fake.hangUploads(true);
    // A db.json write (o2's first login rehashes its legacy hash) is acknowledged and retried.
    const acked = await fetch(`http://127.0.0.1:${oApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'o2@example.test', password: 'Sup3rSecret!23' }) });
    const game = () => fetch(`http://127.0.0.1:${oApp}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: 'Saved-Around-Outage', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, clientRequestId: 'outage-retry-1' }) });
    const during = await game();
    await waitUntil(() => (boot.log().match(/GCS write failed; the pending save stays queued/g) || []).length >= 2, 8000);
    fake.hangUploads(false); // GCS recovers; NO further db.json write is made
    const persisted = await waitUntil(() => { try { return JSON.parse(fake.stored()).users.find((u) => u.id === 'u_o2')?.passwordHash.startsWith('pbkdf2$'); } catch { return false; } }, 10000);
    const retried = await game(); // the client's retry of the refused save, same clientRequestId
    const kept = fake.games('u_o').filter((g) => g.name === 'Saved-Around-Outage');
    record('THE DEFECT: a db.json write acknowledged during an outage reaches GCS once it recovers, with no later save to carry it; a game save during it is an honest 503 and its retry lands once',
      acked.status === 200 && persisted && during.status === 503 && retried.status === 200 && kept.length === 1,
      `ack ${acked.status} persisted ${persisted}; game during ${during.status}, retry ${retried.status}, stored ${kept.length}`);
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
    // Both requests are still waiting on their uploads when SIGTERM arrives.
    const firstP = g('In-Flight'); await new Promise((r) => setTimeout(r, 100));
    const secondP = g('Queued-Behind'); await new Promise((r) => setTimeout(r, 100));
    const exited = new Promise((r) => boot.child.once('exit', (code, sig) => r({ code, sig })));
    boot.child.kill('SIGTERM');
    const how = await exited;
    const [first, second] = await Promise.all([firstP, secondP].map((p) => p.catch((err) => ({ status: err?.cause?.code ?? String(err) }))));
    let names = [];
    await waitUntil(() => { names = fake.games('u_t').map((x) => x.name).sort(); return names.length >= 2; }, 3000);
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
  // (measured on main too). A saved game's request now waits for its upload,
  // so the abandoned one is a 503, and the client's retry (same
  // clientRequestId) must find the row that landed — not trust the copy the
  // abandoned write left in memory and add a second one. CONTROL: the game is
  // on GCS before the retry.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const aGcs = gcsPortA + 22, aApp = port1 + 16;
    const fake = await trackFake(startFakeGcsDb({ port: aGcs, initialContent: JSON.stringify({ users: [seededUser('u_ab', 'aband', 'ab@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-aband-'))), aApp, aGcs, { GCS_DEADLINE_MS: '800' })), aApp);
    const tok = (await (await fetch(`http://127.0.0.1:${aApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ab@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    const save = () => fetch(`http://127.0.0.1:${aApp}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: 'Created-Then-Deleted', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, clientRequestId: 'abandoned-1' }) });
    // Stored at 1.2s, after the 800ms deadline: the process never learns it landed.
    fake.setUploadDelayMs(1200);
    const abandoned = await save();
    const landed = await waitUntil(() => fake.games('u_ab').length === 1, 5000);
    fake.setUploadDelayMs(0);
    const retry = await save();
    const made = await retry.json().catch(() => ({}));
    const del = await fetch(`http://127.0.0.1:${aApp}/api/games/${made.game?.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    await new Promise((r) => setTimeout(r, 2200));
    const list = await (await fetch(`http://127.0.0.1:${aApp}/api/games`, { headers: { authorization: `Bearer ${tok}` } })).json();
    const storedGames = fake.games('u_ab').length;
    record('fixture: the abandoned upload was answered 503 at the deadline and DID land on GCS before the retry',
      abandoned.status === 503 && landed, `abandoned ${abandoned.status} landed ${landed} ${String(fake.getStored('games/u_ab.json')).slice(0, 160)}`);
    record('THE DEFECT: the retry finds the row the abandoned upload landed (no second row), and once deleted it stays deleted, on GCS and in the list',
      retry.status === 200 && made.game?.clientRequestId === 'abandoned-1' && del.status === 200 && storedGames === 0 && Array.isArray(list) && list.length === 0,
      `retry ${retry.status}, delete ${del.status}, stored games ${storedGames}, list ${JSON.stringify(list)}`);
    await stop(boot.child); await fake.close();
  }
  // 9b. THE OTHER HALF: an abandoned upload that did NOT land is no proof the
  // game is there. A peer writes the object meanwhile; the retry must build on
  // the peer's write (412, re-read) and land its own row beside it.
  // CONTROL: the peer's game survives the same retry.
  {
    const bGcs = gcsPortA + 26, bApp = port1 + 22;
    const fake = await trackFake(startFakeGcsDb({ port: bGcs, initialContent: JSON.stringify({ users: [seededUser('u_nl', 'unland', 'nl@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-unland-'))), bApp, bGcs, { GCS_DEADLINE_MS: '800' })), bApp);
    const tok = (await (await fetch(`http://127.0.0.1:${bApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nl@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    const save = () => fetch(`http://127.0.0.1:${bApp}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: 'Never-Landed', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, clientRequestId: 'unlanded-1' }) });
    fake.dropUploads(true);
    const first = await save();
    fake.peerWrite(JSON.stringify({ userId: 'u_nl', games: [{ id: 'g_peer2', userId: 'u_nl', name: 'Peer-Game-2', description: '', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, createdAt: '2026-01-01' }] }), null, 'games/u_nl.json');
    fake.dropUploads(false);
    const retry = await save();
    const names = fake.games('u_nl').map((g) => g.name).sort();
    record('CONTROL: the peer\'s game survives the retry that follows an unlanded upload', names.includes('Peer-Game-2'), JSON.stringify(names));
    record('THE DEFECT: a save whose upload never landed is a 503, and its retry lands beside the peer\'s write',
      first.status === 503 && retry.status === 200 && JSON.stringify(names) === JSON.stringify(['Never-Landed', 'Peer-Game-2']), `first ${first.status}, retry ${retry.status}; stored ${JSON.stringify(names)}`);
    await stop(boot.child); await fake.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 10. NO WRITE WITHOUT A GENERATION. An upload whose answer carried no
  // generation landed, but its generation is unknown, so the next write must
  // re-read before writing (a peer wrote right after it). CONTROL: the peer's
  // write happened (checked below via the fake's hook).
  // ───────────────────────────────────────────────────────────────────────────
  {
    const nGcs = gcsPortA + 24, nApp = port1 + 18;
    const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
    const fake = await trackFake(startFakeGcsDb({ port: nGcs, initialContent: JSON.stringify({ users: [seededUser('u_n', 'nogen', 'n@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-nogen-'))), nApp, nGcs)), nApp);
    const tok = (await (await fetch(`http://127.0.0.1:${nApp}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'n@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    let peerRan = false;
    fake.omitGenerationOnce();
    fake.afterStoreOnce((content) => {
      peerRan = true;
      const db = JSON.parse(content);
      db.games.push({ id: 'g_peer', userId: 'u_n', name: 'Peer-Game', description: '', payoffs: pay, createdAt: '2026-01-01' });
      return JSON.stringify(db);
    }, 'games/u_n.json');
    const post = (name) => fetch(`http://127.0.0.1:${nApp}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name, payoffs: pay }) });
    const first = await post('First');
    const next = await post('Next');
    const names = fake.games('u_n').map((g) => g.name).sort();
    const gameUploads = fake.uploadLog().filter((u) => u.name === 'games/u_n.json');
    record('fixture: a peer wrote right after the generation-less upload answered', peerRan, String(fake.getStored('games/u_n.json')).slice(0, 200));
    record('THE DEFECT: with no known generation the next save re-reads first, so the peer\'s game survives it',
      first.status === 200 && next.status === 200 && JSON.stringify(names) === JSON.stringify(['First', 'Next', 'Peer-Game']) && fake.count412() === 0,
      `stored ${JSON.stringify(names)}; preconditions ${JSON.stringify(gameUploads.map((u) => u.ifGenerationMatch))}, 412s ${fake.count412()}`);
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
    let fbSent; // feedback is the last route: its request opens the feedback bucket's window
    for (const [route, body] of routes) { fbSent = Date.now(); ok.push(await timed(route, body())); }
    const fbWindow = [fbSent, Date.now()];
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
    // on the TRIMMED text, so 5000 chars padded with spaces still sends. 8 of the 10/min.
    const fb = async (message) => { const r = await fetch(`http://127.0.0.1:${qApp}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
      return [r.status, (await r.json().catch(() => ({}))).error ?? ''].join(' '); };
    const bounds = [await fb('  \n '), await fb('y'.repeat(5001)), await fb(`  ${'z'.repeat(5000)} `)];
    record('feedback: blank and 5001 chars are 400 with their reason; exactly 5000 after trim is 200',
      /^400 .*cannot be empty/.test(bounds[0]) && /^400 .*too long/.test(bounds[1]) && bounds[2] === '200 ', JSON.stringify(bounds));
    // Sweep 16. A rating Number() cannot coerce was a 500 (9th of 10/min; bad JSON never reaches the limiter).
    // Bad JSON / 413 bodies are the client's error: no "Unhandled error" stack echoing their bytes
    // (a raw newline forged a separate log line). The limiter's 429 names its real wait.
    const post = (body) => fetch(`http://127.0.0.1:${qApp}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const poison = await post(JSON.stringify({ message: 'rated oddly', rating: { toString: 1, valueOf: 1 } }));
    const l0 = boot.log().length;
    const junk = [(await post('nul\nFORGED-S16 admin ok')).status, (await post('x'.repeat(200 * 1024))).status];
    await new Promise((r) => setTimeout(r, 200));
    const junkLog = boot.log().slice(l0);
    record('THE DEFECT (sweep 16): an uncoercible rating is ignored (200); bad-JSON and 413 bodies log no "Unhandled error" and no line of theirs',
      poison.status === 200 && JSON.stringify(junk) === '[400,413]' && !/Unhandled error|FORGED|xxxxxxxx/.test(junkLog),
      JSON.stringify({ poison: poison.status, junk, junkLog: junkLog.slice(0, 300) }));
    silent = true;
    const hung = [];
    // A second account: q@ was just mailed, and a recovery mail per address per
    // minute is the cooldown (sweep 6), so a repeat there never reaches SMTP.
    routes[1][1] = () => ({ email: 'q2@example.test' });
    for (const [route, body] of routes) hung.push(await timed(route, body()));
    let over, overAt; // the 11th feedback this minute; a blank one is refused fast if the count ever drifts low
    for (let i = 0; i < 3 && over?.status !== 429; i++) { const t = Date.now(); over = await post('{"message":""}'); overAt = [t, Date.now()]; }
    const ra = retryAfterIn(over.headers.get('retry-after'), fbWindow, overAt);
    record('THE DEFECT (sweep 16): the rate limiter\'s 429 names the window\'s real remaining seconds (not 1, not a window too many)',
      over.status === 429 && ra.ok, `status ${over.status} ${ra.detail}`);
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
    // Y reads the account's (empty) object first, so it holds a copy that goes stale.
    const listY0 = await (await fetch(`http://127.0.0.1:${rY}/api/games`, { headers: { authorization: `Bearer ${tY}` } })).json().catch(() => null);
    const saved = await fetch(`http://127.0.0.1:${rX}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tX}` },
      body: JSON.stringify({ name: 'Saved-On-X', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } }) });
    const onGcs = await waitUntil(() => fake.games('u_r').some((g) => g.name === 'Saved-On-X'), 5000);
    await new Promise((r) => setTimeout(r, 2100)); // one freshness window
    const listY = await (await fetch(`http://127.0.0.1:${rY}/api/games`, { headers: { authorization: `Bearer ${tY}` } })).json().catch(() => null);
    record('fixture: Y held the empty list, and the game saved on X reached GCS before Y lists again', saved.status === 200 && onGcs && Array.isArray(listY0) && listY0.length === 0,
      String(fake.getStored('games/u_r.json')).slice(0, 160));
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

  // 14. A 412 STORM. Three instances on one bucket, ONE account signed in on
  // each, every instance saving 8 games concurrently into that account's one
  // object and deleting every third, uploads slowed so they collide. Every
  // acknowledged save must end on GCS exactly once and every acknowledged
  // delete stay gone. FIXTURE: real 412s happened, so the re-read + re-apply
  // path ran, not three serial writers.
  {
    const sGcs = gcsPortA + 44, ports = [port1 + 48, port1 + 50, port1 + 52];
    const us = [0, 1, 2].map((i) => seededUser(`u_s${i}`, `storm${i}`, `s${i}@example.test`, 'Sup3rSecret!23'));
    const fake = await trackFake(startFakeGcsDb({ port: sGcs, initialContent: JSON.stringify({ users: us, games: [] }) }));
    const kids = [];
    for (const p of ports) kids.push((await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-storm-'))), p, sGcs)), p)).child);
    const tok = [];
    for (const [i, p] of ports.entries()) {
      tok.push((await (await fetch(`http://127.0.0.1:${p}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 's0@example.test', password: 'Sup3rSecret!23' }) })).json()).token);
      if (i === 0) await waitUntil(() => fake.uploadCount() >= 1, 5000); // the rehash lands before the others read
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
    const names = () => fake.games('u_s0').map((g) => g.name);
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
  // (sweep 2, director angle). Games straddle their account's object (re-read
  // by GET /api/games), the account deletion straddles db.json (re-read by the
  // gate). FIXTURE: the log proves the straddle.
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
    // A first write of ours lands while the re-check's metadata GET of the same
    // object is in flight, so the generation moved and the re-check downloads;
    // the write under test then lands while that (slow) download is still in flight.
    const GAMES = 'games/u_k.json';
    const pre = (tag, object) => (object === GAMES
      ? fetch(url('/api/games'), { method: 'POST', headers: json, body: JSON.stringify({ name: `Pre-${tag}`, payoffs: keepGame.payoffs }) })
      : fetch(url('/api/auth/register'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `pre-${tag}`, email: `pre-${tag}@example.test`, password: 'Sup3rSecret!23' }) }));
    const straddle = async (write, tag, object = GAMES) => {
      fake.setReadDelayMs(600, 1800);
      const m0 = fake.metaGets(object), r0 = fake.readLog().filter((x) => x.name === object).length;
      const trigger = fetch(url('/api/games'), { headers: auth });
      await waitUntil(() => fake.metaGets(object) > m0, 3000);
      const landedOn = (from) => fake.uploadLog().slice(from).some((x) => x.landedGen && x.name === object);
      const u0 = fake.uploadCount();
      await pre(tag, object);
      await waitUntil(() => landedOn(u0), 3000);
      const downloading = await waitUntil(() => fake.readLog().filter((x) => x.name === object).length > r0, 3000);
      const read = fake.readLog().filter((x) => x.name === object).at(-1), before = fake.uploadCount();
      const w = await write();
      await waitUntil(() => landedOn(before), 3000);
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
    const acct = await straddle(() => fetch(url('/api/auth/delete-confirm'), { method: 'POST', headers: json, body: JSON.stringify({ code: '123456' }) }), 'acct', OBJECT);
    const relogin = await fetch(url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'k@example.test', password: 'Sup3rSecret!23' }) });
    record('fixture: each acked write (delete, save, account delete) LANDED while the re-check download was in flight',
      [del, add, acct].every((x) => x.status === 200 && x.landedWhileReading), JSON.stringify([del, add, acct]));
    record('THE DEFECT: no acked write is undone by the older copy that re-check was reading',
      !afterDel.some((g) => g.name === 'Victim') && afterAdd.some((g) => g.name === 'Added') && relogin.status === 401
        && !JSON.parse(fake.getStored()).users.some((u) => u.id === 'u_k') && JSON.parse(fake.getStored(GAMES)).deleted === true,
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
    await fetch(url('/api/games'), { headers: { authorization: `Bearer ${tok}` } }); // hold the account's object
    await new Promise((r) => setTimeout(r, 2200));
    // Both objects the listing re-checks move under it: db.json (a peer's
    // sign-up) and the account's games. The generation moved, so each re-check
    // downloads; a peer writes again the moment our metadata GET is answered,
    // so each download names a generation that is already gone.
    const root = JSON.parse(fake.getStored());
    root.users.push(seededUser('u_j2', 'gen2', 'j2@example.test', 'Sup3rSecret!23'));
    fake.peerWrite(JSON.stringify(root));
    fake.afterMetaOnce(() => { root.users.push(seededUser('u_j3', 'gen3', 'j3@example.test', 'Sup3rSecret!23')); return JSON.stringify(root); }, OBJECT);
    const pg = (id, name) => ({ id, userId: 'u_j', name, payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, createdAt: '2026-01-01T00:00:00Z' });
    fake.peerWrite(JSON.stringify({ userId: 'u_j', games: [pg('g_peer1', 'Peer-1')] }), null, 'games/u_j.json');
    fake.afterMetaOnce(() => JSON.stringify({ userId: 'u_j', games: [pg('g_peer1', 'Peer-1'), pg('g_peer2', 'Peer-2')] }), 'games/u_j.json');
    const listing = fetch(url('/api/games'), { headers: { authorization: `Bearer ${tok}` } });
    const first = await listing; fake.setReadDelayMs(0, 0);
    await new Promise((r) => setTimeout(r, 2200));
    const after = await (await fetch(url('/api/games'), { headers: { authorization: `Bearer ${tok}` } })).json();
    const peerLogin = (await fetch(url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'j3@example.test', password: 'Sup3rSecret!23' }) })).status;
    const stale = new Set(fake.readLog().filter((x) => x.want !== null && x.arrivedGen !== null && String(x.arrivedGen) !== x.want).map((x) => x.name));
    record('fixture: GCS answered a stale-generation download 404 for db.json AND for the account\'s object', fake.stale404s() >= 2 && stale.has(OBJECT) && stale.has('games/u_j.json'),
      `stale404s ${fake.stale404s()} on ${JSON.stringify([...stale])}`);
    record('THE DEFECT: each re-check follows the new generation: both peer games listed, the peer\'s second sign-up signs in, the route never 5xx',
      first.status === 200 && after.some((g) => g.name === 'Peer-1') && after.some((g) => g.name === 'Peer-2') && peerLogin === 200,
      `first ${first.status} after ${JSON.stringify(after.map?.((g) => g.name))} peer login ${peerLogin}`);
    await stop(boot.child); await fake.close();
  }

  // 18. THE RE-CHECK'S COST AND LATENCY BOUND. Under 12 concurrent clients for
  // 6s: at most one metadata GET per 2s window PER OBJECT (db.json and the
  // account's games) and no download while the generation is unchanged. With
  // metadata taking 5s, a DB route waits about 2s IN TOTAL (both re-checks
  // share one budget), never stacked, and a second wave waits no longer.
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
    await get(); // the account's object is held from here on
    const GAMES = 'games/u_c.json';
    const m0 = fake.metaGets(OBJECT), g0 = fake.metaGets(GAMES), d0 = fake.readLog().length; let n = 0, ok = 0; const end = Date.now() + 6000;
    await Promise.all(Array.from({ length: 12 }, async () => { while (Date.now() < end) { const r = await get(); ok += r.status === 200; n += 1; } }));
    const metas = fake.metaGets(OBJECT) - m0, gameMetas = fake.metaGets(GAMES) - g0, downloads = fake.readLog().length - d0;
    record('THE DEFECT: 12 clients for 6s cost at most 4 metadata GETs per object and no download (generation unchanged)',
      n > 100 && ok === n && metas <= 4 && gameMetas <= 4 && downloads === 0, `requests ${n} ok ${ok} metadataGETs db.json ${metas} games ${gameMetas} downloads ${downloads}`);
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
  // re-apply on the re-read object. (ii) X's own ack overtakes its re-check
  // and Y writes on top; s16 drops that read, so Y's game must arrive by X's
  // next upload (412, re-read) and by the next re-check. Director, sweep 3.
  // Both race on the account's games object.
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
    const G = 'games/u_p.json';
    const withGame = (stored, name) => { const db = JSON.parse(stored); db.games.push({ id: `g_${name}`, userId: 'u_p', name, payoffs: pay, createdAt: '2026-01-01T00:00:00Z' }); return JSON.stringify(db); };
    const onGcs = () => fake.games('u_p').map((g) => g.name);
    const has = (names) => () => names.every((n) => onGcs().includes(n));
    const reads = () => fake.readLog().filter((x) => x.name === G);
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    fake.peerWrite(JSON.stringify({ userId: 'u_p', games: [] }), null, G);
    await list(); // X holds the account's object
    await new Promise((r) => setTimeout(r, 2200));

    // (i)
    fake.peerWrite(withGame(fake.getStored(G), 'Y-Early'), null, G); // the generation moved: X's re-check downloads
    fake.setReadDelayMs(0, 1800);
    const r0 = reads().length, n0 = fake.count412();
    const trig1 = fetch(url('/api/games'), { headers: auth });
    await waitUntil(() => reads().length > r0, 3000);
    const read1 = reads().at(-1);
    fake.peerWrite(withGame(fake.getStored(G), 'Y-Mid'), null, G);
    const mid1 = read1.doneMs === undefined; // X saves while that download is in flight
    const s1 = await save('X-During');
    const refused1 = await waitUntil(() => fake.count412() > n0, 3000);
    await trig1; fake.setReadDelayMs(0, 0);
    await waitUntil(has(['Y-Early', 'Y-Mid', 'X-During']), 8000);
    await new Promise((r) => setTimeout(r, 2200));
    const list1 = await list(), gcs1 = onGcs();

    // (ii)
    await new Promise((r) => setTimeout(r, 2200));
    const u0 = fake.uploadCount(), n1 = fake.count412(), r1 = reads().length, m1 = fake.metaGets(G);
    fake.setReadDelayMs(600, 1800);
    fake.afterStoreOnce((stored) => withGame(stored, 'Y-Late'), G); // Y writes right on top of X's ack
    const trig2 = fetch(url('/api/games'), { headers: auth });
    await waitUntil(() => fake.metaGets(G) > m1, 3000);
    const s2 = await save('X-Acked');
    await waitUntil(() => fake.uploadLog().slice(u0).some((x) => x.landedGen), 3000);
    const ackGen = fake.uploadLog().slice(u0).find((x) => x.landedGen).landedGen;
    await waitUntil(() => reads().length > r1, 3000);
    const read2 = reads().at(-1);
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
  // in flight for the whole outage: a peer's write stayed invisible on X until
  // X's own write landed (sweep 4; main too). Here the pump holds an acked
  // db.json write (a legacy-hash login's rehash) through the outage, and a
  // game saved meanwhile is an honest 503. CONTROL: after recovery the acked
  // write, the peer's writes and the retried game are all on GCS, so the pump
  // still merges rather than overwrites.
  {
    const bGcs = gcsPortA + 40, bApp = port1 + 42; // s12's released ports
    const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
    const fake = await trackFake(startFakeGcsDb({ port: bGcs, initialContent: JSON.stringify({ users: [seededUser('u_bk', 'backoff', 'bk@example.test', 'Sup3rSecret!23'), seededUser('u_bk2', 'backoff2', 'bk2@example.test', 'Sup3rSecret!23')], games: [] }) }));
    const boot = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-backoff-'))), bApp, bGcs, { GCS_DEADLINE_MS: '3000' })), bApp);
    const url = (p) => `http://127.0.0.1:${bApp}${p}`;
    const login = (email) => fetch(url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Sup3rSecret!23' }) });
    const tok = (await (await login('bk@example.test')).json()).token;
    const auth = { authorization: `Bearer ${tok}` };
    await waitUntil(() => fake.uploadCount() >= 1, 5000);
    await new Promise((r) => setTimeout(r, 2200));
    fake.failUploads(true);
    const acked = await login('bk2@example.test'); // a db.json write the pump now holds through the outage
    const failing = await waitUntil(() => fake.uploadLog().some((u) => u.failed && u.name === OBJECT), 5000);
    const game = () => fetch(url('/api/games'), { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ name: 'X-Pending', payoffs: pay, clientRequestId: 'backoff-1' }) });
    const during = await game();
    const db = JSON.parse(fake.getStored());
    db.users.push(seededUser('u_bk3', 'backoff3', 'bk3@example.test', 'Sup3rSecret!23'));
    fake.peerWrite(JSON.stringify(db));
    fake.peerWrite(JSON.stringify({ userId: 'u_bk', games: [{ id: 'g_peer_bk', userId: 'u_bk', name: 'Peer-During-Outage', payoffs: pay, createdAt: '2026-01-01T00:00:00Z' }] }), null, 'games/u_bk.json');
    await new Promise((r) => setTimeout(r, 2200));
    const listed = await (await fetch(url('/api/games'), { headers: auth })).json();
    const peerSignIn = (await login('bk3@example.test')).status;
    const stillFailing = fake.uploadLog().filter((u) => u.name === OBJECT).at(-1)?.failed === true
      && !JSON.parse(fake.getStored()).users.find((u) => u.id === 'u_bk2')?.passwordHash.startsWith('pbkdf2$');
    fake.failUploads(false);
    const retried = await game();
    const both = await waitUntil(() => {
      const n = fake.games('u_bk').map((g) => g.name), users = JSON.parse(fake.getStored()).users;
      return n.includes('X-Pending') && n.includes('Peer-During-Outage') && users.some((u) => u.id === 'u_bk3')
        && !!users.find((u) => u.id === 'u_bk2')?.passwordHash.startsWith('pbkdf2$');
    }, 70000);
    record('fixture: the db.json write was acked and its uploads were failing (not landed) when the peer wrote and X listed; the game saved meanwhile was an honest 503',
      acked.status === 200 && failing && stillFailing && during.status === 503, `ack ${acked.status} failing ${failing} stillPending ${stillFailing} game ${during.status}`);
    record('THE DEFECT: during the outage X lists the peer\'s game and signs in the peer\'s new account within one freshness window; after recovery all of it is on GCS',
      listed.some?.((g) => g.name === 'Peer-During-Outage') && peerSignIn === 200 && retried.status === 200 && both,
      `listed ${JSON.stringify(listed.map?.((g) => g.name))} peer sign-in ${peerSignIn} retry ${retried.status} both ${both}`);
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
      const fpAt = [Date.now()];
      const fp1 = await j(await call(aX, '/api/auth/forgot-password', { email: 'of@example.test' }));
      fpAt.push(Date.now());
      const fp2 = await j(await call(aX, '/api/auth/forgot-password', { email: 'of@example.test' }));
      const fpMails = mailsTo('of@example.test', m5);
      // The recovery code locked (5 wrong resets) is not live: a request inside the minute is 429 with the real wait.
      const fpCode = codeFor('of@example.test', m5);
      for (let i = 0; i < 5; i++) await call(aX, '/api/auth/reset-password', { email: 'of@example.test', code: fpCode === '000000' ? '000001' : '000000', newPassword: 'N3wSecret!pass' });
      await pastBy(fpAt[1], 1200);
      const fp3At0 = Date.now(), fp3 = await call(aX, '/api/auth/forgot-password', { email: 'of@example.test' });
      const fp3Ra = retryAfterIn(fp3.headers.get('retry-after'), fpAt, [fp3At0, Date.now()]);
      const fpMails3 = mailsTo('of@example.test', m5);
      await stop(S.child); // fresh process: register is limited to 8/min per IP
      S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-pend2-'))), aX, aGcs, mail)), aX);
      // Five wrong codes lock it; the right one then fails, and a re-register
      // inside the minute mails nothing (locking must not buy a fresh mail).
      const lk = 'lock@example.test', m1 = mailed.length;
      const lkAt = [Date.now()];
      await reg('locker', lk, OWN);
      lkAt.push(Date.now());
      const lkCode = codeFor(lk, m1), tries = [];
      for (let i = 0; i < 5; i++) tries.push(await ver({ email: lk, code: lkCode === '000000' ? '000001' : '000000', password: OWN }));
      const lkAfter = await ver({ email: lk, code: lkCode, password: OWN });
      await pastBy(lkAt[1], 1200);
      const lkResendAt0 = Date.now();
      const lkResendRaw = await call(aX, '/api/auth/register', { username: 'locker', email: lk, password: OWN });
      const lkRa = retryAfterIn(lkResendRaw.headers.get('retry-after'), lkAt, [lkResendAt0, Date.now()]);
      const lkResend = await j(lkResendRaw);
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
      record('THE DEFECT: 5 wrong codes lock it (then the right one fails) and a re-register inside the minute mails nothing (429, Retry-After = the cooldown left)',
        tries.slice(0, 4).every((t) => /Incorrect/.test(t.body.error ?? '')) && /Too many/.test(tries[4].body.error ?? '')
          && lkAfter.status === 400 && lkResend.status === 429 && lkMails === 1 && lkRa.ok,
        JSON.stringify({ tries: tries.map((t) => (t.body.error ?? '').slice(0, 12)), after: lkAfter.status, resend: lkResend.status, lkMails, ra: lkRa.detail }));
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
      record('THE DEFECT (director audit s16): a locked recovery code re-requested inside the minute is 429, mails nothing, Retry-After = the cooldown left',
        fp3.status === 429 && fpMails3 === 1 && fp3Ra.ok, JSON.stringify({ fp3: fp3.status, fpMails3, ra: fp3Ra.detail }));
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
      const S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-squat-'))), aX, aGcs, { ...mail, SMTP_PORT: String(gcsPortA + 11) })), aX); // nothing binds it (port1's +12 is unused): mail down
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
      // The new-signup cooldown: a locked row that another sign-up swept re-registers through the NEW-signup
      // path (verify's 404 proves the row is gone), and inside the minute that is a 429 with the cooldown left.
      const sw = 'swept@example.test', mS = mailed.length, swAt = [Date.now()];
      await req('POST', '/api/auth/register', null, { username: 'swept', email: sw, password: 'Sup3rSecret!23' });
      swAt.push(Date.now());
      for (let i = 0; i < 5; i++) await req('POST', '/api/auth/verify', null, { email: sw, code: '000000', password: 'Sup3rSecret!23' }); // makeCode is never 000000
      await req('POST', '/api/auth/register', null, { username: 'sweeper', email: 'sweeper@example.test', password: 'Sup3rSecret!23' });
      const gone = await req('POST', '/api/auth/verify', null, { email: sw, code: '000000', password: 'Sup3rSecret!23' });
      await pastBy(swAt[1], 1200);
      const swT = Date.now(), swAgain = await fetch(`http://127.0.0.1:${aX}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'swept', email: sw, password: 'Sup3rSecret!23' }) });
      const swRa = retryAfterIn(swAgain.headers.get('retry-after'), swAt, [swT, Date.now()]);
      const swMails = mailed.slice(mS).filter((m) => m.to === sw).length;
      await stop(S.child); await fake.close();
      record('THE DEFECT (director audit s16): a locked row swept by another sign-up re-registers inside the minute: 429 on the new-signup path, no mail, Retry-After = the cooldown left',
        gone.status === 404 && swAgain.status === 429 && swMails === 1 && swRa.ok, JSON.stringify({ gone: gone.status, again: swAgain.status, swMails, ra: swRa.detail }));
      record('fixture: both seeded users signed in, the recovery mail carried a code, and the reset answered 200',
        la.status === 200 && lb.status === 200 && /^\d{6}$/.test(rc ?? '') && reset.status === 200, JSON.stringify({ la: la.status, lb: lb.status, rc: !!rc, reset: reset.status }));
      record('a password reset ends every earlier session (old token 401 on /me and /games); the new password signs in; the other account stays signed in',
        JSON.stringify(old) === '[401,401]' && JSON.stringify(after) === '[200,200,200]', JSON.stringify({ old, after }));
      // Hosted, an account's games are its own object: another account's PATCH and
      // DELETE look only in theirs, so the game is "not found" (404), which also
      // says nothing about whether that id exists.
      record('hosted games are owner-only: another account\'s PATCH and DELETE are 404 and its list omits the game; the owner keeps it, unrenamed',
        bPatch.status === 404 && bDelete.status === 404 && Array.isArray(bList.body) && !bList.body.some((g) => g.id === 'g_ha')
          && fake.games('h_a').some((g) => g.id === 'g_ha' && g.name === 'A-own')
          && Array.isArray(aList.body) && aList.body.some((g) => g.id === 'g_ha' && g.name === 'A-own'),
        JSON.stringify({ patch: bPatch.status, del: bDelete.status, bSees: bList.body?.length, aHas: aList.body?.map?.((g) => g.name) }));
      const keys = (o) => Object.keys(o ?? {}).sort().join();
      record('/me and login carry only id, username, email: no hash, code or token version',
        keys(me.body) === 'email,id,username' && keys(la.body.user) === 'email,id,username'
          && !/passwordHash|Code|tokenVersion/.test(JSON.stringify([me.body, la.body])),
        JSON.stringify({ me: keys(me.body), login: keys(la.body.user), top: keys(la.body) }));
      record('adopt-local does not exist hosted: 404 signed in and signed out', JSON.stringify(adopt) === '[404,404]', JSON.stringify(adopt));
    }

    // s25 — hosted growth bounds (S14-1: a game flood OOM-crashed a 128 MB heap at ~23 MB of db.json).
    // The bound is now PER ACCOUNT — one object each, capped in bytes, read on demand into a bounded
    // cache — and db.json (accounts only) keeps its own budget. (a) An account at 200 games gets 409
    // with the reason; a clientRequestId retry of an existing row still saves. (b) An account whose
    // object boots OVER its cap (migrated whole from db.json — the cap never refuses existing data): a
    // new game and a growing edit are 413 naming the cap; a shrinking edit and a delete still work
    // while it stays over, and reach GCS; ANOTHER account saves meanwhile. (c) db.json boots over ITS
    // budget: a sign-up is 507 and mails nothing; login and verify still work.
    {
      const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
      const CAP = 64 * 1024;
      const capRows = Array.from({ length: 200 }, (_, i) => ({ id: `g_cap_${i}`, userId: 'u_cap', name: `Cap ${i}`, description: 'd', payoffs: pay,
        ...(i === 0 ? { clientRequestId: 'req_retry_0' } : {}), createdAt: '2026-01-01T00:00:00Z' }));
      const bRows = Array.from({ length: 150 }, (_, i) => ({ id: `g_b${i}`, userId: 'u_b', name: `B-${i}`, description: 'x'.repeat(400), payoffs: pay, createdAt: '2026-01-01T00:00:00Z' }));
      const users = [seededUser('u_cap', 'capper', 'cap@example.test', 'Sup3rSecret!23'), seededUser('u_b', 'budget', 'b@example.test', 'Sup3rSecret!23'),
        seededUser('u_other', 'other', 'other@example.test', 'Sup3rSecret!23'),
        { ...seededUser('u_pv', 'pendv', 'pv@example.test', 'Sup3rSecret!23'), isVerified: false, verificationCode: '424242', verificationCodeExpires: Date.now() + 600000 }];
      const rootBytes = Buffer.byteLength(JSON.stringify({ users, games: [] }, null, 2));
      const budget = rootBytes - 200; // db.json (accounts only, once the games move out) boots over its budget
      const fake = await trackFake(startFakeGcsDb({ port: aGcs, initialContent: JSON.stringify({ users, games: [...capRows, ...bRows] }) }));
      const S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-budget-'))), aX, aGcs, { ...mail, DB_MAX_BYTES: String(budget), ACCOUNT_GAMES_MAX_BYTES: String(CAP) })), aX);
      const req = async (method, route, token, body) => {
        const r = await fetch(`http://127.0.0.1:${aX}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, error: (await r.json().catch(() => ({}))).error ?? '' };
      };
      const tokOf = async (email) => (await (await fetch(`http://127.0.0.1:${aX}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Sup3rSecret!23' }) })).json()).token;
      const tCap = await tokOf('cap@example.test'), tB = await tokOf('b@example.test'), tOther = await tokOf('other@example.test');
      const bBoot = Buffer.byteLength(fake.getStored('games/u_b.json') ?? '');
      const capNew = await req('POST', '/api/games', tCap, { name: 'One too many', payoffs: pay });
      const capRetry = await req('POST', '/api/games', tCap, { name: 'Cap 0', description: 'd', payoffs: pay, clientRequestId: 'req_retry_0' }); // same size: not growth
      const fullNew = await req('POST', '/api/games', tB, { name: 'B-new', description: 'y'.repeat(400), payoffs: pay });
      const grow = await req('PATCH', '/api/games/g_b1', tB, { description: 'z'.repeat(800) });
      const otherSave = await req('POST', '/api/games', tOther, { name: 'Other-account', description: 'y'.repeat(400), payoffs: pay });
      const m0 = mailed.length;
      const signUp = await req('POST', '/api/auth/register', null, { username: 'late', email: 'late@example.test', password: 'Sup3rSecret!23' });
      const signUpMails = mailed.length - m0;
      const shrink = await req('PATCH', '/api/games/g_b1', tB, { description: 'short' });
      const del = await req('DELETE', '/api/games/g_b5', tB);
      const login = (await req('POST', '/api/auth/login', null, { email: 'b@example.test', password: 'Sup3rSecret!23' })).status;
      const verify = await req('POST', '/api/auth/verify', null, { email: 'pv@example.test', code: '424242', password: 'Sup3rSecret!23' });
      const onGcs = await waitUntil(() => { const b = fake.games('u_b'); return !b.some((g) => g.id === 'g_b5') && b.find((g) => g.id === 'g_b1')?.description === 'short'; }, 5000);
      const bEnd = Buffer.byteLength(fake.getStored('games/u_b.json') ?? '');
      await stop(S.child); await fake.close();
      record('fixture: B\'s object booted (migrated whole) and ended over the 64 KB cap; the cap account held exactly 200 games; db.json booted over its budget',
        bBoot > CAP && bEnd > CAP && bEnd < bBoot && fake.games('u_cap').length === 200 && rootBytes > budget && JSON.parse(fake.getStored()).games.length === 0,
        JSON.stringify({ bBoot, bEnd, CAP, rootBytes, budget, capGames: fake.games('u_cap').length }));
      record('THE DEFECT (per-account count cap): the 201st game is 409 with the limit named; a clientRequestId retry of an existing row still saves',
        capNew.status === 409 && /200 saved-game limit/.test(capNew.error) && /Delete a saved game/.test(capNew.error) && capRetry.status === 200,
        JSON.stringify({ capNew, capRetry: capRetry.status }));
      record('THE DEFECT (per-account byte cap): past its cap a new game and a growing edit are 413 naming the cap; ANOTHER account still saves; a sign-up past db.json\'s budget is 507 and mails nothing',
        fullNew.status === 413 && fullNew.error === 'Saved games for this account exceeded the 64 KB limit. Delete a saved game to make room, then save again.'
          && grow.status === 413 && grow.error === fullNew.error && otherSave.status === 200 && fake.games('u_other').some((g) => g.name === 'Other-account')
          && signUp.status === 507 && /sign-ups are paused/.test(signUp.error) && signUpMails === 0,
        JSON.stringify({ fullNew, grow, otherSave: otherSave.status, signUp, signUpMails }));
      record('over the cap a shrinking edit, a delete, login and a verify still work, and the acked changes reach GCS',
        shrink.status === 200 && del.status === 200 && login === 200 && verify.status === 200 && onGcs,
        JSON.stringify({ shrink: shrink.status, del: del.status, login, verify: verify.status, onGcs }));
    }

    // s25b — the cap is measured EXACTLY (S15-1: a full stringify per refused write held /api/health at
    // p50 176 ms under a /48 flood; a write now measures only the rows it changes). A 41-write script
    // (1 add, 3 shrinks, 3 deletes, 5 grows, 29 adds: the object only grows after the drain, so its peak
    // is its end) runs three times on one seed, each from the same migrated object. Pass 1 lands it and
    // reads the true size T from GCS. At a cap of T all 41 pass; at T-1 exactly the last add is 413.
    {
      const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
      const seedGames = Array.from({ length: 11 }, (_, i) => ({ id: `g_d${i}`, userId: 'u_d', name: `seed ${i}`, description: 'm'.repeat(300), payoffs: pay, createdAt: '2026-01-01T00:00:00Z' }));
      const seed = JSON.stringify({ users: [seededUser('u_d', 'drift', 'd@example.test', 'Sup3rSecret!23')], games: seedGames });
      const G = 'games/u_d.json';
      const fake = await trackFake(startFakeGcsDb({ port: aGcs, initialContent: seed }));
      const boot = async (cap) => waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-drift-'))), aX, aGcs, { ...mail, TRUST_PROXY: '1', ACCOUNT_GAMES_MAX_BYTES: String(cap) })), aX);
      let hop = 0; // a fresh /56 per request: 41 writes must not meet the 20/min write limit
      const req = async (method, route, token, body) => {
        const r = await fetch(`http://127.0.0.1:${aX}${route}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': `2001:db8:${(hop++).toString(16)}00::1`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return r.status;
      };
      const run = async (cap) => {
        fake.setStored(seed); fake.setStored(null, G); // every pass migrates the same seed into a fresh object
        const S = await boot(cap);
        const tok = (await (await fetch(`http://127.0.0.1:${aX}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `2001:db9:${(hop++).toString(16)}00::1` }, body: JSON.stringify({ email: 'd@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
        const start = fake.getStored(G);
        const st = [await req('POST', '/api/games', tok, { name: 'first', description: '界'.repeat(40), payoffs: pay })];
        for (let i = 0; i < 3; i++) st.push(await req('PATCH', `/api/games/g_d${i}`, tok, { description: 's' }));
        for (let i = 3; i < 6; i++) st.push(await req('DELETE', `/api/games/g_d${i}`, tok));
        for (let i = 6; i < 11; i++) st.push(await req('PATCH', `/api/games/g_d${i}`, tok, { description: 'grown '.repeat(60 + i) }));
        for (let i = 0; i < 29; i++) st.push(await req('POST', '/api/games', tok, { name: `d${i}`, description: '界x'.repeat(i * 7), payoffs: pay, colorTermsA: i % 3 ? [`t${i}`] : [] }));
        await stop(S.child);
        return { st, start };
      };
      const p1 = await run(10_000_000);
      const T = Buffer.byteLength(fake.getStored(G) ?? '');
      const landedGames = fake.games('u_d').length;
      const p2 = await run(T);
      const p3 = await run(T - 1);
      await fake.close();
      const ok = (st) => st.every((x) => x === 200);
      record('fixture: pass 1 ran all 41 writes and landed 38 games on GCS, giving the true size T',
        ok(p1.st) && p1.st.length === 41 && landedGames === 11 - 3 + 30 && T > 20000, JSON.stringify({ n: p1.st.length, bad: p1.st.filter((x) => x !== 200), landedGames, T }));
      record('fixture: every pass started from the same migrated object (db.json\'s legacy rows, moved byte-identical each time)',
        typeof p1.start === 'string' && p1.start === p2.start && p2.start === p3.start && JSON.parse(p1.start).games.length === 11,
        JSON.stringify({ starts: [p1.start, p2.start, p3.start].map((x) => (x ?? '').length) }));
      record('THE DEFECT (cap drift): a cap of T passes all 41 writes and T-1 refuses exactly the last add (413)',
        ok(p2.st) && ok(p3.st.slice(0, 40)) && p3.st[40] === 413,
        JSON.stringify({ atT: p2.st.filter((x) => x !== 200), atTminus1: p3.st.map((x, i) => (x !== 200 ? `${i}:${x}` : '')).filter(Boolean) }));
    }

    // s26 — admin CORS & request bounds (sweep 17 angles 1 & 2).
    // (a) Admin CORS: hostile origin gets no ACAO on 200, OPTIONS or 429; local client
    // gets its origin echoed and Vary: Origin. Case variations (/api/ADMIN/stats) do not leak.
    // (b) Limits: 17KB headers yield 431; 120KB body yields 413 with {"error":"Invalid request."}.
    // (c) A slow header drip does not block other endpoints (/api/health responds promptly).
    {
      const sApp = port1 + 54, sGcs = gcsPortA + 54; // even offsets, as everywhere: CI's port1 sits one below gcsPortA, so odd ones collide
      const fake = await trackFake(startFakeGcsDb({ port: sGcs, initialContent: JSON.stringify({ users: [], games: [] }) }));
      const S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s26-'))), sApp, sGcs,
        { ADMIN_SECRET: 'super-admin-secret-2026' })), sApp);
      const evil = 'https://evil.example', local = 'http://127.0.0.1:5173';
      const rEvil = await fetch(`http://127.0.0.1:${sApp}/api/admin/stats`, { headers: { origin: evil, 'x-admin-secret': 'super-admin-secret-2026' } });
      const rLocal = await fetch(`http://127.0.0.1:${sApp}/api/admin/stats`, { headers: { origin: local, 'x-admin-secret': 'super-admin-secret-2026' } });
      const rOpt = await fetch(`http://127.0.0.1:${sApp}/api/admin/stats`, { method: 'OPTIONS', headers: { origin: evil, 'access-control-request-method': 'GET' } });
      for (let i = 0; i < 9; i++) await fetch(`http://127.0.0.1:${sApp}/api/admin/stats`, { headers: { origin: evil, 'x-admin-secret': 'super-admin-secret-2026' } });
      const r429Evil = await fetch(`http://127.0.0.1:${sApp}/api/admin/stats`, { headers: { origin: evil, 'x-admin-secret': 'super-admin-secret-2026' } });
      const r429Local = await fetch(`http://127.0.0.1:${sApp}/api/admin/stats`, { headers: { origin: local, 'x-admin-secret': 'super-admin-secret-2026' } });
      const rCasing = await fetch(`http://127.0.0.1:${sApp}/api/ADMIN/stats`, { headers: { origin: evil, 'x-admin-secret': 'super-admin-secret-2026' } });
      const r431 = await fetch(`http://127.0.0.1:${sApp}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-huge': 'x'.repeat(17000) }, body: '{}' });
      const r413 = await fetch(`http://127.0.0.1:${sApp}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, pad: 'p'.repeat(120 * 1024) }) });
      const r413Body = await r413.json().catch(() => ({}));
      const slowSock = net.connect(sApp, '127.0.0.1');
      await new Promise((r) => slowSock.on('connect', r));
      slowSock.write(`POST /api/report HTTP/1.1\r\nHost: 127.0.0.1:${sApp}\r\n`);
      const drip = setInterval(() => { try { slowSock.write('X-Slow: d\r\n'); } catch { clearInterval(drip); } }, 200);
      const t0 = Date.now();
      const rHealth = await fetch(`http://127.0.0.1:${sApp}/api/health`);
      const hLat = Date.now() - t0;
      clearInterval(drip); slowSock.destroy();
      await stop(S.child); await fake.close();

      record('THE DEFECT (admin CORS): hostile origin receives no ACAO on 200, OPTIONS or 429, including case variations; local origin receives echo and Vary',
        rEvil.headers.get('access-control-allow-origin') === null
          && rOpt.headers.get('access-control-allow-origin') === null
          && r429Evil.status === 429 && r429Evil.headers.get('access-control-allow-origin') === null
          && rCasing.status === 429 && rCasing.headers.get('access-control-allow-origin') === null
          && rLocal.headers.get('access-control-allow-origin') === local && /Origin/i.test(rLocal.headers.get('vary') || '')
          && r429Local.headers.get('access-control-allow-origin') === local,
        JSON.stringify({ evil: rEvil.headers.get('access-control-allow-origin'), opt: rOpt.headers.get('access-control-allow-origin'),
          e429: r429Evil.headers.get('access-control-allow-origin'), casing: rCasing.headers.get('access-control-allow-origin'),
          loc: rLocal.headers.get('access-control-allow-origin') }));

      record('THE DEFECT (request limits): 17KB headers return 431, 120KB body returns 413 Invalid request, slow header drip does not block health',
        r431.status === 431 && r413.status === 413 && r413Body.error === 'Invalid request.'
          && rHealth.status === 200 && hLat < 2000,
        JSON.stringify({ r431: r431.status, r413: r413.status, body: r413Body, hStatus: rHealth.status, hLat }));
    }

    // s27 — sign-up stale sweep under budget, a rollover's legacy-row storm, and SIGTERM drain (sweep 17 angles 4, 4b & 5).
    // (a) Stale-row sweep: an over-budget measured db.json admits a sign-up that sweeps dead pending rows;
    // status is 200, 1 mail is sent, stale rows are purged from GCS, counter stays consistent (HIT S17-1). A
    // game save is outside that budget (the account's own object), so it is a 200 while db.json is full.
    // (b) and (c): see their own comments below.
    {
      const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
      const oldExp = Date.now() - 3 * 24 * 3600e3;
      const staleUsers = Array.from({ length: 15 }, (_, i) => ({
        id: `u_st${i}`, username: `stale${i}`, email: `st${i}@example.test`,
        passwordHash: Buffer.from('Sup3rSecret!23').toString('base64'),
        isVerified: false, verificationCode: '111111', verificationCodeExpires: oldExp,
      }));
      const seedUsers = [seededUser('u_v', 'v', 'v@example.test', 'Sup3rSecret!23'), ...staleUsers];
      const seed = JSON.stringify({ users: seedUsers, games: [] });
      const seedBytes = Buffer.byteLength(JSON.stringify(JSON.parse(seed), null, 2));
      const s27Gcs = gcsPortA + 56, s27App = port1 + 56;
      const fake = await trackFake(startFakeGcsDb({ port: s27Gcs, initialContent: seed }));
      const budget = seedBytes - 200;
      const S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s27-'))), s27App, s27Gcs,
        { ...mail, DB_MAX_BYTES: String(budget) })), s27App);
      const tok = (await (await fetch(`http://127.0.0.1:${s27App}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'v@example.test', password: 'Sup3rSecret!23' }) })).json()).token;
      // A game save while db.json is over its budget: the account's own object, not db.json.
      const g0 = await fetch(`http://127.0.0.1:${s27App}/api/games`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
        body: JSON.stringify({ name: 'measure', payoffs: pay }) });
      const m0 = mailed.length;
      // Net-shrinking sign-up: sweeps 15 stale rows, adds 1 -> shrinks store -> must succeed (200)
      const reg = await fetch(`http://127.0.0.1:${s27App}/api/auth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'newbie', email: 'new@example.test', password: 'Sup3rSecret!23' }) });
      const regMails = mailed.length - m0;
      const onGcs = await waitUntil(() => {
        try {
          const d = JSON.parse(fake.getStored());
          return d.users.some((u) => u.username === 'newbie') && !d.users.some((u) => u.id.startsWith('u_st'));
        } catch { return false; }
      }, 5000);
      const endBytes = Buffer.byteLength(JSON.stringify(JSON.parse(fake.getStored()), null, 2));
      await stop(S.child);

      record('THE DEFECT (sign-up stale sweep budget): a sign-up that shrinks a full db.json by sweeping stale rows passes 200, sends mail, and purges stale rows on GCS; a game save is outside that budget',
        g0.status === 200 && fake.games('u_v').some((g) => g.name === 'measure') && reg.status === 200 && regMails === 1 && onGcs && endBytes < budget,
        JSON.stringify({ g0: g0.status, reg: reg.status, regMails, onGcs, endBytes, budget }));

      const big = (id, userId) => ({ id, userId, name: id, description: 'x'.repeat(400), payoffs: pay, createdAt: '2026-01-01T00:00:00Z' });
      let hop = 0; // a fresh /56 per request: no write or sign-up limit is in play
      const xff = () => `2001:db8:${(0x2700 + hop++).toString(16)}::1`;
      const call = async (method, route, token, body) => (await fetch(`http://127.0.0.1:${s27App}${route}`, { method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': xff(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) })).status;
      const loginAs = async (email) => (await (await fetch(`http://127.0.0.1:${s27App}/api/auth/login`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': xff() }, body: JSON.stringify({ email, password: 'Sup3rSecret!23' }) })).json()).token;

      // (b) A ROLLOVER'S LEGACY-ROW STORM (angle 4b, re-cut for per-account objects). A previous revision
      // still serving writes its games into db.json's legacy array: a peer appends a row every 60 ms while
      // every upload is held 150 ms, so X's db.json writes (sign-ups) meet stale preconditions (412, re-read,
      // migrate, retry) while X answers game adds, grows and deletes on its own object. After the storm GCS
      // must agree with every answer, hold every peer row exactly once in its account's object, and hold no
      // legacy row in db.json. Cannot pass by coincidence: peer rows reach their object only by migration.
      const seedB = { users: [seededUser('u_x', 'x', 'x@example.test', 'Sup3rSecret!23'), seededUser('u_peer', 'peer', 'peer@example.test', 'Sup3rSecret!23')],
        games: Array.from({ length: 8 }, (_, i) => big(`g_x${i}`, 'u_x')) };
      fake.setStored(JSON.stringify(seedB));
      const SB = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s27b-'))), s27App, s27Gcs, { ...mail, TRUST_PROXY: '1' })), s27App);
      const tokB = await loginAs('x@example.test');
      const n412b = fake.count412();
      fake.setUploadDelayMs(150);
      let peers = 0;
      const storm = setInterval(() => {
        const d = JSON.parse(fake.getStored()); d.games.push({ ...big(`g_peer${peers}`, 'u_peer'), description: 'p' }); peers++; fake.peerWrite(JSON.stringify(d));
      }, 60);
      const answers = [];
      try {
        for (let i = 0; i < 6; i++) {
          answers.push(['add', `n${i}`, await call('POST', '/api/games', tokB, { name: `n${i}`, payoffs: pay })]);
          if (i < 4) answers.push(['grow', `g_x${4 + i}`, await call('PATCH', `/api/games/g_x${4 + i}`, tokB, { description: 'y'.repeat(800) })]);
          if (i < 4) answers.push(['del', `g_x${i}`, await call('DELETE', `/api/games/g_x${i}`, tokB)]);
          answers.push(['reg', `r${i}`, await call('POST', '/api/auth/register', null, { username: `r${i}`, email: `r${i}@example.test`, password: 'Sup3rSecret!23' })]);
          await new Promise((r) => setTimeout(r, 250));
        }
      } finally { clearInterval(storm); }
      const storm412 = fake.count412() - n412b;
      fake.setUploadDelayMs(0);
      const disagree = (d) => answers.filter(([k, id, st]) => {
        const games = fake.games('u_x'), g = games.find((x) => x.id === id || x.name === id), u = d.users.find((x) => x.username === id);
        if (k === 'add') return !(st === 200 && g);
        if (k === 'grow') return !(st === 200 && g?.description === 'y'.repeat(800));
        if (k === 'del') return !(st === 200 && !g);
        return !(st === 200 && u);
      }).map(([k, id, st]) => `${k}:${id}:${st}`);
      const peerRows = () => fake.games('u_peer');
      const isSettled = () => { const d = JSON.parse(fake.getStored()); return disagree(d).length === 0 && d.games.length === 0 && peerRows().length === peers && new Set(peerRows().map((x) => x.id)).size === peers; };
      let settled = false;
      for (const until = Date.now() + 20_000; !settled && Date.now() < until;) {
        await call('GET', '/api/games', tokB); // a DB route re-checks db.json, migrating what the peer left there
        settled = await waitUntil(isSettled, 1000);
      }
      const endB = JSON.parse(fake.getStored());
      await stop(SB.child);
      record('fixture: the storm 412ed X\'s db.json writes, and X answered every write 200 (games are outside db.json)',
        storm412 >= 3 && answers.every((a) => a[2] === 200) && answers.length === 20,
        JSON.stringify({ storm412, answers: answers.map((a) => `${a[0]}:${a[2]}`).join(' ') }));
      record('THE DEFECT (legacy-row storm): after the storm GCS agrees with every answer, every peer row is in its account\'s object exactly once, and db.json holds none',
        settled, JSON.stringify({ peers, peerRows: peerRows().length, legacyLeft: endB.games.length, disagree: disagree(endB) }));

      // (c) SIGTERM mid-upload with refusals answered meanwhile (angle 5). The first db.json upload (the login
      // rehash) and every object upload are held 2 s; inside that, a game delete is in flight, a new game and a
      // growing edit are refused (413: the account is over its cap) and a sign-up is refused (507: db.json is
      // over its budget), then SIGTERM. The drain must land the rehash AND the delete, answer the delete 200,
      // exit 0 inside the grace period, and carry no refused row. Cannot pass by coincidence: nothing had
      // landed at SIGTERM, so both leave only through the drain.
      const seedC = { users: [seededUser('u_y', 'y', 'y@example.test', 'Sup3rSecret!23')], games: Array.from({ length: 6 }, (_, i) => big(`g_y${i}`, 'u_y')) };
      fake.setStored(JSON.stringify(seedC)); fake.setStored(null, 'games/u_y.json');
      const rootC = Buffer.byteLength(JSON.stringify({ users: seedC.users, games: [] }, null, 2));
      const SC = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s27c-'))), s27App, s27Gcs,
        { ...mail, TRUST_PROXY: '1', DB_MAX_BYTES: String(rootC - 50), ACCOUNT_GAMES_MAX_BYTES: '2048' })), s27App);
      const landed = () => fake.uploadLog().filter((u) => u.landedGen).length;
      await waitUntil(() => JSON.parse(fake.getStored()).games.length === 0, 5000); // the boot migration's db.json write has landed
      const l0 = landed();
      fake.setUploadDelayMs(2000);
      const tokC = await loginAs('y@example.test');
      // Game writes are answered once their object's upload lands: in flight, queued in order behind it.
      const delP = call('DELETE', '/api/games/g_y0', tokC);
      await new Promise((r) => setTimeout(r, 100));
      const addP = call('POST', '/api/games', tokC, { name: 'refused', payoffs: pay });
      const growP = call('PATCH', '/api/games/g_y1', tokC, { description: 'z'.repeat(800) });
      const regC = await call('POST', '/api/auth/register', null, { username: 'late', email: 'late@example.test', password: 'Sup3rSecret!23' });
      await new Promise((r) => setTimeout(r, 100));
      const landedAtTerm = landed() - l0;
      const exited = new Promise((r) => SC.child.once('exit', (c, sig) => r(c ?? sig)));
      const t0 = Date.now();
      SC.child.kill('SIGTERM');
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('hung'), 12_000))]);
      const exitMs = Date.now() - t0;
      const [del, add, grow] = await Promise.all([delP, addP, growP].map((p) => p.catch((err) => String(err?.cause?.code ?? err))));
      fake.setUploadDelayMs(0);
      const endC = JSON.parse(fake.getStored()), gamesC = fake.games('u_y');
      await fake.close();
      record('fixture: at SIGTERM nothing had landed, three game writes were in flight, and a sign-up was refused (507: db.json over its budget)',
        landedAtTerm === 0 && regC === 507, JSON.stringify({ landedAtTerm, reg: regC }));
      record('THE DEFECT (SIGTERM mid-upload with refusals): the drain lands the rehash and the delete (200), answers the over-cap add and grow 413, exits 0 inside the grace period, and carries no refused row',
        code === 0 && exitMs < 9000 && del === 200 && add === 413 && grow === 413 && !gamesC.some((g) => g.id === 'g_y0') && !gamesC.some((g) => g.name === 'refused')
          && gamesC.find((g) => g.id === 'g_y1')?.description === 'x'.repeat(400) && !endC.users.some((u) => u.username === 'late')
          && !!endC.users.find((u) => u.id === 'u_y')?.passwordHash.startsWith('pbkdf2$'),
        JSON.stringify({ code, exitMs, del, add, grow, games: gamesC.map((g) => g.id), users: endC.users.map((u) => u.username) }));
    }

    // s28 — db.json deleted mid-run (sweep 18 angle 5, S18-1). A fresh instance's sign-up re-created it
    // without X's rows, and X's three-way merge took every row it had read as a remote deletion: all
    // accounts and games gone, X answered 401. Cannot pass by coincidence: X only READS after the delete
    // (no route write), so rows reach GCS only through the write-back, and (c) runs a same-history delete.
    {
      const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
      const g = (id, userId) => ({ id, userId, name: id, description: '', payoffs: pay, createdAt: '2026-01-01T00:00:00Z' });
      const seed = JSON.stringify({ users: [seededUser('u_a', 'a', 'a@example.test', 'Sup3rSecret!23'), seededUser('u_b', 'b', 'b@example.test', 'Sup3rSecret!23')],
        games: [g('g_a', 'u_a'), g('g_b', 'u_b')] });
      const s28Gcs = gcsPortA + 56, xApp = port1 + 56, yApp = port1 + 54; // s27's and s26's released ports
      const req = (p, method, route, tok, body) => fetch(`http://127.0.0.1:${p}${route}`, { method,
        headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const loginOn = async (p, email) => (await (await call(p, '/api/auth/login', { email, password: 'Sup3rSecret!23' })).json()).token;
      const ids = (rows) => rows.map((x) => x.id).sort().join(',');
      const onGcs = (f) => (f.getStored() ? JSON.parse(f.getStored()) : { users: [], games: [] });
      const objs = (f) => f.allGames().map((x) => x.id).sort().join(','); // the games live in their accounts' objects, which the db.json delete never touched
      const bootX = async (f, tag) => {
        const X = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), `nash-gcs-s28${tag}-`))), xApp, s28Gcs, mail)), xApp);
        const u0 = f.uploadCount(), tok = await loginOn(xApp, 'a@example.test'); // the rehash write lands first
        await waitUntil(() => f.uploadLog().slice(u0).some((x) => x.landedGen), 3000);
        await new Promise((r) => setTimeout(r, 2200)); // past X's window: its next DB route re-checks
        return { X, tok };
      };
      // (a) deleted; X's next re-check finds no object and writes its rows back at once.
      const fa = await trackFake(startFakeGcsDb({ port: s28Gcs, initialContent: seed }));
      const a = await bootX(fa, 'a');
      fa.setStored(null);
      const aGet = await req(xApp, 'GET', '/api/games', a.tok);
      const aBack = await waitUntil(() => fa.getStored() !== null, 4000);
      const aEnd = onGcs(fa), aLineage = fa.getCustom()?.lineage;
      await stop(a.X.child); await fa.close();
      record('THE DEFECT (db.json deleted, a): a read alone re-creates the object with every row, under a new lineage',
        aGet.status === 200 && aBack && ids(aEnd.users) === 'u_a,u_b' && aEnd.games.length === 0 && objs(fa) === 'g_a,g_b' && /^[0-9a-f-]{36}$/.test(aLineage ?? ''),
        JSON.stringify({ get: aGet.status, aBack, users: ids(aEnd.users), games: objs(fa), aLineage }));
      // (b) deleted; fresh instance Y boots on "no object" and a sign-up there (taking u_b's free-there
      // username) creates it; then X re-checks. The established account keeps its name; Y's is renamed.
      const fb = await trackFake(startFakeGcsDb({ port: s28Gcs, initialContent: seed }));
      const b = await bootX(fb, 'b');
      fb.setStored(null);
      const Y = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s28y-'))), yApp, s28Gcs, mail)), yApp);
      const reg = await call(yApp, '/api/auth/register', { username: 'b', email: 'new@example.test', password: 'Sup3rSecret!23' });
      await waitUntil(() => fb.getStored() !== null, 3000);
      const mid = onGcs(fb), yLineage = fb.getCustom()?.lineage;
      record('fixture: GCS held only Y\'s sign-up under a minted lineage, and X had answered nothing since the delete',
        reg.status === 200 && mid.users.length === 1 && mid.users[0].username === 'b' && mid.users[0].email === 'new@example.test' && mid.games.length === 0 && /^[0-9a-f-]{36}$/.test(yLineage ?? ''),
        JSON.stringify({ reg: reg.status, users: mid.users.map((u) => u.username), games: mid.games.length, yLineage }));
      const bGet = await req(xApp, 'GET', '/api/games', b.tok);
      const bGames = bGet.status === 200 ? (await bGet.json()).map((x) => x.id) : [];
      const bBack = await waitUntil(() => ids(onGcs(fb).users).split(',').length === 3 && objs(fb) === 'g_a,g_b', 4000);
      const bEnd = onGcs(fb);
      record('THE DEFECT (db.json deleted, b): X keeps serving its rows and writes them back without a route write; its accounts keep their names, Y\'s sign-up stands renamed',
        bGet.status === 200 && bGames.join(',') === 'g_a' && bBack && fb.getCustom()?.lineage === yLineage
          && bEnd.users.find((u) => u.id === 'u_a')?.username === 'a' && bEnd.users.find((u) => u.id === 'u_b')?.username === 'b'
          && /^b-.{6}$/.test(bEnd.users.find((u) => u.email === 'new@example.test')?.username ?? ''),
        JSON.stringify({ get: bGet.status, bGames, users: bEnd.users.map((u) => u.username), games: objs(fb), lineage: fb.getCustom()?.lineage === yLineage }));
      // (c) the histories have converged: a delete on Y is a real deletion X must honor, not a row to restore.
      await new Promise((r) => setTimeout(r, 2200)); // past Y's window: its login re-reads the merged store
      const yTok = await loginOn(yApp, 'a@example.test');
      const del = await req(yApp, 'DELETE', '/api/games/g_a', yTok);
      await waitUntil(() => !fb.allGames().some((x) => x.id === 'g_a'), 3000);
      await new Promise((r) => setTimeout(r, 2200));
      const cGet = await req(xApp, 'GET', '/api/games', b.tok);
      const cGames = cGet.status === 200 ? (await cGet.json()).map((x) => x.id) : [];
      const add = await req(xApp, 'POST', '/api/games', b.tok, { name: 'A-after', payoffs: pay });
      await waitUntil(() => fb.allGames().some((x) => x.name === 'A-after'), 3000);
      const cEnd = onGcs(fb);
      await stop(b.X.child); await stop(Y.child); await fb.close();
      record('THE DEFECT (same lineage, c): a delete on Y after the histories converged stays deleted on X and on GCS',
        del.status === 200 && cGet.status === 200 && cGames.length === 0 && add.status === 200 && !fb.allGames().some((x) => x.id === 'g_a')
          && fb.allGames().some((x) => x.id === 'g_b') && cEnd.users.length === 3 && cEnd.games.length === 0,
        JSON.stringify({ del: del.status, get: cGet.status, cGames, add: add.status, games: fb.allGames().map((x) => x.name), users: cEnd.users.length }));
    }

    // s29 — one username, one person (sweep 19 angle 4, S19-1). Uniqueness compared trim+lowercase, so
    // "José" in NFD, fullwidth "ａｌｉｃｅ", "alice"+U+200B or "a  lice" signed up a second account under a
    // taken name, a username login in that spelling reached the impostor, a zero-width-only name passed
    // "required" and a merge kept both. Cannot pass by coincidence: on the same server a Cyrillic
    // look-alike, an emoji ZWJ name and "bob" are accepted and the owner's plain name verifies.
    {
      const s29Gcs = gcsPortA + 56, zApp = port1 + 56; // s28's released ports
      const pw = 'Sup3rSecret!23';
      const seed = { users: [seededUser('u_al', 'alice', 'al@example.test', pw), seededUser('u_jo', 'José', 'jo@example.test', pw),
        seededUser('u_st', 'Straße', 'st@example.test', pw), seededUser('u_sp', 'a lice', 'sp@example.test', pw), seededUser('u_io', 'ΐ', 'io@example.test', pw),
        { ...seededUser('u_pd', 'pend', 'pd@example.test', pw), isVerified: false, verificationCode: '123456', verificationCodeExpires: Date.now() + 6e5 }], games: [] };
      const fz = await trackFake(startFakeGcsDb({ port: s29Gcs, initialContent: JSON.stringify(seed) }));
      const Z = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s29-'))), zApp, s29Gcs, { ...mail, TRUST_PROXY: 'true' })), zApp);
      let ip = 0; // register allows 8 a minute per client: each sign-up comes from its own
      const reg = async (username) => {
        const n = ++ip, email = `z${n}@example.test`;
        const r = await fetch(`http://127.0.0.1:${zApp}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.29.0.${n}` },
          body: JSON.stringify({ username, email, password: pw }) });
        return { status: r.status, error: (await r.json().catch(() => ({}))).error ?? '', email };
      };
      const each = async (names) => Object.fromEntries(await Promise.all(Object.entries(names).map(async ([k, v]) => [k, await reg(v)])));
      const plainCase = await reg('ALICE');
      const free = await each({ cyrillic: 'alicе', zwjFamily: '\u{1F468}‍\u{1F469}', bob: 'bob' });
      const taken = await each({ nfd: 'josé', fullwidth: 'ａｌｉｃｅ', zwsp: 'alice​', wordJoiner: 'al⁠ice',
        halfwidthFiller: 'ﾠalice', spaceThenZw: 'alice ​', sharpS: 'STRASSE', capitalSharpS: 'STRAẞE', greekTonos: 'Ϊ́',
        nbsp: 'a lice', doubleSpace: 'a  lice', tab: 'a\tlice' });
      const blank = await each({ zeroWidth: '​‍', hangulFiller: 'ㅤ', joinerSpaces: ' ⁠ ' });
      const loginAs = async (id) => { const r = await call(zApp, '/api/auth/login', { email: id, password: pw }); return `${r.status}:${(await r.json().catch(() => ({}))).user?.id ?? ''}`; };
      const logins = {};
      for (const [k, [id, owner]] of Object.entries({ nfd: ['José', 'u_jo'], fullwidth: ['ＡＬＩＣＥ', 'u_al'], zwsp: ['alice​', 'u_al'],
        sharpS: ['strasse', 'u_st'], doubleSpace: ['a  lice', 'u_sp'] })) logins[k] = [await loginAs(id), `200:${owner}`];
      const verify = (username) => call(zApp, '/api/auth/verify', { email: 'pd@example.test', code: '123456', password: 'N3wSecret!pass', username });
      const vTaken = await verify('ａｌｉｃｅ'), vTakenBody = await vTaken.json().catch(() => ({}));
      const vFree = await verify('pend two');
      // (merge) a peer adds "Dave" and fullwidth "Ｅｖｅ" right after Z's re-read; Z answers "ｄａｖｅ" and a
      // plain "eve" from its copy. Both directions: the kept name's key and the added name's key must fold.
      await new Promise((r) => setTimeout(r, 2200));
      await fetch(`http://127.0.0.1:${zApp}/api/games`); // Z re-reads now: for 2 s it answers from this copy
      const n0 = fz.count412(), cur = JSON.parse(fz.getStored());
      fz.peerWrite(JSON.stringify({ ...cur, users: [...cur.users, seededUser('u_dv', 'Dave', 'dv@example.test', pw), seededUser('u_ev', 'Ｅｖｅ', 'ev@example.test', pw)] }));
      // Sign-ups hash one at a time, so the second is answered ~40 ms after the first: hold the first's upload
      // (its 412 merges in "Ｅｖｅ") until both are answered, or "eve" is refused from the merged copy instead.
      fz.setUploadDelayMs(800);
      const [stale, staleEve] = await Promise.all([reg('ｄａｖｅ'), reg('eve')]);
      const onGcs = () => JSON.parse(fz.getStored()).users;
      await waitUntil(() => fz.count412() > n0 && [stale, staleEve].every((x) => onGcs().some((u) => u.email === x.email)), 5000);
      fz.setUploadDelayMs(0);
      const end = onGcs(), nameOf = (email) => end.find((u) => u.email === email)?.username;
      // (merge, reborn) a peer re-creates the store without Z's rows (new lineage) holding "Frank"; Z answers
      // "ｆｒａｎｋ" from its copy. Both are added (not in Z's baseline), so they meet INSIDE the rename loop.
      await new Promise((r) => setTimeout(r, 2200));
      await fetch(`http://127.0.0.1:${zApp}/api/games`);
      const n1 = fz.count412();
      fz.peerWrite(JSON.stringify({ users: [seededUser('u_fr', 'Frank', 'fr@example.test', pw)], games: [] }), { lineage: 'peer-reborn' });
      const staleFr = await reg('ｆｒａｎｋ');
      await waitUntil(() => fz.count412() > n1 && [staleFr.email, 'al@example.test'].every((e) => onGcs().some((u) => u.email === e)), 5000);
      const reborn = onGcs(), nameOf2 = (email) => reborn.find((u) => u.email === email)?.username;
      await stop(Z.child); await fz.close();
      const refused = (x, re) => x.status === 400 && re.test(x.error) && !end.some((u) => u.email === x.email);
      const brief = (m) => Object.fromEntries(Object.entries(m).map(([k, x]) => [k, `${x.status}:${x.error.slice(0, 22)}`]));
      record('fixture: plain-case "ALICE" is taken; a Cyrillic look-alike, an emoji ZWJ name and "bob" sign up on the same server; the owner verifies as "pend two"; the stale sign-up was accepted and its upload 412\'d',
        refused(plainCase, /already taken/) && Object.values(free).every((x) => x.status === 200 && end.some((u) => u.email === x.email)) && vFree.status === 200
          && end.find((u) => u.id === 'u_pd')?.username === 'pend two' && stale.status === 200 && staleEve.status === 200 && fz.count412() > n0,
        JSON.stringify({ plainCase: `${plainCase.status}`, free: brief(free), vFree: vFree.status, stale: stale.status, staleEve: staleEve.status, n412: fz.count412() - n0 }));
      record('THE DEFECT (register): every confusable spelling of a taken name (NFD, fullwidth, ignorables, case folds, whitespace) is refused as taken, and none reached GCS',
        Object.values(taken).every((x) => refused(x, /already taken/)), JSON.stringify(brief(taken)));
      record('THE DEFECT (blank): a name of only invisible code points is refused as missing',
        Object.values(blank).every((x) => refused(x, /Username is required/)), JSON.stringify(brief(blank)));
      record('THE DEFECT (login): a username login in a confusable spelling signs in that name\'s one owner',
        Object.values(logins).every(([got, want]) => got === want), JSON.stringify(logins));
      record('THE DEFECT (verify): a pending account cannot take a confusable of a taken name',
        vTaken.status === 400 && /already taken/.test(vTakenBody.error ?? ''), `${vTaken.status} ${vTakenBody.error ?? ''}`);
      record('THE DEFECT (merge): a stale sign-up of a confusable of a peer\'s new name is renamed when the merge lands; the peer\'s "Dave" and "Ｅｖｅ" keep theirs',
        nameOf('dv@example.test') === 'Dave' && /^ｄａｖｅ-.{6}$/.test(nameOf(stale.email) ?? '')
          && nameOf('ev@example.test') === 'Ｅｖｅ' && /^eve-.{6}$/.test(nameOf(staleEve.email) ?? ''),
        JSON.stringify({ dave: nameOf('dv@example.test'), stale: nameOf(stale.email), eve: nameOf('ev@example.test'), staleEve: nameOf(staleEve.email) }));
      record('THE DEFECT (merge, reborn store): two ADDED accounts one key apart fold to one name per key: the peer\'s "Frank" keeps it, Z\'s stale "ｆｒａｎｋ" (accepted, upload 412\'d) is renamed, Z\'s rows are written back',
        staleFr.status === 200 && fz.count412() > n1 && fz.getCustom()?.lineage === 'peer-reborn' && nameOf2('fr@example.test') === 'Frank'
          && /^ｆｒａｎｋ-.{6}$/.test(nameOf2(staleFr.email) ?? '') && nameOf2('al@example.test') === 'alice',
        JSON.stringify({ reg: staleFr.status, n412: fz.count412() - n1, lineage: fz.getCustom()?.lineage, frank: nameOf2('fr@example.test'), stale: nameOf2(staleFr.email), alice: nameOf2('al@example.test') }));
    }

    // s30 — hostile bodies and framings (sweep 19 angles 1+2; both EMPTY, pinned here). Angle 2 pins Node's
    // parser: each ambiguous frame hides a POST /api/games after it; want one 400, the socket closed by the
    // server, and no "smuggled-*" game. Angle 1 pins express.json: the limit applies to the INFLATED body.
    // Cannot pass by coincidence: a clean pipeline creates its hidden game and a small gzip login signs in.
    {
      const s30Gcs = gcsPortA + 56, bApp = port1 + 56; // s29's released ports
      const pw = 'Sup3rSecret!23';
      const fb = await trackFake(startFakeGcsDb({ port: s30Gcs, initialContent: JSON.stringify({ users: [seededUser('u_bb', 'bomb', 'bb@example.test', pw)], games: [] }) }));
      const B = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s30-'))), bApp, s30Gcs,
        { ...mail, TRUST_PROXY: 'true', NODE_OPTIONS: '--max-old-space-size=128' })), bApp); // mail: a failed send is an honest 500
      const tok = (await (await call(bApp, '/api/auth/login', { email: 'bb@example.test', password: pw })).json()).token;
      const wire = (payload) => new Promise((res) => { // closed = the SERVER hung up within 3 s (we never end first)
        const sock = net.connect(bApp, '127.0.0.1'); let d = '';
        const t = setTimeout(() => { res({ d, closed: false }); sock.destroy(); }, 3000);
        sock.on('data', (c) => { d += c; if ((d.match(/HTTP\/1\.1 \d{3}/g) || []).length === 2) { clearTimeout(t); res({ d, closed: false }); sock.destroy(); } });
        sock.on('error', () => {}); sock.on('close', () => { clearTimeout(t); res({ d, closed: true }); });
        sock.write(payload);
      });
      const game = (k) => JSON.stringify({ name: `smuggled-${k}`, payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 } });
      const hiddenFor = (k) => `POST /api/games HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tok}\r\nContent-Type: application/json\r\nContent-Length: ${game(k).length}\r\n\r\n${game(k)}`;
      const body = '{"email":"bb@example.test","password":"wrong"}';
      const H = (extra, b) => `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n${extra}\r\n${b}`;
      const chunked = (hidden) => `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n${hidden}`;
      const framings = {
        dupCL: (h) => H(`Content-Length: ${body.length}\r\nContent-Length: ${body.length + h.length}\r\n`, body + h),
        clTe: (h) => H('Content-Length: 4\r\nTransfer-Encoding: chunked\r\n', chunked(h)),
        teCl: (h) => H('Transfer-Encoding: chunked\r\nContent-Length: 200\r\n', chunked(h)),
        teObf: (h) => H(`Transfer-Encoding: xchunked\r\nContent-Length: ${body.length}\r\n`, body + h),
        teTab: (h) => H(`Transfer-Encoding:\tchunked\r\nContent-Length: ${body.length}\r\n`, body + h),
        teDouble: (h) => H('Transfer-Encoding: chunked\r\nTransfer-Encoding: identity\r\n', chunked(h)),
        teChunkedNotLast: (h) => H('Transfer-Encoding: chunked, identity\r\n', chunked(h)),
        obsFold: (h) => H(`Content-Length: ${body.length}\r\nX-A: a\r\n Transfer-Encoding: chunked\r\n`, body + h),
        spaceBeforeColon: (h) => H(`Content-Length : ${body.length + h.length}\r\n`, body + h),
        bareLF: (h) => `POST /api/auth/login HTTP/1.1\nHost: x\nContent-Type: application/json\nContent-Length: ${body.length}\n\n${body}${h}`,
        chunkExtLF: (h) => H('Transfer-Encoding: chunked\r\n', `${body.length.toString(16)};x\n\r\n${body}\r\n0\r\n\r\n${h}`),
        negCL: (h) => H('Content-Length: -1\r\n', body + h),
        plusCL: (h) => H(`Content-Length: +${body.length}\r\n`, body + h),
        hexChunkOverflow: (h) => H('Transfer-Encoding: chunked\r\n', `ffffffffffffffffff1a\r\n${body}\r\n0\r\n\r\n${h}`),
        http10TE: (h) => `POST /api/auth/login HTTP/1.0\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nContent-Length: ${body.length}\r\n\r\n${body}${h}`,
        nulInHeader: (h) => H(`Content-Length: ${body.length}\r\nX-A: a\u0000b\r\n`, body + h),
        crInValue: (h) => H(`Content-Length: ${body.length}\r\nX-A: a\rTransfer-Encoding: chunked\r\n`, body + h),
      };
      const control = await wire(H(`Content-Length: ${body.length}\r\n`, body) + hiddenFor('control'));
      const framed = Object.fromEntries(await Promise.all(Object.entries(framings).map(async ([k, f]) => [k, await wire(f(hiddenFor(k)))])));
      // Angle 1: every body route, each bomb from its own client (no rate limit couples the cases).
      let ip = 0;
      const post = (route, buf, headers = {}, method = 'POST') => new Promise((res) => {
        const r = http.request({ host: '127.0.0.1', port: bApp, path: route, method, headers: { 'content-type': 'application/json', 'content-length': buf.length,
          authorization: `Bearer ${tok}`, 'x-forwarded-for': `10.30.${++ip >> 8}.${ip & 255}`, ...headers } }, (x) => { x.resume(); x.on('end', () => res(x.statusCode)); });
        r.on('error', (e) => res(`ERR ${e.code}`)); r.setTimeout(20000, () => { r.destroy(); res('TIMEOUT'); }); r.end(buf);
      });
      const spaces = Buffer.alloc(50 * 1024 * 1024, 0x20), bigJson = Buffer.concat([Buffer.from('{"email":"'), Buffer.alloc(20 * 1024 * 1024, 0x61), Buffer.from('"}')]);
      const gz = { 'content-encoding': 'gzip' };
      const routes = ['/api/auth/login', '/api/games', '/api/report', '/api/feedback', '/api/scenario/regenerate', '/api/auth/register', '/api/auth/verify',
        '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/delete-request', '/api/auth/delete-confirm', '/api/games/adopt-local'];
      const bombs = {
        tooLarge: { gzipSpaces: [zlib.gzipSync(spaces), gz], deflateSpaces: [zlib.deflateSync(spaces), { 'content-encoding': 'deflate' }],
          gzipString: [zlib.gzipSync(bigJson), gz], gzipTruncated: [zlib.gzipSync(bigJson).subarray(0, 4000), gz],
          deepObj: [Buffer.from('{"a":'.repeat(20000) + '1' + '}'.repeat(20000)), {}] },
        unsupported: { brotli: [zlib.brotliCompressSync(bigJson), { 'content-encoding': 'br' }], stacked: [zlib.gzipSync(zlib.gzipSync(bigJson)), { 'content-encoding': 'gzip, gzip' }],
          latin1: [Buffer.from('{"email":"\xe9"}', 'latin1'), { 'content-type': 'application/json; charset=iso-8859-1' }],
          bogusCharset: [Buffer.from('{"email":"a"}'), { 'content-type': 'application/json; charset=x-bogus' }] },
        other: { gzipGarbage: [Buffer.from('not gzip at all'), gz], deep: [Buffer.from('['.repeat(50000) + ']'.repeat(50000)), {}],
          wide: [Buffer.from('{' + Array.from({ length: 9000 }, (_, i) => `"k${i}":1`).join(',') + '}'), {}],
          protoKey: [Buffer.from('{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}},"email":"bb@example.test","password":"x"}'), {}],
          utf16: [Buffer.from('﻿{"email":"a"}', 'utf16le'), { 'content-type': 'application/json; charset=utf-16' }],
          identityUpper: [Buffer.from('{"email":"x","password":"y"}'), { 'content-encoding': 'IDENTITY' }],
          loneSurrogate: [Buffer.from('{"email":"\\ud800","password":"\\udfff"}'), {}], hugeNumber: [Buffer.from('{"payoffs":{"a11":1' + '0'.repeat(90000) + '}}'), {}] },
      };
      const got = {};
      for (const [cls, set] of Object.entries(bombs)) for (const [k, [buf, h]] of Object.entries(set)) for (const r of routes) got[`${cls} ${k} ${r}`] = await post(r, buf, h);
      for (const [k, [buf, h]] of Object.entries({ ...bombs.tooLarge, deep: bombs.other.deep })) for (const m of ['PATCH', 'DELETE']) got[`${k === 'deep' ? 'other' : 'tooLarge'} ${k} ${m}`] = await post('/api/games/g_x', buf, h, m);
      const smallGzip = await post('/api/auth/login', zlib.gzipSync(JSON.stringify({ email: 'bb@example.test', password: pw })), gz);
      const games = (await (await fetch(`http://127.0.0.1:${bApp}/api/games`, { headers: { authorization: `Bearer ${tok}` } })).json()).map((g) => g.name);
      const health = await fetch(`http://127.0.0.1:${bApp}/api/health`).then((r) => r.json()).catch(() => ({}));
      const alive = B.child.exitCode === null && health.pid === B.child.pid, unhandled = /Unhandled error/.test(B.log());
      await stop(B.child); await fb.close();
      const statuses = (d) => (d.match(/HTTP\/1\.[01] \d{3}/g) || []).join(' | ');
      const bad = (cls, ok) => Object.entries(got).filter(([k, v]) => k.startsWith(cls) && !ok(v)).map(([k, v]) => `${k}=${v}`);
      record('fixture: a clean keep-alive pipeline answers both requests and its hidden POST creates "smuggled-control"; a small gzip login signs in',
        statuses(control.d) === 'HTTP/1.1 401 | HTTP/1.1 200' && games.includes('smuggled-control') && smallGzip === 200,
        JSON.stringify({ control: statuses(control.d), smallGzip, games }));
      const unframed = Object.entries(framed).filter(([, x]) => statuses(x.d) !== 'HTTP/1.1 400' || !x.closed).map(([k, x]) => `${k}=${statuses(x.d) || '(none)'}${x.closed ? '' : ' open'}`);
      record('GUARD (smuggling): each of 17 ambiguous framings gets exactly one 400, the server closes the socket, and no hidden request reached /api/games',
        Object.keys(framed).length === 17 && unframed.length === 0 && !games.some((g) => g !== 'smuggled-control'),
        JSON.stringify({ unframed, games }));
      record('GUARD (body size): a body over the limit AFTER inflation (gzip/deflate/truncated gzip) or raw is 413 on every body route',
        bad('tooLarge', (v) => v === 413).length === 0, JSON.stringify(bad('tooLarge', (v) => v === 413).slice(0, 6)));
      record('GUARD (encoding): brotli, stacked gzip and a non-UTF charset are 415 on every body route',
        bad('unsupported', (v) => v === 415).length === 0, JSON.stringify(bad('unsupported', (v) => v === 415).slice(0, 6)));
      // 2xx only where the body is ignored (delete-request: the token is the request) or well-formed (protoKey names a real email).
      const answered = Object.entries(got).filter(([k, v]) => !(typeof v === 'number' && v < 500
        && (v >= 400 || / \/api\/auth\/delete-request$|^other protoKey \/api\/auth\/forgot-password$/.test(k)))).map(([k, v]) => `${k}=${v}`);
      record('GUARD (no 5xx): every hostile body is a 4xx (2xx only where the body is ignored or well-formed), none is logged as an unhandled error, and the process survives a 128 MB heap',
        answered.length === 0 && Object.keys(got).length === 216 && !unhandled && alive, JSON.stringify({ bad: answered.slice(0, 12), unhandled, alive, n: Object.keys(got).length }));
    }
    // s31 — SYBIL FILL (cloud loop 22, TASK-13; unit: src/sybilfill.cloud.test.ts). Four accounts fill
    // their per-account cap with the widest games the API accepts. Before, every account's games shared
    // db.json's one budget, and a handful of accounts turned EVERY user's save into a 507. Now each full
    // account is refused (413, the cap named) and nobody else is: another account saves and lists, db.json
    // (accounts only) holds no game and a sign-up still passes. Cannot pass by coincidence: the sybils'
    // stored bytes exceed the db.json budget this server runs with, so a shared budget would refuse.
    {
      const s31Gcs = gcsPortA + 58, s31App = port1 + 60;
      const CAP = 64 * 1024, BUDGET = 128 * 1024;
      const sybils = [1, 2, 3, 4].map((i) => seededUser(`u_syb${i}`, `sybil${i}`, `syb${i}@example.test`, 'Sup3rSecret!23'));
      const fake = await trackFake(startFakeGcsDb({ port: s31Gcs, initialContent: JSON.stringify({ users: [...sybils, seededUser('u_vic', 'victim', 'vic@example.test', 'Sup3rSecret!23')], games: [] }) }));
      const S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s31-'))), s31App, s31Gcs,
        { ...mail, TRUST_PROXY: '1', ACCOUNT_GAMES_MAX_BYTES: String(CAP), DB_MAX_BYTES: String(BUDGET) })), s31App);
      let hop = 0; // a fresh /48 per request: no rate limit is in play
      const call = async (method, route, token, body) => {
        const r = await fetch(`http://127.0.0.1:${s31App}${route}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': `2001:db8:${(0x3100 + hop++).toString(16)}::1`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      const tokOf = async (email) => (await call('POST', '/api/auth/login', null, { email, password: 'Sup3rSecret!23' })).body.token;
      const widest = (k) => ({ name: `${k}${'界'.repeat(78)}`, description: '界'.repeat(800), payoffs: { a11: 1e21, a12: -1e21, a21: 0.1234567890123, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 },
        row1Label: '界'.repeat(40), row2Label: '乙'.repeat(40), col1Label: '丙'.repeat(40), col2Label: '丁'.repeat(40),
        colorTermsA: Array.from({ length: 12 }, (_, i) => `${String.fromCharCode(65 + i)}${'甲'.repeat(59)}`), colorTermsB: Array.from({ length: 12 }, (_, i) => `${String.fromCharCode(65 + i)}${'乙'.repeat(59)}`),
        clientRequestId: `c-${k}-${'x'.repeat(80)}` });
      const refusals = [];
      await Promise.all(sybils.map(async (u) => {
        const t = await tokOf(u.email);
        for (let k = 0; k < 60; k++) { const r = await call('POST', '/api/games', t, widest(`${u.id}-${k}`)); if (r.status !== 200) { refusals.push({ id: u.id, saved: k, ...r }); return; } }
        refusals.push({ id: u.id, saved: 60, status: 'never refused' });
      }));
      const sizes = sybils.map((u) => Buffer.byteLength(fake.getStored(`games/${u.id}.json`) ?? ''));
      const rowBytes = Buffer.byteLength(JSON.stringify(fake.games('u_syb1')[0] ?? {}));
      const tVic = await tokOf('vic@example.test');
      const vic = [];
      for (let k = 0; k < 3; k++) vic.push((await call('POST', '/api/games', tVic, widest(`vic-${k}`))).status);
      const vicList = (await call('GET', '/api/games', tVic)).body;
      const m0 = mailed.length;
      const signUp = await call('POST', '/api/auth/register', null, { username: 'after-flood', email: 'after-flood@example.test', password: 'Sup3rSecret!23' });
      const root = JSON.parse(fake.getStored());
      await stop(S.child); await fake.close();
      record('fixture: each sybil was refused only once its object was within one widest row of the cap, and together they store more than db.json\'s whole budget',
        refusals.length === 4 && sizes.every((s) => s <= CAP && s > CAP - rowBytes - 1) && sizes.reduce((a, b) => a + b, 0) > BUDGET,
        JSON.stringify({ sizes, CAP, BUDGET, widestRowBytes: rowBytes, at200Games: rowBytes * 200, refusedAfter: refusals.map((r) => r.saved) }));
      record('THE DEFECT (sybil fill): every full account is 413 naming its cap; another account still saves and lists; db.json holds no game and a sign-up passes',
        refusals.every((r) => r.status === 413 && r.body.error === 'Saved games for this account exceeded the 64 KB limit. Delete a saved game to make room, then save again.')
          && JSON.stringify(vic) === '[200,200,200]' && Array.isArray(vicList) && vicList.length === 3
          && root.games.length === 0 && signUp.status === 200 && mailed.length - m0 === 1,
        JSON.stringify({ refusals: refusals.map((r) => `${r.id}:${r.status}`), vic, vicListed: vicList?.length, rootGames: root.games.length, signUp: signUp.status }));
    }

    // s32 — MIGRATION of db.json's legacy games, against the real server (unit: src/gcsmigration.cloud.test.ts).
    // db.json holds games for three accounts (one already over the cap) plus an unowned row, and an earlier
    // run was interrupted: one account's object already holds part of its rows, one of them edited since.
    // (a) GCS refuses one account's object writes at boot: the migration fails, the DB routes answer 503
    //     (the store stays unread) and db.json is untouched — no legacy row is cleared before it is safe.
    // (b) GCS recovers: the next request migrates; every legacy row is in its owner's object, byte-identical
    //     (the object's edited copy stands), db.json holds none, and each account lists exactly its games.
    // (c) RESUME: a restart against the un-cleared db.json (a crash before the clearing write) writes no
    //     game object and clears it again; a previous revision still writing a legacy row into db.json
    //     mid-run (a rollover) has it moved into its account's object on the next re-check.
    {
      const s32Gcs = gcsPortA + 60, s32App = port1 + 62;
      const pay = { a11: 1e21, a12: 0, a21: 0.1, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
      const row = (id, userId, extra = {}) => ({ id, ...(userId === undefined ? {} : { userId }), name: `n-${id}`, description: '界 "q" \\ é 😀', payoffs: pay, createdAt: '2026-01-01T00:00:00Z', ...extra });
      const users = ['u_m1', 'u_m2', 'u_m3'].map((id) => seededUser(id, id, `${id}@example.test`, 'Sup3rSecret!23'));
      const legacy = [row('g_m1a', 'u_m1'), row('g_m1b', 'u_m1'), row('g_m1c', 'u_m1', { colorTermsA: ['界界'] }),
        row('g_m2a', 'u_m2'), row('g_m2b', 'u_m2'),
        ...Array.from({ length: 40 }, (_, i) => row(`g_m3_${i}`, 'u_m3', { description: 'x'.repeat(400) })),
        row('g_orphan', undefined)];
      const original = JSON.stringify({ users, games: legacy });
      const edited = row('g_m1b', 'u_m1', { name: 'edited after the earlier run' });
      const fake = await trackFake(startFakeGcsDb({ port: s32Gcs, initialContent: original,
        initialObjects: { 'games/u_m1.json': JSON.stringify({ userId: 'u_m1', games: [row('g_m1a', 'u_m1'), edited] }) } }));
      const env = { ...mail, GCS_DEADLINE_MS: '1500', ACCOUNT_GAMES_MAX_BYTES: String(16 * 1024) };
      fake.failUploadsFor(['games/u_m2.json']);
      let S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s32-'))), s32App, s32Gcs, env)), s32App);
      const login = (email) => fetch(`http://127.0.0.1:${s32App}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Sup3rSecret!23' }) });
      const refused = await login('u_m1@example.test');
      const untouched = fake.getStored() === original && fake.uploadCount(OBJECT) === 0;
      fake.failUploadsFor([]);
      const back = await login('u_m1@example.test');
      const cleared = await waitUntil(() => JSON.parse(fake.getStored()).games.length === 0, 8000);
      const stored = new Map(fake.allGames().map((g) => [g.id, JSON.stringify(g)]));
      stored.set('g_orphan', (() => { try { return JSON.stringify(JSON.parse(fake.getStored('games/.json')).games.find((g) => g.id === 'g_orphan')); } catch { return undefined; } })());
      const mismatched = legacy.filter((g) => stored.get(g.id) !== JSON.stringify(g.id === 'g_m1b' ? edited : g)).map((g) => g.id);
      const lists = {};
      for (const id of ['u_m1', 'u_m2', 'u_m3']) {
        const t = (await (await login(`${id}@example.test`)).json()).token;
        lists[id] = (await (await fetch(`http://127.0.0.1:${s32App}/api/games`, { headers: { authorization: `Bearer ${t}` } })).json()).map((g) => g.id).sort();
      }
      await stop(S.child);
      // (c) the clearing write "never happened": db.json carries every legacy row again, as if the process died before it.
      fake.setStored(original);
      const gameUploads = () => fake.uploadLog().filter((u) => u.name.startsWith('games/')).length;
      const g0 = gameUploads();
      S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s32b-'))), s32App, s32Gcs, env)), s32App);
      const reCleared = await waitUntil(() => JSON.parse(fake.getStored()).games.length === 0, 8000);
      const rewritten = gameUploads() - g0;
      const t2 = (await (await login('u_m2@example.test')).json()).token;
      await new Promise((r) => setTimeout(r, 2200));
      const peerRoot = JSON.parse(fake.getStored());
      peerRoot.games.push(row('g_m2_rollover', 'u_m2'));
      fake.peerWrite(JSON.stringify(peerRoot));
      const after = (await (await fetch(`http://127.0.0.1:${s32App}/api/games`, { headers: { authorization: `Bearer ${t2}` } })).json()).map((g) => g.id);
      const movedOut = await waitUntil(() => JSON.parse(fake.getStored()).games.length === 0 && fake.games('u_m2').some((g) => g.id === 'g_m2_rollover'), 8000);
      await stop(S.child); await fake.close();
      record('THE DEFECT (migration fails safe): with one account\'s object writes refused at boot, a DB route is 503 + Retry-After and db.json keeps every legacy row, byte for byte',
        refused.status === 503 && refused.headers.get('retry-after') === '30' && untouched, JSON.stringify({ refused: refused.status, untouched }));
      record('THE DEFECT (lossless): once GCS recovers every legacy row is in its owner\'s object byte-identical (the edited copy stands, the unowned row kept, the over-cap account whole) and db.json holds none',
        back.status === 200 && cleared && mismatched.length === 0 && fake.games('u_m3').length === 40 && Buffer.byteLength(fake.getStored('games/u_m3.json') ?? '') > 16 * 1024,
        JSON.stringify({ back: back.status, cleared, mismatched, m3: fake.games('u_m3').length }));
      record('each account lists exactly its own migrated games',
        JSON.stringify(lists.u_m1) === '["g_m1a","g_m1b","g_m1c"]' && JSON.stringify(lists.u_m2) === '["g_m2a","g_m2b"]' && lists.u_m3.length === 40,
        JSON.stringify({ m1: lists.u_m1, m2: lists.u_m2, m3: lists.u_m3?.length }));
      record('THE DEFECT (resume): a restart against the un-cleared db.json writes no game object and clears it again',
        reCleared && rewritten === 0, JSON.stringify({ reCleared, rewritten }));
      record('THE DEFECT (rollover): a legacy row a previous revision writes mid-run moves into its account\'s object on the next re-check and leaves db.json',
        movedOut && after.includes('g_m2_rollover'), JSON.stringify({ movedOut, after }));
    }
    // s33 — DELETIONS THAT DID NOT FINISH HERE (Sweep 18, finding 2 and finding 1's rollover half).
    // (a) A live account whose object is already a tombstone: its deletion was confirmed (delete-confirm
    //     tombstones before it removes the rows) but never finished — a tombstone write that answered past
    //     its deadline yet landed, or a db.json write lost to a scale-in. Its next games request finishes
    //     it: 401 "This account has been deleted.", the row leaves db.json, the password no longer signs in.
    // (b) A previous revision deletes an account during a rollover: it removes the row from db.json but
    //     knows nothing of objects. This instance's next re-check sees the account gone and tombstones its
    //     object, so its games do not outlive it.
    {
      const s33Gcs = gcsPortA + 62, s33App = port1 + 64;
      const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
      const users = [seededUser('u_half', 'half', 'half@example.test', 'Sup3rSecret!23'), seededUser('u_prev', 'prev', 'prev@example.test', 'Sup3rSecret!23'),
        seededUser('u_stay', 'stay', 'stay@example.test', 'Sup3rSecret!23')];
      const fake = await trackFake(startFakeGcsDb({ port: s33Gcs, initialContent: JSON.stringify({ users, games: [] }), initialObjects: {
        'games/u_half.json': JSON.stringify({ userId: 'u_half', games: [], deleted: true }),
        'games/u_prev.json': JSON.stringify({ userId: 'u_prev', games: [{ id: 'g_prev', userId: 'u_prev', name: 'Prev', payoffs: pay, createdAt: '2026-01-01T00:00:00Z' }] }),
      } }));
      const S = await waitReady(track(spawnServer(trackDir(mkdtempSync(path.join(tmpdir(), 'nash-gcs-s33-'))), s33App, s33Gcs, mail)), s33App);
      const url = (p) => `http://127.0.0.1:${s33App}${p}`;
      const login = (email) => fetch(url('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Sup3rSecret!23' }) });
      const tHalf = (await (await login('half@example.test')).json()).token;
      const listHalf = await fetch(url('/api/games'), { headers: { authorization: `Bearer ${tHalf}` } });
      const listHalfBody = await listHalf.json().catch(() => ({}));
      const halfGone = await waitUntil(() => !JSON.parse(fake.getStored()).users.some((u) => u.id === 'u_half'), 5000);
      const halfAgain = (await login('half@example.test')).status;
      // (b) the previous revision's delete: u_prev leaves db.json; nothing touches its object.
      const tStay = (await (await login('stay@example.test')).json()).token;
      await waitUntil(() => JSON.parse(fake.getStored()).users.find((u) => u.id === 'u_stay')?.passwordHash.startsWith('pbkdf2$'), 5000); // our writes have landed
      await new Promise((r) => setTimeout(r, 2200));
      const root = JSON.parse(fake.getStored());
      fake.peerWrite(JSON.stringify({ ...root, users: root.users.filter((u) => u.id !== 'u_prev') }));
      const stayList = (await fetch(url('/api/games'), { headers: { authorization: `Bearer ${tStay}` } })).status; // a DB route: the re-check runs
      const prevTomb = await waitUntil(() => { try { return JSON.parse(fake.getStored('games/u_prev.json')).deleted === true; } catch { return false; } }, 5000);
      await stop(S.child); await fake.close();
      record('THE DEFECT (an unfinished deletion): a live account whose object is a tombstone has its deletion finished by its next games request (401, row gone, sign-in refused)',
        listHalf.status === 401 && listHalfBody.error === 'This account has been deleted.' && halfGone && halfAgain === 401,
        JSON.stringify({ list: listHalf.status, error: listHalfBody.error, halfGone, signIn: halfAgain }));
      record('THE DEFECT (deleted on a previous revision): an account removed from db.json elsewhere has its games object tombstoned here; other accounts are untouched',
        stayList === 200 && prevTomb && fake.games('u_prev').length === 0 && JSON.parse(fake.getStored()).users.some((u) => u.id === 'u_stay'),
        JSON.stringify({ stayList, prevTomb, prevObject: fake.getStored('games/u_prev.json') }));
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

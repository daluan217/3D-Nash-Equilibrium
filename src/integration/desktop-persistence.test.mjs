/* INTEGRATION — the desktop's two persistence guarantees, over HTTP against the
 * real production artifact, under the PACKAGED condition.
 *
 * Both defects this guards were found by RED-DESKTOP in the real packaged .app
 * and reproduced here by BLUE-SERVER before anything was changed.
 *
 *   1. SESSIONS MUST SURVIVE A RESTART. Every auth token is an HMAC under
 *      `AUTH_SECRET`. A packaged app ships no `.env` and `electron-main.cjs`
 *      sets no secret, so the per-process `crypto.randomBytes` fallback minted
 *      a new one on every launch and every token ever issued stopped verifying.
 *      Quit and relaunch signed the user out and hid their saved games — on
 *      every single launch — while the rows sat untouched in `db.json`.
 *
 *   2. AN UNREADABLE DATABASE MUST NOT BECOME A DELETED ONE. `db.json` was
 *      written with a truncating `fs.writeFileSync`, and on a parse failure the
 *      loader returned an empty database and let the next save write it over
 *      the file. A torn write therefore turned "unreadable" into "gone".
 *
 * WHY THE cwd MATTERS, and it is the whole reason this file exists separately:
 * the server is booted from a temp directory, never from the repo, because
 * `dotenv.config()` reads `.env` from the server's cwd. Run the same bundle
 * from the repo and it finds credentials a packaged build could never have,
 * and the measurement stops describing the shipped product. `env` is also
 * scrubbed of AUTH_SECRET/SESSION_SECRET/ADMIN_SECRET, since any of those would
 * satisfy the secret by the hosted path and make check 1 pass vacuously.
 *
 *   node src/integration/desktop-persistence.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
let port = Number(process.env.DESKTOP_PERSIST_PORT || 3104);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

/**
 * Boot the production bundle the way the packaged desktop app boots it.
 *
 * The env is built from scratch rather than spread over `process.env`: a dev
 * machine exports AUTH_SECRET often enough that inheriting it would make the
 * session check pass for the wrong reason.
 */
async function boot(userData, thePort) {
  const child = spawn('node', [BUNDLE], {
    cwd: userData, // NOT the repo: no .env, no credentials — the packaged condition
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT: String(thePort),
      IS_ELECTRON: 'true',
      ELECTRON_USER_DATA_PATH: userData,
      NASH_PAYOFF_TEMPLATE: '1',
      NASH_LLM_TIES: 'template',
      NASH_DIRECTION_CHECKS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) {
      // Fail loudly and immediately rather than spending the rest of the
      // 20s poll window timing out with a generic "never became ready" — a
      // dead child (e.g. IS_ELECTRON's EADDRINUSE retry moved it to a
      // different port) is a different failure than "still starting".
      throw new Error(`server exited before becoming ready on ${thePort} (code ${child.exitCode})\n${log}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${thePort}/api/health`);
      // Confirm we are talking to OUR child on OUR port, not another agent's
      // process left listening: a peer's process answering /api/health with
      // r.ok alone looks identical. /api/health echoes process.pid so the pid
      // check below can tell them apart.
      if (r.ok && (await r.json())?.pid === child.pid) return { child, log: () => log };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready on ${thePort}\n${log}`);
}

async function stop(srv) {
  if (!srv?.child || srv.child.exitCode !== null) return;
  const ended = new Promise((res) => srv.child.once('exit', res));
  srv.child.kill('SIGTERM');
  // Registering the exit listener BEFORE kill(), and awaiting it, is the
  // teardown shape CodeRabbit flagged on PR #46; a SIGKILL backstop keeps a
  // wedged child from hanging the suite.
  const timer = setTimeout(() => srv.child.kill('SIGKILL'), 4000);
  await ended;
  clearTimeout(timer);
}

async function call(thePort, method, url, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${thePort}${url}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

const userData = mkdtempSync(path.join(tmpdir(), 'nash-desktop-'));
const DB = path.join(userData, 'db.json');
let srv = null;

try {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. A SESSION SURVIVES QUIT AND RELAUNCH
  // ───────────────────────────────────────────────────────────────────────────
  srv = await boot(userData, port);

  const cred = { username: 'desktopuser', email: 'desktop@example.test', password: 'Sup3rSecret!23' };
  const reg = await call(port, 'POST', '/api/auth/register', { body: cred });
  record('a desktop account registers without SMTP (auto-verify)', reg.status === 200 && reg.json?.success === true,
    `status ${reg.status}`);

  const login = await call(port, 'POST', '/api/auth/login', { body: { email: cred.email, password: cred.password } });
  const token = login.json?.token;
  record('sign-in returns a token', typeof token === 'string' && token.length > 0, `status ${login.status}`);

  const save = await call(port, 'POST', '/api/games', {
    token,
    body: {
      name: 'Persisted Game', desc: 'A game saved before the app was quit.',
      payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 },
      row1Label: 'Stay', row2Label: 'Go', col1Label: 'Match', col2Label: 'Ignore',
    },
  });
  record('a signed-in desktop user can save a game', save.status === 200 || save.status === 201, `status ${save.status}`);

  // Quit the app.
  await stop(srv);
  srv = null;

  // Relaunch against the SAME user-data directory, on a fresh port (a relaunch
  // is a new process, which is exactly what regenerated the secret).
  port += 1;
  srv = await boot(userData, port);

  const me = await call(port, 'GET', '/api/auth/me', { token });
  record('THE DEFECT: the token minted before the restart still validates after it',
    me.status === 200, `status ${me.status} ${JSON.stringify(me.json)}`);

  const games = await call(port, 'GET', '/api/games', { token });
  // GET /api/games returns a BARE ARRAY of the user's games.
  const listed = Array.isArray(games.json) ? games.json : [];
  record('the saved game is still listed to that same session after a restart',
    games.status === 200 && listed.some((g) => g?.name === 'Persisted Game'),
    `status ${games.status}, ${listed.length} game(s)`);

  // The secret must be a real key on disk, not an empty file that happens to be
  // stable — an all-zero or empty secret would pass both checks above.
  const secretFile = path.join(userData, 'auth-secret');
  const secret = existsSync(secretFile) ? readFileSync(secretFile, 'utf-8').trim() : '';
  record('the persisted secret is a full 32-byte key', /^[0-9a-f]{64}$/.test(secret),
    secret ? `${secret.length} chars` : 'no auth-secret file');

  // A GARBAGE auth-secret FILE MUST BE REPLACED, NOT USED.
  //
  // This check exists because a mutation test found the hole: removing the
  // 64-hex validation from `desktopAuthSecret` left the suite at 13/13. Every
  // other check here writes the secret file itself, so none of them could ever
  // see a bad one. Without the validation, a truncated file becomes the HMAC
  // key for every session token on the machine — stable, so sessions survive,
  // which is exactly why the tests above stay green while the guarantee rots.
  await stop(srv);
  srv = null;
  writeFileSync(secretFile, 'deadbeef', 'utf-8'); // 8 chars: not a 32-byte key
  port += 1;
  srv = await boot(userData, port);
  const replaced = readFileSync(secretFile, 'utf-8').trim();
  record('a truncated auth-secret file is replaced with a real key, not used as one',
    /^[0-9a-f]{64}$/.test(replaced) && replaced !== 'deadbeef', `${replaced.length} chars`);

  // ───────────────────────────────────────────────────────────────────────────
  // 2. AN UNREADABLE DATABASE IS PRESERVED, NOT OVERWRITTEN
  // ───────────────────────────────────────────────────────────────────────────
  await stop(srv);
  srv = null;

  const wholeDb = readFileSync(DB, 'utf-8');
  const torn = wholeDb.slice(0, 220); // exactly RED-DESKTOP's repro: a truncated write
  writeFileSync(DB, torn, 'utf-8');

  port += 1;
  srv = await boot(userData, port);

  const asideNames = readdirSync(userData).filter((f) => f.startsWith('db.json.corrupt-'));
  record('THE DEFECT: an unparseable db.json is kept aside rather than left to be overwritten',
    asideNames.length === 1, `${asideNames.length} sidecar(s): ${asideNames.join(', ')}`);

  if (asideNames.length === 1) {
    const kept = readFileSync(path.join(userData, asideNames[0]), 'utf-8');
    record('the kept file holds the ORIGINAL bytes, not a rewritten empty database',
      kept === torn, `${kept.length} bytes, expected ${torn.length}`);
  } else {
    record('the kept file holds the ORIGINAL bytes, not a rewritten empty database', false, 'no sidecar to check');
  }

  // Now force a save. Before the fix this is the step that destroyed the data:
  // the empty in-memory DB was written straight over the unreadable file.
  const reg2 = await call(port, 'POST', '/api/auth/register', {
    body: { username: 'after', email: 'after@example.test', password: 'Sup3rSecret!23' },
  });
  record('the app still works after a corrupt database (registration succeeds)', reg2.status === 200, `status ${reg2.status}`);

  const stillThere = asideNames.length === 1 && existsSync(path.join(userData, asideNames[0]))
    && readFileSync(path.join(userData, asideNames[0]), 'utf-8') === torn;
  record('the preserved copy survives the next save', stillThere);

  // ───────────────────────────────────────────────────────────────────────────
  // 3. NO READER EVER SEES A PARTIAL db.json
  //
  // The atomicity property, driven the only way it can be observed from
  // outside: a second process reading the file while the server writes it.
  // `fs.writeFileSync` truncates then writes, so a reader that lands in that
  // window parses a short file. temp-file + rename closes the window.
  // ───────────────────────────────────────────────────────────────────────────
  const login2 = await call(port, 'POST', '/api/auth/login', {
    body: { email: 'after@example.test', password: 'Sup3rSecret!23' },
  });
  const token2 = login2.json?.token;
  const filler = 'x'.repeat(780);
  let torn_reads = 0, reads = 0, leftoverTmp = 0;
  let writing = true;

  const reader = (async () => {
    while (writing) {
      try {
        const raw = readFileSync(DB, 'utf-8');
        reads++;
        JSON.parse(raw);
      } catch (err) {
        if (err && err.code === 'ENOENT') torn_reads++;     // the file vanished mid-rename/truncate
        else if (err instanceof SyntaxError) torn_reads++;  // the file was short
      }
      if (readdirSync(userData).some((f) => f.includes('db.json.tmp-'))) leftoverTmp++;
      await new Promise((r) => setImmediate(r));
    }
  })();

  let writesOk = 0;
  for (let i = 0; i < 140; i++) {
    const r = await call(port, 'POST', '/api/games', {
      token: token2,
      body: {
        name: `Race ${i}`, desc: filler,
        payoffs: { a11: 1, a12: 2, a21: 3, a22: 4, b11: 4, b12: 3, b21: 2, b22: 1 },
      },
    });
    if (r.status === 200 || r.status === 201) writesOk++;
  }
  writing = false;
  await reader;

  // A failed write (auth, endpoint) never touches db.json, so a reader could
  // trivially see zero torn reads without the atomicity guarantee ever being
  // exercised. Require every write to have actually landed before trusting that.
  record('all 140 race writes succeeded (the race actually touched db.json)',
    writesOk === 140, `${writesOk}/140`);
  record('THE DEFECT: a concurrent reader never observes a partial db.json',
    torn_reads === 0, `${torn_reads} torn read(s) of ${reads}`);
  record('the reader saw enough of the file for that to mean something (control)',
    reads > 50, `${reads} successful parses`);

  const strays = readdirSync(userData).filter((f) => f.includes('db.json.tmp-'));
  record('no scratch file is left behind after the writes settle', strays.length === 0, strays.join(', '));
  if (leftoverTmp > 0) console.log(`  (note: the temp file was observed mid-write ${leftoverTmp} time(s) — that is the mechanism working)`);
} finally {
  await stop(srv);
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((f) => f.name).join(' | ')}`);
  process.exit(1);
}

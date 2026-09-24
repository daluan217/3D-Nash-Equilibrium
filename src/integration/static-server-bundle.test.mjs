/* INTEGRATION — the backend bundle must never be downloadable over HTTP.
 *
 * THE DEFECT (BLUE-LOOP-DESKTOP-22 / SR-48, found by this agent, reproduced
 * against the LIVE PUBLIC SITE before the fix):
 *   GET https://nash-equilibrium-simulator.com/server.cjs
 *     -> 200, 1,566,939 bytes, application/octet-stream
 *   and the body is the real bundle: desktopAuthSecret, acquireDesktopLock,
 *   19 distinct internal "/api/..." route literals.
 * `express.static(distPath)` publishes the directory that dist/server.cjs
 * lives in — server.ts says so itself ("server.cjs lives inside dist/, so
 * __dirname IS the dist folder"). No credential is exposed (esbuild runs with
 * --packages=external and every secret comes from env at runtime, verified by
 * scanning the downloaded bytes for sk-/AIza/PRIVATE KEY/assigned SMTP_PASS
 * etc. — all absent), so this is SOURCE DISCLOSURE, not a credential leak.
 *
 * It is the same door as RED-CLOUD-21/001, which removed dist/server.cjs.map
 * and left dist/server.cjs sitting beside it. Hence this guard covers BOTH
 * spellings: fixing one and leaving the other is exactly what happened before.
 *
 * WHY THIS CANNOT PASS BY COINCIDENCE: the CONTROLS below prove the static
 * mount is alive in the same run. If express.static were simply broken or the
 * dist directory missing, /favicon.ico and /assets/<hashed>.js would not
 * return their real bytes and the suite fails instead of reporting a clean
 * 404. The 404 is only meaningful next to a working 200.
 *
 *   node src/integration/static-server-bundle.test.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForOwnServer } from './ownserver.mjs';

const PORT = process.env.STATIC_BUNDLE_PORT || '3198';
const BASE = `http://127.0.0.1:${PORT}`;
const repo = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(repo, 'dist/server.cjs');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

if (!existsSync(BUNDLE)) {
  console.error(`missing ${BUNDLE} — run \`npm run build\` first.`);
  process.exit(1);
}

const userData = mkdtempSync(path.join(tmpdir(), 'nash-static-bundle-'));
// express.static follows symlinks, so an alias inside dist/ that points at the
// bundle is served under its own name unless the refusal resolves the REQUEST
// (reviewer finding on the hotfix). Plant one for this run only; removed below.
const ALIAS = path.join(repo, 'dist/backend-alias-test.cjs');
rmSync(ALIAS, { force: true });
symlinkSync('server.cjs', ALIAS);
const child = spawn(process.execPath, [BUNDLE], {
  cwd: tmpdir(),
  env: {
    PATH: process.env.PATH,
    HOME: userData,
    NODE_ENV: 'production',
    IS_ELECTRON: 'true',
    PORT,
    ELECTRON_USER_DATA_PATH: userData,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer(timeoutMs = 25000) {
  try { await waitForOwnServer(child, BASE, { timeoutMs }); return true; }
  catch (err) { console.error(err.message); return false; }
}

try {
  if (!await waitForServer()) throw new Error('the packaged server never came up');

  // ── EVERY SPELLING, not the obvious one. The first fix tested `req.path`
  //    against /^\/server\.cjs(\.map)?$/ and SIX of these walked past it while
  //    serve-static happily delivered 1,568,183 bytes — it percent-decodes,
  //    normalises `//` and `\`, and sits on a case-insensitive filesystem.
  //    Measured leaks before the identity-based fix: //server.cjs, /SERVER.CJS,
  //    /Server.cjs, /server%2Ecjs, /%73erver.cjs, /\server.cjs.
  const BUNDLE_SPELLINGS = [
    '/server.cjs', '/server.cjs.map', '/server.cjs?x=1', '/server.cjs/',
    '//server.cjs', '/./server.cjs', '/SERVER.CJS', '/Server.cjs',
    '/server%2Ecjs', '/%73erver.cjs', '/a/../server.cjs', '/assets/../server.cjs',
    '/server.cjs#x', '/\\server.cjs', '/SERVER.CJS.MAP',
  ];
  for (const route of BUNDLE_SPELLINGS) {
    const res = await fetch(`${BASE}${route}`);
    const body = await res.text();
    const isBundle = /desktopAuthSecret|acquireDesktopLock|writeFileAtomicSync/.test(body);
    record(`GET ${route} never returns the backend bundle`,
      !isBundle,
      `status=${res.status} bytes=${body.length}`);
  }

  // ── The canonical spellings must be an explicit 404, not merely "not the
  //    bundle" (a variant that lands on the SPA shell is acceptable for the
  //    odd shapes above, but these two must be refused outright).
  for (const route of ['/server.cjs', '/server.cjs.map']) {
    const res = await fetch(`${BASE}${route}`);
    const body = await res.text();
    const isBundle = /desktopAuthSecret|acquireDesktopLock|writeFileAtomicSync/.test(body);
    record(`GET ${route} does not return the backend bundle`,
      !isBundle,
      `status=${res.status} bytes=${body.length}`);
    record(`GET ${route} is refused outright (404), not merely different bytes`,
      res.status === 404,
      `status=${res.status}`);
  }

  // ── CONTROL 1: the static mount is genuinely serving, so the 404s above
  //    mean "refused" and not "nothing is mounted here at all".
  const favicon = await fetch(`${BASE}/favicon.ico`);
  const faviconBytes = Buffer.from(await favicon.arrayBuffer());
  const onDisk = readFileSync(path.join(repo, 'dist/favicon.ico'));
  record('CONTROL: express.static still serves dist/favicon.ico byte-for-byte',
    favicon.status === 200 && faviconBytes.equals(onDisk),
    `status=${favicon.status} bytes=${faviconBytes.length} vs ${onDisk.length}`);

  // ── CONTROL 2: a hashed asset — the files the app actually needs to run.
  //    Read from the directory, so this cannot rot when the hash changes.
  const assetsDir = path.join(repo, 'dist/assets');
  const jsAsset = readdirSync(assetsDir).find((f) => /^index-[^/]+\.js$/.test(f));
  record('CONTROL: a hashed renderer asset exists to test with', !!jsAsset, String(jsAsset));
  if (jsAsset) {
    const res = await fetch(`${BASE}/assets/${jsAsset}`);
    const text = await res.text();
    record('CONTROL: express.static still serves the hashed renderer bundle',
      res.status === 200 && text.length > 1000,
      `status=${res.status} bytes=${text.length}`);
  }

  // ── CONTROL 3: the SPA fallback still answers an unknown path with the app.
  const spa = await fetch(`${BASE}/library`);
  const spaText = await spa.text();
  record('CONTROL: an unknown app route still gets the SPA shell',
    spa.status === 200 && spaText.includes('<div id="root">'),
    `status=${spa.status} bytes=${spaText.length}`);

  // ── The refusal must not be a path-string coincidence: a route that merely
  //    CONTAINS the name is not the bundle and must behave normally (SPA).
  const lookalike = await fetch(`${BASE}/not-server.cjs-really`);
  record('a path that merely mentions server.cjs is not special-cased into a 404',
    lookalike.status === 200,
    `status=${lookalike.status}`);

  // ── A symlink alias to the bundle must be refused by what it RESOLVES to.
  //    Fails on a request-path-only check: static follows the link and serves
  //    the real bundle under the alias name.
  const alias = await fetch(`${BASE}/backend-alias-test.cjs`);
  const aliasBody = await alias.text();
  record('GET <symlink alias -> server.cjs> never returns the backend bundle',
    alias.status === 404 && !/desktopAuthSecret|acquireDesktopLock/.test(aliasBody),
    `status=${alias.status} bytes=${aliasBody.length}`);
} catch (err) {
  record('suite ran to completion', false, String(err && err.message));
} finally {
  child.kill('SIGKILL');
  rmSync(ALIAS, { force: true });
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

/* INTEGRATION — the desktop API must not be readable by every website.
 *
 * THE DEFECT (BLUE-LOOP-DESKTOP-22 / SR-57, found by this agent).
 * The CORS middleware set `Access-Control-Allow-Origin: *` on every non-admin
 * route whenever the allowlist was empty. On the HOSTED site that is harmless:
 * every private route needs a bearer token, and GET /api/games against
 * production really does answer 401 (verified live). The DESKTOP is the
 * opposite — it authenticates nothing, because `resolveGameOwner` hands any
 * caller the `local-owner` identity.
 *
 * So the same header, in the packaged app, means any page the user visits
 * while the app is running can do this:
 *   fetch('http://127.0.0.1:14321/api/games').then(r => r.json())
 * and read their entire saved-game library, or POST to add to it. No token to
 * steal, no prompt, nothing on screen.
 *
 * MEASURED before the fix, packaged condition, Origin: https://evil.example
 *   GET  /api/games -> 200, `Access-Control-Allow-Origin: *`, 521 bytes of games
 *   POST /api/games -> 200, game created, "userId":"local-owner"
 *
 * Loopback binding is NOT the boundary. It stops another MACHINE (verified:
 * the LAN address refuses) but not another ORIGIN inside the user's own
 * browser — which is precisely what CORS exists for, and `*` switches it off.
 *
 * THE FIX: under IS_ELECTRON the non-admin branch uses the same rule the admin
 * branch already used — echo the origin only when it is loopback or
 * allowlisted. The app's own renderer is a loopback origin, so it is unaffected.
 *
 * WHY THIS CANNOT PASS BY COINCIDENCE: two CONTROLS. The renderer's own origin
 * must still be echoed (otherwise "no ACAO" would also be the reading for a
 * middleware that broke outright, or for a server that is not running), and
 * the WEB condition must still answer `*` (otherwise a change that quietly
 * hardened the hosted API would look like a pass here while breaking the site).
 *
 *   node src/integration/desktop-cors-loopback.test.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(repo, 'dist/server.cjs');
const DESKTOP_PORT = process.env.DESKTOP_CORS_PORT || '3201';
const WEB_PORT = process.env.DESKTOP_CORS_WEB_PORT || '3202';
const HOSTILE = 'https://evil.example';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

if (!existsSync(BUNDLE)) {
  console.error(`missing ${BUNDLE} — run \`npm run build\` first.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(port, extraEnv) {
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-cors-lb-'));
  const child = spawn(process.execPath, [BUNDLE], {
    cwd: tmpdir(), // never the repo: dotenv would load this checkout's .env
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT: port,
      ELECTRON_USER_DATA_PATH: userData,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok && (await r.json())?.pid === child.pid) { up = true; break; }
    } catch { /* not yet */ }
    await sleep(250);
  }
  return { child, up, userData, log: () => log };
}

async function stop(srv) {
  if (!srv?.child || srv.child.exitCode !== null) return;
  const ended = new Promise((res) => srv.child.once('exit', res));
  srv.child.kill('SIGTERM');
  const timer = setTimeout(() => srv.child.kill('SIGKILL'), 4000);
  await ended;
  clearTimeout(timer);
  rmSync(srv.userData, { recursive: true, force: true });
}

const acao = (res) => res.headers.get('access-control-allow-origin');

let desktop = null;
let web = null;
try {
  desktop = await boot(DESKTOP_PORT, { IS_ELECTRON: 'true' });
  record('the desktop-condition server starts', desktop.up,
    desktop.up ? `pid ${desktop.child.pid}` : desktop.log().slice(-300));
  const base = `http://127.0.0.1:${DESKTOP_PORT}`;

  // Plant one game so "nothing was readable" cannot be true for the boring
  // reason that there was nothing to read.
  const created = await fetch(`${base}/api/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'cors-probe-game',
      payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 },
    }),
  });
  record('CONTROL: the desktop really does save a game with no token at all',
    created.status === 200,
    `status=${created.status} — the desktop authenticates nothing (local-owner), which is `
    + 'exactly why ACAO * in front of it matters');

  // ── THE DEFECT: a hostile origin must not be allowed to read the response.
  for (const route of ['/api/games', '/api/health', '/api/version']) {
    const res = await fetch(`${base}${route}`, { headers: { Origin: HOSTILE } });
    record(`a website cannot read ${route} from the desktop app cross-origin`,
      acao(res) !== '*' && acao(res) !== HOSTILE,
      `acao=${acao(res)} status=${res.status}`);
  }
  // …including the write side, which is the part that changes the user's data.
  const hostileWrite = await fetch(`${base}/api/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: HOSTILE },
    body: JSON.stringify({
      name: 'hostile-origin-write',
      payoffs: { a11: 9, a12: 0, a21: 0, a22: 9, b11: 9, b12: 0, b21: 0, b22: 9 },
    }),
  });
  record('a website cannot read the result of a cross-origin WRITE either',
    acao(hostileWrite) !== '*' && acao(hostileWrite) !== HOSTILE,
    `acao=${acao(hostileWrite)} status=${hostileWrite.status}`);

  const preflight = await fetch(`${base}/api/games`, {
    method: 'OPTIONS',
    headers: { Origin: HOSTILE, 'Access-Control-Request-Method': 'POST' },
  });
  record('the preflight does not hand a hostile origin permission either',
    acao(preflight) !== '*' && acao(preflight) !== HOSTILE,
    `acao=${acao(preflight)} status=${preflight.status}`);

  // ── CONTROL 1: the app's OWN renderer must keep working. Without this,
  //    "no ACAO" is also what a broken middleware and a dead server look like.
  for (const own of ['http://127.0.0.1:14321', 'http://localhost:14321']) {
    const res = await fetch(`${base}/api/games`, { headers: { Origin: own } });
    record(`CONTROL: the app's own loopback origin ${own} is still allowed`,
      acao(res) === own,
      `acao=${acao(res)}`);
  }
  // PATCH must survive the preflight: the client updates a saved game in place
  // (scenario keep, rename), and dropping it breaks those calls for the
  // Electron client only — a failure that reads as "couldn't reach the server".
  const ownPreflight = await fetch(`${base}/api/games`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:14321', 'Access-Control-Request-Method': 'PATCH' },
  });
  record('CONTROL: PATCH is still preflight-allowed for the app itself',
    (ownPreflight.headers.get('access-control-allow-methods') || '').includes('PATCH'),
    `allow-methods=${ownPreflight.headers.get('access-control-allow-methods')}`);

  // ── CONTROL 2: the WEB condition must be untouched. The hosted site is a
  //    public API whose private routes are token-gated (production answers 401
  //    for /api/games), so `*` is correct there and this fix must not reach it.
  web = await boot(WEB_PORT, {});
  record('CONTROL: the web-condition server starts', web.up,
    web.up ? `pid ${web.child.pid}` : web.log().slice(-300));
  const webRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`, {
    headers: { Origin: HOSTILE },
  });
  record('CONTROL: the hosted API still answers ACAO * to any origin',
    acao(webRes) === '*',
    `acao=${acao(webRes)} — if this fails the fix leaked into the web build and the public `
    + 'site lost its CORS headers');
} catch (err) {
  record('suite ran to completion', false, String(err && err.message));
} finally {
  await stop(desktop);
  await stop(web);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

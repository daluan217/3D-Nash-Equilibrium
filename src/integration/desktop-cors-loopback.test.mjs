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
import http from 'node:http';

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

  // ── SR-59: "a loopback origin" is TOO WIDE, and it was measured to be.
  //    The first fix used isLocalClientOrigin (any localhost/127.0.0.1 with
  //    any port), and every one of these was echoed back:
  //      http://127.0.0.1:5173  a Vite dev server
  //      http://localhost:8080  any other local app the user runs
  //      https://localhost:443
  //    A page served by ANY of them is a different origin in the same browser,
  //    which is the whole threat model here. The app's own renderer needs none
  //    of that latitude: loadURL('http://127.0.0.1:<port>') plus getApiUrl
  //    returning a RELATIVE path means its requests are same-origin and carry
  //    no Origin at all. So the allowed set is exactly "origin.host equals the
  //    request's Host" — derived, not hardcoded, because the EADDRINUSE walk
  //    moves the port.
  for (const other of ['http://127.0.0.1:5173', 'http://localhost:8080',
    'https://localhost:443', 'http://127.0.0.1:3000']) {
    const res = await fetch(`${base}/api/games`, { headers: { Origin: other } });
    record(`another LOCAL app on ${other} cannot read the library either`,
      !acao(res),
      `acao=${acao(res)} — loopback is not a trust boundary between origins`);
  }

  // ── CONTROL 1: the app's OWN origin must keep working. Without this,
  //    "no ACAO" is also what a broken middleware and a dead server look like.
  //    Built from the port under test, so it follows the EADDRINUSE walk
  //    instead of rotting against a hardcoded 14321.
  {
    const own = `http://127.0.0.1:${DESKTOP_PORT}`;
    const res = await fetch(`${base}/api/games`, { headers: { Origin: own } });
    record(`CONTROL: the app's own origin ${own} is still allowed`,
      acao(res) === own,
      `acao=${acao(res)}`);
  }
  // Same-origin requests carry NO Origin header — this is what the renderer
  // actually sends, and it must pass through untouched.
  {
    const res = await fetch(`${base}/api/games`);
    record('CONTROL: a same-origin request (no Origin header) still succeeds',
      res.status === 200,
      `status=${res.status} — this is the renderer's real shape: getApiUrl returns a `
      + 'relative path in local mode');
  }
  // PATCH must survive the preflight: the client updates a saved game in place
  // (scenario keep, rename), and dropping it breaks those calls for the
  // Electron client only — a failure that reads as "couldn't reach the server".
  const ownPreflight = await fetch(`${base}/api/games`, {
    method: 'OPTIONS',
    headers: {
      Origin: `http://127.0.0.1:${DESKTOP_PORT}`,
      'Access-Control-Request-Method': 'PATCH',
    },
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

  // ───────────────────────────────────────────────────────────────────────────
  // SR-63 — DNS REBINDING. The checks above all send a hostile Origin with the
  // app's own Host, which is the shape CORS is for. Rebinding is the shape it
  // is NOT: attacker.example resolves to its own server, the page loads, the
  // name re-resolves to 127.0.0.1, and the browser now believes
  // attacker.example:<port> IS the origin — so it sends NO Origin header at
  // all and the CORS middleware never runs. Nothing in this file reached that,
  // and `fetch` cannot: it forbids setting Host. Raw http.request can.
  //
  // MEASURED before the fix: Host: evil.example:<port> with no Origin returned
  // 200 and the whole saved-game library; the same Host on POST /api/games
  // created a game owned by local-owner.
  // ───────────────────────────────────────────────────────────────────────────
  const rawReq = (port, hostHeader, { method = 'GET', p = '/api/games', origin, body } = {}) =>
    new Promise((resolve) => {
      const headers = { Host: hostHeader };
      if (origin) headers.Origin = origin;
      if (body) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(body);
      }
      const req = http.request(
        { host: '127.0.0.1', port: Number(port), path: p, method, headers, setHost: false },
        (r) => {
          let d = '';
          r.on('data', (x) => { d += x; });
          r.on('end', () => resolve({
            status: r.statusCode,
            acao: r.headers['access-control-allow-origin'],
            body: d,
          }));
        },
      );
      req.on('error', (e) => resolve({ status: 'error', acao: undefined, body: String(e.message) }));
      if (body) req.write(body);
      req.end();
    });

  // CONTROL FIRST: the raw-request helper itself reaches the app and gets the
  // library. Without this, every "403" below would also be the reading for a
  // helper that sends a malformed request the server rejects for some other
  // reason entirely.
  const rawControl = await rawReq(DESKTOP_PORT, `127.0.0.1:${DESKTOP_PORT}`);
  record('CONTROL: a raw request with the loopback Host reads the library (the helper works)',
    rawControl.status === 200 && rawControl.body.includes('cors-probe-game'),
    `status=${rawControl.status} body=${rawControl.body.slice(0, 80)}`);

  const rebindGet = await rawReq(DESKTOP_PORT, `evil.example:${DESKTOP_PORT}`);
  record('SR-63: a rebound Host with NO Origin cannot read the library',
    rebindGet.status === 403 && !rebindGet.body.includes('cors-probe-game'),
    `status=${rebindGet.status} body=${rebindGet.body.slice(0, 90)}`);

  const rebindPost = await rawReq(DESKTOP_PORT, `evil.example:${DESKTOP_PORT}`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'REBOUND-ATTACKER-GAME',
      payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 },
    }),
  });
  record('SR-63: a rebound Host cannot WRITE to the library either',
    rebindPost.status === 403,
    `status=${rebindPost.status} body=${rebindPost.body.slice(0, 90)}`);

  // …and prove the write really did not land, rather than trusting the status.
  const afterAttack = await rawReq(DESKTOP_PORT, `127.0.0.1:${DESKTOP_PORT}`);
  record('SR-63: the refused write left nothing behind in the library',
    !afterAttack.body.includes('REBOUND-ATTACKER-GAME'),
    afterAttack.body.slice(0, 120));

  record('SR-63: a rebound Host WITH an Origin is not echoed back either',
    (await rawReq(DESKTOP_PORT, `evil.example:${DESKTOP_PORT}`, { origin: `http://evil.example:${DESKTOP_PORT}` })).acao === undefined,
    'before the fix the same-origin test compared Origin against this very Host, so the attacker controlled both sides');

  // The scheme was ignored in that comparison: https://127.0.0.1:<port> is a
  // DIFFERENT origin from the renderer's http:// and was being echoed.
  record('SR-63: an https Origin on the loopback host is NOT treated as same-origin',
    (await rawReq(DESKTOP_PORT, `127.0.0.1:${DESKTOP_PORT}`, { origin: `https://127.0.0.1:${DESKTOP_PORT}` })).acao === undefined,
    'only .host was compared, so the https origin matched');

  // REGRESSION CONTROLS: every Host shape a real client sends must still work.
  // A guard that 403s the renderer is worse than the defect it fixes.
  for (const [hostHeader, why] of [
    [`127.0.0.1:${DESKTOP_PORT}`, 'the renderer itself'],
    [`localhost:${DESKTOP_PORT}`, 'a user typing localhost'],
    [`[::1]:${DESKTOP_PORT}`, 'the IPv6 loopback literal'],
    ['127.0.0.1', 'a Host with no port'],
    [`LOCALHOST:${DESKTOP_PORT}`, 'an uppercase Host'],
  ]) {
    const r = await rawReq(DESKTOP_PORT, hostHeader);
    record(`SR-63 CONTROL: Host "${hostHeader}" still works (${why})`,
      r.status === 200, `status=${r.status}`);
  }

  // And the HOSTED build must not have inherited the guard: its Host is the
  // real domain behind a proxy, so a leak here 403s every production request.
  for (const hostHeader of ['nash-equilibrium-simulator.com', 'some-revision.a.run.app']) {
    const r = await rawReq(WEB_PORT, hostHeader, { p: '/api/health' });
    record(`SR-63 CONTROL: the hosted build still serves Host "${hostHeader}"`,
      r.status === 200, `status=${r.status} — a leak here would 403 the whole public site`);
  }
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

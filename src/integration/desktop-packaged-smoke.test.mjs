/* PACKAGED-BINARY SMOKE — the only harness where CHROMIUM writes the headers.
 *
 * CI packages the .app (package-audit) and audits what is INSIDE it, but never
 * LAUNCHED it. That is the gap SR-63 went through: a Host guard can be correct
 * in dist/server.cjs and still brick the real window, or be absent from the
 * artifact, and every other suite would stay green either way.
 *
 * Every check here is a property that only the real binary can answer —
 * the renderer's own Host header, the real main process, the real user-data
 * directory — and each one corresponds to a fix on this branch:
 *   1-5  the window loads, renders the APP, and its own fetches save/round-trip
 *   6    a foreign Host is refused BY THE ARTIFACT (SR-63 is live in the build)
 *   7    the www->apex 301 does not answer a rebound Host (the ORDERING fix)
 *   8    a11:null is refused (SR-64) with an ordinary matrix as the control
 *   9    the lazy session key signs a token the app can verify (the post-lock
 *        read) end to end
 *
 * Needs a packaged app: `npm run build && npx electron-builder --mac --dir`.
 *
 *   node src/integration/desktop-packaged-smoke.test.mjs
 */
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
// electron-builder names the directory by arch; take whichever one was built
// rather than hardcoding, so this runs on an Intel runner too.
const macDir = ['mac-arm64', 'mac', 'mac-x64']
  .map((d) => join(REPO, 'dist-electron', d))
  .find((d) => existsSync(d));
if (!macDir) {
  console.error('no packaged .app found under dist-electron/ — run `npx electron-builder --mac` first.');
  process.exit(1);
}
const APP = join(macDir, 'Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator');
if (!existsSync(APP)) { console.error(`packaged binary missing at ${APP}`); process.exit(1); }

const out = [];
const rec = (n, ok, d) => { out.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };

const userDataDir = mkdtempSync(join(tmpdir(), 'nash-sr63-udd-'));
let app = null;
try {
  app = await electron.launch({
    executablePath: APP,
    args: [`--user-data-dir=${userDataDir}`],
    cwd: '/tmp', // shipping condition: dotenv must not find the repo's .env
    env: { IS_ELECTRON: 'true', NODE_ENV: 'production', PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3000);

  const url = win.url();
  rec('1. the packaged window LOADS on its loopback origin (the Host guard did not brick it)',
    /^http:\/\/127\.0\.0\.1:\d+/.test(url), `window URL: ${url}`);

  // The real page's own title/root must be there — a 403 body would load as a
  // "document" too, so the URL alone is not proof.
  const rootPresent = await win.evaluate(() => !!document.querySelector('#root, main, [data-testid]')
    && !/Invalid Host header/.test(document.body.innerText));
  rec('2. the rendered document is the APP, not a 403 error body',
    rootPresent, `body starts: ${JSON.stringify((await win.evaluate(() => document.body.innerText)).slice(0, 80))}`);

  // 3. The renderer's OWN fetch — Chromium writes the Host header here, which
  // is the exact thing the guard inspects.
  const listed = await win.evaluate(async () => {
    const r = await fetch('/api/games');
    return { status: r.status, body: (await r.text()).slice(0, 60) };
  });
  rec('3. the renderer\'s own fetch to /api/games is allowed through the guard',
    listed.status === 200, `status ${listed.status} ${listed.body}`);

  const saved = await win.evaluate(async () => {
    const r = await fetch('/api/games', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SR63 REAL APP SAVE', description: 'd',
        payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 } }),
    });
    return { status: r.status, body: (await r.text()).slice(0, 70) };
  });
  rec('4. a save from inside the real app still succeeds', saved.status === 200,
    `status ${saved.status} ${saved.body}`);

  const reread = await win.evaluate(async () => (await (await fetch('/api/games')).json()).map(g => g.name));
  rec('5. the save round-trips (the library really changed)',
    reread.includes('SR63 REAL APP SAVE'), JSON.stringify(reread));

  // 6. And the guard is genuinely LIVE in the packaged build: a foreign Host
  // sent from the app's own network stack must still be refused. Uses the
  // main process's net module, since the renderer cannot set Host.
  const port = Number(/:(\d+)/.exec(url)[1]);
  // The raw socket runs HERE, in the harness process, against the packaged
  // app's own port. Electron's net module refuses a Host override
  // (ERR_INVALID_ARGUMENT), and this is the same wire the attacker would use.
  const foreign = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    const t = setTimeout(() => { s.destroy(); resolve({ status: 'timeout', body: buf.slice(0, 60) }); }, 5000);
    s.on('connect', () => s.write(`GET /api/games HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { buf += d; });
    s.on('close', () => {
      clearTimeout(t);
      const m = /^HTTP\/1\.1 (\d+)/.exec(buf);
      resolve({ status: m ? Number(m[1]) : 'none', body: buf.slice(-60), leaked: buf.includes('SR63 REAL APP SAVE') });
    });
    s.on('error', (e) => { clearTimeout(t); resolve({ status: 'error', body: String(e) }); });
  });
  rec('6. a foreign Host is refused BY THE PACKAGED BUILD (guard is live in the artifact)',
    foreign.status === 403 && foreign.leaked !== true, `status ${foreign.status} leaked=${foreign.leaked} ${foreign.body}`);

  // ── SWEEP 29: every fix this branch made, verified in the REAL artifact ──
  // 7. SR-63 ORDERING: the www->apex 301 must NOT answer a rebound Host.
  const raw = (hostHeader, pth = '/api/games') => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    const t = setTimeout(() => { s.destroy(); resolve({ status: 'timeout', buf }); }, 5000);
    s.on('connect', () => s.write(`GET ${pth} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { buf += d; });
    s.on('close', () => { clearTimeout(t);
      const m = /^HTTP\/1\.1 (\d+)/.exec(buf);
      resolve({ status: m ? Number(m[1]) : 'none', loc: /\r\nLocation: ([^\r]+)/i.exec(buf)?.[1], buf }); });
    s.on('error', (e) => { clearTimeout(t); resolve({ status: 'error', buf: String(e) }); });
  });
  const wwwRebind = await raw('www.nash-equilibrium-simulator.com', '/api/games?x=1');
  rec('7. SR-63 ORDER: the www->apex 301 does not answer a rebound Host in the packaged app',
    wwwRebind.status === 403 && !wwwRebind.loc,
    `status ${wwwRebind.status} location=${wwwRebind.loc ?? '-'}`);

  // 8. SR-64: a coerced non-number payoff is refused by the packaged app.
  const sr64 = await win.evaluate(async () => {
    const P = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
    const bad = await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payoffs: { ...P, a11: null } }) });
    const good = await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payoffs: P }) });
    return { bad: bad.status, good: good.status };
  });
  rec('8. SR-64: a11=null is REFUSED by the packaged app (no report states a number nobody sent)',
    sr64.bad === 400, `status ${sr64.bad}`);
  rec('8b. CONTROL: an ordinary matrix still produces a report in the packaged app',
    sr64.good === 200, `status ${sr64.good}`);

  // 9. THE LAZY SESSION KEY, end to end in the artifact: register + sign in,
  //    and the auth-secret on disk must be the one the running app signs with
  //    (it is written only after the lock is taken).
  const authed = await win.evaluate(async () => {
    await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sweep29', email: 'sweep29@example.com', password: 'CorrectHorse9!' }) });
    const li = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'sweep29@example.com', password: 'CorrectHorse9!' }) });
    const j = await li.json();
    if (!j.token) return { ok: false, why: 'no token' };
    const me = await fetch('/api/auth/me', { headers: { authorization: `Bearer ${j.token}` } });
    return { ok: me.status === 200, status: me.status };
  });
  rec('9. the lazy session key works end-to-end in the packaged app (sign in, /api/auth/me 200)',
    authed.ok === true, JSON.stringify(authed));
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}
const bad = out.filter(r => !r.ok);
console.log(`\n${out.length - bad.length}/${out.length} passed`);
console.log('ALLDONE');
if (bad.length) process.exit(1);

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
 *   10-11 renderer isolation and the IPC bridge, asserted by EFFECT
 *   11d  the channel set of the RUNNING main process — the capability surface
 *        as the shipped binary registers it, which is the one thing the
 *        fake-Electron runner cannot see
 *
 * Needs a packaged app: `npm run build && npx electron-builder --mac --dir`.
 * Runs in CI's `package-audit` job (the only macOS runner that builds a .app),
 * which is one of main's REQUIRED status checks — verified against branch
 * protection: unit, build, e2e, integration, container, mobile, package-audit.
 * A failure here blocks a merge.
 *
 *   node src/integration/desktop-packaged-smoke.test.mjs
 */
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// FRESHNESS, asserted before anything is launched.
//
// This suite reads the PACKAGED artifact, which is correct — and means it will
// happily test a .app left over from an older build and report 10/10.
// MEASURED: with dist/server.cjs mutated and no repackaging, the suite still
// passed, because the mutation was never in the artifact. In CI the build step
// precedes the launch step, but nothing ENFORCES that ordering, and a build
// that silently no-ops would turn this gate into a green light on stale code.
// So compare the server bundle INSIDE app.asar against the one just built:
// same bytes, or this is not a test of the current source.
{
  const asarPath = join(macDir, 'Nash Equilibrium Simulator.app/Contents/Resources/app.asar');
  const built = join(REPO, 'dist/server.cjs');
  if (!existsSync(asarPath) || !existsSync(built)) {
    console.error(`cannot verify artifact freshness: missing ${existsSync(asarPath) ? built : asarPath}`);
    process.exit(1);
  }
  // @electron/asar arrives HOISTED from electron-builder, not declared — the
  // same dependency src/desktop/audit-packaged-asar.cjs documents. If a
  // lockfile change ever nests it, say so instead of dying on an opaque
  // MODULE_NOT_FOUND, because a crash here would read as "the smoke test is
  // broken" rather than "the freshness check stopped running".
  let extractFile;
  try { ({ extractFile } = await import('@electron/asar')); }
  catch (e) {
    console.error('cannot load @electron/asar, which the artifact-freshness check needs. It '
      + 'arrives hoisted from electron-builder; if that changed, declare it in devDependencies. '
      + `(${String(e.message).slice(0, 120)})`);
    process.exit(1);
  }
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const inAsar = sha(extractFile(asarPath, 'dist/server.cjs'));
  const onDisk = sha(readFileSync(built));
  if (inAsar !== onDisk) {
    console.error('STALE ARTIFACT: the server bundle inside app.asar is not the one in dist/.\n'
      + `  app.asar: ${inAsar.slice(0, 16)}\n  dist/:    ${onDisk.slice(0, 16)}\n`
      + '  Re-run `npm run build && npx electron-builder --mac --dir`. Testing a stale .app '
      + 'would report a clean result for code that is not in it.');
    process.exit(1);
  }
  console.log(`PASS 0. the packaged artifact contains the bundle just built (${inAsar.slice(0, 16)})`);
}

const SMOKE_PASSWORD = 'CorrectHorse9!';
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
  // Check 12b greps the on-disk files for this exact string, so it lives in
  // one place: a second literal there could drift and make 12b search for a
  // password nobody ever sent.
  const authed = await win.evaluate(async (pw) => {
    await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sweep29', email: 'sweep29@example.com', password: pw }) });
    const li = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'sweep29@example.com', password: pw }) });
    const j = await li.json();
    if (!j.token) return { ok: false, why: 'no token' };
    const me = await fetch('/api/auth/me', { headers: { authorization: `Bearer ${j.token}` } });
    return { ok: me.status === 200, status: me.status };
  }, SMOKE_PASSWORD);
  rec('9. the lazy session key works end-to-end in the packaged app (sign in, /api/auth/me 200)',
    authed.ok === true, JSON.stringify(authed));
  // ── 10. RENDERER ISOLATION, asserted from INSIDE the page. ──────────────
  // webPreferences reports what was REQUESTED; this reports what the page can
  // actually reach. Only the real binary can answer it.
  const iso = await win.evaluate(() => ({
    require: typeof require !== 'undefined', process: typeof process !== 'undefined',
    module: typeof module !== 'undefined', global: typeof global !== 'undefined',
    buffer: typeof Buffer !== 'undefined',
    exposed: Object.keys(window).filter((k) => /electron|node|ipc|nash/i.test(k)).sort(),
    bridgeKeys: window.nashDesktop ? Object.keys(window.nashDesktop).sort() : null,
    ipcReachable: !!(window.nashDesktop && window.nashDesktop.ipcRenderer),
  }));
  rec('10. the renderer has no Node reachable from inside the page',
    !iso.require && !iso.process && !iso.module && !iso.global && !iso.buffer,
    JSON.stringify(iso));
  rec('10b. exactly one bridge key, with exactly one method, and no ipcRenderer behind it',
    JSON.stringify(iso.exposed) === JSON.stringify(['nashDesktop'])
    && JSON.stringify(iso.bridgeKeys) === JSON.stringify(['setBackgroundColor'])
    && iso.ipcReachable === false,
    JSON.stringify({ exposed: iso.exposed, bridgeKeys: iso.bridgeKeys, ipcReachable: iso.ipcReachable }));

  // ── 11. THE BRIDGE FORWARDS ANYTHING; MAIN IS WHAT MUST VALIDATE. ───────
  // Asserted by EFFECT on the native window, not by the call returning — the
  // renderer cannot see the handler's verdict, so "it did not throw" says
  // nothing at all.
  const colour = () => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBackgroundColor());
  const sendColour = (value, extra) => win.evaluate(([v, e]) => {
    try {
      if (e === undefined) window.nashDesktop.setBackgroundColor(v);
      else window.nashDesktop.setBackgroundColor(v, e);
      return 'sent';
    } catch { return 'threw'; }
  }, [value, extra]);

  const baseline = await colour();
  const accepted = [];
  for (const bad of ['red', '#00', 'javascript:alert(1)', null, 123, '#12345g', '#1234567', '  #ffffff  ']) {
    await sendColour(bad);
    await win.waitForTimeout(120);
    if ((await colour()) !== baseline) accepted.push(bad);
  }
  rec('11. main REJECTS every non-hex background colour the renderer can send',
    accepted.length === 0, `the window changed for: ${JSON.stringify(accepted)}`);
  // CONTROL: a valid colour must actually change the window, or every
  // "unchanged" above is the reading for a bridge that does nothing at all.
  await sendColour('#123456');
  await win.waitForTimeout(250);
  const changed = await colour();
  rec('11b. CONTROL: a VALID hex colour does change the window (the bridge is not inert)',
    changed.toLowerCase() === '#123456', `window colour is ${changed}`);
  // An extra argument must not be usable to pick a different IPC channel.
  // Gate review #5 (finding 2) is right that this cannot fail against today's
  // one-parameter preload arrow — JS drops the extra argument before
  // `ipcRenderer.send` is reached. It is WEAKER than that, and the measurement
  // is worth writing down: giving the preload a real
  // `(color, channel) => ipcRenderer.send(channel || 'set-background-color', color)`
  // signature AND registering a second main-process handler for the evil
  // channel left 11c GREEN — because that handler set the same colour, so the
  // window changed either way and "it routed to the one channel" was never
  // what this observed. An effect check cannot tell two channels apart when
  // both produce the effect. 11d is the assertion; it failed on that mutant by
  // name. 11c stays only as a cheap canary and must not be read as coverage.
  await sendColour('#abcdef', 'set-background-color-evil');
  await win.waitForTimeout(250);
  rec('11c. an extra argument cannot select a different IPC channel',
    (await colour()).toLowerCase() === '#abcdef',
    'the call still routes to the one channel the preload hard-codes');

  // ── 11d. THE CHANNEL SET OF THE RUNNING MAIN PROCESS. ───────────────────
  // Every registered channel is reachable from ANY script the page runs, so
  // the set is the capability surface — and the preload is not the only way
  // to reach it. electron-behavior.test.mjs asserts this against a fake
  // Electron; this asserts it against the process that actually shipped,
  // where a channel added by a dependency's patch or lost in packaging would
  // differ. Read from ipcMain's own listener registry, not from source text.
  //   `error` is Electron's OWN listener, not ours, and not the harness's:
  // MEASURED by logging ipcMain.eventNames() from inside electron-main.cjs
  // immediately BEFORE its single `ipcMain.on` — ["error"] — and the same
  // ["error"] appears when the packaged binary is launched straight from the
  // shell with no Playwright involved. It is an EventEmitter 'error' sink
  // (a `()=>{}`), so it is subtracted BY NAME rather than the assertion being
  // relaxed to a subset check, which would stop counting anything.
  const ELECTRON_OWN = ['error'];
  const channels = await app.evaluate(({ ipcMain }) =>
    ipcMain.eventNames().map(String).sort());
  const ours = channels.filter((c) => !ELECTRON_OWN.includes(c));
  rec('11d. the packaged main process registers EXACTLY the one IPC channel',
    JSON.stringify(ours) === JSON.stringify(['set-background-color']),
    `registered: ${JSON.stringify(channels)}, ours: ${JSON.stringify(ours)} — each one is a `
    + 'capability any script in the page can invoke');
  // CONTROL: the subtraction above must not be able to hide a real channel —
  // if Electron ever stops registering `error`, this fails and the list is
  // re-derived rather than silently carrying a name that subtracts nothing.
  rec('11d CONTROL: the subtracted name is actually present (the filter is not a no-op)',
    ELECTRON_OWN.every((c) => channels.includes(c)),
    `expected ${JSON.stringify(ELECTRON_OWN)} among ${JSON.stringify(channels)}`);

  // ── 12. WHAT THE SESSION LEFT ON DISK. ─────────────────────────────────
  // Sweep 34. Everything above asks what the app ANSWERS; this asks what it
  // WROTE. The app's own files hold a session key and the whole library, and
  // this is the only harness that can see them after a real signed-in session
  // through the real binary.
  //   Scoped to the files the APP owns — Chromium's caches are Chromium's
  // business and their names churn between versions, so asserting on them
  // would be a rot factory. The control below keeps the scoping honest.
  const CHROMIUM = /^(Cache|Code Cache|Dawn\w*Cache|GPUCache|Local Storage|Session Storage|blob_storage|Network|Shared Dictionary|Trust Tokens|Cookies|Singleton|DevToolsActivePort|component_crx_cache|extensions_crx_cache)/;
  const walk = (d, base = d, acc = []) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      let st;
      try { st = statSync(f); } catch { continue; }
      if (st.isDirectory()) walk(f, base, acc);
      else acc.push({ p: f.slice(base.length + 1), mode: (st.mode & 0o777).toString(8) });
    }
    return acc;
  };
  const disk = walk(userDataDir);
  const appOwned = disk.filter((f) => !CHROMIUM.test(f.p));
  // CONTROL first: if the filter ate everything, every check below is vacuous.
  rec('12 CONTROL: the app-owned file set is non-empty after a signed-in session',
    appOwned.length >= 3 && appOwned.some((f) => f.p === 'db.json')
      && appOwned.some((f) => f.p === 'auth-secret'),
    `app-owned: ${JSON.stringify(appOwned.map((f) => `${f.p}:${f.mode}`))}`);
  // The session key and the library are 0600. Not "the app chmods them" —
  // what the mode IS after the real app has run.
  const notPrivate = appOwned.filter((f) => f.mode !== '600');
  rec('12. every file the packaged app writes is 0600 (owner-only)',
    notPrivate.length === 0,
    `group/other-readable: ${JSON.stringify(notPrivate.map((f) => `${f.p}:${f.mode}`))}`);
  // And no file the app owns contains the password in the clear. MEASURED as
  // part of this sweep across all 64 files including Chromium's: zero hits.
  const plaintext = appOwned.filter((f) => {
    try { return readFileSync(join(userDataDir, f.p), 'latin1').includes(SMOKE_PASSWORD); }
    catch { return false; }
  });
  rec('12b. no app-owned file stores the account password in the clear',
    plaintext.length === 0, `contains it: ${JSON.stringify(plaintext.map((f) => f.p))}`);

  // ── 13. THE USER DOUBLE-CLICKS THE ICON AGAIN. ─────────────────────────
  // desktop-concurrent-lock covers two `dist/server.cjs` PROCESSES; this is
  // the packaged .app launched a second time against the user-data directory
  // the running one owns.
  //   WHICH LAYER EACH CHECK PROVES — measured, because the first spelling of
  // 13 was mis-attributed. Removing the SERVER lock (`if (!acquireDesktopLock())
  // return;` -> `acquireDesktopLock();`) left all of 13/13b/13c GREEN: the
  // second app never reaches the server, because electron-main.cjs:177 quits
  // it at `app.requestSingleInstanceLock()` first. So 13 is a guard on
  // ELECTRON's lock, not the server's. Confirmed from the other side:
  // stubbing `gotTheLock = true` makes 13 FAIL with "still running" — and
  // 13b/13c stay green, which is the server lock doing its job with Electron's
  // removed. That is a defence in depth worth stating rather than a
  // redundancy: each check names a different layer.
  //   The invariant is that a refused instance changes NOTHING: the running
  // app keeps serving, and the two files that carry state are byte-identical
  // (sha + size + mtime) across the second launch.
  //   13b/13c ARE OBSERVATIONS, NOT PROOFS, and say so rather than pretending.
  // I could not construct a mutation that makes either fail, and tried:
  // removing the server lock (green), removing Electron's lock (13 fails,
  // 13b/13c green), removing BOTH (13 fails, 13b/13c green), and poisoning
  // auth-secret first so a second instance that ran through would have to
  // WRITE (still green). The reason is a third layer: with both locks gone the
  // second server dies on EADDRINUSE binding 14321 before it touches the
  // directory. Three independent defences, so no single-edit mutant reaches
  // the write. They stay because they cost one stat each and would catch a
  // future instance that DOES get through — but they are not evidence that
  // anything is guarded; check 13 is.
  writeFileSync(join(userDataDir, 'auth-secret'), 'not-a-key');
  const stateFiles = ['db.json', 'auth-secret'];
  const fingerprint = () => JSON.stringify(stateFiles.map((n) => {
    const f = join(userDataDir, n);
    if (!existsSync(f)) return [n, null];
    const st = statSync(f);
    return [n, createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12), st.size, st.mtimeMs];
  }));
  const beforeSecond = fingerprint();
  // CONTROL: the fingerprint must be reading real files, or "unchanged" below
  // is the reading for two nulls.
  rec('13 CONTROL: both state files exist before the second launch',
    !beforeSecond.includes('null'), beforeSecond);

  const { spawn } = await import('node:child_process');
  const second = spawn(APP, [`--user-data-dir=${userDataDir}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const secondExit = await Promise.race([
    new Promise((r) => second.once('exit', (code) => r(code))),
    new Promise((r) => setTimeout(() => r('still running'), 12000)),
  ]);
  if (secondExit === 'still running') second.kill('SIGKILL');
  rec('13. a second launch of the packaged app does not take over (it exits)',
    secondExit !== 'still running', `second instance: ${secondExit}`);
  rec('13b. OBSERVATION: the refused second launch changed nothing on disk',
    fingerprint() === beforeSecond, `before ${beforeSecond} after ${fingerprint()}`);
  // …and the first window is still the live one, serving its own library.
  const survived = await win.evaluate(async () => {
    try {
      const r = await fetch('/api/games');
      return { status: r.status, names: (await r.json()).map((g) => g.name) };
    } catch (e) { return { error: String(e).slice(0, 100) }; }
  });
  rec('13c. OBSERVATION: the FIRST window still serves its library afterwards',
    survived.status === 200 && survived.names?.includes('SR63 REAL APP SAVE'),
    JSON.stringify(survived));
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}
const bad = out.filter(r => !r.ok);
console.log(`\n${out.length - bad.length}/${out.length} passed`);
console.log('ALLDONE');
if (bad.length) process.exit(1);

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

  // Array-guarded: if the guard ever refuses this request the body is an
  // error OBJECT, and an unguarded .map would throw inside the try — skipping
  // every later check and reporting a crash where a FAIL belongs. (The same
  // shape killed desktop-unwritable-save mid-run under a mutant.)
  const reread = await win.evaluate(async () => {
    const j = await (await fetch('/api/games')).json();
    return Array.isArray(j) ? j.map((g) => g.name) : { notAnArray: j };
  });
  rec('5. the save round-trips (the library really changed)',
    Array.isArray(reread) && reread.includes('SR63 REAL APP SAVE'), JSON.stringify(reread));

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
    // Object.keys was the SAME single-registry assumption that made 11d blind
    // to ipcMain.handle, so it was checked rather than trusted: these three
    // are the enumerations a key could hide from.
    bridgeOwnNames: window.nashDesktop ? Object.getOwnPropertyNames(window.nashDesktop).sort() : null,
    bridgeSymbols: window.nashDesktop ? Object.getOwnPropertySymbols(window.nashDesktop).map(String) : null,
    bridgeProto: window.nashDesktop
      ? Object.getOwnPropertyNames(Object.getPrototypeOf(window.nashDesktop) || {}).sort() : null,
  }));
  rec('10. the renderer has no Node reachable from inside the page',
    !iso.require && !iso.process && !iso.module && !iso.global && !iso.buffer,
    JSON.stringify(iso));
  rec('10b. exactly one bridge key, with exactly one method, and no ipcRenderer behind it',
    JSON.stringify(iso.exposed) === JSON.stringify(['nashDesktop'])
    && JSON.stringify(iso.bridgeKeys) === JSON.stringify(['setBackgroundColor'])
    && iso.ipcReachable === false,
    JSON.stringify({ exposed: iso.exposed, bridgeKeys: iso.bridgeKeys, ipcReachable: iso.ipcReachable }));
  // 10c. FACT-PIN, NOT A PROOF — labelled so nobody reads it as coverage.
  //
  // 11d's blind spot made me ask whether `Object.keys` is the same mistake on
  // the bridge. MEASURED, twice, against the packaged binary, because the
  // answer is a property of contextBridge rather than of JS:
  //   non-enumerable via defineProperty -> typeof is "undefined", calling it
  //     throws, the window colour does not move
  //   carried on the PROTOTYPE          -> identical result
  // contextBridge clones only ENUMERABLE OWN properties, so a hidden member
  // does not merely go unlisted, it never reaches the renderer. Object.keys
  // is therefore SUFFICIENT here, unlike ipcMain.eventNames() in 11d.
  //   I could not construct a mutation that makes this check red, so it is
  // not evidence of anything today. It stays because it costs one evaluate
  // and it fails loudly if a future Electron starts cloning non-enumerables,
  // at which point 10b silently stops covering the bridge.
  rec('10c. FACT-PIN: the bridge has nothing behind Object.keys (contextBridge clones own enumerables only)',
    JSON.stringify(iso.bridgeOwnNames) === JSON.stringify(iso.bridgeKeys)
    && JSON.stringify(iso.bridgeSymbols) === JSON.stringify([])
    && JSON.stringify(iso.bridgeProto)
      === JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort()),
    JSON.stringify({ keys: iso.bridgeKeys, ownNames: iso.bridgeOwnNames,
      symbols: iso.bridgeSymbols, proto: iso.bridgeProto }));

  // ── 10d. EVERY webContents, not just getAllWindows()[0]. ───────────────
  // Sweep 37, the same question 11d's blind spot taught me to ask: is one
  // registry enough? Checks 10/10b/10c all speak to the FIRST window. A
  // BrowserView, a WebContentsView, a popup or an opened devtools is a
  // webContents that is not a BrowserWindow, each with its OWN
  // webPreferences — one of them running nodeIntegration would leave every
  // isolation check above green. `webContents.getAllWebContents()` is the
  // registry that sees all of them.
  //   MEASURED on the packaged app: exactly one, type "window", on the
  // loopback URL, with nodeIntegration false / contextIsolation true /
  // sandbox true / webSecurity true / nodeIntegrationInSubFrames false.
  const wcs = await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().map((wc) => {
      let p = {};
      try { p = wc.getLastWebPreferences() || {}; } catch { p = { unreadable: true }; }
      return { type: wc.getType(), url: String(wc.getURL()).slice(0, 60),
        devtools: wc.isDevToolsOpened(), nodeIntegration: p.nodeIntegration ?? null,
        contextIsolation: p.contextIsolation ?? null, sandbox: p.sandbox ?? null,
        webSecurity: p.webSecurity ?? null, subFrames: p.nodeIntegrationInSubFrames ?? null };
    }));
  // CONTROL: an empty list would satisfy every `.every()` below for free.
  rec('10d CONTROL: the webContents registry is non-empty (the checks below have something to read)',
    wcs.length >= 1, JSON.stringify(wcs));
  rec('10d. EVERY webContents is locked down, not just the first window',
    wcs.length === 1 && wcs.every((w) => w.nodeIntegration === false
      && w.contextIsolation === true && w.sandbox === true && w.webSecurity === true
      && w.subFrames === false && w.devtools === false
      && /^http:\/\/127\.0\.0\.1:\d+/.test(w.url)),
    `${wcs.length} webContents: ${JSON.stringify(wcs)} — a BrowserView or popup carries its own `
    + 'webPreferences, and checks 10/10b/10c only ever look at the first window');

  // ── 10e. THE PAGE MUST NOT BE ABLE TO READ THE USER'S FILESYSTEM. ──────
  //
  // BLUE-LOOP-DESKTOP-22, sweep 43. Check 10d asserts `webSecurity === true`
  // from `getLastWebPreferences()` — a CONFIGURATION reading. This asserts
  // the CAPABILITY, which is what actually matters and what a future
  // Chromium/Electron default, a command-line switch, or a per-request
  // protocol handler could change underneath an unchanged config.
  //
  // Found while running the red's 16-vector navigation suite, whose vector 16
  // reported FAIL because the app logs no refusal for `file:`. Measured
  // (_gen/b22-s43-file-scheme.mjs): Chromium blocks file: BEFORE
  // `will-navigate` fires, so the main process never sees it and has nothing
  // to refuse — `main saw []` across anchor click, location.href,
  // location.assign, window.open and iframe src, and the window never left
  // the app origin. The refusal LOG was the wrong instrument; THIS is the
  // right one, because a scheme the main process never sees is a scheme its
  // allowlist cannot protect.
  const fileRead = await win.evaluate(async () => {
    const out = {};
    try {
      const r = await fetch('file:///etc/passwd');
      out.fetch = { ok: true, status: r.status, body: (await r.text()).slice(0, 40) };
    } catch (e) { out.fetch = { ok: false, err: String(e.message).slice(0, 60) }; }
    try {
      const x = new XMLHttpRequest();
      x.open('GET', 'file:///etc/passwd', false);
      x.send();
      out.xhr = { ok: true, status: x.status, body: String(x.responseText).slice(0, 40) };
    } catch (e) { out.xhr = { ok: false, err: String(e.message).slice(0, 60) }; }
    return out;
  });
  rec('10e. the renderer cannot READ a local file (fetch file:///etc/passwd)',
    fileRead.fetch?.ok === false, JSON.stringify(fileRead.fetch));
  rec('10e. the renderer cannot READ a local file (synchronous XHR file:///etc/passwd)',
    fileRead.xhr?.ok === false, JSON.stringify(fileRead.xhr));
  // CONTROL: the same two APIs must WORK against the app's own origin, or
  // "both threw" is a page with no network at all rather than a policy.
  const ownOrigin = await win.evaluate(async () => {
    try {
      const r = await fetch('/api/health');
      return { ok: r.ok, status: r.status };
    } catch (e) { return { ok: false, err: String(e.message).slice(0, 60) }; }
  });
  rec('10e CONTROL: fetch to the app\'s OWN origin still works (the refusals above are a policy, '
    + 'not a dead page)', ownOrigin.ok === true, JSON.stringify(ownOrigin));

  // ── 10f. THE SECURITY HEADERS THE DESKTOP SERVES ITSELF. ───────────────
  //
  // BLUE-LOOP-DESKTOP-22, sweep 44. server.ts sets five baseline headers, and
  // `grep -rln 'Content-Security-Policy' src` found NOTHING — not one guard
  // in this repo asserted that a single one of them is actually served. They
  // are load-bearing precisely on the desktop: the window has no URL bar
  // (titleBarStyle 'hidden') and the page renders model- and user-authored
  // strings, so `base-uri 'self'` is what stops an injected <base href> from
  // retargeting every relative URL in the page — including the renderer's own
  // API calls — and `frame-ancestors 'none'` / X-Frame-Options keep the app
  // out of a frame.
  //
  // Asserted on FOUR paths, not one: the document, two API routes and a
  // static 404. A middleware registered after a route would cover some and
  // not others, and a header set only on the document would leave every API
  // response bare.
  const HEADER_PATHS = ['/', '/api/health', '/api/games', '/assets/does-not-exist.js'];
  const REQUIRED_HEADERS = ['content-security-policy', 'x-frame-options',
    'x-content-type-options', 'referrer-policy', 'permissions-policy'];
  const headerRows = await win.evaluate(async (paths) => {
    const out = [];
    for (const p of paths) {
      try {
        const r = await fetch(p, { cache: 'no-store' });
        const h = {};
        r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
        out.push([p, r.status, h]);
      } catch (e) { out.push([p, 'threw: ' + String(e.message).slice(0, 40), {}]); }
    }
    return out;
  }, HEADER_PATHS);
  rec('10f CONTROL: every header path was actually fetched (an empty list passes the loop below '
    + 'for free)', headerRows.length === HEADER_PATHS.length
    && headerRows.every(([, status]) => typeof status === 'number'),
    JSON.stringify(headerRows.map(([p, s]) => [p, s])));
  for (const [p, , h] of headerRows) {
    const missing = REQUIRED_HEADERS.filter((k) => !h[k]);
    rec(`10f. ${p} is served with every baseline security header`,
      missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'all present');
  }
  // The CSP's three directives by NAME, not just "a CSP header exists": a
  // header trimmed to one directive would satisfy the presence check above
  // while dropping the protection that matters.
  const csp = String(headerRows.find(([p]) => p === '/')?.[2]['content-security-policy'] || '');
  for (const directive of ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'"]) {
    rec(`10f. the CSP still carries ${directive}`, csp.includes(directive), `csp: ${csp}`);
  }
  // …and base-uri ENFORCED, not merely declared. An injected <base> must not
  // re-resolve the page's relative URLs to another origin.
  const rebased = await win.evaluate(() => {
    const b = document.createElement('base');
    b.href = 'https://evil.example/';
    document.head.appendChild(b);
    const a = document.createElement('a');
    a.href = '/api/games';
    const resolved = a.href;
    b.remove();
    return resolved;
  });
  rec('10f. an injected <base href> does NOT retarget the page\'s relative URLs',
    rebased.startsWith('http://127.0.0.1:'), `/api/games resolved to ${rebased}`);

  // ── 11. THE BRIDGE FORWARDS ANYTHING; MAIN IS WHAT MUST VALIDATE. ───────
  // Asserted by EFFECT on the native window, not by the call returning — the
  // renderer cannot see the handler's verdict, so "it did not throw" says
  // nothing at all.
  const colour = () => app.evaluate(({ BrowserWindow }) =>
    // BY URL, not by index. `getAllWindows()[0]` is whichever window Electron
    // lists first — when the 10d mutant added a second window, [0] became the
    // about:blank one and 11b/11c went red for a reason that had nothing to do
    // with the bridge. An index is not an identity; the app's window is the one
    // on the loopback origin.
    {
      const w = BrowserWindow.getAllWindows()
        .find((x) => /^http:\/\/127\.0\.0\.1:\d+/.test(x.webContents.getURL()));
      return w ? w.getBackgroundColor() : `NO LOOPBACK WINDOW among ${BrowserWindow.getAllWindows()
        .map((x) => x.webContents.getURL()).join(', ')}`;
    });
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
  //   THREE REGISTRIES, not one (gate review #6, finding 1 — reproduced).
  // `eventNames()` is ONLY the EventEmitter side: `ipcMain.handle()` stores
  // its handler in a separate `_invokeHandlers` map and never registers a
  // listener. MEASURED on the packaged app with
  // `ipcMain.handle('exfil-data', ...)` added to electron-main.cjs: 11d
  // reported "EXACTLY the one IPC channel" and the suite passed 24/24 while a
  // whole invoke-style capability shipped. `handle()` is the officially
  // recommended pattern for anything that returns a value, so this is the
  // likely shape of the next channel, not an exotic one.
  //   COUNTS, not just names: `eventNames()` collapses duplicates, so a second
  // real `.on('error', …)` would hide behind Electron's own sink. Verified on a
  // plain EventEmitter — eventNames stays ['error'] while listenerCount goes
  // 1 -> 2. The budget below is per-name, so that cannot hide either.
  const ELECTRON_OWN = { error: 1 };   // name -> listeners Electron itself adds
  const reg = await app.evaluate(({ ipcMain }) => ({
    on: ipcMain.eventNames().map(String).sort()
      .map((n) => [n, ipcMain.listenerCount(n)]),
    // `_invokeHandlers` is Electron-internal. If a future version renames it
    // this reads null and the check below FAILS rather than silently passing.
    invoke: ipcMain._invokeHandlers ? [...ipcMain._invokeHandlers.keys()].map(String).sort() : null,
  }));
  const ours = reg.on.filter(([n, c]) => c > (ELECTRON_OWN[n] ?? 0)).map(([n]) => n);
  const extraOnElectronsNames = reg.on
    .filter(([n, c]) => ELECTRON_OWN[n] !== undefined && c > ELECTRON_OWN[n]);
  rec('11d. the packaged main process registers EXACTLY the one IPC channel, on BOTH registries',
    JSON.stringify(ours) === JSON.stringify(['set-background-color'])
    && Array.isArray(reg.invoke) && reg.invoke.length === 0,
    `on=${JSON.stringify(reg.on)} invoke=${JSON.stringify(reg.invoke)} ours=${JSON.stringify(ours)} `
    + `— invoke must be [] (ipcMain.handle is invisible to eventNames), and null means the internal `
    + 'registry moved and this check can no longer see invoke handlers at all');
  rec('11d CONTROL: the subtracted name is present with exactly the expected listener count',
    Object.entries(ELECTRON_OWN).every(([n, c]) =>
      reg.on.some(([rn, rc]) => rn === n && rc === c)) && extraOnElectronsNames.length === 0,
    `expected ${JSON.stringify(ELECTRON_OWN)}, saw ${JSON.stringify(reg.on)} — a mismatch means `
    + 'either Electron changed what it registers (re-derive the budget) or something added a '
    + 'listener under one of its names');

  // ── 12. WHAT THE SESSION LEFT ON DISK. ─────────────────────────────────
  // Sweep 34. Everything above asks what the app ANSWERS; this asks what it
  // WROTE. The app's own files hold a session key and the whole library, and
  // this is the only harness that can see them after a real signed-in session
  // through the real binary.
  //   Scoped to the files the APP owns — Chromium's caches are Chromium's
  // business and their names churn between versions, so asserting on them
  // would be a rot factory. The control below keeps the scoping honest.
  //   ANCHORED AT A PATH SEPARATOR, not a bare prefix (gate review #6,
  // finding 2 — reproduced: the unanchored form excluded 'Cookies-backup.json',
  // 'Network-debug.log' and 'Singleton-user-token.txt', so any future app-owned
  // file starting with one of these words would silently escape BOTH the mode
  // audit and the password grep). A name must match the segment exactly, or be
  // a directory prefix followed by `/`. `Cookies-journal` and the two
  // `Trust Tokens-journal` files are Chromium's own, so they are listed.
  const CHROMIUM = /^(Cache|Code Cache|Dawn\w*Cache|GPUCache|Local Storage|Session Storage|blob_storage|Network|Shared Dictionary|Trust Tokens|Trust Tokens-journal|Cookies|Cookies-journal|SingletonCookie|SingletonLock|SingletonSocket|DevToolsActivePort|component_crx_cache|extensions_crx_cache)(\/|$)/;
  // CONTROL: the boundary must actually bite, or this is the prefix match again.
  for (const [name, shouldExclude] of [
    ['Cookies', true], ['Cookies/data_0', true], ['Cookies-backup.json', false],
    ['Network-debug.log', false], ['Singleton-user-token.txt', false],
    ['db.json', false], ['auth-secret', false],
  ]) {
    if (CHROMIUM.test(name) !== shouldExclude) {
      rec(`12 CONTROL: the Chromium filter treats ${JSON.stringify(name)} correctly`, false,
        `excluded=${CHROMIUM.test(name)} expected=${shouldExclude} — a bare-prefix filter hides `
        + 'app-owned files from the mode and password checks below');
    }
  }
  rec('12 CONTROL: the Chromium filter matches whole path segments, not prefixes',
    !CHROMIUM.test('Cookies-backup.json') && !CHROMIUM.test('Network-debug.log')
    && CHROMIUM.test('Cookies') && CHROMIUM.test('Cache/index'),
    'a prefix match would exempt any app file whose name starts with a Chromium directory name');
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
      const j = await r.json();
      return { status: r.status, names: Array.isArray(j) ? j.map((g) => g.name) : null, body: j };
    } catch (e) { return { error: String(e).slice(0, 100) }; }
  });
  rec('13c. OBSERVATION: the FIRST window still serves its library afterwards',
    survived.status === 200 && survived.names?.includes('SR63 REAL APP SAVE'),
    JSON.stringify(survived));
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}
// SR-47: the count is DECLARED, not counted — a silently skipped block
// otherwise prints "N/N passed" and exits 0. Measured: filtering one data
// array to empty in desktop-dead-token-owner removed six checks and the run
// said "37/37 checks passed".
const EXPECTED_CHECKS = 40;
if (out.length < EXPECTED_CHECKS) {
  console.error(`FAILED: only ${out.length} checks ran, expected at least ${EXPECTED_CHECKS} — a block was skipped.`);
  process.exit(1);
}
const bad = out.filter(r => !r.ok);
console.log(`\n${out.length - bad.length}/${out.length} passed`);
console.log('ALLDONE');
if (bad.length) process.exit(1);

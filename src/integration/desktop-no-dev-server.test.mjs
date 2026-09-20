/* INTEGRATION — a desktop build must never boot a Vite dev server.
 *
 * THE DEFECT (BLUE-LOOP-DESKTOP-22 / SR-56, found by this agent).
 * server.ts gated its dev branch on `process.env.NODE_ENV !== "production"`
 * alone, and called createViteServer() inside it. A packaged app inherits
 * NODE_ENV from whatever environment launched it; electron-main.cjs overwrites
 * it at line 183, so the ONLY thing between a shipped desktop app and a live
 * dev server was the ordering of one assignment — and the guard that checks
 * that ordering (electronenv.contract.test.ts) iterated the three rung-3 flags
 * and skipped NODE_ENV entirely, passing 24/24 with the line moved below the
 * require.
 *
 * MEASURED before the fix, real dist/server.cjs, packaged condition,
 * NODE_ENV=development IS_ELECTRON=true:
 *   the log printed "[vite] (client) Re-optimizing dependencies"
 *   GET / returned a shell carrying @vite/client AND @react-refresh
 * This is not a branch that fails shut in a packaged app: the shipped app.asar
 * carries vite, rollup, tailwind, postcss, babel, react-refresh and
 * lightningcss, and app.asar.unpacked ships esbuild's 9.9MB native binary,
 * which runs from inside the bundle (`--version` -> 0.25.12). So it works, in
 * a bundle with no src/ tree to serve.
 *
 * THE FIX: the dev branch requires IS_ELECTRON !== 'true' as well.
 *
 * WHY THIS CANNOT PASS BY COINCIDENCE: the CONTROL boots the SAME bundle with
 * the desktop flag removed and requires that Vite DOES appear. Without it,
 * "no @vite/client" would also be the reading for a server that failed to
 * start, for a broken locator, or for a build with the dev branch deleted
 * outright — three ways to be green while measuring nothing.
 *
 *   node src/integration/desktop-no-dev-server.test.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(repo, 'dist/server.cjs');
const DESKTOP_PORT = process.env.NO_DEV_SERVER_PORT || '3199';
const WEB_PORT = process.env.NO_DEV_SERVER_WEB_PORT || '3200';

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

/**
 * Boot the production bundle with a hostile NODE_ENV and return what it serves.
 * cwd is a temp dir, never the repo: dotenv would otherwise load this
 * checkout's .env and hand the app credentials a packaged build never has.
 */
async function boot(port, extraEnv) {
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-no-dev-'));
  const child = spawn(process.execPath, [BUNDLE], {
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      // The hostile value in BOTH arms. The desktop arm must ignore it; the
      // control arm must honour it. Same input, so the only difference
      // between the two readings is the desktop flag.
      NODE_ENV: 'development',
      PORT: port,
      ELECTRON_USER_DATA_PATH: userData,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok && (await r.json())?.pid === child.pid) { up = true; break; }
    } catch { /* not yet */ }
    await sleep(250);
  }
  let shell = '';
  if (up) {
    try { shell = await (await fetch(`${base}/`)).text(); } catch { shell = ''; }
  }
  return { child, up, shell, log: () => log, userData };
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

// The two markers Vite's transformIndexHtml injects. Named separately so a
// failure says which one appeared.
const DEV_MARKERS = ['/@vite/client', '/@react-refresh'];

let desktop = null;
let web = null;
try {
  // ── THE DESKTOP ARM: IS_ELECTRON=true, hostile NODE_ENV.
  desktop = await boot(DESKTOP_PORT, { IS_ELECTRON: 'true' });
  record('the desktop-condition server starts at all', desktop.up,
    desktop.up ? `pid ${desktop.child.pid}` : desktop.log().slice(-400));

  for (const marker of DEV_MARKERS) {
    record(`a desktop build never serves ${marker}`,
      !desktop.shell.includes(marker),
      `NODE_ENV=development IS_ELECTRON=true, ${desktop.shell.length} bytes`);
  }
  record('a desktop build never boots the Vite dev server',
    !/\[vite\]/.test(desktop.log()),
    `log mentions of "[vite]": ${(desktop.log().match(/\[vite\]/g) || []).length}`);
  // …and it must still serve the real app, not merely nothing. A server that
  // answered 404 everywhere would satisfy every check above.
  record('a desktop build still serves the built SPA shell',
    desktop.shell.includes('<div id="root">'),
    `${desktop.shell.length} bytes`);

  // ── THE CONTROL: the same bundle, the same hostile NODE_ENV, WITHOUT the
  //    desktop flag. Vite must appear. If it does not, the checks above are
  //    measuring a dev branch that is broken or gone, not a gate that works,
  //    and `npm run dev` is silently serving a stale dist/ to every developer.
  web = await boot(WEB_PORT, {});
  record('CONTROL: the web-condition server starts at all', web.up,
    web.up ? `pid ${web.child.pid}` : web.log().slice(-400));
  const injected = DEV_MARKERS.filter((m) => web.shell.includes(m));
  record('CONTROL: without IS_ELECTRON the dev branch still runs Vite',
    injected.length > 0,
    `injected: ${JSON.stringify(injected)} — if this fails, the gate above is passing `
    + 'because the dev server is broken, not because it is correctly refused');
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

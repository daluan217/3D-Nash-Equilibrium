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

  // Asking for Vite's endpoints DIRECTLY, not only reading the shell. The
  // director reproduced this on main with an empty cwd, where Vite had no
  // index.html to transform: GET / was a 404 with no markers — the
  // shell-scraping checks above would have read that as clean — while
  // GET /@vite/client returned 200 and 182,765 bytes of live dev client.
  // So the endpoints are probed by SIZE as well as status: the SPA fallback
  // answers 200 for every unknown path, and at ~2.5KB it is unmistakable
  // next to Vite's real module output.
  for (const route of ['/@vite/client', '/@react-refresh', '/src/main.tsx']) {
    const res = await fetch(`http://127.0.0.1:${DESKTOP_PORT}${route}`);
    const body = await res.text();
    const isDevModule = res.status === 200 && body.length > 20000;
    record(`a desktop build does not serve ${route} from a dev server`,
      !isDevModule,
      `status=${res.status} bytes=${body.length} (the SPA fallback is ~2.5KB; `
      + "Vite's client is ~180KB)");
  }
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
  // The control asks "is the dev branch alive at all?" and it must be able to
  // answer without asserting a value only ONE host can produce. On ubuntu CI
  // it cannot: Vite pulls in rollup's native module and npm's optional-
  // dependency bug leaves the wrong platform's binary installed
  // ("Cannot find module @rollup/rollup-darwin-x64" on a Linux runner), so
  // createViteServer throws, the server falls through to the static branch,
  // and NOTHING is injected — while the product is perfectly correct.
  //
  // MEASURED both ways: locally the web arm injects /@vite/client (182,753
  // bytes); in CI it injects nothing and the log carries the rollup error.
  // Asserting "Vite must inject" is therefore an SR-46-class check — one that
  // measures the HOST, not the shipping condition. This one caught itself on
  // its first CI run, which is the point of running it there.
  //
  // So: the dev branch must REACH Vite, proven by either outcome — the client
  // injected, or a Vite/rollup failure in the log. What is NOT acceptable is
  // the third outcome: a clean run with no Vite and no error, which is what a
  // deleted or short-circuited dev branch looks like, and which would make
  // every desktop check above pass for free.
  // WHAT THIS CONTROL MAY ASSERT, arrived at by getting it wrong twice.
  //
  // Attempt 1 — "the shell must carry /@vite/client". Passed locally, FAILED
  // in CI. Attempt 2 — "the log must mention vite or rollup". Passed
  // everywhere and proved NOTHING: the vite import is TOP-LEVEL, so every
  // boot prints "…loading ES Module …/vite/dist/node/index.js using
  // require()" whether the branch runs or not; with the dev branch replaced
  // by `if (false)` it still passed 10/10.
  //
  // The reason attempt 1 split is worth writing down, because it is a
  // worktree artifact and not a product difference: Vite's root is the child's
  // cwd (a temp dir) and it walks UP looking for a config and an index.html.
  // In an agent worktree `node_modules` is a SYMLINK to the main checkout, so
  // that walk lands in a directory that HAS an index.html and Vite transforms
  // it. On CI, node_modules is real and there is nothing to find, so Vite
  // starts and serves nothing. Both are the dev branch behaving correctly.
  //
  // So the only thing this control can honestly assert is that the branch was
  // ENTERED, and the one observable that means exactly that — in both
  // environments, and only when the branch runs — is the dev server ANSWERING
  // for a path the production build has no file for. `/@vite/client` is
  // Vite's own endpoint: served when its middleware is mounted, 404 or the
  // SPA fallback when it is not.
  const injected = DEV_MARKERS.filter((m) => web.shell.includes(m));
  const viteRes = await fetch(`http://127.0.0.1:${WEB_PORT}/@vite/client`);
  const viteBody = await viteRes.text();
  const viteMounted = viteRes.status === 200 && viteBody.length > 20000;
  record('CONTROL: without IS_ELECTRON the dev middleware is still MOUNTED',
    viteMounted || injected.length > 0,
    `GET /@vite/client -> ${viteRes.status} ${viteBody.length}b; markers in the shell: `
    + `${JSON.stringify(injected)}. Neither means the dev branch is gone or short-circuited `
    + 'rather than refused, which would make every desktop check above pass for free. '
    + `Log tail: ${web.log().trim().split('\n').slice(-3).join(' | ').slice(0, 250)}`);
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

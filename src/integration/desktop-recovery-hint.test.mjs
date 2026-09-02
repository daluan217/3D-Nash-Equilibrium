/* INTEGRATION — the desktop recovery hint, over HTTP against the real
 * production artifact, under the PACKAGED condition.
 *
 * THE DEFECT THIS GUARDS (RED-DESKTOP-3,
 * findings/RED-DESKTOP-3/002-upgrade-hides-old-account-games-silently.md):
 * a desktop install that predates the "local owner" feature has its saved
 * game(s) parked under a real, named account. Opened with the current build,
 * unauthenticated `GET /api/games` returns 200 [] — a clean, valid, EMPTY
 * list — genuinely indistinguishable from "never saved anything here," while
 * `GET /api/auth/me` correctly 401s the same request. Nothing in the app told
 * a returning user that signing in would recover their games.
 *
 * THE FIX: `GET /api/auth/desktop-hint` answers one boolean — whether a
 * non-local-owner account with at least one saved game exists on this
 * machine — without ever naming the account or its games, so it is safe to
 * call before the user has proven who they are.
 *
 * WHY THE cwd MATTERS: same reason as desktop-persistence.test.mjs — the
 * server is booted from a temp directory, never the repo, so dotenv finds no
 * `.env` and the measurement stays on the packaged condition.
 *
 *   node src/integration/desktop-recovery-hint.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(serverDir, 'dist/server.cjs');
let port = Number(process.env.RECOVERY_HINT_PORT || 3111);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function boot(userData, thePort, extraEnv = {}) {
  const child = spawn('node', [BUNDLE], {
    cwd: userData,
    env: {
      PATH: process.env.PATH,
      HOME: userData,
      NODE_ENV: 'production',
      PORT: String(thePort),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming ready on ${thePort} (code ${child.exitCode})\n${log}`);
    }
    try {
      // Bounded: an unbounded fetch here could hang past this loop's own
      // retry budget if the health endpoint accepted the connection but
      // never completed the response.
      const r = await fetch(`http://127.0.0.1:${thePort}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok && (await r.json())?.pid === child.pid) return child;
    } catch { /* not up yet, or the health check itself timed out */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready on ${thePort}\n${log}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((res) => child.once('exit', res));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  await ended;
  clearTimeout(timer);
}

let srv = null;

try {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. FRESH INSTALL: no other accounts -> false. Checked FIRST as the
  // negative control — a predicate that is true on everything is not a check.
  // ───────────────────────────────────────────────────────────────────────────
  const freshUD = mkdtempSync(path.join(tmpdir(), 'nash-hint-fresh-'));
  srv = await boot(freshUD, port, { IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: freshUD });
  const fresh = await (await fetch(`http://127.0.0.1:${port}/api/auth/desktop-hint`)).json();
  record('a brand-new install reports hasOtherAccounts: false',
    fresh?.hasOtherAccounts === false, JSON.stringify(fresh));

  // Save one game as the local owner — still no OTHER account, still false.
  const localSave = await fetch(`http://127.0.0.1:${port}/api/games`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Local owner game',
      payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 },
    }),
  });
  // Fixture precondition, not the interesting check: without this, a SILENT
  // save failure would make "still false" pass VACUOUSLY (no local-owner
  // game was ever added, so of course the predicate stays false — that
  // proves nothing about whether the predicate correctly ignores the local
  // owner's own games, only that setup itself didn't do anything) —
  // CodeRabbit caught this: a setup failure was indistinguishable from a
  // passing filtering check.
  record('fixture precondition: the local-owner save itself succeeded',
    localSave.status === 200, `status ${localSave.status}`);
  const stillFresh = await (await fetch(`http://127.0.0.1:${port}/api/auth/desktop-hint`)).json();
  record('a local-owner-only install (its own games) still reports false',
    stillFresh?.hasOtherAccounts === false, JSON.stringify(stillFresh));
  await stop(srv); srv = null;
  rmSync(freshUD, { recursive: true, force: true });
  port += 1;

  // ───────────────────────────────────────────────────────────────────────────
  // 2. THE DEFECT: a pre-local-owner install with a real account + game
  // ───────────────────────────────────────────────────────────────────────────
  const legacyUD = mkdtempSync(path.join(tmpdir(), 'nash-hint-legacy-'));
  const legacyDb = {
    users: [{
      id: 'u_legacy1', username: 'olduser', email: 'olduser@example.com',
      // A legacy base64 hash, not pbkdf2 — the exact pre-migration shape.
      passwordHash: Buffer.from('hunter22').toString('base64'),
      isVerified: true, verificationCode: '', verificationCodeExpires: 0,
    }],
    games: [{
      id: 'g_legacy1', userId: 'u_legacy1', name: 'Old Saved Game',
      description: 'saved before local-owner shipped',
      payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 },
      createdAt: '2026-07-01T00:00:00.000Z',
    }],
  };
  writeFileSync(path.join(legacyUD, 'db.json'), JSON.stringify(legacyDb, null, 2), 'utf-8');
  srv = await boot(legacyUD, port, { IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: legacyUD });

  const gamesResp = await fetch(`http://127.0.0.1:${port}/api/games`);
  const gamesJson = await gamesResp.json();
  record('THE ORIGINAL SYMPTOM STILL HOLDS: unauthenticated GET /api/games is 200 []',
    gamesResp.status === 200 && Array.isArray(gamesJson) && gamesJson.length === 0,
    `status ${gamesResp.status}, ${JSON.stringify(gamesJson)}`);

  const meResp = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
  record('GET /api/auth/me still correctly 401s the same unauthenticated request',
    meResp.status === 401, `status ${meResp.status}`);

  const hint = await (await fetch(`http://127.0.0.1:${port}/api/auth/desktop-hint`)).json();
  record('THE FIX: desktop-hint reports hasOtherAccounts: true for this machine',
    hint?.hasOtherAccounts === true, JSON.stringify(hint));

  // The hint must never leak WHICH account or WHAT games — only the boolean.
  const hintKeys = Object.keys(hint || {});
  record('the hint response carries ONLY the boolean, nothing account-identifying',
    hintKeys.length === 1 && hintKeys[0] === 'hasOtherAccounts', JSON.stringify(hint));

  // Signing in still recovers the game (the existing half of the upgrade path).
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'olduser@example.com', password: 'hunter22' }),
  });
  const loginJson = await login.json();
  record('signing in with the legacy (base64) password still works',
    login.status === 200 && typeof loginJson?.token === 'string', `status ${login.status}`);

  if (loginJson?.token) {
    const authedGames = await fetch(`http://127.0.0.1:${port}/api/games`, {
      headers: { authorization: `Bearer ${loginJson.token}` },
    });
    const authedJson = await authedGames.json();
    record('after sign-in the old game is visible',
      Array.isArray(authedJson) && authedJson.some((g) => g.name === 'Old Saved Game'),
      JSON.stringify(authedJson));
  } else {
    record('after sign-in the old game is visible', false, 'no token to check with');
  }

  await stop(srv); srv = null;
  rmSync(legacyUD, { recursive: true, force: true });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. THE WEB PATH IS UNCHANGED: no IS_ELECTRON -> always false, cheaply
  // ───────────────────────────────────────────────────────────────────────────
  port += 1;
  const webCwd = mkdtempSync(path.join(tmpdir(), 'nash-hint-web-'));
  srv = await boot(webCwd, port);
  const webHint = await (await fetch(`http://127.0.0.1:${port}/api/auth/desktop-hint`)).json();
  record('the hosted (non-Electron) path always answers false, never touches disk semantics',
    webHint?.hasOtherAccounts === false, JSON.stringify(webHint));
  await stop(srv); srv = null;
  rmSync(webCwd, { recursive: true, force: true });

} finally {
  await stop(srv);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

/* INTEGRATION — the admin CORS gate must agree with the router it protects.
 *
 * THE DEFECT (BLUE-LOOP-DESKTOP-22 / SR-50, found by this agent):
 * Express routes case-INSENSITIVELY unless `caseSensitive` is set, and it is
 * not. So `GET /api/ADMIN/stats` is served by the same handler as
 * `/api/admin/stats` — while the CORS middleware asked
 * `req.path.startsWith("/api/admin/")`, which is case-SENSITIVE. The uppercase
 * spelling therefore fell to the else-branch and got
 * `Access-Control-Allow-Origin: *`.
 *
 * MEASURED before the fix, with a valid x-admin-secret and Origin:
 * https://evil.example —
 *   /api/admin/stats  -> 200, ACAO absent          (correctly gated)
 *   /api/ADMIN/stats  -> 200, ACAO: *              <-- admin PII, any origin
 *   /API/ADMIN/STATS  -> 200, ACAO: *              <-- same
 * The body in every case is the real stats object (totalUsers, verifiedUsers,
 * unverifiedUsers, totalGames), so a page on any domain could read it with a
 * plain fetch once it had the secret — and `*` is exactly what tells a browser
 * that is allowed.
 *
 * THE FIX: the gate lowercases req.path before the prefix test.
 *
 * WHY THIS CANNOT PASS BY COINCIDENCE: the CONTROL asserts a NON-admin route
 * still receives `*`. If the middleware were simply broken, or the server were
 * not serving at all, the control fails and the suite reports it — a missing
 * ACAO header everywhere would otherwise look like a clean pass.
 *
 *   node src/integration/admin-cors-case.test.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = process.env.ADMIN_CORS_PORT || '3196';
const BASE = `http://127.0.0.1:${PORT}`;
const repo = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(repo, 'dist/server.cjs');
const SECRET = 'admin-cors-case-test-secret';
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

const userData = mkdtempSync(path.join(tmpdir(), 'nash-admin-cors-'));
const child = spawn(process.execPath, [BUNDLE], {
  cwd: tmpdir(),
  env: {
    PATH: process.env.PATH,
    HOME: userData,
    NODE_ENV: 'production',
    PORT,
    ELECTRON_USER_DATA_PATH: userData,
    ADMIN_SECRET: SECRET,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer(timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok || r.status === 404) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

try {
  if (!await waitForServer()) throw new Error('the server never came up');

  // Every casing Express will route to the admin handler.
  const SPELLINGS = [
    '/api/admin/stats',
    '/api/ADMIN/stats',
    '/API/ADMIN/STATS',
    '/api/Admin/stats',
    '/Api/Admin/Stats',
  ];
  for (const route of SPELLINGS) {
    const res = await fetch(`${BASE}${route}`, {
      headers: { Origin: HOSTILE, 'x-admin-secret': SECRET },
    });
    const body = await res.text();
    const acao = res.headers.get('access-control-allow-origin');
    const servesAdminData = /"totalUsers"/.test(body);

    // The real assertion: if this spelling REACHES the admin handler, it must
    // NOT be readable by an arbitrary origin. A 404 is fine too (not routed).
    record(`${route} never returns admin data to an arbitrary origin`,
      !(servesAdminData && (acao === '*' || acao === HOSTILE)),
      `status=${res.status} acao=${acao} adminData=${servesAdminData}`);
  }

  // A route that reaches the handler proves the spellings above are real.
  const canonical = await fetch(`${BASE}/api/admin/stats`, {
    headers: { Origin: HOSTILE, 'x-admin-secret': SECRET },
  });
  const canonicalBody = await canonical.text();
  record('CONTROL: the admin route really does serve stats with a valid secret',
    canonical.status === 200 && /"totalUsers"/.test(canonicalBody),
    `status=${canonical.status} body=${canonicalBody.slice(0, 60)}`);

  const upper = await fetch(`${BASE}/api/ADMIN/stats`, {
    headers: { Origin: HOSTILE, 'x-admin-secret': SECRET },
  });
  const upperBody = await upper.text();
  record('CONTROL: Express really is case-insensitive here, so the gate must be too',
    upper.status === 200 && /"totalUsers"/.test(upperBody),
    'if this ever fails, Express started routing case-sensitively and the '
    + 'checks above would pass for a reason unrelated to the CORS gate');

  // CONTROL: an ordinary route must still be reachable cross-origin, or the
  // "no ACAO" results above could just mean CORS is switched off entirely.
  const health = await fetch(`${BASE}/api/health`, { headers: { Origin: HOSTILE } });
  record('CONTROL: a non-admin route still gets a permissive ACAO',
    health.headers.get('access-control-allow-origin') === '*',
    `acao=${health.headers.get('access-control-allow-origin')}`);

  // The secret itself must still be required — this suite must not be the
  // reason a missing-secret regression slips through.
  const noSecret = await fetch(`${BASE}/api/admin/stats`, { headers: { Origin: HOSTILE } });
  record('CONTROL: without the secret the admin route refuses',
    noSecret.status === 401 || noSecret.status === 403,
    `status=${noSecret.status}`);
} catch (err) {
  record('suite ran to completion', false, String(err && err.message));
} finally {
  child.kill('SIGKILL');
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

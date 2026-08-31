/* LIVE-SITE smoke — the post-deploy layer of the testing pyramid.
 *
 * Everything else in the pyramid runs on GitHub runners against the build
 * artifact. This script verifies what the USER actually gets: the live
 * nash-equilibrium-simulator.com after the Netlify/Cloud Run deploy lands.
 * Read-only by design — no accounts are created, no game is saved, no model
 * is called (the report route is probed with an INVALID matrix, which
 * exercises routing and validation without spending a token).
 *
 * Deploy verification: when EXPECTED_INDEX points at the index.html built by
 * the triggering Test run, the script polls the live site until it serves
 * THAT build's hashed asset (the deploy landed), then checks the live
 * surfaces. Without it (nightly monitor mode) the checks run immediately.
 *
 *   LIVE_BASE=https://nash-equilibrium-simulator.com \
 *   EXPECTED_INDEX=dist/index.html node src/e2e/live-smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = (process.env.LIVE_BASE || 'https://nash-equilibrium-simulator.com').replace(/\/$/, '');
// how long to wait for the deploy to land after the merge (minutes)
const WAIT_MINUTES = Number(process.env.LIVE_WAIT_MINUTES || 15);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function getText(path, opts) {
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text().catch(() => '');
  return { status: r.status, text, headers: r.headers };
}

// ── wait for the deploy: the live index.html must reference the SAME hashed
//    asset as the build we are verifying (a stale deploy serves the old hash)
let expectedAsset = null;
if (process.env.EXPECTED_INDEX) {
  const built = readFileSync(process.env.EXPECTED_INDEX, 'utf8');
  expectedAsset = (built.match(/assets\/[\w.-]+\.js/) || [])[0] || null;
  if (!expectedAsset) throw new Error(`could not find an asset reference in ${process.env.EXPECTED_INDEX}`);
  console.log(`waiting for the live site to serve this build's asset: ${expectedAsset}`);
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  let live = null;
  while (Date.now() < deadline) {
    live = await getText('/');
    if (live.status === 200 && live.text.includes(expectedAsset)) break;
    live = null;
    await sleep(15_000);
  }
  record('the live site serves THIS commit\'s build (by asset hash)', !!live,
    live ? expectedAsset : `still not serving ${expectedAsset} after ${WAIT_MINUTES}min`);
  if (!live) {
    // nothing else is meaningful against a stale/not-yet-deployed site
    const fails = results.filter((r) => !r.pass);
    console.log(`\n══════ LIVE SMOKE: ${results.length - fails.length}/${results.length} checks passed ══════`);
    fails.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
    process.exit(1);
  }
}

// ══ 1. the page itself
{
  const home = await getText('/');
  const ok = home.status === 200 && /Nash Equilibrium/i.test(home.text) && /assets\//.test(home.text);
  record('the live site serves the app page', ok, `status=${home.status}`);
}

// ══ 2. the page's own bundle resolves (catches a deploy where index.html
//      references a chunk that did not upload)
{
  const home = await getText('/');
  const asset = (home.text.match(/assets\/[\w.-]+\.js/) || [])[0];
  if (asset) {
    const js = await getText(`/${asset}`);
    record('the live page\'s JS bundle resolves', js.status === 200 && js.text.length > 1000,
      `status=${js.status} bytes=${js.text.length}`);
  } else {
    record('the live page\'s JS bundle resolves', false, 'no asset reference found in the page');
  }
}

// ══ 3. API liveness behind the same domain
{
  const r = await getText('/api/health');
  record('live /api/health is 200', r.status === 200, `status=${r.status}`);
  const nosniff = r.headers.get('x-content-type-options');
  const xfo = r.headers.get('x-frame-options');
  record('live security headers present', nosniff === 'nosniff' && xfo === 'DENY',
    `nosniff=${nosniff} xfo=${xfo}`);
}

// ══ 4. build metadata (informational: the version source updates with the
//      desktop release pipeline, which lags the web deploy — never a failure)
{
  const r = await getText('/api/version');
  let version = null;
  try { version = JSON.parse(r.text).version; } catch { /* not json */ }
  console.log(`INFO live /api/version → ${version} (repo: ${process.env.EXPECTED_VERSION || 'unknown'})`);
  record('live /api/version answers 200 JSON', r.status === 200 && version !== undefined,
    `status=${r.status} version=${version}`);
}

// ══ 5. the report route is wired and validating BEFORE any model call —
//      an invalid matrix must 400 without spending a token
{
  const r = await fetch(`${BASE}/api/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payoffs: { a11: 'not-a-number' } }),
  });
  record('live /api/report rejects an invalid matrix with 400 (no model call)',
    r.status === 400, `status=${r.status}`);
}

// ══ 6. CORS preflight still answers PATCH (the desktop save path — the exact
//      header that once broke every cross-origin save in production)
{
  const r = await fetch(`${BASE}/api/games`, {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'PATCH' },
  });
  const methods = r.headers.get('access-control-allow-methods') || '';
  record('live CORS preflight allows PATCH (desktop save path)',
    r.status === 200 && methods.includes('PATCH'), `status=${r.status} methods=${methods}`);
}

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ LIVE SMOKE: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length) fails.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
process.exit(fails.length ? 1 : 0);

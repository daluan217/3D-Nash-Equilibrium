/* INTEGRATION — PATCH /api/games/:id colour-term pairing across two
 * INDEPENDENT requests (two tabs/devices), not just one request's own two
 * fields.
 *
 * THE DEFECT (RED-REGEN-7/001, director-reproduced): the Edit dialog sends
 * only the colour-term field it changed (RED-APP-10/001's own fix, #126),
 * and the server pairs a lone submitted array against the game's CURRENTLY
 * STORED other side (also #126) so a phrase can never end up owned by both
 * players. That pairing is correct for ONE request's own two fields, but it
 * silently re-runs across TWO INDEPENDENT requests that never saw each
 * other: tab A patches only colorTermsA, tab B (from a snapshot that never
 * saw A's edit) patches only colorTermsB with the same real-world phrase in
 * a different spelling ("wolf" vs "Wolf" — ordinary, no typography trick).
 * Depending on commit order, either the SECOND submitter's own new chip is
 * silently dropped (their field gets written empty, 200 "success"), or the
 * FIRST submitter's already-committed chip is silently destroyed by the
 * second commit's completely unrelated PATCH (which never even named the
 * field it erases). Both report success to the losing side.
 *
 * THE FIX: the PATCH handler now distinguishes "this request's own two
 * fields collided with each other" (the ORIGINAL, still-supported case —
 * #126/CodeRabbit's "an explicitly submitted side is written even when the
 * pairing empties it") from "the pairing would only fire because the OTHER
 * side came from STORAGE, not from this request" — the shape unique to two
 * independent requests. The latter refuses with 409 instead of writing,
 * naming the collision, so the losing tab can reopen Edit and resolve it
 * instead of silently losing data. See server.ts, PATCH /api/games/:id,
 * "RED-REGEN-7/001" comment.
 *
 * MUTATION: reverting the 409 guard (restoring the pre-fix
 * `if (!hasA || explicitA || ...)` / `if (!hasB || explicitB || ...)` writes
 * unconditionally) makes checks 1-4 below fail — they assert r2.status is
 * 409 and that the loser's data never changed; the pre-fix tree returns 200
 * both times and silently drops or destroys a chip. Checks 5-7 must keep
 * passing on BOTH trees (they guard the behaviour this fix must not break).
 *
 *   node src/integration/colorterms-patch-race.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = process.env.COLORTERMS_RACE_PORT || '3182';
const BASE = `http://localhost:${PORT}`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, p, body, token) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

const MP = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };

async function freshUserAndGame(tag) {
  const rand = Math.random().toString(36).slice(2, 10);
  const email = `ctr-${tag}-${Date.now()}-${rand}@example.test`;
  const username = `ctr${rand}`.slice(0, 30);
  const password = 'TestPass123';
  const reg = await api('POST', '/api/auth/register', { username, email, password });
  if (!reg.json?.success) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const login = await api('POST', '/api/auth/login', { email, password });
  const token = login.json?.token;
  if (!token) throw new Error(`login failed: ${JSON.stringify(login)}`);
  const create = await api('POST', '/api/games', {
    name: `CTR-${tag}`, payoffs: MP,
    row1Label: 'Cooperate', row2Label: 'Defect', col1Label: 'Cooperate', col2Label: 'Defect',
  }, token);
  const gameId = create.json?.game?.id;
  if (!gameId) throw new Error(`create failed: ${JSON.stringify(create)}`);
  return { token, gameId };
}

// ── boot the production server ───────────────────────────────────────────
const userData = mkdtempSync(path.join(tmpdir(), 'nash-ctrace-'));
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
const serverDir = path.resolve(import.meta.dirname, '../..');
const server = spawn('node', [path.join(serverDir, 'dist/server.cjs')], {
  cwd: userData,
  env: { ...process.env, NODE_ENV: 'production', PORT, ELECTRON_USER_DATA_PATH: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
if (!(await waitReady())) {
  console.error('FAIL server never became ready');
  server.kill('SIGKILL');
  process.exit(2);
}

try {
  // ══ 1-2. THE DEFECT, both commit orders ────────────────────────────────
  // Two independent tabs, each sending only the field it means to change,
  // each naming the SAME real-world phrase in a different colorTermKey-equal
  // spelling ("wolf" vs "Wolf" — case only, no unicode trick needed).
  for (const [label, firstIsA] of [['A-first', true], ['B-first', false]]) {
    const { token, gameId } = await freshUserAndGame(`order-${label}`);
    const patchA = { allowClear: true, colorTermsA: ['wolf'] };
    const patchB = { allowClear: true, colorTermsB: ['Wolf'] };
    const [first, second, firstSide] = firstIsA ? [patchA, patchB, 'A'] : [patchB, patchA, 'B'];

    const r1 = await api('PATCH', `/api/games/${gameId}`, first, token);
    const r2 = await api('PATCH', `/api/games/${gameId}`, second, token);
    const after = await api('GET', '/api/games', undefined, token);
    const games = Array.isArray(after.json) ? after.json : (after.json?.games ?? []);
    const game = games.find((g) => g.id === gameId);

    record(`[${label}] first commit succeeds (200)`, r1.status === 200, `status=${r1.status}`);
    record(`[${label}] second, colliding commit is REFUSED (409), not silently accepted`,
      r2.status === 409, `status=${r2.status} body=${JSON.stringify(r2.json)}`);
    record(`[${label}] the refusal names the conflict (a string error message, not empty)`,
      typeof r2.json?.error === 'string' && r2.json.error.length > 0, `error=${JSON.stringify(r2.json?.error)}`);
    // The FIRST commit's data must survive untouched — this is the exact
    // "already-committed chip silently destroyed" shape for the B-first
    // order, and the exact "second submitter's own chip silently dropped
    // while reporting success" shape for the A-first order; either way, a
    // refused second request must never have written ANYTHING.
    const expectFirstSide = firstSide === 'A' ? { colorTermsA: ['wolf'], colorTermsB: [] } : { colorTermsA: [], colorTermsB: ['Wolf'] };
    record(`[${label}] the first commit's own chip is INTACT after the refused second request`,
      JSON.stringify(game?.colorTermsA) === JSON.stringify(expectFirstSide.colorTermsA)
        && JSON.stringify(game?.colorTermsB) === JSON.stringify(expectFirstSide.colorTermsB),
      `stored A=${JSON.stringify(game?.colorTermsA)} B=${JSON.stringify(game?.colorTermsB)}, expected ${JSON.stringify(expectFirstSide)}`);
  }

  // ══ 3. REGRESSION (RED-APP-10/001): two independent, NON-colliding
  //      per-field edits must both still succeed — the guard must not
  //      refuse ordinary, unrelated concurrent edits.
  {
    const { token, gameId } = await freshUserAndGame('noncolliding');
    const r1 = await api('PATCH', `/api/games/${gameId}`, { allowClear: true, colorTermsA: ['the hedge'] }, token);
    const r2 = await api('PATCH', `/api/games/${gameId}`, { allowClear: true, colorTermsB: ['the pond'] }, token);
    record('REGRESSION (RED-APP-10/001): two independent NON-colliding per-field edits both succeed',
      r1.status === 200 && r2.status === 200
        && JSON.stringify(r2.json?.game?.colorTermsA) === JSON.stringify(['the hedge'])
        && JSON.stringify(r2.json?.game?.colorTermsB) === JSON.stringify(['the pond']),
      `r1=${r1.status} r2=${r2.status} finalA=${JSON.stringify(r2.json?.game?.colorTermsA)} finalB=${JSON.stringify(r2.json?.game?.colorTermsB)}`);
  }

  // ══ 4. REGRESSION (#126/CodeRabbit): a SINGLE request naming BOTH fields,
  //      whose own two submissions collide with EACH OTHER, is unchanged —
  //      this is not two independent requests, it's one request's own
  //      self-collision (the client's chip-picker never produces this from
  //      real use, but the contract stays: write the emptied side, 200).
  {
    const { token, gameId } = await freshUserAndGame('selfcollision');
    const r = await api('PATCH', `/api/games/${gameId}`, { allowClear: true, colorTermsA: ['wolf'], colorTermsB: ['Wolf'] }, token);
    record('REGRESSION (#126): one request naming BOTH colliding fields still succeeds (200), B emptied',
      r.status === 200 && JSON.stringify(r.json?.game?.colorTermsA) === JSON.stringify(['wolf'])
        && JSON.stringify(r.json?.game?.colorTermsB) === JSON.stringify([]),
      `status=${r.status} A=${JSON.stringify(r.json?.game?.colorTermsA)} B=${JSON.stringify(r.json?.game?.colorTermsB)}`);
  }

  // ══ 5. Idempotent resubmit: re-sending the SAME pair that is already
  //      stored (no external change happened) must not spuriously 409 —
  //      the guard compares against what pairing WOULD produce, which is a
  //      no-op here.
  {
    const { token, gameId } = await freshUserAndGame('idempotent');
    await api('PATCH', `/api/games/${gameId}`, { allowClear: true, colorTermsA: ['a1'], colorTermsB: ['b1'] }, token);
    const r2 = await api('PATCH', `/api/games/${gameId}`, { allowClear: true, colorTermsA: ['a1'], colorTermsB: ['b1'] }, token);
    record('an idempotent resubmit of the already-stored pair does not 409',
      r2.status === 200, `status=${r2.status} body=${JSON.stringify(r2.json)}`);
  }

  // ══ 6. A request touching only labels/name (no colour-term fields at
  //      all) must never be affected by this guard, collision or not.
  {
    const { token, gameId } = await freshUserAndGame('nofields');
    await api('PATCH', `/api/games/${gameId}`, { allowClear: true, colorTermsA: ['wolf'] }, token);
    const r2 = await api('PATCH', `/api/games/${gameId}`, { name: 'Renamed' }, token);
    record('a PATCH naming neither colour-term field is never refused by this guard',
      r2.status === 200 && r2.json?.game?.name === 'Renamed'
        && JSON.stringify(r2.json?.game?.colorTermsA) === JSON.stringify(['wolf']),
      `status=${r2.status} name=${r2.json?.game?.name} A=${JSON.stringify(r2.json?.game?.colorTermsA)}`);
  }

  // ══ 7. A 409 must not have moved the database into a half-written state:
  //      re-reading the game right after the refusal must equal the
  //      pre-refusal stored state exactly (nothing partially applied).
  {
    const { token, gameId } = await freshUserAndGame('noPartialWrite');
    await api('PATCH', `/api/games/${gameId}`, { allowClear: true, colorTermsA: ['wolf'] }, token);
    const before = await api('GET', '/api/games', undefined, token);
    const beforeGame = (Array.isArray(before.json) ? before.json : before.json?.games ?? []).find((g) => g.id === gameId);
    const refused = await api('PATCH', `/api/games/${gameId}`, { allowClear: true, colorTermsB: ['Wolf'] }, token);
    const after = await api('GET', '/api/games', undefined, token);
    const afterGame = (Array.isArray(after.json) ? after.json : after.json?.games ?? []).find((g) => g.id === gameId);
    record('a 409-refused request leaves the stored record byte-identical to before it',
      refused.status === 409
        && JSON.stringify(afterGame?.colorTermsA) === JSON.stringify(beforeGame?.colorTermsA)
        && JSON.stringify(afterGame?.colorTermsB) === JSON.stringify(beforeGame?.colorTermsB),
      `before=${JSON.stringify({ a: beforeGame?.colorTermsA, b: beforeGame?.colorTermsB })} `
      + `after=${JSON.stringify({ a: afterGame?.colorTermsA, b: afterGame?.colorTermsB })}`);
  }
} catch (e) {
  record('suite completed without a script error', false, e.message.slice(0, 300));
}

server.kill('SIGKILL');
try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }

const fails = results.filter((r) => !r.pass);
console.log(`\n══════ COLOUR-TERM PATCH RACE: ${results.length - fails.length}/${results.length} checks passed ══════`);
if (fails.length) fails.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
process.exit(fails.length ? 1 : 0);

/**
 * Password hashing off the event loop (server.ts `derive`), run from the real source with a fake pbkdf2
 * (sweep 17: pbkdf2Sync, 37 ms a call, held /api/health at p50 636 ms under a login flood). At most HASH_SLOTS
 * run, HASH_QUEUE wait in order, the rest throw ServerBusy (503); a failing hash hands its slot on. The route
 * contract: no pbkdf2Sync anywhere, and login/verify re-read the row after their hash.
 *
 *   npx tsx src/hashqueue.cloud.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const from = src.indexOf('class ServerBusy extends Error {}');
const to = src.indexOf('\n}\n', src.indexOf('async function derive(')) + 2;
assert(from > 0 && to > from, 'ServerBusy/derive are gone from server.ts');
const js = ts.transpileModule(src.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
type Job = { resolve: (b: Buffer) => void; reject: (e: Error) => void };
const load = () => {
  const running: Job[] = [];
  const fake = () => (..._a: unknown[]) => new Promise<Buffer>((resolve, reject) => running.push({ resolve, reject }));
  const m = new Function('promisify', 'crypto', `${js}; return { derive, ServerBusy, HASH_SLOTS, HASH_QUEUE };`)(fake, { pbkdf2: null }) as {
    derive: (p: string, s: Buffer, i: number) => Promise<Buffer>; ServerBusy: new () => Error; HASH_SLOTS: number; HASH_QUEUE: number };
  return { ...m, running };
};
const tick = () => new Promise((r) => setImmediate(r));
let n = 0;
{
  const { derive, ServerBusy, HASH_SLOTS, HASH_QUEUE, running } = load();
  assert(HASH_SLOTS >= 1 && HASH_SLOTS <= 1, `one hash at a time: cloudbuild runs --cpu=1 (${HASH_SLOTS})`); n++;
  assert(HASH_QUEUE >= 8 && HASH_QUEUE * 37 <= 1500, `the queue holds about a second of work (${HASH_QUEUE} x 37 ms)`); n++;
  const done: number[] = [], busy: number[] = [], failed: number[] = [];
  const all = [...Array(HASH_SLOTS + HASH_QUEUE + 3).keys()].map((i) => derive('pw', Buffer.alloc(16), 1).then(() => done.push(i), (e) => (e instanceof ServerBusy ? busy : failed).push(i)));
  await tick();
  assert.strictEqual(running.length, HASH_SLOTS, `only ${HASH_SLOTS} hash(es) run at once (${running.length} started)`); n++;
  assert.deepStrictEqual(busy, [HASH_SLOTS + HASH_QUEUE, HASH_SLOTS + HASH_QUEUE + 1, HASH_SLOTS + HASH_QUEUE + 2], `past the queue, ServerBusy (${busy})`); n++;
  running[0].reject(new Error('boom'));
  await tick();
  assert.strictEqual(running.length, HASH_SLOTS + 1, 'a failed hash hands its slot to the next waiter'); n++;
  for (let k = 1; k < running.length; k++) { running[k].resolve(Buffer.alloc(32)); await tick(); }
  while (running.length < HASH_SLOTS + HASH_QUEUE) await tick();
  for (let k = 0; k < running.length; k++) running[k].resolve(Buffer.alloc(32));
  await Promise.all(all);
  assert.deepStrictEqual(failed, [0], `only the failed hash failed (${failed})`); n++;
  assert.deepStrictEqual(done, [...Array(HASH_SLOTS + HASH_QUEUE - 1).keys()].map((i) => i + 1), `waiters run in arrival order (${done})`); n++;
  const after = derive('pw', Buffer.alloc(16), 1);
  await tick();
  assert.strictEqual(running.length, HASH_SLOTS + HASH_QUEUE + 1, 'the queue drained: a new hash starts at once (no slot leaked)'); n++;
  running.at(-1)!.resolve(Buffer.alloc(32)); await after;
}

// Route contract.
assert(!/pbkdf2Sync/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'server.ts calls pbkdf2Sync (it blocks the event loop)'); n++;
const body = (route: string) => { const s = src.indexOf(`app.post("${route}"`); return src.slice(s, src.indexOf('\n  }));', s)); };
for (const r of ['/api/auth/register', '/api/auth/verify', '/api/auth/login', '/api/auth/reset-password']) {
  const b = body(r);
  const calls = [...b.matchAll(/(await\s+)?(hashPassword|verifyPassword)\(/g)];
  assert(calls.length > 0 && calls.every((m) => m[1]), `${r}: every hash call is awaited (${calls.map((m) => m[0])})`); n++;
  // Every hash happens before the route's LAST store read: the row it acts on is read after the await.
  const lastHash = Math.max(...calls.map((m) => m.index!)), read = b.indexOf('const db = loadDB();');
  assert(read > lastHash, `${r}: the store the route decides on is read after its last hash`); n++;
}
for (const r of ['/api/auth/login', '/api/auth/verify']) {
  assert(/throw new ServerBusy\(\)/.test(body(r)) && /passwordHash !== stored/.test(body(r)), `${r}: a row whose hash changed during the hash is refused, not signed in`); n++;
}
assert(/if \(err instanceof ServerBusy\) \{\s*setRetryAfter\(res, [^)]+\);\s*res\.status\(503\)\.json\(\{ error:/.test(src), 'the error handler answers ServerBusy with 503, Retry-After and an error'); n++;
console.log(`hashqueue.cloud: ${n} checks passed`);

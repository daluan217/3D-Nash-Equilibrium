/**
 * SYBIL FILL (cloud loop 22, TASK-13): a few free accounts saving max-size games filled the ONE
 * hosted db.json budget (8 MB), and from then on every other user's save was a 507 "storage is
 * full". Saved games now live in one GCS object per account with a per-account cap (2 MB), so
 * accounts that fill their own allowance are refused (413, the cap named) and nobody else is.
 * Runs the REAL store (server.ts, account-games store) on an in-memory bucket.
 *
 *   npx tsx src/sybilfill.cloud.test.ts
 */
import assert from 'node:assert';
import ts from 'typescript';
import { loadAccountGameStore, memoryBucket, storedGames, type Game } from './testing/accountGames.ts';

const { create, FULL, source } = await loadAccountGameStore();
let n = 0;

// ── The cap and its message, from the source ────────────────────────────────
const from = source.indexOf('const ACCOUNT_GAMES_MAX_BYTES = ');
const to = source.indexOf('\n', source.indexOf('const ACCOUNT_GAMES_FULL = '));
assert(from > 0 && to > from, 'server.ts must define ACCOUNT_GAMES_MAX_BYTES ... ACCOUNT_GAMES_FULL');
const capJs = ts.transpileModule(source.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const capOf = (env: Record<string, string>) => new Function('process', `${capJs}; return { cap: ACCOUNT_GAMES_MAX_BYTES, full: ACCOUNT_GAMES_FULL };`)({ env }) as { cap: number; full: string };
const prod = capOf({});
assert.strictEqual(prod.cap, 2 * 1024 * 1024, 'the per-account cap is 2 MB'); n++;
assert.strictEqual(prod.full, 'Saved games for this account exceeded the 2 MB limit. Delete a saved game to make room, then save again.',
  'the refusal names the cap'); n++;
assert.match(capOf({ ACCOUNT_GAMES_MAX_BYTES: '65536' }).full, /exceeded the 64 KB limit/, 'a test override names its own cap'); n++;
assert.strictEqual(capOf({ ACCOUNT_GAMES_MAX_BYTES: 'junk' }).cap, 2 * 1024 * 1024, 'an unparseable override falls back to 2 MB'); n++;

// Route contract: every hosted write answers the store's FULL with 413 + that message, never the old 507.
for (const route of ['app.post("/api/games"', 'app.patch("/api/games/:id"']) {
  const s = source.indexOf(route);
  const hosted = source.slice(source.indexOf('if (accountGames) {', s), source.indexOf('await serializeGameWrite(', s));
  assert(hosted.includes('if (outcome === ACCOUNT_FULL) return res.status(413).json({ error: ACCOUNT_GAMES_FULL });') && !/507|STORAGE_FULL|growsPastBudget/.test(hosted),
    `${route}: the hosted branch answers FULL with 413 ACCOUNT_GAMES_FULL and never consults the global budget`); n++;
}

// ── Behaviour ───────────────────────────────────────────────────────────────
const cap = prod.cap;
let seq = 0;
// ~9.6 KB a row: about what the widest game the API accepts serializes to.
const bigGame = (userId: string): Game => ({ id: `g_${seq++}`, userId, name: 'n'.repeat(80), description: '界'.repeat(800), payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 },
  colorTermsA: Array.from({ length: 12 }, (_, i) => `${i}${'甲'.repeat(59)}`), colorTermsB: Array.from({ length: 12 }, (_, i) => `${i}${'乙'.repeat(59)}`), createdAt: '2026-10-01T00:00:00Z' });
const save = (store: ReturnType<typeof create>, userId: string, extraBytes = 0) =>
  store.mutate(userId, (games) => ({ games: [...games, bigGame(userId)], result: 'saved' }), { extraBytes });

{
  const bucket = memoryBucket();
  // A cache far smaller than what the sybils store: the heap is bounded by it, not by the bucket.
  const store = create({ bucket, capBytes: cap, cacheBytes: 3 * 1024 * 1024 });
  const sybils = ['u_s1', 'u_s2', 'u_s3', 'u_s4', 'u_s5'];
  const victimSaves: unknown[] = [];
  // All five fill concurrently while the victim keeps saving (group commit per object).
  await Promise.all([
    ...sybils.map(async (u) => { for (let i = 0; i < 400; i++) { if ((await save(store, u)) === FULL) return; } throw new Error(`${u} was never refused`); }),
    (async () => { for (let i = 0; i < 20; i++) victimSaves.push(await save(store, 'u_victim')); })(),
  ]);
  const sizes = sybils.map((u) => Buffer.byteLength(bucket.objects.get(store.objectName(u))!.body));
  const total = sizes.reduce((a, b) => a + b, 0);
  assert(sizes.every((s) => s <= cap && s > cap - 10_000), `every sybil object is filled to within one row of the cap, never past it: ${sizes}`); n++;
  assert(total > 8 * 1024 * 1024, `the sybils store ${total} bytes: past the old global 8 MB budget, which would have refused everyone`); n++;
  assert(victimSaves.length === 20 && victimSaves.every((r) => r === 'saved') && storedGames(bucket, store.objectName('u_victim'))!.length === 20,
    `the victim's 20 saves all land while the sybils fill: ${victimSaves.filter((r) => r !== 'saved').length} refused`); n++;
  // After the fill, too: a brand-new account and the victim still save.
  assert.strictEqual(await save(store, 'u_new'), 'saved', 'a new account saves after five accounts are full'); n++;
  // The full account is refused, and stays exactly at its bytes (a refused write writes nothing).
  const before = bucket.objects.get(store.objectName('u_s1'))!;
  assert.strictEqual(await save(store, 'u_s1'), FULL, 'a full account is refused'); n++;
  assert.strictEqual(bucket.objects.get(store.objectName('u_s1')), before, 'a refused write uploads nothing'); n++;
  // A full account can always drain: a same-size edit, a shrink and a delete pass; then a save fits again.
  const same = await store.mutate('u_s1', (g) => ({ games: g.map((x, i) => (i === 0 ? { ...x, name: 'm'.repeat(80) } : x)), result: 'edited' }));
  const shrink = await store.mutate('u_s1', (g) => ({ games: g.map((x, i) => (i === 1 ? { ...x, description: 'short' } : x)), result: 'shrunk' }));
  const grow = await store.mutate('u_s1', (g) => ({ games: g.map((x, i) => (i === 1 ? { ...x, description: '界'.repeat(4000) } : x)), result: 'grown' }));
  const del = await store.mutate('u_s1', (g) => ({ games: g.slice(2), result: 'deleted' }));
  assert.deepStrictEqual([same, shrink, grow, del], ['edited', 'shrunk', FULL, 'deleted'], 'at the cap: same-size edit, shrink and delete pass; growth is refused'); n++;
  assert.strictEqual(await save(store, 'u_s1'), 'saved', 'after deleting, the account saves again'); n++;
  // The cache stayed bounded: an account evicted long ago is read again from the bucket.
  const reads = bucket.ops.read;
  await store.snapshot(['u_s2'], 0);
  assert(bucket.ops.read > reads, 'the 10 MB the sybils stored did not all stay on the heap (3 MB cache): u_s2 was re-read'); n++;
}

{
  // A folded duplicate's games count toward the account's cap (extraBytes), and a state already
  // over the cap (migrated data) can still shrink — the cap refuses GROWTH, never existing data.
  const bucket = memoryBucket();
  const store = create({ bucket, capBytes: 100_000 });
  const rows = Array.from({ length: 30 }, () => bigGame('u_over'));
  assert.strictEqual(await store.mutate('u_over', () => ({ games: rows, result: 'migrated', overCapOk: true })), 'migrated', 'migration may exceed the cap'); n++;
  assert.strictEqual(await store.mutate('u_over', (g) => ({ games: g.slice(1), result: 'shrunk' })), 'shrunk', 'over the cap, a delete still passes'); n++;
  assert.strictEqual(await save(store, 'u_over'), FULL, 'over the cap, a save is refused'); n++;
  await save(store, 'u_kept');
  const keptBytes = store.sizeOf('u_kept', storedGames(bucket, store.objectName('u_kept'))!);
  assert.strictEqual(await save(store, 'u_kept', 100_000 - keptBytes - 1000), FULL, 'a folded account\'s bytes count toward the cap'); n++;
  assert.strictEqual(await save(store, 'u_kept'), 'saved', 'CONTROL: the same save without them fits'); n++;
}

{
  // Two instances (sweep 21): a refusal writes nothing, so no precondition vouches for the copy it
  // came from. Instance A holds a full account; the user frees room on instance B; an hour later A
  // must not answer 413 (or a 404 for a game B saved) from its old copy.
  const bucket = memoryBucket();
  let t = 0;
  const A = create({ bucket, capBytes: 30_000, now: () => t });
  const B = create({ bucket, capBytes: 30_000, now: () => t });
  while ((await save(A, 'u_two')) === 'saved');
  assert.strictEqual(await save(A, 'u_two'), FULL, 'instance A: the account is full'); n++;
  await B.snapshot(['u_two'], 0);
  const added = bigGame('u_two');
  assert.strictEqual(await B.mutate('u_two', (g) => ({ games: [...g.slice(2), added], result: 'swapped' })), 'swapped', 'instance B frees room and saves'); n++;
  t += 60 * 60_000;
  const findOnA = await A.mutate('u_two', (g) => ({ result: g.some((x) => x.id === added.id) ? 'found' : 'not found' }));
  assert.strictEqual(findOnA, 'found', 'an hour later, A finds the game B saved (a no-write answer re-checks a stale copy)'); n++;
  assert.strictEqual(await save(A, 'u_two'), 'saved', 'and A saves into the room B made, not 413 from its old copy'); n++;
  // A copy confirmed within freshMs answers without a GCS call; one re-check per answer, not a loop.
  const stats = bucket.ops.stat;
  assert.strictEqual(await save(A, 'u_two'), FULL, 'full again'); n++;
  assert.strictEqual(bucket.ops.stat, stats, 'a refusal from a copy confirmed just now costs no GCS call'); n++;
  t += 60 * 60_000;
  assert.strictEqual(await save(A, 'u_two'), FULL, 'still full an hour later'); n++;
  assert.strictEqual(bucket.ops.stat, stats + 1, 'a refusal from an old copy costs one stat'); n++;
}

{
  // A failed snapshot re-check backs off (the copy keeps being served for reading) but confirms
  // nothing: a refusal during the backoff still re-checks, and finds the room made meanwhile.
  const bucket = memoryBucket();
  let t = 0, down = false;
  const flaky = { ...bucket, stat: (name: string) => (down ? Promise.reject(new Error('GCS unavailable')) : bucket.stat(name)) };
  const A = create({ bucket: flaky, capBytes: 30_000, now: () => t, log: () => {} });
  const B = create({ bucket, capBytes: 30_000, now: () => t });
  while ((await save(A, 'u_flaky')) === 'saved');
  await B.snapshot(['u_flaky'], 0);
  await B.mutate('u_flaky', (g) => ({ games: g.slice(2), result: 'freed' }));
  t += 60 * 60_000;
  down = true;
  const seen = await A.snapshot(['u_flaky'], t + 1_000);
  assert(seen[0].games.length > 0, 'GCS down: the snapshot serves the copy held'); n++;
  down = false;
  t += 1_000; // inside freshMs of the failed re-check (and its 30 s backoff)
  assert.strictEqual(await save(A, 'u_flaky'), 'saved', 'the failed re-check confirmed nothing: the save re-checks and fits'); n++;
}

console.log(`sybilfill.cloud.test.ts: ${n} checks passed`);

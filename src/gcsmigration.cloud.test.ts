/**
 * LEGACY db.json GAMES -> PER-ACCOUNT OBJECTS (cloud loop 22, TASK-13). The hosted store used to
 * keep every account's games in db.json's `games` array; they now live in `games/<userId>.json`.
 * The migration runs on every read of a db.json that still carries rows (boot, re-check, and a
 * peer revision still writing them during a rollover). It must be LOSSLESS (every row lands in its
 * owner's object, read back byte-identical, before db.json is cleared), IDEMPOTENT (a re-run writes
 * nothing) and RESUMABLE (a crash anywhere leaves a state the next run completes). Runs the REAL
 * store on an in-memory bucket; the sync wiring is checked against the source.
 *
 *   npx tsx src/gcsmigration.cloud.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { clampGraphemeSafe } from './utils/textSafety';
import { loadAccountGameStore, memoryBucket, storedGames, type Game, type MemoryBucket } from './testing/accountGames.ts';

const { create, GONE, source } = await loadAccountGameStore();
const CAP = 2 * 1024 * 1024;
let n = 0;

const pay = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };
const g = (id: string | undefined, userId: unknown, extra: Record<string, unknown> = {}): Game =>
  ({ ...(id === undefined ? {} : { id }), userId, name: `n-${id}`, description: '界 "quoted" \\ é 😀', payoffs: pay, createdAt: '2026-01-01T00:00:00Z', ...extra });
// Every shape db.json can hold: several accounts, a duplicated identical row, rows with no owner
// (missing / non-string userId), two IDENTICAL id-less rows, -0 and 1e21 numbers, unicode.
const legacy = (): Game[] => [
  g('g_a1', 'u_a'), g('g_a2', 'u_a', { payoffs: { ...pay, a11: -0, b22: 1e21 } }), g('g_a3', 'u_a', { colorTermsA: ['界界'] }), g('g_a1', 'u_a'),
  g('g_b1', 'u_b'),
  g('g_o1', undefined), g('g_o2', 5), g(undefined, undefined), g(undefined, undefined),
  g('g_c_new', 'u_c'), g('g_c_edit', 'u_c', { name: 'legacy copy' }),
  g('g_w', 'u/weird id?'),
];
const seedC = (b: MemoryBucket, store: ReturnType<typeof create>) =>
  b.peerWrite(store.objectName('u_c'), JSON.stringify({ userId: 'u_c', games: [g('g_c_old', 'u_c'), g('g_c_edit', 'u_c', { name: 'edited after an earlier run' })] }));

/** Every row of every object, as `object -> sorted row JSON`. */
const snapshotOf = (b: MemoryBucket) => Object.fromEntries([...b.objects].sort(([x], [y]) => x.localeCompare(y))
  .map(([name, o]) => [name, (JSON.parse(o.body).games as Game[]).map((r) => JSON.stringify(r)).sort()]));

// 1. Lossless.
const ref = memoryBucket();
const refStore = create({ bucket: ref, capBytes: CAP });
seedC(ref, refStore);
const r1 = await refStore.migrate(legacy());
{
  const name = refStore.objectName;
  const rows = (key: string) => storedGames(ref, name(key))!.map((r) => JSON.stringify(r));
  const want = (key: string, ...games: Game[]) => games.map((x) => JSON.stringify(x));
  assert.deepStrictEqual(rows('u_a'), want('u_a', g('g_a1', 'u_a'), g('g_a2', 'u_a', { payoffs: { ...pay, a11: -0, b22: 1e21 } }), g('g_a3', 'u_a', { colorTermsA: ['界界'] })),
    'each owner\'s rows land in its own object, byte-identical, the identical duplicate once'); n++;
  assert.deepStrictEqual(rows('u_b'), want('u_b', g('g_b1', 'u_b')), 'a second account gets its own object'); n++;
  assert.deepStrictEqual(rows(''), want('', g('g_o1', undefined), g('g_o2', 5), g(undefined, undefined), g(undefined, undefined)),
    'rows with no string owner are KEPT (games/.json), both identical id-less rows included'); n++;
  assert.strictEqual(name(''), 'games/.json', 'the unowned rows\' object is one no account id can name'); n++;
  assert.deepStrictEqual(rows('u/weird id?'), want('', g('g_w', 'u/weird id?')), 'an owner id with / and ? still gets its own object');
  assert(ref.objects.has('games/u%2Fweird%20id%3F.json'), 'ids are URI-encoded into the object name'); n++;
  assert.deepStrictEqual(rows('u_c'), want('u_c', g('g_c_old', 'u_c'), g('g_c_edit', 'u_c', { name: 'edited after an earlier run' }), g('g_c_new', 'u_c')),
    'an existing object keeps its rows; a collision keeps the OBJECT\'s copy (an edit after an earlier run is never reverted)'); n++;
  assert.deepStrictEqual(r1.conflicts, ['games/u_c.json id:g_c_edit'], 'and the collision is reported'); n++;
  assert.deepStrictEqual([r1.rows, r1.accounts, r1.added], [12, 5, 10], `counts: ${JSON.stringify(r1)}`); n++;
}

// 2. Idempotent: a re-run (the next boot before db.json was cleared) writes nothing and changes nothing.
{
  const writes = ref.ops.write, before = snapshotOf(ref);
  const r2 = await create({ bucket: ref, capBytes: CAP }).migrate(legacy());
  assert.strictEqual(ref.ops.write, writes, 'a re-run uploads nothing'); n++;
  assert.deepStrictEqual(snapshotOf(ref), before, 'a re-run changes no object'); n++;
  assert.strictEqual(r2.added, 0, 're-run adds 0'); n++;
}

// 3. Resumable: a crash after EACH possible number of landed writes; a fresh process then finishes
// to exactly the uninterrupted result. Also a crash inside the read-back (verification).
{
  const total = r1.accounts; // one write per object
  for (let k = 0; k < total; k++) {
    const b = memoryBucket();
    const s1 = create({ bucket: b, capBytes: CAP });
    seedC(b, s1);
    let landed = 0;
    b.beforeWrite = () => { if (landed++ >= k) throw new Error('process killed mid-migration'); };
    await assert.rejects(s1.migrate(legacy()), /process killed|write failed/, `crash after ${k} write(s) fails the run`);
    b.beforeWrite = undefined;
    await create({ bucket: b, capBytes: CAP }).migrate(legacy());
    assert.deepStrictEqual(snapshotOf(b), snapshotOf(ref), `crash after ${k} write(s): the next run completes to the uninterrupted result`);
  }
  n++;
  const b = memoryBucket();
  const s1 = create({ bucket: b, capBytes: CAP });
  let reads = 0;
  const realRead = b.read.bind(b);
  b.read = async (name, gen) => { if (++reads === 2) throw new Error('killed during read-back'); return realRead(name, gen); };
  await assert.rejects(s1.migrate(legacy()), /killed during read-back/, 'a crash during the read-back fails the run');
  b.read = realRead;
  await create({ bucket: b, capBytes: CAP }).migrate(legacy());
  const noC = memoryBucket(), noCStore = create({ bucket: noC, capBytes: CAP });
  await noCStore.migrate(legacy());
  assert.deepStrictEqual(snapshotOf(b), snapshotOf(noC), 'after a read-back crash the next run completes'); n++;
}

// 4. Two instances migrating the same db.json at once (a rollover): GCS's precondition serializes
// them, the loser re-reads and re-applies, and no row is lost or duplicated.
{
  const b = memoryBucket();
  const s1 = create({ bucket: b, capBytes: CAP }), s2 = create({ bucket: b, capBytes: CAP });
  seedC(b, s1);
  let refused = 0;
  const realWrite = b.write.bind(b);
  b.write = async (...a) => { try { return await realWrite(...a); } catch (err) { refused++; throw err; } };
  await Promise.all([s1.migrate(legacy()), s2.migrate(legacy())]);
  assert(refused > 0, 'fixture: the two runs collided (412s)'); n++;
  assert.deepStrictEqual(snapshotOf(b), snapshotOf(ref), 'concurrent runs end exactly as one run does'); n++;
}

// 5. The cap never refuses a migrated row: an account already over 2 MB in db.json migrates whole.
{
  const b = memoryBucket();
  const s = create({ bucket: b, capBytes: 100_000 });
  const rows = Array.from({ length: 60 }, (_, i) => g(`g_big${i}`, 'u_big', { description: 'x'.repeat(4000) }));
  const r = await s.migrate(rows);
  assert(r.added === 60 && storedGames(b, s.objectName('u_big'))!.length === 60 && Buffer.byteLength(b.objects.get(s.objectName('u_big'))!.body) > 200_000,
    'an over-cap legacy account migrates every row'); n++;
}

// 6. The read-back is from GCS itself, never the cache: a bucket that drops or alters bytes fails the run.
for (const [label, transform, why] of [
  ['drops a row', (body: string) => { const d = JSON.parse(body); d.games.pop(); return JSON.stringify(d); }, /did not reach GCS/],
  ['alters a row', (body: string) => body.replace('n-g_a2', 'n-g_aX'), /reads back different bytes/],
] as const) {
  const b = memoryBucket();
  const s = create({ bucket: b, capBytes: CAP });
  b.transform = (name, body) => (name === s.objectName('u_a') ? transform(body) : body);
  await assert.rejects(s.migrate(legacy()), why, `a bucket that ${label} fails the migration (db.json is then not cleared)`); n++;
}

// 7. A peer writing an account's object between our read and our write (412) is re-read and kept.
{
  const b = memoryBucket();
  const s = create({ bucket: b, capBytes: CAP });
  await s.snapshot(['u_a'], 0); // cache "no object"
  b.peerWrite(s.objectName('u_a'), JSON.stringify({ userId: 'u_a', games: [g('g_peer', 'u_a')] }));
  await s.migrate(legacy());
  assert.deepStrictEqual(storedGames(b, s.objectName('u_a'))!.map((x) => x.id), ['g_peer', 'g_a1', 'g_a2', 'g_a3'], 'the peer\'s row survives the migration that raced it'); n++;
}

// 9. Account deletion is a TOMBSTONE, not a bare delete: an instance still holding the account
// (its db.json copy is up to 2 s old) has its next save refused instead of re-creating an object
// nobody can reach, and a later migration run does not restore a deleted account's legacy rows.
{
  const b = memoryBucket();
  const x = create({ bucket: b, capBytes: CAP }), y = create({ bucket: b, capBytes: CAP });
  await x.migrate([g('g_d1', 'u_del'), g('g_k1', 'u_keep')]);
  await x.snapshot(['u_del'], 0); // X holds the pre-deletion copy
  await y.removeAll(['u_del', 'u_never_saved']);
  const tomb = JSON.parse(b.objects.get(y.objectName('u_del'))!.body);
  assert.deepStrictEqual(tomb, { userId: 'u_del', games: [], deleted: true }, 'the deleted account\'s object holds only its id and the tombstone'); n++;
  assert(b.objects.has(y.objectName('u_never_saved')), 'an account that never saved still gets a tombstone (a stale peer could save its first game)'); n++;
  const GONE = await x.mutate('u_del', (games) => ({ games: [...games, g('g_late', 'u_del')], result: 'saved' }));
  assert.notStrictEqual(GONE, 'saved', 'a stale instance\'s save for the deleted account is refused');
  assert.strictEqual(typeof GONE, 'symbol', 'refused with the store\'s GONE outcome'); n++;
  assert.deepStrictEqual(storedGames(b, y.objectName('u_del')), [], 'and nothing landed under the deleted account'); n++;
  const r = await create({ bucket: b, capBytes: CAP }).migrate([g('g_d1', 'u_del'), g('g_d2', 'u_del'), g('g_k1', 'u_keep')]);
  assert(storedGames(b, y.objectName('u_del'))!.length === 0 && r.conflicts.filter((c) => c.endsWith('(account deleted)')).length === 2,
    `a re-run does not restore a deleted account's legacy rows, and reports them: ${JSON.stringify(r.conflicts)}`); n++;
  assert.deepStrictEqual((await y.snapshot(['u_del'], 0))[0].games, [], 'a deleted account lists nothing'); n++;
  assert.strictEqual((await y.counts()).get('u_del'), 0, 'and counts zero games'); n++;
}

// 10. A RE-RUN BEFORE db.json IS CLEARED (Sweep 18, finding 1). The legacy array stays in db.json until
// the clearing write lands; during a rollover a previous revision keeps writing db.json, that write 412s
// and the next read migrates the same rows again. The object's record of what was migrated decides:
{
  const b = memoryBucket();
  const s = create({ bucket: b, capBytes: CAP });
  const rows = [g('g_x', 'u_r'), g('g_y', 'u_r'), g('g_z', 'u_r')];
  await s.migrate(rows);
  // (a) the account deletes g_x on the new revision; (b) it edits g_y here; (c) the previous revision edits g_z.
  await s.mutate('u_r', (games) => ({ games: games.filter((x) => x.id !== 'g_x').map((x) => (x.id === 'g_y' ? { ...x, name: 'edited here' } : x)), result: 'ok' }));
  const r = await create({ bucket: b, capBytes: CAP }).migrate([g('g_x', 'u_r'), g('g_y', 'u_r'), g('g_z', 'u_r', { name: 'edited on the previous revision' })]);
  const names = Object.fromEntries(storedGames(b, s.objectName('u_r'))!.map((x) => [x.id, x.name]));
  assert(!('g_x' in names), `a game deleted after its migration is NOT brought back by a re-run: ${JSON.stringify(names)}`); n++;
  assert.strictEqual(names.g_y, 'edited here', 'an edit made here after the migration stands'); n++;
  assert.strictEqual(names.g_z, 'edited on the previous revision', 'an edit the previous revision made to a row untouched here lands'); n++;
  // (d) both sides edit the same row: this side stands, and the collision is reported once.
  await s.mutate('u_r', (games) => ({ games: games.map((x) => (x.id === 'g_z' ? { ...x, name: 'edited here too' } : x)), result: 'ok' }));
  const r2 = await create({ bucket: b, capBytes: CAP }).migrate([g('g_x', 'u_r'), g('g_y', 'u_r'), g('g_z', 'u_r', { name: 'edited there again' })]);
  const z = storedGames(b, s.objectName('u_r'))!.find((x) => x.id === 'g_z');
  assert(z?.name === 'edited here too' && r2.conflicts.some((c) => c.endsWith('id:g_z')) && r.conflicts.length === 0,
    `both sides edited g_z: this side stands, reported (${JSON.stringify(r2.conflicts)})`); n++;
  // (e) the record makes the next identical re-run a no-op: no upload.
  const w = b.ops.write;
  await create({ bucket: b, capBytes: CAP }).migrate([g('g_x', 'u_r'), g('g_y', 'u_r'), g('g_z', 'u_r', { name: 'edited there again' })]);
  assert.strictEqual(b.ops.write, w, 'an identical re-run uploads nothing'); n++;
  // (f) a delete that lands between the migration's write and its read-back neither fails the run nor comes back.
  const b2 = memoryBucket(), s2 = create({ bucket: b2, capBytes: CAP });
  let once = true;
  b2.afterWrite = (name) => { if (once && name === s2.objectName('u_q')) { once = false; const o = JSON.parse(b2.objects.get(name)!.body); o.games = o.games.filter((x: Game) => x.id !== 'g_q1'); b2.peerWrite(name, JSON.stringify(o)); } };
  await s2.migrate([g('g_q1', 'u_q'), g('g_q2', 'u_q')]);
  await create({ bucket: b2, capBytes: CAP }).migrate([g('g_q1', 'u_q'), g('g_q2', 'u_q')]);
  assert.deepStrictEqual(storedGames(b2, s2.objectName('u_q'))!.map((x) => x.id), ['g_q2'], 'a delete racing the read-back stands, and the next run does not undo it'); n++;
}

// 11. One account's object is corrupt (only an outside edit can do that): the migration skips it, reports
// it and returns its rows to stay in db.json; every other account migrates (Sweep 18, finding 3).
{
  const b = memoryBucket();
  const s = create({ bucket: b, capBytes: CAP });
  b.peerWrite(s.objectName('u_bad'), '{"userId":"u_bad","games":"not an array"}');
  const r = await s.migrate([g('g_bad', 'u_bad'), g('g_ok', 'u_ok')]);
  assert(r.kept.length === 1 && r.kept[0].id === 'g_bad' && storedGames(b, s.objectName('u_ok'))!.some((x) => x.id === 'g_ok')
    && b.objects.get(s.objectName('u_bad'))!.body === '{"userId":"u_bad","games":"not an array"}' && r.conflicts.some((c) => /blocked/.test(c)),
    `a corrupt object is skipped (untouched, its rows kept for db.json) and the rest migrates: ${JSON.stringify(r)}`); n++;
}

// 8. The wiring (server.ts syncFromGcs): rows are migrated BEFORE the generation is adopted (once
// adopted, our next upload writes db.json over it), only in hosted mode, and the clearing write is
// scheduled; the merged state carries only the rows of blocked accounts.
{
  const s = source.indexOf('async function syncFromGcs(');
  const body = source.slice(s, source.indexOf('\n}\n', s));
  const mig = body.indexOf('await accountGames.migrate(remote.db.games)');
  assert(mig > 0 && mig < body.indexOf('gcsGeneration = remote.generation') && mig < body.indexOf('applyMergedDb('),
    'syncFromGcs migrates before it adopts the generation or merges'); n++;
  assert(/const remoteDb: DB = accountGames \? \{ users: remote\.db\.users, games: legacyKept \} : remote\.db;/.test(body) && /legacyKept = m\.kept;/.test(body)
    && /applyMergedDb\(unionMergeDb\(remoteDb,/.test(body) && /if \(!descends \|\| migrated \|\| \(accountGames && foldsRemoteLacks\(loadDB\(\)\.users, remote\.db\.users\)\)\) scheduleGcsSave\(\);/.test(body),
    'hosted, the merged state carries only blocked accounts\' legacy rows and a migration schedules the write that clears the rest'); n++;
  // An account the merge removes (deleted on a previous revision during a rollover) has its objects tombstoned.
  // An account the merge removes (deleted on a previous revision during a rollover) has its objects
  // tombstoned, folded duplicates' included (section 16 runs the selection itself).
  assert(/const heldBefore = accountGames \? loadDB\(\)\.users\.filter\(\(u\) => u\.isVerified\)\.map\(\(u\) => \(\{ id: u\.id, keys: accountKeys\(u\) \}\)\) : \[\];/.test(body)
    && body.indexOf('const heldBefore') < body.indexOf('applyMergedDb(')
    && /accountGames\.tombstoneEventually\(removedAccountKeys\(heldBefore, loadDB\(\)\.users\)\);/.test(body)
    && body.indexOf('removedAccountKeys(heldBefore') > body.indexOf('applyMergedDb('),
    'an account the merge removes has its objects tombstoned'); n++;
  // Both deletions go through the one re-reading loop (section 16 runs it), and the rows go only after it.
  const dc = source.slice(source.indexOf('if (accountGames) {', source.indexOf('let gone = new Set(db.users.filter(')), source.indexOf('const fresh = loadDB();', source.indexOf('let gone = new Set(db.users.filter(')));
  const fin = source.slice(source.indexOf('async function finishAccountDeletion('), source.indexOf('\n}\n', source.indexOf('async function finishAccountDeletion(')));
  assert(/gone = await tombstoneAccounts\(u => emailKey\(u\.email\) === userEmail \|\| u\.id === user\.id\);/.test(dc) && !/removeAll/.test(dc)
    && /const ids = await tombstoneAccounts\(\(u\) => u\.id === user\.id \|\| emailKey\(u\.email\) === key\);/.test(fin) && !/removeAll/.test(fin),
    'delete-confirm and an unfinished deletion tombstone through tombstoneAccounts before the rows go'); n++;
  assert(/const users = keepFolds\(merge\(remote\.users, local\.users,[^\n]*\[\.\.\.local\.users, \.\.\.\(baseline\?\.users \?\? \[\]\)\]\);/.test(source),
    'unionMergeDb keeps the folds this side knew'); n++;
}

// 12. A ROW MISSING FROM A LATER LEGACY ARRAY IS NEVER TAKEN FOR A DELETION (Sweep 20). Rows vanish from
// db.json without anyone deleting them: a blocked account's rows are kept back while the rest are cleared,
// a clear lands, a previous-revision upload that timed out lands late and is re-merged. Inferring deletions
// from absence (Sweep 19's attempt) wiped every other account's migrated games after one corrupt object.
// Accepted instead: a game deleted on the PREVIOUS revision, mid-rollover, after its migration, reappears.
{
  const b = memoryBucket();
  const s = create({ bucket: b, capBytes: CAP });
  b.peerWrite(s.objectName('u_bad'), '{"userId":"u_bad","games":7}');
  const L1 = [g('g_1', 'u_1'), g('g_2', 'u_1'), g('g_3', 'u_2'), g('g_b', 'u_bad')];
  const r1 = await s.migrate(L1);
  // The next sync reads db.json holding only what was kept back (the blocked account's rows).
  await create({ bucket: b, capBytes: CAP }).migrate(r1.kept);
  // ... and a later one holds only a row the previous revision made after a clear.
  await create({ bucket: b, capBytes: CAP }).migrate([g('g_new', 'u_2')]);
  assert.deepStrictEqual([storedGames(b, s.objectName('u_1'))!.map((x) => x.id), storedGames(b, s.objectName('u_2'))!.map((x) => x.id)],
    [['g_1', 'g_2'], ['g_3', 'g_new']], 'rows missing from later legacy arrays stay in their objects (nothing removed by absence)'); n++;
  assert.deepStrictEqual(r1.kept.map((x) => x.id), ['g_b'], 'fixture: the blocked account\'s row was kept back'); n++;
}

// 13. Two legacy rows with one id and DIFFERENT bytes (Sweep 19, finding 2): both are kept as distinct rows,
// the run succeeds, and a re-run writes nothing (it used to flip the row and fail forever).
{
  const b = memoryBucket();
  const s = create({ bucket: b, capBytes: CAP });
  const L = [g('g_d', 'u_d'), g('g_d', 'u_d', { name: 'second copy' }), g('g_d', 'u_d')];
  await s.migrate(L);
  const w = b.ops.write;
  await create({ bucket: b, capBytes: CAP }).migrate(L);
  assert.deepStrictEqual(storedGames(b, s.objectName('u_d'))!.map((x) => x.name), ['n-g_d', 'second copy'], 'both differing copies are kept, the identical repeat once'); n++;
  assert.strictEqual(b.ops.write, w, 'and a re-run writes nothing'); n++;
}

// 13b. A differing copy's identity can't collide with a row whose own id looks like one (Sweep 23):
// ids g_x, g_x (other bytes) and 'g_x#2' are three rows; every run succeeds and keeps all three.
{
  const b = memoryBucket();
  const L = [g('g_x', 'u_h', { name: 'A' }), g('g_x', 'u_h', { name: 'B' }), g('g_x#2', 'u_h', { name: 'C' })];
  for (let run = 0; run < 3; run++) await create({ bucket: b, capBytes: CAP }).migrate(L);
  assert.deepStrictEqual(storedGames(b, create({ bucket: b, capBytes: CAP }).objectName('u_h'))!.map((x) => x.name), ['A', 'B', 'C'], 'three rows, three games, on every run'); n++;
}

// 13c. The read-back follows a peer writing between its stat and its download (Sweep 24): the
// account saving on another instance at the wrong moment must not fail the migration.
{
  const b = memoryBucket();
  const s = create({ bucket: b, capBytes: CAP });
  const name = s.objectName('u_rb');
  const peerSave = (id: string) => { const doc = JSON.parse(b.objects.get(name)!.body); doc.games.push(g(id, 'u_rb')); b.peerWrite(name, JSON.stringify(doc)); };
  let phase = 0;
  b.afterWrite = (n2) => { if (n2 === name && phase === 0) { phase = 1; peerSave('peer1'); } };
  const rawStat = b.stat.bind(b);
  b.stat = async (n2) => { const r = await rawStat(n2); if (n2 === name && phase === 1) { phase = 2; peerSave('peer2'); } return r; };
  const r = await s.migrate([g('g_rb', 'u_rb')]);
  assert.strictEqual(phase, 2, 'fixture: a peer wrote after the migration write and again between the read-back stat and download'); n++;
  assert(r.added === 1 && storedGames(b, name)!.map((x) => x.id).join() === 'g_rb,peer1,peer2', `the migration succeeds with every game: ${JSON.stringify(r)}`); n++;
}

// 14. Deletions owed to accounts removed elsewhere are retried until they land (Sweep 19, finding 4),
// on their own: no later call may come — a lone instance's db.json changes only by its own writes (Sweep 28).
{
  const tombstoned = (b: ReturnType<typeof memoryBucket>, s: ReturnType<typeof create>, k: string) => JSON.parse(b.objects.get(s.objectName(k))?.body ?? '{}').deleted === true;
  const b = memoryBucket();
  const s = create({ bucket: b, capBytes: CAP, log: () => {} });
  let fail = true;
  b.beforeWrite = () => { if (fail) throw new Error('GCS unavailable'); };
  s.tombstoneEventually(['u_gone']);
  await s.idle();
  const tombAfterFailure = b.objects.has(s.objectName('u_gone'));
  fail = false;
  await new Promise((r) => setTimeout(r, 800)); // no further call: the owed tombstone is retried after a backoff
  await s.idle();
  assert(!tombAfterFailure && tombstoned(b, s, 'u_gone'), 'a tombstone that failed is owed and paid with no later call'); n++;
  // A key owed while a payment is out is paid when that payment settles, with no later call.
  const b2 = memoryBucket();
  const s2 = create({ bucket: b2, capBytes: CAP });
  s2.tombstoneEventually(['u_a']);
  s2.tombstoneEventually(['u_b']); // during u_a's payment
  for (let i = 0; i < 20 && !tombstoned(b2, s2, 'u_b'); i++) { await s2.idle(); await new Promise((r) => setTimeout(r, 5)); }
  assert(tombstoned(b2, s2, 'u_a') && tombstoned(b2, s2, 'u_b'), 'THE DEFECT (Sweep 28): a key owed during a payment is paid too'); n++;
}

// 15. The store makes no network call of its own: the module imports nothing (every GCS call is in
// server.ts's adapter, under withDeadline). And pickAccount keeps the fold record whichever record wins
// (Sweep 19, finding 3): hosted, a folded account's games are reached only through `mergedFrom`.
{
  const storeSrc = readFileSync(new URL('./server/accountGameStore.ts', import.meta.url), 'utf8');
  assert(!/^\s*import\s|\brequire\(|\bimport\(/m.test(storeSrc), 'src/server/accountGameStore.ts imports nothing'); n++;
  const from = source.indexOf('const MAX_CODE_ATTEMPTS = ');
  const codeFields = source.slice(source.indexOf('const CODE_FIELDS = '), source.indexOf('} as const;', source.indexOf('const CODE_FIELDS = ')) + 11);
  const pickFrom = source.indexOf('function pickAccount(');
  const js = ts.transpileModule(`${source.slice(from, source.indexOf('\n', from))}\n${codeFields}\n${source.slice(pickFrom, source.indexOf('\n}\n', pickFrom) + 2)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const pickAccount = new Function(`${js}; return pickAccount;`)() as (m: object, t: object, w: object) => { mergedFrom?: string[]; tokenVersion?: number };
  const base = { id: 'u_k', username: 'k', email: 'k@x.test', passwordHash: 'h', isVerified: true, verificationCode: '', verificationCodeExpires: 0 };
  const theirs = { ...base, mergedFrom: ['u_folded'] };           // the peer folded u_folded into u_k
  const mine = { ...base, recoveryCode: '123456', recoveryCodeExpires: 1 }; // this instance changed u_k meanwhile
  const out = pickAccount(mine, theirs, base);
  assert.deepStrictEqual(out.mergedFrom, ['u_folded'], 'the fold survives a merge where the other record wins'); n++;
}

// 16. Which objects a merge's removals tombstone, folds kept through a merge, and the deletion loop —
// run from server.ts's own source (Sweeps 24 and 25).
{
  const fn = (name: string) => { const i = source.indexOf(`function ${name}(`); return source.slice(source.lastIndexOf('\n', i) + 1, source.indexOf('\n}\n', i) + 2); };
  const js = ts.transpileModule(`const accountKeys = ${source.slice(source.indexOf('const accountKeys = ') + 20, source.indexOf('\n', source.indexOf('const accountKeys = ')))}\n${fn('removedAccountKeys')}\n${fn('keepFolds')}\n${fn('foldsRemoteLacks')}\n${fn('tombstoneAccounts')}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  type U = { id: string; email?: string; mergedFrom?: string[] };
  let db: { users: U[] } = { users: [] };
  const removed: string[][] = [];
  let onRemove = (_keys: string[]) => {};
  const accountGames = { removeAll: async (keys: string[]) => { removed.push([...keys]); onRemove(keys); } };
  const m = new Function('loadDB', 'accountGames', `${js}; return { removedAccountKeys, keepFolds, foldsRemoteLacks, tombstoneAccounts, accountKeys };`)(() => db, accountGames) as {
    removedAccountKeys: (b: { id: string; keys: string[] }[], a: U[]) => string[]; keepFolds: (u: U[], k: U[]) => U[]; foldsRemoteLacks: (u: U[], r: U[]) => boolean;
    tombstoneAccounts: (match: (u: U) => boolean) => Promise<Set<string>>; accountKeys: (u: U) => string[] };
  const K = { id: 'u_k', mergedFrom: ['u_d'] };
  const held = [{ id: K.id, keys: m.accountKeys(K) }];
  assert.deepStrictEqual(m.removedAccountKeys(held, []), ['u_k', 'u_d'], 'a removed account: its own object and its folded duplicate\'s'); n++;
  assert.deepStrictEqual(m.removedAccountKeys(held, [{ id: 'u_k' }]), [], 'THE DEFECT (Sweep 25): the account survived without its mergedFrom: nothing is tombstoned'); n++;
  assert.deepStrictEqual(m.removedAccountKeys(held, [{ id: 'u_z', mergedFrom: ['u_k', 'u_d'] }]), [], 'folded into another account (it reaches both): nothing is tombstoned'); n++;
  assert.deepStrictEqual(m.removedAccountKeys(held, [{ id: 'u_z', mergedFrom: ['u_d'] }]), ['u_k'], 'removed, but its duplicate lives on elsewhere: only its own object'); n++;
  const kept = m.keepFolds([{ id: 'u_k' }, { id: 'u_x' }], [K, { id: 'u_gone', mergedFrom: ['u_g'] }]);
  assert.deepStrictEqual(kept, [{ id: 'u_k', mergedFrom: ['u_d'] }, { id: 'u_x' }], 'a record that came back without its mergedFrom keeps the folds this side knew; a removed account is not revived'); n++;
  // ... and is written back, not held here only (Sweep 26): a restart would otherwise lose it for good.
  assert(m.foldsRemoteLacks(kept, [{ id: 'u_k' }, { id: 'u_x' }]), 'THE DEFECT (Sweep 26): a fold the remote lost is a reason to upload'); n++;
  assert(!m.foldsRemoteLacks(kept, [{ id: 'u_k', mergedFrom: ['u_d'] }, { id: 'u_x' }]) && !m.foldsRemoteLacks([{ id: 'u_x' }], [{ id: 'u_x', mergedFrom: ['u_y'] }]),
    'CONTROL: folds the remote already has (or has more of) are not'); n++;
  // The loop: a sync during the first await brings in a fold and a duplicate row; both are covered.
  db = { users: [{ id: 'u_k', email: 'k' }, { id: 'u_other', email: 'o', mergedFrom: ['u_o2'] }] };
  onRemove = () => { if (removed.length === 1) db = { users: [{ id: 'u_k', email: 'k', mergedFrom: ['u_d'] }, { id: 'u_k2', email: 'k' }, db.users[1]] }; };
  const gone = await m.tombstoneAccounts((u) => u.email === 'k');
  assert.deepStrictEqual(removed, [['u_k'], ['u_d', 'u_k2']], 'THE DEFECT (Sweep 24): what a sync brought in during the await is tombstoned too, each key once'); n++;
  assert.deepStrictEqual([...gone], ['u_k', 'u_k2'], 'and the rows it answers are those of its last read'); n++;
}

// 17. db.json's unacked overlay (Sweep 28: the gcs-db-saves port moved sections 9/9b to game objects,
// leaving it untested). An upload abandoned at its deadline may land anyway: an account row it created
// and this side deleted since stays deleted when GCS hands it back; one that did NOT land survives a
// peer's write. Run from server.ts's own source.
{
  const fn = (name: string) => { const i = source.search(new RegExp(`\\n(?:async )?function ${name}\\(|\\nconst ${name} = `)) + 1; return source.slice(i, source.indexOf(name.startsWith('overlay') ? '\n});\n' : '\n}\n', i) + (name.startsWith('overlay') ? 4 : 2)); };
  const line = (start: string) => { const i = source.indexOf(start); return source.slice(i, source.indexOf('\n', i)); };
  const codeFields = source.slice(source.indexOf('const CODE_FIELDS = '), source.indexOf('} as const;', source.indexOf('const CODE_FIELDS = ')) + 11);
  const src = [line('const MAX_CODE_ATTEMPTS = '), codeFields, line('const emailKey = '), line('const nfkcBare = '), line('const usernameKey = '),
    fn('keepFolds'), fn('pickAccount'), fn('dedupeAccounts'), fn('unionMergeDb'), fn('overlayDb')].join('\n');
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  type Row = { id: string; email: string; username: string; isVerified?: boolean; passwordHash?: string };
  type D = { users: Row[]; games: unknown[] };
  const { unionMergeDb, overlayDb } = new Function('isDeepStrictEqual', 'clampGraphemeSafe', `${js}; return { unionMergeDb, overlayDb };`)(isDeepStrictEqual, clampGraphemeSafe) as {
    unionMergeDb: (r: D, l: D, b: D | null, u: D | null, descends?: boolean) => D; overlayDb: (a: D, b: D) => D };
  const acct = (id: string): Row => ({ id, email: `${id}@x.test`, username: id, isVerified: true, passwordHash: 'h' });
  const A = acct('u_a'), B = acct('u_b'), C = acct('u_c');
  const ids = (d: D) => d.users.map((u) => u.id).sort();
  const db = (...users: Row[]): D => ({ users, games: [] });
  // 9 (db.json): the abandoned upload created B and LANDED; B was deleted here since.
  const unacked = overlayDb(db(), db(A, B));
  assert.deepStrictEqual(ids(unionMergeDb(db(A, B), db(A), db(A), unacked)), ['u_a'], 'THE DEFECT: an account deleted after its abandoned upload landed stays deleted'); n++;
  assert.deepStrictEqual(ids(unionMergeDb(db(A, B), db(A), db(A), null)), ['u_a', 'u_b'], 'CONTROL: without the unacked record the merge takes it for a peer\'s new account (the overlay is what decides)'); n++;
  // 9b (db.json): the abandoned upload did NOT land; a peer wrote C meanwhile; B (acked) survives.
  assert.deepStrictEqual(ids(unionMergeDb(db(A, C), db(A, B), db(A), unacked)), ['u_a', 'u_b', 'u_c'], 'an acked account whose upload never landed survives the peer\'s write, and so does the peer\'s account'); n++;
  assert.deepStrictEqual(ids(overlayDb(unacked, db(C))), ['u_a', 'u_b', 'u_c'], 'a second abandoned upload adds to the record, it does not replace it'); n++;
  assert(/if \(err\?\.code !== 412\) gcsUnackedDb = overlayDb\(gcsUnackedDb \?\? \{ users: \[\], games: \[\] \}, sent\);/.test(source)
    && /applyMergedDb\(unionMergeDb\(remoteDb, loadDB\(\), gcsBaselineDb, gcsUnackedDb, descends\)\);/.test(source),
    'the pump records an abandoned upload and syncFromGcs merges with it'); n++;
}

console.log(`gcsmigration.cloud.test.ts: ${n} checks passed`);

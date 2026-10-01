/**
 * HOSTED SAVED GAMES, ONE GCS OBJECT PER ACCOUNT (cloud loop 22, TASK-13).
 *
 * WHY. Every account's games lived in the one db.json, under one 8 MB budget
 * (S14-1's OOM bound). Four free accounts saving max-size games filled it, and
 * from then on EVERY other user's save was a 507 "storage is full": a handful of
 * sign-ups could deny the whole site its core feature. Now each account's games
 * are `games/<encodeURIComponent(userId)>.json`, capped in bytes per account
 * (server.ts ACCOUNT_GAMES_MAX_BYTES, 2 MB), so filling your own allowance
 * refuses only you (413, the cap named). db.json keeps the accounts and no games.
 *
 * THE HEAP BOUND MOVES WITH IT. The global budget existed because every game
 * sat on a 128 MB heap. Objects are read on demand into a byte-bounded LRU
 * cache (`cacheBytes`), so no number of full accounts grows the heap: a request
 * holds at most one account's objects (<= the cap) beyond the cache.
 *
 * WRITES ARE AWAITED AND LINEARIZED PER OBJECT. A write is a read-modify-write
 * with `ifGenerationMatch`; a 412 (another instance wrote first) re-reads the
 * object and re-applies the request's operation to it, so two instances never
 * need the three-way merge db.json does (sweeps 2-19 found a dozen ways that
 * merge lost or resurrected rows). Writes that arrive while one is in flight
 * for the same object are applied together in ONE upload (group commit: N rapid
 * saves cost at most two uploads, as #85's pump did). The HTTP answer waits for
 * the upload, so a 200 means the game is in GCS: a failed upload is an honest
 * 503, never the old "acknowledged, retrying in the background" that a
 * scale-in could still lose.
 *
 * NO GCS CALL IS MADE HERE: this module imports nothing (gcsmigration.cloud
 * holds it to that). Every bucket operation goes through the `bucket` adapter
 * server.ts hands in (gcsAccountBucket), where each one runs under
 * `withDeadline` (src/gcsdeadline.contract.test.ts holds server.ts to it). The
 * cloud guards (src/sybilfill.cloud.test.ts, src/gcsmigration.cloud.test.ts)
 * run this module against an in-memory bucket.
 */

export interface AccountBucket {
  /** The object's live generation, or null when there is no object. */
  stat(name: string): Promise<{ generation: string } | null>;
  /** That generation's bytes, or null when it is no longer live (a peer wrote since). */
  read(name: string, generation: string): Promise<string | null>;
  /**
   * Write only if the live generation is still `ifGenerationMatch` ('0': no
   * object may exist); a mismatch rejects with `code: 412`. Resolves to the new
   * generation, or null when the answer carried none (landed, generation unknown).
   */
  write(name: string, body: string, ifGenerationMatch: string, metadata: Record<string, string>): Promise<string | null>;
  /** One page of a prefix listing (`next`: the token for the following page, null at the end). */
  list(prefix: string, pageToken?: string): Promise<{ items: { name: string; metadata: Record<string, string> }[]; next: string | null }>;
}

export interface AccountGameStoreOptions {
  bucket: AccountBucket;
  /** Per-account byte cap on the stored object (growth past it is refused; shrinking always passes). */
  capBytes: number;
  /** How long a read copy is served before its generation is re-checked. */
  freshMs: number;
  /** Byte bound on the parsed objects held in memory. */
  cacheBytes: number;
  /** Monotonic clock (ms). */
  now: () => number;
  log?: (msg: string) => void;
}

/** The fields the store itself reads from a saved game; everything else is carried as is. */
export interface StoredGame { id?: unknown; userId?: unknown }

type Migrated = Readonly<Record<string, string>>;

/**
 * What an operation does to one account's games. `games` absent: no change;
 * `null`: the account is deleted (its object becomes a tombstone); an array:
 * the new contents. `overCapOk` is for migration only — data that already
 * exists is never refused by the cap.
 */
export interface GameStep<G, T> {
  games?: G[] | null; result: T; overCapOk?: boolean;
  /** Migration only: the object's new record of migrated legacy rows (see `migrate`). */
  migrated?: Record<string, string>;
  /** Called with the generation this step's write produced (null: landed, generation unknown). */
  committed?: (generation: string | null) => void;
}
export type GameOp<G, T> = (games: readonly G[], object: { migrated: Migrated }) => GameStep<G, T>;

export class AccountStoreUnavailable extends Error {}

export const ACCOUNT_GAMES_PREFIX = "games/";
/** The write would grow the account past its cap. */
export const ACCOUNT_FULL: unique symbol = Symbol("account-games-full");
/** The account's object is a tombstone: the account was deleted (on any instance). */
export const ACCOUNT_GONE: unique symbol = Symbol("account-games-gone");

/** Two FNV-1a-style 32-bit lanes: a content fingerprint for the migration record, not a security hash. */
function fingerprint(s: string): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export function createAccountGameStore<G extends StoredGame>(opts: AccountGameStoreOptions) {
  const { bucket, capBytes, freshMs, cacheBytes, now } = opts;
  const log = opts.log ?? (() => {});
  // Re-read + re-apply rounds before an honest 503. Every 412 means another
  // writer landed; 8 starved ~2% of saves with three instances on one account
  // (worst-case backoff sum at 16 is ~11.6 s, inside the client's 22 s).
  const MAX_412 = 16;
  // Jittered: instances racing for one object would otherwise re-collide in lockstep.
  const backoff = (attempt: number) => new Promise((r) => setTimeout(r, Math.random() * Math.min(1_000, 25 * 2 ** attempt)));
  const READ_BACKOFF_MS = 30_000;

  // A legacy row with no usable owner keeps its bytes in `games/.json`: no
  // account id encodes to the empty name, and nobody is ever served it.
  const objectName = (key: string) => `${ACCOUNT_GAMES_PREFIX}${encodeURIComponent(key)}.json`;
  const keyOf = (name: string) => decodeURIComponent(name.slice(ACCOUNT_GAMES_PREFIX.length, -".json".length));

  // The stored body is `{"userId":<key>,"games":[row,row,...]}` (compact), plus
  // `"migrated":{...}` on an object a migration wrote to (see `migrate`). Its
  // size is the frame plus each row plus the commas between them — exact, and a
  // write costs a stringify of its NEW rows only (S15-1: a full stringify per
  // refused write was a CPU amplifier under a flood).
  const NONE: Migrated = Object.freeze({});
  const body = (key: string, games: readonly G[], migrated: Migrated = NONE) =>
    JSON.stringify(Object.keys(migrated).length > 0 ? { userId: key, games, migrated } : { userId: key, games });
  // ACCOUNT DELETION WRITES A TOMBSTONE, never a bare delete: a peer instance
  // still holding the account in its (up to freshMs old) db.json copy would
  // otherwise re-create the object with its next save, stranding a game no
  // account can reach or delete. A save is a precondition-checked write, so it
  // meets the tombstone and is refused (ACCOUNT_GONE). Account ids are random
  // and never reused; the tombstone holds nothing but the id.
  const tombstone = (key: string) => JSON.stringify({ userId: key, games: [], deleted: true });
  const rowSizes = new WeakMap<object, number>();
  const rowSize = (g: G) => {
    let n = rowSizes.get(g);
    if (n === undefined) { n = Buffer.byteLength(JSON.stringify(g)); rowSizes.set(g, n); }
    return n;
  };
  const sizeOf = (key: string, games: readonly G[], migrated: Migrated = NONE) => {
    let n = Buffer.byteLength(body(key, [], migrated));
    for (const g of games) n += rowSize(g);
    return n + Math.max(0, games.length - 1);
  };

  // freshUntil: when snapshot next re-checks (a failed re-check pushes it out);
  // verifiedAt: GCS held this copy at some moment after it, i.e. the time the
  // confirming stat (or our write) was SENT, never when its slow answer came.
  interface Entry { games: readonly G[]; generation: string; bytes: number; freshUntil: number; verifiedAt: number; deleted?: boolean; migrated: Migrated }
  const cache = new Map<string, Entry>(); // insertion order = LRU order
  let cachedBytes = 0;
  const blocked = new Map<string, string>(); // key -> why its object is not a database we can trust
  const put = (key: string, e: Entry) => {
    const old = cache.get(key);
    if (old) { cachedBytes -= old.bytes; cache.delete(key); }
    cache.set(key, e); cachedBytes += e.bytes;
    for (const [k, v] of cache) {
      if (cachedBytes <= cacheBytes || cache.size <= 1) break;
      cache.delete(k); cachedBytes -= v.bytes;
    }
  };
  const drop = (key: string) => {
    const old = cache.get(key);
    if (old) { cache.delete(key); cachedBytes -= old.bytes; }
  };
  const touch = (key: string, e: Entry) => { cache.delete(key); cache.set(key, e); };

  function parse(key: string, raw: string, generation: string): Entry {
    let doc: unknown;
    try { doc = JSON.parse(raw); } catch { doc = undefined; }
    const games = (doc as { games?: unknown } | null)?.games;
    const mig = (doc as { migrated?: unknown } | null)?.migrated;
    const why = doc === null || typeof doc !== "object" || Array.isArray(doc) ? "is not a JSON object"
      : (doc as { userId?: unknown }).userId !== key ? `names owner ${JSON.stringify((doc as { userId?: unknown }).userId)}, not ${JSON.stringify(key)}`
      : !Array.isArray(games) ? '"games" is not an array'
      : games.some((g) => g === null || typeof g !== "object" || Array.isArray(g)) ? 'a "games" element is not an object'
      : mig !== undefined && (mig === null || typeof mig !== "object" || Array.isArray(mig) || Object.values(mig).some((h) => typeof h !== "string"))
        ? '"migrated" is not a map of fingerprints'
      : null;
    if (why) {
      blocked.set(key, why);
      log(`GCS games object ${objectName(key)} BLOCKED: it ${why}. That account's saved-game routes answer 503 and nothing is written to it; repair or restore the object, then restart.`);
      throw new AccountStoreUnavailable(`${objectName(key)} ${why}`);
    }
    const rows = games as G[];
    const migrated = (mig as Migrated | undefined) ?? NONE;
    const deleted = (doc as { deleted?: unknown }).deleted === true;
    return { games: deleted ? [] : rows, generation, bytes: sizeOf(key, rows, migrated), freshUntil: now() + freshMs, verifiedAt: now(), migrated, ...(deleted ? { deleted } : {}) };
  }

  // One refresh per object at a time; a read that a write of ours overtook is
  // dropped (sweep 2's straddle: the older copy undid an acked delete). When
  // that write's copy is gone again by the time the read lands (a later 412,
  // eviction, an unknown generation), the read is not served either: it may
  // predate the acked write, so it reads again (sweep 22).
  const refreshing = new Map<string, Promise<Entry>>();
  const overtaken = new Set<string>();
  const wroteHere = (key: string) => { if (refreshing.has(key)) overtaken.add(key); };
  function refresh(key: string): Promise<Entry> {
    let p = refreshing.get(key);
    if (!p) {
      p = (async () => {
        const name = objectName(key);
        for (let vanished = 0; ;) {
          overtaken.delete(key);
          const start = cache.get(key);
          const asOf = now();
          const st = await bucket.stat(name);
          let next: Entry | null = null;
          if (st === null) next = { games: [], generation: "0", bytes: sizeOf(key, []), freshUntil: asOf + freshMs, verifiedAt: asOf, migrated: NONE };
          else if (!start || start.generation !== st.generation) {
            const raw = await bucket.read(name, st.generation);
            if (raw === null) {
              // A peer wrote between the stat and the download: follow it, with the
              // write path's budget and jitter (instances racing for one object).
              if (vanished < MAX_412) { await backoff(vanished++); continue; }
              throw new AccountStoreUnavailable(`${name}: generation ${st.generation} vanished before it could be read`);
            }
            next = { ...parse(key, raw, st.generation), freshUntil: asOf + freshMs, verifiedAt: asOf };
          }
          const cur = cache.get(key);
          if (cur !== undefined && cur !== start) return cur; // our own write landed meanwhile: it is at least as new
          if (overtaken.has(key)) continue; // ... and its copy is gone again: what this read found may predate it
          if (next === null) { // unchanged since the copy held
            start!.freshUntil = asOf + freshMs;
            start!.verifiedAt = asOf;
            return start!;
          }
          put(key, next);
          return next;
        }
      })().finally(() => { refreshing.delete(key); overtaken.delete(key); });
      refreshing.set(key, p);
    }
    return p;
  }

  function checkBlocked(key: string) {
    const why = blocked.get(key);
    if (why) throw new AccountStoreUnavailable(`${objectName(key)} ${why}`);
  }

  /**
   * One account's objects as of at most `freshMs` ago. A copy already held is
   * re-checked in the background and served if the re-check outlives
   * `waitUntil` (a slow GCS costs a request one bounded wait, never stacked); a
   * failed re-check serves the copy and backs off. With no copy, the read is
   * awaited and a failure is AccountStoreUnavailable. `deleted`: the object is
   * a tombstone (the account's deletion reached it).
   */
  async function snapshot(keys: readonly string[], waitUntil: number): Promise<{ key: string; games: readonly G[]; bytes: number; deleted: boolean }[]> {
    const view = (key: string, e: Entry) => ({ key, games: e.games, bytes: e.bytes, deleted: e.deleted === true });
    return Promise.all(keys.map(async (key) => {
      checkBlocked(key);
      const held = cache.get(key);
      if (held && now() < held.freshUntil) { touch(key, held); return view(key, held); }
      if (!held) return view(key, await refresh(key));
      held.freshUntil = now() + freshMs; // one re-check per window, however many requests arrive during it
      const p = refresh(key);
      p.catch((err) => {
        const e = cache.get(key);
        if (e) e.freshUntil = now() + READ_BACKOFF_MS;
        log(`GCS re-check of ${objectName(key)} failed; serving the copy held: ${err instanceof Error ? err.message : String(err)}`);
      });
      const wait = waitUntil - now();
      const e = wait <= 0 ? null : await Promise.race([p.catch(() => null), new Promise<null>((r) => { const t = setTimeout(() => r(null), wait); (t as { unref?: () => void }).unref?.(); })]);
      checkBlocked(key);
      return view(key, e ?? cache.get(key) ?? held);
    }));
  }

  /** The state a write builds on: the held copy (its generation is the precondition), or a fresh read. */
  async function current(key: string, force: boolean): Promise<Entry> {
    checkBlocked(key);
    const held = cache.get(key);
    if (held && !force) return held;
    if (force) drop(key);
    return refresh(key);
  }

  const owners = { known: null as Set<string> | null, pending: new Map<string, boolean>(), listing: null as Promise<void> | null, lastTry: -Infinity };
  const noteOwner = (key: string, has: boolean) => {
    if (owners.known) { if (has) owners.known.add(key); else owners.known.delete(key); }
    else if (owners.listing) owners.pending.set(key, has); // applied over the listing when it lands
  };

  type Queued = { op: GameOp<G, unknown>; extraBytes: number; resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const DELETE_ACCOUNT: GameOp<G, boolean> = () => ({ games: null, result: true });

  async function commit(key: string, ops: Queued[]): Promise<unknown[]> {
    let rechecked = false;
    for (let attempt = 0; ; attempt++) {
      const cur = await current(key, attempt > 0);
      // A deleted account's object stays deleted: every operation on it is refused.
      if (cur.deleted) return ops.map(({ op }) => (op === DELETE_ACCOUNT ? true : ACCOUNT_GONE));
      let games = cur.games, migrated = cur.migrated, bytes = cur.bytes, deleting = false;
      const landed: ((generation: string | null) => void)[] = [];
      const out = ops.map(({ op, extraBytes }) => {
        if (deleting) return ACCOUNT_GONE; // queued behind the deletion, in arrival order
        const step = op(games, { migrated });
        if (step.games === undefined && step.migrated === undefined) return step.result;
        if (step.games === null) { deleting = true; return step.result; }
        const nextGames = step.games ?? games, nextMigrated = step.migrated ?? migrated;
        const nb = sizeOf(key, nextGames, nextMigrated);
        if (!step.overCapOk && nb > bytes && nb + extraBytes > capBytes) return ACCOUNT_FULL;
        games = nextGames; migrated = nextMigrated; bytes = nb;
        if (step.committed) landed.push(step.committed);
        return step.result;
      });
      if (games === cur.games && migrated === cur.migrated && !deleting) {
        // Nothing to write, so no precondition vouches for this copy: an answer
        // (413 full, 409 limit, 404 not found) comes only from a copy GCS
        // confirmed within freshMs. One re-check (a stat when unchanged), then
        // the batch runs again on what it found (sweep 21: a copy held for an
        // hour refused saves another instance had made room for).
        if (!rechecked && now() - cur.verifiedAt >= freshMs) {
          rechecked = true;
          try {
            // Joining a re-check sent before this one asked may yield what GCS held
            // before a peer's acked write (sweep 23): then ask once more, afresh.
            const asked = now();
            if ((await refresh(key)).verifiedAt < asked) await refresh(key);
          } catch (err) {
            throw new AccountStoreUnavailable(`${objectName(key)} re-check failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          attempt--;
          continue;
        }
        return out;
      }
      const name = objectName(key);
      const text = deleting ? tombstone(key) : body(key, games, migrated);
      const asOf = now();
      let generation: string | null;
      try {
        generation = await bucket.write(name, text, cur.generation, { count: deleting ? "0" : String(games.length) });
      } catch (err) {
        drop(key); // stale (412) or unknown (a deadline may still land): never build on this copy again
        const code = (err as { code?: unknown })?.code;
        let mine: string | null = null;
        if (code === 412) {
          try {
            mine = await ownWrite(name, text);
          } catch (e) {
            // Whether it was ours is unknown, as after a deadline: an honest 503, never a
            // re-apply of a batch that may have landed (Sweep 31).
            throw new AccountStoreUnavailable(`${name} write answered 412 and could not be checked: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (mine === null) {
          if (code === 412 && attempt < MAX_412) {
            await backoff(attempt);
            continue;
          }
          throw new AccountStoreUnavailable(`${name} write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        generation = mine;
      }
      const next: Entry = deleting ? { games: [], generation: generation ?? "", bytes: Buffer.byteLength(text), freshUntil: asOf + freshMs, verifiedAt: asOf, deleted: true, migrated: NONE }
        : { games, generation: generation ?? "", bytes, freshUntil: asOf + freshMs, verifiedAt: asOf, migrated };
      if (generation === null) drop(key); // landed, generation unknown: the next use re-reads
      else put(key, next);
      wroteHere(key);
      noteOwner(key, !deleting && games.length > 0);
      for (const f of landed) f(generation);
      return out;
    }
  }

  /**
   * A 412 that is our own write, landed: the storage library retries a
   * conditional upload whose answer was lost (v7 turns auto-retry on when
   * ifGenerationMatch is set), and the retry meets the generation the first
   * attempt made. Re-applying the batch then answered a delete that happened
   * 404 and appended a POST without clientRequestId twice (Sweep 30). The
   * object holding exactly our bytes is that write (or the same state written
   * by a peer: the same outcome); its generation, or null when it holds
   * something else. A check that cannot be answered throws.
   */
  async function ownWrite(name: string, text: string): Promise<string | null> {
    const st = await bucket.stat(name);
    if (st === null) return null;
    return (await bucket.read(name, st.generation)) === text ? st.generation : null;
  }

  // Group commit: one upload in flight per object; operations that arrive
  // meanwhile are applied together, in arrival order, in the next one.
  const queues = new Map<string, { waiting: Queued[]; run: Promise<void> | null }>();
  function mutate<T>(key: string, op: GameOp<G, T>, options: { extraBytes?: number } = {}): Promise<T | typeof ACCOUNT_FULL | typeof ACCOUNT_GONE> {
    return new Promise((resolve, reject) => {
      let q = queues.get(key);
      if (!q) { q = { waiting: [], run: null }; queues.set(key, q); }
      q.waiting.push({ op: op as GameOp<G, unknown>, extraBytes: options.extraBytes ?? 0, resolve: resolve as (v: unknown) => void, reject });
      if (!q.run) {
        const queue = q;
        queue.run = (async () => {
          while (queue.waiting.length > 0) {
            const batch = queue.waiting.splice(0);
            try {
              const out = await commit(key, batch);
              batch.forEach((w, i) => w.resolve(out[i]));
            } catch (err) {
              for (const w of batch) w.reject(err);
            }
          }
          queue.run = null;
          queues.delete(key);
        })();
      }
    });
  }

  /** Resolves once no write is in flight or queued (SIGTERM drain). */
  async function idle(): Promise<void> {
    while (queues.size > 0) await Promise.all([...queues.values()].map((q) => q.run));
  }
  /** Whether a write is in flight or queued right now. */
  const busy = () => queues.size > 0;

  // Keys whose account deletion is in progress here: the routes refuse new
  // game writes for them meanwhile, so none is queued behind the tombstone.
  const deletingNow = new Map<string, number>();
  /** Whether this process is tombstoning this key's object right now. */
  const deleting = (key: string) => (deletingNow.get(key) ?? 0) > 0;

  /** Tombstone every object of these accounts (account deletion), behind any write already queued for each. */
  async function removeAll(keys: readonly string[]): Promise<void> {
    const unique = [...new Set(keys)];
    for (const k of unique) deletingNow.set(k, (deletingNow.get(k) ?? 0) + 1);
    try {
      await Promise.all(unique.map((key) => mutate(key, DELETE_ACCOUNT)));
    } finally {
      for (const k of unique) { const n = (deletingNow.get(k) ?? 1) - 1; if (n > 0) deletingNow.set(k, n); else deletingNow.delete(k); }
    }
  }

  // Accounts deleted elsewhere whose objects are still to be tombstoned: owed
  // until the tombstones land. Paid by the call that owes them and re-armed on
  // its own until paid — keys owed while a payment was out, and a failed one
  // (backing off) — never left waiting for a later call that may not come: a
  // lone instance's db.json changes only by its own writes (Sweep 28).
  const owedTombstones = new Set<string>();
  let paying: Promise<void> | null = null, failures = 0, rearm: ReturnType<typeof setTimeout> | null = null;
  function tombstoneEventually(keys: readonly string[]): void {
    for (const k of keys) owedTombstones.add(k);
    payOwed();
  }
  function payOwed(): void {
    if (paying || rearm || owedTombstones.size === 0) return;
    const owed = [...owedTombstones];
    paying = removeAll(owed).then(
      () => { for (const k of owed) owedTombstones.delete(k); failures = 0; },
      (err) => { failures++; log(`Tombstoning the objects of ${owed.length} account(s) deleted elsewhere failed; retrying: ${err instanceof Error ? err.message : String(err)}`); },
    ).finally(() => {
      paying = null;
      if (owedTombstones.size === 0) return;
      rearm = setTimeout(() => { rearm = null; payOwed(); }, failures === 0 ? 0 : Math.min(60_000, 500 * 2 ** (failures - 1)));
      (rearm as { unref?: () => void }).unref?.();
    });
  }

  /** key -> stored game count, from one listing (custom metadata stamped on every write). */
  // Page by page, each under its own deadline (the adapter's), keeping only
  // key -> count: the objects only grow (every account that saved, and a
  // tombstone per deleted one), and one listing of them all held at once ran
  // a 128 MB heap out of memory on every boot past ~15k (Sweep 30). Callers
  // share the listing in flight, so they never stack.
  let counting: Promise<Map<string, number>> | null = null;
  function counts(): Promise<Map<string, number>> {
    counting ??= (async () => {
      const out = new Map<string, number>();
      let token: string | undefined;
      do {
        const page = await bucket.list(ACCOUNT_GAMES_PREFIX, token);
        for (const f of page.items) {
          if (!f.name.endsWith(".json")) continue;
          const n = Number(f.metadata?.count);
          out.set(keyOf(f.name), Number.isFinite(n) && n >= 0 ? n : 0);
        }
        token = page.next ?? undefined;
      } while (token);
      return out;
    })().finally(() => { counting = null; });
    return counting;
  }

  /**
   * Ids that own stored games, or null while unknown (the caller then must not
   * act on absence). Listed once on first use, then kept by this process's own
   * writes; a peer's new owner is a verified account, which nothing sweeps.
   */
  function knownOwners(): Set<string> | null {
    if (!owners.known && !owners.listing && now() - owners.lastTry > 60_000) {
      owners.lastTry = now();
      owners.pending.clear();
      owners.listing = counts().then((c) => {
        const known = new Set([...c].filter(([, n]) => n > 0).map(([k]) => k));
        for (const [k, has] of owners.pending) { if (has) known.add(k); else known.delete(k); }
        owners.pending.clear();
        owners.known = known;
      }, (err) => log(`Listing ${ACCOUNT_GAMES_PREFIX}* failed; pending-row sweeps wait for it: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { owners.listing = null; });
    }
    return owners.known;
  }

  /**
   * LOSSLESS, IDEMPOTENT, RESUMABLE migration of db.json's legacy `games`
   * array into the per-account objects. Each row goes to its own `userId`'s
   * object (rows with no string owner to `games/.json`, kept, never served).
   *
   * THE OBJECT RECORDS WHAT WAS MIGRATED INTO IT: `migrated` maps each legacy
   * row's identity to a fingerprint of the db.json copy it came from. The
   * legacy array stays in db.json until the write clearing it lands, so a
   * migration can run again over the same rows (that write 412'd because a
   * previous revision wrote db.json during a rollover, the process died, a
   * second instance read the same generation). A row recorded with the same
   * fingerprint is skipped, so whatever the account did to it since — deleted,
   * edited — stands (a re-run never brings back a deleted game). A row whose
   * db.json copy CHANGED since it was recorded was edited on the previous
   * revision: that edit lands if the account has not touched the row here, and
   * otherwise this side stands and the collision is reported. A row not yet
   * recorded is added if absent; if a different copy is already there (an
   * interrupted run from before records existed), this side stands, reported.
   *
   * A row MISSING from a later legacy array is never taken for a deletion:
   * a clear landing, a previous-revision upload that timed out yet landed, a
   * blocked account's rows kept back — each makes rows vanish from db.json
   * without anyone deleting them, and inferring deletions from that wiped
   * other accounts' games (Sweep 20). The cost, accepted: a game deleted on the
   * PREVIOUS revision, during a rollover, after this revision migrated it,
   * stays in its object (it reappears; nothing is lost).
   *
   * Rows sharing an id: byte-identical copies are one row; copies that differ
   * are kept as distinct rows (`id:X`, `id#2:X`, ...), exactly as db.json held
   * them, so no copy is lost. Those identities are positional, so they shift
   * when db.json loses a copy (a previous revision's merge keys games by id):
   * a row whose content is recorded under ANY identity of its id was migrated,
   * and an edit is applied only to an id with one recorded copy. A changed row
   * of an id with several is kept as one more copy, never written over one
   * (Sweep 34: a re-run overwrote copy 1 with copy 2).
   *
   * Every row this run wrote is then read BACK from GCS — the very generation
   * this run wrote, never the cache — and compared byte for byte (its JSON);
   * any miss throws, and the caller must not clear the legacy array. The cap
   * never refuses a migrated row. An account whose object is blocked (not a
   * database we can trust) is skipped and its rows are returned in `kept`, to
   * stay in db.json: one corrupt object must not stall every account.
   */
  async function migrate(legacy: readonly unknown[]): Promise<{ accounts: number; rows: number; added: number; conflicts: string[]; kept: G[] }> {
    const byOwner = (rows: readonly unknown[]) => {
      const out = new Map<string, G[]>();
      for (const g of rows as G[]) {
        const key = typeof g?.userId === "string" ? g.userId : "";
        const list = out.get(key) ?? [];
        list.push(g);
        out.set(key, list);
      }
      return out;
    };
    // Identity, stable across runs over the same array: the id (copies that
    // differ are id#2:, id#3:... in order, a prefix no plain id:<id> can take
    // whatever the id holds; byte-identical copies share one), or with
    // no string id the row's JSON plus its occurrence number, so identical
    // id-less rows are neither merged nor duplicated.
    const identities = (rows: readonly G[]) => {
      const seen = new Map<string, string[]>(), occ = new Map<string, number>();
      return rows.map((g) => {
        const j = JSON.stringify(g);
        if (typeof g.id === "string") {
          const copies = seen.get(g.id) ?? [];
          let k = copies.indexOf(j);
          if (k === -1) { k = copies.length; copies.push(j); seen.set(g.id, copies); }
          return k === 0 ? `id:${g.id}` : `id#${k + 1}:${g.id}`;
        }
        const k = occ.get(j) ?? 0;
        occ.set(j, k + 1);
        return `json:${j}#${k}`;
      });
    };
    // The id an `id:` / `id#k:` identity stands for (null for an id-less row's).
    const rawId = (id: string) => (id.startsWith("id:") ? id.slice(3) : /^id#\d+:/.test(id) ? id.slice(id.indexOf(":") + 1) : null);
    // What the log names a row by: an id-less row's identity is its whole JSON (game contents), so its fingerprint (Sweep 30).
    const shown = (id: string) => (id.startsWith("json:") ? `json#${fingerprint(id)}` : id);
    const groups = byOwner(legacy);
    const conflicts: string[] = [], kept: G[] = [];
    let added = 0;
    const work = [...groups];
    const keep = (key: string, rows: G[]) => {
      kept.push(...rows);
      conflicts.push(`${objectName(key)} blocked (${blocked.get(key)}): its ${rows.length} row(s) stay in db.json`);
    };
    // The first failure ends the run: no worker starts another account, and the run rejects only once
    // the writes already sent have settled, so nothing writes after the caller has given up on this
    // read (Sweep 33: abandoned workers kept writing objects from a db.json read never adopted).
    let failed = false;
    const next = () => (failed ? undefined : work.shift());
    const worker = async () => {
      try { await account(); } catch (err) { failed = true; throw err; }
    };
    const account = async () => {
      for (let item = next(); item; item = next()) {
        const [key, rows] = item;
        if (blocked.has(key)) { keep(key, rows); continue; }
        const name = objectName(key);
        const rowIds = identities(rows), prints = rows.map((g) => fingerprint(JSON.stringify(g)));
        const clash = new Set<string>(), wrote = new Set<number>(); // rows this run put in the object (must read back byte-identical)
        const used = new Map<number, string>(); // rows recorded under another identity than their position gives
        let ours: string | null | undefined; // the generation this run's write produced (undefined: it wrote nothing)
        let r: number | typeof ACCOUNT_FULL | typeof ACCOUNT_GONE;
        try {
          r = await mutate(key, (games, object) => {
            clash.clear(); wrote.clear(); used.clear(); ours = undefined;
            const at = new Map(identities(games).map((id, i) => [id, i] as const));
            const next = [...games], record: Record<string, string> = { ...object.migrated };
            // Each id's recorded copies, fingerprint -> the identity it is recorded under.
            const copies = new Map<string, Map<string, string>>();
            const note = (id: string, print: string) => {
              const x = rawId(id);
              if (x !== null) copies.set(x, (copies.get(x) ?? new Map()).set(print, id));
            };
            for (const [id, print] of Object.entries(record)) note(id, print);
            let changed = false;
            rows.forEach((g, i) => {
              const id = rowIds[i], print = prints[i], was = record[id], j = at.get(id);
              if (was === print) return; // migrated before with this content: what the account did since stands
              const x = rawId(id), known = x === null ? undefined : copies.get(x);
              const under = known?.get(print);
              if (under !== undefined) { used.set(i, under); return; } // migrated before, as another copy of its id
              if (was !== undefined && x !== null && known !== undefined && known.size > 1) {
                // Changed, or moved to another copy's place: which copy it was cannot be told. Kept
                // as one more copy under a fresh identity, never written over one (Sweep 34).
                let k = 2;
                while (record[`id#${k}:${x}`] !== undefined || at.has(`id#${k}:${x}`)) k++;
                const fresh = `id#${k}:${x}`;
                at.set(fresh, next.length); next.push(g); wrote.add(i); used.set(i, fresh);
                record[fresh] = print; note(fresh, print); changed = true;
                return;
              }
              if (was !== undefined) {
                // The db.json copy changed since it was migrated: edited on a previous revision.
                if (j !== undefined && fingerprint(JSON.stringify(next[j])) === was) { next[j] = g; wrote.add(i); } else clash.add(id);
              } else if (j === undefined) {
                at.set(id, next.length); next.push(g); wrote.add(i);
              } else if (JSON.stringify(next[j]) !== JSON.stringify(g)) {
                clash.add(id);
              }
              record[id] = print; note(id, print); changed = true;
            });
            return changed
              ? { games: next, migrated: record, result: wrote.size, overCapOk: true, committed: (generation) => { ours = generation; } }
              : { result: 0 };
          });
        } catch (err) {
          if (blocked.has(key)) { keep(key, rows); continue; }
          throw err;
        }
        // The account was deleted (its object is a tombstone): its legacy rows go with it,
        // as unionMergeDb drops the games of a deleted account. Reported, not restored.
        if (r === ACCOUNT_GONE) { for (const id of rowIds) conflicts.push(`${name} ${shown(id)} (account deleted)`); continue; }
        added += r as number;
        // Read back from GCS itself, never the cache: the generation this run wrote
        // when it wrote one, else (nothing to write, or the account wrote since)
        // the live object, whose record then vouches for rows the account changed.
        let raw = ours ? await bucket.read(name, ours) : null;
        const exact = raw !== null;
        let generation = ours ?? "";
        // A peer writing between the stat and the download is followed, as in refresh (Sweep 24).
        for (let vanished = 0; raw === null; vanished++) {
          const st = await bucket.stat(name);
          if (st === null) throw new Error(`migration: ${name} is missing after its write`);
          generation = st.generation;
          raw = await bucket.read(name, st.generation);
          if (raw === null && vanished >= MAX_412) throw new AccountStoreUnavailable(`migration: ${name} kept changing under its read-back`);
          if (raw === null) await backoff(vanished);
        }
        const stored = parse(key, raw, generation);
        if (stored.deleted) { for (const id of rowIds) conflicts.push(`${name} ${shown(id)} (account deleted)`); continue; }
        const byId = new Map(identities(stored.games).map((id, i) => [id, JSON.stringify(stored.games[i])] as const));
        const texts = new Set(stored.games.map((x) => JSON.stringify(x)));
        rows.forEach((g, i) => {
          const id = used.get(i) ?? rowIds[i];
          // A row kept under a fresh identity sits wherever the object put it: found by its bytes.
          const s = used.has(i) ? (texts.has(JSON.stringify(g)) ? JSON.stringify(g) : undefined) : byId.get(id);
          if (stored.migrated[id] === undefined) throw new Error(`migration: ${shown(id)} of ${name} is not recorded as migrated`);
          if (!wrote.has(i) || s === JSON.stringify(g)) return;
          if (!exact && stored.migrated[id] === prints[i]) return; // the account changed it after this run's write landed
          throw new Error(`migration: ${shown(id)} of ${name} ${s === undefined ? "did not reach GCS" : "reads back different bytes"}`);
        });
        for (const id of clash) conflicts.push(`${name} ${shown(id)}`);
      }
    };
    const settled = await Promise.allSettled(Array.from({ length: Math.min(4, work.length) }, worker));
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
    return { accounts: groups.size, rows: legacy.length, added, conflicts, kept };
  }

  return { snapshot, mutate, removeAll, deleting, tombstoneEventually, counts, knownOwners, migrate, idle, busy, objectName, sizeOf };
}

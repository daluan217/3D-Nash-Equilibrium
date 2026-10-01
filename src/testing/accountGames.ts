/**
 * The hosted per-account game store (src/server/accountGameStore.ts), loaded
 * from the REAL module, and an in-memory bucket with GCS's semantics for it to
 * run against: per-object generations from one increasing counter,
 * `ifGenerationMatch` ('0' = must not exist) as a 412, a download bound to a
 * generation that is no longer live as null.
 *
 * `STORE_TS` points the loader at another copy of the store module and
 * `SERVER_TS` at another copy of server.ts (mutation runs).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Game { id?: unknown; userId?: unknown; [k: string]: unknown }
type Op = (games: readonly Game[], object: { migrated: Readonly<Record<string, string>> }) => {
  games?: Game[] | null; result: unknown; overCapOk?: boolean; migrated?: Record<string, string>; committed?: (generation: string | null) => void };
export interface Store {
  snapshot(keys: string[], waitUntil: number): Promise<{ key: string; games: Game[]; bytes: number; deleted: boolean }[]>;
  mutate(key: string, op: Op, o?: { extraBytes?: number }): Promise<unknown>;
  removeAll(keys: string[]): Promise<void>;
  deleting(key: string): boolean;
  tombstoneEventually(keys: string[]): void;
  counts(): Promise<Map<string, number>>;
  knownOwners(): Set<string> | null;
  migrate(legacy: unknown[], readGeneration?: string): Promise<{ accounts: number; rows: number; added: number; conflicts: string[]; kept: Game[] }>;
  idle(): Promise<void>;
  objectName(key: string): string;
  sizeOf(key: string, games: readonly Game[]): number;
}
export interface Loaded {
  create(o: { bucket: MemoryBucket; capBytes: number; freshMs?: number; cacheBytes?: number; now?: () => number; log?: (m: string) => void }): Store;
  FULL: symbol;
  GONE: symbol;
  /** server.ts (the cap constants, the routes and the sync wiring live there). */
  source: string;
}

export async function loadAccountGameStore(): Promise<Loaded> {
  const storePath = process.env.STORE_TS ?? new URL('../server/accountGameStore.ts', import.meta.url).pathname;
  const mod = await import(pathToFileURL(storePath).href) as { createAccountGameStore: (o: unknown) => Store; ACCOUNT_FULL: symbol; ACCOUNT_GONE: symbol };
  const source = readFileSync(process.env.SERVER_TS ?? new URL('../../server.ts', import.meta.url).pathname, 'utf8');
  return {
    create: (o) => mod.createAccountGameStore({ freshMs: 2_000, cacheBytes: 64 * 1024 * 1024, now: () => performance.now(), ...o }),
    FULL: mod.ACCOUNT_FULL,
    GONE: mod.ACCOUNT_GONE,
    source,
  };
}

export class Http412 extends Error { code = 412; }

export interface MemoryBucket {
  objects: Map<string, { body: string; generation: string; metadata: Record<string, string> }>;
  ops: { stat: number; read: number; write: number; list: number };
  /** Called before a write is applied; may throw (a failed upload) or change `objects` (a peer write). */
  beforeWrite?: (name: string, body: string) => void;
  /** Called after a write is applied (a peer writing right on top of it). */
  afterWrite?: (name: string) => void;
  /** Rewrites what is stored (a bucket that corrupts bytes). */
  transform?: (name: string, body: string) => string;
  peerWrite(name: string, body: string): void;
  stat(name: string): Promise<{ generation: string } | null>;
  read(name: string, generation: string): Promise<string | null>;
  write(name: string, body: string, ifGenerationMatch: string, metadata: Record<string, string>): Promise<string | null>;
  list(prefix: string, pageToken?: string): Promise<{ items: { name: string; metadata: Record<string, string> }[]; next: string | null }>;
  /** Objects per listing page (GCS may return fewer than asked). */
  pageSize: number;
}

export function memoryBucket(): MemoryBucket {
  let gen = 1000;
  const objects: MemoryBucket['objects'] = new Map();
  const tick = () => new Promise<void>((r) => setImmediate(r)); // every call is a real await, as over the network
  const b: MemoryBucket = {
    objects,
    ops: { stat: 0, read: 0, write: 0, list: 0 },
    peerWrite(name, body) { objects.set(name, { body, generation: String(++gen), metadata: {} }); },
    async stat(name) { b.ops.stat++; await tick(); const o = objects.get(name); return o ? { generation: o.generation, metadata: { ...o.metadata } } : null; },
    async read(name, generation) { b.ops.read++; await tick(); const o = objects.get(name); return o && o.generation === generation ? o.body : null; },
    async write(name, body, ifGenerationMatch, metadata) {
      b.ops.write++; await tick();
      b.beforeWrite?.(name, body);
      const o = objects.get(name);
      if (ifGenerationMatch === '0' ? o !== undefined : o?.generation !== ifGenerationMatch) throw new Http412('Precondition Failed');
      const g = String(++gen);
      objects.set(name, { body: b.transform ? b.transform(name, body) : body, generation: g, metadata: { ...metadata } });
      b.afterWrite?.(name);
      return g;
    },
    pageSize: 1000,
    async list(prefix, pageToken) {
      b.ops.list++; await tick();
      const all = [...objects].filter(([n]) => n.startsWith(prefix)).sort(([a], [c]) => (a < c ? -1 : 1));
      const from = pageToken ? Number(pageToken) : 0, to = from + b.pageSize;
      return { items: all.slice(from, to).map(([name, o]) => ({ name, metadata: o.metadata })), next: to < all.length ? String(to) : null };
    },
  };
  return b;
}

/** The games stored in one object (parsed), or null when it does not exist. */
export function storedGames(b: MemoryBucket, name: string): Game[] | null {
  const o = b.objects.get(name);
  return o ? (JSON.parse(o.body).games as Game[]) : null;
}

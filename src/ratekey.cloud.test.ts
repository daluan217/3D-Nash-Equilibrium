/**
 * The rate limiter's client key (server.ts `rateKey`), run from the real source.
 * Live on prod (sweep 9): 21 POSTs from one IPv6 address hit 429 while a second
 * address in the SAME /64 got a fresh bucket, so every per-IP limit (login,
 * verify lockout, register, report spend) was per-address for IPv6 clients.
 * The key is now the /56; an IPv4-mapped address keys as its IPv4. The contract
 * half: every limiter keys through rateKey, and nothing else reads req.ip.
 *
 *   npx tsx src/ratekey.cloud.test.ts
 */
import assert from 'node:assert';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const start = src.indexOf('function rateKey(');
const end = src.indexOf('\n}\n', start) + 2;
assert(start > 0 && end > start, 'rateKey is gone from server.ts');
const js = ts.transpileModule(src.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const rateKey = new Function('net', `${js}; return rateKey;`)(net) as (req: unknown) => string;
const key = (ip: string) => rateKey({ ip, socket: {} });

let n = 0;
const eq = (ip: string, want: string) => { assert.strictEqual(key(ip), want, `${ip} -> ${key(ip)}, want ${want}`); n++; };
// Every spelling of one /56 is one key; the next /56 is another.
for (const ip of ['2607:f010:2e9:10d:84b:6f82:3e4f:fc27', '2607:f010:2e9:1ff::1', '2607:f010:2e9:100::', '2607:F010:02E9:0100:0:0:0:1', '2607:f010:2e9:1ab:0:0:1.2.3.4'])
  eq(ip, '2607:f010:2e9:100::/56');
eq('2607:f010:2e9:20d::1', '2607:f010:2e9:200::/56');
eq('fe80::1%en0', 'fe80:0:0:0::/56');
eq('::1', '0:0:0:0::/56');
// IPv4 and IPv4-mapped stay per-address IPv4 (dotted and hex spellings agree).
for (const [ip, want] of [['203.0.113.7', '203.0.113.7'], ['::ffff:203.0.113.7', '203.0.113.7'], ['::FFFF:cb00:7107', '203.0.113.7'], ['0:0:0:0:0:ffff:203.0.113.8', '203.0.113.8']])
  eq(ip, want);
assert.notStrictEqual(key('::ffff:203.0.113.7'), key('::ffff:203.0.113.8'), 'two mapped IPv4 clients must not share a bucket'); n++;
eq('unknown', 'unknown');
// Seeded fuzz: any IPv6 address, its /56 sibling, and the same address with a
// zero run of any length at any position written as '::', share one 4-group key.
let seed = 20260924;
const r16 = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16; // exact 32-bit LCG, high bits
const hex = (g: number[]) => g.map((x) => x.toString(16)).join(':');
let fuzzed = 0;
for (let i = 0; i < 20000; i++) {
  const g = Array.from({ length: 8 }, r16);
  const at = r16() % 8, len = 1 + (r16() % (8 - at));
  for (let j = at; j < at + len; j++) g[j] = 0;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) continue; // mapped / IPv4-compatible
  const sib = [...g.slice(0, 3), (g[3] & 0xff00) | (r16() & 0xff), r16(), r16(), r16(), r16()];
  const comp = `${hex(g.slice(0, at))}::${hex(g.slice(at + len))}`;
  const k1 = key(hex(g));
  assert(/^([0-9a-f]{1,4}:){4}:\/56$/.test(k1) && k1 === key(hex(sib)) && k1 === key(comp),
    `fuzz ${hex(g)} | ${comp} | ${hex(sib)}: ${k1} ${key(comp)} ${key(hex(sib))}`);
  fuzzed++;
}
assert(fuzzed > 15000, `fuzz ran only ${fuzzed}`); n++;

// Contract: one key function. The limiter keys with rateKey(req), and no other
// line in server.ts reads req.ip / remoteAddress to build a throttle key.
const limiter = src.slice(src.indexOf('function rateLimit('), src.indexOf('\n}\n', src.indexOf('function rateLimit(')));
assert(/const key = `\$\{label\}:\$\{rateKey\(req\)\}`;/.test(limiter), 'rateLimit must key as `${label}:${rateKey(req)}`'); n++;
const readers = src.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => /\breq\.ip\b|remoteAddress/.test(l) && !/^\s*\/\//.test(l));
assert.deepStrictEqual(readers.map(([, l]) => l.trim()), ['const ip = (req.ip || req.socket.remoteAddress || "unknown").replace(/%.*$/, "");'],
  `only rateKey may read the client address: ${JSON.stringify(readers)}`); n++;
const calls = src.match(/rateLimit\(\s*"[^"]+"/g) ?? [];
assert(calls.length >= 15, `expected every route limiter via rateLimit(), found ${calls.length}`); n++;
// Per route (sweep 15: the count above let one route lose its limiter, or a login budget go to 10000, unseen):
// each /api route's limiter as `label max scope`, before its handler; health is cheap and unlimited by design.
const ROUTES: Record<string, string | null> = {
  'get /api/admin/stats': 'admin 10 always', 'get /api/health': null, 'get /api/version': 'version 60 hosted-only',
  'post /api/report': 'report 20 hosted-only', 'post /api/scenario/regenerate': 'report 20 hosted-only',
  'post /api/feedback': 'feedback 10 always', 'get /api/download/dmg': 'dmg 10 always', 'post /api/auth/register': 'register 8 always',
  'post /api/auth/verify': 'verify 12 always', 'post /api/auth/login': 'login 10 always', 'get /api/auth/me': 'me 60 always',
  'post /api/auth/forgot-password': 'forgot 6 always', 'post /api/auth/reset-password': 'reset 8 always',
  'post /api/auth/delete-request': 'delete-request 6 always', 'post /api/auth/delete-confirm': 'delete-confirm 8 always',
  'get /api/auth/desktop-hint': 'desktop-hint 30 always', 'get /api/games': 'games-read 60 hosted-only',
  'post /api/games': 'games-write 20 hosted-only', 'patch /api/games/:id': 'games-write 20 hosted-only',
  'post /api/games/adopt-local': 'games-adopt 10 hosted-only', 'delete /api/games/:id': 'games-delete 30 hosted-only',
};
const routeLimits = (text: string) => Object.fromEntries([...text.matchAll(/\bapp\.(get|post|put|patch|delete|all|head|options)\(\s*"(\/api[^"]*)",([^\n]*)/g)].map(([, verb, p, rest]) => {
  const lim = /^(.*?)\brateLimit\(\s*"([^"]+)",\s*([\d_]+),\s*[\d_]+(?:,\s*'([\w-]+)')?\)/.exec(rest);
  return [`${verb} ${p}`, lim && !/\(req\b|asyncHandler\(/.test(lim[1]) ? `${lim[2]} ${Number(lim[3].replace(/_/g, ''))} ${lim[4] ?? 'always'}` : null];
}));
const verbs = (text: string) => (text.match(/\bapp\.(get|post|put|patch|delete|all|head|options|route)\(/g) ?? []).length;
const routeFaults = (text: string) => [
  ...(JSON.stringify(routeLimits(text)) === JSON.stringify(ROUTES) ? [] : [`limiters ${JSON.stringify(routeLimits(text))}`]),
  // Every verb registration is an /api one above or one of the two SPA-side gets; a Router mounts routes unseen.
  ...(verbs(text) === Object.keys(ROUTES).length + 2 && /app\.get\('\/assets\/:file'/.test(text) && /app\.get\('\*'/.test(text) ? [] : [`${verbs(text)} app.<verb>( calls`]),
  // The five /api app.use( are gatekeepers (save guard, no-store, auth field types, store gate, the 404 catch-all).
  ...((text.match(/\bapp\.use\(\s*\[?\s*['"]\/api/g) ?? []).length === 5 ? [] : ['an /api app.use( mount beyond the reviewed five']),
  ...(/\bRouter\(|\bapp\[/.test(text) ? ['a Router or app[...] registration'] : [])];
assert.deepStrictEqual(routeFaults(src), [], 'server.ts: a route\'s rate limit is not the reviewed one (a route added, unlimited, re-budgeted or re-scoped)'); n++;
// The table's own reach: each of these edits to the real source must be seen.
for (const [what, a, b] of [['limiter dropped', 'app.get("/api/auth/desktop-hint", rateLimit("desktop-hint", 30, 60_000), ', 'app.get("/api/auth/desktop-hint", '],
  ['budget raised', 'rateLimit("login", 10, 60_000)', 'rateLimit("login", 10_000, 60_000)'], ['re-scoped', 'rateLimit("verify", 12, 60_000)', 'rateLimit("verify", 12, 60_000, \'hosted-only\')'],
  ['limiter after the handler', 'rateLimit("me", 60, 60_000), (req, res) =>', '(req, res, next) => next(), rateLimit("me", 60, 60_000), (req, res) =>'],
  ['route added', 'app.get("/api/health", ', 'app.get("/api/x", (q, s) => s.end()); app.get("/api/health", '],
  ['path by variable', 'app.get("/api/health", ', 'app.get(P, (q, s) => s.end()); app.get("/api/health", '], ['router', 'app.get("/api/health", ', 'app.use(express.Router()); app.get("/api/health", '],
  ['use-mounted handler', 'app.get("/api/health", ', 'app.use("/api/y", (q, s) => s.end()); app.get("/api/health", ']] as const) {
  assert(src.includes(a) && routeFaults(src.replace(a, b)).length > 0, `ratekey route table: "${what}" in server.ts passed it`); n++;
}

// Retry-After (director audit s16: "always 1" and "+60" both passed the old 1..60 range check). The limiter
// runs from source on a controlled clock: a 429 names ceil(remaining), a retry 1 s sooner is still
// refused, and a retry after exactly Retry-After passes.
type Mw = (req: unknown, res: unknown, next: () => void) => void;
let clock = 0, wall = 0; // monotonic time; the wall clock, stepped by the skew check below
const span = src.slice(src.indexOf('const rateBuckets = new Map'), src.indexOf('\n}\n', src.indexOf('function rateLimit(')) + 2);
const limit = new Function('net', 'process', 'performance', 'Date', `${ts.transpileModule(span, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return rateLimit;`)(
  net, { env: {} }, { now: () => clock }, { now: () => wall }) as (label: string, max: number, windowMs: number) => Mw;
const hit = (mw: Mw, t: number, step = 0) => {
  clock = t; wall = t + step; let passed = false, code = 0, ra: string | undefined;
  const res = { setHeader: (k: string, v: string) => { if (k === 'Retry-After') ra = v; }, status: (c: number) => { code = c; return res; }, json: () => res };
  mw({ ip: '203.0.113.9', socket: {} }, res, () => { passed = true; });
  return { passed, code, ra };
};
for (const d of [0, 1, 999, 1000, 1001, 30_500, 58_999, 59_000, 59_001, 59_999]) {
  const mw = limit(`ra${d}`, 2, 60_000), T0 = 1_000_000, want = Math.ceil((60_000 - d) / 1000);
  hit(mw, T0); hit(mw, T0);
  const r = hit(mw, T0 + d);
  assert(r.code === 429 && r.ra === String(want), `at +${d} ms: ${r.code} Retry-After ${r.ra}, want ${want}`);
  assert.strictEqual(hit(mw, T0 + d + (want - 1) * 1000).code, 429, `+${d}: a retry 1 s before Retry-After must still be refused`);
  assert(hit(mw, T0 + d + want * 1000).passed, `+${d}: a retry after exactly Retry-After (${want}s) must pass`);
  n += 3;
}

// Clock skew (sweep 17): the window runs on the monotonic clock. A wall clock stepped back 10 min
// after the 429 must not hold the client past 60 s; one stepped forward 10 min must not open it early.
for (const step of [-600_000, 600_000]) {
  const mw = limit(`skew${step}`, 2, 60_000), T = 1_000_000;
  hit(mw, T); hit(mw, T);
  assert.strictEqual(hit(mw, T + 5000, step).code, 429, `wall step ${step}: the 3rd hit inside the window must be refused`);
  assert.strictEqual(hit(mw, T + 30_000, step).code, 429, `wall step ${step}: the window must not open early`);
  assert(hit(mw, T + 60_000, step).passed, `wall step ${step}: the window must open at 60 s of real time`);
  n += 3;
}

// Prune cost (sweep 20): a full scan per call once 1000 buckets were live made every limited request
// O(live), 1.75 ms at 200k distinct /56s. Windows share one clock, so expired buckets leave from the
// front: over 20k distinct clients inside one window, then 20k more after it, work per call stays O(1).
{
  let steps = 0;
  class CountingMap<K, V> extends Map<K, V> { *[Symbol.iterator]() { for (const e of super.entries()) { steps++; yield e; } } }
  const fresh = new Function('net', 'process', 'performance', 'Date', 'Map', `${ts.transpileModule(span, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return { rateLimit, rateBuckets };`)(
    net, { env: {} }, { now: () => clock }, { now: () => wall }, CountingMap) as { rateLimit: typeof limit; rateBuckets: Map<string, unknown> };
  const mw = fresh.rateLimit('prune', 5, 60_000), res = { setHeader() {}, status() { return res; }, json() { return res; } };
  const at = (t: number, i: number) => { clock = t; mw({ ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, socket: {} }, res, () => {}); };
  for (let i = 0; i < 20_000; i++) at(1_000_000 + i, i);
  const live = fresh.rateBuckets.size;
  for (let i = 0; i < 20_000; i++) at(2_000_000 + i, 20_000 + i);
  assert(live === 20_000 && fresh.rateBuckets.size === 20_000, `buckets: ${live} live in the window, ${fresh.rateBuckets.size} after it (the first 20k expired)`); n++;
  assert(steps > 0 && steps <= 3 * 40_000, `prune visited ${steps} entries over 40,000 calls: must be O(1) per call, not O(live)`); n++;
  // The front-prune is exact only while insertion order is expiry order: one window for every limiter.
  const windows = new Set([...src.matchAll(/rateLimit\(\s*"[^"]+",\s*\d+,\s*([\d_]+)/g)].map((m) => m[1]));
  assert(windows.size === 1 && calls.length === [...src.matchAll(/rateLimit\(\s*"[^"]+",\s*\d+,\s*[\d_]+/g)].length, `every rateLimit call must share one literal window: ${[...windows]}`); n++;
}
console.log(`ratekey.cloud.test.ts: ${n} checks passed (${calls.length} rateLimit call sites, all keyed by rateKey)`);

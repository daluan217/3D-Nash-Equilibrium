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

console.log(`ratekey.cloud.test.ts: ${n} checks passed (${calls.length} rateLimit call sites, all keyed by rateKey)`);

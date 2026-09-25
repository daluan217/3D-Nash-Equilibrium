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

// Contract: one key function. The limiter keys with rateKey(req), and no other
// line in server.ts reads req.ip / remoteAddress to build a throttle key.
const limiter = src.slice(src.indexOf('function rateLimit('), src.indexOf('\n}\n', src.indexOf('function rateLimit(')));
assert(/const key = `\$\{label\}:\$\{rateKey\(req\)\}`;/.test(limiter), 'rateLimit must key as `${label}:${rateKey(req)}`'); n++;
const readers = src.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => /\breq\.ip\b|remoteAddress/.test(l) && !/^\s*\/\//.test(l));
assert.deepStrictEqual(readers.map(([, l]) => l.trim()), ['const ip = (req.ip || req.socket.remoteAddress || "unknown").replace(/%.*$/, "");'],
  `only rateKey may read the client address: ${JSON.stringify(readers)}`); n++;
const calls = src.match(/rateLimit\(\s*"[^"]+"/g) ?? [];
assert(calls.length >= 15, `expected every route limiter via rateLimit(), found ${calls.length}`); n++;
console.log(`ratekey.cloud.test.ts: ${n} checks passed (${calls.length} rateLimit call sites, all keyed by rateKey)`);

/**
 * Hosted JSON goes out br/gzip once it is 1 KB or more, negotiated by the ONE pickCoding that /assets uses.
 * Boots the REAL server.ts (tsx) in a temp cwd whose db.json holds a 200-game library.
 * Sweep 28 (S28-1): GET /api/games for 200 games was 64-80 KB raw on live, and Cloud Run compresses nothing.
 * BREACH needs a secret in a compressed body plus a credential the browser attaches by itself (a cookie).
 * Auth here is a Bearer header (static rows below); the one secret-bearing body (login) stays under 1 KB.
 *
 *   npx tsx src/compression.cloud.test.ts
 */
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { PRESETS } from './utils/gameEngine';

setTimeout(() => { console.error('compression.cloud.test.ts: timed out'); process.exit(1); }, 180_000).unref();
const SERVER = fileURLToPath(new URL('../server.ts', import.meta.url));
const src = fs.readFileSync(SERVER, 'utf8');
let n = 0;

// ── static: one negotiation, and no credential a browser attaches by itself
const HOOK = src.slice(src.indexOf('app.response.send = function'), src.indexOf('const PORT = parseInt'));
assert(HOOK.startsWith('app.response.send = function') && HOOK.includes('zlib.'), 'the hosted compression hook is gone from server.ts');
assert.strictEqual(src.split('function pickCoding(').length, 2, 'server.ts must define exactly one pickCoding');
const reads = src.match(/headers\[["']accept-encoding["']\]/gi) ?? [];
const viaPick = src.match(/pickCoding\(String\((this\.)?req\.headers\[["']accept-encoding["']\]/g) ?? [];
assert(reads.length === 2 && viaPick.length === 2, `every Accept-Encoding read goes straight into pickCoding (hook + /assets): ${reads.length} reads, ${viaPick.length} via pickCoding`);
assert(!/acceptsEncodings|get\(["']accept-encoding/i.test(src), 'a second Accept-Encoding reader (acceptsEncodings / req.get) forks the negotiation');
const quality = Number(/BROTLI_PARAM_QUALITY\]: (\d+)/.exec(HOOK)?.[1]);
assert(quality >= 1 && quality <= 6, `dynamic bodies are compressed per request: brotli q${quality} (q11 costs ~80 ms on the library, q5 ~1 ms)`);
// The hook hands send a Buffer, which send types as octet-stream unless a type is set: res.json sets one, a bare send must.
const sends = src.match(/\.send\([^)]/g) ?? [], typed = src.match(/\.type\([^)]*\)\.send\([^)]/g) ?? [];
assert(sends.length > 0 && sends.length === typed.length, `every res.send(body) in server.ts is typed first: ${typed.length} of ${sends.length}`);
n += 5;
assert(!/\bcookies?\b|set-cookie/i.test(src), 'server.ts mentions cookies: a cookie credential re-opens BREACH on the compressed JSON (see the hook)');
assert(!/Access-Control-Allow-Credentials/i.test(src), 'server.ts allows credentialed CORS');
const clientFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return ['integration', 'e2e'].includes(e.name) ? [] : clientFiles(p);
  return /\.tsx?$/.test(e.name) && !/\.test\.|\.contract\./.test(e.name) ? [p] : [];
});
const client = clientFiles(fileURLToPath(new URL('.', import.meta.url)));
assert(client.length > 20, `fixture: only ${client.length} client files found`);
for (const f of client) assert(!/withCredentials|document\.cookie|credentials:\s*["']include["']/.test(fs.readFileSync(f, 'utf8')), `${f}: a browser-attached credential`);
assert(fs.readFileSync(new URL('./utils/apiClient.ts', import.meta.url), 'utf8').includes("headers['Authorization'] = `Bearer ${requestToken}`"), 'apiClient no longer sends the token as a Bearer header');
n += 4;

// ── fixtures: users, a 200-game library, and two one-game libraries of exactly 1,023 and 1,024 bytes
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compression-'));
const kids = new Set<ChildProcess>();
process.on('exit', () => { for (const k of kids) k.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); });
const PASSWORD = 'Sup3rSecret!23';
const user = (username: string, email: string, id = `u_${crypto.randomUUID()}`) =>
  ({ id, username, email, passwordHash: Buffer.from(PASSWORD).toString('base64'), isVerified: true, verificationCode: '', verificationCodeExpires: 0 });
const PS = Object.values(PRESETS), K = ['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const;
const game = (userId: string, i: number, description = `Saved variant ${i}: tweaked payoffs.`) => {
  const p = PS[i % PS.length];
  return { id: `g_${crypto.randomUUID()}`, userId, name: `${p.name} v${i}`, description,
    payoffs: Object.fromEntries(K.map((k, j) => [k, (p[k] ?? 0) + ((i * 7 + j) % 5)])), createdAt: new Date(Date.UTC(2026, 8, 1) + i * 3.6e6).toISOString(),
    ...(p.row1Label ? { row1Label: p.row1Label, row2Label: p.row2Label, col1Label: p.col1Label, col2Label: p.col2Label } : {}) };
};
// Exactly `bytes` of JSON for a one-game list: the description absorbs the difference.
const sized = (userId: string, bytes: number) => { const g = game(userId, 1, ''); g.description = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify([g]))); return g; };
const big = user('librarian', 'librarian@example.test'), u1023 = user('edge1023', 'edge1023@example.test'), u1024 = user('edge1024', 'edge1024@example.test');
// The login body is the one hosted body that carries a secret: at the field caps (username 40, email 254) it stays under 1 KB.
const widest = user('w'.repeat(40), `${'a'.repeat(241)}@example.test`);
const library = Array.from({ length: 200 }, (_, i) => game(big.id, i));
const db = { users: [big, u1023, u1024, widest], games: [...library, sized(u1023.id, 1023), sized(u1024.id, 1024), ...Array.from({ length: 200 }, (_, i) => game('local-owner', i))] };
const dir = (name: string) => { const d = path.join(tmp, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'db.json'), JSON.stringify(db)); return d; };

type Res = { status: number; h: http.IncomingHttpHeaders; body: Buffer };
const call = (port: number, method: string, p: string, headers: Record<string, string> = {}, body?: string) => new Promise<Res>((resolve, reject) => {
  const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (r) => {
    const bufs: Buffer[] = []; r.on('data', (c) => bufs.push(c)); r.on('end', () => resolve({ status: r.statusCode!, h: r.headers, body: Buffer.concat(bufs) }));
  });
  q.on('error', reject); q.setTimeout(30_000, () => q.destroy(new Error(`${method} ${p} timed out`))); q.end(body);
});
const freePort = () => new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
async function boot(cwd: string, env: Record<string, string> = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), SERVER], {
    cwd, env: { PATH: process.env.PATH!, HOME: cwd, NODE_ENV: 'production', PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.add(child); let log = ''; child.stdout!.on('data', (d) => { log += d; }); child.stderr!.on('data', (d) => { log += d; });
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})\n${log}`);
    const r = await call(port, 'GET', '/api/health').catch(() => null);
    if (r?.status === 200 && JSON.parse(r.body.toString()).pid === child.pid) return { port, stop: () => { child.kill('SIGKILL'); kids.delete(child); } };
    await new Promise((r2) => setTimeout(r2, 250));
  }
  throw new Error(`server never came up on ${port}\n${log}`);
}
const decode = (r: Res) => r.h['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.h['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body;
const JSON_TYPE = 'application/json; charset=utf-8';
const CHROME = 'gzip, deflate, br, zstd';

// ── hosted
{
  const s = await boot(dir('hosted'));
  const login = async (email: string, ae = CHROME) => {
    const r = await call(s.port, 'POST', '/api/auth/login', { 'content-type': 'application/json', 'accept-encoding': ae }, JSON.stringify({ email, password: PASSWORD }));
    assert(r.status === 200, `fixture: login ${email} ${r.status} ${r.body}`);
    return r;
  };
  const tok = async (u: { email: string }) => JSON.parse((await login(u.email)).body.toString()).token as string;
  const games = (t: string, ae?: string, extra: Record<string, string> = {}, method = 'GET') =>
    call(s.port, method, '/api/games', { authorization: `Bearer ${t}`, ...(ae === undefined ? {} : { 'accept-encoding': ae }), ...extra });

  const widestLogin = await login(widest.email);
  assert(!widestLogin.h['content-encoding'] && widestLogin.body.length < 1024 && JSON.parse(widestLogin.body.toString()).token,
    `login at the field caps: ${widestLogin.body.length} B, content-encoding=${widestLogin.h['content-encoding']}; the token-bearing body must stay raw`); n++;

  const t = await tok(big);
  const identity = await games(t, 'identity');
  assert(identity.status === 200 && identity.body.equals(Buffer.from(JSON.stringify(library))) && identity.body.length > 16_000,
    `fixture: the identity library is ${identity.status} ${identity.body.length} B, not the stored 200 games`); n++;
  // Each row names the pickCoding clause it pins (the negotiation is shared with /assets; staticassets pins it there too).
  const rows: [string, string | undefined, 'br' | 'gzip' | undefined][] = [
    ['a browser', CHROME, 'br'], ['br only', 'br', 'br'], ['gzip only', 'gzip', 'gzip'], ['identity', 'identity', undefined],
    ['no Accept-Encoding', undefined, undefined], ['a tie goes to br', 'gzip, br', 'br'], ['higher q wins', 'br;q=0.5, gzip', 'gzip'],
    ['both refused', 'br;q=0, gzip;q=0', undefined], ['`*` covers both', '*;q=0.2', 'br'], ['own q=0 beats `*`', 'br;q=0, *', 'gzip'],
    ['q clamped to 1', 'gzip;q=5, br', 'br'], ['q clamped to 0', 'br;q=-1, *', 'gzip'], ['unparseable q is 0', 'br;q=abc, gzip', 'gzip'],
    ['a duplicate keeps its max q', 'br, br;q=0', 'br'], ['codings are case-insensitive', 'GZIP', 'gzip'],
  ];
  const etags = new Map<string, string>();
  for (const [label, ae, want] of rows) {
    const r = await games(t, ae), why = `${label} (Accept-Encoding ${JSON.stringify(ae)})`;
    assert.strictEqual(r.status, 200, `${why}: status ${r.status}`);
    assert.strictEqual(r.h['content-encoding'], want, `${why}: content-encoding`);
    assert(/\baccept-encoding\b/i.test(String(r.h.vary)), `${why}: vary=${r.h.vary ?? '(none)'}; a shared cache would hand this coding to every client`);
    assert.strictEqual(r.h['content-type'], JSON_TYPE, `${why}: content-type`);
    assert.strictEqual(Number(r.h['content-length']), r.body.length, `${why}: content-length`);
    assert(decode(r).equals(identity.body), `${why}: decoded body differs from the identity body`);
    if (want) assert(r.body.length < identity.body.length / 3, `${why}: ${r.body.length} B coded of ${identity.body.length} B raw`);
    etags.set(want ?? 'identity', String(r.h.etag));
    n++;
  }
  // send derives the ETag from the coded bytes, so a validator for one coding never revalidates another.
  assert.strictEqual(new Set(etags.values()).size, 3, `one ETag per coding: ${JSON.stringify([...etags])}`);
  const same = await games(t, 'br', { 'if-none-match': etags.get('br')! }), cross = await games(t, 'gzip', { 'if-none-match': etags.get('br')! });
  assert(same.status === 304 && same.body.length === 0, `If-None-Match on the br ETag with br: ${same.status}`);
  assert(cross.status === 200 && cross.h['content-encoding'] === 'gzip' && zlib.gunzipSync(cross.body).equals(identity.body), `the br ETag with gzip: ${cross.status}`);
  const head = await games(t, 'br', {}, 'HEAD'), brGet = await games(t, 'br');
  assert(head.status === 200 && head.h['content-encoding'] === 'br' && Number(head.h['content-length']) === brGet.body.length && head.body.length === 0,
    `HEAD with br: ${head.status} ${head.h['content-encoding']} ${head.h['content-length']} vs ${brGet.body.length}`);
  n += 3;
  // The threshold, at its edge: 1,023 bytes raw, 1,024 bytes coded. Small bodies are raw and vary on nothing.
  for (const [u, bytes, want] of [[u1023, 1023, undefined], [u1024, 1024, 'br']] as const) {
    const ut = await tok(u), raw = await games(ut, 'identity'), r = await games(ut, CHROME);
    assert.strictEqual(raw.body.length, bytes, `fixture: the ${bytes}-byte library is ${raw.body.length} B`);
    assert(r.status === 200 && r.h['content-encoding'] === want && decode(r).equals(raw.body), `${bytes} B under a browser's Accept-Encoding: content-encoding=${r.h['content-encoding']}`);
    n++;
  }
  const small = await call(s.port, 'GET', '/api/games', { 'accept-encoding': CHROME });
  assert(small.status === 401 && !small.h['content-encoding'] && !/accept-encoding/i.test(String(small.h.vary ?? '')) && JSON.parse(small.body.toString()).error,
    `a small JSON error: ${small.status} content-encoding=${small.h['content-encoding']} vary=${small.h.vary}`); n++;
  s.stop();
}

// ── desktop (IS_ELECTRON): loopback, nothing to save on the wire, answered as before
{
  const d = await boot(dir('desktop'), { IS_ELECTRON: 'true' });
  const r = await call(d.port, 'GET', '/api/games', { 'accept-encoding': CHROME });
  assert(!r.h['content-encoding'] && !/accept-encoding/i.test(String(r.h.vary ?? '')), `desktop: content-encoding=${r.h['content-encoding']} vary=${r.h.vary}`);
  assert(r.status === 200 && r.body.length > 16_000 && JSON.parse(r.body.toString()).length === 200, `fixture: desktop library ${r.status} ${r.body.length} B`);
  n += 2;
  d.stop();
}
console.log(`compression.cloud.test.ts: ${n} checks passed`);
process.exit(0);

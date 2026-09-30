/**
 * Every response the hosted server can produce carries the baseline security headers, HSTS, and no X-Powered-By;
 * the desktop keeps the baseline without HSTS. Boots the REAL server.ts (tsx) in a temp cwd against a fake GCS.
 * Sweep 26: the header middleware sat after the www 301 and express.json, so those and every body-parser
 * 400/413/415 went out bare (live: POST '{bad' -> 400 with no nosniff/XFO/CSP); no HSTS anywhere; X-Powered-By on all.
 *
 *   npx tsx src/securityheaders.cloud.test.ts
 */
import assert from 'node:assert';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import express from 'express';
import { seededRandom } from './testing/prng.ts';

setTimeout(() => { console.error('securityheaders.cloud.test.ts: timed out'); process.exit(1); }, 180_000).unref();
const SERVER = fileURLToPath(new URL('../server.ts', import.meta.url));
const SMOKE = fileURLToPath(new URL('./e2e/live-smoke.mjs', import.meta.url));
const src = fs.readFileSync(SERVER, 'utf8');
let n = 0;

// ── static contract: nothing but the desktop Host guard may answer before the header middleware
{
  const body = src.slice(src.indexOf('  const app = express();\n'), src.indexOf('  startListening(initialPort);\n'));
  assert(body.length > 10_000, 'startServer (const app = express() .. startListening) is gone from server.ts');
  const regs = [...body.matchAll(/^[ \t]*app\.(use|get|post|put|patch|delete|all|options|head|route|param)\(/gm)].map((m) => m.index!);
  const between = (i: number) => body.slice(regs[i], regs[i + 1]);
  assert(regs.length > 20, `only ${regs.length} app registrations found`);
  assert(between(0).includes('"Invalid Host header."') && /if \(process\.env\.IS_ELECTRON === "true"\) \{\s*$/.test(body.slice(0, regs[0])),
    `the first registration in startServer must be the desktop Host guard, found: ${between(0).slice(0, 80)}`); n++;
  assert(between(1).includes('"X-Content-Type-Options", "nosniff"') && between(1).includes('"Strict-Transport-Security"'),
    `the second registration must be the baseline header middleware (every other producer answers after it), found: ${between(1).slice(0, 80)}`); n++;
  assert(between(1).indexOf('next()') > between(1).lastIndexOf('res.setHeader('), 'the header middleware must set every header BEFORE next(): after it, a synchronous answer has already gone out bare'); n++;
  assert(/app\.disable\("x-powered-by"\);/.test(body.slice(0, regs[0])), 'app.disable("x-powered-by") must precede every registration'); n++;
  assert(!/x-powered-by["'],\s*true|app\.enable\(["']x-powered-by/.test(src), 'x-powered-by is re-enabled somewhere'); n++;
  for (const h of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Permissions-Policy', 'Content-Security-Policy', 'Strict-Transport-Security']) {
    assert.strictEqual(src.match(new RegExp(`setHeader\\(["']${h}["']`, 'gi'))?.length, 1, `${h} must be set in exactly one place (the header middleware)`);
    assert(!new RegExp(`removeHeader\\([^)]*${h}|["']${h}["'][^\\n]*\\]\\)\\s*res\\.removeHeader`, 'i').test(src), `${h} is removed somewhere`); n++;
  }
  assert(!/\b(?:http|https|http2)\.createServer\(|\.on\(["'](?:request|checkContinue|checkExpectation|clientError)["']/.test(src),
    'a second request handler outside the Express stack answers without the header middleware'); n++;
}

// ── fixtures: a dist the static block serves, and a fake GCS (dmg object; db.json and app-version.json 403)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'securityheaders-'));
const kids = new Set<ChildProcess>();
process.on('exit', () => { for (const k of kids) k.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); });
fs.mkdirSync(path.join(tmp, 'dist/assets'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist/index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
fs.writeFileSync(path.join(tmp, 'dist/assets/app-AAAA1111.js'), 'var a=1;'.repeat(100));
// The build's precompress siblings (sweep 27): the hosted /assets route answers from them.
fs.writeFileSync(path.join(tmp, 'dist/assets/app-AAAA1111.js.br'), zlib.brotliCompressSync('var a=1;'.repeat(100)));
fs.writeFileSync(path.join(tmp, 'dist/assets/app-AAAA1111.js.gz'), zlib.gzipSync('var a=1;'.repeat(100)));
const BUCKET = 'fake-sechdr-bucket', DMG = 'Nash Equilibrium Simulator.dmg', BYTES = Buffer.alloc(4000, 68);
let mediaGone = false; // the object vanished between metadata and bytes: the route's stream-error 500
const gcs = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  const json = (c: number, b: unknown) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (!u.pathname.endsWith(`/b/${BUCKET}/o/${encodeURIComponent(DMG)}`)) return json(403, { error: { code: 403, message: 'forbidden' } });
  if (mediaGone && u.searchParams.get('alt') === 'media') return json(404, { error: { code: 404, message: 'No such object' } });
  if (u.searchParams.get('alt') !== 'media') return json(200, { name: DMG, bucket: BUCKET, size: String(BYTES.length), generation: '7' });
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? ''), s = m ? Number(m[1]) : 0, e = m ? Number(m[2]) : BYTES.length - 1;
  res.writeHead(m ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': e - s + 1 }); res.end(BYTES.subarray(s, e + 1));
});
await new Promise<void>((r) => gcs.listen(0, '127.0.0.1', r)); gcs.unref();

type Res = { status: number; h: http.IncomingHttpHeaders; body: string };
const call = (port: number, method: string, p: string, headers: Record<string, string> = {}, body?: string | Buffer) => new Promise<Res>((resolve, reject) => {
  const q = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (r) => {
    const bufs: Buffer[] = []; r.on('data', (c) => bufs.push(c)); r.on('end', () => resolve({ status: r.statusCode!, h: r.headers, body: Buffer.concat(bufs).toString() }));
  });
  q.on('error', reject); q.setTimeout(30_000, () => q.destroy(new Error(`${method} ${p} timed out`))); q.end(body);
});
// A request that dies (reset, timeout) is a named failure of its producer, not an anonymous crash.
const named = <T,>(name: string, p: Promise<T>) => p.catch((e: Error) => assert.fail(`${name}: the request failed (${e.message})`));
const freePort = () => new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
async function boot(env: Record<string, string>) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), SERVER], {
    cwd: tmp, env: { PATH: process.env.PATH!, HOME: tmp, NODE_ENV: 'production', PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.add(child); let log = ''; child.stdout!.on('data', (d) => { log += d; }); child.stderr!.on('data', (d) => { log += d; });
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})\n${log}`);
    const r = await call(port, 'GET', '/api/health', { host: `127.0.0.1:${port}` }).catch(() => null);
    if (r?.status === 200 && JSON.parse(r.body).pid === child.pid) return { port, stop: () => { child.kill('SIGKILL'); kids.delete(child); } };
    await new Promise((r2) => setTimeout(r2, 250));
  }
  throw new Error(`server never came up on ${port}\n${log}`);
}

const BASELINE: Record<string, string> = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()', 'content-security-policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};
// Express's own 404 page overwrites CSP with the stricter `default-src 'none'` (no script, style or object at
// all); framing stays blocked by X-Frame-Options DENY. Only it may (serve-static's redirect is off, sweep 22).
const LIB_CSP = "default-src 'none'";
const hardened = (name: string, r: Res, { hsts, libCsp = false }: { hsts: boolean; libCsp?: boolean }) => {
  for (const [k, v] of Object.entries(BASELINE)) {
    const want = k === 'content-security-policy' && libCsp ? LIB_CSP : v;
    assert.strictEqual(r.h[k], want, `${name} (${r.status}): ${k}=${r.h[k] ?? '(none)'}, want ${want}`);
  }
  assert.strictEqual(r.h['strict-transport-security'], hsts ? 'max-age=31536000' : undefined, `${name} (${r.status}): strict-transport-security=${r.h['strict-transport-security'] ?? '(none)'}`);
  assert.strictEqual(r.h['x-powered-by'], undefined, `${name} (${r.status}): x-powered-by=${r.h['x-powered-by']}`);
  n++;
};

// ── hosted (Cloud Run shape: TRUST_PROXY=1, GCS store, GFE's Host + X-Forwarded-Proto)
// TRUST_PROXY as cloudbuild.yaml deploys it; the rate-limit block below proves what that value keys on.
const cbText = fs.readFileSync(fileURLToPath(new URL('../cloudbuild.yaml', import.meta.url)), 'utf8');
const TRUST_PROXY = /'--set-env-vars=(?:[^',]*,)*TRUST_PROXY=([^,']*)/.exec(cbText)?.[1];
// One hop: Cloud Run's peer is Google's front end, never loopback, so an address list (this harness's peer IS
// loopback) would pass here and key every visitor on the front end in production.
assert.strictEqual(TRUST_PROXY, '1', `cloudbuild.yaml TRUST_PROXY is '${TRUST_PROXY}': Cloud Run is exactly one trusted hop`); n++;
const hosted = await boot({ TRUST_PROXY, GCS_BUCKET_NAME: BUCKET, STORAGE_EMULATOR_HOST: `http://127.0.0.1:${(gcs.address() as net.AddressInfo).port}`, GOOGLE_CLOUD_PROJECT: 'fake-project' });
const APEX = 'nash-equilibrium-simulator.com', GFE = { host: APEX, 'x-forwarded-proto': 'https' }, J = { ...GFE, 'content-type': 'application/json' };
const h = (method: string, p: string, headers: Record<string, string> = GFE, body?: string | Buffer) => call(hosted.port, method, p, headers, body);
type Case = [name: string, run: () => Promise<Res>, status: number, marker: string | RegExp, libCsp?: boolean];
const asset = await named('express.static 200', h('GET', '/assets/app-AAAA1111.js'));
const cases: Case[] = [
  ['express.static 200', async () => asset, 200, 'var a=1;'],
  ['express.static index 200', () => h('GET', '/'), 200, '<div id="root">'],
  ['express.static HEAD', () => h('HEAD', '/assets/app-AAAA1111.js'), 200, ''],
  ['express.static conditional 304', () => h('GET', '/assets/app-AAAA1111.js', { ...GFE, 'if-none-match': String(asset.h.etag) }), 304, ''],
  ['/assets br 200', () => h('GET', '/assets/app-AAAA1111.js', { ...GFE, 'accept-encoding': 'br' }), 200, ''],
  ['/assets gzip 200', () => h('GET', '/assets/app-AAAA1111.js', { ...GFE, 'accept-encoding': 'gzip' }), 200, ''],
  ['/assets br 412 (If-Match)', () => h('GET', '/assets/app-AAAA1111.js', { ...GFE, 'accept-encoding': 'br', 'if-match': '"nope"' }), 412, 'Invalid request.'],
  ['/assets 416', () => h('GET', '/assets/app-AAAA1111.js', { ...GFE, range: 'bytes=99999-' }), 416, 'Invalid request.'],
  ['serve-static directory, no redirect', () => h('GET', '/assets'), 404, '"Not found"'],
  ['SPA fallback 200', () => h('GET', '/some/route'), 200, '<div id="root">'],
  ['www 301', () => h('GET', '/x?y=1', { ...GFE, host: `www.${APEX}` }), 301, `https://${APEX}/x?y=1`],
  ['body-parser 400 (malformed JSON)', () => h('POST', '/api/auth/login', J, '{bad'), 400, 'Invalid request.'],
  ['body-parser 413 (oversized)', () => h('POST', '/api/auth/login', J, JSON.stringify({ a: 'x'.repeat(200_000) })), 413, 'Invalid request.'],
  ['body-parser 415 (bad charset)', () => h('POST', '/api/auth/login', { ...J, 'content-type': 'application/json; charset=bogus' }, '{}'), 415, 'Invalid request.'],
  ['body-parser 415 (unsupported encoding)', () => h('POST', '/api/auth/login', { ...J, 'content-encoding': 'br2' }, '{}'), 415, 'Invalid request.'],
  ['body-parser 400 (bad gzip)', () => h('POST', '/api/auth/login', { ...J, 'content-encoding': 'gzip' }, 'notgzip'), 400, 'Invalid request.'],
  ['body-parser 413 (gzip bomb)', () => h('POST', '/api/auth/login', { ...J, 'content-encoding': 'gzip' }, zlib.gzipSync(JSON.stringify({ a: 'x'.repeat(5_000_000) }))), 413, 'Invalid request.'],
  ['URIError 400 (final handler 4xx)', () => h('GET', '/%E0%A4%A'), 400, 'Invalid request.'],
  ['authFieldsAreStrings 400', () => h('POST', '/api/auth/login', J, '{"email":5,"password":"x"}'), 400, 'Invalid request.'],
  ['requireGcsStore 503 (store unread)', () => h('GET', '/api/auth/me'), 503, 'temporarily unavailable'],
  ['route 400', () => h('POST', '/api/report', J, '{"payoffs":{"a11":"x"}}'), 400, 'Invalid payoff matrix.'],
  ['route 500 (GCS refused)', () => h('GET', '/api/version'), 500, 'Internal Server Error'],
  ['/api 404', () => h('GET', '/api/nope'), 404, '"Not found"'],
  ['/assets 404', () => h('GET', '/assets/index-NEVERUPLOADED.js'), 404, '"Not found"'],
  ['/server.cjs 404', () => h('GET', '/server.cjs'), 404, '"Not found"'],
  ['CORS preflight 200', () => h('OPTIONS', '/api/games', { ...GFE, origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'PATCH' }), 200, 'OK'],
  ["Express's own 404 (TRACE)", () => h('TRACE', '/'), 404, 'Cannot TRACE /', true],
  ["Express's own 404 (POST)", () => h('POST', '/x', J, '{}'), 404, 'Cannot POST /x', true],
  ['health 200', () => h('GET', '/api/health'), 200, '"status":"ok"'],
  // Unconditional: gated on req.secure, a lost TRUST_PROXY or X-Forwarded-Proto would drop it silently.
  ['health 200, no X-Forwarded-Proto', () => h('GET', '/api/health', { host: APEX }), 200, '"status":"ok"'],
  ['health 200, X-Forwarded-Proto http', () => h('GET', '/api/health', { host: APEX, 'x-forwarded-proto': 'http' }), 200, '"status":"ok"'],
  ['DMG HEAD 200', () => h('HEAD', '/api/download/dmg'), 200, ''],
  ['DMG 206', () => h('GET', '/api/download/dmg', { ...GFE, range: 'bytes=0-0' }), 206, 'D'],
  ['DMG 412 (If-Match)', () => h('GET', '/api/download/dmg', { ...GFE, 'if-match': '"8"' }), 412, ''],
  ['DMG 416', () => h('GET', '/api/download/dmg', { ...GFE, range: 'bytes=99999-' }), 416, ''],
  // This path strips the download's headers before its JSON 500 (removeHeader): the baseline must survive it.
  ['DMG stream-error 500', async () => { mediaGone = true; try { return await h('GET', '/api/download/dmg'); } finally { mediaGone = false; } }, 500, 'Internal Server Error'],
];
for (const [name, run, status, marker, libCsp] of cases) {
  const r = await named(name, run());
  // The status and a body marker prove the named producer answered, not a neighbour (the coding, for the /assets route).
  const coded = /^\/assets (br|gzip) 200$/.exec(name)?.[1];
  assert(r.status === status && (typeof marker === 'string' ? r.body.includes(marker) : marker.test(r.body)) && (name !== 'www 301' || r.h.location === `https://${APEX}/x?y=1`)
    && r.h['content-encoding'] === coded && (!/^\/assets .*41\d/.test(name) || (r.h['content-type']!.startsWith('application/json') && r.h['cache-control'] === 'no-store')),
    `fixture: ${name} answered ${r.status} ${r.h['content-encoding'] ?? ''} ${r.h['content-type']} ${r.body.slice(0, 100)}, want ${status} with ${marker}`);
  hardened(name, r, { hsts: true, libCsp });
}
// Sweep 22 (S1-5): serve-static's directory redirect echoed the raw target: GET /\evil.example/%2e%2e/assets
// answered 301 Location /\evil.example/%2e%2e/assets/, which a browser resolves to https://evil.example/assets/.
// Live, Google's front end normalises `\` first; the server must not depend on it. The apex redirects nothing.
for (const [method, t] of [['GET', '/\\evil.example/%2e%2e/assets'], ['HEAD', '/\\evil.example/%2e%2e/assets'], ['GET', '/\\evil.example/x/..%2f..%2fassets'],
  ['GET', '//evil.example/%2e%2e/assets'], ['GET', '/%5Cevil.example/%2e%2e/assets'], ['GET', '/assets/..%2Fassets'], ['GET', '/assets/'], ['HEAD', '/assets'],
  ['GET', 'http://evil.example/assets']]) {
  const r = await named(`${method} ${t}`, h(method, t));
  assert(r.status !== 301 && r.status !== 302 && r.status !== 303 && r.status !== 307 && r.status !== 308 && r.h.location === undefined,
    `${method} ${t}: ${r.status} Location ${r.h.location}, want no redirect from the apex`);
  hardened(`${method} ${t}`, r, { hsts: true });
}
// Nothing outside dist/ and no dotfile is served: the hosted cwd holds package.json and, locally, .env.
// Planted after boot (dotenv reads cwd/.env at start); each file carries a marker no answer may contain.
{
  const MARK = 'sechdr-outside-dist-7f3a';
  for (const f of ['.env', 'package.json', '.git/HEAD', 'dist/.env']) { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), `${MARK} ${f}\n`); }
  for (const t of ['/../.env', '/..%2F.env', '/%2e%2e/.env', '/%2e%2e%2f.env', '/..%5C.env', '/assets/..%2F..%2F.env', '/.env', '/%2Eenv', '/.git/HEAD', '/.git%2FHEAD',
    '/../package.json', '/..%2Fpackage.json', '/package.json', '/assets/%2e%2e/%2e%2e/package.json', '/assets/..%5C..%5Cpackage.json', '/dist/.env', '/..%2Fdist%2F.env']) {
    const r = await named(`GET ${t}`, h('GET', t));
    assert(!r.body.includes(MARK), `GET ${t}: ${r.status} served a file outside dist/ or a dotfile: ${r.body.slice(0, 60)}`);
    hardened(`GET ${t}`, r, { hsts: true });
  }
  // Seeded target fuzz (_gen/c22-target-fuzz.mjs, 7000 clean on the bundle): separators, dot segments, encodings
  // and names glued at random; same seed every run, so a failure names a reproducible target. The planted
  // dist/server.cjs stands in for the bundle: no spelling may serve it. The apex never redirects; www only to it.
  fs.writeFileSync(path.join(tmp, 'dist/server.cjs'), `${MARK} dist/server.cjs\n`);
  const draw = seededRandom(23), rnd = (k: number) => Math.floor(draw() * k);
  const lands = (t: string) => { try { return path.posix.normalize(decodeURIComponent(t.split('?')[0]).replace(/\\/g, '/')); } catch { return ''; } };
  const TOK = ['/', '/', '/', '\\', '%2f', '%5c', '%5C', '..', '.', '%2e', '%2e%2e', '.%2e', 'assets', 'assets', 'server.cjs', 'server%2ecjs', 'SERVER.CJS', '.env',
    '%2eenv', 'package.json', '.git', 'HEAD', 'dist', 'evil.example', '@evil.example', '%00', '%', '%E0%A4%A', ';', '?x=//evil', '%23', '%3f', '%09', '%20', '~',
    'index.html', 'app-AAAA1111.js', 'app-AAAA1111.js.br', 'favicon.ico'];
  const seen = new Set<string>();
  for (let k = 0; k < 700; k++) {
    let t = '/'; for (let j = rnd(7); j >= 0; j--) t += TOK[rnd(TOK.length)];
    const method = ['GET', 'GET', 'HEAD', 'OPTIONS'][rnd(4)], www = rnd(7) === 0, name = `fuzz #${k} ${method} ${t}${www ? ' (www)' : ''}`;
    const r = await named(name, h(method, t, { ...GFE, ...(www ? { host: `www.${APEX}` } : {}), 'accept-encoding': 'br' }));
    assert(r.status < 500, `${name}: ${r.status} ${r.body.slice(0, 80)}`);
    const to = r.h.location === undefined ? undefined : new URL(r.h.location, `https://${APEX}/`).host;
    assert(to === undefined || (www && to === APEX), `${name}: ${r.status} Location ${r.h.location} (host ${to}), want none from the apex and only the apex from www`);
    assert(!r.body.includes(MARK), `${name}: ${r.status} served a file outside dist/, a dotfile or the bundle: ${r.body.slice(0, 60)}`);
    hardened(name, r, { hsts: true });
    seen.add(`${r.status}${www ? ' www' : ''}`);
    if (method === 'GET' && !www) seen.add(`GET ${lands(t)}`);
  }
  // Fixture: the seed reaches the SPA, a malformed-target 400, the www redirect, and a GET (a body) of every
  // planted file and of the assets directory by some spelling; else the marker checks prove nothing.
  const want = ['200', '404', '400', '301 www', 'GET /server.cjs', 'GET /.env', 'GET /package.json', 'GET /assets'];
  assert(want.every((s) => seen.has(s)), `fuzz fixture: missing ${want.filter((s) => !seen.has(s))}`); n++;
  // Every other method off /api (sweep 5): only GET/HEAD read files, so each is a 404 (Express's own page carries
  // its default-src 'none' CSP), hardened, never a planted file, never the markup echoed back.
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'TRACE', 'PROPFIND']) for (const t of ['/', '/index.html', '/assets/app-AAAA1111.js', '/server.cjs', '/.env', '/x%3Cb%3E']) {
    // Content-Length set: Node's client sends a DELETE body unframed, which the server rightly reads as a bad request.
    const r = await named(`${m} ${t}`, m === 'TRACE' ? h(m, t) : h(m, t, { ...J, 'content-length': '2' }, '{}'));
    assert(r.status === 404 && !r.body.includes(MARK) && !r.body.includes('<b>'), `${m} ${t}: ${r.status} ${r.body.slice(0, 80)}, want a 404 that serves and echoes nothing`);
    hardened(`${m} ${t}`, r, { hsts: true, libCsp: /^text\/html/.test(String(r.h['content-type'])) });
  }
}

// live-smoke section 3, the real script against the real server: every new row passes.
const SECTION3 = /^(PASS|FAIL) (live security headers present|live HSTS is on \(max-age of at least one year\)|live responses do not name the framework \(no X-Powered-By\)|live malformed-JSON 400 carries the security headers)/;
const smoke3 = (base: string) => new Promise<Map<string, string>>((resolve) => execFile(process.execPath, [SMOKE], { env: { PATH: process.env.PATH, LIVE_BASE: base }, timeout: 90_000 },
  (_e, out, err) => resolve(new Map((out + err).split('\n').map((l) => SECTION3.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[2], m[1]])))));
const ROWS = ['live security headers present', 'live HSTS is on (max-age of at least one year)', 'live responses do not name the framework (no X-Powered-By)', 'live malformed-JSON 400 carries the security headers'];
{
  const rows = await smoke3(`http://127.0.0.1:${hosted.port}`);
  assert.deepStrictEqual(ROWS.map((k) => [k, rows.get(k)]), ROWS.map((k) => [k, 'PASS']), 'live-smoke section 3 against the fixed hosted server'); n++;
}

// Rate limit (dmg: 10/min) and the final error handler's 500, last: both change state.
{
  let r: Res | undefined;
  for (let i = 0; i < 14 && r?.status !== 429; i++) r = await named('rate-limit 429', h('HEAD', '/api/download/dmg'));
  assert.strictEqual(r?.status, 429, 'fixture: the dmg route never rate-limited');
  hardened('rate-limit 429', r!, { hsts: true });
  // Google's front end APPENDS the peer it saw, so the client owns everything left of the last entry. A
  // client rotating that part must stay in one bucket: trusting more than one hop keyed each on the spoof.
  let s: Res | undefined;
  for (let i = 0; i < 14 && s?.status !== 429; i++) s = await named(`xff rotation #${i}`, h('HEAD', '/api/download/dmg', { ...GFE, 'x-forwarded-for': `10.9.${i}.1, 203.0.113.9` }));
  assert.strictEqual(s?.status, 429, `TRUST_PROXY=${TRUST_PROXY}: 14 requests rotating the client-written X-Forwarded-For never hit the dmg limit (10/min)`); n++;
  // ...and a different peer is a different client: trusting no hop put every visitor in the front end's bucket.
  const other = await named('xff other peer', h('HEAD', '/api/download/dmg', { ...GFE, 'x-forwarded-for': '10.9.0.1, 198.51.100.7' }));
  assert.notStrictEqual(other.status, 429, `TRUST_PROXY=${TRUST_PROXY}: a second client (another peer) shares the first one's exhausted bucket`); n++;
  // An unreadable index.html makes send() raise a 500 into next(err): the global handler's own 500, no injection.
  fs.chmodSync(path.join(tmp, 'dist/index.html'), 0o000);
  const e = await named('final error handler 500', h('GET', '/some/route')).finally(() => fs.chmodSync(path.join(tmp, 'dist/index.html'), 0o644));
  assert(e.status === 500 && e.body.includes('Internal server error.'), `fixture: final handler 500 answered ${e.status} ${e.body.slice(0, 80)} (running as root?)`);
  hardened('final error handler 500', e, { hsts: true });
}
hosted.stop();

// ── desktop (IS_ELECTRON, the packaged condition): the baseline it had, no HSTS (a loopback http origin)
{
  // IS_ELECTRON gates both the Host guard and HSTS. No ELECTRON_USER_DATA_PATH: under tsx the dist would be
  // __dirname, which ESM does not define; the store is then a local db.json in the temp cwd.
  const d = await boot({ IS_ELECTRON: 'true' });
  const own = { host: `127.0.0.1:${d.port}` };
  const health = await named('desktop health 200', call(d.port, 'GET', '/api/health', own));
  assert(health.status === 200 && health.body.includes('"status":"ok"'), `fixture: desktop health ${health.status}`);
  hardened('desktop health 200', health, { hsts: false });
  const bad = await named('desktop body-parser 400', call(d.port, 'POST', '/api/games', { ...own, 'content-type': 'application/json' }, '{bad'));
  assert(bad.status === 400 && bad.body.includes('Invalid request.'), `fixture: desktop malformed JSON ${bad.status}`);
  hardened('desktop body-parser 400', bad, { hsts: false });
  // The Host guard is registered FIRST by design (SR-63: nothing may answer a rebound page before it), so its
  // 403 carries none of the baseline: a fixed JSON string to a foreign page, nothing to sniff or frame.
  const rebound = await named('desktop Host-guard 403', call(d.port, 'GET', '/api/games', { host: `evil.example:${d.port}` }));
  assert(rebound.status === 403 && rebound.body === '{"error":"Invalid Host header."}', `fixture: rebound Host ${rebound.status} ${rebound.body}`);
  for (const k of [...Object.keys(BASELINE), 'strict-transport-security', 'x-powered-by']) assert.strictEqual(rebound.h[k], undefined, `desktop Host-guard 403: ${k}=${rebound.h[k]} (nothing may run before the guard)`);
  n++;
  d.stop();
}

// ── live-smoke section 3 against broken shapes: each fails exactly the rows listed ('pre-fix' is what live
// served at 0.0.226; `live security headers present` passed there). The rest each break one clause of one row.
const variant = (kind: string) => {
  const app = express(); app.set('env', 'test'); // express prints every error's stack outside 'test'
  const set = (s: express.Response, hs: Record<string, string>) => { for (const [k, v] of Object.entries(hs)) s.setHeader(k, v); };
  const BASE = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }, CSP = { 'Content-Security-Policy': "frame-ancestors 'none'" };
  const HSTS = { 'Strict-Transport-Security': kind === 'HSTS max-age=300' ? 'max-age=300' : 'max-age=31536000' };
  if (kind === 'pre-fix') { app.use(express.json()); app.use((_q, s, next) => { set(s, BASE); next(); }); } else {
    if (kind !== 'X-Powered-By on') app.disable('x-powered-by');
    app.use((_q, s, next) => { set(s, { ...BASE, ...(kind === 'CSP after the parser' ? {} : CSP), ...(kind === 'HSTS after the parser' ? {} : HSTS) }); next(); });
    if (kind === 'rate-limited') app.post('/api/report', (_q, s) => { s.status(429).json({ error: 'Too many requests.' }); });
    app.use(express.json());
    app.use((_q, s, next) => { set(s, { ...(kind === 'CSP after the parser' ? CSP : {}), ...(kind === 'HSTS after the parser' ? HSTS : {}) }); next(); });
  }
  app.get('/api/health', (_q, s) => { s.json({ status: 'ok' }); });
  app.use((err: { status?: number }, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
    if (kind === 'X-Powered-By on the 400 only') s.setHeader('X-Powered-By', 'Express');
    s.status(err.status ?? 500).json({ error: 'Invalid request.' });
  });
  return app;
};
for (const [kind, failing] of [['pre-fix', [1, 2, 3]], ['HSTS max-age=300', [1]], ['HSTS after the parser', [1]], ['X-Powered-By on', [2]],
  ['X-Powered-By on the 400 only', [2]], ['CSP after the parser', [3]], ['rate-limited', [3]]] as const) {
  const srv = variant(kind).listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  const rows = await smoke3(`http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`); srv.close();
  assert.deepStrictEqual(ROWS.map((k) => [k, rows.get(k)]), ROWS.map((k, i) => [k, (failing as readonly number[]).includes(i) ? 'FAIL' : 'PASS']), `live-smoke section 3 against '${kind}'`); n++;
}
console.log(`securityheaders.cloud.test.ts: ${n} checks passed`);
process.exit(0);

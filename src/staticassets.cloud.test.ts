/**
 * The static block (server.ts) and live-smoke section 2, run for real: the block is lifted from the source
 * into express over a synthetic dist, and the REAL src/e2e/live-smoke.mjs is pointed at it as a child.
 * Sweep 25: a missing /assets/* fell through to the SPA fallback as 200 text/html (~2.5 KB), and section 2
 * read only the first .js by status and size, so a chunk that never uploaded passed the live smoke.
 *
 *   npx tsx src/staticassets.cloud.test.ts
 */
import assert from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import express from 'express';
import ts from 'typescript';

setTimeout(() => { console.error('staticassets.cloud.test.ts: timed out'); process.exit(1); }, 120_000).unref();
const src = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const SMOKE = fileURLToPath(new URL('./e2e/live-smoke.mjs', import.meta.url));
const PRECOMPRESS = fileURLToPath(new URL('../scripts/precompress.mjs', import.meta.url));
const start = src.indexOf('      const forbiddenFiles = new Set<string>();');
const tail = "      app.get('*', (req, res) => {\n        res.sendFile(path.join(distPath, 'index.html'));\n      });\n";
const end = src.indexOf(tail, start) + tail.length;
assert(start > 0 && end > start + tail.length, 'the static block (forbiddenFiles .. SPA fallback) is gone from server.ts');
// The one Accept-Encoding negotiation (module scope in server.ts), lifted with the block that calls it.
const PICK = src.slice(src.indexOf('function pickCoding('), src.indexOf('\nasync function startServer'));
assert(PICK.startsWith('function pickCoding(') && PICK.includes('return qb > 0'), 'pickCoding is gone from server.ts');
const block = PICK + src.slice(start, end);
const STATIC = '      app.use(express.static(distPath));\n';
assert(block.includes(STATIC), 'express.static is gone from the static block');
// The block as it was before sweep 25: nothing between the static mount and the SPA fallback.
const naive = block.slice(0, block.indexOf(STATIC) + STATIC.length) + block.slice(block.indexOf(tail));
const compile = (s: string) => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

// The SPA shell, measured 2026-09-29: 2,497 B local (0.0.227), 2,493 B live (0.0.226). Smallest referenced
// asset: index-*.css, 162,365 B in both. The floor must sit well clear of both.
const MIN = Number(/const ASSET_MIN_BYTES = ([\d_]+);/.exec(fs.readFileSync(SMOKE, 'utf8'))?.[1].replace(/_/g, ''));
assert(MIN > 4 * 2_497 && 4 * MIN < 162_365, `live-smoke ASSET_MIN_BYTES=${MIN} is not calibrated between the shell and the smallest asset`);
let n = 1;

// The four reference shapes vite emits, copied from dist/index.html (0.0.227) with the hashes swapped.
const REFS = { script: '/assets/index-AAAA1111.js', preload1: '/assets/plotly-BBBB2222.js', preload2: '/assets/katex-CCCC3333.js', css: '/assets/index-DDDD4444.css' };
const shell = (pad = 0) => `<!doctype html><html lang="en"><head><title>Nash Equilibrium Simulator</title>
<link rel="icon" href="/favicon.ico" sizes="any" />
<script type="module" crossorigin src="${REFS.script}"></script>
<link rel="modulepreload" crossorigin href="${REFS.preload1}">
<link rel="modulepreload" crossorigin href="${REFS.preload2}">
<link rel="stylesheet" crossorigin href="${REFS.css}">
</head><body><div id="root"></div><!--${'x'.repeat(pad)}--></body></html>`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staticassets-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
// The build's own step (scripts/precompress.mjs) writes the .br/.gz siblings, as `npm run build` does.
const makeDist = (name: string, { drop = '', truncate = '', pad = 0, siblings = true } = {}) => {
  const d = path.join(tmp, name); fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), shell(pad));
  fs.writeFileSync(path.join(d, 'server.cjs'), '/* the backend bundle */');
  for (const u of Object.values(REFS)) if (u !== drop) fs.writeFileSync(path.join(d, u), (u.endsWith('.css') ? '.a{b:c}' : 'var a=1;').repeat(u === truncate ? 200 : 4_000));
  fs.writeFileSync(path.join(d, 'assets/KaTeX_Main-Regular-EEEE5555.woff2'), Buffer.alloc(3_000, 7));
  if (siblings) execFileSync(process.execPath, [PRECOMPRESS, path.join(d, 'assets')]);
  return d;
};
// The global error handler, lifted too: a send 412/416 on an asset is its answer.
const ehStart = src.indexOf('  app.use((err: unknown, req: express.Request');
const handler = src.slice(ehStart, src.indexOf('  // Dynamic port assignment', ehStart));
assert(ehStart > 0 && handler.includes('res.status(upstreamStatus).json('), 'the global error handler is gone from server.ts');
type Pre = express.RequestHandler | undefined;
const serve = async (distPath: string, code = block, pre?: Pre, env: Record<string, string> = {}, eh = handler) => {
  const app = express(); app.set('env', 'test');
  if (pre) app.use(pre); // a misbehaving CDN/origin in front of the real block
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); }); // server.ts mounts this first
  const proc = { env: { ...env } }; // the block reads process.env.IS_ELECTRON: hosted unless given
  new Function('app', 'express', 'path', 'fs', 'distPath', 'process', 'logUnhandled', compile(code + eh))(app, express, path, fs, distPath, proc, () => {});
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  return { base: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, close: () => srv.close() };
};
// Raw bytes (no decoding) with every header, so an encoding and its body are both seen as sent.
type Raw = { status: number; h: http.IncomingHttpHeaders; body: Buffer };
const raw = (base: string, p: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<Raw>((resolve, reject) => {
  const q = http.request(base + p, { method, headers }, (r) => {
    const bufs: Buffer[] = []; r.on('data', (c) => bufs.push(c)); r.on('end', () => resolve({ status: r.statusCode!, h: r.headers, body: Buffer.concat(bufs) }));
  });
  q.on('error', reject); q.end();
});

// ── the server: a missing asset is a no-store JSON 404 on GET and HEAD; the SPA fallback is untouched
{
  const s = await serve(makeDist('full'));
  const get = (p: string, method = 'GET') => fetch(s.base + p, { method }).then(async (r) => ({ status: r.status, ct: r.headers.get('content-type') ?? '', cc: r.headers.get('cache-control') ?? '', body: await r.text() }));
  for (const [p, want] of [[REFS.script, 'javascript'], [REFS.css, 'text/css']] as const) {
    const r = await get(p);
    assert(r.status === 200 && r.ct.includes(want) && r.body.length >= MIN, `${p}: ${r.status} ${r.ct} ${r.body.length} B, want the asset`); n++;
  }
  for (const [p, method] of [['/assets/index-NEVERUPLOADED.js', 'GET'], ['/assets/index-NEVERUPLOADED.js', 'HEAD'], ['/assets/x.css', 'GET'],
    ['/assets/deep/er/y.woff2', 'HEAD'], ['/assets/', 'GET'], ['/assets/z.js', 'POST']]) {
    const r = await get(p, method);
    assert(r.status === 404 && r.ct.startsWith('application/json') && /no-store/.test(r.cc) && !r.body.includes('<div id="root">'),
      `${method} ${p}: ${r.status} ${r.ct} cache-control=${r.cc || '(none)'}, want a no-store JSON 404`); n++;
    if (method === 'GET') { assert.deepStrictEqual(JSON.parse(r.body), { error: 'Not found' }); n++; }
  }
  // Scope: every non-/assets miss is still the SPA shell, including a look-alike prefix and a missing file.
  for (const p of ['/', '/some/route', '/library', '/assetsfoo/x.js', '/favicon-missing.png', '/deep/assets/x.js']) {
    for (const method of ['GET', 'HEAD']) {
      const r = await get(p, method);
      assert(r.status === 200 && r.ct.startsWith('text/html') && (method === 'HEAD' || r.body.includes('<div id="root">')), `${method} ${p}: ${r.status} ${r.ct}, want the SPA shell`); n++;
    }
  }
  const b = await get('/server.cjs');
  assert(b.status === 404 && !b.body.includes('backend bundle'), `/server.cjs: ${b.status}, still refused`); n++;
  s.close();
}

// ── compression and caching (sweep 27: every asset went out raw, 4.66 MB, at max-age=0; Cloud Run compresses nothing)
const CHROME = 'gzip, deflate, br, zstd';
const decode = (r: Raw) => (r.h['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.h['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body);
{
  const d = makeDist('compressed'), s = await serve(d);
  const get = (p: string, headers: Record<string, string> = {}, method = 'GET') => raw(s.base, p, headers, method);
  const onDisk = (u: string) => fs.readFileSync(path.join(d, u));
  // q is honoured: the higher q wins, a tie goes to br, `*` covers an unlisted coding, q=0 refuses, identity otherwise.
  for (const [ae, want] of [[CHROME, 'br'], ['br;q=0.1, gzip', 'gzip'], ['gzip;q=0.5, br;q=0.5', 'br'], ['*;q=0.2', 'br'], ['br;q=0, *', 'gzip'],
    ['identity', undefined], [undefined, undefined], ['gzip;q=0, br;q=0', undefined], ['BR', 'br'], ['gzip, br;q=0.9', 'gzip'], ['deflate', undefined],
    // Out-of-range q is clamped to [0, 1]: q=5 ties br at 1 (br wins), q=-1 refuses br (not a fallback to `*`).
    ['gzip;q=5, br', 'br'], ['br;q=-1, *', 'gzip'],
    // An unparseable q is a refusal (0), not a default 1; a coding listed twice keeps its highest q.
    ['br;q=abc, gzip', 'gzip'], ['br, br;q=0', 'br']] as const) {
    for (const u of [REFS.script, REFS.css]) {
      const r = await get(u, ae === undefined ? {} : { 'accept-encoding': ae });
      assert.strictEqual(r.h['content-encoding'], want, `Accept-Encoding ${JSON.stringify(ae)} on ${u}: content-encoding=${r.h['content-encoding']}, want ${want ?? '(none)'}`);
      assert(r.status === 200 && decode(r).equals(onDisk(u)), `Accept-Encoding ${JSON.stringify(ae)} on ${u}: ${r.status}, the decoded body is not the asset byte for byte`);
      assert(r.h['content-type']!.startsWith(u.endsWith('.css') ? 'text/css' : 'application/javascript'), `Accept-Encoding ${JSON.stringify(ae)} on ${u}: content-type=${r.h['content-type']}, want the asset's own`);
      assert(/\baccept-encoding\b/i.test(String(r.h.vary)), `Accept-Encoding ${JSON.stringify(ae)} on ${u}: vary=${r.h.vary ?? '(none)'}; a shared cache would hand br to a client that never asked`);
      assert.strictEqual(r.h['cache-control'], 'public, max-age=31536000, immutable', `Accept-Encoding ${JSON.stringify(ae)} on ${u}: cache-control`); n++;
    }
  }
  const br = await get(REFS.script, { 'accept-encoding': CHROME }), plain = await get(REFS.script);
  assert(br.body.length * 5 < plain.body.length, `the br body (${br.body.length} B) is not a compressed form of the ${plain.body.length} B asset`); n++;
  // Validators belong to the representation sent: a 304 for br answers only br's own ETag.
  assert(br.h.etag && br.h.etag !== plain.h.etag, `br and identity share the ETag ${br.h.etag}: a cache could revalidate one into the other`); n++;
  const nm = await get(REFS.script, { 'accept-encoding': CHROME, 'if-none-match': String(br.h.etag) });
  assert(nm.status === 304 && nm.body.length === 0 && /immutable/.test(String(nm.h['cache-control'])), `If-None-Match (br ETag): ${nm.status} ${nm.body.length} B`); n++;
  const head = await get(REFS.script, { 'accept-encoding': CHROME }, 'HEAD');
  assert(head.status === 200 && head.h['content-encoding'] === 'br' && head.body.length === 0 && head.h['content-length'] === br.h['content-length'], `HEAD: ${head.status} ce=${head.h['content-encoding']} len=${head.h['content-length']}`); n++;
  const part = await get(REFS.script, { 'accept-encoding': CHROME, range: 'bytes=0-9' });
  assert(part.status === 206 && part.body.equals(br.body.subarray(0, 10)) && part.h['content-range'] === `bytes 0-9/${br.body.length}`, `Range on br: ${part.status} ${part.h['content-range']}`); n++;
  // A failed precondition is the error handler's own uncached JSON, never the asset's type, coding or validators.
  for (const [label, h, status] of [['If-Match miss (br)', { 'accept-encoding': CHROME, 'if-match': '"nope"' }, 412], ['If-Match miss (identity)', { 'if-match': '"nope"' }, 412],
    ['If-Unmodified-Since 1990 (br)', { 'accept-encoding': CHROME, 'if-unmodified-since': 'Mon, 01 Jan 1990 00:00:00 GMT' }, 412],
    ['unsatisfiable Range (br)', { 'accept-encoding': CHROME, range: 'bytes=99999999-' }, 416], ['unsatisfiable Range (identity)', { range: 'bytes=99999999-' }, 416],
    // Past the br body, inside the raw one: the range is of the negotiated (br) representation, never the raw bytes.
    ['Range past the br length (br)', { 'accept-encoding': CHROME, range: `bytes=${br.body.length + 10}-${br.body.length + 20}` }, 416]] as const) {
    const r = await get(REFS.script, h as Record<string, string>);
    assert(r.status === status && r.h['content-type']!.startsWith('application/json') && r.h['cache-control'] === 'no-store' && !r.h['content-encoding'] && !r.h['last-modified']
      && r.h.etag !== br.h.etag && r.h.etag !== plain.h.etag,
      `${label}: ${r.status} type=${r.h['content-type']} cache-control=${r.h['cache-control']} coding=${r.h['content-encoding'] ?? '-'} last-modified=${r.h['last-modified'] ?? '-'} etag=${r.h.etag}`);
    assert.deepStrictEqual(JSON.parse(r.body.toString()), { error: 'Invalid request.' }, `${label}: body`); n++;
  }
  // Not a JS/CSS: immutable, never encoded, no Vary. The shell stays revalidated and never immutable.
  const font = await get('/assets/KaTeX_Main-Regular-EEEE5555.woff2', { 'accept-encoding': CHROME });
  assert(font.status === 200 && !font.h['content-encoding'] && font.h['cache-control'] === 'public, max-age=31536000, immutable' && !font.h.vary, `woff2: ${font.status} ce=${font.h['content-encoding']} cc=${font.h['cache-control']} vary=${font.h.vary}`); n++;
  for (const p of ['/', '/index.html', '/some/route']) {
    const r = await get(p, { 'accept-encoding': CHROME });
    assert(r.status === 200 && r.h['cache-control'] === 'public, max-age=0' && !r.h['content-encoding'], `${p}: cc=${r.h['cache-control']} ce=${r.h['content-encoding']}; the shell names the hashes, it must revalidate`); n++;
  }
  // Only the listed file under its exact spelling: another case, a trailing slash or a traversal is never served compressed or immutable.
  for (const p of [REFS.script.toUpperCase(), REFS.script.replace('/assets/', '/Assets/'), `${REFS.script}/`, '/assets/..%2Findex.html', '/assets/%2e%2e%2fserver.cjs', `/assets/${encodeURIComponent('../server.cjs')}`]) {
    const r = await get(p, { 'accept-encoding': CHROME });
    assert(!r.h['content-encoding'] && !/immutable/.test(String(r.h['cache-control'])) && !r.body.toString().includes('backend bundle'),
      `${p}: ${r.status} ce=${r.h['content-encoding']} cc=${r.h['cache-control']}`); n++;
  }
  // A sibling's own URL is a plain static file (hashed, so immutable too), never encoded a second time.
  for (const p of [`${REFS.script}.br`, `${REFS.script}.gz`]) {
    const r = await get(p, { 'accept-encoding': CHROME });
    assert(r.status === 200 && !r.h['content-encoding'] && r.body.equals(onDisk(p)), `${p}: ${r.status} ce=${r.h['content-encoding']} ${r.body.length} B`); n++;
  }
  // A sibling gone since boot: the raw file, whole and uncoded, never the other coding's headers.
  fs.rmSync(path.join(d, `${REFS.css}.br`));
  const gone = await get(REFS.css, { 'accept-encoding': 'br' });
  assert(gone.status === 200 && !gone.h['content-encoding'] && gone.body.equals(onDisk(REFS.css)) && gone.h['content-type']!.startsWith('text/css'), `sibling gone: ${gone.status} ce=${gone.h['content-encoding']} ${gone.body.length} B`); n++;
  s.close();
  // A dist built without the step: served raw, still immutable, no Vary (nothing varies).
  const bare = await serve(makeDist('bare', { siblings: false }));
  const b = await raw(bare.base, REFS.script, { 'accept-encoding': CHROME });
  assert(b.status === 200 && !b.h['content-encoding'] && /immutable/.test(String(b.h['cache-control'])), `no siblings: ${b.status} ce=${b.h['content-encoding']} cc=${b.h['cache-control']}`); n++;
  bare.close();
  // One sibling only: the coding without a file is never picked (it would 404 into the raw fallback).
  const one = makeDist('oneside');
  fs.rmSync(path.join(one, `${REFS.script}.gz`)); fs.rmSync(path.join(one, `${REFS.css}.br`));
  const os1 = await serve(one);
  for (const [u, ae, want] of [[REFS.script, 'gzip, br;q=0.9', 'br'], [REFS.css, 'br, gzip;q=0.9', 'gzip'], [REFS.script, 'gzip', undefined], [REFS.css, 'br', undefined]] as const) {
    const r = await raw(os1.base, u, { 'accept-encoding': ae });
    assert(r.status === 200 && r.h['content-encoding'] === want && decode(r).equals(fs.readFileSync(path.join(one, u))),
      `one sibling, Accept-Encoding "${ae}" on ${u}: ${r.status} content-encoding=${r.h['content-encoding']}, want ${want ?? '(none)'}`); n++;
  }
  os1.close();
  // Desktop (IS_ELECTRON): unchanged, a loopback origin gains nothing from either.
  const desk = await serve(d, block, undefined, { IS_ELECTRON: 'true' });
  const dr = await raw(desk.base, REFS.script, { 'accept-encoding': CHROME });
  assert(dr.status === 200 && !dr.h['content-encoding'] && dr.h['cache-control'] === 'public, max-age=0', `desktop: ce=${dr.h['content-encoding']} cc=${dr.h['cache-control']}`); n++;
  desk.close();
}

// ── live-smoke section 2, the real script against each shape
const ONE: Record<string, string> = {
  'the live page references its JS entry': 'entry', 'a hashed asset that is not deployed is a 404, not the SPA page': 'control',
  'an identity-only client gets the asset uncompressed': 'identity', 'the live page itself is revalidated on every load (never immutable)': 'shell',
  'a failed conditional asset request is an uncached JSON 412': 'precondition',
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECTION2 = new RegExp(`^(PASS|FAIL) (the live page's (/assets/\\S+) (resolves as \\S+|arrives brotli-compressed and immutable)|${Object.keys(ONE).map(esc).join('|')})(?: —|$)`);
const smoke = async (label: string, distPath: string, code = block, pre?: Pre, eh = handler) => {
  const s = await serve(distPath, code, pre, {}, eh);
  const out = await new Promise<string>((resolve) => execFile(process.execPath, [SMOKE], { env: { PATH: process.env.PATH, LIVE_BASE: s.base }, timeout: 60_000 },
    (_e, stdout, stderr) => resolve(stdout + stderr)));
  s.close();
  const got: Record<string, string> = {};
  for (const m of out.split('\n').map((l) => SECTION2.exec(l)).filter((x): x is RegExpExecArray => !!x)) {
    const key = m[3] ? `${m[4].startsWith('resolves') ? 'resolves' : 'packed'} ${m[3]}` : ONE[m[2]];
    assert(!(key in got), `${label}: section 2 printed the row '${key}' twice`); got[key] = m[1];
  }
  return { label, got, out: out.slice(0, 4000) };
};
// Every section-2 row, each pinned: `failing` the resolves-as rows, `packed` the compressed rows (default: the same).
type Over = { packed?: string[]; identity?: string; shell?: string; precondition?: string };
const expectRows = (r: Awaited<ReturnType<typeof smoke>>, failing: string[], control = 'PASS', o: Over = {}) => {
  const want: Record<string, string> = { entry: 'PASS', control, identity: o.identity ?? 'PASS', shell: o.shell ?? 'PASS', precondition: o.precondition ?? 'PASS' };
  for (const u of Object.values(REFS)) {
    want[`resolves ${u}`] = failing.includes(u) ? 'FAIL' : 'PASS';
    want[`packed ${u}`] = (o.packed ?? failing).includes(u) ? 'FAIL' : 'PASS';
  }
  assert.deepStrictEqual(r.got, want, `${r.label}: live-smoke section 2 rows\n${r.out}`); n++;
};
const ALL = Object.values(REFS);
// A broken server shape, made from the real block by one exact replacement (it must still apply, or it proves nothing).
const swap = (code: string, from: string, to: string) => {
  assert.strictEqual(code.split(from).length, 2, `mutant anchor not found exactly once: ${from}`);
  return code.replace(from, to);
};
expectRows(await smoke('complete dist', makeDist('full')), []);
// The identity and 412 rows read the entry chunk too: with it gone they fail with it.
expectRows(await smoke('the entry chunk never uploaded', makeDist('no-index', { drop: REFS.script })), [REFS.script], 'PASS', { identity: 'FAIL', precondition: 'FAIL' });
expectRows(await smoke('a modulepreload-only chunk never uploaded', makeDist('no-plotly', { drop: REFS.preload1 })), [REFS.preload1]);
expectRows(await smoke('the stylesheet never uploaded', makeDist('no-css', { drop: REFS.css })), [REFS.css]);
// Behind a server that still answers a missing asset with the SPA shell (the pre-fix block):
expectRows(await smoke('SPA-fallback server, dist complete', makeDist('naive-full'), naive), [], 'FAIL');
expectRows(await smoke('SPA-fallback server, entry missing', makeDist('naive-no-index', { drop: REFS.script }), naive), [REFS.script], 'FAIL', { identity: 'FAIL' });
// Why the two below cannot pass by coincidence: each is caught by exactly one clause, proven by fetching it.
{
  const d = makeDist('naive-padded', { drop: REFS.preload2, pad: 30_000 }), s = await serve(d, naive);
  const r = await fetch(s.base + REFS.preload2); const body = await r.text(); s.close();
  assert(r.status === 200 && body.length >= MIN && r.headers.get('content-type')!.startsWith('text/html'), 'fixture: a 30 KB shell passes status and size, only content-type can fail it'); n++;
  expectRows(await smoke('SPA-fallback server, 30 KB shell, preload missing', d, naive), [REFS.preload2], 'FAIL');
}
{
  const d = makeDist('truncated', { truncate: REFS.preload2 }), s = await serve(d);
  const r = await fetch(s.base + REFS.preload2); const body = await r.text(); s.close();
  assert(r.status === 200 && body.length < MIN && body.length > 1_000 && r.headers.get('content-type')!.includes('javascript'), 'fixture: a truncated chunk passes status and type, only the size floor can fail it'); n++;
  expectRows(await smoke('a chunk truncated to 1.6 KB', d), [REFS.preload2], 'PASS', { packed: [] });
}
// The RIGHT type is required, not merely "not HTML": browsers refuse a module script or a stylesheet served
// under another MIME (white page). Full-size bodies, so only the type clause can fail them.
const wrongType = (url: string, type: string): Pre => (req, res, next) => {
  if (req.path !== url) return next();
  res.type(type).send((url.endsWith('.css') ? '.a{b:c}' : 'var a=1;').repeat(4_000));
};
for (const [url, type] of [[REFS.script, 'application/octet-stream'], [REFS.preload1, 'text/plain'], [REFS.css, 'text/plain'], [REFS.css, 'application/javascript']]) {
  // res.send evaluates no If-Match: the entry's 412 row fails with it.
  expectRows(await smoke(`${url} served full-size as ${type}`, makeDist(`type-${n}`), block, wrongType(url, type)), [url], 'PASS', { precondition: url === REFS.script ? 'FAIL' : 'PASS' });
}
// Sweep 27: the compression, cache and error rows against broken shapes of the real block, each failing only its rows.
const ROUTE_PICK = 'qb > 0 && qb >= qg ? "br" : qg > 0 ? "gzip" : undefined';
const ASSET_CC = "'public, max-age=31536000, immutable'";
const STRIP = 'for (const h of ["Content-Type", "Content-Encoding", "ETag", "Last-Modified"]) res.removeHeader(h);';
for (const [label, dist, code, eh, failing, o] of [
  ['the pre-fix server (live 0.0.226)', makeDist('prefix', { siblings: false }), block.slice(0, block.indexOf('      if (process.env.IS_ELECTRON !== "true") {\n        const assetDir')) + block.slice(block.indexOf(STATIC)),
    swap(swap(handler, STRIP, ''), '    res.setHeader("Cache-Control", "no-store");\n', ''), [], { packed: ALL, precondition: 'FAIL' }],
  ['the build without the precompress step', makeDist('nosib', { siblings: false }), block, handler, [], { packed: ALL }],
  ['no Vary: Accept-Encoding', makeDist('novary'), swap(block, "res.vary('Accept-Encoding');", ''), handler, [], { packed: ALL }],
  ['a one-hour asset lifetime', makeDist('short'), swap(block, ASSET_CC, "'public, max-age=3600, immutable'"), handler, [], { packed: ALL }],
  ['a year-long asset lifetime, not immutable', makeDist('notimm'), swap(block, ASSET_CC, "'public, max-age=31536000'"), handler, [], { packed: ALL }],
  ['a tie goes to gzip', makeDist('tiegz'), swap(block, 'qb >= qg', 'qb > qg'), handler, [], { packed: ALL }],
  ['br for every client (Accept-Encoding ignored)', makeDist('always'), swap(block, ROUTE_PICK, '"br"'), handler, [], { identity: 'FAIL' }],
  ["the sibling's own type (no res.type)", makeDist('octet'), swap(block, 'res.type(path.extname(file)).setHeader(', 'res.setHeader('), handler, ALL, { packed: [] }],
  ['a shell cached for a day', makeDist('dayshell'), swap(block, STATIC, "      app.use(express.static(distPath, { maxAge: '1d' }));\n"), handler, [], { shell: 'FAIL' }],
  ['an immutable shell at max-age=0', makeDist('immshell'), swap(block, STATIC, "      app.use((req, res, next) => { if (req.path === '/') res.setHeader('Cache-Control', 'public, max-age=0, immutable'); next(); });\n" + STATIC), handler, [], { shell: 'FAIL' }],
  ["the error handler keeps send's type", makeDist('ehtype'), block, swap(handler, STRIP, 'for (const h of ["Content-Encoding", "ETag", "Last-Modified"]) res.removeHeader(h);'), [], { precondition: 'FAIL' }],
  ["the error handler keeps send's cache", makeDist('ehcache'), block, swap(handler, '    res.setHeader("Cache-Control", "no-store");\n', ''), [], { precondition: 'FAIL' }],
] as const) {
  expectRows(await smoke(label, dist, code, undefined, eh), [...failing], 'PASS', { ...o, packed: o.packed ? [...o.packed] : undefined });
}
// The control is pinned to exactly 404, the only answer the route emits: a 500 is a broken origin, and a 403/410
// would come from something in front of the server (an edge ACL, a CDN rule), which is exactly what to notice.
for (const code of [500, 403, 410, 204]) {
  const pre: Pre = (req, res, next) => (req.path === '/assets/index-NEVERUPLOADED.js' ? res.status(code).json({ error: 'x' }) : next());
  expectRows(await smoke(`the not-deployed control answers ${code}`, makeDist(`ctl-${code}`), block, pre), [], 'FAIL');
}
console.log(`staticassets.cloud.test.ts: ${n} checks passed`);
process.exit(0);

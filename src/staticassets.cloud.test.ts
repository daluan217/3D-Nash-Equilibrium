/**
 * The static block (server.ts) and live-smoke section 2, run for real: the block is lifted from the source
 * into express over a synthetic dist, and the REAL src/e2e/live-smoke.mjs is pointed at it as a child.
 * Sweep 25: a missing /assets/* fell through to the SPA fallback as 200 text/html (~2.5 KB), and section 2
 * read only the first .js by status and size, so a chunk that never uploaded passed the live smoke.
 *
 *   npx tsx src/staticassets.cloud.test.ts
 */
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import ts from 'typescript';

setTimeout(() => { console.error('staticassets.cloud.test.ts: timed out'); process.exit(1); }, 120_000).unref();
const src = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const SMOKE = fileURLToPath(new URL('./e2e/live-smoke.mjs', import.meta.url));
const start = src.indexOf('      const forbiddenFiles = new Set<string>();');
const tail = "      app.get('*', (req, res) => {\n        res.sendFile(path.join(distPath, 'index.html'));\n      });\n";
const end = src.indexOf(tail, start) + tail.length;
assert(start > 0 && end > start + tail.length, 'the static block (forbiddenFiles .. SPA fallback) is gone from server.ts');
const block = src.slice(start, end);
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
const makeDist = (name: string, { drop = '', truncate = '', pad = 0 } = {}) => {
  const d = path.join(tmp, name); fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), shell(pad));
  fs.writeFileSync(path.join(d, 'server.cjs'), '/* the backend bundle */');
  for (const u of Object.values(REFS)) if (u !== drop) fs.writeFileSync(path.join(d, u), (u.endsWith('.css') ? '.a{b:c}' : 'var a=1;').repeat(u === truncate ? 200 : 4_000));
  return d;
};
const serve = async (distPath: string, code = block) => {
  const app = express();
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); }); // server.ts mounts this first
  new Function('app', 'express', 'path', 'fs', 'distPath', compile(code))(app, express, path, fs, distPath);
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  return { base: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, close: () => srv.close() };
};

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

// ── live-smoke section 2, the real script against each shape
const SECTION2 = /^(PASS|FAIL) (the live page references its JS entry|the live page's (\/assets\/\S+) resolves as \S+|a hashed asset that is not deployed is a 404, not the SPA page)/;
const smoke = async (label: string, distPath: string, code = block) => {
  const s = await serve(distPath, code);
  const out = await new Promise<string>((resolve) => execFile(process.execPath, [SMOKE], { env: { PATH: process.env.PATH, LIVE_BASE: s.base }, timeout: 60_000 },
    (_e, stdout, stderr) => resolve(stdout + stderr)));
  s.close();
  const rows = out.split('\n').map((l) => SECTION2.exec(l)).filter((m): m is RegExpExecArray => !!m);
  const byUrl = new Map(rows.filter((m) => m[3]).map((m) => [m[3], m[1]]));
  const entry = rows.find((m) => m[2].startsWith('the live page references'))?.[1];
  const control = rows.find((m) => m[2].startsWith('a hashed asset'))?.[1];
  return { label, byUrl, entry, control, out: out.slice(0, 3000) };
};
const expectRows = (r: Awaited<ReturnType<typeof smoke>>, failing: string[], control = 'PASS') => {
  assert.deepStrictEqual([...r.byUrl.keys()].sort(), Object.values(REFS).sort(), `${r.label}: section 2 must check all four references (script, both modulepreloads, the stylesheet)\n${r.out}`);
  for (const [u, v] of r.byUrl) assert.strictEqual(v, failing.includes(u) ? 'FAIL' : 'PASS', `${r.label}: ${u} ${v}\n${r.out}`);
  assert.strictEqual(r.entry, 'PASS', `${r.label}: entry row\n${r.out}`);
  assert.strictEqual(r.control, control, `${r.label}: the not-deployed control row\n${r.out}`); n++;
};
expectRows(await smoke('complete dist', makeDist('full')), []);
expectRows(await smoke('the entry chunk never uploaded', makeDist('no-index', { drop: REFS.script })), [REFS.script]);
expectRows(await smoke('a modulepreload-only chunk never uploaded', makeDist('no-plotly', { drop: REFS.preload1 })), [REFS.preload1]);
expectRows(await smoke('the stylesheet never uploaded', makeDist('no-css', { drop: REFS.css })), [REFS.css]);
// Behind a server that still answers a missing asset with the SPA shell (the pre-fix block):
expectRows(await smoke('SPA-fallback server, dist complete', makeDist('naive-full'), naive), [], 'FAIL');
expectRows(await smoke('SPA-fallback server, entry missing', makeDist('naive-no-index', { drop: REFS.script }), naive), [REFS.script], 'FAIL');
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
  expectRows(await smoke('a chunk truncated to 1.6 KB', d), [REFS.preload2]);
}
console.log(`staticassets.cloud.test.ts: ${n} checks passed`);
process.exit(0);

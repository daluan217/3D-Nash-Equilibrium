/**
 * The build's precompress step (scripts/precompress.mjs) and everything that carries it: the build line, the
 * Dockerfile, the desktop package's file list and the CI size budget. Sweep 27: live served every asset raw
 * (4.66 MB) because Cloud Run's front end compresses nothing; server.ts now serves these siblings.
 *
 *   npx tsx src/precompress.cloud.test.ts                              # synthetic dist + static contracts
 *   PRECOMPRESS_DIST=dist/assets npx tsx src/precompress.cloud.test.ts # also the real build output (CI build job)
 */
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const SCRIPT = path.join(root, 'scripts/precompress.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'precompress-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

// Every JS/CSS has a .br and a .gz that decode to it byte for byte; nothing else gets one.
const siblingsOf = (dir: string) => {
  const names = fs.readdirSync(dir), assets = names.filter((f) => /\.(js|css)$/.test(f));
  for (const f of assets) {
    const src = fs.readFileSync(path.join(dir, f));
    for (const [ext, dec] of [['br', zlib.brotliDecompressSync], ['gz', zlib.gunzipSync]] as const) {
      assert(names.includes(`${f}.${ext}`), `${dir}/${f} has no .${ext} sibling: the hosted route serves it raw`);
      assert(dec(fs.readFileSync(path.join(dir, `${f}.${ext}`))).equals(src), `${dir}/${f}.${ext} does not decode to ${f}: a stale or foreign sibling`);
    }
  }
  const stray = names.filter((f) => /\.(br|gz)$/.test(f) && !assets.includes(f.replace(/\.(br|gz)$/, '')));
  assert.deepStrictEqual(stray, [], `${dir}: siblings with no asset beside them`);
  return assets;
};

// ── the script, on a synthetic dist: siblings for JS/CSS only, and a dist with none is an error, not a silent no-op
{
  const d = path.join(tmp, 'assets'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'index-A1.js'), 'export const a = 1;\n'.repeat(3_000));
  fs.writeFileSync(path.join(d, 'index-B2.css'), '.a{color:red}\n'.repeat(3_000));
  fs.writeFileSync(path.join(d, 'KaTeX-C3.woff2'), Buffer.alloc(900, 3));
  execFileSync(process.execPath, [SCRIPT, d]);
  assert.deepStrictEqual(siblingsOf(d).sort(), ['index-A1.js', 'index-B2.css'], 'precompress: the JS and CSS'); n++;
  assert(!fs.existsSync(path.join(d, 'KaTeX-C3.woff2.br')), 'precompress: a woff2 is already compressed and must get no sibling'); n++;
  const br = fs.statSync(path.join(d, 'index-A1.js.br')).size, raw = fs.statSync(path.join(d, 'index-A1.js')).size;
  assert(br * 20 < raw, `precompress: the .br is ${br} B for ${raw} B of repetitive JS; not brotli at a real quality`); n++;
  // A rebuilt asset gets fresh siblings: vite empties dist/, but a re-run must never keep a stale one.
  fs.writeFileSync(path.join(d, 'index-A1.js'), 'export const b = 2;\n'.repeat(3_000));
  execFileSync(process.execPath, [SCRIPT, d]); siblingsOf(d); n++;
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty);
  const r = spawnSync(process.execPath, [SCRIPT, empty], { encoding: 'utf8' });
  assert(r.status !== 0 && /no \.js\/\.css/.test(r.stderr), `precompress on a dist with no assets exited ${r.status}: a broken vite build must fail the build`); n++;
}

// ── the real build output (CI: after `npm run build`)
if (process.env.PRECOMPRESS_DIST) {
  const assets = siblingsOf(process.env.PRECOMPRESS_DIST);
  assert(assets.length >= 3, `${process.env.PRECOMPRESS_DIST}: only ${assets.length} JS/CSS (index js+css, plotly, katex expected)`); n++;
}

// ── the build line: vite, then precompress, then the server bundle, chained so a failed step fails the build
const pkg = JSON.parse(read('package.json'));
const steps = String(pkg.scripts.build).split('&&').map((s) => s.trim());
const at = (re: RegExp) => steps.findIndex((s) => re.test(s));
assert(at(/^vite build\b/) === 0 && at(/^node scripts\/precompress\.mjs$/) === 1 && at(/^esbuild server\.ts\b/) === 2,
  `package.json build must run \`vite build && node scripts/precompress.mjs && esbuild ...\`: ${pkg.scripts.build}`); n++;

// ── the Dockerfile's builder stage copies every script the build line runs (else the image build dies on it)
{
  const df = read('Dockerfile');
  const builder = df.slice(0, df.indexOf('RUN npm run build'));
  assert(builder.length > 0 && /^WORKDIR \/app$/m.test(builder), 'Dockerfile: the builder stage (WORKDIR /app .. RUN npm run build) is gone');
  const copies = [...builder.matchAll(/^COPY (?!--from)(\S+) (\S+)\s*$/gm)].map((m) => [m[1], m[2]]);
  for (const s of steps) {
    for (const [, file] of s.matchAll(/\bnode (scripts\/\S+)/g)) {
      const lands = copies.some(([from, to]) => {
        const dest = path.posix.join('/app', to);
        return (from === file && (to.endsWith('/') ? path.posix.join(dest, path.posix.basename(file)) : dest) === `/app/${file}`)
          || (from.endsWith('/') && file.startsWith(from) && `${dest}/` === `/app/${from}`);
      });
      assert(lands, `Dockerfile: the builder stage never COPYs ${file} to /app/${file}, and \`npm run build\` runs it`); n++;
    }
  }
}

// ── the runtime stage (`npm ci --omit=dev`) installs every package the server bundle requires (--packages=external):
// one in devDependencies boots nowhere but the image, where the require throws and every revision fails its health check.
{
  const esbuild = await import('esbuild');
  // The build line's own flags; the OUTPUT's imports, so a type-only import (erased) is not counted.
  const { metafile } = await esbuild.build({ entryPoints: [path.join(root, 'server.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(tmp, 'server.cjs'), write: false, metafile: true, logLevel: 'silent' });
  const pkgName = (s: string) => s.split('/').slice(0, s.startsWith('@') ? 2 : 1).join('/');
  const ext = new Set(Object.values(metafile.outputs).flatMap((o) => o.imports).filter((i) => i.external && !isBuiltin(i.path)).map((i) => pkgName(i.path)));
  assert(ext.has('express') && ext.has('@google-cloud/storage'), `fixture: the server's externals were not read (${[...ext]})`);
  const deps = JSON.parse(read('package.json')).dependencies ?? {};
  for (const p of ext) { assert(p in deps, `server.ts requires ${p}, which is not in package.json dependencies: the image's \`npm ci --omit=dev\` never installs it`); n++; }
  const df = read('Dockerfile'), runtime = df.slice(df.lastIndexOf('\nFROM '));
  assert(/^RUN npm ci --omit=dev$/m.test(runtime) && /^CMD \["node", "dist\/server\.cjs"\]$/m.test(runtime), 'Dockerfile: the runtime stage no longer installs with `npm ci --omit=dev` and runs dist/server.cjs'); n++;
  // Not root (cloud sweep 6): the last USER wins. It owns the WORKDIR (the no-bucket server's db.json folder) and
  // nothing inside it, so the process cannot rewrite the dist/ it serves.
  const users = [...runtime.matchAll(/^USER[ \t]+(\S+)[ \t]*$/gm)].map((m) => m[1]), user = users.at(-1)?.split(':')[0];
  const wd = [...runtime.matchAll(/^WORKDIR[ \t]+(\S+)[ \t]*$/gm)].at(-1)?.[1];
  assert(user && !['root', '0'].includes(user), `Dockerfile: the runtime stage runs as root (USER ${users.at(-1) ?? 'never set'})`); n++;
  assert(wd && runtime.split('\n').includes(`RUN chown ${user}:${user} ${wd}`), `Dockerfile: ${user} does not own ${wd}, where the no-bucket server writes db.json`); n++;
  assert(!/--chown|chown[ \t]+-/.test(runtime), 'Dockerfile: the runtime stage hands files under the WORKDIR to the server user, not just the folder'); n++;
}

// ── the desktop package leaves the siblings out, judged by electron-builder's own matcher (last match wins)
{
  const { FileMatcher } = createRequire(import.meta.url)('app-builder-lib/out/fileMatcher') as {
    FileMatcher: new (from: string, to: string, expand: (s: string) => string, patterns: string[]) => { createFilter(): (file: string, stat: fs.Stats) => boolean }
  };
  const packaged = new FileMatcher(root, '/out', (s) => s, pkg.build.files).createFilter();
  const file = { isDirectory: () => false } as fs.Stats;
  const verdict = (p: string) => packaged(path.join(root, p), file);
  for (const p of ['dist/assets/index-A1.js.br', 'dist/assets/index-A1.js.gz', 'dist/assets/index-B2.css.br', 'dist/assets/index-B2.css.gz']) {
    assert(!verdict(p), `build.files packages ${p}: the desktop serves raw assets, so every sibling is dead weight in the DMG`); n++;
  }
  for (const p of ['dist/assets/index-A1.js', 'dist/assets/index-B2.css', 'dist/assets/KaTeX-C3.woff2', 'dist/index.html', 'dist/server.cjs']) {
    assert(verdict(p), `build.files leaves out ${p}: the app cannot run without it`); n++;
  }
  if (process.env.PRECOMPRESS_DIST) {
    const listed = fs.readdirSync(process.env.PRECOMPRESS_DIST).map((f) => `dist/assets/${f}`);
    const shipped = listed.filter(verdict);
    assert.deepStrictEqual(shipped.filter((f) => /\.(br|gz)$/.test(f)), [], 'the real dist: siblings that would be packaged');
    assert.deepStrictEqual(listed.filter((f) => !/\.(br|gz)$/.test(f) && !verdict(f)), [], 'the real dist: assets left out of the package'); n++;
  }
}

// ── the CI size budget counts raw bundle growth: it still fires on >10 MB raw, never on the siblings alone
{
  const wf = yaml.load(read('.github/workflows/test.yml')) as { jobs: Record<string, { 'runs-on': string; steps: { name?: string; run?: string }[] }> };
  const job = wf.jobs.build, step = job?.steps.find((s) => s.name === 'Enforce the bundle size budget (10 MB)');
  assert(step?.run && job['runs-on'] === 'ubuntu-latest', 'test.yml: the build job budget step is gone (or left ubuntu, where it was measured)');
  const budget = (label: string, script: string, files: Record<string, number>) => {
    const d = path.join(tmp, label); fs.mkdirSync(path.join(d, 'dist/assets'), { recursive: true });
    for (const [f, kb] of Object.entries(files)) fs.writeFileSync(path.join(d, 'dist/assets', f), Buffer.alloc(kb * 1024, 0x5a));
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: d, encoding: 'utf8' });
    fs.rmSync(d, { recursive: true });
    return { fired: r.status !== 0, kb: Number(/dist\/assets is (\d+) KB/.exec(r.stdout)?.[1]), out: r.stdout + r.stderr };
  };
  const RAW_OK = { 'plotly-X.js': 4_700, 'index-X.js': 700, 'index-X.css': 200 };
  const SIBS = { 'plotly-X.js.br': 1_000, 'plotly-X.js.gz': 1_400, 'index-X.js.br': 3_000, 'index-X.js.gz': 3_500 };
  const ok = budget('ok', step.run, { ...RAW_OK, ...SIBS });
  assert(!ok.fired && ok.kb >= 5_600 && ok.kb < 5_700, `budget: 5.6 MB raw + 8.9 MB of siblings fired or miscounted (${ok.kb} KB)\n${ok.out}`); n++;
  const over = budget('over', step.run, { ...RAW_OK, 'katex-X.js': 5_000 });
  assert(over.fired && /exceeds the 10 MB budget/.test(over.out), `budget: 10.6 MB raw did not fire (${over.kb} KB)\n${over.out}`); n++;
  const overSibs = budget('over-sibs', step.run, { ...RAW_OK, 'katex-X.js': 5_000, ...SIBS });
  assert(overSibs.fired, `budget: 10.6 MB raw with siblings beside it did not fire (${overSibs.kb} KB)`); n++;
  // Control: the pre-sweep-27 line counts the siblings and fires on the same healthy dist.
  const old = budget('old', step.run.replace(/^\s*kb=.*$/m, '          kb=$(du -sk dist/assets | cut -f1)'), { ...RAW_OK, ...SIBS });
  assert(old.fired, 'fixture: `du -sk` over the same dist must fire, or this proves nothing about excluding the siblings'); n++;
}
console.log(`precompress.cloud.test.ts: ${n} checks passed`);

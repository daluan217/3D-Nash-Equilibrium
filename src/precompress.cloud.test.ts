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

// ── the Dockerfile as buildkit reads it (moby/buildkit parser.go): a comment line (`#` after blanks) is dropped and
// never continues (review 3: `# c \` then `USER root` ran as root past a plain `\`-newline join); `\` + blanks joins
// the next line, skipping comment and blank lines inside it; `\\` does not continue. A heredoc is refused below, not modelled.
// Blanks are Go's unicode.IsSpace (sweep 13: a BOM, a trailing blank and a NBSP-indented comment misread as instructions).
const SP = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const dockerLines = (text: string) => {
  const raw = text.replace(/^\ufeff/, '').split('\n').map((l) => l.replace(/\r+$/, '')), lines: string[] = [];
  const skip = new RegExp(`^${SP}*(#|$)`), trim = (l: string) => l.replace(new RegExp(`${SP}+$`), '');
  let cur: string | undefined;
  for (const l of raw) {
    if (skip.test(l)) continue;
    const body = l.replace(/(^|[^\\])\\[ \t]*$/, '$1');
    cur = (cur ?? '') + body;
    if (body === l) { lines.push(trim(cur)); cur = undefined; }
  }
  if (cur !== undefined) lines.push(trim(cur));
  // Canonical spelling, or every line-anchored Dockerfile guard (here, cloudbuild.contract's) reads the wrong file:
  // docker takes `from`/`user`/`copy` in any case, indented; heredoc bodies read as instructions here and are not;
  // a parser directive re-escapes or re-parses the file. Not modelled: any directive-shaped comment is refused.
  const offForm = [...raw.filter((l) => new RegExp(`^${SP}*#${SP}*(syntax|escape|check)${SP}*=`, 'i').test(l)),
    ...lines.filter((l) => !/^[A-Z]+ \S/.test(l) || l.includes('<<'))];
  return { lines, offForm };
};
// The reader itself, on review 3's shapes (the real Dockerfile has none of them, so it alone cannot pin the reader).
assert.deepStrictEqual(dockerLines('USER node\n# ignored comment \\\nUSER root\n').lines, ['USER node', 'USER root'], 'Dockerfile reader: a comment ending in `\\` continued into the next instruction'); n++;
assert.deepStrictEqual(dockerLines('RUN a \\\\\nUSER root').lines, ['RUN a \\\\', 'USER root'], 'Dockerfile reader: an escaped `\\\\` continued the line'); n++;
assert.deepStrictEqual(dockerLines('RUN a \\ \t\r\n  # c\n\n  b\n  # indented comment\nUSER x').lines, ['RUN a   b', 'USER x'], 'Dockerfile reader: `\\` + blanks, or a comment/blank inside a continuation, split the instruction'); n++;
assert.deepStrictEqual(dockerLines('  # indented comment\nUSER x').offForm, [], 'Dockerfile reader: an indented comment read as an instruction'); n++;
for (const bad of ['#\u00a0escape=`\nUSER x', '  #check = skip=all\nUSER x', '#!/bin/x\n# syntax=a/b\nUSER x', 'RUN cat <<"# end"\nUSER x\n# end', 'user root', ' USER root', 'USER\troot']) {
  assert(dockerLines(bad).offForm.length > 0, `Dockerfile reader: ${JSON.stringify(bad)} (directive, heredoc, off-case or off-column) read as canonical`); n++;
}
// Docker reads each of these as `USER node` (a BOM, trailing blanks, a unicode-indented comment and blank line).
for (const ok of ['\ufeff# c\nUSER node \t\r\n', '\u00a0# c \\\n\u3000\nUSER node\u00a0\u2003', 'USER node \\']) {
  assert.deepStrictEqual(dockerLines(ok), { lines: ['USER node'], offForm: [] }, `Dockerfile reader: ${JSON.stringify(ok)} not read as docker reads it`); n++;
}
const { lines: dfLines, offForm } = dockerLines(read('Dockerfile'));

// ── the Dockerfile's builder stage copies every script the build line runs (else the image build dies on it)
{
  const df = dfLines.join('\n');
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
  const lines = dfLines, df = lines.join('\n');
  assert(offForm.length === 0, `Dockerfile: instructions the static guards cannot read (want upper case at column 0, no parser directive, no \`<<\`): ${offForm.join(' | ')}`); n++;
  const runtime = df.slice(df.lastIndexOf('\nFROM '));
  // Named sources only (cloudbuild.contract's whole-context check reads one spelling: ADD, `[".", "./"]`, `*` passed).
  const wide = lines.filter((l) => /^(ADD|COPY) /.test(l) && !/^COPY --from=/.test(l)
    && !l.split(/[ \t]+/).slice(1, -1).every((s) => s === 'package*.json' || /^[\w-][\w.-]*(\/[\w-][\w.-]*)*\/?$/.test(s)));
  assert(wide.length === 0, `Dockerfile: copies more than named files from the build context: ${wide.join(' | ')}`); n++;
  assert.deepStrictEqual(runtime.split('\n').filter((l) => /^(ADD|COPY) /.test(l)), ['COPY package*.json ./', 'COPY --from=builder /app/dist/ ./dist/'],
    'Dockerfile: the runtime stage copies only package*.json and the built dist/'); n++;
  // cloudbuild.contract checks NODE_ENV=production is SET, not that it holds: a later ENV (development, IS_ELECTRON,
  // ELECTRON_USER_DATA_PATH = the desktop's local owner, no HSTS, no Host guard) overrode it past both.
  assert.deepStrictEqual(runtime.split('\n').filter((l) => /^(ENV|ARG) /.test(l)), ['ENV NODE_ENV=production'], 'Dockerfile: the runtime stage sets an env beyond NODE_ENV=production'); n++;
  assert(/^RUN npm ci --omit=dev$/m.test(runtime) && /^CMD \["node", "dist\/server\.cjs"\]$/m.test(runtime), 'Dockerfile: the runtime stage no longer installs with `npm ci --omit=dev` and runs dist/server.cjs'); n++;
  // Not root (cloud sweep 6): the last USER (instructions are case-insensitive) is exactly the base image's node,
  // an allowlist, since `USER 00` / `+0` are uid 0 too. Its one chown is the WORKDIR (the no-bucket db.json folder).
  const user = [...runtime.matchAll(/^[ \t]*USER[ \t]+(.*?)[ \t]*$/gim)].at(-1)?.[1];
  const wd = [...runtime.matchAll(/^[ \t]*WORKDIR[ \t]+(\S+)[ \t]*$/gim)].at(-1)?.[1];
  assert(user === 'node', `Dockerfile: the runtime stage runs as root or an unknown user (USER ${user ?? 'never set'}), want node`); n++;
  const rt = runtime.split('\n'), chowns = rt.filter((l) => /ch(own|mod)/i.test(l));
  assert(chowns.includes(`RUN chown node:node ${wd}`), `Dockerfile: node does not own ${wd}, where the no-bucket server writes db.json`); n++;
  assert(chowns.length === 1, `Dockerfile: the runtime stage chowns or chmods more than the folder the server writes to: ${chowns.join(' | ')}`); n++;
  // A RUN after USER node leaves node owning what it creates (npm ci there = writable dependencies).
  // What USER node could regress: it cannot bind below 1024. Cloud Run's port is 8080 unless the deploy passes
  // --port, and Docker (the CI container job) lets non-root bind low ports, so only this sees a --port=80.
  const cb = yaml.load(read('cloudbuild.yaml')) as { steps: { name?: string; args?: string[] }[] };
  const deployArgs = cb.steps.flatMap((s) => s.args ?? []).join(' ');
  const low = [...deployArgs.matchAll(/--port[= ]+(\S+)/g)].map((m) => m[1]).filter((p) => !(Number(p) >= 1024));
  assert(low.length === 0, `cloudbuild.yaml: --port ${low.join(', ')}, which USER node cannot bind`); n++;
  // Every check here reads what ships only if Cloud Run runs this file's last stage (sweep 12: build `-f`/`--target`/
  // another context, another --image, --command/--source all passed). Build + push exact; deploy flags allowlisted.
  const IMG = 'gcr.io/$PROJECT_ID/nash-equilibrium-backend:$SHORT_SHA';
  assert.deepStrictEqual(cb.steps.slice(0, 2), [
    { name: 'gcr.io/cloud-builders/docker', args: ['build', '-t', IMG, '-t', 'gcr.io/$PROJECT_ID/nash-equilibrium-backend:latest', '.'] },
    { name: 'gcr.io/cloud-builders/docker', args: ['push', IMG] }], 'cloudbuild.yaml: the image is not this Dockerfile\'s last stage, built from . and pushed as the deployed tag'); n++;
  const [deploy, ...extra] = cb.steps.slice(2), dArgs = deploy?.args ?? [], flag = (a: string) => a.split('=')[0];
  const DEPLOY_FLAGS = ['--image', '--region', '--platform', '--allow-unauthenticated', '--set-env-vars', '--set-secrets', '--memory', '--cpu', '--timeout', '--max-instances'];
  // Each flag once (sweep 15: a second --set-env-vars=IS_ELECTRON=true or --max-instances=100 passed every guard; the
  // contract reads only the first), and no build-wide env, secrets or pool beside the steps.
  const cbKeys = cb as unknown as Record<string, unknown>;
  assert(Object.keys(cbKeys).sort().join() === 'images,options,steps,substitutions' && JSON.stringify(cbKeys.options) === '{"logging":"CLOUD_LOGGING_ONLY"}',
    `cloudbuild.yaml: top-level keys or options beyond the reviewed ones: ${JSON.stringify(Object.keys(cbKeys))} ${JSON.stringify(cbKeys.options)}`); n++;
  assert(extra.length === 0 && Object.keys(deploy ?? {}).join() === 'name,args' && deploy.name === 'gcr.io/cloud-builders/gcloud'
    && new Set(dArgs.slice(3).map(flag)).size === dArgs.length - 3
    && dArgs.slice(0, 3).join(' ') === 'run deploy nash-equilibrium-backend' && dArgs.slice(3).every((a) => DEPLOY_FLAGS.includes(flag(a)))
    && dArgs.filter((a) => flag(a) === '--image').join() === `--image=${IMG}`,
  `cloudbuild.yaml: the deploy is not one \`gcloud run deploy\` of --image=${IMG} with reviewed flags: ${cb.steps.slice(2).map((s) => JSON.stringify(s)).join(' | ').slice(0, 600)}`); n++;
  const lastAt = (re: RegExp) => rt.map((l) => re.test(l)).lastIndexOf(true);
  assert(lastAt(/^RUN /) < lastAt(/^USER /), 'Dockerfile: a RUN after USER node, so node owns what it creates'); n++;
  // The backstop (sweep 9: `FROM builder`, inheriting source + devDependencies, passed every check above): the
  // runtime stage is exactly the reviewed one. The named checks above say why; changing the image means editing this.
  const REVIEWED = ['FROM node:22-alpine', 'WORKDIR /app', 'ENV NODE_ENV=production', 'COPY package*.json ./', 'RUN npm ci --omit=dev',
    'COPY --from=builder /app/dist/ ./dist/', 'RUN chown node:node /app', 'USER node',
    // `\`-joined as buildkit joins it (sweep 13: `HEALTHCHECK NONE` passed when this line was normalised away).
    'HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3   CMD node -e "require(\'http\').get(\'http://localhost:\' + (process.env.PORT || \'3000\') + \'/api/health\', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"',
    'EXPOSE 3000', 'CMD ["node", "dist/server.cjs"]'];
  assert.deepStrictEqual(rt.filter((l) => /^[A-Z]/.test(l)), REVIEWED, 'Dockerfile: the runtime stage is not the reviewed one'); n++;
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

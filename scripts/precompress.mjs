// Writes <file>.br (brotli q11) and <file>.gz (gzip -9) beside every JS/CSS in dist/assets, for server.ts's
// hosted /assets route. Cloud Run's front end does not compress: every asset went out raw (4.66 MB, sweep 27).
// Build time, not per request: q11 on plotly costs ~6.5 s, and a cold instance would pay it on its first hit.
//   node scripts/precompress.mjs [dir]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2] ?? 'dist/assets';
const files = fs.readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
if (files.length === 0) throw new Error(`precompress: no .js/.css in ${dir}; did vite build run?`);
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f));
  const { BROTLI_PARAM_QUALITY: Q, BROTLI_PARAM_SIZE_HINT: HINT } = zlib.constants;
  fs.writeFileSync(path.join(dir, `${f}.br`), zlib.brotliCompressSync(src, { params: { [Q]: 11, [HINT]: src.length } }));
  fs.writeFileSync(path.join(dir, `${f}.gz`), zlib.gzipSync(src, { level: 9 }));
}
console.log(`precompress: ${files.length} files in ${dir}`);

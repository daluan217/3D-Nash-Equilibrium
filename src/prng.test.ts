/**
 * The shared test PRNG (src/testing/prng.ts) and the ban on the float LCG.
 * PERIOD: 100,000 draws are ≥ 99,000 distinct from several seeds (the float
 * form gives 10,466 and fails). BAN: no `* 1103515245` in src/ or the tracked
 * _gen CI scripts outside prng.ts; a new fuzz must use seededRandom.
 *
 *   npx tsx src/prng.test.ts
 */
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { seededRandom } from './testing/prng.ts';

let n = 0;
for (const seed of [1, 7, 4242, 424242, 20260829, 20260924]) {
  const r = seededRandom(seed), seen = new Set<number>();
  for (let i = 0; i < 100000; i++) { const v = r(); assert(v >= 0 && v < 1, `out of range ${v}`); seen.add(v); }
  assert(seen.size >= 99000, `seed ${seed}: ${seen.size} distinct of 100000 — the generator cycles`); n++;
}
const a = seededRandom(20260829), b = seededRandom(20260829);
for (let i = 0; i < 1000; i++) assert.strictEqual(a(), b(), 'same seed must replay'); n++;

const root = path.resolve(import.meta.dirname, '..');
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|mjs|js)$/.test(f) && !/ \d+\./.test(f)) files.push(p); } };
walk(path.join(root, 'src'));
for (const f of ['_gen/verify_tieprose.ts', '_gen/verify_screens.ts']) files.push(path.join(root, f));
const hits = files.filter((f) => !f.endsWith(path.join('testing', 'prng.ts')) && !f.endsWith('prng.test.ts'))
  .flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const))
  .filter(([, , l]) => /\*\s*1103515245/.test(l) && !/Math\.imul/.test(l));
assert.deepStrictEqual(hits.map(([f, i]) => `${path.relative(root, f)}:${i}`), [], 'float LCG: use seededRandom from src/testing/prng.ts'); n++;
console.log(`prng.test.ts: ${n} checks passed (${files.length} files scanned)`);

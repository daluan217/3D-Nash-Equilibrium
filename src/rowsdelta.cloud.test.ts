/* rowsDelta (server.ts) keeps the hosted budget counter exact between uploads (S15-1: a full
 * stringify per write was a CPU amplifier). Over random add/delete/replace/clear scripts on rows
 * holding every JSON edge (multi-byte, lone surrogates, escapes, NaN, -0, 1e21, undefined fields)
 * its delta must equal the byte change of the pretty store that uploadDbToGcs writes (sweep 19
 * angle 3, EMPTY). In-place edits (same array) are 0 by design: exact again at the next upload. */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { seededRandom } from './testing/prng.ts';

const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const start = src.indexOf('function rowsDelta<T>(');
assert(start > 0, 'server.ts must define rowsDelta');
const js = ts.transpileModule(src.slice(start, src.indexOf('\n}\n', start) + 2), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const rowsDelta = new Function(`${js}; return rowsDelta;`)() as (a: object[], b: object[]) => number;

const rnd = seededRandom(20260928);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const str = () => Array.from({ length: Math.floor(rnd() * 12) }, () => pick(['a', '界', '😀', '\n', '"', '\\', '\ud800', ' ', ' ', 'é', '\u0000'])).join('');
let id = 0;
const row = () => ({ id: `r${id++}`, name: str(), n: pick([0, -0, 1.5, 1e21, NaN, -7]), gone: undefined, tags: rnd() < 0.5 ? [] : [str(), { k: str() }], o: rnd() < 0.3 ? {} : { a: str() } });
const size = (d: object) => Buffer.byteLength(JSON.stringify(d, null, 2));
const ops = { add: 0, del: 0, replace: 0, clear: 0, bulk: 0 };
let steps = 0;
for (let run = 0; run < 400; run++) {
  let db = { users: [] as object[], games: [] as object[] };
  for (let k = 0; k < 30; k++) {
    const key = pick(['users', 'games'] as const), before = db[key], op = pick(Object.keys(ops) as (keyof typeof ops)[]);
    const after = op === 'add' ? [...before, row()] : op === 'del' ? before.filter(() => rnd() < 0.6)
      : op === 'replace' ? before.map((r) => (rnd() < 0.4 ? row() : r)) : op === 'clear' ? []
      : [...before.filter(() => rnd() < 0.5), ...Array.from({ length: Math.floor(rnd() * 4) }, row)];
    const next = { ...db, [key]: after };
    assert.strictEqual(rowsDelta(before, after), size(next) - size(db), `run ${run} step ${k}: ${op} ${before.length} -> ${after.length} rows`);
    db = next; ops[op]++; steps++;
  }
}
const same = [row()];
assert.strictEqual(rowsDelta(same, same), 0, 'the same array is an in-place edit: 0');
assert(Object.values(ops).every((n) => n > 1000), `every op must be exercised: ${JSON.stringify(ops)}`);
console.log(`rowsdelta.cloud.test.ts: rowsDelta exact over ${steps} steps ${JSON.stringify(ops)}`);

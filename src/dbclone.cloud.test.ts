/* jsonClone (server.ts) replaced JSON.parse(bodyStr) and structuredClone for the
 * GCS baseline (S14-1: those full copies OOM'd a 128 MB heap). It must equal
 * JSON.parse(JSON.stringify(v)) on every shape a db.json row can hold, share no
 * mutable object with its input, and every baseline site must use it. */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { seededRandom } from './testing/prng.ts';

const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const start = src.indexOf('function jsonClone(');
assert(start > 0, 'server.ts must define jsonClone');
const end = src.indexOf('\n}\n', start) + 2;
const js = ts.transpileModule(src.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const jsonClone = new Function(`${js}; return jsonClone;`)() as (v: unknown) => unknown;
let n = 0;
const same = (v: unknown, why: string) => { assert.deepStrictEqual(jsonClone(v), JSON.parse(JSON.stringify(v)), why); n++; };

// Every JSON edge a row can carry: undefined/function/symbol fields dropped, in arrays null,
// NaN/Infinity -> null, -0 -> 0, Date via toJSON, nested arrays, empty containers, unicode.
same({ a: undefined, b: () => 1, c: Symbol('x'), d: [undefined, () => 1, Symbol('y'), 1] }, 'undefined/function/symbol');
same({ x: NaN, y: Infinity, z: -Infinity, w: -0, v: 0 }, 'non-finite numbers and -0');
same({ at: new Date(Date.UTC(2026, 8, 25)), nested: { at: new Date(0) } }, 'Date through toJSON');
same({ e: [], o: {}, s: '', u: '界−­', deep: [[[{ k: [1, [2]] }]]] }, 'empty, unicode, deep');
same({ users: [{ id: 'u', mergedFrom: ['a', 'b'], tokenVersion: 3, recoveryCode: undefined }], games: [] }, 'a user row');
Object.is(jsonClone({ m: -0 }) && (jsonClone({ m: -0 }) as { m: number }).m, 0) || assert.fail('-0 must serialize as 0'); n++;

// Seeded fuzz over random JSON-ish trees, including the dropped kinds.
const rnd = seededRandom(20260925);
const leaf = (): unknown => [() => 0, undefined, null, NaN, -0, Infinity, true, false, 1.5, -7, 'x', '', '界', new Date(Math.floor(rnd() * 1e12))][Math.floor(rnd() * 14)];
const tree = (d: number): unknown => d <= 0 || rnd() < 0.3 ? leaf()
  : rnd() < 0.5 ? Array.from({ length: Math.floor(rnd() * 4) }, () => tree(d - 1))
  : Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => [`k${i}`, tree(d - 1)]));
let fuzzed = 0;
for (let i = 0; i < 5000; i++) { const v = { root: tree(5) }; assert.deepStrictEqual(jsonClone(v), JSON.parse(JSON.stringify(v)), `fuzz ${i}`); fuzzed++; }
assert(fuzzed === 5000); n++;

// A copy, not a view: mutating the clone leaves the source alone (routes mutate records in place).
const live = { users: [{ id: 'u', tokenVersion: 1, mergedFrom: ['a'] }], games: [{ id: 'g', payoffs: { a11: 1 } }] };
const base = jsonClone(live) as typeof live;
base.users[0].tokenVersion = 9; base.users[0].mergedFrom.push('z'); base.games[0].payoffs.a11 = 5;
assert.deepStrictEqual(live, { users: [{ id: 'u', tokenVersion: 1, mergedFrom: ['a'] }], games: [{ id: 'g', payoffs: { a11: 1 } }] }, 'clone shares a mutable object'); n++;

// Every baseline site uses it: no full-store JSON.parse(bodyStr) / structuredClone copy survives.
const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); // comments may name the old calls
assert(!/JSON\.parse\(bodyStr\)/.test(code), 'uploadDbToGcs must not re-parse its body (a full copy)'); n++;
assert(!/structuredClone\(remote\.db\)/.test(code), 'syncFromGcs baseline must use jsonClone'); n++;
assert(/gcsBaselineDb = sent;/.test(src) && /const sent = jsonClone\(loadDB\(\)\)/.test(src), 'the upload baseline is jsonClone of what was sent'); n++;
console.log(`dbclone.cloud.test.ts: ${n} checks passed (${fuzzed} fuzzed trees)`);

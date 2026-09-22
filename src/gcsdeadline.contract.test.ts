/**
 * Every @google-cloud/storage network call in server.ts must be deadlined.
 *
 * Storage's own `{ timeout }` option is sent as a QUERY PARAMETER, not a
 * client-side deadline (measured: one request still pending at 150s). An
 * unbounded await against a peer that accepts a socket and never answers
 * blocks `app.listen` at boot, hangs /api/version forever, or pins
 * `gcsUploadInFlight` so no save ever persists again.
 *
 * The integration suite proves the BEHAVIOUR at four call sites. This proves
 * the INVARIANT at all of them, including sites added later: the whole class,
 * not the instances that happen to have a fixture today. Uses the TypeScript
 * parser rather than a regex because three consecutive reviews defeated
 * source-text regex guards on this branch (comments, strings, regex literals).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'server.ts'), 'utf-8');
const sf = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

/** Storage methods that perform a network round-trip we could wait forever on. */
const NETWORK_METHODS = new Set(['exists', 'getMetadata', 'download', 'save']);

type Site = { method: string; line: number; deadlined: boolean; text: string };

const isDeadlined = (call: ts.Node): boolean => {
  // `await withDeadline(<call>, '...')` — the call must be an ARGUMENT of a
  // withDeadline(...) invocation, not merely somewhere near one.
  let n: ts.Node | undefined = call.parent;
  while (n && !ts.isBlock(n)) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'withDeadline') {
      return true;
    }
    n = n.parent;
  }
  return false;
};

// EVERY such call, not only the lexically-awaited ones. Requiring an
// enclosing `await` would let `for await (… of file.download())`, a detached
// `const p = file.exists()` awaited later, and `Promise.all([...])` split
// across statements slip past. Measured on the real server.ts before
// widening: 13 calls, 0 of them un-awaited, so the wider rule costs 0 false
// positives today and covers the shapes a future edit could use.
const collect = (node: ts.Node, sink: (n: ts.CallExpression) => void): void => {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && NETWORK_METHODS.has(node.expression.name.text)
    // `file`, `file.bucket.file('db.json', {...})`, `storage.bucket(..).file(..)`
    && /\bfile\b/.test(node.expression.expression.getText(node.getSourceFile()))) sink(node);
  node.forEachChild((c) => collect(c, sink));
};

const sites: Site[] = [];
collect(sf, (n) => {
  const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
  sites.push({
    method: (n.expression as ts.PropertyAccessExpression).name.text,
    line: line + 1,
    deadlined: isDeadlined(n),
    text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 80),
  });
});

// The scan must be LIVE. If the AST walk silently matched nothing, every
// "all sites deadlined" claim below would be vacuously true.
check('the AST scan actually found GCS network calls in server.ts',
  sites.length >= 13, `found only ${sites.length}`);

const bare = sites.filter((s) => !s.deadlined);
check('every GCS network call is wrapped in withDeadline',
  bare.length === 0,
  `unbounded await(s) — a silent GCS peer hangs boot / pins the save pump:\n    ${
    bare.map((s) => `server.ts:${s.line} ${s.text}`).join('\n    ')}`);

// Each distinct method must be represented, so a future refactor that drops a
// whole call shape cannot quietly shrink what this contract covers.
for (const m of NETWORK_METHODS) {
  check(`the scan covers file.${m}() calls`,
    sites.some((s) => s.method === m), `no ${m}() site found`);
}

// `createReadStream` is deliberately NOT deadlined: it is piped to the HTTP
// response, has its own 'error' handler, and a large DMG download is
// legitimately long. Pin that as an intentional exclusion, not an oversight.
check('createReadStream is excluded by design, and still present',
  /createReadStream\(/.test(source) && !NETWORK_METHODS.has('createReadStream'));

// ── SELF-TESTS: the rule must be able to FAIL, on inputs naming the shape ────
const analyse = (src: string): { total: number; bare: number } => {
  const f = ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: boolean[] = [];
  collect(f, (n) => found.push(isDeadlined(n)));
  return { total: found.length, bare: found.filter((d) => !d).length };
};

check('SELF-TEST: a bare awaited file.exists() is REPORTED',
  analyse('async function f(){ const [e] = await file.exists(); }').bare === 1);
check('SELF-TEST: a deadlined awaited file.exists() is accepted',
  analyse("async function f(){ const [e] = await withDeadline(file.exists(), 'x'); }").bare === 0);
check('SELF-TEST: the generation-bound download shape is seen',
  analyse("async function f(){ const [c] = await withDeadline(file.bucket.file('db.json', { generation: g }).download(), 'x'); }")
    .total === 1);
check('SELF-TEST: a call merely NEAR a withDeadline is not credited',
  analyse("async function f(){ await withDeadline(other(), 'x'); const [e] = await file.exists(); }").bare === 1);
check('SELF-TEST: a commented-out bare call does not create a false failure',
  analyse('async function f(){ // const [e] = await file.exists();\n const [e] = await withDeadline(file.exists(), "x"); }').bare === 0);
check('SELF-TEST: a bare call in a STRING does not create a false failure',
  analyse('async function f(){ const doc = "await file.exists()"; const [e] = await withDeadline(file.exists(), "x"); }').bare === 0);
// The shapes the await-scoped first draft MISSED. Each is a live way to
// reintroduce an unbounded GCS wait without writing `await file.x()`.
check('SELF-TEST: a DETACHED promise awaited later is REPORTED',
  analyse('async function f(){ const p = file.exists(); const [e] = await p; }').bare === 1);
check('SELF-TEST: `for await` over an un-deadlined call is REPORTED',
  analyse('async function f(){ for await (const c of file.download()) { use(c); } }').bare === 1);
check('SELF-TEST: Promise.all of bare calls reports BOTH',
  analyse('async function f(){ const [a, b] = await Promise.all([file.exists(), file.getMetadata()]); }').bare === 2);
check('SELF-TEST: a deadlined call inside Promise.all is accepted',
  analyse("async function f(){ const [a] = await Promise.all([withDeadline(file.exists(), 'x')]); }").bare === 0);

console.log(failures === 0
  ? `\n✓ GCS deadline contract: ${sites.length} GCS network calls, all deadlined`
  : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

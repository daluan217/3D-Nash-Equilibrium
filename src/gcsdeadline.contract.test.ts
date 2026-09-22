/**
 * Every awaited @google-cloud/storage call in server.ts must be deadlined.
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

const sites: Site[] = [];
const walk = (node: ts.Node): void => {
  if (ts.isAwaitExpression(node)) {
    // Find storage-method calls inside this await.
    const scan = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const recv = n.expression.expression.getText(sf);
        // `file`, `file.bucket.file('db.json', {...})`, `storage.bucket(..).file(..)`
        if (NETWORK_METHODS.has(method) && /\bfile\b/.test(recv)) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          sites.push({
            method, line: line + 1, deadlined: isDeadlined(n),
            text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 80),
          });
        }
      }
      n.forEachChild(scan);
    };
    scan(node.expression);
  }
  node.forEachChild(walk);
};
walk(sf);

// The scan must be LIVE. If the AST walk silently matched nothing, every
// "all sites deadlined" claim below would be vacuously true.
check('the AST scan actually found awaited GCS calls in server.ts',
  sites.length >= 13, `found only ${sites.length}`);

const bare = sites.filter((s) => !s.deadlined);
check('every awaited GCS call is wrapped in withDeadline',
  bare.length === 0,
  `unbounded await(s) — a silent GCS peer hangs boot / pins the save pump:\n    ${
    bare.map((s) => `server.ts:${s.line} ${s.text}`).join('\n    ')}`);

// Each distinct method must be represented, so a future refactor that drops a
// whole call shape cannot quietly shrink what this contract covers.
for (const m of NETWORK_METHODS) {
  check(`the scan covers awaited file.${m}() calls`,
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
  const w = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) {
      const scan = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
          && NETWORK_METHODS.has(n.expression.name.text)
          && /\bfile\b/.test(n.expression.expression.getText(f))) found.push(isDeadlined(n));
        n.forEachChild(scan);
      };
      scan(node.expression);
    }
    node.forEachChild(w);
  };
  w(f);
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

console.log(failures === 0
  ? `\n✓ GCS deadline contract: ${sites.length} awaited GCS calls, all deadlined`
  : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

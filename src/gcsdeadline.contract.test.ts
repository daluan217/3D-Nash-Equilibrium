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

/**
 * Storage methods that perform a network round-trip we could wait forever on.
 *
 * The four the product uses today, PLUS the rest of the blocking File/Bucket
 * surface. Listing only what is called today would mean the first `delete()`
 * or `setMetadata()` someone adds is unguarded on arrival — the guard has to
 * cover the surface, not the current instances. Verified these names are not
 * already in use on a non-GCS receiver in server.ts (the only `.delete(`
 * calls are Map.delete and app.delete, both allowlisted below).
 */
const NETWORK_METHODS = new Set([
  'exists', 'getMetadata', 'download', 'save',
  'delete', 'copy', 'move', 'setMetadata', 'getFiles', 'deleteFiles',
  'makePublic', 'makePrivate', 'createResumableUpload', 'getSignedUrl',
  'combine', 'rotateEncryptionKey', 'setStorageClass',
]);

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

/**
 * Receivers that own a same-named method and are NOT GCS. Kept as an explicit
 * allowlist because the rule below matches on the METHOD NAME ALONE.
 *
 * Matching the receiver's source text against /\bfile\b/ was the first
 * attempt and gate review #9 broke it in one line: `const f2 = file;
 * await f2.exists()` is a real unbounded GCS await that the contract did not
 * even count as a site. Any alias, helper parameter or rename defeats a
 * textual receiver test, so the receiver is no longer trusted to identify
 * GCS. Measured on the real server.ts before switching: 14 calls to these
 * four method names on ANY receiver, of which exactly one is not GCS.
 */
const NON_GCS_RECEIVERS = new Set([
  'res',          // express: res.download(path)
  'app',          // express: app.delete(route, ...)
  'rateBuckets',  // Map.delete
  'reportCache',  // Map.delete
]);

const collect = (node: ts.Node, sink: (n: ts.CallExpression) => void): void => {
  if (ts.isCallExpression(node)
    && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
    const src = node.getSourceFile();
    // `file.exists()` and `file['exists']()` alike. A COMPUTED name
    // (`file[m]()`) cannot be resolved statically, so it is treated as a
    // match: an un-deadlined dynamic dispatch onto a GCS file is exactly the
    // shape this guard exists to refuse, and there are none in server.ts
    // today, so this costs nothing and fails loudly if one appears.
    const named = ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : (ts.isStringLiteralLike(node.expression.argumentExpression)
        ? node.expression.argumentExpression.text
        : null);
    const receiver = node.expression.expression.getText(src);
    const dynamic = named === null && !NON_GCS_RECEIVERS.has(receiver);
    if ((named !== null && NETWORK_METHODS.has(named) && !NON_GCS_RECEIVERS.has(receiver)) || dynamic) sink(node);
  }
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

// The four methods the product actually calls today must each still be seen,
// so a refactor that drops a whole call shape cannot quietly shrink what this
// contract covers. The rest of NETWORK_METHODS is forward cover for calls not
// written yet, so it is deliberately NOT required to appear.
const IN_USE = ['exists', 'getMetadata', 'download', 'save'] as const;
for (const m of IN_USE) {
  check(`the scan covers file.${m}() calls`,
    sites.some((s) => s.method === m), `no ${m}() site found`);
}
check('the modelled surface is wider than what the product calls today',
  IN_USE.every((m) => NETWORK_METHODS.has(m)) && NETWORK_METHODS.size > IN_USE.length,
  `${NETWORK_METHODS.size} modelled vs ${IN_USE.length} in use — a newly added GCS call must be guarded on arrival`);

// `createReadStream` is deliberately NOT deadlined: it is piped to the HTTP
// response, has its own 'error' handler, and a large DMG download is
// legitimately long. Pin that as an intentional exclusion, not an oversight.
check('createReadStream is excluded by design, and still present',
  /createReadStream\(/.test(source) && !NETWORK_METHODS.has('createReadStream'));

// The allowlist is the one place this contract can be weakened without
// touching a single assertion: adding a receiver name silently un-guards
// every call on it. Keep it tiny and force a re-justification to grow it.
check('the non-GCS receiver allowlist stays minimal',
  NON_GCS_RECEIVERS.size <= 4,
  `${NON_GCS_RECEIVERS.size} exempt receivers — each one un-guards every GCS-named call on it: ${
    [...NON_GCS_RECEIVERS].join(', ')}`);

// A size cap alone can be satisfied by SWAPPING an entry for `file`. Pin the
// membership too: exempting anything that could be a GCS File must fail here,
// not silently drop call sites out of the scan.
check('the allowlist is exactly the four known non-GCS receivers',
  [...NON_GCS_RECEIVERS].sort().join(',') === 'app,rateBuckets,reportCache,res',
  `allowlist is now: ${[...NON_GCS_RECEIVERS].sort().join(',')}`);

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
// Gate review #9 finding #1, verbatim: each of these defeated the previous
// receiver-text rule while being a genuine unbounded GCS await.
check('SELF-TEST: an ALIASED receiver is REPORTED (review #9 finding 1)',
  analyse('async function f(){ const gcsFileAlias = file; const [m] = await gcsFileAlias.getMetadata(); }').bare === 1);
check('SELF-TEST: a short alias `f2` is REPORTED',
  analyse('async function f(){ const f2 = file; const [e] = await f2.exists(); }').bare === 1);
check('SELF-TEST: a call on a HELPER PARAMETER is REPORTED',
  analyse('function doExists(target){ return target.exists(); }').bare === 1);
check('SELF-TEST: a renamed intermediate (dmgFile) is REPORTED',
  analyse('async function f(){ const dmgFile = bucket.file(k); const [e] = await dmgFile.exists(); }').bare === 1);
check('SELF-TEST: an allowlisted non-GCS receiver (res.download) is NOT reported',
  analyse('function f(req, res){ res.download(p); }').total === 0);
// Third-round self-attack: shapes that evaded the method-name rule.
check('SELF-TEST: computed member file["exists"]() is REPORTED',
  analyse('async function f(){ const [e] = await file["exists"](); }').bare === 1);
check('SELF-TEST: dynamic dispatch file[m]() is REPORTED (cannot be resolved, so refused)',
  analyse('async function f(){ const m = "exists"; const [e] = await file[m](); }').bare === 1);
check('SELF-TEST: optional chaining file?.exists() is REPORTED',
  analyse('async function f(){ const [e] = await file?.exists(); }').bare === 1);
check('SELF-TEST: a not-yet-used blocking method (file.delete) is REPORTED',
  analyse('async function f(){ await file.delete(); }').bare === 1);
check('SELF-TEST: file.setMetadata() is REPORTED',
  analyse('async function f(){ await file.setMetadata(md); }').bare === 1);
check('SELF-TEST: allowlisted Map.delete is NOT reported',
  analyse('function f(){ rateBuckets.delete(k); reportCache.delete(k); }').total === 0);
check('SELF-TEST: allowlisted app.delete route registration is NOT reported',
  analyse('function f(){ app.delete("/api/games/:id", h); }').total === 0);

console.log(failures === 0
  ? `\n✓ GCS deadline contract: ${sites.length} GCS network calls, all deadlined`
  : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

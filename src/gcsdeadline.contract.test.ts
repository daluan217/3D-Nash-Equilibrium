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
import { execSync } from 'node:child_process';
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
  // Not GCS, same class: a mail server that accepts and goes quiet held four
  // routes open past the client's 22s (BLUE-LOOP-CLOUD-22). Matched by name
  // like the rest, so a new send is guarded on arrival.
  'sendMail',
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
/**
 * Function.prototype hops that hide the real method behind an indirection:
 * `file.exists.call(file)` presents `call` as the outer name. Gate review #11
 * used exactly this to smuggle a live unbounded GCS call past the contract.
 */
const FUNCTION_HOPS = new Set(['call', 'apply', 'bind']);

/**
 * Names that a GCS method is DESTRUCTURED onto. `const { exists } = file`
 * strips the receiver entirely, so there is no property access left to match;
 * the destructuring itself is what has to be refused.
 */
const destructuredGcsMethods = (file: ts.SourceFile): string[] => {
  const found: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        const source = (el.propertyName ?? el.name).getText(file);
        if (NETWORK_METHODS.has(source)) found.push(`${source} from ${n.initializer.getText(file).slice(0, 30)}`);
      }
    }
    n.forEachChild(walk);
  };
  walk(file);
  return found;
};

const NON_GCS_RECEIVERS = new Set([
  'res',          // express: res.download(path)
  'app',          // express: app.delete(route, ...)
  'rateBuckets',  // Map.delete
  'lastCodeMail', // Map.delete: the per-address mail cooldown prunes expired entries (BLUE-LOOP-CLOUD-22)
]);

/**
 * The called method's name, for `file.exists()` and `file['exists']()` alike,
 * or null when it is computed (`file[m]()`) and cannot be resolved statically.
 *
 * ONE resolver, used by both the matcher and the site builder. Gate review #10
 * found them duplicated and out of step: `collect` handled element access
 * while the site builder still cast to PropertyAccessExpression, so a real
 * `file['exists']()` crashed the walk with "Cannot read properties of
 * undefined" — CI red, but with no line naming the defect, and none of the
 * self-tests caught it because they never ran the site-building path.
 */
const methodName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    // `file.exists.call(file)` / `.apply` / `.bind` — the OUTER name is
    // `call`, so resolving only that hides the real method (gate review #11).
    // Step inward one level when the outer name is a Function.prototype hop.
    if (FUNCTION_HOPS.has(callee.name.text) && ts.isPropertyAccessExpression(callee.expression)) {
      return callee.expression.name.text;
    }
    return callee.name.text;
  }
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text;
  }
  return null;
};

const collect = (node: ts.Node, sink: (n: ts.CallExpression) => void): void => {
  if (ts.isCallExpression(node)
    && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
    const named = methodName(node);
    const receiver = node.expression.expression.getText(node.getSourceFile());
    const exempt = NON_GCS_RECEIVERS.has(receiver);
    // A computed name cannot be resolved, so it is REFUSED rather than
    // ignored: an un-deadlined dynamic dispatch onto a GCS file is exactly
    // the shape this guard exists to catch. There are none in server.ts
    // today, so this costs nothing and fails loudly if one appears.
    if (!exempt && (named === null || NETWORK_METHODS.has(named))) sink(node);
  }
  node.forEachChild((c) => collect(c, sink));
};

const buildSite = (n: ts.CallExpression, file: ts.SourceFile): Site => ({
  method: methodName(n) ?? `[computed] ${n.expression.getText(file)}`,
  line: file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1,
  deadlined: isDeadlined(n),
  text: n.getText(file).replace(/\s+/g, ' ').slice(0, 80),
});

const sites: Site[] = [];
collect(sf, (n) => sites.push(buildSite(n, sf)));

// The scan must be LIVE. If the AST walk silently matched nothing, every
// "all sites deadlined" claim below would be vacuously true.
// 7 GCS sites since BLUE-LOOP-CLOUD-22 folded three copies of the db.json read
// into readGcsDb and dropped its exists() (was 13), plus the 4 SMTP sends.
check('the AST scan actually found GCS network calls in server.ts',
  sites.length >= 11, `found only ${sites.length}`);

// This contract reads server.ts and nothing else, which is only sufficient
// while server.ts is the only product file that talks to GCS. Gate review #10
// flagged that as an unstated boundary, so it is now a CHECKED precondition:
// the day someone puts GCS I/O in another module, this fails and says so
// rather than silently covering less than it claims.
const gcsImporters = execSync(
  "grep -rl 'google-cloud/storage' --include='*.ts' --include='*.mts' --include='*.cts' "
  + "--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=dist-electron "
  + "--exclude-dir=.git --exclude-dir=_gen . || true",
  { cwd: root, encoding: 'utf-8' },
).split('\n').map((f) => f.replace(/^\.\//, '').trim())
  .filter((f) => f && !/\.test\.|contract\.test/.test(f));
check('server.ts is still the only product file importing the GCS SDK',
  gcsImporters.length === 1 && gcsImporters[0] === 'server.ts',
  `this contract only scans server.ts, but the SDK is imported by: ${gcsImporters.join(', ')}`);

const bare = sites.filter((s) => !s.deadlined);
check('every GCS network call is wrapped in withDeadline',
  bare.length === 0,
  `unbounded await(s) — a silent GCS peer hangs boot / pins the save pump:\n    ${
    bare.map((s) => `server.ts:${s.line} ${s.text}`).join('\n    ')}`);

// The four methods the product actually calls today must each still be seen,
// so a refactor that drops a whole call shape cannot quietly shrink what this
// contract covers. The rest of NETWORK_METHODS is forward cover for calls not
// written yet, so it is deliberately NOT required to appear.
const IN_USE = ['exists', 'getMetadata', 'download', 'save', 'sendMail'] as const;
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
  [...NON_GCS_RECEIVERS].sort().join(',') === 'app,lastCodeMail,rateBuckets,res',
  `allowlist is now: ${[...NON_GCS_RECEIVERS].sort().join(',')}`);

// SHADOWING is the attack the membership check cannot see: bind a GCS File to
// a name that is already exempt (`const res = bucket.file(k)`) and every call
// on it drops out of the scan while the allowlist still reads as expected.
// So verify what these names are actually BOUND to. `res` is only ever an
// express handler parameter (never declared), and the other three are pinned
// to their real initialisers.
const EXPECTED_BINDING: Record<string, RegExp | null> = {
  res: null,                       // express parameter only — must never be declared
  app: /^express\(\)/,
  rateBuckets: /^new Map\b/,
  lastCodeMail: /^new Map\b/,
};
const shadowed: string[] = [];
for (const [name, expected] of Object.entries(EXPECTED_BINDING)) {
  for (const m of source.matchAll(
    new RegExp(String.raw`(?:const|let|var)\s+${name}\s*=\s*([^;\n]{0,70})`, 'g'),
  )) {
    const init = m[1].trim();
    if (expected === null || !expected.test(init)) shadowed.push(`${name} = ${init.slice(0, 40)}`);
  }
}
check('no allowlisted receiver name is rebound to something else (shadowing)',
  shadowed.length === 0,
  `an exempt name bound to a GCS file would silently drop every call on it: ${shadowed.join('; ')}`);

// Gate review #11: `const { exists } = file; await exists()` has no receiver
// left to match, so the call is invisible. Refuse the destructuring itself.
const destructured = destructuredGcsMethods(sf);
check('no GCS network method is destructured off its receiver',
  destructured.length === 0,
  `a destructured method loses the receiver and escapes this scan: ${destructured.join('; ')}`);

// Gate review #11: `isDeadlined` matches the IDENTIFIER `withDeadline`, so a
// local `const withDeadline = (p) => p;` would mark every call in that scope
// deadlined while doing nothing. Require exactly one top-level definition and
// no shadowing binding anywhere.
const deadlineDefs = [...source.matchAll(/^(?:async\s+)?function\s+withDeadline\b/gm)].length;
const deadlineRebinds = [...source.matchAll(/(?:const|let|var)\s+withDeadline\s*=/g)].length;
check('withDeadline is a single top-level function, never shadowed',
  deadlineDefs === 1 && deadlineRebinds === 0,
  `${deadlineDefs} function definition(s), ${deadlineRebinds} rebinding(s) — a pass-through shadow makes every call "deadlined" while doing nothing`);

// ── SELF-TESTS: the rule must be able to FAIL, on inputs naming the shape ────
// Runs the SAME path as the real scan: collect + buildSite. Calling only
// collect() is what let gate review #10's crash hide — the self-tests passed
// while the real file threw inside the site builder.
const analyse = (src: string): { total: number; bare: number; methods: string[] } => {
  const f = ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Site[] = [];
  collect(f, (n) => found.push(buildSite(n, f)));
  return {
    total: found.length,
    bare: found.filter((s) => !s.deadlined).length,
    methods: found.map((s) => s.method),
  };
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
  analyse('function f(){ rateBuckets.delete(k); lastCodeMail.delete(k); }').total === 0);
check('SELF-TEST: allowlisted app.delete route registration is NOT reported',
  analyse('function f(){ app.delete("/api/games/:id", h); }').total === 0);
// Gate review #10: the site BUILDER, not just the matcher. These name the
// resolved method, which is what crashed on an element-access callee.
check('SELF-TEST: an element-access site reports its resolved method name',
  analyse('async function f(){ const [e] = await file["exists"](); }').methods.join() === 'exists');
check('SELF-TEST: a computed site is labelled rather than crashing the walk',
  analyse('async function f(){ const m = "x"; await file[m](); }').methods.join().startsWith('[computed]'));

// Every route that reads or writes the DB sits behind the GCS store gate: an
// ungated reader on hosted serves an unread (empty) or blocked store (sweep 1).
const gatedRoutes = (file: ts.SourceFile) => {
  let gate: { pos: number; prefixes: string[] } | null = null;
  const routes: { path: string; pos: number; db: boolean }[] = [];
  // DB readers are loadDB/saveDB and, to a fixpoint, every top-level function that calls one (getAuthUser).
  const readers = new Set(['loadDB', 'saveDB']);
  const touchesDb = (n: ts.Node): boolean => (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
    && readers.has(n.expression.text)) || (ts.forEachChild(n, touchesDb) ?? false);
  const fns = file.statements.filter(ts.isFunctionDeclaration).filter((f) => f.name && f.body);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of fns) if (!readers.has(f.name!.text) && touchesDb(f.body!)) { readers.add(f.name!.text); grew = true; }
  }
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
      && n.expression.expression.text === 'app') {
      const verb = n.expression.name.text, [first, ...rest] = n.arguments;
      if (verb === 'use' && rest.some((a) => ts.isIdentifier(a) && a.text === 'requireGcsStore') && first && ts.isArrayLiteralExpression(first)) {
        gate = { pos: n.getStart(), prefixes: first.elements.filter(ts.isStringLiteral).map((e) => e.text) };
      } else if (['get', 'post', 'put', 'patch', 'delete'].includes(verb) && first && ts.isStringLiteral(first)) {
        routes.push({ path: first.text, pos: n.getStart(), db: rest.some(touchesDb) });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(file);
  const g = gate as { pos: number; prefixes: string[] } | null;
  const ungated = routes.filter((r) => r.db && !(g && r.pos > g.pos && g.prefixes.some((p) => r.path === p || r.path.startsWith(`${p}/`))));
  return { dbRoutes: routes.filter((r) => r.db).length, ungated: ungated.map((r) => r.path) };
};
const gated = gatedRoutes(sf);
check('the route scan found the DB routes (auth, games, admin)', gated.dbRoutes >= 15, `found ${gated.dbRoutes}`);
check('every route that reads or writes the DB is registered behind requireGcsStore',
  gated.ungated.length === 0, gated.ungated.join(', '));
const gateOf = (src: string) => gatedRoutes(ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)).ungated.join();
const GATE = 'app.use(["/api/games"], requireGcsStore);';
check('SELF-TEST: a DB route outside the gated prefixes is REPORTED',
  gateOf(`${GATE} app.get("/api/report", (q, r) => { const db = loadDB(); });`) === '/api/report');
check('SELF-TEST: a DB route registered BEFORE the gate is REPORTED',
  gateOf(`app.get("/api/games", (q, r) => saveDB(x)); ${GATE}`) === '/api/games');
check('SELF-TEST: a gated DB route and an ungated non-DB route are accepted',
  gateOf(`${GATE} app.get("/api/games/:id", async (q, r) => { await f(); loadDB(); }); app.get("/api/health", (q, r) => r.json(1));`) === '');
check('SELF-TEST: a route reaching the DB through a helper (getAuthUser) is REPORTED',
  gateOf(`function who() { return loadDB().users; } function getAuthUser() { return who()[0]; } ${GATE} app.get("/api/me", (q, r) => getAuthUser(q));`) === '/api/me');
check('SELF-TEST: a prefix match needs a path boundary ("/api/gamesX" is not "/api/games")',
  gateOf(`${GATE} app.get("/api/gamesX", (q, r) => loadDB());`) === '/api/gamesX');

// Every model call carries an AbortSignal: generateReport/generateScenario
// have no deadline of their own, and a provider that accepts and never answers
// held a flags-off /api/report past the client's give-up (sweep 1, 60s+).
const unsignalled = (file: ts.SourceFile): string[] => {
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['generateReport', 'generateScenario'].includes(n.expression.text)) {
      const opts = n.arguments[1];
      const has = !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(file) === 'signal');
      if (!has) out.push(`${n.expression.text}@${file.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
    }
    ts.forEachChild(n, walk);
  };
  walk(file);
  return out;
};
const modelCalls = [...source.matchAll(/\b(?:generateReport|generateScenario)\(/g)].length;
check('the model-call scan found the report and scenario calls', modelCalls >= 4, `found ${modelCalls}`);
check('every generateReport/generateScenario call passes a signal', unsignalled(sf).length === 0, unsignalled(sf).join(', '));
const sig = (src: string) => unsignalled(ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)).length;
check('SELF-TEST: a call without a signal is REPORTED', sig('async function f(){ await generateReport(p, { model: m }); }') === 1);
check('SELF-TEST: a call with no options object is REPORTED', sig('async function f(){ await generateScenario(p); }') === 1);
check('SELF-TEST: `signal: x` and shorthand `signal` are accepted',
  sig('async function f(){ await generateReport(p, { signal: s }); await generateScenario(p, { model, signal }); }') === 0);

// The mail cooldown's Map is exempt above because it PRUNES: run the real
// source (sliced out of server.ts) over 5,000 distinct addresses with a
// clock that moves past the cooldown, and the map must stay under its cap.
{
  const start = source.indexOf('const lastCodeMail = new Map');
  const end = source.indexOf('\nconst releaseCodeMail', start);
  const MS = /const MAIL_COOLDOWN_MS = ([\d_]+);/.exec(source)?.[1]?.replace(/_/g, '');
  let size = -1, maxSize = 0, stillCools = false, skew = '', steps = 0, fillSteps = 0;
  if (start > 0 && end > start && MS) {
    const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    let now = 0, wall = 0;
    // Counts entries visited by every scan of the map: the prune's work per call (sweep 20).
    class CountingMap<K, V> extends Map<K, V> { *[Symbol.iterator]() { for (const e of super.entries()) { steps++; yield e; } } }
    const run = new Function('performance', 'Date', 'MAIL_COOLDOWN_MS', 'Map', `${js}; return { left: mailCooldownLeft, map: lastCodeMail };`);
    const { left, map } = run({ now: () => now }, { now: () => wall }, Number(MS), CountingMap);
    for (let i = 0; i < 5000; i++) { now += 50; left('verification', `a${i}@example.test`); maxSize = Math.max(maxSize, map.size); }
    fillSteps = steps;
    size = map.size;
    stillCools = left('verification', 'a4999@example.test') > 0; // a fresh entry survives pruning
    // Clock skew (sweep 17): the cooldown runs on the monotonic clock, so a wall clock stepped
    // back 10 min neither extends it past MAIL_COOLDOWN_MS nor, stepped forward, ends it early.
    const got: number[] = [];
    for (const step of [-600_000, 600_000]) {
      const addr = `skew${step}@example.test`;
      wall = now; left('verification', addr);
      wall = now + step; now += 1000;
      got.push(left('verification', addr));
      now += Number(MS); got.push(left('verification', addr));
    }
    skew = got.join();
  }
  check('a wall-clock step (-10 min, +10 min) neither extends nor ends the mail cooldown',
    skew === `${Number(MS) - 1000},0,${Number(MS) - 1000},0`, `left after 1 s, after the cooldown: ${skew}`);
  check('the mail-cooldown map stays bounded over 5,000 distinct addresses (expired entries pruned)',
    size > 0 && maxSize <= Number(MS) / 50 + 1 && stillCools,
    `size ${size}, max ${maxSize}, fresh entry still cooling ${stillCools}`);
  check('the mail-cooldown prune visits O(1) entries per call (expired ones leave from the front), not the whole map',
    fillSteps > 0 && fillSteps <= 2 * 5000, `${fillSteps} entries visited over 5,000 calls with ~${Number(MS) / 50} live`);
}

// In-process intervals run on the monotonic clock (sweep 17): a wall-clock step backward
// locked a client out past its window, and one forward cut the SIGTERM drain short. The
// drain runs from source with a wall clock that jumps an hour ahead after its first read.
{
  const start = source.indexOf('async function drainGcsSaves(');
  const end = source.indexOf('\n}\n', start) + 2;
  let returnedAt = -1, landedAt = -1, gameLandedAt = -1, gameReturnedAt = -1, rowsLandedAt = -1, rowsReturnedAt = -1;
  if (start > 0 && end > start) {
    const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const t0 = Date.now();
    let reads = 0;
    const hostile = { now: () => t0 + (reads++ ? 3_600_000 : 0) };
    // `accountGames`: the hosted per-account game store; null = no saved-game write in flight.
    // `state.inFlight`: a db.json upload is out when the drain starts; `state.request` lets a route ask for one.
    const drainWith = (accountGames: unknown, landed: () => void, inFlight = true, state: { request?: () => void } = {}) => new Function('Date', 'performance', 'setTimeout', 'state', 'accountGames', `
      let gcsStoreBlocked = null, gcsUploadInFlight = false, gcsSaveRequested = false, wakeGcsPump = null, gcsPumpDone = Promise.resolve();
      const upload = () => { gcsUploadInFlight = true; gcsSaveRequested = false; return new Promise((r) => setTimeout(() => { gcsUploadInFlight = false; state.landed(); r(); }, 300)); };
      function scheduleGcsSave() { if (!gcsUploadInFlight) gcsPumpDone = upload(); else gcsSaveRequested = true; }
      state.request = () => { gcsSaveRequested = true; };
      if (state.inFlight) gcsPumpDone = upload();
      ${js}; return drainGcsSaves;`)(hostile, performance, setTimeout, Object.assign(state, { landed, inFlight }), accountGames);
    // A fake store whose one write lands after `ms` (then `after` runs, as the route the write unblocks would).
    const gamesFor = (ms: number, after: () => void) => {
      let busy = true;
      const done = new Promise((r) => setTimeout(() => { busy = false; after(); r(undefined); }, ms));
      return { busy: () => busy, idle: () => done };
    };
    await drainWith(null, () => { landedAt = performance.now(); })(8_000);
    returnedAt = performance.now();
    // A saved-game write still in flight (answered only once it lands) outlasts the db.json pump.
    await drainWith(gamesFor(900, () => { gameLandedAt = performance.now(); }), () => {})(8_000);
    gameReturnedAt = performance.now();
    // Sweep 28: the pump idle, a tombstone out; once it lands its route removes the rows (a db.json
    // write). The drain must not exit with that write unlanded (its 200 already said "deleted").
    const st: { request?: () => void } = {};
    await drainWith(gamesFor(500, () => st.request!()), () => { rowsLandedAt = performance.now(); }, false, st)(8_000);
    rowsReturnedAt = performance.now();
  }
  check('SIGTERM drain waits for the in-flight upload through a wall-clock jump', landedAt > 0 && returnedAt >= landedAt,
    `landed ${landedAt.toFixed(0)}, returned ${returnedAt.toFixed(0)}`);
  check('SIGTERM drain also waits for an in-flight saved-game write, not only the db.json pump', gameLandedAt > 0 && gameReturnedAt >= gameLandedAt,
    `game write landed ${gameLandedAt.toFixed(0)}, returned ${gameReturnedAt.toFixed(0)}`);
  check('SIGTERM drain lands the db.json write a route makes once its saved-game write lands (Sweep 28)', rowsLandedAt > 0 && rowsReturnedAt >= rowsLandedAt,
    `rows landed ${rowsLandedAt.toFixed(0)}, returned ${rowsReturnedAt.toFixed(0)}`);
  const body = (name: string) => { const i = source.indexOf(`function ${name}(`); return i < 0 ? '' : source.slice(i, source.indexOf('\n}\n', i)); };
  const onWall = ['rateLimit', 'pruneRateBuckets', 'mailCooldownLeft', 'requireGcsStore', 'syncFromGcs', 'drainGcsSaves']
    .filter((f) => !body(f) || /Date\.now\(/.test(body(f)));
  const wallLines = source.split('\n').filter((l) => /Date\.now\(/.test(l) && /gcsFreshUntil|resetAt|lastCodeMail|\buntil\b/.test(l));
  check('interval state (freshness, drain, cooldown, rate windows) never reads the wall clock',
    onWall.length === 0 && wallLines.length === 0, JSON.stringify({ onWall, wallLines }));
}

console.log(failures === 0
  ? `\n✓ GCS deadline contract: ${sites.length} GCS network calls, all deadlined`
  : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

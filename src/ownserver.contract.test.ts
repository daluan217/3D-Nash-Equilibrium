/**
 * Every READINESS loop in a suite that spawns the server must prove it reached
 * the child it spawned (S73-006). A leaked or foreign server on the port
 * answers `ok`; IS_ELECTRON also walks to port+1 on EADDRINUSE. Measured:
 * db-shape-refusal passed a boot-refusing server.ts mutant GREEN behind one.
 *
 * Per LOOP, not per file: the old rule asked whether a file compared a pid
 * anywhere, and 8 unbound loops hid behind one bound loop in the same file.
 * A readiness loop = an iteration that probes /api/health (or the root) AND
 * retries (a delay inside it). A loop that requests a route once per item and
 * records each result (CORS route tables, fixture tables that wait for EXIT)
 * gates nothing, so it is not one. Falsifier: such a loop gaining a delay.
 *
 *   npx tsx src/ownserver.contract.test.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};

const PROBE = /\/api\/health|fetch\(\s*`\$\{[\w.]+\}\/`|fetch\(\s*[\w.]+\s*\+\s*['"]\/(?:api\/health)?['"]/;
const RETRIES = /setTimeout|\bsleep\(|waitForTimeout\(/;
// The recognised bound forms: the shared helper; a direct or destructured pid
// comparison against the spawned child; an assert on the same.
const BOUND = /\bpid\s*===\s*[\w.]+\.pid\b|assert\.(?:strict)?[Ee]qual\(\s*[\w.]+\.pid\s*,\s*[\w.]+\.pid/;
// Any spelling of the path: `join(ROOT, 'dist', 'server.cjs')` evaded a
// `dist/server.cjs` match and hid desktop-adopt-deadsession's loop.
const SPAWNS = /['"`/]server\.(?:cjs|ts)['"`]|\bBUNDLE\b/;
const REUSE_PROBE = /fetch\(\s*`\$\{BASE\}\/(?:api\/health)?`\s*\)/;

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const printer = ts.createPrinter({ removeComments: true });
export interface Loop { line: number; bound: boolean; }
/** Readiness loops in one source, each with whether it binds a pid. */
export const readinessLoops = (source: string): Loop[] => {
  const sf = ts.createSourceFile('x.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: Loop[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIterationStatement(n, false)) {
      // The printer drops EVERY comment, trailing ones included; a line regex
      // missed `{ // pid === child.pid` and let a comment bind the loop.
      const t = printer.printNode(ts.EmitHint.Unspecified, n, sf);
      if (PROBE.test(t) && RETRIES.test(t)) {
        out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, bound: BOUND.test(t) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};

/** A suite that runs against an already-listening server must gate that on REUSE_SERVER=1. */
export const unguardedReuse = (source: string): boolean => {
  const code = stripComments(source);
  return /already listening|reus/i.test(source) && REUSE_PROBE.test(code) && !/reuseServerAllowed\(\)/.test(code);
};

const dirs = ['src/integration', 'src/e2e'];
const suites = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.mjs')).map((f) => `${d}/${f}`))
  .map((f) => [f, readFileSync(f, 'utf8')] as const)
  .filter(([, s]) => SPAWNS.test(stripComments(s)));

const loops = suites.flatMap(([f, s]) => readinessLoops(s).map((l) => ({ f, ...l })));
const unbound = loops.filter((l) => !l.bound).map((l) => `${l.f}:${l.line}`);
check('every readiness loop in a server-spawning suite binds the answer to the child it spawned',
  unbound.length === 0,
  `use waitForOwnServer() from src/integration/ownserver.mjs — these accept ANY listener: ${unbound.join(', ')}`);

// Only the helper may poll without an inline pid form; it is itself checked
// behaviourally below, so a no-op helper cannot satisfy this file.
const helperCalls = suites.filter(([, s]) => /waitForOwnServer\(/.test(stripComments(s))).map(([f]) => f);
const reuse = suites.filter(([, s]) => unguardedReuse(s)).map(([f]) => f);
check('a suite reuses an already-listening server only under REUSE_SERVER=1',
  reuse.length === 0, `these measure whatever holds the port: ${reuse.join(', ')}`);

check('SELF-TEST: a path built with join() is still recognised as spawning the server',
  SPAWNS.test("spawn(process.execPath, [join(ROOT, 'dist', 'server.cjs')])"));
check('SELF-TEST: the census is scanning real suites', suites.length >= 30 && loops.length >= 21,
  `${suites.length} spawning suites, ${loops.length} readiness loops`);
check('SELF-TEST: the helper is actually in use', helperCalls.length >= 13, `${helperCalls.length} files`);

// ── SELF-TESTS on known shapes, including every false positive measured ──
const loop = (body: string) => readinessLoops(body);
check('SELF-TEST: an unbound `if (r.ok)` retry loop is found and rejected',
  loop('for (let i = 0; i < 9; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 9)); }')
    .some((l) => !l.bound));
check('SELF-TEST: the one-line `up = (...).ok` shape (smoke.mjs desk loops) is found and rejected',
  loop("for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(deskBase + '/api/health')).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 500)); }")
    .some((l) => !l.bound));
check('SELF-TEST: a root-path poll counts as a readiness loop',
  loop('while (true) { const r = await fetch(`${BASE}/`); if (r.ok) break; await sleep(9); }').length === 1);
check('SELF-TEST: the direct pid form is accepted',
  loop('for (;;) { const r = await fetch(`${B}/api/health`); if (r.ok && (await r.json())?.pid === child.pid) return; await sleep(1); }')
    .every((l) => l.bound));
check('SELF-TEST: the destructured pid form is accepted',
  loop('for (;;) { const r = await fetch(`${B}/api/health`); const { pid } = await r.json(); if (pid === child.pid) return; await sleep(1); }')
    .every((l) => l.bound));
check('SELF-TEST: the assert pid form is accepted',
  loop('for (;;) { const h = await fetch(`${b}/api/health`).then((r) => r.json()); assert.equal(h.pid, child.pid); await sleep(1); }')
    .every((l) => l.bound));
check('SELF-TEST: a pid comparison in a COMMENT does not bind the loop',
  loop('for (;;) { // pid === child.pid\n const r = await fetch(`${B}/api/health`); if (r.ok) return; await sleep(1); }')
    .some((l) => !l.bound));
check('SELF-TEST: a route table (one request per route, no retry) is not a readiness loop',
  loop("for (const route of ['/api/games', '/api/health']) { const res = await fetch(`${base}${route}`); record(route, res.ok); }").length === 0);
check('SELF-TEST: a reuse probe without REUSE_SERVER is reported',
  unguardedReuse('// unless one is already listening\nif (!(await fetch(`${BASE}/`).then((r) => r.ok))) { spawn(); }'));
check('SELF-TEST: the same reuse behind reuseServerAllowed() is accepted',
  !unguardedReuse('// reuse only under REUSE_SERVER=1\nif (!(reuseServerAllowed() && await fetch(`${BASE}/`).then((r) => r.ok))) { spawn(); }'));

if (failures > 0) { console.error(`✗ own-server readiness: ${failures} failed`); process.exit(1); }
console.log(`✓ own-server readiness: ${loops.length} readiness loops in ${suites.length} server-spawning suites, all pid-bound; no unguarded reuse`);

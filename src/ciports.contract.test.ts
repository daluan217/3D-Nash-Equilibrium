/**
 * No two steps of one CI job may use the same TCP port.
 *
 *   npx tsx src/ciports.contract.test.ts
 *
 * BLUE-LOOP-DESKTOP-22, sweep 55. Gate review #8's finding 6 was one instance:
 * desktop-adopt-deadsession used 3119, which UNWRITABLE_SAVE_PORT already held
 * in an earlier step of the same job. Sweeping the family found four more.
 *
 * WHY IT BITES, on both runners — measured, not reasoned:
 *  - macOS (blue_desktop_22_notes/portdup-repro.cjs): a leaked IS_ELECTRON
 *    child holds 127.0.0.1:P; the next step's server binds 0.0.0.0:P, which
 *    SUCCEEDS with no EADDRINUSE, and the kernel then routes every loopback
 *    connection to the more specific bind. The later suite drives the earlier
 *    step's server, against a different data directory.
 *  - ubuntu, where this job actually runs (portdup-linux-shape.cjs): the
 *    second bind returns EADDRINUSE, so the step's own server EXITS 1 — and
 *    its readiness poll still finds the leaked child and reports ready. Same
 *    outcome: "suite's waitReady() said ready=true; 127.0.0.1:P answers
 *    pid=<the leaked child>", green against a server it did not spawn.
 * Neither shape logs anything a reader would notice, which is what makes a
 * duplicate worth a build break rather than a comment.
 *
 * A port is claimed where the suite that reads the env var computes it: the
 * base, every `<id> + N` (a concurrent second server) and every cumulative
 * `<id> += N` (a sequential walk). The walk forms are not optional: the
 * 3150/3160/3161/3162 collisions exist ONLY through them, so a base-only
 * check would have reported this job clean.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load: loadYaml } = require('js-yaml') as { load: (source: string) => unknown };
type AnyRecord = Record<string, unknown>;

const recordOf = (value: unknown): AnyRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};

const WORKFLOW = '.github/workflows/test.yml';
const workflowSource = readFileSync(WORKFLOW, 'utf8');
const suiteDir = 'src/integration';
const suiteSource = new Map(
  readdirSync(suiteDir).filter((f) => f.endsWith('.test.mjs'))
    .map((f) => [f, readFileSync(`${suiteDir}/${f}`, 'utf8')] as const));

/** Comments mention ports constantly ("3209, not 3202: ..."), so strip them. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

export interface PortClaim { job: string; step: string; name: string; ports: number[]; }

/** Every `*PORT*: <number>` env value in the workflow, with the job/step that owns it. */
const portEnvEntries = (workflow: string): { job: string; step: string; name: string; base: number }[] => {
  const document = recordOf(loadYaml(workflow));
  const out: { job: string; step: string; name: string; base: number }[] = [];
  for (const [job, rawJob] of Object.entries(recordOf(document.jobs))) {
    const steps = Array.isArray(recordOf(rawJob).steps) ? (recordOf(rawJob).steps as unknown[]) : [];
    for (const rawStep of steps.map(recordOf)) {
      const step = typeof rawStep.name === 'string' ? rawStep.name : String(rawStep.run ?? '(unnamed)');
      for (const [name, value] of Object.entries(recordOf(rawStep.env))) {
        if (!/PORT/.test(name)) continue;
        const base = Number(String(value).trim());
        if (Number.isInteger(base) && base > 0) out.push({ job, step, name, base });
      }
    }
  }
  return out;
};

/**
 * Ports the suites reading `name` actually bind. `sources` is injected so the
 * self-tests below can exercise the derivation on known inputs rather than
 * only on today's tree — a rule measured only against a clean tree cannot be
 * shown to fire.
 */
export const claimedPorts = (name: string, base: number, sources: readonly string[]): number[] => {
  const ports = new Set([base]);
  for (const raw of sources) {
    if (!raw.includes(name)) continue;
    const code = stripComments(raw);
    const binding = code.match(new RegExp(`(?:const|let)\\s+(\\w+)\\s*=[^\\n]*\\b${name}\\b`));
    if (!binding) continue;
    const id = binding[1];
    for (const m of code.matchAll(new RegExp(`\\b${id}\\s*\\+\\s*(\\d+)\\b`, 'g'))) {
      ports.add(base + Number(m[1]));
    }
    let walked = 0;
    for (const m of code.matchAll(new RegExp(`\\b${id}\\s*\\+=\\s*(\\d+)`, 'g'))) {
      walked += Number(m[1]);
      ports.add(base + walked);
    }
  }
  return [...ports].sort((a, b) => a - b);
};

/** Ports used twice within one job. Across jobs is fine — separate runners. */
export const duplicatesWithinJobs = (claims: PortClaim[]): string[] => {
  const seen = new Map<string, PortClaim[]>();
  for (const claim of claims) {
    for (const port of claim.ports) {
      const key = `${claim.job}:${port}`;
      if (!seen.has(key)) seen.set(key, []);
      if (!seen.get(key)!.some((c) => c.name === claim.name)) seen.get(key)!.push(claim);
    }
  }
  return [...seen].filter(([, cs]) => cs.length > 1)
    .map(([key, cs]) => `${key} claimed by ${cs.map((c) => `${c.name} (${c.step})`).join(' + ')}`)
    .sort();
};

// An ARRAY, not the Map's iterator: an iterator is consumed by the first
// lookup, so every later var would see zero sources and resolve to its base
// alone — which silently turns this into the base-only check it exists to
// replace. Caught by the "derivation is live" check below, which read 0.
const claimsFrom = (workflow: string, sources: readonly string[]): PortClaim[] =>
  portEnvEntries(workflow).map(({ job, step, name, base }) =>
    ({ job, step, name, ports: claimedPorts(name, base, sources) }));

const allSuiteSources = [...suiteSource.values()];
const claims = claimsFrom(workflowSource, allSuiteSources);
const duplicates = duplicatesWithinJobs(claims);
check('no two steps of one CI job claim the same port',
  duplicates.length === 0,
  `a leaked child from the earlier step then serves the later step's whole suite:\n    ${duplicates.join('\n    ')}`);

// The clean result above must come from real data, not an empty scan.
check('the workflow scan found the port env vars it claims to cover',
  claims.length >= 38, `found only ${claims.length}`);
check('the walk/offset derivation is live, not inert',
  claims.filter((c) => c.ports.length > 1).length >= 6,
  `only ${claims.filter((c) => c.ports.length > 1).length} vars resolved to more than their base port`);

// ── SELF-TESTS: each rule must be able to fail, on inputs that name the shape ─
const SUITE = (body: string) => [body];
check('SELF-TEST: a base-only var claims exactly its base',
  JSON.stringify(claimedPorts('X_PORT', 3000, SUITE('const p = process.env.X_PORT;'))) === '[3000]');
check('SELF-TEST: `id + N` is claimed (the concurrent-second-server shape)',
  JSON.stringify(claimedPorts('X_PORT', 3000,
    SUITE('const p = Number(process.env.X_PORT);\nconst b = p + 10;\nconst c = p + 12;'))) === '[3000,3010,3012]');
check('SELF-TEST: `id += N` accumulates (the sequential-walk shape)',
  JSON.stringify(claimedPorts('X_PORT', 3000,
    SUITE('let p = Number(process.env.X_PORT);\np += 1;\np += 1;'))) === '[3000,3001,3002]');
check('SELF-TEST: a port named only in a comment is NOT claimed',
  JSON.stringify(claimedPorts('X_PORT', 3000,
    SUITE('// p + 40 was the old layout\nconst p = Number(process.env.X_PORT);'))) === '[3000]');
check('SELF-TEST: a different suite’s arithmetic is not attributed here',
  JSON.stringify(claimedPorts('X_PORT', 3000,
    SUITE('const other = Number(process.env.Y_PORT);\nconst q = other + 9;'))) === '[3000]');
check('SELF-TEST: a duplicate inside one job is REPORTED',
  duplicatesWithinJobs([
    { job: 'integration', step: 'first', name: 'A_PORT', ports: [3150] },
    { job: 'integration', step: 'second', name: 'B_PORT', ports: [3150] },
  ]).length === 1);
check('SELF-TEST: the same port in a DIFFERENT job is allowed (separate runners)',
  duplicatesWithinJobs([
    { job: 'integration', step: 'first', name: 'A_PORT', ports: [3150] },
    { job: 'mobile', step: 'other', name: 'B_PORT', ports: [3150] },
  ]).length === 0);
check('SELF-TEST: one var listed twice in a job is not a self-collision',
  duplicatesWithinJobs([
    { job: 'integration', step: 'first', name: 'A_PORT', ports: [3150, 3151] },
    { job: 'integration', step: 'first', name: 'A_PORT', ports: [3150, 3151] },
  ]).length === 0);
// The real historical instance, end to end: gate review #8 finding 6 was
// desktop-adopt-deadsession on 3119 while UNWRITABLE_SAVE_PORT held it.
check('SELF-TEST: the finding-6 collision would be caught by this rule',
  duplicatesWithinJobs(claimsFrom(
    workflowSource.replace(/DESKTOP_ADOPT_DEAD_PORT: '\d+'/, "DESKTOP_ADOPT_DEAD_PORT: '3119'"),
    allSuiteSources,
  )).some((d) => d.includes('DESKTOP_ADOPT_DEAD_PORT') && d.includes('UNWRITABLE_SAVE_PORT')),
  'putting the pre-fix port back must reproduce the collision, or this guard did not close that finding');
// ...and a walk-only collision, which a base-only check cannot see.
check('SELF-TEST: a collision reachable ONLY through a walk is caught',
  duplicatesWithinJobs(claimsFrom(
    workflowSource.replace(/DESKTOP_ADOPT_DEAD_PORT: '\d+'/, "DESKTOP_ADOPT_DEAD_PORT: '3302'"),
    allSuiteSources,
  )).some((d) => d.includes('DESKTOP_ADOPT_DEAD_PORT') && d.includes('DESKTOP_PERSIST_PORT')),
  '3302 is DESKTOP_PERSIST_PORT (3300) after two walks — base-only comparison would call it free');

if (failures > 0) { console.error(`✗ CI port contract: ${failures} failed`); process.exit(1); }
console.log(`✓ CI port contract: ${claims.length} port env vars across `
  + `${new Set(claims.map((c) => c.job)).size} jobs, no intra-job collisions`);

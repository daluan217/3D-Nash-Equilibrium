/**
 * CORS contract test: every HTTP verb the client code sends must be listed in
 * the server's general Access-Control-Allow-Methods header.
 *
 * Why this exists: the website calls the API same-origin and never triggers a
 * CORS preflight, so a missing verb is invisible there — but the Electron app
 * calls the hosted backend cross-origin from http://127.0.0.1:<port>, where the
 * browser preflights every non-simple request and hard-fails it if the method
 * is absent from the header. That is exactly how PATCH /api/games/:id (added
 * with the scenario-keep feature) shipped broken for the desktop app while the
 * site worked: the header predated the endpoint. This test makes the contract
 * decidable so the next new verb cannot repeat it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// GET/HEAD/POST are CORS-safelisted: the spec allows them even when absent
// from Access-Control-Allow-Methods, so only the rest are load-bearing.
const SAFELISTED = new Set(['GET', 'HEAD', 'POST']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// Verbs the client sends (fetch with an explicit method:)
const clientVerbs = new Set<string>();
for (const file of walk('src')) {
  for (const m of readFileSync(file, 'utf8').matchAll(/method:\s*['"]([A-Z]+)['"]/g)) {
    clientVerbs.add(m[1]);
  }
}

// The server's general (non-admin) allow-list is the longest one declared.
const serverSrc = readFileSync('server.ts', 'utf8');
const headerValues = [...serverSrc.matchAll(/Access-Control-Allow-Methods",\s*"([^"]+)"/g)].map((m) => m[1]);
if (headerValues.length === 0) {
  console.error('✗ cors contract: no Access-Control-Allow-Methods header found in server.ts');
  process.exit(1);
}
const allowed = new Set(
  headerValues.sort((a, b) => b.length - a.length)[0].split(',').map((s) => s.trim()),
);

const missing = [...clientVerbs].filter((v) => !SAFELISTED.has(v) && !allowed.has(v));
if (missing.length > 0) {
  console.error(
    `✗ cors contract: client code sends ${missing.join(', ')} but server.ts `
    + `Access-Control-Allow-Methods only lists: ${[...allowed].join(', ')}. `
    + 'Cross-origin (Electron app) preflights for these verbs will fail even though the website works.',
  );
  process.exit(1);
}
console.log(
  `✓ cors contract: client verbs [${[...clientVerbs].sort().join(', ')}] all covered `
  + `(non-safelisted checked against: ${[...allowed].join(', ')})`,
);

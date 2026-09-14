/**
 * The backend bundle must ship without a sourcemap. RED-CLOUD-21/001: esbuild's
 * `--sourcemap` wrote dist/server.cjs.map with sourcesContent (every backend
 * source file, comments included), the Dockerfile copies all of dist/, and
 * express.static served it at https://…/server.cjs.map. Frontend maps are off
 * by Vite's default; this pins both so a build flag cannot re-open the hole.
 *   npx tsx src/sourcemap.contract.test.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};

/** True when a build script would emit a backend sourcemap. */
export const buildEmitsBackendSourcemap = (build: string): boolean =>
  /esbuild\b[^&|]*--sourcemap/.test(build);

/** True when a Vite config turns sourcemaps on (default is off). */
export const viteEmitsSourcemap = (config: string): boolean =>
  /sourcemap\s*:\s*(true|'inline'|"inline"|'hidden'|"hidden")/.test(config);

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
check('package.json build script passes no --sourcemap to esbuild', !buildEmitsBackendSourcemap(pkg.scripts.build), pkg.scripts.build);
check('vite.config.ts does not enable build.sourcemap', !viteEmitsSourcemap(readFileSync('vite.config.ts', 'utf8')));

// Known positives: the exact shipped 4657eef build line, and a Vite opt-in.
check('mutant: the 4657eef build line is flagged', buildEmitsBackendSourcemap(
  'vite build && esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs'));
check('mutant: --sourcemap=external is flagged', buildEmitsBackendSourcemap('esbuild server.ts --sourcemap=external --outfile=dist/server.cjs'));
check('mutant: vite sourcemap: true is flagged', viteEmitsSourcemap("build: { sourcemap: true }"));
check('mutant: vite sourcemap: \'hidden\' is flagged', viteEmitsSourcemap("build: { sourcemap: 'hidden' }"));
check('clean build line passes', !buildEmitsBackendSourcemap('vite build && esbuild server.ts --bundle --outfile=dist/server.cjs'));

if (failures) process.exit(1);
console.log('✓ sourcemap contract: backend and frontend builds emit no sourcemap');

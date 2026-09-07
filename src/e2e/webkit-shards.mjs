/**
 * Which of the 28 e2e-smoke shards must have WebKit installed.
 *
 * Sections are packed into shards by MEASURED duration (selection.js +
 * shard-timings.json), longest-first, so a new section or a re-measured
 * timing can silently move §70/§75/§83 to a different shard on the next run.
 * Computing this from the SAME packing function used by test.yml's matrix
 * and by smoke.mjs itself (rather than naming shard numbers by hand in the
 * workflow) means the install step can never drift out of sync with where
 * the WebKit-guarded sections actually land.
 *
 * Read by test.yml (CLI use below) and by e2esharding.test.ts (contract:
 * every shard this reports must actually receive a WebKit install).
 *
 *   node src/e2e/webkit-shards.mjs   # prints the needed shard numbers, one per line
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assignShards } from './selection.js';

// The three sections that call launchWebkitOrSkip in smoke.mjs (CodeRabbit
// outside-diff on #166). Kept as an explicit list — not re-derived by
// grepping for `launchWebkitOrSkip(` here — so a section that stops using
// WebKit drops off this list only when someone deliberately edits it.
export const WEBKIT_SECTION_IDS = ['70', '75', '83'];

const here = dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} [smokeSource] smoke.mjs's source, read as TEXT (never
 *   imported as a module — importing it runs the suite's top-level server
 *   boot). Defaults to the real file so CI and the CLI use below need no
 *   argument.
 */
export function shardsNeedingWebkit(smokeSource = readFileSync(join(here, 'smoke.mjs'), 'utf8')) {
  const definitions = [...smokeSource.matchAll(
    /section\('([^']+)',\s*'([^']+)',\s*async\s*\(\)\s*=>/g,
  )].map((match) => ({ id: match[1], name: match[2] }));
  const { definitions: assigned } = assignShards(definitions);
  const shards = new Set();
  for (const id of WEBKIT_SECTION_IDS) {
    const definition = assigned.find((d) => d.id === id);
    if (!definition) {
      throw new Error(`webkit-shards.mjs: section ${id} no longer exists in smoke.mjs — update WEBKIT_SECTION_IDS`);
    }
    shards.add(definition.shard);
  }
  return [...shards].sort((a, b) => a - b);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(shardsNeedingWebkit().join('\n'));
}

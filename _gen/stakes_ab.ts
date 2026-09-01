/**
 * Does telling the model what is at stake change the world it invents?
 *
 * Arms: hint OFF (what ships today) vs hint ON. Same games, same sampler.
 * The ladder holds the ORDINAL structure of the game fixed and varies only the
 * scale, so any difference is attributable to magnitude and not to a different
 * game. Output is JSONL for a separate blind rating pass — this script does no
 * judging, so it cannot flatter its own arm.
 */
import 'dotenv/config';
import { generateScenario } from '../src/utils/report';
import { pickScenarioDomain } from '../src/utils/scenarioDomains';
import { describeStakes, stakesHint } from '../src/utils/scenarioStakes';
import { appendFileSync, writeFileSync } from 'node:fs';
import type { GamePayoffs } from '../src/types';

const MODEL = process.env.AB_MODEL || 'gpt-5.6-luna';
const N = Number(process.env.AB_N || 8);
const OUT = process.env.AB_OUT || '_gen/results/stakes_ab.jsonl';

// One structure, four scales. Battle-of-the-sexes shape: both prefer to agree,
// each prefers a different agreement. Scaling it leaves the equilibria alone.
const ladder = (k: number): GamePayoffs =>
  ({ a11: 2 * k, a12: 0, a21: 0, a22: 1 * k, b11: 1 * k, b12: 0, b21: 0, b22: 2 * k });
// And a lopsidedness ladder at fixed magnitude: one decision worth 100, the
// other worth 100/r. This is the axis Daniel's 100-vs-0.001 example lives on.
const lop = (r: number): GamePayoffs =>
  ({ a11: 100, a12: 0, a21: 0, a22: 100 / r, b11: 100, b12: 0, b21: 0, b22: 100 / r });

const CELLS: Array<{ cell: string; g: GamePayoffs }> = [
  ...[0.2, 3, 15, 45].map((k) => ({ cell: `mag:${k}`, g: ladder(k) })),
  ...[1, 100, 100000].map((r) => ({ cell: `lop:${r}`, g: lop(r) })),
];

writeFileSync(OUT, '');
let n = 0;
for (const { cell, g } of CELLS) {
  const s = describeStakes(g);
  console.log(`\n${cell}  swing=${s.swing}  lopsided=${s.lopsidedness}  hint="${stakesHint(g).slice(0, 90)}…"`);
  for (const stakes of [false, true]) {
    for (let i = 0; i < N; i++) {
      const domain = pickScenarioDomain();
      const t0 = Date.now();
      let r: Awaited<ReturnType<typeof generateScenario>>;
      try {
        r = await generateScenario(g, { model: MODEL, stakes, domain });
      } catch (e) {
        r = { scenario: null, failure: String(e), usage: null } as never;
      }
      const sc = r.scenario;
      appendFileSync(OUT, JSON.stringify({
        cell, arm: stakes ? 'on' : 'off', i, domain, model: MODEL,
        ms: Date.now() - t0, failure: r.failure ?? null,
        name: sc?.name ?? null, description: sc?.description ?? null,
        row1: sc?.row1 ?? null, row2: sc?.row2 ?? null, col1: sc?.col1 ?? null, col2: sc?.col2 ?? null,
        swing: s.swing, lopsidedness: s.lopsidedness,
      }) + '\n');
      n++;
      process.stdout.write(sc ? '.' : 'x');
    }
    process.stdout.write(` [${stakes ? 'on ' : 'off'}] `);
  }
}
console.log(`\n${n} calls -> ${OUT}`);

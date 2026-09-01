/**
 * THE CONDITION THE BANK IS ACTUALLY SERVED UNDER.
 *
 * Every row was screened against the game it was GENERATED for. At serve time it
 * is paired with the USER's game — a different one from the same (domain, band)
 * cell. `validateProseDirections` is game-dependent, so a row that passed on its
 * own game can fail on another, and a high cross-pair failure rate would mean
 * the bank falls through to the model on most draws: present, screened, and
 * useless. Building the artifact without measuring this would leave the whole
 * approach resting on an assumption.
 */
import fs from 'node:fs';
import { validateScenario, scenarioIsClaimFree, validateProseDirections } from '../src/utils/nashValidator';
import { stakesBand } from '../src/utils/scenarioBank';
import type { GamePayoffs, SuggestedScenario } from '../src/types';

const raw = fs.readFileSync(`${process.env.HOME}/nash-finetune-data/scenario_raw_v2.jsonl`, 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r?.scenario?.name && r.game && r.domain) as Array<{ domain: string; game: GamePayoffs; scenario: SuggestedScenario }>;

const byCell = new Map<string, typeof raw>();
for (const r of raw) {
  const k = `${r.domain}|${stakesBand(r.game)}`;
  if (!byCell.has(k)) byCell.set(k, []);
  byCell.get(k)!.push(r);
}

let n = 0, passSelf = 0, passCross = 0;
const why: Record<string, number> = {};
const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();

for (const [, cell] of byCell) {
  if (cell.length < 2) continue;
  for (const row of cell) {
    const other = cell[Math.floor(rng() * cell.length)];
    if (other === row) continue;
    n++;
    const gate = (g: GamePayoffs) => {
      if (!validateScenario(row.scenario, g).ok) return 'validateScenario';
      if (!scenarioIsClaimFree(row.scenario).ok) return 'claim-free';
      const d = validateProseDirections(row.scenario.description ?? '', row.scenario, g);
      if (d.length) return `directions: ${d[0].slice(0, 55)}`;
      return null;
    };
    if (!gate(row.game)) passSelf++;
    const c = gate(other.game);
    if (!c) passCross++; else why[c] = (why[c] ?? 0) + 1;
  }
}
console.log(`cross-pairs tested : ${n}`);
console.log(`passes on OWN game : ${passSelf}  (${(100 * passSelf / n).toFixed(2)}%)`);
console.log(`passes on OTHER    : ${passCross}  (${(100 * passCross / n).toFixed(2)}%)   <-- the serving condition`);
console.log(`\nwhy cross-pairs fail:`);
for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(v).padStart(4)}  ${k}`);

/**
 * One-off sweep for RED-REGEN-2/001: re-screen the shipped scenario bank
 * (src/data/scenarioBank.json) against the strengthened `actorNounsOk`
 * (now requiring a literal, case-insensitive substring match against the raw
 * description, not just the normalized one) and report exactly how many
 * noun-bearing rows fail ONLY the new literal-substring clause. Any row that
 * fails DROPS its actorA/actorB (never rewrites the description or any other
 * field) — per this repo's rule, an AI action never rewrites model output,
 * only rejects it.
 *
 * Run once: `npx tsx _gen/sweep_literal_nouns.ts`
 * Writes the updated artifact back to src/data/scenarioBank.json only if at
 * least one row needed dropping (idempotent otherwise — a second run reports
 * 0 and leaves the file untouched).
 */
import fs from 'node:fs';
import path from 'node:path';
import { actorNounsOk } from '../src/utils/scenarioBank';

const BANK_PATH = path.join(process.cwd(), 'src', 'data', 'scenarioBank.json');
const raw = fs.readFileSync(BANK_PATH, 'utf8');
const rows: Array<{ d: string; b: number; s: Record<string, unknown> }> = JSON.parse(raw);

let scanned = 0;
let dropped = 0;
const examples: string[] = [];

for (const row of rows) {
  const sc = row.s;
  if (sc.actorA == null && sc.actorB == null) continue;
  scanned++;
  if (!actorNounsOk(sc as never)) {
    dropped++;
    if (examples.length < 3) {
      examples.push(`"${sc.name}" actorA=${JSON.stringify(sc.actorA)} actorB=${JSON.stringify(sc.actorB)} description=${JSON.stringify(sc.description)}`);
    }
    delete sc.actorA;
    delete sc.actorB;
  }
}

console.log(`RED-REGEN-2/001 literal-substring sweep: scanned ${scanned} noun-bearing rows of ${rows.length} total, dropped ${dropped}.`);
if (examples.length) {
  console.log('Examples of dropped rows:');
  for (const e of examples) console.log(`  - ${e}`);
}

if (dropped > 0) {
  fs.writeFileSync(BANK_PATH, JSON.stringify(rows, null, 2) + '\n', 'utf8');
  console.log(`Wrote updated artifact to ${BANK_PATH} (nouns removed, description/labels untouched).`);
} else {
  console.log('No rows needed dropping; artifact left untouched.');
}

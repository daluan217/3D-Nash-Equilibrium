/**
 * Build the shipped scenario bank from the raw generation log.
 *
 * The desktop shows these rows INSTEAD OF running a model, so the screening here
 * is the only thing standing between a bad row and a user. It therefore runs the
 * REAL production gates — the same three functions the cloud path applies at
 * request time — rather than a reimplementation of them. A bank screened by a
 * copy of the gates would drift from the gates the moment either changed, and
 * the drift would be invisible: every row would still look verified.
 *
 * Output is the picker's own shape ({d, b, s}), so nothing between here and the
 * screen reinterprets a row.
 */
import fs from 'node:fs';
import { validateScenario, scenarioIsClaimFree, validateProseDirections } from '../src/utils/nashValidator';
import { stakesBand, bankKey, type BankEntry } from '../src/utils/scenarioBank';
import type { GamePayoffs, SuggestedScenario } from '../src/types';

const RAW = process.env.BANK_RAW ?? `${process.env.HOME}/nash-finetune-data/scenario_raw_v2.jsonl`;
const OUT = process.env.BANK_OUT ?? 'src/data/scenarioBank.json';

const lines = fs.readFileSync(RAW, 'utf8').trim().split('\n');
const parsed = lines
  .map((l) => { try { return JSON.parse(l) as { domain?: string; game?: GamePayoffs; scenario?: SuggestedScenario | null }; } catch { return null; } })
  .filter((r): r is NonNullable<typeof r> => !!r);
/**
 * GENERATION FAILURES ARE COUNTED, NOT FILTERED AWAY.
 *
 * The raw log records a failed generation as `scenario: null`. Dropping those in
 * the parse filter is correct — a row with no scenario cannot be gated and
 * cannot ship — but it silently moves the denominator, and a yield quoted
 * against the survivors reads as if the pipeline were cleaner than it is. So
 * they are counted here and reported on their own line: gate yield and
 * generation yield are different numbers and neither should stand in for the
 * other.
 */
const genFailed = parsed.filter((r) => !r.scenario?.name).length;
const rows = parsed.filter((r) => !!r.scenario?.name && !!r.game && !!r.domain);

const drop: Record<string, number> = {};
const kept: BankEntry[] = [];
const seen = new Set<string>();
let dupes = 0;

for (const r of rows) {
  const sc = r.scenario!; const g = r.game!;
  const v = validateScenario(sc, g);
  if (!v.ok) { for (const i of v.issues) drop[bucket(i)] = (drop[bucket(i)] ?? 0) + 1; continue; }
  const cf = scenarioIsClaimFree(sc);
  if (!cf.ok) { drop[`claim-free: ${cf.reason ?? '?'}`] = (drop[`claim-free: ${cf.reason ?? '?'}`] ?? 0) + 1; continue; }
  // The description is the only prose the bank ships, so it is the only prose
  // the direction checks can speak about.
  const dir = validateProseDirections(sc.description ?? '', { row1: sc.row1, row2: sc.row2, col1: sc.col1, col2: sc.col2 }, g);
  if (dir.length) { drop[`directions: ${dir[0].slice(0, 60)}`] = (drop[`directions: ${dir[0].slice(0, 60)}`] ?? 0) + 1; continue; }

  const e: BankEntry = { d: r.domain!, b: stakesBand(g), s: sc };
  const k = bankKey(e);
  if (seen.has(k)) { dupes++; continue; }
  seen.add(k); kept.push(e);
}

/** Collapse an issue string to its class so the drop table is readable. */
function bucket(i: string): string {
  if (/outside the expected script/.test(i)) return 'DEBRIS: foreign script';
  if (/curly brace/.test(i)) return 'DEBRIS: brace';
  if (/talking to itself/.test(i)) return 'DEBRIS: self-talk';
  return `validate: ${i.slice(0, 60)}`;
}

const cells = new Map<string, number>();
for (const e of kept) cells.set(`${e.d}|${e.b}`, (cells.get(`${e.d}|${e.b}`) ?? 0) + 1);
const names = new Map<string, number>();
for (const e of kept) names.set(e.s.name ?? '', (names.get(e.s.name ?? '') ?? 0) + 1);
const top = [...names.entries()].sort((a, b) => b[1] - a[1])[0];

console.log(`raw log lines     : ${lines.length}`);
console.log(`generation failed : ${genFailed}  (scenario: null — cannot be gated, cannot ship)`);
console.log(`gateable rows     : ${rows.length}`);
console.log(`KEPT              : ${kept.length}  (${(100 * kept.length / rows.length).toFixed(1)}% of gateable, ${(100 * kept.length / lines.length).toFixed(1)}% of the log)`);
console.log(`exact duplicates  : ${dupes}`);
console.log(`\ndropped by gate:`);
for (const [k, n] of [...Object.entries(drop)].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log(`\ndistinct domains  : ${new Set(kept.map((e) => e.d)).size}`);
console.log(`distinct names    : ${names.size}  (top "${top?.[0]}" x${top?.[1]} = ${(100 * (top?.[1] ?? 0) / kept.length).toFixed(2)}%)`);
console.log(`(domain,band)cells: ${cells.size}`);
const thin = [...cells.values()].filter((n) => n < 4).length;
console.log(`cells with <4 rows: ${thin}`);

if (process.env.BANK_WRITE === '1') {
  fs.mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(kept));
  console.log(`\nwrote ${OUT}  (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}

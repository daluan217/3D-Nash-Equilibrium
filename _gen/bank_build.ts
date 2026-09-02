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
import { stakesBand, bankKey, SERVE_PROBES, type BankEntry } from '../src/utils/scenarioBank';
import { SCREENS } from './trainset_screens';
import { exposureAsymmetryClaim, doubledTerminalStop } from './bank_screens';
import type { GamePayoffs, SuggestedScenario } from '../src/types';

/**
 * The teacher screens the bank ALSO applies, and the one it refuses.
 *
 * WHY APPLY THEM AT ALL when the three production gates already run above. The
 * gates are what the cloud path enforces at request time; the screens are what
 * the teacher corpus is filtered on. They overlap heavily but not completely,
 * and the gap runs the direction that matters: measured over 3,683 corpus rows
 * carrying their own game (mostly LOCAL model output, which is the dirty
 * surface), 3,301 survive all three production gates — and of those survivors,
 * 5 still carry an article disagreement and 1 a meta leak ("Firm A (the row
 * player)"). Persona (261 -> 0), foreign script (4 -> 0), truncation (1 -> 0)
 * and duplicate options (14 -> 0) ARE subsumed by the gates on that evidence;
 * they are kept here because they cost nothing and the subsumption is a
 * property of today's gates, not a guarantee.
 *
 * WHAT THIS COSTS TODAY: nothing. Every one of these screens returns ZERO hits
 * on the 2,225 gate-passing rows in the current raw log and zero on the 1,958
 * rows of the shipped artifact. That is the point — the reach is measured on
 * output the gates already passed, not asserted, and the row cost is measured
 * too rather than assumed small.
 *
 * LABEL-COLLISION IS DELIBERATELY EXCLUDED. Both players carrying the same two
 * option names is not a falsehood — the Prisoner's Dilemma does it — and this
 * project refused to gate it in production. It would drop 359 of 1,958 rows
 * here, 18% of the bank, for a shape a reader has no complaint about. The
 * teacher corpus excludes it for a different reason (a student should not learn
 * a habit that blinds `validateProseDirections`), and that reason does not
 * transfer to rows that are already written.
 */
const BANK_SCREENS = SCREENS.filter(([name]) => name !== 'label-collision');

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
  /**
   * GATED AGAINST THE GAME IT WILL BE SERVED WITH, NOT ONLY THE ONE IT WAS
   * WRITTEN FOR.
   *
   * This line used to be `validateScenario(sc, g)` alone, where `g` is the row's
   * OWN generation matrix. But `pickFromBank` hands the row to whatever game the
   * user typed, so every game-dependent rule in the gate answers differently at
   * serve time — and a row admitted here could then be rejected in front of a
   * reader, on a path with no model to fall back to and no reroll, leaving the
   * response silently carrying no story at all.
   *
   * 19 shipped rows did exactly that: rivalry vocabulary is rejected on any
   * COMMON-INTEREST matrix, which is the plain pure-coordination game and also
   * the all-zero matrix a user gets by clearing the payoff fields. Two agents
   * reproduced the same 19 from opposite directions — a 270-game probe sweep and
   * one probe per game-conditional branch.
   *
   * `SERVE_PROBES` is one game per condition the gates branch on, at three
   * magnitudes; see its comment in scenarioBank.ts for why it must NOT be
   * band-scoped and why most of its zeros mean "the corpus never says that"
   * rather than "the artifact is safe".
   */
  const v = validateScenario(sc, g);
  if (!v.ok) { for (const i of v.issues) drop[bucket(i)] = (drop[bucket(i)] ?? 0) + 1; continue; }
  const probeFail = SERVE_PROBES.map((p) => validateScenario(sc, p)).find((r) => !r.ok);
  if (probeFail) { for (const i of probeFail.issues) drop[`serve-probe: ${bucket(i)}`] = (drop[`serve-probe: ${bucket(i)}`] ?? 0) + 1; continue; }
  const cf = scenarioIsClaimFree(sc);
  if (!cf.ok) { drop[`claim-free: ${cf.reason ?? '?'}`] = (drop[`claim-free: ${cf.reason ?? '?'}`] ?? 0) + 1; continue; }
  // The description is the only prose the bank ships, so it is the only prose
  // the direction checks can speak about.
  const dir = validateProseDirections(sc.description ?? '', { row1: sc.row1, row2: sc.row2, col1: sc.col1, col2: sc.col2 }, g);
  if (dir.length) { drop[`directions: ${dir[0].slice(0, 60)}`] = (drop[`directions: ${dir[0].slice(0, 60)}`] ?? 0) + 1; continue; }

  const screen = BANK_SCREENS.find(([, fn]) => fn(sc));
  if (screen) { drop[`screen: ${screen[0]}`] = (drop[`screen: ${screen[0]}`] ?? 0) + 1; continue; }

  /**
   * THE EXPOSURE ASYMMETRY THE OLD PROMPT COULD NOT GET RIGHT. Rows generated
   * before the `stakesHint` fix named the exposed party from a ratio that has
   * no direction, and those guesses measured 44% wrong on the row's own game.
   * Recall-favouring on purpose: see `_gen/bank_screens.ts` for why over-firing
   * is the cheap direction here and what it was measured to cost.
   */
  if (exposureAsymmetryClaim(sc)) { drop['screen: exposure-asymmetry'] = (drop['screen: exposure-asymmetry'] ?? 0) + 1; continue; }

  /**
   * A doubled terminal stop (`…and "Late trim.".`). A typo rather than a claim,
   * gated HERE and deliberately not in production: on the report path a
   * rejection deletes the whole story with no reroll, which is the wrong trade
   * for a stray full stop, while here it costs one row of ~2,500 and the picker
   * simply hands over another. See `bank_screens.ts` for the measurement.
   */
  if (doubledTerminalStop(sc)) { drop['screen: doubled-terminal-stop'] = (drop['screen: doubled-terminal-stop'] ?? 0) + 1; continue; }

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

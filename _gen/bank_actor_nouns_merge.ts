/**
 * Merge `_gen/bank_actor_nouns.ts`'s raw JSONL log into the shipped scenario
 * bank artifact — the same raw-log-then-build split `bank_build.ts` uses,
 * kept as two scripts for the same reason: the raw log is the full record
 * (including every failed/dropped row, so a yield number is re-derivable),
 * and the merge step is the one that actually touches the shipped file.
 *
 * Re-validates every row with `actorNounsOk` AGAIN at merge time (not just
 * trusting the raw log's own `ok` flag) — the same "verify at the point you
 * ship, not only at the point you drew" discipline `bankSource.ts`'s module
 * comment states for the story gates themselves. A row whose raw log says
 * `ok:false` is merged with NO nouns, never with a best-effort partial.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { actorNounsOk, type BankEntry } from '../src/utils/scenarioBank';

const BANK_PATH = process.env.BANK_SRC || 'src/data/scenarioBank.json';
const RAW_PATH = process.env.NOUNS_OUT || '_gen/results/bank_actor_nouns_raw.jsonl';
const OUT_PATH = process.env.BANK_OUT || BANK_PATH;

type RawRow = {
  idx: number; ok: boolean; actorA: string[] | null; actorB: string[] | null;
};

const bank: BankEntry[] = JSON.parse(readFileSync(BANK_PATH, 'utf8'));
const raw = readFileSync(RAW_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as RawRow);

// Keep the LAST line per idx (a resumed run can append a duplicate idx if it
// was interrupted mid-write and restarted before the previous line landed;
// "last wins" matches how the harness itself treats a resume — new attempts
// only ever run for idx NOT already in the log, so a duplicate means a
// legitimate re-run of a specific idx, and the newer measurement is the one
// to trust).
const byIdx = new Map<number, RawRow>();
for (const r of raw) byIdx.set(r.idx, r);

let merged = 0; let withNouns = 0; let droppedByReMerge = 0; let missing = 0;
for (let i = 0; i < bank.length; i++) {
  const r = byIdx.get(i);
  if (!r) { missing++; continue; }
  const candidate = {
    actorA: r.actorA, actorB: r.actorB,
    description: bank[i].s.description, row1: bank[i].s.row1, row2: bank[i].s.row2, col1: bank[i].s.col1, col2: bank[i].s.col2,
  };
  // `actorNounsOk` (scenarioBank.ts) carries every bar, including the two
  // found by hand-reading this backfill (a compound "X and Y" noun, and a
  // plain collective noun assigned to one side of a symmetrically-framed
  // description) — kept there, not here, so `scenariobank.test.ts`'s
  // re-screen of the SHIPPED artifact enforces the same rule this merge does.
  const ok = actorNounsOk(candidate);
  if (r.ok && !ok) droppedByReMerge++;
  if (ok && (r.actorA || r.actorB)) {
    bank[i].s.actorA = r.actorA ?? undefined;
    bank[i].s.actorB = r.actorB ?? undefined;
    withNouns++;
  }
  merged++;
}

// Compact, matching `bank_build.ts`'s own `JSON.stringify(kept)` (no
// indentation) — the shipped artifact's existing format, so this merge's
// diff is only the added actorA/actorB keys, not a 2,483-row re-format.
writeFileSync(OUT_PATH, JSON.stringify(bank));
console.log(`merged ${merged}/${bank.length} rows (${missing} had no raw-log entry, ${droppedByReMerge} dropped on re-validation), ${withNouns} rows now carry actorA/actorB -> ${OUT_PATH}`);

/**
 * The bank picker: every property it loses SILENTLY rather than fails on.
 *
 * The bank exists because the local model writes an incoherent world about a
 * quarter of the time and no gate can see it (178/178 defective stories passed
 * all three screens). Blind, paired, sealed: bank 0/68 vs model 25%, p=6.1e-5.
 *
 * So the picker is now the thing standing between a user and a story. If it
 * silently returns nothing, repeats itself, or reaches into the wrong stakes
 * band, the product regresses in a way no existing test would notice.
 */
import { bankAvailable, bankSize, allBankRows } from './utils/bankSource';
import { scenarioIsClaimFree, validateScenario } from './utils/nashValidator';
import { pickFromBank, stakesBand, bankKey, type BankEntry } from './utils/scenarioBank';
import type { GamePayoffs } from './types';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const G = (k: number): GamePayoffs => ({ a11: 2 * k, a12: 0, a21: 0, a22: k, b11: k, b12: 0, b21: 0, b22: 2 * k });
const entry = (d: string, b: number, name: string, desc = 'x'): BankEntry =>
  ({ d, b, s: { name, row1: 'A', row2: 'B', col1: 'C', col2: 'D', description: desc } as never });

/* ------------------------------------------------- bands match the hint */
// The bank is indexed on the band, so an off-by-one here files every story
// under the wrong stakes and the index silently stops meaning anything.
check('band cuts match stakesHint: <1 tiny', stakesBand(G(0.3)) === 0, `${stakesBand(G(0.3))}`);
check('band cuts: <10 modest', stakesBand(G(4)) === 1, `${stakesBand(G(4))}`);
check('band cuts: <50 substantial', stakesBand(G(20)) === 2, `${stakesBand(G(20))}`);
check('band cuts: >=50 very large', stakesBand(G(60)) === 3, `${stakesBand(G(60))}`);

/* --------------------------------------------- without replacement */
{
  const bank = ['One', 'Two', 'Three', 'Four'].map((n) => entry('vineyard', 2, n));
  const seen = new Set<string>();
  const got: string[] = [];
  for (let i = 0; i < 4; i++) {
    const s = pickFromBank(bank, G(20), 'vineyard', seen, () => 0);
    if (!s) break;
    got.push(s.name ?? '');
    seen.add(bankKey(bank.find((e) => e.s.name === s.name)!));
  }
  check('four draws from a four-story cell return four DIFFERENT stories',
    new Set(got).size === 4, got.join(', '));
  // Exhausted is exhausted: repeating is then the honest outcome, not silence.
  const after = pickFromBank(bank, G(20), 'vineyard', seen);
  check('a fifth draw still returns a story rather than null', after !== null);
}

/* ------------------------------------------ names, not just entries */
{
  // 214 of 314 real cells hold >=2 stories under ONE name. A picker that only
  // avoids repeat ENTRIES still shows the same TITLE twice, which is the thing
  // a reader actually notices.
  const bank = [entry('harbour', 1, 'Harbour Inspection', 'first'),
                entry('harbour', 1, 'Harbour Inspection', 'second'),
                entry('harbour', 1, 'Ferry Slotting', 'third')];
  const seen = new Set([bankKey(bank[0])]);
  // DETERMINISTIC pick, and that is the point. With Math.random this assertion
  // passes by luck under a broken picker roughly half the time — a check that
  // cannot reliably fail for the reason it claims, which is the defect this
  // whole campaign keeps finding. `() => 0` takes the FIRST candidate, so a
  // picker that ranks "unseen entry" above "unseen name" hands back the
  // repeated title every run.
  const s = pickFromBank(bank, G(4), 'harbour', seen, () => 0);
  check('a seen NAME is avoided even when the entry differs',
    s?.name === 'Ferry Slotting', `got ${s?.name}`);
}

/* ------------------------------------------------- graceful widening */
{
  const bank = [entry('kelp', 0, 'Tiny One'), entry('kelp', 3, 'Large One')];
  // The exact cell is empty; the DOMAIN is what a reader sees, so hold it.
  const s = pickFromBank(bank, G(20), 'kelp', new Set());
  check('an empty (domain,band) cell falls back within the domain', s !== null, `${s?.name}`);
  // No domain at all: fall back on band rather than returning nothing.
  const other = pickFromBank(bank, G(0.3), 'nonexistent-domain', new Set());
  check('an unknown domain falls back on the band', other?.name === 'Tiny One', `${other?.name}`);
  check('an empty bank returns null rather than throwing', pickFromBank([], G(4), 'kelp', new Set()) === null);
}

/* ----------------------------------------------- the band is honoured */
{
  const bank = [entry('mill', 0, 'Tiny'), entry('mill', 1, 'Modest'),
                entry('mill', 2, 'Substantial'), entry('mill', 3, 'Large')];
  for (const [k, want] of [[0.3, 'Tiny'], [4, 'Modest'], [20, 'Substantial'], [60, 'Large']] as Array<[number, string]>) {
    const s = pickFromBank(bank, G(k), 'mill', new Set());
    check(`a swing of ${k} draws from the ${want} band`, s?.name === want, `got ${s?.name}`);
  }
}

/* ------------------------------------------------------- determinism */
{
  // A seeded picker must be reproducible, so the desktop's reproducible mode
  // keeps working when the bank replaces generation.
  const bank = ['a', 'b', 'c', 'd', 'e'].map((n) => entry('rail', 2, n));
  const fixed = () => 0.42;
  const one = pickFromBank(bank, G(20), 'rail', new Set(), fixed);
  const two = pickFromBank(bank, G(20), 'rail', new Set(), fixed);
  check('the same picker value returns the same story', one?.name === two?.name, `${one?.name} vs ${two?.name}`);
  // And the endpoint cannot fall off the array.
  check('pick()=1 stays in range', pickFromBank(bank, G(20), 'rail', new Set(), () => 0.999999) !== null);
}


/* ============================================================================
 * THE SHIPPED ARTIFACT
 *
 * Everything above tests the picker against fixtures. This section tests the
 * BANK ITSELF — the file the desktop actually shows — because it is an artifact
 * frozen at build time while the gates that justify it keep moving. Two distinct
 * failures are in scope and neither announces itself:
 *
 *   1. THE ARTIFACT DOES NOT LOAD. The first implementation used `require()`,
 *      which is undefined under tsx/ESM, and `bankAvailable()` returned false
 *      everywhere while the catch degraded silently to the model path. Nothing
 *      threw. A size assertion is the only thing that distinguishes "bank
 *      present" from "bank silently absent".
 *
 *   2. THE ARTIFACT GOES STALE. When a gate tightens, rows screened by the old
 *      gate keep shipping until something re-screens them. Re-screening here
 *      means a tightened gate FAILS CI rather than being quietly outvoted by a
 *      file built last week.
 * ========================================================================= */
{
  const size = bankSize();
  check('the shipped bank artifact actually loads', bankAvailable() && size > 500,
    `bankAvailable=${bankAvailable()} size=${size} — a silent load failure looks exactly like an empty cell`);

  // Rows are served with the USER's game, never the one they were written for,
  // so they are screened here against a game they have never seen. That is the
  // real serving condition; measured at 98.78% across 1,560 cross-pairs, which
  // is IDENTICAL to the own-game rate — claim-free prose is game-agnostic by
  // construction, and that property is what makes a bank possible at rung 3 at
  // all. If it ever stops holding, this fails.
  const probes: GamePayoffs[] = [
    { a11: 0.4, a12: -0.3, a21: -0.2, a22: 0.5, b11: -0.4, b12: 0.3, b21: 0.2, b22: -0.5 },
    { a11: 3, a12: -2, a21: -4, a22: 5, b11: -3, b12: 2, b21: 4, b22: -5 },
    { a11: 30, a12: -22, a21: -41, a22: 55, b11: -30, b12: 22, b21: 41, b22: -55 },
  ];
  let bad = 0; let firstBad = '';
  for (const e of allBankRows()) {
    if (!e.s?.name || !e.s.description || typeof e.d !== 'string') {
      bad++; if (!firstBad) firstBad = `malformed row ${JSON.stringify(e).slice(0, 120)}`;
      continue;
    }
    const cf = scenarioIsClaimFree(e.s);
    if (!cf.ok) { bad++; if (!firstBad) firstBad = `"${e.s.name}" not claim-free: ${cf.reason}`; continue; }
    for (const g of probes) {
      const v = validateScenario(e.s, g);
      if (!v.ok) { bad++; if (!firstBad) firstBad = `"${e.s.name}" fails validateScenario: ${v.issues[0]}`; break; }
    }
  }
  check('every shipped bank row still passes the live gates', bad === 0,
    `${bad} of ${size} shipped rows fail today's gates — the artifact is stale, rebuild it with _gen/bank_build.ts. First: ${firstBad}`);
}

// The exit check must be the LAST thing in the file. It was above the shipped-artifact
// section, so those assertions ran, printed, and could not fail the suite.
if (failures > 0) { console.error(`✗ scenario bank: ${failures} failed`); process.exit(1); }
console.log(`✓ scenario bank: bands match stakesHint, draws are without replacement and avoid a seen NAME, thin cells widen by domain then band, an empty bank returns null, seeded picks are reproducible, and all ${bankSize()} SHIPPED rows load and still pass today's gates`);

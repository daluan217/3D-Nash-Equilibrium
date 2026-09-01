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

if (failures > 0) { console.error(`✗ scenario bank: ${failures} failed`); process.exit(1); }
console.log('✓ scenario bank: bands match stakesHint, draws are without replacement and avoid a seen NAME, thin cells widen by domain then band, an empty bank returns null, seeded picks are reproducible');

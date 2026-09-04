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
import { bankAvailable, bankSize, allBankRows, bankScenario, bankScenarioAvoiding, __resetBankSeen } from './utils/bankSource';
import { scenarioIsClaimFree, validateScenario, validateProseDirections } from './utils/nashValidator';
import { pickFromBank, stakesBand, bankKey, SERVE_PROBES, actorNounsOk, type BankEntry } from './utils/scenarioBank';
import { pickScenarioDomainExcluding } from './utils/scenarioDomains';
import { readFileSync } from 'node:fs';
import type { GamePayoffs } from './types';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const G = (k: number): GamePayoffs => ({ a11: 2 * k, a12: 0, a21: 0, a22: k, b11: k, b12: 0, b21: 0, b22: 2 * k });
const entry = (d: string, b: number, name: string, desc = 'x'): BankEntry =>
  ({ d, b, s: { name, row1: 'A', row2: 'B', col1: 'C', col2: 'D', description: desc } as never });

/**
 * SOFT STAKES (2026-09-02) added a softening draw BEFORE the widening ladder
 * (`pickFromBank`'s `softenBand`): the FIRST `pick()` call decides whether to
 * reach for a neighbouring band at all (a value >= `BAND_NEIGHBOR_P` keeps the
 * exact band), and every later call is the pre-existing "which candidate"
 * logic the tests below were written against. Tests whose POINT is the
 * widening ladder — not the softening — use `exactPick`, which always clears
 * the softening gate first and then delegates, so `() => 0`'s old "take the
 * first candidate" meaning is preserved for everything downstream of it.
 */
const exactPick = (inner: () => number = () => 0): () => number => {
  let first = true;
  return () => {
    if (first) { first = false; return 0.99; } // >= BAND_NEIGHBOR_P: keep the exact band
    return inner();
  };
};

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
    const s = pickFromBank(bank, G(20), 'vineyard', seen, exactPick());
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
  const s = pickFromBank(bank, G(4), 'harbour', seen, exactPick());
  check('a seen NAME is avoided even when the entry differs',
    s?.name === 'Ferry Slotting', `got ${s?.name}`);
}

/* --------------------------------- a one-name cell widens, never repeats */
{
  // THE DEFECT THIS FILE MISSED. 34 of the 320 cells in the shipped artifact
  // hold exactly ONE distinct name — "lighthouse relief shifts" band 2 is eight
  // rows all titled "Lighthouse Relief Shifts". The old picker only looked
  // inside the exact cell when that cell was non-empty, so once the title had
  // been shown, every remaining row fell to the "unseen entry" tier and handed
  // the title straight back. Measured on the shipped bank with the domain held
  // fixed: repeated-title 29.5% at 5 presses, 60.7% at 10, 90.2% at 40.
  const bank = [entry('lighthouse relief shifts', 2, 'Lighthouse Relief Shifts', 'one'),
                entry('lighthouse relief shifts', 2, 'Lighthouse Relief Shifts', 'two'),
                entry('kelp farm harvesting', 2, 'Kelp Harvest Timing', 'three')];
  const seen = new Set([bankKey(bank[0])]);
  // `() => 0` again: a picker that repeats returns bank[1] deterministically,
  // so this cannot pass by luck.
  const s = pickFromBank(bank, G(20), 'lighthouse relief shifts', seen, exactPick());
  check('a cell with no unseen NAME widens instead of repeating the title',
    s?.name === 'Kelp Harvest Timing', `got ${s?.name}`);
  // And it widens to the RIGHT BAND: the alternative here is off-band.
  const bank2 = [entry('lighthouse relief shifts', 2, 'Lighthouse Relief Shifts', 'one'),
                 entry('lighthouse relief shifts', 2, 'Lighthouse Relief Shifts', 'two'),
                 entry('lighthouse relief shifts', 0, 'Tiny Lighthouse Job', 'three'),
                 entry('kelp farm harvesting', 2, 'Kelp Harvest Timing', 'four')];
  const s2 = pickFromBank(bank2, G(20), 'lighthouse relief shifts', new Set([bankKey(bank2[0])]), exactPick());
  check('widening prefers the same band over the same domain',
    s2?.name === 'Kelp Harvest Timing', `got ${s2?.name}`);
}

/* ------------------------------------------------- graceful widening */
{
  // AN EMPTY EXACT CELL KEEPS THE STAKES BAND, NOT THE SETTING. The old order
  // widened by DOMAIN first, so a band-3 game whose (domain, band 3) cell was
  // empty was served that domain's band-0 story — "a modest patch of coppice"
  // beside a swing of 120. The band comes from the user's own matrix and the
  // mismatch is visible next to the numbers; the domain is a rotation choice
  // the user never made.
  const bank = [entry('coppice cutting cycles', 0, 'Modest Coppice Patch'),
                entry('kelp farm harvesting', 3, 'Kelp Harvest Timing')];
  const s = pickFromBank(bank, G(60), 'coppice cutting cycles', new Set(), exactPick());
  check('an empty (domain,band) cell holds the BAND rather than the domain',
    s?.name === 'Kelp Harvest Timing', `got ${s?.name}`);

  const kelp = [entry('kelp', 0, 'Tiny One'), entry('kelp', 3, 'Large One')];
  // Nothing at this band ANYWHERE: only then does it fall back within the domain.
  const t = pickFromBank(kelp, G(20), 'kelp', new Set(), exactPick());
  check('a band with no row in the whole bank falls back within the domain', t !== null, `${t?.name}`);
  // No domain at all: fall back on band rather than returning nothing.
  const other = pickFromBank(kelp, G(0.3), 'nonexistent-domain', new Set(), exactPick());
  check('an unknown domain falls back on the band', other?.name === 'Tiny One', `${other?.name}`);
  check('an empty bank returns null rather than throwing', pickFromBank([], G(4), 'kelp', new Set()) === null);
}

/* ----------------------------------------------- the band is honoured */
{
  const bank = [entry('mill', 0, 'Tiny'), entry('mill', 1, 'Modest'),
                entry('mill', 2, 'Substantial'), entry('mill', 3, 'Large')];
  for (const [k, want] of [[0.3, 'Tiny'], [4, 'Modest'], [20, 'Substantial'], [60, 'Large']] as Array<[number, string]>) {
    const s = pickFromBank(bank, G(k), 'mill', new Set(), exactPick());
    check(`a swing of ${k} draws from the ${want} band when the softening gate clears`, s?.name === want, `got ${s?.name}`);
  }
}

/* ------------------------------------------------ soft stakes for the bank
 * `softenBand` is the whole point of this round's change: mostly the exact
 * band, sometimes a neighbour, never two bands over, deterministic per seed.
 */
{
  const bank = [entry('mill', 0, 'Tiny'), entry('mill', 1, 'Modest'),
                entry('mill', 2, 'Substantial'), entry('mill', 3, 'Large')];
  // A low first draw (< BAND_NEIGHBOR_P) reaches for a neighbour; the SECOND
  // draw picks which one when both exist.
  const seq = (vals: number[]) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)]; };
  const low = pickFromBank(bank, G(20), 'mill', new Set(), seq([0, 0])); // band 2 -> neighbour, low half -> band 1
  check('a low softening draw reaches the LOWER neighbour band', low?.name === 'Modest', `got ${low?.name}`);
  const high = pickFromBank(bank, G(20), 'mill', new Set(), seq([0, 0.99])); // band 2 -> neighbour, high half -> band 3
  check('a low softening draw + a high half-draw reaches the UPPER neighbour band', high?.name === 'Large', `got ${high?.name}`);
  // NEVER two bands over: band 0 (Tiny) only has ONE neighbour (band 1) — a
  // mutant that let the ladder wander further would eventually surface
  // "Substantial" or "Large" here, and this pins it to exactly one hop.
  const edge = pickFromBank(bank, G(0.3), 'mill', new Set(), seq([0, 0.99]));
  check('band 0 (no lower neighbour) only ever reaches ONE band over', edge?.name === 'Modest', `got ${edge?.name}`);
  const edge2 = pickFromBank(bank, G(60), 'mill', new Set(), seq([0, 0]));
  check('band 3 (no upper neighbour) only ever reaches ONE band over', edge2?.name === 'Substantial', `got ${edge2?.name}`);

  // MEASURED, not just fixture-checked: over many seeds, the exact band wins
  // roughly 1 - BAND_NEIGHBOR_P (0.3) of the time, and it is NEVER anything
  // but the exact band or an immediate neighbour.
  let seed = 555;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const N = 4000;
  let exact = 0, offByOne = 0, offByMore = 0;
  const bandOf: Record<string, number> = { Tiny: 0, Modest: 1, Substantial: 2, Large: 3 };
  for (let i = 0; i < N; i++) {
    const s = pickFromBank(bank, G(20), 'mill', new Set(), rand); // true band 2
    const b = bandOf[s?.name ?? ''];
    const d = Math.abs(b - 2);
    if (d === 0) exact++; else if (d === 1) offByOne++; else offByMore++;
  }
  check('softened band distribution: exact band ~= 1 - BAND_NEIGHBOR_P (0.3)',
    Math.abs(exact / N - 0.7) < 0.05, `exact ${(exact / N).toFixed(3)} over ${N}`);
  check('softened band distribution: NEVER more than one band away',
    offByMore === 0, `${offByMore}/${N} landed two or more bands from the true one`);
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
 * RED-CLOUD-7/001 — the hosted fallback caller's `seen` must be scoped PER
 * REQUEST, not accumulate across unrelated users on one warm process.
 *
 * `bankScenario`/`bankScenarioAvoiding`'s module-global `seen` (bankSource.ts)
 * is correctly scoped to ONE DESKTOP LAUNCH for the original caller
 * (`inventScenario`, IS_ELECTRON-gated) — a fresh Electron process resets it
 * naturally. `server.ts`'s `inventScreenedScenario` later added a SECOND
 * caller (its last-resort bank fallback), reachable on the HOSTED path too
 * (no IS_ELECTRON gate). Cloud Run runs the service at `--max-instances=1`
 * with no `--min-instances`, so in practice ONE warm process can serve many
 * unrelated users' requests over its lifetime — left unscoped, their fallback
 * draws accumulate in the SAME `seen` Set, eventually exhausting the exact
 * stakes-band pool for a cell and drifting later requests onto a story 2+
 * bands away from their own game's numbers (far-band 24-41% in 200-draw
 * windows after ~400 accumulated draws, vs 0/500 on a properly cold/scoped
 * process — RED-CLOUD-7/001's own measurement).
 *
 * FIX (src/utils/bankSource.ts, server.ts's `inventScreenedScenario`): both
 * bank-picking functions now take an optional `seenOverride` Set; the hosted
 * fallback call site passes a FRESH one every request (server.ts, gated on
 * `IS_ELECTRON !== 'true'`), while the desktop caller passes nothing and
 * keeps using the per-launch singleton, unchanged.
 * ========================================================================= */
{
  // The finding's own reproduction game: true stakes band 1 ("modest").
  const FALLBACK_GAME: GamePayoffs = { a11: 3, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 };
  const trueBand = stakesBand(FALLBACK_GAME);
  check('fixture sanity: FALLBACK_GAME true stakes band is 1', trueBand === 1, `${trueBand}`);

  // Matched by OBJECT REFERENCE, not by name: names repeat across (domain,
  // band) cells by design (that is the whole reason `pickFromBank`'s ladder
  // tracks `seenNames` separately from `seen` entries), so a name-only
  // lookup can silently resolve to the WRONG row's band — `sc` returned by
  // `bankScenario` IS the exact `.s` object of whichever row was picked
  // (`pickFromBank`'s `take()` returns `pool[i].s` verbatim), so reference
  // equality is the only correct way to recover which row served it.
  const bandOfPick = (sc: { name?: string } | null | undefined): number | null => {
    if (!sc) return null;
    const hit = allBankRows().find((e) => e.s === sc);
    return hit ? hit.b : null;
  };
  const classify = (band: number | null): 'exact' | 'near' | 'far' | 'miss' => {
    if (band === null) return 'miss';
    const diff = Math.abs(band - trueBand);
    return diff === 0 ? 'exact' : diff === 1 ? 'near' : 'far';
  };

  // PER-REQUEST SCOPING — what the hosted fallback call site now does: a
  // FRESH Set every single draw, exactly matching server.ts's
  // `hostedFallbackSeen = process.env.IS_ELECTRON === 'true' ? undefined :
  // new Set<string>()` on every request. 2,000 draws (the finding's own
  // sample size) — far-band must be EXACTLY 0 throughout, not just on
  // average, because a properly scoped draw can never see another request's
  // `seen` state at all.
  {
    let exact = 0, near = 0, far = 0, miss = 0;
    for (let i = 0; i < 2000; i++) {
      const domain = pickScenarioDomainExcluding(undefined);
      const sc = bankScenario(FALLBACK_GAME, domain, new Set<string>());
      const c = classify(bandOfPick(sc));
      if (c === 'exact') exact++; else if (c === 'near') near++; else if (c === 'far') far++; else miss++;
    }
    check('per-request-scoped hosted fallback: far-band is 0 across 2,000 sequential draws', far === 0,
      `exact=${exact} near=${near} far=${far} miss=${miss} — any far-band draw means a per-request Set somehow saw a prior request's state`);
    check('per-request-scoped hosted fallback: nearly every draw lands in-band (exact or the designed soft neighbour)',
      exact + near >= 1900, `exact=${exact} near=${near} far=${far} miss=${miss}`);
  }

  // CROSS-REQUEST ACCUMULATION — the pre-fix shape, reproduced directly: the
  // SAME game, but `seen` never reset across 2,000 draws (no seenOverride at
  // all, so every draw shares the one module-global `seen` — exactly what
  // server.ts did before this fix). This is the KNOWN POSITIVE: it proves
  // the two checks above are not vacuously trivial (a picker that always
  // returned null, or a broken classify(), would also show 0 far draws).
  {
    __resetBankSeen();
    let far = 0;
    const farByWindow: number[] = [];
    let windowFar = 0;
    for (let i = 0; i < 2000; i++) {
      const domain = pickScenarioDomainExcluding(undefined);
      const sc = bankScenario(FALLBACK_GAME, domain); // no override => module-global `seen`, unscoped
      const c = classify(bandOfPick(sc));
      if (c === 'far') { far++; windowFar++; }
      if ((i + 1) % 200 === 0) { farByWindow.push(windowFar); windowFar = 0; }
    }
    __resetBankSeen(); // leave the module-global seen clean for any test that runs after this one
    check('UNSCOPED (pre-fix shape) accumulation DOES eventually produce far-band draws — proves the scoped checks above are not vacuous',
      far > 0, `far=${far} across 2000 unscoped draws, per-200-window far counts=${JSON.stringify(farByWindow)}`);
  }

  // STRUCTURAL GUARD on server.ts's own call site: the two unit checks above
  // prove `bankScenario`/`bankScenarioAvoiding` are CAPABLE of per-request
  // scoping, not that the hosted caller actually exercises that capability —
  // that wiring lives in server.ts, outside this browser-safe file's import
  // graph (server.ts is Node/SDK-bound). Pin the exact shape: a FRESH `Set`
  // passed on every non-desktop request, `undefined` (module-global
  // singleton, unchanged) on desktop.
  {
    const src = readFileSync('server.ts', 'utf8');
    const idx = src.indexOf('const hostedFallbackSeen');
    check('server.ts must define hostedFallbackSeen at its bank-fallback call site', idx > 0);
    const line = src.slice(idx, src.indexOf('\n', idx));
    check('hostedFallbackSeen must gate on IS_ELECTRON and hand HOSTED requests a FRESH Set',
      /process\.env\.IS_ELECTRON === "true"\s*\?\s*undefined\s*:\s*new Set<string>\(\)/.test(line),
      `got: ${JSON.stringify(line)}`);
    const callSiteBlock = src.slice(idx, idx + 400);
    check('server.ts must actually PASS hostedFallbackSeen into both bank calls at the fallback call site, not just define it',
      /bankScenarioAvoiding\(payoffs, fallbackDomain, avoid\.name, hostedFallbackSeen\)/.test(callSiteBlock)
      && /bankScenario\(payoffs, fallbackDomain, hostedFallbackSeen\)/.test(callSiteBlock),
      callSiteBlock);
  }
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
  /**
   * THE PROBE SET WAS THREE GAMES AND ALL THREE WERE THE SAME SHAPE.
   *
   * All three were zero-sum-ish, so no probe was COMMON-INTEREST — and
   * `validateScenario`'s rivalry rule fires only on a common-interest matrix.
   * 19 shipped rows are rejected on that shape and this test printed "all 2505
   * SHIPPED rows load and still pass today's gates" anyway. It was not a weak
   * assertion; it was an assertion that could not fail for a whole family of
   * rules, and the family it could not see contains the plain pure-coordination
   * game and the all-zero matrix a user gets by clearing every payoff field.
   *
   * `SERVE_PROBES` is now shared with `_gen/bank_build.ts` rather than written
   * twice. That matters more than it looks: the build and the re-screen must ask
   * the same question, and two lists drift silently — every row would still look
   * verified. See its comment in scenarioBank.ts for why it is not band-scoped.
   *
   * WHAT ELSE THIS RE-SCREEN WAS BLIND TO. `bank_build.ts` filters with THREE
   * production gates plus six teacher screens plus two bank screens; this test
   * re-ran TWO of them. `validateProseDirections` was never re-run, and neither
   * were the screens — so the "when a gate tightens, rows screened by the old
   * gate keep shipping until something re-screens them" guarantee in the comment
   * above did not cover most of what does the screening. All of it runs here now.
   *
   * `validateProseDirections` is INERT on this artifact today and is expected to
   * be: a description that has passed `scenarioIsClaimFree` has no directional
   * claim left to check (measured 0 of 2,505 across 46 games, and separately 0
   * across 300 random games on colliding-label, already-shipped and control
   * subsets). It is here as staleness insurance, not because it currently earns
   * its keep — and that zero means "the vocabulary is not there", not "the
   * artifact is safe".
   */
  const probes: GamePayoffs[] = SERVE_PROBES;
  let bad = 0; let firstBad = '';
  for (const e of allBankRows()) {
    if (!e.s?.name || !e.s.description || typeof e.d !== 'string') {
      bad++; if (!firstBad) firstBad = `malformed row ${JSON.stringify(e).slice(0, 120)}`;
      continue;
    }
    const cf = scenarioIsClaimFree(e.s);
    if (!cf.ok) { bad++; if (!firstBad) firstBad = `"${e.s.name}" not claim-free: ${cf.reason}`; continue; }
    const labels = { row1: e.s.row1, row2: e.s.row2, col1: e.s.col1, col2: e.s.col2 };
    let rowBad = false;
    for (const g of probes) {
      const v = validateScenario(e.s, g);
      if (!v.ok) { rowBad = true; if (!firstBad) firstBad = `"${e.s.name}" fails validateScenario: ${v.issues[0]}`; break; }
      const dir = validateProseDirections(e.s.description ?? '', labels, g);
      if (dir.length) { rowBad = true; if (!firstBad) firstBad = `"${e.s.name}" fails validateProseDirections: ${dir[0]}`; break; }
    }
    if (rowBad) { bad++; continue; }
  }

  /**
   * THE PROBE SET MUST BE ABLE TO FAIL. A probe list is exactly the kind of
   * fixture that silently stops covering what it was written for — the previous
   * one did, for a whole family of rules — so a KNOWN-POSITIVE row is screened
   * through the same loop and must be rejected. Without this the section above
   * is green whether or not the probes reach anything.
   */
  {
    const planted = {
      name: 'Route Contract', row1: 'Firm Bid', row2: 'Lean Bid', col1: 'Priority Bid', col2: 'Flexible Bid',
      description: 'Two courier companies are competing for a season-long delivery route contract. '
        + 'The first chooses between a Firm Bid and a Lean Bid, while the second weighs a Priority Bid against a Flexible Bid.',
    } as BankEntry['s'];
    const caught = probes.some((g) => validateScenario(planted, g).issues
      .some((i) => i.includes('frames the two players as rivals')));
    check('the probe set still reaches the rivalry rule (known-positive)', caught,
      'a description framing the parties as rivals must be rejected on at least one probe — if not, the probe set no longer covers the common-interest branch and the re-screen above cannot fail');
  }
  check('every shipped bank row still passes the live gates', bad === 0,
    `${bad} of ${size} shipped rows fail today's gates — the artifact is stale, rebuild it with _gen/bank_build.ts. First: ${firstBad}`);

  /**
   * ACTOR-NOUN RE-SCREEN (BLUE-NOUNS-8 phase 3, 2026-09-03). `actorNounsOk`
   * is the SAME predicate `_gen/bank_actor_nouns_merge.ts` applies before
   * writing a noun into the artifact — this loop re-runs it here for the
   * identical reason the story gates above are re-run rather than trusted:
   * the artifact is frozen at build time, the predicate is not, and a row
   * that passed when it was merged must still pass today.
   */
  /**
   * A REUSABLE function, not an inline loop, so the SAME skip logic that
   * screens the shipped artifact can also be run against a small planted
   * array below — the same "the probe set must be able to fail" reasoning
   * as the rivalry-rule fixture two blocks up, applied to this loop's own
   * skip condition specifically (CodeRabbit, phase 3 review: `== null`, not
   * a bare falsy check — `''`/0/false must reach `actorNounsOk` and be
   * REJECTED, not silently skipped as an honest "nothing declared" row).
   */
  function screenNounRows(rows: readonly BankEntry[]): { bad: number; scanned: number; firstBad: string } {
    let bad = 0; let scanned = 0; let firstBad = '';
    for (const e of rows) {
      if (e.s?.actorA == null && e.s?.actorB == null) continue;
      scanned++;
      if (!actorNounsOk(e.s)) {
        bad++;
        if (!firstBad) firstBad = `"${e.s.name}" actorA=${JSON.stringify(e.s.actorA)} actorB=${JSON.stringify(e.s.actorB)}`;
      }
    }
    return { bad, scanned, firstBad };
  }

  const shipped = screenNounRows(allBankRows());
  check('every shipped row carrying actorA/actorB still passes actorNounsOk', shipped.bad === 0,
    `${shipped.bad} of ${shipped.scanned} noun-bearing rows fail actorNounsOk — the artifact is stale, re-run _gen/bank_actor_nouns_merge.ts. First: ${shipped.firstBad}`);

  /**
   * KNOWN-POSITIVE for the skip condition itself: a malformed `actorA: ''`
   * is FALSY, so the pre-fix `!e.s?.actorA && !e.s?.actorB` skip would have
   * `continue`d past it without ever calling `actorNounsOk` — a malformed
   * row shipping silently uncaught. Run through the real `screenNounRows`
   * (not a hand-derived assertion), so reverting the `== null` fix makes
   * THIS check fail, not merely a description of what the fix does.
   */
  {
    const planted: BankEntry[] = [{
      d: 'test', b: 0,
      s: { name: 'Malformed Actor Row', row1: 'Firm Bid', row2: 'Lean Bid', col1: 'Priority Bid', col2: 'Flexible Bid',
        description: 'A regional freight broker chooses a Firm Bid or a Lean Bid, and a dockside contractor chooses a Priority Bid or a Flexible Bid.',
        actorA: '' as never, actorB: null },
    }];
    const r = screenNounRows(planted);
    check('a malformed actorA of "" is scanned (not skipped) and rejected by actorNounsOk',
      r.scanned === 1 && r.bad === 1,
      `scanned=${r.scanned} bad=${r.bad} — a falsy-but-present actorA must reach actorNounsOk, not be treated as "nothing declared"`);
  }

  /**
   * KNOWN-POSITIVE, same reason as the rivalry-rule fixture two blocks up: a
   * predicate this file trusts must be able to fail, checked with a planted
   * violation of EACH bar `actorNounsOk` enforces, isolated one at a time (a
   * fixture combining two violations could not tell a caller which rule
   * broke, and could not detect one rule silently stopping — same "isolating
   * fixtures" lesson as everywhere else in this project).
   */
  {
    const base = { row1: 'Firm Bid', row2: 'Lean Bid', col1: 'Priority Bid', col2: 'Flexible Bid',
      description: 'A regional freight broker, also called the broker or the freight agent, chooses a Firm Bid or a Lean Bid. A dockside contractor chooses a Priority Bid or a Flexible Bid.' };
    check('actorNounsOk: a non-verbatim noun is rejected',
      !actorNounsOk({ ...base, actorA: ['a shipping magnate'], actorB: null }));
    check('actorNounsOk: a noun claimed by both players is rejected',
      !actorNounsOk({ ...base, actorA: ['a regional freight broker'], actorB: ['a regional freight broker'] }));
    check('actorNounsOk: a noun equal to an option label is rejected',
      !actorNounsOk({ ...base, actorA: ['Firm Bid'], actorB: null }));
    check('actorNounsOk: more than 3 nouns for one player is rejected',
      !actorNounsOk({ ...base, actorA: ['a regional freight broker', 'the broker', 'the freight agent', 'A regional freight broker'], actorB: null }));
    check('actorNounsOk: a malformed shape (bare string, not array) is rejected',
      !actorNounsOk({ ...base, actorA: 'a regional freight broker' as never, actorB: null }));
    check('actorNounsOk: a single-character noun is rejected',
      !actorNounsOk({ ...base, actorA: ['a'], actorB: null }));
    // CodeRabbit (phase 3 review): the length floor must apply to the
    // NORMALIZED string, not the raw one — a zero-width space survives
    // `.trim()` (not whitespace) but is stripped by `norm`, so "​a" is 2
    // raw characters and 1 real one.
    check('actorNounsOk: a zero-width-prefixed single-character noun is rejected',
      !actorNounsOk({ ...base, actorA: ['​a'], actorB: null }));
    // Bank phase-3 real defect (2026-09-03 backfill hand-read, 5 shipped
    // rows): a noun naming BOTH parties at once ("the upstream and
    // downstream lock-keepers", "Two neighboring orchard operators")
    // assigned to only one player — colouring it as A's claims B's half too.
    const compoundBase = { row1: 'Keep Slot', row2: 'Shift Slot', col1: 'Early Slot', col2: 'Late Slot' };
    // ISOLATED from the symmetric-framing rule below on purpose — neither
    // description here contains "each"/"both", so a mutant that deletes the
    // COMPOUND check cannot hide behind the other rule also firing (the
    // "isolating fixtures" lesson: a fixture carrying two defect signals
    // cannot fail when only one rule is deleted).
    check('actorNounsOk: a noun containing "and" (compound, both parties) is rejected',
      !actorNounsOk({ ...compoundBase, actorB: null,
        description: 'The north and south ferry operators share a lightly used crossing, choosing Keep Slot or Shift Slot for their combined schedule against a harbour scheduler picking Early Slot or Late Slot.',
        actorA: ['the north and south ferry operators'] }));
    check('actorNounsOk: a noun starting with "Two" is rejected',
      !actorNounsOk({ ...compoundBase, actorB: null,
        description: 'Two small ferry operators run a lightly used crossing, choosing Keep Slot or Shift Slot for their schedule against a harbour scheduler picking Early Slot or Late Slot.',
        actorA: ['Two small ferry operators'] }));
    // Same real defect, subtler shape (11 more shipped rows): a PLAIN plural
    // collective noun with no "and"/"two" in it, assigned to one side of a
    // description that names both players symmetrically via "each"/"both".
    // ISOLATED from the COMPOUND rule above: "ferry operators" alone matches
    // neither /\btwo\b/ nor /\band\b/, so only the symmetric-framing rule can
    // be catching this one.
    check('actorNounsOk: a plain collective noun on one side of a symmetric "each" description is rejected',
      !actorNounsOk({ ...compoundBase, actorA: ['ferry operators'], actorB: null,
        description: 'Two small ferry operators share a lightly used crossing. Each chooses either Keep Slot or Shift Slot for its own service, while the other chooses Early Slot or Late Slot.' }));
    check('actorNounsOk: the SAME collective noun is accepted when the description is not symmetric ("each"/"both" absent) — the rule keys on the framing, not the noun alone',
      actorNounsOk({ ...compoundBase, actorA: ['ferry operators'], actorB: null,
        description: 'The ferry operators run a lightly used crossing. The operator chooses Keep Slot or Shift Slot, while the harbour scheduler chooses Early Slot or Late Slot.' }));
    // H5 handoff (2026-09-04): the looser no-noun re-attempt pass surfaced two
    // MORE symmetric-framing markers the "each"/"both" test missed, same defect
    // class — a collective noun on one side while the two parties are
    // distinguished only POSITIONALLY. Real rows: idx 257 ("orchard keepers",
    // "One chooses... the other chooses") and idx 1965 ("lock-keepers", "The
    // first chooses... the second chooses"). ISOLATED: neither description below
    // contains "each"/"both", so a mutant that deletes ONLY the new markers (and
    // keeps the each|both branch) still fails exactly these.
    check('actorNounsOk: a collective noun on one side of a "One... the other" description is rejected',
      !actorNounsOk({ ...compoundBase, actorA: ['orchard keepers'], actorB: null,
        description: 'Two neighboring orchard keepers coordinate a frost watch. One chooses Keep Slot or Shift Slot, while the other chooses Early Slot or Late Slot.' }));
    check('actorNounsOk: a collective noun on one side of a "The first... the second" description is rejected',
      !actorNounsOk({ ...compoundBase, actorA: ['lock-keepers'], actorB: null,
        description: 'Two lock-keepers arrange their shifts. The first chooses Keep Slot or Shift Slot, while the second chooses Early Slot or Late Slot.' }));
    check('actorNounsOk: one/other actor noun phrases still count as symmetric framing',
      !actorNounsOk({ ...compoundBase, actorA: ['orchard keepers'], actorB: null,
        description: 'Two orchard keepers coordinate a frost watch. One orchard keeper chooses Keep Slot or Shift Slot, while the other orchard keeper chooses Early Slot or Late Slot.' }));
    check('actorNounsOk: first/second actor noun phrases still count as symmetric framing',
      !actorNounsOk({ ...compoundBase, actorA: ['lock-keepers'], actorB: null,
        description: 'Two lock-keepers arrange their shifts. The first canal lock-keeper chooses Keep Slot or Shift Slot, while the second canal lock-keeper chooses Early Slot or Late Slot.' }));
    // Positive control for the new markers specifically: "the other"/"first"+
    // "second" absent AND a genuine distinct pair — must stay accepted so the
    // new branch cannot silently reject legitimate two-sided rows.
    check('actorNounsOk: a distinct pair with no positional-framing markers is accepted (new-marker positive control)',
      actorNounsOk({ ...compoundBase, actorA: ['the harbour scheduler'], actorB: ['the ferry operator'],
        description: 'The harbour scheduler chooses Keep Slot or Shift Slot, while the ferry operator chooses Early Slot or Late Slot.' }));
    // CodeRabbit (H5 review): positional words can describe OPTIONS rather than
    // actors. The pre-fix broad phrase checks rejected this valid one-sided
    // declaration even though none of first/second/other is a choosing subject.
    check('actorNounsOk: first/second/other option wording is not mistaken for symmetric actor framing',
      actorNounsOk({ ...compoundBase, actorA: ['The harbour scheduler'], actorB: null,
        description: 'The harbour scheduler compares the first option with the second, then chooses Keep Slot rather than the other option; a ferry operator chooses Early Slot or Late Slot.' }));
    // CodeRabbit (phase 3 review): both regex checks above must run on the
    // NORMALIZED text — a zero-width character breaks the contiguous letters
    // a raw regex needs to match "and"/"each", the same bypass class the
    // verbatim/length check was already fixed against a review round ago.
    check('actorNounsOk: a zero-width character inside "and" still triggers the COMPOUND rejection',
      !actorNounsOk({ ...compoundBase, actorB: null,
        description: 'The north and south ferry operators share a lightly used crossing, choosing Keep Slot or Shift Slot for their combined schedule against a harbour scheduler picking Early Slot or Late Slot.',
        actorA: ['the north a​nd south ferry operators'] }));
    check('actorNounsOk: a zero-width character inside "each" still triggers the symmetric-framing rejection',
      !actorNounsOk({ ...compoundBase, actorA: ['ferry operators'], actorB: null,
        description: 'Two small ferry operators share a lightly used crossing. Ea​ch chooses either Keep Slot or Shift Slot for its own service, while the other chooses Early Slot or Late Slot.' }));
    check('actorNounsOk: a real, clean pair is accepted (positive control)',
      actorNounsOk({ ...base, actorA: ['a regional freight broker'], actorB: ['a dockside contractor'] }));
    check('actorNounsOk: no declaration at all is accepted (silence is safe)',
      actorNounsOk({ ...base, actorA: null, actorB: undefined }));

    /**
     * LITERAL-SUBSTRING GUARD (RED-REGEN-2/001, director-reproduced
     * 2026-09-04). The normalized "verbatim" check above accepts a noun that
     * is only NFKC- or zero-width-equal to the description, not a literal
     * substring of it — but `ColorCoded.tsx` highlights by matching the RAW
     * noun against the RAW description (no `.normalize()`, no zero-width
     * strip). Such a noun ships, and even gets kept as a colour-term chip,
     * but never actually highlights: silent breakage of the field's whole
     * purpose. These two fixtures are the red's EXACT reproduction strings
     * (server-run2-fe45c49.log) — both must now be rejected.
     */
    {
      const zwspNoun = 'A far' + '​' + 'mer'; // zero-width space spliced into "farmer"
      check('actorNounsOk: a noun that only normalized-matches via a zero-width character is rejected (RED-REGEN-2/001)',
        !actorNounsOk({
          row1: 'Plant Early', row2: 'Plant Late', col1: 'Harvest Soon', col2: 'Harvest Late',
          description: 'A farmer chooses when to plant a plot, while a rival grower down the road decides when to harvest theirs.',
          actorA: [zwspNoun], actorB: ['a rival grower'],
        }));
      const nfkcNoun = 'Ａ ｇｒａｉｎ ｔｒａｄｅｒ'; // fullwidth Latin, NFKC-normalizes to "A grain trader"
      check('actorNounsOk: a noun that only normalized-matches via NFKC fullwidth-Latin folding is rejected (RED-REGEN-2/001)',
        !actorNounsOk({
          row1: 'Ship Now', row2: 'Ship Later', col1: 'Buy Now', col2: 'Buy Later',
          description: 'A grain trader and a mill buyer negotiate the timing of a shipment.',
          actorA: [nfkcNoun], actorB: null,
        }));
      // Positive control: the SAME noun, but literally present in the
      // description (no zero-width char, no fullwidth folding needed) — must
      // still be accepted, so the new guard cannot be rejecting on some other
      // property of these fixtures (e.g. their punctuation or length).
      check('actorNounsOk: the plain, literal form of the same noun is still accepted (positive control for the new guard)',
        actorNounsOk({
          row1: 'Plant Early', row2: 'Plant Late', col1: 'Harvest Soon', col2: 'Harvest Late',
          description: 'A farmer chooses when to plant a plot, while a rival grower down the road decides when to harvest theirs.',
          actorA: ['A farmer'], actorB: ['a rival grower'],
        }));
    }
  }
}

// The exit check must be the LAST thing in the file. It was above the shipped-artifact
// section, so those assertions ran, printed, and could not fail the suite.
if (failures > 0) { console.error(`✗ scenario bank: ${failures} failed`); process.exit(1); }
console.log(`✓ scenario bank: bands match stakesHint, draws are without replacement and avoid a seen NAME, a cell with no unseen name widens by BAND before domain rather than repeating a title, an empty bank returns null, seeded picks are reproducible, and all ${bankSize()} SHIPPED rows load and still pass today's gates`);

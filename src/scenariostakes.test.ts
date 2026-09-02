/**
 * Stakes profile + prompt hint.
 *
 * Two things are asserted, because this round proved one is not enough:
 *
 *  1. KNOWN-POSITIVE FIXTURES — every band has a game that must land in it, so
 *     a band cannot silently become unreachable. Four guards this round were
 *     found structurally unable to fire.
 *  2. REACH — every band is measured against a large sweep of real games. A
 *     check that is correct but never meets its trigger reports a clean result
 *     forever (RED 1's fifth instance: a corrected gate with 0 of 341 draws
 *     matching its vocabulary). A band nothing reaches is a band that does not
 *     exist, and this test fails rather than let one ship.
 *
 * The hint must also never make a CLAIM. Rung 3 forbids the description from
 * asserting anything decidable, and a stakes line that leaked "A does better
 * here" would reintroduce exactly the defect rung 3 removes.
 */
import { describeStakes, stakesHint } from './utils/scenarioStakes';
import type { GamePayoffs } from './types';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const G = (a11: number, a12: number, a21: number, a22: number,
           b11: number, b12: number, b21: number, b22: number): GamePayoffs =>
  ({ a11, a12, a21, a22, b11, b12, b21, b22 });

/* ------------------------------------------------- the arithmetic, by hand */
{
  // Daniel's own example: one decision worth 100, another worth 0.001.
  const s = describeStakes(G(100, 0, 0, 0.001, 0, 100, 0.001, 0));
  check('example swingA', s.swingA === 100, `got ${s.swingA}`);
  check('example swing', s.swing === 100, `got ${s.swing}`);
  check('example lopsidedness is 1e5', Math.abs(s.lopsidedness - 100000) < 1, `got ${s.lopsidedness}`);
  check('example players are symmetric', s.playerGap === 1, `got ${s.playerGap}`);
  check('example has no irrelevant choice', !s.hasIrrelevantChoice);
}
{
  // Shifting one player's payoffs by a constant changes nothing strategically
  // and must change nothing here — the story should not move either.
  const base = G(3, -1, 0, 5, 2, 6, 4, -2);
  const shifted = G(3 + 40, -1 + 40, 0 + 40, 5 + 40, 2, 6, 4, -2);
  const a = describeStakes(base), b = describeStakes(shifted);
  check('shift-invariant', JSON.stringify(a) === JSON.stringify(b), JSON.stringify({ a, b }));
  // Scaling everything scales the arithmetic axis and leaves the geometric one.
  const scaled = describeStakes(G(30, -10, 0, 50, 20, 60, 40, -20));
  check('scale multiplies swing', Math.abs(scaled.swing - a.swing * 10) < 1e-9, `${scaled.swing} vs ${a.swing}`);
  check('scale leaves lopsidedness', Math.abs(scaled.lopsidedness - a.lopsidedness) < 1e-9,
    `${scaled.lopsidedness} vs ${a.lopsidedness}`);
}
{
  const flat = describeStakes(G(4, 4, 4, 4, 7, 7, 7, 7));
  check('flat game has zero swing', flat.swing === 0);
  check('flat game emits no hint at all', stakesHint(G(4, 4, 4, 4, 7, 7, 7, 7)) === '');
  const moot = describeStakes(G(5, 9, 5, 1, 2, 8, 3, 0));
  check('a choice that changes nothing is reported', moot.hasIrrelevantChoice);
  check('and not as an infinite ratio the caller must handle',
    moot.lopsidedness === Infinity && Number.isFinite(moot.swing));
}

/* --------------------------------------- known positives: every band fires
 *
 * SOFT STAKES (2026-09-02): the size line no longer fires on every call —
 * `pick() < SIZE_STRONG_P` gates it, and near a band cut it can reach for the
 * neighbouring band's wording instead. `() => 0` always clears the STRONG gate
 * (0 < SIZE_STRONG_P) and, for these deep-interior fixtures, is never even
 * consumed a second time — see the "boundary blend never touches deep-interior
 * fixtures" mutation check below, which proves that rather than assuming it.
 */
type Band = 'sub-unit' | 'modest' | 'substantial' | 'very large';
const sizeBand = (h: string): Band | null =>
  /Stakes lean tiny/.test(h) ? 'sub-unit'
  : /Stakes lean modest/.test(h) ? 'modest'
  : /Stakes lean substantial/.test(h) ? 'substantial'
  : /Stakes lean very large/.test(h) ? 'very large' : null;
const isNeutral = (h: string): boolean => /own logic/.test(h);
const SIZE_FIXTURES: Array<[Band, GamePayoffs]> = [
  ['sub-unit', G(0.4, 0, 0, 0.2, 0.3, 0, 0, 0.1)],
  ['modest', G(6, 0, 0, 3, 5, 0, 0, 2)],
  ['substantial', G(30, 0, 0, 20, 25, 0, 0, 15)],
  ['very large', G(90, 0, 0, 60, 80, 0, 0, 55)],
];
for (const [want, g] of SIZE_FIXTURES) {
  const got = sizeBand(stakesHint(g, () => 0));
  check(`size band "${want}" fires when the STRONG gate clears`, got === want, `got "${got}"`);
}

/* ------------------------------------------------- the STRONG gate is real
 * The whole point of the redesign: the size register must NOT be printed on
 * every call. `pick() >= SIZE_STRONG_P` must reach the neutral branch, which
 * says nothing about magnitude — this is what turns 20/20 blind-rank
 * separation into partial separation. A mutant that hard-codes the STRONG
 * branch (deletes the gate) passes every fixture above unchanged and only
 * this section catches it.
 */
{
  const g = SIZE_FIXTURES[3][1]; // very-large fixture; deep interior
  const strong = stakesHint(g, () => 0);
  const neutral = stakesHint(g, () => 0.999999);
  check('pick() just under SIZE_STRONG_P takes the graded branch', sizeBand(strong) === 'very large', strong);
  check('pick() at the top of the range takes the neutral branch', isNeutral(neutral), neutral);
  check('the neutral branch names no band', sizeBand(neutral) === null, neutral);
  check('the neutral branch still says nothing decidable',
    !/very large|substantial|modest|\btiny\b/.test(neutral), neutral);
}

/* --------------------------------------------------- boundary blend, honest
 * Near a band cut the STRONG branch can reach for the NEIGHBOURING band's
 * wording, ramping from 0 at the window's edge to 50/50 exactly on the cut.
 * `swing = 10` sits exactly on the modest/substantial cut (log10(10) = 1,
 * distance 0 from that boundary) — deliberately chosen so flipProb = 0.5 and
 * both a low and a high second draw are decisive.
 */
{
  const onCut = G(10, 0, 0, 5, 8, 0, 0, 4); // swing = 10, exactly the cut
  // pick() is a single sequence: the FIRST value must clear the STRONG gate
  // (< 0.6), the SECOND is the boundary-blend draw.
  const seq = (vals: number[]) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)]; };
  const exactStays = stakesHint(onCut, seq([0, 1]));    // blend draw 1, well above flipProb=0.5
  const lowBlend = stakesHint(onCut, seq([0, 0]));      // blend draw 0 < flipProb -> flips
  const highBlend = stakesHint(onCut, seq([0, 0.99]));  // blend draw 0.99, does not flip
  check('sanity: exactSizeBand(10) is substantial, not tiny/modest mixed up',
    sizeBand(exactStays) === 'substantial', exactStays);
  check('a low blend draw exactly on a cut reaches the band BELOW',
    sizeBand(lowBlend) === 'modest', lowBlend);
  check('a high blend draw exactly on a cut stays at the exact band',
    sizeBand(highBlend) === 'substantial', highBlend);
}
{
  // Deep-interior fixtures must NEVER pay for a second pick() call — this is
  // what protects the #55 arithmetic-axis magnitudes (their log-distance from
  // every cut is 0.222-0.398, all outside the 0.15 window) from the blend.
  // A poisoned generator that throws on a second call turns "never consumed"
  // into a hard failure rather than a coincidence of what the second value
  // happened to be.
  let calls = 0;
  const poisoned = () => { calls++; if (calls > 1) throw new Error('blendedSizeBand consumed a second draw for a deep-interior swing'); return 0; };
  for (const [, g] of SIZE_FIXTURES) {
    calls = 0;
    let threw = false;
    try { stakesHint(g, poisoned); } catch { threw = true; }
    check('a deep-interior fixture never consumes a second pick() call', !threw);
  }
}

/* -------------------------------------------------------------- determinism
 * `pick` is injectable exactly like `pickScenarioDomain`/`pickFromBank`, so a
 * seeded caller (a future NASH_REPRODUCIBLE mode) gets a BYTE-IDENTICAL hint
 * for the same (game, seed) sequence — required by this round's brief.
 * Mutation check: a stub that returns a fresh Math.random() each call (i.e.
 * genuinely ignores its own state) would fail the repeat-call assertion; a
 * `pick` that closes over real seeded state passes it.
 */
{
  const mulberry32 = (a: number) => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const g = G(7, -3, 2, 9, -4, 6, 1, -8);
  let sawStrong = false, sawNeutral = false, mismatched = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const first = stakesHint(g, mulberry32(seed));
    const repeat = stakesHint(g, mulberry32(seed));
    if (first !== repeat) mismatched++;
    if (isNeutral(first)) sawNeutral = true; else if (sizeBand(first)) sawStrong = true;
  }
  check('every one of 200 seeds reproduces byte-identically on repeat', mismatched === 0, `${mismatched}/200 mismatched`);
  check('the same 200-seed sweep actually visits the STRONG branch', sawStrong);
  check('and actually visits the NEUTRAL branch (not silently still deterministic)', sawNeutral);
}

/* ---------------------------------------------------------- the mix, measured
 * SIZE_STRONG_P is a design constant, not a decoration — assert its empirical
 * rate rather than trust the literal. A deterministic seeded sweep so the
 * assertion itself is reproducible.
 */
{
  let seed = 424242;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const g = G(90, 0, 0, 60, 80, 0, 0, 55); // very-large fixture, deep interior
  const N = 4000;
  let strongCount = 0;
  for (let i = 0; i < N; i++) if (sizeBand(stakesHint(g, rand)) !== null) strongCount++;
  const rate = strongCount / N;
  check('the STRONG rate matches SIZE_STRONG_P (0.6) within sampling noise',
    Math.abs(rate - 0.6) < 0.05, `measured ${rate.toFixed(3)} over ${N} draws`);
}
// The CONTINGENT geometric clauses stay out. Blind rating found no effect for
// the lopsidedness line (p=0.37 against p=0.0006 for the arithmetic ones), and
// the reason is structural: that ratio compares A's swing against B's column 1
// with A's swing against column 2, so the fact is conditional — exactly the
// shape `scenarioIsClaimFree` rejects. `playerGap` is different and IS in: it
// describes who the parties are rather than claiming anything about a cell, and
// it measured 93% vs 46% at the shipping threshold (p=0.0003). This asserts the
// unmeasured ones stay out, so re-adding one without measuring it fails here.
for (const [why, g] of [
  ['extreme lopsidedness', G(100, 0, 0, 0.001, 0, 100, 0.001, 0)],
  ['a moot choice', G(5, 9, 5, 1, 2, 8, 3, 0)],
] as Array<[string, GamePayoffs]>) {
  // Forced STRONG (`() => 0`): this checks WHICH clauses the line can contain
  // when it fires, not whether it fires — that is the section above.
  const h = stakesHint(g, () => 0);
  check(`no unmeasured geometric clause for ${why}`,
    !/times more|comparable weight|no difference whatsoever/.test(h), h.slice(0, 160));
  check(`${why} still gets its arithmetic line when STRONG`, sizeBand(h) !== null, h.slice(0, 80));
}
// describeStakes still computes the full profile — the hint just does not use
// the geometric half yet. Keep it correct so re-adding it is a prompt change.
check('playerGap still computed', describeStakes(G(50, 0, 0, 50, 1, 0, 0, 1)).playerGap === 50);
// The measured geometric line: fires above the cut, silent below it, and never
// without its prohibition — the prohibition is the half that holds the persona
// leak at 0/27, 0/26, 0/31. Naming the parties and forbidding the words beat
// referring to them positionally, which leaked bare letters at 10%.
{
  const above = stakesHint(G(50, 0, 0, 50, 1, 0, 0, 1));   // playerGap 50
  const below = stakesHint(G(50, 0, 0, 50, 30, 0, 0, 30)); // playerGap 1.67, the median
  check('playerGap line fires above the cut', /far more riding on this/.test(above), above.slice(0, 120));
  check('and carries its prohibition', /Never write "Player A"/.test(above));
  check('playerGap line is silent below the cut', !/far more riding/.test(below), below.slice(0, 120));
}
check('hasIrrelevantChoice still computed', describeStakes(G(5, 9, 5, 1, 2, 8, 3, 0)).hasIrrelevantChoice);

/* -------------------------------------------------------- no claims, ever */
{
  // The hint is prepended to a prompt that forbids the description from
  // asserting anything decidable. It must not smuggle one in itself.
  const CLAIM_WORDS = /\b(equilibri\w*|dominan\w*|best response|should choose|will choose|better off|prefers?|optimal|wins?|loses?)\b/i;
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  // A SEPARATE seeded stream drives `pick`, so this test is reproducible
  // end-to-end rather than depending on the real Math.random default — the
  // stream must visit BOTH branches for the claim below to mean anything.
  let pickSeed = 71;
  const pick = () => { pickSeed = (pickSeed * 1103515245 + 12345) & 0x7fffffff; return pickSeed / 0x7fffffff; };
  let claims = 0, digits = 0;
  for (let i = 0; i < 20000; i++) {
    const p = () => Math.round((rand() * 200 - 100) * 1000) / 1000;
    const h = stakesHint(G(p(), p(), p(), p(), p(), p(), p(), p()), pick);
    if (CLAIM_WORDS.test(h)) claims++;
    // With the geometric clauses gone the hint contains NO figures at all, so
    // this is now an absolute check rather than one with an exemption.
    if (/\d/.test(h)) digits++;
  }
  check('hint never makes a decidable claim', claims === 0, `${claims}/20000`);
  check('hint never leaks a payoff figure', digits === 0, `${digits}/20000`);
}

/* ------------------------------------------------------------------ reach */
{
  let seed = 99;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let pickSeed = 991;
  const pick = () => { pickSeed = (pickSeed * 1103515245 + 12345) & 0x7fffffff; return pickSeed / 0x7fffffff; };
  const seen: Record<string, number> = {};
  let neutral = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    // Mixed scales, because a single scale would leave the size bands at the
    // other end of the range unreachable and the reach check would pass anyway.
    const mag = [0.5, 5, 30, 100][i % 4];
    const p = () => Math.round((rand() * 2 - 1) * mag * 1000) / 1000;
    const h = stakesHint(G(p(), p(), p(), p(), p(), p(), p(), p()), pick);
    const b = sizeBand(h);
    if (b) seen[b] = (seen[b] ?? 0) + 1;
    else if (isNeutral(h)) neutral++;
  }
  // "Reachable" is deliberately a low bar (0.1%): the point is to catch a band
  // that is DEAD, not to legislate a distribution.
  for (const band of ['sub-unit', 'modest', 'substantial', 'very large']) {
    const n = seen[band] ?? 0;
    check(`band "${band}" is reachable on real games`, n >= N / 1000, `${n}/${N} — nothing reaches it`);
  }
  // The neutral branch must ALSO be reachable in real play — a dead neutral
  // branch would mean SIZE_STRONG_P is silently 1.0 again.
  check('the neutral (no-register) branch is reachable', neutral >= N / 1000, `${neutral}/${N}`);
  const pct = (k: string) => `${k} ${(100 * (seen[k] ?? 0) / N).toFixed(1)}%`;
  console.log('  reach: ' + ['sub-unit', 'modest', 'substantial', 'very large'].map(pct).join(', ')
    + `, neutral ${(100 * neutral / N).toFixed(1)}%`);
}

/* ------------------------------------------------------ length is a defect */
// The first draft of this hint cost 7.5% of cloud invention yield — 9 of 120
// calls returned `max-tokens` against 0 of 120 without it (p=0.0033) — because
// a subset of calls spent the whole 8192 budget reasoning about a long
// instruction. Output the user never receives is worse than output that could
// have been better, so the length is now a guarded property and not a matter
// of taste.
{
  let seed = 3;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let pickSeed = 31;
  const pick = () => { pickSeed = (pickSeed * 1103515245 + 12345) & 0x7fffffff; return pickSeed / 0x7fffffff; };
  let longest = 0, longestNoGap = 0;
  for (let i = 0; i < 5000; i++) {
    const mag = [0.5, 5, 30, 100][i % 4];
    const p = () => Math.round((rand() * 2 - 1) * mag * 1000) / 1000;
    const h = stakesHint(G(p(), p(), p(), p(), p(), p(), p(), p()), pick);
    longest = Math.max(longest, h.length);
    if (!/far more riding/.test(h)) longestNoGap = Math.max(longestNoGap, h.length);
  }
  // Two budgets, because the two lines have different measured costs. The SIZE
  // line is on every call, so it stays tight. The playerGap line fires on 11.6%
  // of games and its yield cost was measured directly across three thresholds
  // (1, 2 and 1 lost draws, all max-tokens, with the CONTROL losing 2 at gap=4
  // — so the loss is not clean-attributable to it), which buys it more room.
  // SOFT STAKES (2026-09-02) made the SIZE branch itself shorter (dropped the
  // second imperative sentence: 95 chars longest vs 150+ before), so the
  // no-gap bound (header + size + trailer, no gap line) tightens with it —
  // measured worst case 160 (34 header + 95 size + a few trailer/space
  // chars over 33 due to the possessive apostrophe's byte width).
  check('the always-on size line stays short', longestNoGap <= 180, `longest ${longestNoGap} chars`);
  check('the full hint stays bounded', longest <= 400, `longest ${longest} chars`);
}

/* ------------------------------------------------------- exposure DIRECTION
 * The gap line must say WHICH party is exposed, not merely that one is.
 *
 * It used to read "...or the reverse", which announces an asymmetry while
 * withholding its direction — and had to, because `playerGap` is
 * max(swing)/min(swing), a ratio that discards direction by construction. The
 * model therefore guessed, and a red team measured the guess against the
 * story's OWN game: 38% agreement on swing, 53% on range, 44% wrong under both,
 * and every confirmed instance named the ROW party. The "reverse" was never
 * taken.
 *
 * Measured on the real production path, paired on the same games, hand-read:
 * on games where the COLUMN party is the exposed one, the new wording named it
 * correctly 21/21 while the old wording managed 0/7 in the control (2 of those
 * stated no asymmetry at all, and all 5 that did named the row party) —
 * consistent with the red team's independent 0/32.
 *
 * The forced-choice evidence for shipping this line at all was a RANKING task,
 * so it could not have caught this: a story can rank correctly for gap SIZE
 * while pointing at the wrong party.
 */
{
  const exposed = (a: number, b: number): GamePayoffs => ({
    a11: a, a12: -a, a21: -a * 0.6, a22: a * 0.9,
    b11: b, b12: -b, b21: -b * 0.9, b22: b * 0.95,
  });
  const rowBig = exposed(200, 2);
  const colBig = exposed(2, 200);

  check('the gap line names Player A when the ROW party is the exposed one',
    /Player A has far more riding on this than Player B/.test(stakesHint(rowBig)),
    stakesHint(rowBig).slice(0, 200));
  check('the gap line names Player B when the COLUMN party is the exposed one',
    /Player B has far more riding on this than Player A/.test(stakesHint(colBig)),
    stakesHint(colBig).slice(0, 200));
  check('the direction is never left to the model',
    !/or the reverse/i.test(stakesHint(rowBig)) && !/or the reverse/i.test(stakesHint(colBig)),
    'the hint must not announce an asymmetry without saying which way it runs');
  // The persona prohibition is load-bearing and measured (0/27, 0/26, 0/31) —
  // rewording the direction must not drop it.
  for (const g of [rowBig, colBig]) {
    check('the persona prohibition survives the rewording',
      /Never write "Player A", "Player B", "the players" or a bare letter/.test(stakesHint(g)),
      stakesHint(g).slice(0, 200));
  }
  // Sub-threshold games must be untouched: the extra sentence is paid only by
  // the ~1 game in 9 that gets the benefit.
  const flat = exposed(10, 10);
  check('a game below the gap threshold carries no gap line at all',
    !/riding on this/.test(stakesHint(flat)), stakesHint(flat).slice(0, 160));

  // Direction must follow the swings across a sweep, not just two fixtures.
  let wrong = 0;
  for (let i = 1; i <= 60; i++) {
    const g = i % 2 ? exposed(4 * i, 1) : exposed(1, 4 * i);
    const s = describeStakes(g);
    if (!(s.playerGap >= 4)) continue;
    const h = stakesHint(g);
    const namesA = /Player A has far more riding/.test(h);
    if (namesA !== (s.swingA >= s.swingB)) wrong++;
  }
  check('direction tracks the swings across a sweep', wrong === 0,
    `${wrong} hints named the party the matrix contradicts`);

  // INFINITE ASYMMETRY — the strongest case, and it used to be the only one
  // excluded. `playerGap` is Infinity when the smaller swing is exactly 0, and
  // the old `Number.isFinite` guard dropped exactly those games (0.55% of random
  // games over a 200,000-game sweep) while a 4x gap still got the line.
  const onlyASwings: GamePayoffs = { a11: 5, a12: -5, a21: -3, a22: 4, b11: 2, b12: 2, b21: 2, b22: 2 };
  const onlyBSwings: GamePayoffs = { a11: 2, a12: 2, a21: 2, a22: 2, b11: 5, b12: -5, b21: -3, b22: 4 };
  const neitherSwings: GamePayoffs = { a11: 1, a12: 1, a21: 1, a22: 1, b11: 3, b12: 3, b21: 3, b22: 3 };
  check('a party whose choice does NOTHING is the maximal asymmetry, and fires',
    /Player A has far more riding on this than Player B/.test(stakesHint(onlyASwings)),
    stakesHint(onlyASwings).slice(0, 180));
  check('and it fires in the other direction too',
    /Player B has far more riding on this than Player A/.test(stakesHint(onlyBSwings)),
    stakesHint(onlyBSwings).slice(0, 180));
  // A game where NEITHER choice matters must claim no asymmetry. NOTE WHAT THIS
  // DOES AND DOES NOT TEST: it passes because `stakesHint` returns an empty
  // string for a game with no stakes at all, NOT because of anything in the gap
  // logic. I originally guarded the gap branch against this case and asserted
  // the guard here; mutation testing showed deleting the guard changed nothing,
  // because an all-flat game never reaches that branch. The guard was removed as
  // dead code and this check is kept for what it actually covers — the early
  // return — with the distinction written down so nobody reads it as gap coverage.
  check('a game where NEITHER choice matters claims no asymmetry (via the empty hint)',
    stakesHint(neitherSwings) === '',
    JSON.stringify(stakesHint(neitherSwings)));
}

// The exit check stays LAST in the file.
if (failures > 0) { console.error(`✗ scenario stakes: ${failures} failed`); process.exit(1); }
console.log('✓ scenario stakes: shift-invariant, scale-covariant, every surviving band has a known-positive fixture and measured reach, the unmeasured geometric clauses stay out, 20k hints carry no claim and no leaked figure, and the exposure line names WHICH party is exposed');

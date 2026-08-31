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

/* --------------------------------------- known positives: every band fires */
type Band = 'sub-unit' | 'modest' | 'substantial' | 'very large';
const sizeBand = (h: string): Band | null =>
  /smaller than a single unit/.test(h) ? 'sub-unit'
  : /amounts at stake are modest/.test(h) ? 'modest'
  : /amounts at stake are substantial/.test(h) ? 'substantial'
  : /amounts at stake are very large/.test(h) ? 'very large' : null;
const SIZE_FIXTURES: Array<[Band, GamePayoffs]> = [
  ['sub-unit', G(0.4, 0, 0, 0.2, 0.3, 0, 0, 0.1)],
  ['modest', G(6, 0, 0, 3, 5, 0, 0, 2)],
  ['substantial', G(30, 0, 0, 20, 25, 0, 0, 15)],
  ['very large', G(90, 0, 0, 60, 80, 0, 0, 55)],
];
for (const [want, g] of SIZE_FIXTURES) {
  const got = sizeBand(stakesHint(g));
  check(`size band "${want}" fires`, got === want, `got "${got}"`);
}
// The geometric clauses were REMOVED after blind rating found no effect
// (p=0.37 against p=0.0006 for the arithmetic ones). Assert their absence, so
// re-adding one without re-measuring fails here rather than shipping quietly.
for (const [why, g] of [
  ['extreme lopsidedness', G(100, 0, 0, 0.001, 0, 100, 0.001, 0)],
  ['a moot choice', G(5, 9, 5, 1, 2, 8, 3, 0)],
  ['a one-sided exposure', G(50, 0, 0, 50, 1, 0, 0, 1)],
] as Array<[string, GamePayoffs]>) {
  const h = stakesHint(g);
  check(`no unmeasured geometric clause for ${why}`,
    !/times more|comparable weight|no difference whatsoever|riding on this/.test(h), h.slice(0, 160));
  check(`${why} still gets its arithmetic line`, sizeBand(h) !== null, h.slice(0, 80));
}
// describeStakes still computes the full profile — the hint just does not use
// the geometric half yet. Keep it correct so re-adding it is a prompt change.
check('playerGap still computed', describeStakes(G(50, 0, 0, 50, 1, 0, 0, 1)).playerGap === 50);
check('hasIrrelevantChoice still computed', describeStakes(G(5, 9, 5, 1, 2, 8, 3, 0)).hasIrrelevantChoice);

/* -------------------------------------------------------- no claims, ever */
{
  // The hint is prepended to a prompt that forbids the description from
  // asserting anything decidable. It must not smuggle one in itself.
  const CLAIM_WORDS = /\b(equilibri\w*|dominan\w*|best response|should choose|will choose|better off|prefers?|optimal|wins?|loses?)\b/i;
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let claims = 0, digits = 0;
  for (let i = 0; i < 20000; i++) {
    const p = () => Math.round((rand() * 200 - 100) * 1000) / 1000;
    const h = stakesHint(G(p(), p(), p(), p(), p(), p(), p(), p()));
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
  const seen: Record<string, number> = {};
  const N = 20000;
  for (let i = 0; i < N; i++) {
    // Mixed scales, because a single scale would leave the size bands at the
    // other end of the range unreachable and the reach check would pass anyway.
    const mag = [0.5, 5, 30, 100][i % 4];
    const p = () => Math.round((rand() * 2 - 1) * mag * 1000) / 1000;
    const h = stakesHint(G(p(), p(), p(), p(), p(), p(), p(), p()));
    const b = sizeBand(h);
    if (b) seen[b] = (seen[b] ?? 0) + 1;

  }
  // "Reachable" is deliberately a low bar (0.1%): the point is to catch a band
  // that is DEAD, not to legislate a distribution.
  for (const band of ['sub-unit', 'modest', 'substantial', 'very large']) {
    const n = seen[band] ?? 0;
    check(`band "${band}" is reachable on real games`, n >= N / 1000, `${n}/${N} — nothing reaches it`);
  }
  const pct = (k: string) => `${k} ${(100 * (seen[k] ?? 0) / N).toFixed(1)}%`;
  console.log('  reach: ' + ['sub-unit', 'modest', 'substantial', 'very large'].map(pct).join(', '));
}

if (failures > 0) { console.error(`✗ scenario stakes: ${failures} failed`); process.exit(1); }
console.log('✓ scenario stakes: shift-invariant, scale-covariant, every surviving band has a known-positive fixture and measured reach, the unmeasured geometric clauses stay out, 20k hints carry no claim and no leaked figure');

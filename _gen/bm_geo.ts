/**
 * BLUE-MATH's OWN re-measurement of the five geometryBriefing falsehoods.
 *
 * Every class is decided from the payoff matrix directly, and the two that can
 * be checked against an INDEPENDENT oracle are: (d) is confirmed by the regret
 * definition of a Nash equilibrium (`regretA`/`regretB`, which share no code
 * with `equilibriumSet`), and every class is additionally required to appear as
 * the literal sentence in `geometryBriefing(g)` — so a rate can never be
 * reported for a sentence the renderer does not actually emit.
 *
 *   npx tsx _gen/bm_geo.ts
 */
import { geometryBriefing } from '../src/utils/geometry';
import { buildGroundingPayload } from '../src/utils/report';
import { equilibriumSet, regretA, regretB, generateRandomGame, PRESETS } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

const S = {
  a: 'outside [0,1]',
  b: "A's payoff does not depend on what B does",
  c: "A's surface always tilts one way",
  d: 'The equilibrium sits on an edge or corner of the square',
  e: 'NEITHER player has a dominant strategy',
};

/** (a) the root is ON the boundary (or does not exist), yet the prose says "outside [0,1]". */
const E = 1e-9;   // the SAME threshold the shipping code branches on
function defA(g: GamePayoffs): boolean {
  const twistA = g.a11 - g.a12 - g.a21 + g.a22;
  if (Math.abs(twistA) < E) return true;               // yStar = NaN -> "y = undefined, outside [0,1]"
  const y = (g.a22 - g.a12) / twistA;
  return Math.abs(y) <= E || Math.abs(y - 1) <= E;     // ON the boundary, which is INSIDE [0,1]
}
/** (b) twist 0 is read as independence, but the y coefficient is a21 - a22. */
function defB(g: GamePayoffs): boolean {
  return Math.abs(g.a11 - g.a12 - g.a21 + g.a22) < E && Math.abs(g.a21 - g.a22) >= E;
}
/** (c) "always tilts one way" on a board where A is indifferent between rows EVERYWHERE. */
function defC(g: GamePayoffs): boolean {
  return Math.abs(g.a11 - g.a12 - g.a21 + g.a22) < E && Math.abs(g.a12 - g.a22) < E;
}
/** (d) no interior joint flat spot, yet an equilibrium has both coordinates interior. */
function defD(g: GamePayoffs): { hit: boolean; pt?: [number, number] } {
  const twistA = g.a11 - g.a12 - g.a21 + g.a22, twistB = g.b11 - g.b12 - g.b21 + g.b22;
  const inUnit = (v: number) => Number.isFinite(v) && v > 1e-9 && v < 1 - 1e-9;
  const yS = twistA === 0 ? NaN : (g.a22 - g.a12) / twistA;
  const xS = twistB === 0 ? NaN : (g.b22 - g.b21) / twistB;
  if (inUnit(xS) && inUnit(yS)) return { hit: false };          // the briefing's else-branch is not taken
  for (const r of equilibriumSet(g)) {
    const lx = Math.max(r.x0, 0), hx = Math.min(r.x1, 1), ly = Math.max(r.y0, 0), hy = Math.min(r.y1, 1);
    if (!(hx > 0 && lx < 1 && hy > 0 && ly < 1)) continue;
    const x = Math.min(Math.max((lx + hx) / 2, 1e-6), 1 - 1e-6);
    const y = Math.min(Math.max((ly + hy) / 2, 1e-6), 1 - 1e-6);
    if (x <= 0 || x >= 1 || y <= 0 || y >= 1) continue;
    if (x < r.x0 - 1e-12 || x > r.x1 + 1e-12 || y < r.y0 - 1e-12 || y > r.y1 + 1e-12) continue;
    // INDEPENDENT confirmation: the regret oracle, not equilibriumSet.
    if (Math.abs(regretA(x, y, g)) < 1e-9 && Math.abs(regretB(x, y, g)) < 1e-9) return { hit: true, pt: [x, y] };
  }
  return { hit: false };
}
/** (e) no STRICT dominance, but a player's option is never worse. */
function defE(g: GamePayoffs): boolean {
  const strictA = (g.a11 > g.a21 && g.a12 > g.a22) || (g.a21 > g.a11 && g.a22 > g.a12);
  const strictB = (g.b11 > g.b12 && g.b21 > g.b22) || (g.b12 > g.b11 && g.b22 > g.b21);
  if (strictA || strictB) return false;                          // the briefing takes the other branch
  const weakA = (g.a11 >= g.a21 && g.a12 >= g.a22) || (g.a21 >= g.a11 && g.a22 >= g.a12);
  const weakB = (g.b11 >= g.b12 && g.b21 >= g.b22) || (g.b12 >= g.b11 && g.b22 >= g.b21);
  return weakA || weakB;
}

const ri = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
// CORPORA THAT MATCH HOW GAMES ACTUALLY ARRIVE.
//   'random button'  — generateRandomGame REJECTS every within-player tie, so
//                      most of these classes cannot arrive that way at all.
//                      Measuring on plain int[-9,9] would overstate them.
//   'int[-9,9]'      — the matrix editor, hand-typed small integers (ties allowed).
//   'int[-3,3]'      — smaller alphabet, where ties are dense.
//   'dec3[-9,9]'     — the matrix editor used with decimals.
const gens: Record<string, () => GamePayoffs> = {
  'random button': () => generateRandomGame(Math.random() < 0.5 ? 'pure' : 'mixed'),
  'int[-9,9]': () => { const c = () => ri(-9, 9); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
  'int[-3,3]': () => { const c = () => ri(-3, 3); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
  'dec3[-9,9]': () => { const c = () => ri(-9000, 9000) / 1000; return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
};

const N = Number(process.env.BM_N || 200000);
for (const [name, gen] of Object.entries(gens)) {
  const hit: Record<string, number> = { a: 0, b: 0, c: 0, d: 0, e: 0 };
  const said: Record<string, number> = { a: 0, b: 0, c: 0, d: 0, e: 0 };
  for (let i = 0; i < N; i++) {
    const g = gen();
    const t = geometryBriefing(g);
    const flags: Record<string, boolean> = { a: defA(g), b: defB(g), c: defC(g), d: defD(g).hit, e: defE(g) };
    for (const k of Object.keys(flags)) {
      if (!flags[k]) continue;
      hit[k]++;
      // the class only counts if the briefing REALLY emits the sentence
      if (t.includes(S[k as keyof typeof S])) said[k]++;
    }
  }
  console.log(`${name} (n=${N})`);
  for (const k of ['a', 'b', 'c', 'd', 'e'] as const)
    console.log(`  (${k}) ${String(hit[k]).padStart(6)} games = ${(100 * hit[k] / N).toFixed(2)}%   sentence actually emitted in ${said[k]} of them${said[k] === hit[k] ? '' : '   <-- MISMATCH'}`);
}

// ---- THE PRESETS, which are the most-played games of all --------------------
console.log('\npresets:');
for (const [key, p] of Object.entries(PRESETS as Record<string, any>)) {
  if (!p || typeof p.a11 !== 'number') continue;
  const g = p as GamePayoffs;
  const f = { a: defA(g), b: defB(g), c: defC(g), d: defD(g).hit, e: defE(g) };
  const bad = Object.entries(f).filter(([, v]) => v).map(([k]) => k);
  console.log(`  ${key.padEnd(10)} ${bad.length ? 'DEFECTS: ' + bad.join(',') : 'clean'}`);
}

// ---- the exact fixtures, with the verbatim line they produce ---------------
const FIX: [string, GamePayoffs][] = [
  ['(a) y=0 boundary', { a11: 3, a12: -6, a21: -9, a22: -6, b11: 8, b12: 9, b21: 0, b22: 3 }],
  ['(a) y=1 boundary', { a11: 1, a12: 8, a21: 1, a22: 5, b11: 7, b12: -2, b21: -1, b22: -9 }],
  ['(b)+(c) flat A', { a11: -5, a12: -1, a21: -5, a22: -1, b11: -6, b12: -6, b21: 0, b22: 6 }],
  ['(b)+(c) flat A 2', { a11: 7, a12: -9, a21: 7, a22: -9, b11: 3, b12: 0, b21: 2, b22: -4 }],
  ['(d) interior NE', { a11: -2, a12: 2, a21: 4, a22: -5, b11: 3, b12: 3, b21: 4, b22: 4 }],
  ['(e) weak dominance', { a11: -7, a12: -5, a21: -7, a22: 7, b11: -3, b12: -1, b21: -6, b22: -8 }],
];
console.log('\n--- fixtures ---');
for (const [name, g] of FIX) {
  console.log(`\n${name}  ${JSON.stringify(g)}`);
  console.log(`  flags: a=${defA(g)} b=${defB(g)} c=${defC(g)} d=${defD(g).hit}${defD(g).pt ? ` at (${defD(g).pt![0]}, ${defD(g).pt![1]})` : ''} e=${defE(g)}`);
  for (const line of geometryBriefing(g).split('\n').slice(1)) console.log(`  |${line}`);
}
// reachability: the briefing is inside the prompt generateScenario sends
const probe = FIX[0][1];
console.log(`\nbuildGroundingPayload contains the geometry briefing: ${buildGroundingPayload(probe).includes(geometryBriefing(probe))}`);

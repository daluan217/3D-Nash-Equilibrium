import { computeAllNE } from '../src/utils/gameEngine';
// Battle of the Sexes — the peer's Claim 3 negative control
const bos = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
// Prisoner's Dilemma — Claim 1 / Claim 2 negative control
const pd  = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
for (const [name, g] of [['battle-of-sexes', bos], ['prisoners-dilemma', pd]] as const) {
  const ne = computeAllNE(g as any);
  console.log(`${name}: ${ne.length} equilibria -> ${ne.map((n: any) => `${n.type}(x=${n.x?.toFixed(3)},y=${n.y?.toFixed(3)})`).join('  ')}`);
}

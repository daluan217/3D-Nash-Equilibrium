/**
 * EVIDENCE for the "fmtPayoff was applied at 2 of 10 sites" lead.
 *
 * `fmtPayoff` promises that a payoff which merely ROUNDS to zero is never
 * PRINTED as zero. Two call sites got it; the rest of the app still calls
 * `.toFixed(3)` directly. This enumerates small-scale matrices a user can
 * actually type (3 decimals, inside the ±100 clamp) and reports every mixed or
 * pure equilibrium whose stored `eA` prints as a bare zero while the true
 * expected payoff is not zero.
 *
 * Note the subtlety a fix has to respect: `computeAllNE` stores eA/eB ALREADY
 * r3-rounded, and `-0 === 0` in JS, so passing the stored value to `fmtPayoff`
 * is a no-op. Only the exact EA(x, y, g) carries the information.
 */
const { computeAllNE, EA, r3, fmtPayoff } = await import('../src/utils/gameEngine.ts');

console.log('(-0).toFixed(3)      =', JSON.stringify((-0).toFixed(3)), '  <- the sign is lost here');
console.log('(-0.0003).toFixed(3) =', JSON.stringify((-0.0003).toFixed(3)));
console.log('r3(-0.0003)          =', r3(-0.0003), ' isNegativeZero:', Object.is(r3(-0.0003), -0));
console.log('');

const vals = [-0.003, -0.002, -0.001, 0, 0.001, 0.002, 0.003];
const hits = [];
outer:
for (const a11 of vals) for (const a12 of vals) for (const a21 of vals) for (const a22 of vals)
for (const b11 of vals) for (const b12 of vals) for (const b21 of vals) for (const b22 of vals) {
  const g = { a11, a12, a21, a22, b11, b12, b21, b22 };
  for (const n of computeAllNE(g)) {
    const trueA = EA(n.x, n.y, g);
    if (trueA !== 0 && /^-?0\.000$/.test(n.eA.toFixed(3))) {
      hits.push({ g, at: { x: n.x, y: n.y, type: n.type }, trueA,
        printed: n.eA.toFixed(3), honest: fmtPayoff(trueA) });
      if (hits.length >= 3) break outer;
    }
  }
}
console.log(`equilibria whose eA prints as a bare zero for a NONZERO payoff: ${hits.length}`);
for (const h of hits) console.log('  ' + JSON.stringify(h));

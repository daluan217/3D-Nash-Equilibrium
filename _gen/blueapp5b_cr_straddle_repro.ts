/**
 * Reproduction of CodeRabbit's PR #91 finding on equilibriumPanel.ts ~L234:
 * for p=0.0002, q=-0.0002 (a REAL ~4e-4 gap, not float noise), the shared
 * midpoint is exactly 0.0 and the shipped code renders "= 0" on both sides
 * — a false equality claim, since neither payoff is actually 0.
 */
import { indifferenceLine } from '../src/components/equilibriumPanel';

const straddle = indifferenceLine('Row 1', 'Row 2', 0.0002, -0.0002);
console.log('straddle (CodeRabbit case):', JSON.stringify(straddle, null, 2));

const exactZero = indifferenceLine('Row 1', 'Row 2', 0, 0);
console.log('exactZero (must stay "= 0"):', JSON.stringify(exactZero, null, 2));

const noise = indifferenceLine('Row 1', 'Row 2', -2.220446049250313e-16, 4.440892098500626e-16);
console.log('fp-noise (RED-MATH-5/001, must stay "= 0"):', JSON.stringify(noise, null, 2));

const ordinary = indifferenceLine('Row 1', 'Row 2', 2 / 3, 2 / 3);
console.log('ordinary (must stay "= 0.667"):', JSON.stringify(ordinary, null, 2));

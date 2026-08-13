import 'dotenv/config';
import { generateReport } from '../src/utils/report';
import { validateReport } from '../src/utils/nashValidator';
import type { GamePayoffs } from '../src/types';

/**
 * VALIDATOR GAP AUDIT — does the SHIPPED explainer assert framings whose
 * precondition fails, and does nashValidator notice?
 *
 * Preconditions are exactly decidable from the matrix; assertion detection is
 * NOT (a lexical prose check was tried in this codebase and removed for false
 * positives). Keyword hits below are therefore reported as CANDIDATES for human
 * review, never as a score.
 */
const isZeroSum = (g: GamePayoffs) =>
  [['a11','b11'],['a12','b12'],['a21','b21'],['a22','b22']]
    .every(([a,b]) => Math.abs((g as any)[a] + (g as any)[b]) < 1e-9);

const GAMES: { name: string; g: GamePayoffs; note: string }[] = [
  { name: 'battle-of-sexes (NON-zero-sum, interior mixed NE)',
    g: { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 },
    note: 'NEGATIVE control for the minimax/value framing' },
  { name: 'matching-pennies (zero-sum, interior mixed NE)',
    g: { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 },
    note: 'POSITIVE control — minimax genuinely applies' },
  { name: 'prisoners-dilemma (dominant strategy, no mixed NE)',
    g: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 },
    note: 'NEGATIVE control for "mixed strategy is a pure strategy in disguise"' },
];

// Candidate surface only — for human adjudication, not scoring.
const PROBES = ['minimax', 'value of the game', "game's value", 'zero-sum',
                'zero sum', 'in disguise', 'strictly competitive', 'saddle'];

(async () => {
  for (const { name, g, note } of GAMES) {
    console.log(`\n=== ${name}`);
    console.log(`    ${note}   |   zero-sum precondition: ${isZeroSum(g) ? 'HOLDS' : 'FAILS'}`);
    const r = await generateReport(g);
    if (!r.report) { console.log(`    no report (failure=${r.failure})`); continue; }
    const v = validateReport(r.report, g);
    console.log(`    nashValidator: ${v.ok ? 'PASS' : 'FAIL'}  (${v.mismatches.length} mismatches)`);
    const prose = r.report.prose || '';
    const hits = PROBES.filter((p) => prose.toLowerCase().includes(p));
    console.log(`    candidate framing terms present: ${hits.length ? hits.join(', ') : '(none)'}`);
    console.log(`    --- prose ---\n${prose.split('\n').map((l) => '    ' + l).join('\n')}`);
  }
})();

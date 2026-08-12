import 'dotenv/config';
import { generateReport } from '../src/utils/report';
import { validateReport } from '../src/utils/nashValidator';
const g = { a11:7,a12:-3,a21:-6,a22:1, b11:-7,b12:3,b21:6,b22:-1 };   // ugly zero-sum, no story
const cases: [string, any][] = [
  ['NO scenario -> should invent one', {}],
  ['thin description (too short)', { scenario: { description: 'my game' } }],
  ['rich description (should be used)', { scenario: {
      name: 'Warehouse Audit',
      description: 'An auditor decides each night whether to inspect the north warehouse or the south one, while a smuggler simultaneously picks which warehouse to move crates through. Catching the smuggler at the north site is worth far more.' } }],
];
(async () => {
  for (const [label, opts] of cases) {
    const r = await generateReport(g, opts);
    if (!r.report) { console.log(`--- ${label}: FAILED (${r.failure})\n`); continue; }
    const v = validateReport(r.report, g);
    const sug = r.report.suggestedScenario;
    console.log(`--- ${label}  [validator ${v.ok ? 'PASS' : 'FAIL'}]  suggested=${sug ? 'YES' : 'no'}`);
    if (sug) console.log(`    ${sug.name} | ${sug.row1}/${sug.row2} vs ${sug.col1}/${sug.col2}\n    ${sug.description}`);
    console.log(`    prose: ${r.report.prose.slice(0, 240)}\n`);
  }
})();

import 'dotenv/config';
process.env.ALLOW_STYLE_EXEMPLARS = '1';
import { readFileSync } from 'node:fs';
import { generateReport } from '../src/utils/report';
import { validateReport } from '../src/utils/nashValidator';
import { PRESETS } from '../src/utils/gameEngine';

const ex = JSON.parse(readFileSync('_gen/exemplars/exemplars.json','utf8')) as string[];
const p = PRESETS.search;
const g = { a11:p.a11!, a12:p.a12!, a21:p.a21!, a22:p.a22!, b11:p.b11!, b12:p.b12!, b21:p.b21!, b22:p.b22! };
const sc = { name: p.name, row1: p.row1Label, row2: p.row2Label, col1: p.col1Label, col2: p.col2Label };

(async () => {
  for (const [label, opts] of [
    ['NO scenario, no exemplars', {}],
    ['scenario only', { scenario: sc }],
    ['scenario + exemplars', { scenario: sc, styleExemplars: ex }],
  ] as const) {
    const r = await generateReport(g, opts as never);
    if (!r.report) { console.log(`--- ${label}: FAILED (${r.failure})\n`); continue; }
    const v = validateReport(r.report, g);
    console.log(`--- ${label}  [validator ${v.ok ? 'PASS' : 'FAIL'}]`);
    console.log(r.report.prose, '\n');
  }
})();

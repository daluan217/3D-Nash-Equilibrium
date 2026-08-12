import 'dotenv/config';
process.env.ALLOW_STYLE_EXEMPLARS = '1';
import { readFileSync } from 'node:fs';
import { generateReport } from '../src/utils/report';
const ex = JSON.parse(readFileSync('_gen/exemplars/exemplars.json','utf8')) as string[];
const ho = JSON.parse(readFileSync('_gen/exemplars/heldout.json','utf8')) as string[];
// the search game the held-out prose is actually about
const g = { a11:2,a12:0,a21:0,a22:1, b11:-2,b12:0,b21:0,b22:-1 };
(async () => {
  const fs = await generateReport(g, { styleExemplars: ex });
  console.log('=== HELD-OUT (author, search game) ===');
  console.log(ho[1], '\n');
  console.log('=== FEW-SHOT MODEL (same game) ===');
  console.log(fs.report?.prose ?? '(none)');
})();

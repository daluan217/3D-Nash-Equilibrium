import 'dotenv/config';
import { generateReport } from '../src/utils/report';
import { validateReport } from '../src/utils/nashValidator';
const g = { a11:2,a12:0,a21:0,a22:1, b11:1,b12:0,b21:0,b22:2 };
(async () => {
  const r = await generateReport(g);
  console.log('no exemplars -> report:', !!r.report, '| failure:', r.failure);
  if (r.report) console.log('  validator:', validateReport(r.report, g).ok ? 'PASS' : 'FAIL');
})();

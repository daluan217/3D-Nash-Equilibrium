import 'dotenv/config';
import { generateReport } from '../src/utils/report';
const g = { a11:2,a12:0,a21:0,a22:1, b11:1,b12:0,b21:0,b22:2 };
(async () => {
  // 1. production path, no exemplars -> must work
  const a = await generateReport(g);
  console.log('no exemplars:            ', a.report ? 'OK' : `FAILED (${a.failure})`);
  // 2. exemplars WITHOUT the flag -> must throw
  try {
    await generateReport(g, { styleExemplars: ['some manuscript prose'] });
    console.log('exemplars, flag unset:    *** NOT BLOCKED — BUG ***');
  } catch (e) {
    console.log('exemplars, flag unset:    blocked ✓');
  }
  // 3. exemplars WITH the flag -> allowed
  process.env.ALLOW_STYLE_EXEMPLARS = '1';
  const c = await generateReport(g, { styleExemplars: ['some manuscript prose'] });
  console.log('exemplars, flag set:      ', c.report ? 'allowed ✓' : `failed (${c.failure})`);
})();

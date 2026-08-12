import 'dotenv/config';
import { generateReport, scenarioIsUsable } from '../src/utils/report';

const g = { a11:7,a12:-3,a21:-6,a22:1, b11:-7,b12:3,b21:6,b22:-1 };

(async () => {
  // 1) no scenario -> model invents one
  const first = await generateReport(g);
  const sug = first.report?.suggestedScenario;
  if (!sug) { console.log('no suggestion produced — cannot test round-trip'); return; }
  console.log('GENERATED:', sug.name, '|', sug.row1 + '/' + sug.row2, 'vs', sug.col1 + '/' + sug.col2);
  console.log('  description words:', (sug.description ?? '').trim().split(/\s+/).length);

  // 2) feed it back exactly as the app would after the user saves it
  const saved = { name: sug.name, row1: sug.row1, row2: sug.row2, col1: sug.col1, col2: sug.col2, description: sug.description };
  console.log('  scenarioIsUsable(saved):', scenarioIsUsable(saved));

  // 3) description ONLY, as if the app saved just the desc text and no labels
  const descOnly = { description: sug.description };
  console.log('  scenarioIsUsable(description only):', scenarioIsUsable(descOnly));

  for (const [label, sc] of [['full save', saved], ['description only', descOnly]] as const) {
    const r = await generateReport(g, { scenario: sc });
    const regen = !!r.report?.suggestedScenario;
    console.log(`\n[${label}] regenerated a NEW scenario? ${regen ? '*** YES — BUG ***' : 'no ✓'}`);
    console.log('  prose:', (r.report?.prose ?? '').slice(0, 180));
  }
})();

/* KNOWN-POSITIVE fixtures for the three checks landed this window.
 * Every check ships with a draw it MUST flag, asserted in the same run as its
 * negative control — the structural form adopted after RED 1 shipped a screen
 * whose scan window had eaten the evidence and reported a clean zero. */
const { validateScenario } = await import('../src/utils/nashValidator.ts');
let fail = 0;
const check = (want, label, sc, g) => {
  const v = validateScenario(sc, g);
  const got = v.ok ? 'PASSES' : 'CAUGHT';
  const ok = want === got;
  if (!ok) fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${got.padEnd(6)} (want ${want.padEnd(6)}) ${label}`);
  if (!ok || !v.ok) console.log(`         ${JSON.stringify(v.issues)}`);
};

// ── F12: cross-attribution via the LETTER form (RED 1's verbatim draw) ──
const ANTI = { a11:0,a12:3,a21:2,a22:0, b11:0,b12:2,b21:3,b22:0 };
const orchard = { name:'Orchard Frost Watch', row1:'Early Harvest', row2:'Late Harvest',
  col1:'Release Water', col2:'Hold Water', storyClaims:null };
const S1 = 'An orchard manager, Player A, chooses between Early Harvest and Late Harvest for the season.';
const S2 = 'A regional water cooperative, Player B, chooses between Release Water and Hold Water for the same fields.';
const S3 = 'Player A chooses when to release water, and Player B chooses how to manage it.';
check('CAUGHT', 'F12 positive — "Player A chooses when to release water" (Release Water is B\'s)',
  { ...orchard, description: `${S1} ${S2} ${S3}` }, ANTI);
check('PASSES', 'F12 negative — the correct letter prose, sentences 1-2 only',
  { ...orchard, description: `${S1} ${S2}` }, ANTI);
check('PASSES', 'F12 negative — "Player A chooses Early Harvest" (its OWN option)',
  { ...orchard, description: `${S1} ${S2} Player A chooses Early Harvest.` }, ANTI);

// ── F11: a missing option label (RED 1's verbatim draw; col2 ABSENT) ──
const PD = { a11:3,a12:0,a21:5,a22:1, b11:3,b12:5,b21:0,b22:1 };
check('CAUGHT', 'F11 positive — col2 ABSENT (model emitted day1/day2)',
  { name:'Saffron Harvest Labour', row1:'Early Harvest', row2:'Late Harvest', col1:'Night Work',
    day1:'Morning Work', day2:'Evening Work', storyClaims:null,
    description:'A farmer chooses between Early Harvest and Late Harvest for his saffron crop. A nearby worker chooses between Night Work and Day Work for the same harvest period.' }, PD);
check('CAUGHT', 'F11 positive — col2 EMPTY STRING (the other spelling of the same hole)',
  { name:'X', row1:'Early Harvest', row2:'Late Harvest', col1:'Night Work', col2:'   ',
    storyClaims:null, description:'A farmer chooses between Early Harvest and Late Harvest.' }, PD);
check('PASSES', 'F11 negative — all four labels present',
  { name:'X', row1:'Early Harvest', row2:'Late Harvest', col1:'Night Work', col2:'Day Work',
    storyClaims:null, description:'A farmer chooses between Early Harvest and Late Harvest.' }, PD);

// ── F1: matching language on an all-MISMATCH game ──
const coordSc = (d) => ({ name:'X', row1:'Morning Harvest', row2:'Evening Harvest',
  col1:'Shared Window', col2:'Separate Window', storyClaims:null, description:d });
const MATCH = { a11:2,a12:0,a21:0,a22:1, b11:2,b12:0,b21:0,b22:1 };
check('CAUGHT', 'F1 positive — "want to match the opponent\'s choice" where every pure NE is a MISMATCH',
  coordSc("Both cooperatives want to match the opponent's choice for the drying season."), ANTI);
check('PASSES', 'F1 negative — the SAME sentence on a genuine matching game',
  coordSc("Both cooperatives want to match the opponent's choice for the drying season."), MATCH);
check('PASSES', 'F1 negative — plain scene-setting on the mismatch game',
  coordSc('A seaweed cooperative picks a drying slot while a neighbouring firm picks a window.'), ANTI);

console.log(fail ? `\n${fail} FIXTURE FAILURES` : '\nall fixtures behaved as specified');
process.exit(fail ? 1 : 0);

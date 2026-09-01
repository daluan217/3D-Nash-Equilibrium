/* Would the DEAD actorA/actorB misattribution guard have caught F12?
 * Decision-relevant: it decides whether reviving the guard (adding the fields
 * to the schema) would pay for itself, or whether F12 needs its own screen. */
const { validateScenario } = await import('../src/utils/nashValidator.ts');
const G = { a11:0,a12:3,a21:2,a22:0, b11:0,b12:2,b21:3,b22:0 };
const base = {
  name: 'Orchard Water',
  row1: 'Early Harvest', row2: 'Late Harvest',
  col1: 'Release Water', col2: 'Hold Water',
  description: "An orchard manager, Player A, chooses between Early Harvest and Late Harvest for the season. A regional water cooperative, Player B, chooses between Release Water and Hold Water for the same fields. Player A chooses when to release water, and Player B chooses how to manage it.",
};
const variants = [
  ['as the model emitted it (no actors)', {}],
  ['WITH actorA/actorB declared', { actorA: ['orchard manager'], actorB: ['water cooperative'] }],
  ['role noun instead of the letter', { actorA: ['orchard manager'], actorB: ['water cooperative'],
     description: base.description.replace('Player A chooses when to release water', 'the orchard manager chooses Release Water') }],
];
for (const [label, extra] of variants) {
  const sc = { ...base, ...extra };
  const v = validateScenario(sc, G);
  console.log(`${v.ok ? 'PASSES' : 'CAUGHT'}  ${label}`);
  if (!v.ok) for (const i of v.issues) console.log('        ' + i);
}

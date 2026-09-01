/* BLUE TRIAGE of RED 1 F11: a missing option label passes every gate. */
const { validateScenario, scenarioIsClaimFree, validateProseDirections } = await import('../src/utils/nashValidator.ts');
const PD = { a11:3,a12:0,a21:5,a22:1, b11:3,b12:5,b21:0,b22:1 };
const draw = {
  name: 'Saffron Harvest Labour',
  row1: 'Early Harvest', row2: 'Late Harvest',
  col1: 'Night Work',
  day1: 'Morning Work', day2: 'Evening Work',   // hallucinated keys; col2 absent
  description: 'A farmer chooses between Early Harvest and Late Harvest for his saffron crop. A nearby worker chooses between Night Work and Day Work for the same harvest period.',
  storyClaims: null,
};
const v = validateScenario(draw, PD), cf = scenarioIsClaimFree(draw);
const dirs = validateProseDirections(draw.description, draw, PD);
console.log('col2 is', JSON.stringify(draw.col2));
console.log('validateScenario.ok      =', v.ok, JSON.stringify(v.issues));
console.log('scenarioIsClaimFree.ok   =', cf.ok);
console.log('validateProseDirections  =', JSON.stringify(dirs));
console.log('=> SHIPPING GATE PASSES  =', !!(v.ok && cf.ok !== false && dirs.length === 0));
// the save-path template, transcribed from App.tsx useSuggestedScenario
const sc = draw;
const appended = ` A chooses between ${sc.row1} and ${sc.row2}; B chooses between ${sc.col1} and ${sc.col2}.`;
console.log('\nsaved description would be:\n  "' + (draw.description + appended) + '"');
console.log('\ncontains literal "undefined":', /undefined/.test(appended));

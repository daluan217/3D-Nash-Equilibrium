/**
 * RED TEAM 1 — an oracle for the claim-free scenario gate.
 *
 * Two lists, and a fix has to satisfy BOTH:
 *
 *   HOLES     scenarios that are FALSE about the game and currently pass.
 *             A fix should make these fail.
 *   CONTROLS  scenarios that are TRUE about the game and currently pass.
 *             A fix must NOT make these fail. Every hole is conditioned on a
 *             property of the matrix, and each control is the SAME sentence on
 *             a matrix where it is true — so a fix written as a bare word list
 *             is caught here rather than in production.
 *
 * No model needed; the scenarios are hand-written and the verdicts come from
 * validateScenario + scenarioIsClaimFree + validateProseDirections.
 *
 *   npx tsx _gen/rt_gate_holes.mjs
 */
const { validateScenario, scenarioIsClaimFree, validateProseDirections } = await import('../src/utils/nashValidator.ts');
const { computeAllNE } = await import('../src/utils/gameEngine.ts');
const { tieProseFull } = await import('../src/utils/tieProse.ts');

const G = (a11, b11, a12, b12, a21, b21, a22, b22) => ({ a11, a12, a21, a22, b11, b12, b21, b22 });

// Anti-coordination: both pure equilibria are MISmatches; matching pays 0 against 2 and 3.
const ANTI = G(0, 0, 3, 2, 2, 3, 0, 0);
// Pure coordination: both pure equilibria are MATCHES.
const COORD = G(4, 4, 0, 0, 0, 0, 2, 2);
// Matching pennies: strictly zero-sum, no pure equilibrium.
const MP = G(100, -100, -100, 100, -100, 100, 100, -100);
// Pure common interest: the two players' payoffs are IDENTICAL in every cell.
const COMMON = COORD;
// A's payoffs never move: B's choice cannot change what A earns.
const AFLAT = G(5, 0, 5, 3, 5, -3, 5, 1);
// An ordinary game: both players' payoffs vary with the opponent.
const PLAIN = G(3, 1, 0, 4, 5, 2, 1, 6);

const sc = (o) => ({ name: 'Test', row1: 'Early Slot', row2: 'Late Slot', col1: 'Shared Window', col2: 'Separate Window', storyClaims: null, ...o });

const HOLES = [
  ['ANTI-COORD + explicit matching incentive', ANTI, sc({
    description: 'Two drying cooperatives share one rack yard. Each has an incentive to match the opponent\'s choice of Early Slot or Late Slot when the tide allows.',
  }), 'every pure equilibrium is a MISmatch; matching pays 0 against 2 and 3'],
  ['ANTI-COORD + "coordinate their choices" (the model\'s own wording)', ANTI, sc({
    description: 'A seaweed-drying cooperative and a neighbouring company each run a rack yard. The two players coordinate their choices for the same drying season.',
  }), 'same, in the phrasing the local model actually produces'],
  ['ZERO-SUM + cooperative framing', MP, sc({
    description: 'An antique store and a restoration company are coordinating a new display. The store books a slot while the restorer books a window.',
  }), 'every cell is exactly +100/-100: one side gains precisely what the other loses'],
  ['ZERO-SUM + explicit shared goal', MP, sc({
    description: 'A store and a restorer work together toward the same goal for the display. Each books its own slot for the season.',
  }), 'same, stated outright'],
  ['COMMON INTEREST + adversarial framing', COMMON, sc({
    description: 'A textile company and a competing manufacturer fight for the same order. Each books its own dyeing slot for the run.',
  }), 'payoffs identical in every cell: the two never disagree about anything'],
  ['A-FLAT + "B\'s decision determines A\'s outcome"', AFLAT, sc({
    description: 'A roastery picks its supplier for the season. The distribution partner\'s decision will determine the handling and pricing outcome for the roastery.',
  }), 'A earns 5 in all four cells, so B\'s choice provably cannot change A\'s payoff'],
  ['ONE PLAYER holds both option pairs', ANTI, sc({
    description: 'A regional airport is planning a glacier survey and will either use an Early Slot or a Late Slot for the data set. The airport will also choose between a Shared Window and a Separate Window for that same data set.',
  }), 'the reader is shown one decision maker with four options'],
  ['SECOND decision handed to a pronoun subject', ANTI, sc({
    description: 'A dairy co-op is deciding between an Early Slot and a Late Slot for its seasonal milk sale. It chooses either a Shared Window or a Separate Window for distribution.',
  }), '"It" is the co-op, so B\'s options belong to A and B never appears'],
  ['AN OPTION PAIR WITH NO CHOOSER', ANTI, sc({
    description: 'A farm cooperative is deciding whether to book an Early Slot or a Late Slot for the harvest. The Shared Window and Separate Window available represent the workforce\'s availability for that period.',
  }), 'B\'s options are presented as a state of nature, not a player\'s choice'],
  ['THE TWO PLAYERS MAKE THE SAME MOVE', ANTI, sc({
    description: 'A farm cooperative books an Early Slot or a Late Slot for the saffron harvest, while the harvest coordinator chooses the same timing.',
  }), 'asserts B\'s move IS A\'s move, so only the diagonal can ever occur'],
  ['REPEATED PLAY implied', ANTI, sc({
    description: 'Each season the two yards book their racks. One takes an Early Slot or a Late Slot; the other takes a Shared Window or a Separate Window, and reputations from past seasons carry forward.',
  }), 'the app models a one-shot simultaneous game'],
  ['A MISSING OPTION LABEL (caught in the wild: the model emitted day1/day2 instead of col2)', G(3, 3, 0, 5, 5, 0, 1, 1), {
    name: 'Saffron Harvest Labour', row1: 'Early Harvest', row2: 'Late Harvest', col1: 'Night Work',
    day1: 'Morning Work', day2: 'Evening Work', storyClaims: null,
    description: 'A farmer chooses between Early Harvest and Late Harvest for his saffron crop. A nearby worker chooses between Night Work and Day Work for the same harvest period.',
  }, 'col2 is undefined, so B has an option with no name. validateScenario\'s distinctness check reads `base(sc.col1) && base(sc.col1) === base(sc.col2)` and silently skips when a label is empty. Downstream: the suggestion card renders "B: Night Work / "; tieProse falls back to Row/Col for the WHOLE paragraph while the card names the options; and useSuggestedScenario (App.tsx:698) interpolates the missing label, saving the sentence "B chooses between Night Work and undefined."'],
  ['NEGOTIATION / offer-and-accept implied', ANTI, sc({
    description: 'The two yards negotiate over the rack calendar. One side offers an Early Slot or a Late Slot and the other accepts a Shared Window or a Separate Window in exchange.',
  }), 'asserts sequence and binding agreement in a simultaneous non-cooperative game'],
];

const CONTROLS = [
  ['coordination language on a genuine COORDINATION game', COORD, sc({
    description: 'Two rink operators book one resurfacer. Each has an incentive to match the opponent\'s choice of Early Slot or Late Slot.',
  }), 'both pure equilibria sit on matching pairs, so matching language is true here'],
  ['"coordinating" as scene-setting on a coordination game', COORD, sc({
    description: 'A research lab and a satellite operator are coordinating a joint experiment. The lab books an Early Slot or a Late Slot while the operator books a Shared Window or a Separate Window.',
  }), 'a true description of a common-interest game'],
  ['"their choices determine the payoffs" on an ORDINARY matrix', PLAIN, sc({
    description: 'A mill books an Early Slot or a Late Slot for the run. A haulier books a Shared Window or a Separate Window. Their choices determine the resulting payoffs.',
  }), 'true in every game where both players\' payoffs vary — the vacuous closer the model writes constantly'],
  ['"the other side\'s choice affects the outcome" where it really does', PLAIN, sc({
    description: 'A mill books an Early Slot or a Late Slot. A haulier books a Shared Window or a Separate Window, and that choice affects what the mill takes home.',
  }), 'A\'s payoffs do vary with B\'s column here (3 vs 0, 5 vs 1)'],
  ['competitive framing on a STRICTLY OPPOSED matrix', MP, sc({
    description: 'A store and a competing restorer contest the same display. One books an Early Slot or a Late Slot; the other books a Shared Window or a Separate Window.',
  }), 'true: the matrix is exactly zero-sum'],
  ['simultaneity stated correctly', PLAIN, sc({
    description: 'A mill books an Early Slot or a Late Slot while a haulier books a Shared Window or a Separate Window. A and B make their choices simultaneously.',
  }), 'true, and the model does sometimes write it'],
  ['plain two-chooser scene, no framing at all', ANTI, sc({
    description: 'A seaweed-drying cooperative books an Early Slot or a Late Slot for its racks. A neighbouring company books a Shared Window or a Separate Window for the same drying period.',
  }), 'the shape the gate exists to allow'],
  ['a shared physical resource, on an opposed matrix', MP, sc({
    description: 'Two yards draw on one irrigation channel. One books an Early Slot or a Late Slot; the other books a Shared Window or a Separate Window.',
  }), 'sharing a RESOURCE is a scene fact, not a claim that interests are aligned — must stay legal'],
];

const CAUGHT_ON_PURPOSE = [
  ['CONTROL: an outright move-order claim', ANTI, sc({
    description: 'The first yard chooses an Early Slot before the second yard chooses a Shared Window.',
  })],
  ['CONTROL: counter-the-opponent language on a coordination game', COORD, sc({
    description: 'Two rink operators book one resurfacer. Each wants to counter the other\'s booking so the machine is never idle.',
  })],
];

const verdict = (s, g) => {
  const v = validateScenario(s, g), cf = scenarioIsClaimFree(s), dirs = validateProseDirections(s.description ?? '', s, g);
  return { passes: v.ok && cf.ok !== false && dirs.length === 0,
           why: [...v.issues, cf.ok === false ? cf.reason : null, ...dirs.map((d) => d.detail ?? d.kind)].filter(Boolean).join(' | ') };
};

let holes = 0, controlsBroken = 0, missed = 0;
console.log('── HOLES (false about the game; a fix should make these fail) ──────────────\n');
for (const [name, g, s, why] of HOLES) {
  const { passes, why: reason } = verdict(s, g);
  if (passes) holes++;
  console.log(`${passes ? 'REACHES USER' : 'blocked     '}  ${name}`);
  if (passes) {
    console.log(`              "${s.description}"`);
    console.log(`              WHY FALSE: ${why}`);
    console.log(`              solver prose beside it: ${tieProseFull(g, s).prose.slice(0, 150)}…`);
  } else console.log(`              blocked by: ${reason}`);
  console.log('');
}
console.log('── CONTROLS (true about the game; a fix must keep these passing) ───────────\n');
for (const [name, g, s, why] of CONTROLS) {
  const { passes, why: reason } = verdict(s, g);
  if (!passes) controlsBroken++;
  console.log(`${passes ? 'ok          ' : 'REGRESSION  '}  ${name}   (${why})`);
  if (!passes) console.log(`              wrongly blocked by: ${reason}`);
}
console.log('\n── ALREADY CAUGHT (must stay caught) ──────────────────────────────────────\n');
for (const [name, g, s] of CAUGHT_ON_PURPOSE) {
  const { passes, why: reason } = verdict(s, g);
  if (passes) missed++;
  console.log(`${passes ? 'REGRESSION  ' : 'ok          '}  ${name}${passes ? '' : `   (${reason})`}`);
}
console.log(`\nSUMMARY  holes reaching the user ${holes}/${HOLES.length} · controls wrongly blocked ${controlsBroken}/${CONTROLS.length} · existing screens lost ${missed}/${CAUGHT_ON_PURPOSE.length}`);
console.log(`NE(ANTI)=${JSON.stringify(computeAllNE(ANTI).map((n) => [n.type, n.x, n.y]))}  NE(COORD)=${JSON.stringify(computeAllNE(COORD).map((n) => [n.type, n.x, n.y]))}`);

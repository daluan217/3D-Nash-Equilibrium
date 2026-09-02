/**
 * BLUE-GATE — a bank row is served with the USER'S game, so screen it against
 * the SHAPES a user can produce, not against the one it was written for.
 *
 * `bank_build.ts` gates each row against the game it was GENERATED for. At serve
 * time `pickFromBank` pairs it with whatever matrix the user typed. Every
 * game-dependent rule in `validateScenario` therefore gets a different answer at
 * serve time than it did at build time, and a row can be admitted to the bank
 * and then rejected in front of the user — where the desktop has no model to
 * fall back to and the response silently carries no story at all.
 *
 * RED-BANK-2 found one instance (rivalry vocabulary on a common-interest game,
 * 19 rows). This asks the general question: over a probe set spanning the shapes
 * the gates actually branch on, plus random fuzz, WHICH rows fail on ANY game.
 *
 *   npx tsx _gen/blue_gate_bankprobe.mjs [path-to-bank.json]
 */
import fs from 'node:fs';
import { validateScenario, scenarioIsClaimFree, validateProseDirections } from '../src/utils/nashValidator.ts';

const PATH = process.argv[2] ?? 'src/data/scenarioBank.json';
const bank = JSON.parse(fs.readFileSync(PATH, 'utf8'));

/**
 * One probe per SHAPE the gates branch on, read off `validateScenario` and
 * `validateProseDirections` rather than guessed: common interest, constant sum,
 * zero sum, a flat player (each way), both flat (the all-zero matrix a user gets
 * by clearing the fields), dominance (each way and both), pure equilibria on
 * matching pairs, pure equilibria on mismatched pairs, and no pure equilibrium
 * at all. Each shape is given at two magnitudes, because `stakesBand` and the
 * near-tolerances are scale-dependent.
 */
const SHAPES = {
  'common-interest':      (k) => ({ a11: 9 * k, a12: -4 * k, a21: -4 * k, a22: 7 * k, b11: 9 * k, b12: -4 * k, b21: -4 * k, b22: 7 * k }),
  'constant-sum':         (k) => ({ a11: 3 * k, a12: -2 * k, a21: -4 * k, a22: 5 * k, b11: -3 * k, b12: 2 * k, b21: 4 * k, b22: -5 * k }),
  'zero-sum-matching':    (k) => ({ a11: 2 * k, a12: -2 * k, a21: -2 * k, a22: 2 * k, b11: -2 * k, b12: 2 * k, b21: 2 * k, b22: -2 * k }),
  'A-flat':               (k) => ({ a11: 5 * k, a12: 5 * k, a21: 2 * k, a22: 2 * k, b11: 1 * k, b12: 4 * k, b21: 3 * k, b22: 0 }),
  'B-flat':               (k) => ({ a11: 1 * k, a12: 4 * k, a21: 3 * k, a22: 0, b11: 5 * k, b12: 2 * k, b21: 5 * k, b22: 2 * k }),
  'both-flat':            () => ({ a11: 0, a12: 0, a21: 0, a22: 0, b11: 0, b12: 0, b21: 0, b22: 0 }),
  'dominance-both':       (k) => ({ a11: 3 * k, a12: 0, a21: 5 * k, a22: 1 * k, b11: 3 * k, b12: 5 * k, b21: 0, b22: 1 * k }),
  'coordination':         (k) => ({ a11: 4 * k, a12: 0, a21: 0, a22: 3 * k, b11: 3 * k, b12: 0, b21: 0, b22: 4 * k }),
  'anti-coordination':    (k) => ({ a11: 0, a12: 4 * k, a21: 3 * k, a22: 0, b11: 0, b12: 3 * k, b21: 4 * k, b22: 0 }),
  'no-pure':              (k) => ({ a11: 2 * k, a12: -1 * k, a21: -1 * k, a22: 1 * k, b11: -2 * k, b12: 1 * k, b21: 1 * k, b22: -1 * k }),
};
const probes = [];
for (const [n, f] of Object.entries(SHAPES)) for (const k of [0.1, 1, 20]) probes.push([`${n} x${k}`, f(k)]);

// Fuzz, so a shape nobody enumerated still gets asked about.
let seed = 20260901;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const rv = () => Math.round((rnd() * 2 - 1) * 60 * 10) / 10;
for (let i = 0; i < 240; i++) probes.push([`fuzz${i}`, { a11: rv(), a12: rv(), a21: rv(), a22: rv(), b11: rv(), b12: rv(), b21: rv(), b22: rv() }]);

console.log(`bank ${PATH}: ${bank.length} rows, ${probes.length} probe games\n`);

const failRows = new Map();
const byReason = new Map();
for (let i = 0; i < bank.length; i++) {
  const s = bank[i].s;
  const cf = scenarioIsClaimFree(s);
  if (!cf.ok) {
    failRows.set(i, [`CLAIM-FREE (game-independent): ${cf.reason}`]);
    byReason.set(`claim-free: ${cf.reason}`, (byReason.get(`claim-free: ${cf.reason}`) ?? 0) + 1);
    continue;
  }
  const reasons = new Set();
  for (const [pn, g] of probes) {
    const v = validateScenario(s, g);
    if (!v.ok) for (const iss of v.issues) reasons.add(`${iss.slice(0, 90)}  [first seen on ${pn}]`);
    const d = validateProseDirections(s.description ?? '', { row1: s.row1, row2: s.row2, col1: s.col1, col2: s.col2 }, g);
    for (const iss of d) reasons.add(`DIRECTIONS: ${iss.slice(0, 90)}  [first seen on ${pn}]`);
  }
  if (reasons.size) {
    failRows.set(i, [...reasons]);
    for (const r of reasons) {
      const k = r.replace(/\s+\[first seen on [^\]]+\]/, '');
      byReason.set(k, (byReason.get(k) ?? 0) + 1);
    }
  }
}

console.log(`rows that fail on AT LEAST ONE reachable game: ${failRows.size} of ${bank.length} (${(100 * failRows.size / bank.length).toFixed(2)}%)\n`);
for (const [k, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

console.log('\n--- first 25 failing rows, verbatim ---');
let shown = 0;
for (const [i, reasons] of failRows) {
  if (shown++ >= 25) break;
  const e = bank[i];
  console.log(`\n#${i} [${e.d} b${e.b}] "${e.s.name}"  A:${e.s.row1}/${e.s.row2}  B:${e.s.col1}/${e.s.col2}`);
  console.log(`   ${(e.s.description ?? '').slice(0, 300)}`);
  for (const r of reasons) console.log(`   -> ${r}`);
}
console.log(`\nfailing row ids: ${[...failRows.keys()].join(',')}`);

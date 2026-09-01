/**
 * BLUE — WINDOW 4: every rule this campaign has added, through the REAL gate,
 * over every corpus, including RED 1's 928 newest draws.
 *
 * The W3 rules were measured against 890 rows and reported 0 reach. That is a
 * weaker statement than it sounds: a rule measured only on the corpus it was
 * designed against looks free whether or not it is. RED 1 re-ran the label
 * predicates against 274 fresh accepted draws and found 0.00%. This does the
 * same for EVERY rule blue has shipped, against 1,808 draws, and it self-tests
 * that its own detector can fire before reporting any zero.
 *
 *   npx tsx _gen/blue_w4_fullgate.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const FILES = [
  [`${S}/rt1.jsonl`, 'old'], [`${S}/rt2.jsonl`, 'old'], [`${S}/pilot.jsonl`, 'old'],
  ['/tmp/rt2_local.jsonl', 'old'], ['/tmp/rt2_cloud.jsonl', 'old'], ['/tmp/rt2_pilot.jsonl', 'old'],
  ['/tmp/rt2_cloudpilot.jsonl', 'old'], ['/tmp/rt2_stakes_local.jsonl', 'old'],
  ['/tmp/rt2_stakes_cloud.jsonl', 'old'], ['/tmp/rt2_stakes_cloud_hint.jsonl', 'old'],
  ['/tmp/rt2_stakes_pilot.jsonl', 'old'],
  ['/tmp/rt3_character_cloud.jsonl', 'NEW'], ['/tmp/rt3_character_local.jsonl', 'NEW'],
  ['/tmp/rt3_stakes_cloud.jsonl', 'NEW'], ['/tmp/rt3_stakes_local.jsonl', 'NEW'],
  ['/tmp/rt3_local_capability.jsonl', 'NEW'], ['/tmp/rt3_slot_control.jsonl', 'NEW'],
  ['/tmp/rt2_gapladder_g25.jsonl', 'NEW'], ['/tmp/rt2_gapladder_g25_rated.jsonl', 'NEW'],
  ['/tmp/rt3_yield_cost.jsonl', 'NEW'], ['/tmp/rt_stakes_leak_cloud.jsonl', 'NEW'],
  ['/tmp/rt_stakes_leak_local.jsonl', 'NEW'], ['/tmp/rt2_gap_cloud_w1_g25.jsonl', 'NEW'],
  ['/tmp/rt2_gap_cloud_w3_g25.jsonl', 'NEW'], ['/tmp/rt2_gap_cloud_w4_g25.jsonl', 'NEW'],
];
const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const rows = [];
for (const [f, set] of FILES) {
  if (!existsSync(f)) continue;
  const src = f.split('/').pop().replace('.jsonl', '');
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r.sc) continue;
    const g = r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null);
    rows.push({ set, src, i: r.i ?? r.pair, sc: r.sc, g, gate: r.gate });
  }
}
const passing = rows.filter((r) => r.gate?.ok !== false);
console.log(`${rows.length} draws (old ${rows.filter(r=>r.set==='old').length}, NEW ${rows.filter(r=>r.set==='NEW').length}); ${passing.length} gate-passing\n`);

// Every reason string blue has introduced, W3 + W4. A detector matching a
// string the validator no longer emits reports 0% forever.
const MINE = [
  ['W3 label/name numeral', /^(?:the scenario name|the option label ").*cites a number$/],
  ['W3 label/name multiple', /asserts a multiple$/],
  ['W3 negotiation: offer+accept', /one player offers and the other accepts/],
  ['W3 negotiation: binding', /ends in a binding agreement/],
  ['W3 alignment: shared goal', /share a goal, but the matrix is constant-sum/],
  ['W3 alignment: rivals', /frames the two players as rivals/],
  ['W3 alignment: determines', /determines the outcome, but/],
  ['W4 second decision, same player', /a second decision given to a player who already made one/],
  ['W4 pronoun holds second pair', /a second set of options given to a pronoun/],
  ['W4 same move', /one player's move is the same as the other's/],
];
// SELF-TEST: each rule must be reachable through the real functions.
const P = (o) => ({ name: 'N', row1: 'Alpha', row2: 'Beta', col1: 'Gamma', col2: 'Delta', storyClaims: null, ...o });
const MP = { a11: 100, a12: -100, a21: -100, a22: 100, b11: -100, b12: 100, b21: 100, b22: -100 };
const CI = { a11: 4, a12: 0, a21: 0, a22: 2, b11: 4, b12: 0, b21: 0, b22: 2 };
const FL = { a11: 5, a12: 5, a21: 5, a22: 5, b11: 0, b12: 3, b21: -3, b22: 1 };
const TINY = { a11: 0.001, a12: 0, a21: 0, a22: 0.001, b11: 0, b12: 0.001, b21: 0.001, b22: 0 };
const PROBES = [
  ['W3 label/name numeral', P({ row1: 'Commit 1000 Units' }), TINY],
  ['W3 label/name multiple', P({ row1: 'Hundredfold Expansion' }), TINY],
  ['W3 negotiation: offer+accept', P({ description: 'A yard offers an Early Slot or a Late Slot and the board accepts one of two berths.' }), TINY],
  ['W3 negotiation: binding', P({ description: 'Two yards bargain until they reach an agreement on the calendar.' }), TINY],
  ['W3 alignment: shared goal', P({ description: 'A store and a restorer work together toward the same goal for the display.' }), MP],
  ['W3 alignment: rivals', P({ description: 'A textile company and a competing manufacturer fight for the same order.' }), CI],
  ['W3 alignment: determines', P({ description: "A roastery picks a supplier. The partner's decision will determine the pricing outcome." }), FL],
  ['W4 second decision, same player', P({ description: 'A regional airport uses an Early Slot or a Late Slot. The airport will also choose between a Shared Window and a Separate Window.' }), TINY],
  ['W4 pronoun holds second pair', P({ description: 'A dairy co-op is deciding between an Early Slot and a Late Slot. It chooses either a Shared Window or a Separate Window.' }), TINY],
  ['W4 same move', P({ description: 'A cooperative books an Early Slot or a Late Slot, while the coordinator chooses the same timing.' }), TINY],
];
const reasonOf = (sc, g) => {
  const cf = V.scenarioIsClaimFree(sc);
  if (cf.ok === false) return cf.reason ?? '';
  const vs = V.validateScenario(sc, g);
  return (vs.issues ?? []).join(' | ');
};
let broken = 0;
for (const [tag, sc, g] of PROBES) {
  const re = MINE.find(([t]) => t === tag)[1];
  if (!re.test(reasonOf(sc, g))) { console.error(`INSTRUMENT BROKEN — ${tag} unreachable (got: ${reasonOf(sc, g)})`); broken++; }
}
if (broken) { console.error('Run void.'); process.exit(1); }
console.log(`instrument self-test: all ${PROBES.length} blue rules reachable through the real gate\n`);

const counts = new Map(MINE.map(([t]) => [t, { old: 0, NEW: 0, ex: [] }]));
let total = 0;
for (const r of passing) {
  if (!r.g) continue;
  const why = reasonOf(r.sc, r.g);
  if (!why) continue;
  for (const [tag, re] of MINE) {
    if (re.test(why)) {
      const c = counts.get(tag); c[r.set]++; total++;
      if (c.ex.length < 3) c.ex.push(`[${r.set}] ${r.src}#${r.i}: ${String(r.sc.description ?? '').slice(0, 175)}`);
    }
  }
}
console.log('── What blue\'s rules reject, over every corpus ──');
for (const [tag] of MINE) {
  const c = counts.get(tag);
  const n = c.old + c.NEW;
  console.log(`  ${tag.padEnd(34)} ${String(n).padStart(3)}   (old ${c.old}, NEW ${c.NEW})`);
  for (const e of c.ex) console.log(`        ${e}`);
}
console.log(`\n  TOTAL rejected by blue's rules: ${total}/${passing.length} = ${(100 * total / passing.length).toFixed(3)}%`);

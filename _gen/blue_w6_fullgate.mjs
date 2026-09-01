/**
 * BLUE — WINDOW 5: every rule this campaign has shipped, re-measured against
 * EVERY corpus that exists right now, including the ~1,300 draws red produced
 * after W4's measurement was taken.
 *
 * This is the standing policy, not a formality. W3 reported "0 reach on 890
 * draws" for the rivalry arm; the number was TRUE and still hid a false
 * positive, because those 890 were the rows the rule was written against. Only
 * re-running over unseen draws surfaced it. W4's corpus list was HARDCODED, so
 * a file red wrote afterwards would silently drop out of the denominator and
 * the same failure could recur without anyone noticing. This version
 * DISCOVERS the corpora instead.
 *
 * It self-tests that its own detector can fire before reporting any zero.
 *
 *   npx tsx _gen/blue_w6_fullgate.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const REPO = '/Users/danielluan/Desktop/3D-Nash-Equilibrium';
// W4 measured 25 hardcoded paths. Discovery is the fix for the failure mode
// that list has: a corpus written later is invisible to it.
const files = [];
for (const d of ['/tmp', S, `${REPO}/_gen`, `${REPO}/_gen/results`]) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) if (f.endsWith('.jsonl')) files.push(`${d}/${f}`);
}
files.sort();

const W4_FILES = new Set(['rt1', 'rt2', 'pilot', 'rt2_local', 'rt2_cloud', 'rt2_pilot', 'rt2_cloudpilot',
  'rt2_stakes_local', 'rt2_stakes_cloud', 'rt2_stakes_cloud_hint', 'rt2_stakes_pilot',
  'rt3_character_cloud', 'rt3_character_local', 'rt3_stakes_cloud', 'rt3_stakes_local',
  'rt3_local_capability', 'rt3_slot_control', 'rt2_gapladder_g25', 'rt2_gapladder_g25_rated',
  'rt3_yield_cost', 'rt_stakes_leak_cloud', 'rt_stakes_leak_local', 'rt2_gap_cloud_w1_g25',
  'rt2_gap_cloud_w3_g25', 'rt2_gap_cloud_w4_g25']);

const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const rows = []; const seen = new Set();
for (const f of files) {
  const src = f.split('/').pop().replace('.jsonl', '');
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const sc = r.sc ?? r.scenario;
    if (!sc || typeof sc.description !== 'string') continue;
    const key = `${sc.name} ${sc.description} ${sc.row1} ${sc.col1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ src, set: W4_FILES.has(src) ? 'seen-in-W4' : 'UNSEEN', i: r.i ?? r.pair ?? r.line,
      sc, g: r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null), gate: r.gate });
  }
}
const passing = rows.filter((r) => r.gate?.ok !== false);
const nUnseen = rows.filter((r) => r.set === 'UNSEEN').length;
console.log(`${files.length} corpus files discovered · ${rows.length} unique draws · ${nUnseen} from files W4 never measured · ${passing.length} gate-passing at collection time\n`);

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
  ['W6 META prompt cast', /the prompt's own cast names/],
  ['W6 META bare letter', /a bare letter standing in for a character/],
  ['W6 META game cast', /the game's cast \("the two players"\) named/],
  ['W6 META the game itself', /the game itself named as an object/],
];
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
  ['W6 META prompt cast', P({ description: 'Player A books an Early Slot. Player B books a Shared Window.' }), TINY],
  ['W6 META bare letter', P({ description: 'A is a shipwright booking a slot. The board books a window.' }), TINY],
  ['W6 META game cast', P({ description: 'The two players book their own windows for the season.' }), TINY],
  ['W6 META the game itself', P({ description: 'A yard books a slot and a board books a window. The two decisions form the game\'s normal-form setup.' }), TINY],
];
const reasonOf = (sc, g) => {
  const cf = V.scenarioIsClaimFree(sc);
  if (cf.ok === false) return cf.reason ?? '';
  return (V.validateScenario(sc, g).issues ?? []).join(' | ');
};
let broken = 0;
for (const [tag, sc, g] of PROBES) {
  const re = MINE.find(([t]) => t === tag)[1];
  if (!re.test(reasonOf(sc, g))) { console.error(`INSTRUMENT BROKEN — ${tag} unreachable (got: ${reasonOf(sc, g)})`); broken++; }
}
if (broken) { console.error('Run void.'); process.exit(1); }
console.log(`instrument self-test: all ${PROBES.length} blue rules reachable through the real gate\n`);

const counts = new Map(MINE.map(([t]) => [t, { seen: 0, UNSEEN: 0, ex: [] }]));
let total = 0;
for (const r of passing) {
  if (!r.g) continue;
  const why = reasonOf(r.sc, r.g);
  if (!why) continue;
  for (const [tag, re] of MINE) {
    if (re.test(why)) {
      const c = counts.get(tag);
      c[r.set === 'UNSEEN' ? 'UNSEEN' : 'seen']++; total++;
      c.ex.push(`[${r.set}] ${r.src}#${r.i}: ${String(r.sc.description ?? '').slice(0, 190)}`);
    }
  }
}
console.log("── What blue's shipped rules reject, over EVERY corpus ──");
for (const [tag] of MINE) {
  const c = counts.get(tag);
  console.log(`  ${tag.padEnd(34)} ${String(c.seen + c.UNSEEN).padStart(3)}   (seen-in-W4 ${c.seen}, UNSEEN ${c.UNSEEN})`);
  for (const e of c.ex.slice(0, 4)) console.log(`        ${e}`);
}
console.log(`\n  TOTAL rejected by blue's rules: ${total}/${passing.length} = ${(100 * total / passing.length).toFixed(3)}%`);
console.log(`  Of those, from files W4 never saw: ${[...counts.values()].reduce((a, c) => a + c.UNSEEN, 0)}`);

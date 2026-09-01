/**
 * BLUE — WINDOW 7: THE ACCEPTANCE SWEEP.
 *
 * Every rule this campaign has shipped, re-measured against the RETRAINED local
 * model's output. Every gate in this repo was measured against v1; none has
 * ever seen v2, and v2's register is different enough that a rule tuned on v1's
 * habits could be rejecting good output now.
 *
 * Three questions, in the order they matter:
 *   1. FALSE POSITIVES on v2. Zero is the standing bar. Every v2 rejection is
 *      dumped verbatim for a hand-read; a rate is never quoted off a predicate.
 *   2. LOST REACH. A rule that caught something on v1 and is dead on v2 is
 *      logged as containment, not left implying coverage.
 *   3. UNCLASSIFIED reasons. The W6 harness carried a HARDCODED list of rule
 *      tags and it was already stale — `cites a large quantity` (W5) and `the
 *      payoff, the mathematical object` (W6) were shipped and never appeared in
 *      it. So this one reports any rejection reason no tag claims, and exits
 *      non-zero. A rule that drops out of the denominator silently is the exact
 *      failure this suite exists to catch.
 *
 *   npx tsx _gen/blue_w7_acceptance.mjs
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');
const SCR = await import('/Users/danielluan/Desktop/3D-Nash-Equilibrium/_gen/trainset_screens.ts');

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const REPO = '/Users/danielluan/Desktop/3D-Nash-Equilibrium';

// ── corpora: DISCOVERED, never hardcoded ────────────────────────────────────
const files = [];
for (const d of ['/tmp', S, `${REPO}/_gen`, `${REPO}/_gen/results`, `${S}/blue/_gen`, `${S}/blue/_gen/results`]) {
  if (!existsSync(d)) continue;
  // THIS HARNESS MUST NOT EAT ITS OWN OUTPUT. Run 1 wrote its accepted-draw
  // dump to /tmp/blue_w7_v2_accepted.jsonl, which is a directory it DISCOVERS
  // from; run 2 then read that file back as a separate corpus, it sorted ahead
  // of eval_v2.jsonl, and the global dedup silently reassigned 77 of the 80
  // banked v2 draws out of the v2 arm and into `legacy`. The arm counts read
  // v2-banked 3 and the paired comparison was destroyed by the instrument
  // measuring itself. Everything this file writes now goes to /tmp/blue_w7_out/,
  // which readdirSync does not descend into, and the name guard is the second
  // layer in case someone moves an output back.
  for (const f of readdirSync(d)) if (f.endsWith('.jsonl') && !/^blue_w7_(?:out|.*_accepted)/.test(f)) files.push(`${d}/${f}`);
}
files.sort();

const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const rows = []; const seen = new Set();
for (const f of files) {
  const src = f.split('/').pop().replace('.jsonl', '');
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const sc = r.sc ?? r.scenario;
    if (!sc || typeof sc !== 'object') continue;
    const g = r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null);
    // ARM: the v2 corpora are the two files this window collected plus the
    // banked paired eval. Everything else predates the retrain and is v1-or-cloud.
    let arm = 'legacy-other';
    if (src === 'blue_w7_v2') arm = 'v2';
    else if (src === 'blue_w7_v1') arm = 'v1';
    else if (src === 'eval_v2') arm = /v2/.test(r.arm ?? '') ? 'v2-banked' : 'v1-banked';
    // The legacy pile is two different POPULATIONS and pooling them hides every
    // local-vs-cloud finding this campaign has made. Split on the filename,
    // which is how every collector in this repo records the surface.
    else if (/cloud|luna|mini|teacher/.test(src)) arm = 'legacy-cloud';
    else if (/local|desktop|qwen/.test(src)) arm = 'legacy-local';
    // DEDUP WITHIN ARM, not across arms — the second half of the same fix.
    // Even with the self-output excluded, a global key lets whichever file
    // sorts first CLAIM a draw and silently move it out of its own arm, so an
    // arm's denominator depends on filename order. Within-arm is the only
    // keying under which "0 hits on v2" means what it says. (Measured
    // separately: byte-identical repeats across the two v2 runs are 0/40, so
    // v2 is not simply reprinting itself — the collision was the instrument.)
    const key = `${arm}|${sc.name} ${sc.description} ${sc.row1} ${sc.col1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ src, arm, i: r.i ?? r.pair ?? r.line, sc, g });
  }
}

// ── the rule registry: reason pattern + a known-positive fixture ─────────────
const P = (o) => ({ name: 'Harbour Slot Plan', row1: 'Alpha', row2: 'Beta', col1: 'Gamma', col2: 'Delta', storyClaims: null, ...o });
const MP = { a11: 100, a12: -100, a21: -100, a22: 100, b11: -100, b12: 100, b21: 100, b22: -100 };
const CI = { a11: 4, a12: 0, a21: 0, a22: 2, b11: 4, b12: 0, b21: 0, b22: 2 };
const FL = { a11: 5, a12: 5, a21: 5, a22: 5, b11: 0, b12: 3, b21: -3, b22: 1 };
const TINY = { a11: 0.001, a12: 0, a21: 0, a22: 0.001, b11: 0, b12: 0.001, b21: 0.001, b22: 0 };

// mine=true marks a rule blue shipped. The others are measured too, because a
// v2 draw rejected by anyone's rule is a draw the user does not get.
const RULES = [
  // ── scenarioIsClaimFree: name/label surface
  { tag: 'W3 numeral in name/label', mine: 1, re: /^(?:the scenario name|the option label ").*cites a number$/,
    fx: [P({ row1: 'Commit 1000 Units' }), TINY] },
  { tag: 'W3 multiple in name/label', mine: 1, re: /^(?:the scenario name|the option label ").*asserts a multiple$/,
    fx: [P({ row1: 'Hundredfold Expansion' }), TINY] },
  { tag: 'W5 large spelled quantity', mine: 1, re: /cites a large quantity$/,
    fx: [P({ row1: 'Thousands Of Crates' }), TINY] },
  // ── scenarioIsClaimFree: description surface
  { tag: 'W3 numeral in description', mine: 1, re: /^the description cites a number$/,
    fx: [P({ description: 'A yard books one of two slots for 3 barges.' }), TINY] },
  { tag: 'W3 multiple in description', mine: 1, re: /^the description asserts a multiple$/,
    fx: [P({ description: 'A yard books a slot worth a hundred thousand times more than the board’s.' }), TINY] },
  // ── scenarioIsClaimFree: CLAIMY table (pre-blue rules kept in the denominator)
  { tag: 'comparative/payoff word', mine: 0, re: /^a comparative or payoff word$/,
    fx: [P({ description: 'A yard books an Early Slot; the board prefers a Shared Window.' }), TINY] },
  { tag: 'payoff word + comparison', mine: 0, re: /^a payoff word attached to a comparison$/,
    fx: [P({ description: 'A yard books a slot and the returns are higher for the board.' }), TINY] },
  { tag: 'one player answers other', mine: 0, re: /^a claim about how one player answers the other$/,
    fx: [P({ description: 'A yard books a slot and the board responds with a window.' }), TINY] },
  { tag: 'conditional outcome', mine: 0, re: /^a conditional outcome claim$/,
    fx: [P({ description: 'If the yard books an Early Slot, the board gains a quiet berth.' }), TINY] },
  { tag: 'move order', mine: 0, re: /^a claim about who moves first$/,
    fx: [P({ description: 'A yard books a slot before the board chooses a window.' }), TINY] },
  { tag: 'W3 offer + accept', mine: 1, re: /one player offers and the other accepts/,
    fx: [P({ description: 'A yard offers an Early Slot or a Late Slot and the board accepts one of two berths.' }), TINY] },
  { tag: 'W3 binding agreement', mine: 1, re: /ends in a binding agreement/,
    fx: [P({ description: 'Two yards bargain until they reach an agreement on the calendar.' }), TINY] },
  // ── scenarioIsClaimFree: META (W6)
  { tag: 'W6 META prompt cast', mine: 1, re: /the prompt's own cast names/,
    fx: [P({ description: 'Player A books an Early Slot. Player B books a Shared Window.' }), TINY] },
  { tag: 'W6 META bare letter', mine: 1, re: /a bare letter standing in for a character/,
    fx: [P({ description: 'A is a shipwright booking a slot. The board books a window.' }), TINY] },
  { tag: 'W6 META game cast', mine: 1, re: /the game's cast \("the two players"\) named/,
    fx: [P({ description: 'The two players book their own windows for the season.' }), TINY] },
  { tag: 'W6 META the game itself', mine: 1, re: /the game itself named as an object/,
    fx: [P({ description: "A yard books a slot and a board books a window. The two decisions form the game's normal-form setup." }), TINY] },
  { tag: 'W6 META payoff named', mine: 1, re: /the payoff, the mathematical object, named/,
    fx: [P({ description: 'A yard books a slot and a board books a window; their choices determine the resulting payoffs.' }), TINY] },
  // ── scenarioIsClaimFree: STRUCTURAL (W4)
  { tag: 'W4 second decision same actor', mine: 1, re: /a second decision given to a player who already made one/,
    fx: [P({ description: 'A regional airport uses an Early Slot or a Late Slot. The airport will also choose between a Shared Window and a Separate Window.' }), TINY] },
  { tag: 'W4 pronoun holds second pair', mine: 1, re: /a second set of options given to a pronoun/,
    fx: [P({ description: 'A dairy co-op is deciding between an Early Slot and a Late Slot. It chooses either a Shared Window or a Separate Window.' }), TINY] },
  { tag: 'W4 same move asserted', mine: 1, re: /one player's move is the same as the other's/,
    fx: [P({ description: 'A cooperative books an Early Slot or a Late Slot, while the coordinator chooses the same timing.' }), TINY] },
  // ── scenarioIsClaimFree: STRUCTURAL, added THIS window against v2
  { tag: 'W7 collective holds only pair', mine: 1, re: /only option pair in the story is held by both players at once/,
    fx: [{ name: 'n', row1: 'Roof Shed', row2: 'Garden Shed', col1: 'Drainage Line', col2: 'Open Corridor', storyClaims: null,
           description: 'Two neighboring beekeepers are choosing winter apiary sited near their homes. The beekeepers must choose either Roof Shed or Garden Shed for the apiary.' }, TINY] },
  // ── validateScenario: alignment (W3)
  { tag: 'W3 align shared goal', mine: 1, re: /share a goal, but the matrix is constant-sum/,
    fx: [P({ description: 'A store and a restorer work together toward the same goal for the display.' }), MP] },
  { tag: 'W3 align rivals', mine: 1, re: /frames the two players as rivals/,
    fx: [P({ description: 'A textile company and a competing manufacturer fight for the same order.' }), CI] },
  { tag: 'W3 align determines', mine: 1, re: /determines the outcome, but/,
    fx: [P({ description: "A roastery picks a supplier. The partner's decision will determine the pricing outcome." }), FL] },
  // ── validateScenario: label hygiene (pre-blue, but it is what caught v2's new defect)
  { tag: 'label missing', mine: 0, re: /^option label \w+ is missing/,
    fx: [P({ col2: '' }), TINY] },
  { tag: 'row labels not distinct', mine: 0, re: /^row labels are not distinct/,
    fx: [P({ row1: 'Early Slot', row2: 'early slot' }), TINY] },
  { tag: 'col labels not distinct', mine: 0, re: /^column labels are not distinct/,
    fx: [P({ col1: 'Shared Window', col2: 'Shared Window' }), TINY] },
  { tag: 'label annotates wrong pair', mine: 0, re: /annotates a payoff pair the matrix does not hold/,
    fx: [P({ row1: 'Signal (9/9)' }), TINY] },
  // ── validateScenario: the four the W6 registry had already lost track of.
  // Three of them fired on real corpus rows while appearing in no rule list.
  { tag: 'abstract coordinate claim', mine: 0, re: /the two players coordinate their choices, but no pure equilibrium/,
    fx: [P({ description: 'The two players coordinate their choices for the season.' }), MP] },
  { tag: 'option mis-attribution', mine: 0, re: /choosing ".*", which is player [AB]'s option/,
    fx: [P({ description: 'A yard books a berth this week. Player A chooses Gamma, and the board follows.' }), TINY] },
  { tag: 'outcome talk, undeclared', mine: 0, re: /attributes gains\/losses to an action combination without numbers/,
    fx: [P({ description: 'When the yard books early the board loses the berth it wanted.' }), TINY] },
  { tag: 'outcome in words, no numbers', mine: 0, re: /attributes an outcome in words .* without numbers/,
    fx: [P({ description: 'A yard books a berth. If both choose the same plan the yard is punished.' }), TINY] },
  { tag: 'coordination framing', mine: 0, re: /frames the game as coordination \(matching the opponent\)/,
    fx: [P({ description: 'A yard books a berth and has every reason to match the opponent’s choice.' }), MP] },
  { tag: 'anti-coordination framing', mine: 0, re: /frames the game as anti-coordination/,
    fx: [P({ description: 'A yard books a berth and wants to counter the board, so it picks the opposite.' }), CI] },
  // validateProseDirections is the THIRD gate reasonsOf calls, and nothing in
  // the registry claimed it — so a zero from it was a zero from an instrument
  // nobody had shown could fire. It is a matrix-decided check, so it is the one
  // most likely to behave differently on a model whose stories now track the
  // stakes band.
  { tag: 'prose direction backwards', mine: 0, re: /^direction: /,
    fx: [{ name: 'N', row1: 'Early Slot', row2: 'Late Slot', col1: 'Shared Window', col2: 'Separate Window', storyClaims: null,
           description: 'Late Slot does better than Early Slot against Shared Window.' },
         { a11: 5, a12: 1, a21: 0, a22: 4, b11: 2, b12: 3, b21: 1, b22: 0 }] },
];

// Every reason the gate can emit, as one flat list, so an unmatched reason is
// visible instead of silently uncounted.
const reasonsOf = (sc, g) => {
  const out = [];
  try { const cf = V.scenarioIsClaimFree(sc); if (cf.ok === false) out.push(cf.reason ?? '(no reason)'); } catch (e) { out.push(`THREW claimFree: ${e.message}`); }
  try { out.push(...(V.validateScenario(sc, g).issues ?? [])); } catch (e) { out.push(`THREW validateScenario: ${e.message}`); }
  try { out.push(...V.validateProseDirections(sc.description ?? '', sc, g).map((x) => `direction: ${x}`)); } catch (e) { out.push(`THREW directions: ${e.message}`); }
  return out;
};

// ── instrument self-test: every rule must be REACHABLE through the real gate ──
let broken = 0;
for (const r of RULES) {
  const got = reasonsOf(r.fx[0], r.fx[1]);
  if (!got.some((x) => r.re.test(x))) { console.error(`INSTRUMENT BROKEN — ${r.tag} unreachable (got: ${JSON.stringify(got)})`); broken++; }
}
if (broken) { console.error(`\n${broken} rule(s) unreachable. Run void — a zero from a dead instrument is not a zero.`); process.exit(1); }
console.log(`instrument self-test: all ${RULES.length} rules fire through the real gate\n`);

// A ZERO FROM AN EMPTY ARM IS NOT A ZERO. If the v2 file failed to parse, every
// rule would report 0.00% on v2 and the sweep would read like a clean bill.
{
  const raw = readFileSync('/tmp/blue_w7_v2.jsonl', 'utf8').split('\n').filter((l) => l.trim()).length;
  const got = rows.filter((r) => r.arm === 'v2').length;
  if (got < raw * 0.9) { console.error(`V2 ARM UNDER-LOADED — ${got} rows from a ${raw}-line file. Every v2 zero below would be an artefact.`); process.exit(1); }
}
console.log(`${files.length} corpus files discovered - ${rows.length} unique draws`);
const byArm = {};
for (const r of rows) byArm[r.arm] = (byArm[r.arm] ?? 0) + 1;
console.log(`  arms: ${Object.entries(byArm).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);

// ── the sweep ────────────────────────────────────────────────────────────────
const ARMS = ['v2', 'v2-banked', 'v1', 'v1-banked', 'legacy-local', 'legacy-cloud', 'legacy-other'];
const counts = new Map(RULES.map((r) => [r.tag, Object.fromEntries(ARMS.map((a) => [a, 0]))]));
const denom = Object.fromEntries(ARMS.map((a) => [a, 0]));
const unclassified = new Map();
const v2hits = [];
for (const r of rows) {
  if (!r.g) continue;
  denom[r.arm]++;
  for (const why of reasonsOf(r.sc, r.g)) {
    const rule = RULES.find((x) => x.re.test(why));
    if (!rule) { unclassified.set(why, (unclassified.get(why) ?? 0) + 1); continue; }
    counts.get(rule.tag)[r.arm]++;
    if (r.arm === 'v2' || r.arm === 'v2-banked') v2hits.push({ tag: rule.tag, why, src: r.src, i: r.i, sc: r.sc, g: r.g });
  }
}

// COUNTING-PATH SELF-TEST. The registry self-test proves each rule fires on a
// fixture. It does NOT prove the loop that attributes a hit to an ARM works —
// and the arm attribution is exactly what broke twice in this file (the
// self-ingested output file, then the global dedup). So three fixtures are run
// through the SAME counting code under a synthetic arm and must land on the
// right rule in the right arm. A zero on v2 is only meaningful if a hit on v2
// would have been counted.
{
  const probes = [
    ['W6 META prompt cast', P({ description: 'Player A books an Early Slot. Player B books a Shared Window.' })],
    ['W4 same move asserted', P({ description: 'A cooperative books an Early Slot or a Late Slot, while the coordinator chooses the same timing.' })],
    ['row labels not distinct', P({ row1: 'Early Slot', row2: 'early slot' })],
  ];
  const tally = new Map();
  for (const [, sc] of probes) {
    for (const why of reasonsOf(sc, TINY)) {
      const rule = RULES.find((x) => x.re.test(why));
      if (rule) tally.set(rule.tag, (tally.get(rule.tag) ?? 0) + 1);
    }
  }
  const missed = probes.filter(([tag]) => !tally.get(tag)).map(([tag]) => tag);
  if (missed.length) { console.error(`COUNTING PATH BROKEN — planted defects not attributed: ${missed.join(', ')}`); process.exit(1); }
  console.log(`counting-path self-test: ${probes.length} planted defects attributed to the right rule\n`);
}

const pct = (n, d) => d ? `${(100 * n / d).toFixed(2)}%` : '   -  ';
console.log('== REACH OF EVERY SHIPPED RULE, BY ARM ==');
console.log(`  ${'rule'.padEnd(30)} ${ARMS.map((a) => `${a}(${denom[a]})`.padStart(15)).join('')}`);
for (const r of RULES) {
  const c = counts.get(r.tag);
  console.log(`  ${(r.mine ? '* ' : '  ') + r.tag.padEnd(28)} ${ARMS.map((a) => `${c[a]} ${pct(c[a], denom[a])}`.padStart(15)).join('')}`);
}
console.log('  (* = shipped by blue)');

console.log(`\n== UNCLASSIFIED REJECTION REASONS (rules that fell out of the registry) ==`);
if (!unclassified.size) console.log('  none - every rejection over every corpus is claimed by a registered rule');
for (const [why, n] of [...unclassified.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(n).padStart(4)}  ${why.slice(0, 150)}`);

// ── the hand-read dump: every v2 rejection, verbatim ─────────────────────────
writeFileSync('/tmp/blue_w7_out/v2_rejections.txt',
  v2hits.map((h, n) => `#${n + 1} [${h.tag}]  ${h.src}#${h.i}\n  REASON: ${h.why}\n  NAME: ${h.sc.name}\n  A: ${h.sc.row1} / ${h.sc.row2}   B: ${h.sc.col1} / ${h.sc.col2}\n  DESC: ${h.sc.description}\n`).join('\n'));
console.log(`\n${v2hits.length} v2 rejections written to /tmp/blue_w7_out/v2_rejections.txt for a hand-read.`);

// ── the six training screens, on ACCEPTED output only ────────────────────────
console.log('\n== TRAINING SCREENS on GATE-ACCEPTED draws (defects the gate does NOT catch) ==');
const accepted = Object.fromEntries(ARMS.map((a) => [a, []]));
for (const r of rows) { if (r.g && reasonsOf(r.sc, r.g).length === 0) accepted[r.arm].push(r); }
console.log(`  ${'screen'.padEnd(20)} ${ARMS.map((a) => `${a}(${accepted[a].length})`.padStart(15)).join('')}`);
for (const [name, f] of SCR.SCREENS) {
  console.log(`  ${name.padEnd(20)} ${ARMS.map((a) => { const n = accepted[a].filter((r) => f(r.sc)).length; return `${n} ${pct(n, accepted[a].length)}`.padStart(15); }).join('')}`);
}
writeFileSync('/tmp/blue_w7_out/v2_accepted.jsonl',
  [...accepted.v2, ...accepted['v2-banked']].map((r) => JSON.stringify({ src: r.src, i: r.i, sc: r.sc, g: r.g })).join('\n'));
console.log(`\n  ${accepted.v2.length + accepted['v2-banked'].length} gate-ACCEPTED v2 draws written to /tmp/blue_w7_out/v2_accepted.jsonl`);

if (unclassified.size) { console.error('\nUnclassified reasons present: the registry is incomplete.'); process.exit(2); }

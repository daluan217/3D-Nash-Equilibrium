/**
 * BLUE — WINDOW 7, QUESTION 3 continued: the candidate classes found by READING
 * v2 output, priced on both arms before anything is proposed.
 *
 * Everything here came out of a hand-read, not out of a predicate. That order
 * matters: this campaign's eight over-firing predicates were all written first
 * and read afterwards. Each candidate below therefore ships with its hits
 * printed in full so the rate can be checked against the text that produced it.
 *
 *   npx tsx _gen/blue_w7_newclasses.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describeStakes } from '../src/utils/scenarioStakes.ts';

const load = (f, arm) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => JSON.parse(l)).filter((r) => r.scenario)
  .map((r) => ({ arm, i: r.i, domain: r.domain, sc: r.scenario, g: r.game, swing: r.swing }));
const A = { v1: load('/tmp/blue_w7_v1.jsonl', 'v1'), v2: load('/tmp/blue_w7_v2.jsonl', 'v2') };
const n = Math.min(A.v1.length, A.v2.length);
A.v1 = A.v1.slice(0, n); A.v2 = A.v2.slice(0, n);

const D = (r) => (r.sc.description ?? '');
const L = (r) => [r.sc.row1, r.sc.row2, r.sc.col1, r.sc.col2].map((x) => (x ?? '').trim());
const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\b(\w{4,})s\b/g, '$1').trim();

// C1. THE STAKES BAND SAID OUT LOUD. v2 verbalises the band the stakes hint
// computed; v1 essentially does not. Only wrong if it CONTRADICTS the matrix,
// which is decidable, so both the rate and the contradiction rate are reported.
const BIG = /\b(?:high[- ]stakes|large|huge|enormous|massive|major|substantial|significant|crucial|critical|vital)\b/i;
const SMALL = /\b(?:low[- ]stakes|modest|routine|minor|everyday|ordinary|small)\b/i;
// The stakes hint's own bands, from scenarioStakes.stakesHint.
const band = (sw) => (sw < 1 ? 1 : sw < 10 ? 2 : sw < 50 ? 3 : 4);
// Scope: the adjective must modify the SITUATION, not a party or a thing. "A
// small cider cooperative" is the size of the firm and says nothing about the
// payoffs; "a modest hedge-laying project" is the stakes. Without this the
// predicate reads 18.6% on v2 AND 16.0% on v1 and separates nothing.
const SITUATION = String.raw`(?:job|project|contract|deal|order|batch|run|season|window|slot|booking|edition|repair|survey|harvest|crossing|shipment|rotation|service|decision|choice|stakes|amount|sum|investment|commitment|round|bid|grant|pact|allocation|adjustment)s?`;
const situated = (re) => new RegExp(String.raw`\b(?:a|an|the|this|its|their|one)?\s*(?:${re.source.replace(/\\b|\(\?:|\)|\/i/g, '').replace(/^\\b/, '')})\s+(?:\w+[- ]){0,3}${SITUATION}\b`, 'i');
const bigSituated = new RegExp(String.raw`\b(?:high[- ]stakes|large|huge|enormous|massive|major|substantial|significant|crucial|critical|vital)\s+(?:\w+[- ]){0,3}${SITUATION}\b`, 'i');
const smallSituated = new RegExp(String.raw`\b(?:low[- ]stakes|modest|routine|minor|everyday|ordinary|small)\s+(?:\w+[- ]){0,3}${SITUATION}\b`, 'i');

// C2. THE PROMPT'S STAKES LINE, COPIED. "the amounts at stake" is the hint's
// own wording appearing in user-facing fiction — the same class as META, in a
// vocabulary the META screen does not hold.
const STAKES_PROMPT = /\b(?:amounts?\s+at\s+stake|at\s+stake\b|the\s+parties\b|everyday\s+setting|fine\s+adjustment|transformed\s+by\s+it|small\s+and\s+ordinary)\b/i;

// C3. NEAR-COLLIDING LABEL PAIRS. labelCollision is an EXACT match, so
// "Early Rotas / Late Rotas" against "Early Rota / Late Rota" — one plural —
// reads to it as four distinct options. To a reader both players are choosing
// the same thing, and validateProseDirections' label matching is the check that
// collision was shown to blind.
// The `exact` guard MUST read the RAW labels. Written against the normalised
// ones it excluded precisely the case it exists to find — "Early Rotas / Late
// Rotas" against "Early Rota / Late Rota" normalises to an exact match on both
// sides, so the guard fired and the rule reported 0.0% on the draw that
// prompted it. Ninth over-firing-or-under-firing first draft this campaign, and
// the first that failed by being silently EMPTY rather than noisy.
const nearCollision = (r) => {
  const raw = L(r).map((x) => x.toLowerCase());
  const [r1, r2, c1, c2] = L(r).map(norm);
  const exactRaw = [raw[0], raw[1]].some((x) => x && [raw[2], raw[3]].includes(x));
  const nearHit = [r1, r2].filter(Boolean).some((x) => [c1, c2].includes(x));
  return !exactRaw && nearHit;
};
// C4. BOTH PLAYERS' PAIRS BUILT FROM THE SAME MODIFIERS ("Early X / Late X" on
// one side and "Early Y / Late Y" on the other). Not false, but it reads as one
// decision printed twice, which is the register half of the two-chooser defect.
const sameModifiers = (r) => {
  const [r1, r2, c1, c2] = L(r).map((x) => norm(x).split(/\s+/));
  if (!r1[0] || !r2[0] || !c1[0] || !c2[0]) return false;
  const pair = (x, y) => `${x[0]}|${y[0]}`;
  return r1.length > 1 && c1.length > 1 && pair(r1, r2) === pair(c1, c2);
};
// C5. A CHATBOT-REGISTER OPTION LABEL. Found once ("Ask me next").
const addressLabel = (r) => L(r).some((l) => /^(?:ask|tell|let|please|yes|no|maybe|sorry|thanks|ok|okay)\b/i.test(l));
// C6. THE DOMAIN PHRASE ITSELF AS THE ACTOR: "Two avalanche patrol ROSTERS are
// deciding…" hands agency to the schedule rather than to a person.
const domainIsActor = (r) => {
  const head = String(r.domain ?? '').split(/\s+/).slice(-1)[0].toLowerCase().replace(/s$/, '');
  if (head.length < 4) return false;
  return new RegExp(String.raw`^(?:two|both|the|a|an)\s+(?:\w+\s+){0,3}${head}s?\s+(?:are|is|must|will|have)\b`, 'i').test(D(r));
};

const CANDIDATES = [
  ['C1 stakes band said out loud', (r) => bigSituated.test(D(r)) || smallSituated.test(D(r))],
  // THE CONTRADICTION TEST HAD TO STOP READING THE OPTION LABELS. Its first
  // draft reported 2 hits on v2 and 1 on v1, and a hand-read killed all three:
  // every one was an option LABEL quoted inside the description — "the
  // cooperative chooses Small Order or Large Order" on a band-1 game, where
  // "Large Order" is the name of an option and asserts nothing about the
  // stakes. validateScenario's own outcome rule already carries a labelWords
  // exclusion for exactly this; not copying it cost a wrong rate. Labels are
  // blanked before the test rather than the sentence being skipped, so a
  // description that ALSO makes a real magnitude claim still counts.
  ['C1a  ... and it CONTRADICTS the matrix', (r) => {
    const b = band(describeStakes(r.g).swing);
    let t = D(r);
    for (const l of L(r)) if (l) t = t.replace(new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '_');
    return (bigSituated.test(t) && b <= 2) || (smallSituated.test(t) && b >= 4);
  }],
  ['C2 stakes prompt wording copied', (r) => STAKES_PROMPT.test(D(r))],
  ['C3 near-colliding label pairs', nearCollision],
  ['C4 both pairs share modifiers', sameModifiers],
  ['C5 chatbot-register label', addressLabel],
  ['C6 domain phrase as the actor', domainIsActor],
  // C7. THE LABEL SLOT DISAGREES WITH THE MODEL'S OWN SENTENCE. Every duplicate
  // -label rejection on v2 has this shape: the JSON carries "Shared Slot /
  // Shared Slot" while the description in the SAME response says "between
  // Shared Slot and Reserved Slot". The model wrote two distinct options in
  // prose and repeated one of them in the structured field, so this is a
  // serialisation failure, not an invention failure — worth separating because
  // the two have different fixes and only one of them is a training problem.
  ['C7 duplicate label, prose names two', (r) => {
    const [r1, r2, c1, c2] = L(r).map((x) => x.toLowerCase());
    const dup = (r1 && r1 === r2) || (c1 && c1 === c2);
    if (!dup) return false;
    return [...D(r).matchAll(/\bbetween\s+([\w' -]{2,30}?)\s+and\s+([\w' -]{2,30}?)(?=[,.;]|\s+(?:for|while|and|whereas)\b|$)/gi)]
      .some((m) => m[1].trim().toLowerCase() !== m[2].trim().toLowerCase());
  }],
  ['C7b duplicate label at all', (r) => {
    const [r1, r2, c1, c2] = L(r).map((x) => x.toLowerCase());
    return Boolean((r1 && r1 === r2) || (c1 && c1 === c2));
  }],
];

console.log(`paired on ${n} identical (game, domain) cells\n`);
console.log(`${'candidate'.padEnd(40)} ${'v1'.padStart(13)} ${'v2'.padStart(13)}`);
const dump = [];
for (const [name, f] of CANDIDATES) {
  const h1 = A.v1.filter(f), h2 = A.v2.filter(f);
  const p = (k) => `${k} (${(100 * k / n).toFixed(1)}%)`;
  console.log(`${name.padEnd(40)} ${p(h1.length).padStart(13)} ${p(h2.length).padStart(13)}`);
  dump.push(`=== ${name} ===\n` + ['v1', 'v2'].map((arm) => {
    const hits = arm === 'v1' ? h1 : h2;
    return `-- ${arm} ${hits.length}/${n} --\n` + hits.map((r) => `  [${r.i}] swing=${describeStakes(r.g).swing.toFixed(2)} band=${band(describeStakes(r.g).swing)} ${r.domain}\n    labels: ${L(r).join(' / ')}\n    ${D(r)}`).join('\n');
  }).join('\n') + '\n');
}
writeFileSync('/tmp/blue_w7_out/newclasses.txt', dump.join('\n'));
console.log(`\nEvery hit printed in full -> /tmp/blue_w7_out/newclasses.txt (hand-read before quoting any rate)`);

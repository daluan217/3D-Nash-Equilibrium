import assert from 'node:assert';
import { screenScenario } from '../src/utils/scenarioScreen';
import { validateScenario } from '../src/utils/nashValidator';
import { allBankRows } from '../src/utils/bankSource';
import type { GamePayoffs, SuggestedScenario } from '../src/types';

// FIX-VERIFICATION of RED-CLOUD-20/006 — the comparator lives inside
// validateScenario, so assert through the EXPORTED gate at the shipping
// surface, never on a copied comparator (the harness must match the
// shipping condition).
const G: GamePayoffs = { a11: 0.2, a12: 0, a21: 0, a22: 0.1, b11: 0.2, b12: 0, b21: 0, b22: 0.1 };
const labels = (over: Partial<SuggestedScenario>): SuggestedScenario => ({
  name: 'Punctuation Game', row1: 'Left', row2: 'Right', col1: 'Up', col2: 'Down',
  description: 'A scenario with (!) option chosen while others choose Left and Right.',
  actorA: ['Player One'], actorB: ['Player Two'], ...over,
});

// 1. The fix: identical parenthesized punctuation labels are rejected.
assert.strictEqual(validateScenario(labels({ row1: '(!)', row2: '(!)' }), G, { actorNouns: true }).ok, false,
  'FIX: identical "(!)" row labels are rejected as non-distinct');

// 2. Controls — the pairs #192 deliberately ACCEPTED stay accepted, and the
// pairs the union deliberately REJECTS stay rejected.
assert.strictEqual(validateScenario(labels({ row1: '!!', row2: '??' }), G, { actorNouns: true }).ok, true,
  'CONTROL: distinct punctuation-only literals stay distinct (#192)');
assert.strictEqual(validateScenario(labels({ row1: 'Ship (fast)', row2: 'Ship (slow)' }), G, { actorNouns: true }).ok, false,
  'CONTROL: parenthetical-variant pair stays rejected');
assert.strictEqual(validateScenario(labels({ row1: 'Fire Early', row2: 'Fire Early.' }), G, { actorNouns: true }).ok, false,
  'CONTROL: colorTermKey-identical pair stays rejected');

// 3. End-to-end: the identical-(!) scenario no longer passes the screen pipeline.
const sc: SuggestedScenario = labels({ row1: '(!)', row2: '(!)' });
assert.strictEqual(screenScenario(sc, G, { directionChecks: false }).ok, false,
  'FIX: screenScenario rejects the identical-(!)-label scenario');

// 4. Reach across all shipped bank rows — unchanged (hole, not a live defect).
let bankReach = 0;
for (const e of allBankRows()) {
  const s = e.s;
  for (const [x, y] of [[s.row1, s.row2], [s.col1, s.col2]]) {
    if (x && y && x === y) bankReach++;
  }
}
assert.strictEqual(bankReach, 0, 'bank reach is 0 (hole, not defect — fix changes no shipped row)');

console.log('Fix verified: identical parenthesized punctuation labels are rejected; all controls hold; bank reach still 0.');

/**
 * One predicate decides whether a report envelope may be shown and prefilled
 * from. It exists because TWO call sites asked that question and drifted.
 *
 * The display path learned about 'template' envelopes when the rung-3 flag
 * shipped. The "generate a new game" dialog did not, and went on requiring
 * `source === 'llm'`. Production runs rung 3, which NEVER emits 'llm' — so that
 * dialog discarded a perfectly good scenario on EVERY generation and told the
 * user "the AI scenario isn't available right now". Not intermittent: 100%,
 * from the flag flip until this test existed.
 *
 * The first case below is that bug, written as the shape the server actually
 * returns in production — `source: 'template'`, `validation: null`, a complete
 * scenario — rather than as a paraphrase of it.
 */
import { envelopeIsTrustworthy } from './App';

let failures = 0;
const check = (name: string, ok: boolean): void => {
  if (!ok) { console.error(`  ✗ ${name}`); failures++; }
};
const report = { claimedEquilibria: [], prose: 'x', proseClaims: null, suggestedScenario: { name: 'n' } };

// THE REGRESSION. Verified against production: source 'template', validation
// null, scenario present. `validation` is null by design, not by omission —
// the sentences are rendered from the solver, so there are no model claims to
// check, and the scenario was already gated server-side by validateScenario +
// scenarioIsClaimFree + the direction checks before being included.
check('a rung-3 template envelope is trustworthy',
  envelopeIsTrustworthy({ source: 'template', validation: null, report } as never));
check('...even though it carries no validation object',
  envelopeIsTrustworthy({ source: 'template', report } as never));

// The model path still has to show its receipt.
check('an llm envelope needs validation.ok',
  envelopeIsTrustworthy({ source: 'llm', validation: { ok: true }, report } as never));
check('an llm envelope that FAILED validation is refused',
  !envelopeIsTrustworthy({ source: 'llm', validation: { ok: false }, report } as never));
check('an llm envelope with no validation is refused',
  !envelopeIsTrustworthy({ source: 'llm', report } as never));

// No report is no envelope, whatever the source says.
check('a template envelope with no report is refused',
  !envelopeIsTrustworthy({ source: 'template', report: null } as never));
check('null is refused', !envelopeIsTrustworthy(null));
check('undefined is refused', !envelopeIsTrustworthy(undefined));

if (failures > 0) { console.error(`✗ envelope: ${failures} failed`); process.exit(1); }
console.log('✓ envelope: rung-3 template envelopes are trusted (validation is null BY DESIGN there), llm envelopes still need validation.ok, no report is never trusted');

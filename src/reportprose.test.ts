/**
 * The "Plain-English Explanation" prose must stay highlighted with the terms
 * that were ACTUALLY in it when it was written -- not whatever scenario
 * currently happens to sit on the envelope.
 *
 * RED-PUBLIC C (round 3 starting queue): "New AI scenario"
 * (`fetchFreshScenario`) swaps `llmEnvelope.report.suggestedScenario` for a
 * brand-new draw while DELIBERATELY leaving `llmEnvelope.report.prose`
 * untouched (its own comment: "only a fresh STORY is wanted... the prose
 * stays put"). The prose's ColorCoded highlight terms used to read that
 * live, swapped field directly -- so clicking "New AI scenario" silently
 * uncoloured the nouns actually IN the unchanged prose (they were no longer
 * in the term list) while colouring for a story the text never mentions.
 *
 * This is a STRUCTURAL check of App.tsx's source, in the style of this
 * repo's other `*.contract.test.ts` files: there is no DOM test harness here
 * (no vitest/React Testing Library), and exercising the live bug needs a
 * real LLM call this file must not make (paid, and RED-CLOUD-3's surface,
 * not this one's). What IS checkable without either: that the prose's
 * ColorCoded call reads the SNAPSHOT (`proseScenario`), never
 * `llmEnvelope.report.suggestedScenario` directly, that the snapshot is
 * cleared whenever the prose it names is invalidated, and that the ONE
 * function which writes new prose is the one that (re)sets it while the ONE
 * function that swaps the scenario without writing new prose does not.
 *
 *   npx tsx src/reportprose.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'App.tsx'), 'utf8');

let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

// ── the state exists and is cleared alongside the envelope it describes ────
ok(/const \[proseScenario, setProseScenario\] = useState/.test(src),
  'proseScenario state must be declared');
ok(/setLlmEnvelope\(null\); setLlmError\(false\); setProseScenario\(null\);[\s\S]{0,200}\}, \[payoffs\]\);/.test(src),
  'proseScenario must be cleared in the same effect that clears llmEnvelope on a payoff edit '
  + '(otherwise a stale scenario from the OLD game colours prose about the NEW one)');

// ── isolate the prose ColorCoded block ───────────────────────────────────────
// Anchored on the comment right above it. If this anchor moves, this test
// must be updated to find the new one -- failing loudly here (rather than
// silently matching nothing) is the point.
const anchorStart = src.indexOf("A fresh invention's prose uses");
ok(anchorStart !== -1, 'anchor comment for the prose ColorCoded block must exist in App.tsx');
const blockEnd = src.indexOf('</p>', anchorStart);
ok(blockEnd !== -1, 'the prose ColorCoded block must close with </p> after its anchor');
const block = src.slice(anchorStart, blockEnd);

ok(block.includes('proseScenario'),
  'the prose ColorCoded block must read the proseScenario snapshot');
ok(!block.includes('llmEnvelope.report.suggestedScenario'),
  'REGRESSION GUARD: the prose ColorCoded block must not read the live '
  + 'suggestedScenario field directly -- that is the exact defect RED-PUBLIC C found');

// ── the writer sets it, the swapper does not ─────────────────────────────────
const fetchLlmStart = src.indexOf('const fetchLlmExplanation = async');
const fetchFreshStart = src.indexOf('const fetchFreshScenario = async');
ok(fetchLlmStart !== -1 && fetchFreshStart !== -1 && fetchLlmStart < fetchFreshStart,
  'both fetchLlmExplanation and fetchFreshScenario must exist, in that order');

const fetchLlmBody = src.slice(fetchLlmStart, fetchFreshStart);
// CodeRabbit finding (this branch): fetchLlmExplanation's CATCH branch also
// calls setProseScenario(null) (error cleanup) -- a bare
// fetchLlmBody.includes('setProseScenario(') check would still pass if the
// SUCCESS-path snapshot assignment were deleted entirely, because the
// catch's call alone satisfies "the string appears somewhere in this
// function". Isolate the section BEFORE the catch block and require the
// ENVELOPE-DERIVED assignment specifically, not just any call to the setter.
// RED-APP-6/003: the catch now binds the error (`} catch (err) {`) to tell a
// client-side timeout abort apart from any other failure -- match either
// form, bare or bound, rather than the literal bare-catch string.
const fetchLlmCatchMatch = /\}\s*catch\s*(?:\([a-zA-Z_$][\w$]*\))?\s*\{/.exec(fetchLlmBody);
const fetchLlmCatchStart = fetchLlmCatchMatch ? fetchLlmCatchMatch.index : -1;
ok(fetchLlmCatchStart !== -1, 'fetchLlmExplanation must have a catch block');
const fetchLlmSuccessSection = fetchLlmBody.slice(0, fetchLlmCatchStart);
ok(/setProseScenario\(envelope\.report\?\.suggestedScenario \?\? null\)/.test(fetchLlmSuccessSection),
  'REGRESSION GUARD: the SUCCESS branch (isolated from the catch branch, which also calls '
  + 'setProseScenario for unrelated error-cleanup reasons) must assign proseScenario from the '
  + 'envelope this specific response carried -- fetchLlmExplanation writes NEW prose every time '
  + 'it succeeds, so it must (re)set proseScenario to match');

// Bound the fetchFreshScenario body at the next top-level function/hook
// declaration so this does not accidentally read past it into unrelated code.
const nextDeclMatch = /\n  (const |function )/.exec(src.slice(fetchFreshStart + 40));
const fetchFreshEnd = nextDeclMatch ? fetchFreshStart + 40 + nextDeclMatch.index : fetchFreshStart + 2000;
const fetchFreshBody = src.slice(fetchFreshStart, fetchFreshEnd);
ok(!fetchFreshBody.includes('setProseScenario'),
  'REGRESSION GUARD: fetchFreshScenario must never call setProseScenario -- it writes no new '
  + 'prose (its own comment says so), so the OLD snapshot matching the OLD prose must survive '
  + 'the call. Setting it here from the freshly-drawn scenario would reintroduce the same bug '
  + 'in the other direction: the snapshot would then name a story the still-unchanged prose '
  + 'never mentions either.');

console.log(`reportprose.test.ts: ${checks} checks passed`);

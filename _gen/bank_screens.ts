/**
 * Screens that apply to the BANK ARTIFACT specifically — not to teacher data,
 * and not to model output at request time.
 *
 * The distinction matters. `trainset_screens.ts` holds defects a generator can
 * still produce today. What lives here is a defect of the artifact's HISTORY:
 * every row in the shipped bank was generated under a version of `stakesHint`
 * whose exposure line read "Player A has far more riding on this than Player B,
 * or the reverse" — direction-blind by construction, because `playerGap` is
 * max(swing)/min(swing) and a ratio has no direction. Any bank row that asserts
 * an exposure asymmetry therefore GUESSED which party was exposed, and those
 * guesses measured 44% wrong against the row's own matrix under both readings.
 *
 * The prompt is fixed for rows generated from now on. It does nothing for the
 * ~1,958 already in the artifact, and regenerating the whole bank is not worth
 * it, so the affected rows are dropped instead.
 */
import type { SuggestedScenario } from '../src/types';

/**
 * Does the description place the two parties' exposure on a scale?
 *
 * THIS SCREEN FAVOURS RECALL, WHICH IS THE OPPOSITE OF EVERY OTHER PREDICATE IN
 * THIS REPO, and the reason is that the error costs here are wildly asymmetric.
 * A false positive drops ONE row from a bank of 1,958 that has depth to spare;
 * a false negative ships a comparative claim about who has more at stake beside
 * a matrix that contradicts it. So the "both parties have something at stake"
 * shape — "with the season's budget and public reputation at stake", which
 * asserts no asymmetry at all — is deliberately caught too, and is recorded in
 * the fixtures as a KNOWN AND ACCEPTED false positive. Narrowing the rule to
 * spare those rows would buy 16 rows and reintroduce the risk; do not do it.
 *
 * MEASURED on the shipped artifact, every match hand-read:
 *   78 of 1,958 rows (4.0%) — 62 real asymmetry claims, 16 both-parties
 *   "at stake" framings. False-positive rate 20.5%, all of one accepted class.
 *   Cell cost: 320/320 cells still non-empty, none newly emptied; cells under
 *   4 rows 35 -> 40, one-name cells 34 -> 36, median cell size unchanged at 6.
 *
 * NOTHING IS NARROWED, INCLUDING THE ONE NARROWING THAT LOOKED FREE. "Exposed
 * Ridge" and "Long Exposure" are OPTION LABELS in this bank — a different sense
 * of the word carrying no claim about anybody's stake — so a lowercase-only
 * guard on `expos(ure|ed)` looked like a costless way to skip them. Measured, it
 * is not needed: the comparative-word requirement in front of `expos(ure|ed)`
 * already excludes every label row, and case-sensitive and case-insensitive
 * forms return the SAME 78 rows. The `i` flag therefore stays, because it is
 * what reaches a sentence-initial "At stake is…" or "Only a small…".
 */
const EXPOSURE_PHRASE = new RegExp([
  // "with much of its seasonal collection riding on this dyeing run"
  'riding on',
  // "with less at stake than the library"; also the accepted both-parties shape
  'at stake',
  'at risk',
  'on the line',
  'stands? to (lose|gain|win)',
  // "far more exposure in the project than", "more exposed to a mismatch".
  //
  // THE ADJECTIVE SLOT IS OPEN, NOT A THREE-WORD LIST. It was
  // `(financial |commercial |seasonal )?`, and RED-CLOUD's complementary run
  // over 6,788 gate-passing descriptions found 12 misses of the form "much
  // greater BUDGET AND REPUTATION exposure" — any other noun between the
  // comparative and "exposure" broke the match. That was the single largest
  // recall gap in this list.
  // `broader|wider|deeper|fuller` were added after #2057 — "THE AUTHORITY
  // CARRIES THE BROADER SCHEDULING EXPOSURE, while the contractor is managing a
  // modest job" — escaped BOTH this list and the `carries the …` one below on
  // the same word. The earlier widening opened the NOUN slot between the
  // comparative and "exposure"; it did not touch the comparative itself.
  '(more|less|greater|little|much|greatest|larger|higher|lower|heavier|most|least|broader|wider|deeper|fuller)[^.]{0,30}?expos(ure|ed)',
  'expos(ure|ed) [^.]{0,40} than',
  'heavily (exposed|tied|dependent|reliant)',
  'whose (exposure|stake|risk|position)',
  // "matters more to the grower than to the buyer", and the COPULAR form of the
  // same claim — "for which this contract is far more consequential" — which
  // the verb-anchored rule cannot reach (ORACLE, 2 unique texts in 12,518).
  // `matters?` matched "matter" and "matters" and NOT the participle. One
  // inflection let #2424 through: "with the timing of the job MATTERING MORE to
  // the owner than to the crew foreperson".
  'matter(?:s|ed|ing)? (far |much |a lot |significantly |a great deal )?(more|less)\\b',
  '(far|much|considerably|significantly|rather) (more|less) (consequential|important|significant|costly|damaging|serious)',
  'weighs? (more|less|heavil)',
  '(more|less|little|much|a lot|a great deal) to (lose|gain)',
  '(bears?|carries|carry|carrying) (the |a )?(greater|larger|bigger|brunt|heavier|broader|wider|deeper|fuller)',
  '(more|less|greater|smaller|larger) (at stake|consequence)',
  // "a smaller commercial stake", "a smaller seasonal stake" — the same
  // comparative with a modifier wedged in.
  '(smaller|larger|bigger|greater|lesser) \\w+ stake',
  // "with more of the season's budget and reputation" — the comparative with no
  // exposure noun adjacent at all, 13 of RED-CLOUD's 38 misses.
  '(more|less) of (the|its|their) \\w+',
  // "whose seasonal schedule depends heavily on this harbour" against a
  // "smaller" counterparty — the same claim without the word "stake".
  '(depends?|depend|relies?|rely) heavily',
  'tied (closely|heavily)',
  'hinges? (heavily )?on',
  'for whom (this|that|the|it)',
  'only a (small|minor|modest|slight|brief|short)',
  '(smaller|larger|bigger|greater) (scheduling |financial |commercial |seasonal )?(stake|interest|exposure)',
  '\\b(much|most|the bulk) of its\\b',
  // "with the success of the stop CARRYING MORE PERSONAL WEIGHT FOR the
  // puppeteer THAN FOR the host" — a comparative with an open noun after it and
  // no exposure word anywhere, reachable only by anchoring on the SECOND TERM of
  // the comparison instead of on a noun.
  //
  // THE EXPLICIT `than for|than to` IS WHAT MAKES THE OPEN SLOT SAFE, and that
  // was measured against the two negatives this rule family keeps as permanent
  // fixtures (RED-BANK-2 hand-read them out of its own predicate's output):
  //   "the supervisor is responsible for the patch, while the attendant handles
  //    ONLY THE nearby check"
  //   "the foreperson is responsible for the dredging schedule, while the
  //    dispatcher coordinates ONLY ONE nearby ferry's timetable"
  // Neither contains "than" at all, so neither can be reached. Those two divide
  // LABOUR, not stake, and asserting a rule that catches them would be the same
  // over-firing this file already prices at 20.5%.
  '(more|less|greater|larger|smaller|heavier|lighter|higher|lower|bigger|broader|wider)[^.;]{0,60}?than (for|to) (the|its|their|a|an|one)\\b',
  // "the caretaker, WHOSE PERSONAL SCHEDULE IS ONLY MILDLY AFFECTED" — the same
  // claim as the accepted `only a (small|minor|…)` member with the noun replaced
  // by a participle. `only` + an ADVERB + a past participle is a different
  // construction from the negatives' `only` + a DETERMINER + an object noun, so
  // it cannot reach them either.
  'only (mildly|slightly|marginally|modestly|lightly|somewhat|minimally|barely) (affected|impacted|touched|exposed|involved|concerned|invested)\\b',
].join('|'), 'i');

export function exposureAsymmetryClaim(s: SuggestedScenario): boolean {
  return EXPOSURE_PHRASE.test(s.description ?? '');
}

/**
 * A DOUBLED TERMINAL STOP: `…and “Late trim.”.`
 *
 * The closing quotation already carries the period and another is appended. Not
 * a falsehood, not a register problem, not a claim about the game — a typo, and
 * the only mechanically decidable one left in the artifact. 4 rows of 2,505 in
 * the shipped bank, 9 of 9,656 across every corpus held, every one hand-read,
 * zero judgement calls and zero false positives.
 *
 * WHY THIS IS A BANK SCREEN AND NOT A PRODUCTION GATE, which is the only
 * interesting decision here. On the cloud report path a rejection is not a retry
 * — RED-PIPELINE measured one draw with no reroll, `invented` stays null and the
 * response ships `suggestedScenario: undefined` — so gating this in production
 * would DELETE A WHOLE STORY over a stray full stop. That trade is obviously
 * wrong: the reader would rather have the story. In the bank the trade reverses,
 * because a dropped row costs one of 2,505 and the picker simply hands over a
 * different one. Falsehoods and register leaks are worth a missing story;
 * punctuation is not.
 *
 * The adjacent softer defect is DELIBERATELY NOT TAKEN: 7 rows mix quote
 * conventions inside one sentence (`"Rush firing,"` with the comma inside beside
 * `"Late firing".` with the period outside). A reader notices a doubled stop and
 * almost certainly does not notice that, and no instrument separates a
 * convention choice from a mistake.
 */
export function doubledTerminalStop(s: SuggestedScenario): boolean {
  return /[.!?][”’"'][.]\s*$/.test((s.description ?? '').trim());
}

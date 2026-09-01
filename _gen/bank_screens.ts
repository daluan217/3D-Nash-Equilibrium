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
  // "far more exposure in the project than", "more exposed to a mismatch"
  '(more|less|greater|little|much|greatest|larger|higher|lower|heavier|most|least) (financial |commercial |seasonal )?expos(ure|ed)',
  'expos(ure|ed) [^.]{0,40} than',
  'heavily (exposed|tied|dependent|reliant)',
  // "matters more to the grower than to the buyer"
  'matters? (far |much |a lot |significantly |a great deal )?(more|less)\\b',
  'weighs? (more|less|heavil)',
  '(more|less|little|much|a lot|a great deal) to (lose|gain)',
  '(bears?|carries|carry) (the |a )?(greater|larger|bigger|brunt|heavier)',
  '(more|less|greater|smaller|larger) (at stake|consequence)',
  // "whose seasonal schedule depends heavily on this harbour" against a
  // "smaller" counterparty — the same claim without the word "stake".
  'depends? heavily',
  'depend heavily',
  'hinges? (heavily )?on',
  'for whom (this|that|the|it)',
  'only a (small|minor|modest|slight|brief|short)',
  '(smaller|larger|bigger|greater) (scheduling |financial |commercial |seasonal )?(stake|interest|exposure)',
  '\\b(much|most|the bulk) of its\\b',
].join('|'), 'i');

export function exposureAsymmetryClaim(s: SuggestedScenario): boolean {
  return EXPOSURE_PHRASE.test(s.description ?? '');
}

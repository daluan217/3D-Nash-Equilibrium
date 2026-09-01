/**
 * The teacher-data screens, shared by the generator and the re-filter so a
 * corrected screen cannot apply to only one of them.
 */
import type { SuggestedScenario } from '../src/types';



/**
 * The verbs that make a bare letter a CHARACTER rather than a designation.
 *
 * Shared with the article screen below, deliberately. "A" is either the player
 * letter or the indefinite article, and both screens have to decide the same
 * question; two lists would drift and the drift would be invisible.
 */
const LETTER_VERBS = 'is|are|was|chooses|picks|selects|decides|must|will|can|has|holds|runs|operates|plans';

/** Bare "Player A"/"Player B" as the story's characters. 7.2% of accepted
 *  draws campaign-wide; local persona_hard 11.4% vs cloud 2.5%. The vocabulary
 *  is OURS — the payload opens "Player A first, Player B second". */
const personaLeak = (s: SuggestedScenario) => {
  const t = s.description ?? '';
  // Form 1: the prompt's own label, "Player A".
  if (/\bplayers?\s+[AB]\b/i.test(t)) return true;
  // Form 2: the BARE letter as a character — "A is a fisherman choosing…".
  //
  // The negative lookbehind is the whole rule. A capitalised word in front of
  // the letter makes it a designation, not the prompt's variable: "Operator A
  // chooses… while Operator B chooses…" is ordinary English for two otherwise
  // indistinguishable parties, exactly like Team A and Team B, and it does not
  // break the fiction. Without it this predicate reported 20.4% on cloud, and a
  // hand-check of 14 random matches found 13 were that shape — it would have
  // inflated the rate nearly fourfold and thrown away a fifth of the teacher
  // corpus. "Mill A chooses" must pass.
  if (new RegExp(`(?<![A-Za-z]\\s)\\b[AB]\\s+(${LETTER_VERBS})\\b`).test(t)) return true;
  return false;
};

/** Game-theory vocabulary inside a scene that is supposed to read as a real
 *  world. 7.6% local vs 0.0% cloud. */
const META_HARD = /\b(payoffs?|game theory|game-theoretic|normal[- ]form|strategy profile|row player|column player|(the two|both) players|best repl(y|ies)|equilibri\w*|zero[- ]sum|constant[- ]sum|payoff matrix|2\s*x\s*2)\b/i;
/** Game-theory words that make a bare "the game" mean OUR game and not a product. */
const GT_CONTEXT = /\b(payoffs?|players?|equilibri\w*|zero[- ]sum|constant[- ]sum|strateg\w+|dominat\w+|matrix|outcomes?)\b/i;
/** A game as a PRODUCT — the domain rotation contains games, film and software. */
const GAME_PRODUCT = /\b(game (studio|developer|publisher|design|jam|console|store|launch|release|title|demo|engine|night)|video ?game|board ?game|indie game|the game'?s? (launch|release|price|store|page|trailer|build)|(publish|releas\w+|distribut\w+|ship\w*|sell\w*|market\w*|featur\w*|develop\w*) (the|a|its|their) game)\b/i;

/**
 * Game-theory vocabulary inside a scene that is supposed to read as a real
 * world. Measured 7.5% on the local model against 0.0% on cloud (p=0.0089) —
 * the ONLY significant local-specific prose defect, and the one the retrain
 * exists for. In the OLD training data it sat at 2.4% and the model produced it
 * at 7.5%: a 3.1x AMPLIFICATION, so the data has to be near zero, not merely
 * better.
 *
 * "the game" is handled separately and carefully. Of 31 META hits in the old
 * training data, TWELVE were video-game scenarios where "the game" is the
 * PRODUCT — "a small game studio chooses… for distributing the game", "give the
 * game a Featured Slot". Not one was game-theoretic. The domain rotation
 * contains game, film and software settings, so a rule that matches "the game"
 * bare would silently delete a whole domain from the corpus — exactly the skew
 * a filter is most dangerous for. Seventh instance this campaign of a word-list
 * predicate over-firing on ordinary English.
 */
/**
 * THE GAME'S OWN CAST NOUN, BARE — and the one predicate in this campaign that
 * was refused on a HYPOTHESIS and measured wrong.
 *
 * META_HARD reaches "the two players" and "both players"; `personaLeak` reaches
 * "Player A". Neither reaches the two shapes the production model actually
 * writes, all three of these gate-clean and user-visible:
 *
 *   "The players are two rival truffle cooperatives sharing access to a
 *    high-value forest…"
 *   "Two textile firms booking capacity at the same dyehouse are the players."
 *   "The players are the two operators who run a small rope ferry…"
 *
 * The bare noun was originally excluded on SHAPE — the predicted collision was
 * a puppet-theatre or sports setting where "the players" are an acting company
 * or a team. Every other word-list predicate in this repo over-fired on
 * ordinary English, so the caution was the right instinct; here it was simply
 * wrong. Measured over every corpus held, 8,682 UNIQUE scenarios, with every
 * context around the word enumerated rather than sampled: 645 distinct
 * contexts, and after removing the known game-cast shapes exactly TWO remain —
 * "the game's two-player, normal-form setup" and "Neither player has a strategy
 * that always works". Both are meta leaks too. ZERO legitimate uses of the word,
 * singular or plural. The predicted collision does not occur.
 *
 * The SINGULAR was checked separately because "a key player in the region" is
 * ordinary English: 467 hits, 8 not already caught, all 8 meta leaks
 * ("Each player's choice concerns…", "The first player is the triage chief…").
 *
 * Residual risk, stated rather than engineered around: "record player", "player
 * piano" and "a major player in the market" would false-fire. None occurs in
 * 8,682 draws, and one dropped row is the cost if one ever does.
 *
 * Scoped to the AUTHORED fields rather than the description alone, since a
 * label can carry the word too; measured, that widening adds nothing today
 * (every hit is in a description) and costs nothing.
 */
const CAST_NOUN = /\bplayers?\b/i;

const metaLeak = (s: SuggestedScenario) => {
  const t = s.description ?? '';
  if (CAST_NOUN.test([s.name, s.row1, s.row2, s.col1, s.col2, t].filter(Boolean).join(' '))) return true;
  if (META_HARD.test(t)) return true;
  // A bare "the game" counts only when the sentence is talking about OUR game
  // and is not talking about a game as a product.
  return /\b(the|this) game\b/i.test(t) && GT_CONTEXT.test(t) && !GAME_PRODUCT.test(t);
};

/**
 * A description that stops mid-sentence. Real local output, gate-accepted:
 * "…and the game is not zero-sum or constant-sum, so no single" — and the
 * TRUNCATION is what let it through, because the full sentence would have ended
 * "no single outcome dominates" and "dominates" trips scenarioIsClaimFree.
 * Being cut off is what saved it. Decidable in one line; no gate checks it.
 *
 * THE ORIGINAL CLASS WAS 100% FALSE POSITIVE ON REAL OUTPUT. It read
 * `[.!?"')\]]$` — the STRAIGHT double quote but not the curly close-quote
 * U+201D, which is what the models actually emit. A description ending
 * `…while the buyer chooses between “Morning Pickup” and “Afternoon Pickup.”`
 * is a finished sentence and was flagged. Measured over every corpus held
 * (14,545 descriptions): 94 hits, of which 85 ended in `.”` — and 28 of 28 hits
 * in the shipped bank were that same shape. The screen was deleting good rows
 * and catching nothing they did not already carry.
 *
 * The replacement does NOT simply add `”` to the class, because a class accepts
 * a stray closer after a genuine truncation: the recorded defect ends "so no
 * single", and had the model closed a quote after it — `so no single"` — a
 * widened class would pass it. Terminal punctuation is required, and closing
 * quotes/brackets may follow it. Measured over the same 14,545 descriptions the
 * two forms are IDENTICAL (9 hits each), so the stricter one costs nothing:
 * every quote-terminal description in the corpus is `.”` or `."`, never a bare
 * closer, and no description ends in `)` or `]` at all.
 *
 * The 9 survivors are all real: 3 end in JSON/CJK debris (`… “Core Roster.”
 * לה}} 腾讯分分彩?`), 2 stop at "so no single", 2 at "for the two players:",
 * 1 at "Studio A chooses between", 1 at "Description says".
 */
const truncated = (s: SuggestedScenario) => {
  const t = (s.description ?? '').trim();
  return t.length > 0 && !/[.!?][")'\]”’]*$/.test(t);
};

/** Both players handed the SAME option labels. 9.0% local vs 5.0% cloud, and
 *  it BLINDS validateProseDirections — proven: distinct labels, the false claim
 *  is caught; colliding labels, the identical claim is missed and the check
 *  reports no issue, so it reads as a pass.
 *
 *  NOT a falsehood: symmetric games legitimately name both sides the same way,
 *  as the Prisoner's Dilemma does. It is excluded from TEACHER DATA because we
 *  do not want the student to learn a habit that disarms a downstream gate —
 *  which is a different judgement from gating it in production, where the blue
 *  team correctly refused. */
const labelCollision = (s: SuggestedScenario) => {
  const a = [s.row1, s.row2].map((x) => (x ?? '').trim().toLowerCase()).filter(Boolean);
  const b = [s.col1, s.col2].map((x) => (x ?? '').trim().toLowerCase()).filter(Boolean);
  return a.some((x) => b.includes(x));
};

/** A player whose two options carry the same name. 0.89% local, 0.00% cloud.
 *  Every one is a wasted call — the shipping gate already rejects them. */
const duplicateOptions = (s: SuggestedScenario) => {
  const norm = (x?: string) => (x ?? '').trim().toLowerCase();
  return (norm(s.row1) && norm(s.row1) === norm(s.row2)) || (norm(s.col1) && norm(s.col1) === norm(s.col2));
};

/**
 * Vowel-LETTER words that begin with a consonant SOUND, so "a" is the correct
 * article: the /juː/ words (university, unit, useful, usual, utility, utensil,
 * European) and the /w/ words (one, once). Prefixes, not whole words, because
 * the family is productive — "a university consortium" appears 60 times in the
 * corpora held and every one is correct English.
 *
 * It errs toward passing, deliberately. "uni" also prefixes "uninsured" and
 * "unintended", which take "an", so those slip through — a false NEGATIVE costs
 * one uncaught minor typo, while a false POSITIVE deletes a good row from the
 * teacher corpus and the bank, which is the harm this screen keeps causing.
 */
const A_BEFORE_CONSONANT_SOUND = /^(?:uni|unan|usa|use|usu|uti|ute|utop|ubiq|ukul|eu|once|one)/;

/**
 * "a irrigation provider", "a upstream generator". Decidable, so it has no
 * business being in teacher data.
 *
 * THE `i` FLAG ON THE "a" HALF MADE THIS 100% FALSE POSITIVE. `/\ba\s+[aeiou]\w/i`
 * matches the capital player letter, so "A is a cider orchard cooperative…",
 * "A and B are caretakers…" and "A university herbarium curator…" all fired.
 * Measured: 1,007 hits over 14,545 descriptions and 77 of 77 in the shipped
 * bank, every one a false positive on inspection. The "a" half is therefore
 * case-SENSITIVE — a mid-sentence article is lowercase.
 *
 * Case-sensitivity alone is not enough. It leaves 90 hits, of which 75 are
 * "a university" / "a utility" / "a unique" / "a once-in-a-generation" — correct
 * English, the /juː/ and /w/ classes above. With those excluded the screen
 * scores 15 hits over 14,545 descriptions and all 15 are real ("a upstream
 * canal operator" x11, "a irrigation season" x4). Hand-read, every one.
 * `and`/`or` are excluded because "player a and player b" is the bare LOWERCASE
 * letter, not an article — one hit, and `personaLeak` already rejects it.
 *
 * THE SENTENCE-INITIAL ARTICLE IS NOW CAUGHT TOO, and the argument that first
 * made me refuse it was wrong in a specific, instructive way. "A upstream
 * generator is choosing…" is a real error, 3 occurrences, and I initially left
 * it because every predicate reaching it seemed to need an open-ended verb list
 * — "Team A opens early" and "Crew A adds a shift" would false-fire on any
 * version of one. RED-CLOUD's correction: those are NOT sentence-initial. The
 * capital A there is preceded by a noun, so anchoring to a sentence boundary
 * deletes that entire false-positive class, and what remains is small enough to
 * ENUMERATE rather than guess at.
 *
 * Enumerated, not sampled, over 9,001 descriptions from every corpus held:
 * a sentence-initial "A <vowel-word>" has exactly SEVEN distinct followers —
 * `is` 235, `university` 148, `and` 20, `utility` 4, `upstream` 3,
 * `one-person` 1, `university-led` 1. The consonant-sound list kills 154 of
 * them, the and/or guard kills 20, `LETTER_VERBS` kills 235, and the residue is
 * exactly the 3 true errors. The set is closed on this pool, and the guard for
 * the one verb in it is the SAME list `personaLeak` uses to decide the same
 * question, not a second list invented here.
 *
 * The residual risk is priced rather than engineered around: a sentence-initial
 * "A operates two kilns…" would be missed, and that shape is what
 * `personaLeak`'s bare-letter rule is for — a row carrying it is dropped by
 * that screen anyway, so the article screen missing it costs nothing.
 *
 * The "an" half KEEPS the `i` flag, and that is measured too, not inherited:
 * "An" is never a player designator, so capitalisation carries no false
 * positives here — `/\bAn\s+…/` fires 0 times over all 14,545 descriptions —
 * while dropping the flag would blind it to a sentence-initial "An downstream
 * processor".
 */
const NOT_AN_ARTICLE = new RegExp(`^(?:and|or|${LETTER_VERBS})$`, 'i');
/** A lowercase "a" anywhere, or a capital "A" only at a sentence boundary. */
const A_BEFORE_VOWEL = /(?:\ba|(?:^|[.!?;:]["”’']?\s+)A)\s+([aeiou][\w-]*)/g;

const articleDisagreement = (s: SuggestedScenario) => {
  const t = s.description ?? '';
  for (const m of t.matchAll(A_BEFORE_VOWEL)) {
    const w = m[1];
    if (w.length < 2) continue;
    if (NOT_AN_ARTICLE.test(w)) continue;
    if (A_BEFORE_CONSONANT_SOUND.test(w)) continue;
    return true;
  }
  return /\ban\s+(?![aeiouAEIOU]|hour|honest|honou?r)[bcdfgjklmnpqrstvwxyz]\w/i.test(t);
};

/** The register width the local model lost: 79.4% of its descriptions use the
 *  "chooses between" frame TWICE, against cloud's 48.7%. Teaching on doubled
 *  frames is how a model ends up with one sentence shape. */
const doubledFrame = (s: SuggestedScenario) =>
  ((s.description ?? '').match(/chooses between/gi) ?? []).length >= 2;

/** Hard rejects: every one is a MEASURED defect the student must not learn. */
/**
 * A codepoint outside the expected set, anywhere the user sees.
 *
 * Real cloud output, gate-accepted: name "Wind-Farm Maintenance", row1 "Routine
 * Service", row2 "深-cycle Service" — the Chinese character for "deep" inside an
 * English label, so the label disagrees with its own description and one of them
 * is not English. It renders beside the plot and persists through "Use this
 * scenario". 1 in 845 cloud draws.
 *
 * Unlike every word-list screen in this file the predicate is EXACT: a codepoint
 * is in the set or it is not. Accented letters, curly quotes, en/em dashes and
 * U+2212 all pass deliberately — that last one has bitten this repo three times.
 */
const foreignScript = (s: SuggestedScenario) => {
  const fields = [s.name, s.row1, s.row2, s.col1, s.col2, s.description].filter(Boolean).join(' ');
  return /[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{White_Space}\p{Symbol}\p{Mark}]/u.test(fields);
};

const SCREENS: Array<[string, (s: SuggestedScenario) => boolean]> = [
  ['foreign-script', foreignScript],
  ['persona', personaLeak],
  ['meta', metaLeak],
  ['truncated', truncated],
  ['label-collision', labelCollision],
  ['duplicate-options', duplicateOptions],
  ['article', articleDisagreement],
];

/**
 * NO DOUBLED-FRAME SCREEN. The premise did not replicate and the screen is gone.
 *
 * It was built on local using the "chooses between" frame twice in 79.4% of
 * descriptions against cloud's 48.7%. Re-measured on the PRODUCTION path under
 * five definitions from literal to broad, cloud is ALWAYS >= local (60.0/70.0,
 * 72.9/75.0, 72.9/78.8, 77.1/78.8, 88.6/92.5) and the lowest cloud reading is
 * 70%. The 48.7% figure came from a harness that did not go through
 * `generateScenario` at all.
 *
 * So there is no defect here to fix, and a quota would have pushed the training
 * data far below BOTH surfaces on a dimension where none exists — while
 * rejecting 37.5% of teacher draws and silently selecting for whatever else
 * correlates with avoiding the commonest sentence shape in the corpus.
 */


export { SCREENS, personaLeak, metaLeak, labelCollision, duplicateOptions, articleDisagreement, doubledFrame, foreignScript, truncated };

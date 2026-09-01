/**
 * The screens' FIXTURES: the defect each one must still catch, and the ordinary
 * English each one must never touch again.
 *
 * WHY THIS FILE EXISTS. Two of these screens were 100% false positive on real
 * output and nobody noticed, because a screen that silently deletes good rows
 * looks exactly like a screen that is working:
 *
 *   truncated   `[.!?"')\]]$` had the STRAIGHT quote and not the curly one, so
 *               every description ending `…and “Afternoon Pickup.”` was called
 *               a mid-sentence stop. 28 of 28 hits in the shipped bank, 85 of
 *               94 across every corpus held.
 *   article     `/\ba\s+[aeiou]\w/i` — the `i` flag made `\ba` match the
 *               capital PLAYER LETTER, so "A is a cider orchard cooperative…"
 *               and "A and B are caretakers…" fired. 77 of 77 in the bank,
 *               1,007 across every corpus, every one a false positive.
 *
 * Both are fixed. Every false positive above is a permanent NEGATIVE fixture
 * here, and each fixture carries ONE signal so that deleting a single rule
 * fails a specific assertion rather than being masked by another.
 *
 * Run by `npm test`. Mutation results are in `_gen/blue/screens_mutation.txt`.
 */
import { truncated, articleDisagreement, personaLeak, metaLeak, foreignScript, duplicateOptions } from './trainset_screens';
import { exposureAsymmetryClaim } from './bank_screens';
import bankRows from '../src/data/scenarioBank.json';
import type { SuggestedScenario } from '../src/types';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};
/** A scenario carrying ONE signal: the description. Labels are inert filler. */
const sc = (description: string): SuggestedScenario =>
  ({ name: 'Fixture', row1: 'Early', row2: 'Late', col1: 'Open', col2: 'Hold', description } as never);

const fires = (label: string, fn: (s: SuggestedScenario) => boolean, text: string) =>
  check(`${label} MUST fire: ${JSON.stringify(text.slice(-60))}`, fn(sc(text)));
const quiet = (label: string, fn: (s: SuggestedScenario) => boolean, text: string) =>
  check(`${label} must NOT fire: ${JSON.stringify(text.slice(0, 70))}`, !fn(sc(text)));

/* ======================================================== truncated */
// Known positives. The first is the real gate-accepted defect, verbatim.
fires('truncated', truncated,
  'The two players make their decisions independently, and the game is not zero-sum or constant-sum, so no single');
fires('truncated', truncated,
  'The operator chooses between Shared Window and Separate Window. The two decisions produce the following payoffs for the two players:');
fires('truncated', truncated,
  'Hospital A chooses either “Expanded Roster” or “Lean Roster.” לה}} 腾讯分分彩? 亚洲色}}');
// THE ONE THAT MOTIVATES THE STRICTER FORM. Simply adding `”` to the character
// class would accept a truncation that happens to end in a stray closer; the
// rule requires terminal punctuation BEFORE any closing quote.
fires('truncated', truncated,
  'The two players make their decisions independently, so no single"');

// Permanent negative fixtures: every one of these is real accepted output.
quiet('truncated', truncated,
  'A charcoal kiln operator chooses between “Early Burn” and “Late Burn,” while the buyer chooses between “Morning Pickup” and “Afternoon Pickup.”');
quiet('truncated', truncated,
  'The coordinator chooses between "Weekend slot" and "Weeknight slot."');
quiet('truncated', truncated,
  'A vineyard manager and a reservoir authority are scheduling irrigation for the season.');
quiet('truncated', truncated, 'Which window does the ferry take?');
check('truncated ignores an empty description', !truncated(sc('')));

/* ================================================ article disagreement */
// Known positives, including the one verified by hand before the fix.
fires('article', articleDisagreement, 'a apple fell from the orchard tree');
fires('article', articleDisagreement,
  'A downstream farm and a upstream canal operator are coordinating scheduling for a shared irrigation canal.');
fires('article', articleDisagreement,
  'The grower chooses between Early Watering and Late Watering for a irrigation season.');
// The `an` half, and the reason it keeps the `i` flag: "An" is never a player
// designator, so a sentence-initial capital carries no false positive.
fires('article', articleDisagreement,
  'An upstream farmer and an downstream processor are coordinating a harvest.');
fires('article', articleDisagreement,
  'An downstream processor and an upstream farmer are coordinating a harvest.');

// Permanent negative fixtures — the capital PLAYER LETTER, all real output.
quiet('article', articleDisagreement,
  'A university herbarium curator and a visiting botanist are arranging a specimen loan.');
quiet('article', articleDisagreement, 'A and B are caretakers of neighboring dune lots.');
quiet('article', articleDisagreement, 'A is a cider orchard cooperative deciding between Early booking and Late booking.');
quiet('article', articleDisagreement, 'Player A is a grower and Player B is a haulier.');
quiet('article', articleDisagreement, 'Two concession operators, Player A in the north stand and Player B in the south stand, set prices.');
quiet('article', articleDisagreement, 'When A advertises on TV and B runs an influencer campaign, the split changes.');
// …and the vowel LETTERS that begin with a consonant SOUND.
quiet('article', articleDisagreement, 'A national radio observatory and a university consortium are shaping the schedule.');
quiet('article', articleDisagreement, 'A tidal-turbine contractor and a utility authority are coordinating a service window.');
quiet('article', articleDisagreement, 'A national herbarium seeks a loan of a unique type specimen.');
quiet('article', articleDisagreement, 'The planetarium is booking a once-in-a-generation premiere slot.');
quiet('article', articleDisagreement, 'The keeper offers it for a one-shift exchange.');
quiet('article', articleDisagreement, 'Two sami herders, player a and player b, are moving their reindeer herds.');
// The `an` exceptions that were already there and must stay.
quiet('article', articleDisagreement, 'The crew books an hourly slot and an honest appraisal of the roof.');

/* ============================================= exposure asymmetry (bank) */
// Known positive: an unambiguous asymmetry sentence, real bank output.
fires('exposure', exposureAsymmetryClaim,
  'A national rail operator commissioning a major stone wall repair has far more exposure in the project than a small local masonry firm submitting the bid.');
fires('exposure', exposureAsymmetryClaim,
  'A regional film distributor, with more riding on the film’s weekend launch, chooses between Wide Release and Staggered Release.');
fires('exposure', exposureAsymmetryClaim,
  'A national container carrier, whose seasonal schedule depends heavily on this harbour, chooses between a Senior Rotation and a Flexible Rotation.');

// KNOWN AND ACCEPTED FALSE POSITIVE — do not "fix" this.
//
// This sentence asserts NO asymmetry: both parties have the season's budget and
// reputation at stake. It is dropped anyway, and that is the deliberate choice.
// A false positive costs one row out of 1,958 with cell coverage to spare; a
// false negative ships a claim about who is more exposed beside a matrix that
// says otherwise, from rows whose direction was guessed and measured 44% wrong.
// Narrowing the screen to spare this shape would recover 16 rows and give the
// risk back. The assertion is written the way the screen actually behaves so
// that a future narrowing FAILS here and has to be argued for.
check('exposure: the both-parties "at stake" shape is a KNOWN, ACCEPTED false positive',
  exposureAsymmetryClaim(sc('Two ferry operators are assigning timetable slots on a heavily used seasonal route, with the season\'s budget and reputation at stake.')),
  'the accepted over-fire stopped firing — recall was narrowed; see _gen/bank_screens.ts before changing this');

// It must still leave ordinary claim-free scene-setting alone.
quiet('exposure', exposureAsymmetryClaim,
  'A vineyard manager chooses between Early Release and Late Release, while the reservoir authority chooses between Hold Reservoir and Release Water.');
quiet('exposure', exposureAsymmetryClaim,
  'Two beekeepers choose between Sheltered Valley and Exposed Ridge for their overwintering colonies.');
quiet('exposure', exposureAsymmetryClaim,
  'The consortium chooses between Long Exposure, holding the dome for lengthy integrations, and Short Exposure, using briefer observations.');

/* ============================== the screens that were already correct */
fires('persona', personaLeak, 'A is a fisherman choosing between Open Fish and Keep Fish.');
fires('persona', personaLeak, 'Player A and Player B are setting prices for the weekend.');
quiet('persona', personaLeak, 'Operator A chooses Open Valve while Operator B chooses Throttle Valve.');
quiet('persona', personaLeak, 'Mill A chooses Early Cut and Mill B chooses Late Cut.');
fires('meta', metaLeak, 'Firm A can conduct either survey; the payoffs to each firm follow.');
quiet('meta', metaLeak, 'A small game studio chooses how to distribute the game through a featured slot.');
// THE BARE CAST NOUN. All three verbatim production-model output, gate-clean,
// and reached by none of the older META rules.
fires('meta', metaLeak, 'The players are two rival truffle cooperatives sharing access to a high-value forest whose annual permit plan can be opened or tightened.');
fires('meta', metaLeak, 'Two textile firms booking capacity at the same dyehouse are the players. Firm A chooses Early Shift or Late Shift.');
fires('meta', metaLeak, 'The players are the two operators who run a small rope ferry from opposite banks.');
fires('meta', metaLeak, 'A service crew (first player) and a turbine operator (second player) coordinate on tidal turbine maintenance.');
fires('meta', metaLeak, 'Each player chooses either Early Resurfacing or Late Resurfacing for the facility.');
// It reaches a LABEL as well as the description, which the older META rules do not.
check('meta reaches the cast noun in a LABEL, not only the description',
  metaLeak({ name: 'Dyehouse Booking', row1: 'Player Slot', row2: 'Open Slot', col1: 'Early', col2: 'Late',
    description: 'Two textile firms are booking capacity at the same dyehouse.' } as never));
// …and leaves the neighbouring ordinary words alone, so it is the NOUN that
// fires and not the letters.
quiet('meta', metaLeak, 'The playhouse manager and the display coordinator are scheduling the evening programme.');
fires('foreign-script', foreignScript, 'The mill chooses between Routine Service and 深-cycle Service.');
quiet('foreign-script', foreignScript, 'The café’s réseau chooses between Prix Fixe and À la Carte — 12 to 15 covers.');
check('duplicate-options fires on one player with two identical labels',
  duplicateOptions({ name: 'x', row1: 'Early', row2: 'Early', col1: 'Open', col2: 'Hold', description: 'd' } as never));
check('duplicate-options is quiet on distinct labels',
  !duplicateOptions({ name: 'x', row1: 'Early', row2: 'Late', col1: 'Open', col2: 'Hold', description: 'd' } as never));

/* =========================================== THE SHIPPED ARTIFACT ITSELF
 * The bank is frozen at build time while these screens keep moving. Re-screen
 * it here so a tightened screen FAILS CI rather than being quietly outvoted by
 * a file built last week — the same argument `src/scenariobank.test.ts` makes
 * for the production gates.
 * ===================================================================== */
{
  const rows = bankRows as unknown as Array<{ d: string; b: number; s: SuggestedScenario }>;
  const screens: Array<[string, (s: SuggestedScenario) => boolean]> = [
    ['truncated', truncated], ['article', articleDisagreement], ['persona', personaLeak],
    ['meta', metaLeak], ['foreign-script', foreignScript], ['duplicate-options', duplicateOptions],
    ['exposure-asymmetry', exposureAsymmetryClaim],
  ];
  for (const [name, fn] of screens) {
    const hits = rows.filter((r) => fn(r.s));
    check(`no shipped bank row trips the ${name} screen`, hits.length === 0,
      `${hits.length} of ${rows.length} — the artifact is stale, rebuild it with _gen/bank_build.ts. First: "${hits[0]?.s.name}"`);
  }
}

if (failures > 0) { console.error(`✗ screens: ${failures} failed`); process.exit(1); }
console.log('✓ screens: truncated accepts a curly close-quote and still catches a stray-closer truncation, the article screen ignores the capital player letter and the consonant-sound vowels while still catching "a apple"/"a upstream"/"an downstream", the exposure screen keeps its accepted both-parties over-fire, and no shipped bank row trips any of them');

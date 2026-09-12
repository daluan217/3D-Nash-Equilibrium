/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A SCREEN CANNOT SHIP WITHOUT ITS FIXTURES AND ITS REACH NUMBER.
 *
 * The screens a drawn scenario must pass used to be four `if`s inside a closure
 * in `server.ts`, added one per finding. Nothing enumerated them, so nothing
 * could ask whether a screen had a known-positive fixture, whether that fixture
 * was ISOLATING (does deleting this one screen change any result?), whether the
 * screen had ever been measured against good output, or whether it could fire at
 * all. This file walks `SCENARIO_SCREENS` and fails when an entry is missing any
 * of the four:
 *
 *   1. a KNOWN-POSITIVE, refused by that screen, with its provenance and a
 *      written reason why it cannot be refused by coincidence;
 *   2. ISOLATION — deleting the screen from the table must make its own
 *      known-positive PASS. A screen that cannot fire because an earlier one
 *      already refuses everything it would refuse must say so, name the screen
 *      that shadows it, and carry the measurement behind that claim;
 *   3. HAND-READ NEGATIVES — real gate-passing output, at least two per screen,
 *      each one keystroke from the known-positive, which must pass the WHOLE
 *      table;
 *   4. REACH over a known-good corpus, re-measured here and compared with the
 *      pinned number, so a predicate that starts over-firing on good output
 *      fails this file rather than quietly rejecting a fraction of every draw.
 *
 * Adding a screen without an entry here fails; adding an entry for a screen that
 * does not exist fails; renaming a screen fails. That is the whole point.
 */
import { SCENARIO_SCREENS, screenScenario, type ScreenOptions } from './utils/scenarioScreen';
import { allBankRows } from './utils/bankSource';
import { colorTermKey } from './utils/colorTerms';
import { SERVE_PROBES } from './utils/scenarioBank';
import type { GamePayoffs, SuggestedScenario } from './types';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};

/**
 * ONE SET OF OPTIONS, because there is one screening policy. This used to take
 * an audience ('report-card' | 'regen-preview') and then a draw shape
 * (`actorNouns`); both were removed with the defects that made them differ —
 * every surface paints a served scenario with the same terms, and the actor-noun
 * safety pass runs on every route (STRUCT-CLOUD-19/001). What remains is
 * genuinely per-request: the story a regenerate must not repeat, and the
 * direction-check flag.
 */
const opts = (avoid?: ScreenOptions['avoid']): ScreenOptions => ({
  avoid, directionChecks: true,
});

/** Runs an arbitrary subset of the table, in table order. */
const runSubset = (
  ids: readonly string[], sc: SuggestedScenario, g: GamePayoffs, o: ScreenOptions,
): { id: string; reason: string } | null => {
  for (const s of SCENARIO_SCREENS) {
    if (!ids.includes(s.id)) continue;
    const reason = s.run(sc, g, o);
    if (reason !== null) return { id: s.id, reason };
  }
  return null;
};

/* ============================================================================
 * HAND-READ NEGATIVES — real output, verbatim, with its provenance.
 *
 * Every one is a draw from the 160-draw production-shaped campaign of
 * 2026-09-08 (`_gen/cloud19_draw.ts`, model gpt-5.6-luna pinned, NO `reasoning`
 * argument, `stakes:true`, domain rotation, payoffs inside `cleanPayoffs`'s
 * range), read by hand and judged good. They are chosen to sit ONE KEYSTROKE
 * from a known-positive so that none of them can pass by being bland:
 *   #92, #106  carry "Team A"/"Team B" and "beekeepers, A and B" — the two cast
 *              shapes `nashValidator.ts` DELIBERATELY allows (its own comments
 *              at the `META_BARE_LETTER` lookbehind and at
 *              `META_LETTER_IN_APPOSITION` record the measurement and the
 *              refusal). One character further — "A chooses" — and the
 *              claim-free screen refuses them.
 *   #17        says "makes the same choice", which is the phrasing
 *              `assertsTheSameMove` exists for; here the two label pairs are
 *              IDENTICAL, so it means "the same menu", not "the same move".
 *   #92, #106, #17, #145 all give both players the SAME label pair, so the
 *              renderer's `dropAmbiguous` paints nothing — the case the
 *              `attributable` screen must NOT refuse.
 *   #22        names both parties with invented proper nouns and no letters.
 *   #3         is the plain shape with distinct labels and actor nouns.
 * ==========================================================================*/
interface Negative { id: string; sc: SuggestedScenario; g: GamePayoffs }
const NEGATIVES: Negative[] = [
  {
    id: 'draw#3 staghunt x0.05 (distinct labels, actor nouns)',
    g: { a11: 0.25, a12: 0, a21: 0.15, a22: 0.15, b11: 0.25, b12: 0.15, b21: 0, b22: 0.15 },
    sc: {
      name: 'Telescope Scheduling', row1: 'Focused scan', row2: 'Broad scan',
      col1: 'Targeted request', col2: 'Flexible request',
      description: "The observatory scheduler is arranging a radio telescope's shared observing window and chooses between a Focused scan and a Broad scan. The visiting research team chooses between a Targeted request and a Flexible request for that window.",
      actorA: ['the observatory scheduler'], actorB: ['the visiting research team'],
    } as SuggestedScenario,
  },
  {
    id: 'draw#17 coordination x11 ("makes the same choice", identical label pairs)',
    g: { a11: 44, a12: 0, a21: 0, a22: 22, b11: 44, b12: 0, b21: 0, b22: 22 },
    sc: {
      name: 'Truffle Foraging Permits', row1: 'North Grove', row2: 'South Grove',
      col1: 'North Grove', col2: 'South Grove',
      description: "Here, a regional truffle cooperative and a family-run truffle cooperative each apply for one of two seasonal permits: North Grove or South Grove. A regional truffle cooperative chooses between North Grove and South Grove, and a family-run truffle cooperative makes the same choice for its crew's season.",
      actorA: ['a regional truffle cooperative'], actorB: ['a family-run truffle cooperative'],
    } as SuggestedScenario,
  },
  {
    id: 'draw#22 dominantA x11 (proper nouns, no letters)',
    g: { a11: 66, a12: 55, a21: 22, a22: 11, b11: 11, b12: 44, b21: 44, b22: 11 },
    sc: {
      name: 'Seasonal Freight Timetable', row1: 'Early Dispatch', row2: 'Late Dispatch',
      col1: 'Priority Slots', col2: 'Flexible Slots',
      description: 'Northline Rail and PrairieLink Freight are coordinating a seasonal freight timetable. Northline chooses between Early Dispatch and Late Dispatch, while PrairieLink chooses between Priority Slots and Flexible Slots.',
    } as SuggestedScenario,
  },
  {
    id: 'draw#92 pennies x11 ("Team A"/"Team B" — the allowed designation shape)',
    g: { a11: 11, a12: -11, a21: -11, a22: 11, b11: -11, b12: 11, b21: 11, b22: -11 },
    sc: {
      name: 'Dome-Time Claim', row1: 'First Window', row2: 'Second Window',
      col1: 'First Window', col2: 'Second Window',
      description: 'Two astronomy teams are competing for a season-critical observing session at a major observatory. Team A chooses the First Window or Second Window for its proposed dome time, while Team B makes the same choice for its own proposal.',
    } as SuggestedScenario,
  },
  {
    id: 'draw#106 chicken x1 ("beekeepers, A and B" — the allowed appositive pair)',
    g: { a11: 0, a12: 2, a21: -2, a22: -8, b11: 0, b12: -2, b21: 2, b22: -8 },
    sc: {
      name: 'Winter Apiary Siting', row1: 'Sheltered Yard', row2: 'Open Yard',
      col1: 'Sheltered Yard', col2: 'Open Yard',
      description: 'Two neighboring beekeepers, A and B, are arranging where to place their hives for winter. Each chooses between a Sheltered Yard and an Open Yard for the apiary.',
    } as SuggestedScenario,
  },
  {
    id: 'draw#145 coordination x0.05 (label glosses, identical label pairs)',
    g: { a11: 0.2, a12: 0, a21: 0, a22: 0.1, b11: 0.2, b12: 0, b21: 0, b22: 0.1 },
    sc: {
      name: 'Orchard Frost Watch', row1: 'Pre-Dusk Watch', row2: 'Dawn Watch',
      col1: 'Pre-Dusk Watch', col2: 'Dawn Watch',
      description: 'A north-orchard grower and a south-orchard grower each choose between Pre-Dusk Watch and Dawn Watch for a coming frost night. Pre-Dusk Watch means adjusting the orchard sprinklers before dusk, while Dawn Watch means making the adjustment closer to dawn.',
      actorA: ['A north-orchard grower'], actorB: ['a south-orchard grower'],
    } as SuggestedScenario,
  },
];

/* ============================================================================
 * THE EVIDENCE TABLE — one entry per screen, or this file fails.
 * ==========================================================================*/
interface Evidence {
  knownPositive: {
    sc: SuggestedScenario; g: GamePayoffs; avoid?: ScreenOptions['avoid'];
    provenance: string;
    whyNotCoincidence: string;
  };
  /**
   * `independent` — deleting this screen must make its known-positive PASS.
   * `shadowedBy` — an earlier screen already refuses everything this one would;
   * the claim must carry its measurement, and the reach number must be 0.
   */
  isolation: 'independent' | { shadowedBy: string; evidence: string };
  /** indices into NEGATIVES; at least two, each hand-read */
  negatives: number[];
  reach: { corpus: string; fires: number; of: number; note: string };
}

const RIVALRY_MATRIX: GamePayoffs = { a11: 3, a12: 1, a21: 1, a22: 3, b11: 3, b12: 1, b21: 1, b22: 3 };

const EVIDENCE: Record<string, Evidence> = {
  declarations: {
    knownPositive: {
      g: RIVALRY_MATRIX,
      sc: {
        name: 'Route Contract', row1: 'Firm Bid', row2: 'Lean Bid', col1: 'Priority Bid', col2: 'Flexible Bid',
        description: 'Two courier companies are competing for a season-long delivery route contract. '
          + 'The first chooses between a Firm Bid and a Lean Bid, while the second weighs a Priority Bid against a Flexible Bid.',
      } as SuggestedScenario,
      provenance: 'the same planted row `src/scenariobank.test.ts` uses as its rivalry known-positive',
      whyNotCoincidence: 'the matrix is common-interest (both players score identically in every cell), so '
        + '"competing for" contradicts it; on a rivalrous matrix the identical text is accepted, which the '
        + 'control below asserts. Nothing in the text is a comparative claim, a repeated story or an '
        + 'unattributable one, so no other screen can be the one refusing it.',
    },
    isolation: 'independent',
    negatives: [0, 2, 5],
    reach: {
      corpus: 'shipped bank rows x a fixed 6-probe subsample of SERVE_PROBES',
      fires: 0, of: 0,
      note: 'over-fire on known-good output must be zero; the full 28-probe pass is the bank re-screen\'s own job',
    },
  },
  'claim-free': {
    knownPositive: {
      g: { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 },
      sc: {
        name: 'Dyeing Shift Timing', row1: 'Early Shift', row2: 'Late Shift', col1: 'Cool Rinse', col2: 'Warm Rinse',
        description: 'At a textile mill, the dye-house supervisor, Player A, chooses between an Early Shift and a Late Shift for a dye-bath adjustment. The finishing supervisor, Player B, chooses between a Cool Rinse and a Warm Rinse for the same textile dyeing run.',
      } as SuggestedScenario,
      provenance: 'draw #4 of the 2026-09-08 campaign — a REAL production-shaped draw the live gate refused',
      whyNotCoincidence: 'every label is stated verbatim so the story is attributable, the declarations gate '
        + 'passes it, and the text carries no directional claim. Remove the two words "Player A"/"Player B" '
        + 'and the identical draw passes the whole table — negative #3 is that shape with a role noun instead.',
    },
    isolation: 'independent',
    negatives: [3, 4, 1],
    reach: {
      corpus: 'shipped bank rows (matrix-independent, so one pass over 2442 rows is exact)',
      fires: 0, of: 0,
      note: 'the artifact is built through this screen; a non-zero number here means it has drifted',
    },
  },
  'regen-same-story': {
    knownPositive: {
      g: { a11: 44, a12: 0, a21: 0, a22: 22, b11: 44, b12: 0, b21: 0, b22: 22 },
      sc: NEGATIVES[1].sc,
      avoid: { name: 'Truffle Foraging Permits', description: NEGATIVES[1].sc.description },
      provenance: 'negative #1 handed back to a regenerate that asked to replace exactly it',
      whyNotCoincidence: 'the SAME scenario object is a passing negative when `avoid` is absent (asserted '
        + 'below), so the refusal can only come from the avoid comparison.',
    },
    isolation: 'independent',
    negatives: [1, 0, 5],
    reach: {
      corpus: 'shipped bank rows with no `avoid` — the /api/report shape',
      fires: 0, of: 0,
      note: 'this screen exists only on the regenerate path, where `avoid` is the story the user asked to '
        + 'replace; zero on a corpus with no `avoid` is the definition of the screen, not evidence about it',
    },
  },
  directions: {
    knownPositive: {
      g: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 },
      sc: {
        name: 'Quota Talks', row1: 'Hold Quota', row2: 'Raise Quota', col1: 'Open Season', col2: 'Short Season',
        description: 'Two fleets set a seasonal quota. Hold Quota works best against Open Season.',
      } as SuggestedScenario,
      provenance: 'constructed: a directional claim that points the wrong way on a prisoner\'s-dilemma matrix',
      whyNotCoincidence: 'the claim is false against this matrix (against Open Season, Hold Quota pays A 3 '
        + 'and Raise Quota pays 5), and the SAME sentence naming the other option is accepted by this '
        + 'screen — asserted below as the control, so the refusal is about the direction, not the wording.',
    },
    isolation: {
      shadowedBy: 'claim-free',
      evidence: 'A directional claim needs one of "better/worse/best/prefers/favours/dominant/optimal/'
        + 'advantage/gains more/loses more", which is exactly the CLAIMY word list `scenarioIsClaimFree` '
        + 'refuses first. Measured: 0 of 2442 shipped rows and 0 of 146 gate-passing draws from the '
        + '2026-09-08 campaign reach this screen at all. It is staleness insurance for the day the '
        + 'claim-free list is narrowed, not a screen that fires today — and this file records that rather '
        + 'than letting a green run imply it is doing work.',
    },
    negatives: [0, 2, 3],
    reach: {
      corpus: 'shipped bank rows x a fixed 6-probe subsample of SERVE_PROBES',
      fires: 0, of: 0,
      note: 'zero here means "the vocabulary is not there", not "the artifact is safe" — see the isolation note',
    },
  },
  attributable: {
    knownPositive: {
      g: { a11: 0, a12: 2, a21: -2, a22: -8, b11: 0, b12: -2, b21: 2, b22: -8 },
      sc: {
        name: 'Co-op Contract Pricing', row1: 'Hold Price', row2: 'Cut Price', col1: 'Hold Price', col2: 'Cut Price',
        description: 'Two dairy co-ops are negotiating prices for a shared supermarket contract. Each co-op chooses between keeping its current wholesale price or offering a cut to the buyer.',
      } as SuggestedScenario,
      provenance: 'draw #26 of the 2026-09-08 campaign — a REAL draw that passed every OTHER screen',
      whyNotCoincidence: 'it passed all four earlier screens on the unfixed tree (it is one of the 146 in '
        + 'that campaign that did), so the refusal can only be this one; and negatives #4 and #5 share its '
        + 'shape of identical label pairs but state the labels, which is the difference the screen is about.',
    },
    isolation: 'independent',
    negatives: [4, 5, 1],
    reach: {
      corpus: 'shipped bank rows (matrix-independent, exact over 2442 rows)',
      fires: 0, of: 2442,
      note: 'Zero is the POINT, and it is not vacuous: this screen fired on 84 of these rows while '
        + '/api/report stripped their actor nouns, and the load-bearing control below strips them again and '
        + 'requires exactly those 84 back. The corpus this screen exists for is live draws, where it '
        + 'refuses 2 of 146 gate-passing draws (2026-09-08 campaign, _gen/cloud19_colour3.ts) — measured '
        + 'off-corpus because re-deriving it costs real model calls. STRUCT-CLOUD-19/001.',
    },
  },
};

/* ============================================================================
 * 1. THE TABLE AND THE EVIDENCE MUST COVER EACH OTHER EXACTLY.
 * ==========================================================================*/
const screenIds = SCENARIO_SCREENS.map((s) => s.id);
for (const id of screenIds) {
  check(`screen "${id}" has an evidence entry`, !!EVIDENCE[id],
    'a screen cannot ship without a known-positive, its isolation, hand-read negatives and a reach number');
}
for (const id of Object.keys(EVIDENCE)) {
  check(`evidence entry "${id}" names a screen that exists`, screenIds.includes(id));
}
check('every screen id is unique', new Set(screenIds).size === screenIds.length, screenIds.join(','));
for (const s of SCENARIO_SCREENS) {
  check(`screen "${s.id}" says what it refuses`, s.what.length > 20, s.what);
}

/* ============================================================================
 * 2. KNOWN-POSITIVES, AND WHETHER DELETING THE SCREEN CHANGES ANYTHING.
 * ==========================================================================*/
for (const s of SCENARIO_SCREENS) {
  const ev = EVIDENCE[s.id];
  if (!ev) continue;
  const kp = ev.knownPositive;
  const o = opts(kp.avoid);

  check(`"${s.id}" refuses its own known-positive`, s.run(kp.sc, kp.g, o) !== null,
    `${kp.provenance} — the fixture no longer fires, so nothing below it means anything`);
  check(`"${s.id}" records where its known-positive came from`, kp.provenance.length > 20);
  check(`"${s.id}" records why the fixture cannot fire by coincidence`, kp.whyNotCoincidence.length > 60);

  // THE MUTATION, run rather than described: take this screen out of the table.
  const without = screenIds.filter((x) => x !== s.id);
  const survives = runSubset(without, kp.sc, kp.g, o);
  if (ev.isolation === 'independent') {
    check(`"${s.id}" is the ONLY screen refusing its known-positive (delete it and the fixture passes)`,
      survives === null,
      survives ? `${survives.id} also refuses it: ${survives.reason}` : '');
  } else {
    check(`"${s.id}" declares the screen that shadows it`, screenIds.includes(ev.isolation.shadowedBy));
    check(`"${s.id}"'s shadow is real: the full table refuses its fixture at "${ev.isolation.shadowedBy}"`,
      survives?.id === ev.isolation.shadowedBy,
      survives ? `refused by ${survives.id}` : 'nothing refuses it, so it is not shadowed — it is unreachable');
    check(`"${s.id}" carries the measurement behind its shadow claim`, ev.isolation.evidence.length > 120);
    check(`a shadowed screen must have zero reach`, ev.reach.fires === 0, `${ev.reach.fires}`);
  }
}

/* ============================================================================
 * 3. CONTROLS — the known-positives must be refused FOR THEIR STATED REASON.
 * ==========================================================================*/
{
  // declarations: the same text on a RIVALROUS matrix is fine.
  const kp = EVIDENCE.declarations.knownPositive;
  const rival: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 1, b12: 5, b21: 0, b22: 3 };
  check('declarations control: the same story on a rivalrous matrix is accepted',
    screenScenario(kp.sc, rival, opts()).ok,
    JSON.stringify(screenScenario(kp.sc, rival, opts())));
}
{
  // regen-same-story: the same scenario with no `avoid` passes.
  const kp = EVIDENCE['regen-same-story'].knownPositive;
  check('regen-same-story control: the identical story with no avoid is accepted',
    screenScenario(kp.sc, kp.g, opts()).ok);
}
{
  // directions: the same sentence pointing the right way is accepted by the screen.
  const kp = EVIDENCE.directions.knownPositive;
  const flipped = {
    ...kp.sc,
    description: 'Two fleets set a seasonal quota. Raise Quota works best against Open Season.',
  } as SuggestedScenario;
  const screen = SCENARIO_SCREENS.find((s) => s.id === 'directions')!;
  check('directions control: the same sentence pointing the RIGHT way is accepted by this screen',
    screen.run(flipped, kp.g, opts()) === null,
    String(screen.run(flipped, kp.g, opts())));
  check('directions is genuinely OFF when the flag is off',
    screen.run(kp.sc, kp.g, { ...opts(), directionChecks: false }) === null);
}
{
  // attributable: the same story with its labels stated is accepted.
  const kp = EVIDENCE.attributable.knownPositive;
  const stated = {
    ...kp.sc,
    description: 'Two dairy co-ops are negotiating prices for a shared supermarket contract. The first chooses Hold Price or Cut Price for its wholesale list.',
  } as SuggestedScenario;
  check('attributable control: the same story stating its labels is accepted',
    screenScenario(stated, kp.g, opts()).ok,
    JSON.stringify(screenScenario(stated, kp.g, opts())));
}

{
  /**
   * A CLAIM SPELLED IN A SECOND UNICODE ALPHABET IS THE SAME CLAIM.
   *
   * `scenarioIsClaimFree` matches a written word list, and a word list read off
   * unfolded text is evadable one code point at a time: "ｂetter" (U+FF42, a
   * fullwidth Latin b that renders as an ordinary wide "better") passed the
   * screen while the identical ASCII sentence was refused. The fix folds the
   * text the RULES read (NFKC) and leaves the text anyone is served alone.
   * STRUCT-CLOUD-19 red pass 3, `_gen/cloud19_unicode.ts`.
   */
  const g: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
  const quota = {
    name: 'Quota Talks', row1: 'Hold Quota', row2: 'Raise Quota', col1: 'Open Season', col2: 'Short Season',
    description: 'Two fleets set a seasonal quota. Hold Quota is better against Open Season.',
  } as SuggestedScenario;
  const ascii = screenScenario(JSON.parse(JSON.stringify(quota)), g, opts());
  check('claim-free baseline: the ASCII claim is refused', !ascii.ok && ascii.screen === 'claim-free',
    `ok=${ascii.ok} screen=${ascii.screen}`);
  const fullwidth = JSON.parse(JSON.stringify({
    ...quota, description: quota.description!.replace('better', '\uFF42etter'),
  })) as SuggestedScenario;
  const wide = screenScenario(fullwidth, g, opts());
  check('...and the identical claim with one fullwidth letter is refused by the SAME screen',
    !wide.ok && wide.screen === 'claim-free', `ok=${wide.ok} screen=${wide.screen} reason=${wide.reason}`);
  // The control: folding must not turn ordinary prose into a claim. A fullwidth
  // letter in a word no rule lists is not a refusal.
  const harmless = JSON.parse(JSON.stringify({
    ...quota,
    description: 'Two \uFF46leets set a seasonal quota. One picks Hold Quota or Raise Quota; the other picks Open Season or Short Season.',
  })) as SuggestedScenario;
  const plain = screenScenario(harmless, g, opts());
  check('control: a fullwidth letter in a NON-claim word passes the whole table', plain.ok,
    `refused by ${plain.screen}: ${plain.reason}`);
}

{
  /**
   * THE ACTOR-NOUN SAFETY PASS IS NOT A PER-ROUTE OPTION. `validateScenario`
   * drops a declared noun pair `actorNounsOk` refuses and KEEPS the story
   * (RED-CLOUD-9/001) — in place, on the object the later screens then read,
   * which is why `attributable` cannot be fooled by a noun that is about to be
   * dropped. Both halves are asserted here because both are load-bearing and
   * neither is visible in a return value.
   */
  const g: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
  const stated = {
    name: 'Packing Shed Slot', row1: 'Grade Early', row2: 'Grade Late',
    col1: 'Ship Monday', col2: 'Ship Friday',
    description: 'A packing shed and a freight broker settle one week of fruit. The shed picks Grade Early or Grade Late; the broker picks Ship Monday or Ship Friday.',
    // Neither noun occurs in the description, so `actorNounsOk` refuses the pair.
    actorA: ['the riverside grading committee'], actorB: ['the overnight freight desk'],
  } as SuggestedScenario;
  const copy = JSON.parse(JSON.stringify(stated)) as SuggestedScenario;
  const verdict = screenScenario(copy, g, opts());
  check('unsafe actor nouns are dropped on every route, and the story survives',
    verdict.ok && !copy.actorA && !copy.actorB,
    `ok=${verdict.ok} reason=${verdict.reason} actorA=${JSON.stringify(copy.actorA)}`);

  /**
   * The consequence, on a story whose colour DEPENDS on its nouns: neither
   * pair of labels is stated, so once the unsafe nouns are dropped there is
   * nothing left to attach to either player and the table refuses the story
   * rather than serving it half-coloured.
   *
   * What makes THIS pair unsafe is one trailing space — `actorNounsOk` requires
   * the noun to occur in the description as a whole term, and " committee "
   * with the space kept does not. That is real model output, not a contrivance
   * (a declared noun copied out of the sentence with its following space), and
   * the control below is the same story with the space removed: accepted, and
   * served WITH its nouns. So the refusal is about the noun being unusable, not
   * about the story naming no labels.
   */
  const unstated = {
    ...stated,
    description: 'The riverside grading committee settles when the fruit is handled, and the overnight freight desk settles when it leaves.',
    actorA: ['the riverside grading committee '], actorB: ['the overnight freight desk '],
  } as SuggestedScenario;
  const copy2 = JSON.parse(JSON.stringify(unstated)) as SuggestedScenario;
  const verdict2 = screenScenario(copy2, g, opts());
  check('...and a story whose only terms were those nouns is refused, not served half-coloured',
    !verdict2.ok && verdict2.screen === 'attributable',
    `ok=${verdict2.ok} screen=${verdict2.screen} reason=${verdict2.reason}`);

  const copy3 = JSON.parse(JSON.stringify({
    ...unstated,
    actorA: ['the riverside grading committee'], actorB: ['the overnight freight desk'],
  })) as SuggestedScenario;
  const verdict3 = screenScenario(copy3, g, opts());
  check('control: the identical story with usable nouns is accepted, nouns intact',
    verdict3.ok && copy3.actorA?.length === 1 && copy3.actorB?.length === 1,
    `ok=${verdict3.ok} screen=${verdict3.screen} reason=${verdict3.reason} actorA=${JSON.stringify(copy3.actorA)}`);
}

/* ============================================================================
 * 4. NEGATIVES — real, hand-read output must pass the WHOLE table.
 * ==========================================================================*/
for (const s of SCENARIO_SCREENS) {
  const ev = EVIDENCE[s.id];
  if (!ev) continue;
  check(`"${s.id}" has at least two hand-read negatives`, ev.negatives.length >= 2, `${ev.negatives.length}`);
  for (const n of ev.negatives) {
    check(`"${s.id}" negative index ${n} exists`, !!NEGATIVES[n]);
  }
}
for (const neg of NEGATIVES) {
  const v = screenScenario(neg.sc, neg.g, opts());
  check(`negative "${neg.id}" passes the whole table`, v.ok, `refused by ${v.screen}: ${v.reason}`);
}

/* ============================================================================
 * 5. REACH, RE-MEASURED HERE.
 *
 * The corpus is the shipped bank: 2,442 rows of known-good output, every one of
 * which the artifact build put through these same gates. That makes a NON-ZERO
 * number here meaningful in one direction only — it means a screen has started
 * refusing output this project already judged good — which is exactly the
 * over-fire question. It cannot prove a screen is right; the unscreened live
 * campaign (`_gen/cloud19_draw.ts`) is the corpus for that, and its numbers are
 * in the notes rather than here because they cost real model calls to re-derive.
 * ==========================================================================*/
{
  const rows = allBankRows();
  // A fixed, deterministic subsample for the two matrix-DEPENDENT screens: the
  // full 28-probe cross-product is 68,376 pairs and ~40s, which does not belong
  // in `npm test` when `src/scenariobank.test.ts` already runs the full pass as
  // a pass/fail re-screen. Indices are spread across the probe list rather than
  // taken from its head, so the subsample is not all one matrix shape.
  const PROBE_STRIDE = Math.max(1, Math.floor(SERVE_PROBES.length / 6));
  const probes = SERVE_PROBES.filter((_, i) => i % PROBE_STRIDE === 0).slice(0, 6);
  check('the reach subsample actually holds several distinct probe shapes', probes.length >= 5, `${probes.length}`);

  const matrixDependent = new Set(['declarations', 'directions']);
  for (const s of SCENARIO_SCREENS) {
    const ev = EVIDENCE[s.id];
    if (!ev) continue;
    let fires = 0; let of = 0; let firstFire = '';
    const o = opts();
    // SCREEN A COPY. `declarations` runs `validateScenario(..., actorNouns:
    // true)`, which DELETES actorA/actorB in place on a row it dislikes, and the
    // artifact is frozen (STRUCT-CLOUD-19/008) — so handing it a row directly
    // would turn "this row no longer passes" into a TypeError instead of the
    // count this section exists to print. Copying is also what a request does.
    if (matrixDependent.has(s.id)) {
      for (const e of rows) for (const g of probes) {
        of++;
        const r = s.run(structuredClone(e.s) as SuggestedScenario, g, o);
        if (r !== null) { fires++; if (!firstFire) firstFire = `"${e.s.name}": ${r}`; }
      }
    } else {
      for (const e of rows) {
        of++;
        const r = s.run(structuredClone(e.s) as SuggestedScenario, probes[0], o);
        if (r !== null) { fires++; if (!firstFire) firstFire = `"${e.s.name}": ${r}`; }
      }
    }
    check(`"${s.id}" reach is pinned`, ev.reach.corpus.length > 10 && ev.reach.note.length > 30);
    check(`"${s.id}" reach matches the pinned number: ${fires}/${of}`,
      fires === ev.reach.fires,
      `pinned ${ev.reach.fires}, measured ${fires} of ${of}. First: ${firstFire}`);
    if (ev.reach.of !== 0) {
      check(`"${s.id}" reach corpus size matches`, of === ev.reach.of, `pinned ${ev.reach.of}, measured ${of}`);
    }
  }

  /**
   * THE ZERO ABOVE IS LOAD-BEARING, and this is what makes that falsifiable.
   *
   * A screen that reads zero on the only corpus a unit test can hold is one
   * refactor away from being a screen that cannot fire at all — the exact
   * "check that cannot fail for the reason it claims" this file exists to
   * prevent. So: strip the actor nouns off every row, which is precisely what
   * `/api/report` did until STRUCT-CLOUD-19/001 (server.ts, `withoutActorNouns`,
   * introduced by dd15cf9), and require the screen to refuse EXACTLY the 84 rows
   * that regression cost. Revert the server fix and this number is what comes
   * back; break the screen and it goes to zero. Either way this file fails.
   */
  const attributable = SCENARIO_SCREENS.find((s) => s.id === 'attributable')!;
  let strippedFires = 0; let firstStripped = '';
  for (const e of rows) {
    const { actorA: _actorA, actorB: _actorB, ...nounFree } = e.s as SuggestedScenario;
    const r = attributable.run(nounFree as SuggestedScenario, probes[0], opts());
    if (r !== null) { strippedFires++; if (!firstStripped) firstStripped = `"${e.s.name}": ${r}`; }
  }
  check('the actor nouns are load-bearing: strip them and exactly 84 shipped rows stop being attributable',
    strippedFires === 84,
    `${strippedFires} of ${rows.length} (pinned 84) — first: ${firstStripped}. `
    + 'If this is 0 the screen has stopped working; if it moved, the artifact changed and '
    + '_gen/cloud19_colour3.ts re-derives it.');
}

/* ============================================================================
 * 6. ONE QUESTION, TWO COMPARATORS — label distinctness (STRUCT-CLOUD-19/007).
 *
 * "Are this player's two options distinct?" was answered by `nashValidator`'s
 * own `base` (parentheticals out, whitespace collapsed, lower-cased) while the
 * renderer answered it with `colorTermKey`, which ALSO folds dash, quote and
 * apostrophe glyphs, NFKC and invisibles. Between the two answers sits a served
 * scenario whose two rows ColorCoded paints as one phrase. Same class as
 * RED-REGEN-4/5: one question, two comparators, no shared key.
 *
 * The fixture is hand-read negative #145 with row2 respelled using an EN DASH —
 * one codepoint from real gate-passing output, and a spelling a model reaches
 * for by itself. It cannot be refused by coincidence: only `declarations` fires
 * on it, its reason names the row labels, and control C below is the SAME
 * scenario with the second row given different words, which the whole table
 * serves.
 *
 * MUTATION: drop the `colorTermKey` half of `sameLabel` in
 * `src/utils/nashValidator.ts` and exactly three checks here fail — "the
 * en-dash row pair is refused", "…refused by declarations and nothing else"
 * (nothing fires at all) and "the trailing-period column pair is refused".
 * Drop the `base` half instead and exactly one fails: "the parenthetical pair
 * stays refused". Neither mutation touches the control, which is the point.
 * ==========================================================================*/
{
  const G: GamePayoffs = { a11: 0.2, a12: 0, a21: 0, a22: 0.1, b11: 0.2, b12: 0, b21: 0, b22: 0.1 };
  const EN = '\u2013';
  const enDashRows = {
    name: 'Orchard Frost Watch', row1: 'Pre-Dusk Watch', row2: `Pre${EN}Dusk Watch`,
    col1: 'Sprinkler Run', col2: 'Wind Machine',
    description: `A north-orchard grower chooses between Pre-Dusk Watch and Pre${EN}Dusk Watch for a coming frost night. A south-orchard grower chooses between a Sprinkler Run and a Wind Machine for the same night.`,
    actorA: ['A north-orchard grower'], actorB: ['a south-orchard grower'],
  } as SuggestedScenario;
  const periodCols = {
    ...enDashRows, row2: 'Pre-Dawn Watch', col2: 'Sprinkler Run.',
    description: 'A north-orchard grower chooses between Pre-Dusk Watch and Pre-Dawn Watch for a coming frost night. A south-orchard grower chooses between a Sprinkler Run and a Sprinkler Run. for the same night.',
  } as SuggestedScenario;
  const differentWords = {
    ...enDashRows, row2: 'Pre-Dawn Watch',
    description: 'A north-orchard grower chooses between Pre-Dusk Watch and Pre-Dawn Watch for a coming frost night. A south-orchard grower chooses between a Sprinkler Run and a Wind Machine for the same night.',
  } as SuggestedScenario;
  const parenthetical = {
    ...enDashRows, row1: 'Watch (early)', row2: 'Watch (late)',
    description: 'A north-orchard grower chooses between Watch (early) and Watch (late) for a coming frost night. A south-orchard grower chooses between a Sprinkler Run and a Wind Machine for the same night.',
  } as SuggestedScenario;

  // The fixture is a collision for the RENDERER and a distinct pair for the old
  // comparator — asserted, not asserted-about, so a change to either fold makes
  // this file say so instead of silently testing nothing.
  check('the en-dash pair is ONE term to the renderer',
    colorTermKey(enDashRows.row1!) === colorTermKey(enDashRows.row2!),
    `${colorTermKey(enDashRows.row1!)} vs ${colorTermKey(enDashRows.row2!)}`);
  check('the en-dash pair is TWO labels to the old comparator (no parenthesis, differs when lower-cased)',
    !enDashRows.row1!.includes('(') && !enDashRows.row2!.includes('(')
      && enDashRows.row1!.toLowerCase().replace(/\s+/g, ' ') !== enDashRows.row2!.toLowerCase().replace(/\s+/g, ' '));

  const vRows = screenScenario(enDashRows, G, opts());
  check('the en-dash row pair is refused', !vRows.ok && /row labels are not distinct/.test(vRows.reason ?? ''),
    vRows.ok ? 'SERVED' : `${vRows.screen}: ${vRows.reason}`);
  check('the en-dash row pair is refused by "declarations" and nothing else', 
    SCENARIO_SCREENS.filter((s) => s.run(enDashRows, G, opts()) !== null).map((s) => s.id).join(',') === 'declarations');

  const vCols = screenScenario(periodCols, G, opts());
  check('the trailing-period column pair is refused', !vCols.ok && /column labels are not distinct/.test(vCols.reason ?? ''),
    vCols.ok ? 'SERVED' : `${vCols.screen}: ${vCols.reason}`);

  const vOk = screenScenario(differentWords, G, opts());
  check('control: the same scenario with genuinely different second labels passes the whole table',
    vOk.ok, vOk.ok ? '' : `refused by ${vOk.screen}: ${vOk.reason}`);

  const vParen = screenScenario(parenthetical, G, opts());
  check('control: the parenthetical pair stays refused (the `base` half is still doing its half)',
    !vParen.ok && /row labels are not distinct/.test(vParen.reason ?? ''),
    vParen.ok ? 'SERVED' : `${vParen.screen}: ${vParen.reason}`);

  const emptyFoldRows = {
    name: 'Punctuation Signals', row1: '!!', row2: '??',
    col1: 'Open Window', col2: 'Closed Window',
    description: 'A dispatcher uses one of two punctuation signals while a receiver chooses an Open Window or Closed Window.',
    actorA: ['A dispatcher'], actorB: ['a receiver'],
  } as SuggestedScenario;
  const row1Key = colorTermKey(emptyFoldRows.row1);
  const row2Key = colorTermKey(emptyFoldRows.row2);
  check('empty-fold fixture: distinct punctuation labels really do produce two empty renderer keys',
    emptyFoldRows.row1 !== emptyFoldRows.row2 && row1Key === '' && row2Key === '',
    `${JSON.stringify(emptyFoldRows.row1)} => ${JSON.stringify(row1Key)}, ${JSON.stringify(emptyFoldRows.row2)} => ${JSON.stringify(row2Key)}`);
  const legacyEmptyFoldComparator = !!emptyFoldRows.row1 && !!emptyFoldRows.row2 && row1Key === row2Key;
  check('empty-fold mutation control: the former raw-truthiness guard falsely merges the distinct pair',
    legacyEmptyFoldComparator, `legacy=${legacyEmptyFoldComparator}`);
  const vEmptyFold = screenScenario(emptyFoldRows, G, opts());
  check('empty-fold fix: two distinct punctuation labels are not rejected merely because both renderer keys are empty',
    vEmptyFold.ok, vEmptyFold.ok ? '' : `refused by ${vEmptyFold.screen}: ${vEmptyFold.reason}`);

  const identicalPunctuation = { ...emptyFoldRows, row2: '!!' } as SuggestedScenario;
  const vIdenticalPunctuation = screenScenario(identicalPunctuation, G, opts());
  check('empty-fold control: genuinely identical punctuation labels remain rejected by the base comparator',
    !vIdenticalPunctuation.ok && /row labels are not distinct/.test(vIdenticalPunctuation.reason ?? ''),
    vIdenticalPunctuation.ok ? 'SERVED' : `${vIdenticalPunctuation.screen}: ${vIdenticalPunctuation.reason}`);

  /**
   * WHAT THE ADDED HALF COSTS on output this project already judged good: the
   * rows where the two comparators disagree. Zero means the union rejects
   * nothing that ships and only closes a channel; a non-zero number here means
   * it has started refusing real scenarios and this file fails first.
   */
  const flat = (t?: string): string => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  let disagree = 0; let firstDisagree = '';
  for (const e of allBankRows()) {
    const sc = e.s as SuggestedScenario;
    for (const [x, y] of [[sc.row1, sc.row2], [sc.col1, sc.col2]] as Array<[string?, string?]>) {
      if (!x || !y) continue;
      if (flat(x) !== flat(y) && colorTermKey(x) === colorTermKey(y)) {
        disagree++; if (!firstDisagree) firstDisagree = `"${e.s.name}": ${x} / ${y}`;
      }
    }
  }
  check('no shipped bank row has a label pair the validator calls distinct and the renderer reads as one term',
    disagree === 0, `${disagree} pairs — first: ${firstDisagree}`);
}

if (failures > 0) { console.error(`✗ scenario screens: ${failures} failed`); process.exit(1); }
console.log(`✓ scenario screens: all ${SCENARIO_SCREENS.length} screens carry a known-positive, an isolation result, hand-read negatives and a re-measured reach number`);

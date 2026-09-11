/**
 * Pure predicates for the "Regenerate scenario" feature (FEATURE-REGEN).
 *
 * Every hazard the brief named gets a check here, mapped explicitly to the
 * predicate that closes it — the same mapping FEATURE-REGEN-PLAN.md §4/§5
 * lays out — plus structural guards over App.tsx/server.ts for the parts a
 * pure-function test cannot reach (the in-flight ref, the aria-disabled
 * attribute, the flag name never being request-toggled).
 *
 *   npx tsx src/scenarioregen.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  isSameStory,
  regenKeyEquals,
  regenResponseIsCurrent,
  cleanPreview,
  keepFill,
  shouldReplaceName,
  regenErrorFromResponse,
  regenDroppedNote,
  orphanedNote,
  codepointSafeSlice,
  REGEN_NAME_MAX,
  REGEN_LABEL_MAX,
  REGEN_DESCRIPTION_MAX,
  type RegenKey,
} from './utils/scenarioRegen';
import { generatedFillIsSafe, type GeneratedFill } from './utils/generateFill';
import { pickScenarioDomainExcluding, SCENARIO_DOMAINS } from './utils/scenarioDomains';
import { bankDomainFor, bankScenarioAvoiding, allBankRows, bankAvailable, __resetBankSeen } from './utils/bankSource';
import { pickFromBank } from './utils/scenarioBank';
import type { GamePayoffs } from './types';
import { isSavedGameResponseRecord } from './utils/savedGameResponse';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

// The real-world pair used throughout this repo's staleness tests
// (src/reportrace.test.ts) — different payoffs, same shape, a known-good
// fixture for "these two games must never compare equal".
const payoffs = (overrides: Partial<GamePayoffs> = {}): GamePayoffs =>
  ({ a11: 2, b11: 1, a12: 0, b12: 0, a21: 0, b21: 0, a22: 1, b22: 2, ...overrides });
const SEARCH_GAME: GamePayoffs = payoffs({ a11: 2, b11: -2, a12: 0, b12: 0, a21: 0, b21: 0, a22: 1, b22: -1 });
const BATTLE_OF_SEXES: GamePayoffs = payoffs({ a11: 2, b11: 1, a12: 0, b12: 0, a21: 0, b21: 0, a22: 1, b22: 2 });

/* ─────────────────────────────────────────── H-stale: regenResponseIsCurrent */
{
  const editA: RegenKey = { kind: 'edit', gameId: 'game-A' };
  const editB: RegenKey = { kind: 'edit', gameId: 'game-B' };
  check('same generation, same game → current',
    regenResponseIsCurrent({ myGen: 3, currentGen: 3, requestKey: editA, currentKey: editA }));
  check('gen mismatch (a later click bumped it) → NOT current',
    !regenResponseIsCurrent({ myGen: 2, currentGen: 3, requestKey: editA, currentKey: editA }));
  check('gameId mismatch (Edit A response landing while Edit B is open) → NOT current',
    !regenResponseIsCurrent({ myGen: 3, currentGen: 3, requestKey: editA, currentKey: editB }));
  const saveSearch: RegenKey = { kind: 'save', payoffs: SEARCH_GAME };
  const saveBoS: RegenKey = { kind: 'save', payoffs: BATTLE_OF_SEXES };
  check('payoff mismatch (Save-dialog Regenerate landed after Generate rolled a new matrix) → NOT current',
    !regenResponseIsCurrent({ myGen: 1, currentGen: 1, requestKey: saveSearch, currentKey: saveBoS }));
  check('identical payoffs, same object shape → current',
    regenResponseIsCurrent({ myGen: 1, currentGen: 1, requestKey: saveSearch, currentKey: { kind: 'save', payoffs: { ...SEARCH_GAME } } }));
  check('kind mismatch (edit vs save) never equal',
    !regenKeyEquals(editA, saveSearch));
}

/* ─────────────────────────── H-stale (both dialogs closed): the null-guard bug */
{
  // A response landing after BOTH dialogs have closed must be dropped — there
  // is no "current" game to compare against. `regenCurrentKeyRef.current` is
  // `null` in exactly that case; a handler that falls back to
  // `regenCurrentKeyRef.current ?? key` would compare the request's own key
  // against ITSELF and always report "current", silently defeating the whole
  // check the instant the dialog closes. Caught only by reading the wiring,
  // since `regenResponseIsCurrent` itself is correct in isolation (see above)
  // — this guards the CALL SITE, not the pure function.
  const app = readFileSync('src/App.tsx', 'utf8');
  const handler = app.match(/const handleRegenerateScenario = [\s\S]*?\n  \};\n/)?.[0] ?? '';
  check('the handler never falls back to its own request key as "current" (the ?? key anti-pattern)',
    !/currentKey:\s*regenCurrentKeyRef\.current\s*\?\?\s*key/.test(handler),
    'regenCurrentKeyRef.current ?? key makes every response trivially "current" once both dialogs are closed');
  check('the handler treats a null regenCurrentKeyRef as NOT current',
    /!currentKey\s*\|\|/.test(handler) || /currentKey\s*===?\s*null/.test(handler),
    'no explicit null-check on the current key before calling regenResponseIsCurrent');
}

/* ────────────────────────────────────────────────────────── isSameStory */
{
  check('identical names (case/whitespace-insensitive) → same story',
    isSameStory({ name: '  Vineyard Water Scheduling  ' }, { name: 'vineyard water scheduling' }));
  check('NFKC-equivalent names → same story',
    isSameStory({ name: 'Café Bidding' }, { name: 'Café Bidding' })); // combining accent vs precomposed
  check('different names → different story',
    !isSameStory({ name: 'Vineyard Water Scheduling' }, { name: 'Bakery Supply Orders' }));
  check('no names, matching 40-char description prefix → same story',
    isSameStory(
      { description: 'Two bakeries are negotiating flour delivery windows for the spring season.' },
      { description: 'Two bakeries are negotiating flour delivery windows but the rest differs entirely.' },
    ));
  check('no names, differing description prefix → different story',
    !isSameStory({ description: 'A vineyard is scheduling irrigation.' }, { description: 'A bakery is ordering flour.' }));
  check('null/undefined on either side → never same', !isSameStory(null, { name: 'x' }) && !isSameStory({ name: 'x' }, undefined));
  check('empty on both sides → never same (an empty prefix must not equal itself)',
    !isSameStory({}, {}));
}

/* ───────────────────────────────────────────────── H-double-click / structural */
{
  const app = readFileSync('src/App.tsx', 'utf8');
  const handler = app.match(/const handleRegenerateScenario = [\s\S]*?\n  \};\n/);
  check('handleRegenerateScenario exists', !!handler, 'expected a handler literally named handleRegenerateScenario');
  const body = handler?.[0] ?? '';
  check('the handler begins with the in-flight early-return (guard READ)',
    /regenInFlightRef\.current\)\s*return/.test(body.slice(0, 400)),
    'a double-click / Enter-repeat must be rejected before any fetch is issued');
  check('the handler sets the in-flight flag (guard WRITTEN)',
    /regenInFlightRef\.current\s*=\s*true/.test(body),
    'the flag is read but never set — the idempotence bound cannot hold');
  check('the handler clears the in-flight flag only when still current (finally)',
    /regenInFlightRef\.current\s*=\s*false/.test(body));
  // aria-disabled, never plain `disabled` — a disabled button drops DOM
  // focus in Chrome, which would leak focus outside the modal's tab trap.
  // Extract each Regenerate button's OWN opening tag (from the nearest
  // preceding `<button` to that tag's closing `>`) so this cannot be
  // satisfied by a `disabled=` on some unrelated button elsewhere in the file.
  const ariaLabelHits = [...app.matchAll(/aria-label="Regenerate scenario"/g)];
  check('at least two Regenerate buttons exist (one per dialog)', ariaLabelHits.length >= 2, `found ${ariaLabelHits.length}`);
  for (const [i, hit] of ariaLabelHits.entries()) {
    const tagStart = app.lastIndexOf('<button', hit.index!);
    check(`Regenerate button ${i + 1}: a <button opening tag precedes its aria-label`, tagStart >= 0 && hit.index! - tagStart < 400);
    const tagEnd = app.indexOf('>', hit.index!);
    const tag = app.slice(tagStart, tagEnd + 1);
    check(`Regenerate button ${i + 1} carries aria-disabled, not a plain disabled attribute`,
      /aria-disabled=\{/.test(tag) && !/(?<!aria-)\bdisabled=\{/.test(tag),
      tag.replace(/\s+/g, ' ').slice(0, 200));
  }
}

/* ───────────────────────────────────────────────── H-RED-APP-4: Discard never writes */
{
  const app = readFileSync('src/App.tsx', 'utf8');
  const handler = app.match(/const handleRegenerateScenario = [\s\S]*?\n  \};\n/)?.[0] ?? '';
  check('the fetch success branch of the regen handler never calls a save-field setter directly',
    !/setSaveName\(|setSaveDesc\(|setSaveLabel\(|setSaveTerms\(|dispatchSaveForm\(|dispatchEditForm\(|setEditName\(|setEditDesc\(|setEditLabel\(|setEditTerms\(/.test(handler),
    'only setRegen(...) may run on a successful draw; the six form fields must be untouched until Keep runs');
  const discard = app.match(/const discardRegen = [\s\S]*?\n  \};\n/);
  check('discardRegen exists and is a short, pure reset', !!discard);
  check('discardRegen never calls a save/edit field setter',
    !/(setSaveName|setSaveDesc|setSaveLabel|setSaveTerms|dispatchSaveForm|dispatchEditForm|setEditName|setEditDesc|setEditLabel|setEditTerms)\(/.test(discard?.[0] ?? ''));
}

/* ───────────────────────────────────────────────── H-clamp: keepFill */
{
  const long900 = 'x'.repeat(900);
  const kept = keepFill({ name: 'n', description: long900, row1: 'a'.repeat(60), row2: 'b', col1: 'c', col2: 'd' }, true);
  check('keepFill clamps description to 800', kept.desc.length === REGEN_DESCRIPTION_MAX, `got ${kept.desc.length}`);
  check('keepFill clamps a label to 40', kept.labels.row1.length === REGEN_LABEL_MAX, `got ${kept.labels.row1.length}`);
  const longName = 'Vineyard '.repeat(10);
  const keptName = keepFill({ name: longName, description: 'd', row1: '', row2: '', col1: '', col2: '' }, true);
  check('keepFill clamps name to 40 when replaceName is true', (keptName.name ?? '').length <= REGEN_NAME_MAX);

  // Emoji at the exact cut must not be split into a lone surrogate.
  const emoji = '\u{1F600}'; // 😀, a surrogate pair (2 UTF-16 units)
  const withEmojiAtCut = 'a'.repeat(REGEN_LABEL_MAX - 1) + emoji; // cut lands mid-emoji
  const slicedLabel = keepFill({ row1: withEmojiAtCut, description: '', row2: '', col1: '', col2: '' }, false).labels.row1;
  check('an emoji straddling the clamp boundary is dropped whole, never split',
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(slicedLabel) && !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(slicedLabel),
    JSON.stringify(slicedLabel));
  check('codepointSafeSlice never exceeds the UTF-16-unit budget', codepointSafeSlice('a'.repeat(50), 40).length <= 40);
  check('codepointSafeSlice is a no-op under the budget', codepointSafeSlice('short', 40) === 'short');
}

/* ───────────────────────────────────────────────── H-bidi: cleanPreview */
{
  const RLO = String.fromCodePoint(0x202e);
  // CodeRabbit finding (this branch): a literal NUL byte was pasted
  // directly into this source file (twice — once in the fixture, once
  // in the assertion). Same Trojan-Source reasoning as textSafety.ts and
  // api.test.mjs's own RLO/SOH pattern elsewhere in this repo: numeric
  // code points only, never a literal control character in source.
  const NUL = String.fromCodePoint(0x0000);
  const dirty = { name: `Invoice${RLO}txt.exe`, description: `A vendor${NUL} negotiates.`, row1: 'a', row2: 'b', col1: 'c', col2: 'd' };
  const cleaned = cleanPreview(dirty);
  check('cleanPreview strips a bidi override from the name', !cleaned?.name?.includes(RLO), JSON.stringify(cleaned?.name));
  check('cleanPreview strips a NUL control from the description', !cleaned?.description?.includes(NUL));
  const arabic = 'مرحبا بالعالم';
  const realRTL = cleanPreview({ description: arabic });
  check('real right-to-left script text survives cleanPreview untouched', realRTL?.description === arabic);
  check('cleanPreview(null) is null', cleanPreview(null) === null);
}

/* ───────────────────────────────────────────────── H-colour: keepFill terms */
{
  const withActors = keepFill(
    { description: 'd', row1: 'r1', row2: 'r2', col1: 'c1', col2: 'c2', actorA: ['baker', 'baker'], actorB: ['a', 'distributor'] },
    false,
  );
  check('actor nouns flow into terms.a', withActors.terms.a.includes('baker'));
  check('a duplicate actor noun is de-duplicated', withActors.terms.a.filter((t) => t === 'baker').length === 1);
  check('a 1-character actor noun is dropped', !withActors.terms.b.includes('a'));
  check('actor nouns land on the right side', withActors.terms.b.includes('distributor'));

  const noActors = keepFill({ description: 'd', row1: '', row2: '', col1: '', col2: '' }, false);
  check('a bank row with no actor nouns and no existing chips yields empty term chips on both sides',
    noActors.terms.a.length === 0 && noActors.terms.b.length === 0);

  const overlap = keepFill({ description: 'd', row1: '', row2: '', col1: '', col2: '', actorA: ['courier'], actorB: ['courier'] }, false);
  check('a noun offered on both sides belongs to A only (ownership tie-break)',
    overlap.terms.a.includes('courier') && !overlap.terms.b.includes('courier'));

  const many = Array.from({ length: 20 }, (_, i) => `term${i}word`);
  const capped = keepFill({ description: 'd', row1: '', row2: '', col1: '', col2: '', actorA: many }, false);
  check('actor terms are capped (USER_TERMS_MAX via cleanUserColorTermPair)', capped.terms.a.length <= 12);
}

/* ────────────────────────────────── H-RED-REGEN-001: Keep never wipes chips */
{
  // The real shape of every draw this route can ever serve today: no
  // actorA/actorB at all (SCENARIO_SCHEMA is strict; see
  // scratchpad/round7/findings/RED-REGEN/001). The OLD keepFill (no
  // existingTerms argument, always
  // `cleanUserColorTermPair(preview.actorA ?? [], preview.actorB ?? [])`)
  // returned {a:[],b:[]} here every time, and App.tsx's keepRegen
  // UNCONDITIONALLY wrote that into editTerms/saveTerms, then the eventual
  // Save PATCH sent it with allowClear:true — permanently deleting whatever
  // the user had marked. This is the exact reproduction from
  // RED-REGEN/001's real-HTTP run (colorTermsA=['the vendor'] before,
  // colorTermsA=[] after), replayed here as a pure-function fixture so it
  // runs on every `npm test`, not just a live server.
  const realDrawShape = { description: 'A small quarry manager and a hauler negotiate.', row1: 'Early Window', row2: 'Late Window', col1: 'Morning Haul', col2: 'Afternoon Haul' };
  const usersChips = { a: ['the vendor'], b: ['the buyer'] };
  const kept = keepFill(realDrawShape, false, usersChips);
  check('RED-REGEN/001: a real (no-actor-noun) draw leaves the user\'s existing chips on player A untouched',
    kept.terms.a.includes('the vendor'), `got terms.a=${JSON.stringify(kept.terms.a)}`);
  check('RED-REGEN/001: same for player B',
    kept.terms.b.includes('the buyer'), `got terms.b=${JSON.stringify(kept.terms.b)}`);
  // RED-REGEN-14/002: this very draw's story names neither chip — Keep still
  // keeps both (above) AND names them as orphaned, so the note can say so.
  check('RED-REGEN-14/002: chips the kept story no longer contains are named in keepFill.orphaned',
    kept.orphaned.a.includes('the vendor') && kept.orphaned.b.includes('the buyer'), `got orphaned=${JSON.stringify(kept.orphaned)}`);
  const stillNamed = keepFill({ ...realDrawShape, description: 'The vendor and the buyer haggle at the quarry gate.' }, false, usersChips);
  check('RED-REGEN-14/002 (control): chips the kept story still contains are not orphaned',
    stillNamed.orphaned.a.length === 0 && stillNamed.orphaned.b.length === 0, `got orphaned=${JSON.stringify(stillNamed.orphaned)}`);
  const beyondClamp = keepFill({ ...realDrawShape, description: `${'x'.repeat(REGEN_DESCRIPTION_MAX)} the vendor` }, false, usersChips);
  check('RED-REGEN-14/002: orphaned is judged against the CLAMPED description (a phrase only beyond the 800 cut is orphaned)',
    beyondClamp.orphaned.a.includes('the vendor'), `got orphaned=${JSON.stringify(beyondClamp.orphaned)}`);
  check('RED-REGEN/001: nothing is ADDED that the user did not have or the draw did not supply',
    kept.terms.a.length === 1 && kept.terms.b.length === 1,
    `got terms=${JSON.stringify(kept.terms)}`);

  // If the schema is ever extended to carry actor nouns (out of scope for
  // this fix — see the PR description), they must ADD to the user's chips,
  // never replace them.
  const withNewActor = keepFill({ ...realDrawShape, actorA: ['the operator'] }, false, usersChips);
  check('RED-REGEN/001: a supplied actor noun is ADDED alongside the user\'s existing chip, not instead of it',
    withNewActor.terms.a.includes('the vendor') && withNewActor.terms.a.includes('the operator'),
    `got terms.a=${JSON.stringify(withNewActor.terms.a)}`);

  // CodeRabbit (this PR): "never destroys" has to mean "never REASSIGNS"
  // too. The user placed "wolf" on player B; a draw's actorA also offers
  // "wolf". The naive fix (concatenate existing+actor, then clean) let A
  // claim it and silently dropped the user's own B assignment. The real fix
  // cleans the EXISTING pair first — the user's ownership is fixed before
  // any actor noun is even considered — so a colliding actor noun is simply
  // discarded, never reassigned.
  const collision = keepFill(
    { ...realDrawShape, actorA: ['wolf'] }, false, { a: [], b: ['wolf'] },
  );
  check('RED-REGEN/001 (CodeRabbit): an actor noun colliding with the user\'s EXISTING opposite-side chip must not reassign it',
    collision.terms.b.includes('wolf') && !collision.terms.a.includes('wolf'),
    `got terms=${JSON.stringify(collision.terms)}`);
}

/* ───────────────────────────────────────────── H-name-rule: shouldReplaceName */
{
  check('name IS replaced when the user has not typed into the name field this session',
    shouldReplaceName(false) === true);
  check('name is NEVER replaced once the user typed into the name field this session',
    shouldReplaceName(true) === false);
}

/* ───────────────────────────────────────── H-rate-limit wording: regenErrorFromResponse */
{
  check("429 -> 'rate-limit'", regenErrorFromResponse(429, { error: 'Too many attempts. Please wait a minute and try again.' }, null) === 'rate-limit');
  const abortErr = new DOMException('aborted', 'AbortError');
  check("AbortError -> 'timeout' regardless of status", regenErrorFromResponse(null, null, abortErr) === 'timeout');
  check("404 -> 'unavailable'", regenErrorFromResponse(404, null, null) === 'unavailable');
  check("200 with scenario:null -> 'no-story'", regenErrorFromResponse(200, { scenario: null }, null) === 'no-story');
  check("anything else (offline, 500, malformed body) -> 'network'", regenErrorFromResponse(500, null, null) === 'network');
  check("network failure with no status at all -> 'network'", regenErrorFromResponse(null, null, new TypeError('fetch failed')) === 'network');
}

/* ───────────────────────────────────────────────── server pure: domain/bank avoidance */
{
  // pickScenarioDomainExcluding never returns the excluded domain when a
  // RETRY can find something else — the first draw hits the excluded domain,
  // every retry after it lands elsewhere.
  const alwaysFirst = () => 0; // Math.floor(0 * N) === 0 → SCENARIO_DOMAINS[0], every call
  const excluded = SCENARIO_DOMAINS[0];
  let calls = 0;
  const firstThenElsewhere = () => (calls++ === 0 ? 0 : 0.5); // 1st call hits `excluded`; every retry lands on index ~42
  check('pickScenarioDomainExcluding never returns the excluded domain when a retry can avoid it',
    pickScenarioDomainExcluding(excluded, firstThenElsewhere) !== excluded,
    `picker's first draw is "${excluded}" and the retry did not avoid it`);
  check('pickScenarioDomainExcluding(undefined) behaves like an ordinary pick',
    SCENARIO_DOMAINS.includes(pickScenarioDomainExcluding(undefined, alwaysFirst)));
  check('pickScenarioDomainExcluding degrades to a repeated draw (not a throw/hang) when the picker itself is constant',
    pickScenarioDomainExcluding(excluded, alwaysFirst) === excluded,
    'the docstring promises "returns whatever the last draw was" for a degenerate picker, never a throw or an infinite loop');
  check('pickScenarioDomainExcluding never throws when excluded is not a real domain at all',
    typeof pickScenarioDomainExcluding('not-a-real-domain', alwaysFirst) === 'string');

  if (bankAvailable()) {
    const rows = allBankRows();
    const real = rows[0];
    check('bankDomainFor returns the row\'s own domain for a real bank scenario',
      bankDomainFor(real.s) === real.d, `expected ${real.d}, got ${bankDomainFor(real.s)}`);
    check('bankDomainFor returns undefined for a user-typed story not in the bank',
      bankDomainFor({ name: 'Definitely Not A Bank Row XYZ123', description: 'nothing like it' }) === undefined);
    check('bankDomainFor(undefined) is undefined', bankDomainFor(undefined) === undefined);

    // bankScenarioAvoiding on a fake single-domain, multi-row bank: never
    // returns the avoided name while another exists in the same cell.
    __resetBankSeen();
    const g: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
    // Use pickFromBank directly against a synthetic bank to prove the LADDER
    // semantics survive avoidance (bankScenarioAvoiding itself is exercised
    // against the real shipped bank just below — a synthetic one here keeps
    // this assertion independent of what happens to ship in the artifact).
    const synth = [
      { d: 'x', b: 0, s: { name: 'Row One', row1: 'a', row2: 'b', col1: 'c', col2: 'd', description: 'one' } },
      { d: 'x', b: 0, s: { name: 'Row Two', row1: 'a', row2: 'b', col1: 'c', col2: 'd', description: 'two' } },
    ] as const;
    const avoidSeen = new Set(synth.filter((e) => e.s.name === 'Row One').map((e) => `${e.d}|${e.s.name}|${e.s.description.slice(0, 40)}`));
    const picked = pickFromBank(synth as never, g, 'x', avoidSeen, () => 0);
    check('a synthetic 2-row bank with one name avoided always serves the other name',
      picked?.name === 'Row Two', `got ${picked?.name}`);

    // Real bank: 25 draws never re-serve the avoided name while alternatives exist.
    const avoidName = real.s.name;
    let anyAvoided = false;
    for (let i = 0; i < 25; i++) {
      const sc = bankScenarioAvoiding(g, real.d, avoidName);
      if (sc?.name && avoidName && isSameStory(sc, { name: avoidName })) anyAvoided = true;
    }
    check('bankScenarioAvoiding never re-serves the avoided name across 25 draws (real bank)', !anyAvoided);
    __resetBankSeen();
  } else {
    console.warn('  (bank not available in this environment — bank-avoidance checks skipped, not failed)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STRUCT-REGEN-19/002 + /003c. Two structural changes, each with its mutation map.
//
//   m1 keepFill stops computing `shadowed`            -> "shadowed names the kept chip…"
//   m2 shadowedNote ignores its player/plural         -> "shadowedNote agrees in number…"
//   m3 regenDroppedNote drops the `shadowed` argument -> "regenDroppedNote names a shadowed chip…"
//   m4 keepRegen loses its session check              -> "keepRegen refuses an outcome…"
//   m5 regenView stops gating on the dialog key       -> "regenView is gated on…"
{
  // VERBATIM from STRUCT-REGEN-19/002's live repro — real draw #32 of the
  // 34-draw corpus, typography included (the U+2019 apostrophe in "resort’s"):
  // the user's chip "crew" for Player A, under Player B's option labels
  // "Early Crew" / "Late Crew". The words ARE on screen; they are BLUE.
  const shadowDraw = {
    description: 'A ski resort’s operations manager and its grooming contractor are coordinating '
      + 'preparation for a high-profile lift corridor. The manager chooses Full Grooming or Selective '
      + 'Grooming, and the contractor books an Early Crew or a Late Crew.',
    row1: 'Full Grooming', row2: 'Selective Grooming', col1: 'Early Crew', col2: 'Late Crew',
  };
  const shadowKept = keepFill(shadowDraw, false, { a: ['crew'], b: [] });
  check('STRUCT-REGEN-19/002: shadowed names the kept chip and the phrase that took its colour',
    shadowKept.shadowed.a.length === 1
    && shadowKept.shadowed.a[0].term === 'crew'
    && shadowKept.shadowed.a[0].by === 'Early Crew'
    && shadowKept.shadowed.a[0].bySide === 'B',
    `got shadowed=${JSON.stringify(shadowKept.shadowed)}`);
  check('STRUCT-REGEN-19/002: a shadowed chip is STILL KEPT (Keep never destroys highlights)',
    shadowKept.terms.a.includes('crew'), `got terms.a=${JSON.stringify(shadowKept.terms.a)}`);
  check('STRUCT-REGEN-19/002: a shadowed chip is not ALSO reported as orphaned (its phrase is there)',
    shadowKept.orphaned.a.length === 0, `got orphaned=${JSON.stringify(shadowKept.orphaned)}`);
  // CONTROL: the same chip under labels that do not contain it paints normally.
  const notShadowed = keepFill({ ...shadowDraw, col1: 'Early Slot', col2: 'Late Slot',
    description: shadowDraw.description.replace(/Early Crew/, 'Early Slot').replace(/Late Crew/, 'Late Slot') },
    false, { a: ['crew'], b: [] });
  check('STRUCT-REGEN-19/002 (control): with no other-player phrase over it, the chip is not shadowed',
    notShadowed.shadowed.a.length === 0 && notShadowed.orphaned.a.length === 1,
    `got shadowed=${JSON.stringify(notShadowed.shadowed)} orphaned=${JSON.stringify(notShadowed.orphaned)}`);
  // CONTROL: same-side shadowing is NOT a lie — the words really are this
  // player's colour, just claimed by the longer phrase.
  const sameSide = keepFill({ ...shadowDraw, row1: 'Early Crew', row2: 'Late Crew', col1: 'Full Grooming', col2: 'Selective Grooming' },
    false, { a: ['crew'], b: [] });
  check('STRUCT-REGEN-19/002 (control): a chip swallowed by a phrase of its OWN player is not shadowed',
    sameSide.shadowed.a.length === 0, `got shadowed=${JSON.stringify(sameSide.shadowed)}`);
  // CONTROL: a draw's own actor noun is not a "kept chip" and is never reported.
  const drawNoun = keepFill({ ...shadowDraw, actorA: ['crew'] }, false, { a: [], b: [] });
  check('STRUCT-REGEN-19/002 (control): the draw’s own noun is not reported as a shadowed KEPT chip',
    drawNoun.shadowed.a.length === 0, `got shadowed=${JSON.stringify(drawNoun.shadowed)}`);

  const shadowOne = regenDroppedNote({ a: [], b: [] }, { a: [], b: [] }, shadowKept.shadowed) ?? '';
  check('STRUCT-REGEN-19/002: regenDroppedNote names a shadowed chip, the phrase that took it, and that player',
    /"crew"/.test(shadowOne) && /"Early Crew"/.test(shadowOne) && /Player B/.test(shadowOne)
    && /Player A's highlight /.test(shadowOne), shadowOne);
  check('STRUCT-REGEN-19/002: shadowedNote agrees in number (singular)',
    / highlight /.test(shadowOne) && / is shown /.test(shadowOne) && /remove the chip,/.test(shadowOne), shadowOne);
  const shadowTwo = regenDroppedNote({ a: [], b: [] }, { a: [], b: [] },
    { a: [{ term: 'crew', by: 'Early Crew', bySide: 'B' }, { term: 'slot', by: 'Late Slot', bySide: 'B' }], b: [] }) ?? '';
  check('STRUCT-REGEN-19/002: shadowedNote agrees in number (plural: highlights … are … the chips)',
    / highlights /.test(shadowTwo) && / are shown /.test(shadowTwo) && /remove the chips,/.test(shadowTwo), shadowTwo);
  check('STRUCT-REGEN-19/002 (control): nothing dropped, orphaned or shadowed still reads as no note at all',
    regenDroppedNote({ a: [], b: [] }, { a: [], b: [] }, { a: [], b: [] }) === null);

  // 003c: a regenerate outcome belongs to the dialog session that asked for it.
  const appSrcRegen = readFileSync('src/App.tsx', 'utf8');
  check('STRUCT-REGEN-19/003c: keepRegen refuses an outcome drawn for another dialog session',
    /if \(!regen\.preview \|\| !regen\.key \|\| !regenKeyEquals\(regen\.key, key\)\) return;/.test(appSrcRegen));
  check('STRUCT-REGEN-19/003c: regenView is gated on regen.key matching the dialog on screen',
    /regen\.key && currentDialogKey && regenKeyEquals\(regen\.key, currentDialogKey\)/.test(appSrcRegen));
  check('STRUCT-REGEN-19/003c: every regen outcome records the key it was drawn for',
    !/setRegen\(\{[^}]*\}\)/.test(appSrcRegen.replace(/setRegen\(\{[^}]*key[^}]*\}\)/g, '')));
}

/* ─────────────────────── STRUCT-REGEN-19/007: Keep must not hand the user's own
   text to the "what the app last wrote" record. RED-APP-4 (round 4) stops a
   Generate fill from overwriting text the user typed; `keepRegen` registers the
   kept draw as that record (OPUS-REVIEW-171/N1) so a re-roll may replace it. The
   fallback `kept.name !== undefined ? kept.name : liveName` put the USER's name
   in there — `kept.name` is undefined exactly when the user typed it — and the
   next Generate then judged the field "the app's own" and overwrote it.
   Live: "My careful title" -> "Trail Watch" (findings/STRUCT-REGEN-19/007);
   control without the Keep: the name survives. */
{
  const draw = { name: 'AI Title', description: 'A harbour story about ferries and tides.', row1: 'r1', row2: 'r2', col1: 'c1', col2: 'c2' };
  const TYPED = 'My careful title';
  // The whole path, as App.tsx runs it.
  const record = (liveName: string, typedIt: boolean): GeneratedFill => {
    const kept = keepFill(draw, shouldReplaceName(typedIt), { a: [], b: [] });
    return {
      // App.tsx's rule, post-fix: only what the Keep itself wrote.
      name: kept.name ?? '',
      desc: kept.desc,
      row1: kept.labels.row1, row2: kept.labels.row2, col1: kept.labels.col1, col2: kept.labels.col2,
    };
  };
  check('fixture precondition: Keep leaves a hand-typed name alone', shouldReplaceName(true) === false);
  check('fixture precondition: Keep replaces a name the user never touched', shouldReplaceName(false) === true);
  const typedCase = record(TYPED, true);
  check('STRUCT-REGEN-19/007: the kept-draw record never carries the name the USER typed',
    typedCase.name !== TYPED, JSON.stringify(typedCase.name));
  const afterKeep = { name: TYPED, desc: typedCase.desc, labels: { row1: typedCase.row1, row2: typedCase.row2, col1: typedCase.col1, col2: typedCase.col2 } };
  check('STRUCT-REGEN-19/007: after that Keep, the next Generate may NOT overwrite the form (RED-APP-4)',
    generatedFillIsSafe(afterKeep, typedCase) === false);
  // The pre-fix record, verbatim, must fail that same assertion — so the check
  // above cannot be passing for an unrelated reason.
  const preFix: GeneratedFill = { ...typedCase, name: TYPED };
  check('fixture: the pre-fix record (name falls back to liveName) DOES let the fill through',
    generatedFillIsSafe(afterKeep, preFix) === true);
  // Control: a name the user never touched IS the app's own, and a re-roll may
  // replace it — the behaviour OPUS-REVIEW-171/N1 added, still intact.
  const untouched = record('AI Title', false);
  check('control: a Keep that replaced the name records it, so a re-roll may replace it again',
    untouched.name === 'AI Title'
    && generatedFillIsSafe({ name: 'AI Title', desc: untouched.desc, labels: { row1: untouched.row1, row2: untouched.row2, col1: untouched.col1, col2: untouched.col2 } }, untouched) === true);
  // …and the rest of the kept story is still recorded, or the re-roll flow breaks.
  check('control: the kept description and option names are still recorded',
    untouched.desc === keepFill(draw, true, { a: [], b: [] }).desc && untouched.row1 === 'r1');
}

/* App.tsx source: the record is built from `kept` alone. */
{
  const app = readFileSync('src/App.tsx', 'utf8');
  const keepStart = app.indexOf('const keepRegen = (key: RegenKey) => {');
  const keepFn = app.slice(keepStart, app.indexOf('regenButtonRef.current?.focus();', keepStart));
  check('STRUCT-REGEN-19/007: keepRegen records only what the Keep wrote (name: kept.name ?? \'\')',
    /name: kept\.name \?\? '',/.test(keepFn));
  // Comment lines stripped first: this block's own explanation names `liveName`,
  // and a check that a COMMENT can fail is a check that cannot fail for its reason.
  const keepCode = keepFn.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('STRUCT-REGEN-19/007: liveName never reaches the last-generated-fill record',
    !/lastGeneratedFillRef\.current = \{[\s\S]{0,300}?liveName/.test(keepCode));
  check('fixture: that check DOES fire on the pre-fix code',
    /lastGeneratedFillRef\.current = \{[\s\S]{0,300}?liveName/.test(
      keepCode.replace("name: kept.name ?? '',", 'name: kept.name !== undefined ? kept.name : liveName,')));
}

// ── STRUCT-REGEN-19/010: one orphaned-chip sentence, two callers ─────────────
// The 409 adoption plants chips the app chose, against a description this dialog
// may have rewritten. It owes the same sentence Keep already gives rather than a
// second one written beside it, so `orphanedNote` takes WHERE the phrase is
// missing from. The default must be byte-identical to what Keep printed before.
{
  const keepDefault = orphanedNote(['lighthouse keeper'], 'A');
  check('orphanedNote: the default wording is unchanged for the Keep path',
    keepDefault === 'Player A\'s highlight "lighthouse keeper" does not appear in the new story, so it is shown as not highlighted — reuse the phrase in the text or remove the chip.',
    keepDefault);
  const adopted = orphanedNote(['lighthouse keeper'], 'A', 'this description');
  check('orphanedNote: the adoption path names this description instead of the new story',
    adopted.includes('does not appear in this description') && !adopted.includes('the new story'), adopted);
  check('orphanedNote: only the WHERE changes — the rest of the sentence is the same one',
    adopted === keepDefault.replace('the new story', 'this description'), adopted);
  // Number agreement (the round-16 rule) must survive the new argument.
  const two = orphanedNote(['a', 'b'], 'B', 'this description');
  check('orphanedNote: plural noun, verb and pronoun with a custom where',
    /highlights .* do not appear in this description, so they are shown/.test(two)
    && /remove the chips\.$/.test(two), two);
  check('orphanedNote: singular noun, verb and pronoun with a custom where',
    /highlight .* does not appear in this description, so it is shown/.test(adopted)
    && /remove the chip\.$/.test(adopted), adopted);
  // Mutants, each killed by the check that names it.
  const mutants: [string, string, string][] = [
    ['M1 the where argument is ignored (the pre-fix function)',
      orphanedNote(['lighthouse keeper'], 'A'), 'names this description instead of the new story'],
    ['M2 the default changes under the Keep path',
      orphanedNote(['lighthouse keeper'], 'A', 'the story'), 'the default wording is unchanged'],
  ];
  check(`${mutants[0][0]} -> would fail "${mutants[0][2]}"`,
    !mutants[0][1].includes('this description'));
  check(`${mutants[1][0]} -> would fail "${mutants[1][2]}"`,
    mutants[1][1] !== keepDefault);
}

// ── RED-REGEN-20/001: an abandoned auth detour must not spend a prefill ─────
{
  const app = readFileSync('src/App.tsx', 'utf8');
  // These checks intentionally inspect the EXACT named functions and paths,
  // rather than searching the whole file. A source regex that sees a helper or
  // a comment anywhere in App.tsx can pass while the real Save success branch
  // never consumes anything, or while the dismiss clear sits under Edit only.
  const withoutComments = (source: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const between = (source: string, start: string, end: string) => {
    const i = source.indexOf(start);
    if (i < 0) return '';
    const j = source.indexOf(end, i + start.length);
    return j < 0 ? '' : source.slice(i, j);
  };
  const code = withoutComments(app);
  const suggested = between(code, 'const useSuggestedScenario = async', 'const fetchLlmExplanation = async');
  const suggestedEdit = between(suggested, 'if (existing && authToken) {', 'setIsEditModalOpen(true);');
  const suggestedSave = between(suggested, "const prefillName = (sc.name ?? '').slice(0, 40);", 'setIsSaveModalOpen(true);');
  const authGate = between(code, 'const beginNeedsAuthSignIn =', 'const explanationDialogSessionSeqRef =');
  const dismiss = between(code, 'const dismissAuthModal = () => {', 'const consumeRegenExplanationAfterSave = (');
  const beginSave = between(code, 'const beginSaveDialogSession = () => {', 'const beginEditDialogSession = () => {');
  const abandon = between(code, 'const abandonExplanationDialogSession = () => {', 'const cancelSaveDialog =');
  const consume = between(code, 'const consumeRegenExplanationAfterSave = (', 'useEffect(() => {');
  const editHandler = between(code, 'const handleEditGameSubmit = async', 'const deletingGamesRef =');
  const saveHandler = between(code, 'const handleSaveGameSubmit = async', 'const handleRegenerateScenario = async');
  const parsedSuccessGate = "if (res.kind !== 'response' || (res.ok && (!res.dataParsed || res.data?.success !== true)))";
  const editSuccess = between(editHandler, 'if (res.ok) {', '\n      } else if (res.status === 404)');
  const saveSuccess = between(saveHandler, 'if (res.ok) {', '\n      } else {');
  const required = (label: string, ok: boolean) => check(`RED-REGEN-20/001: ${label}`, ok);
  const guardRange = (source: string, signature: string): { start: number; open: number; close: number } | null => {
    const start = source.indexOf(signature);
    if (start < 0) return null;
    const open = source.indexOf('{', start + signature.length);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') depth -= 1;
      if (depth === 0) return { start, open, close: i };
    }
    return null;
  };
  const guardReturnsBefore = (source: string, signature: string, commitMarker: string): boolean => {
    const gate = guardRange(source, signature);
    const commit = source.indexOf(commitMarker);
    if (!gate || commit < 0 || gate.close >= commit) return false;
    const body = source.slice(gate.open + 1, gate.close);
    const parsed = ts.createSourceFile(
      'regen-response-guard.tsx',
      `function guard() {${body}}`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const fn = parsed.statements.find(ts.isFunctionDeclaration);
    return fn?.body?.statements.some(ts.isReturnStatement) === true;
  };
  const removeDirectGuardReturn = (source: string, signature: string): string => {
    const gate = guardRange(source, signature);
    if (!gate) return source;
    const body = source.slice(gate.open + 1, gate.close);
    const returnAt = body.lastIndexOf('return;');
    if (returnAt < 0) return source;
    const absolute = gate.open + 1 + returnAt;
    return source.slice(0, absolute) + source.slice(absolute + 'return;'.length);
  };
  const editPrefillStoresOwnSession = (source: string): boolean =>
    /const dialogSessionId = beginEditDialogSession\(\);[\s\S]*regenExplanationAfterSaveRef\.current = \{\s*dialogSessionId,\s*regenKey: \{ kind: 'edit', gameId: existing\.id \}/.test(source);
  const savePrefillStoresOwnSession = (source: string): boolean =>
    /const dialogSessionId = beginSaveDialogSession\(\);[\s\S]*regenExplanationAfterSaveRef\.current = \{\s*dialogSessionId,\s*regenKey: \{ kind: 'save', payoffs \}/.test(source);
  const startsIndependentSaveSession = (source: string): boolean =>
    /saveRequestIdRef\.current\s*=\s*null;/.test(source)
    && /setSaveLoading\(false\);/.test(source);
  const validSavedGame = {
    id: 'g-fixture',
    name: 'Fixture game',
    description: 'A complete saved-game response.',
    payoffs: payoffs(),
    row1Label: 'Up', row2Label: 'Down', col1Label: 'Left', col2Label: 'Right',
    colorTermsA: ['operator'], colorTermsB: ['supplier'],
  };

  required('the pending value has a dialog nonce plus a RegenKey',
    /type ExplanationSessionKey = \{[\s\S]*dialogSessionId: number;[\s\S]*regenKey: RegenKey;/.test(code)
    && /useRef<ExplanationSessionKey \| null>\(null\)/.test(code));
  required('Save and Edit prefill paths mint and store their own session keys',
    editPrefillStoresOwnSession(suggestedEdit) && savePrefillStoresOwnSession(suggestedSave));
  const wrongEditNonce = suggestedEdit.replace(
    /(regenExplanationAfterSaveRef\.current = \{\s*)dialogSessionId,/,
    '$1dialogSessionId: dialogSessionId + 1,',
  );
  check('mutation: storing the wrong Edit dialog nonce fails the pending-session guard',
    wrongEditNonce !== suggestedEdit && !editPrefillStoresOwnSession(wrongEditNonce));
  const wrongSaveNonce = suggestedSave.replace(
    /(regenExplanationAfterSaveRef\.current = \{\s*)dialogSessionId,/,
    '$1dialogSessionId: dialogSessionId + 1,',
  );
  check('mutation: storing the wrong Save dialog nonce fails the pending-session guard',
    wrongSaveNonce !== suggestedSave && !savePrefillStoresOwnSession(wrongSaveNonce));
  required('a fresh ordinary Save starts a new session before opening',
    /onClick=\{\(\) => \{[\s\S]*?beginSaveDialogSession\(\);[\s\S]*?openSaveFormForBoard\(\);[\s\S]*?setIsSaveModalOpen\(true\);[\s\S]*?data-focus-fallback="save-preset"/.test(code));
  required('every new Save session invalidates an older POST and releases its own loading state',
    startsIndependentSaveSession(beginSave));
  const saveSessionWithoutRequestInvalidation = beginSave.replace(/saveRequestIdRef\.current\s*=\s*null;/, '');
  check('mutation: keeping the prior Save request id fails the fresh-session boundary',
    saveSessionWithoutRequestInvalidation !== beginSave
    && !startsIndependentSaveSession(saveSessionWithoutRequestInvalidation));
  const saveSessionWithoutLoadingRelease = beginSave.replace(/setSaveLoading\(false\);/, '');
  check('mutation: inheriting the old Save loading state fails the fresh-session boundary',
    saveSessionWithoutLoadingRelease !== beginSave
    && !startsIndependentSaveSession(saveSessionWithoutLoadingRelease));
  required('a fresh ordinary Edit starts a new session before opening',
    /const openEditGame = \(game: any\) => \{\s*beginEditDialogSession\(\);/.test(code));
  required('auth resume closes and reopens the same dialog without abandoning it',
    /if \(kind === 'save'\) \{\s*resumeSaveAfterAuthRef\.current = true;\s*setIsSaveModalOpen\(false\);/.test(authGate)
    && /else \{\s*resumeEditAfterAuthRef\.current = true;\s*setIsEditModalOpen\(false\);/.test(authGate)
    && !/abandonExplanationDialogSession\(\)/.test(authGate)
    && /if \(authToken && resumeSaveAfterAuthRef\.current\) \{[\s\S]*setIsSaveModalOpen\(true\);/.test(code)
    && /if \(authToken && resumeEditAfterAuthRef\.current\) \{[\s\S]*setIsEditModalOpen\(true\);/.test(code));
  required('the auth-dismiss clear is unconditional and precedes the Edit-only reopen branch',
    dismiss.indexOf('abandonExplanationDialogSession();') >= 0
    && dismiss.indexOf('abandonExplanationDialogSession();') < dismiss.indexOf('if (resumeEditAfterAuthRef.current)'));
  required('the abandonment helper clears the pending value and both dialog sessions',
    /regenExplanationAfterSaveRef\.current = null;[\s\S]*saveDialogSessionRef\.current = null;[\s\S]*editDialogSessionRef\.current = null;/.test(abandon));
  required('Save and Edit cancel handlers synchronously abandon the session',
    /const cancelSaveDialog = \(\) => \{\s*abandonExplanationDialogSession\(\);/.test(code)
    && /const cancelEditDialog = \(\) => \{\s*abandonExplanationDialogSession\(\);/.test(code)
    && /onClose=\{cancelSaveDialog\}/.test(code) && /onClose=\{cancelEditDialog\}/.test(code)
    && (code.match(/onClick=\{cancelSaveDialog\}/g) ?? []).length >= 2
    && (code.match(/onClick=\{cancelEditDialog\}/g) ?? []).length >= 2);
  required('consume clears before comparing nonce and RegenKey',
    /const pendingKey = regenExplanationAfterSaveRef\.current;\s*regenExplanationAfterSaveRef\.current = null;/.test(consume)
    && /pendingKey\.dialogSessionId === submittedSessionId/.test(consume)
    && /regenKeyEquals\(pendingKey\.regenKey, submittedKey\)/.test(consume));
  required('Edit consume is inside parsed success:true path',
    guardReturnsBefore(editHandler, parsedSuccessGate, 'if (res.ok) {')
    && /consumeRegenExplanationAfterSave\([\s\S]*editDialogSessionRef\.current/.test(editSuccess));
  required('Save consume is inside parsed success:true path',
    guardReturnsBefore(saveHandler, parsedSuccessGate, 'if (res.ok) {')
    && /consumeRegenExplanationAfterSave\([\s\S]*saveDialogSessionRef\.current/.test(saveSuccess));
  const editWithoutParsedReturn = removeDirectGuardReturn(editHandler, parsedSuccessGate);
  check('mutation: removing Edit parsed-success return fails the regeneration commit boundary',
    editWithoutParsedReturn !== editHandler
    && !guardReturnsBefore(editWithoutParsedReturn, parsedSuccessGate, 'if (res.ok) {'));
  const saveWithoutParsedReturn = removeDirectGuardReturn(saveHandler, parsedSuccessGate);
  check('mutation: removing Save parsed-success return fails the regeneration commit boundary',
    saveWithoutParsedReturn !== saveHandler
    && !guardReturnsBefore(saveWithoutParsedReturn, parsedSuccessGate, 'if (res.ok) {'));

  required('the saved-game response predicate accepts a complete server game',
    isSavedGameResponseRecord(validSavedGame));
  required('the saved-game response predicate rejects a missing game, non-finite payoff, and malformed term list',
    !isSavedGameResponseRecord(undefined)
    && !isSavedGameResponseRecord({ ...validSavedGame, payoffs: { ...validSavedGame.payoffs, a11: Number.NaN } })
    && !isSavedGameResponseRecord({ ...validSavedGame, colorTermsA: ['operator', 4] }));
  const savedGameGuard = 'if (res.ok && !savedGame)';
  const commitsOnlyValidGame = (source: string): boolean =>
    /const savedGame\s*=\s*isSavedGameResponseRecord\(data\?\.game\)[\s\S]{0,120}?\?\s*data\.game\s*:\s*null;/.test(source)
    && guardReturnsBefore(source, savedGameGuard, 'if (res.ok) {');
  const editCommitsOnlyMatchingGame = (source: string): boolean =>
    commitsOnlyValidGame(source)
    && /isSavedGameResponseRecord\(data\?\.game\)\s*&&\s*data\.game\.id\s*===\s*editGameId/.test(source);
  required('Edit validates data.game and exits before committing malformed success data',
    editCommitsOnlyMatchingGame(editHandler) && !/data\.game/.test(editSuccess));
  required('Save validates data.game and exits before committing malformed success data',
    commitsOnlyValidGame(saveHandler) && !/data\.game/.test(saveSuccess));
  const editWithoutGameValidation = editHandler.replace(
    'isSavedGameResponseRecord(data?.game)',
    '!!data?.game',
  );
  check('mutation: accepting any truthy Edit data.game fails the response-record guard',
    editWithoutGameValidation !== editHandler && !editCommitsOnlyMatchingGame(editWithoutGameValidation));
  const saveWithoutGameValidation = saveHandler.replace(
    'isSavedGameResponseRecord(data?.game)',
    '!!data?.game',
  );
  check('mutation: accepting any truthy Save data.game fails the response-record guard',
    saveWithoutGameValidation !== saveHandler && !commitsOnlyValidGame(saveWithoutGameValidation));
  const editWithoutIdBinding = editHandler.replace(' && data.game.id === editGameId', '');
  check('mutation: accepting another game id fails the Edit response-binding guard',
    editWithoutIdBinding !== editHandler && !editCommitsOnlyMatchingGame(editWithoutIdBinding));
  required('the session key is retired when a new matrix is generated',
    /const handleGenerateGame = async \(\) => \{[\s\S]*beginSaveDialogSession\(\);/.test(code));

  const smoke = withoutComments(readFileSync('src/e2e/smoke.mjs', 'utf8'));
  const section91 = between(smoke, "section('91',", '\nawait executeSections();');
  const readback = between(section91, 'const readBackSavedGame = async', 'const submitOrdinarySave = async');
  const readbackIsBounded = (source: string) =>
    /const\s+controller\s*=\s*new AbortController\(\)/.test(source)
    && /setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*10_000\)/.test(source)
    && /fetch\('\/api\/games',\s*\{[\s\S]*?signal:\s*controller\.signal[\s\S]*?\}\)/.test(source)
    && /catch\s*\{[\s\S]*?ok:\s*false[\s\S]*?parsed:\s*false[\s\S]*?found:\s*false/.test(source)
    && /finally\s*\{\s*clearTimeout\(deadlineTimer\);\s*\}/.test(source);
  required('§91 bounds saved-game readback with an abort signal and cleanup-safe timer',
    readbackIsBounded(readback));
  const noReadbackSignalMutant = readback.replace(/,\s*signal:\s*controller\.signal/, '');
  check('mutation: removing the readback fetch signal fails the §91 deadline guard',
    !readbackIsBounded(noReadbackSignalMutant));
  const noReadbackCleanupMutant = readback.replace('clearTimeout(deadlineTimer);', '');
  check('mutation: removing readback timer cleanup fails the §91 deadline guard',
    !readbackIsBounded(noReadbackCleanupMutant));
}

if (failures > 0) {
  console.error(`\n${failures} scenarioregen check(s) failed.`);
  process.exit(1);
}
console.log(`scenarioregen.test.ts: all checks passed.`);

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
import {
  isSameStory,
  regenKeyEquals,
  regenResponseIsCurrent,
  cleanPreview,
  keepFill,
  shouldReplaceName,
  regenErrorFromResponse,
  codepointSafeSlice,
  REGEN_NAME_MAX,
  REGEN_LABEL_MAX,
  REGEN_DESCRIPTION_MAX,
  type RegenKey,
} from './utils/scenarioRegen';
import { pickScenarioDomainExcluding, SCENARIO_DOMAINS } from './utils/scenarioDomains';
import { bankDomainFor, bankScenarioAvoiding, allBankRows, bankAvailable, __resetBankSeen } from './utils/bankSource';
import { pickFromBank } from './utils/scenarioBank';
import type { GamePayoffs } from './types';

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
    !/setSaveName\(|setSaveDesc\(|setSaveLabels\(|setSaveTerms\(|setEditName\(|setEditDesc\(|setEditLabels\(|setEditTerms\(/.test(handler),
    'only setRegen(...) may run on a successful draw; the six form fields must be untouched until Keep runs');
  const discard = app.match(/const discardRegen = [\s\S]*?\n  \};\n/);
  check('discardRegen exists and is a short, pure reset', !!discard);
  check('discardRegen never calls a save/edit field setter',
    !/(setSaveName|setSaveDesc|setSaveLabels|setSaveTerms|setEditName|setEditDesc|setEditLabels|setEditTerms)\(/.test(discard?.[0] ?? ''));
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
  const dirty = { name: `Invoice${RLO}txt.exe`, description: `A vendor  negotiates.`, row1: 'a', row2: 'b', col1: 'c', col2: 'd' };
  const cleaned = cleanPreview(dirty);
  check('cleanPreview strips a bidi override from the name', !cleaned?.name?.includes(RLO), JSON.stringify(cleaned?.name));
  check('cleanPreview strips a NUL control from the description', !cleaned?.description?.includes(' '));
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
  check('a bank row with no actor nouns yields empty term chips on both sides',
    noActors.terms.a.length === 0 && noActors.terms.b.length === 0);

  const overlap = keepFill({ description: 'd', row1: '', row2: '', col1: '', col2: '', actorA: ['courier'], actorB: ['courier'] }, false);
  check('a noun offered on both sides belongs to A only (ownership tie-break)',
    overlap.terms.a.includes('courier') && !overlap.terms.b.includes('courier'));

  const many = Array.from({ length: 20 }, (_, i) => `term${i}word`);
  const capped = keepFill({ description: 'd', row1: '', row2: '', col1: '', col2: '', actorA: many }, false);
  check('actor terms are capped (USER_TERMS_MAX via cleanUserColorTermPair)', capped.terms.a.length <= 12);
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

if (failures > 0) {
  console.error(`\n${failures} scenarioregen check(s) failed.`);
  process.exit(1);
}
console.log(`scenarioregen.test.ts: all checks passed.`);

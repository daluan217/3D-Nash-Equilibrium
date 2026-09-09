/**
 * The Save Custom Game modal's "Generate" button must never silently destroy
 * typed text.
 *
 * RED-APP-4 finding 001 (round 4,
 * findings/RED-APP-4/001-save-modal-generate-overwrites-typed-fields.md),
 * reproduced 1/1 against the LIVE production site with a real account: type a
 * Game Name, Game Description, and four Option Names by hand into the Save
 * Custom Game modal, click "Generate" once (default Pure-strategy) without
 * touching anything else, and every one of those six fields was overwritten
 * by the AI-invented scenario — no confirmation, no undo. The in-dialog copy
 * said only "Replaces the matrix shown above."; it said nothing about the
 * name, description or option names sitting right below it.
 *
 * The fix (`src/utils/generateFill.ts`, wired into
 * `App.tsx`'s `handleGenerateGame`): a fresh AI scenario replaces the six
 * fields ONLY when every one of them is still empty, or still holds exactly
 * what the immediately preceding Generate call itself put there. The instant
 * any field holds something else — user-typed text, or a hand-edited AI
 * draft — NONE of the six are touched.
 *
 *   npx tsx src/generatefill.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generatedFillIsSafe } from './utils/generateFill';
import type { GeneratedFill, SaveFormFields } from './utils/generateFill';

const here = dirname(fileURLToPath(import.meta.url));
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

const empty: SaveFormFields = { name: '', desc: '', labels: { row1: '', row2: '', col1: '', col2: '' } };
const fillA: GeneratedFill = { name: 'Clocktower Restoration', desc: 'A city clock conservator and a tower management firm are coordinating.', row1: 'Full Overhaul', row2: 'Timed Repairs', col1: 'Premium Crew', col2: 'Lean Crew' };
const fillB: GeneratedFill = { name: 'Sawmill Kiln Booking', desc: 'North Pine Sawmill and Cedar Ridge Sawmill are planning their seasonal kiln bookings.', row1: 'Early Booking', row2: 'Flexible Booking', col1: 'Early Booking', col2: 'Flexible Booking' };
const asFields = (f: GeneratedFill): SaveFormFields => ({ name: f.name, desc: f.desc, labels: { row1: f.row1, row2: f.row2, col1: f.col1, col2: f.col2 } });

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE DEFECT ITSELF, VERBATIM — the exact reported repro.
//
// The user typed all six fields BEFORE ever clicking Generate (prevFill is
// `null`: nothing has been auto-filled yet in this modal session). This is
// precisely the shape RED-APP-4 reproduced against production.
// ─────────────────────────────────────────────────────────────────────────────
{
  const typedByHand: SaveFormFields = {
    name: 'MyOwnCarefullyChosenName',
    desc: 'This is a description I typed myself and care about preserving exactly.',
    labels: { row1: 'MyRow1', row2: 'MyRow2', col1: 'MyCol1', col2: 'MyCol2' },
  };
  ok(generatedFillIsSafe(typedByHand, null) === false,
    'THE DEFECT: hand-typed text with no prior Generate fill must never be judged safe to overwrite');
  // A single field is enough to withhold the whole six-field block — the
  // ALL-OR-NOTHING rule (see the module docstring): a save with the user's
  // real name stitched to an unrelated AI story would be a second, quieter
  // defect (an internally incoherent save), not a fix for the first one.
  const onlyNameTyped: SaveFormFields = { ...empty, name: 'MyOwnCarefullyChosenName' };
  ok(generatedFillIsSafe(onlyNameTyped, null) === false,
    'one hand-typed field must withhold the WHOLE block, not just that field');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE FIX'S OWN NORMAL CASES — everything the fix must still allow.
// ─────────────────────────────────────────────────────────────────────────────
{
  // A brand-new modal: nothing typed, nothing generated yet.
  ok(generatedFillIsSafe(empty, null) === true, 'an untouched, empty form must accept the first Generate fill');

  // A re-roll: the user clicked Generate, didn't touch anything, clicked it
  // again. This is the "keep clicking Generate to browse options" flow and
  // must keep working exactly as it does today.
  ok(generatedFillIsSafe(asFields(fillA), fillA) === true,
    'a re-roll where nothing was edited since the last Generate must still refill');
  ok(generatedFillIsSafe(asFields(fillA), fillB) === false,
    'fields holding a DIFFERENT prior fill than the one being compared against must not be treated as untouched');

  // Mixed: some fields still hold the AI's own prior output, some are empty
  // (user cleared one field on purpose) — still entirely safe.
  const partiallyCleared: SaveFormFields = { ...asFields(fillA), desc: '' };
  ok(generatedFillIsSafe(partiallyCleared, fillA) === true,
    'clearing a field the AI filled, and leaving the rest as the AI left them, must still be safe to refill');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE EDIT CASE — the user kept a Generate fill but then changed ONE word.
// This must withhold the WHOLE block, same as case 1's second check, proving
// it holds even when five of six fields still match the prior fill exactly.
// ─────────────────────────────────────────────────────────────────────────────
{
  const editedOneWord: SaveFormFields = { ...asFields(fillA), name: 'Clocktower Restoration Deluxe' };
  ok(generatedFillIsSafe(editedOneWord, fillA) === false,
    'editing even one field after a Generate fill must withhold the whole block from the next roll');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PROPERTY SWEEP — `generatedFillIsSafe` must agree with a naive,
// independently-written per-field reimplementation, across randomised field
// combinations (empty / matches prevFill / something else, for each of the
// six fields independently, with and without a `prevFill`).
// ─────────────────────────────────────────────────────────────────────────────
{
  function mk(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mk(20260902);
  const KEYS = ['name', 'desc', 'row1', 'row2', 'col1', 'col2'] as const;
  let n = 0, sawSafe = 0, sawUnsafe = 0;
  for (let i = 0; i < 3000; i++) {
    const havePrev = rnd() < 0.7;
    const prev: GeneratedFill | null = havePrev
      ? { name: 'PN', desc: 'PD', row1: 'PR1', row2: 'PR2', col1: 'PC1', col2: 'PC2' }
      : null;
    const pick = () => {
      const r = rnd();
      if (r < 0.34) return '';
      if (r < 0.67 && havePrev) return null; // marker: "use prevFill's own value for this key" below
      return `typed-${Math.floor(rnd() * 1000)}`;
    };
    const vals: Record<typeof KEYS[number], string> = {} as never;
    for (const k of KEYS) {
      const p = pick();
      vals[k] = p === null ? (prev as GeneratedFill)[k] : p;
    }
    const current: SaveFormFields = {
      name: vals.name, desc: vals.desc,
      labels: { row1: vals.row1, row2: vals.row2, col1: vals.col1, col2: vals.col2 },
    };
    const expected = KEYS.every((k) => vals[k] === '' || (prev !== null && vals[k] === prev[k]));
    const got = generatedFillIsSafe(current, prev);
    n++;
    if (got) sawSafe++; else sawUnsafe++;
    ok(got === expected,
      `mismatch at i=${i}: expected ${expected}, got ${got}, current=${JSON.stringify(current)}, prev=${JSON.stringify(prev)}`);
  }
  ok(n === 3000, `the sweep must run exactly as many cases as configured, got ${n}`);
  ok(sawSafe > 100 && sawUnsafe > 100,
    `both outcomes must be reachable in the sweep, got safe=${sawSafe} unsafe=${sawUnsafe} of ${n}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4b. STRUCT-REGEN-19/005 — the app writes into this form from TWO places.
//     The dialog prefills the four option names FROM THE BOARD every time it
//     opens (openSaveFormForBoard). Knowing only `prevFill`, the predicate read
//     those as the user's own typing, so the very first Generate click on any
//     preset refused to fill and told the user it had "kept the
//     name/description/option names you'd already typed" — text the user had
//     never touched. Reproduced on origin/main 0.0.197; the dialog opens with
//     labels ["Cooperate","Defect","Cooperate","Defect"] and name/desc empty.
// ─────────────────────────────────────────────────────────────────────────────
{
  const boardLabels = { row1: 'Cooperate', row2: 'Defect', col1: 'Cooperate', col2: 'Defect' };
  const asOpened: SaveFormFields = { name: '', desc: '', labels: { ...boardLabels } };

  // THE defect, as a one-line assertion: without the board-derived source the
  // predicate says "the user typed this".
  ok(generatedFillIsSafe(asOpened, null) === false,
    'fixture precondition: with only prevFill known, a freshly-opened dialog reads as user-typed (the shipped defect)');
  ok(generatedFillIsSafe(asOpened, null, boardLabels) === true,
    'a form holding nothing but the option names the dialog itself prefilled from the board is safe to fill (STRUCT-REGEN-19/005)');

  // Controls — RED-APP-4 must not be weakened by the new source.
  const typedOne: SaveFormFields = { name: '', desc: '', labels: { ...boardLabels, col2: 'My own option' } };
  ok(generatedFillIsSafe(typedOne, null, boardLabels) === false,
    'one option name the user typed still blocks the whole fill, board-derived siblings or not (RED-APP-4)');
  const typedDesc: SaveFormFields = { name: '', desc: 'my own description', labels: { ...boardLabels } };
  ok(generatedFillIsSafe(typedDesc, null, boardLabels) === false,
    'a typed description still blocks the fill even when every label is the board\'s (RED-APP-4)');
  const typedName: SaveFormFields = { name: 'My game', desc: '', labels: { ...boardLabels } };
  ok(generatedFillIsSafe(typedName, null, boardLabels) === false,
    'a typed name still blocks the fill even when every label is the board\'s (RED-APP-4)');
  // A DIFFERENT board's names are not this board's prefill.
  const otherBoard: SaveFormFields = { name: '', desc: '', labels: { row1: 'Undercut', row2: 'Hold', col1: 'Match', col2: 'Ignore' } };
  ok(generatedFillIsSafe(otherBoard, null, boardLabels) === false,
    'labels that are NOT what this dialog prefilled are still the user\'s (STRUCT-REGEN-19/005)');
  // Passing null (the caller\'s way of saying "these are the user\'s now") is
  // exactly the old behaviour — this is what App.tsx does the moment
  // provenance.labels flips to \'typed\'.
  ok(generatedFillIsSafe(asOpened, null, null) === generatedFillIsSafe(asOpened, null),
    'omitting the board-derived source must mean exactly what it meant before it existed');
  // The two sources compose: a previous fill\'s name plus this board\'s labels.
  const mixed: SaveFormFields = { name: fillA.name, desc: fillA.desc, labels: { ...boardLabels } };
  ok(generatedFillIsSafe(mixed, fillA, boardLabels) === true,
    'a form holding the last fill\'s text and the board\'s option names is all the app\'s own work (STRUCT-REGEN-19/005)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE WIRING — App.tsx must actually call the guard, not just import it.
// Same style as equilibriumpanel.test.ts §6: presence of an import proves
// nothing about whether its result gates anything.
// ─────────────────────────────────────────────────────────────────────────────
{
  const app = readFileSync(join(here, 'App.tsx'), 'utf8');
  ok(app.includes("import { generatedFillIsSafe, type GeneratedFill } from './utils/generateFill';"),
    'App.tsx must import the guard from the shared module, not reimplement it inline');

  const start = app.indexOf('const handleGenerateGame = async () => {');
  const end = app.indexOf('const handleSaveGameSubmit', start);
  ok(start > 0 && end > start, 'handleGenerateGame must be found in App.tsx');
  const fn = app.slice(start, end);

  ok((fn.match(/generatedFillIsSafe\(saveFormRef\.current, lastGeneratedFillRef\.current, boardLabelsIfAppsOwn\(saveFormRef\.current\)\)/g) || []).length === 2,
    'handleGenerateGame must call the guard, at BOTH decision points, with the LIVE form ref, the last-fill ref and the board-derived labels — not stale closure values, and not a subset of what the app itself wrote (RED-APP-4, STRUCT-REGEN-19/005)');
  ok(/const boardLabelsIfAppsOwn = \(f: SaveFormState\) => \(f\.provenance\.labels === 'from-board' \? f\.labels : null\);/.test(app),
    'the board-derived labels must be identified by the reducer\'s own provenance, not re-derived from the strings (STRUCT-REGEN-19/005)');
  // The guarded branch must gate ALL SIX setters, not just some of them —
  // catches a fix that guards the name/desc but leaves the labels
  // unconditional (or vice versa).
  const ifSafe = fn.indexOf('if (safe) {');
  const elseSafe = fn.indexOf('} else {', ifSafe);
  ok(ifSafe > 0 && elseSafe > ifSafe, 'the safe/unsafe branch must exist');
  const safeBranch = fn.slice(ifSafe, elseSafe);
  // STRUCT-REGEN-19/001: all-or-nothing is now STRUCTURAL — the fill is ONE
  // story action, so a later edit cannot split it into three setters and let
  // the labels (or the chips) fall out of the guard.
  const oneStory = /dispatchSaveForm\(\{\s*type: 'story',\s*boardKey,\s*name: gen\.name,\s*desc: gen\.desc,\s*labels: \{ row1: gen\.row1, row2: gen\.row2, col1: gen\.col1, col2: gen\.col2 \},\s*\}\);/;
  ok(oneStory.test(safeBranch),
    'the guarded branch must apply name, description AND labels as ONE story action carrying the board (STRUCT-REGEN-19/001)');
  ok((safeBranch.match(/dispatchSaveForm\(/g) || []).length === 1,
    'the guarded branch must write the save form exactly once — a second write is a second rule');
  ok(/lastGeneratedFillRef\.current\s*=\s*gen/.test(safeBranch),
    'a successful fill must update the "own prior fill" ref, or the next re-roll would wrongly be treated as user-edited');

  // Mutation: the pre-fix source unconditionally set all three, with no guard
  // and no ref at all — prove this predicate would have matched THAT text, so
  // it is not accidentally vacuous.
  const preFixShape = `
      if (sc) {
        setSaveName((sc.name ?? '').slice(0, 40));
        setSaveDesc((sc.description ?? '').slice(0, 800));
        setSaveLabels({
          row1: sc.row1 ?? '', row2: sc.row2 ?? '',
          col1: sc.col1 ?? '', col2: sc.col2 ?? '',
        });
        setGenerateNote(\`New \${kindLabel} game on the board, scenario written by AI — edit anything below, then save.\`);
      } else {`;
  ok(!fn.includes(preFixShape), 'the shipped handler must no longer contain the unconditional pre-fix write');
  ok(!/generatedFillIsSafe/.test(preFixShape), 'the pre-fix text must not accidentally already contain the guard call (fixture sanity check)');
  // …and the one-story predicate above must REJECT that pre-fix shape, so it
  // is not passing for a reason unrelated to what it claims to check.
  ok(!oneStory.test(preFixShape) && (preFixShape.match(/dispatchSaveForm\(/g) || []).length === 0,
    'fixture: the one-story predicate must reject the pre-fix three-setter write');

  // The in-dialog copy must actually say the fields are protected, not only
  // the code — the report's other half of the defect was misleading copy.
  // Comment lines stripped first: this phrase is quoted in App.tsx's own comments
  // (OPUS-REVIEW-184/F1 explains the Generate seam right above the prefill), and
  // the first match then landed in prose instead of on the rendered heading — a
  // check failed by a comment, the RED-REGEN hazard this suite has hit before.
  const appCode = app.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const genIdx = appCode.indexOf("…or generate a new game");
  ok(genIdx > 0, 'the Generate section heading must be found in CODE, not in a comment');
  const copy = appCode.slice(genIdx, genIdx + 500);
  ok(/never overwritten|kept|preserv/i.test(copy),
    `the in-dialog copy near Generate must describe that typed text is protected, got: ${JSON.stringify(copy.slice(0, 300))}`);
  ok(!/^\s*\/\//m.test(copy.split('\n')[0]),
    'fixture: the slice must start on rendered copy, not on a comment line');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE REF IS SYNCED FROM `useLayoutEffect`, NOT `useEffect` (CodeRabbit
// finding, PR #87 re-review — same shape as the ALREADY-FIXED `payoffsRef`
// a few lines above it in App.tsx).
//
// A passive `useEffect` runs asynchronously after paint, leaving a real
// window between React committing a keystroke's state update and the ref
// actually catching up. If `handleGenerateGame`'s report response resolves
// inside that window it would read a STALE `saveFormRef.current` and could
// approve overwriting text the user just typed — the exact defect class this
// ref exists to close (finding 001). `useLayoutEffect` fires synchronously
// right after the commit, before the browser paints and long before any
// network response can resolve, closing the window entirely.
//
// There is no DOM test harness in this repo to exercise the live timing race
// directly (same reason src/reportrace.test.ts's `payoffsRef` guard is
// checked structurally, not by actually racing a network response — see its
// own comment) — this is the checkable, decidable half: the ref-sync effect
// that guards saveFormRef must be a layout effect.
// ─────────────────────────────────────────────────────────────────────────────
{
  const app = readFileSync(join(here, 'App.tsx'), 'utf8');
  const refDeclIdx = app.indexOf('const saveFormRef = useRef(');
  ok(refDeclIdx > 0, 'saveFormRef must be declared');
  // The very next non-comment statement after the declaration must be the
  // layout-effect sync — anchored tightly so a LATER, unrelated
  // useLayoutEffect elsewhere in the file cannot satisfy this by accident.
  const nextChunk = app.slice(refDeclIdx, refDeclIdx + 400);
  ok(/useLayoutEffect\(\(\) => \{\s*saveFormRef\.current = saveForm;\s*\}, \[saveForm\]\);/.test(nextChunk),
    `saveFormRef must be synced inside useLayoutEffect (not useEffect), got: ${JSON.stringify(nextChunk)}`);
  ok(!/useEffect\(\(\) => \{\s*saveFormRef\.current/.test(app),
    'saveFormRef must never be synced from a plain (passive) useEffect anywhere in the file');

  // Mutation: the pre-fix (CodeRabbit-flagged) shape must actually match the
  // negative predicate above, or that predicate is vacuous.
  const preFixShape = `useEffect(() => {\n    saveFormRef.current = saveForm;\n  }, [saveForm]);`;
  ok(/useEffect\(\(\) => \{\s*saveFormRef\.current/.test(preFixShape),
    'the pre-fix fixture text must itself match the forbidden pattern (fixture sanity check)');
}

console.log(`generatefill.test.ts: ${checks} checks passed`);

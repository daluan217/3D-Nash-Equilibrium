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

  ok(fn.includes('generatedFillIsSafe(saveFieldsRef.current, lastGeneratedFillRef.current)'),
    'handleGenerateGame must call the guard with the LIVE form ref and the last-fill ref, not stale closure values');
  // The guarded branch must gate ALL SIX setters, not just some of them —
  // catches a fix that guards the name/desc but leaves the labels
  // unconditional (or vice versa).
  const ifSafe = fn.indexOf('if (safe) {');
  const elseSafe = fn.indexOf('} else {', ifSafe);
  ok(ifSafe > 0 && elseSafe > ifSafe, 'the safe/unsafe branch must exist');
  const safeBranch = fn.slice(ifSafe, elseSafe);
  ok(/setSaveName\(gen\.name\)/.test(safeBranch) && /setSaveDesc\(gen\.desc\)/.test(safeBranch)
    && /setSaveLabels\(\{[^}]*row1:\s*gen\.row1/.test(safeBranch),
    'the guarded branch must apply name, description AND labels together — all six fields, all-or-nothing');
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

  // The in-dialog copy must actually say the fields are protected, not only
  // the code — the report's other half of the defect was misleading copy.
  const genIdx = app.indexOf("…or generate a new game");
  ok(genIdx > 0, 'the Generate section heading must be found');
  const copy = app.slice(genIdx, genIdx + 500);
  ok(/never overwritten|kept|preserv/i.test(copy),
    `the in-dialog copy near Generate must describe that typed text is protected, got: ${JSON.stringify(copy.slice(0, 300))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE REF IS SYNCED FROM `useLayoutEffect`, NOT `useEffect` (CodeRabbit
// finding, PR #87 re-review — same shape as the ALREADY-FIXED `payoffsRef`
// a few lines above it in App.tsx).
//
// A passive `useEffect` runs asynchronously after paint, leaving a real
// window between React committing a keystroke's state update and the ref
// actually catching up. If `handleGenerateGame`'s report response resolves
// inside that window it would read a STALE `saveFieldsRef.current` and could
// approve overwriting text the user just typed — the exact defect class this
// ref exists to close (finding 001). `useLayoutEffect` fires synchronously
// right after the commit, before the browser paints and long before any
// network response can resolve, closing the window entirely.
//
// There is no DOM test harness in this repo to exercise the live timing race
// directly (same reason src/reportrace.test.ts's `payoffsRef` guard is
// checked structurally, not by actually racing a network response — see its
// own comment) — this is the checkable, decidable half: the ref-sync effect
// that guards saveFieldsRef must be a layout effect.
// ─────────────────────────────────────────────────────────────────────────────
{
  const app = readFileSync(join(here, 'App.tsx'), 'utf8');
  const refDeclIdx = app.indexOf('const saveFieldsRef = useRef(');
  ok(refDeclIdx > 0, 'saveFieldsRef must be declared');
  // The very next non-comment statement after the declaration must be the
  // layout-effect sync — anchored tightly so a LATER, unrelated
  // useLayoutEffect elsewhere in the file cannot satisfy this by accident.
  const nextChunk = app.slice(refDeclIdx, refDeclIdx + 400);
  ok(/useLayoutEffect\(\(\) => \{\s*saveFieldsRef\.current = \{ name: saveName, desc: saveDesc, labels: saveLabels \};\s*\}, \[saveName, saveDesc, saveLabels\]\);/.test(nextChunk),
    `saveFieldsRef must be synced inside useLayoutEffect (not useEffect), got: ${JSON.stringify(nextChunk)}`);
  ok(!/useEffect\(\(\) => \{\s*saveFieldsRef\.current/.test(app),
    'saveFieldsRef must never be synced from a plain (passive) useEffect anywhere in the file');

  // Mutation: the pre-fix (CodeRabbit-flagged) shape must actually match the
  // negative predicate above, or that predicate is vacuous.
  const preFixShape = `useEffect(() => {\n    saveFieldsRef.current = { name: saveName, desc: saveDesc, labels: saveLabels };\n  }, [saveName, saveDesc, saveLabels]);`;
  ok(/useEffect\(\(\) => \{\s*saveFieldsRef\.current/.test(preFixShape),
    'the pre-fix fixture text must itself match the forbidden pattern (fixture sanity check)');
}

console.log(`generatefill.test.ts: ${checks} checks passed`);

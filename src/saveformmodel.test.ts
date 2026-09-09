/**
 * The Save dialog's form model — behavioural contract, property sweep and
 * mutation tests for `src/utils/saveFormModel.ts` (STRUCT-REGEN-19/001).
 *
 * WHY THIS FILE EXISTS. The save form is five pieces (name, description, four
 * option labels, the user's colour chips) plus the board they were written
 * for. Six places in App.tsx used to write them, each a DIFFERENT subset, and
 * the invariant belonged to nobody. It broke: the report card's "Save this
 * scenario with the game" wrote name+description+labels, left an abandoned
 * draft's colour chips untouched, and stamped the board key itself — which
 * also disarmed the one reconcile that would ever have cleared them. The saved
 * record then named highlight phrases that appear nowhere in its own
 * description (confirmed through the POST body and a `GET /api/games`
 * read-back on a live server; findings/STRUCT-REGEN-19/001).
 *
 * The fix is structural: ONE reducer with ONE rule. So the interesting tests
 * here are not "does case X work" but the two properties that make the class
 * impossible —
 *
 *   P3  a story's result does not depend on what the form held before it
 *       (except the name it deliberately leaves alone), so nothing of an
 *       older story can survive one; and
 *   P1  re-opening for the same board is idempotent, so a draft cannot be
 *       eroded a piece at a time by repeated opens.
 *
 * `src/payoffhonesty.test.ts` §5e guards the OTHER half — that App.tsx routes
 * every entry point through this reducer and keeps no second copy of the state.
 *
 *   npx tsx src/saveformmodel.test.ts
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  saveFormReducer,
  EMPTY_SAVE_FORM,
  EMPTY_LABELS,
  type SaveFormState,
  type SaveFormAction,
  type SaveFormLabels,
} from './utils/saveFormModel';
import { keptFieldsOf } from './utils/generateNote';

let failures = 0;
let cases = 0;
function check(name: string, cond: boolean, detail = ''): void {
  cases++;
  if (!cond) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const B1 = '[3,0,5,1,3,5,0,1]';
const B2 = '[2,0,5,1,3,5,0,1]';
const PRESET: SaveFormLabels = { row1: 'Undercut', row2: 'Hold price', col1: 'Match', col2: 'Ignore' };
const STORY_LABELS: SaveFormLabels = { row1: 'Raid', row2: 'Rest', col1: 'Guard', col2: 'Sleep' };

/** A form as the report-card defect left it: a story for B1 with chips from an
 *  ABANDONED earlier draft still attached. Verbatim from finding 001's live
 *  POST body (draw of 2026-09-07, desktop mode, port 4840). */
const draftWithStaleChips: SaveFormState = {
  name: 'Harbour Standoff',
  desc: 'The pilot boat and the tug each decide whether to enter the channel first.',
  labels: STORY_LABELS,
  terms: { a: ['pilot boat'], b: ['tug'] },
  boardKey: B1,
  nameBaseline: 'Harbour Standoff',
  provenance: { name: 'generated', desc: 'generated', labels: 'generated', terms: 'typed' },
};

const run = (actions: SaveFormAction[], from: SaveFormState = EMPTY_SAVE_FORM) =>
  actions.reduce(saveFormReducer, from);

// ════════════════════════════════════════════════════════════════════════════
// 1. The named defects, one assertion each.
// ════════════════════════════════════════════════════════════════════════════
function testNamedDefects(): void {
  // STRUCT-REGEN-19/001 — THE finding. A new story arrives for the same board;
  // the chips of the story it replaced must not survive it.
  {
    const after = saveFormReducer(draftWithStaleChips, {
      type: 'story',
      boardKey: B1,
      name: 'Two Trains',
      desc: 'Two trains approach the single-track bridge from opposite ends.',
      labels: { row1: 'Enter', row2: 'Wait', col1: 'Enter', col2: 'Wait' },
    });
    check('STRUCT-REGEN-19/001: a new story clears the previous story\'s colour chips',
      after.terms.a.length === 0 && after.terms.b.length === 0,
      `kept ${JSON.stringify(after.terms)}`);
    check('STRUCT-REGEN-19/001: a new story replaces the description it came with',
      after.desc.startsWith('Two trains'));
    check('STRUCT-REGEN-19/001: a new story replaces the option labels',
      after.labels.row1 === 'Enter' && after.labels.col2 === 'Wait');
    check('STRUCT-REGEN-19/001: a new story records the board it was written for',
      after.boardKey === B1);
    check('STRUCT-REGEN-19/001: a story that sets the name moves the name baseline with it',
      after.name === 'Two Trains' && after.nameBaseline === 'Two Trains');
  }
  // A story that brings chips of its own keeps THOSE (Regenerate → Keep).
  {
    const after = saveFormReducer(draftWithStaleChips, {
      type: 'story', boardKey: B1, name: 'Two Trains', desc: 'Two trains…',
      labels: STORY_LABELS, terms: { a: ['driver'], b: ['signaller'] },
    });
    check('a story that carries chips keeps its OWN chips',
      after.terms.a.join() === 'driver' && after.terms.b.join() === 'signaller');
    check('chips that arrive with a story are generated, not typed',
      after.provenance.terms === 'generated');
  }
  // A story that leaves the name alone (Keep with a user-typed name) leaves
  // the baseline alone too — director's decision, 2026-09-03.
  {
    const typed = saveFormReducer(draftWithStaleChips, { type: 'typed', field: 'name', value: 'My own name' });
    const after = saveFormReducer(typed, { type: 'story', boardKey: B1, desc: 'new text', labels: STORY_LABELS });
    check('a story with no name of its own leaves the name and its baseline untouched',
      after.name === 'My own name' && after.nameBaseline === draftWithStaleChips.nameBaseline);
  }

  // RED-REGEN-13/001 — a draft written for another board is discarded whole.
  {
    const after = saveFormReducer(draftWithStaleChips, { type: 'openForBoard', boardKey: B2, presetLabels: PRESET });
    check('RED-REGEN-13/001: opening for a DIFFERENT board discards the story',
      after.name === '' && after.desc === '');
    check('RED-REGEN-13/001: opening for a different board discards the chips too',
      after.terms.a.length === 0 && after.terms.b.length === 0);
    check('RED-REGEN-13/001: opening for a different board clears the name baseline',
      after.nameBaseline === '');
    check('RED-REGEN-13/001: opening for a different board takes that board\'s option names',
      after.labels.row1 === 'Undercut' && after.labels.col2 === 'Ignore');
    check('RED-REGEN-13/001: opening for a different board records THAT board',
      after.boardKey === B2);
  }
  // RED-REGEN-14/001 — a kept draft keeps the option names it was written with.
  {
    const after = saveFormReducer(draftWithStaleChips, { type: 'openForBoard', boardKey: B1, presetLabels: PRESET });
    check('RED-REGEN-14/001: a draft for THIS board keeps its own option names',
      after.labels.row1 === 'Raid' && after.labels.col1 === 'Guard',
      JSON.stringify(after.labels));
    check('RED-REGEN-14/001: a draft for this board keeps its text and chips',
      after.desc === draftWithStaleChips.desc && after.terms.a.join() === 'pilot boat');
  }
  // …but a kept draft with NO option names of its own still takes the board's
  // (#178's fix — nothing of the story is overwritten).
  {
    const blank = { ...draftWithStaleChips, labels: EMPTY_LABELS };
    const after = saveFormReducer(blank, { type: 'openForBoard', boardKey: B1, presetLabels: PRESET });
    check('#178: a kept draft with blank option names takes the board\'s',
      after.labels.row1 === 'Undercut' && after.desc === blank.desc);
    // CodeRabbit on #178: whitespace-only counts as blank.
    const ws = { ...draftWithStaleChips, labels: { row1: '  ', row2: '\t', col1: ' ', col2: '' } };
    const afterWs = saveFormReducer(ws, { type: 'openForBoard', boardKey: B1, presetLabels: PRESET });
    check('CodeRabbit on #178: whitespace-only option names count as blank',
      afterWs.labels.row1 === 'Undercut' && afterWs.labels.col1 === 'Match');
  }
  // A fresh form takes the board's names, and says where they came from.
  {
    const after = saveFormReducer(EMPTY_SAVE_FORM, { type: 'openForBoard', boardKey: B1, presetLabels: PRESET });
    check('a fresh form takes the board\'s option names', after.labels.col1 === 'Match');
    check('board-derived option names are marked from-board, not typed',
      after.provenance.labels === 'from-board');
    const unnamed = saveFormReducer(EMPTY_SAVE_FORM, { type: 'openForBoard', boardKey: B1, presetLabels: EMPTY_LABELS });
    check('an unnamed board leaves the labels empty, not "from-board"',
      unnamed.provenance.labels === 'empty');
  }

  // OPUS-REVIEW-171/N1 — a board change under an open form.
  {
    const cleared = saveFormReducer(draftWithStaleChips, { type: 'boardChanged', boardKey: B2, keepUserText: false });
    check('OPUS-REVIEW-171/N1: generated text goes when the board changes under it',
      cleared.name === '' && cleared.desc === '' && cleared.terms.a.length === 0);
    check('CodeRabbit on #171: the option names go with it',
      cleared.labels.row1 === '' && cleared.labels.col2 === '');
    check('OPUS-REVIEW-171/N1: the new board is recorded even so', cleared.boardKey === B2);
    const kept = saveFormReducer(draftWithStaleChips, { type: 'boardChanged', boardKey: B2, keepUserText: true });
    check('CodeRabbit on #171: the user\'s own text stays and belongs to the new board',
      kept.desc === draftWithStaleChips.desc && kept.boardKey === B2 && kept.labels.row1 === 'Raid');
    const same = saveFormReducer(draftWithStaleChips, { type: 'boardChanged', boardKey: B1, keepUserText: false });
    check('a "board change" to the SAME board changes nothing at all', same === draftWithStaleChips);
  }

  // OPUS-REVIEW-184/S3 — the 409 recovery's adoption is its own door.
  // Another device's chips are neither this user's typing nor this app's writing,
  // and `keptFieldsOf` now depends on that distinction being true.
  {
    const adopted = run([
      { type: 'openForBoard', boardKey: B1, presetLabels: PRESET },
      { type: 'typed', field: 'desc', value: 'my own words' },
      { type: 'adoptedTerms', a: ['the channel', 'lighthouse keeper'], b: [] },
    ]);
    check('adoptedTerms: the chips land on the form',
      adopted.terms.a.join('|') === 'the channel|lighthouse keeper' && adopted.terms.b.length === 0,
      JSON.stringify(adopted.terms));
    check('adoptedTerms: provenance says adopted — not typed, and not generated',
      adopted.provenance.terms === 'adopted', adopted.provenance.terms);
    check('adoptedTerms: the Generate note may not claim them as "you\'d already added"',
      keptFieldsOf(adopted).terms === false);
    check('adoptedTerms: it touches ONLY the terms',
      adopted.desc === 'my own words' && adopted.provenance.desc === 'typed'
      && JSON.stringify(adopted.labels) === JSON.stringify(PRESET) && adopted.provenance.labels === 'from-board',
      JSON.stringify({ desc: adopted.desc, prov: adopted.provenance }));
    // The discriminator: the same chips through the door the user types with.
    const typedIn = run([
      { type: 'openForBoard', boardKey: B1, presetLabels: PRESET },
      { type: 'typedTerms', a: ['the channel', 'lighthouse keeper'], b: [] },
    ]);
    check('adoptedTerms is distinguishable from typedTerms — same chips, different provenance',
      typedIn.provenance.terms === 'typed' && keptFieldsOf(typedIn).terms === true
      && typedIn.terms.a.join('|') === adopted.terms.a.join('|'));
  }

  // RED-APP-4 — the user's own typing outranks a generated fill.
  {
    const typed = run([
      { type: 'openForBoard', boardKey: B1, presetLabels: PRESET },
      { type: 'typed', field: 'desc', value: 'my own words' },
      { type: 'typedLabel', field: 'row1', value: 'Mine' },
      { type: 'typedTerms', a: ['owl'], b: [] },
    ]);
    check('RED-APP-4: typing marks the field as the user\'s',
      typed.provenance.desc === 'typed' && typed.provenance.labels === 'typed' && typed.provenance.terms === 'typed');
    // The provenance IS the app's "may a generated fill overwrite this?" answer
    // (STRUCT-REGEN-19/005 wires `provenance.labels === 'from-board'` straight
    // into `generatedFillIsSafe`), so it is asserted here as such rather than
    // through a helper whose only caller was this test.
    const appsOwn = (s: SaveFormState) => (['name', 'desc', 'labels', 'terms'] as const)
      .every((f) => s.provenance[f] !== 'typed');
    check('RED-APP-4: a form the user has typed into is not the app\'s own work', !appsOwn(typed));
    const fresh = saveFormReducer(EMPTY_SAVE_FORM, { type: 'openForBoard', boardKey: B1, presetLabels: PRESET });
    check('a form holding only board-derived names IS the app\'s own work', appsOwn(fresh));
    check('board-derived labels are exactly what STRUCT-REGEN-19/005 hands generatedFillIsSafe',
      fresh.provenance.labels === 'from-board');
    check('one keystroke into a label field takes that away again',
      saveFormReducer(fresh, { type: 'typedLabel', field: 'col1', value: 'Mine' }).provenance.labels === 'typed');
  }

  // A successful save leaves nothing behind — no board, no chips, no baseline.
  {
    const after = saveFormReducer(draftWithStaleChips, { type: 'saved' });
    check('RED-REGEN-13/001: a successful save blanks the form and its board',
      JSON.stringify(after) === JSON.stringify(EMPTY_SAVE_FORM));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Properties over random action sequences.
// ════════════════════════════════════════════════════════════════════════════
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOARDS = [B1, B2, '[9,9,9,9,9,9,9,9]'];
function randomAction(r: () => number): SaveFormAction {
  const board = BOARDS[Math.floor(r() * BOARDS.length)];
  const lab = (): SaveFormLabels => ({
    row1: r() < 0.3 ? '' : `r1-${Math.floor(r() * 9)}`,
    row2: r() < 0.3 ? '' : `r2-${Math.floor(r() * 9)}`,
    col1: r() < 0.3 ? '' : `c1-${Math.floor(r() * 9)}`,
    col2: r() < 0.3 ? '' : `c2-${Math.floor(r() * 9)}`,
  });
  switch (Math.floor(r() * 7)) {
    case 0: return { type: 'typed', field: r() < 0.5 ? 'name' : 'desc', value: `t${Math.floor(r() * 99)}` };
    case 1: return { type: 'typedLabel', field: (['row1', 'row2', 'col1', 'col2'] as const)[Math.floor(r() * 4)], value: `L${Math.floor(r() * 9)}` };
    case 2: return { type: 'typedTerms', a: r() < 0.5 ? ['heron'] : [], b: r() < 0.5 ? ['otter'] : [] };
    case 3: return { type: 'openForBoard', boardKey: board, presetLabels: lab() };
    case 4: return r() < 0.5
      ? { type: 'story', boardKey: board, name: `n${Math.floor(r() * 99)}`, desc: `d${Math.floor(r() * 99)}`, labels: lab() }
      : { type: 'story', boardKey: board, desc: `d${Math.floor(r() * 99)}`, labels: lab(), terms: { a: ['fox'], b: ['crow'] } };
    case 5: return { type: 'boardChanged', boardKey: board, keepUserText: r() < 0.5 };
    default: return { type: 'saved' };
  }
}

function testProperties(): void {
  const r = mulberry32(0x5A17);
  let p1 = 0; let p2 = 0; let p3 = 0; let p4 = 0; let p6 = 0;
  for (let trial = 0; trial < 4000; trial++) {
    const n = 1 + Math.floor(r() * 8);
    const seq: SaveFormAction[] = [];
    for (let i = 0; i < n; i++) seq.push(randomAction(r));
    const s = run(seq);

    // P1 — re-opening for the same board is IDEMPOTENT. A draft cannot be
    // eroded one piece at a time by repeated opens (the shape of a defect
    // where a second open blanks labels a first one kept).
    const open: SaveFormAction = { type: 'openForBoard', boardKey: BOARDS[0], presetLabels: PRESET };
    const once = saveFormReducer(s, open);
    if (JSON.stringify(saveFormReducer(once, open)) === JSON.stringify(once)) p1++;

    // P2 — `saved` is absorbing: from ANY state, the form is exactly empty.
    if (JSON.stringify(saveFormReducer(s, { type: 'saved' })) === JSON.stringify(EMPTY_SAVE_FORM)) p2++;

    // P3 — THE property behind finding 001: a story that names itself leaves a
    // result that does not depend on what the form held before. Nothing of an
    // older story — its chips above all — can survive one.
    const story: SaveFormAction = {
      type: 'story', boardKey: BOARDS[1], name: 'N', desc: 'D', labels: STORY_LABELS,
    };
    const fromHere = saveFormReducer(s, story);
    const fromEmpty = saveFormReducer(EMPTY_SAVE_FORM, story);
    if (JSON.stringify(fromHere) === JSON.stringify(fromEmpty)) p3++;

    // P4 — a story that does NOT name itself differs from that only in the
    // name and its baseline: still no leak of the old description, labels or
    // chips through the anonymous path.
    const anon: SaveFormAction = { type: 'story', boardKey: BOARDS[1], desc: 'D', labels: STORY_LABELS };
    const a = saveFormReducer(s, anon);
    if (a.desc === 'D' && JSON.stringify(a.labels) === JSON.stringify(STORY_LABELS)
      && a.terms.a.length === 0 && a.terms.b.length === 0 && a.boardKey === BOARDS[1]
      && a.name === s.name && a.nameBaseline === s.nameBaseline) p4++;

    // P6 — provenance soundness, checked at EVERY step of the sequence: while a
    // field is marked 'typed' it must still hold exactly what the user last
    // typed into it. No action may keep the mark and change the value (that is
    // how a generated fill silently overwrites the user's own words —
    // RED-APP-4), and none may forge the mark it never earned.
    let typedDesc: string | null = null;
    let sound = true;
    let walk = EMPTY_SAVE_FORM;
    for (const act of seq) {
      if (act.type === 'typed' && act.field === 'desc') typedDesc = act.value;
      walk = saveFormReducer(walk, act);
      if (walk.provenance.desc === 'typed' && walk.desc !== typedDesc) sound = false;
    }
    if (sound) p6++;
  }
  check('P1: opening for the same board is idempotent (4000 sequences)', p1 === 4000, `${p1}/4000`);
  check('P2: `saved` empties the form from any state (4000 sequences)', p2 === 4000, `${p2}/4000`);
  check('P3: a named story\'s result is independent of the form it replaces (4000 sequences)', p3 === 4000, `${p3}/4000`);
  check('P4: an anonymous story replaces everything but the name (4000 sequences)', p4 === 4000, `${p4}/4000`);
  check('P6: a field marked "typed" holds what the user typed (4000 sequences)', p6 === 4000, `${p6}/4000`);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Mutation tests ON THE REAL FILE — each names the check that must fail.
//    The module is dependency-free, so a mutated copy runs standalone.
// ════════════════════════════════════════════════════════════════════════════
type Model = {
  saveFormReducer: typeof saveFormReducer;
  EMPTY_SAVE_FORM: SaveFormState;
};

/** The contract, re-run against an arbitrary implementation. Every assertion
 *  here is one of the named checks above, so a mutant is reported by name. */
function contract(m: Model): void {
  const story: SaveFormAction = {
    type: 'story', boardKey: B1, name: 'Two Trains', desc: 'Two trains…',
    labels: { row1: 'Enter', row2: 'Wait', col1: 'Enter', col2: 'Wait' },
  };
  const afterStory = m.saveFormReducer(draftWithStaleChips, story);
  assert.equal(afterStory.terms.a.length + afterStory.terms.b.length, 0,
    'a new story clears the previous story\'s colour chips');
  assert.equal(afterStory.labels.row1, 'Enter', 'a new story replaces the option labels');
  assert.equal(afterStory.nameBaseline, 'Two Trains', 'a story that sets the name moves the baseline');
  assert.deepEqual(m.saveFormReducer(EMPTY_SAVE_FORM, story), afterStory,
    'P3: a named story\'s result is independent of the form it replaces');

  const other = m.saveFormReducer(draftWithStaleChips, { type: 'openForBoard', boardKey: B2, presetLabels: PRESET });
  assert.equal(other.desc, '', 'opening for a DIFFERENT board discards the story');
  assert.equal(other.terms.a.length, 0, 'opening for a different board discards the chips');
  assert.equal(other.nameBaseline, '', 'opening for a different board clears the name baseline');
  assert.equal(other.labels.row1, 'Undercut', 'opening for a different board takes that board\'s option names');

  const same = m.saveFormReducer(draftWithStaleChips, { type: 'openForBoard', boardKey: B1, presetLabels: PRESET });
  assert.equal(same.labels.row1, 'Raid', 'a draft for THIS board keeps its own option names');
  assert.equal(same.desc, draftWithStaleChips.desc, 'a draft for this board keeps its text');
  const blankLabels = m.saveFormReducer({ ...draftWithStaleChips, labels: { row1: ' ', row2: '', col1: '', col2: '' } },
    { type: 'openForBoard', boardKey: B1, presetLabels: PRESET });
  assert.equal(blankLabels.labels.row1, 'Undercut', 'a kept draft with blank option names takes the board\'s');

  const cleared = m.saveFormReducer(draftWithStaleChips, { type: 'boardChanged', boardKey: B2, keepUserText: false });
  assert.equal(cleared.labels.row1, '', 'a board change under generated text takes the option names too');
  assert.equal(cleared.boardKey, B2, 'a board change records the new board even so');
  const keptText = m.saveFormReducer(draftWithStaleChips, { type: 'boardChanged', boardKey: B2, keepUserText: true });
  assert.equal(keptText.desc, draftWithStaleChips.desc, 'a board change keeps the user\'s own text');

  assert.deepEqual(m.saveFormReducer(draftWithStaleChips, { type: 'saved' }), m.EMPTY_SAVE_FORM,
    'a successful save blanks the form and its board');

  const typedName = m.saveFormReducer(EMPTY_SAVE_FORM, { type: 'typed', field: 'name', value: 'x' });
  assert.equal(typedName.provenance.name, 'typed', 'typing marks the field as the user\'s');
}

async function testMutants(): Promise<void> {
  const path = 'src/utils/saveFormModel.ts';
  const src = readFileSync(path, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'saveform-mut-'));
  const mutants: [string, string, string, string][] = [
    ['M1 a story inherits the previous chips (the shipped defect)',
      "terms: { a: [...(action.terms?.a ?? [])], b: [...(action.terms?.b ?? [])] },",
      "terms: action.terms ? { a: [...action.terms.a], b: [...action.terms.b] } : state.terms,",
      'a new story clears the previous story\'s colour chips'],
    ['M2 a story keeps the old option labels',
      'labels: { ...action.labels },\n        terms:', 'labels: state.labels,\n        terms:',
      'a new story replaces the option labels'],
    ['M3 a story leaves the name baseline behind',
      'nameBaseline: action.name ?? state.nameBaseline,', 'nameBaseline: state.nameBaseline,',
      'a story that sets the name moves the baseline'],
    ['M4 openForBoard keeps a draft written for ANOTHER board',
      'const kept = state.boardKey === null || state.boardKey === action.boardKey;', 'const kept = true;',
      'opening for a DIFFERENT board discards the story'],
    ['M5 openForBoard discards every draft, this board\'s included',
      'if (kept && hasDraft) {', 'if (false) {',
      'a draft for THIS board keeps its own option names'],
    ['M6 openForBoard re-prefills over a kept draft\'s own labels',
      'return labelsBlank(state.labels)', 'return true',
      'a draft for THIS board keeps its own option names'],
    ['M7 blank means empty-string only (whitespace labels never re-prefilled)',
      "l.col2].every((s) => !s.trim())", "l.col2].every((s) => s === '')",
      'a kept draft with blank option names takes the board\'s'],
    ['M8 a board change spares the option names',
      "? { ...state, boardKey: action.boardKey }\n        : { ...EMPTY_SAVE_FORM, boardKey: action.boardKey };",
      "? { ...state, boardKey: action.boardKey }\n        : { ...EMPTY_SAVE_FORM, labels: state.labels, boardKey: action.boardKey };",
      'a board change under generated text takes the option names too'],
    ['M9 a board change throws away the user\'s own text',
      'return action.keepUserText', 'return false',
      'a board change keeps the user\'s own text'],
    ['M10 a saved form remembers its board',
      "    case 'saved':\n      return EMPTY_SAVE_FORM;", "    case 'saved':\n      return { ...EMPTY_SAVE_FORM, boardKey: state.boardKey };",
      'a successful save blanks the form and its board'],
    ['M11 typing is recorded as generated text',
      "next.provenance = { ...state.provenance, [action.field]: 'typed' };",
      "next.provenance = { ...state.provenance, [action.field]: 'generated' };",
      'typing marks the field as the user\'s'],
  ];
  try {
    for (const [label, from, to, expect] of mutants) {
      if (!src.includes(from)) { check(`${label}: anchor present`, false, `anchor missing: ${from.slice(0, 50)}`); continue; }
      const file = join(dir, `m${mutants.indexOf(mutants.find((x) => x[0] === label)!)}.ts`);
      writeFileSync(file, src.replace(from, to));
      const mod = (await import(pathToFileURL(file).href)) as Model;
      let msg = '';
      try { contract(mod); } catch (e) { msg = (e as Error).message; }
      check(`${label} -> killed by "${expect}"`, msg.includes(expect),
        msg ? `reported instead: ${msg.split('\n')[0]}` : 'NOT KILLED (contract passed)');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The unmutated file must pass the same contract.
  contract({ saveFormReducer, EMPTY_SAVE_FORM });
  check('the real saveFormModel.ts satisfies the contract', true);
}

async function main(): Promise<void> {
  console.log('Save-form model — STRUCT-REGEN-19/001');
  testNamedDefects();
  testProperties();
  await testMutants();
  if (failures > 0) {
    console.error(`\n✗ ${failures} failure(s) of ${cases} checks`);
    process.exit(1);
  }
  console.log(`✓ ${cases} checks: one reducer, one reconcile rule; 5 properties over 4000 random sequences; 11 mutants killed by name`);
}

void main();

/**
 * The Generate note — one outcome, one rendering, number agreement.
 * STRUCT-REGEN-19/006; see src/utils/generateNote.ts for the defect it closes.
 *
 *   npx tsx src/generatenote.test.ts
 */
import { readFileSync } from 'node:fs';
import { generateNote, highlightsRemovedClause, type GenerateOutcome, type EquilibriumKind } from './utils/generateNote';

let failures = 0;
let cases = 0;
function check(name: string, cond: boolean, detail = ''): void {
  cases++;
  if (!cond) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const OUTCOMES: GenerateOutcome[] = ['filled', 'kept', 'unavailable'];
const KINDS: EquilibriumKind[] = ['pure', 'mixed'];

// ── 1. THE defect: a click that removes highlights must say so ───────────────
{
  const silent = generateNote('pure', 'filled', 0);
  const spoken = generateNote('pure', 'filled', 1);
  check('STRUCT-REGEN-19/006: a Generate that removed a highlight does not print the note for one that removed none',
    silent !== spoken, JSON.stringify(silent));
  check('STRUCT-REGEN-19/006: the note names what was removed',
    /colour highlight/.test(spoken), spoken);
  // "says nothing about REMOVAL" — the 'kept' sentence legitimately mentions
  // highlights as something it kept, which is the point of listing them there.
  check('a Generate that removed nothing says nothing about removal',
    !/went with the story/.test(silent), silent);

  // Every outcome, not just the one the defect was found in — a later edit that
  // adds a clause to one branch and forgets the others is the shape this file exists
  // to prevent.
  for (const o of OUTCOMES) {
    for (const k of KINDS) {
      check(`${k}/${o}: two removed highlights are reported`,
        /2 colour highlights/.test(generateNote(k, o, 2)), generateNote(k, o, 2));
      check(`${k}/${o}: none removed means no removal clause at all`,
        !/went with the story/.test(generateNote(k, o, 0)), generateNote(k, o, 0));
    }
  }
}

// ── 2. Number agreement (the round-16 rule): noun, verb and pronoun ──────────
{
  const one = highlightsRemovedClause(1);
  const many = highlightsRemovedClause(4);
  check('singular: noun is singular', / The colour highlight /.test(one), one);
  check('singular: verb is singular ("went" is invariant; the pronoun carries it)',
    /it described/.test(one) && !/they described/.test(one), one);
  check('plural: noun is plural and counted', / The 4 colour highlights /.test(many), many);
  check('plural: pronoun is plural', /they described/.test(many) && !/it described/.test(many), many);
  check('zero: no clause at all', highlightsRemovedClause(0) === '', JSON.stringify(highlightsRemovedClause(0)));
  check('a negative count cannot produce a clause (a caller that miscounts must not print "-1 highlights")',
    highlightsRemovedClause(-3) === '', JSON.stringify(highlightsRemovedClause(-3)));
  for (let n = 2; n <= 12; n++) {
    check(`n=${n}: counted, plural noun, plural pronoun`,
      highlightsRemovedClause(n).includes(` ${n} colour highlights `) && /they described/.test(highlightsRemovedClause(n)));
  }
}

// ── 3. The three outcomes are three different sentences ──────────────────────
{
  for (const k of KINDS) {
    const seen = new Set(OUTCOMES.map((o) => generateNote(k, o, 0)));
    check(`${k}: each outcome has its own sentence`, seen.size === OUTCOMES.length, JSON.stringify([...seen]));
    check(`${k}: the equilibrium kind is named`,
      OUTCOMES.every((o) => generateNote(k, o, 0).includes(k === 'mixed' ? 'mixed-strategy' : 'pure-strategy')));
  }
  // The 'kept' branch keeps EVERY field, chips included (verified live:
  // notes/STRUCT-REGEN-19/h5_run7_ctl_typed.log), so its sentence must say so —
  // the shipped one listed three fields and omitted the fourth.
  const kept = generateNote('pure', 'kept', 0);
  check('the "kept" note lists the colour highlights among what it kept',
    /colour highlights/.test(kept), kept);
  for (const field of ['name', 'description', 'option names']) {
    check(`the "kept" note still lists ${field}`, kept.includes(field), kept);
  }
}

// ── 4. The wiring: App.tsx must have no note of its own ──────────────────────
{
  const app = readFileSync('src/App.tsx', 'utf8');
  const calls = app.match(/setGenerateNote\(/g) || [];
  // The third argument is a COUNT EXPRESSION, not a fixed name: the 'filled'
  // branch adds the chips the story itself is about to clear (see below). The
  // shape check is "the renderer, with the kind and one of the three outcomes";
  // the count is pinned separately, by its own check.
  const rendered = app.match(/setGenerateNote\(renderGenerateNote\(generateKind, '(filled|kept|unavailable)',[\s\S]{0,200}?\)\)/g) || [];
  const blanks = app.match(/setGenerateNote\(''\)/g) || [];
  check('every Generate note comes from the one renderer (or is a blank reset)',
    rendered.length + blanks.length === calls.length,
    `${calls.length} setGenerateNote calls, ${rendered.length} rendered, ${blanks.length} blank`);
  check('all three outcomes are actually reachable from App.tsx',
    ['filled', 'kept', 'unavailable'].every((o) => rendered.some((r) => r.includes(`'${o}'`))));
  check('App.tsx must not build a Generate sentence itself',
    !/setGenerateNote\(`New \$\{/.test(app));
  // The count is asked of the reducer, not re-derived — a second copy of that
  // decision is exactly how the note came to disagree with what happened.
  check('the removed-highlight count is computed by running the reducer itself',
    /const afterBoard = saveFormReducer\(saveFormRef\.current, boardAction\);/.test(app)
    && /const chipsRemoved = chipsBefore - \(afterBoard\.terms\.a\.length \+ afterBoard\.terms\.b\.length\);/.test(app),
    'App.tsx must derive chipsRemoved from saveFormReducer(boardAction), not from its own copy of the rule');
  check('the same action object is the one dispatched',
    /dispatchSaveForm\(boardAction\);/.test(app));
  // The 'filled' branch runs AFTER the report await, and a `story` clears the
  // chips too. `keepUserText` was decided before that await, so this branch can
  // be reached with chips still on the form — the note must count those as well,
  // read from the live ref, or it undercounts and goes quiet again.
  check('the filled note counts the chips the story itself is about to clear, from the LIVE ref',
    /renderGenerateNote\(generateKind, 'filled',\s*chipsRemoved \+ saveFormRef\.current\.terms\.a\.length \+ saveFormRef\.current\.terms\.b\.length\)\)/.test(app));
  check('fixture: that check rejects the reconcile-time-only count',
    !/renderGenerateNote\(generateKind, 'filled',\s*chipsRemoved \+ saveFormRef\.current\.terms\.a\.length \+ saveFormRef\.current\.terms\.b\.length\)\)/.test(
      app.replace(/renderGenerateNote\(generateKind, 'filled',[\s\S]*?\)\);/, "renderGenerateNote(generateKind, 'filled', chipsRemoved));")));
}

// ── 5. Mutants — each must break the check that NAMES it, not some other ─────
{
  /** The four properties the clause must have, by name. */
  const probes: [string, (clause: (n: number) => string) => boolean][] = [
    ['a removed highlight is reported at all', (c) => c(1) !== ''],
    ['singular: noun is singular', (c) => / The colour highlight /.test(c(1)) && /it described/.test(c(1))],
    ['plural: noun is plural and counted', (c) => c(4).includes(' 4 colour highlights ') && /they described/.test(c(4))],
    ['none removed means no removal clause at all', (c) => c(0) === ''],
  ];
  // The real clause satisfies all four.
  for (const [name, p] of probes) check(`the real clause satisfies "${name}"`, p(highlightsRemovedClause));

  const mutants: [string, (n: number) => string, string][] = [
    ['M1 the clause is dropped again (the shipped defect)',
      () => '', 'a removed highlight is reported at all'],
    ['M2 the clause is always plural',
      (n) => ` The ${n} colour highlights you had added went with the story they described.`, 'singular: noun is singular'],
    ['M3 the clause is always singular',
      (n) => (n <= 0 ? '' : ' The colour highlight you had added went with the story it described.'), 'plural: noun is plural and counted'],
    ['M4 the count is dropped from the plural',
      (n) => (n <= 0 ? '' : n === 1 ? ' The colour highlight you had added went with the story it described.' : ' The colour highlights you had added went with the story they described.'), 'plural: noun is plural and counted'],
    ['M5 a zero count still prints a clause',
      (n) => (n === 1 ? ' The colour highlight you had added went with the story it described.' : ` The ${n} colour highlights you had added went with the story they described.`), 'none removed means no removal clause at all'],
  ];
  for (const [label, fake, named] of mutants) {
    const failed = probes.filter(([, p]) => !p(fake)).map(([n]) => n);
    check(`${label} -> killed by "${named}"`, failed.includes(named),
      failed.length === 0 ? 'NOT KILLED (the mutated clause satisfied every probe)' : `killed instead by: ${failed.join('; ')}`);
  }
}

if (failures > 0) {
  console.error(`\n✗ ${failures} failure(s) of ${cases} checks`);
  process.exit(1);
}
console.log(`✓ generatenote.test.ts: ${cases} checks — one renderer for three outcomes, number agreement 1..12, App.tsx builds no sentence of its own, 5 mutants rejected`);

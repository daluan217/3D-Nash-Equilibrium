/**
 * Structural regression guards for two axe-core findings (RED-APP-4, round 4)
 * folded into blue4-app before its CodeRabbit review.
 *
 * axe-core itself is the real verification instrument (it was run against a
 * live local build both before and after each fix — see the blue-notes on
 * findings/RED-APP-4/005 and /006). It is not wired into `npm test` (it needs
 * a browser + a running server, same class as the e2e suite, not a fast unit
 * check) so these are the DECIDABLE half: static facts about the source that
 * a regression could not silently undo without also breaking one of these.
 *
 *   npx tsx src/a11yfixes.test.ts
 */
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

const app = readFileSync('src/App.tsx', 'utf8');
const css = readFileSync('src/index.css', 'utf8');

/** RED-APP-17/001: dark print must use the light paper palette. */
function extractPrintBlock(source: string): string {
  const start = source.indexOf('@media print');
  let printBlock = '';
  if (start >= 0) {
    const open = source.indexOf('{', start);
    let depth = open >= 0 ? 0 : -1;
    for (let i = open; i >= 0 && i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) {
        printBlock = source.slice(start, i + 1);
        break;
      }
    }
  }
  return printBlock;
}

function assertDarkPrintPalette(source: string): void {
  const printBlock = extractPrintBlock(source);
  assert(printBlock, 'src/index.css must contain an @media print block');
  const rootRule = [...printBlock.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([selector]) => selector.includes('html.dark') && selector.includes('html.dark body'));
  assert(rootRule, '@media print must contain the html.dark root palette rule');
  assert(/color-scheme:\s*light\s*!important/.test(rootRule[2]),
    '@media print must force color-scheme: light in the html.dark root rule');
  // RED-APP-18/004 (regression from #172): the `[class*="dark:…"]` family
  // overrides keyed on the PRESENCE of a dark variant, not on the ink, and
  // blanked Player B's blue on the dark-theme printout. They must be gone;
  // the dark variant itself is defined inert under print media.
  assert(!/html\.dark \[class\*="dark:/.test(printBlock),
    '@media print must not carry [class*="dark:…"] family overrides (RED-APP-18/004: they turned Player B\'s print ink black)');
  assert(/@custom-variant dark \{\s*@media not print \{\s*&:where\(\.dark, \.dark \*\) \{\s*@slot;?\s*\}\s*\}\s*\}/.test(source),
    'the dark variant must be defined inside @media not print so every dark: utility is inert on paper (RED-APP-18/004)');
  assert(!/@variant dark \(/.test(source) && !/@custom-variant dark \(/.test(source),
    'no bare (media-unconditional) dark variant definition may remain (RED-APP-18/004)');
  assert(/background-color:\s*var\(--color-white\)\s*!important/.test(rootRule[2]),
    '@media print must force a white paper background in the html.dark root rule');
  assert(/color:\s*var\(--color-slate-900\)\s*!important/.test(rootRule[2]),
    '@media print must force dark readable ink in the html.dark root rule');
}

assertDarkPrintPalette(css);
/**
 * STRUCT-APP-19/002 — the same guarantee this guard has always made ("the
 * simulation progress panel prints light"), asserted against the structure that
 * now provides it instead of against the eleven hand-written print overrides
 * that used to.
 *
 * Those overrides existed because the panel picked its dark classes in
 * JavaScript, and a JS-chosen class is a plain class no `@media` rule can make
 * inert. They were wrong twice over: the map disagreed with the light theme's
 * own choice (a dark-theme visitor printed those labels slate-700 where a
 * light-theme visitor printed slate-500 — measured), and it covered exactly one
 * component, so the next component to pick classes in JS printed dark with
 * nothing failing.
 *
 * The panel now uses `dark:` variants, which are already inert on paper
 * (assertDarkPrintPalette above). So the invariant to hold is the STRONGER,
 * general one: no component picks Tailwind colour classes at runtime, and the
 * print block carries no per-utility dark overrides at all. e2e §41 asserts the
 * same thing on the rendered page, over every element that reaches paper.
 */
// OPUS-REVIEW-180 SHOULD 3: this used to read App.tsx only, match only
// `darkMode ?`, and only single-quoted branches — one file wide, when the
// invariant it states ("no component picks a colour class at runtime") is
// repo-wide. It now covers `isDark` too (what the components use) and all three
// quote styles.
const COLOUR_UTILITY = '(?:bg|text|border|ring|placeholder|from|via|to|fill|stroke|decoration|outline|shadow|accent|caret|divide)';
const runtimeDarkTernary = () => new RegExp(
  `\\b(?:darkMode|isDark)\\s*\\?\\s*(['"\`])[^'"\`]*\\b${COLOUR_UTILITY}-(?:[a-z]+-\\d{2,3}|white|black|transparent|current|none)\\b[^'"\`]*\\1\\s*:`,
  'g',
);
const RUNTIME_DARK_COLOUR_TERNARY = runtimeDarkTernary();

/**
 * Components whose output never reaches paper, each with the reason and the
 * measurement behind it. This is an ALLOW-LIST, not a silence: the assertion
 * below fails if an entry names a file that no longer exists, or one that no
 * longer contains a runtime ternary — so an entry cannot outlive the thing it
 * excuses. Anything NOT listed here must use `dark:` variants.
 */
const PRINT_HIDDEN_RUNTIME_DARK: Record<string, string> = {
  'GameGraphMiniature.tsx':
    'Renders only through SavedGamesList variant="drawer" and MenuDrawer, both inside [data-modal-surface], which @media print hides. '
    + 'OPUS-REVIEW-180 SHOULD 3 proposed this as a LIVE leak via App.tsx\'s SavedGamesList; measured 2026-09-09 with one saved game in '
    + 'desktop local-owner mode, that call site passes variant="sidebar" (a compact strip with no miniature): zero miniatures render on '
    + 'the main page in either theme, and the printed saved-game row is identical light vs dark.',
  'PlotlyView.tsx': 'The 3D plot carries [data-tour="plot"], which @media print hides.',
  'AdminDashboard.tsx': 'Renders inside a ModalSurface ([data-modal-surface]), which @media print hides.',
};

/** Every component file as {name: source}. Injectable so the mutants below can
 *  plant a runtime ternary without touching the working tree. */
const readComponents = (): Record<string, string> => Object.fromEntries(
  readdirSync('src/components').filter((f) => f.endsWith('.tsx'))
    .map((f) => [f, readFileSync(join('src/components', f), 'utf8')]),
);

function assertNoRuntimeDarkColourClasses(
  source: string,
  appSource: string,
  components: Record<string, string> = readComponents(),
): void {
  const printBlock = extractPrintBlock(source);
  assert(printBlock, 'src/index.css must contain an @media print block');
  // 1. No per-utility dark override survives in the print block. This is the
  //    clause the old eleven mappings would fail.
  // Scan RULES, not prose: the block explains in a comment what used to be here,
  // and a scanner that reads its own documentation fires on the fix itself.
  const printRules = printBlock.replace(/\/\*[\s\S]*?\*\//g, '');
  const perUtility = [...printRules.matchAll(/html\.dark \[class~="[^"]+"\]/g)].map((m) => m[0]);
  assert(perUtility.length === 0,
    `@media print must carry no per-utility runtime-dark overrides; found ${perUtility.length}: ${perUtility.slice(0, 3).join(', ')} (STRUCT-APP-19/002)`);
  // 2. No component picks a Tailwind COLOUR class from the darkMode flag. A
  //    class chosen in JS cannot be made inert on paper, so paper would depend
  //    on the screen theme again.
  const runtime = [...appSource.matchAll(runtimeDarkTernary())].map((m) => m[0]);
  assert(runtime.length === 0,
    `App.tsx must not choose Tailwind colour classes from darkMode — use a dark: variant, which is inert on paper. Found ${runtime.length}: ${runtime.slice(0, 2).join(' | ')} (STRUCT-APP-19/002)`);
  // 2b. The same rule for every component that can reach paper. Enumerating one
  //     file was exactly the shape of the eleven print overrides this replaced.
  const offenders: string[] = [];
  for (const [file, src] of Object.entries(components)) {
    const hits = [...src.matchAll(runtimeDarkTernary())].map((m) => m[0]);
    if (!hits.length) continue;
    if (PRINT_HIDDEN_RUNTIME_DARK[file]) continue;
    offenders.push(`${file}: ${hits[0].slice(0, 70)}`);
  }
  assert(offenders.length === 0,
    `no component that reaches paper may choose Tailwind colour classes at runtime — use dark: variants, which are inert on paper. `
    + `Found ${offenders.length}: ${offenders.slice(0, 3).join(' | ')}. If the component is genuinely print-hidden, add it to `
    + `PRINT_HIDDEN_RUNTIME_DARK with the reason and the measurement (STRUCT-APP-19/002)`);
  // 2c. The allow-list is a ratchet: no entry may outlive what it excuses.
  for (const [file, reason] of Object.entries(PRINT_HIDDEN_RUNTIME_DARK)) {
    const src = components[file] ?? '';
    assert(src, `PRINT_HIDDEN_RUNTIME_DARK names ${file}, which no longer exists — remove the entry (STRUCT-APP-19/002)`);
    assert(reason.length > 40, `PRINT_HIDDEN_RUNTIME_DARK[${file}] must record WHY it cannot reach paper`);
    assert([...src.matchAll(runtimeDarkTernary())].length > 0,
      `PRINT_HIDDEN_RUNTIME_DARK names ${file}, which no longer picks colour classes at runtime — remove the entry so the allow-list `
      + `cannot silently cover a future one (STRUCT-APP-19/002)`);
  }
  // 3. The panel really does carry the dark: variants now (a positive fixture,
  //    so silently dropping the dark styling is a failure and not a pass).
  for (const cls of ['bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800',
    'text-slate-500 dark:text-slate-400',
    'bg-slate-200 dark:bg-slate-700',
    'border-ne-mixed-300 dark:border-ne-mixed-700 text-ne-mixed-700 dark:text-ne-mixed-400 hover:bg-ne-mixed-50 dark:hover:bg-ne-mixed-900/30 cursor-pointer']) {
    assert(appSource.includes(cls),
      `the simulation progress panel must keep its dark: variant styling: "${cls}" (STRUCT-APP-19/002)`);
  }
}

assertNoRuntimeDarkColourClasses(css, app);
// OPUS-REVIEW-180 SHOULD 3 mutants — the repo-wide clause and its ratchet.
{
  const real = readComponents();
  // A NEW component that picks a colour class at runtime, in each quote style
  // and from either flag, must be caught — this is the case the App.tsx-only
  // scanner could never see.
  for (const planted of [
    "className={`p-2 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}",
    'className={`p-2 ${darkMode ? "text-slate-400" : "text-slate-500"}`}',
    'const cls = isDark ? `bg-slate-900` : `bg-slate-100`;',
    // CodeRabbit (#180): shade-less utilities (text-white, bg-black) are the
    // likeliest dark-arm picks and used to slip past the numeric-shade pattern.
    "className={isDark ? 'text-white' : 'text-slate-900'}",
  ]) {
    assert.throws(
      () => assertNoRuntimeDarkColourClasses(css, app, { ...real, 'NewThing.tsx': planted }),
      /no component that reaches paper may choose Tailwind colour classes at runtime/,
      `mutation: a component picking colour classes at runtime must fail the guard — ${planted.slice(0, 48)}`,
    );
  }
  // The allow-list must not be able to cover something it no longer describes.
  assert.throws(
    () => assertNoRuntimeDarkColourClasses(css, app, { ...real, 'GameGraphMiniature.tsx': 'export const X = () => null;' }),
    /no longer picks colour classes at runtime/,
    'mutation: a stale allow-list entry (the file no longer has a runtime ternary) must fail',
  );
  const withoutFile = { ...real };
  delete withoutFile['PlotlyView.tsx'];
  assert.throws(
    () => assertNoRuntimeDarkColourClasses(css, app, withoutFile),
    /which no longer exists — remove the entry/,
    'mutation: an allow-list entry naming a deleted file must fail',
  );
  // Control: the real tree passes, so the mutants above are not passing on a
  // guard that fires unconditionally.
  assertNoRuntimeDarkColourClasses(css, app, real);
}
// Mutants — each must fail the named guard.
{
  // The shipped RED-APP-18/004-era shape: the panel picking its classes in JS.
  const jsClasses = app.replace(
    'className="flex flex-col gap-2 px-3 py-2.5 rounded-xl border bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800"',
    "className={`flex flex-col gap-2 px-3 py-2.5 rounded-xl border ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'}`}",
  );
  assert.notStrictEqual(jsClasses, app, 'mutation-test precondition: the runtime-dark class ternary can be re-planted');
  assert.throws(() => assertNoRuntimeDarkColourClasses(css, jsClasses), /must not choose Tailwind colour classes from darkMode/,
    'mutation-test: a component picking Tailwind colour classes from darkMode must fail the named guard');
  // The compensating print override coming back.
  const overrideBack = css.replace('  /* The one `position: sticky` element on the page.',
    '  html.dark [class~="bg-slate-900"][class~="border-slate-800"] { background-color: var(--color-slate-50) !important; }\n\n  /* The one `position: sticky` element on the page.');
  assert.notStrictEqual(overrideBack, css, 'mutation-test precondition: a per-utility print override can be re-planted');
  assert.throws(() => assertNoRuntimeDarkColourClasses(overrideBack, app), /no per-utility runtime-dark overrides/,
    'mutation-test: re-planting a per-utility runtime-dark print override must fail the named guard');
  // Dropping the dark styling altogether would make paper consistent by making
  // the SCREEN wrong; that must fail too, not pass.
  const noDark = app.replace('bg-slate-200 dark:bg-slate-700', 'bg-slate-200');
  assert.notStrictEqual(noDark, app, 'mutation-test precondition: the dark: variant can be dropped');
  assert.throws(() => assertNoRuntimeDarkColourClasses(css, noDark), /must keep its dark: variant styling/,
    'mutation-test: dropping the panel\'s dark: variant must fail the named guard');
  // NEGATIVE CONTROL (permanent): the three legitimate `darkMode ?` uses that
  // remain in App.tsx — a native window colour, a button title, and an icon —
  // must NOT trip the runtime-colour-class predicate. A predicate that fires on
  // these would be unfixable without deleting real code.
  const legit = [
    "const bg = darkMode ? '#020617' : '#f8fafc';",
    'title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}',
    '{darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-accent-500" />}',
  ].join('\n');
  assert([...legit.matchAll(RUNTIME_DARK_COLOUR_TERNARY)].length === 0,
    'negative control: a native-window hex colour, a title string and an icon element must not be read as runtime colour classes');
  assert([...app.matchAll(/darkMode\s*\?/g)].length >= 3,
    'negative control precondition: App.tsx still contains the legitimate darkMode ternaries this control is about');
}

// RED-APP-18/004 mutants — each must fail the named guard.
{
  const replanted = css.replace('  html.dark body {', '  html.dark [class*="dark:text-"] { color: var(--color-slate-900) !important; }\n  html.dark body {');
  assert.notStrictEqual(replanted, css, 'mutation-test precondition: the #172 family override can be re-planted');
  assert.throws(() => assertDarkPrintPalette(replanted), /family overrides/,
    'mutation-test: re-planting a [class*="dark:text-"] print override must fail the named guard');
  const unconditional = css.replace(/@custom-variant dark \{\s*@media not print \{\s*&:where\(\.dark, \.dark \*\) \{\s*@slot;?\s*\}\s*\}\s*\}/, '@custom-variant dark (&:where(.dark, .dark *));');
  assert.notStrictEqual(unconditional, css, 'mutation-test precondition: the print-conditional dark variant can be flattened');
  assert.throws(() => assertDarkPrintPalette(unconditional), /inert on paper|media-unconditional/,
    'mutation-test: a dark variant that also applies under print must fail the named guard');
  const noMedia = css.replace('@custom-variant dark {\n  @media not print {\n    &:where(.dark, .dark *) {\n      @slot;\n    }\n  }\n}', '@custom-variant dark {\n  &:where(.dark, .dark *) {\n    @slot;\n  }\n}');
  assert.notStrictEqual(noMedia, css, 'mutation-test precondition: the @media not print wrapper can be removed');
  assert.throws(() => assertDarkPrintPalette(noMedia), /inert on paper/,
    'mutation-test: dropping the @media not print wrapper must fail the named guard');
}

/**
 * The full text of the `<div>` block that OPENS at `startMarker`, found by
 * counting div depth (not a fixed character window) so a comment or JSX
 * expression added later inside the block cannot silently walk the slice
 * off the end. Self-closing `<div ... />` tags do not change depth.
 */
function extractDivBlock(src: string, startMarker: string): string {
  const start = src.indexOf(startMarker);
  assert(start > 0, `start marker not found: ${JSON.stringify(startMarker)}`);
  const openTagEnd = src.indexOf('>', start) + 1;
  assert(openTagEnd > 0, `no closing '>' found for the opening tag at ${JSON.stringify(startMarker)}`);
  // A self-closing `<div ... />` (e.g. a dangerouslySetInnerHTML card with no
  // JSX children) IS the whole block: there is no `</div>` of its own to
  // match, so returning here keeps the scan below from consuming the next
  // unrelated `</div>` further down the file instead.
  if (src.slice(start, openTagEnd).trimEnd().endsWith('/>')) {
    return src.slice(start, openTagEnd);
  }
  const tagRe = /<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = openTagEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  let endIdx = -1;
  while ((m = tagRe.exec(src)) !== null) {
    if (m[0] === '</div>') {
      depth--;
      if (depth === 0) { endIdx = m.index + m[0].length; break; }
    } else if (!m[0].endsWith('/>')) {
      depth++;
    }
  }
  assert(endIdx > 0, `did not find the matching close for ${JSON.stringify(startMarker)}`);
  return src.slice(start, endIdx);
}

/**
 * round14: Account/Save/Edit/Feedback moved from a hand-rolled backdrop+panel
 * div (which `extractDivBlock` used to scope into) to `<ModalSurface id="...">
 * ...children...</ModalSurface>`. No `<ModalSurface>` nests inside another, so
 * a plain string search for the matching `</ModalSurface>` (unlike
 * `extractDivBlock`'s div-depth counting, needed only because `<div>` DOES
 * nest) is sufficient and exact.
 */
function extractModalSurfaceBlock(src: string, id: string): string {
  const idMarker = `id="${id}"`;
  const idIdx = src.indexOf(idMarker);
  assert(idIdx > 0, `<ModalSurface id="${id}"> not found`);
  const tagStart = src.lastIndexOf('<ModalSurface', idIdx);
  assert(tagStart > 0 && idIdx - tagStart < 300, `the <ModalSurface> opening this id="${id}"> was not found nearby`);
  const openTagEnd = src.indexOf('>', idIdx) + 1;
  const closeIdx = src.indexOf('</ModalSurface>', openTagEnd);
  assert(closeIdx > 0, `no matching </ModalSurface> found for id="${id}"`);
  return src.slice(tagStart, closeIdx + '</ModalSurface>'.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 005 (axe CRITICAL "label" rule, 13 nodes): the 8 payoff-matrix
// inputs, x0/y0, the step-size box + slider, and the Loop Speed slider had no
// label/aria-label/aria-labelledby/title/placeholder at all.
// ─────────────────────────────────────────────────────────────────────────────
{
  // The 8 payoff cells: aria-label built from activeLabels, one per field.
  for (const [field, row, col, player] of [
    ['a11', 'row1', 'col1', 'A'], ['b11', 'row1', 'col1', 'B'],
    ['a12', 'row1', 'col2', 'A'], ['b12', 'row1', 'col2', 'B'],
    ['a21', 'row2', 'col1', 'A'], ['b21', 'row2', 'col1', 'B'],
    ['a22', 'row2', 'col2', 'A'], ['b22', 'row2', 'col2', 'B'],
  ] as const) {
    const callSite = app.indexOf(`updatePayoffField('${field}'`);
    ok(callSite > 0, `the ${field} input's onChange call site must be found`);
    const nextInputEnd = app.indexOf('/>', callSite);
    const block = app.slice(callSite, nextInputEnd);
    ok(new RegExp(`aria-label=\\{\`\\$\\{activeLabels\\.${row}[^}]*\\}, \\$\\{activeLabels\\.${col}[^}]*\\}, Player ${player} payoff\`\\}`).test(block),
      `the ${field} input must carry an aria-label built from activeLabels.${row}/${col} naming Player ${player}, got: ${JSON.stringify(block)}`);
  }

  // The other 5 flagged controls. OPUS-REVIEW-APP16 N-3: x0/y0 used to carry
  // BOTH a real <label> (RED-APP-16/003's fix) and an aria-label with the
  // ASCII "x0"/"y0" spelling — aria-label wins the accessible-name
  // computation, so the visible "x₀"/"y₀" (U+2080) label never reached
  // assistive tech (WCAG 2.5.3 label-in-name). The aria-label is gone; the
  // <label> now supplies the name, so it now matches what is on screen.
  ok(!app.includes(`aria-label="Row Start Point (x0)"`), 'the x0 input must NOT carry the old ASCII-spelled aria-label (the <label> supplies the name now)');
  ok(!app.includes(`aria-label="Col Start Point (y0)"`), 'the y0 input must NOT carry the old ASCII-spelled aria-label (the <label> supplies the name now)');
  ok(/<label htmlFor=\{labelFor\('coords', 'x0'\)\}[^>]*>Row Start Point \(x₀\)<\/label>[\s\S]{0,200}id=\{labelFor\('coords', 'x0'\)\}/.test(app),
    'the x0 field\'s <label> (with the visible U+2080 subscript) must be htmlFor/id-paired to the input');
  ok(/<label htmlFor=\{labelFor\('coords', 'y0'\)\}[^>]*>Col Start Point \(y₀\)<\/label>[\s\S]{0,200}id=\{labelFor\('coords', 'y0'\)\}/.test(app),
    'the y0 field\'s <label> (with the visible U+2080 subscript) must be htmlFor/id-paired to the input');
  ok(/aria-label=\{stepMode === 'regret' \? 'Regret Step Weight \(lambda\)' : 'Initial Domain Shrink Step Size'\}/.test(app),
    'the step-size text box must carry a mode-aware aria-label');
  ok(/aria-label=\{stepMode === 'regret' \? 'Regret Step Weight \(lambda\) slider' : 'Initial Domain Shrink Step Size slider'\}/.test(app),
    'the step-size range slider must carry its own mode-aware aria-label');
  ok(app.includes(`aria-label="Loop Speed"`), 'the Loop Speed slider must carry an aria-label');

  // Mutation: the pre-fix shape (bare input, no label of any kind) must not
  // accidentally already satisfy the regexes above.
  const preFix = `
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.\\-]*"
                  value={rawPayoffs.a11}
                  onChange={(e) => updatePayoffField('a11', e.target.value)}
                  onBlur={() => handlePayoffBlur('a11')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-a-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />`;
  ok(!/aria-label/.test(preFix), 'the pre-fix fixture text must not accidentally already contain an aria-label (fixture sanity check)');
}

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 006, REVERSED (round 6, BLUE-COLOUR-REVERT, 2026-09-02).
//
// Daniel's call, verbatim: "not a fan of those darker colors, I preferred the
// old ones. The darker matte colors are only meant for stuff like
// Game-Theoretic Report and the explanations for the preset/saved games in
// the top left." So the app-wide muted-text idiom and the player-a-500
// running-text idiom that finding 006 (round 4, axe-core color-contrast
// SERIOUS) had moved to slate-600/slate-400 and -600 respectively are
// RESTORED everywhere EXCEPT two named regions: the Game-Theoretic Report
// panel (`reportPanelRef`) and the preset/saved-game explanation cards in the
// top-left workspace. Those two keep the darker, AA-clearing pair via a new
// SCOPED token, `--color-prose-muted` / `--color-prose-muted-dark`.
//
// This means the 2.51:1 light / 3.74-4.23:1 dark contrast axe flagged as
// SERIOUS is, outside those two regions, BY DESIGN as of 2026-09-02 — see
// round6/README.md and the closed-angle note in
// .claude/skills/red-blue-teams/SKILL.md. A red should not re-file plain
// muted-text or player-a-500 running-text contrast findings outside the
// report panel / drawer narrative cards; a genuinely NEW contrast defect
// inside those two regions, or anywhere the checks below don't cover, is
// still fair game.
// ─────────────────────────────────────────────────────────────────────────────
{
  // ── Global palette parity: --color-muted is back to the pre-#87 pair ──
  ok(/--color-muted:\s*var\(--color-slate-400\)/.test(css),
    'the --color-muted token must resolve back to slate-400 (pre-#87)');
  ok(/--color-muted-dark:\s*var\(--color-slate-500\)/.test(css),
    'the --color-muted-dark token must resolve back to slate-500 (pre-#87)');

  // ── The scoped prose token exists, at the SAME values #87 had chosen for
  // the (now reverted) global token — the darker pair is not gone, only
  // confined. Measured (WCAG relative-luminance formula, same one axe
  // uses): slate-600 on slate-50/white = 7.25:1/7.58:1; slate-400 on
  // slate-900/950 = 6.78:1/7.66:1 — real margin above 4.5:1.
  ok(/--color-prose-muted:\s*var\(--color-slate-600\)/.test(css),
    'the --color-prose-muted token must resolve to slate-600');
  ok(/--color-prose-muted-dark:\s*var\(--color-slate-400\)/.test(css),
    'the --color-prose-muted-dark token must resolve to slate-400');

  // The exact pre-#87 FAILING literal idiom must never be reintroduced —
  // this repo always uses the `text-muted`/`text-prose-muted` TOKENS (whose
  // resolved color is asserted above), never the raw Tailwind slate steps,
  // so a future edit that hard-codes the literal class can't silently
  // reopen the 2.51:1 contrast finding by a different path.
  for (const path of [
    'src/App.tsx', 'src/components/AdminDashboard.tsx', 'src/components/MenuDrawer.tsx',
    'src/components/DescriptionEditor.tsx', 'src/components/DownloadModal.tsx',
  ]) {
    const src = readFileSync(path, 'utf8');
    ok(!src.includes('text-slate-400 dark:text-slate-500'),
      `${path} must not reintroduce the literal text-slate-400 dark:text-slate-500 pairing (use the text-muted/text-prose-muted tokens)`);
  }

  // ── The Game-Theoretic Report panel: every muted caption inside it must
  // use the SCOPED prose token, not the (now light-again) global one. ──
  const reportPanel = extractDivBlock(app, 'ref={reportPanelRef}');
  const reportProseMutedCount = (reportPanel.match(/text-prose-muted dark:text-prose-muted-dark/g) || []).length;
  ok(reportProseMutedCount === 4,
    `the report panel must carry exactly 4 text-prose-muted captions (the loading/tie-note/unverified/empty-state lines), found ${reportProseMutedCount}`);
  ok(!/(?<!prose-)\btext-muted dark:text-muted-dark\b/.test(reportPanel),
    'no caption inside the report panel may use the plain (reverted, lighter) text-muted token — it must use text-prose-muted');

  // ── The second region — the preset/saved-game explanation cards in the
  // top-left workspace (App.tsx's own "Selected Preset Narrative Card" and
  // MenuDrawer's saved/default-game description cards) — keep their darker
  // matte text through a DIFFERENT, pre-existing mechanism this revert did
  // not touch: ColorCoded's player-a-ink/player-b-ink tokens (defined and
  // used there since before #87 — ColorCoded.tsx is not part of #87's diff
  // at all) plus a constant `text-slate-600 dark:text-slate-300` body color,
  // never `--color-muted`. So neither card currently has anything to move
  // onto the new prose token — verified here so this stays true, and so a
  // caption ADDED to either card later is forced onto text-prose-muted
  // rather than silently reintroducing the lighter global token. Both
  // narrative-card blocks are extracted (div-depth, like the report panel)
  // so they can be EXCLUDED from the "no leak outside" check below — using
  // text-prose-muted inside them is the documented, intended fallback, not
  // a leak. */
  const menuDrawer = readFileSync('src/components/MenuDrawer.tsx', 'utf8');
  const narrativeCardMarkers = [...app.matchAll(/data-testid="preset-narrative"/g)];
  ok(narrativeCardMarkers.length === 2,
    `expected exactly 2 preset-narrative card definitions (custom + standard), found ${narrativeCardMarkers.length}`);
  const narrativeCardBlocks = narrativeCardMarkers.map((m) => extractDivBlock(app, app.slice(m.index!, m.index! + 32)));
  for (const [i, block] of narrativeCardBlocks.entries()) {
    ok(!/\btext-muted dark:text-muted-dark\b/.test(block),
      `the preset-narrative card #${i} must not use the plain text-muted token — it should use text-prose-muted if it ever needs muted text, got: ${JSON.stringify(block.slice(0, 200))}`);
  }
  // BLUE-LIST-14 (round14): this card moved from MenuDrawer.tsx into the
  // shared src/components/SavedGamesList.tsx (drawer variant) — same markup,
  // new home.
  const savedGamesList = readFileSync('src/components/SavedGamesList.tsx', 'utf8');
  const savedGameDescIdx = savedGamesList.indexOf("<ColorCoded text={game.desc}");
  ok(savedGameDescIdx > 0, 'the SavedGamesList saved-game description ColorCoded call must be found');
  const savedGameDescNearby = savedGamesList.slice(Math.max(0, savedGameDescIdx - 200), savedGameDescIdx);
  ok(!/\btext-muted dark:text-muted-dark\b/.test(savedGameDescNearby),
    'the SavedGamesList saved-game description card must not use the plain text-muted token');
  ok(savedGameDescNearby.includes('text-slate-500 dark:text-slate-400'),
    'the SavedGamesList saved-game description card must still render its own matte body text (unaffected by this revert)');

  // ── No element OUTSIDE the report panel AND the two narrative-card blocks
  // uses the scoped prose token — the other half of "confined to two
  // regions": a leak here would mean some unrelated caption picked up the
  // darker pair by accident. CodeRabbit finding (this branch): the first
  // draft of this check forbade text-prose-muted anywhere outside the
  // report panel, which would fail the moment the narrative cards' own
  // documented fallback (above) is ever exercised — so the narrative
  // blocks must be carved out here too, not just the report panel. ──
  let appOutsideScopedRegions = app.slice(0, app.indexOf(reportPanel)) + app.slice(app.indexOf(reportPanel) + reportPanel.length);
  for (const block of narrativeCardBlocks) {
    ok(appOutsideScopedRegions.includes(block), 'a narrative-card block must still be present in the report-panel-excised text before it can be excised itself');
    appOutsideScopedRegions = appOutsideScopedRegions.replace(block, '');
  }
  ok(!appOutsideScopedRegions.includes('text-prose-muted'),
    'text-prose-muted must not appear in App.tsx outside the report panel and the two preset-narrative cards');
  for (const path of [
    'src/components/AdminDashboard.tsx', 'src/components/DescriptionEditor.tsx', 'src/components/DownloadModal.tsx',
  ]) {
    const src = readFileSync(path, 'utf8');
    ok(!src.includes('text-prose-muted'), `${path} must not use text-prose-muted (not one of the two named regions)`);
  }
  // MenuDrawer.tsx is a named region too (the saved/default-game
  // description cards), so it is deliberately NOT in the "must not use"
  // loop above — but nothing in it uses text-prose-muted today either
  // (verified above: the description card's own body text is a literal
  // slate-500/400 pair, never the token), so this stays a live check.
  ok(!menuDrawer.includes('text-prose-muted'),
    'MenuDrawer.tsx must not use text-prose-muted today (the default-preset description card has nothing to move onto it yet)');
  // BLUE-LIST-14: the saved-game card itself now lives in SavedGamesList.tsx
  // (moved out of MenuDrawer.tsx) — same "nothing to move onto it yet" guard.
  ok(!savedGamesList.includes('text-prose-muted'),
    'SavedGamesList.tsx must not use text-prose-muted today (its description card has nothing to move onto it yet)');

  // ── The running-text player-a-500 instances (row/col headers, payoff-A
  // input text, coordinate/legend labels, option-name labels) are BACK,
  // except: (a) inside the report panel, where the one pre-existing
  // (pre-#87, untouched) player-a-ink use in the "Scenario written for this
  // game" card stays as-is, and (b) the two documented HOVER-state
  // exceptions (text-slate-400 hover:text-player-a-500 — passes at REST,
  // only changes color on interaction, which axe's static snapshot does not
  // evaluate as failing). ──
  const staticPlayerA500 = [...appOutsideScopedRegions.matchAll(/(?<!hover:)text-player-a-500\b/g)]
    .filter((m) => !appOutsideScopedRegions.slice(Math.max(0, m.index! - 20), m.index!).includes('hover:'));
  ok(staticPlayerA500.length === 13,
    `expected 13 restored STATIC text-player-a-500 running-text call sites outside the report panel (12 bare + the "A Moves" legend with its own dark:text-player-a-400), found ${staticPlayerA500.length}`);
  ok(reportPanel.includes('text-player-a-ink dark:text-player-a-ink-dark') && !reportPanel.includes('text-player-a-500'),
    'the pre-existing (pre-#87) text-player-a-ink use inside the report panel\'s "Scenario written for this game" card must be left untouched, not reverted');

  // ── The active "Player A" toggle buttons are back to the SAME -500 step
  // Player B's button always used at rest (bg-player-b-500 was never
  // touched by #87 for the inactive/other-branch case; only Player A's
  // ACTIVE state was bumped to -600 and is now reverted). ──
  ok(!app.includes("'bg-player-a-600 text-white border-player-a-600'"),
    'the Player A active-toggle button must no longer use the (reverted) bg-player-a-600/white pairing');
  const activeButtonCount = [...app.matchAll(/'bg-player-a-500 text-white border-player-a-500'/g)].length;
  ok(activeButtonCount === 2, `both Player A active-toggle buttons must be back to bg-player-a-500, found ${activeButtonCount}`);

  // ── MUTATION FIXTURES — the checks above must be able to tell the #87
  // shape apart from the reverted shape in both directions. ──
  ok(!/--color-muted:\s*var\(--color-slate-400\)/.test('  --color-muted: var(--color-slate-600);\n  --color-muted-dark: var(--color-slate-400);'),
    'fixture sanity: the #87 CSS shape must not accidentally match the reverted-value regex');
  ok(!extractDivBlock('<div ref={reportPanelRef} className="x"><p className="text-muted dark:text-muted-dark">y</p></div>', 'ref={reportPanelRef}')
    .match(/text-prose-muted dark:text-prose-muted-dark/g),
    'fixture sanity: a report-panel block using the plain (unfixed) token must not accidentally satisfy the count===4 check');
}

// ─────────────────────────────────────────────────────────────────────────────
// CodeRabbit finding, PR #87 re-review (src/components/MenuDrawer.tsx): the
// "Central Hub Website URL" <label> was not associated with its <input> —
// no wrapping, no htmlFor/id pair — so a screen reader announces the field
// with no accessible name, the exact `label` axe rule finding 005 was about,
// just on a different (non-default-visible) panel finding 005's sweep never
// opened.
// ─────────────────────────────────────────────────────────────────────────────
{
  const menuDrawer = readFileSync('src/components/MenuDrawer.tsx', 'utf8');
  ok(/<label htmlFor="central-hub-url"[^>]*>\s*Central Hub Website URL/.test(menuDrawer),
    'the Central Hub Website URL label must carry htmlFor="central-hub-url"');
  const inputIdx = menuDrawer.indexOf('value={apiBaseUrl}');
  ok(inputIdx > 0, 'the Central Hub URL input must be found');
  const inputBlock = menuDrawer.slice(Math.max(0, inputIdx - 200), inputIdx);
  ok(/id="central-hub-url"/.test(inputBlock),
    `the Central Hub URL input must carry the matching id, got: ${JSON.stringify(inputBlock)}`);
  // No duplicate id anywhere else in the tree (a duplicate id is its own
  // a11y/DOM defect and would make the association ambiguous).
  const idCount = (menuDrawer.match(/id="central-hub-url"/g) || []).length;
  ok(idCount === 1, `id="central-hub-url" must appear exactly once, found ${idCount}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// RED-APP-5 finding 001 (round 5): the "Edit saved game" dialog was once
// missing from a hand-maintained "close whichever foreground modal is open
// on Escape" condition chain + dependency array — every other modal closed
// on Escape; Edit was simply never added to the list.
//
// round14 structural pass (BLUE-MODAL-14): that per-dialog chain is GONE.
// Every dialog (Account/Save/Edit/Feedback/the drawer) now closes on Escape
// through the ONE shared `<ModalSurface>` implementation (src/modalsurface
// .test.ts covers its registry/mutation testing) — so "a new dialog forgot
// to be added to the list" is no longer a reachable shape: there is no list.
// round15 (BLUE-MODAL-15): the local-games offer joins the same primitive —
// its Escape/stopPropagation-against-the-tour guard (RED-APP-6/002) is now
// ModalSurface's, not a hand-rolled copy. What remains decidable here: Edit's
// and the offer's own `onClose` still carry the SAME side-effects their "✕"
// button/backdrop always used (the actual per-dialog behavior this finding
// cared about).
// ─────────────────────────────────────────────────────────────────────────────
{
  const editBlock = extractModalSurfaceBlock(app, 'edit-saved-game');
  ok(/onClose=\{\(\) => \{ setIsEditModalOpen\(false\); setEditError\(''\); \}\}/.test(editBlock),
    `Edit's <ModalSurface onClose> must close the SAME way its own "✕" button and backdrop do, got: ${JSON.stringify(editBlock.slice(0, 300))}`);

  // The local-games offer's onClose must still refuse to close mid-request
  // (RED-APP-12's "never mid-move" rule) — ModalSurface's shared Escape
  // handler always stopPropagation()s while active regardless of what onClose
  // itself decides, so the busy guard belongs in onClose, not around it.
  const offerBlock = extractModalSurfaceBlock(app, 'local-games-offer');
  ok(/onClose=\{\(\) => \{ if \(!localGamesBusy\) setLocalGamesOffer\(null\); \}\}/.test(offerBlock),
    `the local-games-offer <ModalSurface onClose> must refuse to close while localGamesBusy, got: ${JSON.stringify(offerBlock.slice(0, 300))}`);

  // MUTATION / NEGATIVE FIXTURE — a hand-maintained chain missing a branch
  // (the ORIGINAL shape of this finding), to prove the check above is not
  // vacuously true against any string.
  const preFix = `  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isFeedbackOpen) closeFeedback();
      else if (isSaveModalOpen) { setIsSaveModalOpen(false); setSaveError(''); }
      else if (isAuthModalOpen) { setIsAuthModalOpen(false); setAuthError(''); setAuthSuccess(''); resumeSaveAfterAuthRef.current = false; }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isFeedbackOpen, isSaveModalOpen, isAuthModalOpen]);`;
  ok(!/onClose=\{\(\) => \{ setIsEditModalOpen\(false\); setEditError\(''\); \}\}/.test(preFix),
    'the pre-fix fixture text must not accidentally already carry the fixed onClose wiring (fixture sanity check)');
}

// ─────────────────────────────────────────────────────────────────────────────
// RED-APP-5 finding 002 (round 5): four of the five `role="dialog"
// aria-modal="true"` surfaces (Feedback, Auth, Save, Edit) had no Tab trap at
// all. Fixed with a shared `useModalTabTrap` hook wired to all four —
// separately, at four call sites, each with its own ref.
//
// round14 structural pass (BLUE-MODAL-14): those four call sites are GONE.
// `useModalTabTrap` moved to src/components/ModalSurface.tsx and is now
// called from exactly ONE place — inside `ModalSurface` itself — so "one of
// four copy-pasted wirings got the wrong ref" is no longer a reachable
// shape: there is one hook call, and every converted dialog (Account, Save,
// Edit, Feedback, and the drawer) shares it by construction. That structural
// fact (every one of them renders through `<ModalSurface>`) is what
// src/modalsurface.test.ts checks, with its own mutation tests. This block
// now checks the hook itself still exists, in its new home, called exactly
// once — the shape a regression back to "one wiring per dialog" would break.
// ─────────────────────────────────────────────────────────────────────────────
{
  const modalSurfaceSrc = readFileSync('src/components/ModalSurface.tsx', 'utf8');
  ok(/export function useModalTabTrap\(/.test(modalSurfaceSrc),
    'the shared useModalTabTrap hook must exist in components/ModalSurface.tsx');
  const callSites = modalSurfaceSrc.match(/\buseModalTabTrap\(/g) ?? [];
  ok(callSites.length === 2,
    `useModalTabTrap must be defined once and CALLED once, from ModalSurface itself — found ${callSites.length} occurrences (expected the definition + one call)`);
  ok(!/function useModalTabTrap\(/.test(app),
    'App.tsx must not redefine its own copy of useModalTabTrap — it imports the one from ModalSurface');

  // MUTATION / NEGATIVE FIXTURE — the pre-round14 shape (four separate call
  // sites, one per dialog), to prove the count-based check above is not
  // vacuously true against any file.
  const preFixWiring = `useModalTabTrap(isFeedbackOpen, feedbackDialogRef, '[data-focus-fallback="feedback"]');
  useModalTabTrap(isAuthModalOpen, authDialogRef, '[data-focus-fallback="account"] button, [data-focus-fallback="account"]');
  useModalTabTrap(isSaveModalOpen, saveDialogRef, '[data-focus-fallback="save-preset"]');
  useModalTabTrap(isEditModalOpen, editDialogRef, '[data-focus-fallback="saved-games"]');`;
  const preFixCallSites = preFixWiring.match(/\buseModalTabTrap\(/g) ?? [];
  ok(preFixCallSites.length === 4,
    'fixture sanity: the pre-round14 fixture must show four separate call sites, not the fixed shape');
}

// ─────────────────────────────────────────────────────────────────────────────
// CodeRabbit review on PR #91 (Major, after RED-APP-5/002 shipped above):
// `useModalTabTrap` deliberately did not set initial focus, and only
// Feedback has its own `autoFocus` field — Auth, Save and Edit left focus
// stranded on the background opener until the user's first Tab press. Fixed
// by moving focus to the first enabled control inside the hook itself, gated
// on `!container.contains(document.activeElement)` so a dialog with its OWN
// autoFocus (Feedback) is unaffected. round14: the hook itself lives in
// components/ModalSurface.tsx now (see the block above) — same code, moved.
// This is the decidable half — the real behavioral proof is
// `src/e2e/smoke.mjs` section 20/66 (checks the Auth dialog, which has no
// autoFocus field of its own, so it is the one case that actually exercises
// this).
// ─────────────────────────────────────────────────────────────────────────────
{
  const modalSurfaceSrc = readFileSync('src/components/ModalSurface.tsx', 'utf8');
  const hookIdx = modalSurfaceSrc.indexOf('export function useModalTabTrap(');
  ok(hookIdx > 0, 'useModalTabTrap must exist (checked above; re-anchoring here)');
  const hookEnd = modalSurfaceSrc.indexOf('round14 structural pass (STRUCTURAL.md): a module-level stack', hookIdx);
  ok(hookEnd > hookIdx, 'could not find the end of useModalTabTrap (the next doc comment after it)');
  const hookBody = modalSurfaceSrc.slice(hookIdx, hookEnd);
  ok(hookBody.includes('getModalFocusables'),
    'useModalTabTrap must use a shared focusables helper (not re-derive its own query for the mount-focus branch)');
  ok(/if\s*\(container\s*&&\s*!container\.contains\(document\.activeElement\)\)/.test(hookBody),
    `useModalTabTrap must only move focus when it is not ALREADY inside the dialog — `
    + `otherwise Feedback's own autoFocus would be fought over, got: ${JSON.stringify(hookBody.slice(0, 400))}`);
  // round15 (RED-APP-14/002): falls back to the panel itself only when
  // focusables is EMPTY (`focusables[0] ?? container`) — still the first
  // real control whenever one exists, never the last or an arbitrary one.
  ok(/const focusables = getModalFocusables\(container\);\s*\n[\s\S]{0,200}?\(focusables\[0\] \?\? container\)\.focus\(\);/.test(hookBody),
    'useModalTabTrap must focus the FIRST focusable element (falling back to the panel only when none exist), not e.g. the last');
  // The mount-focus branch must run BEFORE the Tab keydown listener is
  // registered — placed after it would only take effect on the dialog's
  // SECOND open (React effect ordering), silently missing the first.
  const mountFocusIdx = hookBody.search(/if\s*\(container\s*&&\s*!container\.contains/);
  const listenerIdx = hookBody.indexOf('window.addEventListener');
  ok(mountFocusIdx > 0 && listenerIdx > mountFocusIdx,
    'the mount-focus check must run before the Tab-trap listener is attached');

  // MUTATION FIXTURE: the pre-fix hook body, verbatim (Tab-trap only, no
  // mount-focus branch). Proves the checks above can tell the fixed hook
  // apart from the defect.
  const preFixHookBody = `function useModalTabTrap(open: boolean, containerRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {`;
  ok(!preFixHookBody.includes('getModalFocusables'),
    'the pre-fix fixture text must not accidentally already carry the mount-focus branch (fixture sanity check)');
}

// ─────────────────────────────────────────────────────────────────────────────
// RED-APP-5 finding 003 (round 5): the guided tour (z-[60]) painted ABOVE
// every dialog (z-50), so a deliberately-opened modal (e.g. Sign In, which
// stays clickable throughout the tour) could be visually and functionally
// covered by the tour's callout card — a real, timed, non-forced Playwright
// click on the Login button timed out; `elementFromPoint` at the button's
// own center returned the tour card's <h3>, not the button. Fixed by
// raising the five dialogs (expand-log + the four here) to z-[65], above
// the tour — NOT by making the tour modal (it stays non-modal/click-through,
// per its own docstring, unchanged).
// ─────────────────────────────────────────────────────────────────────────────
{
  const walkthrough = readFileSync('src/components/Walkthrough.tsx', 'utf8');
  const tourZMatch = walkthrough.match(/fixed inset-0 z-\[(\d+)\]/);
  ok(tourZMatch !== null, 'the tour container\'s z-index must be found in Walkthrough.tsx');
  const tourZ = Number(tourZMatch![1]);

  // Check the TAG ITSELF, not the surrounding docstring (which discusses
  // aria-modal BY NAME to explain why it is deliberately absent — a naive
  // nearby-text search would false-positive on that very explanation).
  // RED-APP-16/001 (BLUE-MODAL-17): the wrapper's opening tag now spans
  // several lines (it also carries `inert={blocked}` and a conditional
  // `style={...}`), so a single-LINE search no longer finds it — extract the
  // whole tag by balanced braces (same technique modalsurface.test.ts's
  // extractButtons uses) instead of assuming it fits on one line.
  // lastIndexOf, not indexOf: the JS `insideOtherDialog` guard earlier in
  // this file also contains the literal substring
  // `[role="dialog"]:not([aria-label="Guided tour"])` (documented in
  // RED-APP-14/001's comment above it) — the actual JSX tag is the LATER of
  // the two occurrences.
  const labelIdx = walkthrough.lastIndexOf('aria-label="Guided tour"');
  ok(labelIdx > 0, 'could not find aria-label="Guided tour" in Walkthrough.tsx at all');
  const tagStart = walkthrough.lastIndexOf('<div', labelIdx);
  let ti = tagStart; let braceDepth = 0;
  while (ti < walkthrough.length) {
    const c = walkthrough[ti];
    if (c === '{') braceDepth++;
    else if (c === '}') braceDepth--;
    else if (c === '>' && braceDepth === 0) { ti++; break; }
    ti++;
  }
  const tourTag = tagStart > 0 ? walkthrough.slice(tagStart, ti).replace(/\s+/g, ' ') : undefined;
  ok(tourTag !== undefined && /role="dialog"/.test(tourTag) && /aria-label="Guided tour"/.test(tourTag) && !tourTag.includes('aria-modal'),
    `THE FIX MUST NOT make the tour modal — it must stay click-through, per its own docstring, got: ${JSON.stringify(tourTag)}`);

  // round15: the expand-log dialog is now <ModalSurface ariaLabel="Simulation
  // log" overlayClassName="...">, so its own z-index lives in its
  // `overlayClassName` prop string in App.tsx (a custom one — a different
  // backdrop-blur/padding than the shared four-dialog default — not the
  // ModalSurface OVERLAY_CLASS constant checked generically below).
  {
    const idx = app.indexOf('ariaLabel="Simulation log"');
    ok(idx > 0, 'the expand-log dialog\'s ariaLabel must be found');
    const propsStart = app.lastIndexOf('<ModalSurface', idx);
    ok(propsStart > 0 && idx - propsStart < 300, 'the <ModalSurface> opening the expand-log dialog was not found nearby');
    const closeTagEnd = app.indexOf('>', app.indexOf('overlayClassName=', idx)) + 1;
    const nearby = app.slice(propsStart, closeTagEnd);
    const zMatch = nearby.match(/z-\[(\d+)\]/) || nearby.match(/z-(\d+)\b/);
    ok(zMatch !== null, `the expand-log dialog must carry a z-index class, got: ${JSON.stringify(nearby)}`);
    const dialogZ = Number(zMatch![1]);
    ok(dialogZ > tourZ,
      `THE FIX: the expand-log dialog (z-${dialogZ}) must paint ABOVE the tour (z-${tourZ}), or the tour can cover it again`);
  }

  // round14: Account/Save/Edit/Feedback no longer carry their OWN z-index
  // class in App.tsx — they share ModalSurface's ONE overlay constant. Check
  // that shared constant instead of four separate (and now nonexistent)
  // per-dialog class strings; every converted dialog inherits whatever it says.
  const modalSurfaceSrc = readFileSync('src/components/ModalSurface.tsx', 'utf8');
  const overlayMatch = modalSurfaceSrc.match(/OVERLAY_CLASS = '[^']*z-\[(\d+)\]/);
  ok(overlayMatch !== null, "ModalSurface's OVERLAY_CLASS must carry a z-[N] class");
  const surfaceZ = Number(overlayMatch![1]);
  ok(surfaceZ > tourZ,
    `THE FIX must still hold: ModalSurface's shared overlay (z-${surfaceZ}) must paint ABOVE the tour (z-${tourZ})`);

  // MUTATION / NEGATIVE FIXTURE — the pre-fix Auth dialog's className,
  // verbatim (z-50, below the tour's z-[60]).
  const preFixAuthClassName = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none';
  const preFixZ = Number(preFixAuthClassName.match(/z-(\d+)\b/)![1]);
  ok(preFixZ < tourZ,
    'the pre-fix fixture must still sit BELOW the tour, or this fixture has stopped testing anything');
}

// ─────────────────────────────────────────────────────────────────────────────
// RED-APP-5 finding 004 (round 5): zero `aria-live`/`role="log"`/
// `role="status"` existed anywhere in the app — a screen-reader user got no
// announcement that a run started, paused, or converged. Fixed with a
// single hidden `aria-live="polite"` region that speaks on PHASE
// transitions only (never once per log line — see `liveStatus`'s own
// comment for why that distinction matters and how it is enforced).
// ─────────────────────────────────────────────────────────────────────────────
{
  ok(/aria-live="polite"\s+role="status"\s+className="sr-only"/.test(app),
    'a hidden aria-live="polite" role="status" region must exist in the render tree');
  ok(/prevSimPhaseRef/.test(app) && /phase === prevSimPhaseRef\.current\) return/.test(app),
    'the announcement must be GATED on a phase-transition guard, not fired on every render/log line');

  // The converged announcement must use the SAME gate as the visible
  // "Nash Equilibrium Reached" banner (simState.converged &&
  // simState.convergedIsNE !== false && !runStale && nearestNE) — see that
  // block's own comment on why `converged` alone is not enough (STATIONARY,
  // not "is an equilibrium"). If the two gates ever diverge, the
  // announcement could tell a screen-reader user an equilibrium was found
  // when the visible banner disagrees.
  const bannerIdx = app.indexOf('simState.converged && simState.convergedIsNE !== false && !runStale && nearestNE');
  ok(bannerIdx > 0, 'the visible convergence banner\'s gate condition must be found');
  const liveIdx = app.indexOf('const isConverged = simState.converged && simState.convergedIsNE !== false && !runStale && !!nearestNE;');
  ok(liveIdx > 0 && liveIdx < bannerIdx,
    'the live-status effect\'s convergence gate must use the identical condition (modulo the !! cast) and be defined before the banner');

  ok(/'Simulation running\.'/.test(app) && /'Simulation paused\.'/.test(app)
    && /strategy Nash equilibrium reached\./.test(app),
    'all three announced phases (running/paused/converged) must be present');

  // MUTATION / NEGATIVE FIXTURE — the pre-fix render root, verbatim (no live
  // region at all, exactly RED-APP-5's finding: zero aria-live/role="log"/
  // role="status" occurrences anywhere in the file).
  const preFixRoot = `  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col antialiased">
      {/* ── Heading Banner ── */}`;
  ok(!/aria-live="polite"\s+role="status"/.test(preFixRoot),
    'the pre-fix fixture text must not accidentally already carry a live region (fixture sanity check)');
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE-REGEN (round 6, 2026-09-03): "Regenerate scenario" announces its own
// loading/ready/error/kept/discarded state inside EACH dialog it appears in —
// a SECOND, dialog-scoped `role="status" aria-live="polite"` region, distinct
// from the app-wide phase announcer just above (which never mentions
// regeneration at all). Scoped to each dialog block with `extractDivBlock`,
// same pattern the tab-trap checks above use for these two dialogs.
// ─────────────────────────────────────────────────────────────────────────────
{
  // round14: these two moved from a hand-rolled div (which extractDivBlock
  // scoped into) to <ModalSurface id="...">...</ModalSurface> — see that
  // helper's own doc comment for why the extraction differs.
  const editDialog = extractModalSurfaceBlock(app, 'edit-saved-game');
  const saveDialog = extractModalSurfaceBlock(app, 'save-preset');
  // CodeRabbit finding (this branch): the two ok() calls below used to be
  // INDEPENDENT — one asserting the live-region markup exists ANYWHERE in
  // the dialog block, the other that the literal text "regen.note" appears
  // ANYWHERE in it. A dialog with an unrelated, empty status region PLUS a
  // `{regen.note}` reference sitting in some ordinary, non-live paragraph
  // elsewhere would satisfy both checks despite announcing nothing. Match
  // the actual status-region ELEMENT (its opening `role="status"
  // aria-live="polite"` tag through the next `</p>`) and require
  // `regen.note` to appear INSIDE that captured span specifically.
  const statusRegionRe = /<p\s+role="status"\s+aria-live="polite"[^>]*>([\s\S]*?)<\/p>/;
  for (const [label, block] of [['Edit', editDialog], ['Save', saveDialog]] as const) {
    const m = block.match(statusRegionRe);
    ok(!!m, `${label} dialog must carry its own <p role="status" aria-live="polite">...</p> region for regen announcements`);
    // STRUCT-REGEN-19/003c: the note the dialog announces is `regenView.note` —
    // the outcome of THIS dialog session, not whatever `regen` last held (a
    // preview stranded by a cancelled needs-auth jump belongs to a session that
    // is gone). Same assertion, against the value the JSX is now allowed to read.
    ok(!!m && /regenView\.note/.test(m[1]),
      `${label} dialog's status-region ELEMENT (not just the surrounding block) must render regenView.note`);
    ok(!/\{regen\.(note|status|preview|error)\b/.test(block),
      `${label} dialog must read the regen outcome through regenView (session-scoped), never the raw regen state`);
  }

  // MUTATION / NEGATIVE FIXTURE — a dialog block missing the live region
  // entirely must be caught, not silently pass because SOME dialog has one.
  const noLiveRegion = '<div aria-label="Save custom game"><p className="text-xs">{regenView.note}</p></div>';
  ok(!statusRegionRe.test(noLiveRegion),
    'fixture sanity: a status paragraph without role/aria-live must NOT satisfy the live-region check');

  // MUTATION / NEGATIVE FIXTURE — the exact defect CodeRabbit's finding
  // describes: a real live region present, but EMPTY, plus a `regen.note`
  // reference sitting in a completely unrelated, non-live paragraph. The
  // OLD independent-regex check would have passed this; the fixed check
  // must reject it because `regen.note` never appears inside the <p>...</p>
  // the status-region regex actually captures.
  const decoupledNote = '<div aria-label="Save custom game"><p role="status" aria-live="polite" className="sr-only">{someOtherStatus}</p><p className="text-xs">{regenView.note}</p></div>';
  const decoupledMatch = decoupledNote.match(statusRegionRe);
  ok(!!decoupledMatch && !/regenView\.note/.test(decoupledMatch[1]),
    'fixture sanity: a live region that does NOT itself contain regen.note must fail the (fixed) check, even though regen.note appears elsewhere in the block');
}

// CodeRabbit on #141 (second thread): the drawer's `drawer-games` focus
// landmark must exist in BOTH the populated list and the empty state — after
// the last saved game is deleted the list unmounts, and App's focus
// restoration would otherwise fall through to the page beneath the open
// drawer. e2e section 56(d) exercises it; this guard keeps the empty-state
// attribute from being tidied away.
//
// BLUE-LIST-14 (round14): the landmark now lives in the SHARED
// src/components/SavedGamesList.tsx, keyed dynamically by `variant`
// (`data-focus-fallback={landmark}`, not a literal string) — one component
// renders it in all THREE branches (not-owner, empty-but-owner, populated),
// for both the drawer ('drawer-games') and the sidebar ('saved-games').
{
  const menuDrawerSrc = readFileSync('src/components/MenuDrawer.tsx', 'utf8');
  const savedGamesListSrc = readFileSync('src/components/SavedGamesList.tsx', 'utf8');
  const landmarks = savedGamesListSrc.match(/data-focus-fallback=\{landmark\}\s*\n\s*tabIndex=\{-1\}/g) ?? [];
  ok(landmarks.length === 3,
    `SavedGamesList must mount the focus landmark in the not-owner, empty, and populated states (found ${landmarks.length})`);
  ok(/drawer: 'drawer-games'/.test(savedGamesListSrc) && /sidebar: 'saved-games'/.test(savedGamesListSrc),
    'SavedGamesList must map variant "drawer" to the "drawer-games" landmark id and "sidebar" to "saved-games"');
  ok(/<SavedGamesList[\s\S]{0,600}variant="drawer"/.test(menuDrawerSrc),
    'MenuDrawer must render SavedGamesList with variant="drawer"');
  const appSrc = readFileSync('src/App.tsx', 'utf8');
  ok(/<SavedGamesList[\s\S]{0,600}variant="sidebar"/.test(appSrc),
    'App must render SavedGamesList with variant="sidebar"');
  // OPUS-REVIEW-LIST N3 (round14 review of #150): all three branches emit
  // the IDENTICAL `data-focus-fallback={landmark}` token (it's keyed by a
  // variable, not a literal per branch), so a bare nearest-preceding-match
  // is not automatically "the drawer's" landmark by the text alone — it is
  // correct here only because "No saved custom game presets." is the
  // drawer-only half of the `variant === 'sidebar' ? ... : ...` ternary
  // inside THIS SAME div, with no other landmark occurrence between the
  // two (checked explicitly below, not just a distance bound).
  const emptyStateIdx = savedGamesListSrc.indexOf('No saved custom game presets.');
  const emptyLandmarkIdx = savedGamesListSrc.lastIndexOf('data-focus-fallback={landmark}', emptyStateIdx);
  const between = savedGamesListSrc.slice(emptyLandmarkIdx + 1, emptyStateIdx);
  ok(emptyStateIdx > 0 && emptyLandmarkIdx > 0 && emptyStateIdx - emptyLandmarkIdx < 1400,
    'the empty-state card itself (the one that says "No saved custom game presets.") must carry the drawer-games landmark');
  ok(!/data-focus-fallback=/.test(between),
    'no OTHER data-focus-fallback occurrence must sit between this landmark and "No saved custom game presets." — otherwise the nearest-match above could be pinning the WRONG branch\'s landmark');
}

// ─────────────────────────────────────────────────────────────────────────────
// RED-APP-16/003: every `<label>` in the app must be associated with a real
// control — `htmlFor`/`id`, or by wrapping the control — and no input's ONLY
// name source may be `placeholder` (a hint, not a label; it disappears once
// the user types). 24 of the app's 25 `<label>`s were unassociated and 15
// fields were placeholder-only; the fix is `src/utils/a11y.ts`'s shared
// `labelFor(scope, field)` id pairing, used at every text/number/password/
// email/textarea site, and a plain heading (not a `<label>`) for the few
// headings that caption a GROUP of buttons rather than one control.
// ─────────────────────────────────────────────────────────────────────────────
{
  /** Blanks out `/* ... *\/` block comments and `// ...` line comments
   *  (replacing with spaces, so byte offsets used in error messages stay
   *  meaningful) — this file's OWN prose repeatedly says things like
   *  "a real `<label>`", which a naive scan over raw source would flag as
   *  an unassociated label in a comment, not in JSX.
   *
   *  CodeRabbit CLI (this review): the old regex-only version was NOT
   *  quote-aware — MenuDrawer.tsx's own real
   *  `placeholder="e.g., https://nash-equilibrium.run.app"` contains a
   *  literal `//` INSIDE a string, which `\/\/[^\n]*` blanked from that
   *  point to end-of-line, erasing the placeholder's own closing quote and
   *  leaving `openTags`'s quote-tracker stuck "inside a string" for
   *  everything after — corrupting every check for the rest of the file.
   *  This walker tracks quote state (character-by-character, same
   *  backslash-escape handling as `openTags`) and only treats `//`/`/*` as
   *  a comment when OUTSIDE any quote. */
  function stripComments(src: string): string {
    let out = '';
    let i = 0;
    let q: string | null = null;
    while (i < src.length) {
      const c = src[i];
      if (q) {
        if (c === '\\' && i + 1 < src.length) { out += c + src[i + 1]; i += 2; continue; }
        out += c;
        if (c === q) q = null;
        i++;
        continue;
      }
      // CodeRabbit CLI (this review): a `'` immediately preceded by a word
      // character (e.g. "Player A's strategy", real JSX text in
      // MenuDrawer.tsx) is a contraction/possessive, not a string-literal
      // open — valid JS/TSX has no token that puts a bare `'` directly after
      // an identifier with no operator between them, so this can only be
      // prose. Treat it as a plain character; only `"`/`` ` `` and a `'` NOT
      // preceded by a word character open a real quoted span.
      if (c === "'" && /[A-Za-z0-9_]/.test(src[i - 1] ?? '')) { out += c; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        out += '  '; i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += (src[i] === '\n' ? '\n' : ' '); i++; }
        if (i < src.length) { out += '  '; i += 2; }
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  // CodeRabbit CLI (this review), isolated fixture: JSX text with a
  // possessive apostrophe (the real shape at MenuDrawer.tsx:321-323,
  // "Player A's strategy...") must not put the quote-tracker into a stuck
  // "inside a string" state that then hides a REAL comment (and whatever
  // bogus markup that comment contains) from every check downstream.
  {
    const fixture = [
      "const x = <p>Player A's strategy evolution over time.</p>;",
      "// <label>should be stripped, not real markup</label>",
      'const y = 1;',
    ].join('\n');
    const stripped = stripComments(fixture);
    ok(!/<label>should be stripped/.test(stripped),
      `stripComments must blank a real "//" comment that follows a possessive apostrophe in JSX text, not leave it (and its fake <label>) as live markup: ${JSON.stringify(stripped)}`);
    ok(/Player A's strategy/.test(stripped),
      'stripComments must leave the possessive apostrophe itself untouched (it is prose, not a comment or a string to blank)');
  }

  /** Every `<TAG ...>` opening tag matching `names`, with its FULL attribute
   *  string — consumed to the `>` at BRACE DEPTH 0, outside quotes.
   *
   *  OPUS-REVIEW-APP16 FIX-BEFORE-MERGE 1: the original `[^>]*` stopped at
   *  the first `>` inside the tag, which for nearly every real control in
   *  this app is the `>` of its OWN event handler arrow function
   *  (`onChange={e => ...}`) — every attribute written after the first
   *  handler, placeholder included, was invisible to both checkers below.
   *  `placeholderOnlyControls` on the pre-fix tree passed on a file
   *  (AdminDashboard.tsx) that violates its own stated invariant, because
   *  the ONE attribute it needed (`placeholder=`) never appeared in the
   *  truncated string it read. This walker tracks `{}` depth and skips over
   *  `"`/`'`/`` ` `` quoted spans (a `>` or unbalanced brace inside a string
   *  literal must not end the tag early or corrupt the depth count). */
  function openTags(src: string, names: string[]): { tag: string; attrs: string; index: number; end: number }[] {
    const out: { tag: string; attrs: string; index: number; end: number }[] = [];
    const re = new RegExp(`<(${names.join('|')})\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      let depth = 0;
      let q: string | null = null;
      for (; i < src.length; i++) {
        const c = src[i];
        // CodeRabbit CLI (this review): a backslash-escaped quote INSIDE a
        // quoted span (a handler like `setValue("a \"quoted\" value")`)
        // must not close the span early — skip the escaped character so the
        // real closing quote (and the tag's own `>`) are found correctly.
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) break;
      }
      // `i` is the index of the tag's own closing `>` (or src.length if
      // unterminated); +1 gives the offset the tag's BODY starts at.
      out.push({ tag: m[1], attrs: src.slice(m.index + m[0].length, i), index: m.index, end: i + 1 });
    }
    return out;
  }

  /** Tags whose `id=` genuinely gives a `<label htmlFor>` something to
   *  point at — HTML's own labelable-elements list, restricted to what
   *  this app uses, plus `DescriptionEditor` (verified below to forward its
   *  `id` prop straight to its own `<textarea>`). Every OTHER custom
   *  component's `id` (e.g. ModalSurface's dialog id: `expand-log`,
   *  `account`, `admin`, `drawer` — none ever targeted by an htmlFor)
   *  names a DIFFERENT DOM node, not a labelable control. */
  const LABELABLE_TAGS = ['input', 'textarea', 'select', 'button', 'meter', 'output', 'progress', 'DescriptionEditor'];
  /** Extracts the VALUE of a `name=` attribute from an attrs string,
   *  accepting all three valid JSX/TSX quoting styles — double-quoted,
   *  single-quoted, or a `{expr}` (CodeRabbit CLI, this review: the old
   *  double-quote-or-brace-only regexes at every id=/htmlFor= site silently
   *  missed `id='x'`/`htmlFor='x'` — valid TSX no checker below would ever
   *  catch a mismatch in). */
  function attrValue(attrs: string, name: string): string | undefined {
    const m = attrs.match(new RegExp(`\\b${name}=(?:"([^"]+)"|'([^']+)'|\\{([^}]+)\\})`));
    return m ? (m[1] ?? m[2] ?? m[3]).trim() : undefined;
  }
  /** Every `id=` VALUE on a labelable tag in `src` — used to check that an
   *  `htmlFor=` actually names a real, labelable control, not just that
   *  SOME element somewhere carries that id (CodeRabbit CLI, this review:
   *  "collectIdValues accepts IDs from all elements... a `<div id=...>`
   *  passes unassociatedLabels, but the label is not associated with a
   *  control"). */
  function collectIdValues(src: string): Set<string> {
    const ids = new Set<string>();
    for (const { attrs } of openTags(src, LABELABLE_TAGS)) {
      const v = attrValue(attrs, 'id');
      if (v !== undefined) ids.add(v);
    }
    return ids;
  }
  /** Every `htmlFor=` VALUE, but ONLY on a real `<label>` tag (CodeRabbit
   *  CLI, this review: "placeholderOnlyControls accepts an input when ANY
   *  tag has a matching htmlFor value" — an `htmlFor` on a non-label
   *  element names nothing real; only a genuine `<label>` can associate). */
  function collectHtmlForValues(src: string): Set<string> {
    const values = new Set<string>();
    for (const { attrs } of openTags(src, ['label'])) {
      const v = attrValue(attrs, 'htmlFor');
      if (v !== undefined) values.add(v);
    }
    return values;
  }

  /** Every `<label ...>` tag in `src` with no `htmlFor` AND no control
   *  (input/select/textarea) nested before its own `</label>` — OR an
   *  `htmlFor` whose value does not match any `id=` anywhere in the file
   *  (a dangling/mismatched pair, CodeRabbit CLI this review). */
  function unassociatedLabels(rawSrc: string): string[] {
    const src = stripComments(rawSrc);
    const idValues = collectIdValues(src);
    const violations: string[] = [];
    for (const { attrs, index, end } of openTags(src, ['label'])) {
      const hfValue = attrValue(attrs, 'htmlFor');
      if (hfValue !== undefined) {
        if (idValues.has(hfValue)) continue;
        violations.push(`<label${attrs}> at offset ${index} has htmlFor=${JSON.stringify(hfValue)} but no matching id= anywhere in the file (dangling)`);
        continue;
      }
      const bodyStart = end;
      const bodyEnd = src.indexOf('</label>', bodyStart);
      const body = bodyEnd > 0 ? src.slice(bodyStart, bodyEnd) : src.slice(bodyStart, bodyStart + 400);
      if (/<input\b|<select\b|<textarea\b/.test(body)) continue;
      violations.push(`<label${attrs}> at offset ${index} has no htmlFor and wraps no control`);
    }
    return violations;
  }

  /** Every `<input .../>`/`<textarea ...>` opening tag that carries
   *  `placeholder=` but no `aria-label=`/`aria-labelledby=`, and either no
   *  `id=` at all, or an `id=` whose value does not match any `htmlFor=`
   *  anywhere in the file (dangling/mismatched, CodeRabbit CLI this
   *  review) — i.e. nothing that COULD be a real accessible name besides
   *  the placeholder hint.
   *
   *  The one exception: `id={id}` — the EXACT shape `DescriptionEditor`'s
   *  textarea uses to forward a caller-supplied `id` PROP (its own file
   *  never contains the literal `labelFor(...)` value the caller passes,
   *  so it can never match any `htmlFor=` collected from THIS file — that
   *  pairing is cross-file, checked directly below by name for both call
   *  sites and the forwarded prop).
   *
   *  CodeRabbit CLI (this review): the `id === 'id'` exemption used to apply
   *  to EVERY scanned file — a new, unrelated component destructuring a
   *  prop named `id` and writing `id={id}` on a placeholder-only control
   *  would pass with no linked label or ARIA name at all. `filePath` scopes
   *  the exemption to `DescriptionEditor.tsx` specifically, the one file
   *  this shape is actually verified (by name, below) to be safe in. */
  function placeholderOnlyControls(rawSrc: string, filePath?: string): string[] {
    const src = stripComments(rawSrc);
    const htmlForValues = collectHtmlForValues(src);
    // aria-labelledby may point at ANY element (not just a labelable one —
    // unlike htmlFor, its target need not itself be a control), so this
    // collects every id= in the file regardless of tag.
    const allIds = new Set([...src.matchAll(/\bid=(?:"([^"]+)"|'([^']+)'|\{([^}]+)\})/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim()));
    const isDescriptionEditor = filePath?.endsWith('DescriptionEditor.tsx') ?? false;
    const violations: string[] = [];
    for (const { tag, attrs, index } of openTags(src, ['input', 'textarea'])) {
      if (!/\bplaceholder=/.test(attrs)) continue;
      // CodeRabbit CLI (this review): the old check exempted on bare
      // ATTRIBUTE PRESENCE — `aria-label=""` and a dangling/empty
      // `aria-labelledby=""` both passed with no real accessible name at
      // all. A real aria-label must be non-empty; a real aria-labelledby
      // must be non-empty AND every space-separated IDREF it lists must
      // resolve to an id= that actually exists somewhere in the file.
      const ariaLabel = attrValue(attrs, 'aria-label');
      if (ariaLabel !== undefined && ariaLabel.trim() !== '') continue;
      const ariaLabelledBy = attrValue(attrs, 'aria-labelledby');
      if (ariaLabelledBy !== undefined) {
        const refs = ariaLabelledBy.trim().split(/\s+/).filter(Boolean);
        if (refs.length > 0 && refs.every((r) => allIds.has(r))) continue;
      }
      const idValue = attrValue(attrs, 'id');
      if (idValue !== undefined) {
        if (idValue === 'id' && isDescriptionEditor) continue; // DescriptionEditor's forwarded-prop shape ONLY
        if (htmlForValues.has(idValue)) continue;
        violations.push(`<${tag}${attrs}> at offset ${index} has id=${JSON.stringify(idValue)} but no matching htmlFor= anywhere in the file (dangling)`);
        continue;
      }
      violations.push(`<${tag}${attrs}> at offset ${index} has placeholder but no aria-label/aria-labelledby/id`);
    }
    return violations;
  }

  // ── Known-positive fixtures — both shapes must be CAUGHT, proving the
  //    checkers do not just pass everything. ──
  ok(unassociatedLabels('<label className="x">Name</label><input value="" />').length === 1,
    'fixture: a sibling label+input with no htmlFor/id pair and no wrapping must be flagged (the exact RED-APP-16/003 shape)');
  ok(unassociatedLabels('<label htmlFor="a">Name</label><input id="a" />').length === 0,
    'fixture: an htmlFor/id pair must NOT be flagged');
  ok(unassociatedLabels('<label>Name<input value="" /></label>').length === 0,
    'fixture: a wrapping label must NOT be flagged (the other valid shape named in the brief)');
  ok(placeholderOnlyControls('<input placeholder="Game Name" />').length === 1,
    'fixture: an input named only by placeholder must be flagged (the pre-fix "Game Name" shape had none at all, but placeholder-only is the broader 15-field class)');
  ok(placeholderOnlyControls('<input id="a" placeholder="x" /><label htmlFor="a">Name</label>').length === 0,
    'fixture: a placeholder input that ALSO has a real htmlFor-linked label must NOT be flagged');
  ok(placeholderOnlyControls('<input aria-label="Name" placeholder="x" />').length === 0,
    'fixture: a placeholder input with its own aria-label must NOT be flagged (Row/Col Start Point keep this shape)');
  // OPUS-REVIEW-APP16 FIX-BEFORE-MERGE 1: the exact blind spot — an event
  // handler arrow function (its OWN `>`) appears BEFORE `placeholder=` in
  // the tag. The old `[^>]*` scan stopped at that `>` and never saw
  // `placeholder=` at all, so this fixture passed (wrongly) on the pre-fix
  // checker; `openTags`'s brace-aware scan must still see past it.
  ok(placeholderOnlyControls('<input onChange={e => setX(e.target.value)} placeholder="x" />').length === 1,
    'fixture: placeholder AFTER an arrow-function handler must still be flagged (the AdminDashboard/Go-to-step shape)');
  ok(placeholderOnlyControls('<input onChange={e => setX(e.target.value)} id="a" placeholder="x" /><label htmlFor="a">Name</label>').length === 0,
    'fixture: the same handler-then-placeholder shape, but WITH a real htmlFor-linked id, must NOT be flagged');

  // CodeRabbit CLI (this review): "An id alone does not give an input an
  // accessible name... a label with htmlFor="missing" also passes" — both
  // checkers must verify the VALUE matches, not just that either attribute
  // is merely present.
  ok(unassociatedLabels('<label htmlFor="missing">Name</label><input id="a" />').length === 1,
    'fixture: a label htmlFor pointing at an id that does not exist anywhere in the file must be flagged (dangling htmlFor)');
  // CodeRabbit CLI (this review): collectIdValues must not accept an id from
  // ANY element — a <label htmlFor> pointing at a non-labelable element's id
  // (a heading <div>, e.g. this app's own button-group headings) is not
  // really associated with a control, even though the two VALUES match.
  ok(unassociatedLabels('<label htmlFor="g">Name</label><div id="g">Group</div>').length === 1,
    'fixture: htmlFor matching a <div id> (not a labelable element) must still be flagged — a matching VALUE on the wrong TAG is not real association');
  ok(unassociatedLabels('<label htmlFor="g">Name</label><select id="g"><option /></select>').length === 0,
    'fixture: htmlFor matching a <select id> must NOT be flagged — select is a genuine labelable element');
  ok(unassociatedLabels('<label htmlFor="g">Name</label><DescriptionEditor id="g" />').length === 0,
    'fixture: htmlFor matching a <DescriptionEditor id> must NOT be flagged — its forwarded id reaches a real <textarea> (verified below, cross-file)');
  ok(unassociatedLabels('<label htmlFor="g">Name</label><ModalSurface id="g">x</ModalSurface>').length === 1,
    'fixture: htmlFor matching a <ModalSurface id> MUST be flagged — that id names the dialog itself (App.tsx\'s own expand-log/account/admin/drawer ids), never a labelable control, unlike DescriptionEditor');
  // CodeRabbit CLI (this review): valid TSX may single-quote an attribute
  // value (`id='g'`) — every id=/htmlFor= matcher must accept it, not just
  // double-quoted or `{expr}`.
  ok(unassociatedLabels(`<label htmlFor='g'>Name</label><input id='g' />`).length === 0,
    'fixture: a single-quoted htmlFor/id pair must NOT be flagged — single-quoted JSX attributes are valid TSX');
  ok(placeholderOnlyControls(`<input id='missing' placeholder="x" /><label htmlFor="a">Name</label>`).length === 1,
    'fixture: a single-quoted dangling id must still be flagged (proves the single-quote branch is actually consulted, not just accepted as a non-match)');
  // CodeRabbit CLI (this review): an escaped quote INSIDE a quoted attribute
  // span (a handler like `onChange={() => setValue("a \"b")}`, an ODD
  // number of escaped quotes so the naive tracker's quote parity never
  // recovers) used to leave the scanner permanently "inside a string" for
  // the rest of the source — the real closing `>` of THIS tag was never
  // found at depth 0, so the scan ran straight through it and swallowed the
  // ENTIRE next `<input>` tag (including its real `aria-label`) into this
  // tag's own attrs, wrongly exempting a placeholder-only control that has
  // no accessible name of its own.
  ok(placeholderOnlyControls(String.raw`<input onChange={() => setValue("a \"b")} placeholder="x" /><input aria-label="Other" placeholder="y" />`).length === 1,
    'fixture: a handler with an ODD count of escaped quotes must not swallow the NEXT tag\'s real aria-label into this tag\'s own attrs — only the first (unnamed) input should be flagged, not zero');
  // CodeRabbit CLI (this review): the old aria-label/aria-labelledby
  // exemption fired on bare ATTRIBUTE PRESENCE — an empty aria-label or a
  // dangling/empty aria-labelledby gave no real accessible name at all.
  ok(placeholderOnlyControls('<input aria-label="" placeholder="x" />').length === 1,
    'fixture: an EMPTY aria-label must still be flagged — presence alone is not a real accessible name');
  ok(placeholderOnlyControls('<input aria-labelledby="missing" placeholder="x" />').length === 1,
    'fixture: an aria-labelledby whose IDREF matches no id= anywhere in the file must be flagged (dangling, same class as htmlFor)');
  ok(placeholderOnlyControls('<input aria-labelledby="" placeholder="x" />').length === 1,
    'fixture: an EMPTY aria-labelledby must be flagged — no IDREF at all names nothing');
  ok(placeholderOnlyControls('<input aria-labelledby="g" placeholder="x" /><div id="g">Name</div>').length === 0,
    'fixture: an aria-labelledby whose IDREF resolves to a real id= (even on a non-labelable <div>, valid per the ARIA spec) must NOT be flagged');
  ok(placeholderOnlyControls('<input id="missing" placeholder="x" /><label htmlFor="a">Name</label>').length === 1,
    'fixture: a placeholder input\'s id pointing at an htmlFor that does not exist anywhere in the file must be flagged (dangling id)');
  ok(placeholderOnlyControls('<input id={id} placeholder="x" />', 'src/components/DescriptionEditor.tsx').length === 0,
    'fixture: id={id} in DescriptionEditor.tsx — its own forwarded-prop shape — must NOT be flagged even though nothing in ITS file names that value (checked cross-file, by name, below)');
  ok(placeholderOnlyControls('<input id={id} placeholder="x" />').length === 1,
    'fixture: the SAME id={id} shape with NO filePath (or a different file) must be flagged — the exemption is scoped to DescriptionEditor.tsx specifically, not any component that happens to destructure a prop named `id` (CodeRabbit CLI, this review)');
  ok(placeholderOnlyControls('<input id={id} placeholder="x" />', 'src/components/SomeOtherComponent.tsx').length === 1,
    'fixture: id={id} in an UNRELATED file must be flagged — the exemption must not accidentally generalize');
  // CodeRabbit CLI (this review): an htmlFor= on a NON-label tag names
  // nothing real — only a genuine <label> can associate. A decoy htmlFor
  // elsewhere in the file must not suppress a real placeholder-only
  // violation.
  ok(placeholderOnlyControls('<input id="a" placeholder="x" /><div htmlFor="a">Not a label</div>').length === 1,
    'fixture: an htmlFor on a non-<label> tag must NOT count as association — a placeholder-only input still gets flagged even when a decoy element elsewhere happens to carry a matching htmlFor');
  ok(placeholderOnlyControls('<input id="a" placeholder="x" /><label htmlFor="a">Name</label>').length === 0,
    'fixture: an htmlFor on a REAL <label> tag still associates normally (control, proves the label-scoping did not break the valid case)');
  // CodeRabbit CLI (this review): stripComments used to be regex-only, not
  // quote-aware — a real placeholder string containing "//" (a URL) was
  // itself treated as a line-comment START, blanking its own closing quote
  // and everything after it on that line (the exact MenuDrawer.tsx shape:
  // `placeholder="e.g., https://nash-equilibrium.run.app"`), corrupting
  // every check for the rest of the file.
  ok(placeholderOnlyControls('<input placeholder="e.g., https://example.com" />').length === 1,
    'fixture: a placeholder containing "//" (a URL) is STILL a placeholder-only control (no aria-label/id of its own) and must be flagged for that real reason — proves the "//" text itself was not silently blanked away along with everything meant to follow it');
  ok(placeholderOnlyControls('<input id="a" placeholder="e.g., https://example.com" /><label htmlFor="a">Name</label>').length === 0,
    'fixture: the SAME "//"-containing placeholder, but with a real htmlFor-linked label, must NOT be flagged — proves the quote-aware stripComments does not corrupt the tag\'s own later id= attribute');
  ok(unassociatedLabels('<input placeholder="e.g., https://example.com" /><label className="x">Name</label><input value="" />').length === 1,
    'fixture: a REAL violation AFTER a "//"-containing placeholder must still be caught — proves stripComments did not swallow the rest of the source into a phantom open string');

  // ── The real tree: walk every src/**/*.tsx file, both checkers, 0 violations. ──
  function walkTsx(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkTsx(p));
      else if (entry.name.endsWith('.tsx')) out.push(p);
    }
    return out;
  }
  const tsxFiles = walkTsx('src');
  ok(tsxFiles.length >= 13, `sanity: found a plausible number of .tsx files, got ${tsxFiles.length}`);
  const allLabelViolations: string[] = [];
  const allPlaceholderViolations: string[] = [];
  for (const file of tsxFiles) {
    const src = readFileSync(file, 'utf8');
    for (const v of unassociatedLabels(src)) allLabelViolations.push(`${file}: ${v}`);
    for (const v of placeholderOnlyControls(src, file)) allPlaceholderViolations.push(`${file}: ${v}`);
  }
  ok(allLabelViolations.length === 0, `every <label> in src/**/*.tsx must be associated: ${JSON.stringify(allLabelViolations)}`);
  ok(allPlaceholderViolations.length === 0, `no input's only name source may be placeholder: ${JSON.stringify(allPlaceholderViolations)}`);

  // ── MUTATION TEST — stripping the new htmlFor from the exact field
  //    RED-APP-16/003 named (the Edit dialog's "Game Name", which unlike
  //    the others has no placeholder at all — so on the real pre-fix tree
  //    this was the one hit an AX sweep actually saw) must be caught. ──
  const editGameNameSrc = readFileSync('src/App.tsx', 'utf8');
  const mutated = editGameNameSrc.replace(
    `htmlFor={labelFor('edit-game', 'name')} className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Game Name`,
    `className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Game Name`,
  );
  ok(mutated !== editGameNameSrc, 'mutation-test precondition: the Game Name label\'s htmlFor must be found and strippable');
  ok(unassociatedLabels(mutated).length === 1,
    'mutation-test: reverting the Edit dialog\'s Game Name htmlFor must be caught by unassociatedLabels');

  // ── DescriptionEditor forwards its `id` prop to the textarea (checked
  //    generically above via unassociatedLabels/placeholderOnlyControls
  //    treating any id= as associated), so the CROSS-file half of the pair
  //    — that both call sites actually PASS a real id, matching their
  //    label's htmlFor — is checked explicitly here by name. ──
  const descEditorSrc = readFileSync('src/components/DescriptionEditor.tsx', 'utf8');
  ok(/<textarea\s[\s\S]{0,40}id=\{id\}/.test(descEditorSrc),
    'DescriptionEditor\'s textarea must forward the id prop it declares (so a caller\'s htmlFor pairing actually reaches the DOM)');
  const editDescPair = /htmlFor=\{labelFor\('edit-game', 'description'\)\}[\s\S]{0,700}<DescriptionEditor\s[\s\S]{0,80}id=\{labelFor\('edit-game', 'description'\)\}/.test(app);
  ok(editDescPair, 'the Edit dialog\'s Game Description label and its DescriptionEditor must share the same labelFor id');
  const saveDescPair = /htmlFor=\{labelFor\('save-game', 'description'\)\}[\s\S]{0,700}<DescriptionEditor\s[\s\S]{0,80}id=\{labelFor\('save-game', 'description'\)\}/.test(app);
  ok(saveDescPair, 'the Save dialog\'s Game Description label and its DescriptionEditor must share the same labelFor id');

  // ── MUTATION TEST — stripping the `id` from a real placeholder-only field
  //    (the register form's Username, one of the original 15) must be
  //    caught by placeholderOnlyControls. ──
  const usernameMutated = app.replace(
    `id={labelFor('auth', 'username')}\n                      type="text"`,
    `type="text"`,
  );
  ok(usernameMutated !== app, 'mutation-test precondition: the Username input\'s id must be found and strippable');
  ok(placeholderOnlyControls(usernameMutated).length === 1,
    'mutation-test: reverting the Username field\'s id must be caught by placeholderOnlyControls');

  // ── MUTATION TEST — OPUS-REVIEW-APP16 FIX-BEFORE-MERGE 1's exact blind
  //    spot: the admin password field's `placeholder=` sits AFTER its own
  //    `onChange={e => ...}` handler, so the OLD `[^>]*` scan could never
  //    see it (unlike Username above, whose placeholder happens to sit
  //    before its first handler and so was already naive-visible). Stripping
  //    its `id` must be caught ONLY by the brace-aware `openTags` scan. ──
  const adminSrc = readFileSync('src/components/AdminDashboard.tsx', 'utf8');
  const adminMutated = adminSrc.replace(
    `id={labelFor('admin', 'password')}\n                  type="password"`,
    `type="password"`,
  );
  ok(adminMutated !== adminSrc, 'mutation-test precondition: the admin password input\'s id must be found and strippable');
  ok(placeholderOnlyControls(adminMutated).length === 1,
    'mutation-test: reverting the admin password field\'s id must be caught by placeholderOnlyControls (the naive [^>]* scan could not see this field at all)');
  // Sanity: the NAIVE (pre-fix) regex genuinely cannot see this field's
  // placeholder even on the UNMUTATED source — proves the fixture above is
  // exercising the real blind spot, not a shape the old scan already caught.
  const naiveAttrs = [...stripComments(adminSrc).matchAll(/<(input|textarea)\b([^>]*)>/g)]
    .map((m) => m[2]).find((a) => /type="password"/.test(a));
  ok(naiveAttrs !== undefined && !/\bplaceholder=/.test(naiveAttrs),
    `fixture precondition: the naive [^>]* regex must NOT see 'placeholder=' on the admin password tag (proves this is the real blind spot), got: ${JSON.stringify(naiveAttrs)}`);
}

console.log(`a11yfixes.test.ts: ${checks} checks passed`);

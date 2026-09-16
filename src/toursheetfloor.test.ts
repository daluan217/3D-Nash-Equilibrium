/**
 * Guards the tour sheet's PIXEL floor. The cap used to be a bare percentage of
 * the viewport height, so a short screen produced a card shorter than its own
 * footer: Back and Next painted below the fold with no scroll box to reach them
 * and the tour could not be advanced at all (280px at 300% zoom = a 93x281
 * layout viewport; §97 measures that end-to-end in a browser). This pins the
 * arithmetic, and pins that the floor does NOT move any real phone.
 *
 *   npx tsx src/toursheetfloor.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tourSheetMaxPx } from './components/Walkthrough.js';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ' -- ' + detail : ''}`); failures++; }
};

// The floor exists because of this: the un-floored value at these heights is
// smaller than the card's own footer, which is what put Back below the fold.
for (const vh of [281, 320, 360, 400, 480]) {
  const unfloored = Math.round(vh * 0.32);
  check(`vh=${vh}: the raw percentage really is too short to hold the footer (${unfloored}px < 168px)`,
    unfloored < 168, `${unfloored}`);
  check(`vh=${vh}: the cap is floored to 168px`, tourSheetMaxPx(vh) === 168, `${tourSheetMaxPx(vh)}`);
}

// A floor that also changed ordinary phones would be a silent redesign of the
// tour on every device anyone actually owns. These are the real layout heights.
for (const [vh, expected] of [[560, 179], [600, 192], [667, 213], [700, 224], [720, 274],
                              [800, 304], [844, 321], [896, 340], [1024, 389]] as const) {
  check(`vh=${vh}: unchanged by the floor (still the percentage, ${expected}px)`,
    tourSheetMaxPx(vh) === expected, `${tourSheetMaxPx(vh)}`);
}

// 525px is where the two rules meet; below it the floor binds, above it does not.
check('the floor stops binding at 525px, where the percentage overtakes it',
  tourSheetMaxPx(525) === 168 && tourSheetMaxPx(530) === 170,
  `${tourSheetMaxPx(525)}/${tourSheetMaxPx(530)}`);

// The floor must never exceed the viewport: a 100px-tall window may not be
// handed a 168px card, or the placement maths goes negative.
for (const vh of [0, 40, 100, 150, 200]) {
  check(`vh=${vh}: the cap never exceeds the viewport minus its gaps`,
    tourSheetMaxPx(vh) <= Math.max(vh - 32, 0), `${tourSheetMaxPx(vh)}`);
}

// The floor is only half the fix: the card's contents need a scroll box, or a
// long caption pushes the footer out of the floored card just the same.
const src = readFileSync('src/components/Walkthrough.tsx', 'utf8');
check('the card contents are wrapped in one scroll box driven by `scrolls`',
  (src.match(/\$\{scrolls \? ' overflow-y-auto' : ''\}/g) || []).length === 1
  && /flex flex-col min-h-0[^`]*\$\{scrolls \? ' overflow-y-auto' : ''\}/.test(src));
// The box is a keyboard-reachable region exactly while it scrolls, and never on
// the inert measuring probe (which is aria-hidden and must stay untabbable).
// `scrolls` means the card is CAPPED, not that the body overflows it: 14 of 19
// steps fit on a plain 390x844 phone and were still named a focusable
// "scrollable" region -- a tab stop that does nothing. The tab stop now follows
// MEASURED overflow, and the probe is still excluded.
check('a tour body is focusable and named only when it MEASURABLY overflows, and never the probe',
  /tabIndex=\{scrolls && !probe && bodyOverflows \? 0 : undefined\}/.test(src)
  && /role=\{scrolls && !probe && bodyOverflows \? 'region' : undefined\}/.test(src)
  && /aria-label=\{scrolls && !probe && bodyOverflows \? '[^']+' : undefined\}/.test(src));
check('the overflow flag is measured from the DOM, not inferred from the cap',
  /setBodyOverflows\(el\.scrollHeight > el\.clientHeight \+ 1\)/.test(src)
  && /new ResizeObserver\(sync\)/.test(src)
  && /for \(const child of el\.children\) ro\.observe\(child\)/.test(src));
check('the footer may wrap, so Back cannot be pushed off the left edge at 61px',
  /flex flex-wrap items-center justify-end gap-2/.test(src));
// `sheetMaxVh` may appear exactly once outside its own declaration: inside
// tourSheetMaxPx. A second use means a call site went back to the raw ratio and
// silently lost the floor -- which is how the placement and the rendered
// maxHeight disagreed before.
check('the raw ratio is used in exactly one place: the floored helper itself',
  src.split('sheetMaxVh(').length - 1 === 1,
  `${src.split('sheetMaxVh(').length - 1} call sites`);

// The start-point grid's breakpoint. §100 measures that the VALUE fits below it
// (in a browser, where the gutter and font are real); what it cannot show
// cheaply is that the two columns survive ABOVE it. A pair that quietly became
// one column on every desktop would pass every reflow check ever written.
const app = readFileSync('src/App.tsx', 'utf8');
const gridCls = app.match(/<div className="grid grid-cols-2 ([^"]*)gap-4">/);
check('the start-point fields are still a 2-column grid by default', gridCls !== null);
// Read the breakpoint OUT of App.tsx and check it against the measurement, so
// a narrower literal fails here. Asserting 324 === 324 over five in-file
// constants was a tautology no source change could break (ds-rev finding E).
// The floor is 106px of cell: 10px left padding + a 40px stepper gutter + 56px
// of rendered "0.217"; real cells measured 74px@260, 104px@320, 139px@390, so
// linear interpolation puts a 106px cell at ~324px.
const bpMatch = !!gridCls && gridCls[1].match(/max-\[(\d+)px\]:grid-cols-1/);
const bp = bpMatch ? Number(bpMatch[1]) : 0;
const floorWidth = Math.round(320 + (106 - 104) * (390 - 320) / (139 - 104));
check('they collapse below a max-[Npx] breakpoint, not a media query that drifted away',
  bp > 0, gridCls ? gridCls[1] : 'no match');
check('the breakpoint is not BELOW the width where a cell reaches the 106px floor',
  bp >= floorWidth, `breakpoint=${bp} floor=${floorWidth}`);
check('auto-fit was not reintroduced (it invented empty 0px tracks at 390 and 1024)',
  !/repeat\(auto-fit[^)]*\)\)\] gap-4">/.test(app));

if (failures) { console.error(`\ntoursheetfloor.test.ts: ${failures} failed`); process.exit(1); }
console.log('✓ layout floors: 5 short heights floored, 9 real devices unchanged, the 525px crossover, viewport clamp, three tour source invariants, and the start-point grid breakpoint');

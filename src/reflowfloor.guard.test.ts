/**
 * Guards the narrow-width reflow block in src/index.css — the CONTAINMENT and
 * the non-regression side that a browser check cannot see cheaply.
 *
 * §100/§101 measure behaviour below 220px. What they cannot show is that these
 * rules stay BELOW 220px: every one of them overrides something the normal
 * layout depends on (a sticky header, a fixed-corner button, a padding reserve),
 * so a rule that leaked out of the media query would change every desktop.
 * That is a text fact about one file, checked here instead of by booting a
 * browser at nine widths.
 *
 *   npx tsx src/reflowfloor.guard.test.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ' -- ' + detail : ''}`); failures++; }
};

const css = readFileSync('src/index.css', 'utf8');

// Extract the one @media (max-width: 220px) block by brace matching, so the
// test reads the real block rather than a line range that shifts with edits.
const open = css.indexOf('@media (max-width: 220px)');
check('the narrow-width reflow block exists', open >= 0);
let depth = 0, end = -1;
for (let i = css.indexOf('{', open); i < css.length; i += 1) {
  if (css[i] === '{') depth += 1;
  else if (css[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
}
check('the block is brace-balanced', end > open);
const block = css.slice(open, end + 1);
const outside = css.slice(0, open) + css.slice(end + 1);

// Each of these overrides normal layout. Outside the query they would apply at
// EVERY width: a static header (the sticky feature gone), a feedback pill in
// flow instead of its corner, dialog rows wrapping on a desktop.
for (const [name, needle] of [
  ['the sticky-header release', 'header.sticky { position: static; }'],
  ['the feedback pill returning to flow', 'button.fixed.bottom-4.left-4 {'],
  ['the dialog flex-row release', '[role="dialog"] .flex:not(.flex-col) > * { min-width: 0; }'],
  ['the padding reclaim', '[class^="p-"], [class*=" p-"]'],
  ['the keeps-clear vertical reserve', '[data-keeps-clear] {'],
] as const) {
  check(`${name} is inside the 220px block`, block.includes(needle), needle);
  check(`${name} does NOT also apply at every width`, !outside.includes(needle), needle);
}

// The reserve exemption must stay attached to the padding reclaim: without the
// `:not()`, the reclaim eats the gap an absolutely-positioned control sits in
// and the tour's close button lands on the step counter.
check('the padding reclaim still exempts [data-keeps-clear]',
  /\[class\*=" pr-"\]\)\s*:not\(\[data-keeps-clear\]\)/.test(block));

// The icon carve-out: releasing `shrink-0` wholesale squeezed an 11px icon to
// 4.8px (ds-rev finding 5). SVGs must keep their size.
check('SVGs are exempt from the shrink-0 release',
  /svg\.shrink-0/.test(block) && /\.shrink-0:not\(svg\)/.test(block));

// The boundary-anchored selector: a bare [class*="p-"] also matches gap-*,
// top-1/2 and tap-24, which shredded 25 labels when it was tried. Comments are
// stripped first — this block explains that mistake in prose, and matching the
// prose instead of the CSS is exactly the false pass the check exists to avoid.
const decls = block.replace(/\/\*[\s\S]*?\*\//g, '');
check('padding is matched on a class BOUNDARY, never a bare substring',
  !/\[class\*="p-"\]/.test(decls) && decls.includes('[class^="p-"]'));

// The range hint the numeric fields show is DERIVED from the shared range
// constant, but the e2e that asserts it hard-codes the rendered string. Editing
// PAYOFF_RANGE.label would move the app and leave the e2e asserting the old
// text — red for the wrong reason, or quietly agreeing if both were edited to
// differ from what the field actually clamps to. This pins the two together.
const app = readFileSync('src/App.tsx', 'utf8');
const engine = readFileSync('src/utils/gameEngine.ts', 'utf8');
const smoke = readFileSync('src/e2e/smoke.mjs', 'utf8');
check('the hint is built from the range constant, not a literal',
  /const rangeHint = \(range: \{ label: string \}\) => `Range: \$\{range\.label\}\.`/.test(app));
const label = engine.match(/PAYOFF_RANGE = \{[^}]*label: '([^']+)'/)?.[1];
check('PAYOFF_RANGE still declares a label', !!label, String(label));
check("the e2e's hard-coded hint matches what the constant renders",
  smoke.includes(`const RANGE_HINT = 'Range: ${label}.'`),
  `constant says "${label}"`);

if (failures) { console.error(`\nreflowfloor.guard.test.ts: ${failures} failed`); process.exit(1); }
console.log('✓ reflow floor: 5 overrides contained to the 220px block and absent outside it, '
  + 'reserve exemption, SVG carve-out, boundary-anchored padding selector, '
  + 'and the range hint the e2e asserts is the one the range constant renders');

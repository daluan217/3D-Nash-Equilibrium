/**
 * Structural regression guards for two RED-APP-4 findings (round 4):
 *
 * - 007 (axe SERIOUS "scrollable-region-focusable"): the Simulation Log's
 *   scroll container had no tabindex and no focusable content, so a
 *   keyboard-only user could not Tab into it and scroll with arrow keys.
 * - 004 (visual, 320px): the Payoff Matrix row/col label cells broke a long
 *   label mid-word at a 320px viewport. The layout half is verified in
 *   src/e2e/smoke.mjs §17 (a browser is needed to observe actual wrapping);
 *   this file checks the DECIDABLE static half — that the narrow-viewport
 *   font-size class is actually present on all four label cells, and that
 *   the payoff-input columns are untouched (the fix must not reopen the
 *   WCAG-24px input-width regression the 72px column cap was chosen to
 *   prevent — confirmed empirically, see the finding's blue-note, that
 *   widening the label COLUMN has no effect on wrapping at all, so this fix
 *   deliberately never touches column widths).
 *
 *   npx tsx src/logandlabelfixes.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

const app = readFileSync('src/App.tsx', 'utf8');

/**
 * The JSX opening tag (attributes only, `<div ... >`) that CONTAINS byte
 * offset `refIdx`.
 *
 * CodeRabbit finding (this branch): slicing forward to `{logLines}` instead
 * pulled in the element's own CHILDREN too — a descendant carrying
 * `tabIndex`/`aria-label` (a log line, say) would satisfy the assertions
 * below while the scroll container with the `ref` itself has neither, and
 * the keyboard-focus defect this file exists to catch would silently
 * return. Anchoring on the nearest `<` before the ref and the nearest `>`
 * after it isolates exactly the opening tag's own attributes.
 */
function openingTagAt(src: string, refIdx: number): string {
  const start = src.lastIndexOf('<', refIdx);
  const end = src.indexOf('>', refIdx);
  return src.slice(start, end + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 007 — both the compact and expanded Simulation Log containers.
// ─────────────────────────────────────────────────────────────────────────────
{
  const compactIdx = app.indexOf('ref={logsContainerRef}');
  ok(compactIdx > 0, 'the compact log container (logsContainerRef) must be found');
  const compactTag = openingTagAt(app, compactIdx);
  ok(/tabIndex=\{0\}/.test(compactTag), `the compact log container's OWN opening tag must carry tabIndex={0}, got: ${JSON.stringify(compactTag)}`);
  ok(/role="region"/.test(compactTag), 'the compact log container must carry role="region" (a bare div does not support an accessible name)');
  ok(/aria-label="Simulation log"/.test(compactTag), 'the compact log container must carry an aria-label');

  const expandedIdx = app.indexOf('ref={logsExpandedRef}');
  ok(expandedIdx > 0, 'the expanded log container (logsExpandedRef) must be found');
  const expandedTag = openingTagAt(app, expandedIdx);
  ok(/tabIndex=\{0\}/.test(expandedTag), `the expanded log container's OWN opening tag must carry tabIndex={0}, got: ${JSON.stringify(expandedTag)}`);
  ok(/role="region"/.test(expandedTag), 'the expanded log container must carry role="region"');
  ok(/aria-label="Simulation log"/.test(expandedTag), 'the expanded log container must carry an aria-label');
}

// ─────────────────────────────────────────────────────────────────────────────
// Isolation self-check for `openingTagAt` — the exact shape CodeRabbit's
// finding warned about: attributes present on a DESCENDANT, absent from the
// element with the ref. Proves the function isolates the right tag rather
// than merely looking plausible against the real (already-fixed) source.
// ─────────────────────────────────────────────────────────────────────────────
{
  const decoy = '<div ref={x}><span tabIndex={0} role="region" aria-label="Simulation log" /></div>';
  const decoyRefIdx = decoy.indexOf('ref={x}');
  const decoyTag = openingTagAt(decoy, decoyRefIdx);
  ok(decoyTag === '<div ref={x}>', `openingTagAt must isolate ONLY the ref-bearing opening tag, got: ${JSON.stringify(decoyTag)}`);
  ok(!/tabIndex=\{0\}/.test(decoyTag) && !/role="region"/.test(decoyTag) && !/aria-label=/.test(decoyTag),
    'the isolated tag must NOT pick up attributes that only exist on a descendant — this is the exact defect the old (unanchored) slice missed');
}

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 004 — the four row/col label cells in the Payoff Matrix.
// ─────────────────────────────────────────────────────────────────────────────
{
  const narrowClass = 'max-[380px]:text-[10.5px]';
  const labelSites = [
    'title={activeLabels.col1}',
    'title={activeLabels.col2}',
    'title={activeLabels.row1}',
    'title={activeLabels.row2}',
  ];
  for (const site of labelSites) {
    const idx = app.indexOf(site);
    ok(idx > 0, `label call site for ${site} must be found`);
    const tagStart = app.lastIndexOf('<div', idx);
    const tag = app.slice(tagStart, idx);
    ok(tag.includes(narrowClass), `the label cell at ${site} must carry ${narrowClass}, got: ${JSON.stringify(tag)}`);
    ok(tag.includes('break-words'), `the label cell at ${site} must keep break-words as the fallback`);
  }

  // THIS fix (RED-APP-4/004) must never touch the payoff-input grid's own
  // LABEL column — the ORIGINAL 72px cap (re-verified against three
  // mobile.mjs profiles) stays exactly as it was; only the label column's
  // own font size (checked above) carries this fix.
  //
  // RED-APP-6/004 (a later, separate fix) DID legitimately change the other
  // two tracks — bare `1fr` (== `minmax(auto, 1fr)`) let an unbreakable
  // 40-char label force the whole grid past a 320px viewport (WCAG 1.4.10);
  // both non-label tracks are now `minmax(0, 1fr)`, matching what the
  // per-cell payoff-pair grid already did. So this check now anchors on the
  // one thing THIS finding actually protects — the 72px label-column cap —
  // rather than the whole template staying byte-identical forever.
  // CodeRabbit finding (this branch): the old check searched the WHOLE
  // file for `grid-cols-[minmax(0,72px)_...] max-[` in that order, so a
  // narrow-viewport override placed BEFORE the base class in the same
  // className (Tailwind applies classes by specificity, not by their
  // position in the string, so `max-[380px]:grid-cols-... grid-cols-[...]`
  // is exactly as live as the reverse) would satisfy it while still
  // reintroducing the regression. Isolate the SPECIFIC element's own
  // className (found via its `data-tour="matrix"` anchor, not a whole-file
  // search) and check for the override ANYWHERE inside that one class list.
  const matrixGridIdx = app.indexOf('data-tour="matrix"');
  ok(matrixGridIdx > 0, 'the outer matrix grid element must be found by its data-tour anchor');
  const matrixGridClassMatch = app.slice(matrixGridIdx, matrixGridIdx + 300).match(/className="([^"]*)"/);
  ok(matrixGridClassMatch !== null, 'the outer matrix grid element must carry a className attribute');
  const matrixGridClasses = matrixGridClassMatch![1];
  ok(matrixGridClasses.includes('grid-cols-[minmax(0,72px)_'),
    `the outer matrix grid's label column must keep its minmax(0,72px) cap, got: ${JSON.stringify(matrixGridClasses)}`);
  ok(!/max-\[[^\]]*\]:grid-cols-/.test(matrixGridClasses),
    `the outer matrix grid must not carry a narrow-viewport grid-cols override anywhere in its class list, `
    + `regardless of position relative to the base class (measured to have no effect; do not reintroduce it) -- `
    + `got: ${JSON.stringify(matrixGridClasses)}`);
}

console.log(`logandlabelfixes.test.ts: ${checks} checks passed`);

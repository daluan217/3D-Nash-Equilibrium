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

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 007 — both the compact and expanded Simulation Log containers.
// ─────────────────────────────────────────────────────────────────────────────
{
  const compactIdx = app.indexOf('ref={logsContainerRef}');
  ok(compactIdx > 0, 'the compact log container (logsContainerRef) must be found');
  const compactBlock = app.slice(compactIdx, app.indexOf('>', app.indexOf('{logLines}', compactIdx)));
  const compactTag = app.slice(compactIdx - 20, app.indexOf('{logLines}', compactIdx));
  ok(/tabIndex=\{0\}/.test(compactTag), 'the compact log container must carry tabIndex={0}');
  ok(/aria-label="Simulation log"/.test(compactTag), 'the compact log container must carry an aria-label');

  const expandedIdx = app.indexOf('ref={logsExpandedRef}');
  ok(expandedIdx > 0, 'the expanded log container (logsExpandedRef) must be found');
  const expandedTag = app.slice(expandedIdx - 20, app.indexOf('{logLines}', expandedIdx));
  ok(/tabIndex=\{0\}/.test(expandedTag), 'the expanded log container must carry tabIndex={0}');
  ok(/aria-label="Simulation log"/.test(expandedTag), 'the expanded log container must carry an aria-label');

  void compactBlock; // kept for readability of the slice above, not asserted on directly
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

  // The fix must never touch the payoff-input grid's own column widths —
  // the ORIGINAL 72px cap (re-verified against three mobile.mjs profiles)
  // stays exactly as it was.
  ok(app.includes('grid-cols-[minmax(0,72px)_1fr_1fr]'),
    'the outer matrix grid column template must be untouched by this fix');
  ok(!/grid-cols-\[minmax\(0,72px\)_1fr_1fr\]\s+max-\[/.test(app),
    'the outer matrix grid must not carry a narrow-viewport column-width override (measured to have no effect; do not reintroduce it)');
}

console.log(`logandlabelfixes.test.ts: ${checks} checks passed`);

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
import { readFileSync } from 'node:fs';

let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

const app = readFileSync('src/App.tsx', 'utf8');
const css = readFileSync('src/index.css', 'utf8');

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

  // The other 5 flagged controls.
  ok(app.includes(`aria-label="Row Start Point (x0)"`), 'the x0 input must carry an aria-label');
  ok(app.includes(`aria-label="Col Start Point (y0)"`), 'the y0 input must carry an aria-label');
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
// FINDING 006 (axe SERIOUS "color-contrast" rule): the app-wide muted-text
// idiom (2.51:1 light / 3.74-4.23:1 dark) and several `text-player-a-500`
// running-text call sites (3.63-3.8:1) were all under the 4.5:1 AA floor;
// the active "Player A" toggle button (white on bg-player-a-500) was 3.8:1.
// ─────────────────────────────────────────────────────────────────────────────
{
  // The new tokens exist and are DEFINED FROM the measured-safe slate steps
  // (slate-600 on slate-50/white = 7.25:1/7.58:1; slate-400 on slate-900/950
  // = 6.78:1/7.66:1 — real margin above 4.5:1, not a knife-edge value).
  ok(/--color-muted:\s*var\(--color-slate-600\)/.test(css), 'the --color-muted token must resolve to slate-600');
  ok(/--color-muted-dark:\s*var\(--color-slate-400\)/.test(css), 'the --color-muted-dark token must resolve to slate-400');

  // The exact failing idiom must be GONE from every file it appeared in —
  // not just App.tsx, since it was the SAME design-system idiom in each.
  for (const path of [
    'src/App.tsx', 'src/components/AdminDashboard.tsx', 'src/components/MenuDrawer.tsx',
    'src/components/DescriptionEditor.tsx', 'src/components/DownloadModal.tsx',
  ]) {
    const src = readFileSync(path, 'utf8');
    ok(!src.includes('text-slate-400 dark:text-slate-500'),
      `${path} must no longer use the failing text-slate-400 dark:text-slate-500 pairing`);
  }

  // The running-text player-a-500 instances (row/col headers, payoff-A input
  // text, coordinate/legend labels) must be gone; only the two documented
  // HOVER-state exceptions (text-slate-400 hover:text-player-a-500 — passes
  // at REST, only changes color on interaction, which axe's static snapshot
  // does not evaluate as failing) may remain.
  const staticPlayerA500 = [...app.matchAll(/(?<!hover:)text-player-a-500(?!['"]?\s*:)/g)]
    .filter((m) => !app.slice(Math.max(0, m.index! - 20), m.index!).includes('hover:'));
  ok(staticPlayerA500.length === 0,
    `no STATIC text-player-a-500 running-text call site may remain, found ${staticPlayerA500.length}`);

  // The active "Player A" toggle buttons must use the SAME -600 step already
  // established for Player B's identical button (bg-player-b-600), not -500.
  ok(!app.includes("'bg-player-a-500 text-white border-player-a-500'"),
    'the Player A active-toggle button must no longer use the failing bg-player-a-500/white pairing');
  const activeButtonCount = [...app.matchAll(/'bg-player-a-600 text-white border-player-a-600'/g)].length;
  ok(activeButtonCount === 2, `both Player A active-toggle buttons must use bg-player-a-600, found ${activeButtonCount}`);
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

console.log(`a11yfixes.test.ts: ${checks} checks passed`);

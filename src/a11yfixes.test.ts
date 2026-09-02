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

// ─────────────────────────────────────────────────────────────────────────────
// RED-APP-5 finding 001 (round 5): the "Edit saved game" dialog
// (`isEditModalOpen`) was missing from BOTH the "close whichever foreground
// modal is open on Escape" effect's condition chain AND its dependency array
// — every other modal (Feedback, Save, Auth, and #90's expand-log dialog)
// closes on Escape; Edit was simply never added to the list, so pressing
// Escape while it was open did nothing. Playwright-verified before this fix
// (`probe_edit_escape.mjs`, in RED-APP-5's worktree): Edit dialog stayed
// visible after Escape while the Save modal control closed correctly in the
// same run.
// ─────────────────────────────────────────────────────────────────────────────
{
  const start = app.indexOf('Close whichever foreground modal is open on Escape');
  ok(start > 0, 'the Escape-close effect must be found by its own comment');
  const end = app.indexOf('}, [', start) + 400;
  const block = app.slice(start, end);
  // A slice that silently went empty (or picked up the wrong effect) would
  // pass every assertion below vacuously.
  ok(block.includes('onKeyDown') && block.includes("e.key !== 'Escape'"),
    'the slice under test must actually be the Escape-close effect');

  ok(/else if \(isEditModalOpen\)\s*\{\s*setIsEditModalOpen\(false\);\s*setEditError\(''\);\s*\}/.test(block),
    `THE FIX: isEditModalOpen must be in the condition chain with the SAME close side-effects `
    + `its own "✕" button and backdrop use, got: ${JSON.stringify(block)}`);

  // The dependency array (the second `}, [...]);` after the comment) must
  // list isEditModalOpen too, or React would keep calling a stale closure
  // that never sees the dialog open — the classic "added to the branch but
  // not the deps" half of this exact defect class.
  const depsMatch = block.match(/\}, \[([^\]]*)\]\);/);
  ok(depsMatch !== null, 'the effect\'s dependency array must be found');
  const deps = (depsMatch![1] || '').split(',').map((s) => s.trim());
  ok(deps.includes('isEditModalOpen'),
    `isEditModalOpen must be in the Escape effect's dependency array, got [${deps.join(', ')}]`);
  // And the pre-existing three modals must still be there — this fix adds a
  // branch, it does not replace the others.
  for (const dep of ['isFeedbackOpen', 'isSaveModalOpen', 'isAuthModalOpen']) {
    ok(deps.includes(dep), `${dep} must still be in the Escape effect's dependency array`);
  }

  // MUTATION / NEGATIVE FIXTURE — the defect itself, verbatim. If this
  // pattern could not tell the pre-fix effect apart from the fixed one, the
  // checks above would be worthless.
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
  ok(!/isEditModalOpen/.test(preFix),
    'the pre-fix fixture text must not accidentally already mention isEditModalOpen (fixture sanity check)');
}

// ─────────────────────────────────────────────────────────────────────────────
// RED-APP-5 finding 002 (round 5): four of the five `role="dialog"
// aria-modal="true"` surfaces (Feedback, Auth, Save, Edit) had no Tab trap
// at all — only the expand-log dialog (#90) did. Repeatedly pressing Tab
// walked focus onto the page behind the backdrop and could open a SECOND
// aria-modal dialog on top of the still-open first one
// (`probe_nested_collision.mjs`, RED-APP-5's worktree). Fixed with a shared
// `useModalTabTrap` hook wired to all four. This is the DECIDABLE half — the
// e2e Playwright regression (src/e2e/smoke.mjs section 20) is the real
// behavioral proof, exercised against the Feedback dialog.
// ─────────────────────────────────────────────────────────────────────────────
{
  ok(/function useModalTabTrap\(/.test(app), 'the shared useModalTabTrap hook must exist');
  const hookIdx = app.indexOf('function useModalTabTrap(');
  ok(hookIdx > 0 && hookIdx < app.indexOf('export default function App()'),
    'useModalTabTrap must be a module-level hook, defined before the App component');

  // Each of the four dialogs: the hook is called with that dialog's OWN
  // open-state and its OWN ref (not, say, all four wired to the same ref by
  // a copy-paste slip — a mistake this exact pairing check would catch).
  const wiring: Array<[string, string, string]> = [
    ['Feedback', 'isFeedbackOpen', 'feedbackDialogRef'],
    ['Auth', 'isAuthModalOpen', 'authDialogRef'],
    ['Save', 'isSaveModalOpen', 'saveDialogRef'],
    ['Edit', 'isEditModalOpen', 'editDialogRef'],
  ];
  for (const [name, openVar, refVar] of wiring) {
    ok(new RegExp(`useModalTabTrap\\(${openVar}, ${refVar}\\)`).test(app),
      `${name} dialog must call useModalTabTrap(${openVar}, ${refVar})`);
  }
  // No two dialogs may share a ref — each hook call needs the RIGHT
  // container to search for focusables in, or the trap would confine Tab to
  // the wrong (possibly unmounted) dialog.
  const refNames = wiring.map(([, , r]) => r);
  ok(new Set(refNames).size === refNames.length,
    `each dialog must have its own distinct ref, got [${refNames.join(', ')}]`);

  // Each dialog's `role="dialog"` element must actually carry the matching
  // ref attribute — calling the hook with a ref nothing attaches to would
  // leave `containerRef.current` null forever and the hook a no-op.
  const dialogBlocks: Array<[string, string, string]> = [
    ['Feedback', 'aria-label="Send feedback"', 'feedbackDialogRef'],
    ['Auth', 'aria-label="Account"', 'authDialogRef'],
    ['Save', 'aria-label="Save custom game"', 'saveDialogRef'],
    ['Edit', 'aria-label="Edit saved game"', 'editDialogRef'],
  ];
  for (const [name, label, refVar] of dialogBlocks) {
    const labelIdx = app.indexOf(label);
    ok(labelIdx > 0, `the ${name} dialog (${label}) must be found`);
    // The ref attaches to the SAME element as role="dialog"/the aria-label —
    // look in a tight window just before the label, not the whole file.
    const nearby = app.slice(Math.max(0, labelIdx - 200), labelIdx);
    ok(nearby.includes(`ref={${refVar}}`),
      `the ${name} dialog element must carry ref={${refVar}}, got: ${JSON.stringify(nearby)}`);
  }

  // MUTATION / NEGATIVE FIXTURE — the pre-fix Feedback dialog, verbatim (no
  // ref, and useModalTabTrap not called for it). Proves the checks above can
  // tell the fixed wiring apart from the defect.
  const preFixFeedbackDialog = `<div
            role="dialog"
            aria-modal="true"
            aria-label="Send feedback"
            onClick={(e) => e.stopPropagation()}`;
  ok(!preFixFeedbackDialog.includes('ref={feedbackDialogRef}'),
    'the pre-fix fixture text must not accidentally already carry the ref (fixture sanity check)');
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
  const tourTagLine = walkthrough.split('\n').find((l) => l.includes('role="dialog" aria-label="Guided tour"'));
  ok(tourTagLine !== undefined && !tourTagLine.includes('aria-modal'),
    `THE FIX MUST NOT make the tour modal — it must stay click-through, per its own docstring, got: ${JSON.stringify(tourTagLine)}`);

  for (const label of ['aria-label="Send feedback"', 'aria-label="Account"',
                        'aria-label="Save custom game"', 'aria-label="Edit saved game"',
                        // "Simulation log" appears THREE times (the inline
                        // non-modal region, this dialog's OWN aria-label, and
                        // the region reused INSIDE the expanded dialog) — the
                        // `aria-modal="true"` immediately before it picks out
                        // the dialog's own tag uniquely.
                        'aria-modal="true"\n      aria-label="Simulation log"']) {
    const idx = app.indexOf(label);
    ok(idx > 0, `dialog ${label} must be found`);
    // Search back to the START of this dialog's backdrop div (its own
    // "fixed inset-0" className), not a fixed character window — the
    // RED-APP-5 003 comment above the className varies in length per dialog.
    const backdropIdx = app.lastIndexOf('fixed inset-0', idx);
    ok(backdropIdx > 0 && idx - backdropIdx < 600,
      `dialog ${label}'s own backdrop div must be found nearby, got distance ${idx - backdropIdx}`);
    const nearby = app.slice(backdropIdx, idx);
    const zMatch = nearby.match(/z-\[(\d+)\]/) || nearby.match(/z-(\d+)\b/);
    ok(zMatch !== null, `dialog ${label} must carry a z-index class, got: ${JSON.stringify(nearby)}`);
    const dialogZ = Number(zMatch![1]);
    ok(dialogZ > tourZ,
      `THE FIX: dialog ${label} (z-${dialogZ}) must paint ABOVE the tour (z-${tourZ}), or the tour can `
      + `cover it again`);
  }

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

console.log(`a11yfixes.test.ts: ${checks} checks passed`);

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
  const savedGameDescIdx = menuDrawer.indexOf("<ColorCoded text={game.desc}");
  ok(savedGameDescIdx > 0, 'the MenuDrawer saved-game description ColorCoded call must be found');
  const savedGameDescNearby = menuDrawer.slice(Math.max(0, savedGameDescIdx - 200), savedGameDescIdx);
  ok(!/\btext-muted dark:text-muted-dark\b/.test(savedGameDescNearby),
    'the MenuDrawer saved-game description card must not use the plain text-muted token');
  ok(savedGameDescNearby.includes('text-slate-500 dark:text-slate-400'),
    'the MenuDrawer saved-game description card must still render its own matte body text (unaffected by this revert)');

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
    'MenuDrawer.tsx must not use text-prose-muted today (neither saved/default-game description card has anything to move onto it yet)');

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

  // RED-APP-6/002: this branch now also calls `e.stopPropagation()` (so the
  // same Escape press cannot also reach Walkthrough.tsx's tour listener).
  // CodeRabbit finding (this branch): the `?` made that call OPTIONAL, so
  // this assertion would still pass if a future edit dropped
  // stopPropagation() again and reopened the tour-cascade defect -- require
  // it, not merely tolerate it.
  ok(/else if \(isEditModalOpen\)\s*\{\s*setIsEditModalOpen\(false\);\s*setEditError\(''\);\s*(?:e\.stopPropagation\(\);\s*)\}/.test(block),
    `THE FIX: isEditModalOpen must be in the condition chain with the SAME close side-effects `
    + `its own "✕" button and backdrop use, AND call e.stopPropagation() (RED-APP-6/002), `
    + `got: ${JSON.stringify(block)}`);

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
// CodeRabbit review on PR #91, App.tsx:223 (Major, after RED-APP-5/002
// shipped above): `useModalTabTrap` deliberately did not set initial focus,
// and only Feedback has its own `autoFocus` field — Auth, Save and Edit left
// focus stranded on the background opener until the user's first Tab press.
// Fixed by moving focus to the first enabled control inside the hook itself,
// gated on `!container.contains(document.activeElement)` so a dialog with
// its OWN autoFocus (Feedback) is unaffected. This is the decidable half —
// the real behavioral proof is `src/e2e/smoke.mjs` section 20 (checks the
// Auth dialog, which has no autoFocus field of its own, so it is the one
// case that actually exercises this).
// ─────────────────────────────────────────────────────────────────────────────
{
  const hookIdx = app.indexOf('function useModalTabTrap(');
  ok(hookIdx > 0, 'useModalTabTrap must exist (checked above; re-anchoring here)');
  const hookBody = app.slice(hookIdx, app.indexOf('\n}', app.indexOf('window.addEventListener', hookIdx)));
  ok(hookBody.includes('getModalFocusables'),
    'useModalTabTrap must use a shared focusables helper (not re-derive its own query for the mount-focus branch)');
  ok(/if\s*\(container\s*&&\s*!container\.contains\(document\.activeElement\)\)/.test(hookBody),
    `useModalTabTrap must only move focus when it is not ALREADY inside the dialog — `
    + `otherwise Feedback's own autoFocus would be fought over, got: ${JSON.stringify(hookBody.slice(0, 400))}`);
  ok(/getModalFocusables\(container\)\[0\]\?\.focus\(\)/.test(hookBody),
    'useModalTabTrap must focus the FIRST focusable element, not e.g. the last or the container itself');
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

/**
 * round14 structural pass (BLUE-MODAL-14): one ModalSurface primitive with a
 * single-active-modal registry, used by Account/Save/Edit/Feedback AND the
 * workspace drawer. Fixes RED-APP-13/002 (focus escapes an open dialog on a
 * 401), /003 (drawer Delete has no in-flight state) and /004 (drawer has no
 * role/trap). The real DOM behavior is section 66's job (src/e2e/smoke.mjs);
 * these are the decidable structural facts a regression could not silently
 * undo without also breaking one of these.
 *
 *   npx tsx src/modalsurface.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { ModalRegistry } from './components/ModalSurface';

let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

/** Strips `/** *\/` block comments and `// ...` line comments so a count of
 *  a JSX attribute (e.g. `role="dialog"`) is not inflated by the SAME text
 *  appearing in prose describing it. Good enough for counting, not a parser. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const app = stripComments(readFileSync('src/App.tsx', 'utf8'));
const drawer = stripComments(readFileSync('src/components/MenuDrawer.tsx', 'utf8'));
const modalSurfaceSrc = stripComments(readFileSync('src/components/ModalSurface.tsx', 'utf8'));

// ── Structural: every converted dialog renders through <ModalSurface> ──────
{
  const surfaceIds = ['account', 'edit-saved-game', 'save-preset', 'feedback'];
  for (const id of surfaceIds) {
    ok(new RegExp(`<ModalSurface[\\s\\S]{0,200}?id="${id}"`).test(app),
      `App.tsx must render the "${id}" dialog through <ModalSurface id="${id}">`);
  }
  // The four converted dialogs no longer hand-roll role="dialog" themselves —
  // ModalSurface owns it. App.tsx's only REMAINING literal role="dialog"
  // attributes belong to the two surfaces this round deliberately left alone
  // (the expand-log overlay and the local-games-offer dialog, both out of
  // scope per round14/STRUCTURAL.md) — exactly 2, never more.
  const roleDialogAttrs = app.match(/\brole="dialog"/g) ?? [];
  ok(roleDialogAttrs.length === 2,
    `App.tsx must have exactly 2 hand-rolled role="dialog" left (expand-log, local-games-offer); found ${roleDialogAttrs.length}`);
  ok(app.includes('aria-label="Simulation log"') && app.includes('aria-label="Games saved on this device"'),
    'the 2 remaining hand-rolled dialogs must still be the expand-log overlay and the local-games offer, not a re-added converted one');
}

// The drawer has ZERO hand-rolled role="dialog" — it goes through
// <ModalSurface layout="drawer">, the same primitive as the four dialogs.
{
  ok(!/\brole="dialog"/.test(drawer),
    'MenuDrawer.tsx must not hand-roll role="dialog" — it renders through <ModalSurface>');
  ok(/<ModalSurface[\s\S]{0,120}?id="drawer"[\s\S]{0,200}?layout="drawer"/.test(drawer),
    'MenuDrawer.tsx must render its outer overlay through <ModalSurface id="drawer" layout="drawer">');
}

// ModalSurface.tsx is the ONE place role="dialog" is written for every
// converted surface (2 layout branches: centered dialogs, the drawer).
{
  const roleDialogAttrs = modalSurfaceSrc.match(/\brole="dialog"/g) ?? [];
  ok(roleDialogAttrs.length === 2,
    `ModalSurface.tsx must define role="dialog" exactly twice (centered + drawer layouts); found ${roleDialogAttrs.length}`);
}

// ── Structural: the [user] focus effect is guarded by the registry ─────────
// RED-APP-13/002: this effect used to fire (and steal focus to a header
// control hidden under an open dialog's backdrop) on every `user` change,
// with no guard for "some OTHER surface is open." Mutation: delete the
// `if (ModalRegistry.isAnyOpen()) return;` line from App.tsx and this check
// fails (verified by hand, see REPORT.md) — the effect body no longer
// contains the guard before its activeElement check.
{
  const marker = "'[data-focus-fallback=\"account\"] button, [data-focus-fallback=\"account\"]')?.focus();\n  }, [user]);";
  const markerIdx = app.indexOf(marker);
  ok(markerIdx > 0, 'could not locate the [user]-keyed header focus effect at all — has it moved or been renamed?');
  const effectStart = app.lastIndexOf('useEffect(() => {', markerIdx);
  ok(effectStart > 0 && markerIdx - effectStart < 500,
    'could not find the useEffect(...) wrapping the [user] focus effect');
  const effectBody = app.slice(effectStart, markerIdx + marker.length);
  ok(effectBody.includes('if (ModalRegistry.isAnyOpen()) return;'),
    'the [user]-keyed header focus effect must no-op while ModalRegistry.isAnyOpen() (RED-APP-13/002) — the guard line is missing');
  // Isolating: the guard must run BEFORE the activeElement check, not after
  // (an "after" placement would still let the effect steal focus first on
  // whichever render the two checks raced on — order matters here because
  // both are plain early returns with no other synchronization between them).
  const guardIdx = effectBody.indexOf('ModalRegistry.isAnyOpen()');
  const bodyCheckIdx = effectBody.indexOf('document.activeElement !== document.body');
  ok(guardIdx > 0 && bodyCheckIdx > guardIdx,
    'the registry guard must appear BEFORE the document.activeElement check inside the [user] effect, not after');
  ok(/import\s*\{[^}]*\bModalRegistry\b[^}]*\}\s*from\s*'\.\/components\/ModalSurface'/.test(app),
    'App.tsx must import ModalRegistry from components/ModalSurface (not redefine its own copy)');
}

// ── Functional: the registry enforces single-active-modal ──────────────────
// (RED-APP-13/002+004 shape: a second dialog opening — or Enter reaching a
// background control — while a first was still open.) Pure data structure,
// no DOM needed.
{
  ModalRegistry._resetForTests();
  ok(ModalRegistry.canOpen('a') === true, 'an empty registry must allow any id to open');
  ModalRegistry.open('a', false);
  ok(ModalRegistry.isAnyOpen() === true, 'isAnyOpen() must be true once a surface is registered');
  ok(ModalRegistry.canOpen('a') === true, 'the SAME id re-affirming its own open must not refuse itself');
  ok(ModalRegistry.canOpen('b') === false,
    'a second, DIFFERENT, non-stacking surface must be refused while "a" (non-stacking) is open — RED-APP-13/002+004\'s shape');
  ModalRegistry.close('a');
  ok(ModalRegistry.canOpen('b') === true, 'closing "a" must let "b" open');
  ModalRegistry._resetForTests();

  // The one declared exception: allowsStack.
  ModalRegistry.open('tour', true);
  ok(ModalRegistry.canOpen('account') === true,
    'a surface may open over one that itself declared allowsStack:true (reserved for the guided tour)');
  ModalRegistry.open('account', false);
  ok(ModalRegistry.canOpen('other') === false,
    'once "account" (non-stacking) is ALSO open, a third surface must still be refused — allowsStack is not transitive');
  ModalRegistry.close('account');
  ModalRegistry.close('tour');
  ok(ModalRegistry.isAnyOpen() === false, 'closing every open id must leave the registry empty');
  ModalRegistry._resetForTests();
}

// ── The drawer threads deletingGameIds into its own Delete button ──────────
// (RED-APP-13/003: identical handler, identical data, only the sidebar
// showed the in-flight state.) BLUE-LIST-14 (round14): the button itself
// moved to the SHARED src/components/SavedGamesList.tsx — MenuDrawer.tsx
// now only threads the PROP through. Mutation: delete `disabled={isDeleting}`
// from SavedGamesList's drawer-variant Delete button and this fails.
{
  ok(/deletingGameIds:\s*string\[\]/.test(drawer),
    'MenuDrawerProps must declare deletingGameIds: string[]');
  ok(/<SavedGamesList[\s\S]{0,300}deletingGameIds=\{deletingGameIds\}/.test(drawer),
    'MenuDrawer must pass its deletingGameIds prop straight through to <SavedGamesList>');
  const listSrc = stripComments(readFileSync('src/components/SavedGamesList.tsx', 'utf8'));
  ok(/const isDeleting = deletingGameIds\.includes\(game\.id\);/.test(listSrc),
    'SavedGamesList must derive isDeleting from deletingGameIds.includes(game.id)');
  const deleteBtnIdx = listSrc.indexOf('title={deleteTitle}');
  const secondDeleteBtnIdx = listSrc.indexOf('title={deleteTitle}', deleteBtnIdx + 1);
  ok(deleteBtnIdx > 0 && secondDeleteBtnIdx > deleteBtnIdx,
    'could not find BOTH Delete buttons (sidebar + drawer variants) in SavedGamesList.tsx');
  for (const [variant, idx] of [['sidebar', deleteBtnIdx], ['drawer', secondDeleteBtnIdx]] as const) {
    const btnStart = listSrc.lastIndexOf('<button', idx);
    const btnSlice = listSrc.slice(btnStart, idx + 20);
    ok(/disabled=\{isDeleting\}/.test(btnSlice),
      `the ${variant}-variant Delete button must read disabled={isDeleting}`);
    ok(/aria-busy=\{isDeleting\s*\|\|\s*undefined\}/.test(btnSlice),
      `the ${variant}-variant Delete button must read aria-busy={isDeleting || undefined}`);
  }
}

console.log(`modalsurface.test.ts: ${checks} checks passed`);

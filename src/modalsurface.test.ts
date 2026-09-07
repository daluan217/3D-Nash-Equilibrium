/**
 * round14 structural pass (BLUE-MODAL-14): one ModalSurface primitive with a
 * single-active-modal registry, used by Account/Save/Edit/Feedback AND the
 * workspace drawer. Fixes RED-APP-13/002 (focus escapes an open dialog on a
 * 401), /003 (drawer Delete has no in-flight state) and /004 (drawer has no
 * role/trap). round15 (BLUE-MODAL-15): the local-games offer and the
 * expand-log overlay join the same primitive (RED-APP-14/002+004); the Tab
 * trap never gives up when every control is disabled (RED-APP-14/002); the
 * drawer's own Danger Zone fetches clear a dead token (RED-APP-14/003);
 * opener tracking survives WebKit's focus-the-landmark behavior
 * (RED-APP-14/005). The real DOM behavior is sections 66/67/70's job
 * (src/e2e/smoke.mjs); these are the decidable structural facts a regression
 * could not silently undo without also breaking one of those.
 *
 *   npx tsx src/modalsurface.test.ts
 */
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
const admin = stripComments(readFileSync('src/components/AdminDashboard.tsx', 'utf8'));

// ── Structural: every converted dialog renders through <ModalSurface> ──────
// round15 (RED-APP-14/002+004): the local-games offer and the expand-log
// overlay join the four round14 surfaces — EVERY role=dialog/fixed-inset
// overlay in App.tsx now goes through the shared primitive, so App.tsx must
// have ZERO hand-rolled role="dialog" left (a new bare overlay fails this).
{
  const surfaceIds = ['account', 'edit-saved-game', 'save-preset', 'feedback', 'local-games-offer', 'expand-log'];
  for (const id of surfaceIds) {
    ok(new RegExp(`<ModalSurface[\\s\\S]{0,200}?id="${id}"`).test(app),
      `App.tsx must render the "${id}" dialog through <ModalSurface id="${id}">`);
  }
  const roleDialogAttrs = app.match(/\brole="dialog"/g) ?? [];
  ok(roleDialogAttrs.length === 0,
    `App.tsx must have ZERO hand-rolled role="dialog" left — every overlay renders through <ModalSurface> (round15); found ${roleDialogAttrs.length}`);
  ok(app.includes('ariaLabel="Simulation log"') && app.includes('ariaLabel="Games saved on this device"'),
    'the local-games offer and the expand-log overlay must keep their aria labels (now the ariaLabel prop) through the <ModalSurface> conversion');
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

  // RED-APP-14/004 (round15): a surface refused at open time must retry the
  // moment the stack changes — this is what lets a caller "sequence, never
  // stack" two surfaces with NO coordination between them (the local-games
  // offer and a resumed Save dialog racing to open from the same sign-in).
  // Mutation: drop `notifyStackChanged()` from `open`/`close` and the second
  // `subscribe` callback below never fires — this fails.
  ModalRegistry.open('offer', false);
  ok(ModalRegistry.isRegistered('offer'), 'isRegistered must report a currently-open id');
  ok(!ModalRegistry.isRegistered('save-preset'), 'isRegistered must not report an id that never opened');
  let retried = false;
  const unsubscribe = ModalRegistry.subscribe(() => {
    if (!ModalRegistry.isRegistered('save-preset') && ModalRegistry.canOpen('save-preset')) {
      ModalRegistry.open('save-preset', false);
      retried = true;
    }
  });
  ok(ModalRegistry.canOpen('save-preset') === false, 'save-preset must be refused while offer is open (precondition)');
  ModalRegistry.close('offer');
  ok(retried && ModalRegistry.isRegistered('save-preset'),
    'closing the blocker must let a subscribed, refused surface register itself — sequenced, never stacked');
  unsubscribe();
  ModalRegistry._resetForTests();
  // Isolating: unsubscribe must actually stop future notifications.
  let firedAfterUnsubscribe = false;
  const u2 = ModalRegistry.subscribe(() => { firedAfterUnsubscribe = true; });
  u2();
  ModalRegistry.open('x', false);
  ok(!firedAfterUnsubscribe, 'a listener must not fire after its own unsubscribe() has been called');
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

// RED-APP-14/001 (director-reproduced): every window/document keydown
// listener OUTSIDE ModalSurface.tsx must either handle only Escape (which
// ModalSurface already stops from reaching lower layers) or consult the
// registry, so no key typed inside an open surface drives something beneath
// it. Enumerated over src/ so a new listener cannot appear unguarded.
{
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = `${dir}/${f}`;
    if (statSync(p).isDirectory()) return f === 'e2e' || f === 'integration' ? [] : walk(p);
    return /\.(tsx?|mjs)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
  // Named handlers AND inline callbacks (CodeRabbit on #151): for an inline
  // `(e) => { … }` the body is the text from the listener call to the end of
  // the enclosing effect (the next `}, [` dependency array).
  const listenerRe = /(?:window|document)\.addEventListener\(\s*['"]keydown['"]\s*,\s*(\w+|\([^)]*\)\s*=>|\w+\s*=>|function\b)/g;
  let listeners = 0;
  for (const file of walk('src')) {
    if (file.endsWith('ModalSurface.tsx')) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(listenerRe)) {
      listeners++;
      const handlerName = m[1];
      const inline = !/^\w+$/.test(handlerName);
      const def = inline ? -1 : src.indexOf(`const ${handlerName} = `);
      const body = inline
        ? src.slice(m.index, src.indexOf('}, [', m.index) > 0 ? src.indexOf('}, [', m.index) : m.index + 2000)
        : (def >= 0 ? src.slice(def, m.index) : '');
      // Benign: a handler that acts only on Escape (ModalSurface stops that key
      // from reaching lower layers) and/or Tab (a focus trap for its own
      // overlay). Anything that reacts to other keys must consult the registry.
      const keysHandled = [...body.matchAll(/e\.key\s*(?:!==|===)\s*'([^']+)'/g)].map((k) => k[1]);
      const benign = keysHandled.length > 0 && keysHandled.every((k) => k === 'Escape' || k === 'Tab');
      const gated = /ModalRegistry\.isAnyOpen\(/.test(body);
      ok(benign || gated,
        `${file}: the keydown listener "${handlerName}" handles ${JSON.stringify(keysHandled)} without consulting ModalRegistry.isAnyOpen() (RED-APP-14/001)`);
    }
  }
  // round15: App.tsx's own hand-rolled expand-log and local-games-offer
  // keydown listeners are GONE — both surfaces now go through ModalSurface's
  // shared Escape/Tab handling, leaving only Walkthrough.tsx's own tour
  // listener outside this file.
  ok(listeners >= 1, `expected at least Walkthrough's own keydown listener outside ModalSurface, found ${listeners}`);
  // Fixture: an inline unguarded listener must be caught by the same regex.
  const inlineFixture = "useEffect(() => {\n  window.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') next(); });\n}, [next]);";
  const fm = [...inlineFixture.matchAll(listenerRe)];
  ok(fm.length === 1 && !/^\w+$/.test(fm[0][1]), 'fixture: the listener regex matches an inline arrow callback');
  const tour = readFileSync('src/components/Walkthrough.tsx', 'utf8');
  ok(/ModalRegistry\.isAnyOpen\(\) \|\| insideOtherDialog\(e\.target\)/.test(tour),
    'Walkthrough\'s key listener must bail when any ModalSurface is open OR the key was typed inside another dialog');
}

// RED-APP-14/006 + /007 (director-reproduced): the plot's document-capture
// press detectors must reject presses whose real target is interactive UI or
// a dialog/overlay that merely overlaps the plot rectangle; the centered
// overlay closes only when the pointer went DOWN on the backdrop.
{
  const plot = readFileSync('src/components/PlotlyView.tsx', 'utf8');
  const guards = plot.match(/pressOnUnrelatedUi\(e, container\)\) return;/g) ?? [];
  ok(guards.length >= 3, `PlotlyView: expected the 3 document-capture detectors (pause, spin take-over, activity) to call pressOnUnrelatedUi, found ${guards.length}`);
  ok(/\[role="dialog"\], \[data-modal-surface\], header/.test(plot), 'PlotlyView: the unrelated-UI selector must cover dialogs, ModalSurface overlays and the header');
  // CodeRabbit on #153: the plot's OWN Rotate / Pan / Reset View buttons sit inside the wrapper, so an
  // interactive control must be rejected regardless of containment (e2e 74 presses each one mid-run).
  ok(/if \(t\.closest\(INTERACTIVE_CONTROL\)\) return true;/.test(plot) && /INTERACTIVE_CONTROL = 'button, a\[href\], input, select, textarea'/.test(plot),
    'PlotlyView: pressOnUnrelatedUi must reject any interactive control before the containment test');
  const surface = readFileSync('src/components/ModalSurface.tsx', 'utf8');
  ok(/onPointerDown=\{\(e\) => \{ pointerDownOnOverlayRef\.current = e\.target === e\.currentTarget; \}\}/.test(surface)
    && /if \(e\.target === e\.currentTarget && pointerDownOnOverlayRef\.current\) onClose\(\)/.test(surface),
    'ModalSurface: the centered overlay closes only when the pointer went down on the backdrop itself (RED-APP-14/007)');
}

// RED-APP-14/002 (round15): the Tab trap must never give up when every
// control inside a dialog is disabled — it must park focus on the panel
// itself (`tabIndex={-1}`) and swallow Tab/Shift+Tab, then hand focus back
// to the first control once one re-enables. Structural (the real DOM
// behavior is e2e section 70's job): mutation-tested by hand — reverting
// the `onKey` branch to a bare `return` (its round14 shape) fails the first
// check below; dropping the MutationObserver fails the third.
{
  ok(/if \(focusables\.length === 0\) \{\s*\n[\s\S]{0,300}?e\.preventDefault\(\);\s*\n[\s\S]{0,120}?container\.focus\(\);/.test(modalSurfaceSrc),
    'useModalTabTrap\'s onKey must preventDefault() and park focus on the panel when focusables.length === 0, not bare `return` (RED-APP-14/002)');
  ok(/\(focusables\[0\] \?\? container\)\.focus\(\)/.test(modalSurfaceSrc),
    'the open-time focus effect and the onFocusOut recapture must both fall back to the panel itself, never a silent no-op on an empty focusables list (RED-APP-14/002)');
  ok(/new MutationObserver\(/.test(modalSurfaceSrc) && /attributeFilter:\s*\[['"]disabled['"]\]/.test(modalSurfaceSrc),
    'useModalTabTrap must watch for controls re-enabling (a MutationObserver on the `disabled` attribute) and return focus to the first one (RED-APP-14/002)');
  ok((modalSurfaceSrc.match(/tabIndex=\{-1\}/g) ?? []).length >= 2,
    'both ModalSurface panel layouts (centered + drawer) must set tabIndex={-1} so the panel itself is a valid focus-park target');
}

// RED-APP-14/005 (round15): opener tracking must survive WebKit focusing a
// `tabIndex={-1}` landmark instead of the clicked button — `focusin` must be
// filtered to real controls, and pointerdown/keydown (which WebKit still
// fires on the real control) are the sources of record. Mutation: widen
// REAL_CONTROL_SELECTOR back to `[tabindex]` (dropping `:not([tabindex="-1"])`)
// and this fails; drop the `.matches(REAL_CONTROL_SELECTOR)` filter on
// `focusin` and this also fails.
{
  ok(/REAL_CONTROL_SELECTOR\s*=\s*'[^']*\[tabindex\]:not\(\[tabindex="-1"\]\)/.test(modalSurfaceSrc),
    'REAL_CONTROL_SELECTOR must exclude tabIndex={-1} containers (RED-APP-14/005)');
  ok(/addEventListener\('focusin',[\s\S]{0,200}?\.matches\(REAL_CONTROL_SELECTOR\)/.test(modalSurfaceSrc),
    'the focusin listener must only record a target that matches REAL_CONTROL_SELECTOR — never a landmark (RED-APP-14/005)');
  ok(/addEventListener\('pointerdown',[\s\S]{0,200}?closest\?\.\(REAL_CONTROL_SELECTOR\)/.test(modalSurfaceSrc),
    'the pointerdown listener must record the closest REAL_CONTROL_SELECTOR match');
  ok(/addEventListener\('keydown',[\s\S]{0,200}?closest\?\.\(REAL_CONTROL_SELECTOR\)/.test(modalSurfaceSrc),
    'a keydown listener must also record the opener, for keyboard activation (Enter/Space) with no prior focusin (RED-APP-14/005)');
}

// RED-APP-14/003 (round15): every authenticated (`Authorization: Bearer`)
// fetch in src/components must clear a dead token on 401 through ONE shared
// helper — not a re-implementation per call site. Enumerated so a NEW
// authenticated fetch in src/components that skips the helper fails CI.
// Mutation: delete the `clearTokenIfExpired(res);` call from either Danger
// Zone handler in MenuDrawer.tsx and this fails for that site.
{
  const walkComponents = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(p).isDirectory() ? walkComponents(p) : (/\.tsx?$/.test(f) && !/\.test\./.test(f) ? [p] : []);
  });
  let authedFetchSites = 0;
  for (const file of walkComponents('src/components')) {
    const src = readFileSync(file, 'utf8');
    // Every occurrence of the Authorization header; the enclosing function is
    // the text back to the nearest `const ... = async` / `const ... = (` before it.
    for (const m of src.matchAll(/'Authorization':\s*`Bearer/g)) {
      authedFetchSites++;
      const fnStart = Math.max(src.lastIndexOf('const handle', m.index), src.lastIndexOf('async (', m.index), src.lastIndexOf('async function', m.index));
      const bodyEnd = src.indexOf('\n  };', m.index) > 0 ? src.indexOf('\n  };', m.index) : m.index + 2000;
      const body = src.slice(fnStart >= 0 ? fnStart : 0, bodyEnd);
      ok(/clearTokenIfExpired\(res\)/.test(body),
        `${file}: an authenticated fetch's response handling must clear a dead token through clearTokenIfExpired(res), not its own check (RED-APP-14/003)`);
    }
  }
  ok(authedFetchSites >= 2, `expected at least MenuDrawer.tsx's 2 Danger Zone fetch sites, found ${authedFetchSites}`);
  ok(/const clearTokenIfExpired = \(res: Response\) => \{ if \(res\.status === 401\) updateAuthToken\(null\); \};/.test(drawer),
    'MenuDrawer.tsx must define exactly one clearTokenIfExpired helper backed by the updateAuthToken prop');
  ok(/updateAuthToken:\s*\(token: string \| null\) => void;/.test(drawer),
    'MenuDrawerProps must declare updateAuthToken so the drawer never re-implements its own token store');
  ok(/<MenuDrawer[\s\S]{0,400}updateAuthToken=\{updateAuthToken\}/.test(app),
    'App.tsx must pass its own updateAuthToken down to <MenuDrawer>');
}

// RED-APP-4 (round15 regression guard): the expand-log dialog must still
// focus the LOG REGION on open, not <ModalSurface>'s default (the first
// focusable — the Collapse button). Measured directly (not inferred): an
// inline arrow-function ref stays a NEW function every render and re-steals
// focus on every log line while the dialog is open; a `[logExpanded]`-keyed
// useEffect fires in `<ModalSurface>`'s FIRST commit (before it renders
// anything — `active` starts false), while the ref only exists after its
// SECOND commit — both were tried by hand and both landed focus on the
// Collapse button instead (screenshots/focus dumps in REPORT.md).
//
// OPUS-REVIEW-MODAL FIX-BEFORE-MERGE 2: the SAME two-commit-mount timing
// broke the pre-existing auto-scroll-to-newest effect (its `logsExpandedRef
// .current` was null on the commit its `[logExpanded]` dependency actually
// changed) — the log opened scrolled to the TOP, not the newest lines. Fixed
// in the SAME ref callback that already solved this ordering problem for
// focus; the callback is renamed `mountLogRegion` to reflect doing both.
{
  ok(/const mountLogRegion = useCallback\(\(el: HTMLDivElement \| null\) => \{\s*\n\s*logsExpandedRef\.current = el;\s*\n\s*if \(el\) \{\s*\n\s*el\.scrollTop = el\.scrollHeight;\s*\n\s*el\.focus\(\);\s*\n\s*\}\s*\n\s*\}, \[\]\);/.test(app),
    'App.tsx must focus AND scroll-to-bottom the log region via the SAME stable (useCallback, empty deps) ref callback, not an inline arrow function or a [logExpanded]-keyed effect (OPUS-REVIEW-MODAL FIX-BEFORE-MERGE 2)');
  ok(/ref=\{mountLogRegion\}/.test(app),
    'the log region\'s own div must use the stable mountLogRegion ref callback');
  ok(!/autoFocus/.test((app.match(/aria-label="Simulation log"[\s\S]{0,400}/) ?? [''])[0]),
    'the log region must not rely on autoFocus — it is inert on a non-form element (React only special-cases button/input/select/textarea)');
}

// OPUS-REVIEW-MODAL BLOCK 1 (round15) folded into RED-APP-15/001's general fix
// (round16, BLUE-MODAL-16): `document.activeElement` can be the panel itself
// (`tabIndex={-1}`, mouse-focusable) OR any OTHER `tabIndex={-1}` landmark
// inside the container (SavedGamesList's `[data-focus-fallback]` wrappers) —
// neither is ever in `focusables`, so `!focusables.includes(active)` is the
// general edge check (subsumes BLOCK 1's `=== container` case: the container
// is never matched by getModalFocusables' selector either). Route by DOM
// order (focusableAfter/Before) instead of a fixed first/last so a landmark
// with real controls nested after it (a populated saved-games list) still
// advances into them. Mutation: revert to the old
// `!container.contains(document.activeElement) || document.activeElement === container`
// check (no `focusableAfter`/`focusableBefore`) and this fails — RED-APP-15/001
// reproduces the escape again (forward Tab from an empty-state landmark).
{
  const onKeyWindow = (modalSurfaceSrc.match(/if \(!focusables\.includes\(active\)\) \{[\s\S]{0,500}?\n\s*\}/) ?? [''])[0];
  ok(/e\.preventDefault\(\);/.test(onKeyWindow), 'the landmark-edge branch must preventDefault so the browser never runs its own Tab traversal (RED-APP-15/001)');
  ok(/\(e\.shiftKey \? focusableBefore\(focusables, active\) : focusableAfter\(focusables, active\)\)\.focus\(\);/.test(onKeyWindow),
    'the landmark-edge branch must route by DOM order via focusableBefore/focusableAfter, not a fixed first/last (RED-APP-15/001)');
}

// The DOM-order helpers themselves (RED-APP-15/001): a landmark's neighbors
// are found via compareDocumentPosition, wrapping to the far end when there
// is nothing after/before. Mutation: swap DOCUMENT_POSITION_FOLLOWING for
// _PRECEDING (or vice versa) in either helper and this fails.
{
  ok(/function focusableAfter\(focusables: HTMLElement\[\], from: Node\): HTMLElement \{\s*\n\s*for \(const el of focusables\) \{\s*\n\s*if \(from\.compareDocumentPosition\(el\) & Node\.DOCUMENT_POSITION_FOLLOWING\) return el;\s*\n\s*\}\s*\n\s*return focusables\[0\];\s*\n\s*\}/.test(modalSurfaceSrc),
    'focusableAfter must pick the first focusable that FOLLOWS `from` in DOM order, wrapping to focusables[0]');
  ok(/function focusableBefore\(focusables: HTMLElement\[\], from: Node\): HTMLElement \{\s*\n\s*for \(let i = focusables\.length - 1; i >= 0; i--\) \{\s*\n\s*if \(from\.compareDocumentPosition\(focusables\[i\]\) & Node\.DOCUMENT_POSITION_PRECEDING\) return focusables\[i\];\s*\n\s*\}\s*\n\s*return focusables\[focusables\.length - 1\];\s*\n\s*\}/.test(modalSurfaceSrc),
    'focusableBefore must pick the last focusable that PRECEDES `from` in DOM order, wrapping to the last focusable');
}

// CodeRabbit CLI (round15 review): `mountLogRegion`'s own `el.focus()` on the
// log region (tabIndex={0}, a REAL control) fires a real `focusin` in the
// SAME commit that mounts it — before useModalTabTrap's effect ever reads
// `lastInteractedControl` — overwriting the correctly-recorded "Expand log"
// button (its own pointerdown, moments earlier) with the log region itself,
// which the trap's container already contains. `opener` then resolves to
// null and focus fell back to `[data-focus-home]` instead of the actual
// opener. Measured directly against the built dist (a throwaway script,
// removed, never committed): DEFECT before this fix, PASS after. Mutation:
// remove the `fallbackSelector` prop from the expand-log ModalSurface and
// this fails.
{
  ok(/ariaLabel="Simulation log"[\s\S]{0,400}?fallbackSelector='\[aria-label="Expand simulation log"\]'/.test(app),
    'the expand-log <ModalSurface> must declare a fallbackSelector naming its one real opener (the Expand log button) — mountLogRegion\'s own focus() clobbers opener-tracking\'s lastInteractedControl, so focusAfterDialog\'s opener param resolves to null');
  // OPUS-REVIEW-MODAL2 NOTE 3: the fallbackSelector literal and the button's
  // actual aria-label are two independently-typed strings that must agree —
  // nothing else checks that pairing. `app.includes(...)` alone would be a
  // SELF-REFERENTIAL check: the fallbackSelector string itself is
  // `'[aria-label="Expand simulation log"]'`, which already contains the
  // exact substring being searched for, so the check would pass even with
  // the button's own attribute renamed (verified by hand — it did). The
  // negative lookbehind excludes that `[...]` occurrence, requiring a SECOND,
  // real JSX-attribute occurrence. Mutation: rename only the button's own
  // aria-label (App.tsx:4126), leaving the fallbackSelector string
  // untouched → this fails; the naive `includes` form does not.
  ok(/(?:^|[^[])aria-label="Expand simulation log"/.test(app),
    'App.tsx must still have a button with aria-label="Expand simulation log" as a REAL JSX attribute (not just inside the fallbackSelector string) — the expand-log fallbackSelector names this exact string, and nothing else checks that the two agree (OPUS-REVIEW-MODAL2 NOTE 3)');
}

// RED-APP-15/002 (round16, BLUE-MODAL-16): AdminDashboard.tsx hand-rolled a
// `fixed inset-0` overlay with a bare `className=` — no role, no Escape, no
// trap, not in ModalRegistry — reachable by a real triple-click, letting its
// own keystrokes drive the guided tour underneath it. Scan EVERY .tsx under
// src/components plus App.tsx for a bare `className="...fixed...inset-0..."`
// (never `overlayClassName=`, which is a value forwarded INTO a <ModalSurface>
// caller, not a hand-rolled overlay); the only allowed exception is the
// guided tour's own non-modal backdrop (Walkthrough.tsx — documented
// `pointer-events-none`, deliberately not `aria-modal`, gated by
// `ModalRegistry.isAnyOpen()` for RED-APP-15/003 instead). Known-positive
// fixture: reverting AdminDashboard.tsx to its pre-fix wrapper divs fails
// this. Mutation: revert the AdminDashboard.tsx conversion → this fails.
{
  const ALLOWED_BARE_OVERLAY_FILES = new Set(['src/components/Walkthrough.tsx']);
  const walkAll = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(p).isDirectory() ? walkAll(p) : (/\.tsx?$/.test(f) && !/\.test\./.test(f) ? [p] : []);
  });
  const files = [...walkAll('src/components'), 'src/App.tsx'].filter((f) => f !== 'src/components/ModalSurface.tsx');
  let scanned = 0;
  for (const file of files) {
    // NOT stripComments here: its `/\*...\*\//` regex has no notion of `//`
    // line comments, so a `//` comment that happens to contain a literal
    // `/*` substring (DownloadModal.tsx:69, `dist-electron/*.dmg`) makes it
    // swallow everything up to the next real `*/` — including this file's
    // own overlayClassName JSX below it. Scanning raw source sidesteps that;
    // a real JSX attribute value is not fabricated by a stray comment.
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(overlayClassName|className)\s*=\s*(?:"([^"]*)"|`([^`]*)`)/g)) {
      const [, attr, dq, bt] = m; const value = dq ?? bt ?? '';
      if (!(/\bfixed\b/.test(value) && /\binset-0\b/.test(value))) continue;
      scanned++;
      const ok1 = attr === 'overlayClassName' || ALLOWED_BARE_OVERLAY_FILES.has(file);
      ok(ok1, `${file}: a bare className="fixed inset-0..." overlay must render through <ModalSurface> (pass the class via overlayClassName), or be an allow-listed non-interactive backdrop with a stated reason (RED-APP-15/002) — found ${attr}="${value.slice(0, 60)}"`);
    }
  }
  ok(scanned >= 3, `expected at least DownloadModal's, the expand-log's and the guided tour's fixed inset-0 occurrences, found ${scanned}`);
}

// CodeRabbit CLI: AdminDashboard now stays MOUNTED across opens (ModalSurface
// hides it, App.tsx renders it unconditionally) — without a reset-on-close
// effect, the admin secret stayed in memory and reopening (any triple-click)
// showed the cached user table with no password prompt. Mutation: delete the
// reset useEffect → this fails.
{
  ok(/useEffect\(\(\) => \{\s*\n\s*if \(open\) return;\s*\n\s*setAuthed\(false\); setPassword\(''\); setStats\(null\); setError\(''\); setLoading\(false\);\s*\n\s*\}, \[open\]\);/.test(admin),
    'AdminDashboard must reset authed/password/stats/error/loading in a useEffect keyed on `open` going false — it no longer unmounts on close (CodeRabbit CLI)');
}

console.log(`modalsurface.test.ts: ${checks} checks passed`);

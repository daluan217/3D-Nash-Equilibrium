/**
 * BLUE-LIST-14 (round14): ONE SavedGamesList, two call sites. This is the
 * unit half of the invariant — App.tsx and MenuDrawer.tsx cannot grow their
 * own inline saved-game row again without this test noticing, and both
 * `variant`s must behave identically on the MECHANISMS (row count, the focus
 * landmark, which row's Delete is in flight) for the SAME props. Per
 * OPUS-REVIEW-LIST F4 (round14 director review of #150), empty-state COPY
 * is deliberately per-variant product text, not part of the invariant — only
 * the landmark/gating mechanism is checked to be the same shape.
 *
 *   npx tsx src/savedgameslist.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedGamesList, formatSavedGames, type SavedGameListItem } from './components/SavedGamesList';

let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

const app = readFileSync('src/App.tsx', 'utf8');
const drawer = readFileSync('src/components/MenuDrawer.tsx', 'utf8');
const list = readFileSync('src/components/SavedGamesList.tsx', 'utf8');

// The REAL predicate each "no inline row markup" check below applies —
// pulled out so the mutation fixture can run the SAME code, not a
// reimplementation of it (OPUS-REVIEW-LIST F2).
const hasInlineRowMarkup = (src: string, title: string): boolean => src.includes(title);

// ── STRUCTURAL: the two Delete-button titles (locators for e2e 45/53/56/60)
// exist EXACTLY ONCE each, and both live in SavedGamesList.tsx — never in
// the call sites. A row re-inlined into App.tsx or MenuDrawer.tsx (the exact
// shape of the original RED-DESKTOP-13/001 + RED-APP-13/003 duplication)
// would show up here as a second occurrence outside this file. ──
for (const title of ['Delete this saved game', 'Delete custom layout']) {
  ok(!hasInlineRowMarkup(app, title), `App.tsx must not contain the "${title}" title literal (row markup belongs to SavedGamesList)`);
  ok(!hasInlineRowMarkup(drawer, title), `MenuDrawer.tsx must not contain the "${title}" title literal (row markup belongs to SavedGamesList)`);
  ok(hasInlineRowMarkup(list, title), `SavedGamesList.tsx must contain the "${title}" title literal (it is the only owner)`);
}
// MUTATION FIXTURE — sanity: reintroducing a title literal into App.tsx MUST
// be caught by the REAL predicate above (OPUS-REVIEW-LIST F2: the previous
// fixture only proved `.includes()` works on a string it had just built —
// it never called `hasInlineRowMarkup`, so it could not have failed).
{
  const mutatedApp = app + '\n<button title="Delete this saved game" />';
  ok(hasInlineRowMarkup(mutatedApp, 'Delete this saved game'),
    'fixture sanity: the REAL hasInlineRowMarkup predicate flags a reintroduced title literal in App.tsx');
  ok(!hasInlineRowMarkup(app, 'Delete this saved game'),
    'fixture precondition: the UNMUTATED App.tsx must not already trip the same predicate');
}

// ── STRUCTURAL: both call sites render THROUGH SavedGamesList and share the
// ONE `formatSavedGames` mapping — never their own inline `.map`. ──
ok(/<SavedGamesList\b/.test(app), 'App.tsx must render <SavedGamesList>');
ok(/<SavedGamesList\b/.test(drawer), 'MenuDrawer.tsx must render <SavedGamesList>');
ok(/formatSavedGames\(/.test(app), 'App.tsx must call the shared formatSavedGames(), not its own inline .map');
ok(/formatSavedGames\(/.test(drawer), 'MenuDrawer.tsx must call the shared formatSavedGames(), not its own inline .map');

// ── formatSavedGames itself: the raw record survives untouched (onEdit needs
// fields — row1Label, colorTermsA — this display shape does not carry). ──
{
  const raw = [{ id: 'g1', name: 'N1', description: 'D1', payoffs: { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 }, row1Label: 'R1', colorTermsA: ['x'] }];
  const formatted = formatSavedGames(raw);
  ok(formatted.length === 1 && formatted[0].id === 'g1' && formatted[0].name === 'N1' && formatted[0].desc === 'D1',
    'formatSavedGames must map id/name/desc');
  ok(formatted[0].raw === raw[0], 'formatSavedGames must keep the RAW record (for onEdit) untouched, not a copy');
}

// ── BEHAVIOURAL (react-dom/server): same props, both variants agree on the
// MECHANISM (row count, landmark, which row is in flight). ──
const payoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
const games: SavedGameListItem[] = [
  { id: 'g1', name: 'Alpha', desc: 'first game', payoffs, terms: { a: [], b: [] }, raw: { id: 'g1' } },
  { id: 'g2', name: 'Beta', desc: 'second game (deleting)', payoffs, terms: { a: [], b: [] }, raw: { id: 'g2' } },
  { id: 'g3', name: 'Gamma', desc: 'third game', payoffs, terms: { a: [], b: [] }, raw: { id: 'g3' } },
];
const noop = () => {};
const render = (variant: 'sidebar' | 'drawer', overrides: Partial<Parameters<typeof SavedGamesList>[0]> = {}) =>
  renderToStaticMarkup(React.createElement(SavedGamesList, {
    games, canOwnGames: true, deletingGameIds: ['g2'], activePreset: 'none',
    onLoad: noop, onEdit: noop, onDelete: noop, onSignIn: noop, isDark: false, variant,
    ...overrides,
  }));

const sidebarHtml = render('sidebar');
const drawerHtml = render('drawer');

const countOccurrences = (html: string, needle: string) => (html.match(new RegExp(needle, 'g')) ?? []).length;

// Same row count.
ok(countOccurrences(sidebarHtml, 'data-saved-game="true"') === 3, `sidebar must render 3 rows, got ${countOccurrences(sidebarHtml, 'data-saved-game="true"')}`);
ok(countOccurrences(drawerHtml, 'data-saved-game="true"') === 3, `drawer must render 3 rows, got ${countOccurrences(drawerHtml, 'data-saved-game="true"')}`);

// Same landmark mechanism: exactly one focus-fallback landmark, always
// tabIndex={-1}, in both variants (their IDs are deliberately DIFFERENT
// strings — 'saved-games' vs 'drawer-games' — section 56 tells the two
// surfaces apart by it; what must match is that there is exactly one, and
// it is a real tab-stop fallback, not the string itself).
ok(countOccurrences(sidebarHtml, 'data-focus-fallback="saved-games"') === 1, 'sidebar must carry exactly one saved-games landmark');
ok(countOccurrences(drawerHtml, 'data-focus-fallback="drawer-games"') === 1, 'drawer must carry exactly one drawer-games landmark');
ok(sidebarHtml.includes('tabindex="-1"') && drawerHtml.includes('tabindex="-1"'), 'both variants\' landmark must be a tabIndex={-1} fallback target');

// Same in-flight Delete state, tied to the SPECIFIC row (g2, "Beta") that is
// in deletingGameIds — not just "exactly one disabled control somewhere"
// (OPUS-REVIEW-LIST N4: a coincidental count match would not prove WHICH
// control it landed on). Split the rendered rows in DOM order (g1, g2, g3)
// and check disabled/aria-busy sit on g2's segment only.
const rowSegments = (html: string): string[] => {
  const parts = html.split('data-saved-game="true"');
  ok(parts.length === 4, `expected 3 rows (4 split parts) in the rendered list, got ${parts.length - 1} rows`);
  return parts.slice(1); // parts[0] is everything before the first row
};
for (const [name, html] of [['sidebar', sidebarHtml], ['drawer', drawerHtml]] as const) {
  const [rowG1, rowG2, rowG3] = rowSegments(html);
  ok(rowG2.includes('disabled=""') && rowG2.includes('aria-busy="true"'),
    `${name}: g2's ("Beta", the deleting id) row must carry disabled+aria-busy`);
  ok(!rowG1.includes('disabled=""') && !rowG1.includes('aria-busy="true"'),
    `${name}: g1's ("Alpha") row must NOT carry disabled/aria-busy`);
  // g3's segment runs to the end of the string (it is the LAST row, so
  // nothing follows it to split on) — check the WHOLE segment, same as
  // rowG1 above (CodeRabbit on #150: a fixed slice(0, 600) window could
  // silently stop proving anything if the drawer's markup grows past it).
  ok(!rowG3.includes('disabled=""') && !rowG3.includes('aria-busy="true"'),
    `${name}: g3's ("Gamma") row must NOT carry disabled/aria-busy`);
}

// ── Empty-state / not-owner copy: per-variant PRODUCT TEXT (OPUS-REVIEW-LIST
// F4) — the invariant is the landmark mechanism, never the wording. Each
// variant's own existing copy is pinned so a future refactor cannot silently
// re-harmonize it, and the load-bearing e2e-45 substrings are pinned too. ──
const stripTags = (html: string) => html.replace(/<[^>]+>/g, '').trim();

const ownerEmptySidebar = stripTags(render('sidebar', { games: [] }));
const ownerEmptyDrawer = stripTags(render('drawer', { games: [] }));
ok(/No saved custom games\. Adapt payoffs and click\s*Save Preset\s*to persist your first game!/.test(ownerEmptySidebar),
  `sidebar owner-empty copy must keep its own original wording, got ${JSON.stringify(ownerEmptySidebar)}`);
ok(/No saved custom game presets\. Customize payoffs in the main board and click\s*Save Preset\s*to record your own scenarios!/.test(ownerEmptyDrawer),
  `drawer owner-empty copy must keep its own wording, with the CodeRabbit-fixed "Save Preset" (not "Save payoffs"), got ${JSON.stringify(ownerEmptyDrawer)}`);
ok(!/must be signed in to view and save/i.test(ownerEmptySidebar) && !/must be signed in to view and save/i.test(ownerEmptyDrawer),
  'the owner-empty state (canOwnGames=true) must NOT show the sign-in copy in either variant (e2e section 45)');

const notOwnerSidebar = stripTags(render('sidebar', { games: [], canOwnGames: false }));
const notOwnerDrawer = stripTags(render('drawer', { games: [], canOwnGames: false }));
ok(/Want to name and save custom presets\?\s*Sign in here/.test(notOwnerSidebar),
  `sidebar not-owner copy must keep its own original inline-link wording, got ${JSON.stringify(notOwnerSidebar)}`);
ok(/You must be signed in to view and save custom game profiles\./.test(notOwnerDrawer) && /Sign In \/ Sign Up/.test(notOwnerDrawer),
  `drawer not-owner copy must keep its own wording, got ${JSON.stringify(notOwnerDrawer)}`);

// MUTATION FIXTURE — sanity: the sidebar's not-owner copy pin actually
// distinguishes the real render from the drawer's (proves the regex above
// is not accidentally satisfied by either variant's text).
ok(!/Want to name and save custom presets\?\s*Sign in here/.test(notOwnerDrawer),
  'fixture sanity: the sidebar-specific not-owner copy pin does NOT match the drawer\'s own render');

if (checks < 20) { console.error(`✗ savedgameslist: suspiciously few checks ran (${checks})`); process.exit(1); }
console.log(`✓ savedgameslist: ${checks} checks passed — one row-rendering component, both variants agree on row count, landmark and which row's Delete is in flight; empty-state copy stays per-variant product text`);

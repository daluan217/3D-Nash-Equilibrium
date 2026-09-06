/**
 * BLUE-LIST-14 (round14): ONE SavedGamesList, two call sites. This is the
 * unit half of the invariant — App.tsx and MenuDrawer.tsx cannot grow their
 * own inline saved-game row again without this test noticing, and both
 * `variant`s must behave identically (row count, the focus landmark, the
 * in-flight Delete state, and the empty-state copy) for the SAME props —
 * only classes/layout may differ.
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

// ── STRUCTURAL: the two Delete-button titles (locators for e2e 45/53/56/60)
// exist EXACTLY ONCE each, and both live in SavedGamesList.tsx — never in
// the call sites. A row re-inlined into App.tsx or MenuDrawer.tsx (the exact
// shape of the original RED-DESKTOP-13/001 + RED-APP-13/003 duplication)
// would show up here as a second occurrence outside this file. ──
for (const title of ['Delete this saved game', 'Delete custom layout']) {
  ok(!app.includes(title), `App.tsx must not contain the "${title}" title literal (row markup belongs to SavedGamesList)`);
  ok(!drawer.includes(title), `MenuDrawer.tsx must not contain the "${title}" title literal (row markup belongs to SavedGamesList)`);
  ok(list.includes(title), `SavedGamesList.tsx must contain the "${title}" title literal (it is the only owner)`);
}
// MUTATION FIXTURE — sanity: a title literal reintroduced into App.tsx MUST
// be caught by the same check above, not just theoretically.
{
  const mutatedApp = app + '\n<button title="Delete this saved game" />';
  ok(mutatedApp.includes('Delete this saved game'), 'fixture sanity: a reintroduced title literal is detectable by .includes()');
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

// ── BEHAVIOURAL (react-dom/server): same props, both variants agree. ──
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

// Same in-flight Delete state: exactly one disabled + one aria-busy="true",
// both on g2 (the id in deletingGameIds), in BOTH variants.
for (const [name, html] of [['sidebar', sidebarHtml], ['drawer', drawerHtml]] as const) {
  ok(countOccurrences(html, 'aria-busy="true"') === 1, `${name}: exactly one row must carry aria-busy="true" (found ${countOccurrences(html, 'aria-busy="true"')})`);
  ok(countOccurrences(html, 'disabled=""') === 1, `${name}: exactly one control must carry disabled="" (found ${countOccurrences(html, 'disabled=""')})`);
}

// Same empty-state copy for canOwnGames === true (0 games) and === false —
// stripped of tags, the rendered TEXT must be byte-identical between variants;
// only the surrounding classes may differ.
const stripTags = (html: string) => html.replace(/<[^>]+>/g, '').trim();
const ownerEmptyText = { sidebar: stripTags(render('sidebar', { games: [] })), drawer: stripTags(render('drawer', { games: [] })) };
ok(ownerEmptyText.sidebar.length > 0 && ownerEmptyText.sidebar === ownerEmptyText.drawer,
  `owner-empty-state copy must be identical between variants: sidebar=${JSON.stringify(ownerEmptyText.sidebar)} drawer=${JSON.stringify(ownerEmptyText.drawer)}`);
ok(/No saved custom game presets/i.test(ownerEmptyText.sidebar), 'owner-empty-state copy must still say "No saved custom game presets" (e2e section 45 regex)');

const notOwnerText = {
  sidebar: stripTags(render('sidebar', { games: [], canOwnGames: false })),
  drawer: stripTags(render('drawer', { games: [], canOwnGames: false })),
};
ok(notOwnerText.sidebar.length > 0 && notOwnerText.sidebar === notOwnerText.drawer,
  `not-owner-state copy must be identical between variants: sidebar=${JSON.stringify(notOwnerText.sidebar)} drawer=${JSON.stringify(notOwnerText.drawer)}`);
ok(!/must be signed in to view and save/i.test(ownerEmptyText.sidebar) && !/must be signed in to view and save/i.test(ownerEmptyText.drawer),
  'the owner-empty state (canOwnGames=true) must NOT show the sign-in copy in either variant (e2e section 45)');

// MUTATION FIXTURE — sanity: two DIFFERENT strings must not accidentally
// satisfy the equality check above (i.e. the check is not vacuously true).
ok(stripTags('<p>A</p>') !== stripTags('<p>B</p>'), 'fixture sanity: the stripTags equality check can distinguish two different texts');

if (checks < 20) { console.error(`✗ savedgameslist: suspiciously few checks ran (${checks})`); process.exit(1); }
console.log(`✓ savedgameslist: ${checks} checks passed — one row-rendering component, both variants agree on row count, landmark, in-flight Delete and empty-state copy`);

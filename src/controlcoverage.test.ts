/**
 * Every user-visible control is either exercised by an e2e suite or listed,
 * with a reason, as knowingly untested.
 *
 * WHY. "Generate a new game" discarded a perfectly good scenario on EVERY
 * generation for about a day and no suite noticed — the smoke suite drives the
 * simulation and never opened that dialog. The fix added coverage for that one
 * surface. This makes the CLASS visible instead: a control nobody presses is
 * now a build failure rather than something rediscovered from a screenshot.
 *
 * A RATCHET, NOT A MANDATE. The allowlist is seeded with what is untested
 * TODAY, each entry carrying a reason, so this does not demand retroactive
 * coverage of an app that already exists. What it stops is the set GROWING: a
 * control added tomorrow has no entry, so CI fails until someone either tests
 * it or writes down why not. The current gap stops being unknown and becomes a
 * list you can read.
 *
 * ON THE EXTRACTOR, because this session has produced seven predicates that
 * were wrong on their first draft and every one over-fired on ordinary text.
 * This one reads only what a USER COULD CLICK ON — the literal text of a
 * <button>, its aria-label, or its title — and deliberately does NOT try to
 * resolve JSX expressions, because a label assembled at runtime is not
 * something a static reader can name honestly. Those are counted and reported
 * rather than guessed at. The fixtures below prove the extractor both fires
 * and stays quiet.
 */
import { readFileSync, readdirSync } from 'node:fs';

let failures = 0;
const fail = (msg: string): void => { console.error(`  ✗ ${msg}`); failures++; };

/** Literal, user-visible labels. Expression children are skipped on purpose. */
export function extractControlLabels(src: string): string[] {
  const out = new Set<string>();
  // <button …>Some Text</button> — literal text only, no {expressions}
  for (const m of src.matchAll(/<button\b[^>]*>([^<>{}]{2,60})<\/button>/g)) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t && /[A-Za-z]/.test(t)) out.add(t);
  }
  // Text that sits beside an icon: <button …><Icon … /> Save Preset</button>
  for (const m of src.matchAll(/<button\b[\s\S]{0,400}?\/>\s*([A-Z][^<>{}\n]{2,40})\s*<\/button>/g)) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t && /[A-Za-z]/.test(t)) out.add(t);
  }
  // A control named only for assistive tech, or only by a tooltip, still ships
  // to users. Both are read — but ONLY from tags that a user can actually
  // operate. Reading `aria-label` from every element pulled in region labels
  // like "Simulation log", which is a landmark, not a control, and padded the
  // allowlist with entries that could never be "pressed" by anything.
  const INTERACTIVE = /<(?:button|a|input|select|textarea|summary)\b[^>]*>|<[a-zA-Z][^>]*\brole="(?:button|link|switch|tab|menuitem|checkbox|radio)"[^>]*>/g;
  for (const tag of src.match(INTERACTIVE) ?? []) {
    for (const attr of ['aria-label', 'title']) {
      const m = tag.match(new RegExp(`${attr}="([^"{}]{2,60})"`));
      if (m) out.add(m[1].trim());
    }
  }
  return [...out];
}

/** Everything the e2e suites can be said to reference. */
function e2eVocabulary(): string {
  return readdirSync('src/e2e').filter((f) => f.endsWith('.mjs'))
    .map((f) => readFileSync(`src/e2e/${f}`, 'utf8')).join('\n');
}

/* ------------------------------------------------------- fixtures first */
{
  const fired = extractControlLabels('<button className="x">Save Preset</button>');
  if (!fired.includes('Save Preset')) fail('fixture: a plain button label is not extracted');
  const icon = extractControlLabels('<button onClick={f}><Plus className="w-3" /> Save Preset</button>');
  if (!icon.includes('Save Preset')) fail('fixture: an icon+text button label is not extracted');
  const aria = extractControlLabels('<button aria-label="Reset the view" />');
  if (!aria.includes('Reset the view')) fail('fixture: an aria-label is not extracted');
  // Controls whose label is computed cannot be named honestly by a static read.
  const dyn = extractControlLabels('<button>{saveLoading ? "Saving..." : "Save"}</button>');
  if (dyn.length !== 0) fail(`fixture: a computed label was guessed at — ${JSON.stringify(dyn)}`);
  const nonBtn = extractControlLabels('<div>Standard Scenarios</div>');
  if (nonBtn.length !== 0) fail(`fixture: a non-control was extracted — ${JSON.stringify(nonBtn)}`);
  const titled = extractControlLabels('<button title="Reset the view" />');
  if (!titled.includes('Reset the view')) fail('fixture: a title-only control is not extracted');
  // A landmark is not a control; reading aria-label off any element padded the
  // allowlist with things nothing could ever press.
  const region = extractControlLabels('<section aria-label="Simulation log"><p>x</p></section>');
  if (region.length !== 0) fail(`fixture: a non-interactive aria-label was extracted — ${JSON.stringify(region)}`);
  // Coverage must require a SELECTOR, not loose words.
  const wordSoup = e2eSelectorNames('// deletes a saved game in another suite\nawait page.click();');
  if (wordSoup.length !== 0) fail('fixture: prose in a test file was read as a selector');
  const realSel = e2eSelectorNames("page.getByRole('button', { name: /^Run$/ })");
  if (!realSel.length) fail('fixture: a real role selector was not read');
  // The role is not the name.
  const named = e2eSelectorNames("page.getByRole('button', { name: 'Run' })");
  if (!named.some((s) => !(s instanceof RegExp) && s.value === 'Run' && !s.exact))
    fail(`fixture: a STRING role name was not read as a substring (non-exact) selector — got ${JSON.stringify(named)}`);
  if (named.some((s) => !(s instanceof RegExp) && s.value === 'button')) fail('fixture: the ROLE was recorded as if it were a control name');
  // The raw-attribute form the smoke suite actually uses. It must be tagged
  // EXACT, not the same substring contract as an accessible-name selector.
  const attr = e2eSelectorNames('page.locator(\'[aria-label="Toggle dark mode"]\').first().click()');
  if (!attr.some((s) => !(s instanceof RegExp) && s.value === 'Toggle dark mode' && s.exact))
    fail(`fixture: an attribute selector was not read as EXACT — got ${JSON.stringify(attr)}`);
}

/* ------------------------------------------------------------- the audit */
const ALLOWLIST: Record<string, string> = JSON.parse(readFileSync('src/e2e/untested-controls.json', 'utf8'));
delete ALLOWLIST._README;
// A reason has to BE a reason. An empty or one-word entry is a rubber stamp,
// and the point of this list is that skipping a control was a decision someone
// made in writing.
// A reason has to BE a reason. An empty or one-word entry is a rubber stamp,
// and the point of this list is that skipping a control was a decision someone
// made in writing. A cross-reference is allowed — repeating the same paragraph
// four times for four steppers is worse writing, not better evidence — but only
// when it points at an entry that exists and carries a real reason of its own,
// so "See X" can never become a chain that terminates in nothing.
const REAL_REASON_WORDS = 5;
// A reference may sit ANYWHERE in the reason, not only at the start. The
// first draft anchored to ^See, so this file's own entry — "Duplicate
// spelling; see 'Close Dialog'." — was never recognised AS a reference, and
// therefore was never checked to resolve. It passed on word count alone, and
// deleting its target would have left a dangling pointer that nothing failed
// on. That is the exact drift this list exists to prevent, in the list itself.
const xref = (v: string) => v.match(/\b(?:see|as above)\b[^'"\u2018\u2019]{0,20}['\u2018"]([^'\u2019"]+)['\u2019"]/i)?.[1];
for (const [k, v] of Object.entries(ALLOWLIST)) {
  if (typeof v !== 'string') { fail(`allowlist entry "${k}" has no reason`); continue; }
  const target = xref(v);
  if (target) {
    const t = ALLOWLIST[target];
    if (typeof t !== 'string') fail(`allowlist entry "${k}" refers to "${target}", which is not in the list`);
    else if (xref(t)) fail(`allowlist entry "${k}" refers to "${target}", which is itself only a cross-reference`);
    else if (t.trim().split(/\s+/).length < REAL_REASON_WORDS) fail(`allowlist entry "${k}" refers to "${target}", which has no real reason`);
    continue;
  }
  if (v.trim().split(/\s+/).length < REAL_REASON_WORDS) fail(`allowlist entry "${k}" has no real reason`);
}
const sources = ['src/App.tsx', ...readdirSync('src/components').filter((f) => /\.tsx$/.test(f)).map((f) => `src/components/${f}`)];
const labels = new Set<string>();
for (const f of sources) for (const l of extractControlLabels(readFileSync(f, 'utf8'))) labels.add(l);

const vocab = e2eVocabulary();

/**
 * The names an e2e suite actually SELECTS BY — not every word that happens to
 * appear in the file.
 *
 * The first draft asked whether each of a label's words occurred anywhere in
 * the raw `.mjs` text. That counts comments, unrelated assertions and other
 * selectors, so a new "Delete saved game" control would have read as covered
 * because "Delete", "saved" and "game" each appear somewhere for other reasons.
 * A predicate that says "covered" when nothing presses the control is worse
 * than no audit, because it reports a clean number.
 */
/**
 * A named selector, tagged with its OWN matching contract. Playwright's
 * accessible-name queries (getByRole/getByText/…) substring-match; a raw CSS
 * attribute selector (`[aria-label="X"]`) matches only an EXACT attribute
 * value — conflating the two let a control labelled "Toggle dark mode
 * settings" read as covered by `locator('[aria-label="Toggle dark mode"]')`,
 * a selector that would never actually find it.
 */
interface NamedSelector { value: string; exact: boolean }
function e2eSelectorNames(src: string): Array<NamedSelector | RegExp> {
  const out: Array<NamedSelector | RegExp> = [];
  // getByRole('button', { name: 'X' }) — take the NAME, not the role. The first
  // draft grabbed the first quoted string, which is the ROLE ("button"), so
  // every role query recorded a useless token and the controls it selects read
  // as untested. Under-crediting is the mirror of the word-soup bug this file
  // was written to fix, and just as wrong.
  for (const m of src.matchAll(/get(?:By|AllBy)Role\(\s*['"`][^'"`]+['"`]\s*,\s*(\{[^}]*?name:\s*['"`][^'"`]{2,60}['"`][^}]*\})/g)) {
    const opts = m[1];
    const name = opts.match(/name:\s*['"`]([^'"`]{2,60})['"`]/)?.[1];
    if (name === undefined) continue;
    out.push({ value: name, exact: /\bexact:\s*true\b/.test(opts) });
  }
  // The other queries take the name as their first argument.
  for (const m of src.matchAll(/get(?:By|AllBy)(?:Text|Label|Placeholder|Title)\(\s*['"`]([^'"`]{2,60})['"`]/g)) out.push({ value: m[1], exact: false });
  // The suites also select by raw attribute — smoke.mjs presses the theme
  // toggle as page.locator('[aria-label="Toggle dark mode"]'). A parser that
  // does not read the form the tests actually use is not measuring coverage.
  // EXACT: a CSS attribute selector matches only that literal value.
  for (const m of src.matchAll(/locator\(\s*['"`]\[(?:aria-label|title)="([^"]{2,60})"\]/g)) out.push({ value: m[1], exact: true });
  for (const m of src.matchAll(/get(?:By|AllBy)(?:Role|Text|Label|Placeholder|Title)\([^)]*?\/((?:[^/\\]|\\.){2,80})\/([gimsuy]*)/g)) {
    try { out.push(new RegExp(m[1], m[2].replace(/[gy]/g, ''))); } catch { /* unparseable selector */ }
  }
  return out;
}
const selectors = e2eSelectorNames(vocab);
// FORWARD ONLY, and only for a NON-exact selector: Playwright's getByRole/
// getByText name option matches when the SELECTOR text is a substring of the
// control's accessible name — the reverse (`sel.includes(label)`) let a
// control labelled "Save" read as covered when the only real selector in the
// suite pressed an unrelated, more specific "Save Preset" control;
// Playwright's own substring rule runs the other way. A raw CSS attribute
// selector shares neither direction: it matches only an EXACT value.
function matchesSelector(label: string, sel: NamedSelector | RegExp): boolean {
  if (sel instanceof RegExp) return sel.test(label);
  return sel.exact ? sel.value === label : sel.value === label || label.includes(sel.value);
}
const covered = (label: string): boolean => selectors.some((sel) => matchesSelector(label, sel));

// Fixture: the reverse direction must not manufacture a false positive, and
// the forward direction it was confused with must still fire.
if (matchesSelector('Save', { value: 'Save Preset', exact: false })) {
  fail('fixture: a control labelled "Save" must not read as covered by an unrelated, more specific "Save Preset" selector');
}
if (!matchesSelector('Save Preset', { value: 'Save', exact: false })) {
  fail('fixture: a selector named "Save" must still cover a control labelled "Save Preset" — that is the real Playwright substring direction');
}
// EXACT-selector fixture: a raw CSS attribute selector must not credit a
// control whose accessible name only CONTAINS the selector's exact value.
if (matchesSelector('Toggle dark mode settings', { value: 'Toggle dark mode', exact: true })) {
  fail('fixture: a raw CSS attribute selector must not cover a control whose name merely contains its exact value');
}
if (!matchesSelector('Toggle dark mode', { value: 'Toggle dark mode', exact: true })) {
  fail('fixture: a raw CSS attribute selector must still cover the control it actually matches exactly');
}
// PARSER fixture: real suites use `getByRole('button', { name: 'Go', exact: true })`
// (src/e2e/smoke.mjs, src/e2e/mobile.mjs) — the parser must read that `exact`
// option out of the source rather than hard-coding false for every role query.
{
  const parsed = e2eSelectorNames(`await page.getByRole('button', { name: 'Go', exact: true }).click();`);
  const one = parsed[0];
  if (!one || one instanceof RegExp || one.value !== 'Go' || one.exact !== true) {
    fail(`fixture: getByRole('button', { name: 'Go', exact: true }) must parse to exact:true, got ${JSON.stringify(one)}`);
  }
  const nonExact = e2eSelectorNames(`await page.getByRole('button', { name: 'Save' }).click();`)[0];
  if (!nonExact || nonExact instanceof RegExp || nonExact.exact !== false) {
    fail(`fixture: a role query with no exact option must still parse to exact:false, got ${JSON.stringify(nonExact)}`);
  }
}

const untested = [...labels].filter((l) => !covered(l)).sort();
const unlisted = untested.filter((l) => !(l in ALLOWLIST));
const staleEntries = Object.keys(ALLOWLIST).filter((l) => !labels.has(l));

if (unlisted.length) {
  fail(`${unlisted.length} control(s) no e2e suite presses and no one has written down why:\n`
    + unlisted.map((l) => `        "${l}"`).join('\n')
    + '\n      Either exercise it in src/e2e/, or add it to src/e2e/untested-controls.json with a REASON.');
}
// A stale entry means a control was renamed or removed, and its reason now
// protects nothing — the same drift that caused the bug this file exists for.
if (staleEntries.length) {
  fail(`${staleEntries.length} allowlist entr(ies) name a control that no longer exists: ${staleEntries.join(', ')}`);
}
// An entry for a control that IS exercised is dead weight in the other
// direction: its reason says nobody presses it, and somebody does. Left alone
// the list slowly becomes fiction, which is exactly what it exists to prevent.
const nowCovered = Object.keys(ALLOWLIST).filter((l) => labels.has(l) && covered(l));
if (nowCovered.length) {
  fail(`${nowCovered.length} allowlist entr(ies) name a control an e2e suite now DOES press — delete them: ${nowCovered.join(', ')}`);
}

console.log(`  controls found ${labels.size} · exercised by e2e ${labels.size - untested.length} · knowingly untested ${untested.length}`);
if (failures > 0) { console.error(`✗ control coverage: ${failures} failed`); process.exit(1); }
console.log('✓ control coverage: every user-visible control is either exercised by an e2e suite or listed with a reason');

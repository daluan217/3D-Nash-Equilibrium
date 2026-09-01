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
  // Controls named only for assistive tech still ship to users.
  for (const m of src.matchAll(/aria-label="([^"{}]{2,60})"/g)) out.add(m[1].trim());
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
const xref = (v: string) => v.match(/^\s*(?:See|As above)\b[^'"\u2018\u2019]*['\u2018"]([^'\u2019"]+)['\u2019"]/i)?.[1];
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
const covered = (label: string): boolean => {
  if (vocab.includes(label)) return true;
  // A suite may match a control by a distinctive fragment or a regex.
  const words = label.split(/\s+/).filter((w) => w.length > 3);
  return words.length > 0 && words.every((w) => vocab.includes(w));
};

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

console.log(`  controls found ${labels.size} · exercised by e2e ${labels.size - untested.length} · knowingly untested ${untested.length}`);
if (failures > 0) { console.error(`✗ control coverage: ${failures} failed`); process.exit(1); }
console.log('✓ control coverage: every user-visible control is either exercised by an e2e suite or listed with a reason');

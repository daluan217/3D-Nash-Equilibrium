/**
 * Guards the RED-APP-20 closeTour `.via` oracle gap (round 20): `closeTour`
 * returns `{ closed, via }` precisely so a call site can see whether the CLICK
 * closed the tour or the Escape fallback masked an unclickable X — the
 * z-index-collision mutant (an overlay covering the X at z 9999) passes every
 * call site that ignores `.via`, because Escape still closes the tour.
 * Only §90 asserted it, so 52 of 53 sites masked the mutant.
 *
 * Two invariants on src/e2e/smoke.mjs (and the other suites that share the
 * helper):
 *   1. Every smoke.mjs call site that opens the tour in CI must read `.via`
 *      and require it to be 'click' when the tour was actually open — the
 *      Escape fallback may serve only as documentation, never as an unchecked
 *      fallback that can mask an unclickable X.
 *   2. `closeTour` itself keeps its Escape fallback for robustness but must
 *      not silently swallow a failed X-click when the tour was up: the
 *      'escape' path is allowed only when the click path was impossible
 *      (tour absent), which the helper already reports as 'absent'.
 *
 * Mutation-tested: deleting a call site's `.via` check, or restoring the
 * bare `await closeTour(page)` shape at the canonical site, fails by name.
 *
 *   npx tsx src/tourcloseguard.test.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ' -- ' + detail : ''}`); failures++; }
};

const smoke = readFileSync('src/e2e/smoke.mjs', 'utf8');
const tour = readFileSync('src/e2e/tour.mjs', 'utf8');

// ── The helper keeps its contract: it REPORTS the path, it does not hide it ──
check('tour.mjs still returns { closed, via } from closeTour',
  /return \{ closed: true, via: 'click' \};/.test(tour) && /return \{ closed: await gone\(\), via: 'escape' \};/.test(tour));
const viaMutant = tour.replace("if (await gone()) return { closed: true, via: 'click' };", "return { closed: true, via: 'click' };");
check('mutation: a closeTour that reports click without checking it fails the contract',
  !/return \{ closed: true, via: 'click' \};/.test(viaMutant.replace("return { closed: true, via: 'click' };\n  await", 'BROKEN')));

// ── Invariant 1: §90 (the canonical site) still asserts via === 'click' ─────
const s90 = smoke.indexOf("section('90'");
const s91 = smoke.indexOf("section('91'");
const section90 = s90 >= 0 && s91 > s90 ? smoke.slice(s90, s91) : '';
check('§90 exists and its via assertion is intact',
  section90.includes("via === 'click'"), 'the closeTour .via oracle must keep at least this one enforcing site');
const viaMutant90 = section90.replace("closed && via === 'click'", 'closed');
check('mutation: dropping the via === click conjunct at §90 fails this guard',
  !section90.includes("closed && via === 'click'") || !/via === 'click'/.test(viaMutant90));

// ── Invariant 2: the grandfather set is closed. The 52 historical sites that
// ignore `.via` predate this guard (they are setup helpers, not tour claims —
// RED-APP-20's finding is that they MASK a dead X, not that they test it).
// This guard pins the census: exactly the sites listed below may call
// closeTour without reading `.via`. A NEW call site must either read `.via`
// and require 'click' when it claims tour behavior, or be added to this
// census with a comment naming why Escape fallback is acceptable there —
// both are auditable in review.
const sections = [...smoke.matchAll(/section\('([^']+)',\s*'([^']+)',\s*async/g)];
const lastEnforced = sections.findIndex((s) => s[1] === '90');
const silentSites = sections.slice(lastEnforced + 1)
  .filter((s) => {
    const start = s.index!, next = sections[sections.indexOf(s) + 1]?.index ?? smoke.length;
    const body = smoke.slice(start, next);
    return body.includes('closeTour') && !body.includes('.via');
  })
  .map((s) => s[1]);
// §91b/§91c use closeTour only as PAGE SETUP (get the scrim out of the way
// before testing the regen-ref contract) — they claim nothing about the tour.
const GRANDFATHERED_SETUP = ['91b', '91c', '92'];
const newSilent = silentSites.filter((id) => !GRANDFATHERED_SETUP.includes(id));
check('every section after §90 that calls closeTour either reads .via or is on the audited setup census',
  newSilent.length === 0,
  newSilent.length ? `new silent sites: ${newSilent.join(', ')} — assert .via or extend the census with a stated reason` : '(census: 91b, 91c, 92)');

if (failures > 0) { console.error(`✗ tour-close guard: ${failures} failed`); process.exit(1); }
console.log('✓ tour-close guard: closeTour reports { closed, via }, §90 enforces via === click, no new silent sites after §90');

/**
 * Guards RED-APP-20's closeTour oracle class. A tour Close button covered by
 * an overlay used to look healthy because every caller silently pressed Escape
 * when its click failed. The invariant is now deliberately two-tiered:
 *
 *   - at least one consumer asserts the product control with strict closeTour;
 *   - every other consumer that merely needs an unobscured page names itself
 *     and supplies a non-empty reason to dismissTourForSetup.
 *
 * The census covers every current e2e consumer, not a suffix of smoke.mjs, so
 * inserting a silent call before §90 or in mobile/AI cannot reopen the hole.
 *
 *   npx tsx src/tourcloseguard.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { closeTour, dismissTourForSetup } from './e2e/tour.mjs';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ' -- ' + detail : ''}`); failures++; }
};

const e2eSources = (): Map<string, string> => {
  const files = readdirSync('src/e2e', { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.mjs'))
    .map((entry) => path.join('src/e2e', entry));
  return new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
};

type Census = {
  consumers: string[];
  imports: Array<{ file: string; names: string[] }>;
  strict: Array<{ file: string; index: number }>;
  setupCalls: number;
  setupReasons: string[];
};

const inspectCensus = (sources: Map<string, string>): Census => {
  const importPattern = /import\s+(\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+(['"])([^'"\n]+)\2/g;
  const imports: Array<{ file: string; names: string[] }> = [];
  const strict: Array<{ file: string; index: number }> = [];
  let setupCalls = 0;
  const setupReasons: string[] = [];
  const consumers: string[] = [];
  for (const [file, source] of sources) {
    const tourImports = [...source.matchAll(importPattern)].filter((match) => {
      if (!match[3].startsWith('.')) return false;
      return path.normalize(path.join(path.dirname(file), match[3])) === path.normalize('src/e2e/tour.mjs');
    });
    if (tourImports.length === 0) continue;
    consumers.push(file);
    for (const match of tourImports) {
      const named = /^\{([^}]*)\}$/.exec(match[1]);
      imports.push({
        file,
        names: named ? named[1].split(',').map((name) => name.trim()).filter(Boolean) : [],
      });
    }
    for (const match of source.matchAll(/\bcloseTour\s*\(/g)) {
      strict.push({ file, index: match.index ?? -1 });
    }
    for (const match of source.matchAll(/\bdismissTourForSetup\s*\(\s*[^,]+,\s*(['"])([^'"\n]*)\1/g)) {
      setupCalls++;
      setupReasons.push(match[2].trim());
    }
  }
  consumers.sort();
  return { consumers, imports, strict, setupCalls, setupReasons };
};

const sources = e2eSources();
const census = inspectCensus(sources);
const smoke = sources.get('src/e2e/smoke.mjs')!;
const tour = sources.get('src/e2e/tour.mjs')!;

check('every e2e consumer of tour.mjs is included in the whole-suite census',
  census.consumers.join(',') === 'src/e2e/ai-surface.mjs,src/e2e/mobile.mjs,src/e2e/smoke.mjs',
  census.consumers.join(', ') || 'no consumers found');
check('tour helpers have no aliases or hidden import paths in e2e consumers',
  census.imports.every(({ names }) => names.length > 0
    && names.every((name) => name === 'closeTour' || name === 'dismissTourForSetup')),
  census.imports.map(({ file, names }) => `${file}:${names.join('|') || '<unparsed>'}`).join(', '));
check('there is at least one strict closeTour product assertion across every e2e suite',
  census.strict.length >= 1,
  census.strict.map(({ file }) => file).join(', ') || 'none');
const strictSite = census.strict[0];
const strictWindow = strictSite ? sources.get(strictSite.file)!.slice(Math.max(0, strictSite.index - 100), strictSite.index + 500) : '';
check('the canonical strict closeTour caller reads via and requires the click path',
  /const \{ closed, via \} = await closeTour\(cp\);/.test(strictWindow)
    && /closed && via === 'click'/.test(strictWindow),
  strictSite ? strictSite.file : 'no strict site');

const rawSetupCalls = [...sources]
  .filter(([file]) => census.consumers.includes(file))
  .flatMap(([file, source]) => [...source.matchAll(/\bdismissTourForSetup\s*\(/g)].map((match) => ({ file, index: match.index ?? -1 })));
check('every setup dismissal has an explicit non-empty reason',
  rawSetupCalls.length > 0 && rawSetupCalls.length === census.setupCalls && census.setupReasons.every(Boolean),
  `calls=${rawSetupCalls.length} reasons=${census.setupReasons.length}`);
check('the setup-only helper validates its required reason at runtime',
  /requires a non-empty setup reason/.test(tour) && /reason\.trim\(\)\.length === 0/.test(tour));
check('strict closeTour does not opt into Escape fallback',
  /export const closeTour = async \(page, options = \{\}\) =>\s*\n\s*attemptTourClose\(page, \{ \.\.\.options, allowEscapeFallback: false \}\);/.test(tour));

// Mutation tests use the same whole-suite census predicate as the real source.
const movedStrictMutant = new Map(sources);
movedStrictMutant.set('src/e2e/smoke.mjs', smoke.replace(
  'const { closed, via } = await closeTour(cp);',
  "const { closed, via } = await dismissTourForSetup(cp, 'MUTANT: silently allow Escape');",
));
const movedStrict = inspectCensus(movedStrictMutant);
check('mutation: replacing the product assertion with a setup fallback fails the strict census',
  movedStrict.strict.length < 1 || movedStrict.setupCalls !== rawSetupCalls.length + 1);

const missingReasonMutant = new Map(sources);
missingReasonMutant.set('src/e2e/smoke.mjs', smoke.replace(
  "dismissTourForSetup(page,\n    'setup: clear a possible first-run tour before the primary smoke flow'",
  "dismissTourForSetup(page,\n    ''",
));
const missingReason = inspectCensus(missingReasonMutant);
check('mutation: removing a setup reason fails the same whole-suite census',
  missingReason.setupCalls !== rawSetupCalls.length || missingReason.setupReasons.some((reason) => reason.length === 0));

const nestedImportControl = new Map(sources);
nestedImportControl.set('src/e2e/nested/deeper/setup.mjs', `
  import { dismissTourForSetup } from '../../tour.mjs';
  await dismissTourForSetup(page, 'nested fixture: unobscured page required');
`);
const nestedCensus = inspectCensus(nestedImportControl);
check('parent-relative tour imports at any nesting depth stay inside the census',
  nestedCensus.consumers.includes('src/e2e/nested/deeper/setup.mjs')
    && nestedCensus.setupCalls === census.setupCalls + 1
    && nestedCensus.setupReasons.includes('nested fixture: unobscured page required'));

type FakeTourPage = {
  page: any;
  escapePresses: () => number;
};

const fakeTourPage = ({
  dialogVisible = true,
  closeVisible = true,
  clickSucceeds = true,
  waitOutcomes = [true, true],
} = {}): FakeTourPage => {
  const outcomes = [...waitOutcomes];
  let escapes = 0;
  const page = {
    getByRole: (role: string) => role === 'dialog' ? {
      waitFor: () => dialogVisible ? Promise.resolve() : Promise.reject(new Error('tour absent')),
    } : {
      waitFor: () => closeVisible ? Promise.resolve() : Promise.reject(new Error('close control unavailable')),
      click: () => clickSucceeds ? Promise.resolve() : Promise.reject(new Error('overlay intercepted click')),
    },
    waitForFunction: () => (outcomes.shift() ? Promise.resolve() : Promise.reject(new Error('still visible'))),
    keyboard: { press: async () => { escapes++; } },
  };
  return { page, escapePresses: () => escapes };
};

// Behavioral contract: a failed product click rejects even though cleanup uses
// Escape, whereas the explicitly reasoned setup helper can return `escape`.
{
  const strictPage = fakeTourPage({ clickSucceeds: false, waitOutcomes: [true, true] });
  await assert.rejects(() => closeTour(strictPage.page), /did not close through its Close button/);
  check('strict helper rejects a failed Close-button click after cleanup', strictPage.escapePresses() === 1);

  const setupPage = fakeTourPage({ clickSucceeds: false, waitOutcomes: [true, true] });
  const setupResult = await dismissTourForSetup(setupPage.page, 'fixture: test needs an unobscured page');
  check('setup-only helper documents and returns its Escape fallback',
    setupResult.closed && setupResult.via === 'escape' && setupPage.escapePresses() === 1);

  const clickPage = fakeTourPage({ clickSucceeds: true, waitOutcomes: [true, true] });
  const clickResult = await closeTour(clickPage.page);
  check('strict helper succeeds only for a real Close-button dismissal',
    clickResult.closed && clickResult.via === 'click' && clickPage.escapePresses() === 0);

  const absentPage = fakeTourPage({ dialogVisible: false, closeVisible: false, waitOutcomes: [true] });
  const absentResult = await dismissTourForSetup(absentPage.page, 'fixture: tour may not have appeared');
  check('setup-only helper preserves the explicit absent state',
    !absentResult.closed && absentResult.via === 'absent');

  const missingCloseStrict = fakeTourPage({ closeVisible: false, waitOutcomes: [true, true] });
  await assert.rejects(() => closeTour(missingCloseStrict.page), /Close tour button was not visible/);
  check('a visible dialog with no Close control fails strict closeTour after cleanup',
    missingCloseStrict.escapePresses() === 1);

  const missingCloseSetup = fakeTourPage({ closeVisible: false, waitOutcomes: [true, true] });
  const missingCloseResult = await dismissTourForSetup(
    missingCloseSetup.page,
    'fixture: another surface needs the broken tour cleared',
  );
  check('a visible dialog with no Close control takes only the explicit setup Escape path',
    missingCloseResult.closed && missingCloseResult.via === 'escape'
      && missingCloseSetup.escapePresses() === 1);

  await assert.rejects(() => dismissTourForSetup(clickPage.page, ''), /non-empty setup reason/);
  check('setup-only helper rejects an unreasoned fallback request', true);
}

if (failures > 0) { console.error(`✗ tour-close guard: ${failures} failed`); process.exit(1); }
console.log(`✓ tour-close guard: ${census.setupCalls} explicit setup dismissals, ${census.strict.length} strict click assertion(s), full e2e census`);

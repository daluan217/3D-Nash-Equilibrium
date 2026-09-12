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
import ts from 'typescript';
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
  unsupportedTourAccess: string[];
};

const inspectCensus = (sources: Map<string, string>): Census => {
  const imports: Array<{ file: string; names: string[] }> = [];
  const strict: Array<{ file: string; index: number }> = [];
  let setupCalls = 0;
  const setupReasons: string[] = [];
  const consumers: string[] = [];
  const unsupportedTourAccess: string[] = [];
  const isTourModule = (file: string, specifier: string): boolean => specifier.startsWith('.')
    && path.normalize(path.join(path.dirname(file), specifier)) === path.normalize('src/e2e/tour.mjs');

  for (const [file, source] of sources) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let consumesTour = false;
    const fileStrict: Array<{ file: string; index: number }> = [];
    const fileSetupReasons: string[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && isTourModule(file, node.moduleSpecifier.text)) {
        consumesTour = true;
        const clause = node.importClause;
        const names: string[] = [];
        if (clause?.name) names.push(`<default:${clause.name.text}>`);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          names.push(`<namespace:${clause.namedBindings.name.text}>`);
        } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            names.push(element.propertyName ? `${imported} as ${element.name.text}` : imported);
          }
        }
        imports.push({ file, names });
      }

      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && isTourModule(file, node.moduleSpecifier.text)) {
        consumesTour = true;
        unsupportedTourAccess.push(`${file}:re-export`);
      }

      if (ts.isCallExpression(node)) {
        const firstArg = node.arguments[0];
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && firstArg && ts.isStringLiteral(firstArg)
          && isTourModule(file, firstArg.text)) {
          consumesTour = true;
          unsupportedTourAccess.push(`${file}:dynamic-import`);
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === 'require'
          && firstArg && ts.isStringLiteral(firstArg) && isTourModule(file, firstArg.text)) {
          consumesTour = true;
          unsupportedTourAccess.push(`${file}:require`);
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === 'closeTour') {
          fileStrict.push({ file, index: node.getStart(ast) });
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === 'dismissTourForSetup') {
          const reason = node.arguments[1];
          fileSetupReasons.push(reason && ts.isStringLiteralLike(reason) ? reason.text.trim() : '');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);

    if (!consumesTour) continue;
    consumers.push(file);
    strict.push(...fileStrict);
    setupCalls += fileSetupReasons.length;
    setupReasons.push(...fileSetupReasons);
  }
  consumers.sort();
  unsupportedTourAccess.sort();
  return { consumers, imports, strict, setupCalls, setupReasons, unsupportedTourAccess };
};

const sources = e2eSources();
const census = inspectCensus(sources);
const smoke = sources.get('src/e2e/smoke.mjs')!;
const tour = sources.get('src/e2e/tour.mjs')!;

check('every e2e consumer of tour.mjs is included in the whole-suite census',
  census.consumers.join(',') === 'src/e2e/ai-surface.mjs,src/e2e/mobile.mjs,src/e2e/smoke.mjs',
  census.consumers.join(', ') || 'no consumers found');
check('tour helpers have no aliases or hidden import paths in e2e consumers',
  census.unsupportedTourAccess.length === 0
    && census.imports.every(({ names }) => names.length > 0
    && names.every((name) => name === 'closeTour' || name === 'dismissTourForSetup')),
  [...census.unsupportedTourAccess,
    ...census.imports.map(({ file, names }) => `${file}:${names.join('|') || '<unparsed>'}`)].join(', '));
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

const dynamicImportMutant = new Map(sources);
dynamicImportMutant.set('src/e2e/nested/dynamic.mjs', `
  const { dismissTourForSetup } = await import('../tour.mjs');
  await dismissTourForSetup(page, 'MUTANT: dynamically hidden helper');
`);
check('mutation: a dynamic tour-helper import is rejected instead of escaping the census',
  inspectCensus(dynamicImportMutant).unsupportedTourAccess.includes('src/e2e/nested/dynamic.mjs:dynamic-import'));

const reExportMutant = new Map(sources);
reExportMutant.set('src/e2e/nested/re-export.mjs', `
  export { dismissTourForSetup } from '../tour.mjs';
`);
check('mutation: a tour-helper re-export is rejected instead of escaping the census',
  inspectCensus(reExportMutant).unsupportedTourAccess.includes('src/e2e/nested/re-export.mjs:re-export'));

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

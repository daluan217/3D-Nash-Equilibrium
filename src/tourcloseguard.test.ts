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
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true,
  };
  const defaultHost = ts.createCompilerHost(options);
  const virtualSources = new Map([...sources].map(([file, source]) => [
    path.resolve(file),
    ts.createSourceFile(path.resolve(file), source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
  ]));
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (file) => virtualSources.has(path.resolve(file)) || defaultHost.fileExists(file),
    readFile: (file) => virtualSources.get(path.resolve(file))?.text ?? defaultHost.readFile(file),
    getSourceFile: (file, languageVersion) => virtualSources.get(path.resolve(file))
      ?? defaultHost.getSourceFile(file, languageVersion),
  };
  const program = ts.createProgram({ rootNames: [...virtualSources.keys()], options, host });
  const checker = program.getTypeChecker();
  const imports: Array<{ file: string; names: string[] }> = [];
  const strict: Array<{ file: string; index: number }> = [];
  let setupCalls = 0;
  const setupReasons: string[] = [];
  const consumers: string[] = [];
  const unsupportedTourAccess: string[] = [];
  const isTourModule = (file: string, specifier: string): boolean => specifier.startsWith('.')
    && path.normalize(path.join(path.dirname(file), specifier)) === path.normalize('src/e2e/tour.mjs');

  for (const [file] of sources) {
    const ast = program.getSourceFile(path.resolve(file))!;
    let consumesTour = false;
    const fileStrict: Array<{ file: string; index: number }> = [];
    const fileSetupReasons: string[] = [];
    const isImportedTourHelper = (identifier: ts.Identifier, importedName: string): boolean =>
      checker.getSymbolAtLocation(identifier)?.declarations?.some((declaration) => {
        if (!ts.isImportSpecifier(declaration)) return false;
        const importDeclaration = declaration.parent.parent.parent;
        return (declaration.propertyName?.text ?? declaration.name.text) === importedName
          && ts.isImportDeclaration(importDeclaration)
          && ts.isStringLiteral(importDeclaration.moduleSpecifier)
          && isTourModule(file, importDeclaration.moduleSpecifier.text);
      }) ?? false;

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
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && firstArg && ts.isStringLiteralLike(firstArg)
          && isTourModule(file, firstArg.text)) {
          consumesTour = true;
          unsupportedTourAccess.push(`${file}:dynamic-import`);
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === 'require'
          && firstArg && ts.isStringLiteralLike(firstArg) && isTourModule(file, firstArg.text)) {
          consumesTour = true;
          unsupportedTourAccess.push(`${file}:require`);
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === 'closeTour'
          && isImportedTourHelper(node.expression, 'closeTour')) {
          fileStrict.push({ file, index: node.getStart(ast) });
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === 'dismissTourForSetup'
          && isImportedTourHelper(node.expression, 'dismissTourForSetup')) {
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
dynamicImportMutant.set('src/e2e/nested/require.mjs', `
  const tour = require('../tour.mjs');
  await tour.dismissTourForSetup(page, 'MUTANT: require-hidden helper');
`);
const dynamicImportCensus = inspectCensus(dynamicImportMutant);
check('mutation: string-literal dynamic and require access cannot escape the census',
  dynamicImportCensus.consumers.includes('src/e2e/nested/dynamic.mjs')
    && dynamicImportCensus.consumers.includes('src/e2e/nested/require.mjs')
    && dynamicImportCensus.unsupportedTourAccess.includes('src/e2e/nested/dynamic.mjs:dynamic-import')
    && dynamicImportCensus.unsupportedTourAccess.includes('src/e2e/nested/require.mjs:require'));

const templateAccessMutant = new Map(sources);
templateAccessMutant.set('src/e2e/nested/dynamic-template.mjs', `
  const tour = await import(\`../tour.mjs\`);
  await tour.dismissTourForSetup(page, 'MUTANT: dynamically hidden template helper');
`);
templateAccessMutant.set('src/e2e/nested/require-template.mjs', `
  const tour = require(\`../tour.mjs\`);
  await tour.dismissTourForSetup(page, 'MUTANT: require-hidden template helper');
`);
const templateAccessCensus = inspectCensus(templateAccessMutant);
check('mutation: template-literal dynamic and require access cannot escape the census',
  templateAccessCensus.consumers.includes('src/e2e/nested/dynamic-template.mjs')
    && templateAccessCensus.consumers.includes('src/e2e/nested/require-template.mjs')
    && templateAccessCensus.unsupportedTourAccess.includes('src/e2e/nested/dynamic-template.mjs:dynamic-import')
    && templateAccessCensus.unsupportedTourAccess.includes('src/e2e/nested/require-template.mjs:require'));

const shadowedBindingMutant = new Map(sources);
shadowedBindingMutant.set('src/e2e/nested/shadowed.mjs', `
  import { closeTour, dismissTourForSetup } from '../tour.mjs';
  function exercise(closeTour) {
    const dismissTourForSetup = () => ({ closed: true, via: 'click' });
    closeTour(page);
    dismissTourForSetup(page, 'MUTANT: shadowed local helper');
  }
`);
const shadowedBindingCensus = inspectCensus(shadowedBindingMutant);
check('mutation: shadowed helper parameters and local declarations do not satisfy the census',
  shadowedBindingCensus.strict.length === census.strict.length
    && shadowedBindingCensus.setupCalls === census.setupCalls
    && shadowedBindingCensus.setupReasons.length === census.setupReasons.length);

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
  decision = 'shown' as string | null,
  calls = [] as string[],
} = {}): FakeTourPage => {
  const outcomes = [...waitOutcomes];
  let escapes = 0;
  const page = {
    getByRole: (role: string) => role === 'dialog' ? {
      count: async () => { calls.push('dialog.count'); return dialogVisible ? 1 : 0; },
      waitFor: ({ state }: { state: string }) => (calls.push(`dialog.${state}`), state === 'visible')
        ? (dialogVisible ? Promise.resolve() : Promise.reject(new Error('tour absent')))
        : (outcomes.shift() ? Promise.resolve() : Promise.reject(new Error('still visible'))),
    } : {
      waitFor: () => closeVisible ? Promise.resolve() : Promise.reject(new Error('close control unavailable')),
      click: () => clickSucceeds ? Promise.resolve() : Promise.reject(new Error('overlay intercepted click')),
    },
    // TASK-18 H6: the helper's decision wait reads App.tsx's data-tour-auto marker.
    waitForFunction: (fn: () => unknown) => String(fn).includes('tourAuto')
      ? (calls.push('decision'), decision ? Promise.resolve({ jsonValue: async () => decision }) : Promise.reject(new Error('timeout')))
      : (outcomes.shift() ? Promise.resolve() : Promise.reject(new Error('still visible'))),
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

  // TASK-18 H6: never proceed while the tour can still open. The browser proof is smoke §108.
  const order: string[] = [];
  await dismissTourForSetup(fakeTourPage({ calls: order }).page, 'fixture: decision first');
  check('the helper reads the app\'s tour decision before it looks for the dialog',
    order[0] === 'decision' && order.indexOf('decision') < order.indexOf('dialog.visible'), order.join(','));
  const skipCalls: string[] = [];
  const skipResult = await dismissTourForSetup(fakeTourPage({ dialogVisible: false, decision: 'skip', calls: skipCalls }).page, 'fixture: signed in');
  check('a "skip" decision with no dialog answers absent without waiting on the dialog',
    skipResult.via === 'absent' && !skipCalls.includes('dialog.visible'), skipCalls.join(','));
  for (const helper of [closeTour, (p: any) => dismissTourForSetup(p, 'fixture: no decision')]) {
    await assert.rejects(() => helper(fakeTourPage({ decision: null }).page), /never published its tour decision/,
      'no decision published = a loud failure from both helpers, never a silent "absent"');
  }
  check('no decision published = a loud failure from both helpers, never a silent "absent"', true);
}

// TASK-18 H6: data-tour-auto is test-facing only. Nothing under src/ may read it except the
// App.tsx hook that writes it, the e2e helper and suite, and the two static guards that pin them.
const tourAutoReaders = (files: Map<string, string>): string[] => {
  const out: string[] = [];
  const allowed = new Set(['src/e2e/tour.mjs', 'src/e2e/smoke.mjs', 'src/tourcloseguard.test.ts', 'src/e2esharding.test.ts']);
  for (const [file, text] of files) {
    if (allowed.has(file) || !/tour-?auto/i.test(text)) continue;
    if (file === 'src/App.tsx') {
      const a = text.indexOf('// Test-facing only (e2e/tour.mjs;');
      const end = '}, [tourOpen, tourAutoFired]);';
      const b = text.indexOf(end);
      const outside = a < 0 || b < a ? text : text.slice(0, a) + text.slice(b + end.length);
      if (!/tour-?auto/i.test(outside)) continue;
    }
    out.push(file);
  }
  return out;
};
const srcFiles = new Map(readdirSync('src', { recursive: true })
  .filter((entry): entry is string => typeof entry === 'string' && /\.(tsx?|mjs|js|css|html)$/.test(entry) && !/ \d+\./.test(entry))
  .map((entry) => path.join('src', entry)).map((file) => [file, readFileSync(file, 'utf8')]));
check('only the App.tsx hook, the e2e helper and suite, and the two static guards reference data-tour-auto',
  tourAutoReaders(srcFiles).length === 0, tourAutoReaders(srcFiles).join(','));
{
  const planted = new Map(srcFiles);
  planted.set('src/index.css', (planted.get('src/index.css') ?? '') + '\nhtml[data-tour-auto="shown"] .x { display: none; }');
  planted.set('src/App.tsx', (planted.get('src/App.tsx') ?? '') + '\nconst leak = document.documentElement.dataset.tourAuto;');
  check('mutation: a CSS rule and app code reading data-tour-auto are both caught by name',
    tourAutoReaders(planted).join(',') === 'src/App.tsx,src/index.css', tourAutoReaders(planted).join(','));
}
const appSrc = srcFiles.get('src/App.tsx') ?? '';
check('App.tsx publishes "skip" on both no-open branches and "shown" only for the auto-open',
  /everAuthedRef\.current = true;\n\s+document\.documentElement\.dataset\.tourAuto = 'skip';/.test(appSrc)
    && /if \(everAuthedRef\.current\) \{ document\.documentElement\.dataset\.tourAuto = 'skip'; return; \}/.test(appSrc)
    && /if \(tourOpen && tourAutoFired\) document\.documentElement\.dataset\.tourAuto = 'shown';/.test(appSrc));

if (failures > 0) { console.error(`✗ tour-close guard: ${failures} failed`); process.exit(1); }
console.log(`✓ tour-close guard: ${census.setupCalls} explicit setup dismissals, ${census.strict.length} strict click assertion(s), full e2e census`);

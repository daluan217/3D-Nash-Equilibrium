/**
 * Load one of the repo's root .cjs files for real and report whether it throws.
 *
 * WHY THIS EXISTS. On 2026-08-31 a root .cjs file on a since-closed branch (PR
 * #52, DMG-bundled local model) was committed in a state that did not even
 * load — a constant had been renamed and five references to the old name
 * survived, one of them at module top level, so `require()` threw
 * ReferenceError immediately. All five CI jobs went green anyway: `npm run
 * lint` is `tsc --noEmit`, tsconfig sets `allowJs` without `checkJs`, and there
 * is no ESLint in the repo, so the root .cjs files are parsed by nothing and
 * executed by nothing. electron-main.cjs is the app's `main` entry — a module
 * that throws on require bricks the desktop app on launch, and nothing in the
 * pyramid could see it. That specific file never landed on main, but the gap
 * it exposed — no CI job executes ANY root .cjs — is permanent and applies to
 * every file in the set, present and future.
 *
 * `node --check` is not enough: the defect class is syntactically valid (a
 * dangling reference to a renamed/removed identifier). Only really executing
 * the module's top level catches it, which means running these files outside
 * Electron, which means stubbing what they import.
 *
 * The `electron` stub is a total Proxy — every property is a callable,
 * constructible Proxy — so this probe does not have to be revised each time the
 * app touches a new Electron API. A stub can hide an API misuse; it cannot hide
 * an undefined identifier, which is the defect class being guarded.
 *
 * Side effects are refused rather than stubbed loosely: electron-main.cjs's top
 * level requires the compiled Express server, which would bind a port — that
 * require is intercepted and handed an empty module instead.
 *
 * Usage: node src/desktop/require-probe.cjs <absolute path to .cjs>
 * Exit 0 = loaded. Exit 1 = threw (message on stdout).
 */
const Module = require('module');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.log('usage: require-probe.cjs <abs path to .cjs>');
  process.exit(2);
}

/** Callable, constructible, infinitely deep, always truthy. */
function totalStub(name) {
  const fn = function () {};
  fn.__stub = name;
  return new Proxy(fn, {
    get(t, prop) {
      if (prop === 'then') return undefined;            // never look thenable
      if (prop === Symbol.toPrimitive) return () => `[stub ${name}]`;
      if (prop === 'toString') return () => `[stub ${name}]`;
      if (prop in t) return t[prop];
      return totalStub(`${name}.${String(prop)}`);
    },
    apply() { return totalStub(`${name}()`); },
    construct() { return totalStub(`new ${name}`); },
    has() { return true; },
  });
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return totalStub('electron');
  // electron-main.cjs's top level requires the compiled Express server, which
  // binds a port. Hand back an empty module instead of ever letting that run.
  if (/dist[/\\]server\.cjs$/.test(request)) return {};
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require(path.resolve(target));
  console.log(`loaded: ${path.basename(target)}`);
  process.exit(0);
} catch (err) {
  console.log(`${err && err.constructor ? err.constructor.name : 'Error'}: ${String(err && err.message).split('\n')[0]}`);
  process.exit(1);
}

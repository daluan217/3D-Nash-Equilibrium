/**
 * RED-APP-8/004: `safeGetItem`/`safeSetItem`/`safeRemoveItem`
 * (src/utils/safeStorage.ts) must never let a `localStorage` failure escape
 * as an exception — a real `QuotaExceededError` from `setItem` (old Safari
 * private mode, a full per-origin quota) used to blank the ENTIRE app on
 * first mount because the theme-sync effect called the bare API unguarded.
 *
 * This is the pure-function half of the fixture; the browser half (does the
 * app actually still render with a real QuotaExceededError thrown from
 * inside the page) lives in src/e2e/smoke.mjs's RED-APP-8/004 section, since
 * a throwing localStorage and an uncaught-exception-blanks-the-page failure
 * mode can only be observed for real in a browser page, not in this Node
 * process (which has no DOM/localStorage at all, and this file installs its
 * own fake one on `globalThis` for exactly that reason).
 *
 *   npx tsx src/safestorage.test.ts
 */
import assert from 'node:assert';

let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

// ── install a throwing fake localStorage on globalThis, matching how a
//    quota-exhausted browser actually behaves: every call throws a real
//    DOMException named 'QuotaExceededError' ────────────────────────────────
class FakeQuotaExceededError extends Error {
  name = 'QuotaExceededError';
}
const throwingStorage: Storage = {
  length: 0,
  clear() { throw new FakeQuotaExceededError('The quota has been exceeded.'); },
  key() { throw new FakeQuotaExceededError('The quota has been exceeded.'); },
  getItem() { throw new FakeQuotaExceededError('The quota has been exceeded.'); },
  setItem() { throw new FakeQuotaExceededError('The quota has been exceeded.'); },
  removeItem() { throw new FakeQuotaExceededError('The quota has been exceeded.'); },
};
(globalThis as unknown as { localStorage: Storage }).localStorage = throwingStorage;

// Import AFTER installing the fake global — the module reads `localStorage`
// only inside its function bodies (never at module-eval time), so import
// order doesn't matter for correctness, but doing it this way mirrors how a
// real page's script evaluates against an already-present (and already
// broken) `window.localStorage`.
const { safeGetItem, safeSetItem, safeRemoveItem } = await import('./utils/safeStorage');

// ── 1. every wrapper survives a throwing localStorage without throwing ─────
{
  let threw = false;
  let result: string | null = 'unset';
  try {
    result = safeGetItem('nash_sim_theme');
  } catch {
    threw = true;
  }
  ok(!threw, 'safeGetItem must not propagate a throwing localStorage.getItem');
  ok(result === null, `safeGetItem must degrade to null on failure, got ${JSON.stringify(result)}`);
}
{
  let threw = false;
  let result: boolean | 'unset' = 'unset';
  try {
    result = safeSetItem('nash_sim_theme', 'dark');
  } catch {
    threw = true;
  }
  ok(!threw, 'safeSetItem must not propagate a throwing localStorage.setItem (RED-APP-8/004\'s exact defect)');
  ok(result === false, `safeSetItem must report failure (false), got ${JSON.stringify(result)}`);
}
{
  let threw = false;
  let result: boolean | 'unset' = 'unset';
  try {
    result = safeRemoveItem('nash_sim_theme');
  } catch {
    threw = true;
  }
  ok(!threw, 'safeRemoveItem must not propagate a throwing localStorage.removeItem');
  ok(result === false, `safeRemoveItem must report failure (false), got ${JSON.stringify(result)}`);
}

// ── 2. a working localStorage still round-trips normally (no change in
//    behavior for the overwhelmingly common case) ───────────────────────────
{
  const store = new Map<string, string>();
  const workingStorage: Storage = {
    length: 0,
    clear() { store.clear(); },
    key() { return null; },
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    setItem(k: string, v: string) { store.set(k, v); },
    removeItem(k: string) { store.delete(k); },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = workingStorage;

  ok(safeSetItem('k', 'v') === true, 'safeSetItem returns true on success');
  ok(safeGetItem('k') === 'v', 'safeGetItem returns the stored value on success');
  ok(safeRemoveItem('k') === true, 'safeRemoveItem returns true on success');
  ok(safeGetItem('k') === null, 'safeGetItem returns null after removal');
}

// ── MUTATION / NEGATIVE FIXTURE — the pre-fix shape, verbatim (a bare
//    localStorage.setItem call with no try/catch). Proves the fixture text
//    itself can tell the fixed wiring apart from the defect it replaced.
{
  const preFixEffect = `localStorage.setItem('nash_sim_theme', 'dark');`;
  ok(!/safeSetItem/.test(preFixEffect),
    'the pre-fix fixture text must not accidentally already carry the safe wrapper call (fixture sanity check)');
}

console.log(`safestorage.test.ts: ${checks} checks passed`);

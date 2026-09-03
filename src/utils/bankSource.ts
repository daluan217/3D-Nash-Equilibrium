/**
 * The desktop's scenario SOURCE: a pre-verified bank instead of a bundled model.
 *
 * WHY A BANK AND NOT THE 0.6B. The retrained local model's remaining defects are
 * coherence, not lexicon, and they are GENERATED rather than inherited — the
 * teacher corpus is cloud output and cloud measures 0% coherence-defective, so a
 * v3 trained on cleaner data cannot fix what the small model itself produces.
 * The bank sidesteps the generator entirely: every row was screened by the real
 * production gates before it shipped, so what the desktop shows has already
 * passed what the cloud path enforces at request time.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: skip the gates. A bank row is
 * re-screened by the caller exactly like model output, because the bank is an
 * artifact frozen at build time while the gates keep moving. If a gate tightens
 * after the artifact is built, a bank row that no longer passes MUST be caught,
 * and it can only be caught by running the live gate. Treating "already
 * verified" as "need not be checked" is how a stale artifact silently outvotes
 * a fix — so the bank changes only WHERE a scenario comes from, never whether
 * it is screened.
 */
import { pickFromBank, bankKey, type BankEntry } from './scenarioBank';
import { isSameStory } from './scenarioRegen';
import type { GamePayoffs, SuggestedScenario } from '../types';

/**
 * STATIC IMPORT, DELIBERATELY.
 *
 * The first version used `require()` so the artifact would not be inlined into
 * builds that never read it. It returned `false` from `bankAvailable()` in every
 * context that matters — tsx, ESM, tests — because `require` is not defined
 * there, and the failure was SILENT: the catch below degraded to the model path
 * exactly as designed, so nothing threw, nothing logged, and the desktop would
 * have shipped consulting a bank that never loaded. Caught by probing the
 * function rather than by reading it.
 *
 * A static import is resolved by tsx, Vite and esbuild alike, and costs ~745 KB
 * inlined into the server bundle — against the ~378 MB model this replaces, that
 * is not a tradeoff worth a runtime loader for.
 */
import rows from '../data/scenarioBank.json';

const bank: BankEntry[] = (rows as unknown as BankEntry[]) ?? [];

/**
 * Rows already shown this run. In memory only and deliberately so: a desktop
 * launch is the natural scope for "don't repeat yourself", and persisting it
 * would mean a long-lived install eventually exhausting the bank and falling
 * back to repeats anyway — with a file to corrupt in the meantime.
 */
const seen = new Set<string>();

/** True when the bank can serve this process at all — used to pick the path. */
export function bankAvailable(): boolean {
  return bank.length > 0;
}

/**
 * A scenario for this game, or null to fall through to the model path.
 * `domain` comes from the same rotation the cloud path uses, so setting variety
 * is driven identically on both surfaces.
 *
 * `seenOverride` (RED-CLOUD-7/001): the module-global `seen` above is correctly
 * scoped to ONE DESKTOP LAUNCH for the original caller (`inventScenario`,
 * IS_ELECTRON-gated) — a fresh Electron process naturally resets it. `server.ts`'s
 * `inventScreenedScenario` later added a SECOND caller, reachable on the HOSTED
 * path too (no IS_ELECTRON gate), where one warm Cloud Run process serves many
 * unrelated users' requests: left unscoped, `seen` accumulated across ALL of
 * them, eventually exhausting the exact-band pool and drifting later requests
 * onto a story 2+ stakes bands away from their own game (far-band 24-41% in
 * 200-draw windows after ~400 accumulated fallback draws — 0/500 on a properly
 * scoped cold process). Passing an explicit `Set` here (the hosted caller passes
 * a FRESH one per request; the desktop caller passes nothing, so it keeps using
 * the per-launch singleton, unchanged) is what closes that gap without touching
 * `pickFromBank`'s picker logic at all — a request's own reroll ladder can still
 * avoid its own repeats, since the set it's given starts empty either way.
 */
export function bankScenario(g: GamePayoffs, domain: string, seenOverride?: Set<string>): SuggestedScenario | null {
  if (!bank.length) return null;
  const activeSeen = seenOverride ?? seen;
  const sc = pickFromBank(bank, g, domain, activeSeen);
  if (!sc) return null;
  // Record BEFORE returning: the caller may reject this row at the gate, and a
  // rejected row should not come back on the retry.
  const hit = bank.find((e) => e.s === sc);
  if (hit) activeSeen.add(bankKey(hit));
  return sc;
}

/**
 * The setting a scenario CAME FROM the bank under, if it did — used by the
 * "Regenerate scenario" feature to avoid re-drawing the same domain on a
 * desktop regenerate. Matches by the same (domain, name, description-prefix)
 * identity `bankKey` uses, so this only ever answers "yes" for a row that is
 * genuinely still in the shipped bank; a user-typed or hand-edited story (no
 * row shares its key) correctly returns `undefined`, and the caller then has
 * no domain to avoid, which is the right, structural answer.
 */
export function bankDomainFor(sc: { name?: string; description?: string } | null | undefined): string | undefined {
  if (!sc) return undefined;
  const hit = bank.find((e) => isSameStory(e.s, sc));
  return hit?.d;
}

/**
 * A scenario for this game, deliberately NOT the same story (by name) as
 * `avoidName`, and NOT the same setting `bankScenario` would otherwise repeat
 * — used by the regenerate route so a desktop draw reads as a genuinely new
 * attempt rather than the bank handing back the row already on screen.
 *
 * Reuses `pickFromBank` UNCHANGED: its own `seen: ReadonlySet<string>`
 * parameter already exists for exactly this ("rows already shown this
 * session"), so avoidance is just widening that set with every row that
 * shares `avoidName` — the ladder/softenBand semantics `pickFromBank` already
 * implements are untouched, and a bank with only one row for the game's
 * (domain, band) cell still degrades the same way it already does when
 * `seen` covers everything (widen, then repeat honestly rather than fail).
 */
/** `seenOverride`: same RED-CLOUD-7/001 reasoning as `bankScenario` above —
 *  omitted (desktop) keeps the per-launch singleton; the hosted fallback
 *  caller passes its own fresh, per-request `Set`. */
export function bankScenarioAvoiding(
  g: GamePayoffs,
  domain: string,
  avoidName?: string,
  seenOverride?: Set<string>,
): SuggestedScenario | null {
  if (!bank.length) return null;
  const baseSeen = seenOverride ?? seen;
  const avoidKeys = avoidName
    ? bank.filter((e) => isSameStory(e.s, { name: avoidName })).map(bankKey)
    : [];
  const unionSeen = avoidKeys.length ? new Set([...baseSeen, ...avoidKeys]) : baseSeen;
  const sc = pickFromBank(bank, g, domain, unionSeen);
  if (!sc) return null;
  const hit = bank.find((e) => e.s === sc);
  // Record into the SAME set the picker was scoped to, matching bankScenario:
  // baseSeen (not unionSeen, which may be a throwaway union copy when
  // avoidKeys is non-empty) — writing into unionSeen there would silently
  // drop the record on the floor for that call shape.
  if (hit) baseSeen.add(bankKey(hit));
  return sc;
}

/** The shipped rows, so a test can re-screen the artifact against today's gates. */
export function allBankRows(): readonly BankEntry[] { return bank; }

/** Row count, so a test can assert the artifact actually arrived. */
export function bankSize(): number { return bank.length; }

/** Test seam — the seen set is process-global, which a test must be able to reset. */
export function __resetBankSeen(): void { seen.clear(); }

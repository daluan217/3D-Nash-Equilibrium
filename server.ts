/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

// First imports from src/ into the server. esbuild bundles these relative
// modules into dist/server.cjs; only npm packages stay external. Sharing one
// solver between client, server, and eval is the point — a second copy here
// would let them drift and quietly invalidate every consistency number.
// Extensionless, matching the rest of src/ (a Vite convention the whole client
// tree relies on). That means the dev runtime must resolve like the bundlers do:
// `npm run dev` uses tsx, NOT node --experimental-strip-types, whose native ESM
// resolver requires explicit extensions and throws ERR_MODULE_NOT_FOUND on the
// first src/ import. esbuild (production) and vite (client) both resolve these.
import { computeAllNE, hasEquilibriumContinuum } from "./src/utils/gameEngine";
import { tieProse, tieProseFull } from "./src/utils/tieProse";
import { validateReport, validateScenario, validateProseClaims, validateProseDirections, scenarioIsClaimFree } from "./src/utils/nashValidator";
import { generateReport, generateScenario, hasCredentials, scenarioIsUsable, DEFAULT_MODEL, LOCAL_SYSTEM_PROMPT, type Scenario } from "./src/utils/report";
import type { ReasoningEffort } from "./src/utils/providers";
import { stripUnsafeText, clampGraphemeSafe } from "./src/utils/textSafety";
import { cleanScenarioActorNouns } from "./src/utils/scenarioActorNouns";

// Production reasoning effort for the explainer. UNSET (provider default)
// since the materialized best-reply table landed: the 2026-08-27 follow-up
// A/B measured zero-effort+table at 7/8 on the baseline families in 7.0s —
// identical fidelity to 'low' without the table (7/8, 10.3s) — and
// low+table added latency (10.7s) with no measurable gain, because the
// table replaces exactly the derivations the thinking was doing. The env
// override remains the escape hatch if fidelity ever regresses. Set here
// at the ROUTE, not inside generateReport, so the eval harness keeps
// measuring the model's unmodified default unless a sweep opts in.
const REPORT_REASONING: ReasoningEffort | undefined =
  (process.env.REPORT_REASONING as ReasoningEffort) || undefined;
// REPORT_LOCAL_PROMPT=1 serves the fine-tuned local explainer: it was trained
// with the compact LOCAL_SYSTEM_PROMPT (the rulebook is in its weights) and
// only on the full-report task, so the scenario-only fast path is served by
// an invention-mode report instead of the separate scenario prompt.
const LOCAL_PROMPT = process.env.REPORT_LOCAL_PROMPT === '1' ? LOCAL_SYSTEM_PROMPT : undefined;

/**
 * WHERE AN INVENTED SCENARIO COMES FROM — one function, three callers.
 *
 * This was three copies of the same ternary. The copies are what
 * `scenariopaths.contract.test.ts` exists to police, because they had already
 * drifted once: a branch took `server.ts` wholesale from a pre-fix tree and
 * silently reverted the claim-free screen on one path only. A single source
 * makes that particular drift unrepresentable rather than merely detectable.
 *
 * ORDER IS DELIBERATE. The bank is consulted first and ONLY on the desktop,
 * because it exists to replace a bundled model, not to override the cloud. A
 * miss falls through to the model path instead of failing: a thin (domain,
 * band) cell should cost variety, never a report.
 *
 * WHAT THIS DOES NOT DO is decide whether the scenario may be SHOWN. Every
 * caller screens the result — bank rows included — through the same live gates
 * it applies to model output. The bank is frozen at build time while the gates
 * keep moving, so "already verified" must never read as "need not be checked".
 */
/**
 * Can this process produce a scenario at all?
 *
 * A key is no longer the only way. The desktop ships a bank precisely so the
 * offline app has a story WITHOUT credentials, so gating invention on
 * `hasCredentials` alone would have made the bank unreachable in the exact
 * situation it was built for — present, loaded, correct, and never consulted.
 */
function canInvent(): boolean {
  return hasCredentials(DEFAULT_MODEL) || (process.env.IS_ELECTRON === 'true' && bankAvailable());
}

/**
 * FEATURE-REGEN's flag. Read at request time, like `canInvent`'s own
 * credential check — never assigned to a module-level constant, so a test
 * that flips the env var between requests (or the desktop's own 96-98
 * startup block) is observed immediately rather than only at process boot.
 * Default OFF: the route 404s and the client hides the action until this is
 * explicitly `'1'` (a literal in cloudbuild.yaml, never request-toggled —
 * see `src/electronenv.contract.test.ts`'s `flagNames` negative check).
 */
function scenarioRegenEnabled(): boolean {
  return process.env.NASH_SCENARIO_REGEN === '1';
}

/**
 * THE ONE SCREENED, REROLLED SCENARIO DRAW. Every path that invents a scenario
 * goes through here, so none of them can drift from the others again.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE COPIES. server.ts invents a scenario at
 * three places — the rung-3 report path, the tie report path, and the
 * `scenarioOnly` path behind "New AI scenario". They have now drifted THREE
 * separate times, in three different properties, and every time the split was
 * on the MATRIX rather than on anything the user does:
 *
 *   SCREENING drifted first and was unified in #56. That fix's comment is still
 *   in this file, still correct, and reads as a guarantee about this whole
 *   surface — which is exactly why the next two drifts were so easy to miss.
 *   THE RETRY drifted next and was NOT unified, with the polarity reversed, so
 *   the 12.7% tie minority became the weak side. RED-PIPELINE measured the SAME
 *   BUTTON against the shipped bank, n=3000 per cell: 1.30% of tie-game presses
 *   returned no story against 0.00% of non-tie presses, z=6.3. Where the reroll
 *   existed it was a complete rescue — 23 losses to zero.
 *   THE OPT-OUT FLAG drifted third. `NASH_SCENARIO_CHECKS=0` was read only in
 *   `scenarioOnly` and in the now-unreachable LLM path, so it was INERT on both
 *   branches production serves. Its own comment promises that "each gate's
 *   effect is measurable in isolation"; an operator flipping it to measure the
 *   scenario gate on the report path saw no difference and would conclude the
 *   gate does nothing. A measurement instrument that silently does not measure
 *   is worse than a dead flag.
 *
 * WHAT THE MISSING REROLL COST, measured end to end against a real provider at
 * PRODUCTION settings (no `reasoning` argument — thirteen harnesses in this
 * repo hard-code 'low', and every number they produced is at the wrong
 * setting): 4 of 60 reports came back with NO STORY, 6.7%, Wilson 95% CI
 * [2.6%, 15.9%]. One of the four took 83.5 seconds to return a report with no
 * story. The lost draws are persona/META leaks — a bare letter standing in for
 * a character, or the prompt's own "Player A" in the prose — a model-side
 * property with a known per-draw rate, so independent draws are precisely the
 * right instrument. Rewriting model output is not permitted here; a reroll is,
 * and it costs one extra call only on the calls that produced nothing.
 *
 * BOUND ON THE GATE-DROP REROLLS (2026-09-02, BLUE-APP-4's measurement,
 * routed by the director): the single reroll above rescues a LOST draw
 * (timeout/error/unparseable) but only ever gives a GATE-DROPPED draw (one
 * that came back and failed `storyOk`, most often the META/persona-leak
 * screen) ONE second chance. Two draws that are BOTH independently
 * META-dropped is not a floor case: measured against the real teacher
 * corpus through the shipped screens, single-draw drop rate 7.33%, so the
 * two-in-a-row residual is ~0.54% — 2.7x the 0.2% ship bar production
 * confirmed hitting live (two "Player A" drops 5s apart, report shipped
 * with NO scenario at all). `NASH_SCENARIO_REROLLS` (default 2, clamped to
 * [0, 3]) is how many EXTRA draws a GATE-DROPPED result may consume; at the
 * default, a pure gate-drop cascade needs three independent drops in a row
 * (~0.0395% residual) before the report goes without a story.
 *
 * The LOST-draw retry is UNCHANGED and NOT governed by this setting — it
 * still fires at most once, same as before this setting existed. A
 * timed-out or erroring provider must not be hammered a bounded-by-setting
 * number of times; that would multiply the WORST-CASE latency (a genuinely
 * slow/broken provider) by the reroll count instead of by a fixed 2x. Only
 * a draw that the provider actually ANSWERED — fast, in practice — spends
 * from the bounded gate-drop budget.
 *
 * LATENCY: every extra attempt still goes through `drawWithDeadline`, so
 * each one is individually capped at `SCENARIO_DEADLINE_MS` (20s default) —
 * the total deadline guarantee is "N draws x the per-draw cap", not
 * unbounded. Theoretical worst case at the default setting is now 4 draws
 * (1 lost + 1 timeout-retry that itself gate-drops, + 2 gate rerolls) x 20s
 * = 80s, up from the old 2 x 20s = 40s ceiling. In practice a gate-drop
 * means the provider ANSWERED (not a timeout), so the realistic added cost
 * of the two extra rerolls is roughly two ordinary provider round-trips
 * (production reasoning-on cloud: ~5.4-5.6s p50 each, so ~11s typical
 * added latency, only on the ~7% of draws that gate-drop at all — most
 * requests pay nothing extra).
 */
const SCENARIO_REROLL_LIMIT = (() => {
  const raw = Number(process.env.NASH_SCENARIO_REROLLS);
  const DEFAULT = 2;
  const MAX = 3;
  if (!Number.isInteger(raw) || raw < 0) return DEFAULT;
  return Math.min(raw, MAX);
})();

/**
 * RED-CLOUD-6/002: the reroll ladder above is correctly implemented (every
 * drop across 185 real production-settings draws was a genuine, documented
 * gate rejection, not a bug) but the CURRENT model's real gate-drop rate
 * (~15.2% empirically, roughly double the 7.33% this ladder's own sizing
 * comment cites) means full exhaustion — a report shipped with literally NO
 * scenario at all — happened 3/185 times (1.6%), well above the ~0.04-0.2%
 * bars the reroll bump was built and documented against.
 *
 * LAST RESORT, not a fourth reroll: when every model attempt is exhausted
 * (gate-dropped three times running, or the provider itself was unreachable
 * across the one lost-draw retry), fall back to a single pre-screened bank
 * row before giving up. `NASH_SCENARIO_REROLLS` governs the MODEL budget
 * unchanged — this is a separate, cheap, ALWAYS-AVAILABLE final attempt
 * layered after it, not an extra model call.
 *
 * WHY THE BANK IS SAFE TO USE HERE, ON THE HOSTED PATH TOO — it is not
 * gated on `IS_ELECTRON` the way `inventScenario`'s PRIMARY bank draw is: the
 * artifact is a plain static import (`bankSource.ts`'s own comment: "~745 KB
 * inlined into the server bundle"), so it is already present and loaded in
 * the exact same Cloud Run bundle that serves production. The bank row is
 * re-screened through the SAME `storyOk` gate as model output before it is
 * ever returned — `bankSource.ts`'s own module comment is explicit that
 * "already verified" at build time must never read as "need not be checked"
 * again at request time, since the gates keep moving after the artifact is
 * frozen.
 *
 * WHY THIS DOES NOT REOPEN "a bank predetermined by payoff scale" (Daniel,
 * 2026-09-02 — he does not want the story fully determined by the numbers on
 * screen): it does not change how the bank is INDEXED or PICKED at all. This
 * calls the exact same `bankScenario`/`pickFromBank` every other bank draw in
 * this app already uses (the desktop's own primary invention path, and the
 * "New AI scenario" button when offline) — including `softenBand`'s existing
 * 30%-neighbor-band blend, which is ITSELF the already-shipped answer to that
 * exact concern (scenarioBank.ts's own comment cites it). This is a new
 * CALLER of an unchanged, already-soft picker, only reached on the residual
 * few-percent tail where the model produced nothing usable at all — not a new
 * selection rule.
 *
 * `scenarioSource: 'bank-fallback'` on the returned object (undefined on
 * every ordinary model-drawn scenario) is what makes this measurable, per the
 * finding's own ask — callers thread it into the response so the rate can be
 * tracked in production rather than only inferred.
 */
/**
 * What a "Regenerate scenario" draw must not repeat (FEATURE-REGEN). `name`/
 * `description` identify the CURRENT story so a fresh draw that lands on the
 * exact same one counts as a gate drop, not a success — a same-story draw
 * would read to the user as "nothing happened" despite spending a whole
 * reroll. `domain` (desktop only, from `bankDomainFor`) additionally biases
 * the bank picker away from the setting the current story came from, so a
 * regenerate is more likely to read as genuinely new rather than only
 * guaranteed non-identical. This is a REJECT-AND-REROLL input, never a
 * rewrite: `isSameStory` only ever causes another draw, exactly like every
 * other `storyOk` rejection this ladder already handles.
 */
type RegenAvoid = { name?: string; description?: string; domain?: string };

// Actor declarations are a regeneration-preview affordance, not part of the
// long-standing report/new-scenario response shape.  Bank rows may carry them
// as source metadata, so remove them at the shared screened-result boundary
// whenever the caller did not explicitly opt in.
function withoutActorNouns(sc: SuggestedScenario): SuggestedScenario {
  const { actorA: _actorA, actorB: _actorB, ...nounFree } = sc;
  return nounFree;
}

async function inventScreenedScenario(
  payoffs: GamePayoffs,
  onDrop?: (reason: string) => void,
  avoid?: RegenAvoid,
  actorNouns = false,
): Promise<{ scenario: SuggestedScenario | null; failure?: string; scenarioSource?: 'bank-fallback' }> {
  // Honoured on EVERY path now. That is the point of the flag.
  const gateOn = process.env.NASH_SCENARIO_CHECKS !== '0';
  const storyOk = (sc: SuggestedScenario): boolean => {
    // Actor declarations are a regenerate-only response contract. The full
    // report schema deliberately remains unchanged, so its existing gate must
    // not start demanding fields it can never receive.
    if (!validateScenario(sc, payoffs, { actorNouns }).ok) return false;
    const claimFree = scenarioIsClaimFree(sc);
    if (!claimFree.ok) { onDrop?.(claimFree.reason); return false; }
    if (avoid && isSameStory(sc, avoid)) { onDrop?.('regen-same-story'); return false; }
    return process.env.NASH_DIRECTION_CHECKS !== '1'
      || validateProseDirections(sc.description ?? '', sc, payoffs).length === 0;
  };

  let usedTimeoutRetry = false;
  let gateRerollsUsed = 0;
  let exhaustionFailure = "validation-failed";
  for (;;) {
    const draw = await drawWithDeadline(payoffs, avoid, actorNouns);
    if (!draw.scenario) {
      // LOST: the draw never produced a scenario at all (timeout, provider
      // error, unparseable output). Exactly one retry, same as before this
      // setting existed — never governed by NASH_SCENARIO_REROLLS.
      if (usedTimeoutRetry) { exhaustionFailure = draw.failure ?? "unparseable"; break; }
      usedTimeoutRetry = true;
      continue;
    }
    if (!gateOn || storyOk(draw.scenario)) {
      return { scenario: actorNouns ? draw.scenario : withoutActorNouns(draw.scenario) };
    }
    // GATE-DROPPED: a real draw came back and the screen rejected it. This
    // is the only case the bounded reroll setting governs.
    if (gateRerollsUsed >= SCENARIO_REROLL_LIMIT) {
      exhaustionFailure = "validation-failed";
      break;
    }
    gateRerollsUsed++;
  }

  // The model side is exhausted (either failure shape above). One more,
  // free, always-available attempt before this request goes without a story:
  // see this function's own comment for why the bank is reachable and safe
  // to use here, even on the hosted path.
  const fallbackDomain = pickScenarioDomainExcluding(avoid?.domain);
  // RED-CLOUD-7/001: this fallback call is reachable on the HOSTED path
  // (no IS_ELECTRON gate — see this function's own doc comment above), where
  // Cloud Run's single warm process (`--max-instances=1`, no `--min-instances`)
  // can serve many unrelated users' requests over the life of one process.
  // `bankSource.ts`'s `seen` Set is a module-global correctly scoped to ONE
  // DESKTOP LAUNCH for the pre-existing primary bank draw — left unscoped
  // here too, it would accumulate every unrelated user's fallback draw and
  // eventually drift LATER requests onto a story 2+ stakes bands away from
  // their own game (measured: far-band 24-41% after ~400 accumulated draws
  // on one warm process, vs 0/500 properly scoped). A fresh, empty `Set`
  // every hosted request closes that — this request's own ladder can still
  // avoid ITS OWN repeats, since the set starts empty either way. On
  // desktop, pass nothing so `bankScenario`/`bankScenarioAvoiding` keep
  // using the per-launch singleton, exactly as before this fix.
  const hostedFallbackSeen = process.env.IS_ELECTRON === "true" ? undefined : new Set<string>();
  const fallback = avoid
    ? bankScenarioAvoiding(payoffs, fallbackDomain, avoid.name, hostedFallbackSeen)
    : bankScenario(payoffs, fallbackDomain, hostedFallbackSeen);
  if (fallback && (!gateOn || storyOk(fallback))) {
    return { scenario: actorNouns ? fallback : withoutActorNouns(fallback), scenarioSource: 'bank-fallback' };
  }
  return { scenario: null, failure: exhaustionFailure };
}

/**
 * A DEADLINE ON THE STORY, because the story is the optional part.
 *
 * A provider that ACCEPTS the connection and then never answers used to hold
 * the user's request open indefinitely. RED-PIPELINE measured it against a mock
 * that accepts and never responds: 798 seconds — 13m18s — still open, exactly
 * one provider attempt, no timeout at any layer. Every link in that chain is a
 * default nobody chose. `new OpenAI({ baseURL, apiKey })` sets no `timeout` and
 * no `maxRetries`, so the SDK's own 600s x 3 applies; `providers.ts` then walks
 * up to four request shapes and each gets that full budget; and Cloud Run's
 * request timeout on this service is 3600s, not the 300s default. The outer
 * bound in production was an HOUR of a spinning "Explain this game", ending in
 * the client saying the deterministic report above still stands.
 *
 * WHY THE DEADLINE BELONGS HERE and not on the OpenAI client: a `timeout` there
 * caps one ATTEMPT, and the shape ladder multiplies it. This call site is the
 * one that knows the work is OPTIONAL — `suggestedScenario` may be absent on
 * every branch by construction, and the templated report needs no model at all.
 * The same handler already degrades perfectly on eleven provider failures that
 * ARRIVE (500, 400, 429, HTML, empty choices, null content, truncation,
 * refusal, no scenario, prose-not-JSON, null scenario — all under 1.5s). The
 * one badly handled case was the one where the right answer was most obviously
 * already in hand.
 *
 * The draw is abandoned, not cancelled: the provider promise is left to settle
 * on its own (its result is simply discarded) because there is no cancellation
 * token through `generateScenario`, and a rejected orphan would be an unhandled
 * rejection. `.catch` keeps it quiet.
 */
const SCENARIO_DEADLINE_MS = (() => {
  const raw = Number(process.env.NASH_SCENARIO_TIMEOUT_MS);
  // Number(undefined) and Number('') are NaN/0; setTimeout treats both as an
  // immediate fire, which would silently drop the scenario on every draw.
  // setTimeout also normalizes a delay under 1ms, or one that overflows
  // Node's 32-bit signed timer field (> 2147483647), to an immediate 1ms
  // fire — so 0.5 and 2147483648 pass a bare `> 0` check and still drop
  // every scenario the same way NaN/0 did.
  return Number.isInteger(raw) && raw >= 1 && raw <= 2147483647 ? raw : 20_000;
})();

async function drawWithDeadline(payoffs: GamePayoffs, avoid?: RegenAvoid, actorNouns = false): Promise<{ scenario: SuggestedScenario | null; failure?: string }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ scenario: null; failure: string }>((resolve) => {
    timer = setTimeout(() => resolve({ scenario: null, failure: "timeout" }), SCENARIO_DEADLINE_MS);
    // Never hold the process open for a draw nobody is waiting for.
    timer.unref?.();
  });
  try {
    return await Promise.race([
      inventScenario(payoffs, avoid, actorNouns).catch((err) => {
        console.warn(`[report] scenario draw failed: ${err?.message ?? err}`);
        return { scenario: null, failure: "error" as const };
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function inventScenario(payoffs: GamePayoffs, avoid?: RegenAvoid, actorNouns = false): Promise<{ scenario: SuggestedScenario | null; failure?: string }> {
  // On the desktop bank path only, bias the domain away from where the
  // CURRENT story came from (regen's `avoid.domain`, from `bankDomainFor`) so
  // a regenerate is not just non-identical but reads as a new setting too.
  // The cloud path is unaffected — the prompt is never told about `avoid` at
  // all (see `inventScreenedScenario`'s doc comment: reject-and-reroll only).
  const domain = pickScenarioDomainExcluding(avoid?.domain);
  if (process.env.IS_ELECTRON === 'true' && bankAvailable()) {
    const sc = avoid ? bankScenarioAvoiding(payoffs, domain, avoid.name) : bankScenario(payoffs, domain);
    if (sc) return { scenario: actorNouns ? sc : withoutActorNouns(sc) };
  }
  // Actor-mode requests always go through generateScenario, even when
  // REPORT_LOCAL_PROMPT is set: the local explainer was trained only on the
  // full-report task with the compact LOCAL_SYSTEM_PROMPT (no actor-noun
  // rule, no SCENARIO_SCHEMA_WITH_ACTORS), so an actor-mode draw through
  // generateReport can never carry actorA/actorB — it would just burn every
  // reroll attempt against a schema that structurally cannot satisfy the
  // actor-noun validator, then fall through to bank-fallback or failure.
  if (!LOCAL_PROMPT || actorNouns) {
    return generateScenario(payoffs, { model: DEFAULT_MODEL, reasoning: REPORT_REASONING, domain, stakes: true, actorNouns });
  }
  const r = await generateReport(payoffs, { model: DEFAULT_MODEL, systemPrompt: LOCAL_PROMPT });
  return { scenario: r.report?.suggestedScenario ?? null, failure: r.failure };
}

// Validated-report cache. The same eight numbers always have the same
// equilibria, and only envelopes that passed EVERY gate are stored — so a
// hit serves certified content instantly and for free. The six standard
// presets are the common case (identical matrix + scenario on every visitor).
// Explicit Regenerate clicks send bypassCache so the button still rolls a
// fresh report (the cache is then overwritten with the new validated one);
// scenario-only invention requests never touch the cache — freshness is
// their point. In-memory on purpose: it dies with the process, which caps
// staleness at one deploy cycle.
const reportCache = new Map<string, object>();
const REPORT_CACHE_MAX = 200;
const reportCacheKey = (p: { a11: number; a12: number; a21: number; a22: number; b11: number; b12: number; b21: number; b22: number }, sc?: Scenario) =>
  JSON.stringify([p.a11, p.a12, p.a21, p.a22, p.b11, p.b12, p.b21, p.b22,
    sc ? [sc.name, sc.row1, sc.row2, sc.col1, sc.col2, sc.description] : null]);
import type { ReportEnvelope, SuggestedScenario } from "./src/types";
import { cleanUserColorTermPair } from "./src/utils/colorTerms";
import { pickScenarioDomainExcluding } from "./src/utils/scenarioDomains";
import { bankAvailable, bankScenario, bankDomainFor, bankScenarioAvoiding } from "./src/utils/bankSource";
import { isSameStory } from "./src/utils/scenarioRegen";

// Load environment variables from .env file
dotenv.config();

// ── Async error boundary (RED-DESKTOP-6/001) ────────────────────────────────
//
// There was NO async error boundary anywhere in this file: every `async (req,
// res) => {...}` route handler is registered with no `express-async-errors`
// and no wrapper, so a synchronous throw inside one (e.g. `db.users.find` on
// a `db.users` that turns out not to be an array — exactly what an
// unvalidated old/malformed db.json shape produces, see `loadDBFromFile`
// below) does not propagate to Express's error handling at all. It silently
// rejects the handler's own returned Promise, which nothing awaits or
// catches. Node 22's default `unhandledRejection` mode ("throw") then turns
// that into an uncaught exception with no handler — CRASHING THE WHOLE
// PROCESS in the standalone `dist/server.cjs` case (confirmed: the PID
// vanishes, every in-flight and future request gets a connection reset). In
// the packaged app (server.ts required IN-PROCESS by electron-main.cjs) the
// process itself survives, but `inMemoryDb` is never reloaded, so the SAME
// failure recurs identically on every future request touching the DB — the
// UI just says "Network error" forever, with nothing naming the cause.
//
// `asyncHandler` closes the gap at its source: any async route handler
// wrapped with it has its rejection routed to `next(err)`, which Express's
// OWN routing then hands to the global error-handling middleware below —
// same one clean, logged 500 response either way, not a hung connection.
function asyncHandler(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void | express.Response>
): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Set to true only once `app.listen`'s own callback fires (see
// `startListening` near the bottom of `startServer`). Everything that can go
// wrong BEFORE that point — a bad db.json shape, a filesystem permission
// error, a port bind failure — is a STARTUP failure: the existing behavior
// (an uncaught exception/rejection crashes the process loudly) is exactly
// right there, so this flag is what lets the handlers below tell "starting
// up" apart from "already serving requests" and choose accordingly.
let serverListening = false;

// Set to true the moment a desktop startup refusal has been HANDED OFF to
// the packaged app's dialog hook (`reportDesktopLockFailure`, when
// `globalThis.onDesktopLockFailure` is registered) — separate from
// `serverListening`, which never becomes true on this path at all (the
// refusal means `startServer` returns before ever calling `initDB`/`listen`).
// CodeRabbit, 2026-09-03: without this, the window between that hand-off and
// the user actually seeing/dismissing the async native dialog was still
// treated as "starting up" by `handleFatalAsync` below — so ANY unrelated
// unhandled rejection or uncaught exception during that window (a stray
// analytics call, an IPC handler throw, nothing to do with the refusal
// itself) hit the `!serverListening` branch and called `process.exit(1)`,
// which — because `server.ts` runs IN-PROCESS inside electron-main.cjs —
// kills the ENTIRE Electron main process, dialog included, before or while
// the user is looking at it. Exactly the "silent vanish" class #88/#93's
// dialog hook exists to prevent, reintroduced through a different door.
let startupOutcomeReported = false;

// Last-resort safety net, for anything that reaches neither `asyncHandler`
// nor Express's synchronous error handling — a rejected promise in
// fire-and-forget code (e.g. an un-awaited background save), a throw inside
// a timer/event callback, or simply the next unvalidated assumption someone
// adds next to one of the many `db.users`/`db.games` call sites this class of
// bug came from. Per RED-DESKTOP-6/001's own ask: log loudly WITH the cause,
// keep serving once the server is up (never exit on a request-path error);
// still exit loudly on a startup-time failure, matching today's behavior for
// that case exactly (Node's own default), just with an intentional, findable
// log line instead of a bare default stack dump. A desktop startup refusal
// that has already been handed to the dialog hook (`startupOutcomeReported`)
// is treated the same as "already serving" here — not because the server IS
// serving, but because the outcome is already settled and reported, and a
// bare `process.exit(1)` at this point would only cut off the dialog the
// user is meant to see instead of adding any new information.
function handleFatalAsync(kind: "unhandledRejection" | "uncaughtException", err: unknown): void {
  const cause = err instanceof Error ? (err.stack || err.message) : String(err);
  if (!serverListening && !startupOutcomeReported) {
    console.error(`FATAL (${kind}) during startup — exiting: ${cause}`);
    process.exit(1);
  }
  console.error(
    `Unhandled ${kind} after the server was already listening — logging and continuing to serve `
    + `(this indicates a bug: some code path threw/rejected outside every async-error boundary). `
    + `Cause: ${cause}`
  );
}
process.on("unhandledRejection", (err) => handleFatalAsync("unhandledRejection", err));
process.on("uncaughtException", (err) => handleFatalAsync("uncaughtException", err));

interface GamePayoffs {
  a11: number; a12: number; a21: number; a22: number;
  b11: number; b12: number; b21: number; b22: number;
}

interface SavedGame {
  id: string;
  userId: string;
  name: string;
  description: string;
  payoffs: GamePayoffs;
  createdAt: string;
  /**
   * What this game's four options are actually called.
   *
   * Presets have carried these since the beginning (`row1Label` and friends in
   * PRESETS); saved games could not, so a custom game had no way to say that
   * Row 1 means "Undercut" and Col 2 means "Hold price". The explainer decides
   * whether to reuse a scenario or invent a fresh one by asking whether four
   * labels are present, so a game that cannot store labels was condemned to a
   * new invented story on every single explanation.
   */
  row1Label?: string;
  row2Label?: string;
  col1Label?: string;
  col2Label?: string;
  /**
   * Phrases the USER chose to have colored as player A / player B in their own
   * description. Stored as phrases rather than character ranges because the
   * description is plain text that can be edited afterwards — offsets would
   * slide onto the wrong words, a phrase does not.
   *
   * These decorate the user's description and nothing else. They are NEVER put
   * into a model prompt and never applied to model-written prose: the labels
   * above are the fields the explainer reads, and these are deliberately not
   * among them. src/unit.test.ts asserts that separation.
   */
  colorTermsA?: string[];
  colorTermsB?: string[];
}

interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string; // stored simply for sandbox safety (base64 or direct)
  isVerified: boolean;
  verificationCode: string;
  verificationCodeExpires: number;
  verificationCodeAttempts?: number;
  deleteCode?: string;
  deleteCodeExpires?: number;
  deleteCodeAttempts?: number;
  recoveryCode?: string;
  recoveryCodeExpires?: number;
  recoveryCodeAttempts?: number;
  tokenVersion?: number;
}

interface DB {
  users: User[];
  games: SavedGame[];
}

const PASSWORD_ITERATIONS = 210_000;
const AUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * THE DESKTOP'S SESSION SECRET, persisted beside its database.
 *
 * WHY. Every auth token is an HMAC under `AUTH_SECRET`. A packaged app ships no
 * `.env` — correctly, since a distributed binary must not carry credentials —
 * and `electron-main.cjs` sets NODE_ENV/PORT/IS_ELECTRON/ELECTRON_USER_DATA_PATH
 * plus the rung-3 trio, but no secret. So the fallback below minted a NEW random
 * secret on every launch and every token ever issued stopped verifying.
 *
 * MEASURED against the real packaged .app (`electron-builder --dir`, launched
 * with cwd=/ so dotenv loads nothing): register, sign in, save a game, quit,
 * relaunch against the SAME user-data directory —
 *   before: GET /api/auth/me -> 401 "Invalid session."
 *           GET /api/games   -> 401 "Invalid or expired session."
 * The rows are still in `db.json`; the token in localStorage is simply dead. On
 * a local-first desktop app that reads as "my saved games are gone", and it
 * happened on every launch.
 *
 * SCOPE, deliberately narrow. This persists ONLY under
 * `ELECTRON_USER_DATA_PATH` — the desktop, where the user's own machine is the
 * trust boundary and the key sits in the same directory as the database it
 * protects. The hosted path keeps its per-process random fallback on purpose:
 * writing a secret to a Cloud Run container's ephemeral disk would make an
 * unkeyed deploy LOOK fixed while still dropping every session on scale-out or
 * a revision roll, which is worse than the loud warning below. An explicitly
 * configured secret still wins over both, so the deployed service is untouched.
 *
 * Degrades rather than throws: if the file cannot be read or written (read-only
 * home, permissions) this returns null and the caller falls back to exactly
 * today's behaviour — a random per-process secret — rather than failing to boot.
 */
function desktopAuthSecret(): string | null {
  const dir = process.env.ELECTRON_USER_DATA_PATH;
  if (!dir) return null;
  const file = path.join(dir, "auth-secret");
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf-8").trim();
      // Only accept something that is actually a key. A truncated or empty file
      // must not silently become a one-character HMAC secret that still "works".
      if (/^[0-9a-f]{64}$/.test(existing)) return existing;
    }
    const fresh = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(dir, { recursive: true });
    // 0600: the database beside it is only as private as the user's home
    // directory, but a session key should not be world-readable.
    fs.writeFileSync(file, fresh, { encoding: "utf-8", mode: 0o600 });
    return fresh;
  } catch (err) {
    console.error("Could not persist the desktop session secret; sessions will not survive a restart:", err);
    return null;
  }
}

const AUTH_SECRET = process.env.AUTH_SECRET
  || process.env.SESSION_SECRET
  || process.env.ADMIN_SECRET
  || desktopAuthSecret()
  || crypto.randomBytes(32).toString("hex");

if (process.env.NODE_ENV === "production" && !process.env.AUTH_SECRET && !process.env.SESSION_SECRET && !process.env.ADMIN_SECRET
    && !process.env.ELECTRON_USER_DATA_PATH) {
  console.warn("AUTH_SECRET/SESSION_SECRET is not configured; auth sessions will be invalidated on server restart.");
}

const GCS_BUCKET = process.env.GCS_BUCKET_NAME;
const DB_FILE = process.env.ELECTRON_USER_DATA_PATH
  ? path.join(process.env.ELECTRON_USER_DATA_PATH, "db.json")
  : path.join(process.cwd(), "db.json");

/**
 * Replace a file's contents in one indivisible step.
 *
 * `fs.writeFileSync` truncates the target and then writes into it, so between
 * those two operations the file on disk is short. On the desktop `db.json` is
 * the ONLY copy of the user's account and saved games — the GCS branch is
 * skipped whenever ELECTRON_USER_DATA_PATH is set — and a crash, force-quit or
 * power loss in that window leaves a truncated file. `loadDBFromFile` then
 * catches the parse error and returns an empty database, so the app opens
 * looking exactly like a fresh install, and the next save writes that empty
 * database over whatever was left.
 *
 * Write to a sibling temp file, flush it to the platter, then `rename` over the
 * target. POSIX rename within a directory is atomic: a reader sees either the
 * whole old file or the whole new one, never a partial. The fsync is what makes
 * that hold after a power loss rather than only after a process crash.
 */
function writeFileAtomicSync(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    // The rename is a DIRECTORY operation, so the directory must be flushed
    // too; flushing the file alone leaves the new name unpersisted.
    try {
      const dirFd = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* not fsyncable on every platform; contents are already flushed */ }
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    // Never leave the scratch file behind to be mistaken for data — best
    // effort: this cleanup runs INSIDE the very failure it is trying to
    // clean up after, so it is not guaranteed to succeed. RED-DESKTOP-7/001:
    // when the directory itself turns unwritable mid-write (the `renameSync`
    // above failing for exactly that reason), `fs.unlinkSync(tmp)` fails for
    // the IDENTICAL reason — unlink needs directory-write permission too —
    // and the scratch file is orphaned. That used to be silent (`catch { }`,
    // no log line), so an operator had no way to learn the file even exists.
    // Log loudly here; `sweepStaleAtomicTmpFiles` (called once at startup)
    // removes anything this cleanup could not, on the next boot.
    //
    // CodeRabbit (this PR): call `unlinkSync` directly rather than gating it
    // on `fs.existsSync(tmp)` first — `existsSync` swallows EVERY error
    // (including an access error on the directory, exactly the failure this
    // whole function exists to survive) and just returns `false`, which used
    // to skip the delete AND the log silently: the tmp file could genuinely
    // still be sitting there, inaccessible, and nothing would ever say so.
    // `ENOENT` is the one code worth staying quiet about (the tmp file
    // legitimately never got created — the failure was in `openSync` itself).
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr: any) {
      if (cleanupErr?.code !== "ENOENT") {
        console.error(`writeFileAtomicSync: could not remove scratch file ${tmp} after a write error (it may be orphaned until the next startup sweep):`, cleanupErr);
      }
    }
    throw err;
  }
}

/**
 * Remove stale `<file>.tmp-<pid>-<timestamp>` scratch files left behind by a
 * `writeFileAtomicSync` whose own failure-cleanup could not run
 * (RED-DESKTOP-7/001, see that function's comment) — most commonly a
 * directory that turned read-only or ran out of permission specifically
 * between the tmp file being closed and the rename over the real file.
 *
 * Runs once at startup, AFTER the desktop lock is held (`acquireDesktopLock`
 * already guarantees no other process can be writing this same directory
 * concurrently at that point), and only removes files older than `maxAgeMs` —
 * so it can never race a write actually in flight: the CURRENT process's own
 * first save has not happened yet when this runs, and any OTHER process's tmp
 * file is either long-dead (the lock proves nothing else is live here now) or
 * young enough to be left alone out of caution.
 */
function sweepStaleAtomicTmpFiles(file: string, maxAgeMs = 5000): void {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.tmp-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err: any) {
    // CodeRabbit (this PR): this runs BEFORE `initDB`/`loadDBFromFile`, so a
    // silently-swallowed permission/IO error here would be the FIRST place a
    // real problem with the data directory could have been reported, and
    // wasn't. `ENOENT` is the one benign case (nothing to sweep, and
    // `loadDBFromFile` will create the directory momentarily); anything else
    // — EACCES, a busy volume, ... — is worth a log line even though this
    // function still cannot do anything about it itself.
    if (err?.code !== "ENOENT") {
      console.error(`Could not scan ${dir} for a stale atomic-write sweep at startup:`, err);
    }
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(dir, name);
    let age: number;
    try {
      age = Date.now() - fs.statSync(full).mtimeMs;
    } catch (err: any) {
      // ENOENT here is the ordinary "vanished between readdir and stat" race
      // (nothing left to sweep); anything else is a real, worth-logging
      // problem reading this specific entry.
      if (err?.code !== "ENOENT") {
        console.error(`Could not check the age of ${full} during the startup atomic-write sweep:`, err);
      }
      continue;
    }
    if (age < maxAgeMs) continue;
    try {
      fs.unlinkSync(full);
      console.warn(`Removed a stale atomic-write scratch file at startup: ${full} (orphaned by an earlier interrupted write; see writeFileAtomicSync).`);
    } catch (err) {
      console.error(`Found a stale atomic-write scratch file ${full} but could not remove it:`, err);
    }
  }
}

let inMemoryDb: DB | null = null;

/**
 * Shape-validate a JSON.parse'd db.json before anything trusts it
 * (RED-DESKTOP-6/001). `loadDBFromFile` used to `return JSON.parse(data)`
 * typed as `DB` with NO check that `users`/`games` were even present, let
 * alone arrays — a db.json that is valid JSON but the wrong shape (a
 * genuinely old file predating 2026-06-18's multi-user/`users` array, or a
 * partial/hand-edited write) loaded unmodified and crashed the FIRST request
 * that touched `db.users`/`db.games` (`ensureLocalOwner`'s `db.users.find`,
 * `POST /api/games`'s `[...db.games, newGame]`, etc.) — in the standalone
 * process that crash takes the whole server down; in the packaged app it
 * poisons `inMemoryDb` for the rest of that run, silently and permanently,
 * with nothing ever naming db.json as the cause.
 *
 * A missing or `null` "users"/"games" field is a KNOWN old shape — normalise
 * it to `[]` and say so loudly (a warning, not silence) rather than crash on
 * first use. A field that is PRESENT but the WRONG TYPE (a string, a number,
 * an object — not a recognised old shape, not something we can guess the
 * intent of) is not safe to default to empty without telling anyone: that
 * case throws, and the caller below treats it exactly like a JSON.parse
 * failure — preserve the bytes, refuse to boot rather than serve a DB that
 * silently discarded who knows what.
 */
function normalizeDbShape(parsed: unknown, filePath: string): DB {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${filePath} does not contain a JSON object at its top level (got `
      + `${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}).`
    );
  }
  const obj = parsed as { users?: unknown; games?: unknown };

  const normalizeCollection = (name: "users" | "games", value: unknown): unknown[] => {
    if (value === undefined || value === null) {
      console.warn(
        `${filePath}: "${name}" was ${value === undefined ? "missing" : "null"} — treating it as an `
        + `empty array. This is expected for a database saved before accounts existed (pre-2026-06-18) `
        + `or after a partial write; existing data in the other collection is untouched.`
      );
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error(`${filePath}: "${name}" is present but is a ${typeof value}, not an array — refusing to guess its contents.`);
    }
    return value;
  };

  return {
    users: normalizeCollection("users", obj.users) as User[],
    games: normalizeCollection("games", obj.games) as SavedGame[],
  };
}

/**
 * Pre-ownership games (no `userId` — the field was added 2026-06-18 with
 * multi-user support) load fine under `normalizeDbShape` above but are then
 * invisible forever: every read filters strictly by `userId`
 * (`g.userId === user.id`), `undefined` never matches any real id, and
 * nothing ever back-fills the field — `GET /api/games` returns `200 []`
 * on every future request while the exact same games sit byte-intact in
 * db.json (RED-DESKTOP-6/002). Desktop-only (the brief's own scoping): a
 * hosted db.json missing `userId` on some rows is a DIFFERENT, ambiguous
 * situation (which of potentially many accounts should adopt them?) with no
 * safe single answer, so it is left alone there, just logged.
 */
function migrateOwnerlessGames(db: DB, filePath: string): boolean {
  if (!isDesktop()) return false;
  const orphaned = db.games.filter((g) => !g.userId);
  if (orphaned.length === 0) return false;
  for (const g of orphaned) g.userId = LOCAL_OWNER_ID;
  console.warn(
    `${filePath}: migrated ${orphaned.length} pre-account game(s) with no "userId" to the desktop `
    + `local owner ("${LOCAL_OWNER_ID}") so they remain visible. This is a one-time migration, `
    + `written back to disk.`
  );
  return true;
}

/**
 * Set when a startup recovery path found an unreadable, unparseable or
 * malformed `DB_FILE` and could NOT move it aside (`fs.renameSync` failed —
 * typically the containing directory is not writable). The original bytes
 * are then still sitting at `DB_FILE`, and the process is running on a fresh
 * empty database: the very next local-file `saveDB`/`saveDBAwaited` would
 * write that empty object straight over the real data — silently, and most
 * likely AFTER an operator has fixed the directory permissions to "make
 * saving work again". (CodeRabbit, 2026-09-03, PR #96: "block local-file
 * writes after failed preservation".) While set, every local-file save is
 * refused with `false` — which the desktop routes already turn into an
 * honest 500 (RED-DESKTOP-4/002) — until the operator resolves the file and
 * restarts. The GCS branch is unaffected: there the local file is scratch
 * and the bucket is the store.
 */
let localPersistenceBlocked: string | null = null;
function blockLocalPersistence(reason: string): void {
  localPersistenceBlocked = reason;
  console.error(
    `Local-file persistence is now BLOCKED for this process: ${reason}. Every save to ${DB_FILE} `
    + `will be refused until the file is repaired, moved or deleted and the server is restarted.`
  );
}
function localFileSaveBlocked(): boolean {
  if (!localPersistenceBlocked) return false;
  if (!process.env.ELECTRON_USER_DATA_PATH && GCS_BUCKET) return false; // GCS is the store; the local file is scratch
  console.error(`Refusing to write ${DB_FILE}: local-file persistence is blocked (${localPersistenceBlocked}).`);
  return true;
}

function loadDBFromFile(): DB | null {
  try {
    const dbDir = path.dirname(DB_FILE);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  } catch (err) {
    console.error("Error creating database directory:", err);
  }
  if (!fs.existsSync(DB_FILE)) {
    const fresh: DB = { users: [], games: [] };
    try {
      writeFileAtomicSync(DB_FILE, JSON.stringify(fresh, null, 2));
    } catch (err) {
      console.error("Error creating fresh db.json:", err);
    }
    return fresh;
  }

  let data: string;
  try {
    data = fs.readFileSync(DB_FILE, "utf-8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      // TOCTOU: the `fs.existsSync(DB_FILE)` check just above was true a
      // moment ago, and the file is now gone (deleted between the check and
      // this read). Nothing to lose — same as the "no file yet" branch
      // above.
      console.error(`db.json at ${DB_FILE} vanished between the existence check and the read; starting fresh:`, err);
      return { users: [], games: [] };
    }
    // CodeRabbit, 2026-09-03 (Major — real data loss, reproduced): the file
    // EXISTS (confirmed above) but could not be READ — EACCES, EISDIR, EIO,
    // a transient permissions/disk problem, not "no database yet." Blindly
    // returning an empty DB here used to be exactly as dangerous as the
    // JSON-parse/shape-mismatch branches below already guard against: the
    // very next `saveDB` calls `writeFileAtomicSync` and overwrites the file
    // WHOLESALE with that empty object, permanently erasing real data that
    // was never actually corrupted — only unreadable BY THIS PROCESS AT THIS
    // MOMENT. Reproduced against the shipping bundle: `chmod 000` on an
    // existing db.json holding a real user and a real saved game — the
    // server boots, /api/health is 200, and the very next write (a plain
    // registration) replaces the whole file with just the new user; the
    // original user and game are gone, not recoverable.
    //
    // `fs.renameSync` needs only WRITE permission on the containing
    // directory, not read/write permission on the file's own bits, so this
    // still succeeds when the `open()` above failed on EACCES — preserving
    // the original, unmodified bytes for recovery once the underlying
    // problem (permissions, a busy volume, ...) is fixed.
    const aside = `${DB_FILE}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let preserved = false;
    try {
      fs.renameSync(DB_FILE, aside);
      preserved = true;
    } catch (renameErr) {
      console.error(`Could not move the unreadable db.json aside to ${aside}:`, renameErr);
    }
    const cause = err instanceof Error ? err.message : String(err);

    // Same desktop/hosted split as the shape-mismatch branch below, for the
    // identical reason: a hosted instance must never exit(1) over local
    // scratch state that a transient GCS failure fell back to (see that
    // branch's own comment for the full argument).
    if (!isDesktop()) {
      console.error(
        `${DB_FILE} exists but could not be read (${cause}). Resetting to a fresh database`
        + (preserved
          ? ` — the unreadable file has been preserved at ${aside} for recovery.`
          : `; the unreadable file could NOT be moved aside — it has been left in place, unread.`)
      );
      if (!preserved) blockLocalPersistence(`${DB_FILE} could not be read (${cause}) and could not be moved aside`);
      return { users: [], games: [] };
    }

    reportDesktopLockFailure(
      `Refusing to start: ${DB_FILE} exists but could not be read (${cause}). Starting anyway `
      + `would risk silently replacing real data with an empty games library on the next save. `
      + (preserved
        ? `The unreadable file has been preserved at ${aside} — quit, fix its permissions (or restore it from a backup), then relaunch.`
        : `The unreadable file could not be moved aside; please back it up, then fix its permissions and relaunch.`),
      preserved ? aside : DB_FILE,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    // A database we cannot parse is not a database we may DELETE. Returning the
    // empty DB here is survivable on its own; what made it destructive is what
    // happens next — the first `saveDB` writes that empty object straight over
    // the file, so the unreadable-but-present rows become genuinely gone. Move
    // the bad file aside first, so the bytes still exist to be recovered from
    // and the next save lands on a clean path.
    const aside = `${DB_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      fs.renameSync(DB_FILE, aside);
      console.error(`Error reading db.json, resetting database. The unreadable file has been kept at ${aside}:`, err);
    } catch (renameErr) {
      console.error("Error reading db.json, resetting database (and the unreadable file could NOT be preserved):", err, renameErr);
      blockLocalPersistence(`${DB_FILE} is not valid JSON and could not be moved aside`);
    }
    return { users: [], games: [] };
  }

  let db: DB;
  try {
    db = normalizeDbShape(parsed, DB_FILE);
  } catch (shapeErr) {
    // Present, but the WRONG TYPE — not a recognised old shape. Same
    // preserve-the-bytes treatment as an unparseable file either way: move
    // the bad file aside so the bytes still exist to be recovered from and
    // the next save lands on a clean path.
    const aside = `${DB_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let preserved = false;
    try {
      fs.renameSync(DB_FILE, aside);
      preserved = true;
    } catch (renameErr) {
      console.error(`Could not move the malformed db.json aside to ${aside}:`, renameErr);
    }
    const cause = shapeErr instanceof Error ? shapeErr.message : String(shapeErr);

    // DESKTOP ONLY past this point (CodeRabbit, 2026-09-03 — a real gap: this
    // function is ALSO reached on the HOSTED path, both from initDB's
    // no-GCS-configured branch and from its GCS-load-threw catch, neither of
    // which sets IS_ELECTRON). On the hosted service this is NOT
    // "survivable on its own" would be the wrong read to invert into a hard
    // failure: unlike the desktop case (one user's own data, a dialog they
    // can act on), a malformed local db.json in a Cloud Run container is
    // ephemeral scratch state a transient GCS failure fell back to — exiting
    // here would crash the instance in a request-unrelated startup path
    // (worse than the old silent-empty-DB fallback this whole function
    // exists to improve on), Cloud Run would just restart it into the same
    // failure, and the refusal's own message ("quit, inspect/repair or
    // delete it, then relaunch") is desktop-specific text no operator would
    // see. Same treatment as an unparseable file there: log loudly, keep the
    // bytes preserved aside, start with a fresh empty DB rather than exit.
    if (!isDesktop()) {
      console.error(
        `${DB_FILE} could not be read as a valid database (${cause}). Resetting to a fresh database `
        + (preserved
          ? `; the unreadable file has been preserved at ${aside} for recovery.`
          : `; the unreadable file could NOT be moved aside — it has been left in place, unread.`)
      );
      if (!preserved) blockLocalPersistence(`${DB_FILE} is not a valid database (${cause}) and could not be moved aside`);
      return { users: [], games: [] };
    }

    // Present, but the WRONG TYPE — not a recognised old shape. This is NOT
    // "survivable on its own" the way a fresh empty DB is for a corrupt-JSON
    // file: silently starting with an empty library here could just as
    // easily be masking real, unknown-shaped data belonging to the one user
    // of this desktop install. Refuse LOUDLY at startup instead — the same
    // dialog/exit machinery `acquireDesktopLock` already uses (#88/#93) for
    // "we cannot trust this data directory, don't start."
    reportDesktopLockFailure(
      `Refusing to start: ${DB_FILE} could not be read as a valid database (${cause}). Starting `
      + `anyway would risk silently showing an empty games library instead of the real cause. `
      + (preserved
        ? `The unreadable file has been preserved at ${aside} — quit, inspect/repair or delete it, then relaunch.`
        : `The unreadable file could not be moved aside; please back it up, then remove or repair ${DB_FILE} and relaunch.`),
      preserved ? aside : DB_FILE,
    );
    return null;
  }

  if (migrateOwnerlessGames(db, DB_FILE)) {
    try {
      writeFileAtomicSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (err) {
      // Best-effort durability: the in-memory DB is correct either way (every
      // future read/write this run sees the migrated userId), so a write
      // failure here just means the SAME migration note logs again on the
      // next boot rather than being lost.
      console.error(`Could not persist the ownerless-game migration to ${DB_FILE} (will retry on next boot):`, err);
    }
  }

  return db;
}

// GCS concurrency state. See `scheduleGcsSave`/`uploadDbToGcs` below (near
// `saveDB`) for the full explanation of what these protect against.
let gcsGeneration: string | null = null;
let gcsBaselineDb: DB | null = null;
/**
 * Refuse to become a SECOND writer against the same `ELECTRON_USER_DATA_PATH`.
 *
 * `loadDB()`/`saveDB()` cache the ENTIRE database in memory once at startup
 * and always overwrite the WHOLE file on save — `writeFileAtomicSync`'s own
 * comment above promises atomicity per write, but says nothing about a
 * SECOND writer, because there was never supposed to be one. Two
 * `dist/server.cjs` processes pointed at the same user-data directory hold
 * two independent, diverging in-memory snapshots, and whichever one saves
 * LAST silently and completely erases the other's saved games from disk —
 * with a 200 OK returned to BOTH windows at the moment each save was made.
 * (RED-DESKTOP-3, round3/findings/RED-DESKTOP-3/001-concurrent-servers-
 * silent-data-loss.md — reproduced independently before this fix.)
 *
 * Electron's own `app.requestSingleInstanceLock()` (electron-main.cjs)
 * already blocks the ORDINARY path — double-clicking the Dock icon while the
 * app is already open never reaches this file at all, since the second
 * process calls `app.quit()` before `dist/server.cjs` is ever required. This
 * lock is defense for the paths that lock does NOT cover: a support/debug
 * script running the bundle directly against a real install's data
 * directory, `npm run electron:start` (dev) alongside an already-open
 * packaged .app, Electron's own documented non-instantaneous lock
 * acquisition, or two copies of the app sharing one user-data path. Worse,
 * IS_ELECTRON's own EADDRINUSE retry (`startListening`, below) would
 * otherwise let a second process land quietly on the NEXT port and start
 * serving — no crash, no port conflict, nothing to notice until a save goes
 * missing.
 *
 * A PID lockfile turns that silent loss into a loud, immediate startup
 * failure: exit BEFORE `initDB()` ever loads a second in-memory snapshot, so
 * nothing is read, nothing is served, and no divergent write can happen.
 *
 * "Loud" only held for a standalone `node dist/server.cjs` run, where
 * whoever typed the command sees the message on their own terminal. The
 * PACKAGED app requires this file IN-PROCESS (electron-main.cjs), so the
 * original `process.exit(1)` here silently killed the entire Electron main
 * process before any BrowserWindow existed — no window, no dialog, no
 * "app quit unexpectedly" alert, no crash report, nothing in the unified log
 * a normal user would ever find (RED-DESKTOP-4/001-reused-pid-silent-app-
 * vanish.md). Worse, the liveness check below is PID-based and pid numbers
 * get reused by unrelated processes once their original owner is gone, so an
 * ordinary crash history can make this fire on a false positive, forever,
 * with zero visible cause.
 *
 * `reportDesktopLockFailure` is the one exit for both failure sites in this
 * function (see below). Under the packaged app it hands off to
 * `global.onDesktopLockFailure`, which electron-main.cjs registers BEFORE
 * requiring this file — that presence IS the signal "we are the packaged
 * app and someone can show a dialog," so a standalone run (this file's own
 * integration tests included) is untouched: no hook is registered, so
 * `process.exit(1)` still fires exactly as before.
 */
function reportDesktopLockFailure(message: string, lockFile: string): boolean {
  console.error(message);
  const onFailure = process.env.IS_ELECTRON === "true" ? (globalThis as any).onDesktopLockFailure : undefined;
  if (typeof onFailure === "function") {
    // Hands the process's fate to electron-main.cjs (dialog, then
    // app.exit()/app.relaunch()) instead of exiting here. Returning `false`
    // tells the caller to stop (no initDB, no listen) WITHOUT exiting itself
    // — the Electron process must stay alive for the async dialog to render.
    // `lockFile` is passed structurally (not parsed back out of the message)
    // so the dialog's own "delete it and retry" action never has to guess a
    // path out of prose.
    //
    // Marked settled BEFORE calling the hook, not after: `onFailure` itself
    // may synchronously trigger further code (electron-main.cjs's own hook
    // body) before this function returns, and `handleFatalAsync` must treat
    // that whole window — hand-off through the async dialog actually being
    // shown and dismissed — as reported, not still "starting up" (see
    // `startupOutcomeReported`'s own comment).
    startupOutcomeReported = true;
    onFailure({ message, lockFile });
    return false;
  }
  process.exit(1);
}

function acquireDesktopLock(): boolean {
  const userDataPath = process.env.ELECTRON_USER_DATA_PATH;
  if (!userDataPath) return true; // hosted service: GCS's own analogous risk is a separate, product-scope question
  try {
    if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
  } catch (err: any) {
    // RED-DESKTOP-5b (following up on 001's read-side fix): this branch can
    // ONLY be reached when `fs.existsSync(userDataPath)` just returned false
    // — i.e. there is no accessible pre-existing directory here, for THIS
    // process or any other. Unlike the write-side lock-file branch below
    // (which now checks explicitly), there is no scenario where failing
    // open here reaches a user's real, existing data: `loadDBFromFile`
    // needs the exact same directory access this call just failed to get,
    // so proceeding does not "let them in" — it walks straight into
    // `loadDBFromFile`'s own catch (server.ts ~470-478), which silently
    // returns a FRESH EMPTY database with only a console.error nobody in
    // the packaged app ever sees. That is strictly worse than refusing
    // loudly here with the real error: the user would see an empty library
    // and could easily mistake it for "no games saved yet" rather than "the
    // app can't reach your data directory". Fail CLOSED.
    console.error("Error creating user-data directory for the desktop lock:", err);
    return reportDesktopLockFailure(
      `Refusing to start: could not create or access the desktop data directory at ${userDataPath} `
      + `(${err && err.code ? err.code : "unknown error"}). This usually means a permissions problem, `
      + `a read-only filesystem, or a missing/inaccessible parent directory. Starting anyway would risk `
      + `showing an empty games library instead of a clear error, since your saved games (if any) live `
      + `in this same directory. Fix its permissions/availability and try again.`,
      userDataPath,
    );
  }
  const lockFile = path.join(userDataPath, ".server.lock");

  // ATOMIC on purpose. An earlier version checked `fs.existsSync(lockFile)`
  // and then `fs.writeFileSync`'d it as two separate steps — a real
  // check-then-act race (CodeRabbit caught it): two processes launched
  // close enough together can both observe "no lock file" before either has
  // written one, and both then proceed to load independent database
  // snapshots — exactly the near-simultaneous-launch case this lock exists
  // to catch, silently defeated. `wx` (write, fail if the path already
  // exists) makes the CREATE itself the race-free step: the filesystem, not
  // this process, decides which of two simultaneous openers wins.
  // Bound raised from 3 to 5: the content-recheck below can now consume an
  // attempt WITHOUT creating the lock (a detected race just loops to
  // re-decide), so a genuine two-way stale-takeover race needs one extra
  // round-trip of headroom over the original bound.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break; // acquired
    } catch (err: any) {
      if (err.code !== "EEXIST") {
        // RED-DESKTOP-5b: `err.code !== "EEXIST"` is NOT reliable proof that
        // no lock file exists. POSIX does not guarantee the O_EXCL
        // existence check runs before an access check: if this process
        // lacks *search/lookup* permission on the directory itself (e.g. its
        // mode has no execute bit — verified empirically: a directory
        // chmod'd 000 reports EACCES for a lock-file path REGARDLESS of
        // whether that lock file exists or not), the kernel can report
        // EACCES/EPERM without ever reaching the "does it exist" test, even
        // though a live lock is sitting right there. Failing open on that
        // would recreate exactly the 001 hole (an ambiguous "can't tell"
        // case discarding the protection) via a different errno.
        //
        // `fs.existsSync` cannot resolve this — it swallows every error
        // internally and returns `false` for BOTH "genuinely absent" and
        // "cannot even check", which are exactly the two cases that must be
        // told apart here (verified empirically: a directory with no search
        // permission makes `existsSync` say `false` whether or not the file
        // is really there). `fs.statSync`'s own error CODE distinguishes
        // them: `ENOENT` is the one code that means the lookup itself
        // succeeded and the name genuinely is not there (verified: a
        // read+execute-but-not-writable directory — the shape
        // desktop-unwritable-save.test.mjs exercises — gives ENOENT for a
        // truly absent lock file); any other code means the lookup itself
        // could not be completed, so absence was never established.
        let statErr: any = null;
        try {
          fs.statSync(lockFile);
          // Succeeded: the file DOES exist. Fall through (no return) to the
          // EEXIST handling below, exactly as a real EEXIST would have.
        } catch (e: any) {
          statErr = e;
        }
        if (statErr) {
          // CodeRabbit (this round): ENOENT on the LOCK FILE alone is not
          // enough — the mkdir/existsSync check above only proved the
          // directory was there AT THAT POINT IN TIME. If `userDataPath`
          // itself was removed in the window between that check and here
          // (another process/tool deleting it, or a race), `openSync`/
          // `statSync` on a path INSIDE a now-missing directory ALSO report
          // ENOENT — indistinguishable from "directory fine, lock file
          // legitimately never existed" by this code alone. Failing open on
          // that would walk into exactly the case the mkdir branch above was
          // fixed to avoid: `loadDBFromFile` finds DB_FILE missing too and
          // silently returns a fresh EMPTY database. Re-check the directory
          // itself, fresh, before trusting the ENOENT.
          const directoryStillThere = fs.existsSync(userDataPath);
          if (statErr.code === "ENOENT" && directoryStillThere) {
            // Positively confirmed: the directory is there RIGHT NOW, and
            // the lock file specifically is not. Any EXISTING games remain
            // readable by `loadDBFromFile`; this failure is specifically
            // about creating a NEW file (a read-only mount, a full disk, a
            // permission that blocks *creates* specifically, ...) and
            // carries no positive evidence of a live second writer. Per
            // round4/#88's `saveDBOrFail`, an actual write attempt under the
            // same condition will fail LOUDLY and honestly at save time, not
            // silently diverge, so this cannot reproduce 001's split-brain
            // scenario. Failing CLOSED here instead would deny the user read
            // access to their existing data for a write-only problem with no
            // real data-loss risk. Fail OPEN — but only for this,
            // positively-confirmed-absent-with-directory-intact case.
            console.error("Error writing desktop lock file:", err);
            return true;
          }
          // Cannot determine either way. Two shapes land here: (a)
          // EACCES/EPERM/... on the stat itself (the directory blocks even
          // looking), or (b) ENOENT on the lock file WHILE `userDataPath`
          // itself is ALSO gone right now (`directoryStillThere` false) —
          // the directory that passed the mkdir/existsSync check above did
          // not survive to this point, so the earlier check's "the
          // directory is fine" no longer holds. Both are genuinely
          // ambiguous: a live lock (or real, now-unreachable data) could be
          // sitting right there, invisible to us. Same principle as 001's
          // read-side fix — "cannot resolve" must mean refuse, not proceed
          // unprotected.
          console.error("Error writing desktop lock file:", err, "— and could not determine whether one already exists:", statErr);
          return reportDesktopLockFailure(
            `Refusing to start: could not create the desktop data-directory lock at ${lockFile} `
            + `(${err && err.code ? err.code : "unknown error"}), and could not determine whether one `
            + `already exists either (${statErr && statErr.code ? statErr.code : "unknown error"}). This `
            + `usually means a permissions problem on ${userDataPath}, or that it stopped being `
            + `accessible partway through startup. Starting anyway could silently overwrite another `
            + `process's saved games if one is currently running, or show an empty library instead of `
            + `a clear error. Fix its permissions/availability and try again.`,
            lockFile,
          );
        }
      }
    }
    // EEXIST: someone else's lock is already there — a live process, or one
    // that crashed without cleaning up. Read it to tell the two apart.
    //
    // TEST HOOK ONLY — never set outside a test process: lets an
    // integration test deterministically win the race CodeRabbit found on
    // re-review — `existsSync` and `readFileSync` are two separate calls,
    // so a competing process (or, in the test, the test itself) can unlink
    // the file in between, and the unguarded `readFileSync` would throw
    // ENOENT outside any catch, crashing `startServer()` before it ever
    // gets to initDB()/listen().
    const readRaceDelayMs = parseInt(process.env.NASH_LOCK_TEST_READ_RACE_DELAY_MS || "", 10);
    if (fs.existsSync(lockFile) && Number.isFinite(readRaceDelayMs) && readRaceDelayMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, readRaceDelayMs);
    }
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(lockFile, "utf-8");
    } catch (err: any) {
      if (err && err.code === "ENOENT") {
        // The lock vanished between our EEXIST and this read — someone
        // else's own stale-takeover (or a clean release) already cleared
        // it. Loop and re-decide from scratch instead of treating a
        // gone/unreadable file as a real lock with empty content (which
        // would have parsed as heldBy = NaN and fallen through as if the
        // recorded pid were simply invalid, silently skipping straight to
        // "stale, take over" without ever re-checking what's ACTUALLY there
        // now — possibly a brand-new LIVE lock).
        continue;
      }
      // RED-DESKTOP-5/001: unlike the write-side fail-open above (a
      // directory-creation error carries no positive evidence either way),
      // reaching HERE means `fs.openSync(lockFile, "wx", ...)` already threw
      // EEXIST — the lock file's mere EXISTENCE *is* positive evidence some
      // process wrote it, live or crashed. An unreadable-but-existing lock
      // (permissions changed by a sync/backup tool, an ownership change,
      // ...) is the single most ambiguous case this function exists to
      // resolve, and failing OPEN on it throws away the whole protection:
      // a second process boots normally, becomes an independent writer
      // against the same ELECTRON_USER_DATA_PATH, and whichever one saves
      // last silently erases the other's games — reproduced end-to-end
      // (chmod 000 on a live instance's lock file; the second process
      // booted anyway; db.json ended up holding only the second process's
      // game). "Cannot resolve the ambiguity" must mean refuse, the same as
      // a confirmed-alive pid, not proceed unprotected.
      console.error("Error reading desktop lock file:", err);
      return reportDesktopLockFailure(
        `Refusing to start: the desktop data-directory lock at ${lockFile} exists but could not `
        + `be read (${err && err.code ? err.code : 'unknown error'}). This usually means its file `
        + `permissions changed (a backup/sync tool, or an ownership change) while another Nash `
        + `Equilibrium Simulator process may still be using this data directory (${userDataPath}). `
        + `Starting anyway could silently overwrite its saved games. Fix the file's permissions, or `
        + `— if you're sure no other copy is open — delete the lock file and try again.`,
        lockFile,
      );
    }
    const heldBy = parseInt(rawContent.trim(), 10);
    let alive = false;
    if (Number.isInteger(heldBy) && heldBy > 0) {
      try {
        // Throws ESRCH if no such process exists; EPERM means it exists but
        // is owned by someone else, which still counts as "alive" here.
        process.kill(heldBy, 0);
        alive = true;
      } catch (err: any) {
        alive = err && err.code === "EPERM";
      }
    }
    if (alive) {
      return reportDesktopLockFailure(
        `Refusing to start: another Nash Equilibrium Simulator server (pid ${heldBy}) is already using `
        + `this data directory (${userDataPath}). Starting a second one would silently overwrite its saved `
        + `games. Quit the other instance first, or — if you're sure no other copy is open (this can happen `
        + `after a crash whose process id has since been reused by something unrelated) — delete the lock `
        + `file at ${lockFile} and try again.`,
        lockFile,
      );
    }
    // Stale: the recorded PID is no longer running. TEST HOOK ONLY — never
    // set outside a test process — lets an integration test deterministically
    // win the exact interleaving below rather than hoping real OS scheduling
    // cooperates (a 12-process stress test against the UNFIXED code still
    // serialized to 1 winner in this sandbox's process-spawn timing, so real
    // timing cannot be trusted to exercise this path).
    const testDelayMs = parseInt(process.env.NASH_LOCK_TEST_DELAY_MS || "", 10);
    if (Number.isFinite(testDelayMs) && testDelayMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testDelayMs);
    }
    // CodeRabbit's finding: unconditionally unlinking here is not atomic
    // with the read above. Between that read and this unlink, a DIFFERENT
    // process can run this exact same stale-detection-and-takeover sequence
    // to completion, creating a fresh, LIVE lock with ITS OWN pid — and this
    // process would then delete that live lock out from under it, blind to
    // the change, and go on to create a SECOND live lock of its own. Two
    // writers, the exact thing this file exists to prevent. Re-reading
    // immediately before the unlink and comparing against what we just
    // inspected closes that: if the content changed, someone else already
    // acted on this exact staleness — do NOT touch their fresh lock, loop
    // and re-evaluate whatever is there now instead. Full atomicity would
    // need an OS-level advisory lock (flock) this codebase does not have;
    // this narrows the surviving race to the few instructions between the
    // re-read and the unlink, which is what the loop bound below accounts
    // for as a needed extra round-trip, not evidence of unbounded spinning.
    let recheck: string | null = null;
    try { recheck = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf-8") : ""; } catch { recheck = null; }
    if (recheck !== rawContent) {
      continue; // someone else changed it — re-read and re-decide from scratch
    }
    try { fs.unlinkSync(lockFile); } catch { /* already gone: fine, next attempt recreates it */ }
  }

  // Defensive: if every attempt was consumed by repeated recheck-misses
  // without ever reaching the `break` above, we do NOT actually hold the
  // lock. Falling through un-locked would silently defeat the whole
  // guarantee — verify, and refuse loudly rather than serve unprotected.
  {
    const finalContent = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf-8").trim() : "";
    if (finalContent !== String(process.pid)) {
      return reportDesktopLockFailure(
        `Refusing to start: could not acquire the desktop data-directory lock at ${lockFile} `
        + `after repeated contention. Try again.`,
        lockFile,
      );
    }
  }

  const release = () => {
    try {
      if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, "utf-8").trim() === String(process.pid)) {
        fs.unlinkSync(lockFile);
      }
    } catch { /* best effort — a leftover lock is handled by the liveness check above */ }
  };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(0); });
  process.on("SIGTERM", () => { release(); process.exit(0); });
  return true;
}

// Load DB once at startup: GCS in Cloud Run, local file in Electron/dev.
// Returns `false` when `loadDBFromFile` refused to load an unrecoverable
// db.json shape (RED-DESKTOP-6/001) — the failure has already been reported
// (standalone: `process.exit(1)`; packaged: the startup-blocked dialog via
// `reportDesktopLockFailure`), so the caller (`startServer`) must stop before
// ever calling `app.listen`, exactly like `acquireDesktopLock`'s own contract.
async function initDB(): Promise<boolean> {
  if (process.env.ELECTRON_USER_DATA_PATH) {
    const db = loadDBFromFile();
    if (db === null) return false;
    inMemoryDb = db;
  } else if (GCS_BUCKET) {
    try {
      const { Storage } = await import('@google-cloud/storage');
      const storage = new Storage();
      const file = storage.bucket(GCS_BUCKET).file('db.json');
      const [exists] = await file.exists();
      if (exists) {
        // Metadata FIRST, then a download BOUND to that generation:
        // `download()` ignores `preconditionOpts` in @google-cloud/storage 7,
        // so content and a separately fetched generation could straddle a
        // concurrent write, and the next conditional save would overwrite
        // that write without ever seeing a 412 (CodeRabbit, PR #85).
        const [meta] = await file.getMetadata();
        const [content] = await file.bucket.file('db.json', { generation: meta.generation }).download();
        inMemoryDb = JSON.parse(content.toString('utf-8'));
        gcsGeneration = meta.generation != null ? String(meta.generation) : null;
        // A genuine deep copy, not a reference to `inMemoryDb`: the object
        // returned here would otherwise be the SAME live object every future
        // caller mutates in place (every `saveDB` call site does
        // `const db = loadDB(); db.games.push(...); saveDB(db);` against the
        // one shared singleton), which would make this "baseline" silently
        // track every future edit instead of staying pinned to what was
        // actually on GCS at boot — exactly the state `unionMergeDb` needs to
        // tell "deleted since we last synced" apart from "never existed."
        gcsBaselineDb = JSON.parse(JSON.stringify(inMemoryDb));
      } else {
        inMemoryDb = { users: [], games: [] };
        gcsBaselineDb = { users: [], games: [] };
        // `0` is GCS's own convention for "this object must not exist yet" —
        // protects the very first save of a brand-new bucket against a race
        // with another instance's own first save landing in between this
        // exists() check and that save.
        gcsGeneration = '0';
      }
      console.log(`DB loaded from GCS bucket "${GCS_BUCKET}": ${inMemoryDb!.users.length} users, ${inMemoryDb!.games.length} games`);
    } catch (err) {
      console.error('Error loading DB from GCS, falling back to local file:', err);
      const db = loadDBFromFile();
      if (db === null) return false;
      inMemoryDb = db;
    }
  } else {
    const db = loadDBFromFile();
    if (db === null) return false;
    inMemoryDb = db;
  }
  return true;
}

// Returns the in-memory DB (always synchronous after initDB resolves)
function loadDB(): DB {
  return inMemoryDb ?? { users: [], games: [] };
}

/**
 * Union-merge two DB snapshots by id, after a GCS write lost a generation
 * race to another instance. `remote` is the state we just re-downloaded
 * (the OTHER instance's write); `local` is what THIS instance was about to
 * upload; `baseline` is what this instance last knew to be true on GCS
 * (from `initDB` or its own last successful write).
 *
 * WHY UNION-BY-ID WITH "LOCAL WINS ON COLLISION": neither `User` nor
 * `SavedGame` carries an `updatedAt` field (checked: `interface User`/
 * `SavedGame` in this file have neither), so there is no timestamp to
 * arbitrate a genuine same-id conflict. In practice a same-id collision
 * needs the SAME record edited by two instances in the same short window —
 * rare. The dominant, realistic case this exists for is the one
 * round3/findings/RED-DESKTOP-3/003-cloud-gcs-save-races.md's own
 * reproduction plan describes: each instance handling a DIFFERENT save
 * (disjoint ids), where union recovers BOTH regardless of which id "wins."
 *
 * WHY `baseline` MATTERS — DELETIONS: a plain union of `remote` and `local`
 * would RESURRECT a record this process just deleted (present in `local`'s
 * absence, but the OTHER instance's `remote` copy — which never saw the
 * delete — still has it). An id present in `baseline` but absent from
 * `local` was deleted by THIS process since it last synced; excluding it
 * from both sides of the union honors that deletion even though `remote`
 * doesn't know about it yet.
 */
function unionMergeDb(remote: DB, local: DB, baseline: DB | null): DB {
  const baseUserIds = new Set((baseline?.users ?? []).map((u) => u.id));
  const baseGameIds = new Set((baseline?.games ?? []).map((g) => g.id));
  const localUserIds = new Set(local.users.map((u) => u.id));
  const localGameIds = new Set(local.games.map((g) => g.id));
  const deletedUserIds = new Set([...baseUserIds].filter((id) => !localUserIds.has(id)));
  const deletedGameIds = new Set([...baseGameIds].filter((id) => !localGameIds.has(id)));

  const mergedUsers = new Map<string, User>();
  for (const u of remote.users) if (!deletedUserIds.has(u.id)) mergedUsers.set(u.id, u);
  for (const u of local.users) if (!deletedUserIds.has(u.id)) mergedUsers.set(u.id, u); // local wins a same-id collision

  const mergedGames = new Map<string, SavedGame>();
  for (const g of remote.games) if (!deletedGameIds.has(g.id)) mergedGames.set(g.id, g);
  for (const g of local.games) if (!deletedGameIds.has(g.id)) mergedGames.set(g.id, g);

  return { users: [...mergedUsers.values()], games: [...mergedGames.values()] };
}

/**
 * Publish a merged DB as the process's shared state — MUTATING the CURRENT
 * `inMemoryDb` object's properties, never reassigning `inMemoryDb` to a
 * different object.
 *
 * WHY THIS MATTERS, CONCRETELY: every route handler does
 * `const db = loadDB(); ...mutate db in place...; saveDB(db);`, capturing a
 * REFERENCE to whatever `inMemoryDb` was at the START of that request.
 * `saveDB` in turn does `inMemoryDb = db` — a no-op reassignment in the
 * ORDINARY case, because `db` already IS `inMemoryDb`. If a merge here
 * instead reassigned `inMemoryDb` to a BRAND NEW object, any handler still
 * mid-flight holding the OLDER reference would, on its own next `saveDB`
 * call, silently overwrite `inMemoryDb` back to its stale copy — undoing
 * the merge. Caught this exact interleaving in this round's own
 * integration test: a registration handler's first save (adding a user)
 * triggered a merge with pre-existing remote content; its second save (on
 * the SAME stale `db` reference, removing that user again after the SMTP
 * step failed) then overwrote the merge, silently re-erasing the
 * pre-existing remote game a second time. Mutating in place means that
 * handler's `db` reference IS the merged object, so its own filter/save
 * only ever removes what it meant to remove.
 */
function applyMergedDb(merged: DB): DB {
  const target = inMemoryDb ?? { users: [], games: [] };
  target.users = merged.users;
  target.games = merged.games;
  inMemoryDb = target;
  return target;
}

/**
 * Upload the CURRENT `db` snapshot to GCS with a generation precondition,
 * re-downloading/merging/retrying once on a conflict.
 *
 * WHY `resumable: false, validation: false`: `db.json` is at most a few
 * hundred KB (never the ~120MB the DMG download path deals with), so the
 * resumable-session protocol (POST to open a session, PUT the bytes to the
 * returned Location) buys nothing here and would need a materially more
 * complex fake-GCS harness to test; the simple multipart upload does the
 * same job in one request. `validation: false` skips the client's own MD5
 * round-trip check — reasonable for a same-connection HTTPS upload where
 * TCP/TLS already guarantee byte-level integrity end to end, and it is what
 * the fake-GCS integration test also mocks against.
 */
async function uploadDbToGcs(db: DB, attempt: number = 0): Promise<void> {
  if (attempt > 2) {
    console.error('GCS write failed after repeated generation conflicts — giving up on this save. A later save will try again with fresh state.');
    return;
  }
  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage();
  const file = storage.bucket(GCS_BUCKET!).file('db.json');

  // `gcsGeneration === null` means we have NEVER established what is
  // actually on GCS — most plausibly `initDB`'s GCS read threw and fell
  // back to `loadDBFromFile()` (which, in hosted mode, reads a LOCAL file
  // that does not exist in Cloud Run and returns an empty database).
  // Uploading unconditionally in that state would be a real, unconditional
  // write with no precondition at all, which would REPLACE the real remote
  // object with that empty fallback — CodeRabbit caught this. Re-sync
  // first rather than either writing blindly or refusing to ever write
  // again: this makes the process self-healing once GCS is reachable,
  // instead of a transient load failure at boot permanently disabling all
  // future saves.
  if (gcsGeneration === null) {
    try {
      const [exists] = await file.exists();
      if (exists) {
        const [meta] = await file.getMetadata(); // metadata first, generation-bound download — see initDB
        const [remoteContent] = await file.bucket.file('db.json', { generation: meta.generation }).download();
        gcsGeneration = meta.generation != null ? String(meta.generation) : null;
        const remote: DB = JSON.parse(remoteContent.toString('utf-8'));
        db = applyMergedDb(unionMergeDb(remote, db, gcsBaselineDb)); // mutates the SHARED object in place — see applyMergedDb's comment
      } else {
        gcsGeneration = '0'; // GCS's own "must not exist yet" convention, matching initDB
      }
    } catch (err) {
      console.error('GCS write skipped: could not establish the object generation after a previous load failure. A later save will retry:', err);
      return; // fail SAFE — do not write blindly over state we have never read
    }
  }

  const bodyStr = JSON.stringify(db, null, 2);
  const saveOpts: {
    contentType: string; resumable: boolean; validation: boolean; timeout: number;
    preconditionOpts?: { ifGenerationMatch: string };
  } = {
    contentType: 'application/json', resumable: false, validation: false,
    // The non-resumable path defaults to timeout 0 (wait forever); a hung
    // request would pin `gcsUploadInFlight` and starve every later save.
    timeout: 30_000,
  };
  if (gcsGeneration !== null) {
    saveOpts.preconditionOpts = { ifGenerationMatch: gcsGeneration };
  }
  try {
    await file.save(bodyStr, saveOpts);
    // Read the generation OFF THE UPLOAD RESPONSE ITSELF
    // (`@google-cloud/storage` populates `file.metadata` from it), not a
    // separate `getMetadata()` call — CodeRabbit caught the TOCTOU: between
    // our write completing and a follow-up GET landing, a DIFFERENT writer
    // could have already written again, and we would then silently adopt
    // THEIR generation as if it were the result of our own write, letting
    // our next save overwrite theirs without ever seeing a 412.
    const generation = file.metadata?.generation;
    gcsGeneration = generation != null ? String(generation) : null;
    gcsBaselineDb = JSON.parse(bodyStr); // see initDB's comment: a real copy, not a live reference
  } catch (err: any) {
    if (err?.code === 412) {
      // Someone else wrote first. Re-download, merge OUR pending changes
      // onto their state, and retry with the fresh generation.
      try {
        const [meta] = await file.getMetadata(); // metadata first, generation-bound download — see initDB
        const [remoteContent] = await file.bucket.file('db.json', { generation: meta.generation }).download();
        gcsGeneration = meta.generation != null ? String(meta.generation) : null;
        const remote: DB = JSON.parse(remoteContent.toString('utf-8'));
        const merged = applyMergedDb(unionMergeDb(remote, db, gcsBaselineDb)); // mutates the SHARED object in place — see applyMergedDb's comment
        await uploadDbToGcs(merged, attempt + 1);
      } catch (mergeErr) {
        console.error('GCS write conflict: re-download/merge failed:', mergeErr);
      }
      return;
    }
    console.error('GCS write failed:', err);
  }
}

let gcsUploadInFlight = false;
let gcsSaveRequested = false;

/**
 * Serialize and COALESCE saves to GCS, per process.
 *
 * THE DEFECT THIS CLOSES (round3/findings/RED-DESKTOP-3/
 * 003-cloud-gcs-save-races.md, case 1): the previous `saveDB` fired an
 * independent, un-awaited `import(...).then(save)` chain on EVERY call, so
 * two saves within the same upload's latency window raced as two
 * concurrent HTTP uploads with no ordering guarantee between them — GCS is
 * last-COMPLETION-wins, so an older upload finishing after a newer one
 * silently erased the newer save.
 *
 * THE FIX EXPLOITS THIS FILE'S OWN ARCHITECTURE RATHER THAN FIGHTING IT:
 * every `saveDB` call site does `const db = loadDB(); ...mutate db in
 * place...; saveDB(db);` against the ONE shared `inMemoryDb` singleton —
 * `db` is always the SAME object reference, never a fresh clone. That means
 * a pump that (a) never starts a second upload while one is in flight, and
 * (b) always uploads whatever `inMemoryDb` LOOKS LIKE AT THE MOMENT IT
 * ACTUALLY STARTS THAT UPLOAD, automatically uploads the latest state for
 * free — no explicit snapshot queue needed. `gcsSaveRequested` just means
 * "at least one more save happened since the pump last looked"; when the
 * in-flight upload finishes, the pump uploads the CURRENT state exactly
 * once more, however many saves piled up while it was busy.
 */
function scheduleGcsSave(): void {
  gcsSaveRequested = true;
  if (gcsUploadInFlight) return;
  gcsUploadInFlight = true;
  (async () => {
    while (gcsSaveRequested) {
      gcsSaveRequested = false;
      await uploadDbToGcs(inMemoryDb ?? { users: [], games: [] });
    }
    gcsUploadInFlight = false;
  })().catch((err) => {
    console.error('Unexpected error in the GCS save pump:', err);
    gcsUploadInFlight = false;
  });
}

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf-8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function makeCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

// How many wrong guesses a one-time code tolerates before it's invalidated.
const MAX_CODE_ATTEMPTS = 5;

const CODE_FIELDS = {
  verification: { code: "verificationCode", expires: "verificationCodeExpires", attempts: "verificationCodeAttempts" },
  recovery: { code: "recoveryCode", expires: "recoveryCodeExpires", attempts: "recoveryCodeAttempts" },
  delete: { code: "deleteCode", expires: "deleteCodeExpires", attempts: "deleteCodeAttempts" },
} as const;

// Constant-time, attempt-limited check of a one-time 6-digit code. Increments a
// per-code failure counter and invalidates the code after MAX_CODE_ATTEMPTS
// wrong guesses, so the 10-minute TTL can't be brute-forced across the 1e6
// space (the per-IP rate limit alone is bypassable via IP rotation). Mutates
// `user`; the caller must persist with saveDB(). `locked` means this attempt
// tripped the limit and the code is now cleared.
function verifyOneTimeCode(user: User, kind: keyof typeof CODE_FIELDS, submitted: string): { ok: boolean; locked: boolean } {
  const f = CODE_FIELDS[kind];
  const u = user as unknown as Record<string, unknown>;
  const stored = u[f.code];
  if (typeof stored !== "string" || stored.length === 0) {
    return { ok: false, locked: false };
  }
  if (safeEqual(stored, submitted)) {
    u[f.attempts] = undefined;
    return { ok: true, locked: false };
  }
  const attempts = ((u[f.attempts] as number) ?? 0) + 1;
  if (attempts >= MAX_CODE_ATTEMPTS) {
    u[f.code] = kind === "verification" ? "" : undefined;
    u[f.expires] = kind === "verification" ? 0 : undefined;
    u[f.attempts] = undefined;
    return { ok: false, locked: true };
  }
  u[f.attempts] = attempts;
  return { ok: false, locked: false };
}

function makeId(prefix: "u" | "g"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
  return `pbkdf2$${PASSWORD_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith("pbkdf2$")) {
    const [, iterRaw, saltRaw, hashRaw] = stored.split("$");
    const iterations = Number(iterRaw);
    if (!iterations || !saltRaw || !hashRaw) return false;
    const salt = Buffer.from(saltRaw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const actual = b64url(crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256"));
    return safeEqual(actual, hashRaw);
  }

  // Legacy migration path for older local/cloud accounts.
  return safeEqual(Buffer.from(password).toString("base64"), stored);
}

function needsPasswordRehash(stored: string): boolean {
  return !stored.startsWith("pbkdf2$");
}

// Precomputed hash for a random password. Used to spend the same pbkdf2 work on
// a login miss as on a hit, so response timing doesn't reveal whether an
// account exists (user enumeration).
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

// Escape user-controlled text before interpolating it into HTML (email bodies).
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createAuthToken(user: User): string {
  const payload = b64url(JSON.stringify({
    sub: user.id,
    ver: user.tokenVersion ?? 0,
    exp: Date.now() + AUTH_TOKEN_TTL_MS,
    nonce: b64url(crypto.randomBytes(12)),
  }));
  const sig = b64url(crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

function readAuthToken(token: string): { sub: string; ver: number } | null {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra) return null;
  const expected = b64url(crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest());
  if (!safeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
    if (!parsed.sub || typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return { sub: parsed.sub, ver: typeof parsed.ver === "number" ? parsed.ver : 0 };
  } catch {
    return null;
  }
}

function getAuthUser(req: express.Request): User | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  const claims = readAuthToken(token);
  if (!claims) return null;
  const user = loadDB().users.find(u => u.id === claims.sub) ?? null;
  // Reject tokens minted before the user's current token version (e.g. issued
  // before a password reset), so a stolen token can't outlive the reset.
  if (!user || (user.tokenVersion ?? 0) !== claims.ver) return null;
  return user;
}

/**
 * The desktop's local owner — the reason the offline app no longer asks you to
 * invent a password to save a file to your own disk.
 *
 * On the hosted service an account is what separates one visitor's games from
 * another's. On the desktop there is no other visitor: the database is
 * `db.json` inside this OS user's own data directory, and the "tenant" is the
 * person at the keyboard, who already owns the file. Requiring registration
 * and e-mail verification there was a hosted constraint imposed where it means
 * nothing — the same mistake as rate-limiting a user against a server they do
 * not share.
 *
 * SCOPED TO THE GAME ROUTES ON PURPOSE. `getAuthUser` is also what guards
 * account DELETION, and a fallback identity there would let anyone at the
 * keyboard start a deletion flow against a real account. Those routes keep the
 * strict check; only the routes that read and write this machine's own saved
 * games use the owner below. That distinction is the whole safety argument, so
 * it is asserted in the tests rather than left to the reader.
 */
const LOCAL_OWNER_ID = 'local-owner';

function isDesktop(): boolean {
  return process.env.IS_ELECTRON === 'true';
}

/** Provision the local owner on first use. Never on the hosted service. */
function ensureLocalOwner(): User | null {
  if (!isDesktop()) return null;
  const db = loadDB();
  const existing = db.users.find((u) => u.id === LOCAL_OWNER_ID);
  if (existing) return existing;
  // Built to the real User shape, with NO cast. The first version set
  // `verified: true` — a field this interface does not have — so the owner
  // read as UNVERIFIED everywhere `isVerified` is checked, and the
  // `as unknown as User` cast is precisely what hid the mismatch. A cast is
  // how a schema drift ships looking correct.
  const owner: User = {
    id: LOCAL_OWNER_ID,
    username: 'This device',
    // A reserved, unroutable address: the local owner has no e-mail, and a
    // blank one would collide with any other record missing the field.
    email: 'local-owner@localhost.invalid',
    passwordHash: '',
    isVerified: true,
    verificationCode: '',
    verificationCodeExpires: 0,
    tokenVersion: 0,
  };
  db.users.push(owner);
  saveDB(db);
  return owner;
}

/**
 * Who owns the saved games for this request: the signed-in user if there is
 * one, otherwise — on the desktop only — the local owner.
 */
function getGameOwner(req: express.Request): User | null {
  return getAuthUser(req) ?? ensureLocalOwner();
}

/**
 * Sign-in ADOPTS whatever was saved locally.
 *
 * Daniel's call: a local owner who later signs in takes their games with them,
 * exactly as a signed-in user's games already follow them. Without this, using
 * the app before making an account would silently strand that work behind an
 * identity the user can no longer reach.
 *
 * Re-parenting rather than copying, so signing in twice cannot duplicate a
 * library.
 */
function adoptLocalGames(userId: string): number {
  if (!isDesktop() || userId === LOCAL_OWNER_ID) return 0;
  const db = loadDB();
  const mine = db.games.filter((g) => g.userId === LOCAL_OWNER_ID);
  if (!mine.length) return 0;
  for (const g of mine) g.userId = userId;
  saveDB(db);
  return mine.length;
}

/**
 * `clampGraphemeSafe` (never splits a surrogate pair or a wider grapheme
 * cluster -- RED-CLOUD-5/001, RED-CLOUD-6/001) now lives in
 * `src/utils/textSafety.ts`, imported above, rather than being defined here:
 * RED-APP-7/004 found the BROWSER needed the identical boundary logic (the
 * label inputs' native `maxLength` attribute was cutting a typed/pasted ZWJ
 * emoji sequence mid-grapheme, client-side, before this server-side clamp
 * ever saw the original string), and a second hand-copied implementation is
 * exactly the kind of drift this codebase has been burned by before (see
 * `cutAtWordBoundary`'s own docstring below, RED-APP-4). One function, two
 * callers, both isomorphic (`Intl.Segmenter` is available in the Node 22
 * runtime this app targets and in every evergreen browser).
 */

/**
 * The one place every user-supplied string passes through before it is
 * persisted via POST/PATCH /api/games, so it has to carry the same
 * bidi-override/control-character stripping the UI form applies
 * (src/utils/textSafety.ts) -- otherwise a direct API call (curl, a script,
 * a modified client) bypasses the form entirely and a RIGHT-TO-LEFT OVERRIDE
 * or raw control character reaches storage intact.
 *
 * Order matters: strip first, then trim, then clamp -- stripping after trim
 * would let a bidi override sitting at the edge of the field decide where
 * the "real" edge is before it gets removed (same reasoning as
 * textSafety.ts's own cleanText). The clamp itself is grapheme-safe
 * (RED-CLOUD-5/001) rather than a bare `.slice`.
 */
function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? clampGraphemeSafe(stripUnsafeText(value).trim(), maxLength) : "";
}

/** How long an option label may be. Short on purpose: these render as column
 *  and row headers next to the payoff inputs, and a sentence would break the
 *  grid. Long enough for "Advertise heavily", short enough to stay a label. */
const LABEL_MAX = 40;

/**
 * Cut a string to at most `maxLength` characters, preferring the last word
 * boundary within that limit over a mid-word slice — a bare `.slice(0, 40)`
 * on a label that gets PRINTED cuts mid-word and the stub then repeats
 * verbatim through a whole rendered paragraph ("Escalate the dispute to the
 * regional arb", rounds T1 and T2).
 *
 * Shared by `cleanScenario`'s `label()` and `cleanLabels()` — RED-APP-4
 * found these had drifted: `cleanLabels` (POST/PATCH /api/games' own
 * row/col labels) still did the bare mid-word slice this helper exists to
 * avoid, on a sibling path `cleanScenario` had already been fixed on.
 * Reachable only by a direct API call (the Save/Edit modal's own
 * `maxlength=40` already blocks it in ordinary UI use).
 *
 * `s` must already be clamped WIDER than `maxLength` by the caller (see
 * `cleanLabels` and `cleanScenario`'s own `noTags(v, 60)`) — cutting the
 * word boundary out of a string already hard-sliced AT `maxLength` would
 * just reproduce the same bug one step later. `at > minKeep` guards against
 * clamping to almost nothing when the first word itself runs long (no space
 * within the first `minKeep` characters).
 *
 * RED-CLOUD-5/001: this function's OWN `cut = s.slice(0, maxLength)` was a
 * second, independent place a bare UTF-16 slice could split a surrogate
 * pair — reachable even when the caller's wider pre-clamp (`cleanText`,
 * fixed separately) never triggers, because `s` can already be <= that
 * wider width and still > `maxLength` here (the live repro: a 41-unit
 * label passed the 60-unit `noTags` clamp untouched, then got split by
 * THIS function's own slice to 40). `cut` is now grapheme-safe via
 * `clampGraphemeSafe`; the later `cut.slice(0, at)` stays a plain index
 * slice, but `at` is always the index of a literal ASCII space character
 * inside the already grapheme-safe `cut` — a space is a single code unit
 * that is never part of a surrogate pair or a wider grapheme cluster, so
 * slicing up to (excluding) it cannot reopen the same defect.
 */
function cutAtWordBoundary(s: string, maxLength: number, minKeep = 12): string {
  if (s.length <= maxLength) return s;
  const cut = clampGraphemeSafe(s, maxLength);
  const at = cut.lastIndexOf(' ');
  return (at > minKeep ? cut.slice(0, at) : cut).trim();
}

/**
 * The four option labels off a request body, cleaned.
 *
 * Returns only the keys that were actually supplied, so a caller updating just
 * the description does not blank the labels by omission. Same clamping as every
 * other user-supplied string here: these are rendered in the UI and fed to the
 * model prompt, so they are trimmed and length-capped rather than trusted.
 */
function cleanLabels(body: any, allowClear = false): Partial<Pick<SavedGame, "row1Label" | "row2Label" | "col1Label" | "col2Label">> {
  const out: Record<string, string> = {};
  for (const key of ["row1Label", "row2Label", "col1Label", "col2Label"] as const) {
    // Clamped WIDER (LABEL_MAX + 20) first, same pattern as cleanScenario's
    // own noTags(v, 60) -> label() below, so cutAtWordBoundary has room to
    // find a real space instead of working on a string already hard-sliced
    // to exactly LABEL_MAX.
    const v = cutAtWordBoundary(cleanText(body?.[key], LABEL_MAX + 20), LABEL_MAX);
    // Without allowClear an empty value means "not supplied", so a caller
    // updating only the description cannot blank the labels by omission. The
    // edit dialog is the opposite case: it sends every field every time, and a
    // user who deletes a wrong label means it. Only that caller opts in.
    if (v || (allowClear && key in (body ?? {}))) out[key] = v;
  }
  return out;
}

/**
 * The user's own colour terms off a request body, cleaned by the SAME shared
 * rules the client applies before sending them (src/utils/colorTerms.ts), so
 * the two ends cannot disagree about what a valid term is.
 *
 * Follows cleanLabels' supplied-vs-cleared convention: an absent key is "not
 * supplied" and leaves the stored terms alone, while the edit dialog — which
 * sends every field — opts into clearing so a user who removes their last term
 * actually loses it.
 *
 * Unlike the labels, these never reach the model prompt.
 */
function cleanColorTerms(body: any, allowClear = false): Partial<Pick<SavedGame, "colorTermsA" | "colorTermsB">> {
  const out: Partial<Pick<SavedGame, "colorTermsA" | "colorTermsB">> = {};
  // Cleaned as a PAIR: a phrase belongs to one player, and cleaning the lists
  // independently would let a direct PATCH store it in both, after which the
  // colour depends on which list the renderer scans first.
  const pair = cleanUserColorTermPair(body?.colorTermsA, body?.colorTermsB);
  if ("colorTermsA" in (body ?? {}) && (pair.a.length > 0 || allowClear)) out.colorTermsA = pair.a;
  if ("colorTermsB" in (body ?? {}) && (pair.b.length > 0 || allowClear)) out.colorTermsB = pair.b;
  return out;
}

/**
 * A client-supplied scenario goes straight into the model prompt, so it is
 * clamped and stripped rather than trusted.
 *
 * Tags are removed because preset descriptions are stored as HTML and a custom
 * game's description is free text a user typed; neither should reach the prompt
 * as markup. Lengths are capped so a long description cannot crowd out the
 * grounding payload that keeps the explanation correct.
 */
function cleanScenario(value: any, options: { actorNouns?: boolean } = {}): Scenario | undefined {
  if (!value || typeof value !== "object") return undefined;
  const noTags = (v: unknown, n: number) =>
    cleanText(v, n).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  // Option labels are clamped to 40 characters and then PRINTED, so a bare
  // slice cuts mid-word and the stub is repeated four or five times in one
  // rendered paragraph ("Escalate the dispute to the regional arb" — rounds
  // T1 and T2). cutAtWordBoundary (shared with cleanLabels, see its own
  // comment) clamps at the last word boundary instead.
  const label = (v: unknown) => cutAtWordBoundary(noTags(v, 60), LABEL_MAX) || undefined;
  const sc: Scenario = {
    name: noTags(value.name, 80) || undefined,
    row1: label(value.row1),
    row2: label(value.row2),
    col1: label(value.col1),
    col2: label(value.col2),
    description: noTags(value.description, 1200) || undefined,
  };
  // Regenerate is the only caller whose response can legitimately carry actor
  // nouns. Full-report inputs stay on the frozen schema even when a client
  // sends extra fields; opt in only at the regenerate response boundary.
  if (options.actorNouns) Object.assign(sc, cleanScenarioActorNouns(value, sc));
  return Object.values(sc).some(Boolean) ? sc : undefined;
}

function cleanPayoffs(value: any): GamePayoffs | null {
  const keys: (keyof GamePayoffs)[] = ["a11", "a12", "a21", "a22", "b11", "b12", "b21", "b22"];
  const out = {} as GamePayoffs;
  for (const key of keys) {
    const n = Number(value?.[key]);
    if (!Number.isFinite(n)) return null;
    out[key] = Math.max(-100, Math.min(100, Math.round(n * 1000) / 1000));
  }
  return out;
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

// Drop expired buckets so the Map can't grow unbounded under many distinct IPs.
// Cheap: only sweeps once the Map gets large rather than on every request.
function pruneRateBuckets(now: number) {
  if (rateBuckets.size < 1000) return;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}

/**
 * Per-IP throttle for the hosted service.
 *
 * `hosted-only` marks a limit that exists ONLY to protect a SHARED server from
 * one user. On the desktop there is no shared server: the model runs on the
 * user's own machine, a report costs them nothing, and since this build binds
 * 127.0.0.1 there is nobody else on the socket to throttle. Capping generation
 * there is a pure downgrade — unlimited regeneration at no cost is one of the
 * few things the local app has BY CONSTRUCTION that the hosted one cannot
 * offer, and at ~0.75s per local report, 20/min is under half a minute of
 * ordinary use.
 *
 * Limits that protect the USER rather than the server — sign-in attempts,
 * verification and recovery codes, account deletion, admin endpoints — are
 * deliberately NOT marked and stay in force everywhere. They guard the local
 * database against whoever is at the keyboard, which is a real threat model on
 * a desktop and not one on Cloud Run, so the desktop is the last place to
 * relax them.
 */
function rateLimit(
  label: string,
  max: number,
  windowMs: number,
  scope: 'always' | 'hosted-only' = 'always',
): express.RequestHandler {
  const liftedForDesktop = scope === 'hosted-only' && process.env.IS_ELECTRON === 'true';
  return (req, res, next) => {
    if (liftedForDesktop) return next();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `${label}:${ip}`;
    const now = Date.now();
    pruneRateBuckets(now);
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ error: "Too many attempts. Please wait a minute and try again." });
    }
    return next();
  };
}

/**
 * Cloud Run's own documented limit: an HTTP/1 response over 32 MiB fails
 * UNLESS it is sent chunked/streamed rather than as a fixed-length body —
 * "Maximum HTTP/1 response size: 32 MiB per response, if not using
 * Transfer-Encoding: chunked or streaming" (Cloud Run quotas docs). Setting
 * an explicit `Content-Length` tells Node to send a fixed-length body, NOT
 * chunked, so a >=32 MiB DMG download hit exactly this limit: the deployed
 * `/api/download/dmg` returned a bare Google-Frontend `HTTP 500` with an
 * EMPTY body and NONE of this app's own headers (no x-powered-by, no CSP) —
 * i.e. the request never reached our own error handling at all — on every
 * plain GET (no Range) or any Range spanning >=32 MiB of the 137 MB DMG.
 * Verified live (2026-09-02): a request with NO Range header 500s the same
 * way as a malformed one — this is not about Range PARSING, it is the whole
 * full-file download path (RED-DESKTOP-4/003-malformed-range-header-live-
 * 500.md; the finding's own repro used malformed Range headers, which
 * happen to share this exact failure because they too fall through to the
 * >=32 MiB full-file branch — but a well-formed request for the same size
 * fails identically, confirmed by pulling Cloud Run request logs for the
 * `x-cloud-trace-context` of a live repro: "Response size was too large.
 * Please consider reducing response size.").
 *
 * Below the limit, Content-Length is still set (unchanged from before) —
 * small partial-range requests, the common case for a resumable download
 * manager, keep their exact declared size for an accurate progress bar.
 */
// NASH_MAX_SIZED_RESPONSE_BYTES overrides the cap for TESTS ONLY (a
// few-KB fake object then exercises the real production branch without
// this suite moving 32 MiB per run); unset, in production, it is exactly
// Cloud Run's own documented 32 MiB HTTP/1 limit. Reconciled with the
// 2026-09-02 hotfix (PR #89, live incident) onto this branch's own fix —
// same env var name and the same strict `<` boundary, kept as the one
// surviving implementation per the director's call.
const CLOUD_RUN_HTTP1_RESPONSE_LIMIT = (() => {
  const v = parseInt(process.env.NASH_MAX_SIZED_RESPONSE_BYTES || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 32 * 1024 * 1024;
})();
function setContentLengthIfUnderCloudRunLimit(res: express.Response, byteLength: number): void {
  if (byteLength < CLOUD_RUN_HTTP1_RESPONSE_LIMIT) {
    res.setHeader('Content-Length', String(byteLength));
  }
  // >= the limit: leave Content-Length UNSET. Node/Express then sends the
  // piped stream with `Transfer-Encoding: chunked`, which Cloud Run's own
  // limit explicitly exempts.
}

/**
 * Updates in-memory DB immediately; persists to GCS (Cloud Run) or local file
 * (Electron/dev).
 *
 * Returns whether the write is KNOWN to have happened. The two branches are
 * honest about what they can actually promise: the desktop/local-file branch
 * writes SYNCHRONOUSLY, so a caught error here really does mean nothing
 * reached disk, and `false` is returned; the hosted GCS branch is
 * fire-and-forget (an async `.then/.catch`, unchanged), so a caller can never
 * learn its outcome from this return value — `true` here means only "handed
 * off", exactly the same as before this function had a return value at all.
 * (RED-DESKTOP-4/002-unwritable-userdata-fake-save-success.md notes the GCS
 * branch has the identical false-success shape and scopes fixing it as a
 * separate, hosted-side question — not claimed as fixed here.)
 */
function saveDB(db: DB): boolean {
  if (localFileSaveBlocked()) return false;
  inMemoryDb = db;
  if (!process.env.ELECTRON_USER_DATA_PATH && GCS_BUCKET) {
    scheduleGcsSave(); // #85's coalescing pump; the GCS write is async, so the caller's boolean cannot reflect it
    return true;
  } else {
    try {
      const dbDir = path.dirname(DB_FILE);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      writeFileAtomicSync(DB_FILE, JSON.stringify(db, null, 2));
      return true;
    } catch (err) {
      console.error("Error writing db.json:", err);
      return false;
    }
  }
}

/**
 * Serializes the game-save/update/delete routes' entire read-build-save
 * sequence into one queue, so two requests that arrive close together can
 * never both build a candidate off the SAME `inMemoryDb` snapshot and have
 * whichever commits second silently clobber the other's change.
 *
 * ORIGIN (CodeRabbit, 2026-09-02, second review round): an earlier version
 * of `saveDBAwaited` awaited a real per-request GCS write, which is a
 * genuine yield point on Node's single-threaded event loop — a second
 * request's handler could run `loadDB()` while the first was still
 * mid-write. That GCS-await design was replaced (see `saveDBAwaited`'s own
 * comment, reconciled with #85's coalescing pump) with a SYNCHRONOUS
 * hand-off to `scheduleGcsSave()`, which removes that specific yield point
 * — so this queue is no longer load-bearing for GCS mode, and the DESKTOP
 * branch (a synchronous file write) was never at risk either. Left in place
 * anyway as cheap insurance: correct and free given `--max-instances=1`
 * (this same PR, so there is only ever one process to serialize against),
 * and it costs nothing to keep the three game routes fully ordered against
 * each other if a future change ever reintroduces a real await in this
 * path. `.catch(() => {})` on the chain link is load-bearing regardless —
 * without it, one caller's write throwing would leave every LATER caller
 * permanently chained onto a rejected promise.
 */
let gameWriteQueue: Promise<unknown> = Promise.resolve();
function serializeGameWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = gameWriteQueue.then(fn, fn);
  gameWriteQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Persist a CANDIDATE `games` array. Used only by the game-save/update/
 * delete routes (via `saveDBOrFail` below) — every other `saveDB` call site
 * is untouched.
 *
 * THE HONESTY GUARANTEE IS DESKTOP-ONLY, BY DIRECTOR'S CALL (2026-09-02,
 * reconciling this with #85 after a merge): the desktop/local-file branch
 * writes SYNCHRONOUSLY, so a caught error here really does mean nothing
 * reached disk, `false` is returned, and the caller gets an honest 500
 * instead of RED-DESKTOP-4/002's false "success" (an unwritable
 * `ELECTRON_USER_DATA_PATH` echoing a save that then vanishes on restart).
 *
 * The GCS/hosted branch does NOT await a real upload here — it delegates to
 * `scheduleGcsSave()`, #85's per-process COALESCING PUMP (generation
 * preconditions, 412 conflict re-download/merge, one upload in flight at a
 * time). An earlier version of this function ran its OWN raw, unawaited-
 * elsewhere `.save()` call with none of that machinery: no
 * `ifGenerationMatch`, a DIFFERENT upload wire shape than the pump's
 * (`resumable`/`validation` defaults, vs. the pump's explicit
 * `resumable:false, validation:false`) — which silently desynced the local
 * `gcsGeneration` tracker from GCS's real state and broke
 * `src/integration/gcs-db-saves.test.mjs`'s wire-format assumptions
 * (all four rapid saves stopped returning 200). Trying to ALSO get a
 * per-request honest 500/rollback out of GCS would mean either awaiting the
 * pump (defeating its whole coalescing purpose — the pump exists precisely
 * so N rapid saves become one upload, not N) or duplicating its generation/
 * merge logic a second time. Not worth it: the pump's own retry-on-412 and
 * `--max-instances=1` (this same PR) already make hosted data loss the
 * class of defect #85 exists to close; RED-DESKTOP-4/002's own repro was
 * desktop-only (an unwritable directory is a desktop/Electron concept —
 * `ELECTRON_USER_DATA_PATH` has no hosted analogue), so scoping the honest-
 * failure guarantee to desktop is not a regression on what was ever proven.
 *
 * `users` is still read FRESH from `inMemoryDb` right before committing —
 * not carried as a stale snapshot from before this function was called —
 * so a concurrent account-route write (registration, deletion, ...; the
 * ~17 OTHER `saveDB` call sites, still untouched) is never silently undone
 * by a game write that started before it and finishes after.
 */
async function saveDBAwaited(games: SavedGame[]): Promise<boolean> {
  if (!process.env.ELECTRON_USER_DATA_PATH && GCS_BUCKET) {
    inMemoryDb = { users: inMemoryDb?.users ?? [], games };
    scheduleGcsSave(); // #85's coalescing pump — see this function's own comment for why this branch cannot also await a per-request result
    return true;
  }
  if (localFileSaveBlocked()) return false;
  try {
    const dbDir = path.dirname(DB_FILE);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const payload: DB = { users: inMemoryDb?.users ?? [], games };
    writeFileAtomicSync(DB_FILE, JSON.stringify(payload, null, 2));
    inMemoryDb = { users: inMemoryDb?.users ?? [], games };
    return true;
  } catch (err) {
    console.error("Error writing db.json:", err);
    return false;
  }
}

/**
 * `saveDBAwaited`, but a caller that is about to respond to an HTTP request
 * can use this to turn a real DESKTOP write failure into an honest 500
 * instead of the false "success" RED-DESKTOP-4/002 found — see
 * `saveDBAwaited`'s own comment for why the GCS/hosted branch cannot make
 * the same promise (it delegates to #85's coalescing pump, which is
 * deliberately not awaited per-request) and instead always reports success
 * once handed off, exactly like every other `saveDB` call site.
 */
async function saveDBOrFail(games: SavedGame[], res: express.Response): Promise<boolean> {
  if (await saveDBAwaited(games)) return true;
  res.status(500).json({ error: "Could not save your changes. Please try again." });
  return false;
}

// Helper to get NodeMailer transporter
function getTransporter() {
  const host = process.env.SMTP_HOST ?? "";
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER ?? "";
  const pass = process.env.SMTP_PASS ?? "";

  if (host && user && pass) {
    const isGmail = host.toLowerCase().includes("gmail") || user.toLowerCase().includes("gmail");

    if (isGmail) {
      console.log(`Configuring specialized Gmail SMTP transporter for ${user}`);
      return nodemailer.createTransport({
        service: "gmail",
        auth: {
          user,
          pass,
        },
      });
    }

    console.log(`Configuring custom SMTP transporter via ${host}:${port} for ${user}`);
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass,
      },
      // Validate the SMTP server's TLS certificate by default. Disabling it
      // exposes SMTP credentials and mail contents to MITM, so only opt out via
      // an explicit dev-only flag (e.g. a self-signed local relay).
      ...(process.env.SMTP_ALLOW_INSECURE_TLS === "true"
        ? { tls: { rejectUnauthorized: false } }
        : {}),
    });
  }
  return null;
}

// Send real email verification
async function sendVerificationEmail(email: string, code: string, username: string): Promise<{ success: boolean; via: string; messageId?: string; previewUrl?: string | null; smtpError?: string | null; }> {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || `"Nash Equilibrium Simulator" <noreply@example.com>`;

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; display: inline-block; margin-bottom: 8px;">🧭</span>
        <h2 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 800; tracking-tight: -0.025em;">Nash Equilibrium Simulator</h2>
      </div>
      <p style="color: #334155; font-size: 15px; line-height: 1.6; margin-bottom: 16px;">Hello <strong>@${escapeHtml(username)}</strong>,</p>
      <p style="color: #475569; font-size: 14.5px; line-height: 1.6; margin-bottom: 24px;">To complete your setup, please enter this code into the Nash Equilibrium Simulator verification modal:</p>
      
      <div style="text-align: center; margin: 28px 0;">
        <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 34px; font-weight: 800; letter-spacing: 5px; color: #2563eb; background: #f0f7ff; padding: 14px 28px; border: 2px solid #bfdbfe; border-radius: 14px; display: inline-block;">
          ${code}
        </span>
      </div>

      <p style="color: #64748b; font-size: 12.5px; line-height: 1.6; margin-top: 28px; border-top: 1px solid #f1f5f9; padding-top: 18px; text-align: center;">
        This confirmation code expires in 10 minutes. If you did not create an account, you can safely ignore this email.
      </p>
    </div>
  `;

  if (!transporter) {
    throw new Error("SMTP configuration is incomplete/missing in .env. Please define SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.");
  }

  try {
    const info = await transporter.sendMail({
      from,
      to: email,
      subject: `Your Nash Sim Verification Code: ${code}`,
      text: `Your Nash Sim verification code is: ${code}. It expires in 10 minutes.`,
      html: htmlContent,
    });
    console.log("Verification email sent successfully using custom SMTP:", info.messageId);
    return { success: true, via: "smtp", messageId: info.messageId };
  } catch (err: any) {
    console.error("Failed to send email via custom SMTP, error details:", err);
    throw new Error(`SMTP Mail delivery failed: ${err.message}`);
  }
}

async function sendDeleteEmail(email: string, code: string, username: string): Promise<{ success: boolean; via: string; messageId?: string; }> {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || `"Nash Equilibrium Simulator" <noreply@example.com>`;

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; border: 1px solid #fecaca; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(220, 38, 38, 0.03); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; display: inline-block; margin-bottom: 8px;">⚠️</span>
        <h2 style="margin: 0; color: #991b1b; font-size: 20px; font-weight: 800; tracking-tight: -0.025em;">Confirm Account Deletion</h2>
      </div>
      <p style="color: #334155; font-size: 15px; line-height: 1.6; margin-bottom: 16px;">Hello <strong>@${escapeHtml(username)}</strong>,</p>
      <p style="color: #475569; font-size: 14.5px; line-height: 1.6; margin-bottom: 24px;">We received a request to permanently delete your Nash Equilibrium Simulator account. This action cannot be undone. To proceed, please enter this security confirmation code into the simulator's deletion screen:</p>
      
      <div style="text-align: center; margin: 28px 0;">
        <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 32px; font-weight: 800; letter-spacing: 5px; color: #dc2626; background: #fef2f2; padding: 14px 28px; border: 2px solid #fca5a5; border-radius: 14px; display: inline-block;">
          ${code}
        </span>
      </div>

      <p style="color: #64748b; font-size: 12.5px; line-height: 1.6; margin-top: 28px; border-top: 1px solid #f1f5f9; padding-top: 18px; text-align: center;">
        If you did not request to delete your account, please ignore this message and consider changing your password. This deletion confirmation code expires in 10 minutes.
      </p>
    </div>
  `;

  if (!transporter) {
    throw new Error("SMTP configuration is incomplete/missing in .env.");
  }

  try {
    const info = await transporter.sendMail({
      from,
      to: email,
      subject: `Confirm Account Deletion Request: ${code}`,
      text: `Your account deletion security code is: ${code}. It expires in 10 minutes.`,
      html: htmlContent,
    });
    console.log("Account Deletion confirmation email sent successfully:", info.messageId);
    return { success: true, via: "smtp", messageId: info.messageId };
  } catch (err: any) {
    console.error("Failed to send deletion confirmation email, error details:", err);
    throw new Error(`SMTP Mail delivery failed: ${err.message}`);
  }
}

async function sendRecoveryEmail(email: string, code: string): Promise<{ success: boolean; via: string; messageId?: string; }> {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || `"Nash Equilibrium Simulator" <noreply@example.com>`;

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; border: 1px solid #fed7aa; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(234, 88, 12, 0.04); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; display: inline-block; margin-bottom: 8px;">🔑</span>
        <h2 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 800;">Password Recovery</h2>
        <p style="color: #64748b; font-size: 13px; margin-top: 6px;">Nash Equilibrium Simulator</p>
      </div>
      <p style="color: #475569; font-size: 14.5px; line-height: 1.6; margin-bottom: 24px;">We received a request to reset the password for this account. Enter the code below in the simulator to set a new password:</p>

      <div style="text-align: center; margin: 28px 0;">
        <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 34px; font-weight: 800; letter-spacing: 5px; color: #ea580c; background: #fff7ed; padding: 14px 28px; border: 2px solid #fed7aa; border-radius: 14px; display: inline-block;">
          ${code}
        </span>
      </div>

      <p style="color: #64748b; font-size: 12.5px; line-height: 1.6; margin-top: 28px; border-top: 1px solid #f1f5f9; padding-top: 18px; text-align: center;">
        This recovery code expires in 10 minutes. If you did not request a password reset, you can safely ignore this email — your password will not change.
      </p>
    </div>
  `;

  if (!transporter) {
    throw new Error("SMTP configuration is incomplete/missing in .env. Please define SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.");
  }

  try {
    const info = await transporter.sendMail({
      from,
      to: email,
      subject: `Your Nash Sim Password Recovery Code: ${code}`,
      text: `Your Nash Sim password recovery code is: ${code}. It expires in 10 minutes.`,
      html: htmlContent,
    });
    console.log("Password recovery email sent successfully:", info.messageId);
    return { success: true, via: "smtp", messageId: info.messageId };
  } catch (err: any) {
    console.error("Failed to send recovery email:", err);
    throw new Error(`SMTP Mail delivery failed: ${err.message}`);
  }
}

// Destination inbox for all user feedback submissions
const FEEDBACK_INBOX = process.env.FEEDBACK_INBOX || "daluan217@gmail.com";

async function sendFeedbackEmail(
  message: string,
  rating: number | null,
  fromEmail: string | null
): Promise<{ success: boolean; via: string; messageId?: string; }> {
  const transporter = getTransporter();
  // Always send from the project's own mailbox so anonymous submissions stay anonymous.
  const from = process.env.SMTP_FROM || `"Nash Equilibrium Simulator" <noreply@example.com>`;

  if (!transporter) {
    throw new Error("SMTP configuration is incomplete/missing in .env.");
  }

  const stars = rating && rating > 0
    ? "★".repeat(rating) + "☆".repeat(5 - rating) + ` (${rating}/5)`
    : "Not provided";
  const senderLabel = fromEmail ? fromEmail : "Anonymous";
  const safeMessage = (message || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; display: inline-block; margin-bottom: 8px;">💬</span>
        <h2 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 800;">New User Feedback</h2>
        <p style="color: #64748b; font-size: 13px; margin-top: 6px;">Nash Equilibrium Simulator</p>
      </div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <tr>
          <td style="color: #64748b; font-size: 13px; font-weight: 700; padding: 6px 0; width: 90px;">Rating</td>
          <td style="color: #ea580c; font-size: 15px; padding: 6px 0;">${stars}</td>
        </tr>
        <tr>
          <td style="color: #64748b; font-size: 13px; font-weight: 700; padding: 6px 0;">From</td>
          <td style="color: #334155; font-size: 14px; padding: 6px 0;">${escapeHtml(senderLabel)}</td>
        </tr>
      </table>
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; color: #334155; font-size: 14.5px; line-height: 1.6; white-space: pre-wrap;">${safeMessage}</div>
      <p style="color: #94a3b8; font-size: 11.5px; line-height: 1.6; margin-top: 24px; border-top: 1px solid #f1f5f9; padding-top: 16px; text-align: center;">
        Submitted on ${new Date().toUTCString()}${fromEmail ? " — reply directly to this email to respond." : " — this submission was sent anonymously."}
      </p>
    </div>
  `;

  const textContent =
    `New feedback for Nash Equilibrium Simulator\n\n` +
    `Rating: ${stars}\nFrom: ${senderLabel}\n\n${message}`;

  try {
    const info = await transporter.sendMail({
      from,
      to: FEEDBACK_INBOX,
      ...(fromEmail ? { replyTo: fromEmail } : {}),
      subject: `New Feedback${rating ? ` (${rating}★)` : ""} — Nash Equilibrium Simulator`,
      text: textContent,
      html: htmlContent,
    });
    console.log("Feedback email sent successfully:", info.messageId);
    return { success: true, via: "smtp", messageId: info.messageId };
  } catch (err: any) {
    console.error("Failed to send feedback email:", err);
    throw new Error(`SMTP Mail delivery failed: ${err.message}`);
  }
}

async function startServer() {
  // First thing, before anything else touches the filesystem or binds a
  // port: refuse to run as a second writer against a data directory another
  // live process already owns. See acquireDesktopLock's own comment. A
  // `false` return means the failure has already been reported (a
  // standalone run's process.exit(1), or the packaged app's dialog hook) —
  // either way this function must stop here: no initDB, no listen.
  if (!acquireDesktopLock()) return;
  // RED-DESKTOP-7/001: clean up any db.json.tmp-* scratch file an earlier,
  // interrupted writeFileAtomicSync could not remove itself. Safe exactly
  // here — the lock above already guarantees no other process can be
  // writing this directory right now, and this runs before this process's
  // own first save.
  //
  // The age threshold is overridable ONLY for tests (CodeRabbit, this PR):
  // a "young, not-yet-stale" fixture is written just before this process is
  // spawned, and on a slow/loaded machine the gap between that write and
  // THIS line running could plausibly approach the 5s production default,
  // making the test flaky through no fault of the sweep itself. The
  // production default (5000ms) is unchanged when the var is unset.
  const sweepMaxAgeMs = Number(process.env.NASH_TMP_SWEEP_MAX_AGE_MS);
  sweepStaleAtomicTmpFiles(DB_FILE, Number.isFinite(sweepMaxAgeMs) && sweepMaxAgeMs > 0 ? sweepMaxAgeMs : undefined);

  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);

  // Trust the proxy in front of us (e.g. Cloud Run) so req.ip reflects the real
  // client for rate limiting. Configurable because trusting X-Forwarded-For when
  // NOT behind a trusted proxy would let clients spoof their IP. Set TRUST_PROXY
  // to a hop count (e.g. "1"), "true", or a subnet; defaults to off for local.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    app.set("trust proxy", /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10)
      : trustProxy === "true" ? true
      : trustProxy);
  }

  // Parse JSON bodies
  app.use(express.json());

  // Baseline security headers. A full content CSP is intentionally omitted here
  // because the app loads Google Analytics + inline scripts and Plotly may use
  // eval/blob workers — tightening script/style/connect needs browser testing.
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    next();
  });

  // CORS for cross-origin API access (e.g. from the local Electron client to the
  // website backend). Set CORS_ALLOWED_ORIGINS (comma-separated) to restrict to
  // known origins; if unset we fall back to "*" for backward compatibility.
  const corsAllowlist = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",").map(o => o.trim()).filter(Boolean);
  // The desktop (Electron) client runs on http://127.0.0.1:<port> and calls the
  // hosted backend cross-origin — treat localhost as a trusted first-party origin.
  const isLocalClientOrigin = (origin: string) =>
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (req.path.startsWith("/api/admin/")) {
      // Admin returns user PII and is gated by x-admin-secret. Don't expose it to
      // arbitrary internet origins via "*"; allow cross-origin calls only from the
      // first-party local (Electron) client or explicitly allowlisted origins.
      if (origin && (isLocalClientOrigin(origin) || corsAllowlist.includes(origin))) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "x-admin-secret");
      }
    } else {
      if (corsAllowlist.length === 0) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      } else if (origin && corsAllowlist.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      // PATCH is how the client updates a saved game in place (scenario keep,
      // rename); leaving it out of the preflight answer breaks those calls for
      // every cross-origin client (the Electron app) while the same-origin
      // website works — the failure reads as "couldn't reach the server".
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-secret");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // ── Admin Stats API ────────────────────────────────────────────────────────
  app.get("/api/admin/stats", rateLimit("admin", 10, 60_000), (req, res) => {
    const secret = req.headers["x-admin-secret"] as string;
    // Fail closed: reject when ADMIN_SECRET is unconfigured or the header is
    // missing — otherwise an unset env makes `undefined !== undefined` false and
    // the check passes, exposing all-user PII to an unauthenticated caller.
    if (!process.env.ADMIN_SECRET || !secret || !safeEqual(secret, process.env.ADMIN_SECRET)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const db = loadDB();
    const now = Date.now();
    const day = 86400000;
    const signupsToday = db.users.filter(u => {
      // Use verificationCodeExpires as a rough creation timestamp proxy
      // (set to now + 10min on register, so creation ≈ expires - 10min)
      const created = u.verificationCodeExpires - 10 * 60 * 1000;
      return created > now - day;
    }).length;
    const signupsThisWeek = db.users.filter(u => {
      const created = u.verificationCodeExpires - 10 * 60 * 1000;
      return created > now - 7 * day;
    }).length;
    res.json({
      totalUsers: db.users.length,
      verifiedUsers: db.users.filter(u => u.isVerified).length,
      unverifiedUsers: db.users.filter(u => !u.isVerified).length,
      totalGames: db.games.length,
      signupsToday,
      signupsThisWeek,
      users: db.users.map(u => ({
        username: u.username,
        email: u.email,
        isVerified: u.isVerified,
        gamesCount: db.games.filter(g => g.userId === u.id).length,
      })),
    });
  });

  // ── Authentication API ─────────────────────────────────────────────────────

  // Express API health check
  app.get("/api/health", (req, res) => {
    // pid lets a test's boot() confirm it is talking to the child it spawned,
    // not a stray process another agent left listening on the same port.
    // `capabilities` is how the CLIENT decides whether to show a
    // flag-gated action at all — no auth, no DB read, no rate limit, read at
    // request time (same style as the flag itself) so a flag flip is visible
    // on the very next probe. `scenarioRegen` additionally requires
    // `canInvent()`: showing the button when the process could never invent
    // anything (no credentials, no bank) would only ever produce the
    // 200-with-null-scenario `no-key` response.
    res.json({ status: "ok", pid: process.pid, capabilities: { scenarioRegen: scenarioRegenEnabled() && canInvent() } });
  });

  // Latest desktop app version — written to GCS by the release CI alongside the DMG.
  // The installed Electron app polls this to decide whether to prompt for an update.
  app.get("/api/version", rateLimit("version", 60, 60_000, 'hosted-only'), asyncHandler(async (req, res) => {
    try {
      if (!process.env.ELECTRON_USER_DATA_PATH && GCS_BUCKET) {
        const { Storage } = await import('@google-cloud/storage');
        const file = new Storage().bucket(GCS_BUCKET).file('app-version.json');
        const [exists] = await file.exists();
        if (exists) {
          const [content] = await file.download();
          res.setHeader('Cache-Control', 'no-store');
          return res.type('application/json').send(content.toString('utf-8'));
        }
      }
      return res.json({ version: null });
    } catch (error: any) {
      console.error("Error reading app version:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }));

  // ── Report API ─────────────────────────────────────────────────────────────
  // Grounded LLM analysis with deterministic fallback. The client renders model
  // prose only when validation passes; a refusal, truncation, or hallucination
  // degrades to the existing deterministic panel rather than showing something
  // wrong. That makes the fallback path exercised in normal operation.
  app.post("/api/report", rateLimit("report", 20, 60_000, 'hosted-only'), asyncHandler(async (req, res) => {
    const payoffs = cleanPayoffs(req.body?.payoffs);
    const scenario = cleanScenario(req.body?.scenario);
    if (!payoffs) {
      return res.status(400).json({ error: "Invalid payoff matrix." });
    }

    // NASH_PAYOFF_TEMPLATE=1 — PROTOTYPE, default OFF. Rung 3 of the constraint
    // ladder: render the mathematical sentences of ORDINARY games from the
    // solver, exactly as tie games already are, and let the model supply only
    // the scenario. Built so the tradeoff can be MEASURED rather than argued:
    // across twelve adversarial rounds the templated surface produced one
    // defect ever while free prose plateaued at 2-4%. Adopting this is a
    // product decision — it trades some of the model's voice for that
    // guarantee — so it stays behind a flag until that decision is made.
    if (process.env.NASH_PAYOFF_TEMPLATE === '1') {
      const p2 = payoffs;
      const isTie = p2.a11 === p2.a21 || p2.a12 === p2.a22 || p2.b11 === p2.b12 || p2.b21 === p2.b22;
      if (!isTie && req.body?.scenarioOnly !== true) {
        let invented: SuggestedScenario | null = null;
        // `scenarioIsUsable`, NOT the truthiness of `scenario`.
        //
        // `cleanScenario` returns an OBJECT when ANY of name/row1/row2/col1/
        // col2/description is non-empty, so `!scenario` treated a game with
        // nothing but a NAME as "the user already has a scenario". Every other
        // site in the codebase asks `scenarioIsUsable` — all four labels, or a
        // description of >=12 words — including `scenarioBlock`, the
        // `scenarioOnly` path, and the client's own post-save regen guard.
        // So a scenario that was "supplied" here was "unusable" everywhere
        // else, and rung 3 then neither used it nor replaced it.
        //
        // REACHED IN FOUR CLICKS ON THE DEFAULT SAVE PATH: the save dialog
        // requires only a name, and the server itself manufactures a
        // description ("Custom payoff matrix saved by <username>") below. So a
        // user who saves a game with just a name got generic Row/Col prose and
        // no story on every explain, forever — while the same request at rung 0
        // reaches scenarioBlock's "Nothing usable: let the model invent one"
        // and gets a story. The fix must therefore test USABILITY, not
        // presence.
        const supplied = scenarioIsUsable(scenario);
        // RED-CLOUD-6/002: undefined unless the model ladder was fully
        // exhausted and `inventScreenedScenario`'s own last-resort bank draw
        // is what actually supplied `invented` — see that function's comment.
        let inventedSource: 'bank-fallback' | undefined;
        if (!supplied && canInvent()) {
          try {
            // Screened AND rerolled, exactly like the other two paths. Under
            // rung 3 the scenario must also be CLAIM-FREE: the solver states
            // the mathematics, so a description that asserts anything decidable
            // is both unnecessary and the only remaining defect surface (T1
            // measured it at 11.4%).
            const drawn2 = await inventScreenedScenario(
              payoffs,
              (reason) => console.warn(`[report] rung-3 scenario dropped: ${reason}`),
            );
            invented = drawn2.scenario;
            inventedSource = drawn2.scenarioSource;
          } catch { invented = null; }
        }
        // Labels follow USABILITY too. A name-only scenario is truthy, so
        // `scenario ?? invented` kept selecting it and rendered the prose in
        // Row/Col even once a fully-labelled story had been invented beside it.
        const labels2 = supplied ? scenario : (invented ?? scenario);
        const truth2 = computeAllNE(payoffs);
        // ONE pass, used twice. The comment below says the claims are "derived
        // in the SAME pass as the prose so the two cannot drift" — and the code
        // called tieProseFull twice, so that was true only because the function
        // happens to be pure. Bind it and the comment is a guarantee instead of
        // a coincidence.
        const rendered2 = tieProseFull(payoffs, labels2 ?? null);
        return res.json({
          source: 'template',
          report: {
            claimedEquilibria: truth2.map((n) => ({ type: n.type, x: n.x, y: n.y })),
            prose: rendered2.prose,
            // The renderer declares what it asserts, derived in the SAME pass as
            // the prose so the two cannot drift. Was `null`, which made the
            // DETERMINISTIC surface less verifiable than the model's.
            proseClaims: rendered2.claims,
            suggestedScenario: supplied ? undefined : invented ?? undefined,
            // Undefined on every ordinary model-drawn or user-supplied
            // scenario; 'bank-fallback' only on the residual reroll-ladder
            // exhaustion RED-CLOUD-6/002 measured (~1.6% of invention draws).
            scenarioSource: supplied ? undefined : inventedSource,
          },
          groundTruth: truth2,
          validation: null,
        });
      }
    }

    // Tie-game policy, set by NASH_LLM_TIES:
    //   '0'        — withhold LLM prose entirely (the deterministic panel
    //                explains ties and continua exactly). Both models
    //                concentrate their residual errors here (rounds L1/L2/C1,
    //                and L4: 7 of 17 tie prose surfaces wrong).
    //   'template' — render the mathematical sentences from the solver and let
    //                the model supply only the scenario.
    // Anything else sends tie games to the model like any other game.
    const tiePolicy = process.env.NASH_LLM_TIES;
    if (tiePolicy === '0' || tiePolicy === 'template') {
      const p = payoffs;
      const tie = p.a11 === p.a21 || p.a12 === p.a22 || p.b11 === p.b12 || p.b21 === p.b22;
      if (tie) {
        // NASH_LLM_TIES=template: the model's DECLARATIONS on tie games are
        // reliably exact (round L4: every declared claim true) while its free
        // prose is not (7 of 17 tie prose surfaces wrong). So the mathematical
        // sentences are rendered from the solver and the model is asked only
        // for a scenario — the work it does well (L4 stories: 46/46 correct).
        if (tiePolicy === 'template') {
          // A supplied scenario is the user's own game description: the
          // non-tie path never replaces it, and neither may this one. Only
          // invent when nothing was supplied. (Round C14 draw 60: a `let
          // scenario` here shadowed the request's scenario, so a user who
          // supplied "Night Shift / Day Shift" was shown a mathematically
          // perfect paragraph about options that were not in their game.)
          let invented: SuggestedScenario | null = null;
          let inventFailure: string | undefined;
          // RED-CLOUD-6/002: see the non-tie branch's own comment.
          let inventedSourceTie: 'bank-fallback' | undefined;
          // Usability, not presence — the same predicate the non-tie branch and
          // every other site now use.
          const suppliedTie = scenarioIsUsable(scenario);
          if (!suppliedTie && canInvent()) {
            try {
              // Screened AND rerolled through the shared draw. The screening
              // half of this was unified in #56 and its comment (kept below)
              // already claimed parity; the RETRY half was not, and this was
              // the branch left without one. Same button, same user, same
              // model: 1.30% of tie-game presses of "New AI scenario" returned
              // no story against 0.00% of non-tie presses, z=6.3 at n=3000 per
              // cell — decided entirely by whether the matrix happens to
              // contain a payoff tie, which the user never sees.
              //
              // The screen itself: the declarations gate, the CLAIM-FREE
              // screen, AND the label-aware direction/dependence checks over
              // the free description. C15 draw 56's story denied a payoff tie
              // that the template paragraph beside it stated aloud.
              //
              // The claim-free screen was MISSING here until 2026-08-29, while
              // this comment already claimed parity. Every claim-free rule —
              // the payoff rules, "in response", "before B chooses" — silently
              // did not apply to tie games, which are 12.7% of a random sample.
              // Found by adversarial round #2: "The shop owner chooses between
              // Open Records and Restrict Records when responding to the
              // review" shipped on a tie game (b11 = b12 = -1) even though the
              // screen drops that exact description.
              const drawn = await inventScreenedScenario(
                payoffs,
                (reason) => console.warn(`[report] tie-path scenario dropped: ${reason}`),
              );
              invented = drawn.scenario;
              inventFailure = drawn.failure;
              inventedSourceTie = drawn.scenarioSource;
            } catch { invented = null; }
          }
          // Labels for the rendered sentences: the user's own scenario when it
          // is USABLE, an invented one otherwise.
          const labels = suppliedTie ? scenario : (invented ?? scenario);
          if (req.body?.scenarioOnly === true) {
            // The reason must name what actually happened. This reported
            // 'validation-failed' for a provider error, an unparseable draw,
            // and for NO CREDENTIALS AT ALL — the non-tie path on the same
            // server correctly says 'no-key' for the last of those. Not
            // user-visible today, because the client prints one fixed string
            // whatever it receives, but it is the envelope's contract and an
            // eval reading it would be misled.
            return res.json(invented
              ? { scenario: invented, scenarioSource: inventedSourceTie }
              : {
                  scenario: null,
                  failure: suppliedTie ? 'scenario-supplied'
                    : !canInvent() ? 'no-key'
                    : (inventFailure ?? 'validation-failed'),
                });
          }
          const truth = computeAllNE(payoffs);
          // One pass, used twice — see the note on the non-tie branch.
          const rendered = tieProseFull(payoffs, labels ?? null);
          return res.json({
            source: 'template',
            report: {
              claimedEquilibria: truth.map((n) => ({ type: n.type, x: n.x, y: n.y })),
              prose: rendered.prose,
              proseClaims: rendered.claims,
              // Never offer a replacement the user did not ask for.
              suggestedScenario: suppliedTie ? undefined : invented ?? undefined,
              scenarioSource: suppliedTie ? undefined : inventedSourceTie,
            },
            groundTruth: truth,
            validation: null,
          });
        }
        if (req.body?.scenarioOnly === true) return res.json({ scenario: null, failure: 'tie-game' });
        return res.json({
          source: 'deterministic',
          report: null,
          groundTruth: computeAllNE(payoffs),
          validation: null,
          fallbackReason: 'tie-game',
        });
      }
    }

    // The slim path behind "New AI scenario": the explanation on screen is
    // already validated, so only a fresh STORY is wanted — ~300 output
    // tokens instead of ~650, roughly halving that button's latency and its
    // retry. Same story-claims gate, one retry, suggestion withheld on a
    // double failure. Never cached: freshness is the request.
    if (req.body?.scenarioOnly === true) {
      if (!canInvent()) {
        return res.json({ scenario: null, failure: "no-key" });
      }
      // The tie path already refuses to replace a scenario the user supplied;
      // the ordinary path did not, so scenarioOnly handed back a substitute
      // (round T2). Never offer a replacement the user did not ask for.
      if (scenarioIsUsable(scenario)) {
        return res.json({ scenario: null, failure: "scenario-supplied" });
      }
      // ONE shared draw with the other two paths. The screening half of this
      // was unified in #56 and the comment below records why; the RETRY and the
      // NASH_SCENARIO_CHECKS opt-out were left behind, and the reroll that used
      // to live here inline is now the shared instrument every branch uses.
      //
      // The original note, still the reason the shared screen exists:
      // The claim-free screen belongs here too, and its absence was the single
      // biggest hole in the scenario surface. The rung-3 report path and the
      // tie path both called it; this path did not, so it dropped the digit
      // rule and all six CLAIMY rules — and then retried, meaning the LOOSEST
      // gate was the one that got two draws while the strictest got one.
      // What made it user-visible is that the split is on the MATRIX, not on
      // the button. Ties are 12.7% of a random sample, so roughly 87% of clicks
      // on that button took the weaker path — same button, same user, same
      // model, different screening because of something about the matrix the
      // user never sees.
      // Measured before changing it: 4 of 4 known positives the report path
      // rejects sailed through here, including a real "Col1 or Col2" draw that
      // was rejected in the wild on the other path. Cost of parity across 890
      // stored draws: 2 newly withheld, 0.23%.
      //
      // The reroll's own measurement, unchanged: a draw that never came back at
      // all (`max-tokens`) used to get no second chance, at 7.5% of calls once
      // the stakes hint lengthened the prompt (9 of 120 vs 0 of 120 without it,
      // p=0.0033). Roughly one click in thirteen.
      const { scenario: invented, failure, scenarioSource } = await inventScreenedScenario(
        payoffs,
        (reason) => console.warn(`[report] scenarioOnly scenario dropped: ${reason}`),
      );
      return res.json({ scenario: invented, failure: invented ? null : (failure ?? "error"), scenarioSource });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EVERYTHING BELOW THIS LINE IS UNREACHABLE IN PRODUCTION. Read this before
    // trusting anything in it.
    //
    // Production sets NASH_PAYOFF_TEMPLATE=1 and NASH_LLM_TIES=template
    // (cloudbuild.yaml for the site, electron-main.cjs for the desktop), and
    // those two flags PARTITION the input space: every request returns from the
    // rung-3 branch, the tie branch, or the scenarioOnly branch above. PROVEN
    // ON THE WIRE by RED-PIPELINE rather than by reading — seven requests
    // covering every shape (plain, bypassCache, an identical repeat, tie,
    // scenarioOnly on tie and non-tie, and a fully usable supplied scenario)
    // produced six provider calls, and all six were the SCENARIO call. Zero
    // report calls.
    //
    // FOUR GUARANTEES ARE THEREFORE BELIEVED AND NOT HELD:
    //   * `generateReport`, `validateReport`, `validateProseClaims`, the
    //     rank-and-replace retry, `orphanedLabels` and `proseClaimsFailed` are
    //     all unreachable.
    //   * `source: 'llm'` and `source: 'deterministic'` are unreachable, so
    //     EVERY `fallbackReason` is unreachable — including 'no-key'. On an
    //     unkeyed deploy the client is never told there is no model; it just
    //     gets a template report with no story.
    //   * App.tsx's `source === 'llm' && validation?.ok === true` clause, and
    //     with it the client's whole untrusted-envelope rendering, is dead.
    //   * THE REPORT CACHE NEVER SERVES. `reportCache` is written only under
    //     `source === 'llm'`, so it is never populated, and the note below
    //     about serving an identical request "instantly" describes behaviour
    //     that no longer happens. Harmless in practice — the presets supply
    //     their own scenario and cost zero calls anyway.
    //
    // NOT DELETED ON PURPOSE: rung 2 (model states the payoffs, solver still
    // states the equilibria) is on the roadmap and will need all of it.
    // Labelled instead, because the cost of this code is not that it runs — it
    // is that four guarantees look live to anyone reading the file.
    // ─────────────────────────────────────────────────────────────────────────

    // Cache: serve a previously validated envelope for the identical
    // (matrix, scenario) instantly. bypassCache comes from an explicit
    // Regenerate click, which must roll fresh (and then overwrites the entry).
    const cacheKey = reportCacheKey(payoffs, scenario);
    if (req.body?.bypassCache !== true) {
      const hit = reportCache.get(cacheKey);
      if (hit) return res.json(hit);
    }

    const groundTruth = computeAllNE(payoffs);

    // No key for the configured model's provider: local Electron mode, or an
    // unkeyed deploy. Not an error — fall through to the deterministic report.
    if (!hasCredentials(DEFAULT_MODEL)) {
      const envelope: ReportEnvelope = {
        source: "deterministic",
        report: null,
        validation: null,
        groundTruth,
        fallbackReason: "no-key",
      };
      return res.json(envelope);
    }

    // Model is server-controlled on purpose — a client-supplied model would let
    // anyone bill the expensive one. The eval sweep calls generateReport
    // directly, so it varies the model without this route needing to accept it.
    let { report, failure } = await generateReport(payoffs, { model: DEFAULT_MODEL, scenario, reasoning: REPORT_REASONING, systemPrompt: LOCAL_PROMPT });

    // The prompt already forbids inventing a story for a game that has one,
    // but that is an instruction, not a guarantee — models drift. Enforce it:
    // when a usable scenario was supplied, drop any suggestion so the client
    // is never offered a replacement it didn't ask for. A user who WANTS a
    // fresh invention asks for one by omitting the scenario from the request.
    if (report?.suggestedScenario && scenarioIsUsable(scenario)) {
      report.suggestedScenario = null;
    }

    // Declared-claims gates — the scenario's story (storyClaims) and the
    // prose's action statements (proseClaims), each checked as lookups the
    // way geometryClaims are. ONE retry covers both (never more than two
    // model calls per request); the second report replaces the first only
    // when it scores strictly better. Final consequences differ by artifact:
    // a bad story costs the suggestion (it would otherwise be prefilled into
    // the save form and persisted), bad prose actions cost the prose itself —
    // demoted to the deterministic panel below, exactly like a hallucinated
    // equilibrium, because "right numbers, wrong words" is still wrong.
    // Per-gate opt-outs mirror NASH_PROSE_CHECKS so each gate's effect is
    // measurable in isolation. The eval sweep calls generateReport directly
    // and never crosses either gate.
    // RED-MATH-8/002: was `computeIndifference(payoffs).any` (full
    // indifference only), while report.ts's grounding payload and
    // nashValidator.ts's validateReport both already switched to
    // `hasEquilibriumContinuum` for this exact question (RED-MATH-7/001,
    // #101). All three now agree — see the note on `validateReport`'s own
    // `degenerate` in nashValidator.ts for why a mismatch here is a
    // structural gate bug, not a model-quality signal.
    const degenerate = hasEquilibriumContinuum(payoffs);
    const scenarioGateOn = process.env.NASH_SCENARIO_CHECKS !== '0';
    const proseGateOn = process.env.NASH_PROSE_ACTION_CHECKS !== '0';
    // Label-aware direction check (opt-in, NASH_DIRECTION_CHECKS=1): reads
    // the sentences themselves — "X is better / prefers X … against Y" — in
    // the game's option words and verifies direction and strictness. Closes
    // the "true declaration, wrong words" gap the declared-claims gates
    // cannot see (observed on both the cloud and the local model).
    const directionOn = process.env.NASH_DIRECTION_CHECKS === '1';
    const assess = (r: NonNullable<typeof report>) => {
      const scenarioOk = !scenarioGateOn || !r.suggestedScenario
        || (validateScenario(r.suggestedScenario, payoffs).ok
          && (!directionOn || validateProseDirections(r.suggestedScenario.description ?? '', r.suggestedScenario, payoffs).length === 0));
      // Run even when proseClaims is null: the undeclared-comparison screen
      // is exactly for prose that makes claims while declaring nothing.
      const proseLabels = scenarioIsUsable(scenario) ? scenario : r.suggestedScenario;
      const proseOk = !proseGateOn
        || (validateProseClaims(r.proseClaims ?? null, r.prose ?? '', payoffs, groundTruth, degenerate, directionOn ? proseLabels ?? null : undefined).ok
          && (!directionOn || validateProseDirections(r.prose ?? '', proseLabels ?? null, payoffs).length === 0));
      // Prose outranks the optional story when choosing between candidates.
      return { scenarioOk, proseOk, rank: (proseOk ? 2 : 0) + (scenarioOk ? 1 : 0) };
    };
    let proseClaimsFailed = false;
    let orphanedLabels = false;
    if (report) {
      let gates = assess(report);
      if (gates.rank < 3) {
        console.warn(`[report] declared-claims gate failed (scenarioOk=${gates.scenarioOk}, proseOk=${gates.proseOk}) — retrying once`);
        const second = await generateReport(payoffs, { model: DEFAULT_MODEL, scenario, reasoning: REPORT_REASONING, systemPrompt: LOCAL_PROMPT });
        if (second.report) {
          // Same enforcement as the first attempt: never offer a replacement
          // scenario the user didn't ask for.
          if (second.report.suggestedScenario && scenarioIsUsable(scenario)) {
            second.report.suggestedScenario = null;
          }
          const g2 = assess(second.report);
          if (g2.rank > gates.rank) {
            ({ report, failure } = second);
            gates = g2;
          }
        }
        if (report && !gates.scenarioOk) {
          // The story is dropped, but the prose may be WRITTEN in its option
          // names — round C14 draw 21 shipped "A uses Issue statement with
          // probability 0.95 …" with no scenario on screen to say what an
          // Issue statement is. An explanation about options the reader cannot
          // see is withheld, the same as any other unshowable prose.
          const dropped = report.suggestedScenario;
          const names = [dropped?.row1, dropped?.row2, dropped?.col1, dropped?.col2]
            .map((n) => (n ?? '').trim()).filter((n) => n.length > 2);
          const prose = report.prose ?? '';
          if (names.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(prose))) {
            orphanedLabels = true;
          }
          report.suggestedScenario = null;
        }
        proseClaimsFailed = !gates.proseOk;
      }
    }

    if (!report) {
      const envelope: ReportEnvelope = {
        source: "deterministic",
        report: null,
        validation: null,
        groundTruth,
        fallbackReason: failure ?? "error",
      };
      return res.json(envelope);
    }

    const validation = validateReport(report, payoffs);
    // proseClaimsFailed outranks a passing validation: the numeric checks
    // can all be green while the declared actions contradict the solver
    // ("right numbers, wrong words") — that prose is withheld the same way
    // a hallucinated equilibrium is.
    const envelope: ReportEnvelope = orphanedLabels
      ? {
          source: "deterministic",
          report,
          validation,
          groundTruth,
          fallbackReason: "orphaned-labels",
        }
      : proseClaimsFailed
      ? {
          source: "deterministic",
          report,
          validation,
          groundTruth,
          fallbackReason: "prose-claims-failed",
        }
      : validation.ok
      ? { source: "llm", report, validation, groundTruth }
      : {
          source: "deterministic",
          report,
          validation,
          groundTruth,
          fallbackReason: "validation-failed",
        };

    // Only fully-verified envelopes are worth serving twice. Insertion-order
    // eviction keeps the map bounded; the presets are re-cached on their
    // next request if ever evicted.
    if (envelope.source === "llm" && envelope.validation?.ok) {
      if (reportCache.size >= REPORT_CACHE_MAX) {
        const oldest = reportCache.keys().next().value;
        if (oldest !== undefined) reportCache.delete(oldest);
      }
      reportCache.set(cacheKey, envelope);
    }
    return res.json(envelope);
  }));

  // ── Scenario regenerate API (FEATURE-REGEN, flag NASH_SCENARIO_REGEN,
  //    default OFF) ───────────────────────────────────────────────────────────
  //
  // A saved/custom game's payoffs never move; this asks for a NEW description
  // + option labels + colour labelling for the SAME matrix, through the
  // identical `inventScreenedScenario` ladder every other invention site uses
  // (cloud: model + bounded rerolls + bank fallback; desktop: bank first,
  // never the cloud) — plus the ONE extra reject-and-reroll rule threaded in
  // above: the draw must not be the same story as `current`. Nothing here is
  // persisted; the client's existing POST /api/games / PATCH /api/games/:id
  // still owns saving, with every clamp/strip/ownership check unchanged. Not
  // a new screening site — `src/scenariopaths.contract.test.ts` polices that
  // this route calls `inventScreenedScenario` and does not roll its own gate.
  //
  // Same rate-limit LABEL as `/api/report` (`"report"`) — deliberately: a
  // regenerate is a model call exactly like Explain/New AI scenario, so it
  // shares that one honest 20/min hosted budget rather than opening a second,
  // uncounted door to the same provider. Lifted on desktop like every
  // `hosted-only` limit. No auth: nothing is read from or written to the DB.
  // CodeRabbit finding: the flag gate used to live INSIDE the handler, after
  // `rateLimit(...)` had already run — so with the flag off, a burst of 21+
  // requests to this disabled route still consumed that client's shared
  // "report" bucket (429 on the 21st, before the handler ever got to return
  // the real 404), quietly starving their `/api/report` budget for a route
  // that does not even exist yet. This tiny middleware runs BEFORE
  // rateLimit, so a disabled route always answers 404 and never touches the
  // shared bucket at all.
  const requireScenarioRegen: express.RequestHandler = (req, res, next) => {
    if (!scenarioRegenEnabled()) return res.status(404).json({ error: "Not enabled." });
    next();
  };
  app.post("/api/scenario/regenerate", requireScenarioRegen, rateLimit("report", 20, 60_000, 'hosted-only'), asyncHandler(async (req, res) => {
    const payoffs = cleanPayoffs(req.body?.payoffs);
    if (!payoffs) {
      return res.status(400).json({ error: "Invalid payoff matrix." });
    }
    if (!canInvent()) {
      // Honest, not an error: the client's capability probe should already
      // have hidden the button in this state, but a stale probe or a direct
      // API call must still get a real, typed answer rather than a 500.
      return res.json({ scenario: null, failure: "no-key" });
    }
    // `current`: the dialog's OWN live fields, clamped/stripped exactly like
    // every other scenario input — used ONLY to avoid repeating this story
    // (name/description equality, and on desktop the bank domain it came
    // from). Never used to shape the prompt beyond that, never persisted.
    const current = cleanScenario(req.body?.current);
    const avoid = current
      ? { name: current.name, description: current.description, domain: bankDomainFor(current) }
      : undefined;
    const { scenario, failure, scenarioSource } = await inventScreenedScenario(
      payoffs,
      (reason) => console.warn(`[regen] scenario dropped: ${reason}`),
      avoid,
      true,
    );
    // Apply the same response clamp as any client-supplied scenario before the
    // preview sees it. This is what keeps bank and cloud nouns on one safe wire
    // shape even if a future caller bypasses the model's structured schema.
    const cleanedScenario = cleanScenario(scenario, { actorNouns: true });
    console.log(`[regen] served source=${scenarioSource ?? (scenario ? 'model' : 'none')} desktop=${process.env.IS_ELECTRON === 'true'}`);
    return res.json({ scenario: cleanedScenario ?? null, failure: cleanedScenario ? null : (failure ?? "error"), scenarioSource });
  }));

  // ── Feedback API ───────────────────────────────────────────────────────────
  app.post("/api/feedback", rateLimit("feedback", 10, 60_000), asyncHandler(async (req, res) => {
    const { message, email, rating } = req.body;

    const trimmedMessage = typeof message === "string" ? message.trim() : "";
    if (!trimmedMessage) {
      return res.status(400).json({ error: "Feedback message cannot be empty." });
    }
    if (trimmedMessage.length > 5000) {
      return res.status(400).json({ error: "Feedback message is too long (max 5000 characters)." });
    }

    // Email is optional; validate only if the user chose to attach one.
    let fromEmail: string | null = null;
    if (email && typeof email === "string" && email.trim()) {
      const candidate = email.trim();
      if (candidate.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) {
        return res.status(400).json({ error: "Please enter a valid email address or leave it blank to stay anonymous." });
      }
      fromEmail = candidate;
    }

    // Rating is optional; clamp to 1–5 if present.
    let ratingValue: number | null = null;
    if (rating !== undefined && rating !== null && rating !== 0) {
      const r = Math.round(Number(rating));
      if (!Number.isNaN(r) && r >= 1 && r <= 5) ratingValue = r;
    }

    try {
      await sendFeedbackEmail(trimmedMessage, ratingValue, fromEmail);
      return res.json({
        success: true,
        message: fromEmail
          ? "Thank you! Your feedback has been sent — we may reach out at the email you provided."
          : "Thank you! Your anonymous feedback has been sent.",
      });
    } catch (err: any) {
      console.error("Failed to send feedback:", err);
      return res.status(500).json({ error: "Could not send feedback. Please try again later." });
    }
  }));

  // Serve compiled DMG file. Content-Length above the sized-response cap is
  // handled by setContentLengthIfUnderCloudRunLimit (module scope, above) —
  // reconciled from two independent fixes (this branch's own root-cause
  // finding, RED-DESKTOP-4/003, and PR #89's live hotfix) into ONE
  // implementation per the director's call; see that function's own comment.
  app.get("/api/download/dmg", rateLimit("dmg", 10, 60_000), asyncHandler(async (req, res) => {
    try {
      // In Cloud Run, stream from GCS
      if (!process.env.ELECTRON_USER_DATA_PATH && GCS_BUCKET) {
        const { Storage } = await import('@google-cloud/storage');
        const file = new Storage().bucket(GCS_BUCKET).file('Nash Equilibrium Simulator.dmg');
        const [exists] = await file.exists();
        if (exists) {
          // getMetadata() before piping: without it the response carries no
          // Content-Length, so the browser shows an unknown-size download with
          // no progress bar/ETA for a ~120MB file, and a client that reads
          // Content-Length to detect a truncated transfer (curl -C -, some
          // download managers) cannot tell a good download from a dropped one.
          // Verified live against production (revision 00194-fxz):
          // `curl -r 0-0` got a full 200 stream with no Content-Length, no
          // Accept-Ranges, no Content-Range — the range request was silently
          // ignored. `size` comes back as a STRING from the GCS JSON API.
          const [metadata] = await file.getMetadata();
          const size = metadata.size !== undefined && metadata.size !== null
            ? parseInt(String(metadata.size), 10) : null;

          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Disposition', 'attachment; filename="Nash Equilibrium Simulator.dmg"');
          if (size !== null && Number.isFinite(size)) res.setHeader('Accept-Ranges', 'bytes');

          // DownloadModal.tsx does a HEAD request first, specifically to
          // check existence/size WITHOUT downloading. Express dispatches
          // HEAD to this same GET handler (there is no separate route), so
          // without this guard every "just checking" HEAD probe opened a
          // real GCS read stream and piped it into the response — wasted
          // GCS egress for a request whose whole point was to avoid a
          // download. HEAD gets exactly the headers a GET would send, no
          // stream ever created.
          if (req.method === 'HEAD') {
            if (size !== null && Number.isFinite(size)) res.setHeader('Content-Length', String(size));
            res.status(200).end();
            return;
          }

          const streamAndPipe = (range?: { start: number; end: number }) => {
            const stream = range ? file.createReadStream(range) : file.createReadStream();
            stream.on('error', (err) => {
              console.error("Error streaming DMG from GCS:", err);
              if (!res.headersSent) res.status(500).json({ error: "Internal Server Error" });
              else res.destroy();
            });
            stream.pipe(res);
          };

          // RESUMABLE DOWNLOADS: a dropped connection on a ~120MB file
          // otherwise means starting over. `Range: bytes=start-end`,
          // `bytes=start-` (open-ended), and `bytes=-N` (last N bytes) are
          // the three forms curl/browsers/download managers actually send.
          const rangeHeader = size !== null ? req.headers.range : undefined;
          const m = typeof rangeHeader === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
          if (m && (m[1] !== '' || m[2] !== '') && size !== null) {
            let start: number, end: number;
            if (m[1] === '') {
              const suffixLen = parseInt(m[2], 10);
              start = Math.max(0, size - suffixLen);
              end = size - 1;
            } else {
              start = parseInt(m[1], 10);
              // RFC 9110 §14.1.2: an explicit last-byte-pos AT OR PAST the
              // object's length is not an error — it means "to the end of
              // the representation," clamped to size-1. Only a first-byte-
              // pos beyond the object's length is unsatisfiable (416).
              // CodeRabbit caught this: `bytes=0-999999` on a 7500-byte
              // object was rejected 416 instead of served as the whole file.
              end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
            }
            const validRange = Number.isFinite(start) && Number.isFinite(end)
              && start >= 0 && start < size && start <= end;
            if (!validRange) {
              res.setHeader('Content-Range', `bytes */${size}`);
              return res.status(416).end();
            }
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
            setContentLengthIfUnderCloudRunLimit(res, end - start + 1);
            streamAndPipe({ start, end });
            return;
          }

          if (size !== null && Number.isFinite(size)) setContentLengthIfUnderCloudRunLimit(res, size);
          streamAndPipe();
          return;
        }
      }

      // Local / Electron: look in dist-electron/
      const distElectronPath = path.join(process.cwd(), "dist-electron");
      if (fs.existsSync(distElectronPath)) {
        const files = fs.readdirSync(distElectronPath);
        const dmgFile = files.find(f => f.toLowerCase().endsWith(".dmg"));
        if (dmgFile) {
          return res.download(path.join(distElectronPath, dmgFile), dmgFile);
        }
      }

      return res.status(404).json({
        error: "DMG Not Found",
        message: "No compiled macOS .dmg file found. You can package this app locally by running 'npm run electron:dist' on your Mac."
      });
    } catch (error: any) {
      console.error("Error serving DMG:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }));

  // Register Endpoint
  app.post("/api/auth/register", rateLimit("register", 8, 60_000), asyncHandler(async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password are required." });
    }
    const usernameTrimmed = cleanText(username, 40);
    if (!usernameTrimmed) {
      return res.status(400).json({ error: "Username is required." });
    }

    // Password validation: At least 8 characters, with at least one uppercase and one lowercase letter
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters long and contain at least one uppercase and one lowercase letter."
      });
    }

    const emailTrimmed = email.trim().toLowerCase();
    const db = loadDB();
    const isElectron = !!process.env.ELECTRON_USER_DATA_PATH;

    // Check for duplicate username (case-insensitive)
    const usernameTaken = db.users.find(
      u => u.username.trim().toLowerCase() === usernameTrimmed.toLowerCase()
        && u.email.trim().toLowerCase() !== emailTrimmed
    );
    if (usernameTaken) {
      return res.status(400).json({ error: "That username is already taken. Please choose a different one." });
    }

    // Check if user exists using trimmed, lowercased comparison
    const existingUser = db.users.find(u => u.email.trim().toLowerCase() === emailTrimmed);
    if (existingUser) {
      if (existingUser.isVerified) {
        return res.status(400).json({ error: "An account with this email already exists." });
      }

      // If we are in Electron local mode, mark them verified instantly and save
      if (isElectron) {
        existingUser.isVerified = true;
        existingUser.username = usernameTrimmed;
        existingUser.passwordHash = hashPassword(password);
        saveDB(db);
        return res.json({
          success: true,
          message: "Local account created successfully! You are ready to log in.",
          autoVerified: true
        });
      }

      // If of the unverified user on the website, refresh code
      const updatedCode = makeCode();
      existingUser.username = usernameTrimmed;
      existingUser.passwordHash = hashPassword(password);
      existingUser.verificationCode = updatedCode;
      existingUser.verificationCodeExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
      existingUser.verificationCodeAttempts = undefined; // fresh code → fresh attempt budget
      saveDB(db);

      let emailResult;
      let emailErrorMsg = null;
      try {
        emailResult = await sendVerificationEmail(emailTrimmed, updatedCode, usernameTrimmed);
      } catch (err: any) {
        emailErrorMsg = err.message;
      }

      if (emailErrorMsg) {
        return res.status(500).json({
          error: `Could not send verification email: ${emailErrorMsg}. Please check your server SMTP settings.`
        });
      }

      return res.json({
        success: true,
        message: "Unverified user exists. Sent a new 6-digit verification code to your email address.",
        email: emailTrimmed,
        via: emailResult?.via || "smtp",
        previewUrl: emailResult?.previewUrl || null
      });
    }

    // Direct verified path for local Electron apps
    if (isElectron) {
      const newUser: User = {
        id: makeId("u"),
        username: usernameTrimmed,
        email: emailTrimmed,
        passwordHash: hashPassword(password),
        isVerified: true,
        verificationCode: "",
        verificationCodeExpires: 0
      };
      db.users.push(newUser);
      saveDB(db);
      return res.json({
        success: true,
        message: "Local account created successfully! You are ready to log in.",
        autoVerified: true
      });
    }

    const verificationCode = makeCode();
    const newUser: User = {
      id: makeId("u"),
      username: usernameTrimmed,
      email: emailTrimmed,
      passwordHash: hashPassword(password),
      isVerified: false,
      verificationCode,
      verificationCodeExpires: Date.now() + 10 * 60 * 1000
    };

    db.users.push(newUser);
    saveDB(db);

    let emailResult;
    let emailErrorMsg = null;
    try {
      emailResult = await sendVerificationEmail(emailTrimmed, verificationCode, usernameTrimmed);
    } catch (err: any) {
      emailErrorMsg = err.message;
    }

    if (emailErrorMsg) {
      // Discard the unverified registration if SMTP is failing completely,
      // so we do not block subsequent attempts when SMTP config is updated.
      db.users = db.users.filter(u => u.email.trim().toLowerCase() !== emailTrimmed);
      saveDB(db);
      return res.status(500).json({
        error: `Could not send verification email: ${emailErrorMsg}. Please check your server SMTP settings.`
      });
    }

    res.json({
      success: true,
      message: "Registration successful! A 6-digit confirmation code has been sent to your email address.",
      email: emailTrimmed,
      via: emailResult?.via || "smtp",
      previewUrl: emailResult?.previewUrl || null
    });
  }));

  // Verify Endpoint
  app.post("/api/auth/verify", rateLimit("verify", 12, 60_000), (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: "Email and verification code are required." });
    }

    const emailTrimmed = email.trim().toLowerCase();
    const db = loadDB();
    const userIndex = db.users.findIndex(u => u.email === emailTrimmed);

    if (userIndex === -1) {
      return res.status(404).json({ error: "No pending registration found for this email." });
    }

    const user = db.users[userIndex];

    if (user.isVerified) {
      return res.status(400).json({ error: "Email is already verified." });
    }

    if (user.verificationCodeExpires < Date.now()) {
      return res.status(400).json({ error: "Verification code has expired. Please register again to get a new code." });
    }

    const verifyCheck = verifyOneTimeCode(user, "verification", code);
    if (!verifyCheck.ok) {
      saveDB(db);
      return res.status(400).json({
        error: verifyCheck.locked
          ? "Too many incorrect attempts. Please register again to get a new code."
          : "Incorrect verification code."
      });
    }

    // Mark verified
    user.isVerified = true;
    saveDB(db);

    res.json({
      success: true,
      message: "Email verified successfully! You can now log in.",
      username: user.username
    });
  });

  // Login Endpoint
  app.post("/api/auth/login", rateLimit("login", 10, 60_000), (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email/username and password are required." });
    }

    const identifier = email.trim().toLowerCase();
    const db = loadDB();
    const candidate = db.users.find(u =>
      u.email === identifier || u.username.toLowerCase() === identifier
    );
    // Always run pbkdf2 (against a dummy hash on a miss) so a non-existent
    // account isn't revealed by a faster response — see DUMMY_PASSWORD_HASH.
    const passwordOk = verifyPassword(password, candidate ? candidate.passwordHash : DUMMY_PASSWORD_HASH);
    const user = candidate && passwordOk ? candidate : null;

    if (!user) {
      return res.status(401).json({ error: "Invalid email/username or password." });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        error: "Please complete email verification first.",
        needVerification: true,
        email: user.email
      });
    }

    if (needsPasswordRehash(user.passwordHash)) {
      user.passwordHash = hashPassword(password);
      saveDB(db);
    }
      // A local owner who signs in takes their games with them. Without this,
      // anything saved before making an account would be stranded behind an
      // identity the user can no longer reach.
      const adopted = adoptLocalGames(user.id);
      if (adopted) console.log(`[auth] adopted ${adopted} local game(s) into ${user.id}`);


    res.json({
      success: true,
      token: createAuthToken(user),
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });
  });

  // Get Current Session
  app.get("/api/auth/me", rateLimit("me", 60, 60_000), (req, res) => {
    const user = getAuthUser(req);

    if (!user) {
      return res.status(401).json({ error: "Invalid session." });
    }

    res.json({
      id: user.id,
      username: user.username,
      email: user.email
    });
  });

  // Forgot Password — send recovery code to email
  app.post("/api/auth/forgot-password", rateLimit("forgot", 6, 60_000), asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email address is required." });
    }

    const emailTrimmed = email.trim().toLowerCase();
    const db = loadDB();
    const user = db.users.find(u => u.email.trim().toLowerCase() === emailTrimmed);

    // Always return a success-looking response to prevent email enumeration
    if (!user || !user.isVerified) {
      return res.json({
        success: true,
        message: "If an account with that email exists, a recovery code has been sent."
      });
    }

    const recoveryCode = makeCode();
    user.recoveryCode = recoveryCode;
    user.recoveryCodeExpires = Date.now() + 10 * 60 * 1000;
    user.recoveryCodeAttempts = undefined; // fresh code → fresh attempt budget
    saveDB(db);

    const isElectron = !!process.env.ELECTRON_USER_DATA_PATH;
    let emailErrorMsg = null;

    if (!isElectron) {
      try {
        await sendRecoveryEmail(emailTrimmed, recoveryCode);
      } catch (err: any) {
        emailErrorMsg = err.message;
      }
    }

    if (emailErrorMsg && !isElectron) {
      return res.status(500).json({ error: "Could not send recovery email. Please try again later." });
    }

    return res.json({
      success: true,
      message: isElectron
        ? `Recovery code generated locally. Use code: ${recoveryCode}`
        : "A 6-digit recovery code has been sent to your email address.",
      ...(isElectron ? { recoveryCode } : {})
    });
  }));

  // Reset Password — verify code and set new password
  app.post("/api/auth/reset-password", rateLimit("reset", 8, 60_000), (req, res) => {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "Email, recovery code, and new password are required." });
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters long and contain at least one uppercase and one lowercase letter."
      });
    }

    const emailTrimmed = email.trim().toLowerCase();
    const db = loadDB();
    const user = db.users.find(u => u.email.trim().toLowerCase() === emailTrimmed);

    if (!user) {
      return res.status(404).json({ error: "No account found for this email." });
    }

    if (!user.recoveryCode || !user.recoveryCodeExpires) {
      return res.status(400).json({ error: "No active recovery request found. Please request a new code." });
    }

    if (user.recoveryCodeExpires < Date.now()) {
      return res.status(400).json({ error: "Recovery code has expired. Please request a new one." });
    }

    const recoveryCheck = verifyOneTimeCode(user, "recovery", code);
    if (!recoveryCheck.ok) {
      saveDB(db);
      return res.status(400).json({
        error: recoveryCheck.locked
          ? "Too many incorrect attempts. Please request a new recovery code."
          : "Incorrect recovery code."
      });
    }

    user.passwordHash = hashPassword(newPassword);
    user.recoveryCode = undefined;
    user.recoveryCodeExpires = undefined;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1; // invalidate existing sessions
    saveDB(db);

    res.json({ success: true, message: "Password reset successfully! You can now log in with your new password." });
  });

  // Request account deletion code
  app.post("/api/auth/delete-request", rateLimit("delete-request", 6, 60_000), asyncHandler(async (req, res) => {
    const db = loadDB();
    const user = getAuthUser(req);

    if (!user) {
      return res.status(401).json({ error: "Invalid session." });
    }

    const deleteCode = makeCode();
    user.deleteCode = deleteCode;
    user.deleteCodeExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
    user.deleteCodeAttempts = undefined; // fresh code → fresh attempt budget

    saveDB(db);

    let emailErrorMsg = null;
    try {
      await sendDeleteEmail(user.email, deleteCode, user.username);
    } catch (err: any) {
      emailErrorMsg = err.message;
    }

    const isElectron = !!process.env.ELECTRON_USER_DATA_PATH;
    if (emailErrorMsg && !isElectron) {
      return res.status(500).json({ error: "Could not send deletion confirmation email. Please try again later." });
    }

    return res.json({
      success: true,
      message: isElectron && emailErrorMsg
        ? `A security confirmation code was generated locally: Enter code ${deleteCode} below.`
        : "A 6-digit confirmation security code has been sent to your email address.",
      ...(isElectron ? { deleteCode } : {})
    });
  }));

  // Verify deletion code and delete account
  app.post("/api/auth/delete-confirm", rateLimit("delete-confirm", 8, 60_000), (req, res) => {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: "Verification code is required." });
    }

    const db = loadDB();
    const authUser = getAuthUser(req);
    const userIndex = authUser ? db.users.findIndex(u => u.id === authUser.id) : -1;

    if (userIndex === -1) {
      return res.status(401).json({ error: "Invalid session or user not found." });
    }

    const user = db.users[userIndex];

    if (!user.deleteCode || !user.deleteCodeExpires) {
      return res.status(400).json({ error: "No active deletion request found for this account." });
    }

    if (user.deleteCodeExpires < Date.now()) {
      return res.status(400).json({ error: "Deletion confirmation code has expired. Please request a new one." });
    }

    const deleteCheck = verifyOneTimeCode(user, "delete", code);
    if (!deleteCheck.ok) {
      saveDB(db);
      return res.status(400).json({
        error: deleteCheck.locked
          ? "Too many incorrect attempts. Please request a new confirmation code."
          : "Incorrect verification code."
      });
    }

    const userEmail = user.email.toLowerCase().trim();

    // Clean up corresponding games saved by team space
    db.games = db.games.filter(g => g.userId !== user.id);

    // Completely wipe out any user records matching this email or user ID
    db.users = db.users.filter(u => u.email.toLowerCase().trim() !== userEmail && u.id !== user.id);

    saveDB(db);

    res.json({
      success: true,
      message: "Your account and all saved game profiles have been successfully deleted from our records."
    });
  });

  // ── Desktop recovery hint ───────────────────────────────────────────────────
  // Unauthenticated `GET /api/games` returns 200 [] both for a brand-new
  // install (never used) AND for a real pre-existing account that saved games
  // before `local-owner` shipped — the two are indistinguishable from that
  // response alone, and there is nothing else in the app that would tell a
  // returning user "sign in to see your other games." This endpoint answers
  // exactly one boolean, computed without ever exposing which account, what
  // its games are, or anything else pre-auth — safe to call from the empty
  // state before the user has proven who they are.
  app.get("/api/auth/desktop-hint", rateLimit("desktop-hint", 30, 60_000), (req, res) => {
    if (!isDesktop()) return res.json({ hasOtherAccounts: false });
    const db = loadDB();
    const hasOtherAccounts = db.users.some((u) =>
      u.id !== LOCAL_OWNER_ID && db.games.some((g) => g.userId === u.id));
    res.json({ hasOtherAccounts });
  });

  // ── Custom Saved Games API ─────────────────────────────────────────────────

  // Get User's Custom Games
  app.get("/api/games", rateLimit("games-read", 60, 60_000, 'hosted-only'), (req, res) => {
    const user = getGameOwner(req);
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    const db = loadDB();
    const userGames = db.games.filter(g => g.userId === user.id);
    res.json(userGames);
  });

  // Create/Save a Custom Game
  app.post("/api/games", rateLimit("games-write", 20, 60_000, 'hosted-only'), asyncHandler(async (req, res) => {
    const user = getGameOwner(req);
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    const { name, description, payoffs } = req.body;
    const cleanName = cleanText(name, 80);
    const cleanDescription = cleanText(description, 800);
    const cleanMatrix = cleanPayoffs(payoffs);
    if (!cleanName || !cleanMatrix) {
      return res.status(400).json({ error: "Game name and payoffs matrix are required." });
    }

    // The ENTIRE read-build-save sequence is serialized (see
    // serializeGameWrite's own comment): `loadDB()` happens INSIDE the
    // queued function so it reads whatever the most recently queued write
    // actually committed, not a snapshot taken before this request had to
    // wait its turn.
    await serializeGameWrite(async () => {
      const db = loadDB();
      const newGame: SavedGame = {
        id: makeId("g"),
        userId: user.id,
        name: cleanName,
        description: cleanDescription || `Custom payoff matrix saved by ${user.username}`,
        payoffs: cleanMatrix,
        createdAt: new Date().toISOString(),
        ...cleanLabels(req.body),
        ...cleanColorTerms(req.body, true)
      };

      // A NEW games array, not a push onto the live `db.games` (==
      // inMemoryDb's own array) — saveDBOrFail only commits this candidate
      // to inMemoryDb on a CONFIRMED write, so a failure must find nothing
      // already mutated to roll back FROM. `users` is NOT part of this
      // candidate (saveDBAwaited reads it fresh at write/commit time) — see
      // its own comment for why a users SNAPSHOT here would race a
      // concurrent, unserialized account write.
      if (!(await saveDBOrFail([...db.games, newGame], res))) return;

      res.json({
        success: true,
        message: "Game saved successfully!",
        game: newGame
      });
    });
  }));

  // Update a Custom Game's story (name / description / option labels).
  //
  // Exists so an invented scenario can be kept ON the game the user already
  // saved. Without it the only way to retain a scenario was to save a second
  // copy of the same matrix, and the original would keep getting a freshly
  // invented story on every explanation.
  //
  // Payoffs are deliberately NOT updatable here: changing them would silently
  // invalidate the description, which is the exact mismatch this feature exists
  // to prevent. Editing a matrix stays a save-as-new operation.
  app.patch("/api/games/:id", rateLimit("games-write", 20, 60_000, 'hosted-only'), asyncHandler(async (req, res) => {
    const user = getGameOwner(req);
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    // The edit dialog sends every field, so it opts into clearing; the
    // save-this-scenario path sends only what it means to change.
    const allowClear = req.body?.allowClear === true;
    const nextName = cleanText(req.body?.name, 80);
    const nextDescription = cleanText(req.body?.description, 800);
    const nextLabels = cleanLabels(req.body, allowClear);
    const nextTerms = cleanColorTerms(req.body, allowClear);
    // Labels count as an update in their own right. Keeping an invented
    // scenario means writing its four option names onto the game, and that has
    // to be a valid PATCH on its own — otherwise a scenario whose description
    // came back empty would be rejected as "nothing to update" and the labels
    // would be lost with it.
    if (!nextName && !nextDescription && Object.keys(nextLabels).length === 0
        && Object.keys(nextTerms).length === 0) {
      return res.status(400).json({ error: "Nothing to update." });
    }

    // The ENTIRE read-find-build-save sequence is serialized (see
    // serializeGameWrite's own comment) — including the not-found/ownership
    // checks, which must read whatever the most recently queued write
    // committed, not a snapshot from before this request waited its turn.
    await serializeGameWrite(async () => {
      const db = loadDB();
      const game = db.games.find(g => g.id === req.params.id);
      if (!game) {
        return res.status(404).json({ error: "Game not found." });
      }
      if (game.userId !== user.id) {
        return res.status(403).json({ error: "You are not authorized to edit this game." });
      }
      // A NEW game object and a NEW games array — never mutate `game` (a
      // live reference into inMemoryDb.games) in place, or a failed write
      // would have nothing left to roll back FROM (saveDBAwaited's own
      // comment).
      const updatedGame: SavedGame = { ...game };
      if (nextName) updatedGame.name = nextName;
      // Description follows the same rule as the labels: normally an empty
      // value means "not supplied", but an edit that deliberately empties
      // the box must be able to remove the text.
      if (nextDescription || (allowClear && "description" in req.body)) updatedGame.description = nextDescription;
      Object.assign(updatedGame, nextLabels, nextTerms);
      // `users` is NOT part of this candidate — see saveDBAwaited's own
      // comment for why a users snapshot here would race a concurrent,
      // unserialized account write.
      const candidateGames = db.games.map((g) => (g.id === updatedGame.id ? updatedGame : g));
      if (!(await saveDBOrFail(candidateGames, res))) return;

      res.json({ success: true, message: "Game updated.", game: updatedGame });
    });
  }));

  // Delete a Custom Game
  app.delete("/api/games/:id", rateLimit("games-delete", 30, 60_000, 'hosted-only'), asyncHandler(async (req, res) => {
    const user = getGameOwner(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized access." });
    }
    const gameId = req.params.id;

    // The ENTIRE read-find-save sequence is serialized (see
    // serializeGameWrite's own comment) — including the not-found/ownership
    // checks, which must read whatever the most recently queued write
    // committed, not a snapshot from before this request waited its turn.
    await serializeGameWrite(async () => {
      const db = loadDB();
      const gameIndex = db.games.findIndex(g => g.id === gameId);
      if (gameIndex === -1) {
        return res.status(404).json({ error: "Game not found." });
      }

      const game = db.games[gameIndex];
      if (game.userId !== user.id) {
        return res.status(403).json({ error: "You are not authorized to delete this game." });
      }

      // A NEW games array (filter, not splice on the live one) — a failed
      // write must leave inMemoryDb's own array undisturbed. `users` is NOT
      // part of this candidate — see saveDBAwaited's own comment for why a
      // users snapshot here would race a concurrent, unserialized account
      // write.
      if (!(await saveDBOrFail(db.games.filter((_, i) => i !== gameIndex), res))) return;

      res.json({
        success: true,
        message: "Game deleted successfully."
      });
    });
  }));


  // ── Vite / Frontend static file host ───────────────────────────────────────

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In production, only serve frontend if dist files exist (optional)
    // In packaged Electron, process.cwd() is not the app folder — use __dirname
    // (server.cjs lives inside dist/, so __dirname IS the dist folder)
    const distPath = process.env.ELECTRON_USER_DATA_PATH
      ? __dirname
      : path.join(process.cwd(), 'dist');
    if (fs.existsSync(path.join(distPath, 'index.html'))) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      // No frontend files - just serve API
      console.log("Frontend files not found, serving API-only mode");
      // Fallback 404 for unknown routes (after API routes)
      app.use((req, res) => {
        res.status(404).json({ error: "Not found" });
      });
    }
  }

  // Global Express error-handling middleware (RED-DESKTOP-6/001). Registered
  // LAST, after every route and the static/404 fallback above, which is where
  // Express requires a 4-arg handler to live to be recognised as an error
  // handler at all. Every `asyncHandler`-wrapped route funnels its rejections
  // here via `next(err)`; a plain synchronous handler that throws lands here
  // through Express's own built-in behavior. One logged, generic 500 instead
  // of a hung/reset connection and a crashed or silently poisoned process.
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const cause = err instanceof Error ? (err.stack || err.message) : String(err);
    console.error(`Unhandled error on ${req.method} ${req.path}:`, cause);
    if (res.headersSent) {
      // A response already started streaming; Express's own guidance is to
      // delegate to the default handler rather than try to send a second one.
      next(err);
      return;
    }
    // body-parser (express.json's own middleware, ahead of every route) rejects
    // a malformed or oversized request body with a genuine client-facing HTTP
    // status attached as `err.status`/`err.statusCode` — 413 for a body over the
    // configured limit ("entity.too.large"), 400 for unparseable JSON
    // ("entity.parse.failed"). Before this catch-all existed, Express's own
    // built-in error handler read that status straight through. A bare
    // `res.status(500)` here would silently turn every one of those into a
    // generic server error — caught by api.test.mjs's own regression check
    // ("a 200kb request body -> 413"), which went 500 the first time this
    // handler shipped without this carve-out. Only trust a 4xx (never a
    // spoofed/mistaken 5xx or something out of range) from upstream
    // middleware; anything else still collapses to a logged, generic 500.
    const upstreamStatus = (err as { status?: unknown; statusCode?: unknown } | null | undefined)?.status
      ?? (err as { status?: unknown; statusCode?: unknown } | null | undefined)?.statusCode;
    if (typeof upstreamStatus === "number" && upstreamStatus >= 400 && upstreamStatus < 500) {
      res.status(upstreamStatus).json({ error: "Invalid request." });
      return;
    }
    res.status(500).json({ error: "Internal server error." });
  });

  // Legacy accounts store passwords as reversible base64 (pre-pbkdf2). They're
  // upgraded on next successful login, but dormant rows stay plaintext-equivalent
  // if db.json/GCS leaks. Surface the count so operators can force a reset.
  const legacyPwCount = loadDB().users.filter(u => needsPasswordRehash(u.passwordHash)).length;
  if (legacyPwCount > 0) {
    console.warn(`SECURITY: ${legacyPwCount} account(s) still use legacy (reversible) password hashes. Consider forcing a password reset for these users.`);
  }

  // Dynamic port assignment with automatic fallback in case of port collisions
  const startListening = (port: number) => {
    // BIND HOST IS A DEFECT FIX, not a preference.
    //
    // On macOS, bind(0.0.0.0:P) SUCCEEDS while another process holds
    // 127.0.0.1:P — no EADDRINUSE — and the more specific bind then wins every
    // loopback connection. In the desktop app that had two consequences. The
    // API was reachable from the LOCAL NETWORK: verified against a running
    // installed copy, http://<lan-ip>:14321/ answered 200, and on a build with
    // the offline model bundled a POST to /api/report from another machine
    // returned a freshly invented scenario. CORS is irrelevant there; a direct
    // request is not a browser. And the port-retry loop below could
    // "successfully" bind a port another local server already owned, log
    // nothing, and leave the window talking to that other server.
    //
    // Binding the loopback at the SAME specificity makes the kernel refuse the
    // second bind, so the retry actually advances. Cloud Run must still bind
    // 0.0.0.0 or the container is unreachable, hence the gate on IS_ELECTRON.
    const host = process.env.IS_ELECTRON === 'true' ? '127.0.0.1' : '0.0.0.0';
    const serverInstance = app.listen(port, host, () => {
      console.log(`Express server running on http://${host}:${port}`);
      // From here on, a request-path failure should be logged and survived,
      // not treated as a startup failure. See `handleFatalAsync` above.
      serverListening = true;
      if (process.env.IS_ELECTRON === 'true') {
        (global as any).expressPort = port;
        if ((global as any).onExpressListening) {
          (global as any).onExpressListening(port);
        }
      }
    });

    serverInstance.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${port} is already in use. Retrying with port ${port + 1}...`);
        if (process.env.IS_ELECTRON === 'true') {
          startListening(port + 1);
        } else {
          console.error(`EADDRINUSE: Port ${port} is occupied.`);
          process.exit(1);
        }
      } else {
        console.error("Server bind error:", err);
      }
    });
  };

  const initialPort = parseInt(process.env.PORT || "3000", 10);
  // A `false` return means `initDB`/`loadDBFromFile` already reported the
  // failure (see their own comments) — stop here: never call `app.listen`
  // on a DB we refused to trust.
  if (!(await initDB())) return;
  startListening(initialPort);
}

startServer();

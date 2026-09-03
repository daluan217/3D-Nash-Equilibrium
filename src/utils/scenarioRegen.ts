/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure predicates and shared shapes for the "Regenerate scenario" feature
 * (FEATURE-REGEN, 2026-09-02/03): a saved/custom game can ask the model for a
 * NEW description + option labels + colour labelling for the SAME payoff
 * matrix, preview it, and Keep or Discard. Payoffs are never touched.
 *
 * WHY A SEPARATE MODULE, SHARED BY CLIENT AND SERVER. Every previous defect
 * this repo shipped in this neighbourhood (RED-APP-4's unconditional
 * overwrite, RED-APP-3's stale-report race) lived in a UI event handler where
 * the DECISION and the plumbing were the same code, so nothing could test the
 * decision in isolation. `generateFill.ts` set the pattern; this follows it.
 * Both `server.ts` (the avoid-gate on the invention ladder) and `App.tsx`
 * (staleness, Keep/Discard, error wording) import from here so the two sides
 * cannot drift on what "the same story" or "still current" means.
 *
 * `isSameStory`/`regenKeyEquals`/`regenResponseIsCurrent` etc. take only
 * plain data — no DOM, no fetch, no React — so every branch is a one-line
 * assertion in `src/scenarioregen.test.ts` with no mount required.
 */
import { cleanText } from './textSafety';
import { cleanUserColorTermPair } from './colorTerms';
import type { GamePayoffs } from '../types';

// ── field limits, matching the existing save/edit dialogs and server clamps ──
export const REGEN_NAME_MAX = 40;
export const REGEN_LABEL_MAX = 40;
export const REGEN_DESCRIPTION_MAX = 800;

/**
 * Slice a string to at most `max` UTF-16 code units WITHOUT splitting a
 * surrogate pair in half.
 *
 * A plain `s.slice(0, max)` cuts by UTF-16 code UNIT, so a max landing inside
 * an astral character (most emoji, several scripts) keeps the lone leading
 * surrogate — an unpaired surrogate that renders as U+FFFD / a broken glyph
 * everywhere the text is shown afterwards (the drawer card, the matrix
 * header, the saved description). Iterating `for...of` walks by CODE POINT,
 * so a character that would push the running UTF-16-unit count past `max` is
 * dropped whole rather than split — exactly the same code-point-safe
 * iteration `stripUnsafeText` already relies on in this codebase, applied
 * here to a length budget instead of a filter. The budget stays in UTF-16
 * units (not code points) so the result never exceeds a native
 * `maxLength={max}` on the controlled inputs these values are written into.
 */
export function codepointSafeSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = '';
  let units = 0;
  for (const ch of s) {
    const chUnits = ch.length; // 1, or 2 for a surrogate pair
    if (units + chUnits > max) break;
    out += ch;
    units += chUnits;
  }
  return out;
}

// ── which game a regen request/preview is FOR ────────────────────────────────
export type RegenKey =
  | { kind: 'edit'; gameId: string }
  | { kind: 'save'; payoffs: GamePayoffs };

function payoffsEqualLocal(a: GamePayoffs, b: GamePayoffs): boolean {
  // A small deliberate duplicate of App.tsx's own `payoffsEqual` rather than
  // an import: App.tsx imports THIS module, so importing back would be a
  // circular dependency for an eight-field comparison not worth the risk.
  return a.a11 === b.a11 && a.a12 === b.a12 && a.a21 === b.a21 && a.a22 === b.a22
      && a.b11 === b.b11 && a.b12 === b.b12 && a.b21 === b.b21 && a.b22 === b.b22;
}

export function regenKeyEquals(a: RegenKey, b: RegenKey): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'edit' && b.kind === 'edit') return a.gameId === b.gameId;
  if (a.kind === 'save' && b.kind === 'save') return payoffsEqualLocal(a.payoffs, b.payoffs);
  return false;
}

/**
 * True iff a regen response/preview that was requested under `requestKey` at
 * generation `myGen` is still the one the UI should act on: the generation
 * counter has not been bumped by a later click/open/close, AND the dialog is
 * still showing the same game the request was FOR (an Edit-A response must
 * never land in Edit-B, a Save-dialog response must never land after
 * "Generate" rolled a new matrix under it).
 */
export function regenResponseIsCurrent(args: {
  myGen: number;
  currentGen: number;
  requestKey: RegenKey;
  currentKey: RegenKey;
}): boolean {
  return args.myGen === args.currentGen && regenKeyEquals(args.requestKey, args.currentKey);
}

// ── "is this the same story as the one already on screen?" ───────────────────
function normStory(s: string | undefined | null): string {
  return (s ?? '').normalize('NFKC').trim().toLowerCase();
}

/**
 * Same rule `bankKey` uses to de-duplicate within a bank session: names
 * compared case/NFKC/trim-insensitively when both sides have one, otherwise
 * the first 40 characters of the (normalized) description — the same prefix
 * length `bankKey` itself uses, so a name-less draw's identity is judged by
 * exactly the text a reader would recognise as "the same opening again".
 */
export function isSameStory(
  a: { name?: string; description?: string } | null | undefined,
  b: { name?: string; description?: string } | null | undefined,
): boolean {
  if (!a || !b) return false;
  const an = normStory(a.name);
  const bn = normStory(b.name);
  if (an && bn) return an === bn;
  const ad = normStory(a.description).slice(0, 40);
  const bd = normStory(b.description).slice(0, 40);
  return ad.length > 0 && ad === bd;
}

// ── the regenerated draw, as the client sees it ───────────────────────────────
export interface RegenPreview {
  name?: string;
  description?: string;
  row1?: string;
  row2?: string;
  col1?: string;
  col2?: string;
  actorA?: string[];
  actorB?: string[];
}

/**
 * Strip bidi-override/control code points from every text field of a draw
 * before it is even PREVIEWED — the same strip every save/edit submit
 * already applies (`textSafety.cleanText`), moved earlier so the preview
 * itself cannot render a bidi-reordered model string. This is NOT a rewrite
 * of model content: it removes invisible formatting controls a model should
 * never emit and a save would strip anyway; it changes no visible character.
 * Deliberately no length clamp here — the preview shows the draw as it will
 * be judged; clamping is `keepFill`'s job, applied only on Keep.
 */
export function cleanPreview(sc: RegenPreview | null | undefined): RegenPreview | null {
  if (!sc) return null;
  const strip = (v: string | undefined) => (v === undefined ? v : cleanText(v));
  return {
    name: strip(sc.name),
    description: strip(sc.description),
    row1: strip(sc.row1),
    row2: strip(sc.row2),
    col1: strip(sc.col1),
    col2: strip(sc.col2),
    actorA: sc.actorA,
    actorB: sc.actorB,
  };
}

// ── Keep ───────────────────────────────────────────────────────────────────
export interface KeptFill {
  /** Present only when the caller decided (via `shouldReplaceName`) that the
   *  name should be replaced too. Absent means "leave the name field alone". */
  name?: string;
  desc: string;
  labels: { row1: string; row2: string; col1: string; col2: string };
  terms: { a: string[]; b: string[] };
}

/**
 * DIRECTOR'S DECISION (2026-09-03, round 6, amending the plan): Keep
 * replaces the NAME too, unless the user typed into the name field during
 * THIS dialog session — typed text always wins, whether that means typing
 * into a blank field or hand-editing an auto-prefilled one. A kept OLD name
 * over a BRAND-NEW story ("Vineyard Water Scheduling" above a bakery story)
 * is a coherence defect a red would file immediately; the user's own typing
 * is the one thing regeneration must never touch.
 *
 * "Typed this session" is tracked by the caller as a single boolean — set
 * the instant the name `<input>`'s onChange fires from a real keystroke, and
 * reset to false whenever the dialog opens for a (possibly different) game —
 * so this function is the whole decision, pure and testable without mounting
 * anything: both branches are one call each.
 */
export function shouldReplaceName(nameTypedThisSession: boolean): boolean {
  return !nameTypedThisSession;
}

/**
 * Turn a (cleaned) preview into the values the two dialogs' setters should
 * receive on Keep. Applies the SAME clamps the save/edit submit handlers and
 * the server apply (name 40 / description 800 / label 40), grapheme-safe, so
 * a value that has already been through `keepFill` cannot be rejected or
 * silently truncated a second, DIFFERENT way by the eventual submit.
 *
 * Colour terms: always `cleanUserColorTermPair(preview.actorA, preview.actorB)`
 * — the new text's OWN labelling, REPLACING whatever chips the user had
 * marked on the old text (director's decision 3: a bank row with no actor
 * nouns yields `{a:[],b:[]}`, and the four structural/option labels alone
 * colour it from then on, exactly like every other custom game without
 * actor nouns today).
 */
export function keepFill(preview: RegenPreview, replaceName: boolean): KeptFill {
  const out: KeptFill = {
    desc: codepointSafeSlice(cleanText(preview.description ?? ''), REGEN_DESCRIPTION_MAX),
    labels: {
      row1: codepointSafeSlice(cleanText(preview.row1 ?? ''), REGEN_LABEL_MAX),
      row2: codepointSafeSlice(cleanText(preview.row2 ?? ''), REGEN_LABEL_MAX),
      col1: codepointSafeSlice(cleanText(preview.col1 ?? ''), REGEN_LABEL_MAX),
      col2: codepointSafeSlice(cleanText(preview.col2 ?? ''), REGEN_LABEL_MAX),
    },
    terms: cleanUserColorTermPair(preview.actorA ?? [], preview.actorB ?? []),
  };
  if (replaceName) out.name = codepointSafeSlice(cleanText(preview.name ?? ''), REGEN_NAME_MAX);
  return out;
}

// ── errors ───────────────────────────────────────────────────────────────────
export type RegenErrorKind = 'rate-limit' | 'timeout' | 'unavailable' | 'no-story' | 'network';

/**
 * Map a response (or a thrown/aborted fetch) to one of five honest outcomes.
 * `status` is `null` when the request never produced a response at all
 * (network failure, or an abort — distinguished by `err`).
 */
export function regenErrorFromResponse(
  status: number | null,
  body: { scenario?: unknown; error?: string } | null,
  err: unknown,
): RegenErrorKind {
  if (err instanceof DOMException && err.name === 'AbortError') return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status === 404) return 'unavailable';
  if (status === 200 && body && body.scenario === null) return 'no-story';
  return 'network';
}

/** One template per kind; `rate-limit` folds in the server's own 429 body
 *  text (the standard "Too many attempts…" wording `rateLimit` sends) so the
 *  dialog states the real reason rather than a generic one. */
export const REGEN_ERROR_MESSAGES: Record<RegenErrorKind, (serverText?: string) => string> = {
  'rate-limit': (t) => `AI limit reached — ${t || 'Too many attempts. Please wait a minute and try again.'}`,
  'timeout': () => 'This is taking longer than expected — try again?',
  'unavailable': () => "Regenerating isn't available on this server.",
  'no-story': () => "Couldn't write a verified scenario just now — try again.",
  'network': () => "Couldn't reach the scenario service. Your text below is unchanged.",
};

/** aria-live announcements, one string per moment — kept as constants so the
 *  e2e/a11y checks and the handler can never say something different. */
export const REGEN_ANNOUNCE = {
  loading: 'Regenerating a new scenario…',
  ready: 'New scenario ready — review it below, then Keep or Discard.',
  keptEdit: 'Kept — review the fields, then Save Changes.',
  keptSave: 'Kept — review the fields, then Save Game Profile.',
  discarded: 'Discarded — your text is unchanged.',
} as const;

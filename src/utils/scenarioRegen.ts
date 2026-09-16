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
import { cleanText, clampGraphemeSafe } from './textSafety';
import {
  regenKeptColorTerms, capHitMessage, chipPaintStates, colorTermKey,
  mergeDescriptionTerms, dialogBaseColorTerms, optionLabelTerms,
} from './colorTerms';
import type { GamePayoffs } from '../types';

// ── field limits, matching the existing save/edit dialogs and server clamps ──
export const REGEN_NAME_MAX = 40;
export const REGEN_LABEL_MAX = 40;
export const REGEN_DESCRIPTION_MAX = 800;


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
  if (!sc || typeof sc !== 'object') return null;
  // TRUST BOUNDARY. `body.scenario` is not always ours: in desktop cloud mode
  // `apiBaseUrl` is a free-form field (App.tsx getApiUrl), so a proxy or a
  // broken upstream can send any JSON. A non-string field used to reach
  // `cleanText` and throw ("s is not iterable") OUTSIDE App.tsx's try/catch,
  // leaving the dialog silent. Drop what is not a string instead.
  const strip = (v: unknown) => (typeof v === 'string' ? cleanText(v) : undefined);
  const nouns = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  return {
    name: strip(sc.name),
    description: strip(sc.description),
    row1: strip(sc.row1),
    row2: strip(sc.row2),
    col1: strip(sc.col1),
    col2: strip(sc.col2),
    actorA: nouns(sc.actorA),
    actorB: nouns(sc.actorB),
  };
}

/**
 * Is this preview usable as a STORY? A draw whose description did not survive
 * the trust boundary has nothing to show, so the caller routes it to the
 * honest transient kind ('no-story') rather than rendering an empty card.
 */
export function previewIsUsable(sc: RegenPreview | null): boolean {
  // Every field the preview card RENDERS, not just the description: a draw that
  // kept its story but lost its option labels at the boundary would otherwise
  // render "A:  / " and, on Keep, blank all four labels of the user's game.
  // Same six fields the integration suite calls a valid scenario shape.
  const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  return !!sc && str(sc.description) && str(sc.name)
    && str(sc.row1) && str(sc.row2) && str(sc.col1) && str(sc.col2);
}

// ── Keep ───────────────────────────────────────────────────────────────────
export interface KeptFill {
  /** Present only when the caller decided (via `shouldReplaceName`) that the
   *  name should be replaced too. Absent means "leave the name field alone". */
  name?: string;
  desc: string;
  labels: { row1: string; row2: string; col1: string; col2: string };
  terms: { a: string[]; b: string[] };
  /** RED-REGEN-14/002: EXISTING chip(s), kept in `terms`, whose phrase does
   *  not occur in `desc` any more (per `termOccursIn`) — the editor shows
   *  them as "not highlighted"; the Keep note names them. */
  orphaned: { a: string[]; b: string[] };
  /** STRUCT-REGEN-19/002: EXISTING chip(s), kept in `terms`, whose phrase DOES
   *  occur in `desc` but only inside a phrase highlighted for the OTHER player
   *  (an option label, or an actor noun the draw brought), so every occurrence
   *  is on screen in that player's colour. Same family as `orphaned` — the chip
   *  paints nothing of its own — and named the same way rather than left for
   *  the reader to notice a colour they did not choose. `by`/`bySide` come from
   *  `chipPaintStates`, the pass that paints. */
  shadowed: { a: ShadowedChip[]; b: ShadowedChip[] };
  /** RED-REGEN-11/001: actor noun(s) the draw offered but the per-side
   *  `USER_TERMS_MAX` cap kept out of `terms` — empty on both sides for
   *  every draw that fit. `keepRegen` turns this into the same cap-hit
   *  wording `DescriptionEditor.addSelection` shows for a manual highlight
   *  (see `regenDroppedNote`), so this path is never silent either. */
  dropped: { a: string[]; b: string[] };
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
 * RED-REGEN-21/001: "grapheme-safe" above was a claim this code did not keep.
 * These five clamps used a local code-POINT walk, which splits any cluster
 * built from several code points (ZWJ, flags, skin tone, combining marks,
 * VS16) and persisted the broken half. They now call the same
 * `clampGraphemeSafe` the typing path uses (`DescriptionEditor`,
 * `colorTerms`, `scenarioActorNouns`, server `cleanText`) — one clamp, every
 * site, so Keep and typing cannot cut the same string differently.
 *
 * DIRECTOR'S DECISION (2026-09-03, REVISING round-6 decision 3 — RED-REGEN/001):
 * an AI action never destroys user-authored data. `SCENARIO_SCHEMA` is strict
 * (`additionalProperties:false`), so no cloud draw can ever carry
 * `actorA`/`actorB`, and bank rows have none either — every real Keep was
 * therefore sending `colorTermsA/B: []` with `allowClear:true` and PERMANENTLY
 * WIPING the user's existing highlights. Colour terms on Keep are now:
 * `existingTerms` untouched, plus any actor nouns the draw DOES supply, ADDED
 * (never replacing) via `regenKeptColorTerms` — the same function the regen
 * preview card renders with, so the preview never promises a different
 * outcome than Keep delivers (RED-REGEN/002).
 */
export function keepFill(
  preview: RegenPreview,
  replaceName: boolean,
  existingTerms: { a: readonly string[]; b: readonly string[] } = { a: [], b: [] },
): KeptFill {
  const out: KeptFill = {
    desc: clampGraphemeSafe(cleanText(preview.description ?? ''), REGEN_DESCRIPTION_MAX),
    labels: {
      row1: clampGraphemeSafe(cleanText(preview.row1 ?? ''), REGEN_LABEL_MAX),
      row2: clampGraphemeSafe(cleanText(preview.row2 ?? ''), REGEN_LABEL_MAX),
      col1: clampGraphemeSafe(cleanText(preview.col1 ?? ''), REGEN_LABEL_MAX),
      col2: clampGraphemeSafe(cleanText(preview.col2 ?? ''), REGEN_LABEL_MAX),
    },
    terms: { a: [], b: [] },
    dropped: { a: [], b: [] },
    orphaned: { a: [], b: [] },
    shadowed: { a: [], b: [] },
  };
  // RED-REGEN-14/002: judged against the CLAMPED description — the text the
  // dialog will actually hold and render, not the raw draw.
  const kept = regenKeptColorTerms(preview.actorA ?? [], preview.actorB ?? [], existingTerms.a, existingTerms.b, out.desc);
  out.terms = { a: kept.a, b: kept.b };
  out.dropped = kept.dropped;
  out.orphaned = kept.orphaned;
  // STRUCT-REGEN-19/002: shadowing can only be judged against the FULL merged
  // list the dialog will render with — the kept chips PLUS this draw's own
  // option labels — because the phrase that takes the colour is usually one of
  // those labels. Composed here exactly as `DescriptionEditor` composes it.
  const merged = mergeDescriptionTerms(
    dialogBaseColorTerms(out.labels), kept.a, kept.b, optionLabelTerms(out.labels),
  );
  const states = chipPaintStates(out.desc, merged.a, merged.b);
  const shadowedOn = (side: 'a' | 'b', chips: readonly string[]): ShadowedChip[] => {
    const existingKeys = new Set((side === 'a' ? existingTerms.a : existingTerms.b).map(colorTermKey));
    const found: ShadowedChip[] = [];
    for (const t of chips) {
      if (!existingKeys.has(colorTermKey(t))) continue; // the draw's own nouns are not kept chips
      const st = (side === 'a' ? states.a : states.b).get(colorTermKey(t));
      if (st && st.state === 'shadowed') found.push({ term: t, by: st.by, bySide: st.bySide });
    }
    return found;
  };
  out.shadowed = { a: shadowedOn('a', kept.a), b: shadowedOn('b', kept.b) };
  // A draw with no usable name must LEAVE THE NAME ALONE (this interface's own
  // contract), not blank it: saveFormModel does `action.name ?? state.name`, so
  // an empty string would wipe the user's game name instead of falling back.
  if (replaceName) {
    const drawn = clampGraphemeSafe(cleanText(typeof preview.name === 'string' ? preview.name : ''), REGEN_NAME_MAX);
    if (drawn) out.name = drawn;
  }
  return out;
}

/**
 * RED-REGEN-11/001: the ONE place `keepRegen` turns a Keep's `dropped` actor
 * noun(s) into user-facing wording — same cap, same wording template
 * (`capHitMessage`) as `DescriptionEditor.addSelection`'s manual-highlight
 * hint, so the two paths that can both hit `USER_TERMS_MAX` say the same
 * thing instead of one being silent. Returns `null` when nothing was
 * dropped (the common case — a Keep note falls back to
 * `REGEN_ANNOUNCE.keptEdit`/`keptSave` unchanged).
 */
export function regenDroppedNote(
  dropped: { a: readonly string[]; b: readonly string[] },
  orphaned: { a: readonly string[]; b: readonly string[] } = { a: [], b: [] },
  shadowed: { a: readonly ShadowedChip[]; b: readonly ShadowedChip[] } = { a: [], b: [] },
  /** What the phrases are missing from; see `orphanedNote` (STRUCT-REGEN-19/010). */
  where = 'the new story',
): string | null {
  const notes: string[] = [];
  if (dropped.a.length > 0) notes.push(capHitMessage(dropped.a, 'A'));
  if (dropped.b.length > 0) notes.push(capHitMessage(dropped.b, 'B'));
  // RED-REGEN-14/002: a kept chip the new story no longer contains is not
  // deleted (2026-09-03: Keep never destroys highlights) — but a silent inert
  // chip was the defect, so Keep says which ones and what to do.
  if (orphaned.a.length > 0) notes.push(orphanedNote(orphaned.a, 'A', where));
  if (orphaned.b.length > 0) notes.push(orphanedNote(orphaned.b, 'B', where));
  // STRUCT-REGEN-19/002: same family — the chip paints nothing of its own —
  // but the words ARE on screen, in the other player's colour, so the wording
  // names the phrase that took them instead of saying "does not appear".
  if (shadowed.a.length > 0) notes.push(shadowedNote(shadowed.a, 'A'));
  if (shadowed.b.length > 0) notes.push(shadowedNote(shadowed.b, 'B'));
  return notes.length > 0 ? notes.join(' ') : null;
}

/** A kept chip whose phrase a phrase of the OTHER player paints over. */
export interface ShadowedChip { term: string; by: string; bySide: 'A' | 'B' }

export function shadowedNote(items: readonly ShadowedChip[], player: 'A' | 'B'): string {
  const one = items.length === 1;
  const parts = items.map((i) => `"${i.term}" (inside "${i.by}", Player ${i.bySide}'s)`).join(', ');
  // Noun, verb and pronoun agree in number (the round-16 rule).
  return one
    ? `Player ${player}'s highlight ${parts} is shown in the other player's colour, because the longer phrase claims it — remove the chip, or highlight the longer phrase for Player ${player}.`
    : `Player ${player}'s highlights ${parts} are shown in the other player's colour, because the longer phrases claim them — remove the chips, or highlight the longer phrases for Player ${player}.`;
}

/**
 * `where` names the text the phrase is missing from. It defaults to "the new
 * story" — the Keep path this note was written for — and the 409 adoption path
 * passes "this description" (STRUCT-REGEN-19/010): the app put those chips on
 * the form, so it owes the same sentence Keep already gives, rather than a
 * second one written from scratch beside it.
 */
export function orphanedNote(
  terms: readonly string[],
  player: 'A' | 'B',
  where = 'the new story',
): string {
  const quoted = terms.map((t) => `"${t}"`).join(', ');
  const one = terms.length === 1;
  // CodeRabbit CLI (this branch): noun, verb and pronoun agree in number.
  return `Player ${player}'s highlight${one ? '' : 's'} ${quoted} ${one ? 'does' : 'do'} not appear in ${where}, so ${one ? 'it is' : 'they are'} shown as not highlighted — reuse the ${one ? 'phrase' : 'phrases'} in the text or remove the ${one ? 'chip' : 'chips'}.`;
}

// ── errors ───────────────────────────────────────────────────────────────────
export type RegenErrorKind = 'rate-limit' | 'timeout' | 'unavailable' | 'no-key' | 'no-story' | 'network' | 'game-gone';

/**
 * Map a response (or a thrown/aborted fetch) to one of the six outcomes a
 * RESPONSE can produce. `RegenErrorKind` has a seventh, 'game-gone', which
 * this function never returns: it is decided client-side before any request
 * is sent (App.tsx, the game vanished from the list), so there is no status
 * or body to map.
 * `status` is `null` when the request never produced a response at all
 * (network failure, or an abort — distinguished by `err`).
 *
 * RED-REGEN-21/002: a 200 with `scenario:null` is NOT one condition. The
 * route answers that shape for two categories that differ in the only way
 * the message has to get right — whether retrying can work:
 *
 *   `failure:'no-key'`  server has no credentials (`canInvent()` false,
 *                       server.ts). Persistent and admin-only-fixable; every
 *                       retry returns this same response. Reachable with the
 *                       button still visible because the capability probe
 *                       runs once per API base (App.tsx) and is not re-polled,
 *                       so credentials lost mid-session leave a stale probe.
 *   everything else     the draw itself failed this time — `timeout`,
 *                       `error`, `unparseable`, `validation-failed`,
 *                       `aborted` (server.ts's ladder). Genuinely transient:
 *                       a later draw can succeed, so "try again" is honest.
 *
 * Only `no-key` is re-routed. The transient bucket keeps `no-story` and its
 * existing wording unchanged — this distinguishes a message that was wrong,
 * it does not soften one that was right.
 */
export function regenErrorFromResponse(
  status: number | null,
  body: { scenario?: unknown; error?: unknown; failure?: unknown } | null,
  err: unknown,
): RegenErrorKind {
  if (err instanceof DOMException && err.name === 'AbortError') return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status === 404) return 'unavailable';
  // A 200 that carried no usable story is a DRAW failure, not a network one —
  // whether the server said `scenario: null` or a non-ours upstream sent a
  // malformed object. Reporting "Couldn't reach the scenario service" for a
  // request that plainly succeeded is a lie the user cannot act on.
  if (status === 200 && body && !previewIsUsable(cleanPreview(body.scenario as RegenPreview))) {
    return body.failure === 'no-key' ? 'no-key' : 'no-story';
  }
  return 'network';
}

/** Longest server-supplied 429 text the dialog will quote. Calibrated on the
 *  shipping condition: this server's own longest `error` string is 121 chars
 *  and `rateLimit`'s own 429 is 54, so nothing we send is ever truncated. */
export const REGEN_SERVER_TEXT_MAX = 200;

/**
 * Did the server actually SAY something quotable? Same test `apiClient`'s
 * `said` applies to the same `error` field (apiClient.ts, main 81e4a21): a
 * non-string is not a message, and neither is whitespace. Clamped and
 * control-stripped too, because in desktop cloud mode `apiBaseUrl` is a
 * free-form field (MenuDrawer.tsx), so this string is not always ours.
 */
function serverSaid(t: unknown): string {
  if (typeof t !== 'string') return '';
  return clampGraphemeSafe(cleanText(t), REGEN_SERVER_TEXT_MAX);
}

/** One template per kind; `rate-limit` folds in the server's own 429 body
 *  text (the standard "Too many attempts…" wording `rateLimit` sends) so the
 *  dialog states the real reason rather than a generic one — but only when
 *  the server really sent text; otherwise the em-dash would dangle over an
 *  empty tail, or render a raw `[object Object]` (BLUE-LOOP-REGEN-21). */
export const REGEN_ERROR_MESSAGES: Record<RegenErrorKind, (serverText?: unknown) => string> = {
  'rate-limit': (t) => `AI limit reached — ${serverSaid(t) || 'Too many attempts. Please wait a minute and try again.'}`,
  'timeout': () => 'This is taking longer than expected — try again?',
  'unavailable': () => "Regenerating isn't available on this server.",
  // RED-REGEN-21/002: distinct from 'unavailable' (the route is enabled, so
  // the button is legitimately there) and from 'no-story' (retrying cannot
  // help). Names the side the problem is on and omits the retry prompt.
  'no-key': () => "Regenerating isn't set up on this server — this isn't something you can retry.",
  'no-story': () => "Couldn't write a verified scenario just now — try again.",
  'network': () => "Couldn't reach the scenario service. Your text below is unchanged.",
  // BLUE-LOOP-REGEN-21: the game was deleted elsewhere while this dialog stayed
  // open (App.tsx prunes the row on a Save-Changes 404 and deliberately leaves
  // the dialog up). Nothing is unreachable, so 'network' misnamed the cause;
  // there is no matrix to rewrite a story FOR, so "try again" would lie too.
  // Names only what this dialog actually offers — read off the live DOM, which
  // has Cancel and Save Changes and no "save as new" (a first draft of this
  // string promised one, which would have been a fresh dishonesty).
  'game-gone': () => "This game was deleted elsewhere, so there's nothing to rewrite. Your text below is unchanged — copy anything you want to keep before you close this.",
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

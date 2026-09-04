/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { GamePayoffs, SimState, PresetGame, NashEquilibrium, PathSegment, ReportEnvelope, type SuggestedScenario } from './types';
import {
  PRESETS,
  EA,
  EB,
  r3,
  computeAllNE,
  describeContinua,
  computeIndifference,
  doStep,
  buildPolyStr,
  generateRandomGame,
  hasEquilibriumContinuum as computeHasEquilibriumContinuum,
  resolveProfile,
  texProb,
  // The ONE string->number conversion for typed fields. Nothing in this file may
  // call parseFloat / parseInt / Number / valueAsNumber on user-supplied text:
  // two defects came from call sites each answering "is this a number?" for
  // themselves — a pasted U+2212 minus lost on blur, and x0 = 0 discarded by a
  // falsy-zero fallback. src/test.ts asserts no such call site survives.
  commitPayoffInput,
  commitStartCoordinate,
  parseNumericInput,
  commitStepSize,
  commitStepIndex,
  precomputeThinHistory,
  replayToStep,
  type ThinSnapshot,
  fmtPayoff,
  payoffTexRhs,
} from './utils/gameEngine';
import { PlotlyView } from './components/PlotlyView';
import { indifferenceLines, neValues } from './components/equilibriumPanel';
import { cleanText, clampGraphemeSafe, wouldExceedGraphemeBudget } from './utils/textSafety';
import { safeGetItem, safeSetItem, safeRemoveItem } from './utils/safeStorage';
import { resolveReportFetchTimeoutMs } from './utils/fetchTimeout';
import { Walkthrough, type TourStep } from './components/Walkthrough';
import { CAMERA, TRACE, moveCamera } from './components/PlotlyView';
import {
  Play,
  Pause,
  RotateCcw,
  SkipForward,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  BookOpen,
  Sliders,
  Award,
  Terminal,
  Compass,
  CheckCircle2,
  Lock,
  AlertTriangle,
  User,
  LogIn,
  LogOut,
  Plus,
  Trash2,
  Pencil,
  Key,
  Mail,
  Info,
  Check,
  X,
  UserCheck,
  Sun,
  Moon,
  Menu,
  Download,
  MessageSquare,
  Star,
  Send,
  Sparkles,
  ShieldCheck,
  Maximize2,
  Minimize2
} from 'lucide-react';

import { MenuDrawer } from './components/MenuDrawer';
import { ColorCoded } from './components/ColorCoded';
import { colorTermsFor, descriptionColorTerms, dialogBaseColorTerms, regenPreviewColorTerms } from './utils/colorTerms';
import { generatedFillIsSafe, type GeneratedFill } from './utils/generateFill';
import {
  regenKeyEquals,
  regenResponseIsCurrent,
  keepFill,
  shouldReplaceName,
  regenErrorFromResponse,
  cleanPreview,
  REGEN_ERROR_MESSAGES,
  REGEN_ANNOUNCE,
  type RegenKey,
  type RegenPreview,
  type RegenErrorKind,
} from './utils/scenarioRegen';
import { DescriptionEditor } from './components/DescriptionEditor';
import { DownloadModal } from './components/DownloadModal';
import { OtherAccountsNotice } from './components/OtherAccountsNotice';
import { AdminDashboard } from './components/AdminDashboard';
import katex from 'katex';

/**
 * RED-APP-7/004: the four option-label inputs' native `maxLength={40}`
 * enforced the same 40-unit budget as the server, but by raw UTF-16 code
 * unit count with NO grapheme awareness — a typed/pasted ZWJ emoji sequence
 * (or anything astral) straddling the 40th unit got cut mid-grapheme
 * client-side, before the server's already-grapheme-safe `cleanLabels`
 * clamp ever saw the original, un-truncated string. Enforced here instead,
 * in `onChange`, with the exact same boundary logic the server uses
 * (`clampGraphemeSafe`, shared via `src/utils/textSafety.ts` so the two
 * can never drift apart again).
 */
const clampLabelInput = (v: string) => clampGraphemeSafe(v, 40);

/**
 * RED-APP-8/002 + RED-APP-8/003: the `onChange`-based clamp above (#101's
 * fix for RED-APP-7/004) introduced two NEW regressions relative to the
 * native `maxLength` it replaced — both from the same root cause, an
 * unconditional post-hoc React state rewrite of a value the browser itself
 * already produced:
 *
 *  - 002: a native `input` event fires on EVERY keystroke of an open IME
 *    composition (CJK/JP/KR), not just on commit. Clamping mid-composition
 *    fights the IME — the DOM value stops growing while the composition's
 *    own internal buffer keeps growing, desyncing the two.
 *  - 003: the FIRST time the clamp actually narrows a value, the browser's
 *    native Undo (Cmd/Ctrl+Z) goes permanently inert for that field —
 *    writing a DIFFERENT string back into a controlled input breaks the
 *    correspondence between the undo stack and the displayed value.
 *
 * Both are closed by moving enforcement from `onChange` (after the browser
 * has already committed the edit) to `onBeforeInput` (before it has):
 * `preventDefault()` here stops the browser from performing an insertion
 * that would push the value over the grapheme-safe budget, so the browser's
 * OWN undo-stack-tracked edit either happens (value stays ≤40 units, exactly
 * what a real edit produced) or never happens at all (no `input` event, no
 * `onChange`, nothing for undo to have to reconcile).
 *
 * `insertCompositionText` — every keystroke of an OPEN composition — is
 * defined by the spec as NOT cancelable, so `preventDefault()` here is a
 * silent no-op for it: composition passes through completely untouched,
 * matching native `maxLength`'s own deferred-enforcement behavior. The
 * eventual COMMITTED string (compositionend) still needs a clamp, since
 * `onBeforeInput` never saw it coming — `onChange`'s clamp stays, but now
 * skips while `e.nativeEvent.isComposing` is true (only the OLD unconditional
 * form was the bug) so it never touches a value mid-composition, only the
 * final committed one.
 */
function clampLabelBeforeInput(e: React.FormEvent<HTMLInputElement>): void {
  const ne = e.nativeEvent as InputEvent;
  if (ne.isComposing) return; // not cancelable anyway — let composition through untouched
  const target = e.target as HTMLInputElement;
  // RED-APP-9/003: the boundary math itself (read the prospective value,
  // compare it to its own grapheme-safe clamp) now lives once in
  // `wouldExceedGraphemeBudget` (src/utils/textSafety.ts), shared with the
  // Game Name inputs (same 40-unit budget, reusing THIS function directly)
  // and the Description textarea (DescriptionEditor.tsx's own
  // onBeforeInput, at its own maxLength) — a second hand-copied
  // implementation is exactly the kind of drift this codebase has been
  // burned by before.
  if (wouldExceedGraphemeBudget(target, ne.data, 40)) {
    e.preventDefault();
  }
}

// Typeset LaTeX inline via KaTeX (self-hosted, works offline)
function MathTex({ tex, className }: { tex: string; className?: string }) {
  const html = useMemo(
    () => katex.renderToString(tex, { throwOnError: false }),
    [tex]
  );
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Color player-relevant phrases in model- or user-written PLAIN TEXT.
 *
 * Built-in preset descriptions carry trusted app-authored HTML spans, but the
 * AI explanation and user descriptions are rendered as text precisely so they
 * cannot inject markup. This applies the same player-a / player-b coloring as
 * a deterministic post-pass: known terms are matched (case-insensitively, at
 * word boundaries, longest first) and wrapped in React elements — the text
 * itself is never interpreted as HTML.
 */
// ColorCoded moved to its own component so the workspace-center library
// (MenuDrawer) can color saved-game text with the exact same rules.

/**
 * Is this report envelope one we may show and prefill from?
 *
 * TWO call sites ask this and they had DRIFTED, which is the whole bug. The
 * display path was taught about 'template' when the rung-3 flag shipped; the
 * "generate a new game" dialog was not, and kept requiring source === 'llm'.
 * Production runs rung 3, which NEVER emits 'llm' — so that dialog threw away
 * a perfectly good scenario on every single generation and told the user "the
 * AI scenario isn't available right now". Not intermittent: 100%, since the
 * flag flip.
 *
 * 'template' envelopes carry NO validation object, and that is correct rather
 * than missing: their sentences are rendered from the solver, so there are no
 * model claims left to check, and the scenario they carry was already put
 * through validateScenario + scenarioIsClaimFree + the direction checks
 * SERVER-SIDE before being included. Requiring `validation.ok` of them asks for
 * a receipt from a gate that had nothing to weigh.
 *
 * One predicate, so the next rung cannot desynchronise them again.
 */
export function envelopeIsTrustworthy(env: ReportEnvelope | null | undefined): boolean {
  if (!env?.report) return false;
  if (env.source === 'template') return true;
  return env.source === 'llm' && env.validation?.ok === true;
}

/**
 * A legend swatch drawn as a shape, not typed as an emoji.
 *
 * The legend used 🔴 🔵 🟣 for three of its entries. Emoji are rendered by the
 * PLATFORM's font, so they carried a shading and outline nothing on the plot
 * has, they changed appearance between macOS, Windows and Android, and none of
 * them could take the app's own colours in dark mode. The purple one was also
 * simply WRONG: a mixed equilibrium is drawn on the plot as a DIAMOND, exactly
 * like a pure one, and only the colour distinguishes them — so the legend was
 * teaching a reader to look for a circle that is not there.
 *
 * Every shape here mirrors what Plotly actually draws: a diamond for both
 * equilibrium kinds, a dashed rectangle for the domain and corridor boxes, an
 * open ring for the translucent ghost markers, a rule for the move paths, and
 * a soft-cornered patch for a payoff SURFACE — a surface is a sheet, so a patch
 * reads truer than a sphere ever did.
 *
 * Everything is stroked and filled with `currentColor`, so each entry inherits
 * the colour token its own text already uses and both themes come out right
 * without a second palette to keep in step.
 */
function LegendSwatch({ shape }: { shape: 'surface' | 'diamond' | 'ring' | 'dashed' | 'line' }) {
  const common = { width: 11, height: 11, viewBox: '0 0 12 12', 'aria-hidden': true as const,
    className: 'shrink-0 overflow-visible' };
  switch (shape) {
    case 'surface':
      // A patch of sheet, lightly translucent like the plotted surfaces.
      return <svg {...common}><rect x="0.5" y="1.5" width="11" height="9" rx="2" fill="currentColor" opacity="0.85" /></svg>;
    case 'diamond':
      // The plot draws BOTH equilibrium kinds as diamonds; colour is the only
      // difference, which is why this shape is shared.
      return <svg {...common}><path d="M6 0.5 11.5 6 6 11.5 0.5 6Z" fill="currentColor" /></svg>;
    case 'ring':
      // Ghost markers are translucent and hollow-reading on the plot.
      return <svg {...common}><circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
    case 'dashed':
      return <svg {...common}><rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.6 2" /></svg>;
    case 'line':
    default:
      return <svg {...common}><line x1="0.5" y1="6" x2="11.5" y2="6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>;
  }
}

/**
 * Structural equality on the 8 payoff numbers — the whole content of a
 * `GamePayoffs`. Used ONLY to detect whether the game changed out from under
 * an in-flight `/api/report` request (RED-APP-3 finding 001): the matrix on
 * screen and the request's own captured payoffs are the same object only
 * within one render, so this compares by VALUE, never by reference.
 */
export function payoffsEqual(a: GamePayoffs, b: GamePayoffs): boolean {
  return a.a11 === b.a11 && a.a12 === b.a12 && a.a21 === b.a21 && a.a22 === b.a22
      && a.b11 === b.b11 && a.b12 === b.b12 && a.b21 === b.b21 && a.b22 === b.b22;
}

/**
 * WAI-ARIA APG "Tab is confined to the dialog while it is open" — the same
 * rule #90 already implemented once, inline, for the expand-log dialog
 * (`logDialogRef`, see the "Escape closes the expanded log" effect above).
 *
 * RED-APP-5 finding 002 (round 5): the app's other four `role="dialog"
 * aria-modal="true"` surfaces (Feedback, Auth, Save, Edit) had NO trap at
 * all, so repeatedly pressing Tab walked focus off the dialog and onto the
 * page behind the backdrop — concretely, onto the floating "Feedback"
 * button, where an Enter press opened a SECOND `aria-modal="true"` dialog on
 * top of the still-open first one. `aria-modal="true"` exists specifically
 * to promise assistive tech that the rest of the document is inert while a
 * modal is open; a real Tab trap is what makes that promise true, not just
 * declared.
 *
 * Deliberately does NOT also handle Escape: the four dialogs above already
 * share one central "close whichever foreground modal is open on Escape"
 * effect (see `isFeedbackOpen`/`isSaveModalOpen`/`isAuthModalOpen`/
 * `isEditModalOpen` there); duplicating Escape handling here would race that
 * effect's `document`-level listener against this hook's own, in an
 * unspecified DOM order, for no gain.
 *
 * DOES move initial focus into the dialog on open (CodeRabbit review on PR
 * #91, after the RED-APP-5/002 fix above shipped): only Feedback sets its
 * own `autoFocus` field; Auth, Save and Edit have none, so on those three
 * focus was left stranded on the background opener until the user's FIRST
 * Tab press — no signal at all that a modal had opened, for a screen reader
 * or for someone tabbing who has not yet reached the dialog. Fixed by
 * focusing the first enabled control ONLY when focus is not ALREADY inside
 * the dialog: React commits an element's `autoFocus` during the SAME commit
 * phase as this effect's dependency change, strictly before this PASSIVE
 * effect runs, so by the time this checks `document.activeElement`,
 * Feedback's textarea is already focused and this is a no-op for it — the
 * existing in-dialog autofocus behavior is unchanged, exactly what
 * CodeRabbit asked for. Does not restore focus on close (unmeasured,
 * narrower than this finding).
 */
function getModalFocusables(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"]), input, select, textarea, a[href]'),
  ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
}

function useModalTabTrap(open: boolean, containerRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) {
      getModalFocusables(container)[0]?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = getModalFocusables(container);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      // Also catches focus already OUTSIDE the container (the exact leak
      // this finding reproduced: N tabs in, focus lands past `last` on a
      // background element) — not just the two boundary elements, so a
      // focus that has already escaped is pulled back in rather than only
      // preventing the NEXT escape.
      if (!container.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, containerRef]);
}

/**
 * RED-APP-6/003: `fetch(getApiUrl('/api/report'), ...)` had no `signal`
 * anywhere in this file (a whole-file grep for `AbortController`/`signal:`
 * returned zero matches). A CLOSED connection (killed server, refusing
 * proxy) already rejects promptly and the existing `catch` handles it fine;
 * a STALLED one — a captive portal, a hung reverse proxy, a flaky link that
 * drops packets without a RST — neither resolves nor rejects, ever, and
 * nothing forced it to. 22s comfortably exceeds this app's own measured
 * report latency (low single-digit seconds; session history) while slightly
 * exceeding the server's own scenario-draw deadline (`SCENARIO_DEADLINE_MS`,
 * 20s default, server.ts) per the finding's own guidance ("match or slightly
 * exceed" the server side), and still bounds a genuinely stuck request. The abort surfaces as a
 * `DOMException` named `AbortError` in the caller's `catch`, distinguishable
 * from an ordinary network failure so the UI can say which happened.
 *
 * CodeRabbit finding (this branch): `fetch()`'s own promise resolves once
 * RESPONSE HEADERS arrive, not once the body is fully read — a first draft
 * cleared the abort timer in a `.finally()` chained directly onto the
 * `fetch()` call, which fires the instant headers land, BEFORE the caller
 * ever calls `res.json()`. A connection that answers promptly with headers
 * and then stalls mid-body (the exact "flaky link" case this fix exists
 * for) would leave `res.json()` pending with no timer left to abort it.
 * The timer must stay armed until the CALLER finishes reading the body, so
 * `clear()` is returned separately and called from the caller's own
 * `finally` block, alongside its other per-request cleanup.
 */
// CI's smoke suite can compile a shorter timeout into its throwaway test
// bundle so the two stalled-request wording checks do not each spend 22 real
// seconds. Ordinary local and production builds leave the variable unset and
// therefore exercise the shipping 22-second value. This is intentionally a
// Vite build-time variable: dist/ is static, so a server-process environment
// variable cannot change code that is already running in the browser.
const REPORT_FETCH_TIMEOUT_MS = resolveReportFetchTimeoutMs(
  typeof import.meta.env === 'undefined'
    ? undefined
    : import.meta.env.VITE_E2E_FETCH_TIMEOUT_MS,
);

// `timeoutMs` defaults to REPORT_FETCH_TIMEOUT_MS; exported and parameterized
// only so src/fetchtimeout.test.ts can exercise the real logic with a short
// timeout against a real (stalled-body) HTTP server, instead of waiting out
// the full 22s or re-deriving the logic in a second, drifting copy.
export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  controller: AbortController,
  timeoutMs: number = REPORT_FETCH_TIMEOUT_MS,
): { promise: Promise<Response>; clear: () => void } {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { promise: fetch(url, { ...init, signal: controller.signal }), clear: () => clearTimeout(timer) };
}

export default function App() {
  const isElectron = typeof window !== 'undefined' && window.navigator?.userAgent?.toLowerCase().includes('electron');
  const isElectronMac = isElectron && window.navigator?.userAgent?.toLowerCase().includes('mac');
  // Touch devices (phones + tablets) get the compact 2-row header; desktops get the flex row
  const isTouchDevice = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

  // ── Fullscreen detection (Electron macOS — hide traffic-light spacer when fullscreen) ──
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isElectronMac) return;
    const handler = (e: Event) => setIsFullscreen((e as CustomEvent).detail as boolean);
    window.addEventListener('electron-fullscreen-change', handler);
    return () => window.removeEventListener('electron-fullscreen-change', handler);
  }, [isElectronMac]);

  // ── Web display scale ────────────────────────────────────────────────────
  // The site historically rendered at 133% via a non-standard `zoom` hack.
  // Scaling the root font-size instead scales every rem-based size (text,
  // spacing, panels) together without breaking Plotly's pointer hit-testing.
  // 125% on top of the 15px type-scale base matches the old effective sizes.
  useEffect(() => {
    if (!isElectron) {
      document.documentElement.style.fontSize = '125%';
    }
  }, [isElectron]);

  // ── Theme State ────────────────────────────────────────────────────────────
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return safeGetItem('nash_sim_theme') === 'dark';
  });

  useEffect(() => {
    // RED-APP-8/004: this effect fires unconditionally on first mount, so an
    // unguarded setItem throwing here (a real QuotaExceededError, e.g. old
    // Safari private mode) used to blank the ENTIRE app with no error
    // boundary to catch it. The in-memory darkMode state and the classList
    // toggle below still do the visible work; persistence is best-effort.
    if (darkMode) {
      document.documentElement.classList.add('dark');
      safeSetItem('nash_sim_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      safeSetItem('nash_sim_theme', 'light');
    }
    // Desktop app: keep the NATIVE window background in step with the theme.
    // It is what shows through when a drag-resize outpaces the repaint, so a
    // stale value flashes a white strip in dark mode. Colors mirror the page
    // root (bg-slate-50 / dark:bg-slate-950). No-op in the browser.
    (window as { nashDesktop?: { setBackgroundColor: (c: string) => void } })
      .nashDesktop?.setBackgroundColor(darkMode ? '#020617' : '#f8fafc');
  }, [darkMode]);

  // ── Authentication & Saved Games States ────────────────────────────────────
  const [dbMode, setDbMode] = useState<'local' | 'cloud'>(() => {
    return (safeGetItem('nash_sim_db_mode') as 'local' | 'cloud') || 'local';
  });
  const [apiBaseUrl, setApiBaseUrl] = useState<string>(() => {
    const cached = safeGetItem('nash_sim_api_base');
    if (cached && (cached.includes('ais-pre-') || cached.includes('243079162760') || cached.includes('988056159702') || cached.includes('194708291738'))) {
      safeSetItem('nash_sim_api_base', 'https://nash-equilibrium-simulator.com');
      return 'https://nash-equilibrium-simulator.com';
    }
    return cached || 'https://nash-equilibrium-simulator.com';
  });

  const getApiUrl = (path: string) => {
    if (isElectron && dbMode === 'cloud') {
      const base = apiBaseUrl.trim().replace(/\/$/, '');
      return `${base || 'https://nash-equilibrium-simulator.com'}${path}`;
    }
    return path;
  };

  const [authToken, setAuthToken] = useState<string | null>(() => {
    const key = (safeGetItem('nash_sim_db_mode') || 'local') === 'cloud' ? 'nash_sim_token_cloud' : 'nash_sim_token_local';
    return safeGetItem(key) || safeGetItem('nash_sim_token');
  });

  const updateAuthToken = (token: string | null) => {
    setAuthToken(token);
    const key = dbMode === 'cloud' ? 'nash_sim_token_cloud' : 'nash_sim_token_local';
    if (token) {
      safeSetItem(key, token);
    } else {
      safeRemoveItem(key);
      safeRemoveItem('nash_sim_token'); // clear legacy as well
    }
  };

  const handleSwitchDbMode = (mode: 'local' | 'cloud') => {
    setDbMode(mode);
    safeSetItem('nash_sim_db_mode', mode);
    const key = mode === 'cloud' ? 'nash_sim_token_cloud' : 'nash_sim_token_local';
    const savedToken = safeGetItem(key);
    setAuthToken(savedToken);

    // Reset basic session users or load correct data
    if (!savedToken) {
      setUser(null);
      setUserCustomGames([]);
    }
  };

  const [user, setUser] = useState<{ id: string; username: string; email: string } | null>(null);
  const [userCustomGames, setUserCustomGames] = useState<any[]>([]);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);

  // Auth Modal States
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'verify' | 'forgot' | 'reset-password'>('login');

  // Save Game Modal States
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDesc, setSaveDesc] = useState('');
  /** Option names for the save dialog: typed by the user, or prefilled from an
   *  invented scenario the user chose to keep. */
  const [saveLabels, setSaveLabels] = useState({ row1: '', row2: '', col1: '', col2: '' });
  /** The user's own colour highlights for the description they are writing.
   *  Never sent to the model — see src/utils/colorTerms.ts. */
  const [saveTerms, setSaveTerms] = useState<{ a: string[]; b: string[] }>({ a: [], b: [] });
  // "Generate a game for me" inside the save modal: which equilibrium
  // structure to roll, whether a roll+AI-description round trip is in flight,
  // and the outcome line shown under the controls.
  const [generateKind, setGenerateKind] = useState<'pure' | 'mixed'>('pure');
  const [generateLoading, setGenerateLoading] = useState(false);
  const [generateNote, setGenerateNote] = useState('');

  // Edit dialog for an already-saved game. Separate state from the save dialog
  // rather than shared: the two are open in different situations and reusing
  // one set of fields would let a half-typed new game leak into an edit.
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editGameId, setEditGameId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editLabels, setEditLabels] = useState({ row1: '', row2: '', col1: '', col2: '' });
  const [editTerms, setEditTerms] = useState<{ a: string[]; b: string[] }>({ a: [], b: [] });
  const [editError, setEditError] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);
  /**
   * Set when the visitor jumps from the save modal to sign in. The save modal
   * has to CLOSE for that jump (both modals sit at the same z-index, z-[65],
   * so the later-rendered save dialog would paint over the auth dialog), and
   * this is what brings it back — fields intact — the moment a token lands.
   * Cleared whenever the auth modal is dismissed without signing in.
   */
  const resumeSaveAfterAuthRef = useRef(false);
  /**
   * RED-APP-7/001: the Edit dialog's own analogue of `resumeSaveAfterAuthRef`
   * — set when a mid-session token expiry (or any other 401) sends the user
   * from the Edit dialog to Sign In. Same reason for existing: the Edit and
   * Auth dialogs sit at the same z-index (z-[65]), so Edit has to CLOSE for
   * the jump, and this is what reopens it — editName/editDesc/editLabels/
   * editTerms are untouched by the close (they live in their own state, not
   * reset on close), so the user's typed text is exactly as they left it.
   * Cleared whenever the auth modal is dismissed without signing in.
   */
  const resumeEditAfterAuthRef = useRef(false);
  // Set when "Save this scenario with the game" routes through the save modal
  // (preset or unsaved matrix): the scenario only becomes real when that save
  // completes, so the explanation regenerates there — from the fields as
  // actually submitted, since the user may have edited them in the modal.
  const regenExplanationAfterSaveRef = useRef(false);
  /**
   * RED-APP-9/002: one id per Save-dialog SUBMISSION ATTEMPT (not per
   * keystroke, not per dialog open) — minted lazily on the first submit
   * inside `handleSaveGameSubmit`, then reused unchanged on every retry
   * (including the resume-after-re-auth path at the effect just below,
   * which reopens the SAME in-progress save rather than starting a new
   * one) so a dropped response followed by a retry sends the server the
   * same idempotency key both times. Reset to null wherever a dialog open
   * means "start saving something new" (a fresh "Save Preset" click, or
   * "Save this scenario with the game") so that case mints its own id
   * rather than colliding with a previous, unrelated save.
   */
  const saveRequestIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Watching the token rather than any one success handler means the save
    // modal comes back regardless of which path produced the sign-in (login,
    // or register + verification).
    if (authToken && resumeSaveAfterAuthRef.current) {
      resumeSaveAfterAuthRef.current = false;
      setSaveError('');
      setIsSaveModalOpen(true);
    }
    if (authToken && resumeEditAfterAuthRef.current) {
      resumeEditAfterAuthRef.current = false;
      setEditError('');
      setIsEditModalOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  /**
   * The save form's CURRENT name/description/labels, readable from async code.
   *
   * `handleGenerateGame` awaits a report call (2-6s against the live model)
   * before deciding whether to prefill these fields. Reading `saveName` /
   * `saveDesc` / `saveLabels` through the function's own closure would see
   * them as of the CLICK, not as of whenever the await resolves — so text the
   * user types DURING the wait would not be seen as "already there" and could
   * still be silently overwritten. Kept in sync on every render instead.
   *
   * `useLayoutEffect`, NOT `useEffect` (CodeRabbit finding, PR #87 re-review
   * — same shape as `payoffsRef` above). A PASSIVE effect runs asynchronously
   * after paint, so there is a real window — between React committing a
   * keystroke's state update and that effect actually running — during which
   * `saveFieldsRef.current` is STALE. If `handleGenerateGame`'s report
   * response happens to resolve inside that window, it reads the OLD field
   * values and can approve overwriting text the user just typed, which is
   * exactly the class of bug this ref exists to close. `useLayoutEffect`
   * fires synchronously right after the commit, before the browser paints and
   * long before any network response can possibly resolve, so there is no
   * window left for an async callback to land in.
   */
  const saveFieldsRef = useRef({ name: saveName, desc: saveDesc, labels: saveLabels });
  useLayoutEffect(() => {
    saveFieldsRef.current = { name: saveName, desc: saveDesc, labels: saveLabels };
  }, [saveName, saveDesc, saveLabels]);
  /**
   * What the LAST successful Generate call itself wrote into the save form —
   * `null` until the first fill. Lets a re-roll ("Generate" clicked again,
   * fields still holding the PREVIOUS AI story untouched) recognise its own
   * prior output as safe to replace, while text the user typed by hand is not.
   */
  const lastGeneratedFillRef = useRef<GeneratedFill | null>(null);

  /**
   * "Regenerate scenario" (FEATURE-REGEN, flag `NASH_SCENARIO_REGEN`): ask the
   * model for a NEW description + option labels + colour labelling for the
   * SAME payoff matrix, preview it in the dialog it was asked from, Keep or
   * Discard. Payoffs are never touched by this feature — see
   * `src/utils/scenarioRegen.ts` for the pure predicates this state machine
   * is built from.
   *
   * `capabilities.scenarioRegen` gates VISIBILITY only (the server 404s the
   * route independently when the flag is off) — probed once per API base so
   * a desktop app pointed at a different server (dbMode/apiBaseUrl) re-checks.
   */
  const [capabilities, setCapabilities] = useState<{ scenarioRegen: boolean }>({ scenarioRegen: false });
  useEffect(() => {
    let cancelled = false;
    fetch(getApiUrl('/api/health'))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setCapabilities(j?.capabilities ?? { scenarioRegen: false }); })
      .catch(() => { if (!cancelled) setCapabilities({ scenarioRegen: false }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbMode, apiBaseUrl]);

  const [regen, setRegen] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    preview: RegenPreview | null;
    error: RegenErrorKind | null;
    note: string;
  }>({ status: 'idle', preview: null, error: null, note: '' });
  // SEPARATE from requestGenerationRef (see the doc comment on that ref
  // above): bumping the shared counter from a dialog would leave an
  // in-flight "Explain this game" spinner permanently stuck, because its own
  // `finally` only clears loading when its generation is still current.
  const regenGenerationRef = useRef(0);
  // Same-tick double-click / Enter-repeat idempotence — a ref because it must
  // be readable synchronously inside the handler's own first line, before any
  // state update has committed.
  const regenInFlightRef = useRef(false);
  const regenControllerRef = useRef<AbortController | null>(null);
  // Focus restore target after Keep/Discard unmounts the preview card. Only
  // one dialog is ever open at a time, so one ref suffices.
  const regenButtonRef = useRef<HTMLButtonElement>(null);
  /**
   * The game the dialog CURRENTLY showing is for, mirrored every render (same
   * `useLayoutEffect`-before-paint trick as `payoffsRef`) so an async regen
   * response can tell — synchronously, with no stale closure — whether it
   * still describes what's on screen. `null` when neither dialog is open.
   */
  const regenCurrentKeyRef = useRef<RegenKey | null>(null);
  useLayoutEffect(() => {
    regenCurrentKeyRef.current = isEditModalOpen && editGameId
      ? { kind: 'edit', gameId: editGameId }
      : isSaveModalOpen
      ? { kind: 'save', payoffs }
      : null;
  });
  /**
   * DIRECTOR'S DECISION (2026-09-03): Keep replaces the game NAME too, unless
   * the user typed into the name field during this dialog session. "Typed"
   * is decided the same way `generatedFillIsSafe` decides a field is safe to
   * overwrite: each baseline ref below holds the last value that was NOT
   * typed by the user (blank on a fresh dialog, the existing game's name on
   * Edit, or whatever a prefill/Generate/Keep itself just wrote) — every site
   * that programmatically sets a name field updates the matching baseline in
   * the SAME statement, so the two can never drift. If the live field still
   * equals its baseline, the user never touched it and Keep may replace it;
   * the moment it differs, the user's own typing wins and Keep leaves it.
   */
  const saveNameBaselineRef = useRef('');
  const editNameBaselineRef = useRef('');

  // Feedback Modal States
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackEmail, setFeedbackEmail] = useState('');
  const [feedbackRating, setFeedbackRating] = useState(0);
  const [feedbackHoverRating, setFeedbackHoverRating] = useState(0);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackSuccess, setFeedbackSuccess] = useState('');
  const feedbackSubmittedRef = useRef(false);
  const feedbackLastClosedRef = useRef(0);

  // Auth Inputs
  const [authUsername, setAuthUsername] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Fetch Session User and Games
  useEffect(() => {
    if (authToken) {
      fetch(getApiUrl('/api/auth/me'), {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error('Session invalid');
        })
        .then((data) => {
          setUser(data);
        })
        .catch(() => {
          updateAuthToken(null);
          setUser(null);
        });
    } else {
      setUser(null);
    }
  }, [authToken, dbMode, apiBaseUrl]);

  /**
   * RED-APP-9/001: a 404 from PATCH/DELETE /api/games/:id (another tab,
   * profile, or device already deleted the row) is the server telling this
   * client, authoritatively, that its local list is stale — before this fix
   * neither failure path acted on that, so a deleted game's row stayed a
   * permanent phantom until a full reload. Both 404 handlers below call this
   * SAME re-fetch the initial-mount effect uses, so "the list has been
   * refreshed" is never just a local filter guessing at the truth — it is
   * grounded in a fresh server read every time.
   */
  const refetchUserGames = useCallback(async () => {
    if (!authToken) { setUserCustomGames([]); return; }
    try {
      const res = await fetch(getApiUrl('/api/games'), {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      setUserCustomGames(res.ok ? await res.json() : []);
    } catch (err) {
      console.error('Error fetching custom games:', err);
    }
  }, [authToken, apiBaseUrl]);

  useEffect(() => {
    if (authToken && user) {
      void refetchUserGames();
    } else {
      setUserCustomGames([]);
    }
  }, [authToken, user, dbMode, apiBaseUrl, refetchUserGames]);

  // ── Preset Selector State ──────────────────────────────────────────────────
  const [activePreset, setActivePreset] = useState<string>('bos');

  // ── Payoff Values State ────────────────────────────────────────────────────
  const [payoffs, setPayoffs] = useState<GamePayoffs>({
    a11: 2, b11: 1, a12: 0, b12: 0,
    a21: 0, b21: 0, a22: 1, b22: 2,
  });
  // Always the LATEST payoffs, readable from inside an async callback whose
  // own closure captured an OLDER value. RED-APP-3 finding 001:
  // `fetchLlmExplanation`'s closure captures `payoffs` at the moment the
  // button was clicked; by the time a slow `/api/report` response lands, the
  // component may have re-rendered several times with a DIFFERENT game on
  // screen, and that closure has no way to see it. A ref updated on every
  // render is the standard way to give an async callback a window onto
  // "now" instead of "when I started".
  //
  // Written from `useLayoutEffect`, NOT assigned directly in the render
  // body (CodeRabbit finding, this branch): writing to a ref DURING render
  // is a React purity violation — a render that is started but never
  // committed (React can and does throw away speculative renders) would
  // still have mutated `payoffsRef.current`, leaving it holding payoffs
  // that were never actually shown. `useLayoutEffect` fires synchronously
  // right after a render COMMITS, before the browser paints and long before
  // any network response can possibly resolve, so it closes the same gap
  // `fetchLlmExplanation` needs without ever running from a discarded
  // render.
  const payoffsRef = useRef(payoffs);
  useLayoutEffect(() => { payoffsRef.current = payoffs; });

  // CodeRabbit finding on this branch (App.tsx:924): payoff-value equality
  // alone is not a sufficient identity check for a report request. Two
  // saved games can share IDENTICAL payoff numbers while being different
  // games (different labels/description) -- payoffsEqual alone would treat
  // a stale response for game A as still valid once the user switches to a
  // same-matrix game B. And two requests fired for the SAME game (e.g. two
  // quick "Regenerate" clicks) can resolve out of order -- the FIRST
  // request's late response could overwrite the SECOND (more recent, more
  // wanted) one even though both are technically "for this game".
  //
  // A monotonic generation counter closes both: bumped whenever the
  // report's underlying identity changes (the payoffs-change effect below)
  // AND at the start of every individual request (fetchLlmExplanation),
  // so two requests for the SAME unchanged game still get different
  // numbers -- the later one always wins regardless of arrival order, and
  // a stale request compares its captured number against the LATEST one,
  // not just the latest NUMBERS. Kept alongside payoffsEqual, not instead
  // of it -- belt and braces: a bug in the bump logic would leave
  // payoffsEqual as a second, independent line of defense against the
  // cross-game case finding 001 already covers.
  const requestGenerationRef = useRef(0);
  // RED-APP-7/002: fetchFreshScenario used to share requestGenerationRef with
  // fetchLlmExplanation. The two buttons are not disabled by the same
  // condition ("New AI scenario" checks `llmLoading || scenarioLoading`;
  // "Regenerate" checked `llmLoading` only), so a real user could click
  // Regenerate while a scenario invention was in flight -- that click bumped
  // the SHARED counter, and the stale scenario request's own `finally`
  // (`myGeneration === requestGenerationRef.current`) then never matched
  // again, so `scenarioLoading` stuck `true` forever, even after the
  // request it was guarding had long since settled. Same fix shape as
  // `regenGenerationRef` above (a save-triggered regeneration must not
  // permanently stick "Explain this game"'s own spinner): a SEPARATE
  // counter, so bumping one request kind's generation can never defeat the
  // other kind's own `finally`. Both counters are still bumped together by
  // the payoffs-change effect below, so a game switch invalidates BOTH.
  const scenarioGenerationRef = useRef(0);
  // RED-APP-6/003: fetchLlmExplanation/fetchFreshScenario had no
  // AbortController anywhere -- a request that neither resolves nor rejects
  // (a stalled connection, not a closed one -- a captive portal or a hung
  // reverse proxy, as opposed to a killed server, which `fetch` already
  // rejects promptly) left `llmLoading`/`scenarioLoading` stuck `true`
  // forever, with no timer anywhere to force it back. Every in-flight
  // report-family controller is tracked here so the payoffs-change effect
  // below (and unmount) can abort whatever is still outstanding, instead of
  // only relying on the generation check to make a late response inert.
  const inFlightReportControllersRef = useRef<Set<AbortController>>(new Set());

  const [rawPayoffs, setRawPayoffs] = useState<Record<keyof GamePayoffs, string>>({
    a11: '2', b11: '1', a12: '0', b12: '0',
    a21: '0', b21: '0', a22: '1', b22: '2',
  });

  // Timer ref to reset empty/partial inputs to "0" after 2 seconds of inaction
  const inactiveTimersRef = useRef<Record<string, any>>({});

  useEffect(() => {
    return () => {
      if (inactiveTimersRef.current) {
        Object.values(inactiveTimersRef.current).forEach(clearTimeout);
      }
    };
  }, []);

  // ── Simulation Settings State ──────────────────────────────────────────────
  const [firstMover, setFirstMover] = useState<'A' | 'B'>('A');
  /**
   * The parameters the CURRENT simState was produced with.
   *
   * Every panel that narrates a FINISHED run must read these, never live React
   * state. Two defects came from the gap: editing a matrix cell repointed the
   * geometry while the run stayed frozen, and clicking "Player B" under Who
   * moves first rewrote the history of a run A had already completed — the box
   * said "Player B moved first and realised 1.000" over a log that still read
   * "Player A moves first", and the report committed to the opposite corner
   * from the one the box named. Guarding each control that WRITES this state
   * missed the mover toggle; guarding the READ covers every control at once,
   * including ones added later.
   */
  const [runCtx, setRunCtx] = useState<{
    payoffs: GamePayoffs; firstMover: 'A' | 'B'; shrinkStep: number;
    stepMode: 'shrink' | 'regret'; allNE: NashEquilibrium[]; committedNE: NashEquilibrium | null;
  } | null>(null);
  const [trackingMode, setTrackingMode] = useState<'A' | 'B' | 'both'>('A');
  const [shrinkStep, setShrinkStep] = useState<number>(0.1);
  const [shrinkStepRaw, setShrinkStepRaw] = useState<string>('0.100');
  // Convergence method: fixed domain-shrink/bisection vs opponent's-regret stepping
  const [stepMode, setStepMode] = useState<'shrink' | 'regret'>('shrink');
  const [speed, setSpeed] = useState<number>(5);

  // Initial Coordinates States
  const [x0, setX0] = useState<string>('0.217');
  const [y0, setY0] = useState<string>('0.217');

  // Custom stepper for the start-point fields (replaces the native spinners)
  const stepStartPoint = (axis: 'x' | 'y', dir: 1 | -1) => {
    const base = commitStartCoordinate(axis === 'x' ? x0 : y0);
    const next = Math.max(0, Math.min(1, Math.round((base + dir * 0.01) * 1000) / 1000));
    (axis === 'x' ? setX0 : setY0)(next.toFixed(3));
    setInitialized(false);
  };

  /**
   * Write the COMMITTED start coordinate back into the field.
   *
   * Patch 1 gave every numeric field one parser, but only three of its four
   * sites also wrote the committed value back. The matrix cells canonicalise on
   * blur, the step-size box canonicalises on blur, and the x0/y0 SPINNER
   * canonicalises (stepStartPoint already rounds and calls setX0) — but typing
   * into x0/y0 did not, so the field kept the raw string forever while every
   * computation used the clamped value. Typing "2" into a box whose own
   * attributes say max="1.0" left it reading 2 while the readout showed 1.000
   * and the log opened "Start (1.000, 0.217)"; clearing it left an invisible
   * 0.217 the user never typed. Three panels, two start points, no correction
   * on screen.
   */
  const commitStartField = (axis: 'x' | 'y') => {
    const raw = axis === 'x' ? x0 : y0;
    const committed = commitStartCoordinate(raw);
    // Rewrite ONLY when the box MISREPRESENTS the value the run will use.
    // Comparing against the formatted string instead rewrote "0.5" to "0.500" —
    // same value, different text — which changes x0, which fires the [x0, y0]
    // re-freeze effect, which resets the run. A blur that changed nothing would
    // then wipe a finished run. That is the same hazard handlePayoffBlur guards
    // with its value inequality; this is its sibling, and it was mine.
    if (parseNumericInput(raw) !== committed) {
      (axis === 'x' ? setX0 : setY0)(committed.toFixed(3));
    }
  };

  // Initialize simulation running flag
  const [initialized, setInitialized] = useState<boolean>(false);

  // ── Core Simulator State ───────────────────────────────────────────────────
  const [simState, setSimState] = useState<SimState>({
    cx: 0.217,
    cy: 0.217,
    exactX: 0.217,
    exactY: 0.217,
    calcX: 0.217,
    calcY: 0.217,
    displayX: 0.217,
    displayY: 0.217,
    startX: 0.217,
    startY: 0.217,
    domainLo: 0,
    domainHi: 1,
    domXLo: 0,
    domXHi: 1,
    domYLo: 0,
    domYHi: 1,
    stratX: 0.217,
    stratY: 0.217,
    cycleCount: 0,
    visitedPositions: [],
    ghostVisitedPositions: [],
    discoveredMixedX: null,
    discoveredMixedY: null,
    foundAxis: null,
    running: false,
    converged: false,
    stepCount: 0,
    pathSegmentsA: [{
      xs: [0.217], ys: [0.217], zs: [r3(EA(0.217, 0.217, {
        a11: 2, b11: 1, a12: 0, b12: 0,
        a21: 0, b21: 0, a22: 1, b22: 2,
      }))], mover: 'A'
    }],
    pathSegmentsB: [{
      xs: [0.217], ys: [0.217], zs: [r3(EB(0.217, 0.217, {
        a11: 2, b11: 1, a12: 0, b12: 0,
        a21: 0, b21: 0, a22: 1, b22: 2,
      }))], mover: 'A'
    }],
    phase1PtsA: null, phase1PtsB: null,
    ghostPathSegmentsA: [],
    ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false,
    bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false,
    ghostBisectGoodLo: 0, ghostBisectGoodHi: 1, ghostBisectBadLo: 0, ghostBisectBadHi: 1
  });

  const [logEntries, setLogEntries] = useState<string[]>([
    'Set starting point and first mover, then click Run or Step.'
  ]);

  // ── Timeline state ─────────────────────────────────────────────────────────
  const [thinHistory, setThinHistory] = useState<ThinSnapshot[]>([]);
  // Whether the precompute hit its step cap instead of converging. Without this
  // the UI showed a full progress bar and a disabled Step button, which reads as
  // "finished" — the run had simply been cut off.
  const [runTruncated, setRunTruncated] = useState<boolean>(false);
  const thinHistoryRef = useRef<ThinSnapshot[]>([]);
  const scrubPosRef = useRef<number>(0);
  const initStateRef = useRef<SimState | null>(null);
  const simStateRef = useRef<SimState>(simState);
  useEffect(() => { simStateRef.current = simState; }, [simState]);

  // Single snapshot saved when the first NE coordinate is discovered
  const [neSnapshot, setNeSnapshot] = useState<SimState | null>(null);
  const neSnapshotRef = useRef<SimState | null>(null);

  const [jumpInput, setJumpInput] = useState<string>('');

  const logsContainerRef = useRef<HTMLDivElement>(null);
  // The expanded overlay renders a SECOND copy of the log, so it needs its own
  // ref — a single ref would be overwritten by whichever copy mounted last and
  // the auto-scroll would silently follow the wrong one.
  const logsExpandedRef = useRef<HTMLDivElement>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  /** The dialog's own outer element — the boundary the Tab trap searches for
   *  focusable descendants inside. */
  const logDialogRef = useRef<HTMLDivElement>(null);
  /** The "Expand log" button, as a fallback opener to restore focus to on
   *  close if `document.activeElement` was not it for some reason (e.g. the
   *  dialog was opened programmatically rather than by a real click/Enter). */
  const expandLogButtonRef = useRef<HTMLButtonElement>(null);

  // RED-APP-5 finding 002 (round 5): the four dialogs below had no Tab trap
  // at all — see `useModalTabTrap`'s own docstring for the mechanism and why
  // Escape is deliberately NOT handled here.
  const feedbackDialogRef = useRef<HTMLDivElement>(null);
  const authDialogRef = useRef<HTMLDivElement>(null);
  const saveDialogRef = useRef<HTMLDivElement>(null);
  const editDialogRef = useRef<HTMLDivElement>(null);
  useModalTabTrap(isFeedbackOpen, feedbackDialogRef);
  useModalTabTrap(isAuthModalOpen, authDialogRef);
  useModalTabTrap(isSaveModalOpen, saveDialogRef);
  useModalTabTrap(isEditModalOpen, editDialogRef);

  // Auto-scroll the logs browser to the bottom on new entries
  useEffect(() => {
    for (const container of [logsContainerRef.current, logsExpandedRef.current]) {
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [logEntries, logExpanded]);

  /**
   * Focus management for the expanded-log dialog (RED-APP-4, CodeRabbit
   * finding on PR #90): opening it left focus on the "Expand log" button
   * underneath the overlay, so a keyboard user's next Tab walked the REST OF
   * THE PAGE (hidden behind the backdrop) before ever reaching the dialog —
   * and nothing ever moved focus back when it closed. WAI-ARIA APG's modal
   * dialog pattern: move focus INTO the dialog on open, trap Tab/Shift+Tab
   * within it while open, restore focus to the opener on close.
   *
   * The cleanup function (not a second effect) does the restore: it runs
   * exactly when `logExpanded` flips back to false — right before the
   * early-return body for that render — which is precisely "the moment the
   * dialog closes," not sooner and not later.
   */
  useEffect(() => {
    if (!logExpanded) return;
    const opener = (document.activeElement as HTMLElement | null) ?? expandLogButtonRef.current;
    // The log region itself, not the collapse button — a keyboard user
    // arriving here wants to read/scroll the log immediately.
    logsExpandedRef.current?.focus();
    return () => { opener?.focus(); };
  }, [logExpanded]);

  // Escape closes the expanded log (matching the other modals in the app);
  // Tab/Shift+Tab is trapped to the dialog's own focusable elements so
  // focus can never leave it onto the page underneath while it is open.
  useEffect(() => {
    if (!logExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      // RED-APP-6/002 (re-broken, RED-APP-7/003): stop the keydown from also
      // reaching Walkthrough.tsx's own independent `window`-level Escape
      // listener — without this, one Escape press while this dialog is open
      // over the tour closes BOTH this dialog AND the tour (resetting its
      // step to 0). `document` fires before `window` in the bubble phase, so
      // stopping it here is enough — but ONLY if this listener is actually
      // registered on `document`. It was registered on `window` (the same
      // target as Walkthrough's own listener), which makes
      // `stopPropagation()` a no-op against a sibling listener on the same
      // target (that needs `stopImmediatePropagation`, not used here) — the
      // comment above described the fix this code never implemented.
      if (e.key === 'Escape') { setLogExpanded(false); e.stopPropagation(); return; }
      if (e.key !== 'Tab') return;
      const container = logDialogRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [logExpanded]);

  // ── Simulation-log placement ───────────────────────────────────────────────
  // The log lives in the right column with an explicit height so its bottom lines
  // up with the bottom of the "Simulation Coordinates & Parameters" panel in the
  // left column. We size it to the room between the report panel's bottom and the
  // params panel's bottom (minus the column gap). Once converged, the Equilibrium
  // Reached box can grow tall enough that this room collapses; when it drops below
  // the height the log needs to render, we move it to a full-width band below.
  const paramsPanelRef = useRef<HTMLDivElement>(null);
  const reportPanelRef = useRef<HTMLDivElement>(null);
  const [logBelow, setLogBelow] = useState(false);
  const [inlineLogHeight, setInlineLogHeight] = useState<number | null>(null);
  /**
   * The smallest inline log worth rendering, in REM so it tracks the responsive
   * root font-size — the same reason columnGap is derived rather than hardcoded.
   *
   * This is a real floor, not a taste threshold. The card cannot render shorter
   * than its own chrome (padding + header + gap) plus the console's minimum box,
   * and that box does not shrink to nothing: `flex-1 min-h-0` lets the console's
   * CONTENT reach zero height, but its padding and borders still occupy space —
   * 42px at a 20px root.
   *
   * The previous value was 120px, floored with Math.max so the card could be
   * assigned a height SMALLER than the panel's own minimum. At 1512x945 that
   * produced a 101px card: 50px padding + 24px header + 15px gap left about 9px
   * for a box that cannot go below 42, and the log spilled 29px out through the
   * bottom of its card. The escape hatch to the full-width band never fired,
   * because the threshold was below the height at which rendering breaks.
   */
  const MIN_LOG_REM = 9;

  useLayoutEffect(() => {
    const measure = () => {
      const params = paramsPanelRef.current;
      const report = reportPanelRef.current;
      // Side-by-side only at lg; stacked layout doesn't need bottom-alignment.
      const sideBySide = window.matchMedia('(min-width: 1024px)').matches;
      if (!params || !report || !sideBySide) {
        setLogBelow(false);
        setInlineLogHeight(null);
        return;
      }
      // The flex gap above the log (`gap-6` = 1.5rem) scales with the root
      // font-size, which is responsive (e.g. 20px on the web layout, 16px in the
      // Electron window). Derive it from the live root font-size instead of
      // hardcoding 24px, otherwise the log's bottom drifts below the params panel
      // whenever the root font-size isn't 16px.
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const columnGap = remPx * 1.5;
      const room = params.getBoundingClientRect().bottom - report.getBoundingClientRect().bottom;
      // Drop to the full-width band whenever the room is gone — regardless of
      // WHY it is gone. This used to also require simState.converged, on the
      // assumption that only the "Equilibrium Reached" box could grow the report
      // panel that far, and that box only appears after convergence. The LLM
      // explanation broke that assumption: a long explanation, or the invented
      // scenario card, makes the report tall before the simulation is ever run.
      // The old condition then could not fire, and the log was clamped to the
      // 90px floor — a squashed stub holding a single line.
      // `room` spans from the report's bottom to the params' bottom; the log's own
      // header + padding sit inside that, so the scroll area gets the remainder.
      const inlineHeight = room - columnGap;
      // Compare the height the card would ACTUALLY get against the height it
      // needs. The old test compared `room` to a constant and then clamped with
      // Math.max, which could hand the card a height it cannot render in — the
      // clamp defeated the very check it was part of.
      if (inlineHeight < remPx * MIN_LOG_REM) {
        setLogBelow(true);
        setInlineLogHeight(null);
        return;
      }
      setLogBelow(false);
      setInlineLogHeight(inlineHeight);
    };
    let cancelled = false;
    const safeMeasure = () => { if (!cancelled) measure(); };
    measure();
    const ro = new ResizeObserver(measure);
    if (paramsPanelRef.current) ro.observe(paramsPanelRef.current);
    if (reportPanelRef.current) ro.observe(reportPanelRef.current);
    window.addEventListener('resize', measure);
    // A ResizeObserver only fires on element SIZE changes, not POSITION shifts.
    // On initial open, the 3D Plotly chart renders asynchronously above the
    // report panel and pushes it down (a position change), and web fonts can
    // reflow the panels — neither re-triggers the observer, so the first measure
    // is stale until the user resizes the window (which is why full-screening
    // "fixes" the alignment). Re-measure once those settle.
    const raf = requestAnimationFrame(() => requestAnimationFrame(safeMeasure));
    const settleTimers = [setTimeout(safeMeasure, 250), setTimeout(safeMeasure, 800)];
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(safeMeasure).catch(() => {});
    }
    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(raf);
      settleTimers.forEach(clearTimeout);
    };
  }, [simState.converged, simState.cx, simState.cy, logEntries]);

  // ── Memoized Nash Equilibria ───────────────────────────────────────────────
  const allNE = useMemo<NashEquilibrium[]>(() => {
    return computeAllNE(payoffs);
  }, [payoffs]);

  const indifferenceStatus = useMemo(() => computeIndifference(payoffs), [payoffs]);

  // Equilibrium CONTINUA. computeAllNE enumerates corners plus the interior
  // mixed point, which is the whole truth only when no player has a weak best
  // reply; with a payoff tie the equilibrium set is often a whole edge, and on
  // ~3 of every 4 tie games the corner list alone under-reports it. These lines
  // are additive — allNE, the simulation and the plot are untouched.
  const continua = useMemo(() => describeContinua(payoffs), [payoffs]);

  // ── Grounded LLM explanation ───────────────────────────────────────────────
  // On demand, never reactive: payoffs change on every slider drag, so fetching
  // per change would fire a model call per keystroke. The user asks for it.
  const [llmEnvelope, setLlmEnvelope] = useState<ReportEnvelope | null>(null);
  // The scenario whose NOUNS actually appear in `llmEnvelope.report.prose`,
  // captured the moment that prose was written — NOT read live off
  // `llmEnvelope.report.suggestedScenario`. RED-PUBLIC C: "New AI scenario"
  // (fetchFreshScenario) deliberately swaps `suggestedScenario` for a
  // brand-new draw while leaving `prose` untouched (its own comment: "only a
  // fresh STORY is wanted... the prose stays put"). Reading the LIVE
  // suggestedScenario for that unchanged prose's highlight terms meant the
  // nouns actually IN the text silently lost their colour the moment a new
  // suggestion arrived, while terms from a story the prose never mentions
  // got added instead — colouring text for the wrong scenario. This snapshot
  // is what the prose was ACTUALLY generated from, and fetchFreshScenario
  // must never touch it.
  const [proseScenario, setProseScenario] = useState<SuggestedScenario | null>(null);
  // Whether the game ACTUALLY has a payoff tie, for the provenance line in the
  // report panel. That line used to assert a tie unconditionally, which was true
  // only while the tie path alone produced `source === 'template'`;
  // NASH_PAYOFF_TEMPLATE=1 routes every game there.
  const hasPayoffTie = payoffs.a11 === payoffs.a21 || payoffs.a12 === payoffs.a22
    || payoffs.b11 === payoffs.b12 || payoffs.b21 === payoffs.b22;
  // The category narrative below asserts structure ("exactly one pure NE",
  // "always converges to the unique attractor") that a CONTINUUM contradicts.
  // It gated on `computeIndifference`, which only detects a FULLY flat player,
  // so a PARTIAL tie walked straight through: on a=[[-2,-2],[-2,-1]],
  // b=[[-2,-1],[-1,-2]] the set is x in [0, 0.5] at y=1 and (0.3, 1) has zero
  // regret for both players, so "always converge to the unique" is false while
  // the continuum is listed three lines above. This is the ONE shared test
  // (gameEngine.ts's `hasEquilibriumContinuum`) tieProse.ts, report.ts's
  // grounding payload, and nashValidator.ts's validateReport all now use —
  // RED-MATH-8/002 found nashValidator.ts still on the old, narrower test.
  const hasEquilibriumContinuum = computeHasEquilibriumContinuum(payoffs);
  const [llmLoading, setLlmLoading] = useState(false);
  // Tracked separately: without it a failed request clears the envelope and
  // renders identically to "never asked", so the user cannot tell a dead
  // request from an untouched panel.
  const [llmError, setLlmError] = useState(false);
  // Distinguishes "the request timed out" from "the request failed fast" --
  // RED-APP-6/003 asks for honest, specific wording rather than a single
  // generic failure message covering both.
  const [llmTimedOut, setLlmTimedOut] = useState(false);
  // "New AI scenario" while a validated explanation is on screen uses the
  // slim scenario-only endpoint (about half the tokens and latency of a full
  // report) and swaps just the suggestion card — its own loading flag keeps
  // the prose visible during the wait.
  const [scenarioLoading, setScenarioLoading] = useState(false);

  // Model prose renders ONLY when the server validated it against the solver.
  // Every other outcome — refusal, truncation, rate limit, hallucinated
  // equilibrium, or no API key at all — leaves the deterministic report above as
  // the only answer shown. The fallback is the default, not the exception.
  // 'template' reports (tie games under NASH_LLM_TIES=template) carry no
  // validation object because there is nothing to validate: their sentences are
  // rendered from the solver, so they are grounded by construction rather than
  // by a gate. They display like a verified report.
  const llmVerified = envelopeIsTrustworthy(llmEnvelope);

  // Any edit to the game invalidates prose written about the previous one.
  // Also bumps requestGenerationRef (any in-flight request becomes stale the
  // instant this fires) and clears the loading flags -- CodeRabbit's second
  // point on the same finding: without this, switching away from a game
  // with a slow request in flight left "Explain this game" / "New AI
  // scenario" permanently disabled for the NEWLY selected game, because
  // only the (now-superseded) old request's own `finally` block was ever
  // going to clear them.
  useEffect(() => {
    requestGenerationRef.current += 1;
    scenarioGenerationRef.current += 1;
    setLlmEnvelope(null); setLlmError(false); setProseScenario(null);
    setLlmLoading(false); setScenarioLoading(false); setLlmTimedOut(false);
  }, [payoffs]);

  // RED-APP-6/003: abort whatever report-family request was in flight for the
  // PREVIOUS game -- a SEPARATE effect (not folded into the one above) so its
  // cleanup fires on the same [payoffs] schedule (right before the next
  // change, and on unmount) without disturbing the state-clearing effect's
  // own shape. The generation check in fetchLlmExplanation/fetchFreshScenario
  // already makes a late response inert; this additionally stops the network
  // work itself and frees the abort timer early instead of leaving it to fire
  // on its own.
  useEffect(() => {
    return () => {
      inFlightReportControllersRef.current.forEach((c) => c.abort());
      inFlightReportControllersRef.current.clear();
    };
  }, [payoffs]);

  /**
   * Keep an invented scenario ON the game, labels and all.
   *
   * The four option labels are the half that makes reuse reliable.
   * `scenarioIsUsable` accepts four labels OR a description of at least twelve
   * words, and only the labels are unconditionally sufficient — a terse
   * description silently falls under the word threshold and triggers a fresh
   * invention next time, which would make the text the user just kept a dead
   * letter.
   *
   * They used to be crammed into the description as a sentence ("A chooses
   * between X and Y…") because SavedGame had nowhere to put them. It does now,
   * so they go in the label fields, where the UI can show them as the matrix
   * headers too. The sentence survives only as a fallback for a suggestion that
   * arrives with labels missing.
   */
  const useSuggestedScenario = async (sc: SuggestedScenario) => {
    const hasAllLabels = [sc.row1, sc.row2, sc.col1, sc.col2].every(Boolean);
    // Only when the labels have no field of their own to live in. With all four
    // present they are saved structurally and the description stays prose.
    //
    // THE FALLBACK USED TO INTERPOLATE THE HOLE IT EXISTS TO COVER (RED 1 F11).
    // This branch runs precisely when a label is MISSING, and it then wrote
    // `${sc.col2}` into the sentence regardless — so the draw that emitted col1
    // plus invented keys day1/day2 saved the user the sentence "B chooses
    // between Night Work and undefined." The branch written to handle the
    // missing-label case was the one that printed it.
    //
    // Built per PAIR now, so a partial draw keeps whatever it actually supplied.
    // Note what is deliberately NOT done: the guard below was
    // `[row1,row2,col1,col2].some(Boolean)`, and tightening THAT to
    // `hasAllLabels` would have silently dropped the labels a partial draw did
    // provide — trading a visible "undefined" for invisible data loss, which is
    // the worse of the two failures because nothing on screen reveals it.
    const pair = (who: string, a?: string, b?: string) =>
      a && b ? `${who} chooses between ${a} and ${b}` : '';
    const parts = hasAllLabels
      ? []
      : [pair('A', sc.row1, sc.row2), pair('B', sc.col1, sc.col2)].filter(Boolean);
    const description = `${sc.description ?? ''}${parts.length ? ` ${parts.join('; ')}.` : ''}`.trim();
    // Already a saved game of this user's: route the suggestion through the
    // EDIT dialog prefilled, exactly like the save-as-new path routes through
    // the save dialog — the user reviews and can rewrite any of it before it
    // lands (Daniel's call: keeping a scenario should never skip the editable
    // form). The PATCH happens in handleEditGameSubmit as with any other edit,
    // and the explanation regenerates there from what was actually submitted.
    const existing = userCustomGames.find((g) => g.id === activePreset);
    if (existing && authToken) {
      const prefillName = (sc.name ?? existing.name).slice(0, 40);
      setEditGameId(existing.id);
      setEditName(prefillName);
      // This IS an auto-prefill (the report's invention, not the user's own
      // typing) — the name-replace baseline moves with it, same as any other
      // programmatic name write. See the ref's own doc comment above.
      editNameBaselineRef.current = prefillName;
      setEditDesc(description.slice(0, 800));
      setEditLabels({
        row1: sc.row1 ?? '', row2: sc.row2 ?? '',
        col1: sc.col1 ?? '', col2: sc.col2 ?? '',
      });
      setEditError('');
      regenExplanationAfterSaveRef.current = true;
      setIsEditModalOpen(true);
      return;
    }

    // Preset or unsaved matrix: there is nothing to patch, so route through the
    // existing save-as-new flow with the story prefilled. Clamped to the
    // textarea/server limit: prefilling PAST maxLength locks the field (a
    // controlled textarea over its cap rejects every keystroke). The Name
    // field needs the SAME clamp its sibling branch above already has
    // (RED-APP-6/005): `maxLength` on the `<input>` only bounds what a user
    // TYPES, not a value set programmatically, so an AI-invented name over 40
    // characters would otherwise land in the field verbatim — visibly past
    // the limit the field claims (and correctly enforces for typing) to cap.
    const prefillName = (sc.name ?? '').slice(0, 40);
    setSaveName(prefillName);
    saveNameBaselineRef.current = prefillName;
    setSaveDesc(description.slice(0, 800));
    setSaveLabels({
      row1: sc.row1 ?? '', row2: sc.row2 ?? '',
      col1: sc.col1 ?? '', col2: sc.col2 ?? '',
    });
    setSaveError('');
    regenExplanationAfterSaveRef.current = true;
    // A fresh save attempt for a different scenario — never reuse a
    // clientRequestId minted for whatever the dialog last tried to save.
    saveRequestIdRef.current = null;
    setIsSaveModalOpen(true);
  };

  /**
   * `freshScenario` is the user OPTING IN to a brand-new invented story: the
   * request simply omits the scenario, so the model writes as if the game had
   * none and returns its invention in suggestedScenario — which the UI then
   * offers, never applies. The default path always sends the scenario, and the
   * server hard-drops any suggestion the model returns despite one being
   * supplied, so an existing description is only ever replaced by choice.
   *
   * `scenarioOverride` exists for the moment a scenario was JUST saved:
   * scenarioForReport is a memo of the previous render, so a regeneration
   * fired from the same handler would send the stale (usually absent)
   * scenario and ask for another invention instead of using the one the user
   * kept. The caller hands the fresh scenario explicitly.
   */
  const fetchLlmExplanation = async (
    freshScenario = false,
    scenarioOverride?: { name?: string; row1?: string; row2?: string; col1?: string; col2?: string; description?: string },
  ) => {
    // Snapshot: the payoffs this SPECIFIC request describes. Not just the
    // closure's own `payoffs` read later — that would be the same frozen
    // value the bug already reads — an explicit local so the intent (compare
    // "what I asked about" against "what's on screen now") reads plainly at
    // the call site below.
    const requestPayoffs = payoffs;
    // Bump-then-capture, not just read: two calls for the SAME game (e.g.
    // "Regenerate" clicked twice before the first response lands) must get
    // DIFFERENT generation numbers so the later call always wins regardless
    // of which response arrives first -- reading without bumping would give
    // both calls the identical number whenever the payoffs never changed
    // between them, and an out-of-order resolution would then pass this
    // check exactly like the bug it exists to close. The payoffs-change
    // effect ALSO bumps this (see its declaration), so a game switch
    // invalidates an in-flight request even with no new call at all.
    const myGeneration = (requestGenerationRef.current += 1);
    setLlmLoading(true);
    setLlmError(false);
    setLlmTimedOut(false);
    // RED-APP-6/003: tracked so a payoffs change (or unmount) can abort this
    // specific request; removed in `finally` below regardless of outcome.
    const controller = new AbortController();
    inFlightReportControllersRef.current.add(controller);
    // See fetchWithTimeout's docstring: `clear()` must not run until the
    // BODY is also read, so it is called from this function's own `finally`
    // below, not chained onto the fetch promise itself.
    const { promise: fetchPromise, clear: clearReportTimeout } = fetchWithTimeout(getApiUrl('/api/report'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        freshScenario
          ? { payoffs: requestPayoffs, bypassCache: true }
          : { payoffs: requestPayoffs, scenario: scenarioOverride ?? scenarioForReport, ...(llmEnvelope ? { bypassCache: true } : {}) },
      ),
    }, controller);
    try {
      // bypassCache: an explicit re-request (Regenerate, or any fresh
      // invention) must roll a new report; a FIRST explain is the cache's
      // customer — identical preset matrices serve instantly.
      const res = await fetchPromise;
      if (!res.ok) throw new Error(String(res.status));
      const envelope = (await res.json()) as ReportEnvelope;
      // RED-APP-3 finding 001: the user may have switched to a DIFFERENT
      // game while this (possibly slow — reports have hung for minutes in
      // this app's own history) request was in flight. `payoffsRef.current`
      // is always the LATEST payoffs, unlike this closure's own `payoffs` /
      // `requestPayoffs`, which are frozen at the moment this function was
      // called. A mismatch means the response describes a game that is no
      // longer on screen — showing it as "verified against the solver"
      // would verify the WRONG game, so it is dropped silently. The
      // `[payoffs]` effect has already cleared `llmEnvelope`/`proseScenario`
      // for whatever IS on screen now; this only stops the stale response
      // from overwriting that a moment later.
      if (myGeneration !== requestGenerationRef.current || !payoffsEqual(requestPayoffs, payoffsRef.current)) return;
      setLlmEnvelope(envelope);
      // Snapshot the scenario THIS prose was generated from — see the
      // proseScenario declaration above. Every fresh fetch here writes new
      // prose, so this always tracks it; only fetchFreshScenario (which
      // writes no new prose) must skip this line.
      setProseScenario(envelope.report?.suggestedScenario ?? null);
    } catch (err) {
      // Offline, unreachable server, a non-2xx, or (RED-APP-6/003) a client-
      // side timeout abort. The deterministic report above still stands; we
      // just say so instead of failing silently — but only for the game
      // this request was actually about. A request for an ABANDONED game
      // failing after the user switched away must not paint "No verified
      // explanation available" over whatever game is on screen now, when
      // nothing was ever asked about IT — same staleness guard as the
      // success path above, same reason.
      if (myGeneration !== requestGenerationRef.current || !payoffsEqual(requestPayoffs, payoffsRef.current)) return;
      setLlmEnvelope(null);
      setProseScenario(null);
      setLlmError(true);
      setLlmTimedOut(err instanceof DOMException && err.name === 'AbortError');
    } finally {
      clearReportTimeout();
      inFlightReportControllersRef.current.delete(controller);
      // Only the request that is still CURRENT clears the loading flag --
      // a superseded request's finally must not clobber a newer request's
      // still-in-flight spinner (the payoffs-change effect above already
      // cleared it immediately on the actual game switch, for the case
      // where nothing newer was fired).
      if (myGeneration === requestGenerationRef.current) setLlmLoading(false);
    }
  };

  /**
   * "New AI scenario" — slim path. With a validated explanation already on
   * screen, only a fresh STORY is wanted: the scenario-only endpoint returns
   * it in roughly half the time of a full report, and the suggestion card is
   * swapped in place while the prose stays put. Without a verified envelope
   * (nothing on screen to keep) it falls back to the full fresh-invention
   * report, exactly as before.
   */
  const fetchFreshScenario = async () => {
    if (!llmVerified || !llmEnvelope?.report) return fetchLlmExplanation(true);
    // CodeRabbit finding (this branch, on the fixup commit): this function
    // had NO staleness guard of its own. The `prev?.report` check in the
    // updater below only proves SOME report exists when the response
    // lands -- not that it is the SAME game's report. Sequence that slips
    // through unguarded: user is on game A, clicks "New AI scenario"
    // (this request fires for A); switches to game B (the payoffs effect
    // clears llmEnvelope); asks for game B's own explanation (llmEnvelope
    // now HAS a report again -- B's); THEN this stale request for A
    // resolves, `prev?.report` is truthy (it's B's), and A's invented
    // scenario gets merged into B's envelope. Same class of bug as
    // fetchLlmExplanation (finding 001 / App.tsx:924), same fix: snapshot
    // the identity this request was fired for, and require it to still
    // match before touching state.
    const requestPayoffs = payoffs;
    // RED-APP-7/002: this request's OWN generation counter (see
    // scenarioGenerationRef's declaration) -- a concurrent Regenerate click
    // (fetchLlmExplanation) bumps requestGenerationRef, not this one, so it
    // can no longer defeat this function's own `finally` below.
    const myGeneration = (scenarioGenerationRef.current += 1);
    setScenarioLoading(true);
    // RED-APP-6/003: same no-timeout defect as fetchLlmExplanation, same fix.
    const controller = new AbortController();
    inFlightReportControllersRef.current.add(controller);
    // See fetchWithTimeout's docstring: `clear()` runs from this function's
    // own `finally` below, after the body is read, not chained onto fetch.
    const { promise: fetchPromise, clear: clearReportTimeout } = fetchWithTimeout(getApiUrl('/api/report'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payoffs: requestPayoffs, scenarioOnly: true }),
    }, controller);
    try {
      const res = await fetchPromise;
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { scenario: SuggestedScenario | null };
      if (myGeneration !== scenarioGenerationRef.current || !payoffsEqual(requestPayoffs, payoffsRef.current)) {
        // Stale: the user has since switched games. Neither the scenario
        // NOR a "couldn't invent" log line belongs on whatever is on
        // screen now -- both would be about a game that is no longer
        // there to have an opinion about.
        return;
      }
      if (data.scenario) {
        setLlmEnvelope((prev) =>
          prev?.report ? { ...prev, report: { ...prev.report, suggestedScenario: data.scenario } } : prev);
      } else {
        setLogEntries((prev) => [...prev, "✗ Couldn't invent a verified scenario just now — try again."]);
      }
    } catch (err) {
      if (myGeneration !== scenarioGenerationRef.current || !payoffsEqual(requestPayoffs, payoffsRef.current)) return;
      const timedOut = err instanceof DOMException && err.name === 'AbortError';
      setLogEntries((prev) => [...prev, timedOut
        ? "✗ Inventing a new scenario is taking longer than expected — try again."
        : "✗ Couldn't reach the server for a new scenario."]);
    } finally {
      clearReportTimeout();
      inFlightReportControllersRef.current.delete(controller);
      // Same reasoning as fetchLlmExplanation's finally: only the request
      // that is still current may clear the loading flag. RED-APP-7/002:
      // "current" is now judged against THIS function's own counter, not the
      // one Regenerate/Explain bumps.
      if (myGeneration === scenarioGenerationRef.current) setScenarioLoading(false);
    }
  };

  const pureNEs = useMemo<NashEquilibrium[]>(() => {
    return allNE.filter((n) => n.type === 'pure');
  }, [allNE]);

  const mixedNE = useMemo<NashEquilibrium | undefined>(() => {
    return allNE.find((n) => n.type === 'mixed');
  }, [allNE]);

  // Player-committed pure equilibrium under turn priority
  const committedNE = useMemo<NashEquilibrium | null>(() => {
    if (pureNEs.length === 0) return null;
    if (pureNEs.length === 1) return pureNEs[0];

    // Multi-pure NE: Mover selects their preferred choice
    return pureNEs.reduce((best, ne) => {
      const myScore = firstMover === 'A' ? ne.eA : ne.eB;
      const bestScore = firstMover === 'A' ? best.eA : best.eB;
      return myScore > bestScore ? ne : best;
    });
  }, [pureNEs, firstMover]);

  /**
   * The run parameters, mirrored into a ref.
   *
   * `handleStep`'s init branch reads eight pieces of live React state to build
   * and precompute a run. Any caller SCHEDULED BEFORE those values change
   * captures the pre-update closure and stages the wrong run.
   *
   * The tour's "Watch the leans flatten" step does exactly that: its onEnter
   * calls changeStepMode('regret') and then
   * `tourDefer(() => handleStep(true), 350)`. The timer is created in the same
   * tick as the setState, so it can NEVER observe the new mode — it is stale by
   * construction, not by racing. On the normal path the mode is already 'regret'
   * by then and the stale value happens to be right, which is why this was
   * invisible; a visitor who touches the method button once on the previous step
   * makes it wrong. The panel, the step-size label, the help text and the plot
   * caption all said Opponent Regret while the staged run was Domain Shrink:
   * denominator 58 and first-find 37 instead of 30 and 24, with the regret
   * strategy lines not drawn at all under a caption saying to watch them flatten.
   *
   * A ref is the fix rather than a dependency array because the staleness is in
   * a TIMER, not in an effect: reading current values at call time is exactly
   * what a deferred caller needs, and it immunises every future tourDefer too.
   */
  const runParamsRef = useRef({ payoffs, firstMover, shrinkStep, stepMode, allNE, committedNE, x0, y0 });
  useEffect(() => {
    runParamsRef.current = { payoffs, firstMover, shrinkStep, stepMode, allNE, committedNE, x0, y0 };
  });

  // Expected equations text
  const eqAStr = useMemo(() => {
    return buildPolyStr(
      payoffs.a11 - payoffs.a12 - payoffs.a21 + payoffs.a22,
      payoffs.a12 - payoffs.a22,
      payoffs.a21 - payoffs.a22,
      payoffs.a22
    );
  }, [payoffs]);

  const eqBStr = useMemo(() => {
    return buildPolyStr(
      payoffs.b11 - payoffs.b12 - payoffs.b21 + payoffs.b22,
      payoffs.b12 - payoffs.b22,
      payoffs.b21 - payoffs.b22,
      payoffs.b22
    );
  }, [payoffs]);

  // Nearest calculated equilibrium details for final report
  const nearestNE = useMemo<NashEquilibrium | null>(() => {
    if (allNE.length === 0) return null;
    return allNE.reduce((best, ne) => {
      const d = Math.hypot(ne.x - simState.cx, ne.y - simState.cy);
      const dBest = Math.hypot(best.x - simState.cx, best.y - simState.cy);
      return d < dBest ? ne : best;
    }, allNE[0]);
  }, [allNE, simState.cx, simState.cy]);

  // The converged box's solution concept comes from the REALISED profile, never
  // from `nearestNE` — that is the *nearest* equilibrium and can be arbitrarily
  // far from where the run actually stopped. Two earlier defects in this same
  // box came from borrowing its identity (the eA payoff, then the mover noun);
  // this is the third: "Pure Strategy Nash Equilibrium Reached" printed above
  // x*=1.000, y*=0.500 on a continuum where B is mixing 50/50.
  // Resolve back to the solver's EXACT coordinates before naming anything.
  // simState.cx/cy are r3-collapsed inside doStep, so asking them "is this a
  // vertex?" answered yes for a mixed equilibrium at 0.99955 and printed PURE
  // on a game with no pure equilibrium.
  const resolved = useMemo(
    () => resolveProfile(payoffs, simState),
    [payoffs, simState]
  );
  const realisedConcept = resolved.concept;

  // A finished run is STALE the moment the game or the turn order it ran under
  // changes. Gating the box here covers every control at once — the matrix
  // editor, the first-mover toggle, and anything added later — rather than
  // relying on each writer remembering to reset.
  const runStale = !runCtx
    || runCtx.firstMover !== firstMover
    || (Object.keys(runCtx.payoffs) as (keyof GamePayoffs)[]).some((k) => runCtx.payoffs[k] !== payoffs[k]);

  // The equilibrium panel's two indifference equations, and the labels above
  // them ("A indifferent:" / "A strictly prefers:").
  //
  // Which players are ACTUALLY indifferent here: a continuum point is "mixed"
  // but only ONE player is indifferent on it; printing both indifference
  // equations asserted E[Row 1] = 3.783 ≈ E[Row 2] = -0.698.
  //
  // Evaluated at `resolved` — the SAME exact coordinates the x*/y*/E[A]/E[B]
  // row above it uses. Reading `simState.cx`/`cy` here instead made the panel
  // contradict itself within one box: those are r3-collapsed by `doStep`, so on
  // the Search Game preset the headline said E[A] = 0.667 while the line under
  // it asserted "A indifferent: E[Row 1] = 0.666 ≈ E[Row 2] = 0.667" — a
  // difference that exists only because 1/3 was read as 0.333. At a mixed
  // equilibrium E[A], E[Row 1] and E[Row 2] are the same number by definition.
  const lines = useMemo(
    () => indifferenceLines(payoffs, resolved.x, resolved.y),
    [payoffs, resolved.x, resolved.y]
  );



  /**
   * The ONE writer of `firstMover`.
   *
   * Turn order is part of a run's rules. Changing it left the timeline controls
   * replaying the old mover's run beside a report that had already flipped to
   * the new mover's committed corner: on Battle of the Sexes the report said
   * "Player B initiates and commits to Pure NE (Row2, Col2)" while the log still
   * read "Player A moves first", the markers sat on (Row1, Col1) and the pill
   * still certified "✓ Converged".
   *
   * Deliberately NOT a useEffect on `firstMover`: the guided tour re-asserts the
   * mover on every act entry (enterDilemmaAct, enterMixedAct), and an effect
   * would fire there and wipe tour state mid-act. It would also fire only when
   * the value actually changed, i.e. only for a visitor who toggled mid-tour —
   * intermittently, in the one case nobody tests.
   *
   * The early return keeps those re-assertions a true no-op in the common case,
   * and when the mover HAS genuinely changed, resetting is what the tour's own
   * comment already claims happens ("a changed value triggers the re-freeze
   * reset") — true for x0/y0 via their effect, and silently false here until now.
   */
  const changeFirstMover = (next: 'A' | 'B') => {
    if (next === firstMover) return;
    setFirstMover(next);
    setInitialized(false);
    if (runCtx) handleReset();
  };

  /**
   * The ONE writer of `stepMode`, for the same reason as changeFirstMover.
   *
   * The convergence method is the third control that defines a run's rules,
   * after the matrix and the turn order. Both steppers pass `fc.stepMode` from
   * the frozen run context, so switching method mid-run left the button visibly
   * active while every subsequent Step continued under the OLD method. Nothing
   * false was printed — which is exactly what made it worth fixing: the control
   * silently had no effect, and the user had no way to tell "this did nothing"
   * from "this did something I cannot see".
   *
   * Same shape as changeFirstMover, and the same reason it is not a useEffect:
   * the tour re-asserts the method on almost every step of the mixed act, and
   * the unchanged-value early return keeps those re-assertions true no-ops.
   */
  const changeStepMode = (next: 'shrink' | 'regret') => {
    if (next === stepMode) return;
    setStepMode(next);
    setInitialized(false);
    if (runCtx) handleReset();
  };

  // ── Interactive Single-Step Engine ─────────────────────────────────────────
  const handleStep = (startRunningAfter = false) => {
    if (!initialized) {
      // Read the run parameters from the ref, never from this closure: a
      // deferred caller (the tour's tourDefer staging) holds a closure from
      // before its own onEnter's setState committed.
      const rp = runParamsRef.current;
      const { payoffs, firstMover, shrinkStep, stepMode, allNE, committedNE } = rp;
      // `parseFloat(x0) || 0.217` treated a legitimate 0 as a missing value: x0 = 0
      // (advertised by the input's own min="0.0", and where the down button lands
      // from 0.010) ran from 0.217, and the log opened "Start (0.217, 0.500)"
      // above a box still reading 0.
      const startValX = commitStartCoordinate(rp.x0);
      const startValY = commitStartCoordinate(rp.y0);

      const initSegA = { xs: [startValX], ys: [startValY], zs: [r3(EA(startValX, startValY, payoffs))], mover: 'A' as const };
      const initSegB = { xs: [startValX], ys: [startValY], zs: [r3(EB(startValX, startValY, payoffs))], mover: 'A' as const };

      const initState: SimState = {
        ...simState,
        cx: startValX, cy: startValY,
        exactX: startValX, exactY: startValY,
        calcX: startValX, calcY: startValY,
        displayX: startValX, displayY: startValY,
        startX: startValX, startY: startValY,
        domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1, stratX: startValX, stratY: startValY, cycleCount: 0,
        visitedPositions: [], ghostVisitedPositions: [],
        discoveredMixedX: null, discoveredMixedY: null, foundAxis: null,
        running: false, converged: false, stepCount: 0,
        pathSegmentsA: [initSegA], pathSegmentsB: [initSegB],
        phase1PtsA: null, phase1PtsB: null,
        ghostPathSegmentsA: [], ghostPathSegmentsB: [],
        cyclePattern: null, bisecting: false,
        bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
        ghostCyclePattern: null, ghostBisecting: false,
        ghostBisectGoodLo: 0, ghostBisectGoodHi: 1, ghostBisectBadLo: 0, ghostBisectBadHi: 1
      };

      setInitialized(true);
      setRunCtx({ payoffs, firstMover, shrinkStep, stepMode, allNE, committedNE });
      setLogEntries([`Start (${startValX.toFixed(3)}, ${startValY.toFixed(3)}) — Player ${firstMover} moves first`]);
      initStateRef.current = initState;
      neSnapshotRef.current = null;
      setNeSnapshot(null);
      setJumpInput('');

      // Pre-compute thin snapshots — used for total step count and NE snapshot
      const { snaps, neState, truncated } = precomputeThinHistory(initState, payoffs, firstMover, shrinkStep, allNE, committedNE, stepMode);
      setRunTruncated(truncated);
      thinHistoryRef.current = snaps;
      setThinHistory(snaps);
      if (neState) {
        neSnapshotRef.current = neState;
        setNeSnapshot(neState);
      }

      // Do the first actual step incrementally
      const next: SimState = {
        ...initState,
        visitedPositions: [], ghostVisitedPositions: [],
        pathSegmentsA: [{ ...initSegA, xs: [...initSegA.xs], ys: [...initSegA.ys], zs: [...initSegA.zs] }],
        pathSegmentsB: [{ ...initSegB, xs: [...initSegB.xs], ys: [...initSegB.ys], zs: [...initSegB.zs] }],
        phase1PtsA: null, phase1PtsB: null,
    ghostPathSegmentsA: [], ghostPathSegmentsB: []
      };
      const stepLogs: string[] = [];
      doStep(payoffs, next, firstMover, shrinkStep, allNE, committedNE,
        (msg) => stepLogs.push(msg), () => {}, () => { next.running = false; }, stepMode);
      if (!next.converged) next.running = startRunningAfter;

      simStateRef.current = next;
      setSimState(next);
      scrubPosRef.current = 1;

      if (stepLogs.length > 0) {
        setLogEntries(prev => {
          let updated = [...prev];
          if (updated.length === 1 && updated[0].startsWith('Set starting')) updated = [];
          return [...updated, ...stepLogs];
        });
      }
      return;
    }

    // Subsequent step — incremental doStep on live simState
    const prev = simStateRef.current;
    if (prev.converged || scrubPosRef.current >= thinHistoryRef.current.length - 1) return;

    const next: SimState = {
      ...prev,
      visitedPositions: [...prev.visitedPositions],
      ghostVisitedPositions: [...prev.ghostVisitedPositions],
      pathSegmentsA: prev.pathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
      pathSegmentsB: prev.pathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
      ghostPathSegmentsA: prev.ghostPathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
      ghostPathSegmentsB: prev.ghostPathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] }))
    };
    const stepLogs: string[] = [];
    // ONE source of truth for the whole run, forward and backward. Freezing the
    // replay while the forward stepper read LIVE controls let a run change its
    // own rules mid-flight: the step-size box (the only control that never
    // called setInitialized) altered dynamics on a run already in progress,
    // while the precomputed history — which drives the progress denominator and
    // the Step button — still described the abandoned trajectory. The app
    // printed "Equilibrium reached" and disabled Step at a profile where a
    // player gained 4 by switching.
    const fc = runCtx ?? { payoffs, firstMover, shrinkStep, stepMode, allNE, committedNE };
    doStep(fc.payoffs, next, fc.firstMover, fc.shrinkStep, fc.allNE, fc.committedNE,
      (msg) => stepLogs.push(msg), () => {}, () => { next.running = false; }, fc.stepMode);

    simStateRef.current = next;
    setSimState(next);
    const nextPos = scrubPosRef.current + 1;
    scrubPosRef.current = nextPos;
    if (stepLogs.length > 0) setLogEntries(prev => [...prev, ...stepLogs]);
  };

  // Recursive play runner trigger
  useEffect(() => {
    if (!simState.running) return;

    const thin = thinHistoryRef.current;
    if (thin.length > 0 && scrubPosRef.current >= thin.length - 1) {
      setSimState(prev => ({ ...prev, running: false }));
      return;
    }

    const intervalMs = Math.max(30, Math.round(550 / speed));
    const timer = setTimeout(() => {
      const pos = scrubPosRef.current;
      const snaps = thinHistoryRef.current;
      if (snaps.length === 0 || pos >= snaps.length - 1) {
        setSimState(prev => ({ ...prev, running: false }));
        return;
      }
      const prev = simStateRef.current;
      const next: SimState = {
        ...prev,
        visitedPositions: [...prev.visitedPositions],
        ghostVisitedPositions: [...prev.ghostVisitedPositions],
        pathSegmentsA: prev.pathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        pathSegmentsB: prev.pathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        ghostPathSegmentsA: prev.ghostPathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        ghostPathSegmentsB: prev.ghostPathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] }))
      };
      const stepLogs: string[] = [];
      const fc = runCtx ?? { payoffs, firstMover, shrinkStep, stepMode, allNE, committedNE };
      doStep(fc.payoffs, next, fc.firstMover, fc.shrinkStep, fc.allNE, fc.committedNE,
        (msg) => stepLogs.push(msg), () => {}, () => { next.running = false; }, fc.stepMode);
      simStateRef.current = next;
      setSimState(next);
      const nextPos = pos + 1;
      scrubPosRef.current = nextPos;
      if (stepLogs.length > 0) setLogEntries(prev => [...prev, ...stepLogs]);
    }, intervalMs);

    return () => clearTimeout(timer);
  }, [simState.running, simState.stepCount, speed]);

  // ── Authentication & Custom Game Handlers ──────────────────────────────────
  const handleLogout = () => {
    updateAuthToken(null);
    setUser(null);
    setUserCustomGames([]);
    setActivePreset('bos');
    setLogEntries(['Logged out successfully.']);
  };

  /**
   * Open the edit dialog for a saved game, prefilled with what it already says.
   *
   * Until now a saved game was write-once: the only way to fix a name, a
   * description or an option label was to delete the game and save it again,
   * which loses the id every explanation is keyed to.
   */
  const openEditGame = (game: any) => {
    setEditGameId(game.id);
    setEditName(game.name ?? '');
    // The name on screen is the SAVED name, not user typing — Keep may
    // replace it (director's decision) as long as the user leaves it alone.
    editNameBaselineRef.current = game.name ?? '';
    setEditDesc(game.description ?? '');
    setEditTerms({ a: game.colorTermsA ?? [], b: game.colorTermsB ?? [] });
    setEditLabels({
      row1: game.row1Label ?? '', row2: game.row2Label ?? '',
      col1: game.col1Label ?? '', col2: game.col2Label ?? '',
    });
    setEditError('');
    // A different game must never inherit another game's regen preview.
    regenGenerationRef.current += 1;
    regenControllerRef.current?.abort();
    regenInFlightRef.current = false;
    setRegen({ status: 'idle', preview: null, error: null, note: '' });
    setIsEditModalOpen(true);
  };

  const handleEditGameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editGameId || !authToken) return;
    if (!cleanText(editName)) { setEditError('Please enter a game name.'); return; }
    setEditError('');
    setEditLoading(true);
    try {
      const res = await fetch(getApiUrl(`/api/games/${editGameId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({
          // cleanText, not .trim() alone: RED-PUBLIC D — a bidi override or
          // raw control character typed into any of these fields used to
          // reach the saved record untouched (src/utils/textSafety.ts).
          name: cleanText(editName),
          description: cleanText(editDesc),
          // Sent even when blank so CLEARING a label is possible. The server
          // ignores empty strings on create, but an edit dialog that cannot
          // remove a wrong label is only half an edit dialog — see the
          // allowClear flag on the PATCH route.
          row1Label: cleanText(editLabels.row1),
          row2Label: cleanText(editLabels.row2),
          col1Label: cleanText(editLabels.col1),
          col2Label: cleanText(editLabels.col2),
          colorTermsA: editTerms.a,
          colorTermsB: editTerms.b,
          allowClear: true,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setUserCustomGames((prev) => prev.map((g) => (g.id === editGameId ? data.game : g)));
        setIsEditModalOpen(false);
        setLogEntries((prev) => [...prev, `✓ Updated "${data.game.name}".`]);
        // The explanation was written about the OLD story, so it no longer
        // describes what the panel now says. A kept-scenario save goes one
        // step further than clearing: it regenerates from the fields as
        // submitted (the user may have rewritten the AI's draft in this
        // dialog), passed explicitly because scenarioForReport won't see the
        // update until the next render. Guard mirrors scenarioIsUsable so an
        // emptied-out form clears rather than triggering a fresh invention.
        if (regenExplanationAfterSaveRef.current) {
          regenExplanationAfterSaveRef.current = false;
          const labels = [editLabels.row1, editLabels.row2, editLabels.col1, editLabels.col2].map((l) => cleanText(l));
          const desc = cleanText(editDesc);
          if (labels.every(Boolean) || desc.split(/\s+/).length >= 12) {
            void fetchLlmExplanation(false, {
              name: cleanText(editName) || undefined,
              row1: labels[0] || undefined, row2: labels[1] || undefined,
              col1: labels[2] || undefined, col2: labels[3] || undefined,
              description: desc || undefined,
            });
          } else {
            setLlmEnvelope(null);
          }
        } else {
          setLlmEnvelope(null);
        }
      } else if (res.status === 404) {
        // RED-APP-9/001: the game this dialog is editing was already deleted
        // elsewhere (another tab/profile/device) — the server's 404 is
        // authoritative, so prune the phantom row and re-fetch rather than
        // just surfacing the error string and leaving the stale row in
        // place. The dialog itself is left OPEN (same as any other failed
        // submit) so the user can read the message and Cancel; by the time
        // they do, the underlying list is already correct — no reload
        // needed. If the deleted game was the one currently loaded on the
        // board, fall back the same way the Delete button already does
        // (handleLoadPreset('bos')) rather than leaving the matrix pointed
        // at a saved-game id that no longer resolves to anything.
        setUserCustomGames((prev) => prev.filter((g) => g.id !== editGameId));
        if (activePreset === editGameId) handleLoadPreset('bos');
        void refetchUserGames();
        setEditError('This game was deleted elsewhere; the list has been refreshed.');
      } else {
        // RED-APP-7/001: a validly-signed but EXPIRED token dies mid-session
        // (the tab stayed open past AUTH_TOKEN_TTL_MS) without React ever
        // being told — `authToken` state kept the dead token, so the header
        // still read "Log out" and this dialog had no re-auth affordance at
        // all. Clearing it here on any 401 makes the app's own state agree
        // with the server's; the header flips to "Sign in" and the
        // `!authToken` branch on the error render above fires naturally.
        if (res.status === 401) updateAuthToken(null);
        setEditError(data.error || 'Failed to update game.');
      }
    } catch {
      setEditError('Network error. Failed to update game.');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDeleteGame = async (gameId: string) => {
    if (!authToken) return;
    try {
      const res = await fetch(getApiUrl(`/api/games/${gameId}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.ok) {
        setUserCustomGames(prev => prev.filter(g => g.id !== gameId));
        if (activePreset === gameId) {
          handleLoadPreset('bos');
        }
        setLogEntries(prev => [...prev, `🗑 Deleted custom game.`]);
      } else if (res.status === 404) {
        // RED-APP-9/001: clicking Delete on a game someone else already
        // deleted used to re-alert "Game not found." forever — the row was
        // never removed from `userCustomGames`, so the exact same phantom
        // reappeared the instant the alert was dismissed. The server's 404
        // is authoritative here: prune it and re-fetch, same fallback as a
        // normal successful delete if it was the active game.
        setUserCustomGames(prev => prev.filter(g => g.id !== gameId));
        if (activePreset === gameId) {
          handleLoadPreset('bos');
        }
        void refetchUserGames();
        alert('This game was deleted elsewhere; the list has been refreshed.');
      } else {
        // RED-APP-7/001: same dead-token cleanup as Save/Edit — an expired
        // token must not keep asserting "signed in" (header, Save/Edit's own
        // re-auth affordances) after the server has stopped honoring it.
        if (res.status === 401) updateAuthToken(null);
        const data = await res.json();
        alert(data.error || 'Failed to delete game.');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Stale-note guard: reopening the save modal should not resurrect the
  // outcome line from a generation done minutes ago.
  useEffect(() => {
    if (isSaveModalOpen) setGenerateNote('');
    // Both dialogs closed without saving: a later unrelated save or edit must
    // not fire the kept-scenario regeneration. The sign-in detour is the
    // exception — the save modal closes for auth and comes back to finish the
    // same save, so the flag rides along with resumeSaveAfterAuthRef (and,
    // RED-APP-7/001, the same for the Edit dialog's own detour and
    // resumeEditAfterAuthRef). (A successful submit consumes the flag itself
    // before closing, so this only ever cancels.)
    else if (!isEditModalOpen && !resumeSaveAfterAuthRef.current && !resumeEditAfterAuthRef.current) {
      regenExplanationAfterSaveRef.current = false;
    }
  }, [isSaveModalOpen, isEditModalOpen]);

  // Regen preview reset: BOTH dialogs closed (not the sign-in detour, which
  // must preserve an in-progress preview exactly like it preserves the typed
  // fields) means any in-flight or ready regen belongs to a dialog that no
  // longer exists. Bumping the generation here — not just on the next open —
  // is what makes a slow response land nowhere even if the SAME game's Edit
  // dialog is reopened before the response arrives (a fresh open bumps again
  // regardless, so this is redundant-but-cheap insurance for the gap between
  // close and reopen).
  useEffect(() => {
    if (!isSaveModalOpen && !isEditModalOpen && !resumeSaveAfterAuthRef.current && !resumeEditAfterAuthRef.current) {
      regenGenerationRef.current += 1;
      regenControllerRef.current?.abort();
      regenInFlightRef.current = false;
      setRegen({ status: 'idle', preview: null, error: null, note: '' });
    }
  }, [isSaveModalOpen, isEditModalOpen]);

  /**
   * Roll a fresh random game with the chosen equilibrium structure, put it on
   * the board, then ask the AI to invent a scenario for it (the same
   * omit-the-scenario request "New AI scenario" uses) and prefill the save
   * form with the invention. The matrix is applied BEFORE the model call and
   * kept even if that call fails — the game is real either way; only the
   * story is best-effort.
   *
   * THE FORM PREFILL NEVER DESTROYS TYPED TEXT (RED-APP-4, round 4). This used
   * to overwrite `saveName`/`saveDesc`/`saveLabels` unconditionally on every
   * successful call, with no guard for whether the user had already typed
   * into the very form Generate sits inside — reproduced 1/1 against the live
   * site: type a name/description/labels by hand, click Generate once, and
   * they were gone with no undo. The invented story is now applied ONLY when
   * every one of those six fields is either still empty, or still holds
   * exactly what a PRIOR Generate call itself wrote (a re-roll recognising its
   * own earlier output is fine to replace) — never text the user typed. If
   * any field has been hand-edited, none of the six are touched; the matrix
   * still rolls (it was never the field this defect was about), and the note
   * says so instead of silently doing nothing.
   */
  const handleGenerateGame = async () => {
    setGenerateLoading(true);
    setGenerateNote('');
    setSaveError('');
    // Generate rolls a NEW MATRIX — any regen preview (or in-flight regen
    // request) was for the OLD one and must not survive it, same as the
    // dialog-close reset above. The button itself is also hidden while
    // generateLoading (see the JSX), so this only ever clears a preview
    // that was already sitting there from before this click.
    regenGenerationRef.current += 1;
    regenControllerRef.current?.abort();
    regenInFlightRef.current = false;
    setRegen({ status: 'idle', preview: null, error: null, note: '' });
    const g = generateRandomGame(generateKind);
    // Mirror handleLoadPreset: board payoffs, their editable string twins,
    // preset highlight off, sim rebuilt from the start point.
    setActivePreset('custom');
    // Both halves through the SAME commit function. Writing payoffs as raw
    // numbers and rawPayoffs as String(v) left the two agreeing only while every
    // incoming value already satisfied v === clamp(-100,100,r3(v)) — an invariant
    // enforced in server.ts, on the far side of an HTTP boundary. A game saved
    // before that clamp existed would make blur silently rewrite the matrix.
    const gc = commitPayoffs(g);
    setPayoffs(gc);
    setRawPayoffs(rawOf(gc));
    handleReset();
    const kindLabel = generateKind === 'mixed' ? 'mixed-strategy' : 'pure-strategy';
    try {
      const res = await fetch(getApiUrl('/api/report'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payoffs: g }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const env = (await res.json()) as ReportEnvelope;
      // Prefill only from a validated invention — an unvalidated story could
      // contradict the very equilibria the user just asked for.
      const sc = envelopeIsTrustworthy(env) ? env.report?.suggestedScenario : null;
      if (sc) {
        const gen: GeneratedFill = {
          name: (sc.name ?? '').slice(0, 40),
          desc: (sc.description ?? '').slice(0, 800),
          row1: sc.row1 ?? '', row2: sc.row2 ?? '',
          col1: sc.col1 ?? '', col2: sc.col2 ?? '',
        };
        // Read the LIVE form values, not this closure's — the user may have
        // typed during the await above (see the doc comment on saveFieldsRef).
        const safe = generatedFillIsSafe(saveFieldsRef.current, lastGeneratedFillRef.current);
        if (safe) {
          setSaveName(gen.name);
          saveNameBaselineRef.current = gen.name;
          setSaveDesc(gen.desc);
          setSaveLabels({ row1: gen.row1, row2: gen.row2, col1: gen.col1, col2: gen.col2 });
          lastGeneratedFillRef.current = gen;
          setGenerateNote(`New ${kindLabel} game on the board, scenario written by AI — edit anything below, then save.`);
        } else {
          setGenerateNote(`New ${kindLabel} game is on the board. Kept the name/description/option names you'd already typed — the AI wrote a scenario too, but didn't touch your text. Clear ALL of those fields (not just one) to let it fill them in on the next Generate.`);
        }
      } else {
        setGenerateNote(`New ${kindLabel} game is on the board. The AI scenario isn't available right now — name and describe it yourself below.`);
      }
      setLogEntries((prev) => [...prev, `✓ Generated a random game with a ${kindLabel} equilibrium.`]);
    } catch {
      setGenerateNote(`New ${kindLabel} game is on the board. The AI scenario isn't available right now — name and describe it yourself below.`);
      setLogEntries((prev) => [...prev, `✓ Generated a random game with a ${kindLabel} equilibrium (AI description unavailable).`]);
    } finally {
      setGenerateLoading(false);
    }
  };

  const handleSaveGameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cleanText(saveName)) {
      setSaveError('Please enter a game name.');
      return;
    }
    // Signed out: don't send a doomed request whose 401 surfaces as the
    // baffling "Invalid or expired session." — say what to actually do.
    // The banner renders this case as an invitation with a Sign In button,
    // not an error (see the !authToken branch at the saveError render).
    if (!authToken) {
      setSaveError('Sign in or create an account to save this game.');
      return;
    }
    setSaveError('');
    setSaveLoading(true);
    // RED-APP-9/002: minted ONCE per save attempt and reused on every retry
    // (a dropped response after the server already wrote the row must not
    // read as "a new save" the second time) — see the ref's own doc comment.
    if (!saveRequestIdRef.current) saveRequestIdRef.current = crypto.randomUUID();
    const clientRequestId = saveRequestIdRef.current;
    try {
      const res = await fetch(getApiUrl('/api/games'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          // cleanText, not .trim() alone: RED-PUBLIC D — see the matching
          // comment in handleEditGameSubmit above.
          name: cleanText(saveName),
          description: cleanText(saveDesc),
          payoffs,
          row1Label: cleanText(saveLabels.row1),
          row2Label: cleanText(saveLabels.row2),
          col1Label: cleanText(saveLabels.col1),
          col2Label: cleanText(saveLabels.col2),
          // The user's own highlights. Deliberately NOT part of the scenario
          // sent to the model — they colour this description and nothing else.
          colorTermsA: saveTerms.a,
          colorTermsB: saveTerms.b,
          clientRequestId
        })
      });
      const data = await res.json();
      if (res.ok) {
        // This attempt is done (successfully) — the NEXT Save Preset click
        // is a new attempt and must mint its own id, not reuse this one.
        saveRequestIdRef.current = null;
        setUserCustomGames(prev => [...prev, data.game]);
        setActivePreset(data.game.id);
        // Kept-scenario saves rewrite the explanation in the story's terms.
        // Values captured from the submitted form (the user may have edited
        // the prefill) BEFORE the field clears below. The usability guard
        // mirrors the server's scenarioIsUsable — four labels or a real
        // description — because sending an unusable scenario would trigger a
        // fresh invention, the opposite of "use what I just saved".
        if (regenExplanationAfterSaveRef.current) {
          regenExplanationAfterSaveRef.current = false;
          const labels = [saveLabels.row1, saveLabels.row2, saveLabels.col1, saveLabels.col2].map((l) => cleanText(l));
          const desc = cleanText(saveDesc);
          const usable = labels.every(Boolean) || desc.split(/\s+/).length >= 12;
          if (usable) {
            void fetchLlmExplanation(false, {
              name: cleanText(saveName) || undefined,
              row1: labels[0] || undefined, row2: labels[1] || undefined,
              col1: labels[2] || undefined, col2: labels[3] || undefined,
              description: desc || undefined,
            });
          }
        }
        setIsSaveModalOpen(false);
        setSaveName('');
        setSaveDesc('');
        setSaveTerms({ a: [], b: [] });
        setSaveLabels({ row1: '', row2: '', col1: '', col2: '' });
        // The fields are blank again, so any earlier Generate fill is spent —
        // the empty-field branch of handleGenerateGame's guard already covers
        // this, but clearing the ref too keeps it from describing content that
        // no longer exists.
        lastGeneratedFillRef.current = null;
        saveNameBaselineRef.current = '';
        setLogEntries(prev => [...prev, `✓ Saved custom game "${data.game.name}" successfully!`]);
      } else {
        // RED-APP-7/001: same dead-token cleanup as Edit/Delete — see that
        // comment. `authToken` was truthy but dead, so this branch's own
        // `saveError` text ("Invalid or expired session.") used to always
        // take the bare-rose-error render below rather than the friendly
        // `!authToken` one, even though its own wording is exactly the case
        // that branch exists for.
        if (res.status === 401) updateAuthToken(null);
        setSaveError(data.error || 'Failed to save game.');
      }
    } catch (err) {
      setSaveError('Network error. Failed to save game.');
    } finally {
      setSaveLoading(false);
    }
  };

  /**
   * "Regenerate scenario" — ask the model for a NEW description + option
   * labels + colour labelling for the SAME payoff matrix, from either dialog.
   * Never persists anything; never touches the six form fields itself (only
   * `keepRegen` does that, and only on Keep). See the `regen` state's own
   * doc comment above for the staleness/idempotence machinery this leans on.
   */
  const handleRegenerateScenario = async (key: RegenKey) => {
    // Idempotent double-click / Enter-repeat: same tick, so a ref (not state,
    // which would not have committed yet) is the only thing that can gate it.
    if (regenInFlightRef.current) return;
    regenInFlightRef.current = true;
    const myGen = (regenGenerationRef.current += 1);
    setRegen({ status: 'loading', preview: null, error: null, note: REGEN_ANNOUNCE.loading });

    const requestPayoffs = key.kind === 'edit'
      ? userCustomGames.find((g) => g.id === key.gameId)?.payoffs
      : key.payoffs;
    if (!requestPayoffs) {
      // The game vanished (deleted from another tab, say) between opening
      // the dialog and clicking Regenerate — an honest network-style error
      // rather than a silent no-op or a thrown exception.
      if (myGen === regenGenerationRef.current) {
        regenInFlightRef.current = false;
        setRegen({ status: 'error', preview: null, error: 'network', note: REGEN_ERROR_MESSAGES.network() });
      }
      return;
    }
    // `current`: the DIALOG'S live fields (not the last-saved record), sent
    // ONLY so the server can avoid repeating this exact story — never used
    // to shape the prompt beyond that, and never persisted by this route.
    const current = key.kind === 'edit'
      ? { name: cleanText(editName), description: cleanText(editDesc) }
      : { name: cleanText(saveName), description: cleanText(saveDesc) };

    const controller = new AbortController();
    regenControllerRef.current = controller;
    const { promise, clear } = fetchWithTimeout(getApiUrl('/api/scenario/regenerate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payoffs: requestPayoffs, current }),
    }, controller);

    let status: number | null = null;
    let body: { scenario?: RegenPreview | null; error?: string } | null = null;
    let caught: unknown = null;
    try {
      const res = await promise;
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (err) {
      caught = err;
    } finally {
      clear();
    }

    // Staleness: a later click/open/close bumped the generation, OR the
    // dialog now shows a different game than this request was for (Edit A
    // -> Escape -> Edit B; or the Save dialog's matrix changed under it via
    // Generate), OR — the fallback a bare generation check would miss —
    // BOTH dialogs are now closed, so there is no current game at all.
    // `regenCurrentKeyRef.current` is `null` in exactly that case, and
    // `regenResponseIsCurrent` requires an actual `RegenKey` to compare
    // against, so a `null` here must drop the response rather than default
    // to "current" (defaulting to `key` itself would make every response
    // trivially match its own request, defeating the check precisely when
    // the dialog has closed). Drop entirely — no note, no state change.
    const currentKey = regenCurrentKeyRef.current;
    if (!currentKey || !regenResponseIsCurrent({
      myGen, currentGen: regenGenerationRef.current, requestKey: key, currentKey,
    })) {
      if (myGen === regenGenerationRef.current) regenInFlightRef.current = false;
      return;
    }
    regenInFlightRef.current = false;

    if (status === 200 && body?.scenario) {
      setRegen({ status: 'ready', preview: cleanPreview(body.scenario), error: null, note: REGEN_ANNOUNCE.ready });
    } else {
      const kind = regenErrorFromResponse(status, body ?? null, caught);
      setRegen({ status: 'error', preview: null, error: kind, note: REGEN_ERROR_MESSAGES[kind](body?.error) });
    }
  };

  /** Keep: fill the dialog's form fields from the preview. Persisting is
   *  still the existing Save / Save Changes submit — nothing here writes to
   *  the server, so every clamp/cleanText/cleanLabels/cleanColorTerms the
   *  submit already runs still applies unchanged. */
  const keepRegen = (key: RegenKey) => {
    if (!regen.preview) return;
    const baselineRef = key.kind === 'edit' ? editNameBaselineRef : saveNameBaselineRef;
    const liveName = key.kind === 'edit' ? editName : saveName;
    const replaceName = shouldReplaceName(liveName !== baselineRef.current);
    // The user's EXISTING chips for whichever dialog Keep is running in — Keep
    // never destroys them (RED-REGEN/001); `keepFill` only ADDS any actor
    // nouns the draw itself supplies.
    const existingTerms = key.kind === 'edit' ? editTerms : saveTerms;
    const kept = keepFill(regen.preview, replaceName, existingTerms);
    if (key.kind === 'edit') {
      if (kept.name !== undefined) { setEditName(kept.name); editNameBaselineRef.current = kept.name; }
      setEditDesc(kept.desc);
      setEditLabels(kept.labels);
      setEditTerms(kept.terms);
    } else {
      if (kept.name !== undefined) { setSaveName(kept.name); saveNameBaselineRef.current = kept.name; }
      setSaveDesc(kept.desc);
      setSaveLabels(kept.labels);
      setSaveTerms(kept.terms);
    }
    setRegen({
      status: 'idle', preview: null, error: null,
      note: key.kind === 'edit' ? REGEN_ANNOUNCE.keptEdit : REGEN_ANNOUNCE.keptSave,
    });
    regenButtonRef.current?.focus();
  };

  /** Discard: clear the preview only. The six fields and the colour chips
   *  were never written to, so there is nothing to undo. */
  const discardRegen = () => {
    setRegen({ status: 'idle', preview: null, error: null, note: REGEN_ANNOUNCE.discarded });
    regenButtonRef.current?.focus();
  };

  const openFeedback = () => {
    setFeedbackError('');
    setFeedbackSuccess('');
    setIsFeedbackOpen(true);
  };

  const closeFeedback = () => {
    setIsFeedbackOpen(false);
    feedbackLastClosedRef.current = Date.now();
  };

  const handleFeedbackSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedbackText.trim()) {
      setFeedbackError('Please enter your feedback before sending.');
      return;
    }
    setFeedbackError('');
    setFeedbackSuccess('');
    setFeedbackLoading(true);
    try {
      const res = await fetch(getApiUrl('/api/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: feedbackText.trim(),
          email: feedbackEmail.trim() || undefined,
          rating: feedbackRating || undefined
        })
      });
      const data = await res.json();
      if (res.ok) {
        feedbackSubmittedRef.current = true;
        setFeedbackSuccess(data.message || 'Thank you! Your feedback has been sent.');
        setFeedbackText('');
        setFeedbackEmail('');
        setFeedbackRating(0);
        setFeedbackHoverRating(0);
      } else {
        setFeedbackError(data.error || 'Failed to send feedback.');
      }
    } catch (err) {
      setFeedbackError('Network error. Failed to send feedback. Please try again.');
    } finally {
      setFeedbackLoading(false);
    }
  };

  // Close whichever foreground modal is open on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // RED-APP-6/002: Walkthrough.tsx has its own independent `window`-level
      // Escape listener that unconditionally closes the tour AND resets its
      // step to 0. `document` (this listener) fires before `window` in the
      // bubble phase, so stopping propagation HERE, but only when a modal in
      // this chain actually closed, means one Escape closes only the
      // topmost layer: the dialog first, the tour only on a second press
      // with nothing else open. Do not stopPropagation when nothing here was
      // open — that Escape press must still reach the tour.
      if (isFeedbackOpen) { closeFeedback(); e.stopPropagation(); }
      else if (isSaveModalOpen) { setIsSaveModalOpen(false); setSaveError(''); e.stopPropagation(); }
      else if (isAuthModalOpen) { setIsAuthModalOpen(false); setAuthError(''); setAuthSuccess(''); resumeSaveAfterAuthRef.current = false; resumeEditAfterAuthRef.current = false; e.stopPropagation(); }
      // RED-APP-5 001, round 5: the Edit-saved-game dialog was missing from
      // both this chain and the deps array below, so Escape did nothing while
      // it was open — every other modal in the app (and #90's expand-log
      // dialog) closes on Escape; Edit was simply never added to the list.
      // Same close side-effects as its own "✕" button and its backdrop click.
      else if (isEditModalOpen) { setIsEditModalOpen(false); setEditError(''); e.stopPropagation(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isFeedbackOpen, isSaveModalOpen, isAuthModalOpen, isEditModalOpen]);

  /**
   * RED-APP-5 finding 004 (round 5): no `aria-live`/`role="status"`/
   * `role="log"` existed ANYWHERE in the app (confirmed by a whole-file grep
   * returning zero matches) — a screen-reader user running a simulation got
   * no announcement that a run started, paused, or converged; they would
   * have to manually re-navigate to the log or the report area to find out.
   *
   * Deliberately NOT `aria-live` on the log container itself (`role="region"
   * aria-label="Simulation log"` above, unchanged): that fills with a new
   * line on every discovery step of a run — often dozens per second on the
   * tab-wedge fixture — and announcing each one would drown a screen-reader
   * user in noise. Instead, a single hidden `aria-live="polite"` region
   * tracks the run's PHASE (idle / running / paused / converged) and is
   * updated only on a phase TRANSITION, via the `prevPhaseRef` guard below —
   * so it speaks once per state change, never once per log line.
   *
   * The converged phase reuses the SAME gate the "Nash Equilibrium Reached"
   * banner itself uses (`simState.converged && simState.convergedIsNE !==
   * false && !runStale && nearestNE`) — see that block's own comment on why
   * `converged` alone (STATIONARY, not "is an equilibrium") is not enough —
   * so the announcement and the visible banner can never disagree about
   * whether convergence happened.
   */
  const [liveStatus, setLiveStatus] = useState('');
  const prevSimPhaseRef = useRef<'idle' | 'running' | 'paused' | 'converged' | 'settled'>('idle');
  useEffect(() => {
    const isConverged = simState.converged && simState.convergedIsNE !== false && !runStale && !!nearestNE;
    // A run can go STATIONARY at a point that is NOT a Nash equilibrium
    // (`convergedIsNE === false` — regret exceeds tolerance for some player),
    // which the visible "Settled (not an NE)" pill announces unconditionally
    // on `simState.converged` alone (RED-APP-6/001) — gated the same way here,
    // so the live region can never fall through to the generic 'paused' phase
    // (and its "Simulation paused." text, identical to a manual Pause click)
    // for a run that in fact finished, just not at an equilibrium.
    const isSettledNotNE = simState.converged && simState.convergedIsNE === false;
    const phase: typeof prevSimPhaseRef.current = isConverged
      ? 'converged'
      : isSettledNotNE
        ? 'settled'
        : simState.running
          ? 'running'
          : simState.stepCount > 0 ? 'paused' : 'idle';
    if (phase === prevSimPhaseRef.current) return;
    prevSimPhaseRef.current = phase;
    if (phase === 'running') setLiveStatus('Simulation running.');
    else if (phase === 'paused') setLiveStatus('Simulation paused.');
    else if (phase === 'converged') {
      setLiveStatus(`${realisedConcept === 'mixed' ? 'Mixed' : 'Pure'} strategy Nash equilibrium reached.`);
    } else if (phase === 'settled') {
      setLiveStatus('Simulation settled — not a Nash equilibrium.');
    } else setLiveStatus('');
  }, [simState.running, simState.converged, simState.convergedIsNE, simState.stepCount,
      runStale, nearestNE, realisedConcept]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthSuccess('');
    setAuthLoading(true);

    if (authMode === 'login') {
      if (!authEmail || !authPassword) {
        setAuthError('Email and password are required.');
        setAuthLoading(false);
        return;
      }
      try {
        const res = await fetch(getApiUrl('/api/auth/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail, password: authPassword })
        });
        
        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = { error: `Server returned invalid response (Status ${res.status}).` };
        }

        if (res.ok) {
          updateAuthToken(data.token);
          setIsAuthModalOpen(false);
          setAuthEmail('');
          setAuthPassword('');
          setLogEntries(prev => [...prev, `✓ Welcome back, @${data.user.username}! Connected to server database.`]);
        } else if (data.needVerification) {
          setAuthMode('verify');
          setAuthSuccess('Please complete email verification first.');
        } else {
          setAuthError(data.error || 'Invalid credentials.');
        }
      } catch (err) {
        setAuthError('Connection error.');
      } finally {
        setAuthLoading(false);
      }
    } else if (authMode === 'register') {
      if (!authUsername || !authEmail || !authPassword || !authConfirmPassword) {
        setAuthError('All registration fields are required.');
        setAuthLoading(false);
        return;
      }

      // Client-side validations
      if (authPassword !== authConfirmPassword) {
        setAuthError('Passwords do not match. Please ensure both fields are identical.');
        setAuthLoading(false);
        return;
      }

      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
      if (!passwordRegex.test(authPassword)) {
        setAuthError('Password must be at least 8 characters long and contain at least one uppercase and one lowercase letter.');
        setAuthLoading(false);
        return;
      }

      try {
        const res = await fetch(getApiUrl('/api/auth/register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: authUsername, email: authEmail, password: authPassword })
        });
        
        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = { error: `Server returned invalid response (Status ${res.status}).` };
        }

        if (res.ok) {
          if (data.autoVerified) {
            setAuthMode('login');
            setAuthSuccess(data.message || 'Account created successfully inside local database! You are ready to log in.');
          } else {
            setAuthMode('verify');
            setAuthSuccess(data.message || 'Registration successful! A 6-digit confirmation code has been sent to your email address.');
            if (data.verificationCode) {
              setAuthCode(data.verificationCode);
            }
          }
        } else {
          setAuthError(data.error || 'Registration failed.');
        }
      } catch (err) {
        setAuthError('Connection error.');
      } finally {
        setAuthLoading(false);
      }
    } else if (authMode === 'verify') {
      if (!authCode) {
        setAuthError('Please enter the 6-digit confirmation code.');
        setAuthLoading(false);
        return;
      }
      try {
        const res = await fetch(getApiUrl('/api/auth/verify'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail, code: authCode })
        });

        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = { error: `Server returned invalid response (Status ${res.status}).` };
        }

        if (res.ok) {
          setAuthMode('login');
          setAuthSuccess('Account verified successfully! You can now log in.');
          setAuthCode('');
        } else {
          setAuthError(data.error || 'Incorrect confirmation code.');
        }
      } catch (err) {
        setAuthError('Connection error.');
      } finally {
        setAuthLoading(false);
      }
    } else if (authMode === 'forgot') {
      if (!authEmail) {
        setAuthError('Please enter your email address.');
        setAuthLoading(false);
        return;
      }
      try {
        const res = await fetch(getApiUrl('/api/auth/forgot-password'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail })
        });

        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = { error: `Server returned invalid response (Status ${res.status}).` };
        }

        if (res.ok) {
          setAuthMode('reset-password');
          setAuthSuccess(data.message || 'Recovery code sent! Check your email.');
          if (data.recoveryCode) setAuthCode(data.recoveryCode);
        } else {
          setAuthError(data.error || 'Failed to send recovery code.');
        }
      } catch (err) {
        setAuthError('Connection error.');
      } finally {
        setAuthLoading(false);
      }
    } else if (authMode === 'reset-password') {
      if (!authCode || !authPassword || !authConfirmPassword) {
        setAuthError('Recovery code, new password, and confirmation are all required.');
        setAuthLoading(false);
        return;
      }
      if (authPassword !== authConfirmPassword) {
        setAuthError('Passwords do not match.');
        setAuthLoading(false);
        return;
      }
      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
      if (!passwordRegex.test(authPassword)) {
        setAuthError('Password must be at least 8 characters long and contain at least one uppercase and one lowercase letter.');
        setAuthLoading(false);
        return;
      }
      try {
        const res = await fetch(getApiUrl('/api/auth/reset-password'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail, code: authCode, newPassword: authPassword })
        });

        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = { error: `Server returned invalid response (Status ${res.status}).` };
        }

        if (res.ok) {
          setAuthMode('login');
          setAuthSuccess(data.message || 'Password reset successfully! You can now log in.');
          setAuthCode('');
          setAuthPassword('');
          setAuthConfirmPassword('');
        } else {
          setAuthError(data.error || 'Failed to reset password.');
        }
      } catch (err) {
        setAuthError('Connection error.');
      } finally {
        setAuthLoading(false);
      }
    }
  };

  // ── Dynamic Presets Mapping ────────────────────────────────────────────────
  const mergedPresets = useMemo(() => {
    const merged: Record<string, PresetGame> = { ...PRESETS };
    userCustomGames.forEach((g) => {
      merged[g.id] = {
        key: g.id,
        name: g.name,
        a11: g.payoffs.a11, b11: g.payoffs.b11,
        a12: g.payoffs.a12, b12: g.payoffs.b12,
        a21: g.payoffs.a21, b21: g.payoffs.b21,
        a22: g.payoffs.a22, b22: g.payoffs.b22,
        desc: g.description || '',
        // Saved games carry option labels exactly like presets do. Merging them
        // here rather than reading them separately downstream keeps ONE source
        // of labels, so the headers above the payoff inputs and the nouns sent
        // to the explainer can never disagree about what Row 1 is called.
        row1Label: g.row1Label,
        row2Label: g.row2Label,
        col1Label: g.col1Label,
        col2Label: g.col2Label,
        colorTermsA: g.colorTermsA,
        colorTermsB: g.colorTermsB,
      };
    });
    return merged;
  }, [userCustomGames]);

  const selectedPreset = mergedPresets[activePreset];
  const selectedCustomGame = userCustomGames.find((g) => g.id === activePreset);

  // The nouns this game already has. Without them the explainer can only say
  // "Player A plays Row 1" — the Search Game has "Search L"/"Hide R" sitting
  // unused in its preset, and a saved custom game has whatever story the user
  // wrote. The server decides whether it is enough to use or whether to invent
  // one, so this just hands over everything available.
  const scenarioForReport = useMemo(() => {
    const p = mergedPresets[activePreset];
    const custom = userCustomGames.find((g) => g.id === activePreset);
    // Only if the matrix still MATCHES the selected game. Editing the payoffs
    // does not clear activePreset, so without this check a tweaked Battle of the
    // Sexes would still be explained in terms of opera and football — a story
    // those numbers no longer tell. When they diverge, send nothing and let the
    // model invent a scenario that fits what is actually on screen.
    const matches = p
      && p.a11 === payoffs.a11 && p.a12 === payoffs.a12
      && p.a21 === payoffs.a21 && p.a22 === payoffs.a22
      && p.b11 === payoffs.b11 && p.b12 === payoffs.b12
      && p.b21 === payoffs.b21 && p.b22 === payoffs.b22;
    if (!matches) return undefined;

    const sc = {
      name: custom?.name ?? p?.name,
      row1: p?.row1Label,
      row2: p?.row2Label,
      col1: p?.col1Label,
      col2: p?.col2Label,
      description: custom?.description ?? p?.desc,
    };
    return Object.values(sc).some(Boolean) ? sc : undefined;
  }, [activePreset, mergedPresets, userCustomGames, payoffs]);

  /**
   * What to CALL each option in the UI, falling back to "Row 1" / "Col 2".
   *
   * Derived from scenarioForReport rather than read fresh off the preset, so it
   * inherits that memo's matches-the-matrix gate for free: edit the payoffs away
   * from the saved game and the headers revert to generic names in the same
   * instant the explainer stops being told the story. Reading the labels
   * independently would leave "Undercut" sitting above a matrix that is no
   * longer the undercutting game.
   */
  const activeLabels = useMemo(() => ({
    row1: scenarioForReport?.row1 || 'Row 1',
    row2: scenarioForReport?.row2 || 'Row 2',
    col1: scenarioForReport?.col1 || 'Col 1',
    col2: scenarioForReport?.col2 || 'Col 2',
  }), [scenarioForReport]);

  /**
   * Terms ColorCoded highlights in AI/user text, per player. Inherits
   * scenarioForReport's matches-the-matrix gate the same way activeLabels
   * does: edit the payoffs away from the preset and the actor nouns stop
   * being colored in the same instant the story stops being sent.
   */
  const colorTerms = useMemo(() => {
    // "Player A"/"Player B" used to be terms here; Daniel had them dropped —
    // with the bare letters already gray, the phrases read as leftover noise.
    // The structural Row/Col terms live in colorTermsFor so the suggestion card
    // and the saved description cannot disagree about how much text is colored.
    const p = scenarioForReport ? mergedPresets[activePreset] : undefined;
    return colorTermsFor(scenarioForReport, p?.actorA ?? [], p?.actorB ?? []);
  }, [scenarioForReport, mergedPresets, activePreset]);

  /**
   * The same terms plus the user's own highlights — for the selected custom
   * game's description card, and ONLY that. `colorTerms` above stays the pair
   * the AI explanation renders with, so a user's highlights can never reach the
   * model's prose.
   *
   * Hoisted out of the JSX because it was called twice there with identical
   * arguments, once for `aTerms` and once for `bTerms`. Two calls that must
   * agree is the same shape as two lists that must agree, one `??` away from
   * the drawer defect this change set exists to remove.
   */
  const descriptionTerms = useMemo(() => descriptionColorTerms(
    scenarioForReport,
    mergedPresets[activePreset]?.actorA ?? [],
    mergedPresets[activePreset]?.actorB ?? [],
    Array.isArray(selectedPreset?.colorTermsA) ? selectedPreset.colorTermsA : [],
    Array.isArray(selectedPreset?.colorTermsB) ? selectedPreset.colorTermsB : [],
  ), [scenarioForReport, mergedPresets, activePreset, selectedPreset]);

  /**
   * The automatic terms each description dialog's PREVIEW merges the user's
   * highlights onto — built from that dialog's own Option Names.
   *
   * Both previews used to be handed `colorTerms`, i.e. the terms of whatever
   * game was selected in the main panel. That is neither the game the dialog is
   * editing nor the labels being typed into the form, and it broke the
   * preview's stated promise in both directions: the save dialog under-coloured
   * (type four new option names, preview one highlight, save four), and the
   * pencil over-coloured, because it opens the edit dialog WITHOUT selecting
   * the row — so the preview borrowed the still-selected game's option names
   * and promised highlights the save then dropped.
   *
   * A pleasant side effect of reading the dialog's own state: the preview now
   * updates as the Option Names are typed, which it never did.
   */
  const saveBaseTerms = useMemo(() => dialogBaseColorTerms(saveLabels), [saveLabels]);
  const editBaseTerms = useMemo(() => dialogBaseColorTerms(editLabels), [editLabels]);
  // Exactly what Keep will store and DescriptionEditor will then render —
  // `regenPreviewColorTerms` is the ONE function both this preview card and
  // the post-Keep saved render compose through (RED-REGEN/002), fed the
  // CURRENT dialog's existing chips so the preview also reflects RED-REGEN/001:
  // Keep never wipes them, it only adds any actor nouns the draw supplies.
  // Only one dialog is ever open at a time, so `isEditModalOpen` alone picks
  // the right existing-chip source.
  const regenPreviewTerms = useMemo(() => {
    if (!regen.preview) return { a: [], b: [] };
    const existing = isEditModalOpen ? editTerms : saveTerms;
    return regenPreviewColorTerms(
      regen.preview, regen.preview.actorA ?? [], regen.preview.actorB ?? [], existing.a, existing.b,
    );
  }, [regen.preview, isEditModalOpen, editTerms, saveTerms]);


  // Clamp a whole matrix through the one cell parser, and derive its editable
  // string twin from the RESULT — so payoffs and rawPayoffs cannot disagree
  // whatever a preset, a generated game or a saved game supplies.
  const commitPayoffs = (g: GamePayoffs): GamePayoffs => ({
    a11: commitPayoffInput(String(g.a11)), b11: commitPayoffInput(String(g.b11)),
    a12: commitPayoffInput(String(g.a12)), b12: commitPayoffInput(String(g.b12)),
    a21: commitPayoffInput(String(g.a21)), b21: commitPayoffInput(String(g.b21)),
    a22: commitPayoffInput(String(g.a22)), b22: commitPayoffInput(String(g.b22)),
  });
  const rawOf = (g: GamePayoffs): Record<keyof GamePayoffs, string> => ({
    a11: String(g.a11), b11: String(g.b11), a12: String(g.a12), b12: String(g.b12),
    a21: String(g.a21), b21: String(g.b21), a22: String(g.a22), b22: String(g.b22),
  });

  // ── Preset loader action ───────────────────────────────────────────────────
  const handleLoadPreset = (key: string) => {
    setActivePreset(key);
    if (key !== 'custom') {
      const preset = mergedPresets[key];
      if (preset) {
        const payload: GamePayoffs = {
          a11: preset.a11 ?? 0, b11: preset.b11 ?? 0,
          a12: preset.a12 ?? 0, b12: preset.b12 ?? 0,
          a21: preset.a21 ?? 0, b21: preset.b21 ?? 0,
          a22: preset.a22 ?? 0, b22: preset.b22 ?? 0,
        };
        // Same single commit path as the generator and the editor.
        const clamped = commitPayoffs(payload);
        setPayoffs(clamped);
        setRawPayoffs(rawOf(clamped));
      }
    }
    handleReset();
  };

  // ── Reset entire simulation ────────────────────────────────────────────────
  const handleReset = (overridePayoffs?: GamePayoffs) => {
    const rp = overridePayoffs ?? payoffs;
    setRunCtx(null);
    // Same single parser as handleStep — the two must agree on where a run
    // begins, or the markers sit somewhere the run never starts from.
    const startValX = commitStartCoordinate(x0);
    const startValY = commitStartCoordinate(y0);

    const initSegA = { xs: [startValX], ys: [startValY], zs: [r3(EA(startValX, startValY, rp))], mover: 'A' as const };
    const initSegB = { xs: [startValX], ys: [startValY], zs: [r3(EB(startValX, startValY, rp))], mover: 'A' as const };

    setSimState({
      cx: startValX,
      cy: startValY,
      exactX: startValX,
      exactY: startValY,
      calcX: startValX,
      calcY: startValY,
      displayX: startValX,
      displayY: startValY,
      startX: startValX,
      startY: startValY,
      domainLo: 0,
      domainHi: 1,
      domXLo: 0,
      domXHi: 1,
      domYLo: 0,
      domYHi: 1,
      stratX: startValX,
      stratY: startValY,
      cycleCount: 0,
      visitedPositions: [],
      ghostVisitedPositions: [],
      discoveredMixedX: null,
      discoveredMixedY: null,
      foundAxis: null,
      running: false,
      converged: false,
      stepCount: 0,
      pathSegmentsA: [initSegA],
      pathSegmentsB: [initSegB],
      phase1PtsA: null, phase1PtsB: null,
      ghostPathSegmentsA: [],
      ghostPathSegmentsB: [],
      cyclePattern: null, bisecting: false,
      bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
      ghostCyclePattern: null, ghostBisecting: false,
      ghostBisectGoodLo: 0, ghostBisectGoodHi: 1, ghostBisectBadLo: 0, ghostBisectBadHi: 1
    });

    setLogEntries(['Set starting point and first mover, then click Run or Step.']);
    setInitialized(false);
    // A reset is a fresh picture — restart the idle spin immediately, even if
    // earlier graph activity had halted it or its countdown was mid-flight.
    // (Covers preset loads too: handleLoadPreset funnels through here.)
    setTourSpinNonce((n) => n + 1);
    thinHistoryRef.current = [];
    scrubPosRef.current = 0;
    initStateRef.current = null;
    neSnapshotRef.current = null;
    setThinHistory([]);
    setRunTruncated(false);
    setNeSnapshot(null);
    setJumpInput('');
  };

  /**
   * Re-freeze the simulation whenever the start point is edited.
   *
   * Typing a new x0/y0 only cleared `initialized`, which tells the NEXT run to
   * start fresh but leaves the picture showing the OLD position — so the markers
   * sat at the previous start until you pressed Run or Reset, and the number in
   * the box disagreed with the dot on the surface. handleReset rebuilds the
   * frozen, ready-to-run state from the current fields, which is exactly what
   * the edit is asking for.
   *
   * Runs after the state update rather than inside the input handler, because
   * handleReset reads x0/y0 from the render it was created in and would
   * otherwise reset to the value being replaced.
   */
  useEffect(() => {
    handleReset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x0, y0]);

  // ── Play/Pause toggle ──────────────────────────────────────────────────────
  const togglePlay = () => {
    if (!initialized) {
      handleStep(true);
      return;
    }
    const snaps = thinHistoryRef.current;
    if (snaps.length > 0 && scrubPosRef.current >= snaps.length - 1) {
      setLogEntries(prev => [...prev, '✓ Equilibrium reached. Choose Reset to restart.']);
      return;
    }
    setSimState((prev: SimState) => ({ ...prev, running: !prev.running }));
  };

  /* ── Guided tour ──────────────────────────────────────────────────────────
   *
   * A general introduction to mixed equilibria, staged on a concrete game. The
   * point it exists to land is the one the picture makes and prose usually
   * cannot: a player's equilibrium mixture is computed from the OPPONENT's
   * payoffs, so it holds the opponent indifferent rather than serving the
   * player's own interest.
   *
   * Steps point at live elements by `data-tour`, and a couple of them drive the
   * app so the visitor sees the thing being described rather than reading about
   * it. Shown once, then remembered — the header keeps a control to replay it.
   */
  const [tourOpen, setTourOpen] = useState(false);
  /**
   * Points the tour is currently talking about, drawn on the surfaces with each
   * player's payoff labelled. Empty except while a step is discussing one.
   */
  const [tourPoints, setTourPoints] = useState<{ x: number; y: number; accent?: 'gold' | 'purple' }[]>([]);
  /** Trace names the current tour step wants switched off. Held in state (not
   *  rebuilt inline) so its identity is stable between steps. */
  const [tourHiddenTraces, setTourHiddenTraces] = useState<string[]>([]);
  /** Bumped on every step so the idle spin restarts; and cleared on the one step
   *  that runs the simulation, where a turning camera would fight the markers. */
  const [tourSpinNonce, setTourSpinNonce] = useState(0);
  const [tourSpinAllowed, setTourSpinAllowed] = useState(true);

  /**
   * RED-APP-8/001: distinguishes "never signed in this session" from
   * "was signed in and just got 401'd" (e.g. an expired token cleared by
   * updateAuthToken(null) on a failed Save/Edit/Delete). Without this, the
   * effect below — keyed on every `authToken` transition, not just mount —
   * cannot tell the two apart and reopens the tour mid-session for a visitor
   * who was never anonymous to begin with.
   */
  const everAuthedRef = useRef(!!authToken);

  /**
   * Runs on EVERY load, including a refresh — but not for a signed-in visitor,
   * and not for a visitor whose token merely died mid-session (that visitor
   * already saw the app once; auto-opening the tour on top of their own game
   * would be uninvited, and the tour's first step replaces the active game).
   *
   * Gated on `authToken` rather than on `user`, because the token is read from
   * localStorage synchronously while `user` only arrives after /api/auth/me
   * answers. Waiting for `user` would flash the tour at returning members for a
   * few hundred milliseconds on every page load.
   */
  useEffect(() => {
    if (authToken) {
      everAuthedRef.current = true;
      return;
    }
    if (everAuthedRef.current) return;
    const t = setTimeout(() => setTourOpen(true), 700);
    return () => clearTimeout(t);
  }, [authToken]);

  /**
   * Armed only by the tour's run step: stop the simulation the moment either
   * NE coordinate is discovered, so the frame the visitor is left looking at
   * is the first line going flat — and the next step's caption explains the
   * thing that just happened rather than something long past. Watching state
   * rather than hooking the playback loop means it works no matter how the
   * run was started, and clicking Next before the pause fires is fine: the
   * flat-line step stages its own picture anyway.
   */
  const [tourPauseAtFirstFind, setTourPauseAtFirstFind] = useState(false);
  useEffect(() => {
    if (!tourPauseAtFirstFind || !simState.running) return;
    // Fire on the DECLARATION itself. Regret mode now declares coordinates
    // individually, so the moment a coordinate is found is one frame: the log
    // line prints, the corridor collapses, the line snaps level, and the
    // 1st-NE-Coord snapshot points here — pausing on the same frame keeps
    // every indicator telling one story. (An older version watched the
    // rename thresholds because declaration only happened at convergence.)
    if ((simState.discoveredMixedX !== null) !== (simState.discoveredMixedY !== null)) {
      setSimState((prev) => ({ ...prev, running: false }));
    }
  }, [tourPauseAtFirstFind, simState, payoffs]);

  /* Deferred work scheduled by tour steps (delayed handleStep, delayed
   * resume). Every timer goes through tourDefer so that entering ANY step
   * first cancels whatever a previous step left in flight — otherwise a
   * leftover "start running" or "take the first step" callback fires into the
   * frame the NEW step just staged, and what the visitor sees depends on how
   * fast they clicked. Determinism rule: a step's onEnter must fully own
   * everything that happens until the next onEnter. */
  const tourTimersRef = useRef<number[]>([]);
  const tourDefer = (fn: () => void, ms: number) => {
    tourTimersRef.current.push(window.setTimeout(fn, ms));
  };
  const clearTourTimers = () => {
    tourTimersRef.current.forEach((t) => window.clearTimeout(t));
    tourTimersRef.current = [];
  };

  /* Request that the sim be staged AT the first-find frame (the step the
   * "1st NE Coord" button names — 24 on the tour's Penalty Kick run), with an
   * optional resume. Steps 14/15 must show the SAME animation no matter how
   * the visitor arrived — waited out the pause, clicked past it early, or came
   * Back from a later step — so they never reuse whatever the live run left
   * behind: they reset and rebuild through this request instead.
   *
   * It is a state+effect rather than a direct call chain because onEnter's own
   * render can still have initialized=true (entering from a live run): a
   * handleStep captured in THAT closure takes the incremental branch and
   * no-ops against the just-cleared history. The effect below runs after the
   * reset commits, with fresh closures. */
  const [tourFirstFindReq, setTourFirstFindReq] = useState<{ resume: boolean; nonce: number } | null>(null);

  const closeTour = useCallback(() => {
    tourTimersRef.current.forEach((t) => window.clearTimeout(t));
    tourTimersRef.current = [];
    setTourFirstFindReq(null);
    setTourOpen(false);
    setTourPoints([]);
    setTourHiddenTraces([]);
    setTourPauseAtFirstFind(false);
    // Restart the idle spin: the click that closed the tour may have landed
    // inside the plot and taken the wheel, and the effect's deps don't change
    // on tour exit — without a nonce bump the always-on spin would stay dead.
    setTourSpinNonce((n) => n + 1);
    setTourSpinAllowed(true);
    setSpeed(5);
    setShrinkStep(0.1);
    setShrinkStepRaw('0.100');
  }, []);

  /**
   * Rebuilt every render ON PURPOSE — do not memoise this.
   *
   * The steps close over handleReset/handleStep/handleLoadPreset, which in turn
   * read the CURRENT payoffs, start coordinates and equilibria. Wrapping the
   * array in useMemo with an empty dependency list froze the first render's
   * closures, so the "watch greedy play" step ran the simulation against the
   * preset that happened to be loaded at mount (Battle of the Sexes) instead of
   * the game the tour had just switched to. It converged to a corner in three
   * steps and the chase sat motionless — the one step whose entire job is to
   * move. Walkthrough keeps the active index in its own state and keys its
   * effects on step.target, so a fresh array each render costs nothing.
   */
  /**
   * Put the app into the state an act ASSUMES, from whatever state it is in.
   *
   * Act setup used to live only on the first step of each act, which worked
   * going forwards and broke going back: stepping back into the dilemma left
   * the mixed game's payoffs and surfaces on screen, because nothing on those
   * earlier steps ever said "be the Prisoner's Dilemma". Every step now declares
   * its act, so each one is reachable from either direction.
   *
   * The preset is only reloaded when it is actually wrong — reloading on every
   * step would throw away the discovered-equilibrium state that the indifference
   * steps deliberately stage.
   */
  const FROZEN_HIDDEN = [TRACE.startPoint, TRACE.posA, TRACE.posB];

  const enterDilemmaAct = () => {
    // A step owns everything until the next step: kill any delayed
    // handleStep/resume a previous step scheduled, or it fires into the
    // frame this step is about to stage.
    clearTourTimers();
    setTourFirstFindReq(null);
    setTourSpinNonce((n) => n + 1);
    setTourSpinAllowed(true);
    setTourPauseAtFirstFind(false);
    if (activePreset !== 'pd') {
      handleLoadPreset('pd');
    }
    // ALWAYS re-assert the start point and mover — not just on preset switch.
    // The visitor can edit them mid-tour, and a step's animation must not
    // depend on that: same entry, same run, every time. (Setting the same
    // value is a no-op; a changed value triggers the re-freeze reset, which
    // the staged steps do anyway.)
    setX0('0.217');
    setY0('0.217');
    changeFirstMover('A');
    changeStepMode('shrink');
    setTrackingMode('both');
    setTourPoints([]);
    setSimState((prev) => ({ ...prev, discoveredMixedX: null, discoveredMixedY: null, foundAxis: null }));
    setTourHiddenTraces(FROZEN_HIDDEN);
  };

  /**
   * The mixed act, frozen. Position markers stay hidden here for the same reason
   * they do in the dilemma: nothing is running, so a pair of dots parked at the
   * start point is furniture. The final step turns them back on, because there
   * they are the thing being watched.
   */
  const enterMixedAct = (extraHidden: string[] = []) => {
    // Same ownership rule as enterDilemmaAct: cancel anything in flight.
    clearTourTimers();
    setTourFirstFindReq(null);
    setTourSpinNonce((n) => n + 1);
    setTourSpinAllowed(true);
    setTourPauseAtFirstFind(false);
    // λ = 0.3 for the whole act — ONE value, set here and nowhere else. The
    // run, the scrub history, the jump-box replay and the 1st-NE-Coord
    // snapshot all step with the live shrinkStep, so two different λs in the
    // act put the button, the pause and the replay on different timelines
    // (measured: jump-to-47 landed on a converged frame 30 because the replay
    // contracted faster than the history it replayed).
    setShrinkStep(0.3);
    setShrinkStepRaw('0.300');
    if (activePreset !== 'penalty') {
      handleLoadPreset('penalty');
    }
    // ALWAYS re-assert start point and mover, not just on preset switch —
    // mid-tour edits must not change what a step's animation looks like.
    // Far from the equilibrium at (0.1, 0.3), so the chase has distance to
    // run and the position markers start well clear of the NE diamonds.
    setX0('0.800');
    setY0('0.200');
    changeFirstMover('A');
    // Deliberately does NOT set the convergence method. It used to force
    // 'shrink' here, so every step had to re-assert 'regret' or be silently
    // flipped back — which is what happened on the last step and left the
    // visitor in Domain Shrink after the tour ended. Each step now says what it
    // needs, and the method is left alone otherwise.
    setTrackingMode('both');
    setSimState((prev) => ({ ...prev, discoveredMixedX: null, discoveredMixedY: null, foundAxis: null }));
    setTourHiddenTraces([...FROZEN_HIDDEN, ...extraHidden]);
  };

  const tourSteps: TourStep[] = [
    // ── Act 1: the familiar game ─────────────────────────────────────────────
    // Almost everyone has met the Prisoner's Dilemma, so it costs nothing to
    // explain and buys a reader who already knows the answer — and can therefore
    // check the PICTURE against what they already believe. It also sets up the
    // contrast the rest depends on: its surface never goes level, so there is
    // nothing to balance and no reason to mix.
    {
      target: 'matrix',
      title: 'Start somewhere familiar',
      body:
        'The Prisoner\'s Dilemma. Two suspects, each choosing to stay silent or confess, with no chance to '
        + 'talk first. Look at the four cells: that table is the whole game.',
      onEnter: () => {
        enterDilemmaAct();
        moveCamera(CAMERA.overview, 600);
      },
    },
    {
      target: 'plot',
      title: 'The same game, as a shape',
      body:
        'Here is that table drawn as a surface. Height is what a player expects to earn, and the two floor '
        + 'axes are how often each of them stays silent. The plot draws both players\' surfaces together, '
        + 'so you can see what one choice does to each of them.',
      onEnter: () => {
        enterDilemmaAct();
        moveCamera(CAMERA.overview, 800);
      },
    },
    {
      // Sits between the surface being introduced and the corners being toured,
      // because "where does that shape come from" is the question a reader asks
      // the moment they see it, and every later step leans on the answer.
      target: 'ep',
      title: 'Where the shape comes from',
      body:
        'Each player\'s height is one formula. Take every cell of the table, multiply its payoff by how likely '
        + 'that cell is (x times y for the top-left, and so on for the other three), and add the four up. '
        + 'That single expression in x and y is what gets plotted. It is why the surface is straight along '
        + 'each axis on its own and only bends where the two probabilities multiply together.',
      onEnter: () => {
        enterDilemmaAct();
        moveCamera(CAMERA.overview, 700);
      },
    },
    {
      target: 'plot',
      title: 'The corner where they cooperate',
      body:
        'Swing round to the corner where both stay silent. Both surfaces sit high here, three each, the best '
        + 'combined outcome in the game. Remember this corner.',
      onEnter: () => {
        enterDilemmaAct();
        setTourPoints([{ x: 1, y: 1 }]);
        moveCamera(CAMERA.cornerRow1Col1, 1100);
      },
    },
    {
      target: 'plot',
      title: 'And the corner they actually reach',
      body:
        'Now the opposite corner, where both confess. Both surfaces are lower, one each. This is the '
        + 'equilibrium: the only cell where neither player can improve by changing their mind alone.',
      onEnter: () => {
        enterDilemmaAct();
        setTourPoints([{ x: 0, y: 0 }]);
        moveCamera(CAMERA.cornerRow2Col2, 1300);
      },
    },
    {
      // Targets the PLOT, not the equilibrium readout. The claim here is a
      // comparison between two heights, and pointing at the text panel scrolls
      // the surfaces off screen — leaving the labelled corners, which are the
      // entire evidence for the sentence, invisible.
      target: 'plot',
      title: 'The stable corner is the worse corner',
      body:
        'Both players would rather be at the first corner, and neither can get there. An equilibrium is just '
        + 'the cell where nobody can gain by moving alone. Nothing about that makes it a good outcome, and '
        + 'here it is the worse one.',
      onEnter: () => {
        enterDilemmaAct();
        setTourPoints([{ x: 1, y: 1 }, { x: 0, y: 0 }]);
        moveCamera(CAMERA.overview, 900);
      },
    },

    // ── Act 2: no dominant move, so the surface must go level ────────────────
    {
      target: 'matrix',
      title: 'Now take the dominance away',
      body:
        'A penalty kick: the kicker picks a side to shoot, the goalie picks a side to dive, at the same '
        + 'instant. This time neither side has a move that is always best, and what helps one hurts the '
        + 'other, so no corner can hold still.',
      onEnter: () => {
        enterMixedAct();
        // Shrink here only because the regret renderer would draw strategy lines,
        // and these two steps are introducing the surface, not the method.
        changeStepMode('shrink');
        setTourPoints([]);
        moveCamera(CAMERA.mixedOpen, 900);
      },
    },
    {
      target: 'plot',
      title: 'A surface with a twist in it',
      body:
        'Same kind of picture, different shape. This one runs straight along each axis but bends through a '
        + 'single twist. The twist is where the two players\' choices interact.',
      onEnter: () => {
        enterMixedAct();
        // Shrink here only because the regret renderer would draw strategy lines,
        // and these two steps are introducing the surface, not the method.
        changeStepMode('shrink');
        setTourPoints([]);
        moveCamera(CAMERA.mixedOpen, 900);
      },
    },
    // ── Act 3: regret — teach the lean BEFORE naming it ──────────────────────
    // The order is deliberate: show one leaning line, then both, then give the
    // lean its name at the method toggle, run the search and watch the leans
    // flatten, and only then present flatness as indifference. An earlier cut
    // presented the flat lines first and mentioned "the lean" afterwards — a
    // reference to something the reader had never been shown.
    {
      target: 'plot',
      title: 'A leaning line is an instruction',
      body:
        'Take an example point, away from any equilibrium: both players at an even half-half mix, the marked '
        + 'spot. This line is A\'s payoff as A alone varies their mix, with B held still there. It leans, '
        + 'and a leaning line is an instruction: slide to its high end. The high end is always a corner, '
        + 'all-in on one option, never a blend. As long as the line leans, A wants a corner.',
      onEnter: () => {
        // Regret mode with NOTHING solved: the strategy lines render at the
        // domain midpoints, tilted. B's line is hidden so the first lean is
        // read on its own; running:false because the visitor may arrive here
        // by stepping Back from the run.
        enterMixedAct([TRACE.strategyB]);
        changeStepMode('regret');
        // Full reset, not just running:false — arriving here by stepping Back
        // from the run otherwise keeps its path stripes and corridor residue
        // on screen, burying the one line this step exists to show.
        handleReset();
        // The example point the caption talks through, marked with its payoffs
        // exactly like the dilemma corners were. After a reset the strategy
        // lines are drawn at the domain midpoints, so (0.5, 0.5) is not a
        // stand-in for the example — it IS the point the lines pass through.
        setTourPoints([{ x: 0.5, y: 0.5 }]);
        moveCamera(CAMERA.edgeOn, 1100);
      },
    },
    {
      target: 'plot',
      title: 'The other line leans too',
      body:
        'Through the same marked point, B\'s line does the same job along B\'s own axis. It also leans, so B '
        + 'is pulled to a corner at its own high end. Two leaning lines through one point, two players each '
        + 'pulled away from the middle. Nothing in this picture, so far, would ever produce a mixture.',
      onEnter: () => {
        enterMixedAct();
        changeStepMode('regret');
        handleReset();
        setTourPoints([{ x: 0.5, y: 0.5 }]);
        moveCamera(CAMERA.mixedOpen, 1100);
      },
    },
    {
      target: 'method',
      title: 'The lean has a name',
      body:
        'That lean is Opponent Regret: how much better a player could still do against what the other one is '
        + 'actually playing. The steeper the line, the more is left on the table. This method watches the lean '
        + 'itself, and moves the players step by step so that it shrinks.',
      onEnter: () => {
        enterMixedAct();
        changeStepMode('regret');
        handleReset();
        setTourPoints([]);
      },
    },
    {
      target: 'coords',
      title: 'Each player gets a shrinking corridor',
      body:
        'Every player also carries a boundary: a range of mixes still worth considering. As regret falls, '
        + 'both corridors contract from both sides at once. But they do not finish together.',
      onEnter: () => {
        enterMixedAct();
        changeStepMode('regret');
        handleReset();
        setTourPoints([]);
        moveCamera(CAMERA.topDown, 900);
      },
    },
    {
      // Points at the GRAPH: the run starts itself, so the thing to look at is
      // the lines losing their lean, not the button that started it.
      target: 'plot',
      title: 'Watch the leans flatten',
      body:
        'The search is running. Self-interest alone always points at a corner (the best reply to any opponent '
        + 'mix is a pure strategy, never a blend), so it can never name an interior point. The contracting '
        + 'boundaries carry the search inward instead: both lines flatten together, and the one that began '
        + 'nearer level reaches indifference first. The moment it does, the run pauses.',
      onEnter: () => {
        enterMixedAct();
        changeStepMode('regret');
        setTourPoints([]);
        setTourPauseAtFirstFind(true);
        // 1x so the few-dozen-step run (λ = 0.3, set by enterMixedAct) plays
        // at a readable pace. Restored on tour close.
        setSpeed(1);
        // The markers come back ON here: this is the only step where anything is
        // moving, and they are what the visitor is being asked to watch — and
        // the idle spin stays off for the same reason, including after the run
        // converges, so the result can be read against a still camera.
        setTourHiddenTraces([]);
        setTourSpinAllowed(false);
        // Side-on rather than top-down: the flattening the caption promises is
        // a change in TILT, which a straight-down camera cannot show.
        moveCamera(CAMERA.mixedOpen, 800);
        handleReset();
        tourDefer(() => handleStep(true), 350);
      },
    },
    {
      target: 'plot',
      title: 'The first lean disappears',
      body:
        'The run paused the moment this happened: one line has gone completely flat, and its coordinate is '
        + 'found. No lean means no regret left; every mix now pays that player exactly the same. That is '
        + 'indifference, found rather than declared. The other line still leans, its corridor is still '
        + 'closing, and the search carries on there.',
      onEnter: () => {
        // Unconditional: ALWAYS rebuild the run and jump to the first-find
        // frame — the exact step the pause on the previous step lands on
        // (the run is deterministic, so this IS that frame, contracted
        // corridors and drawn paths included, not a staged lookalike).
        // Earlier versions kept the live frame when the pause had fired and
        // staged an approximation otherwise, which meant what this step
        // showed depended on how fast the visitor clicked.
        enterMixedAct();
        changeStepMode('regret');
        setTourPoints([]);
        setSpeed(1);
        handleReset();
        setTourFirstFindReq({ resume: false, nonce: Date.now() });
        moveCamera(CAMERA.edgeOn, 1100);
      },
    },
    {
      target: 'plot',
      title: 'Now watch the second coordinate',
      body:
        'The first coordinate is locked, and its corridor is closed for good. The run resumes: the other '
        + 'corridor keeps contracting, its line eases the rest of the way down, and the moment it lands '
        + 'flat the second coordinate is discovered too. The equilibrium is now fully found.',
      onEnter: () => {
        // Start EXACTLY at the first-find frame — the same step the
        // "1st NE Coord" button names (24 on this game) — then resume and
        // play to the second discovery. Unconditional rebuild, same as the
        // previous step: earlier versions reused the live run's snapshot
        // when one existed and ran afresh from step 0 otherwise, so clicking
        // past the run early produced a different animation than waiting.
        enterMixedAct();
        changeStepMode('regret');
        setTourPoints([]);
        setTourHiddenTraces([]);
        setTourSpinAllowed(false);
        setSpeed(1);
        handleReset();
        setTourFirstFindReq({ resume: true, nonce: Date.now() });
      },
    },
    {
      target: 'plot',
      title: 'Both flat: the crossing is the equilibrium',
      body:
        'Now the second coordinate locks and the other line lies flat as well. Follow the two flat lines to '
        + 'where they cross in the xy-plane below. That crossing is the mixed Nash equilibrium: no lean '
        + 'left for anyone, so nobody can gain by moving alone.',
      onEnter: () => {
        enterMixedAct();
        changeStepMode('regret');
        handleReset();
        if (mixedNE) {
          setSimState((prev) => ({
            ...prev,
            running: false,
            converged: false,
            discoveredMixedX: mixedNE.x,
            discoveredMixedY: mixedNE.y,
            foundAxis: 'y',
          }));
          setTourPoints([{ x: mixedNE.x, y: mixedNE.y, accent: 'purple' }]);
        }
        moveCamera(CAMERA.interior, 1200);
      },
    },
    {
      target: 'ne',
      title: 'The coordinates come out crossed',
      body:
        'The probability that flattens your surface is built from your opponent\'s payoffs. Your own numbers '
        + 'never enter your own equilibrium mix.',
    },
    {
      target: 'ne',
      title: 'Your mixing is for them',
      body:
        'So equilibrium mixing does nothing for you. It is a service you perform for your opponent, holding '
        + 'them perfectly balanced, while their mixing does the same for you.',
      onEnter: () => {
        enterMixedAct();
        changeStepMode('regret');
        handleReset();
        if (mixedNE) {
          setSimState((prev) => ({
            ...prev,
            running: false,
            converged: false,
            discoveredMixedX: mixedNE.x,
            discoveredMixedY: mixedNE.y,
            foundAxis: 'y',
          }));
          setTourPoints([{ x: mixedNE.x, y: mixedNE.y, accent: 'purple' }]);
        }
        moveCamera(CAMERA.interior, 700);
      },
    },
    {
      target: 'matrix',
      title: 'Now change the game',
      body:
        'The equilibrium sits exactly where each player\'s own incentive goes quiet. Edit any payoff and watch '
        + 'the flat spot move somewhere new.',
      onEnter: () => {
        enterMixedAct();
        changeStepMode('regret');
        setTourHiddenTraces([]);
        setTourPoints([]);
        moveCamera(CAMERA.overview, 900);
      },
    },
  ];

  // ── Trajectory Backstep ───────────────────────────────────────────────────
  const handleBackstep = () => {
    if (simState.running || !initStateRef.current || simState.stepCount <= 0) return;
    const targetStep = simState.stepCount - 1;
    // Replay the run that ACTUALLY happened. Using the live firstMover made
    // Back teleport onto the other player's trajectory — "Stepped back to step
    // 2" landed on (0,0), a point the displayed run never occupied, while every
    // log line above still read "Player A moves first".
    if (!runCtx) return;
    const replayed = replayToStep(initStateRef.current, targetStep, runCtx.payoffs, runCtx.firstMover,
      runCtx.shrinkStep, runCtx.allNE, runCtx.committedNE, runCtx.stepMode);
    simStateRef.current = replayed;
    setSimState(replayed);
    scrubPosRef.current = targetStep;
    setLogEntries(prev => [...prev, `⏮ Stepped back to step ${targetStep}`]);
  };

  // ── Jump to NE snapshot ────────────────────────────────────────────────────
  const handleJumpToNE = () => {
    const snap = neSnapshotRef.current;
    if (!snap) return;
    const paused = { ...snap, running: false };
    simStateRef.current = paused;
    setSimState(paused);
    scrubPosRef.current = paused.stepCount;
    setJumpInput(String(paused.stepCount));
    setLogEntries(prev => [...prev, `→ Jumped to step ${paused.stepCount} (first NE coordinate found)`]);
  };

  // Fulfil a pending first-find staging request (see the comment at the
  // declaration). Waits for initialized=false so it runs strictly after the
  // requesting step's handleReset — and after the x0/y0 re-freeze effect,
  // which is declared earlier and therefore runs first in the same commit.
  useEffect(() => {
    if (!tourFirstFindReq || initialized) return;
    const { resume } = tourFirstFindReq;
    setTourFirstFindReq(null);
    handleStep(false);   // initialize: precomputes the run + the NE snapshot
    handleJumpToNE();    // land on the first-find frame, paths and all
    if (resume) {
      // A beat on the found frame before it moves, so the viewer can see
      // where the playback picks up from.
      tourDefer(() => setSimState((prev) => ({ ...prev, running: true })), 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourFirstFindReq, initialized]);

  // ── Step-input Jump ────────────────────────────────────────────────────────
  const handleJump = () => {
    if (!initStateRef.current || thinHistoryRef.current.length === 0) return;
    const parsed = commitStepIndex(jumpInput);
    if (parsed === null) return;
    const clamped = Math.max(0, Math.min(thinHistoryRef.current.length - 1, parsed));
    // Same frozen set as Back. This read was missed entirely by the previous
    // fix: "Go to step 3" replayed the CURRENT controls onto the old run's
    // history, landing on points the log four lines above never visited.
    if (!runCtx) return;
    const replayed = replayToStep(initStateRef.current, clamped, runCtx.payoffs, runCtx.firstMover,
      runCtx.shrinkStep, runCtx.allNE, runCtx.committedNE, runCtx.stepMode);
    simStateRef.current = replayed;
    setSimState(replayed);
    scrubPosRef.current = clamped;
    setJumpInput(String(clamped));
    setLogEntries(prev => [...prev, `→ Jumped to step ${clamped} of ${thinHistoryRef.current.length - 1}`]);
  };

  // ── Matrix Editor Input Clamps ─────────────────────────────────────────────
  const updatePayoffField = (field: keyof GamePayoffs, valStr: string) => {
    setActivePreset('custom');
    setRawPayoffs((prev) => ({ ...prev, [field]: valStr }));

    // One parser, shared with the blur handler. It normalises the minus signs a
    // PDF or Word paste produces — without that the cell displays "−4" while
    // parseFloat returns NaN -> 0, so the matrix on screen and the matrix every
    // panel computes with are different games. Blur used to re-implement this
    // conversion WITHOUT the normalisation and silently reset the cell to 0.
    const clamped = commitPayoffInput(valStr);
    const nextPayoffs = { ...payoffs, [field]: clamped };
    setPayoffs(nextPayoffs);
    setInitialized(false);
    // Editing the matrix invalidates the finished run. handleLoadPreset and
    // handleGenerateGame both reset; the matrix editor did not, so a converged
    // box survived the edit and then recomputed its coordinates against the NEW
    // game while its payoffs, markers and log still described the OLD one —
    // "PURE STRATEGY NASH EQUILIBRIUM REACHED, x*=1, y*=0" above a position
    // marker sitting at (0,0). setInitialized(false) was not enough: the box
    // gates on simState.converged, not on `initialized`.
    // `runCtx !== null` is the direct answer to "is there a live run?"; the old
    // `stepCount > 0` was a proxy that missed the stepCount===0-with-a-live-run
    // state Back and "Go to step 0" produce. Red 14 break 1: Search Game, Run to
    // 49/49, Go to step 0, edit b22 to -4, Go to step 49 -> the app certified
    // "Mixed NE: x=0.333, y=0.333 E[A]=0.667 E[B]=-0.667" for a game whose real
    // equilibrium is (2/3, 1/3), where B gains 4/3 by switching, and whose E[B]
    // there is -2 exactly. The -0.667 was the pre-edit game leaking through.
    if (runCtx) handleReset(nextPayoffs);

    // Cancel any existing inactivity timer for this field
    if (inactiveTimersRef.current[field]) {
      clearTimeout(inactiveTimersRef.current[field]);
    }

    // Set interactive timeout: if user clears the input completely or leaves just a minus/plus sign,
    // reset to "0" after 2 seconds of inaction
    if (valStr === '' || valStr === '-' || valStr === '+' || valStr === '.') {
      inactiveTimersRef.current[field] = setTimeout(() => {
        setRawPayoffs((prev) => {
          if (prev[field] === '' || prev[field] === '-' || prev[field] === '+' || prev[field] === '.') {
            return { ...prev, [field]: '0' };
          }
          return prev;
        });
        setPayoffs((prev: GamePayoffs) => {
          if (prev[field] === 0) {
            return { ...prev, [field]: 0 };
          }
          return prev;
        });
      }, 2000); // 2 seconds of inaction
    }
  };

  const handlePayoffBlur = (field: keyof GamePayoffs) => {
    // Cancel the inactivity timer immediately when blurred
    if (inactiveTimersRef.current[field]) {
      clearTimeout(inactiveTimersRef.current[field]);
    }

    // Blur used to be a SECOND, independently written string->number conversion.
    // It lacked updatePayoffField's minus-sign normalisation, so a pasted "−4"
    // (U+2212) was accepted on change — every panel recomputed and reported the
    // equilibrium for −4 — and was then silently reset to 0 on the way out of
    // the cell, which is what clicking Run does before the run starts.
    //
    // Now there is one parser, and any blur that genuinely CHANGES a payoff goes
    // through the one writer, so it cannot miss the run invalidation either. The
    // inequality matters: without it, merely focusing a cell and leaving would
    // reset a finished run.
    const committed = commitPayoffInput(rawPayoffs[field]);
    const canonical = String(committed);
    if (payoffs[field] !== committed) {
      updatePayoffField(field, canonical);
    } else if (rawPayoffs[field] !== canonical) {
      setRawPayoffs((prev) => ({ ...prev, [field]: canonical }));
    }
  };

  // ── Simulation log panel ──────────────────────────────────────────────────
  // Lives in the right column with an explicit height (see the placement effect)
  // so its bottom lines up with the params panel's bottom; when the converged
  // report leaves no room, it drops to a full-width band beneath both columns.
  const useFlexLog = !logBelow && inlineLogHeight != null;

  // Rendered once and used by BOTH the inline panel and the expanded overlay, so
  // the two can never drift apart in colouring or content.
  // Equilibrium lines take the colour of the marker the graph draws for that
  // equilibrium — the pure diamond's green or the mixed diamond's purple — so a
  // reader can match the log to the plot by colour alone. The KIND is read from
  // the run's own final "━━ Pure NE" / "━━ Mixed NE" line when it exists; before
  // convergence it follows the nearest equilibrium, defaulting to mixed because
  // a "✓ coordinate discovered" line is a coordinate of the mixed search.
  const logKind: 'pure' | 'mixed' = logEntries.some((l) => l.includes('━━ Pure NE'))
    ? 'pure'
    : logEntries.some((l) => l.includes('━━ Mixed NE'))
      ? 'mixed'
      : (nearestNE?.type ?? 'mixed');
  const neLineClass = logKind === 'pure'
    ? 'text-ne-pure dark:text-ne-pure'
    : 'text-ne-mixed-marker dark:text-ne-mixed-marker';
  const logLines = logEntries.map((line, idx) => {
    let colClass = 'text-slate-600 dark:text-slate-300';
    if (line.includes('✓')) {
      colClass = `${neLineClass} font-semibold`;
    } else if (line.includes('↺')) {
      if (line.includes('Ghost cycle')) {
        if (line.includes('(A)')) {
          colClass = 'text-rose-500 dark:text-rose-300 font-medium';
        } else if (line.includes('(B)')) {
          colClass = 'text-player-b-600 dark:text-player-b-300 font-medium';
        } else {
          colClass = 'text-amber-600 dark:text-amber-300 font-medium';
        }
      } else {
        colClass = 'text-amber-600 dark:text-amber-400 font-semibold';
      }
    } else if (line.includes('━━ Pure NE') || line.includes('━━ Mixed NE')) {
      colClass = `${neLineClass} font-semibold`;
    } else if (line.includes('━━')) {
      // "━━ Settled … NOT an equilibrium" is neither marker; keep the accent.
      colClass = 'text-accent-600 dark:text-accent-400 font-semibold';
    } else if (line.startsWith('Start (')) {
      // The starting-point sphere's grey, so the first line matches its marker.
      colClass = 'text-sim-start dark:text-sim-start font-semibold';
    } else if (line.includes('(A)')) {
      colClass = 'text-player-a-600 dark:text-player-a-400 font-semibold';
    } else if (line.includes('(B)')) {
      colClass = 'text-player-b-600 dark:text-player-b-400 font-semibold';
    }
    return (
      <p key={idx} className={colClass}>
        {line}
      </p>
    );
  });

  const simulationLogPanel = (
    <div
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-2xl flex flex-col gap-3 text-slate-700 dark:text-slate-200 shadow-sm"
      style={useFlexLog ? { height: inlineLogHeight! } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold flex items-center gap-1.5">
          <Terminal className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
          Simulation Log
        </span>
        <button
          ref={expandLogButtonRef}
          type="button"
          onClick={() => setLogExpanded(true)}
          title="Expand log"
          aria-label="Expand simulation log"
          className="shrink-0 p-1.5 -m-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:focus:ring-emerald-900"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div
        ref={logsContainerRef}
        tabIndex={0}
        role="region"
        aria-label="Simulation log"
        className={`w-full overflow-y-auto bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-600 dark:text-slate-300 space-y-1 block leading-relaxed select-text focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:focus:ring-emerald-900 ${useFlexLog ? 'flex-1 min-h-0' : (simState.converged ? 'h-44' : 'h-80')}`}
      >
        {logLines}
      </div>
    </div>
  );

  // ── Expanded log overlay ───────────────────────────────────────────────────
  // Fills most of the viewport over a blurred backdrop. The backdrop closes on
  // click; the dialog stops propagation so selecting log text does not dismiss
  // it — the whole point of expanding is to read and copy from it.
  const expandedLogOverlay = logExpanded && (
    <div
      // z-[65]: above the guided tour's z-[60] — see the RED-APP-5 003 note
      // on the Auth dialog below for why.
      className="fixed inset-0 z-[65] flex items-center justify-center p-4 sm:p-8 bg-slate-900/60 backdrop-blur-md"
      onClick={() => setLogExpanded(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Simulation log"
    >
      <div
        ref={logDialogRef}
        className="w-full max-w-5xl h-[90vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl flex flex-col gap-3 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold flex items-center gap-1.5">
            <Terminal className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
            Simulation Log
            <span className="normal-case tracking-normal text-muted dark:text-muted-dark font-normal">
              — {logEntries.length} {logEntries.length === 1 ? 'line' : 'lines'}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setLogExpanded(false)}
            title="Collapse log (Esc)"
            aria-label="Collapse simulation log"
            className="shrink-0 p-1.5 -m-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:focus:ring-emerald-900"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>
        <div
          ref={logsExpandedRef}
          tabIndex={0}
          role="region"
          aria-label="Simulation log"
          className="flex-1 min-h-0 w-full overflow-y-auto bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-5 font-mono text-xs sm:text-sm text-slate-600 dark:text-slate-300 space-y-1 block leading-relaxed select-text focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:focus:ring-emerald-900"
        >
          {logLines}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col antialiased">
      {/* Visually hidden — see `liveStatus`'s own comment above for why this
          announces run PHASE transitions only, never every log line. */}
      <div aria-live="polite" role="status" className="sr-only">{liveStatus}</div>
      {/* ── Heading Banner ──
          RED-APP-9/004: `sticky top-0` is exactly what Chromium's print
          pagination bakes in as an opaque floating box wherever the page-
          break algorithm lands it, rather than printing the header once in
          flow at the top of page 1. `data-print="static"` is the print
          stylesheet's hook (src/index.css) to reset this ONE element back
          to `position: static` for print only — the on-screen sticky
          behavior is untouched. */}
      <header
        data-print="static"
        className={`bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30 shadow-subtle${tourOpen ? ' [@media(max-height:560px)]:!static' : ''}`}
        style={isElectron ? { WebkitAppRegion: 'drag' } as React.CSSProperties : undefined}
      >
        {/* Vertical space for macOS traffic-light buttons — title sits below them, no horizontal offset needed */}
        {isElectronMac && !isFullscreen && <div className="h-9" />}
        <div className={`w-full flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 ${isElectronMac ? 'px-6 py-2' : 'px-4 py-3 sm:px-6 sm:py-4'}`}
          style={isElectron ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : undefined}
        >
          <div>
            <div className="flex items-center gap-2.5">
              <span
                className="p-2 bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 rounded-xl cursor-pointer select-none"
                onClick={e => { if (e.detail === 3) setIsAdminOpen(true); }}
                title=""
              >
                <Compass className="w-5.5 h-5.5" />
              </span>
              <h1 className="text-lg md:text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                Nash Equilibrium Simulator
              </h1>
            </div>
            {/* Tagline is hidden on phones — the header would otherwise dominate the viewport */}
            <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Best-response dynamics on 3D expected-payoff surfaces — watch the search corridor contract onto the Nash equilibrium.
              {' '}
              <button
                type="button"
                onClick={() => setTourOpen(true)}
                className="tap-24 font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
              >
                Take the tour
              </button>
            </p>
          </div>
          {isTouchDevice ? (
            /* ── TOUCH (phones + tablets): single compact row ── */
            <div data-print="hide" className="flex items-center justify-end gap-2 w-full flex-wrap">
              {!isElectron && (
                <button
                  aria-label="Get the desktop app"
                  onClick={() => setIsDownloadModalOpen(true)}
                  className="inline-flex items-center gap-1.5 bg-accent-50 hover:bg-slate-100 text-accent-700 dark:bg-accent-950/45 dark:hover:bg-accent-900/40 dark:text-accent-400 border border-accent-100 dark:border-accent-900 font-bold text-xs p-2 sm:px-3 sm:py-1.5 rounded-xl transition-all shadow-xs cursor-pointer"
                >
                  <Download className="w-4 h-4 sm:w-3.5 sm:h-3.5" /><span className="hidden sm:inline">Get Desktop App</span>
                </button>
              )}
              <button
                aria-label="Toggle dark mode" onClick={() => setDarkMode(!darkMode)}
                className="p-2 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-accent-500" />}
              </button>
              <button
                aria-label="Open workspace menu" onClick={() => setIsMenuOpen(true)}
                className="p-2 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                <Menu className="w-4 h-4" />
              </button>
              {user ? (
                <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 pl-2.5 pr-1 py-1 rounded-xl">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate max-w-[100px]" title={user.email}>@{user.username}</span>
                  <button onClick={handleLogout} className="text-xs font-medium text-slate-400 hover:text-danger-500 hover:bg-danger-50/50 dark:hover:bg-danger-950/50 px-2.5 py-1 rounded-lg transition-colors cursor-pointer">Log out</button>
                </div>
              ) : (
                <button
                  onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthMode('login'); setIsAuthModalOpen(true); }}
                  className="inline-flex items-center gap-1.5 bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs px-3.5 py-1.5 rounded-xl transition-all shadow-xs cursor-pointer"
                >
                  <LogIn className="w-3.5 h-3.5" /> Sign In<span className="hidden sm:inline">&nbsp;/ Sign Up</span>
                </button>
              )}
            </div>
          ) : (
            /* ── NON-TOUCH (desktops/laptops): original flex row ── */
            <div data-print="hide" className="flex items-center flex-wrap gap-2.5">
              {!isElectron && (
                <button
                  onClick={() => setIsDownloadModalOpen(true)}
                  className="inline-flex items-center gap-1.5 bg-accent-50 hover:bg-slate-100 text-accent-700 dark:bg-accent-950/45 dark:hover:bg-accent-900/40 dark:text-accent-400 border border-accent-100 dark:border-accent-900 font-bold text-xs px-3 py-1.5 rounded-xl transition-all shadow-xs cursor-pointer"
                  title="Download macOS Desktop App"
                >
                  <Download className="w-3.5 h-3.5" /><span>Get Desktop App</span>
                </button>
              )}
              <button
                aria-label="Toggle dark mode" onClick={() => setDarkMode(!darkMode)}
                className="p-2 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
              >
                {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-accent-500" />}
              </button>
              <button
                id="menu-toggle-btn"
                aria-label="Open workspace menu" onClick={() => setIsMenuOpen(true)}
                className="p-2 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer animate-pulse-once"
                title="Open Workspace Center"
              >
                <Menu className="w-4 h-4" />
              </button>
              {user ? (
                <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 pl-2.5 pr-1 py-1 rounded-xl">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate max-w-[120px]" title={user.email}>@{user.username}</span>
                  <button onClick={handleLogout} className="text-xs font-medium text-slate-400 dark:text-slate-400 hover:text-danger-500 hover:bg-danger-50/50 dark:hover:bg-danger-950/50 px-2.5 py-1 rounded-lg transition-colors cursor-pointer">Log out</button>
                </div>
              ) : (
                <button
                  onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthMode('login'); setIsAuthModalOpen(true); }}
                  className="inline-flex items-center gap-1.5 bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs px-3.5 py-1.5 rounded-xl transition-all shadow-xs cursor-pointer"
                >
                  <LogIn className="w-3.5 h-3.5" /> Sign In / Sign Up
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {/* ── Main Layout Body ── */}
      <main className="flex-1 max-w-[100rem] w-full mx-auto px-4 lg:px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* ── Left Sidebar Settings Panel (5 cols) ── */}
        <div className="lg:col-span-5 flex flex-col gap-6">

          {/* Preset Buttons Block */}
          <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-4">
            <div className="flex items-center gap-2 text-slate-800 dark:text-slate-200 font-semibold text-xs uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pb-2">
              <BookOpen className="w-4 h-4 text-rose-500" />
              Standard Scenarios
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {(['search', 'bos', 'pd', 'cnr', 'spy', 'penalty'] as const).map((key) => {
                const isSelected = activePreset === key;
                return (
                  <button
                    key={key}
                    onClick={() => handleLoadPreset(key)}
                    className={`py-2 px-3 text-xs font-semibold rounded-xl border transition-all text-center cursor-pointer ${isSelected
                        ? 'bg-accent-600 text-white border-accent-600 shadow-xs'
                        : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white'
                      }`}
                  >
                    {PRESETS[key].name}
                  </button>
                );
              })}
            </div>

            {/* User Custom Saved Games Segment */}
            <div className="flex items-center justify-between text-slate-800 dark:text-slate-200 font-semibold text-xs uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pt-1.5 pb-2">
              <div className="flex items-center gap-2">
                <Award className="w-4 h-4 text-accent-500" />
                Custom Game Presets
              </div>
              {/* On the desktop the save control is available signed OUT too: the
                  database is a file in this machine's own user-data directory,
                  so there is no other tenant to separate the games from. A
                  local owner is provisioned server-side on first write, and
                  signing in later adopts whatever was saved.

                  Gated on dbMode === 'local', not on isElectron alone: the
                  desktop can also run in CLOUD mode, against the hosted API
                  and a separate token key, where there is no local owner and
                  an account is genuinely required. Showing the control there
                  would offer a save that cannot work. */}
              {(user || (isElectron && dbMode === 'local')) && (
                <button
                  onClick={() => {
                    setSaveError('');
                    // Prefill from whatever the current game already calls its
                    // options, so saving a copy of a named game keeps the names.
                    // Read from scenarioForReport, not activeLabels, because the
                    // latter substitutes the literal "Row 1" and prefilling that
                    // would save a placeholder as if it were a real label.
                    setSaveLabels({
                      row1: scenarioForReport?.row1 ?? '', row2: scenarioForReport?.row2 ?? '',
                      col1: scenarioForReport?.col1 ?? '', col2: scenarioForReport?.col2 ?? '',
                    });
                    // A brand-new "Save Preset" click — a new save attempt,
                    // never a retry of whatever the dialog last submitted.
                    saveRequestIdRef.current = null;
                    setIsSaveModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-bold text-accent-600 dark:text-accent-400 bg-accent-50 dark:bg-accent-950/40 hover:bg-accent-100 dark:hover:bg-accent-900/50 border border-accent-200/50 dark:border-accent-800/60 px-2.5 py-1 rounded-lg transition-all cursor-pointer"
                >
                  <Plus className="w-3 h-3" /> Save Preset
                </button>
              )}
            </div>

            {!user ? (
              <div className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/30 border border-slate-200/60 dark:border-slate-800/80 rounded-xl p-3 text-center">
                <span>Want to name and save custom presets? </span>
                <button
                  onClick={() => {
                    setAuthError('');
                    setAuthSuccess('');
                    setAuthMode('login');
                    setIsAuthModalOpen(true);
                  }}
                  className="tap-24 font-bold text-accent-600 dark:text-accent-400 hover:underline cursor-pointer"
                >
                  Sign in here
                </button>
              </div>
            ) : userCustomGames.length === 0 ? (
              <div className="text-xs text-muted dark:text-muted-dark bg-slate-50/70 dark:bg-slate-950/20 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl p-4 text-center">
                No saved custom games. Adapt payoffs and click <strong className="text-accent-600 dark:text-accent-400">Save Preset</strong> to persist your first game!
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[160px] overflow-y-auto pr-1">
                {userCustomGames.map((game) => {
                  const isSelected = activePreset === game.id;
                  return (
                    <div
                      key={game.id}
                      className={`group flex items-center justify-between p-2 pl-3 rounded-xl border transition-all ${isSelected
                          ? 'bg-accent-500 border-accent-500 text-white shadow-xs'
                          : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:bg-slate-100/80 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
                        }`}
                    >
                      <button
                        onClick={() => handleLoadPreset(game.id)}
                        className="flex-1 text-left text-xs font-semibold truncate cursor-pointer mr-1"
                        title={`${game.name} - ${game.description}`}
                      >
                        {game.name}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditGame(game);
                        }}
                        className={`p-1 rounded-md transition-colors cursor-pointer ${isSelected
                            ? 'text-accent-100 hover:text-white hover:bg-accent-600'
                            : 'text-slate-400 hover:text-accent-600 dark:text-slate-500 dark:hover:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-950/40'
                          }`}
                        title="Edit name, description and option names"
                        aria-label={`Edit ${game.name}`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteGame(game.id);
                        }}
                        className={`p-1 rounded-md transition-colors cursor-pointer ${isSelected
                            ? 'text-accent-100 hover:text-white hover:bg-accent-600'
                            : 'text-slate-400 hover:text-danger-500 dark:text-slate-500 dark:hover:text-danger-400 hover:bg-danger-50 dark:hover:bg-danger-950/40'
                          }`}
                        title="Delete this saved game"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Selected Preset Narrative Card */}
            {selectedPreset?.desc && (
              selectedCustomGame ? (
                <div data-testid="preset-narrative" className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed break-words bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-900/45 rounded-xl p-3">
                  <strong>Custom - {selectedCustomGame.name}:</strong>{' '}
                  {/* descriptionColorTerms, not colorTermsFor: this is the
                      user's OWN description, so their highlights apply here —
                      and only here. The AI explanation below deliberately
                      keeps using colorTerms, so a user's choices can never
                      alter how the model's prose is coloured. */}
                  <ColorCoded
                    text={selectedPreset.desc}
                    aTerms={descriptionTerms.a}
                    bTerms={descriptionTerms.b}
                  />
                </div>
              ) : (
                <div
                  data-testid="preset-narrative"
                  className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-900/45 rounded-xl p-3"
                  dangerouslySetInnerHTML={{ __html: selectedPreset.desc }}
                />
              )
            )}
          </div>

          {/* Payoff Matrix Editor Block */}
          <div className="bg-slate-50 dark:bg-slate-950/40 p-5 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
              <div className="flex items-center gap-2 text-slate-800 dark:text-slate-200 font-semibold text-sm">
                <Sliders className="w-4 h-4 text-player-b-500" />
                <span>
                  Payoff Matrix — (
                  <span className="text-player-a-500 font-semibold font-mono">A</span>,{' '}
                  <span className="text-player-b-600 dark:text-player-b-400 font-semibold font-mono">B</span>)
                </span>
              </div>
              <span className="text-xs text-muted dark:text-muted-dark font-mono">Range: [-100, 100]</span>
            </div>

            {/* Row-label column capped at 72px (was "auto"): mobile CI caught this
                --  an auto-sized column grows to fit whatever text is in it (e.g.
                "Football", "Stay at Home"), stealing width from the payoff-input
                columns on either side. On the iPhone 14 Pro profile (393px viewport,
                the narrowest of the three CI tests) that pushed the number inputs
                to 23-24px wide -- under the WCAG 2.2 AA 24px target floor. Capping
                the label column forces long labels to wrap (break-words is already
                on the label divs below) instead of shrinking the inputs. 72px was
                chosen empirically: re-verified against BOTH the longest label this
                branch introduced ("Stay at Home", Cops & Robbers) and the shortest
                real preset labels, on all three mobile.mjs device profiles.
                The other two tracks were bare `1fr` (== `minmax(auto, 1fr)`),
                so a label with no break opportunity (a 40-char run with no
                spaces — the label field's own maxLength, RED-APP-6/004) could
                not shrink below its unbroken min-content width, forcing the
                whole grid — and the page — 235px past a 320px viewport
                (WCAG 1.4.10). `minmax(0, 1fr)` matches what the per-cell
                payoff-pair grid below already does correctly. */}
            <div data-tour="matrix" className="grid grid-cols-[minmax(0,72px)_minmax(0,1fr)_minmax(0,1fr)] gap-3 text-center items-center">
              <div className="text-xs font-bold text-muted dark:text-muted-dark pr-2 text-left">Tactics</div>
              <div className="text-xs max-[380px]:text-[10.5px] font-bold text-player-b-600 dark:text-player-b-400 break-words hyphens-auto" title={activeLabels.col1}>B: {activeLabels.col1}</div>
              <div className="text-xs max-[380px]:text-[10.5px] font-bold text-player-b-600 dark:text-player-b-400 break-words hyphens-auto" title={activeLabels.col2}>B: {activeLabels.col2}</div>

              {/* Row 1 inputs */}
              <div className="text-xs max-[380px]:text-[10.5px] font-bold text-player-a-500 text-left pr-2 break-words hyphens-auto" title={activeLabels.row1}>A: {activeLabels.row1}</div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 dark:border-slate-700 rounded-xl p-1.5 bg-white dark:bg-slate-950 focus-within:ring-2 focus-within:ring-accent-100/50 dark:focus-within:ring-slate-800 focus-within:border-slate-300 dark:focus-within:border-slate-700 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.\-]*"
                  value={rawPayoffs.a11}
                  onChange={(e) => updatePayoffField('a11', e.target.value)}
                  aria-label={`${activeLabels.row1 || 'Row 1'}, ${activeLabels.col1 || 'Col 1'}, Player A payoff`}
                  onBlur={() => handlePayoffBlur('a11')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-a-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 dark:text-slate-600 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.\-]*"
                  value={rawPayoffs.b11}
                  onChange={(e) => updatePayoffField('b11', e.target.value)}
                  aria-label={`${activeLabels.row1 || 'Row 1'}, ${activeLabels.col1 || 'Col 1'}, Player B payoff`}
                  onBlur={() => handlePayoffBlur('b11')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-b-600 dark:text-player-b-400 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 dark:border-slate-700 rounded-xl p-1.5 bg-white dark:bg-slate-950 focus-within:ring-2 focus-within:ring-accent-100/50 dark:focus-within:ring-slate-800 focus-within:border-slate-300 dark:focus-within:border-slate-700 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.\-]*"
                  value={rawPayoffs.a12}
                  onChange={(e) => updatePayoffField('a12', e.target.value)}
                  aria-label={`${activeLabels.row1 || 'Row 1'}, ${activeLabels.col2 || 'Col 2'}, Player A payoff`}
                  onBlur={() => handlePayoffBlur('a12')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-a-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 dark:text-slate-600 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.\-]*"
                  value={rawPayoffs.b12}
                  onChange={(e) => updatePayoffField('b12', e.target.value)}
                  aria-label={`${activeLabels.row1 || 'Row 1'}, ${activeLabels.col2 || 'Col 2'}, Player B payoff`}
                  onBlur={() => handlePayoffBlur('b12')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-b-600 dark:text-player-b-400 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>

              {/* Row 2 inputs */}
              <div className="text-xs max-[380px]:text-[10.5px] font-bold text-player-a-500 text-left pr-2 break-words hyphens-auto" title={activeLabels.row2}>A: {activeLabels.row2}</div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 dark:border-slate-700 rounded-xl p-1.5 bg-white dark:bg-slate-950 focus-within:ring-2 focus-within:ring-accent-100/50 dark:focus-within:ring-slate-800 focus-within:border-slate-300 dark:focus-within:border-slate-700 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.\-]*"
                  value={rawPayoffs.a21}
                  onChange={(e) => updatePayoffField('a21', e.target.value)}
                  aria-label={`${activeLabels.row2 || 'Row 2'}, ${activeLabels.col1 || 'Col 1'}, Player A payoff`}
                  onBlur={() => handlePayoffBlur('a21')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-a-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 dark:text-slate-600 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.\-]*"
                  value={rawPayoffs.b21}
                  onChange={(e) => updatePayoffField('b21', e.target.value)}
                  aria-label={`${activeLabels.row2 || 'Row 2'}, ${activeLabels.col1 || 'Col 1'}, Player B payoff`}
                  onBlur={() => handlePayoffBlur('b21')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-b-600 dark:text-player-b-400 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border border-slate-200 dark:border-slate-700 rounded-xl p-1.5 bg-white dark:bg-slate-950 focus-within:ring-2 focus-within:ring-accent-100/50 dark:focus-within:ring-slate-800 focus-within:border-slate-300 dark:focus-within:border-slate-700 w-full min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.\-]*"
                  value={rawPayoffs.a22}
                  onChange={(e) => updatePayoffField('a22', e.target.value)}
                  aria-label={`${activeLabels.row2 || 'Row 2'}, ${activeLabels.col2 || 'Col 2'}, Player A payoff`}
                  onBlur={() => handlePayoffBlur('a22')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-a-500 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
                <span className="text-slate-300 dark:text-slate-600 shrink-0 text-center select-none font-medium px-1">,</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9.\-]*"
                  value={rawPayoffs.b22}
                  onChange={(e) => updatePayoffField('b22', e.target.value)}
                  aria-label={`${activeLabels.row2 || 'Row 2'}, ${activeLabels.col2 || 'Col 2'}, Player B payoff`}
                  onBlur={() => handlePayoffBlur('b22')}
                  className="w-full min-w-0 text-center font-mono font-medium text-player-b-600 dark:text-player-b-400 bg-transparent border-none outline-none text-xs sm:text-sm"
                />
              </div>
            </div>
          </div>

          {/* Expected math formulations */}
          <div data-tour="ep" className="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Expected-Payoff Functions
            </span>
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/50 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800">
                <MathTex tex="\mathbb{E}[A]" className="text-player-a-600 dark:text-player-a-400" />
                <MathTex tex={`= ${eqAStr}`} className="text-slate-700 dark:text-slate-200" />
              </div>
              <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/50 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800">
                <MathTex tex="\mathbb{E}[B]" className="text-player-b-600 dark:text-player-b-400" />
                <MathTex tex={`= ${eqBStr}`} className="text-slate-700 dark:text-slate-200" />
              </div>
            </div>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              <MathTex tex="x = P(\text{A plays Row 1}), \quad y = P(\text{B plays Col 1})" />
            </span>
          </div>

          {/* Configuration Parameters Panel */}
          <div ref={paramsPanelRef} data-tour="coords" className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-4">
            <div className="text-slate-800 dark:text-slate-200 font-semibold text-sm border-b border-slate-100 dark:border-slate-800 pb-2">
              Simulation Coordinates & Parameters
            </div>

            {/* Starting coordinate fields */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-player-a-500 font-semibold mb-1">Row Start Point (x₀)</label>
                <div className="relative">
                  <input
                    type="number"
                    min="0.0"
                    max="1.0"
                    step="0.01"
                    value={x0}
                    onChange={(e) => {
                      setX0(e.target.value);
                      setInitialized(false);
                    }}
                    onBlur={() => commitStartField('x')}
                    aria-label="Row Start Point (x0)"
                    className="no-native-spinner w-full font-mono text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 p-2 pr-8 rounded-xl focus:ring-rose-200 focus:outline-none"
                  />
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex flex-col">
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Increase x₀"
                      onClick={() => stepStartPoint('x', 1)}
                      className="tap-24 flex items-center justify-center px-1 py-0.5 rounded-md leading-none text-slate-400 hover:text-player-a-500 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Decrease x₀"
                      onClick={() => stepStartPoint('x', -1)}
                      className="tap-24 flex items-center justify-center px-1 py-0.5 rounded-md leading-none text-slate-400 hover:text-player-a-500 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs text-player-b-600 dark:text-player-b-400 font-semibold mb-1">Col Start Point (y₀)</label>
                <div className="relative">
                  <input
                    type="number"
                    min="0.0"
                    max="1.0"
                    step="0.01"
                    value={y0}
                    onChange={(e) => {
                      setY0(e.target.value);
                      setInitialized(false);
                    }}
                    onBlur={() => commitStartField('y')}
                    aria-label="Col Start Point (y0)"
                    className="no-native-spinner w-full font-mono text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 p-2 pr-8 rounded-xl focus:ring-accent-100 focus:outline-none"
                  />
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex flex-col">
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Increase y₀"
                      onClick={() => stepStartPoint('y', 1)}
                      className="tap-24 flex items-center justify-center px-1 py-0.5 rounded-md leading-none text-slate-400 hover:text-player-b-500 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Decrease y₀"
                      onClick={() => stepStartPoint('y', -1)}
                      className="tap-24 flex items-center justify-center px-1 py-0.5 rounded-md leading-none text-slate-400 hover:text-player-b-500 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Who moves first choice */}
            <div>
              <label className="block text-xs text-slate-600 dark:text-slate-300 font-medium mb-1.5">Who moves first?</label>
              <div className="grid grid-cols-2 gap-2">
                {(['A', 'B'] as const).map((player) => {
                  const active = firstMover === player;
                  return (
                    <button
                      key={player}
                      onClick={() => changeFirstMover(player)}
                      className={`py-2 px-3 text-xs font-semibold rounded-xl border transition-all ${active
                          ? player === 'A'
                            ? 'bg-player-a-500 text-white border-player-a-500'
                            : 'bg-player-b-600 text-white border-player-b-600'
                          : 'bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }`}
                    >
                      Player {player}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* visual tracking choice */}
            <div>
              <label className="block text-xs text-slate-600 dark:text-slate-300 font-medium mb-1.5">Expected Payoff Surface Tracking</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['A', 'B', 'both'] as const).map((m) => {
                  const active = trackingMode === m;
                  return (
                    <button
                      key={m}
                      onClick={() => setTrackingMode(m)}
                      className={`py-2 px-1 text-xs font-semibold rounded-xl border transition-all text-center ${active
                          ? m === 'A'
                            ? 'bg-player-a-500 text-white border-player-a-500'
                            : m === 'B'
                              ? 'bg-player-b-600 text-white border-player-b-600'
                              : 'bg-ne-mixed-600 text-white border-ne-mixed-600'
                          : 'bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }`}
                    >
                      {m === 'both' ? 'Both Plots' : `Player ${m}`}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Convergence method */}
            <div data-tour="method">
              <label className="block text-xs text-slate-600 dark:text-slate-300 font-medium mb-1.5">Convergence Method</label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { key: 'shrink', label: 'Domain Shrink' },
                  { key: 'regret', label: 'Opponent Regret' },
                ] as const).map(({ key, label }) => {
                  const active = stepMode === key;
                  return (
                    <button
                      key={key}
                      onClick={() => changeStepMode(key)}
                      className={`py-2 px-2 text-xs font-semibold rounded-xl border transition-all text-center ${active
                          ? 'bg-accent-600 text-white border-accent-600 shadow-xs'
                          : 'bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <span className="text-xs text-muted dark:text-muted-dark mt-1.5 block">
                {stepMode === 'regret'
                  ? "Steps each player's strategy by the opponent's regret, animating the strategy line flattening into the indifference line (mixed-strategy games only)."
                  : 'Contracts the search corridor by a fixed step, bisecting when a coordinate is overshot.'}
              </span>
            </div>

            {/* Step size / regret weight */}
            <div>
              <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 font-medium mb-1">
                <span>{stepMode === 'regret' ? 'Regret Step Weight (λ)' : 'Initial Domain Shrink Step Size'}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={shrinkStepRaw}
                  onChange={(e) => {
                    setShrinkStepRaw(e.target.value);
                    setShrinkStep(commitStepSize(e.target.value, shrinkStep));
                  }}
                  onBlur={() => {
                    const clamped = commitStepSize(shrinkStepRaw, shrinkStep);
                    setShrinkStep(clamped);
                    setShrinkStepRaw(clamped.toFixed(3));
                  }}
                  aria-label={stepMode === 'regret' ? 'Regret Step Weight (lambda)' : 'Initial Domain Shrink Step Size'}
                  className="w-20 font-mono font-semibold text-accent-600 dark:text-accent-400 text-right bg-transparent border-b border-accent-300 dark:border-accent-700 focus:outline-none focus:border-accent-500"
                />
              </div>
              <input
                type="range"
                min="0.001"
                max="0.999"
                step="0.001"
                value={shrinkStep}
                onChange={(e) => { const v = commitStepSize(e.target.value, shrinkStep); setShrinkStep(v); setShrinkStepRaw(v.toFixed(3)); }}
                aria-label={stepMode === 'regret' ? 'Regret Step Weight (lambda) slider' : 'Initial Domain Shrink Step Size slider'}
                className="w-full accent-accent-600 h-1 bg-slate-100 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer"
              />
              <span className="text-xs text-muted dark:text-muted-dark mt-1 block">
                {stepMode === 'regret'
                  ? 'Larger λ glides in faster; keep it modest so the line flattens smoothly without overshooting. As the opponent’s regret → 0, the steps shrink and the line eases into the flat shelf.'
                  : 'Sets how much the search corridor contracts per detected cycle; switches to bisection method when a Player overshoots a mixed equilibrium coordinate.'}
              </span>
            </div>
          </div>
        </div>

        {/* ── Right Panel Simulation Console & Plots (7 cols) ── */}
        <div className="lg:col-span-7 flex flex-col gap-6">

          {/* Plot Legend Info Line */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 items-center text-xs text-slate-500 justify-center lg:justify-start">
            <span className="flex items-center gap-1 text-player-a-600 dark:text-player-a-400"><LegendSwatch shape="surface" /> E[A] Surface</span>
            <span className="flex items-center gap-1 text-player-b-600 dark:text-player-b-400"><LegendSwatch shape="surface" /> E[B] Surface</span>
            <span className="flex items-center gap-1 text-player-a-500 dark:text-player-a-400 font-medium"><LegendSwatch shape="line" /> A Moves</span>
            <span className="flex items-center gap-1 text-player-b-600 dark:text-player-b-400 font-medium"><LegendSwatch shape="line" /> B Moves</span>
            <span className="flex items-center gap-1 font-semibold text-ne-pure dark:text-ne-pure"><LegendSwatch shape="diamond" /> Pure NE</span>
            <span className="flex items-center gap-1 text-ne-mixed-600 dark:text-ne-mixed-400 font-bold"><LegendSwatch shape="diamond" /> Mixed NE</span>
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><LegendSwatch shape="dashed" /> Domain</span>
            <span className="flex items-center gap-1 text-orange-500 dark:text-orange-400"><LegendSwatch shape="dashed" /> Search Corridor</span>
            <span className="flex items-center gap-1 text-orange-500 dark:text-orange-400"><LegendSwatch shape="ring" /> Ghost positions</span>
          </div>

          {/* RED-APP-9/004: printed/PDF output replaces the plot with this
              same legend line (on-screen it stays exactly as it was) plus a
              print-only note — the WebGL canvas below is hidden for print
              ([data-tour="plot"] in src/index.css), since Chromium's print
              path does not reliably rasterize it. `hidden print:block`
              keeps this invisible on screen (Tailwind's built-in print
              variant), so nothing changes for the interactive app. */}
          <p className="hidden print:block text-xs text-slate-500">
            The interactive 3D plot is not shown in print — WebGL canvases do not render in a printed page.
            Open this game in the app to view it.
          </p>

          {/* Plotly 3D visual component */}
          <PlotlyView
            payoffs={payoffs}
            simState={simState}
            trackingMode={trackingMode}
            tourPoints={tourPoints}
            hiddenTraces={tourHiddenTraces}
            // The spin runs whenever the simulation isn't — in the tour it is
            // additionally gated per-step (tourSpinAllowed). Outside the tour
            // nothing is permanent: graph activity halts the spin and it
            // returns by itself after 10s of inactivity. A fresh or newly
            // loaded game spins straight away (spinDelayMs 0 — handleReset
            // bumps the nonce so this restarts on every load); a PAUSED or
            // finished run first waits out the same 10s, since the visitor
            // is likely mid-inspection.
            idleSpin={tourOpen ? tourSpinAllowed && !simState.running : !simState.running}
            spinNonce={tourSpinNonce}
            spinDelayMs={!tourOpen && initialized ? 10000 : 0}
            spinAutoResumeMs={tourOpen ? 0 : 10000}
            // Pressing anywhere on the graph pauses a running simulation —
            // reaching into the picture means the visitor wants to inspect
            // it, not race the markers. No auto-resume (unlike the spin's
            // countdown): Run continues exactly where it stopped. Gated off
            // during the tour, whose scripted playback a stray press would
            // desync.
            onGraphPress={() => {
              if (!tourOpen && simStateRef.current.running) {
                setSimState((prev) => ({ ...prev, running: false }));
              }
            }}
            allNE={allNE}
            isDark={darkMode}
            // Frozen with the rest of the run context: switching method on a
            // finished run redrew a trajectory that never used it — the regret
            // box switches to the per-axis domain the shrink stepper never
            // writes, so the drawn box snapped back to the full unit square.
            stepMode={runCtx?.stepMode ?? stepMode}
          />

          {/* Progress bar + step input + NE jump — always visible once simulation starts */}
          <div className={`flex flex-col gap-2 px-3 py-2.5 rounded-xl border ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
            {/* Bar row — only shown after first step */}
            {thinHistory.length > 1 && (
              <div className="flex items-center gap-3">
                <span className={`text-xs font-medium shrink-0 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Progress</span>
                <div className={`flex-1 h-2 rounded-full overflow-hidden ${darkMode ? 'bg-slate-700' : 'bg-slate-200'}`}>
                  <div
                    className="h-full rounded-full bg-accent-500 transition-all duration-150"
                    style={{ width: `${Math.min(100, (simState.stepCount / (thinHistory.length - 1)) * 100)}%` }}
                  />
                </div>
                <span className="text-xs font-mono shrink-0 text-amber-500 font-semibold">
                  {simState.stepCount} / {thinHistory.length - 1}
                </span>
              </div>
            )}
            {/* Step input row + NE button + converged status */}
            <div className="flex items-center gap-2 flex-wrap">
              {thinHistory.length > 1 && (
                <>
                  <span className={`text-xs font-medium shrink-0 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Go to step</span>
                  <input
                    type="number"
                    min={0}
                    max={thinHistory.length - 1}
                    value={jumpInput}
                    onChange={e => setJumpInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleJump(); }}
                    placeholder={`0 – ${thinHistory.length - 1}`}
                    className={`no-native-spinner w-28 px-2 py-1 text-xs rounded-lg border font-mono ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-600' : 'bg-white border-slate-300 text-slate-700 placeholder-slate-400'}`}
                  />
                  <button
                    onClick={handleJump}
                    className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-700 text-white transition-all"
                  >
                    Go
                  </button>
                </>
              )}
              {/* Enabled in BOTH modes: regret used to lock the two coordinates
                  atomically (so this marker coincided with convergence and was
                  hidden there), but it now declares them individually — the
                  first find is a real, distinct moment in either mode. */}
              {mixedNE && (
                <button
                  onClick={handleJumpToNE}
                  disabled={!neSnapshot}
                  className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all ${
                    neSnapshot
                      ? darkMode ? 'border-ne-mixed-700 text-ne-mixed-400 hover:bg-ne-mixed-900/30 cursor-pointer' : 'border-ne-mixed-300 text-ne-mixed-700 hover:bg-ne-mixed-50 cursor-pointer'
                      : darkMode ? 'border-slate-700 text-slate-600 cursor-not-allowed' : 'border-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  {neSnapshot ? `1st NE Coord (step ${neSnapshot.stepCount})` : '1st NE Coord'}
                </button>
              )}
              {!simState.converged && runTruncated && thinHistory.length > 1 && (
                <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium bg-amber-100/95 dark:bg-amber-950/90 text-amber-800 dark:text-amber-300 py-1 px-2.5 rounded-full border border-amber-200 dark:border-amber-800">
                  <AlertTriangle className="w-3.5 h-3.5" /> Stopped at the {thinHistory.length - 1}-step limit — not an equilibrium
                </span>
              )}
              {simState.converged && (
                <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium bg-emerald-100/95 dark:bg-emerald-950/90 text-emerald-800 dark:text-emerald-300 py-1 px-2.5 rounded-full border border-emerald-200 dark:border-emerald-800 animate-fade-in">
                  <CheckCircle2 className="w-3.5 h-3.5" /> {simState.convergedIsNE === false ? 'Settled (not an NE)' : 'Converged'}
                </span>
              )}
            </div>
          </div>

          {/* Simulation Controls Dashboard */}
          <div data-tour="controls" className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-4">

            {/* Play trigger buttons row */}
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <button
                  onClick={togglePlay}
                  className={`flex items-center gap-1 mt-0.5 py-2 px-3 sm:px-5 text-xs sm:text-sm font-semibold rounded-xl text-white transition-all shadow-xs ${simState.running
                      ? 'bg-yellow-500 hover:bg-yellow-600'
                      : 'bg-accent-600 hover:bg-accent-700'
                    }`}
                >
                  {simState.running ? (
                    <>
                      <Pause className="w-3.5 h-3.5 fill-white" /> Pause
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-white" /> Run
                    </>
                  )}
                </button>

                <button
                  onClick={() => handleStep()}
                  disabled={simState.running || (thinHistory.length > 0 && simState.stepCount >= thinHistory.length - 1)}
                  className="flex items-center gap-1 mt-0.5 py-2 px-2.5 sm:px-4 text-xs sm:text-sm font-semibold rounded-xl border border-slate-200 dark:border-slate-700 text-accent-600 dark:text-accent-400 bg-accent-50/50 dark:bg-accent-950/20 hover:bg-accent-50 dark:hover:bg-accent-950/40 transition-all disabled:opacity-50 disabled:bg-slate-50 dark:disabled:bg-slate-800 disabled:text-slate-400 disabled:border-slate-200 dark:disabled:border-slate-700"
                >
                  <SkipForward className="w-3.5 h-3.5" /> Step
                </button>

                <button
                  onClick={handleBackstep}
                  disabled={simState.running || !initStateRef.current || simState.stepCount === 0}
                  className="flex items-center gap-1 mt-0.5 py-2 px-2 sm:px-3 text-xs sm:text-sm font-medium rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all disabled:opacity-40"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Back
                </button>

                <button
                  onClick={() => handleReset()}
                  className="flex items-center gap-1 mt-0.5 py-2 px-2 sm:px-3 text-xs sm:text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Reset
                </button>
              </div>

              {/* Speed slider */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Loop Speed</span>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={speed}
                  onChange={(e) => setSpeed(commitStepIndex(e.target.value) ?? 5)}
                  aria-label="Loop Speed"
                  className="w-20 accent-accent-600 h-1 bg-slate-100 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
                <span className="text-xs font-mono text-muted dark:text-muted-dark font-semibold">{speed}x</span>
              </div>
            </div>

            {/* Realtime coordinates outputs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                <span className="text-xs text-player-a-500 font-bold uppercase block tracking-wider">
                  x: P(A playing Row 1)
                </span>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200 font-mono">
                  {simState.cx.toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                <span className="text-xs text-player-b-600 dark:text-player-b-400 font-semibold uppercase block tracking-wider">
                  y: P(B playing Col 1)
                </span>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200 font-mono">
                  {simState.cy.toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                <span className="text-xs text-slate-500 dark:text-slate-400 block tracking-wider">
                  Expected Payoff E[A]
                </span>
                <span className="text-sm font-bold text-player-a-500 font-mono">
                  {fmtPayoff(EA(simState.cx, simState.cy, payoffs))}
                </span>
              </div>
              <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                <span className="text-xs text-slate-500 dark:text-slate-400 block tracking-wider">
                  Expected Payoff E[B]
                </span>
                <span className="text-sm font-bold text-player-b-600 dark:text-player-b-400 font-mono">
                  {fmtPayoff(EB(simState.cx, simState.cy, payoffs))}
                </span>
              </div>
            </div>
          </div>
          {/* `converged` means STATIONARY, not "is an equilibrium". A
              best-response path can settle where a player still gains by
              switching, and this box then announced a Nash equilibrium at a
              point with regret 18. Gate on the regret-oracle result. */}
          {simState.converged && simState.convergedIsNE !== false && !runStale && nearestNE && (
            <div className={`p-5 rounded-2xl border flex flex-col gap-3 shadow-xs animate-fade-in ${realisedConcept === 'mixed'
                ? 'bg-ne-mixed-50 dark:bg-ne-mixed-950/20 border-ne-mixed-200 dark:border-ne-mixed-800/60'
                : 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60'
              }`}>
              <div className="flex items-center gap-2">
                <span className={`p-1.5 rounded-lg ${realisedConcept === 'mixed' ? 'bg-ne-mixed-100 dark:bg-ne-mixed-900/60 text-ne-mixed-700 dark:text-ne-mixed-300' : 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300'
                  }`}>
                  <Award className="w-5 h-5" />
                </span>
                <span className={`text-sm font-bold uppercase tracking-wider ${realisedConcept === 'mixed' ? 'text-ne-mixed-900 dark:text-ne-mixed-200' : 'text-emerald-900 dark:text-emerald-200'
                  }`}>
                  {realisedConcept === 'mixed' ? 'Mixed' : 'Pure'} Strategy Nash Equilibrium Reached
                </span>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 py-3 bg-white/75 dark:bg-slate-900/65 px-4 rounded-xl border border-slate-100 dark:border-slate-800 text-xs shadow-3xs">
                <span className="text-player-a-600 dark:text-player-a-400">
                  <MathTex tex={`x^* = ${texProb(resolved.x)}`} />
                </span>
                <span className="text-player-b-600 dark:text-player-b-400">
                  <MathTex tex={`y^* = ${texProb(resolved.y)}`} />
                </span>
                <span className="text-slate-700 dark:text-slate-200">
                  <MathTex tex={`\\mathbb{E}[A] ${payoffTexRhs(EA(resolved.x, resolved.y, payoffs))}`} />
                </span>
                <span className="text-slate-700 dark:text-slate-200">
                  <MathTex tex={`\\mathbb{E}[B] ${payoffTexRhs(EB(resolved.x, resolved.y, payoffs))}`} />
                </span>
              </div>

              {/* THE CONVENTION, stated rather than left to be discovered.
                  Nothing above is false — every number is the correct value of
                  the quantity it names, computed at the exact equilibrium and
                  rounded once, at display time. What is NOT true is that the
                  four PRINTED numbers form a self-consistent tuple: substitute
                  the printed x* and y* into E[A] and you land somewhere else,
                  for 50.5% of mixed equilibria on integer payoffs in [-9,9]
                  (worst 0.008) and 90.0% at the +/-100 clamp (worst 0.093).
                  Those two figures count E[A] ALONE; counting a mixed NE as
                  affected when EITHER payoff moves gives 77.5% and 99.0%, which
                  is the same phenomenon on a wider population, not a different
                  measurement.
                  A reader who checks the arithmetic by hand — which is exactly
                  what this app invites, and what a referee will do — concludes
                  the app is wrong.

                  Printing more coordinate digits was the alternative and it
                  does NOT close the gap: making the substitution reproduce BOTH
                  printed payoffs needs 5 dp for 99.7% of mixed NEs at int[-9,9]
                  and 6 dp for 98.7% at int[-100,100], and never reaches 100%.
                  That buys "x* = 0.333333" on the Search Game preset in
                  exchange for a guarantee it cannot deliver.

                  And recomputing the payoffs AT the rounded profile is ruled
                  out: it was the old convention, and it made the solver label
                  and the templated prose print 2.315 and 2.316 for the same
                  quantity. Today both say 2.316.

                  Mixed only. At a pure equilibrium the coordinates are exactly
                  0 or 1, the substitution reproduces the payoff exactly, and
                  the caveat would be noise. Wording kept in step with the
                  convention comment in gameEngine.ts. */}
              {realisedConcept === 'mixed' && (
                <p className="text-[11px] leading-snug text-muted dark:text-muted-dark -mt-1 px-1">
                  Computed at the exact equilibrium, then rounded to 3 dp for display — recomputing E[A] from the rounded x* and y* can differ in the last digits.
                </p>
              )}

              <div className="bg-white/50 dark:bg-slate-900/30 p-3.5 rounded-xl border border-slate-100 dark:border-slate-800 text-xs font-mono text-slate-600 dark:text-slate-300 space-y-1">
                {realisedConcept === 'mixed' ? (
                  <>
                    <div>
                      <span className="font-sans font-semibold text-player-a-600 dark:text-player-a-400 mr-2">
                        {lines.a.indifferent ? 'A indifferent:' : 'A strictly prefers:'}
                      </span>
                      <MathTex tex={lines.a.tex} />
                    </div>
                    <div>
                      <span className="font-sans font-semibold text-player-b-600 dark:text-player-b-400 mr-2">
                        {lines.b.indifferent ? 'B indifferent:' : 'B strictly prefers:'}
                      </span>
                      <MathTex tex={lines.b.tex} />
                    </div>
                    <div className="text-xs text-muted dark:text-muted-dark mt-2 font-sans font-medium">
                      {/* The COUNT is real (the regret branch increments
                          cycleCount too), but "search corridors" is the shrink
                          method's furniture — the regret log has no corridor
                          lines at all. Name what the run actually did. */}
                      Resolved via {simState.cycleCount} {(runCtx?.stepMode ?? stepMode) === 'regret'
                        ? 'regret contraction cycles' : 'contraction cycles of search corridors'}.
                    </div>
                  </>
                ) : (
                  <div className="font-sans text-xs">
                    {/* This printed nearestNE.eA — the payoff of the NEAREST
                        equilibrium — not what the run actually realised. On the
                        red-team fixture it claimed a committed payoff of 9.000
                        two lines below a box showing E[A] = -9.000. */}
                    {/* The NUMBER was corrected to the realised payoff, but the
                        NOUN still claimed "optimal pure NE payoff" on runs that
                        settled at a profile that is not a pure NE at all. Say
                        what actually happened. */}
                    {/* `toFixed(3)` here could print "-0.000" — a negative zero
                        that both claims the payoff is nothing and reads as a
                        typo. This is prose, not TeX, so it takes `fmtPayoff`
                        (which says "less than 0.001" in words) rather than
                        `payoffTexRhs`. */}
                    Mover priority settled. Player {(runCtx?.firstMover ?? firstMover) === 'A' ? 'A' : 'B'} moved first and realised {fmtPayoff((runCtx?.firstMover ?? firstMover) === 'A' ? EA(resolved.x, resolved.y, payoffs) : EB(resolved.x, resolved.y, payoffs))}.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Game situation description box */}
          <div ref={reportPanelRef} className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300 h-fit">
            <div className="text-slate-800 dark:text-slate-100 font-semibold text-sm border-b border-rose-100/50 dark:border-slate-800 pb-2 flex items-center gap-1.5">
              <Compass className="w-4 h-4 text-emerald-500" />
              Game-Theoretic Report
            </div>

            <div className="space-y-3">
              <div data-tour="ne">
                <strong className="text-slate-700 dark:text-slate-200">Calculated Nash Equilibria:</strong>
                <ul className="list-disc pl-5 mt-1 text-slate-600 dark:text-slate-300 space-y-1">
                  {allNE.map((ne, idx) => (
                    <li key={idx}>
                      {/* ColorCoded inside: nested spans recolor the Row/Col
                          and coordinate pieces while the outer class keeps
                          the label's own weight and base hue. */}
                      <span className={`font-semibold ${ne.type === 'mixed' ? 'text-ne-mixed-600 dark:text-ne-mixed-400' : 'text-slate-800 dark:text-slate-100'}`}>
                        <ColorCoded text={ne.label} />
                      </span>{' '}
                      {/* Recomputed via `neValues`, not read from ne.eA/eB: those are
                          stored pre-rounded, and -0 === 0 in JavaScript, so a bare
                          fmtPayoff swap would keep printing a false zero. */}
                      with values <ColorCoded text={`E[A]=${neValues(ne, payoffs).a}, E[B]=${neValues(ne, payoffs).b}`} />
                    </li>
                  ))}
                  {continua.map((line, idx) => (
                    <li key={`cont-${idx}`} className="text-ne-mixed-600 dark:text-ne-mixed-400">
                      <ColorCoded text={line} />
                    </li>
                  ))}
                  {allNE.length === 0 && continua.length === 0 && (
                    <li className="text-rose-500 font-medium">No standard NE found in real dimensions.</li>
                  )}
                </ul>
              </div>

              {indifferenceStatus.any && (
                <div className="bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-900/30 rounded-xl p-3.5 text-xs text-amber-800 dark:text-amber-300 space-y-1.5 shadow-sm leading-relaxed">
                  <div className="font-semibold flex items-center gap-1.5 text-amber-900 dark:text-amber-100">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                    Flat Payoffs & Indifference Notice
                  </div>
                  {indifferenceStatus.both ? (
                    <p>
                      Because all choices yield identical payoffs, <strong>every single point</strong> in the continuous [0, 1] × [0, 1] strategy space is a Nash Equilibrium! Neither player has any incentive to deviate. Any active path movement is simply an artifact of default tie-breaking direction or step sizes.
                    </p>
                  ) : indifferenceStatus.aIndifferent ? (
                    <p>
                      <strong>Player A's options yield flat payoffs.</strong> Since Player A's strategy does not affect their payoff, they have no relative incentive to shift rows. This produces entire lines/ranges of equilibria and causes neutral best-response drift.
                    </p>
                  ) : (
                    <p>
                      <strong>Player B's options yield flat payoffs.</strong> Since Player B's strategy does not affect their payoff, they have no relative incentive to shift columns. This produces entire lines/ranges of equilibria and causes neutral best-response drift.
                    </p>
                  )}
                </div>
              )}

              {/* Category narrative. Suppressed on degenerate (flat-payoff)
                  games: the amber notice above is the accurate story there,
                  and these branches would assert structure (first-mover
                  advantage, unique attractors) that a continuum of equilibria
                  contradicts on the same screen. */}
              {!indifferenceStatus.any && !hasEquilibriumContinuum && (
              <div className="text-slate-500 dark:text-slate-400">
                {pureNEs.length === 0 && mixedNE ? (
                  <p>
                    No pure strategy NE coordinates exist. The best-response trajectory forms stable cyclic loops, letting our domain-shrinking algorithm narrow down the search corridor boundaries until they safely contract and lock directly onto the <strong className="text-ne-mixed-600 dark:text-ne-mixed-400 font-bold">Mixed NE</strong>.
                  </p>
                ) : pureNEs.length === 1 && !mixedNE ? (
                  <p>
                    Exactly one pure NE exists. Best response trajectories will always converge towards the unique pure attracter point.
                  </p>
                ) : pureNEs.length >= 1 && mixedNE ? (
                  <div>
                    <p className="mb-2">
                      Multiple pure equilibria exist as well as a mixed NE which is unstable under best-response dynamics.
                    </p>
                    {committedNE && (
                      <p className="font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/20 rounded-xl p-2.5 border border-emerald-100 dark:border-emerald-800">
                        <ColorCoded
                          text={`Player ${firstMover} initiates and commits to: ${committedNE.label} (payoff A = ${neValues(committedNE, payoffs).a}, B = ${neValues(committedNE, payoffs).b}).`}
                          aTerms={colorTerms.a}
                          bTerms={colorTerms.b}
                        />
                      </p>
                    )}
                  </div>
                ) : pureNEs.length > 1 ? (
                  // This branch is only reachable with NO interior mixed NE
                  // (the >=1 && mixedNE arm above catches the rest), so the
                  // copy must not mention one — the old text referenced "the
                  // mixed NE" and named pureNEs[0] as the destination, which
                  // is corner-enumeration order, not where dynamics actually
                  // land. The committed-NE line states the real tie-break.
                  <div>
                    <p className="mb-2">
                      Multiple pure equilibria coexist with no interior mixed NE. Which corner the
                      trajectories settle on depends on the starting point and on who moves first.
                    </p>
                    {committedNE && (
                      <p className="font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/20 rounded-xl p-2.5 border border-emerald-100 dark:border-emerald-800">
                        <ColorCoded
                          text={`Player ${firstMover} initiates and commits to: ${committedNE.label} (payoff A = ${neValues(committedNE, payoffs).a}, B = ${neValues(committedNE, payoffs).b}).`}
                          aTerms={colorTerms.a}
                          bTerms={colorTerms.b}
                        />
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
              )}

              {/* Plain-English explanation. The solver computes; the model only
                  narrates, and its claims are checked against the solver before
                  a single word of it is shown. */}
              <div className="border-t border-slate-100 dark:border-slate-800 pt-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
                    Plain-English Explanation
                  </strong>
                  <div className="flex items-center gap-1.5">
                    {/*
                      Opt-in path to a NEW invented story for a game that already
                      has one: the request omits the scenario, so the model
                      invents and the suggestion card below offers it — nothing
                      is replaced unless the user saves it.
                    */}
                    {scenarioForReport && (
                      <button
                        onClick={() => void fetchFreshScenario()}
                        disabled={llmLoading || scenarioLoading}
                        title="Invent a brand-new scenario for these payoffs — you choose whether to keep it."
                        className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-slate-50/60 dark:bg-slate-900/40 hover:bg-slate-100 dark:hover:bg-slate-800/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {scenarioLoading ? 'Inventing…' : 'New AI scenario'}
                      </button>
                    )}
                    <button
                      onClick={() => fetchLlmExplanation()}
                      // RED-APP-7/002 belt-and-braces: also disabled while a
                      // scenario invention is in flight, mirroring "New AI
                      // scenario"'s own `llmLoading || scenarioLoading`. The
                      // separate generation counters above already stop the
                      // race from leaving anything stuck; this additionally
                      // closes the REACHABILITY precondition so a real click
                      // can never fire the two request kinds concurrently.
                      disabled={llmLoading || scenarioLoading}
                      className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 bg-indigo-50/60 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {llmLoading ? 'Analyzing…' : llmEnvelope ? 'Regenerate' : 'Explain this game'}
                    </button>
                  </div>
                </div>

                {llmLoading && (
                  <p className="italic text-prose-muted dark:text-prose-muted-dark">
                    Writing an explanation and checking it against the solver…
                  </p>
                )}

                {!llmLoading && llmVerified && llmEnvelope?.report && (
                  <div className="space-y-2">
                    {llmEnvelope.source === 'template' && (
                      // Say plainly who wrote what: on a tie game the sentences
                      // are generated from the solver, and only the scenario
                      // came from the model.
                      <p className="text-[11px] uppercase tracking-wide text-prose-muted dark:text-prose-muted-dark">
                        {/* This said "this game has a payoff tie" unconditionally.
                            True while only the tie path produced `template`, but
                            NASH_PAYOFF_TEMPLATE=1 routes EVERY game here, so a
                            textbook Prisoner's Dilemma was told it has a tie.
                            Found by an adversarial red team; the 300-game campaign
                            missed it because it verified the API response, not the
                            rendered UI. */}
                        {hasPayoffTie
                          ? 'Generated from the solver — this game has a payoff tie'
                          : 'Generated from the solver — the mathematics is derived, not written by the model'}
                      </p>
                    )}
                    <p className="text-slate-600 dark:text-slate-300">
                      {/* A fresh invention's prose uses the suggestion's own
                          option names, so those join the highlight terms.
                          Reads `proseScenario` (a SNAPSHOT taken when this
                          exact prose was written), never the envelope's own
                          live suggested-scenario field directly —
                          RED-PUBLIC C: "New AI scenario" replaces that live
                          field with a brand-new draw while intentionally
                          leaving this prose untouched, so reading it live
                          would name a story this text never mentions while
                          the nouns actually IN it go uncoloured. See the
                          proseScenario declaration. */}
                      <ColorCoded
                        text={llmEnvelope.report.prose}
                        aTerms={[
                          ...colorTerms.a,
                          ...(proseScenario
                            ? [proseScenario.row1, proseScenario.row2].filter(Boolean)
                            : []),
                        ]}
                        bTerms={[
                          ...colorTerms.b,
                          ...(proseScenario
                            ? [proseScenario.col1, proseScenario.col2].filter(Boolean)
                            : []),
                        ]}
                      />
                    </p>
                    <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                      <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Every equilibrium named above was verified against the solver
                        {llmEnvelope.validation ? ` (${llmEnvelope.validation.checks.length} checks passed)` : ''}.
                      </span>
                    </div>

                    {/*
                      Appears when the explanation above was written against an
                      INVENTED story: either the game had no scenario of its own,
                      or the user pressed "New AI scenario" to ask for one. Saving
                      is always the user's choice — for a saved game it replaces
                      the description in place, for a preset it saves a custom
                      copy; declining leaves everything untouched.
                    */}
                    {llmEnvelope.report.suggestedScenario && (
                      <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900/60 dark:bg-indigo-950/30">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
                          Scenario written for this game
                        </p>
                        <p className="mt-1 font-semibold text-slate-700 dark:text-slate-200 break-words">
                          {llmEnvelope.report.suggestedScenario.name}
                        </p>
                        <p className="mt-0.5 text-[12px] text-slate-600 dark:text-slate-300 break-words">
                          {/* Same terms this description will get once it is
                              saved as the game's own (colorTermsFor is the one
                              definition). Passing only the four option names
                              here made the card color LESS than the identical
                              text did a click later, which read as the save
                              having changed the writing. */}
                          <ColorCoded
                            text={llmEnvelope.report.suggestedScenario.description ?? ''}
                            aTerms={colorTermsFor(llmEnvelope.report.suggestedScenario).a}
                            bTerms={colorTermsFor(llmEnvelope.report.suggestedScenario).b}
                          />
                        </p>
                        <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                          <span className="text-player-a-ink dark:text-player-a-ink-dark font-semibold">
                            A: {llmEnvelope.report.suggestedScenario.row1} / {llmEnvelope.report.suggestedScenario.row2}
                          </span>
                          {'  ·  '}
                          <span className="text-player-b-ink dark:text-player-b-ink-dark font-semibold">
                            B: {llmEnvelope.report.suggestedScenario.col1} / {llmEnvelope.report.suggestedScenario.col2}
                          </span>
                        </p>
                        <button
                          type="button"
                          onClick={() => useSuggestedScenario(llmEnvelope.report!.suggestedScenario!)}
                          className="mt-2.5 rounded-md bg-indigo-600 px-2.5 py-1.5 text-[12px] font-semibold text-white transition hover:bg-indigo-700"
                        >
                          Save this scenario with the game
                        </button>
                        <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                          Keeps these names for future explanations instead of inventing new ones.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {!llmLoading && llmEnvelope && !llmVerified && (
                  <p className="text-prose-muted dark:text-prose-muted-dark italic">
                    No verified explanation available
                    {llmEnvelope.fallbackReason ? ` (${llmEnvelope.fallbackReason})` : ''} — the computed
                    report above is authoritative.
                  </p>
                )}

                {!llmLoading && !llmEnvelope && llmError && (
                  <p className="text-amber-700 dark:text-amber-400">
                    {/* RED-APP-6/003: distinct, honest wording for a client-side
                        timeout (a stalled connection, aborted after
                        REPORT_FETCH_TIMEOUT_MS) vs. an ordinary fast failure —
                        both re-enable the button either way, via llmLoading. */}
                    {llmTimedOut
                      ? "This is taking longer than expected. The computed report above is unaffected — try again?"
                      : "Couldn't reach the explanation service. The computed report above is unaffected — try again in a moment."}
                  </p>
                )}

                {!llmLoading && !llmEnvelope && !llmError && (
                  <p className="text-prose-muted dark:text-prose-muted-dark">
                    Get a written walkthrough of what each player is trading off. The equilibria are
                    always computed exactly; the explanation is checked against them before it appears.
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Log sits in the right column, sized to align with the params panel */}
          {!logBelow && simulationLogPanel}
        </div>

        {/* When the converged report leaves no room, the log spans full width */}
        {logBelow && (
          <div className="lg:col-span-12">
            {simulationLogPanel}
          </div>
        )}
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 py-4 px-6 text-center">
        <p className="text-xs text-muted dark:text-muted-dark">© 2026 Daniel Luan</p>
      </footer>

      {expandedLogOverlay}

      <Walkthrough steps={tourSteps} open={tourOpen} onClose={closeTour} />

      {isAuthModalOpen && (
        <div
          // RED-APP-5 finding 003 (round 5): the guided tour is deliberately
          // NON-modal (Walkthrough.tsx's own comment) and click-through, so
          // a visitor can open Sign In from behind it mid-tour — the Sign In
          // button stays clickable throughout. But at the OLD z-50 this
          // dialog painted BELOW the tour's z-[60] callout card, which could
          // visually and functionally cover the Login button (a real,
          // timed, non-forced Playwright click on it timed out;
          // `elementFromPoint` at the button's center returned the tour
          // card's own <h3>, not the button). A deliberately-opened dialog
          // must always win the click, so this and the other three dialogs
          // below (plus the expand-log overlay above) render at z-[65] —
          // above the tour, not by making the tour modal. The tour itself
          // is untouched: still non-modal, still click-through, still
          // visible around a foreground dialog's backdrop.
          className="fixed inset-0 z-[65] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none"
          onClick={() => { setIsAuthModalOpen(false); setAuthError(''); setAuthSuccess(''); resumeSaveAfterAuthRef.current = false; resumeEditAfterAuthRef.current = false; }}
        >
          <div
            ref={authDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Account"
            onClick={(e) => e.stopPropagation()}
            // RED-APP-8/005: matches the Save/Edit dialogs' own height cap —
            // without it, at a short viewport (e.g. 320x200, what 400% zoom
            // on an ordinary screen produces) this fixed-position dialog can
            // render taller than the viewport with no scroll path (page
            // scroll has zero effect on a `position:fixed` element), making
            // Login/Sign Up permanently unreachable.
            className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-xl animate-modal-in max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-accent-50 dark:bg-accent-950/40 text-accent-600 rounded-lg">
                  <User className="w-4 h-4" />
                </span>
                <span className="font-bold text-slate-800 dark:text-slate-100 text-sm md:text-base">
                  {authMode === 'login' ? 'Sign In' : authMode === 'register' ? 'Create Account' : authMode === 'verify' ? 'Verify Email' : authMode === 'forgot' ? 'Forgot Password' : 'Reset Password'}
                </span>
              </div>
              <button
                onClick={() => {
                  setIsAuthModalOpen(false);
                  setAuthError('');
                  setAuthSuccess('');
                  resumeSaveAfterAuthRef.current = false;
                  resumeEditAfterAuthRef.current = false;
                }}
                aria-label="Close dialog" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {authError && (
              <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-300 text-xs rounded-xl p-3 flex gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                <span>{authError}</span>
              </div>
            )}

            {authSuccess && (
              <div className="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-xs rounded-xl p-3 flex gap-3 font-medium">
                <Check className="w-4 h-4 shrink-0 text-emerald-500" />
                <span>{authSuccess}</span>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="flex flex-col gap-3.5">
              {authMode === 'register' && (
                <div>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Username</label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                      placeholder="game_theorist"
                      value={authUsername}
                      onChange={(e) => setAuthUsername(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}

              {(authMode === 'login' || authMode === 'register') && (
                <>
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">
                      {authMode === 'login' ? 'Email or Username' : 'Email Address'}
                    </label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type={authMode === 'login' ? 'text' : 'email'}
                        className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder={authMode === 'login' ? 'john@example.com or username' : 'john@example.com'}
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="password"
                        className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder="••••••••"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        required
                      />
                    </div>
                    {authMode === 'register' && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-normal">
                        Password requirement: <strong className="text-accent-600 dark:text-accent-400 font-semibold">Min 8 characters</strong> with at least <strong className="text-accent-600 dark:text-accent-400 font-semibold">one uppercase</strong> and <strong className="text-accent-600 dark:text-accent-400 font-semibold">one lowercase</strong> letter.
                      </p>
                    )}
                  </div>

                  {authMode === 'register' && (
                    <div>
                      <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Retype Password</label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input
                          type="password"
                          className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-300 dark:focus:ring-slate-700 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                          placeholder="••••••••"
                          value={authConfirmPassword}
                          onChange={(e) => setAuthConfirmPassword(e.target.value)}
                          required
                        />
                      </div>
                      {authPassword && authConfirmPassword && (
                        <div className="text-xs mt-1 font-semibold">
                          {authPassword === authConfirmPassword ? (
                            <span className="text-emerald-600 flex items-center gap-1">✓ Passwords match</span>
                          ) : (
                            <span className="text-rose-500 flex items-center gap-1">✗ Passwords do not match</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {authMode === 'verify' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">6-Digit Confirmation Code</label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        maxLength={6}
                        className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm tracking-widest font-mono font-bold bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-center text-slate-800 dark:text-slate-200"
                        placeholder="123456"
                        value={authCode}
                        onChange={(e) => setAuthCode(e.target.value.replace(/\D/g, ''))}
                        required
                      />
                    </div>
                  </div>
                </div>
              )}

              {authMode === 'forgot' && (
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-3 leading-relaxed">
                    Enter the email address associated with your account and we'll send you a 6-digit recovery code.
                  </p>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Email Address</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="email"
                      className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                      placeholder="john@example.com"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}

              {authMode === 'reset-password' && (
                <div className="space-y-3.5">
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">6-Digit Recovery Code</label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        maxLength={6}
                        className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm tracking-widest font-mono font-bold bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-100 focus:border-slate-300 text-center text-slate-800 dark:text-slate-200"
                        placeholder="123456"
                        value={authCode}
                        onChange={(e) => setAuthCode(e.target.value.replace(/\D/g, ''))}
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">New Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="password"
                        className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder="••••••••"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        required
                      />
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-normal">
                      Min 8 characters with at least one <strong className="text-orange-600 dark:text-orange-400">uppercase</strong> and one <strong className="text-orange-600 dark:text-orange-400">lowercase</strong> letter.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Confirm New Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="password"
                        className="w-full pl-9 pr-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-100/50 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder="••••••••"
                        value={authConfirmPassword}
                        onChange={(e) => setAuthConfirmPassword(e.target.value)}
                        required
                      />
                    </div>
                    {authPassword && authConfirmPassword && (
                      <div className="text-xs mt-1 font-semibold">
                        {authPassword === authConfirmPassword ? (
                          <span className="text-emerald-600 flex items-center gap-1">✓ Passwords match</span>
                        ) : (
                          <span className="text-rose-500 flex items-center gap-1">✗ Passwords do not match</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={authLoading}
                className={`w-full text-white font-bold text-xs sm:text-sm py-2.5 rounded-xl transition-all cursor-pointer shadow-xs disabled:opacity-50 inline-flex items-center justify-center gap-1.5 ${authMode === 'forgot' || authMode === 'reset-password' ? 'bg-orange-500 hover:bg-orange-600' : 'bg-accent-600 hover:bg-accent-700'}`}
              >
                {authLoading ? 'Please wait...' : authMode === 'login' ? 'Login' : authMode === 'register' ? 'Register Account' : authMode === 'verify' ? 'Verify & Setup Account' : authMode === 'forgot' ? 'Send Recovery Code' : 'Reset Password'}
              </button>
            </form>

            <div className="border-t border-slate-100 dark:border-slate-800 pt-3.5 text-center text-xs text-slate-500 dark:text-slate-400 font-medium flex flex-col gap-1.5">
              {authMode === 'login' ? (
                <>
                  <span>
                    Don't have an account?{' '}
                    <button
                      onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthMode('register'); }}
                      className="font-bold text-accent-600 hover:underline cursor-pointer"
                    >
                      Sign Up
                    </button>
                  </span>
                  <span>
                    <button
                      onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthCode(''); setAuthMode('forgot'); }}
                      className="font-bold text-orange-500 hover:underline cursor-pointer"
                    >
                      Forgot your password?
                    </button>
                  </span>
                </>
              ) : authMode === 'register' ? (
                <span>
                  Already have an account?{' '}
                  <button
                    onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthMode('login'); }}
                    className="font-bold text-accent-600 hover:underline cursor-pointer"
                  >
                    Log In
                  </button>
                </span>
              ) : authMode === 'forgot' || authMode === 'reset-password' ? (
                <span>
                  Remember your password?{' '}
                  <button
                    onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthCode(''); setAuthPassword(''); setAuthConfirmPassword(''); setAuthMode('login'); }}
                    className="font-bold text-accent-600 hover:underline cursor-pointer"
                  >
                    Back to Login
                  </button>
                </span>
              ) : (
                <span>
                  Back to{' '}
                  <button
                    onClick={() => { setAuthError(''); setAuthSuccess(''); setAuthMode('register'); }}
                    className="font-bold text-accent-600 hover:underline cursor-pointer"
                  >
                    Registration
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Save Custom Game Modal ── */}
      {/* Edit an already-saved game: name, description, option names.
          Payoffs are deliberately absent — the server refuses to update them
          here, because changing the numbers silently invalidates the story
          written about them, which is the exact mismatch the scenario feature
          exists to prevent. Editing a matrix stays a save-as-new operation. */}
      {isEditModalOpen && (
        <div
          // z-[65]: above the guided tour (z-[60]) — see the RED-APP-5 003 note
          // on the Auth dialog above.
          className="fixed inset-0 z-[65] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none"
          onClick={() => { setIsEditModalOpen(false); setEditError(''); }}
        >
          <div
            ref={editDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Edit saved game"
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-xl animate-modal-in max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Pencil className="w-4 h-4 text-accent-500" />
                <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">Edit Game</h3>
              </div>
              <button
                type="button"
                onClick={() => { setIsEditModalOpen(false); setEditError(''); }}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xs cursor-pointer"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleEditGameSubmit} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Game Name</label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                  value={editName}
                  onBeforeInput={clampLabelBeforeInput}
                  onChange={(e) => setEditName((e.nativeEvent as InputEvent).isComposing ? e.target.value : clampLabelInput(e.target.value))}
                  onCompositionEnd={(e) => {
                    const v = e.currentTarget.value;
                    const clamped = clampLabelInput(v);
                    if (clamped !== v) setEditName(clamped);
                  }}
                  required
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Game Description</label>
                {/* Same 800 as the save modal and the server clamp — an
                    AI-kept description can legitimately be this long, and a
                    lower cap here would lock editing of exactly those games. */}
                <DescriptionEditor
                  value={editDesc}
                  onChange={setEditDesc}
                  termsA={editTerms.a}
                  termsB={editTerms.b}
                  onTermsChange={(a, b) => setEditTerms({ a, b })}
                  baseA={editBaseTerms.a}
                  baseB={editBaseTerms.b}
                  maxLength={800}
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">
                  Option Names <span className="font-normal text-muted dark:text-muted-dark">(optional)</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['row1', "A's Row 1", 'e.g. Undercut'],
                    ['row2', "A's Row 2", 'e.g. Hold price'],
                    ['col1', "B's Col 1", 'e.g. Match'],
                    ['col2', "B's Col 2", 'e.g. Ignore'],
                  ] as const).map(([key, label, placeholder]) => (
                    <div key={key}>
                      <span className={`block text-[10px] font-semibold mb-0.5 ${key.startsWith('row') ? 'text-player-a-500' : 'text-player-b-600 dark:text-player-b-400'}`}>
                        {label}
                      </span>
                      <input
                        type="text"
                        className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder={placeholder}
                        value={editLabels[key]}
                        onBeforeInput={clampLabelBeforeInput}
                        onChange={(e) => setEditLabels((prev) => ({
                          ...prev,
                          // RED-APP-8/002: never clamp WHILE an IME composition is
                          // open (the DOM value is correct as-is; onBeforeInput
                          // cannot block insertCompositionText).
                          [key]: (e.nativeEvent as InputEvent).isComposing ? e.target.value : clampLabelInput(e.target.value),
                        }))}
                        onCompositionEnd={(e) => {
                          // The commit's own trailing `input` event often carries
                          // the SAME string the last mid-composition `input` event
                          // already wrote to the DOM — React's value tracker sees
                          // no change from what it last recorded and suppresses
                          // onChange entirely for that event, so relying on
                          // onChange alone left an over-budget composed string
                          // unclamped forever. onCompositionEnd fires unconditionally
                          // (it does not go through the value-tracker dedup), so it
                          // is the one place guaranteed to see the committed value.
                          const v = e.currentTarget.value;
                          const clamped = clampLabelInput(v);
                          if (clamped !== v) setEditLabels((prev) => ({ ...prev, [key]: clamped }));
                        }}
                      />
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-muted dark:text-muted-dark">
                  Naming all four lets the AI explainer reuse this scenario instead of inventing a new one.
                  Clear a box to remove that name.
                </p>
              </div>

              <p className="text-[10px] text-muted dark:text-muted-dark -mt-1">
                To change the payoff numbers, edit them on the board and save as a new game — the
                description here would no longer match.
              </p>

              {/* "Regenerate scenario" (FEATURE-REGEN, flag NASH_SCENARIO_REGEN,
                  default OFF — hidden until the server capability probe says
                  it's on). Its own indigo block, separate from any other AI
                  affordance, right under the immutability note above: this
                  rewrites the STORY only, the numbers on the board never move. */}
              {capabilities.scenarioRegen && (
                <div className="bg-indigo-50/40 dark:bg-indigo-950/20 border border-indigo-200 dark:border-indigo-900/50 rounded-xl p-3 flex flex-col gap-2" aria-busy={regen.status === 'loading'}>
                  <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 shrink-0" />
                    Rewrite the story for these payoffs
                  </span>
                  <div>
                    <button
                      ref={regenButtonRef}
                      type="button"
                      aria-label="Regenerate scenario"
                      aria-disabled={regen.status === 'loading'}
                      title="Have the AI write a new description and option names for these exact payoffs. You preview it first; nothing changes until you Keep it."
                      onClick={() => { if (regen.status !== 'loading' && editGameId) void handleRegenerateScenario({ kind: 'edit', gameId: editGameId }); }}
                      className="px-3.5 py-1.5 text-xs font-semibold rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 bg-indigo-50/60 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      {regen.status === 'loading' ? 'Regenerating…' : regen.status === 'ready' ? 'Regenerate again' : 'Regenerate scenario'}
                    </button>
                  </div>
                  {regen.note && (
                    <p role="status" aria-live="polite" className="text-[10px] leading-relaxed font-semibold text-indigo-700 dark:text-indigo-300">
                      {regen.note}
                    </p>
                  )}
                  {regen.status === 'ready' && regen.preview && (
                    <div className="mt-1 rounded-lg border border-indigo-200 bg-white/70 dark:border-indigo-900/60 dark:bg-slate-950/30 p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
                        New scenario (preview)
                      </p>
                      <p className="mt-1 font-semibold text-slate-700 dark:text-slate-200 break-words text-xs">
                        {regen.preview.name}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-300 break-words">
                        <ColorCoded text={regen.preview.description ?? ''} aTerms={regenPreviewTerms.a} bTerms={regenPreviewTerms.b} />
                      </p>
                      <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                        <span className="text-player-a-ink dark:text-player-a-ink-dark font-semibold">
                          A: {regen.preview.row1} / {regen.preview.row2}
                        </span>
                        {'  ·  '}
                        <span className="text-player-b-ink dark:text-player-b-ink-dark font-semibold">
                          B: {regen.preview.col1} / {regen.preview.col2}
                        </span>
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => editGameId && keepRegen({ kind: 'edit', gameId: editGameId })}
                          className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-indigo-700"
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          onClick={discardRegen}
                          className="rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          Discard
                        </button>
                      </div>
                      <p className="mt-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                        Keep replaces the description and option names below with this text — your highlights are kept. Payoffs are never changed.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {editError && (
                // RED-APP-7/001: mirrors the Save dialog's own !authToken
                // branch below — a mid-session 401 (token expired while the
                // tab stayed open) now clears authToken (see
                // handleEditGameSubmit), so this fires instead of leaving
                // the user with the bare server string and no way forward.
                !authToken ? (
                  <div className="bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 text-indigo-800 dark:text-indigo-200 text-xs rounded-xl p-3 flex gap-2 font-medium">
                    <LogIn className="w-4 h-4 shrink-0 text-indigo-500 dark:text-indigo-400 mt-0.5" />
                    <div className="flex flex-col items-start gap-2">
                      <span>{editError} Your changes will stay right here.</span>
                      <button
                        type="button"
                        onClick={() => {
                          resumeEditAfterAuthRef.current = true;
                          setIsEditModalOpen(false);
                          setAuthError(''); setAuthSuccess(''); setAuthMode('login'); setIsAuthModalOpen(true);
                        }}
                        className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-indigo-700"
                      >
                        Sign In / Sign Up
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-danger-500 font-semibold">{editError}</p>
                )
              )}

              <div className="flex gap-2 justify-end border-t border-slate-100 dark:border-slate-800 pt-3.5">
                <button
                  type="button"
                  onClick={() => { setIsEditModalOpen(false); setEditError(''); }}
                  className="px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editLoading}
                  className="bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs py-2 px-4 rounded-xl transition-all shadow-xs cursor-pointer disabled:opacity-50"
                >
                  {editLoading ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isSaveModalOpen && (
        <div
          // z-[65]: above the guided tour (z-[60]) — see the RED-APP-5 003 note
          // on the Auth dialog above.
          className="fixed inset-0 z-[65] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none"
          onClick={() => { setIsSaveModalOpen(false); setSaveError(''); }}
        >
          <div
            ref={saveDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Save custom game"
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-xl animate-modal-in max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-accent-50 dark:bg-accent-950/40 text-accent-600 rounded-lg">
                  <Award className="w-4 h-4" />
                </span>
                <span className="font-bold text-slate-800 dark:text-slate-100 text-sm md:text-base">
                  Save Custom Game
                </span>
              </div>
              <button
                onClick={() => {
                  setIsSaveModalOpen(false);
                  setSaveError('');
                }}
                aria-label="Close dialog" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {saveError && (
              // Signed out, any save problem: the remedy is signing in, so this
              // renders as an invitation with the door held open — not a red
              // error about sessions the visitor never had.
              !authToken ? (
                <div className="bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 text-indigo-800 dark:text-indigo-200 text-xs rounded-xl p-3 flex gap-2 font-medium">
                  <LogIn className="w-4 h-4 shrink-0 text-indigo-500 dark:text-indigo-400 mt-0.5" />
                  <div className="flex flex-col items-start gap-2">
                    <span>{saveError} Your matrix, name and description will stay right here.</span>
                    <button
                      type="button"
                      onClick={() => {
                        resumeSaveAfterAuthRef.current = true;
                        setIsSaveModalOpen(false);
                        setAuthError(''); setAuthSuccess(''); setAuthMode('login'); setIsAuthModalOpen(true);
                      }}
                      className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-indigo-700"
                    >
                      Sign In / Sign Up
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-300 text-xs rounded-xl p-3 flex gap-2 font-medium">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                  <span>{saveError}</span>
                </div>
              )
            )}

            <div className="bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800 rounded-xl p-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Payload to be saved:</span>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                <div>(Row 1, Col 1) = ({payoffs.a11}, {payoffs.b11})</div>
                <div>(Row 1, Col 2) = ({payoffs.a12}, {payoffs.b12})</div>
                <div>(Row 2, Col 1) = ({payoffs.a21}, {payoffs.b21})</div>
                <div>(Row 2, Col 2) = ({payoffs.a22}, {payoffs.b22})</div>
              </div>
            </div>

            {/* "Regenerate scenario" (FEATURE-REGEN, flag NASH_SCENARIO_REGEN,
                default OFF). A SEPARATE block from the generate-a-new-game
                affordance below — that one rolls a brand-new MATRIX; this one
                rewrites only the story for the payoffs shown above, which
                never move. Hidden while a Generate call is changing that
                matrix out from under it (handleGenerateGame already clears
                any preview the instant it starts). NOTE: never quote that
                other block's exact heading text verbatim in this comment —
                generatefill.test.ts locates it with a plain indexOf, and an
                earlier verbatim match up here breaks the locator. */}
            {capabilities.scenarioRegen && !generateLoading && (
              <div className="bg-indigo-50/40 dark:bg-indigo-950/20 border border-indigo-200 dark:border-indigo-900/50 rounded-xl p-3 flex flex-col gap-2" aria-busy={regen.status === 'loading'}>
                <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 shrink-0" />
                  Rewrite the story for these payoffs
                </span>
                <div>
                  <button
                    ref={regenButtonRef}
                    type="button"
                    aria-label="Regenerate scenario"
                    aria-disabled={regen.status === 'loading'}
                    title="Have the AI write a new description and option names for these exact payoffs. You preview it first; nothing changes until you Keep it."
                    onClick={() => { if (regen.status !== 'loading') void handleRegenerateScenario({ kind: 'save', payoffs }); }}
                    className="px-3.5 py-1.5 text-xs font-semibold rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 bg-indigo-50/60 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    {regen.status === 'loading' ? 'Regenerating…' : regen.status === 'ready' ? 'Regenerate again' : 'Regenerate scenario'}
                  </button>
                </div>
                {regen.note && (
                  <p role="status" aria-live="polite" className="text-[10px] leading-relaxed font-semibold text-indigo-700 dark:text-indigo-300">
                    {regen.note}
                  </p>
                )}
                {regen.status === 'ready' && regen.preview && (
                  <div className="mt-1 rounded-lg border border-indigo-200 bg-white/70 dark:border-indigo-900/60 dark:bg-slate-950/30 p-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
                      New scenario (preview)
                    </p>
                    <p className="mt-1 font-semibold text-slate-700 dark:text-slate-200 break-words text-xs">
                      {regen.preview.name}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-300 break-words">
                      <ColorCoded text={regen.preview.description ?? ''} aTerms={regenPreviewTerms.a} bTerms={regenPreviewTerms.b} />
                    </p>
                    <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                      <span className="text-player-a-ink dark:text-player-a-ink-dark font-semibold">
                        A: {regen.preview.row1} / {regen.preview.row2}
                      </span>
                      {'  ·  '}
                      <span className="text-player-b-ink dark:text-player-b-ink-dark font-semibold">
                        B: {regen.preview.col1} / {regen.preview.col2}
                      </span>
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => keepRegen({ kind: 'save', payoffs })}
                        className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-indigo-700"
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        onClick={discardRegen}
                        className="rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        Discard
                      </button>
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                      Keep replaces the description, option names and highlights below with this text. Payoffs are never changed.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Generate-a-game-for-me. Rolls a solver-verified random matrix
                with the chosen equilibrium structure onto the board (replacing
                the payload above), then prefills the form from an AI-invented
                scenario. Styled indigo like the app's other AI affordances. */}
            <div className="bg-indigo-50/40 dark:bg-indigo-950/20 border border-indigo-200 dark:border-indigo-900/50 rounded-xl p-3 flex flex-col gap-2">
              <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                …or generate a new game
              </span>
              <p className="text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
                Rolls a fresh random matrix with the equilibrium type you pick and has the AI write
                a scenario for it. Replaces the matrix shown above, and fills in the name,
                description and option names below — but only while you haven't typed your own;
                your own text is never overwritten.
              </p>
              <div className="flex gap-2">
                <select
                  value={generateKind}
                  onChange={(e) => setGenerateKind(e.target.value as 'pure' | 'mixed')}
                  disabled={generateLoading}
                  aria-label="Equilibrium type to generate"
                  className="flex-1 px-2.5 py-1.5 text-xs bg-white dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-700 dark:text-slate-200 cursor-pointer disabled:opacity-50"
                >
                  <option value="pure">Pure-strategy equilibrium</option>
                  <option value="mixed">Mixed-strategy equilibrium</option>
                </select>
                <button
                  type="button"
                  onClick={handleGenerateGame}
                  disabled={generateLoading}
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 bg-indigo-50/60 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {generateLoading ? 'Generating…' : 'Generate'}
                </button>
              </div>
              {generateNote && (
                <p className="text-[10px] leading-relaxed font-semibold text-indigo-700 dark:text-indigo-300">
                  {generateNote}
                </p>
              )}
            </div>

            <form onSubmit={handleSaveGameSubmit} className="flex flex-col gap-3.5">
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Game Name</label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                  placeholder="e.g. Battle of the Sexes 2.0"
                  value={saveName}
                  onBeforeInput={clampLabelBeforeInput}
                  onChange={(e) => setSaveName((e.nativeEvent as InputEvent).isComposing ? e.target.value : clampLabelInput(e.target.value))}
                  onCompositionEnd={(e) => {
                    const v = e.currentTarget.value;
                    const clamped = clampLabelInput(v);
                    if (clamped !== v) setSaveName(clamped);
                  }}
                  required
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Game Description</label>
                {/* Matches the server's clamp (cleanText(description, 800)).
                    A cap BELOW what prefill can supply locks the field: a
                    controlled textarea already over maxLength rejects every
                    keystroke, which read as "can't edit the description"
                    when an AI-invented scenario prefilled ~300+ chars. */}
                <DescriptionEditor
                  value={saveDesc}
                  onChange={setSaveDesc}
                  termsA={saveTerms.a}
                  termsB={saveTerms.b}
                  onTermsChange={(a, b) => setSaveTerms({ a, b })}
                  baseA={saveBaseTerms.a}
                  baseB={saveBaseTerms.b}
                  placeholder="Explain the background storyline or payoff choices of this strategic profile."
                  maxLength={800}
                />
              </div>

              {/* Option names. Optional, but the most valuable thing a user can
                  fill in: four labels are enough on their own for the explainer
                  to reuse this game's story instead of inventing a new one, and
                  they replace "Row 1"/"Col 2" in the matrix headers. */}
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">
                  Option Names <span className="font-normal text-muted dark:text-muted-dark">(optional)</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['row1', "A's Row 1", 'e.g. Undercut'],
                    ['row2', "A's Row 2", 'e.g. Hold price'],
                    ['col1', "B's Col 1", 'e.g. Match'],
                    ['col2', "B's Col 2", 'e.g. Ignore'],
                  ] as const).map(([key, label, placeholder]) => (
                    <div key={key}>
                      <span className={`block text-[10px] font-semibold mb-0.5 ${key.startsWith('row') ? 'text-player-a-500' : 'text-player-b-600 dark:text-player-b-400'}`}>
                        {label}
                      </span>
                      <input
                        type="text"
                        className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                        placeholder={placeholder}
                        value={saveLabels[key]}
                        onBeforeInput={clampLabelBeforeInput}
                        onChange={(e) => setSaveLabels((prev) => ({
                          ...prev,
                          // RED-APP-8/002: see the identical comment on the Edit
                          // dialog's label inputs above.
                          [key]: (e.nativeEvent as InputEvent).isComposing ? e.target.value : clampLabelInput(e.target.value),
                        }))}
                        onCompositionEnd={(e) => {
                          // See the identical comment on the Edit dialog's label
                          // inputs above — React's value tracker can suppress
                          // onChange for the composition-commit event.
                          const v = e.currentTarget.value;
                          const clamped = clampLabelInput(v);
                          if (clamped !== v) setSaveLabels((prev) => ({ ...prev, [key]: clamped }));
                        }}
                      />
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-muted dark:text-muted-dark">
                  Naming all four lets the AI explainer reuse this scenario instead of inventing a new one.
                </p>
              </div>

              <div className="flex gap-2 justify-end border-t border-slate-100 dark:border-slate-800 pt-3.5">
                <button
                  type="button"
                  onClick={() => setIsSaveModalOpen(false)}
                  className="px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saveLoading}
                  className="bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs py-2 px-4 rounded-xl transition-all shadow-xs cursor-pointer disabled:opacity-50"
                >
                  {saveLoading ? 'Saving...' : 'Save Game Profile'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Slideout workspace center menu drawer */}
      <MenuDrawer
        isOpen={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
        user={user}
        authToken={authToken}
        userCustomGames={userCustomGames}
        onDeleteCustomGame={handleDeleteGame}
        onLoadPreset={handleLoadPreset}
        activePreset={activePreset}
        isDark={darkMode}
        onLogout={handleLogout}
        onOpenAuth={() => {
          setAuthError('');
          setAuthSuccess('');
          setAuthMode('login');
          setIsAuthModalOpen(true);
        }}
        getApiUrl={getApiUrl}
        dbMode={dbMode}
        apiBaseUrl={apiBaseUrl}
        onSwitchDbMode={handleSwitchDbMode}
        onUpdateApiBaseUrl={(url) => {
          setApiBaseUrl(url);
          safeSetItem('nash_sim_api_base', url);
        }}
      />

      <DownloadModal
        isOpen={isDownloadModalOpen}
        onClose={() => setIsDownloadModalOpen(false)}
      />

      <OtherAccountsNotice dbMode={dbMode} signedIn={!!authToken} />

      {isAdminOpen && (
        <AdminDashboard
          onClose={() => setIsAdminOpen(false)}
          isDark={darkMode}
          isElectron={isElectron}
          apiBaseUrl={apiBaseUrl}
        />
      )}

      {/* Bottom-left feedback launcher. Hidden during the tour: it floats over
          the corner of the plot the spotlight keeps landing on, and a stray
          call-to-action inside a guided walkthrough reads as part of the tour. */}
      {!tourOpen && (
      <button
        data-print="hide"
        onClick={openFeedback}
        title="Send feedback"
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 px-3.5 py-2.5 rounded-full bg-accent-600 hover:bg-accent-700 text-white text-xs font-semibold shadow-lg shadow-accent-600/20 transition-all cursor-pointer select-none"
      >
        <MessageSquare className="w-4 h-4" />
        <span className="hidden sm:inline">Feedback</span>
      </button>
      )}

      {isFeedbackOpen && (
        <div
          // z-[65]: above the guided tour (z-[60]) — see the RED-APP-5 003 note
          // on the Auth dialog above.
          className="fixed inset-0 z-[65] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs select-none"
          onClick={closeFeedback}
        >
          <div
            ref={feedbackDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Send feedback"
            onClick={(e) => e.stopPropagation()}
            // RED-APP-8/005: same height cap as the Account dialog above,
            // for the same reason — this dialog was the other one of the
            // app's four full-size dialogs missing it.
            className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-xl animate-modal-in max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-accent-50 dark:bg-accent-950/40 text-accent-600 rounded-lg">
                  <MessageSquare className="w-4 h-4" />
                </span>
                <span className="font-bold text-slate-800 dark:text-slate-100 text-sm md:text-base">
                  Send Feedback
                </span>
              </div>
              <button
                onClick={closeFeedback}
                aria-label="Close dialog" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {feedbackSuccess ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <span className="p-2.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 rounded-full">
                  <CheckCircle2 className="w-7 h-7" />
                </span>
                <p className="text-sm text-slate-700 dark:text-slate-200 font-medium px-2">{feedbackSuccess}</p>
                <button
                  onClick={closeFeedback}
                  className="mt-1 bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs py-2 px-5 rounded-xl transition-all cursor-pointer"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                {feedbackError && (
                  <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-300 text-xs rounded-xl p-3 flex gap-2 font-medium">
                    <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                    <span>{feedbackError}</span>
                  </div>
                )}

                <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Share any questions, concerns, or ideas. Your email is optional — leave it blank to send anonymously.
                </p>

                <form onSubmit={handleFeedbackSubmit} className="flex flex-col gap-3.5">
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1.5">Rating <span className="font-normal text-slate-400">(optional)</span></label>
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setFeedbackRating(n === feedbackRating ? 0 : n)}
                          onMouseEnter={() => setFeedbackHoverRating(n)}
                          onMouseLeave={() => setFeedbackHoverRating(0)}
                          className="p-0.5 cursor-pointer"
                          aria-label={`${n} star${n > 1 ? 's' : ''}`}
                        >
                          <Star
                            className={`w-6 h-6 transition-colors ${
                              n <= (feedbackHoverRating || feedbackRating)
                                ? 'text-amber-400 fill-amber-400'
                                : 'text-slate-300 dark:text-slate-600'
                            }`}
                          />
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Your feedback</label>
                    <textarea
                      className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 h-28 resize-none text-slate-800 dark:text-slate-200"
                      placeholder="Questions, concerns, or feedback…"
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      maxLength={5000}
                      autoFocus
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Email <span className="font-normal text-slate-400">(optional — for a reply)</span></label>
                    <input
                      type="email"
                      className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 text-slate-800 dark:text-slate-200"
                      placeholder="you@example.com (leave blank to stay anonymous)"
                      value={feedbackEmail}
                      onChange={(e) => setFeedbackEmail(e.target.value)}
                    />
                  </div>

                  <div className="flex gap-2 justify-end border-t border-slate-100 dark:border-slate-800 pt-3.5">
                    <button
                      type="button"
                      onClick={closeFeedback}
                      className="px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={feedbackLoading}
                      className="flex items-center gap-1.5 bg-accent-600 hover:bg-accent-700 text-white font-semibold text-xs py-2 px-4 rounded-xl transition-all shadow-xs cursor-pointer disabled:opacity-50"
                    >
                      <Send className="w-3.5 h-3.5" />
                      {feedbackLoading ? 'Sending…' : 'Send Feedback'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

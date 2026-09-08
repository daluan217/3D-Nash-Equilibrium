/**
 * The ONE client every account-scoped request in this app goes through.
 *
 * WHY IT EXISTS (STRUCT-DESKTOP-19, round 19). Session semantics — which
 * failure means "your session is dead", which token may be cleared, when a
 * late response is no longer this context's business — used to be hand-wired
 * at each call site. Every round found the one site that had not been wired:
 *
 *   RED-DESKTOP-16/001  GET /api/games had no 401 handling at all
 *   CodeRabbit on #163  a 401 for an OLD token cleared the CURRENT one
 *   RED-DESKTOP-18/001  DELETE acted on a response from a previous context
 *   RED-DESKTOP-19/001  adopt-local never told the shared helper about its 401
 *   STRUCT-DESKTOP-19/001  /api/auth/me treated EVERY failure as a dead
 *                       session: a transient 503, and an ordinary offline
 *                       launch, DELETED the stored token — permanently
 *   STRUCT-DESKTOP-19/002  the Danger Zone carried a second, weaker copy of
 *                       the rule (no stale-token guard) and showed the
 *                       browser's raw "Failed to fetch" to the user
 *
 * That is one class with N instances, and it recurred because the rule lived
 * in prose ("route your 401 through the helper") rather than in a primitive a
 * call site cannot skip. Here the rule is applied by construction: a caller
 * asks for a request and is handed a VERDICT it did not compute.
 *
 * THE RULE, in one place:
 *   - A response is STALE when the request's context generation (identity +
 *     database mode + API base) is no longer current, or when the caller's own
 *     `isStale` predicate (a dialog session, a request id) says so. A stale
 *     response clears nothing and the caller must act on nothing.
 *   - ONLY a 401 means the session died. A 5xx, a 404, a validation error, a
 *     timeout and a network failure are all TRANSIENT: they leave the stored
 *     credential exactly as it was. ("A failed request is not an empty
 *     library" — CodeRabbit on #142 — generalised to the credential itself.)
 *   - A dead session clears the token only when the token THIS request used is
 *     still the committed one. A 401 for a token the app has already replaced
 *     (the user signed in again while the request was in flight) leaves the
 *     new session alone.
 *   - The body is read BEFORE the verdict is computed, because the context can
 *     move on during that second await (CodeRabbit CLI on #169's fix).
 *
 * `src/apiclient.contract.test.ts` fails the build if any request outside this
 * module attaches an Authorization header, or if a new `/api/` endpoint
 * appears that has not been classified as authenticated or not.
 */

import { DEFAULT_REPORT_FETCH_TIMEOUT_MS } from './fetchTimeout';

/**
 * The deadline every account request gets unless its caller names another.
 *
 * It is the CONSTANT, deliberately — not App.tsx's `REPORT_FETCH_TIMEOUT_MS`,
 * which CI's e2e bundle compiles down to 5 s (`VITE_E2E_FETCH_TIMEOUT_MS`) so
 * two report-stall tests need not each wait 22 real seconds. Before this
 * client, the games routes used a bare `fetch` with no bound at all, so that
 * knob could not reach them; routing them through `fetchWithTimeout` without
 * an explicit value would have handed every save, edit, delete and list in CI
 * a 5-second deadline on a loaded runner — a request that timed out while the
 * server had already written. The account client passes its own number every
 * time, so the report knob cannot reach it.
 */
export const ACCOUNT_REQUEST_TIMEOUT_MS = DEFAULT_REPORT_FETCH_TIMEOUT_MS;

/** What the caller must supply once, from the component that owns the state. */
export interface AccountApiDeps {
  /** Resolves a path against the server this context talks to. */
  getApiUrl: (path: string) => string;
  /** The token committed RIGHT NOW — a ref read, never a captured closure. */
  currentToken: () => string | null;
  /** The current request-context generation (identity + db mode + API base). */
  currentGen: () => number;
  /** Clears the stored session. Called only under the rule above. */
  clearSession: () => void;
  /** The app's bounded fetch (see App.tsx's `fetchWithTimeout` doc comment). */
  fetchWithTimeout: (
    url: string,
    init: RequestInit,
    controller: AbortController,
    timeoutMs?: number,
  ) => { promise: Promise<Response>; clear: () => void };
}

export interface AccountRequestInit {
  method?: string;
  /** Body to send as JSON; sets Content-Type. */
  json?: unknown;
  /**
   * The token to attach. Omit to use the CURRENT committed token. Pass an
   * explicit one only where the caller genuinely holds a different, newer
   * credential than the committed state (the local-games offer runs straight
   * after sign-in, before `authToken` has caught up); pass `null` to send no
   * Authorization header at all (the desktop's local owner).
   */
  token?: string | null;
  /** Abort after this many ms. Omit for ACCOUNT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * An ADDITIONAL staleness test for a caller that owns a narrower session
   * than the auth context — a dialog that was closed and reopened, a save
   * whose request id has been reminted. Evaluated after the body is read.
   */
  isStale?: () => boolean;
}

export interface AccountResponse {
  /** 'response' — the server answered. 'timeout' — our own deadline fired.
   *  'network' — the request never completed (offline, refused, reset). */
  kind: 'response' | 'timeout' | 'network';
  /** 0 when there was no response. */
  status: number;
  ok: boolean;
  /** The parsed JSON body, or `{}` when there was none / it was not JSON. */
  data: any;
  /** Whether `data` really came from the body. A caller that reads a field out
   *  of a SUCCESS response (`data.game`) must check this: before the client
   *  existed, an unparseable body threw into the caller's `catch` and was
   *  reported as a connection failure, and that is still the right story. */
  dataParsed: boolean;
  /** This response is no longer this context's business — act on nothing. */
  stale: boolean;
  /** The server refused this request as unauthenticated (401). TRUE whether or
   *  not a credential was attached: the sign-in gate and the "this library is
   *  not yours" reset are about what the SERVER refused, not about whose token
   *  it was. NEVER true for a 5xx, a timeout or a network failure. */
  unauthorized: boolean;
  /** The narrower claim: a credential was actually presented and refused, so
   *  the session behind it is dead. A request that attached nothing cannot
   *  prove the stored token died. Callers that clear, log or word a message
   *  about "your session" read THIS; callers that ask the user to sign in read
   *  `unauthorized`. NEVER true for a 5xx, a timeout or a network failure. */
  sessionDied: boolean;
  /** ...and the token it used was still the committed one, so it was cleared
   *  here. False when a newer session has since been committed. */
  sessionCleared: boolean;
  /** The token this request actually attached (null when it sent none). */
  requestToken: string | null;
  /** The rejection, for a 'network'/'timeout' kind. Never shown to the user
   *  raw: `describeRequestFailure` turns it into copy. */
  error: unknown;
}

export interface AccountApi {
  request: (path: string, init?: AccountRequestInit) => Promise<AccountResponse>;
}

/**
 * User-facing copy for a request that never produced a response. The browser's
 * own text ("Failed to fetch", "Load failed" — it differs per engine) is not
 * an explanation, and it used to reach the Danger Zone's error line verbatim
 * (STRUCT-DESKTOP-19/002). `subject` completes the sentence, e.g.
 * `describeRequestFailure(r, 'delete your account')`.
 */
export function describeRequestFailure(res: AccountResponse, subject: string): string {
  if (res.kind === 'timeout') return `The server did not answer in time. Could not ${subject}.`;
  return `Connection error. Could not ${subject}.`;
}

export function createAccountApi(deps: AccountApiDeps): AccountApi {
  const request = async (path: string, init: AccountRequestInit = {}): Promise<AccountResponse> => {
    const requestToken = 'token' in init ? (init.token ?? null) : deps.currentToken();
    const requestGen = deps.currentGen();
    const headers: Record<string, string> = {};
    if (requestToken) headers['Authorization'] = `Bearer ${requestToken}`;
    if (init.json !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const { promise, clear } = deps.fetchWithTimeout(
      deps.getApiUrl(path),
      {
        ...(init.method ? { method: init.method } : {}),
        headers,
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      },
      controller,
      init.timeoutMs ?? ACCOUNT_REQUEST_TIMEOUT_MS,
    );

    const base = { requestToken, unauthorized: false, sessionDied: false, sessionCleared: false } as const;
    try {
      const res = await promise;
      // The body is a SECOND await: read it first, then judge staleness, or a
      // context change during the read would be missed (CodeRabbit CLI on the
      // #169 fix). A non-JSON body is not an error here — the caller's own
      // branch decides what an empty `data` means.
      let dataParsed = true;
      const data = await res.json().catch(() => { dataParsed = false; return {}; });
      const stale = requestGen !== deps.currentGen() || (init.isStale?.() ?? false);
      if (stale) {
        return { ...base, kind: 'response', status: res.status, ok: res.ok, data, dataParsed, stale: true, error: null };
      }
      // ONLY a 401 is a dead session, and only for a token that is still the
      // committed one. Everything else leaves the credential untouched.
      // The two halves are reported separately because they answer different
      // questions. A 401 on a request that attached NO credential cannot prove
      // the stored one died (CodeRabbit CLI) — the desktop local owner lists
      // and writes games with no token at all — but it IS still the server
      // saying "not without an account", which is what raises the sign-in
      // gate. Collapsing them either clears a credential the server never saw
      // or leaves a signed-out user staring at a plain error with no way in.
      const unauthorized = res.status === 401;
      const sessionDied = unauthorized && requestToken !== null;
      const sessionCleared = sessionDied && deps.currentToken() === requestToken;
      if (sessionCleared) deps.clearSession();
      return { ...base, kind: 'response', status: res.status, ok: res.ok, data, dataParsed, stale: false, unauthorized, sessionDied, sessionCleared, error: null };
    } catch (error) {
      const kind = error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'network';
      // A request that never reached the server says NOTHING about the
      // session: the credential survives, and the caller learns only that the
      // attempt failed. This is the whole of STRUCT-DESKTOP-19/001.
      const stale = requestGen !== deps.currentGen() || (init.isStale?.() ?? false);
      return { ...base, kind, status: 0, ok: false, data: {}, dataParsed: false, stale, error };
    } finally {
      // The deadline must outlive the body read, so it is cleared only here —
      // see `fetchWithTimeout`'s own doc comment in App.tsx.
      clear();
    }
  };

  return { request };
}

export const DEFAULT_REPORT_FETCH_TIMEOUT_MS = 22_000;

/** Resolve the CI-only browser timeout without weakening App.tsx's rule that
 * every user-entered number goes through the shared game-input parsers. */
export function resolveReportFetchTimeoutMs(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return DEFAULT_REPORT_FETCH_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  return parsed >= 100 && parsed <= DEFAULT_REPORT_FETCH_TIMEOUT_MS
    ? parsed
    : DEFAULT_REPORT_FETCH_TIMEOUT_MS;
}

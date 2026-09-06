# Scenario request deadline

All rung-3 invention paths share one budget in `inventScreenedScenario`: ordinary
reports, tie reports, scenario-only requests, and regenerate previews. The budget
is the shipping browser timeout (22 seconds) minus a two-second allowance for
screening the existing bank fallback and delivering the response.

Every draw is limited by the smaller of its configured per-draw timeout and the
request's remaining budget. A fast failed draw can still be retried and a fast
rejected story can still be rerolled, subject to the existing attempt counts.
When the total budget expires, the existing screened bank fallback runs. No model
prose is rewritten. A model result that arrives after the deadline is discarded.

This replaces a per-attempt-only bound: the old server could wait 40 seconds for
two lost draws, or up to 80 seconds for mixed failure/rejection retries. The client
had already aborted at 22 seconds, making the eventual rescue unreachable.

## Evidence

`node src/integration/scenario-request-deadline.test.mjs` starts the production
bundle from empty directories, with explicit production model/flag settings and
loopback providers. It checks all four routes at the shipping timeout, a delayed
rejection followed by a stalled retry, and fast valid/rejected-then-valid controls.
It is part of both `npm run test:integration` and the required CI integration job.

The four stalled-route checks fail on `0d0311e` with client timeout errors; their
fast-response control passes. Replacing the shared deadline with infinity is the
mutation that restores the defect. Assertions inspect HTTP status, a real scenario
in the response, the bank-fallback source, and provider attempt counts.

### Testing this without waiting out the real budget (BLUE-CANCEL-12)

The 20-second budget above made the suite's own wall-clock cost ~20s per stalled
case, real waiting shared with whatever else is running on the CI runner at the
time (this suite failed 3 times in a row alongside 12 concurrent e2e smoke
shards, always passing on a rerun or run alone). `NASH_SCENARIO_REQUEST_BUDGET_MS`
overrides `SCENARIO_REQUEST_BUDGET_MS` for exactly this: the test spawns the
server with a 2-second budget instead of the real 20, and sizes its own client
abort as a PROPORTIONAL multiple of that (never a fixed millisecond count), so
the ratio — and so what a regression looks like — stays meaningful whatever the
configured budget is. Nothing in production sets this variable. See
`round12/notes/BLUE-CANCEL-12/HARNESS-LOG.md` for the reproduction attempt and
the mutation test (removing the override from the spawned env — equivalent to
the budget silently becoming the real ~20s production one again — fails 5 of 6
subtests; the fast control is unaffected).

## Cancellation

Being *bounded* by the budget above did not mean being *cancelled*: a draw that
lost its race against the deadline, or whose client disconnected mid-flight,
used to keep running in the background and could still make new physical
provider requests on its own. Three shapes of this were found (2026-09-05
transport probe against 3f699f4/v0.0.160), and reproduced independently
(`round12/notes/BLUE-CANCEL-12/repro-before-fix.log`):

- **429 storm**: the OpenAI-compatible SDK clients' own default retry
  (`maxRetries`, up to 3 physical attempts per shape) multiplied one logical
  draw into up to 6 physical requests for a single 429 — invisible to the
  ladder's own budget accounting, which only ever saw 2 logical draws.
- **Client gone, retry still fires**: when the client disconnected mid-draw,
  the ladder's own "one retry" policy did not check for that, so a second
  physical request could start seconds after nobody was listening.
- **Fallback delivered, retry still fires**: a draw abandoned to the deadline
  timer kept running for real; if the provider eventually answered with a
  retryable status, the SDK started another physical request on its own —
  observed ~1.4s after the bank fallback had already gone out to the client.

`ProviderRequest.signal` (providers.ts) now threads an `AbortSignal` through
every adapter (Gemini, Foundry-OpenAI, Foundry-Anthropic, OpenRouter): checked
before each physical attempt (including each schema-negotiation variant) and
passed to the underlying SDK call so an in-flight request is aborted rather
than abandoned. Every SDK client now sets `maxRetries: 0` (Gemini:
`httpOptions.retryOptions.attempts: 1`) — the ladder is the only retrier, so
its own physical-request count is now accurate. `inventScreenedScenario`
(server.ts) owns one `AbortController` per invocation, combined with a
`clientGoneSignal(res)` built from `res`'s `close` event (discriminated by
`res.writableEnded`, since that event also fires on ordinary completion): the
combined signal is threaded through every draw, the ladder refuses to start a
new one once the client is gone, and aborts whatever it is still waiting on
the instant it has an answer to give (success, bank fallback, or exhaustion).
`drawWithDeadline` additionally owns its OWN per-draw `AbortController`
(combined with the signal above), aborted in its own `finally` — so a draw
that loses its race against ITS OWN per-attempt deadline is cancelled the
instant that happens, not left running until the whole ladder's `finally`
(which only fires once every retry is exhausted): a retry could otherwise
start a second physical request while the previous, timed-out one was still
connected (CodeRabbit, PR #139).

### Evidence

`node src/integration/scenario-cancellation.test.mjs` runs the same
shipping-bundle/loopback-provider setup as the suite above, asserting the
PHYSICAL request count for: a client abort mid-flight (expect 1, not 2), a
late response arriving after the fallback was already sent (expect 1, not 2),
a retry that must not start while the previous draw is still connected
(a forced two-draw retry via a short `NASH_SCENARIO_TIMEOUT_MS`, asserting the
first draw's connection actually closes before the second's request arrives —
not just that nothing extra was counted), and a 429 storm (expect 2 — one per
logical draw — not 6), plus two fast controls that must keep working (a valid
draw, and a rejected-then-valid reroll). The two delayed cases additionally
record each provider connection's premature-close time (`res`'s `close` event,
gated on `!res.writableEnded` — a `req`-based check was tried first and found
to fire unconditionally on any ordinary request, a vacuous instrument) and
assert it precedes the provider's own delayed reply. It also asserts every
outgoing request body carries the pinned `REPORT_MODEL` and no
`reasoning_effort`. Reverting providers.ts/report.ts/server.ts to their
pre-fix state (939b3be^) fails exactly the three originally-named cancellation
checks while both controls stay green
(`round12/notes/BLUE-CANCEL-12/cancellation-mutation.log`); reverting only the
per-draw `AbortController` in `drawWithDeadline` fails exactly the
retry-overlap check, isolated from the rest
(`round12/notes/BLUE-CANCEL-12/HARNESS-LOG.md`). It is part of both
`npm run test:integration` and the CI integration job.

## Limits and follow-up

The two-second allowance is a response margin, not a guarantee against arbitrary
network delay or event-loop stalls. This suite establishes behavior under
transport failures, not model story quality or a measured frequency of slow
responses in production. Fresh cloud quality sampling must still use the
production model with no reasoning override.

**How often this path is actually reached, measured:** RED-CLOUD-11/002
(2026-09-05, main 3f699f4, real Azure Foundry calls, production model/no-
reasoning pins) pooled 105 direct `generateScenario()` draws and found 4
(3.8%) running 58-79s before failing on `max-tokens` — cleanly bimodal, with
every other draw finishing under 10s and none landing between 10 and 20s.
That is the population the cancellation work above protects: roughly 1 in
26 real scenario draws used to leave an upstream provider call running,
unobserved, for an extra 40-60+ seconds after this deadline fired and the
bank fallback had already reached the user — now aborted instead. The same
report separately measured 18 real draws through the actual deadline-wrapped
HTTP path (`/api/scenario/regenerate`) all completing in 3.5-7.1s, consistent
with the 20s deadline sitting comfortably inside the fast mode.

## Minimum remaining budget before a draw starts

No model draw starts with less than `MIN_DRAW_MS` (2 s, `inventScreenedScenario` in
`server.ts`) left on the request clock. A draw needs seconds; one started with a few
milliseconds left cannot succeed and only costs a physical provider request. This closes the
boundary race CI kept catching on #139 (first call stalls, budget expires at ~20 s, a second
call still starts at 20.54 s because the per-draw timer and the request clock disagree by a
few ms). The documented retry still happens whenever the remaining budget is real: the
integration tests' 6 s budgets leave ~4 s after their fractional rejection delay.

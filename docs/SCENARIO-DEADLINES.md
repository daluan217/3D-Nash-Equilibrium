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

## Limits and follow-up

The two-second allowance is a response margin, not a guarantee against arbitrary
network delay or event-loop stalls. SDK requests are still abandoned rather than
cancelled; propagating cancellation through every provider adapter is separate
work. This suite establishes behavior under transport failures, not model story
quality or a measured frequency of slow responses in production. Fresh cloud
quality sampling must still use the production model with no reasoning override.

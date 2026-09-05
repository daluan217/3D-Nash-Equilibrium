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

## Limits and follow-up

The two-second allowance is a response margin, not a guarantee against arbitrary
network delay or event-loop stalls. SDK requests are still abandoned rather than
cancelled; propagating cancellation through every provider adapter is separate
work. This suite establishes behavior under transport failures, not model story
quality or a measured frequency of slow responses in production. Fresh cloud
quality sampling must still use the production model with no reasoning override.

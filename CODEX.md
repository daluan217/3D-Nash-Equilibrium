# CODEX.md

Session notes for Codex work in this repository.

## Session: 2026-06-18

### Repository Context Learned

- Project: React 19 + Vite + Express + Plotly + KaTeX app for visualizing mixed Nash equilibria of 2x2 games on 3D expected-payoff surfaces.
- The repo also packages an Electron desktop app.
- The code supports a research paper submitted to the American Mathematical Monthly.
- Branch model:
  - `main` is the de-anonymized public/product branch. It uses the real name "Nash Equilibrium Simulator", real domain, analytics/product wiring, and author-facing operational details.
  - `review-mirror` is the anonymized AMM review branch. Reviewers only receive the Netlify URL, not the source repo. Keep the web app anonymized as "Mixed Nash Equilibrium Visualizer" and avoid real names, domains, analytics, or author contact info in the reviewer-facing app.
- Node version note:
  - Use Node 22 for local builds/dev.
  - Vite is known to hang under Node 26.
  - `npm run build` and `npm run lint` worked under Node 22.
- Existing untracked files before this session:
  - `_pw-verify 2.mjs`
  - `_pw-verify 3.mjs`

### User Clarifications

- The Search Game from the paper is already the default loaded game in the anonymized build, but it was not visible as a preset button.
- Search Game description:
  - Searcher chooses Left/Right.
  - Hider chooses Left/Right.
  - Searcher gets 2 for finding the hider at the left door, 1 at the right door.
  - Hider payoffs are exact negatives, so the game is zero-sum.
  - Neither player has a dominant strategy.
  - Unique mixed Nash equilibrium is `(x*, y*) = (1/3, 1/3)`.
  - The paper wants readers to notice the flat spot in both expected-payoff surfaces at `(1/3, 1/3)`.
- Decision made: keep Spy vs. Analyst. Do not replace it. Add/surface Search Game as its own standard scenario.

### Review Feedback Given

- Strengths:
  - The visual/mathematical core is strong.
  - The app feels like a real mathematical instrument rather than a toy.
  - Solver, Plotly separation, and recent bisection/shrinkage logic are thoughtful.
  - The manuscript framing around "joint flat spot" is memorable and aligns well with the app.
- Highest-priority concerns identified:
  1. Hosted auth was not production-safe: passwords were stored as base64 and user IDs were returned as bearer tokens.
  2. Custom saved game descriptions could create stored XSS because user-provided name/description were interpolated into HTML and rendered with `dangerouslySetInnerHTML`.
  3. The convergence algorithm needed real regression tests, not only a one-off diagnostic.
  4. Reviewer-facing/paper UX should make the Search Game first-class and easy to return to.
  5. Manuscript/app alignment should be tight, especially around the Search Game example.
- Paper notes:
  - Be careful that the general mixed-equilibrium formula for `x*` uses Player B's payoff coefficients unless explicitly scoped to a zero-sum/symmetric example.
  - Phrase "self-interest cannot find it" as myopic pure best-response chasing, since some learning/regret dynamics can converge under assumptions.

### Main Branch Changes Made

Files modified on `main`:

- `server.ts`
  - Added `crypto`-backed security helpers.
  - Passwords now use PBKDF2 with 210,000 iterations and per-password random salts.
  - Legacy base64 password records are still accepted and are migrated to PBKDF2 on successful login.
  - Auth tokens are now signed, expiring bearer tokens rather than raw user IDs.
  - Added `AUTH_SECRET` / `SESSION_SECRET` support.
  - If no auth secret is configured, a random secret is generated and a warning is logged. This invalidates sessions on server restart.
  - Verification, recovery, deletion codes, user IDs, and game IDs now use crypto-backed randomness.
  - Web API no longer returns recovery/delete confirmation codes. Local Electron mode can still show local codes for offline use.
  - Added simple in-memory rate limiting for admin, feedback, register, verify, login, forgot-password, reset-password, delete-request, and delete-confirm endpoints.
  - Added server-side text cleanup and payoff validation/clamping for saved custom games.
  - Saved game IDs now use crypto UUIDs.
- `src/App.tsx`
  - Custom game descriptions now render as React text instead of being interpolated into HTML.
  - Built-in preset descriptions still render trusted preset HTML.
  - Added `Search Game` to the visible standard-scenarios row on `main`.
- `src/utils/gameEngine.ts`
  - Added `search` preset:
    - `a11=2, b11=-2`
    - `a12=0, b12=0`
    - `a21=0, b21=0`
    - `a22=1, b22=-1`
    - row labels: Search L, Search R
    - column labels: Hide L, Hide R
    - description calls out the mixed NE `(1/3, 1/3)`.
- `src/components/MenuDrawer.tsx`
  - Updated help text to mention Search Game among mixed-NE examples.
- `src/test.ts`
  - Replaced the old verbose one-off ghost-corridor diagnostic with a regression suite.
  - Coverage added for:
    - canonical solver results,
    - Search Game mixed NE,
    - zero-sum search variants,
    - shrink-mode convergence,
    - regret-mode convergence,
    - pure-NE convergence for Battle of the Sexes and Prisoners Dilemma,
    - ghost-corridor no-diagonal invariant,
    - ghost corridor visiting four endpoints before cycling.
- `package.json`
  - Added `npm test` script: `tsx src/test.ts`.
- `AGENTS.md`
  - Appended a 2026-06-18 session-history entry summarizing the changes and verification.
- `CLAUDE.md`
  - Also updated locally with the same session-history entry, but note: `CLAUDE.md` is not tracked by Git in this repo.

### Review-Mirror Branch Change

- A separate worktree was created at:
  - `/private/tmp/3D-Nash-Equilibrium-review`
- Branch checked out there:
  - `review-mirror`
- Change made there:
  - `src/App.tsx`: the existing `search` preset is now visible in the standard-scenarios row.
  - Changed the row from `['bos', 'pd', 'cnr', 'spy']` to `['search', 'bos', 'pd', 'cnr', 'spy']`.
  - Changed grid layout from `sm:grid-cols-4` to `sm:grid-cols-3`.
- This branch already had anonymized behavior such as:
  - default `activePreset` set to `search`,
  - anonymized title/name in frontend,
  - account/feedback/admin gates hidden behind `ANONYMIZED`.
- No de-anonymized strings were intentionally copied into the reviewer-facing app.

### Verification Performed

On `main`:

- `npm run lint`
  - Passed.
- `npm test`
  - First sandboxed run failed because `tsx` could not open its local IPC pipe under sandbox restrictions.
  - Reran with local test escalation.
  - Passed: "All game-engine regression tests passed."
- `npm run build`
  - Passed under Node 22.
  - Vite still reports the known large Plotly chunk warning.
- Browser smoke test:
  - Served `dist/server.cjs` with `PORT=3001 NODE_ENV=production`.
  - Needed escalation because local server binding is sandbox-blocked.
  - Page loaded at `http://127.0.0.1:3001`.
  - Search Game button was visible and clickable.
  - No console errors.
  - One known Plotly canvas performance warning was present.

### Operational Notes

- Set `AUTH_SECRET` or `SESSION_SECRET` in production.
  - Without it, sessions are intentionally invalidated whenever the server restarts.
  - Existing raw user-id bearer tokens from older builds will no longer be valid.
  - Existing base64 password records will migrate on successful login.
- The simple in-memory rate limiter is a helpful baseline but not a substitute for Cloud Run/edge rate limiting if the app receives public traffic.
- The JSON database and GCS persistence model still remain lightweight. Concurrent writes can still be a future operational concern.
- `review-mirror` source still contains some de-anonymized strings in non-reviewer-facing files such as README/server/electron configuration, based on previous audit. This is acceptable only under the stated threat model: reviewers see the Netlify app, not the source repo.

### Current Git State After Session

On `main`, tracked modified files:

- `AGENTS.md`
- `package.json`
- `server.ts`
- `src/App.tsx`
- `src/components/MenuDrawer.tsx`
- `src/test.ts`
- `src/utils/gameEngine.ts`

Untracked files still present from before this work:

- `_pw-verify 2.mjs`
- `_pw-verify 3.mjs`

On `/private/tmp/3D-Nash-Equilibrium-review` (`review-mirror` worktree):

- Modified:
  - `src/App.tsx`

### Suggested Follow-Ups

- Commit `main` changes separately from `review-mirror` changes.
- Add `AUTH_SECRET` or `SESSION_SECRET` to production environment configuration.
- Consider adding Cloud Run or reverse-proxy rate limits for auth endpoints.
- Consider a more robust persistence layer if public accounts/saved games matter long-term.
- Consider a paper/reviewer mode that makes the plot and Search Game even more immediate on mobile, if reviewer experience becomes a priority.

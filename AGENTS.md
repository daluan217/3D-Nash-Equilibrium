# AGENTS.md

Guidance for Codex when working in this repository.

## Project overview

3D visualizer for **Mixed Nash Equilibria** of 2×2 games — interactive expected-payoff
surfaces and best-response dynamics. React 19 + Vite frontend, Express backend
(`server.ts`), Plotly for the 3D plot, KaTeX for math. Also packaged as an Electron
desktop app.

This repo backs a **research paper** on 3D modeling of Nash equilibria, submitted to the
**American Mathematical Monthly (AMM)**.

## Branch model (important — anonymization)

- **`review-mirror`** — the *anonymized* branch for the AMM peer review (double-blind).
  App name is "Mixed Nash Equilibrium Visualizer"; the real name/domain/analytics/author
  email are scrubbed. Reviewers only get the anonymized **Netlify URL** (the live web app),
  not the source repo. **Keep this branch anonymized** — never introduce the real app name,
  author identity, or de-anonymized links.
- **`main`** — the de-anonymized, public-use version (real name "Nash Equilibrium Simulator",
  domain nash-equilibrium-simulator.com, analytics, author email).

## Running locally

⚠️ **Vite is broken under Node v26** (the default `node` here): both `npm run dev` and
`npm run build` hang (dev never binds to port 3001; build stalls at 0% CPU mid-transform).
Use **Node 22** for builds/dev:

```bash
# Node 22 installed via Homebrew (keg-only):
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm run build      # vite build + esbuild server bundle -> dist/
NODE_ENV=production npm run start   # serve prebuilt dist/ on http://localhost:3001
# or
npm run dev        # dev server (vite middleware) on http://localhost:3001
```

Server port is `PORT` in `.env` (3001). `.env` is gitignored.

## Key files

- `src/App.tsx` — main UI (panels, controls, simulation log, report). Light/dark via
  the `dark` class on `<html>`; theme persisted in `localStorage` `nash_sim_theme`.
- `src/components/PlotlyView.tsx` — 3D plot; background is theme-aware via an `isDark` prop.
- `src/utils/plotting.ts` — plot trace/layout construction.
- `server.ts` — Express API (auth, games, feedback email, DMG download) + Vite middleware.

## Conventions

- Tailwind for styling; light-mode classes should always pair with `dark:` variants
  (don't leave panels dark "by omission" in light mode).
- Player color semantics: Player A = rose, Player B = blue/`player-b`.

## Session history

> Newest first. Append a dated entry each session; keep entries short.

### 2026-06-17
- Drove the app via Playwright (production build on :3001, since Vite dev hangs on Node 26).
  Verified the simulation: Battle of the Sexes converges to a **pure NE**; Spy vs. Analyst
  converges to the **mixed NE** (x*=0.667, y*=0.333) — recent cycling→bisection logic works.
  No console errors.
- **Anonymization audit** of `review-mirror` (threat model = reviewers see only the Netlify
  URL): frontend is clean (no real name/email/domain/GA); web API calls are same-origin
  relative paths so no real domain leaks in network traffic. Residual real name/domain remain
  in README/server.ts/electron/config (only matters if the repo itself is shared). Watch-item:
  backend emails are still branded "Nash Equilibrium Simulator" via `SMTP_FROM`.
- **Light-mode consistency fix** in `src/App.tsx`: made the *Expected-Payoff Functions* panel
  and the *Simulation Log* panel light-adaptive (`bg-white dark:bg-slate-900`, light borders,
  per-line log colors given light/dark variants). The 3D plot's "black background" was not a
  bug — it was a stuck `nash_sim_theme: dark`; in real light mode the plot is white.
- **Resolved the Vite hang**: it's a Node 26 incompatibility. Installed **Node 22** via
  Homebrew (`/opt/homebrew/opt/node@22/bin`); `npm run build` then succeeds (~1 min) and
  `NODE_ENV=production node --experimental-strip-types server.ts` serves the fresh `dist/` on
  :3001. (Note: the `esbuild server.ts` step in `npm run build` needs `esbuild` on PATH; for
  local verification just run `server.ts` directly in production mode — no `server.cjs` needed.)
- **Verified the light-mode fix against the real build** (not a CSS injection): in light mode
  the EP panel and Log panel are white (`rgb(255,255,255)`), the log console is slate-50, and
  per-line log colors render as readable `-600` variants (indigo/rose/blue). Dark mode still
  shows slate-900 panels (no regression). Simulation converges; no console errors.

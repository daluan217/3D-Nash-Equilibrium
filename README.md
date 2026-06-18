# Nash Equilibrium Simulator

> Interactive 3D visualizer for the Nash equilibria of two-player games.

See the strategic structure of a 2×2 game at a glance. Rotate and zoom the
expected-payoff surfaces, watch best-response dynamics converge step by step, and
read off the pure and mixed-strategy Nash equilibria as they're computed in real time.
Built as a full-stack web app, with an Electron desktop build for offline use.

**▶ Live site:** [nash-equilibrium-simulator.com](https://nash-equilibrium-simulator.com)

---

## Features

- **Interactive 3D surfaces** — rotate, pan, and pinch-to-zoom the expected-payoff landscape (Plotly.js)
- **Best-response dynamics** — step through or loop an animation of strategy convergence
- **Nash equilibrium solver** — computes every pure and mixed NE analytically, in real time
- **AI game-theorist report** — natural-language analysis of each game's strategic situation
- **Accounts & saved games** — email-verified sign-in with cloud-synced custom presets
- **Desktop app** — Electron build with an embedded Express server for fully offline use

---

## Tech Stack

### Frontend
| Technology | Purpose |
|---|---|
| React 19 | UI framework |
| TypeScript | Type safety |
| Tailwind CSS v4 | Styling |
| Vite | Build tool and dev server |
| Plotly.js | 3D surface and scatter visualisation |
| Lucide React | Icons |
| Motion | Animations |

### Backend
| Technology | Purpose |
|---|---|
| Node.js + Express | REST API server |
| Google Cloud Storage | Persistent JSON database (Cloud Run) |
| Nodemailer | Email verification and account deletion codes |
| Google Gemini API | AI game theorist situation reports |
| HMAC-signed tokens | Stateless bearer-token auth (PBKDF2 password hashing) |

### Desktop (Electron)
| Technology | Purpose |
|---|---|
| Electron 31 | macOS desktop app wrapper |
| electron-builder | DMG and ZIP packaging |
| Embedded Express | Local server running inside the app |

### Infrastructure
| Technology | Purpose |
|---|---|
| Google Cloud Run | Serverless container hosting |
| Google Cloud Build | CI/CD — auto-deploys on push to `main` |
| Google Container Registry | Docker image storage |
| Google Cloud Storage | Database persistence + DMG hosting |
| Docker | Container image for Cloud Run |
| Namecheap DNS | Custom domain routing |
| Google Analytics 4 | Traffic and session analytics |

---

## Project Structure

```
├── src/
│   ├── App.tsx                  # Root component — layout, auth, simulation state
│   ├── main.tsx                 # React entry point
│   ├── index.css                # Global styles
│   ├── types.ts                 # Shared TypeScript interfaces
│   ├── test.ts                  # Game-engine regression tests (npm test)
│   ├── components/
│   │   ├── PlotlyView.tsx       # 3D Plotly chart with rotate/pan/pinch controls
│   │   ├── MenuDrawer.tsx       # Slide-out workspace centre panel
│   │   ├── DownloadModal.tsx    # Desktop app download modal
│   │   ├── AdminDashboard.tsx   # Admin stats panel (password protected)
│   │   └── GameGraphMiniature.tsx # Small graph preview thumbnail
│   └── utils/
│       ├── gameEngine.ts        # Nash Equilibrium solver + simulation step logic
│       └── plotting.ts          # Plotly trace builders for surfaces and markers
│
├── server.ts                    # Express server — API routes, auth, GCS DB, email
├── electron-main.cjs            # Electron main process — window creation, IPC
├── index.html                   # HTML template (Vite entry + GA4 tag)
├── vite.config.ts               # Vite configuration
├── tsconfig.json                # TypeScript configuration
├── Dockerfile                   # Multi-stage Docker build for Cloud Run
├── cloudbuild.yaml              # Cloud Build CI/CD pipeline
├── scripts/
│   └── afterPack.cjs            # electron-builder hook (post-pack placeholder)
└── build/
    ├── icon.svg                 # App icon source (3D isometric cube design)
    ├── icon.png                 # Rendered icon PNG
    └── icon.icns                # macOS icon bundle
```

---

## Database

The app uses a simple JSON file as its database (`db.json`), with two collections:

- **`users`** — id, username, email, passwordHash, isVerified, verificationCode
- **`games`** — id, userId, name, description, payoffs, createdAt

**In Cloud Run:** loaded from and saved to Google Cloud Storage on every write.  
**In Electron / dev:** read from and written to the local filesystem.

---

## API Routes

All routes are rate-limited. Routes that read or write user data require a bearer token.

| Method | Route | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/version` | Latest desktop app version (for update prompts) |
| GET | `/api/admin/stats` | Admin stats (requires `x-admin-secret` header) |
| GET | `/api/download/dmg` | Streams DMG from GCS or local `dist-electron/` |
| POST | `/api/feedback` | Send anonymous or attributed user feedback |
| POST | `/api/auth/register` | Register + send email verification code |
| POST | `/api/auth/verify` | Verify email with 6-digit code |
| POST | `/api/auth/login` | Log in, returns a signed bearer token |
| GET | `/api/auth/me` | Get the current user from a token |
| POST | `/api/auth/forgot-password` | Send a password-recovery code by email |
| POST | `/api/auth/reset-password` | Reset the password with a recovery code |
| POST | `/api/auth/delete-request` | Send account-deletion confirmation email |
| POST | `/api/auth/delete-confirm` | Confirm and delete the account |
| GET | `/api/games` | List saved games for the authenticated user |
| POST | `/api/games` | Save a new game preset |
| DELETE | `/api/games/:id` | Delete a saved game |

---

## Running Locally

**Prerequisites:** Node.js 20+

```bash
npm install
npm run dev          # starts Express server with hot-reload (website mode)
npm run electron:start  # builds and launches the Electron desktop app
```

Copy `.env.example` to `.env` and fill in:

```
GEMINI_API_KEY=your-key
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
ADMIN_SECRET=your-admin-password
AUTH_SECRET=generate-with-openssl-rand-hex-32
```

> **`AUTH_SECRET` (required in production):** HMAC key used to sign auth
> session bearer tokens. If unset, the server generates a random key at boot,
> so every restart/redeploy invalidates all existing sessions (users get logged
> out). Set a long, stable, random value (`openssl rand -hex 32`). `SESSION_SECRET`
> is accepted as an alias. In Cloud Run it's wired via the `_AUTH_SECRET`
> Cloud Build substitution.

---

## Building the Desktop App

```bash
npm run electron:dist
```

Output: `dist-electron/Nash Equilibrium Simulator-0.0.0-arm64.dmg`

**macOS Gatekeeper note:** because the app is not notarized, macOS will block it on first launch. Remove the quarantine flag after installing:

```bash
xattr -dr com.apple.quarantine "/Applications/Nash Equilibrium Simulator.app"
```

---

## Deployment

Every push to `main` triggers Cloud Build automatically:

1. Builds the Docker image (Vite frontend + esbuild server bundle)
2. Pushes to Google Container Registry
3. Deploys to Cloud Run at [nash-equilibrium-simulator.com](https://nash-equilibrium-simulator.com)

Environment variables are passed via Cloud Build substitutions defined in `cloudbuild.yaml`.

---

## How the Electron App Works

The Electron app bundles the full Express server inside the `.app` package:

1. `electron-main.cjs` sets `ELECTRON_USER_DATA_PATH` and boots `dist/server.cjs`
2. Express starts on port 14321 and calls `global.onExpressListening`
3. Electron creates a `BrowserWindow` and loads `http://127.0.0.1:14321`
4. The React frontend detects `Electron` in the user agent and adjusts the UI

The database discriminator (`ELECTRON_USER_DATA_PATH`) tells the server to use local file storage instead of GCS.

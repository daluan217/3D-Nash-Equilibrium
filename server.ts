/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

// First imports from src/ into the server. esbuild bundles these relative
// modules into dist/server.cjs; only npm packages stay external. Sharing one
// solver between client, server, and eval is the point — a second copy here
// would let them drift and quietly invalidate every consistency number.
// Extensionless, matching the rest of src/ (a Vite convention the whole client
// tree relies on). That means the dev runtime must resolve like the bundlers do:
// `npm run dev` uses tsx, NOT node --experimental-strip-types, whose native ESM
// resolver requires explicit extensions and throws ERR_MODULE_NOT_FOUND on the
// first src/ import. esbuild (production) and vite (client) both resolve these.
import { computeAllNE, computeIndifference } from "./src/utils/gameEngine";
import { tieProse, tieProseFull } from "./src/utils/tieProse";
import { validateReport, validateScenario, validateProseClaims, validateProseDirections, scenarioIsClaimFree } from "./src/utils/nashValidator";
import { generateReport, generateScenario, hasCredentials, scenarioIsUsable, DEFAULT_MODEL, LOCAL_SYSTEM_PROMPT, type Scenario } from "./src/utils/report";
import type { ReasoningEffort } from "./src/utils/providers";

// Production reasoning effort for the explainer. UNSET (provider default)
// since the materialized best-reply table landed: the 2026-08-27 follow-up
// A/B measured zero-effort+table at 7/8 on the baseline families in 7.0s —
// identical fidelity to 'low' without the table (7/8, 10.3s) — and
// low+table added latency (10.7s) with no measurable gain, because the
// table replaces exactly the derivations the thinking was doing. The env
// override remains the escape hatch if fidelity ever regresses. Set here
// at the ROUTE, not inside generateReport, so the eval harness keeps
// measuring the model's unmodified default unless a sweep opts in.
const REPORT_REASONING: ReasoningEffort | undefined =
  (process.env.REPORT_REASONING as ReasoningEffort) || undefined;
// REPORT_LOCAL_PROMPT=1 serves the fine-tuned local explainer: it was trained
// with the compact LOCAL_SYSTEM_PROMPT (the rulebook is in its weights) and
// only on the full-report task, so the scenario-only fast path is served by
// an invention-mode report instead of the separate scenario prompt.
const LOCAL_PROMPT = process.env.REPORT_LOCAL_PROMPT === '1' ? LOCAL_SYSTEM_PROMPT : undefined;

// Validated-report cache. The same eight numbers always have the same
// equilibria, and only envelopes that passed EVERY gate are stored — so a
// hit serves certified content instantly and for free. The six standard
// presets are the common case (identical matrix + scenario on every visitor).
// Explicit Regenerate clicks send bypassCache so the button still rolls a
// fresh report (the cache is then overwritten with the new validated one);
// scenario-only invention requests never touch the cache — freshness is
// their point. In-memory on purpose: it dies with the process, which caps
// staleness at one deploy cycle.
const reportCache = new Map<string, object>();
const REPORT_CACHE_MAX = 200;
const reportCacheKey = (p: { a11: number; a12: number; a21: number; a22: number; b11: number; b12: number; b21: number; b22: number }, sc?: Scenario) =>
  JSON.stringify([p.a11, p.a12, p.a21, p.a22, p.b11, p.b12, p.b21, p.b22,
    sc ? [sc.name, sc.row1, sc.row2, sc.col1, sc.col2, sc.description] : null]);
import type { ReportEnvelope, SuggestedScenario } from "./src/types";
import { cleanUserColorTermPair } from "./src/utils/colorTerms";
import { pickScenarioDomain } from "./src/utils/scenarioDomains";

// Load environment variables from .env file
dotenv.config();

interface GamePayoffs {
  a11: number; a12: number; a21: number; a22: number;
  b11: number; b12: number; b21: number; b22: number;
}

interface SavedGame {
  id: string;
  userId: string;
  name: string;
  description: string;
  payoffs: GamePayoffs;
  createdAt: string;
  /**
   * What this game's four options are actually called.
   *
   * Presets have carried these since the beginning (`row1Label` and friends in
   * PRESETS); saved games could not, so a custom game had no way to say that
   * Row 1 means "Undercut" and Col 2 means "Hold price". The explainer decides
   * whether to reuse a scenario or invent a fresh one by asking whether four
   * labels are present, so a game that cannot store labels was condemned to a
   * new invented story on every single explanation.
   */
  row1Label?: string;
  row2Label?: string;
  col1Label?: string;
  col2Label?: string;
  /**
   * Phrases the USER chose to have colored as player A / player B in their own
   * description. Stored as phrases rather than character ranges because the
   * description is plain text that can be edited afterwards — offsets would
   * slide onto the wrong words, a phrase does not.
   *
   * These decorate the user's description and nothing else. They are NEVER put
   * into a model prompt and never applied to model-written prose: the labels
   * above are the fields the explainer reads, and these are deliberately not
   * among them. src/unit.test.ts asserts that separation.
   */
  colorTermsA?: string[];
  colorTermsB?: string[];
}

interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string; // stored simply for sandbox safety (base64 or direct)
  isVerified: boolean;
  verificationCode: string;
  verificationCodeExpires: number;
  verificationCodeAttempts?: number;
  deleteCode?: string;
  deleteCodeExpires?: number;
  deleteCodeAttempts?: number;
  recoveryCode?: string;
  recoveryCodeExpires?: number;
  recoveryCodeAttempts?: number;
  tokenVersion?: number;
}

interface DB {
  users: User[];
  games: SavedGame[];
}

const PASSWORD_ITERATIONS = 210_000;
const AUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_SECRET = process.env.AUTH_SECRET
  || process.env.SESSION_SECRET
  || process.env.ADMIN_SECRET
  || crypto.randomBytes(32).toString("hex");

if (process.env.NODE_ENV === "production" && !process.env.AUTH_SECRET && !process.env.SESSION_SECRET && !process.env.ADMIN_SECRET) {
  console.warn("AUTH_SECRET/SESSION_SECRET is not configured; auth sessions will be invalidated on server restart.");
}

const GCS_BUCKET = process.env.GCS_BUCKET_NAME;
const DB_FILE = process.env.ELECTRON_USER_DATA_PATH
  ? path.join(process.env.ELECTRON_USER_DATA_PATH, "db.json")
  : path.join(process.cwd(), "db.json");

let inMemoryDb: DB | null = null;

function loadDBFromFile(): DB {
  try {
    const dbDir = path.dirname(DB_FILE);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  } catch (err) {
    console.error("Error creating database directory:", err);
  }
  if (!fs.existsSync(DB_FILE)) {
    const fresh: DB = { users: [], games: [] };
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2), "utf-8");
    } catch (err) {
      console.error("Error creating fresh db.json:", err);
    }
    return fresh;
  }
  try {
    const data = fs.readFileSync(DB_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    console.error("Error reading db.json, resetting database:", err);
    return { users: [], games: [] };
  }
}

// Load DB once at startup: GCS in Cloud Run, local file in Electron/dev
async function initDB(): Promise<void> {
  if (process.env.ELECTRON_USER_DATA_PATH) {
    inMemoryDb = loadDBFromFile();
  } else if (GCS_BUCKET) {
    try {
      const { Storage } = await import('@google-cloud/storage');
      const storage = new Storage();
      const file = storage.bucket(GCS_BUCKET).file('db.json');
      const [exists] = await file.exists();
      if (exists) {
        const [content] = await file.download();
        inMemoryDb = JSON.parse(content.toString('utf-8'));
      } else {
        inMemoryDb = { users: [], games: [] };
      }
      console.log(`DB loaded from GCS bucket "${GCS_BUCKET}": ${inMemoryDb!.users.length} users, ${inMemoryDb!.games.length} games`);
    } catch (err) {
      console.error('Error loading DB from GCS, falling back to local file:', err);
      inMemoryDb = loadDBFromFile();
    }
  } else {
    inMemoryDb = loadDBFromFile();
  }
}

// Returns the in-memory DB (always synchronous after initDB resolves)
function loadDB(): DB {
  return inMemoryDb ?? { users: [], games: [] };
}

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf-8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function makeCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

// How many wrong guesses a one-time code tolerates before it's invalidated.
const MAX_CODE_ATTEMPTS = 5;

const CODE_FIELDS = {
  verification: { code: "verificationCode", expires: "verificationCodeExpires", attempts: "verificationCodeAttempts" },
  recovery: { code: "recoveryCode", expires: "recoveryCodeExpires", attempts: "recoveryCodeAttempts" },
  delete: { code: "deleteCode", expires: "deleteCodeExpires", attempts: "deleteCodeAttempts" },
} as const;

// Constant-time, attempt-limited check of a one-time 6-digit code. Increments a
// per-code failure counter and invalidates the code after MAX_CODE_ATTEMPTS
// wrong guesses, so the 10-minute TTL can't be brute-forced across the 1e6
// space (the per-IP rate limit alone is bypassable via IP rotation). Mutates
// `user`; the caller must persist with saveDB(). `locked` means this attempt
// tripped the limit and the code is now cleared.
function verifyOneTimeCode(user: User, kind: keyof typeof CODE_FIELDS, submitted: string): { ok: boolean; locked: boolean } {
  const f = CODE_FIELDS[kind];
  const u = user as unknown as Record<string, unknown>;
  const stored = u[f.code];
  if (typeof stored !== "string" || stored.length === 0) {
    return { ok: false, locked: false };
  }
  if (safeEqual(stored, submitted)) {
    u[f.attempts] = undefined;
    return { ok: true, locked: false };
  }
  const attempts = ((u[f.attempts] as number) ?? 0) + 1;
  if (attempts >= MAX_CODE_ATTEMPTS) {
    u[f.code] = kind === "verification" ? "" : undefined;
    u[f.expires] = kind === "verification" ? 0 : undefined;
    u[f.attempts] = undefined;
    return { ok: false, locked: true };
  }
  u[f.attempts] = attempts;
  return { ok: false, locked: false };
}

function makeId(prefix: "u" | "g"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
  return `pbkdf2$${PASSWORD_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith("pbkdf2$")) {
    const [, iterRaw, saltRaw, hashRaw] = stored.split("$");
    const iterations = Number(iterRaw);
    if (!iterations || !saltRaw || !hashRaw) return false;
    const salt = Buffer.from(saltRaw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const actual = b64url(crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256"));
    return safeEqual(actual, hashRaw);
  }

  // Legacy migration path for older local/cloud accounts.
  return safeEqual(Buffer.from(password).toString("base64"), stored);
}

function needsPasswordRehash(stored: string): boolean {
  return !stored.startsWith("pbkdf2$");
}

// Precomputed hash for a random password. Used to spend the same pbkdf2 work on
// a login miss as on a hit, so response timing doesn't reveal whether an
// account exists (user enumeration).
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

// Escape user-controlled text before interpolating it into HTML (email bodies).
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createAuthToken(user: User): string {
  const payload = b64url(JSON.stringify({
    sub: user.id,
    ver: user.tokenVersion ?? 0,
    exp: Date.now() + AUTH_TOKEN_TTL_MS,
    nonce: b64url(crypto.randomBytes(12)),
  }));
  const sig = b64url(crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

function readAuthToken(token: string): { sub: string; ver: number } | null {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra) return null;
  const expected = b64url(crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest());
  if (!safeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
    if (!parsed.sub || typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return { sub: parsed.sub, ver: typeof parsed.ver === "number" ? parsed.ver : 0 };
  } catch {
    return null;
  }
}

function getAuthUser(req: express.Request): User | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  const claims = readAuthToken(token);
  if (!claims) return null;
  const user = loadDB().users.find(u => u.id === claims.sub) ?? null;
  // Reject tokens minted before the user's current token version (e.g. issued
  // before a password reset), so a stolen token can't outlive the reset.
  if (!user || (user.tokenVersion ?? 0) !== claims.ver) return null;
  return user;
}

/**
 * The desktop's local owner — the reason the offline app no longer asks you to
 * invent a password to save a file to your own disk.
 *
 * On the hosted service an account is what separates one visitor's games from
 * another's. On the desktop there is no other visitor: the database is
 * `db.json` inside this OS user's own data directory, and the "tenant" is the
 * person at the keyboard, who already owns the file. Requiring registration
 * and e-mail verification there was a hosted constraint imposed where it means
 * nothing — the same mistake as rate-limiting a user against a server they do
 * not share.
 *
 * SCOPED TO THE GAME ROUTES ON PURPOSE. `getAuthUser` is also what guards
 * account DELETION, and a fallback identity there would let anyone at the
 * keyboard start a deletion flow against a real account. Those routes keep the
 * strict check; only the routes that read and write this machine's own saved
 * games use the owner below. That distinction is the whole safety argument, so
 * it is asserted in the tests rather than left to the reader.
 */
const LOCAL_OWNER_ID = 'local-owner';

function isDesktop(): boolean {
  return process.env.IS_ELECTRON === 'true';
}

/** Provision the local owner on first use. Never on the hosted service. */
function ensureLocalOwner(): User | null {
  if (!isDesktop()) return null;
  const db = loadDB();
  const existing = db.users.find((u) => u.id === LOCAL_OWNER_ID);
  if (existing) return existing;
  const owner = {
    id: LOCAL_OWNER_ID,
    username: 'This device',
    // A reserved, unroutable address: the local owner has no e-mail, and a
    // blank one would collide with any other record missing the field.
    email: 'local-owner@localhost.invalid',
    passwordHash: '',
    verified: true,
    tokenVersion: 0,
    createdAt: new Date().toISOString(),
  } as unknown as User;
  db.users.push(owner);
  saveDB(db);
  return owner;
}

/**
 * Who owns the saved games for this request: the signed-in user if there is
 * one, otherwise — on the desktop only — the local owner.
 */
function getGameOwner(req: express.Request): User | null {
  return getAuthUser(req) ?? ensureLocalOwner();
}

/**
 * Sign-in ADOPTS whatever was saved locally.
 *
 * Daniel's call: a local owner who later signs in takes their games with them,
 * exactly as a signed-in user's games already follow them. Without this, using
 * the app before making an account would silently strand that work behind an
 * identity the user can no longer reach.
 *
 * Re-parenting rather than copying, so signing in twice cannot duplicate a
 * library.
 */
function adoptLocalGames(userId: string): number {
  if (!isDesktop() || userId === LOCAL_OWNER_ID) return 0;
  const db = loadDB();
  const mine = db.games.filter((g) => g.userId === LOCAL_OWNER_ID);
  if (!mine.length) return 0;
  for (const g of mine) g.userId = userId;
  saveDB(db);
  return mine.length;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/** How long an option label may be. Short on purpose: these render as column
 *  and row headers next to the payoff inputs, and a sentence would break the
 *  grid. Long enough for "Advertise heavily", short enough to stay a label. */
const LABEL_MAX = 40;

/**
 * The four option labels off a request body, cleaned.
 *
 * Returns only the keys that were actually supplied, so a caller updating just
 * the description does not blank the labels by omission. Same clamping as every
 * other user-supplied string here: these are rendered in the UI and fed to the
 * model prompt, so they are trimmed and length-capped rather than trusted.
 */
function cleanLabels(body: any, allowClear = false): Partial<Pick<SavedGame, "row1Label" | "row2Label" | "col1Label" | "col2Label">> {
  const out: Record<string, string> = {};
  for (const key of ["row1Label", "row2Label", "col1Label", "col2Label"] as const) {
    const v = cleanText(body?.[key], LABEL_MAX);
    // Without allowClear an empty value means "not supplied", so a caller
    // updating only the description cannot blank the labels by omission. The
    // edit dialog is the opposite case: it sends every field every time, and a
    // user who deletes a wrong label means it. Only that caller opts in.
    if (v || (allowClear && key in (body ?? {}))) out[key] = v;
  }
  return out;
}

/**
 * The user's own colour terms off a request body, cleaned by the SAME shared
 * rules the client applies before sending them (src/utils/colorTerms.ts), so
 * the two ends cannot disagree about what a valid term is.
 *
 * Follows cleanLabels' supplied-vs-cleared convention: an absent key is "not
 * supplied" and leaves the stored terms alone, while the edit dialog — which
 * sends every field — opts into clearing so a user who removes their last term
 * actually loses it.
 *
 * Unlike the labels, these never reach the model prompt.
 */
function cleanColorTerms(body: any, allowClear = false): Partial<Pick<SavedGame, "colorTermsA" | "colorTermsB">> {
  const out: Partial<Pick<SavedGame, "colorTermsA" | "colorTermsB">> = {};
  // Cleaned as a PAIR: a phrase belongs to one player, and cleaning the lists
  // independently would let a direct PATCH store it in both, after which the
  // colour depends on which list the renderer scans first.
  const pair = cleanUserColorTermPair(body?.colorTermsA, body?.colorTermsB);
  if ("colorTermsA" in (body ?? {}) && (pair.a.length > 0 || allowClear)) out.colorTermsA = pair.a;
  if ("colorTermsB" in (body ?? {}) && (pair.b.length > 0 || allowClear)) out.colorTermsB = pair.b;
  return out;
}

/**
 * A client-supplied scenario goes straight into the model prompt, so it is
 * clamped and stripped rather than trusted.
 *
 * Tags are removed because preset descriptions are stored as HTML and a custom
 * game's description is free text a user typed; neither should reach the prompt
 * as markup. Lengths are capped so a long description cannot crowd out the
 * grounding payload that keeps the explanation correct.
 */
function cleanScenario(value: any): Scenario | undefined {
  if (!value || typeof value !== "object") return undefined;
  const noTags = (v: unknown, n: number) =>
    cleanText(v, n).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  // Option labels are clamped to 40 characters and then PRINTED, so a bare
  // slice cuts mid-word and the stub is repeated four or five times in one
  // rendered paragraph ("Escalate the dispute to the regional arb" — rounds
  // T1 and T2). Clamp at the last word boundary instead.
  const label = (v: unknown) => {
    const t = noTags(v, 60);
    if (t.length <= 40) return t || undefined;
    const cut = t.slice(0, 40);
    const at = cut.lastIndexOf(' ');
    return (at > 12 ? cut.slice(0, at) : cut).trim() || undefined;
  };
  const sc: Scenario = {
    name: noTags(value.name, 80) || undefined,
    row1: label(value.row1),
    row2: label(value.row2),
    col1: label(value.col1),
    col2: label(value.col2),
    description: noTags(value.description, 1200) || undefined,
  };
  return Object.values(sc).some(Boolean) ? sc : undefined;
}

function cleanPayoffs(value: any): GamePayoffs | null {
  const keys: (keyof GamePayoffs)[] = ["a11", "a12", "a21", "a22", "b11", "b12", "b21", "b22"];
  const out = {} as GamePayoffs;
  for (const key of keys) {
    const n = Number(value?.[key]);
    if (!Number.isFinite(n)) return null;
    out[key] = Math.max(-100, Math.min(100, Math.round(n * 1000) / 1000));
  }
  return out;
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

// Drop expired buckets so the Map can't grow unbounded under many distinct IPs.
// Cheap: only sweeps once the Map gets large rather than on every request.
function pruneRateBuckets(now: number) {
  if (rateBuckets.size < 1000) return;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}

/**
 * Per-IP throttle for the hosted service.
 *
 * `hosted-only` marks a limit that exists ONLY to protect a SHARED server from
 * one user. On the desktop there is no shared server: the model runs on the
 * user's own machine, a report costs them nothing, and since this build binds
 * 127.0.0.1 there is nobody else on the socket to throttle. Capping generation
 * there is a pure downgrade — unlimited regeneration at no cost is one of the
 * few things the local app has BY CONSTRUCTION that the hosted one cannot
 * offer, and at ~0.75s per local report, 20/min is under half a minute of
 * ordinary use.
 *
 * Limits that protect the USER rather than the server — sign-in attempts,
 * verification and recovery codes, account deletion, admin endpoints — are
 * deliberately NOT marked and stay in force everywhere. They guard the local
 * database against whoever is at the keyboard, which is a real threat model on
 * a desktop and not one on Cloud Run, so the desktop is the last place to
 * relax them.
 */
function rateLimit(
  label: string,
  max: number,
  windowMs: number,
  scope: 'always' | 'hosted-only' = 'always',
): express.RequestHandler {
  const liftedForDesktop = scope === 'hosted-only' && process.env.IS_ELECTRON === 'true';
  return (req, res, next) => {
    if (liftedForDesktop) return next();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `${label}:${ip}`;
    const now = Date.now();
    pruneRateBuckets(now);
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ error: "Too many attempts. Please wait a minute and try again." });
    }
    return next();
  };
}

// Updates in-memory DB immediately; persists to GCS (Cloud Run) or local file (Electron/dev)
function saveDB(db: DB) {
  inMemoryDb = db;
  if (!process.env.ELECTRON_USER_DATA_PATH && GCS_BUCKET) {
    import('@google-cloud/storage').then(({ Storage }) => {
      const storage = new Storage();
      return storage.bucket(GCS_BUCKET!).file('db.json').save(
        JSON.stringify(db, null, 2),
        { contentType: 'application/json' }
      );
    }).catch(err => console.error('GCS write failed:', err));
  } else {
    try {
      const dbDir = path.dirname(DB_FILE);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
    } catch (err) {
      console.error("Error writing db.json:", err);
    }
  }
}

// Helper to get NodeMailer transporter
function getTransporter() {
  const host = process.env.SMTP_HOST ?? "";
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER ?? "";
  const pass = process.env.SMTP_PASS ?? "";

  if (host && user && pass) {
    const isGmail = host.toLowerCase().includes("gmail") || user.toLowerCase().includes("gmail");

    if (isGmail) {
      console.log(`Configuring specialized Gmail SMTP transporter for ${user}`);
      return nodemailer.createTransport({
        service: "gmail",
        auth: {
          user,
          pass,
        },
      });
    }

    console.log(`Configuring custom SMTP transporter via ${host}:${port} for ${user}`);
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass,
      },
      // Validate the SMTP server's TLS certificate by default. Disabling it
      // exposes SMTP credentials and mail contents to MITM, so only opt out via
      // an explicit dev-only flag (e.g. a self-signed local relay).
      ...(process.env.SMTP_ALLOW_INSECURE_TLS === "true"
        ? { tls: { rejectUnauthorized: false } }
        : {}),
    });
  }
  return null;
}

// Send real email verification
async function sendVerificationEmail(email: string, code: string, username: string): Promise<{ success: boolean; via: string; messageId?: string; previewUrl?: string | null; smtpError?: string | null; }> {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || `"Nash Equilibrium Simulator" <noreply@example.com>`;

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; display: inline-block; margin-bottom: 8px;">🧭</span>
        <h2 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 800; tracking-tight: -0.025em;">Nash Equilibrium Simulator</h2>
      </div>
      <p style="color: #334155; font-size: 15px; line-height: 1.6; margin-bottom: 16px;">Hello <strong>@${escapeHtml(username)}</strong>,</p>
      <p style="color: #475569; font-size: 14.5px; line-height: 1.6; margin-bottom: 24px;">To complete your setup, please enter this code into the Nash Equilibrium Simulator verification modal:</p>
      
      <div style="text-align: center; margin: 28px 0;">
        <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 34px; font-weight: 800; letter-spacing: 5px; color: #2563eb; background: #f0f7ff; padding: 14px 28px; border: 2px solid #bfdbfe; border-radius: 14px; display: inline-block;">
          ${code}
        </span>
      </div>

      <p style="color: #64748b; font-size: 12.5px; line-height: 1.6; margin-top: 28px; border-top: 1px solid #f1f5f9; padding-top: 18px; text-align: center;">
        This confirmation code expires in 10 minutes. If you did not create an account, you can safely ignore this email.
      </p>
    </div>
  `;

  if (!transporter) {
    throw new Error("SMTP configuration is incomplete/missing in .env. Please define SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.");
  }

  try {
    const info = await transporter.sendMail({
      from,
      to: email,
      subject: `Your Nash Sim Verification Code: ${code}`,
      text: `Your Nash Sim verification code is: ${code}. It expires in 10 minutes.`,
      html: htmlContent,
    });
    console.log("Verification email sent successfully using custom SMTP:", info.messageId);
    return { success: true, via: "smtp", messageId: info.messageId };
  } catch (err: any) {
    console.error("Failed to send email via custom SMTP, error details:", err);
    throw new Error(`SMTP Mail delivery failed: ${err.message}`);
  }
}

async function sendDeleteEmail(email: string, code: string, username: string): Promise<{ success: boolean; via: string; messageId?: string; }> {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || `"Nash Equilibrium Simulator" <noreply@example.com>`;

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; border: 1px solid #fecaca; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(220, 38, 38, 0.03); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; display: inline-block; margin-bottom: 8px;">⚠️</span>
        <h2 style="margin: 0; color: #991b1b; font-size: 20px; font-weight: 800; tracking-tight: -0.025em;">Confirm Account Deletion</h2>
      </div>
      <p style="color: #334155; font-size: 15px; line-height: 1.6; margin-bottom: 16px;">Hello <strong>@${escapeHtml(username)}</strong>,</p>
      <p style="color: #475569; font-size: 14.5px; line-height: 1.6; margin-bottom: 24px;">We received a request to permanently delete your Nash Equilibrium Simulator account. This action cannot be undone. To proceed, please enter this security confirmation code into the simulator's deletion screen:</p>
      
      <div style="text-align: center; margin: 28px 0;">
        <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 32px; font-weight: 800; letter-spacing: 5px; color: #dc2626; background: #fef2f2; padding: 14px 28px; border: 2px solid #fca5a5; border-radius: 14px; display: inline-block;">
          ${code}
        </span>
      </div>

      <p style="color: #64748b; font-size: 12.5px; line-height: 1.6; margin-top: 28px; border-top: 1px solid #f1f5f9; padding-top: 18px; text-align: center;">
        If you did not request to delete your account, please ignore this message and consider changing your password. This deletion confirmation code expires in 10 minutes.
      </p>
    </div>
  `;

  if (!transporter) {
    throw new Error("SMTP configuration is incomplete/missing in .env.");
  }

  try {
    const info = await transporter.sendMail({
      from,
      to: email,
      subject: `Confirm Account Deletion Request: ${code}`,
      text: `Your account deletion security code is: ${code}. It expires in 10 minutes.`,
      html: htmlContent,
    });
    console.log("Account Deletion confirmation email sent successfully:", info.messageId);
    return { success: true, via: "smtp", messageId: info.messageId };
  } catch (err: any) {
    console.error("Failed to send deletion confirmation email, error details:", err);
    throw new Error(`SMTP Mail delivery failed: ${err.message}`);
  }
}

async function sendRecoveryEmail(email: string, code: string): Promise<{ success: boolean; via: string; messageId?: string; }> {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || `"Nash Equilibrium Simulator" <noreply@example.com>`;

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; border: 1px solid #fed7aa; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(234, 88, 12, 0.04); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; display: inline-block; margin-bottom: 8px;">🔑</span>
        <h2 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 800;">Password Recovery</h2>
        <p style="color: #64748b; font-size: 13px; margin-top: 6px;">Nash Equilibrium Simulator</p>
      </div>
      <p style="color: #475569; font-size: 14.5px; line-height: 1.6; margin-bottom: 24px;">We received a request to reset the password for this account. Enter the code below in the simulator to set a new password:</p>

      <div style="text-align: center; margin: 28px 0;">
        <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 34px; font-weight: 800; letter-spacing: 5px; color: #ea580c; background: #fff7ed; padding: 14px 28px; border: 2px solid #fed7aa; border-radius: 14px; display: inline-block;">
          ${code}
        </span>
      </div>

      <p style="color: #64748b; font-size: 12.5px; line-height: 1.6; margin-top: 28px; border-top: 1px solid #f1f5f9; padding-top: 18px; text-align: center;">
        This recovery code expires in 10 minutes. If you did not request a password reset, you can safely ignore this email — your password will not change.
      </p>
    </div>
  `;

  if (!transporter) {
    throw new Error("SMTP configuration is incomplete/missing in .env. Please define SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.");
  }

  try {
    const info = await transporter.sendMail({
      from,
      to: email,
      subject: `Your Nash Sim Password Recovery Code: ${code}`,
      text: `Your Nash Sim password recovery code is: ${code}. It expires in 10 minutes.`,
      html: htmlContent,
    });
    console.log("Password recovery email sent successfully:", info.messageId);
    return { success: true, via: "smtp", messageId: info.messageId };
  } catch (err: any) {
    console.error("Failed to send recovery email:", err);
    throw new Error(`SMTP Mail delivery failed: ${err.message}`);
  }
}

// Destination inbox for all user feedback submissions
const FEEDBACK_INBOX = process.env.FEEDBACK_INBOX || "daluan217@gmail.com";

async function sendFeedbackEmail(
  message: string,
  rating: number | null,
  fromEmail: string | null
): Promise<{ success: boolean; via: string; messageId?: string; }> {
  const transporter = getTransporter();
  // Always send from the project's own mailbox so anonymous submissions stay anonymous.
  const from = process.env.SMTP_FROM || `"Nash Equilibrium Simulator" <noreply@example.com>`;

  if (!transporter) {
    throw new Error("SMTP configuration is incomplete/missing in .env.");
  }

  const stars = rating && rating > 0
    ? "★".repeat(rating) + "☆".repeat(5 - rating) + ` (${rating}/5)`
    : "Not provided";
  const senderLabel = fromEmail ? fromEmail : "Anonymous";
  const safeMessage = (message || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; display: inline-block; margin-bottom: 8px;">💬</span>
        <h2 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 800;">New User Feedback</h2>
        <p style="color: #64748b; font-size: 13px; margin-top: 6px;">Nash Equilibrium Simulator</p>
      </div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <tr>
          <td style="color: #64748b; font-size: 13px; font-weight: 700; padding: 6px 0; width: 90px;">Rating</td>
          <td style="color: #ea580c; font-size: 15px; padding: 6px 0;">${stars}</td>
        </tr>
        <tr>
          <td style="color: #64748b; font-size: 13px; font-weight: 700; padding: 6px 0;">From</td>
          <td style="color: #334155; font-size: 14px; padding: 6px 0;">${escapeHtml(senderLabel)}</td>
        </tr>
      </table>
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; color: #334155; font-size: 14.5px; line-height: 1.6; white-space: pre-wrap;">${safeMessage}</div>
      <p style="color: #94a3b8; font-size: 11.5px; line-height: 1.6; margin-top: 24px; border-top: 1px solid #f1f5f9; padding-top: 16px; text-align: center;">
        Submitted on ${new Date().toUTCString()}${fromEmail ? " — reply directly to this email to respond." : " — this submission was sent anonymously."}
      </p>
    </div>
  `;

  const textContent =
    `New feedback for Nash Equilibrium Simulator\n\n` +
    `Rating: ${stars}\nFrom: ${senderLabel}\n\n${message}`;

  try {
    const info = await transporter.sendMail({
      from,
      to: FEEDBACK_INBOX,
      ...(fromEmail ? { replyTo: fromEmail } : {}),
      subject: `New Feedback${rating ? ` (${rating}★)` : ""} — Nash Equilibrium Simulator`,
      text: textContent,
      html: htmlContent,
    });
    console.log("Feedback email sent successfully:", info.messageId);
    return { success: true, via: "smtp", messageId: info.messageId };
  } catch (err: any) {
    console.error("Failed to send feedback email:", err);
    throw new Error(`SMTP Mail delivery failed: ${err.message}`);
  }
}

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);

  // Trust the proxy in front of us (e.g. Cloud Run) so req.ip reflects the real
  // client for rate limiting. Configurable because trusting X-Forwarded-For when
  // NOT behind a trusted proxy would let clients spoof their IP. Set TRUST_PROXY
  // to a hop count (e.g. "1"), "true", or a subnet; defaults to off for local.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    app.set("trust proxy", /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10)
      : trustProxy === "true" ? true
      : trustProxy);
  }

  // Parse JSON bodies
  app.use(express.json());

  // Baseline security headers. A full content CSP is intentionally omitted here
  // because the app loads Google Analytics + inline scripts and Plotly may use
  // eval/blob workers — tightening script/style/connect needs browser testing.
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    next();
  });

  // CORS for cross-origin API access (e.g. from the local Electron client to the
  // website backend). Set CORS_ALLOWED_ORIGINS (comma-separated) to restrict to
  // known origins; if unset we fall back to "*" for backward compatibility.
  const corsAllowlist = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",").map(o => o.trim()).filter(Boolean);
  // The desktop (Electron) client runs on http://127.0.0.1:<port> and calls the
  // hosted backend cross-origin — treat localhost as a trusted first-party origin.
  const isLocalClientOrigin = (origin: string) =>
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (req.path.startsWith("/api/admin/")) {
      // Admin returns user PII and is gated by x-admin-secret. Don't expose it to
      // arbitrary internet origins via "*"; allow cross-origin calls only from the
      // first-party local (Electron) client or explicitly allowlisted origins.
      if (origin && (isLocalClientOrigin(origin) || corsAllowlist.includes(origin))) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "x-admin-secret");
      }
    } else {
      if (corsAllowlist.length === 0) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      } else if (origin && corsAllowlist.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      // PATCH is how the client updates a saved game in place (scenario keep,
      // rename); leaving it out of the preflight answer breaks those calls for
      // every cross-origin client (the Electron app) while the same-origin
      // website works — the failure reads as "couldn't reach the server".
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-secret");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // ── Admin Stats API ────────────────────────────────────────────────────────
  app.get("/api/admin/stats", rateLimit("admin", 10, 60_000), (req, res) => {
    const secret = req.headers["x-admin-secret"] as string;
    // Fail closed: reject when ADMIN_SECRET is unconfigured or the header is
    // missing — otherwise an unset env makes `undefined !== undefined` false and
    // the check passes, exposing all-user PII to an unauthenticated caller.
    if (!process.env.ADMIN_SECRET || !secret || !safeEqual(secret, process.env.ADMIN_SECRET)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const db = loadDB();
    const now = Date.now();
    const day = 86400000;
    const signupsToday = db.users.filter(u => {
      // Use verificationCodeExpires as a rough creation timestamp proxy
      // (set to now + 10min on register, so creation ≈ expires - 10min)
      const created = u.verificationCodeExpires - 10 * 60 * 1000;
      return created > now - day;
    }).length;
    const signupsThisWeek = db.users.filter(u => {
      const created = u.verificationCodeExpires - 10 * 60 * 1000;
      return created > now - 7 * day;
    }).length;
    res.json({
      totalUsers: db.users.length,
      verifiedUsers: db.users.filter(u => u.isVerified).length,
      unverifiedUsers: db.users.filter(u => !u.isVerified).length,
      totalGames: db.games.length,
      signupsToday,
      signupsThisWeek,
      users: db.users.map(u => ({
        username: u.username,
        email: u.email,
        isVerified: u.isVerified,
        gamesCount: db.games.filter(g => g.userId === u.id).length,
      })),
    });
  });

  // ── Authentication API ─────────────────────────────────────────────────────

  // Express API health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Latest desktop app version — written to GCS by the release CI alongside the DMG.
  // The installed Electron app polls this to decide whether to prompt for an update.
  app.get("/api/version", rateLimit("version", 60, 60_000, 'hosted-only'), async (req, res) => {
    try {
      if (!process.env.ELECTRON_USER_DATA_PATH && GCS_BUCKET) {
        const { Storage } = await import('@google-cloud/storage');
        const file = new Storage().bucket(GCS_BUCKET).file('app-version.json');
        const [exists] = await file.exists();
        if (exists) {
          const [content] = await file.download();
          res.setHeader('Cache-Control', 'no-store');
          return res.type('application/json').send(content.toString('utf-8'));
        }
      }
      return res.json({ version: null });
    } catch (error: any) {
      console.error("Error reading app version:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ── Report API ─────────────────────────────────────────────────────────────
  // Grounded LLM analysis with deterministic fallback. The client renders model
  // prose only when validation passes; a refusal, truncation, or hallucination
  // degrades to the existing deterministic panel rather than showing something
  // wrong. That makes the fallback path exercised in normal operation.
  app.post("/api/report", rateLimit("report", 20, 60_000, 'hosted-only'), async (req, res) => {
    const payoffs = cleanPayoffs(req.body?.payoffs);
    const scenario = cleanScenario(req.body?.scenario);
    if (!payoffs) {
      return res.status(400).json({ error: "Invalid payoff matrix." });
    }

    // NASH_PAYOFF_TEMPLATE=1 — PROTOTYPE, default OFF. Rung 3 of the constraint
    // ladder: render the mathematical sentences of ORDINARY games from the
    // solver, exactly as tie games already are, and let the model supply only
    // the scenario. Built so the tradeoff can be MEASURED rather than argued:
    // across twelve adversarial rounds the templated surface produced one
    // defect ever while free prose plateaued at 2-4%. Adopting this is a
    // product decision — it trades some of the model's voice for that
    // guarantee — so it stays behind a flag until that decision is made.
    if (process.env.NASH_PAYOFF_TEMPLATE === '1') {
      const p2 = payoffs;
      const isTie = p2.a11 === p2.a21 || p2.a12 === p2.a22 || p2.b11 === p2.b12 || p2.b21 === p2.b22;
      if (!isTie && req.body?.scenarioOnly !== true) {
        let invented: SuggestedScenario | null = null;
        if (!scenario && hasCredentials(DEFAULT_MODEL)) {
          try {
            const r = LOCAL_PROMPT
              ? (await generateReport(payoffs, { model: DEFAULT_MODEL, systemPrompt: LOCAL_PROMPT })).report?.suggestedScenario ?? null
              : (await generateScenario(payoffs, { model: DEFAULT_MODEL, reasoning: REPORT_REASONING, domain: pickScenarioDomain(), stakes: true })).scenario;
            // Under rung 3 the scenario must also be CLAIM-FREE: the solver
            // states the mathematics, so a description that asserts anything
            // decidable is both unnecessary and the only remaining defect
            // surface (T1 measured it at 11.4%).
            // `claimFree` was `false | {ok, reason}` and was read through two
            // `as any` casts. It behaved correctly, but a cast is where the next
            // edit goes wrong silently — and this is the screen that decides
            // whether a decidable claim reaches the user. Narrowed to the same
            // shape the other two scenario paths use.
            const claimFree = r ? scenarioIsClaimFree(r) : null;
            const ok = !!r && validateScenario(r, payoffs).ok && claimFree?.ok === true
              && (process.env.NASH_DIRECTION_CHECKS !== '1' || validateProseDirections(r.description ?? '', r, payoffs).length === 0);
            if (r && ok) invented = r;
            else if (r && claimFree && !claimFree.ok) console.warn(`[report] rung-3 scenario dropped: ${claimFree.reason}`);
          } catch { invented = null; }
        }
        const labels2 = scenario ?? invented;
        const truth2 = computeAllNE(payoffs);
        return res.json({
          source: 'template',
          report: {
            claimedEquilibria: truth2.map((n) => ({ type: n.type, x: n.x, y: n.y })),
            prose: tieProseFull(payoffs, labels2 ?? null).prose,
            // The renderer declares what it asserts, derived in the SAME pass as
            // the prose so the two cannot drift. Was `null`, which made the
            // DETERMINISTIC surface less verifiable than the model's.
            proseClaims: tieProseFull(payoffs, labels2 ?? null).claims,
            suggestedScenario: scenario ? undefined : invented ?? undefined,
          },
          groundTruth: truth2,
          validation: null,
        });
      }
    }

    // Tie-game policy, set by NASH_LLM_TIES:
    //   '0'        — withhold LLM prose entirely (the deterministic panel
    //                explains ties and continua exactly). Both models
    //                concentrate their residual errors here (rounds L1/L2/C1,
    //                and L4: 7 of 17 tie prose surfaces wrong).
    //   'template' — render the mathematical sentences from the solver and let
    //                the model supply only the scenario.
    // Anything else sends tie games to the model like any other game.
    const tiePolicy = process.env.NASH_LLM_TIES;
    if (tiePolicy === '0' || tiePolicy === 'template') {
      const p = payoffs;
      const tie = p.a11 === p.a21 || p.a12 === p.a22 || p.b11 === p.b12 || p.b21 === p.b22;
      if (tie) {
        // NASH_LLM_TIES=template: the model's DECLARATIONS on tie games are
        // reliably exact (round L4: every declared claim true) while its free
        // prose is not (7 of 17 tie prose surfaces wrong). So the mathematical
        // sentences are rendered from the solver and the model is asked only
        // for a scenario — the work it does well (L4 stories: 46/46 correct).
        if (tiePolicy === 'template') {
          // A supplied scenario is the user's own game description: the
          // non-tie path never replaces it, and neither may this one. Only
          // invent when nothing was supplied. (Round C14 draw 60: a `let
          // scenario` here shadowed the request's scenario, so a user who
          // supplied "Night Shift / Day Shift" was shown a mathematically
          // perfect paragraph about options that were not in their game.)
          let invented: SuggestedScenario | null = null;
          if (!scenario && hasCredentials(DEFAULT_MODEL)) {
            try {
              const s = LOCAL_PROMPT
                ? (await generateReport(payoffs, { model: DEFAULT_MODEL, systemPrompt: LOCAL_PROMPT })).report?.suggestedScenario ?? null
                : (await generateScenario(payoffs, { model: DEFAULT_MODEL, reasoning: REPORT_REASONING, domain: pickScenarioDomain(), stakes: true })).scenario;
              // The scenario still faces its own gate; a failed story costs the
              // labels, not the explanation.
              // Same screen the non-tie path applies: the declarations gate,
              // the CLAIM-FREE screen, AND the label-aware direction/dependence
              // checks over the free description. C15 draw 56's story denied a
              // payoff tie that the template paragraph beside it stated aloud.
              //
              // The claim-free screen was MISSING here until 2026-08-29, while
              // this comment already claimed parity. Every claim-free rule —
              // the payoff rules, "in response", "before B chooses" — silently
              // did not apply to tie games, which are 12.7% of a random sample.
              // Found by adversarial round #2: "The shop owner chooses between
              // Open Records and Restrict Records when responding to the
              // review" shipped on a tie game (b11 = b12 = -1) even though the
              // screen drops that exact description.
              const claimFreeOk = !!s && scenarioIsClaimFree(s).ok;
              const storyOk = !!s && validateScenario(s, payoffs).ok && claimFreeOk
                && (process.env.NASH_DIRECTION_CHECKS !== '1' || validateProseDirections(s.description ?? '', s, payoffs).length === 0);
              if (s && !claimFreeOk) console.warn(`[report] tie-path scenario dropped: ${scenarioIsClaimFree(s).reason}`);
              if (s && storyOk) invented = s;
            } catch { invented = null; }
          }
          // Labels for the rendered sentences: the user's own scenario first,
          // an invented one only when they supplied none.
          const labels = scenario ?? invented;
          if (req.body?.scenarioOnly === true) {
            return res.json(invented ? { scenario: invented } : { scenario: null, failure: scenario ? 'scenario-supplied' : 'validation-failed' });
          }
          const truth = computeAllNE(payoffs);
          return res.json({
            source: 'template',
            report: {
              claimedEquilibria: truth.map((n) => ({ type: n.type, x: n.x, y: n.y })),
              prose: tieProseFull(payoffs, labels ?? null).prose,
              proseClaims: tieProseFull(payoffs, labels ?? null).claims,
              // Never offer a replacement the user did not ask for.
              suggestedScenario: scenario ? undefined : invented ?? undefined,
            },
            groundTruth: truth,
            validation: null,
          });
        }
        if (req.body?.scenarioOnly === true) return res.json({ scenario: null, failure: 'tie-game' });
        return res.json({
          source: 'deterministic',
          report: null,
          groundTruth: computeAllNE(payoffs),
          validation: null,
          fallbackReason: 'tie-game',
        });
      }
    }

    // The slim path behind "New AI scenario": the explanation on screen is
    // already validated, so only a fresh STORY is wanted — ~300 output
    // tokens instead of ~650, roughly halving that button's latency and its
    // retry. Same story-claims gate, one retry, suggestion withheld on a
    // double failure. Never cached: freshness is the request.
    if (req.body?.scenarioOnly === true) {
      if (!hasCredentials(DEFAULT_MODEL)) {
        return res.json({ scenario: null, failure: "no-key" });
      }
      // The tie path already refuses to replace a scenario the user supplied;
      // the ordinary path did not, so scenarioOnly handed back a substitute
      // (round T2). Never offer a replacement the user did not ask for.
      if (scenarioIsUsable(scenario)) {
        return res.json({ scenario: null, failure: "scenario-supplied" });
      }
      const invent = async () => {
        if (!LOCAL_PROMPT) return generateScenario(payoffs, { model: DEFAULT_MODEL, reasoning: REPORT_REASONING, domain: pickScenarioDomain(), stakes: true });
        const r = await generateReport(payoffs, { model: DEFAULT_MODEL, systemPrompt: LOCAL_PROMPT });
        return { scenario: r.report?.suggestedScenario ?? null, failure: r.failure };
      };
      let { scenario: invented, failure } = await invent();
      // The claim-free screen belongs here too, and its absence was the single
      // biggest hole in the scenario surface. The rung-3 report path (:899) and
      // the tie path (:963) both call it; this path did not, so it dropped the
      // digit rule and all six CLAIMY rules — and then retried, meaning the
      // LOOSEST gate was the one that got two draws while the strictest got one.
      //
      // What made it user-visible is that the split is on the MATRIX, not on the
      // button. "New AI scenario" on a TIE game is served from the tie block and
      // is screened; on any other game it lands here and was not. Ties are 12.7%
      // of a random sample, so roughly 87% of clicks on that button took the
      // weaker path — same button, same user, same model, different screening
      // because of something about the matrix the user never sees.
      //
      // Measured before changing it: 4 of 4 known positives the report path
      // rejects sailed through here, including a real "Col1 or Col2" draw that
      // was rejected in the wild on the other path. Cost of parity across 890
      // stored draws: 2 newly withheld, 0.23%.
      const storyOk = (sc: NonNullable<typeof invented>) => validateScenario(sc, payoffs).ok
        && scenarioIsClaimFree(sc).ok
        && (process.env.NASH_DIRECTION_CHECKS !== '1' || validateProseDirections(sc.description ?? '', sc, payoffs).length === 0);
      // Two different ways to end up with nothing, and only one used to get a
      // second chance.
      //
      // A draw that came back and FAILED the gate was retried. A draw that
      // never came back at all — `max-tokens`, the model spending its whole
      // budget reasoning — was not, because `invented` is null and the
      // condition below started with `invented &&`. So the user clicked "New AI
      // scenario" and got nothing, silently, with a second draw sitting right
      // there. Measured at 7.5% of calls once the stakes hint lengthened the
      // prompt (9 of 120 vs 0 of 120 without it, p=0.0033), and a pre-existing
      // 1.1-1.7% before that. Roughly one click in thirteen.
      //
      // A reroll is the sanctioned instrument here — nothing is rewritten, a
      // lost draw is simply drawn again — and it costs one extra call only on
      // the calls that produced nothing.
      const gateOn = process.env.NASH_SCENARIO_CHECKS !== '0';
      const lost = !invented;
      if (lost || (gateOn && !storyOk(invented))) {
        const second = await invent();
        invented = second.scenario && (!gateOn || storyOk(second.scenario)) ? second.scenario : null;
        if (!invented) failure = (lost && !second.scenario ? (second.failure ?? failure) : "validation-failed") as typeof failure;
      }
      return res.json({ scenario: invented, failure: invented ? null : (failure ?? "error") });
    }

    // Cache: serve a previously validated envelope for the identical
    // (matrix, scenario) instantly. bypassCache comes from an explicit
    // Regenerate click, which must roll fresh (and then overwrites the entry).
    const cacheKey = reportCacheKey(payoffs, scenario);
    if (req.body?.bypassCache !== true) {
      const hit = reportCache.get(cacheKey);
      if (hit) return res.json(hit);
    }

    const groundTruth = computeAllNE(payoffs);

    // No key for the configured model's provider: local Electron mode, or an
    // unkeyed deploy. Not an error — fall through to the deterministic report.
    if (!hasCredentials(DEFAULT_MODEL)) {
      const envelope: ReportEnvelope = {
        source: "deterministic",
        report: null,
        validation: null,
        groundTruth,
        fallbackReason: "no-key",
      };
      return res.json(envelope);
    }

    // Model is server-controlled on purpose — a client-supplied model would let
    // anyone bill the expensive one. The eval sweep calls generateReport
    // directly, so it varies the model without this route needing to accept it.
    let { report, failure } = await generateReport(payoffs, { model: DEFAULT_MODEL, scenario, reasoning: REPORT_REASONING, systemPrompt: LOCAL_PROMPT });

    // The prompt already forbids inventing a story for a game that has one,
    // but that is an instruction, not a guarantee — models drift. Enforce it:
    // when a usable scenario was supplied, drop any suggestion so the client
    // is never offered a replacement it didn't ask for. A user who WANTS a
    // fresh invention asks for one by omitting the scenario from the request.
    if (report?.suggestedScenario && scenarioIsUsable(scenario)) {
      report.suggestedScenario = null;
    }

    // Declared-claims gates — the scenario's story (storyClaims) and the
    // prose's action statements (proseClaims), each checked as lookups the
    // way geometryClaims are. ONE retry covers both (never more than two
    // model calls per request); the second report replaces the first only
    // when it scores strictly better. Final consequences differ by artifact:
    // a bad story costs the suggestion (it would otherwise be prefilled into
    // the save form and persisted), bad prose actions cost the prose itself —
    // demoted to the deterministic panel below, exactly like a hallucinated
    // equilibrium, because "right numbers, wrong words" is still wrong.
    // Per-gate opt-outs mirror NASH_PROSE_CHECKS so each gate's effect is
    // measurable in isolation. The eval sweep calls generateReport directly
    // and never crosses either gate.
    const degenerate = computeIndifference(payoffs).any;
    const scenarioGateOn = process.env.NASH_SCENARIO_CHECKS !== '0';
    const proseGateOn = process.env.NASH_PROSE_ACTION_CHECKS !== '0';
    // Label-aware direction check (opt-in, NASH_DIRECTION_CHECKS=1): reads
    // the sentences themselves — "X is better / prefers X … against Y" — in
    // the game's option words and verifies direction and strictness. Closes
    // the "true declaration, wrong words" gap the declared-claims gates
    // cannot see (observed on both the cloud and the local model).
    const directionOn = process.env.NASH_DIRECTION_CHECKS === '1';
    const assess = (r: NonNullable<typeof report>) => {
      const scenarioOk = !scenarioGateOn || !r.suggestedScenario
        || (validateScenario(r.suggestedScenario, payoffs).ok
          && (!directionOn || validateProseDirections(r.suggestedScenario.description ?? '', r.suggestedScenario, payoffs).length === 0));
      // Run even when proseClaims is null: the undeclared-comparison screen
      // is exactly for prose that makes claims while declaring nothing.
      const proseLabels = scenarioIsUsable(scenario) ? scenario : r.suggestedScenario;
      const proseOk = !proseGateOn
        || (validateProseClaims(r.proseClaims ?? null, r.prose ?? '', payoffs, groundTruth, degenerate, directionOn ? proseLabels ?? null : undefined).ok
          && (!directionOn || validateProseDirections(r.prose ?? '', proseLabels ?? null, payoffs).length === 0));
      // Prose outranks the optional story when choosing between candidates.
      return { scenarioOk, proseOk, rank: (proseOk ? 2 : 0) + (scenarioOk ? 1 : 0) };
    };
    let proseClaimsFailed = false;
    let orphanedLabels = false;
    if (report) {
      let gates = assess(report);
      if (gates.rank < 3) {
        console.warn(`[report] declared-claims gate failed (scenarioOk=${gates.scenarioOk}, proseOk=${gates.proseOk}) — retrying once`);
        const second = await generateReport(payoffs, { model: DEFAULT_MODEL, scenario, reasoning: REPORT_REASONING, systemPrompt: LOCAL_PROMPT });
        if (second.report) {
          // Same enforcement as the first attempt: never offer a replacement
          // scenario the user didn't ask for.
          if (second.report.suggestedScenario && scenarioIsUsable(scenario)) {
            second.report.suggestedScenario = null;
          }
          const g2 = assess(second.report);
          if (g2.rank > gates.rank) {
            ({ report, failure } = second);
            gates = g2;
          }
        }
        if (report && !gates.scenarioOk) {
          // The story is dropped, but the prose may be WRITTEN in its option
          // names — round C14 draw 21 shipped "A uses Issue statement with
          // probability 0.95 …" with no scenario on screen to say what an
          // Issue statement is. An explanation about options the reader cannot
          // see is withheld, the same as any other unshowable prose.
          const dropped = report.suggestedScenario;
          const names = [dropped?.row1, dropped?.row2, dropped?.col1, dropped?.col2]
            .map((n) => (n ?? '').trim()).filter((n) => n.length > 2);
          const prose = report.prose ?? '';
          if (names.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(prose))) {
            orphanedLabels = true;
          }
          report.suggestedScenario = null;
        }
        proseClaimsFailed = !gates.proseOk;
      }
    }

    if (!report) {
      const envelope: ReportEnvelope = {
        source: "deterministic",
        report: null,
        validation: null,
        groundTruth,
        fallbackReason: failure ?? "error",
      };
      return res.json(envelope);
    }

    const validation = validateReport(report, payoffs);
    // proseClaimsFailed outranks a passing validation: the numeric checks
    // can all be green while the declared actions contradict the solver
    // ("right numbers, wrong words") — that prose is withheld the same way
    // a hallucinated equilibrium is.
    const envelope: ReportEnvelope = orphanedLabels
      ? {
          source: "deterministic",
          report,
          validation,
          groundTruth,
          fallbackReason: "orphaned-labels",
        }
      : proseClaimsFailed
      ? {
          source: "deterministic",
          report,
          validation,
          groundTruth,
          fallbackReason: "prose-claims-failed",
        }
      : validation.ok
      ? { source: "llm", report, validation, groundTruth }
      : {
          source: "deterministic",
          report,
          validation,
          groundTruth,
          fallbackReason: "validation-failed",
        };

    // Only fully-verified envelopes are worth serving twice. Insertion-order
    // eviction keeps the map bounded; the presets are re-cached on their
    // next request if ever evicted.
    if (envelope.source === "llm" && envelope.validation?.ok) {
      if (reportCache.size >= REPORT_CACHE_MAX) {
        const oldest = reportCache.keys().next().value;
        if (oldest !== undefined) reportCache.delete(oldest);
      }
      reportCache.set(cacheKey, envelope);
    }
    return res.json(envelope);
  });

  // ── Feedback API ───────────────────────────────────────────────────────────
  app.post("/api/feedback", rateLimit("feedback", 10, 60_000), async (req, res) => {
    const { message, email, rating } = req.body;

    const trimmedMessage = typeof message === "string" ? message.trim() : "";
    if (!trimmedMessage) {
      return res.status(400).json({ error: "Feedback message cannot be empty." });
    }
    if (trimmedMessage.length > 5000) {
      return res.status(400).json({ error: "Feedback message is too long (max 5000 characters)." });
    }

    // Email is optional; validate only if the user chose to attach one.
    let fromEmail: string | null = null;
    if (email && typeof email === "string" && email.trim()) {
      const candidate = email.trim();
      if (candidate.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) {
        return res.status(400).json({ error: "Please enter a valid email address or leave it blank to stay anonymous." });
      }
      fromEmail = candidate;
    }

    // Rating is optional; clamp to 1–5 if present.
    let ratingValue: number | null = null;
    if (rating !== undefined && rating !== null && rating !== 0) {
      const r = Math.round(Number(rating));
      if (!Number.isNaN(r) && r >= 1 && r <= 5) ratingValue = r;
    }

    try {
      await sendFeedbackEmail(trimmedMessage, ratingValue, fromEmail);
      return res.json({
        success: true,
        message: fromEmail
          ? "Thank you! Your feedback has been sent — we may reach out at the email you provided."
          : "Thank you! Your anonymous feedback has been sent.",
      });
    } catch (err: any) {
      console.error("Failed to send feedback:", err);
      return res.status(500).json({ error: "Could not send feedback. Please try again later." });
    }
  });

  // Serve compiled DMG file
  app.get("/api/download/dmg", rateLimit("dmg", 10, 60_000), async (req, res) => {
    try {
      // In Cloud Run, stream from GCS
      if (!process.env.ELECTRON_USER_DATA_PATH && GCS_BUCKET) {
        const { Storage } = await import('@google-cloud/storage');
        const file = new Storage().bucket(GCS_BUCKET).file('Nash Equilibrium Simulator.dmg');
        const [exists] = await file.exists();
        if (exists) {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Disposition', 'attachment; filename="Nash Equilibrium Simulator.dmg"');
          file.createReadStream().pipe(res);
          return;
        }
      }

      // Local / Electron: look in dist-electron/
      const distElectronPath = path.join(process.cwd(), "dist-electron");
      if (fs.existsSync(distElectronPath)) {
        const files = fs.readdirSync(distElectronPath);
        const dmgFile = files.find(f => f.toLowerCase().endsWith(".dmg"));
        if (dmgFile) {
          return res.download(path.join(distElectronPath, dmgFile), dmgFile);
        }
      }

      return res.status(404).json({
        error: "DMG Not Found",
        message: "No compiled macOS .dmg file found. You can package this app locally by running 'npm run electron:dist' on your Mac."
      });
    } catch (error: any) {
      console.error("Error serving DMG:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Register Endpoint
  app.post("/api/auth/register", rateLimit("register", 8, 60_000), async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password are required." });
    }
    const usernameTrimmed = cleanText(username, 40);
    if (!usernameTrimmed) {
      return res.status(400).json({ error: "Username is required." });
    }

    // Password validation: At least 8 characters, with at least one uppercase and one lowercase letter
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters long and contain at least one uppercase and one lowercase letter."
      });
    }

    const emailTrimmed = email.trim().toLowerCase();
    const db = loadDB();
    const isElectron = !!process.env.ELECTRON_USER_DATA_PATH;

    // Check for duplicate username (case-insensitive)
    const usernameTaken = db.users.find(
      u => u.username.trim().toLowerCase() === usernameTrimmed.toLowerCase()
        && u.email.trim().toLowerCase() !== emailTrimmed
    );
    if (usernameTaken) {
      return res.status(400).json({ error: "That username is already taken. Please choose a different one." });
    }

    // Check if user exists using trimmed, lowercased comparison
    const existingUser = db.users.find(u => u.email.trim().toLowerCase() === emailTrimmed);
    if (existingUser) {
      if (existingUser.isVerified) {
        return res.status(400).json({ error: "An account with this email already exists." });
      }

      // If we are in Electron local mode, mark them verified instantly and save
      if (isElectron) {
        existingUser.isVerified = true;
        existingUser.username = usernameTrimmed;
        existingUser.passwordHash = hashPassword(password);
        saveDB(db);
        return res.json({
          success: true,
          message: "Local account created successfully! You are ready to log in.",
          autoVerified: true
        });
      }

      // If of the unverified user on the website, refresh code
      const updatedCode = makeCode();
      existingUser.username = usernameTrimmed;
      existingUser.passwordHash = hashPassword(password);
      existingUser.verificationCode = updatedCode;
      existingUser.verificationCodeExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
      existingUser.verificationCodeAttempts = undefined; // fresh code → fresh attempt budget
      saveDB(db);

      let emailResult;
      let emailErrorMsg = null;
      try {
        emailResult = await sendVerificationEmail(emailTrimmed, updatedCode, usernameTrimmed);
      } catch (err: any) {
        emailErrorMsg = err.message;
      }

      if (emailErrorMsg) {
        return res.status(500).json({
          error: `Could not send verification email: ${emailErrorMsg}. Please check your server SMTP settings.`
        });
      }

      return res.json({
        success: true,
        message: "Unverified user exists. Sent a new 6-digit verification code to your email address.",
        email: emailTrimmed,
        via: emailResult?.via || "smtp",
        previewUrl: emailResult?.previewUrl || null
      });
    }

    // Direct verified path for local Electron apps
    if (isElectron) {
      const newUser: User = {
        id: makeId("u"),
        username: usernameTrimmed,
        email: emailTrimmed,
        passwordHash: hashPassword(password),
        isVerified: true,
        verificationCode: "",
        verificationCodeExpires: 0
      };
      db.users.push(newUser);
      saveDB(db);
      return res.json({
        success: true,
        message: "Local account created successfully! You are ready to log in.",
        autoVerified: true
      });
    }

    const verificationCode = makeCode();
    const newUser: User = {
      id: makeId("u"),
      username: usernameTrimmed,
      email: emailTrimmed,
      passwordHash: hashPassword(password),
      isVerified: false,
      verificationCode,
      verificationCodeExpires: Date.now() + 10 * 60 * 1000
    };

    db.users.push(newUser);
    saveDB(db);

    let emailResult;
    let emailErrorMsg = null;
    try {
      emailResult = await sendVerificationEmail(emailTrimmed, verificationCode, usernameTrimmed);
    } catch (err: any) {
      emailErrorMsg = err.message;
    }

    if (emailErrorMsg) {
      // Discard the unverified registration if SMTP is failing completely,
      // so we do not block subsequent attempts when SMTP config is updated.
      db.users = db.users.filter(u => u.email.trim().toLowerCase() !== emailTrimmed);
      saveDB(db);
      return res.status(500).json({
        error: `Could not send verification email: ${emailErrorMsg}. Please check your server SMTP settings.`
      });
    }

    res.json({
      success: true,
      message: "Registration successful! A 6-digit confirmation code has been sent to your email address.",
      email: emailTrimmed,
      via: emailResult?.via || "smtp",
      previewUrl: emailResult?.previewUrl || null
    });
  });

  // Verify Endpoint
  app.post("/api/auth/verify", rateLimit("verify", 12, 60_000), (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: "Email and verification code are required." });
    }

    const emailTrimmed = email.trim().toLowerCase();
    const db = loadDB();
    const userIndex = db.users.findIndex(u => u.email === emailTrimmed);

    if (userIndex === -1) {
      return res.status(404).json({ error: "No pending registration found for this email." });
    }

    const user = db.users[userIndex];

    if (user.isVerified) {
      return res.status(400).json({ error: "Email is already verified." });
    }

    if (user.verificationCodeExpires < Date.now()) {
      return res.status(400).json({ error: "Verification code has expired. Please register again to get a new code." });
    }

    const verifyCheck = verifyOneTimeCode(user, "verification", code);
    if (!verifyCheck.ok) {
      saveDB(db);
      return res.status(400).json({
        error: verifyCheck.locked
          ? "Too many incorrect attempts. Please register again to get a new code."
          : "Incorrect verification code."
      });
    }

    // Mark verified
    user.isVerified = true;
    saveDB(db);

    res.json({
      success: true,
      message: "Email verified successfully! You can now log in.",
      username: user.username
    });
  });

  // Login Endpoint
  app.post("/api/auth/login", rateLimit("login", 10, 60_000), (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email/username and password are required." });
    }

    const identifier = email.trim().toLowerCase();
    const db = loadDB();
    const candidate = db.users.find(u =>
      u.email === identifier || u.username.toLowerCase() === identifier
    );
    // Always run pbkdf2 (against a dummy hash on a miss) so a non-existent
    // account isn't revealed by a faster response — see DUMMY_PASSWORD_HASH.
    const passwordOk = verifyPassword(password, candidate ? candidate.passwordHash : DUMMY_PASSWORD_HASH);
    const user = candidate && passwordOk ? candidate : null;

    if (!user) {
      return res.status(401).json({ error: "Invalid email/username or password." });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        error: "Please complete email verification first.",
        needVerification: true,
        email: user.email
      });
    }

    if (needsPasswordRehash(user.passwordHash)) {
      user.passwordHash = hashPassword(password);
      saveDB(db);
    }
      // A local owner who signs in takes their games with them. Without this,
      // anything saved before making an account would be stranded behind an
      // identity the user can no longer reach.
      const adopted = adoptLocalGames(user.id);
      if (adopted) console.log(`[auth] adopted ${adopted} local game(s) into ${user.id}`);


    res.json({
      success: true,
      token: createAuthToken(user),
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });
  });

  // Get Current Session
  app.get("/api/auth/me", rateLimit("me", 60, 60_000), (req, res) => {
    const user = getAuthUser(req);

    if (!user) {
      return res.status(401).json({ error: "Invalid session." });
    }

    res.json({
      id: user.id,
      username: user.username,
      email: user.email
    });
  });

  // Forgot Password — send recovery code to email
  app.post("/api/auth/forgot-password", rateLimit("forgot", 6, 60_000), async (req, res) => {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email address is required." });
    }

    const emailTrimmed = email.trim().toLowerCase();
    const db = loadDB();
    const user = db.users.find(u => u.email.trim().toLowerCase() === emailTrimmed);

    // Always return a success-looking response to prevent email enumeration
    if (!user || !user.isVerified) {
      return res.json({
        success: true,
        message: "If an account with that email exists, a recovery code has been sent."
      });
    }

    const recoveryCode = makeCode();
    user.recoveryCode = recoveryCode;
    user.recoveryCodeExpires = Date.now() + 10 * 60 * 1000;
    user.recoveryCodeAttempts = undefined; // fresh code → fresh attempt budget
    saveDB(db);

    const isElectron = !!process.env.ELECTRON_USER_DATA_PATH;
    let emailErrorMsg = null;

    if (!isElectron) {
      try {
        await sendRecoveryEmail(emailTrimmed, recoveryCode);
      } catch (err: any) {
        emailErrorMsg = err.message;
      }
    }

    if (emailErrorMsg && !isElectron) {
      return res.status(500).json({ error: "Could not send recovery email. Please try again later." });
    }

    return res.json({
      success: true,
      message: isElectron
        ? `Recovery code generated locally. Use code: ${recoveryCode}`
        : "A 6-digit recovery code has been sent to your email address.",
      ...(isElectron ? { recoveryCode } : {})
    });
  });

  // Reset Password — verify code and set new password
  app.post("/api/auth/reset-password", rateLimit("reset", 8, 60_000), (req, res) => {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "Email, recovery code, and new password are required." });
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters long and contain at least one uppercase and one lowercase letter."
      });
    }

    const emailTrimmed = email.trim().toLowerCase();
    const db = loadDB();
    const user = db.users.find(u => u.email.trim().toLowerCase() === emailTrimmed);

    if (!user) {
      return res.status(404).json({ error: "No account found for this email." });
    }

    if (!user.recoveryCode || !user.recoveryCodeExpires) {
      return res.status(400).json({ error: "No active recovery request found. Please request a new code." });
    }

    if (user.recoveryCodeExpires < Date.now()) {
      return res.status(400).json({ error: "Recovery code has expired. Please request a new one." });
    }

    const recoveryCheck = verifyOneTimeCode(user, "recovery", code);
    if (!recoveryCheck.ok) {
      saveDB(db);
      return res.status(400).json({
        error: recoveryCheck.locked
          ? "Too many incorrect attempts. Please request a new recovery code."
          : "Incorrect recovery code."
      });
    }

    user.passwordHash = hashPassword(newPassword);
    user.recoveryCode = undefined;
    user.recoveryCodeExpires = undefined;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1; // invalidate existing sessions
    saveDB(db);

    res.json({ success: true, message: "Password reset successfully! You can now log in with your new password." });
  });

  // Request account deletion code
  app.post("/api/auth/delete-request", rateLimit("delete-request", 6, 60_000), async (req, res) => {
    const db = loadDB();
    const user = getAuthUser(req);

    if (!user) {
      return res.status(401).json({ error: "Invalid session." });
    }

    const deleteCode = makeCode();
    user.deleteCode = deleteCode;
    user.deleteCodeExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
    user.deleteCodeAttempts = undefined; // fresh code → fresh attempt budget

    saveDB(db);

    let emailErrorMsg = null;
    try {
      await sendDeleteEmail(user.email, deleteCode, user.username);
    } catch (err: any) {
      emailErrorMsg = err.message;
    }

    const isElectron = !!process.env.ELECTRON_USER_DATA_PATH;
    if (emailErrorMsg && !isElectron) {
      return res.status(500).json({ error: "Could not send deletion confirmation email. Please try again later." });
    }

    return res.json({
      success: true,
      message: isElectron && emailErrorMsg
        ? `A security confirmation code was generated locally: Enter code ${deleteCode} below.`
        : "A 6-digit confirmation security code has been sent to your email address.",
      ...(isElectron ? { deleteCode } : {})
    });
  });

  // Verify deletion code and delete account
  app.post("/api/auth/delete-confirm", rateLimit("delete-confirm", 8, 60_000), (req, res) => {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: "Verification code is required." });
    }

    const db = loadDB();
    const authUser = getAuthUser(req);
    const userIndex = authUser ? db.users.findIndex(u => u.id === authUser.id) : -1;

    if (userIndex === -1) {
      return res.status(401).json({ error: "Invalid session or user not found." });
    }

    const user = db.users[userIndex];

    if (!user.deleteCode || !user.deleteCodeExpires) {
      return res.status(400).json({ error: "No active deletion request found for this account." });
    }

    if (user.deleteCodeExpires < Date.now()) {
      return res.status(400).json({ error: "Deletion confirmation code has expired. Please request a new one." });
    }

    const deleteCheck = verifyOneTimeCode(user, "delete", code);
    if (!deleteCheck.ok) {
      saveDB(db);
      return res.status(400).json({
        error: deleteCheck.locked
          ? "Too many incorrect attempts. Please request a new confirmation code."
          : "Incorrect verification code."
      });
    }

    const userEmail = user.email.toLowerCase().trim();

    // Clean up corresponding games saved by team space
    db.games = db.games.filter(g => g.userId !== user.id);

    // Completely wipe out any user records matching this email or user ID
    db.users = db.users.filter(u => u.email.toLowerCase().trim() !== userEmail && u.id !== user.id);

    saveDB(db);

    res.json({
      success: true,
      message: "Your account and all saved game profiles have been successfully deleted from our records."
    });
  });

  // ── Custom Saved Games API ─────────────────────────────────────────────────

  // Get User's Custom Games
  app.get("/api/games", rateLimit("games-read", 60, 60_000, 'hosted-only'), (req, res) => {
    const user = getGameOwner(req);
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    const db = loadDB();
    const userGames = db.games.filter(g => g.userId === user.id);
    res.json(userGames);
  });

  // Create/Save a Custom Game
  app.post("/api/games", rateLimit("games-write", 20, 60_000, 'hosted-only'), (req, res) => {
    const db = loadDB();
    const user = getGameOwner(req);
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    const { name, description, payoffs } = req.body;
    const cleanName = cleanText(name, 80);
    const cleanDescription = cleanText(description, 800);
    const cleanMatrix = cleanPayoffs(payoffs);
    if (!cleanName || !cleanMatrix) {
      return res.status(400).json({ error: "Game name and payoffs matrix are required." });
    }

    const newGame: SavedGame = {
      id: makeId("g"),
      userId: user.id,
      name: cleanName,
      description: cleanDescription || `Custom payoff matrix saved by ${user.username}`,
      payoffs: cleanMatrix,
      createdAt: new Date().toISOString(),
      ...cleanLabels(req.body),
      ...cleanColorTerms(req.body, true)
    };

    db.games.push(newGame);
    saveDB(db);

    res.json({
      success: true,
      message: "Game saved successfully!",
      game: newGame
    });
  });

  // Update a Custom Game's story (name / description / option labels).
  //
  // Exists so an invented scenario can be kept ON the game the user already
  // saved. Without it the only way to retain a scenario was to save a second
  // copy of the same matrix, and the original would keep getting a freshly
  // invented story on every explanation.
  //
  // Payoffs are deliberately NOT updatable here: changing them would silently
  // invalidate the description, which is the exact mismatch this feature exists
  // to prevent. Editing a matrix stays a save-as-new operation.
  app.patch("/api/games/:id", rateLimit("games-write", 20, 60_000, 'hosted-only'), (req, res) => {
    const user = getGameOwner(req);
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }
    const db = loadDB();
    const game = db.games.find(g => g.id === req.params.id);
    if (!game) {
      return res.status(404).json({ error: "Game not found." });
    }
    if (game.userId !== user.id) {
      return res.status(403).json({ error: "You are not authorized to edit this game." });
    }

    // The edit dialog sends every field, so it opts into clearing; the
    // save-this-scenario path sends only what it means to change.
    const allowClear = req.body?.allowClear === true;
    const nextName = cleanText(req.body?.name, 80);
    const nextDescription = cleanText(req.body?.description, 800);
    const nextLabels = cleanLabels(req.body, allowClear);
    const nextTerms = cleanColorTerms(req.body, allowClear);
    // Labels count as an update in their own right. Keeping an invented
    // scenario means writing its four option names onto the game, and that has
    // to be a valid PATCH on its own — otherwise a scenario whose description
    // came back empty would be rejected as "nothing to update" and the labels
    // would be lost with it.
    if (!nextName && !nextDescription && Object.keys(nextLabels).length === 0
        && Object.keys(nextTerms).length === 0) {
      return res.status(400).json({ error: "Nothing to update." });
    }
    if (nextName) game.name = nextName;
    // Description follows the same rule as the labels: normally an empty value
    // means "not supplied", but an edit that deliberately empties the box must
    // be able to remove the text.
    if (nextDescription || (allowClear && "description" in req.body)) game.description = nextDescription;
    Object.assign(game, nextLabels, nextTerms);
    saveDB(db);

    res.json({ success: true, message: "Game updated.", game });
  });

  // Delete a Custom Game
  app.delete("/api/games/:id", rateLimit("games-delete", 30, 60_000, 'hosted-only'), (req, res) => {
    const user = getGameOwner(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized access." });
    }
    const gameId = req.params.id;
    const db = loadDB();

    const gameIndex = db.games.findIndex(g => g.id === gameId);
    if (gameIndex === -1) {
      return res.status(404).json({ error: "Game not found." });
    }

    const game = db.games[gameIndex];
    if (game.userId !== user.id) {
      return res.status(403).json({ error: "You are not authorized to delete this game." });
    }

    db.games.splice(gameIndex, 1);
    saveDB(db);

    res.json({
      success: true,
      message: "Game deleted successfully."
    });
  });


  // ── Vite / Frontend static file host ───────────────────────────────────────

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In production, only serve frontend if dist files exist (optional)
    // In packaged Electron, process.cwd() is not the app folder — use __dirname
    // (server.cjs lives inside dist/, so __dirname IS the dist folder)
    const distPath = process.env.ELECTRON_USER_DATA_PATH
      ? __dirname
      : path.join(process.cwd(), 'dist');
    if (fs.existsSync(path.join(distPath, 'index.html'))) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      // No frontend files - just serve API
      console.log("Frontend files not found, serving API-only mode");
      // Fallback 404 for unknown routes (after API routes)
      app.use((req, res) => {
        res.status(404).json({ error: "Not found" });
      });
    }
  }

  // Legacy accounts store passwords as reversible base64 (pre-pbkdf2). They're
  // upgraded on next successful login, but dormant rows stay plaintext-equivalent
  // if db.json/GCS leaks. Surface the count so operators can force a reset.
  const legacyPwCount = loadDB().users.filter(u => needsPasswordRehash(u.passwordHash)).length;
  if (legacyPwCount > 0) {
    console.warn(`SECURITY: ${legacyPwCount} account(s) still use legacy (reversible) password hashes. Consider forcing a password reset for these users.`);
  }

  // Dynamic port assignment with automatic fallback in case of port collisions
  const startListening = (port: number) => {
    // BIND HOST IS A DEFECT FIX, not a preference.
    //
    // On macOS, bind(0.0.0.0:P) SUCCEEDS while another process holds
    // 127.0.0.1:P — no EADDRINUSE — and the more specific bind then wins every
    // loopback connection. In the desktop app that had two consequences. The
    // API was reachable from the LOCAL NETWORK: verified against a running
    // installed copy, http://<lan-ip>:14321/ answered 200, and on a build with
    // the offline model bundled a POST to /api/report from another machine
    // returned a freshly invented scenario. CORS is irrelevant there; a direct
    // request is not a browser. And the port-retry loop below could
    // "successfully" bind a port another local server already owned, log
    // nothing, and leave the window talking to that other server.
    //
    // Binding the loopback at the SAME specificity makes the kernel refuse the
    // second bind, so the retry actually advances. Cloud Run must still bind
    // 0.0.0.0 or the container is unreachable, hence the gate on IS_ELECTRON.
    const host = process.env.IS_ELECTRON === 'true' ? '127.0.0.1' : '0.0.0.0';
    const serverInstance = app.listen(port, host, () => {
      console.log(`Express server running on http://${host}:${port}`);
      if (process.env.IS_ELECTRON === 'true') {
        (global as any).expressPort = port;
        if ((global as any).onExpressListening) {
          (global as any).onExpressListening(port);
        }
      }
    });

    serverInstance.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${port} is already in use. Retrying with port ${port + 1}...`);
        if (process.env.IS_ELECTRON === 'true') {
          startListening(port + 1);
        } else {
          console.error(`EADDRINUSE: Port ${port} is occupied.`);
          process.exit(1);
        }
      } else {
        console.error("Server bind error:", err);
      }
    });
  };

  const initialPort = parseInt(process.env.PORT || "3000", 10);
  await initDB();
  startListening(initialPort);
}

startServer();

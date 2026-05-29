/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

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
}

interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string; // stored simply for sandbox safety (base64 or direct)
  isVerified: boolean;
  verificationCode: string;
  verificationCodeExpires: number;
}

interface DB {
  users: User[];
  games: SavedGame[];
}

const DB_FILE = path.join(process.cwd(), "db.json");

// Helper to load DB
function loadDB(): DB {
  if (!fs.existsSync(DB_FILE)) {
    const fresh: DB = { users: [], games: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2), "utf-8");
    return fresh;
  }
  try {
    const data = fs.readFileSync(DB_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    console.error("Error reading db.json, resetting database", err);
    return { users: [], games: [] };
  }
}

// Helper to save DB
function saveDB(db: DB) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing db.json", err);
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
      tls: {
        rejectUnauthorized: false
      }
    });
  }
  return null;
}

// Send real/sandbox email verification
async function sendVerificationEmail(email: string, code: string, username: string) {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || `"Nash Equilibrium Simulator" <noreply@example.com>`;

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; display: inline-block; margin-bottom: 8px;">🧭</span>
        <h2 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 800; tracking-tight: -0.025em;">Nash Equilibrium Simulator</h2>
      </div>
      <p style="color: #334155; font-size: 15px; line-height: 1.6; margin-bottom: 16px;">Hello <strong>@${username}</strong>,</p>
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

  let smtpError: string | null = null;

  if (transporter) {
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
      smtpError = err.message;
      // Do not throw! Fallback to ethereal so the user isn't blocked.
    }
  }

  // Fallback to Ethereal-sandbox SMTP connection
  try {
    console.log("No working custom SMTP connection. Spinning up an Ethereal-sandbox SMTP connection...");
    const testAccount = await nodemailer.createTestAccount();
    const etherealTransporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });

    const info = await etherealTransporter.sendMail({
      from: '"Nash Equilibrium Simulator" <noreply@ethereal.email>',
      to: email,
      subject: `Your Nash Sim Verification Code: ${code}`,
      text: `Your Nash Sim verification code is: ${code}. It expires in 10 minutes.`,
      html: htmlContent,
    });

    const previewUrl = nodemailer.getTestMessageUrl(info);
    console.log(`
=============================================================
[SANDBOX EMAIL DELIVERED via ETHEREAL]
To: ${email}
Subject: Nash Sim Verification Code
Verification Code: ${code}
View rendered message: ${previewUrl}
=============================================================
    `);

    return {
      success: true,
      via: "ethereal",
      smtpError: smtpError || undefined, // Include the SMTP error to show help in UI
      previewUrl: previewUrl || undefined,
      messageId: info.messageId,
    };
  } catch (err: any) {
    console.error("Ethereal test mailbox auto-creation failed, using console logging fallback:", err);
    return {
      success: false,
      via: "none",
      smtpError: smtpError || undefined,
      error: err.message
    };
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Parse JSON bodies
  app.use(express.json());

  // ── Authentication API ─────────────────────────────────────────────────────

  // Express API health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Register Endpoint
  app.post("/api/auth/register", async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password are required." });
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

    // Check if user exists
    const existingUser = db.users.find(u => u.email === emailTrimmed);
    if (existingUser) {
      if (existingUser.isVerified) {
        return res.status(400).json({ error: "An account with this email already exists." });
      }
      
      // If of the unverified user, refresh code
      const updatedCode = Math.floor(100000 + Math.random() * 900000).toString();
      existingUser.username = username;
      existingUser.passwordHash = Buffer.from(password).toString("base64"); // Simple hashing
      existingUser.verificationCode = updatedCode;
      existingUser.verificationCodeExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
      saveDB(db);

      let emailResult;
      try {
        emailResult = await sendVerificationEmail(emailTrimmed, updatedCode, username);
      } catch (err: any) {
        return res.status(500).json({ error: `Failed to dispatch confirmation email: ${err.message}` });
      }

      return res.json({
        success: true,
        message: "Unverified user exists. Sent a new 6-digit verification code to your email address.",
        email: emailTrimmed,
        via: emailResult?.via || "smtp",
        previewUrl: emailResult?.previewUrl || null,
        smtpError: emailResult?.smtpError || null
      });
    }

    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const newUser: User = {
      id: "u_" + Math.random().toString(36).substring(2, 11),
      username,
      email: emailTrimmed,
      passwordHash: Buffer.from(password).toString("base64"),
      isVerified: false,
      verificationCode,
      verificationCodeExpires: Date.now() + 10 * 60 * 1000
    };

    db.users.push(newUser);
    saveDB(db);

    let emailResult;
    try {
      emailResult = await sendVerificationEmail(emailTrimmed, verificationCode, username);
    } catch (err: any) {
      return res.status(500).json({ error: `Registration recorded, but failed to send verification email: ${err.message}` });
    }

    res.json({
      success: true,
      message: "Registration successful! A 6-digit code has been sent to your email.",
      email: emailTrimmed,
      via: emailResult?.via || "smtp",
      previewUrl: emailResult?.previewUrl || null,
      smtpError: emailResult?.smtpError || null
    });
  });

  // Verify Endpoint
  app.post("/api/auth/verify", (req, res) => {
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

    if (user.verificationCode !== code) {
      return res.status(400).json({ error: "Incorrect verification code." });
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
  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const emailTrimmed = email.trim().toLowerCase();
    const db = loadDB();
    const hashedPassword = Buffer.from(password).toString("base64");
    const user = db.users.find(u => u.email === emailTrimmed && u.passwordHash === hashedPassword);

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        error: "Please complete email verification first.",
        needVerification: true,
        email: user.email
      });
    }

    res.json({
      success: true,
      token: user.id,
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });
  });

  // Get Current Session
  app.get("/api/auth/me", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized access." });
    }
    const token = authHeader.split(" ")[1];
    const db = loadDB();
    const user = db.users.find(u => u.id === token);

    if (!user) {
      return res.status(401).json({ error: "Invalid session." });
    }

    res.json({
      id: user.id,
      username: user.username,
      email: user.email
    });
  });

  // ── Custom Saved Games API ─────────────────────────────────────────────────

  // Get User's Custom Games
  app.get("/api/games", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized access." });
    }
    const token = authHeader.split(" ")[1];
    const db = loadDB();

    // Check user validity
    const userExists = db.users.some(u => u.id === token);
    if (!userExists) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    const userGames = db.games.filter(g => g.userId === token);
    res.json(userGames);
  });

  // Create/Save a Custom Game
  app.post("/api/games", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized access." });
    }
    const token = authHeader.split(" ")[1];
    const db = loadDB();

    const user = db.users.find(u => u.id === token);
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    const { name, description, payoffs } = req.body;
    if (!name || !payoffs) {
      return res.status(400).json({ error: "Game name and payoffs matrix are required." });
    }

    const newGame: SavedGame = {
      id: "g_" + Math.random().toString(36).substring(2, 11),
      userId: token,
      name,
      description: description || `Custom payoff matrix saved by ${user.username}`,
      payoffs,
      createdAt: new Date().toISOString()
    };

    db.games.push(newGame);
    saveDB(db);

    res.json({
      success: true,
      message: "Game saved successfully!",
      game: newGame
    });
  });

  // Delete a Custom Game
  app.delete("/api/games/:id", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized access." });
    }
    const token = authHeader.split(" ")[1];
    const gameId = req.params.id;
    const db = loadDB();

    const gameIndex = db.games.findIndex(g => g.id === gameId);
    if (gameIndex === -1) {
      return res.status(404).json({ error: "Game not found." });
    }

    const game = db.games[gameIndex];
    if (game.userId !== token) {
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
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Express server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

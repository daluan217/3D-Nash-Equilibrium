// Shared harness plumbing for STRUCT-DESKTOP-19.
//
// WHY THIS EXISTS: the shared machine carries orphaned `dist/server.cjs`
// processes from dead agents' worktrees, and this server FALLS FORWARD to the
// next port on EADDRINUSE instead of failing. Both together mean a harness can
// silently measure ANOTHER worktree's build: red pass 1's first three runs
// printed `assets/index-BsYlzJ8G.js` — wt-red-app-18's bundle at 542ea91 —
// while claiming to test this worktree. Every server this library starts is
// verified to be OURS by comparing the served bundle to our own dist/index.html
// before a single assertion runs.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function expectedBundle(WT) {
  const html = readFileSync(join(WT, 'dist/index.html'), 'utf-8');
  const m = html.match(/assets\/index-[^."]+\.js/);
  if (!m) throw new Error('no bundle reference in dist/index.html — build first');
  return m[0];
}

/**
 * Start a server from THIS worktree's dist and prove the port really answers
 * with it. `mode` is 'desktop' (IS_ELECTRON + a throwaway user-data dir, the
 * packaged-app shape) or 'hosted' (no IS_ELECTRON, DB under the empty cwd).
 * Always: env -i-shaped env, EMPTY cwd so dotenv cannot reach the repo .env.
 */
export async function startOwnServer(WT, port, { mode = 'desktop', tag = 'srv', extraEnv = {}, reuseDataDir = null } = {}) {
  const dataDir = reuseDataDir ?? mkdtempSync(join(tmpdir(), `nash-d19-${tag}-`));
  const cwd = mkdtempSync(join(tmpdir(), `nash-d19-${tag}-cwd-`));
  const env = {
    PATH: process.env.PATH, HOME: dataDir, NODE_ENV: 'production', PORT: String(port),
    ...(mode === 'desktop' ? { IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: dataDir } : {}),
    ...extraEnv,
  };
  const child = spawn('node', [join(WT, 'dist/server.cjs')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  // A harness that throws mid-run used to leave its server alive, squatting the
  // port for every later run (and for the next agent). Reap on ANY exit path.
  const reap = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
  process.on('exit', reap);
  process.on('uncaughtException', (e) => { reap(); console.error(e); process.exit(1); });
  process.on('unhandledRejection', (e) => { reap(); console.error(e); process.exit(1); });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${port}`;
  let up = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/health')).ok) { up = true; break; } } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) { child.kill('SIGKILL'); throw new Error(`server never answered on ${port}. log tail: ${log.slice(-800)}`); }
  const want = expectedBundle(WT);
  const served = (await (await fetch(base)).text()).match(/assets\/index-[^."]+\.js/)?.[0];
  if (served !== want) {
    child.kill('SIGKILL');
    throw new Error(`PORT ${port} IS NOT OURS: serves ${served}, this worktree built ${want}. `
      + `An orphaned server from another worktree holds the port and this process fell forward to another one. `
      + `Pick a free port. log tail: ${log.slice(-400)}`);
  }
  return { child, base, dataDir, cwd, getLog: () => log, bundle: served };
}

export async function waitPortDead(port) {
  for (let i = 0; i < 80; i++) {
    try { await fetch(`http://localhost:${port}/api/health`); } catch { return true; }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Register + log in through the real UI. Polls for the login view rather than
 *  assuming a timing: the dialog swaps views as the register response lands. */
export async function registerAndLogin(page, { u, e, p }) {
  const authDlg = page.locator('[role="dialog"][aria-label="Account"]');
  await page.locator('header').getByRole('button', { name: /sign in.*sign up/i }).click();
  await authDlg.waitFor({ state: 'visible' });
  await authDlg.getByRole('button', { name: /^sign up$/i }).click().catch(() => {});
  await authDlg.locator('input[placeholder="game_theorist"]').waitFor({ state: 'visible', timeout: 8000 });
  await authDlg.locator('input[placeholder="game_theorist"]').fill(u);
  await authDlg.locator('input[placeholder="john@example.com"]').fill(e);
  await authDlg.locator('input[placeholder="••••••••"]').first().fill(p);
  await authDlg.locator('input[placeholder="••••••••"]').nth(1).fill(p);
  await authDlg.getByRole('button', { name: /register account/i }).click();
  const loginEmail = authDlg.locator('input[placeholder*="example.com or username"]');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    if (await loginEmail.isVisible().catch(() => false)) break;
    await authDlg.getByRole('button', { name: /^log in$/i }).click({ timeout: 1000 }).catch(() => {});
  }
  await loginEmail.waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);
  await loginEmail.fill(e);
  await authDlg.locator('input[placeholder="••••••••"]').first().fill(p);
  const rp = page.waitForResponse((r) => r.url().includes('/api/auth/login'));
  await authDlg.getByRole('button', { name: /^login$/i }).click();
  const resp = await rp;
  await authDlg.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  const offer = page.locator('[role="dialog"][aria-label="Games saved on this device"]');
  if (await offer.isVisible({ timeout: 700 }).catch(() => false)) {
    await page.getByRole('button', { name: /leave .* on this device/i }).click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  return resp;
}

export const ELECTRON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) nash-equilibrium-simulator/0.0.193 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';

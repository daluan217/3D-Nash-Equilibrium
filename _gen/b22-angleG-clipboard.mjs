// Re-attacking my OWN angle-G fix: the allowlist's single entry exists so the
// app's copy buttons keep working. Asserting the permission NAME is not the
// same as the feature working, so this exercises the real call the app makes
// (`navigator.clipboard.writeText`, DownloadModal's copy handler) inside the
// packaged renderer and reads the text back.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22/dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT = Number(process.argv[2] || 4899);
const udd = mkdtempSync(join(tmpdir(), 'b22-clip-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const child = spawn(APP, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`], {
  cwd: '/tmp',
  env: { IS_ELECTRON: 'true', NODE_ENV: 'production', PATH: process.env.PATH, HOME: process.env.HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { await sleep(500); }
}
if (!browser) { child.kill(); console.error('CDP never came up'); process.exit(1); }
const ctx = browser.contexts()[0];
let page;
for (let i = 0; i < 30 && !page; i++) { page = ctx.pages().find(p => p.url().startsWith('http://127.0.0.1')); if (!page) await sleep(500); }
if (!page) { child.kill(); console.error('app page never appeared'); process.exit(1); }

const MARKER = 'b22-clipboard-' + Date.now();
const wrote = await page.evaluate(async (m) => {
  try { await navigator.clipboard.writeText(m); return 'ok'; }
  catch (e) { return 'threw: ' + e.name + ': ' + e.message; }
}, MARKER);
console.log('clipboard.writeText (the call DownloadModal makes):', wrote);

// Read back from the OS pasteboard via the main process — the renderer's own
// clipboard.readText is DENIED by the policy, so reading it there would only
// re-measure the deny, not whether the write landed.
let pasteboard = 'unread';
try {
  const { execSync } = await import('node:child_process');
  pasteboard = execSync('pbpaste', { encoding: 'utf8' });
} catch (e) { pasteboard = 'pbpaste failed: ' + e.message; }
console.log('pbpaste sees the marker:', pasteboard.includes(MARKER));

const ok = wrote === 'ok' && pasteboard.includes(MARKER);
console.log(ok
  ? '\nEMPTY: the permission policy did not break the app\'s own copy-to-clipboard'
  : '\n>>> HIT: the permission allowlist broke navigator.clipboard.writeText');
process.exitCode = ok ? 0 : 2;
await browser.close().catch(() => {});
child.kill();

// BLUE-LOOP-DESKTOP-22 — invented angle I: the contextBridge surface as seen
// from HOSTILE CHILD CONTEXTS, not just from the top frame.
//
// The brief calls angle 1 (contextBridge: wrong types, huge payloads, rapid
// repeats, calls from iframe/srcdoc/about:blank children) the thinnest part of
// a Sonnet red's coverage. Earlier sweeps exercised the top frame. This one
// asks the question those did not: does `window.nashDesktop` exist in a
// srcdoc/about:blank/data: child, and can a child drive the main process?
//
// Two invariants:
//   1. contextBridge exposure must not reach a child frame the app never made.
//   2. No payload from any frame may crash the main process or leave the window
//      in a state the app did not choose.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.argv[2] ||
  '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22/dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT = Number(process.argv[3] || 4896);
const udd = mkdtempSync(join(tmpdir(), 'b22-bridge-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const child = spawn(APP, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`], {
  cwd: '/tmp',
  env: { IS_ELECTRON: 'true', NODE_ENV: 'production', PATH: process.env.PATH, HOME: process.env.HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let mainLog = '';
child.stdout.on('data', d => { mainLog += d; });
child.stderr.on('data', d => { mainLog += d; });

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { await sleep(500); }
}
if (!browser) { child.kill(); console.error('CDP never came up:\n' + mainLog.slice(-600)); process.exit(1); }
const ctx = browser.contexts()[0];
let page;
for (let i = 0; i < 30 && !page; i++) { page = ctx.pages().find(p => p.url().startsWith('http://127.0.0.1')); if (!page) await sleep(500); }
if (!page) { child.kill(); console.error('app page never appeared'); process.exit(1); }

const findings = [];
const hit = (what) => { findings.push(what); console.log(`>>> HIT ${what}`); };

// ── 1. Is the bridge reachable from child contexts the app never created? ────
const exposure = await page.evaluate(async () => {
  const out = {};
  out.topFrame = typeof window.nashDesktop;
  const mk = (setup) => new Promise((res) => {
    const f = document.createElement('iframe');
    setup(f);
    f.style.cssText = 'position:fixed;left:-9999px;width:10px;height:10px';
    f.onload = () => {
      let v;
      try { v = typeof f.contentWindow.nashDesktop; } catch (e) { v = 'cross-origin-throw: ' + e.name; }
      f.remove(); res(v);
    };
    document.body.appendChild(f);
    setTimeout(() => { try { f.remove(); } catch {} res('never-loaded'); }, 3000);
  });
  out.srcdoc = await mk((f) => { f.srcdoc = '<p>x</p>'; });
  out.aboutBlank = await mk((f) => { f.src = 'about:blank'; });
  out.dataUrl = await mk((f) => { f.src = 'data:text/html,<p>x</p>'; });
  out.sandboxed = await mk((f) => { f.setAttribute('sandbox', 'allow-scripts'); f.srcdoc = '<p>x</p>'; });
  // A worker is another context that must not inherit the bridge.
  try {
    const b = new Blob(['self.postMessage(typeof self.nashDesktop)'], { type: 'text/javascript' });
    const w = new Worker(URL.createObjectURL(b));
    out.worker = await new Promise((res) => { w.onmessage = (e) => { w.terminate(); res(e.data); }; setTimeout(() => res('timeout'), 2000); });
  } catch (e) { out.worker = 'worker-blocked: ' + e.name; }
  return out;
});
for (const [k, v] of Object.entries(exposure)) console.log(`bridge in ${k.padEnd(12)} ${v}`);
// The top frame SHOULD have it (that is the feature, and a control: if this is
// 'undefined' the probe is testing a page where nothing is exposed and every
// 'undefined' below would be vacuous).
if (exposure.topFrame !== 'object') { console.error('\n>>> INCONCLUSIVE: the bridge is absent from the TOP frame; nothing below discriminates'); child.kill(); process.exit(3); }
for (const k of ['srcdoc', 'aboutBlank', 'dataUrl', 'sandboxed', 'worker']) {
  if (exposure[k] === 'object') hit(`the contextBridge is exposed in a ${k} child context`);
}

// ── 2. Hostile payloads through the bridge, from the top frame ──────────────
const before = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
const payloads = await page.evaluate(async () => {
  const send = (v) => { try { window.nashDesktop.setBackgroundColor(v); return 'sent'; } catch (e) { return 'threw: ' + e.name; } };
  const out = {};
  out.wrongTypeNumber = send(123);
  out.wrongTypeObject = send({ toString() { return '#ff0000'; } });
  out.throwingToString = send({ toString() { throw new Error('boom'); } });
  out.nullish = send(null);
  out.arr = send(['#ff0000']);
  out.huge = send('#' + 'a'.repeat(5_000_000));
  out.cssInjection = send('#000000; background: url(http://evil.invalid/x)');
  out.notHex = send('red');
  out.shortHex = send('#fff');
  out.newlineSmuggle = send('#000000\n#ff0000');
  // Rapid repeats: 2000 sends with no await, the shape that floods the IPC queue.
  let n = 0;
  for (let i = 0; i < 2000; i++) { try { window.nashDesktop.setBackgroundColor('#0' + (i % 10) + '0000'.slice(0, 4)); n++; } catch {} }
  out.floodSent = n;
  return out;
});
for (const [k, v] of Object.entries(payloads)) console.log(`payload ${k.padEnd(18)} ${String(v).slice(0, 60)}`);

// ── 3. Did any of it hurt? ──────────────────────────────────────────────────
await sleep(1500);
const alive = await page.evaluate(() => ({
  responsive: typeof document.title === 'string',
  title: document.title,
  hasRoot: !!document.querySelector('#root, [data-reactroot], main'),
})).catch((e) => ({ responsive: false, error: String(e.name) }));
console.log('renderer after the barrage:', JSON.stringify(alive));
if (!alive.responsive) hit('the renderer stopped responding after the bridge barrage');

const mainAlive = !child.killed && child.exitCode === null;
console.log('main process alive:', mainAlive, '| exitCode:', child.exitCode);
if (!mainAlive) hit('the MAIN process died from a bridge payload');
const uncaught = /Uncaught Exception|UnhandledPromiseRejection|TypeError: .*color/i.test(mainLog);
console.log('main log clean of uncaught/color errors:', !uncaught);
if (uncaught) hit('the main process logged an uncaught exception from a bridge payload');

// A real server request still works => the app is not merely "not crashed".
const health = await page.evaluate(async () => {
  try { const r = await fetch('/api/health'); return r.status; } catch (e) { return 'fetch-threw: ' + e.name; }
});
console.log('/api/health after the barrage:', health);
if (health !== 200) hit(`the app's own server stopped answering after the barrage (${health})`);

console.log('');
if (findings.length) { console.log(`>>> ${findings.length} HIT(s)`); process.exitCode = 2; }
else console.log('EMPTY: the bridge is top-frame only and survived every hostile payload');
await browser.close().catch(() => {});
child.kill();

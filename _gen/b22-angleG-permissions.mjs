// BLUE-LOOP-DESKTOP-22 — invented angle G: permission surface of the LIVE DMG.
//
// electron-builder's default Info.plist ships NSCameraUsageDescription /
// NSMicrophoneUsageDescription ("This app needs access to the camera"), and
// electron-main.cjs registers no setPermissionRequestHandler. Electron's default
// is to GRANT most renderer permission requests. Question this probe answers with
// a number, not a read: does the packaged app actually hand the renderer camera,
// microphone, geolocation, notifications, clipboard-read and display-capture?
//
// Shipping condition: the live 0.0.223 DMG copy, its own origin, CDP only.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/round22/dl/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const PORT = Number(process.argv[2] || 4894);
const udd = mkdtempSync(join(tmpdir(), 'b22-permg-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const child = spawn(APP, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`], {
  cwd: '/tmp',
  env: { IS_ELECTRON: 'true', NODE_ENV: 'production', PATH: process.env.PATH, HOME: process.env.HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });

let browser;
for (let i = 0; i < 40; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break; } catch {}
  await sleep(500);
}
if (!browser) { child.kill(); console.error('CDP never came up:\n' + log.slice(-800)); process.exit(1); }

const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().startsWith('http://127.0.0.1'));
for (let i = 0; i < 30 && !page; i++) { await sleep(500); page = ctx.pages().find(p => p.url().startsWith('http://127.0.0.1')); }
if (!page) { child.kill(); console.error('app page never appeared'); process.exit(1); }
console.log('origin:', new URL(page.url()).origin);

// Permissions API state, as the renderer sees it. `prompt` means Electron would
// have to decide; `granted` means it already decided yes.
const states = await page.evaluate(async () => {
  const names = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-write', 'midi'];
  const out = {};
  for (const name of names) {
    try { out[name] = (await navigator.permissions.query({ name })).state; }
    catch (e) { out[name] = 'query-threw: ' + e.name; }
  }
  return out;
});
for (const [k, v] of Object.entries(states)) console.log(`permissions.query ${k.padEnd(16)} ${v}`);

// The decisive test: actually REQUEST them. A grant here is Electron's default
// handler saying yes on behalf of an app that is an offline math tool.
// Bounded so a macOS TCC prompt cannot hang the probe.
const withTimeout = (fnSrc, ms) => page.evaluate(async ([src, t]) => {
  const run = (0, eval)(src);
  return await Promise.race([
    run().then(v => ({ outcome: v })),
    new Promise(r => setTimeout(() => r({ outcome: 'TIMEOUT (an OS prompt would land here)' }), t)),
  ]);
}, [fnSrc, ms]);

const results = {};
results.getUserMediaVideo = (await withTimeout(`async () => {
  try { const s = await navigator.mediaDevices.getUserMedia({video:true});
        const n = s.getTracks().length; s.getTracks().forEach(t=>t.stop()); return 'GRANTED tracks='+n; }
  catch (e) { return 'DENIED '+e.name; }
}`, 6000)).outcome;
results.getUserMediaAudio = (await withTimeout(`async () => {
  try { const s = await navigator.mediaDevices.getUserMedia({audio:true});
        const n = s.getTracks().length; s.getTracks().forEach(t=>t.stop()); return 'GRANTED tracks='+n; }
  catch (e) { return 'DENIED '+e.name; }
}`, 6000)).outcome;
results.geolocation = (await withTimeout(`async () => new Promise((res) => {
  navigator.geolocation.getCurrentPosition(() => res('GRANTED position'), (e) => res('DENIED code='+e.code), {timeout:4000});
})`, 6000)).outcome;
results.notifications = (await withTimeout(`async () => {
  try { return 'RESULT '+await Notification.requestPermission(); } catch (e) { return 'DENIED '+e.name; }
}`, 6000)).outcome;
results.displayCapture = (await withTimeout(`async () => {
  try { const s = await navigator.mediaDevices.getDisplayMedia({video:true});
        s.getTracks().forEach(t=>t.stop()); return 'GRANTED'; }
  catch (e) { return 'DENIED '+e.name; }
}`, 6000)).outcome;
results.clipboardRead = (await withTimeout(`async () => {
  try { await navigator.clipboard.readText(); return 'GRANTED'; } catch (e) { return 'DENIED '+e.name; }
}`, 6000)).outcome;

console.log('');
for (const [k, v] of Object.entries(results)) console.log(`request ${k.padEnd(20)} ${v}`);

// VERDICT. The bar: an offline 2x2-game visualiser must not hand its renderer
// camera, microphone or screen capture. Notifications/clipboard are not in that
// class (no OS-level privacy capability, and clipboard-write is used by the
// app's own copy buttons), so they are reported but not failed on.
const privacyCritical = ['getUserMediaVideo', 'getUserMediaAudio', 'displayCapture'];
const hits = privacyCritical.filter(k => String(results[k]).startsWith('GRANTED'));
// A probe that cannot observe anything must not read as EMPTY.
if (Object.values(results).every(v => String(v).startsWith('TIMEOUT')))
  { console.error('\n>>> INCONCLUSIVE: every request timed out; this is not an EMPTY'); process.exitCode = 3; }
else if (hits.length) { console.log(`\n>>> ${hits.length} HIT(s): ${hits.join(', ')}`); process.exitCode = 2; }
else console.log('\nEMPTY: the packaged renderer got no camera, microphone or screen capture');

await browser.close().catch(() => {});
child.kill();

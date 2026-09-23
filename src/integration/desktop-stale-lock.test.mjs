/* INTEGRATION (macOS) — the desktop data-directory lock, arbitrated by the KERNEL.
 * S75-009: after a reboot a .server.lock pid is routinely reused by an unrelated
 * live process (Daniel's 672 became Passwords.app) and the app refused forever.
 * Review #12: recovering a "stale" pid file raced into two writers (F2), and a
 * timestamp proof was fooled by a backdated FAT lock (F3). Now the server holds
 * flock on the data directory for its lifetime; the pid file is only a label.
 * Electron's requestSingleInstanceLock (electron-main.cjs) already stops a second
 * PACKAGED instance before server.cjs runs; these fixtures are the server lock's
 * own invariant, which the project has kept since desktop-concurrent-lock.
 *   node src/integration/desktop-stale-lock.test.mjs   (needs dist/server.cjs)
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForOwnServer } from './ownserver.mjs';

if (process.platform !== 'darwin') {
  console.log('SKIP: the desktop lock is only sound on darwin (flock on the data directory); '
    + 'this suite runs for real in the macOS package-audit job.');
  process.exit(0);
}
const BUNDLE = path.resolve(import.meta.dirname, '../../dist/server.cjs');
const HOLDER = path.resolve(import.meta.dirname, '../desktop/flock-holder.cjs');
const PRELOAD = (f) => path.resolve(import.meta.dirname, `../desktop/${f}`);
const BASE = Number(process.env.STALE_LOCK_TEST_PORT || 3480);
const results = [];
const rec = (name, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const dirs = []; const kids = [];
const dir = (tag) => { const d = mkdtempSync(path.join(tmpdir(), `nash-stale-${tag}-`)); dirs.push(d); return d; };
const live = (cmd, args) => { const c = spawn(cmd, args, { stdio: 'ignore' }); kids.push(c); return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (ud, port, extra = {}) => ({ PATH: process.env.PATH, HOME: ud, NODE_ENV: 'production', PORT: String(port), IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: ud, ...extra });
const lstart = (pid) => Date.parse(execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim() + ' GMT') / 1000;

// A live process holding the directory flock, like a running server. `label` is
// what it writes as the pid file (default: its own pid).
async function holdFlock(ud, label) {
  const c = spawn(process.execPath, label === undefined ? [HOLDER, ud] : [HOLDER, ud, label], { stdio: ['ignore', 'pipe', 'inherit'] });
  kids.push(c);
  await new Promise((res, rej) => { c.stdout.once('data', res); c.once('exit', (code) => rej(new Error(`flock holder exited ${code}`))); });
  return c;
}
async function stopKid(c) { if (c.exitCode === null && c.signalCode === null) { c.kill('SIGKILL'); await new Promise((r) => c.once('exit', r)); } }

// Starts the real bundle on a data dir whose lock says `label`. Resolves the outcome.
async function attempt(tag, label, port, { mtime, wrap = [], preload, ud = dir(tag) } = {}) {
  const lock = path.join(ud, '.server.lock');
  if (label !== null) writeFileSync(lock, String(label));
  if (mtime !== undefined) utimesSync(lock, mtime, mtime);
  const argv = [...wrap, process.execPath, ...(preload ? ['--require', PRELOAD(preload)] : []), BUNDLE];
  const child = spawn(argv[0], argv.slice(1), { cwd: ud, stdio: ['ignore', 'pipe', 'pipe'], env: env(ud, port) });
  kids.push(child);
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  // sandbox-exec execs node in place, so the pid is the server's either way.
  const started = await waitForOwnServer(child, `http://127.0.0.1:${port}`, { timeoutMs: 20000 }).then(() => true, () => false);
  let lockNow = null; try { lockNow = readFileSync(lock, 'utf8').trim(); } catch { /* absent, or not a file */ }
  await stopKid(child);
  return { started, refused: /Refusing to start/.test(log), lockNow, pid: child.pid, log, line: log.split('\n').find((l) => /Refusing/.test(l)) || '' };
}
const took = (r) => r.started && r.lockNow === String(r.pid);
const refusedOnly = (r) => r.refused && !r.started;

try {
  // ── FAT volume: its utimes moves mtime AND ctime, the F3 shape. ──
  const img = dir('fat'); const mnt = path.join(img, 'mnt');
  execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-size', '16m', '-fs', 'MS-DOS', '-volname', 'NASHLOCK', path.join(img, 'v')]);
  execFileSync('/usr/bin/hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', mnt, path.join(img, 'v.dmg')]);
  const fatKids = [];
  try {
    for (const d of ['i', 'ix', 'x', 'xiv']) mkdirSync(path.join(mnt, d));
    // (i) the label names a live node that started after the lock's last write, and
    // nobody holds the directory: taken over (the kernel, not the timestamp, decides).
    const later = live(process.execPath, ['-e', 'setTimeout(()=>{},120000)']); await sleep(300);
    const r1 = await attempt('i', later.pid, BASE, { mtime: lstart(later.pid) - 86400, ud: path.join(mnt, 'i') });
    rec("(i) a lock last written before its pid's process started, directory not held: taken over", took(r1), r1.line);
    // (ix) a live HOLDER whose label carries a 1990 write time: refused.
    const h9 = await holdFlock(path.join(mnt, 'ix')); fatKids.push(h9);
    const r9 = await attempt('ix', h9.pid, BASE + 1, { mtime: Date.UTC(1990, 0) / 1000, ud: path.join(mnt, 'ix') });
    rec('(ix) a live holder whose lock says 1990 still refuses', refusedOnly(r9), r9.line);
    // (x) after a reboot the app can draw the very pid its old label names (672 -> 678).
    const selfDir = path.join(mnt, 'x'); const selfLock = path.join(selfDir, '.server.lock');
    const self = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(selfLock)}, String(process.pid)); require(${JSON.stringify(BUNDLE)});`],
      { cwd: selfDir, stdio: 'ignore', env: env(selfDir, BASE + 2) });
    kids.push(self);
    const selfUp = await waitForOwnServer(self, `http://127.0.0.1:${BASE + 2}`, { timeoutMs: 20000 }).then(() => true, () => false);
    rec("(x) a label naming the app's OWN new pid is taken over, not refused as 'another server'",
      selfUp && readFileSync(selfLock, 'utf8').trim() === String(self.pid));
    await stopKid(self);
    // (xiv) review #12 F3: a LIVE server on FAT; a tool backdates its lock; a second launch must not serve.
    const f3 = path.join(mnt, 'xiv');
    const A = spawn(process.execPath, [BUNDLE], { cwd: f3, stdio: 'ignore', env: env(f3, BASE + 3) }); kids.push(A); fatKids.push(A);
    await waitForOwnServer(A, `http://127.0.0.1:${BASE + 3}`, { timeoutMs: 20000 });
    const back = Date.now() / 1000 - 86400; utimesSync(path.join(f3, '.server.lock'), back, back);
    const B = spawn(process.execPath, [BUNDLE], { cwd: f3, stdio: 'ignore', env: env(f3, BASE + 4) }); kids.push(B); fatKids.push(B);
    const bUp = await waitForOwnServer(B, `http://127.0.0.1:${BASE + 4}`, { timeoutMs: 6000 }).then(() => true, () => false);
    rec("(xiv) a LIVE writer's backdated lock on FAT is not taken over: ONE writer", !bUp, `second writer up=${bUp}`);
  } finally {
    for (const k of fatKids) await stopKid(k);
    execFileSync('/usr/bin/hdiutil', ['detach', '-quiet', '-force', mnt]);
  }

  // ── Labels naming live processes that do NOT hold the directory: all taken over. ──
  const sleeper = live('/bin/sleep', ['600']); await sleep(300);
  let r = await attempt('ii', sleeper.pid, BASE + 5);
  rec('(ii) the reboot case: a label naming a live foreign process (/bin/sleep) is taken over', took(r), r.line);
  // (xviii) the label is a symlink to a file outside: replaced, never written through.
  const d18 = dir('xviii'); const outside = path.join(dir('outside'), 'keep'); writeFileSync(outside, 'KEEP');
  symlinkSync(outside, path.join(d18, '.server.lock'));
  r = await attempt('xviii', null, BASE + 28, { ud: d18 });
  rec('(xviii) a symlinked label is replaced, and the file it pointed at is untouched',
    took(r) && readFileSync(outside, 'utf8') === 'KEEP', `outside=${JSON.stringify(readFileSync(outside, 'utf8'))}`);
  const d3 = dir('named'); const link = path.join(d3, 'Nash Equilibrium Simulator'); symlinkSync('/bin/sleep', link);
  const named = live(link, ['600']); await sleep(300);
  r = await attempt('iii-a', named.pid, BASE + 6);
  rec('(iii-a) a label naming a live process called like the app, not holding the directory, is taken over', took(r), r.line);
  const nodeLabel = live(process.execPath, ['-e', 'setTimeout(()=>{},120000)']); await sleep(300);
  r = await attempt('iii-b', nodeLabel.pid, BASE + 7);
  rec('(iii-b) a label naming a live node process not holding the directory is taken over', took(r), r.line);
  const spoof = live('/bin/sh', ['-c', 'exec -a server.ts /bin/sleep 600']); await sleep(300);
  r = await attempt('iii-c', spoof.pid, BASE + 8);
  rec('(iii-c) a label naming a live process whose argv says server.ts is taken over', took(r), r.line);
  const policy = '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))';
  r = await attempt('iv', sleeper.pid, BASE + 9, { wrap: ['/usr/bin/sandbox-exec', '-p', policy] });
  rec('(iv) with /bin/ps unrunnable the lock still works: ps is never consulted', took(r), r.line);
  const nonPos = [await attempt('neg1', '-1', BASE + 10), await attempt('zero', '0', BASE + 11)];
  rec('(xii) a label of -1 or 0 is taken over (no process-group probe)', nonPos.every(took), nonPos.map((x) => `started=${x.started}`).join(' '));
  r = await attempt('viii', 1, BASE + 12);
  rec('(viii) a label naming pid 1 (launchd) is taken over', took(r), r.line);

  // ── A live HOLDER of the directory: every launch refuses, whatever the label says. ──
  const hdir = dir('xv');
  const h = await holdFlock(hdir);
  r = await attempt('xv-a', null, BASE + 13, { ud: hdir });
  rec('(xv-a) a live holder of the directory refuses a second server, naming its pid',
    refusedOnly(r) && r.line.includes(`(pid ${h.pid})`), r.line);
  utimesSync(path.join(hdir, '.server.lock'), Date.now() / 1000 + 5, Date.now() / 1000 + 5);
  r = await attempt('vi', null, BASE + 14, { ud: hdir });
  rec('(vi) a lock touched after its live holder started still refuses', refusedOnly(r), r.line);
  const t7 = lstart(h.pid) - 86400; utimesSync(path.join(hdir, '.server.lock'), t7, t7);
  r = await attempt('vii', null, BASE + 15, { ud: hdir });
  rec('(vii) a backdated lock on a live holder still refuses', refusedOnly(r), r.line);
  await stopKid(h);
  const shaped = [];
  for (const [k, text] of [(p) => `${p}abc`, (p) => `+${p}`, (p) => `000${p}`].entries()) {
    const ud = dir(`xi${k}`); const hk = await holdFlock(ud, '-'); writeFileSync(path.join(ud, '.server.lock'), text(hk.pid));
    shaped.push(await attempt(`xi${k}`, null, BASE + 16 + k, { ud })); await stopKid(hk);
  }
  rec('(xi) a live holder whose label only STARTS with its pid (junk, +, zero-padded) still refuses',
    shaped.every(refusedOnly), shaped.map((x) => x.refused).join(' '));
  const blank = [];
  for (const [k, label] of ['', 'not-a-pid'].entries()) {
    const ud = dir(`xvb${k}`); const hk = await holdFlock(ud, label);
    blank.push(await attempt(`xvb${k}`, null, BASE + 19 + k, { ud })); await stopKid(hk);
  }
  rec('(xv-b) a holder between its flock and its pid write (empty or garbage label) refuses; the message names no pid',
    blank.every((x) => refusedOnly(x) && !/\(pid/.test(x.line) && /another Nash Equilibrium Simulator server is already using/.test(x.line)),
    blank.map((x) => x.line.slice(0, 90)).join(' | '));

  // (xvii) a label the server cannot replace (a directory squats the name): it still
  // serves under the flock, and leaves no temp file in the user's folder.
  const d17 = dir('xvii'); mkdirSync(path.join(d17, '.server.lock'));
  r = await attempt('xvii', null, BASE + 27, { ud: d17 });
  const litter = readdirSync(d17).filter((f) => f.startsWith('.server.lock.'));
  rec('(xvii) an unreplaceable label: the server still starts and leaves no temp file behind',
    r.started && litter.length === 0, `started=${r.started} litter=${JSON.stringify(litter)}`);

  // (xvi) any other flock error fails closed, naming the folder.
  const dx = dir('xvi');
  r = await attempt('xvi', null, BASE + 21, { preload: 'lock-enotsup.cjs', ud: dx });
  rec('(xvi) a directory that cannot be locked (ENOTSUP) refuses, naming the folder',
    refusedOnly(r) && r.line.includes(`${dx} cannot be locked (ENOTSUP)`), r.line);

  // (v) two starters on one stale lock: exactly one serves.
  const ud5 = dir('race'); writeFileSync(path.join(ud5, '.server.lock'), String(sleeper.pid));
  const first = spawn(process.execPath, [BUNDLE], { cwd: ud5, stdio: 'ignore', env: env(ud5, BASE + 22, { NASH_LOCK_TEST_DELAY_MS: '2500' }) }); kids.push(first);
  await sleep(800);
  const second = spawn(process.execPath, [BUNDLE], { cwd: ud5, stdio: 'ignore', env: env(ud5, BASE + 23) }); kids.push(second);
  const ups = await Promise.all([[first, BASE + 22], [second, BASE + 23]].map(([c, p]) => waitForOwnServer(c, `http://127.0.0.1:${p}`, { timeoutMs: 9000 }).then(() => c, () => null)));
  const winners = ups.filter(Boolean);
  rec('(v) two starters on one stale lock: exactly one serves and holds the label',
    winners.length === 1 && readFileSync(path.join(ud5, '.server.lock'), 'utf8').trim() === String(winners[0].pid), `winners=${winners.length}`);

  // (xiii) review #12 F2: B pauses inside any unlink of the lock; A starts meanwhile. ONE writer.
  const ud13 = dir('f2'); writeFileSync(path.join(ud13, '.server.lock'), '999999999');
  const B13 = spawn(process.execPath, ['--require', PRELOAD('lock-pause-unlink.cjs'), BUNDLE], { cwd: ud13, stdio: 'ignore', env: env(ud13, BASE + 24, { PAUSE_MS: '2500' }) }); kids.push(B13);
  await sleep(700);
  const A13 = spawn(process.execPath, [BUNDLE], { cwd: ud13, stdio: 'ignore', env: env(ud13, BASE + 25) }); kids.push(A13);
  const up13 = await Promise.all([[B13, BASE + 24], [A13, BASE + 25]].map(([c, p]) => waitForOwnServer(c, `http://127.0.0.1:${p}`, { timeoutMs: 9000 }).then(() => 1, () => 0)));
  rec("(xiii) a starter paused inside its lock unlink cannot give two writers: ONE writer", up13[0] + up13[1] === 1, `B up=${up13[0]} A up=${up13[1]}`);

  // Hosted control: no ELECTRON_USER_DATA_PATH => no lock at all, even beside a live-pid label.
  const hd = dir('hosted'); writeFileSync(path.join(hd, '.server.lock'), String(nodeLabel.pid));
  const hosted = spawn(process.execPath, [BUNDLE], { cwd: hd, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: hd, NODE_ENV: 'production', PORT: String(BASE + 26) } }); kids.push(hosted);
  const hostedUp = await waitForOwnServer(hosted, `http://127.0.0.1:${BASE + 26}`, { timeoutMs: 20000 }).then(() => true, () => false);
  rec('hosted control: no desktop data dir, no lock logic — starts regardless', hostedUp && readFileSync(path.join(hd, '.server.lock'), 'utf8').trim() === String(nodeLabel.pid));
} finally {
  for (const k of kids) { try { k.kill('SIGKILL'); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

const EXPECTED_CHECKS = 22;
if (results.length < EXPECTED_CHECKS) {
  console.error(`FAILED: only ${results.length} checks ran, expected ${EXPECTED_CHECKS}`);
  process.exit(1);
}
const failed = results.filter((p) => !p).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exit(1);

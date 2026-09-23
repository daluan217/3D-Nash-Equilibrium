/* INTEGRATION (macOS) — S75-009: a .server.lock whose pid was reused.
 * After a reboot the lock's small pid routinely belongs to an unrelated live
 * process (Daniel's: pid 672 became Passwords.app); kill(pid, 0) succeeded and
 * the app refused to start on every launch. Recovery is allowed only on proof,
 * and every unknown must still refuse. Each fixture's holder is a REAL live
 * process, so a lock check that ignores liveness cannot pass them by chance.
 *   node src/integration/desktop-stale-lock.test.mjs   (needs dist/server.cjs)
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForOwnServer } from './ownserver.mjs';

const BUNDLE = path.resolve(import.meta.dirname, '../../dist/server.cjs');
const BASE = Number(process.env.STALE_LOCK_TEST_PORT || 3480);
const results = [];
const rec = (name, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const dirs = []; const kids = [];
const dir = (tag) => { const d = mkdtempSync(path.join(tmpdir(), `nash-stale-${tag}-`)); dirs.push(d); return d; };
const live = (cmd, args) => { const c = spawn(cmd, args, { stdio: 'ignore' }); kids.push(c); return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts the real bundle on `lock` naming `holderPid`. `mtime` (seconds) backdates or
// postdates the lock; `wrap` prefixes the command (sandbox-exec). Resolves the outcome.
async function attempt(tag, holderPid, port, { mtime, wrap = [], ud = dir(tag) } = {}) {
  const lock = path.join(ud, '.server.lock');
  writeFileSync(lock, String(holderPid));
  if (mtime !== undefined) utimesSync(lock, mtime, mtime);
  const argv = [...wrap, process.execPath, BUNDLE];
  const child = spawn(argv[0], argv.slice(1), {
    cwd: ud, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: ud, NODE_ENV: 'production', PORT: String(port), IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: ud },
  });
  kids.push(child);
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.once('exit', r));
  // sandbox-exec execs node in place, so the pid is the server's either way.
  const started = await waitForOwnServer(child, `http://127.0.0.1:${port}`, { timeoutMs: 20000 }).then(() => true, () => false);
  const lockNow = existsSync(lock) ? readFileSync(lock, 'utf8').trim() : null;
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  return { started, refused: /Refusing to start/.test(log), recovered: /Recovering a stale desktop lock/.test(log), lockNow, pid: child.pid, log };
}
const now = () => Date.now() / 1000;
const ageOf = (pid) => Date.parse(execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim() + ' GMT') / 1000;

try {
  // A foreign live process: /bin/sleep (ucomm "sleep"). Started BEFORE the lock is written.
  const sleeper = live('/bin/sleep', ['600']); await sleep(300);

  // (i) proof (a'): the holder is a live NODE (so (b) cannot fire) forked after the
  // lock's last write. APFS keeps ctime at the real write, so a backdated mtime there
  // proves nothing (fixture vii); a FAT volume's utimes moves both, like a lock
  // genuinely left by a previous boot.
  const img = dir('fat'); const mnt = path.join(img, 'mnt');
  execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-size', '16m', '-fs', 'MS-DOS', '-volname', 'NASHLOCK', path.join(img, 'v')]);
  execFileSync('/usr/bin/hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', mnt, path.join(img, 'v.dmg')]);
  try {
    const later = live(process.execPath, ['-e', 'setInterval(()=>{},1e6)']); await sleep(300);
    const r1 = await attempt('a-prime', later.pid, BASE, { mtime: ageOf(later.pid) - 86400, ud: mnt });
    rec("(i) proof (a'): a lock last written before its pid's process started is recovered, even when that process is a node",
      r1.started && r1.lockNow === String(r1.pid) && /\(a'\)/.test(r1.log), r1.log.split('\n').find((l) => /Recover|Refus/.test(l)));
    // (ix) a zeroed/ancient write time (1990: FAT's floor is 1980) proves nothing: holder is ours ⇒ refuse.
    const r9 = await attempt('ancient', later.pid, BASE + 12, { mtime: Date.UTC(1990, 0) / 1000, ud: mnt });
    rec('(ix) a pre-2020 lock write time is not proof: a live node holder still refuses', r9.refused && !r9.started, `refused=${r9.refused}`);
  } finally { execFileSync('/usr/bin/hdiutil', ['detach', '-quiet', '-force', mnt]); }
  let r;

  // (ii) proof (b): fresh lock, holder is a foreign live process ⇒ recover.
  r = await attempt('b-foreign', sleeper.pid, BASE + 1);
  rec('(ii) proof (b): a fresh lock naming a live /bin/sleep is recovered, lock rewritten', r.started && r.lockNow === String(r.pid) && /\(b\)/.test(r.log), r.log.split('\n').find((l) => /Recover|Refus/.test(l)));

  // (iii) holder looks like us — a symlink to /bin/sleep named like the app, and a node — fresh lock ⇒ refuse.
  const d = dir('named'); const link = path.join(d, 'Nash Equilibrium Simulator'); symlinkSync('/bin/sleep', link);
  const named = live(link, ['600']); await sleep(300);
  r = await attempt('ours-named', named.pid, BASE + 2);
  rec('(iii-a) a live process whose argv[0] is the app name refuses', r.refused && !r.started && r.lockNow === String(named.pid), `refused=${r.refused} started=${r.started}`);
  const nodeHolder = live(process.execPath, ['-e', 'setInterval(()=>{},1e6)']); await sleep(300);
  r = await attempt('ours-node', nodeHolder.pid, BASE + 3);
  rec('(iii-b) a live node process (a dev server.cjs) refuses', r.refused && !r.started && r.lockNow === String(nodeHolder.pid), `refused=${r.refused} started=${r.started}`);
  const spoof = live('/bin/sh', ['-c', 'exec -a server.ts /bin/sleep 600']); await sleep(300);
  r = await attempt('ours-argv', spoof.pid, BASE + 4);
  rec('(iii-c) a foreign executable whose argv names server.ts refuses (command column)', r.refused && !r.started, `refused=${r.refused} started=${r.started}`);

  // (iv) unreadable: ps cannot run (sandbox denies exec of /bin/ps) and the holder is foreign ⇒ refuse.
  const policy = '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))';
  r = await attempt('unreadable', sleeper.pid, BASE + 5, { wrap: ['/usr/bin/sandbox-exec', '-p', policy] });
  rec('(iv) ps unavailable (EPERM) with a foreign live holder refuses — fail closed', r.refused && !r.started, `refused=${r.refused} started=${r.started}`);

  // (vi) a sync tool touched the lock AFTER our live holder started ⇒ (a') not proven, (b) says ours ⇒ refuse.
  r = await attempt('touched', nodeHolder.pid, BASE + 6, { mtime: now() + 5 });
  rec('(vi) a lock touched after its live Nash holder started still refuses', r.refused && !r.started, `refused=${r.refused}`);
  // (vii) mtime backdated by a tool while the holder is ours: ctime keeps the real write ⇒ refuse.
  r = await attempt('backdated-ours', nodeHolder.pid, BASE + 7, { mtime: ageOf(nodeHolder.pid) - 86400 });
  rec('(vii) a backdated mtime on a live Nash holder still refuses (ctime is the last write)', r.refused && !r.started, `refused=${r.refused}`);

  // (viii) pid 1 is readable and foreign on macOS (kill(1,0) = EPERM) ⇒ recover by (b).
  r = await attempt('pid1', 1, BASE + 8);
  rec('(viii) pid 1 (launchd: EPERM to signal, readable to ps) is a foreign holder and is recovered', r.started && r.lockNow === String(r.pid), r.log.split('\n').find((l) => /Recover|Refus/.test(l)));

  // (v) two recoverers on one stale lock: exactly one wins.
  const ud = dir('race'); const lock = path.join(ud, '.server.lock'); writeFileSync(lock, String(sleeper.pid));
  const env = (port, extra = {}) => ({ PATH: process.env.PATH, HOME: ud, NODE_ENV: 'production', PORT: String(port), IS_ELECTRON: 'true', ELECTRON_USER_DATA_PATH: ud, ...extra });
  const first = spawn(process.execPath, [BUNDLE], { cwd: ud, stdio: 'ignore', env: env(BASE + 9, { NASH_LOCK_TEST_DELAY_MS: '2500' }) }); kids.push(first);
  await sleep(800);
  const second = spawn(process.execPath, [BUNDLE], { cwd: ud, stdio: 'ignore', env: env(BASE + 10) }); kids.push(second);
  const up2 = await waitForOwnServer(second, `http://127.0.0.1:${BASE + 10}`, { timeoutMs: 20000 }).then(() => true, () => false);
  const firstCode = await new Promise((res) => { if (first.exitCode !== null) res(first.exitCode); first.once('exit', res); setTimeout(() => res('still running'), 8000); });
  rec('(v) two recoverers of one stale lock: exactly one wins, the other refuses',
    up2 && firstCode !== 'still running' && firstCode !== 0 && readFileSync(lock, 'utf8').trim() === String(second.pid), `second up=${up2}, first exit=${firstCode}`);

  // Hosted control: no ELECTRON_USER_DATA_PATH ⇒ no lock at all, even with a live-pid lock in cwd.
  const hd = dir('hosted'); writeFileSync(path.join(hd, '.server.lock'), String(nodeHolder.pid));
  const hosted = spawn(process.execPath, [BUNDLE], { cwd: hd, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: hd, NODE_ENV: 'production', PORT: String(BASE + 11) } }); kids.push(hosted);
  const hostedUp = await waitForOwnServer(hosted, `http://127.0.0.1:${BASE + 11}`, { timeoutMs: 20000 }).then(() => true, () => false);
  rec('hosted control: no desktop data dir, no lock logic — starts regardless', hostedUp && readFileSync(path.join(hd, '.server.lock'), 'utf8').trim() === String(nodeHolder.pid));
} finally {
  for (const k of kids) { try { k.kill('SIGKILL'); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

const EXPECTED_CHECKS = 12;
if (results.length < EXPECTED_CHECKS) {
  console.error(`FAILED: only ${results.length} checks ran, expected ${EXPECTED_CHECKS}`);
  process.exit(1);
}
const failed = results.filter((p) => !p).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exit(1);

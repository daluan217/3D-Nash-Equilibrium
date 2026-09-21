/* INTEGRATION — two properties a DESKTOP app needs and a server does not:
 * it is killed constantly, and its data directory is a path a human can move.
 *
 * These are BLUE-LOOP-DESKTOP-22 sweep-28 probes, checked in because a sweep
 * counts as EMPTY only once every empty probe is a green, mutation-proven CI
 * guard — a probe left under `_gen/` protects nothing (Daniel, 2026-09-15).
 *
 * SECTION 1 — SHUTDOWN. A desktop app is quit far more violently than a
 * server: Cmd-Q, force quit, logout, battery death. A burst of saves is
 * interrupted mid-flight by each of SIGTERM/SIGINT/SIGHUP/SIGKILL and three
 * things must hold afterwards: db.json still PARSES, the NEXT launch is not
 * blocked by the dead process's lock, and that launch sweeps any scratch file
 * the killed process could not. The lock one is the user-visible one: a lock
 * that outlives its owner means the app never starts again until someone
 * finds a dotfile.
 *   The parse rows are REGRESSION guards, not proof of atomicity — measured,
 * they stay green against a deliberately non-atomic save. Section 1a asserts
 * the mechanism (inode churn) instead; read its comment before trusting a
 * green parse row to mean anything about torn writes.
 *
 * SECTION 2 — THE DATA DIRECTORY IS A PATH, AND PATHS HAVE SHAPES. Electron
 * hands the app a real directory, but the thing at that path is whatever the
 * filesystem says: a user who relocated their data has a SYMLINK there, and
 * a broken setup can leave a file or a link loop. A symlinked directory must
 * WORK (relocating app data is ordinary), and an impossible shape must refuse
 * to boot with something in the log — never boot and silently write nowhere,
 * which is the shape that loses data without an error.
 *
 * SECTION 3 — THE DISK STOPS ACCEPTING WRITES. A laptop fills up, and saveDB
 * rewrites the WHOLE database, so the first casualty is a save that used to
 * work. The failure that matters is a 200 for a write that did not land.
 *
 *   node src/integration/desktop-shutdown-and-paths.test.mjs
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(repo, 'dist/server.cjs');
let port = Number(process.env.DESKTOP_SHUTDOWN_PORT || 3330);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

if (!existsSync(BUNDLE)) {
  console.error(`missing ${BUNDLE} — run \`npm run build\` first.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAYOFFS = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 1 };

/** The packaged condition: cwd is a temp dir so dotenv cannot find this repo's .env. */
function launch(userDataPath, thePort, homeDir, extraEnv = {}) {
  const child = spawn(process.execPath, [BUNDLE], {
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH, HOME: homeDir ?? userDataPath,
      NODE_ENV: 'production', IS_ELECTRON: 'true',
      PORT: String(thePort), ELECTRON_USER_DATA_PATH: userDataPath,
      NASH_PAYOFF_TEMPLATE: '1', NASH_LLM_TIES: 'template', NASH_DIRECTION_CHECKS: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, log: () => log };
}

/** Resolve once the server prints its bind line, or the child dies trying. */
async function waitBound(srv, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const m = /Express server running on http:\/\/127\.0\.0\.1:(\d+)/.exec(srv.log());
    if (m) return Number(m[1]);
    if (srv.child.exitCode !== null) return null;
    await sleep(150);
  }
  return null;
}

async function stop(srv) {
  // `exitCode` alone is not "already dead": a child killed by a SIGNAL reports
  // exitCode null and signalCode set, and awaiting `exit` on a process that has
  // already emitted it hangs forever (this suite kills its own children by
  // signal, so it hit exactly that — "unsettled top-level await"). Check both,
  // and never wait unbounded.
  if (!srv?.child || srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  const ended = new Promise((res) => srv.child.once('exit', res));
  srv.child.kill('SIGKILL');
  await Promise.race([ended, sleep(4000)]);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. KILLED MID-SAVE — every signal, including the one nothing can catch.
// ═══════════════════════════════════════════════════════════════════════════
// SIGKILL is the important row: SIGTERM/SIGINT/SIGHUP can in principle be
// handled, so a suite that only sent those would be measuring a handler. A
// force-quit cannot be intercepted at all, which makes it the honest test of
// whether the ON-DISK format survives interruption on its own.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']) {
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-shutdown-'));
  const first = launch(userData, ++port);
  const bound = await waitBound(first);
  record(`${signal}: the fixture server booted (so the kill below interrupts something real)`,
    bound !== null, bound === null ? first.log().slice(-200) : `port ${bound}`);

  if (bound !== null) {
    // Fire a burst and kill while it is in flight. Individual saves may fail
    // — that is the point — so every request is allowed to reject.
    const burst = Array.from({ length: 30 }, (_, i) =>
      fetch(`http://127.0.0.1:${bound}/api/games`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `S-${i}`, payoffs: PAYOFFS }),
      }).catch(() => null));
    await sleep(25);
    first.child.kill(signal);
    await Promise.allSettled(burst);
    await sleep(600);

    // (a) the file still parses. A torn write is how "unreadable" becomes
    //     "gone": the loader's repair path decides what the user keeps.
    let parsed = null;
    let parseError = null;
    try { parsed = JSON.parse(readFileSync(path.join(userData, 'db.json'), 'utf8')); }
    catch (e) { parseError = e.message; }
    record(`${signal}: db.json still parses after the process died mid-save`,
      parsed !== null && Array.isArray(parsed.games),
      parseError ? `JSON.parse: ${parseError}` : `${parsed?.games?.length} game(s)`);

    // (b) A scratch file MAY survive the kill — a process that is gone cannot
    //     run its own cleanup, and MEASURED over 24 signal-kills it happens in
    //     9. "None is left behind" was the first spelling of this check and it
    //     was simply WRONG about the product: it passed three runs in a row on
    //     this laptop and would have flaked in CI forever. The real invariant
    //     is the one the startup sweep exists to provide — the NEXT launch
    //     cleans it up (measured 9/9) — so that is what is asserted, below,
    //     after the relaunch.
    const straysBefore = readdirSync(userData).filter((f) => f.includes('db.json.tmp-'));

    // (c) THE USER-VISIBLE ONE: the next launch must not be blocked by the
    //     dead process's lock. A lock that outlives its owner means the app
    //     never starts again until someone finds a dotfile.
    //     NASH_TMP_SWEEP_MAX_AGE_MS=1 so the sweep does not skip a scratch
    //     file that is younger than its 5s production caution threshold; the
    //     production default is untouched (server.ts only reads the override).
    const second = launch(userData, ++port, undefined, { NASH_TMP_SWEEP_MAX_AGE_MS: '1' });
    const reboundPort = await waitBound(second);
    record(`${signal}: the app launches again afterwards (the dead process's lock does not block it)`,
      reboundPort !== null,
      reboundPort !== null ? `port ${reboundPort}` : second.log().slice(-240));

    // (d) …and that launch sweeps whatever the killed process could not.
    //     Skipped, loudly, when the kill happened to leave nothing: a check
    //     that silently passes on an empty directory is not a check.
    if (reboundPort !== null) {
      await sleep(300);
      const straysAfter = readdirSync(userData).filter((f) => f.includes('db.json.tmp-'));
      record(`${signal}: the relaunch swept any scratch file the killed process left behind`,
        straysAfter.length === 0,
        `the kill left ${straysBefore.length}; ${straysAfter.length} still there: ${straysAfter.join(', ')}`);
    }
    await stop(second);
  }
  await stop(first);
  rmSync(userData, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1a. THE MECHANISM, NOT THE SYMPTOM.
//
// Gate review #5 (finding 1) said the four "db.json still parses" rows above
// cannot fail, because renameSync is atomic. MEASURED, and it is worse than
// that: rewriting writeFileAtomicSync to open db.json directly and write it
// in 4KB chunks — a genuinely non-atomic save — left all four rows GREEN, and
// so did the 1b/3 parse checks. Three further probes found no observable
// tearing either: 19,938 concurrent reads during a burst (0 torn), and 6
// kill-mid-rewrite trials against a 191,899-byte db.json (0 unparseable).
// Node's writes are synchronous and win the race every time, so "the file
// parses" is simply not a predicate that can catch this on a real machine.
//
// The INODE is. A rename-based replace makes db.json a different file on
// every save; an in-place write keeps the same inode forever. Measured on
// the same 8 saves: clean tree 8 distinct inodes, mutant 1. That separation
// is the whole point — it is a property of the MECHANISM, which is what the
// atomic-write contract actually promises, rather than of an outcome the
// filesystem hides.
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-inode-'));
  const srv = launch(userData, ++port);
  const bound = await waitBound(srv);
  record('1a: the fixture server booted', bound !== null,
    bound === null ? srv.log().slice(-200) : `port ${bound}`);
  if (bound !== null) {
    const dbFile = path.join(userData, 'db.json');
    const save = (n) => fetch(`http://127.0.0.1:${bound}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `ino-${n}`, payoffs: PAYOFFS }),
    }).catch(() => null);
    await save(0);
    await sleep(200);
    const SAVES = 8;
    const inodes = new Set();
    let sawFile = 0;
    for (let i = 1; i <= SAVES; i++) {
      await save(i);
      await sleep(120);
      if (existsSync(dbFile)) { sawFile++; inodes.add(statSync(dbFile).ino); }
    }
    // CONTROL first: if the file never appeared, "distinct inodes" below is
    // counting nothing and would pass for the wrong reason.
    record('1a CONTROL: db.json existed after every save (the inode count is counting something)',
      sawFile === SAVES, `observed the file ${sawFile}/${SAVES} times`);
    record('1a: every save REPLACES db.json rather than overwriting it in place',
      inodes.size === SAVES,
      `${inodes.size} distinct inode(s) over ${SAVES} saves — 1 means an in-place write, `
      + 'which is the non-atomic shape the four parse checks above cannot see');
  }
  await stop(srv);
  rmSync(userData, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1b. THE SWEEP, EXERCISED DETERMINISTICALLY.
// ═══════════════════════════════════════════════════════════════════════════
// The per-signal sweep checks above only mean something on a run where the
// kill actually left a scratch file, and MEASURED that is 9 of 24 kills — so
// on most runs they pass over an empty directory and prove nothing. This case
// PLANTS the scratch file instead of hoping for one, so the sweep is
// exercised on every run, and plants a same-prefixed file that must SURVIVE,
// so "it deletes everything" cannot pass as "it sweeps correctly".
{
  const userData = mkdtempSync(path.join(tmpdir(), 'nash-sweep-'));
  const stray = path.join(userData, 'db.json.tmp-999999-1');
  const keep = path.join(userData, 'db.json');
  const decoy = path.join(userData, 'db.json.backup');
  writeFileSync(stray, 'interrupted write');
  writeFileSync(keep, JSON.stringify({ users: [], games: [] }));
  writeFileSync(decoy, 'not a scratch file');

  const srv = launch(userData, ++port, undefined, { NASH_TMP_SWEEP_MAX_AGE_MS: '1' });
  const bound = await waitBound(srv);
  record('the sweep fixture booted', bound !== null,
    bound === null ? srv.log().slice(-200) : `port ${bound}`);
  if (bound !== null) {
    await sleep(300);
    record('startup sweeps a PLANTED db.json.tmp-* scratch file (deterministic, not luck)',
      !existsSync(stray), existsSync(stray) ? 'the scratch file is still there' : 'removed');
    record('CONTROL: the sweep does not take db.json with it',
      existsSync(keep), 'the database itself must survive its own scratch-file sweep');
    record('CONTROL: the sweep does not take a same-prefixed NON-scratch file',
      existsSync(decoy), 'db.json.backup does not match the `db.json.tmp-` prefix and must remain');
  }
  await stop(srv);
  rmSync(userData, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE DATA DIRECTORY IS A PATH, AND PATHS HAVE SHAPES.
// ═══════════════════════════════════════════════════════════════════════════
// Each case says what MUST happen, so the table cannot be satisfied by an app
// that simply refuses everything (or accepts everything). `boots: true` cases
// must also SAVE, because booting while writing nowhere is the failure mode
// that loses data without an error.
const SHAPES = [
  ['a symlink to a real directory', true, (root) => {
    const real = path.join(root, 'real');
    mkdirSync(real);
    const link = path.join(root, 'link');
    symlinkSync(real, link);
    return link;
  }, 'relocating application data is ordinary — a user who moved their data has this'],
  ['a symlink to a directory outside the tree', true, (root) => {
    const outside = mkdtempSync(path.join(tmpdir(), 'nash-shape-out-'));
    const link = path.join(root, 'link');
    symlinkSync(outside, link);
    return link;
  }, 'same shape, different target: the app follows the path Electron gave it'],
  ['a path that does not exist yet', true, (root) => path.join(root, 'a', 'b', 'c'),
    'first launch on a fresh profile — the directory must be created, not fatal'],
  ['a regular FILE where the directory should be', false, (root) => {
    const f = path.join(root, 'notadir');
    writeFileSync(f, 'x');
    return f;
  }, 'impossible: it must refuse loudly rather than boot and write nowhere'],
  ['a symlink loop', false, (root) => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    symlinkSync(b, a);
    symlinkSync(a, b);
    return a;
  }, 'impossible: ELOOP must surface, not be swallowed into a silent no-op'],
];

for (const [label, mustBoot, build, why] of SHAPES) {
  const root = mkdtempSync(path.join(tmpdir(), 'nash-shape-'));
  const userDataPath = build(root);
  const srv = launch(userDataPath, ++port, root);
  const bound = await waitBound(srv, 50);

  record(`ELECTRON_USER_DATA_PATH is ${label}: ${mustBoot ? 'the app boots' : 'the app refuses to boot'}`,
    mustBoot ? bound !== null : bound === null,
    `${why} — booted=${bound !== null} exit=${srv.child.exitCode}`);

  if (mustBoot && bound !== null) {
    // Booting is not enough: it must actually SAVE. An app that starts and
    // writes nowhere loses the user's work with no error anywhere.
    const r = await fetch(`http://127.0.0.1:${bound}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SHAPE-PROBE', payoffs: PAYOFFS }),
    }).then((x) => x.status).catch((e) => e.message);
    record(`ELECTRON_USER_DATA_PATH is ${label}: a save through it actually succeeds`,
      r === 200, `status ${r}`);
    // …and the bytes are really there, through whatever the path resolves to.
    const dbPath = path.join(userDataPath, 'db.json');
    const onDisk = existsSync(dbPath) && readFileSync(dbPath, 'utf8').includes('SHAPE-PROBE');
    record(`ELECTRON_USER_DATA_PATH is ${label}: the saved bytes are readable back through that path`,
      onDisk, onDisk ? '' : 'the save reported 200 but db.json does not contain it');
  }
  if (!mustBoot) {
    // Refusing is only correct if it SAYS SO. A silent exit is the same
    // experience as a hang from the user's side.
    record(`ELECTRON_USER_DATA_PATH is ${label}: the refusal is reported, not silent`,
      /EACCES|EPERM|ELOOP|ENOTDIR|ENOENT|EEXIST|not a directory|refus|Error/i.test(srv.log()),
      srv.log().slice(-200).replace(/\s+/g, ' '));
  }
  await stop(srv);
  rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE DISK STOPS ACCEPTING WRITES MID-USE.
// ═══════════════════════════════════════════════════════════════════════════
// A laptop fills up. `saveDB` rewrites the WHOLE database through
// writeFileAtomicSync, so the first casualty is a save that used to work, and
// the failure mode that matters is a 200 for a write that did not land —
// "Game saved successfully!" over a library that silently did not change.
//
// Simulated with RLIMIT_FSIZE rather than a real volume: capping file size
// makes the rewrite fail at exactly the same call, needs no root, and works
// on macOS and Linux alike (a real small volume needs `hdiutil`/`mount`, so
// it could never run in the ubuntu integration job). The errno differs —
// EFBIG rather than ENOSPC — but the branch under test is `writeFileSync`
// throwing, which is the same one either way.
//
// MEASURED on a real 3MB HFS+ volume first, to be sure this is not an
// artefact of the simulation: with the library large enough that the atomic
// rewrite could not fit, the app answered 500 "Could not save your changes",
// the refused game was absent from disk, db.json still parsed, and a save
// after freeing space succeeded.
{
  const capScript = path.join(tmpdir(), `nash-fsize-cap-${process.pid}.sh`);
  // 150 * 512B blocks ~= 75KB; the suite below grows db.json past that.
  writeFileSync(capScript, `#!/bin/bash\nulimit -f 150\nexec node "$@"\n`);
  chmodSync(capScript, 0o755);

  const userData = mkdtempSync(path.join(tmpdir(), 'nash-fsize-'));
  const thePort = ++port;
  const child = spawn(capScript, [BUNDLE], {
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH, HOME: userData, NODE_ENV: 'production', IS_ELECTRON: 'true',
      PORT: String(thePort), ELECTRON_USER_DATA_PATH: userData,
      NASH_PAYOFF_TEMPLATE: '1', NASH_LLM_TIES: 'template', NASH_DIRECTION_CHECKS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let flog = '';
  child.stdout.on('data', (d) => { flog += d; });
  child.stderr.on('data', (d) => { flog += d; });
  const srv = { child, log: () => flog };
  const bound = await waitBound(srv);
  record('the write-limit fixture booted', bound !== null,
    bound === null ? flog.slice(-200) : `port ${bound}`);

  if (bound !== null) {
    const save = (name) => fetch(`http://127.0.0.1:${bound}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, payoffs: PAYOFFS }),
    }).then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 80) }))
      .catch((e) => ({ status: 'threw', text: e.message }));

    let succeeded = 0;
    let refusal = null;
    for (let i = 0; i < 500 && refusal === null; i++) {
      const r = await save(`G-${i}`);
      if (r.status === 200) succeeded++;
      else refusal = { i, ...r };
    }
    // CONTROL FIRST: saves must work until the cap actually bites. Without
    // this, "the first failure was honest" would also pass on a server that
    // refused the very first save for an unrelated reason.
    record('CONTROL: saves succeed until the write limit is actually reached',
      succeeded > 10 && refusal !== null,
      `${succeeded} succeeded, then ${refusal ? `#${refusal.i} -> ${refusal.status}` : 'NEVER failed — the cap never bit'}`);

    if (refusal) {
      record('a save that cannot be written is REFUSED, not reported as saved',
        refusal.status >= 500,
        `status ${refusal.status} ${refusal.text} — a 200 here is the "my games vanished" defect`);
      const disk = existsSync(path.join(userData, 'db.json'))
        ? readFileSync(path.join(userData, 'db.json'), 'utf8') : '';
      let parses = false;
      try { JSON.parse(disk); parses = true; } catch { /* torn */ }
      record('db.json still parses after a write that could not complete',
        parses, `${disk.length} bytes`);
      record('the refused save is absent from disk (no half-written record)',
        !disk.includes(`"G-${refusal.i}"`), `looking for G-${refusal.i}`);
      const list = await fetch(`http://127.0.0.1:${bound}/api/games`)
        .then((r) => r.json()).catch(() => null);
      record('the library is still served after the failed write',
        Array.isArray(list) && list.length === succeeded,
        `served ${list?.length} of ${succeeded} saved`);
    }
  }
  await stop(srv);
  rmSync(userData, { recursive: true, force: true });
  rmSync(capScript, { force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n══════ DESKTOP SHUTDOWN & PATH SHAPES: ${results.length - failed.length}/${results.length} checks passed ══════`);
if (failed.length > 0) {
  console.error(`\n${failed.length} FAILURE(S):`);
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

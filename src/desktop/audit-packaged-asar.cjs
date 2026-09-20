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

if (!process.argv[2]) {
  const all = findAsars();
  if (all.length === 0) {
    console.error('audit-packaged-asar: no app.asar found. Run `npx electron-builder --dir` first, '
      + 'or pass the path. Refusing to report success without an artifact to audit.');
    process.exit(2);
  }
  // Re-run for each bundle rather than auditing one and hoping the rest match.
  // No `break` on failure: the point of an audit is the full list of leaks.
  let worst = 0;
  for (const p of all) {
    const r = require('child_process').spawnSync(process.execPath, [__filename, p],
      { stdio: 'inherit' });
    worst = Math.max(worst, r.status === null ? 1 : r.status);
  }
  if (all.length > 1) console.log(`audit-packaged-asar: audited ${all.length} bundles.`);
  process.exit(worst);
}

const asarPath = process.argv[2];
if (!fs.existsSync(asarPath)) {
  console.error(`audit-packaged-asar: ${asarPath} does not exist. Refusing to report success `
    + 'without an artifact to audit.');
  process.exit(2);
}

const listing = execFileSync('npx', ['asar', 'list', asarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((l) => l.trim()).filter(Boolean);

// Everything shipped OUTSIDE the archive. app.asar lives at
// <App>.app/Contents/Resources/app.asar, so the bundle root is two levels up.
// Walked with fs rather than `find` so a filename with a newline in it cannot
// split into two harmless-looking lines.
const bundleRoot = path.dirname(path.dirname(path.dirname(asarPath)));
const isBundle = bundleRoot.endsWith('.app') && fs.existsSync(path.join(bundleRoot, 'Contents'));
function walk(dir, prefix, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    acc.push(rel);
    // Symlinks are NOT followed into: a link out of the bundle would walk the
    // whole filesystem, and the link's own path is what ships.
    if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(dir, entry.name), rel, acc);
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
const FRAMEWORK_BASELINE = 203; // electron ^31.7.7, darwin-arm64
const frameworkPaths = bundleListing.filter((p) => p.startsWith('/Contents/Frameworks/'));
ok(frameworkPaths.length === FRAMEWORK_BASELINE,
  `the bundle's framework trees hold ${frameworkPaths.length} paths; the recorded baseline is `
  + `${FRAMEWORK_BASELINE}. The allowlist cannot enumerate inside Electron's own frameworks (they `
  + 'are reshuffled every release), so this count is what stands between an afterPack hook and an '
  + 'arbitrary file hidden in them — a `settings.dat` deep in Electron Framework.framework passed '
  + 'all 51 checks before this existed. If you upgraded Electron, update FRAMEWORK_BASELINE in the '
  + 'same commit; if you did not, something wrote into the bundle after packaging.');

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

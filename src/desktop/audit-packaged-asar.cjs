/**
 * Audit the ACTUAL app.asar that electron-builder produced.
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
 * Usage: node src/desktop/audit-packaged-asar.cjs [path/to/app.asar]
 *        (with no argument, finds the one under dist-electron/)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..', '..');

function findAsar() {
  const base = path.join(repo, 'dist-electron');
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base)) {
    const app = path.join(base, dir);
    if (!fs.statSync(app).isDirectory()) continue;
    for (const entry of fs.readdirSync(app)) {
      if (!entry.endsWith('.app')) continue;
      const asar = path.join(app, entry, 'Contents', 'Resources', 'app.asar');
      if (fs.existsSync(asar)) return asar;
    }
  }
  return null;
}

const asarPath = process.argv[2] || findAsar();
if (!asarPath || !fs.existsSync(asarPath)) {
  console.error('audit-packaged-asar: no app.asar found. Run `npx electron-builder --dir` first, '
    + 'or pass the path. Refusing to report success without an artifact to audit.');
  process.exit(2);
}

const listing = execFileSync('npx', ['asar', 'list', asarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((l) => l.trim()).filter(Boolean);

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

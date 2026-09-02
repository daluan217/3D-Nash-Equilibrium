#!/usr/bin/env node
/**
 * Auto-increments the package.json patch version — at most once per release.
 *
 * Run by the pre-commit hook (.githooks/pre-commit). The installed Electron app
 * compares its baked-in app.getVersion() against the published /api/version and
 * prompts users to update when a newer build exists, so every MERGE to main must
 * carry a strictly newer semver than the last. Bumping every commit satisfied
 * that but over-counted: a multi-commit PR jumped several versions per release.
 *
 * Instead, bump only when the working version is not already ahead of
 * origin/main's — the first commit on a branch bumps, later commits ride the
 * same number, and each merged PR lands exactly one version up. If origin/main
 * can't be read (fresh clone, offline fetch state), fall back to bumping:
 * over-counting is harmless, a stale version that ties main's breaks the
 * update prompt.
 *
 * Idempotent within a single commit: the hook stages package.json after bumping,
 * and pre-commit hooks do not recurse, so there is no bump loop.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

const parse = (v) => {
  const parts = String(v || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
};
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
};

let mainVersion = null;
try {
  const mainPkg = execFileSync('git', ['show', 'origin/main:package.json'], { encoding: 'utf-8' });
  mainVersion = parse(JSON.parse(mainPkg).version);
} catch {
  // origin/main unreadable — fall through to an unconditional bump.
}

const cur = parse(pkg.version);
if (mainVersion && newer(cur, mainVersion)) {
  process.stdout.write(`version ${cur.join('.')} already ahead of origin/main (${mainVersion.join('.')}) — no bump\n`);
  process.exit(0);
}

const base = mainVersion && newer(mainVersion, cur) ? mainVersion : cur;
const next = [base[0], base[1], base[2] + 1].join('.');

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// AND THE LOCKFILE, which this script has never touched. package-lock.json
// carries the project's own version in two places, and because only
// package.json was written here the two drifted apart every release — found at
// package.json 0.0.104 against a lock still saying 0.0.90, fourteen releases
// behind. Harmless in itself (checked: all 33 declared dependencies still
// resolve inside their ranges and the lock's root dependency blocks are
// identical to package.json's, so nothing was masked), but a lockfile that
// disagrees with its manifest is exactly the sort of thing that gets waved
// through until the once it matters.
//
// Only the two VERSION fields are rewritten — never the dependency tree. That
// is what `npm version` itself does, and it keeps this hook incapable of
// silently re-resolving a dependency during a commit.
const lockPath = path.join(__dirname, '..', 'package-lock.json');
try {
  const raw = fs.readFileSync(lockPath, 'utf-8');
  const lock = JSON.parse(raw);
  if (lock.name === pkg.name) {
    lock.version = next;
    if (lock.packages && lock.packages['']) lock.packages[''].version = next;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }
} catch {
  // No lockfile, or one this script cannot parse. A version bump must never be
  // the thing that blocks a commit, so this is advisory only.
}

process.stdout.write(`bumped version -> ${next}\n`);

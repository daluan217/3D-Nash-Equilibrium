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

process.stdout.write(`bumped version -> ${next}\n`);

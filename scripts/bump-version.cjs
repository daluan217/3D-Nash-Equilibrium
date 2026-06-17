#!/usr/bin/env node
/**
 * Auto-increments the package.json patch version by one.
 *
 * Run automatically by the pre-commit hook (.githooks/pre-commit) so that every
 * commit produces a distinct, strictly-newer semver. The installed Electron app
 * compares its baked-in app.getVersion() against the published /api/version and
 * prompts users to download the update when a newer build exists. Bumping here
 * guarantees each released build is detectably newer than the last.
 *
 * Idempotent within a single commit: the hook stages package.json after bumping,
 * and pre-commit hooks do not recurse, so there is no bump loop.
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

const parts = String(pkg.version || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
while (parts.length < 3) parts.push(0);
parts[2] += 1; // bump patch
const next = parts.slice(0, 3).join('.');

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

process.stdout.write(`bumped version -> ${next}\n`);

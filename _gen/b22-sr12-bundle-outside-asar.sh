#!/bin/sh
# SR-12: the audit read `asar list` only, so anything electron-builder shipped
# ALONGSIDE app.asar was invisible. `extraResources: ["db.json"]` puts the
# account store at Contents/Resources/db.json — unpacked, world-readable — and
# the audit printed "31 checks passed".
#
# Usage: sh _gen/b22-sr12-bundle-outside-asar.sh   (after `npx electron-builder --dir`)
set -e
cd "$(dirname "$0")/.."
R="dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/Resources"
[ -f "$R/app.asar" ] || { echo "build first: npx electron-builder --dir"; exit 2; }
printf '{"users":[{"email":"a@b.c","hash":"$2b$10$x"}]}' > "$R/db.json"
printf 'SESSION_SECRET=hunter2\n' > "$R/.env"
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node src/desktop/audit-packaged-asar.cjs; rc=$?
rm -f "$R/db.json" "$R/.env"
[ $rc -eq 0 ] && echo "SURVIVED: secrets shipped, audit passed" || echo "KILLED: audit caught them"
exit 0

#!/bin/sh
# SR-21 (self-review, sweep 1 on dea3b86): auditing PATHS cannot see what a
# symlink points AT. A link named harmless.dat inside the sidecar's
# node_modules — squarely in the dependency carve-out — passed all 52 checks
# while resolving to any file on the user's disk.
set -e
cd "$(dirname "$0")/.."
A="dist-electron/mac-arm64/Nash Equilibrium Simulator.app"
[ -f "$A/Contents/Resources/app.asar" ] || { echo "build first: npx electron-builder --dir"; exit 2; }
U="$A/Contents/Resources/app.asar.unpacked"
printf 'secret' > /tmp/b22-sr21-secret.txt
ln -sf /tmp/b22-sr21-secret.txt "$U/node_modules/harmless.dat"
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node src/desktop/audit-packaged-asar.cjs >/dev/null 2>&1 \
  && echo "SURVIVED: symlink out of the bundle shipped unnoticed" || echo "KILLED"
rm -f "$U/node_modules/harmless.dat" /tmp/b22-sr21-secret.txt

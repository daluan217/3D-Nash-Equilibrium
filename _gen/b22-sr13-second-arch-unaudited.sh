#!/bin/sh
# SR-13: findAsar() returned the FIRST app.asar it found. mac.target is
# ["dmg","zip"] and a universal/x64 build emits mac-arm64/ and mac-x64/ side by
# side — both uploaded. A leak confined to the second slice was audited by
# nobody and the run exited 0.
set -e
cd "$(dirname "$0")/.."
SRC="dist-electron/mac-arm64/Nash Equilibrium Simulator.app"
[ -f "$SRC/Contents/Resources/app.asar" ] || { echo "build first: npx electron-builder --dir"; exit 2; }
X="dist-electron/mac-x64/Nash Equilibrium Simulator.app/Contents"
mkdir -p "$X/Resources" "$X/MacOS"
cp "$SRC/Contents/Resources/app.asar" "$X/Resources/app.asar"
printf 'x' > "$X/MacOS/Nash Equilibrium Simulator"
printf '{"users":[{"email":"leak@x.c"}]}' > "$X/Resources/db.json"
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node src/desktop/audit-packaged-asar.cjs; rc=$?
rm -rf dist-electron/mac-x64
[ $rc -eq 0 ] && echo "SURVIVED: second slice never audited" || echo "KILLED"
exit 0

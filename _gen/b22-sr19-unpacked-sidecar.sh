#!/bin/sh
# SR-19 (9router reviewer, 2nd pass): the bundle walk excluded the PREFIX
# '/Contents/Resources/app.asar', which also swallowed the sibling directory
# app.asar.unpacked/ — a real shipped surface that `asar list` cannot see
# either. A db.json planted there passed all 51 checks.
# Second finding in the same message: `settings.dat` deep inside
# Electron Framework.framework also passed (the allowlist waves framework
# trees through wholesale and the denylist only knows secret-shaped names).
set -e
cd "$(dirname "$0")/.."
A="dist-electron/mac-arm64/Nash Equilibrium Simulator.app"
[ -f "$A/Contents/Resources/app.asar" ] || { echo "build first: npx electron-builder --dir"; exit 2; }
U="$A/Contents/Resources/app.asar.unpacked"
F="$A/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
for T in "$U/db.json" "$F/settings.dat"; do
  printf '{"users":[{"email":"AFTERPACK_CANARY"}]}' > "$T"
  PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node src/desktop/audit-packaged-asar.cjs >/dev/null 2>&1 \
    && echo "SURVIVED: $T" || echo "KILLED:   $T"
  rm -f "$T"
done

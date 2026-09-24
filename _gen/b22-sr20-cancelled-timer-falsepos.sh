#!/bin/sh
# SR-20 (self-review, sweep 1): the timer census counted a CANCELLED timer as
# still armed. electron-main.cjs already arms a slow-boot fallback and clears
# it when the window opens, so the check was one refactor away from firing on
# correct code — and a check that cries wolf gets switched off, which would
# have made `setTimeout(...); clearTimeout(...)` a place to hide a beacon.
set -e
cd "$(dirname "$0")/.."
cp electron-main.cjs /tmp/b22-main-sr20.bak
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node -e "
const f=require('fs');let s=f.readFileSync('electron-main.cjs','utf8');
s=s.replace(/(app\.commandLine\.appendSwitch\([^\n]*\n)/, '\$1{ const t = setTimeout(() => {}, 90000); clearTimeout(t); }\n');
f.writeFileSync('electron-main.cjs',s);"
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node src/integration/electron-behavior.test.mjs >/dev/null 2>&1 \
  && echo "PASS (correct): a cancelled timer is not reported as armed" \
  || echo "FALSE POSITIVE: a cancelled timer reported as armed"
cp /tmp/b22-main-sr20.bak electron-main.cjs

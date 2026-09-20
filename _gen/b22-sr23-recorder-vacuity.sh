#!/bin/sh
# SR-23 (self-review, sweep 1 on c4d1d89): every preload verdict is "the list
# came back empty", which is also what a BROKEN RECORDER produces. Four ways of
# breaking one each left all 433 checks green. The egress mode's positive
# control covers a different fetch (the update-reply stub ~650 lines down), so
# it could not see any of them.
set -e
cd "$(dirname "$0")/.."
R=src/desktop/electron-behavior-runner.cjs
cp "$R" /tmp/b22-run-sr23.bak
for M in "preloadNetworkCalls: networkCalls.slice(networkCallsBeforePreload),|preloadNetworkCalls: []," \
         "const full = { pendingTimers: pendingTimersNow(), ...payload };|const full = { pendingTimers: [], ...payload };" \
         "outboundDoors: doorsOfferedToPreload,|outboundDoors: ['fetch','XMLHttpRequest','WebSocket','sendBeacon']," ; do
  cp /tmp/b22-run-sr23.bak "$R"
  FROM=${M%%|*}; TO=${M#*|}
  FROM="$FROM" TO="$TO" PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node -e "
  const f=require('fs');let s=f.readFileSync('$R','utf8');
  f.writeFileSync('$R', s.replace(process.env.FROM, process.env.TO));"
  PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node src/integration/electron-behavior.test.mjs >/dev/null 2>&1 \
    && echo "SURVIVED: $TO" || echo "KILLED:   $TO"
done
cp /tmp/b22-run-sr23.bak "$R"

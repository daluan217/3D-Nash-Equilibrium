#!/bin/sh
# SR-15 (9router reviewer, finding 1): desktopAuthSecret() returned an existing
# VALID 64-hex key before reaching the chmod, so a world-writable key was
# reused as-is on every launch after the first. The earlier mode fix only
# covered the REWRITE path (key rejected), which is the rare one.
set -e
cd "$(dirname "$0")/.."
W="$PWD"; D=$(mktemp -d); E=$(mktemp -d)
PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH" node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "$D/auth-secret"
chmod 0666 "$D/auth-secret"; K1=$(cat "$D/auth-secret")
echo "before: mode=$(stat -f '%Lp' "$D/auth-secret")"
(cd "$E" && env -i PATH="$HOME/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin" \
  IS_ELECTRON=true ELECTRON_USER_DATA_PATH="$D" PORT=4893 node "$W/dist/server.cjs" >"$D/srv.log" 2>&1 &)
i=0; while [ $i -lt 60 ]; do curl -sf -o /dev/null http://127.0.0.1:4893/ && break; sleep 0.25; i=$((i+1)); done
echo "after:  mode=$(stat -f '%Lp' "$D/auth-secret") key_preserved=$([ "$K1" = "$(cat "$D/auth-secret")" ] && echo YES || echo NO)"
lsof -ti :4893 | xargs kill 2>/dev/null || true; rm -rf "$D" "$E"

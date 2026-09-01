#!/bin/bash
# BLUE — WINDOW 6 mutation test for the META screen.
#
# Four guards, four mutations. Each guard was added because a MEASURED case
# needed it, so each must be provably necessary: break it, and the suite must
# go red at that guard's own control. The two most important are N1 and N4 —
# both are the shape a careless version of this screen would have shipped, and
# both are cheap mistakes that look free on a rate.
#
#   N1  drop the negative lookbehind      -> cloud's good shape is rejected (20.0% vs 1.2%)
#   N2  drop the hyphen boundary          -> the real "game-day menu" draw is rejected
#   N3  drop the product-vocabulary guard -> the video-game studio is rejected
#   N4  add bare "the players" back       -> the puppet-theatre company is rejected
#
# Restores the file unconditionally on exit.
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
F=src/utils/nashValidator.ts
cp "$F" /tmp/blue_w6_validator.bak
trap 'cp /tmp/blue_w6_validator.bak "$F"; echo "[restored]"' EXIT
run() { npx tsx src/unit.test.ts 2>&1 | tail -2; }

echo "=== BASELINE ==="; run

mutate() { # $1 = label, $2 = python replacement body
  cp /tmp/blue_w6_validator.bak "$F"
  echo; echo "=== $1 ==="
  python3 - "$2" <<'PY'
import io, sys
p = 'src/utils/nashValidator.ts'
s = io.open(p, encoding='utf-8').read()
old, new = sys.argv[1].split('|||')
assert old in s, f'anchor missing, mutation did not apply -> result would be meaningless: {old[:60]}'
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('applied')
PY
  run
}

mutate "N1: drop the negative lookbehind on the bare-letter form" \
'  /(?<![\p{L}\p{N}][ \t]|[\p{L}\p{N}])\b[AB]\b\s+(?:chooses?|||  /\b[AB]\b\s+(?:chooses?'

mutate "N2: drop the hyphen boundary on \"the game\"" \
'if (!/\bthe\s+game\b(?![-\w])/i.test(s)) continue;|||if (!/\bthe\s+game\b/i.test(s)) continue;'

mutate "N3: drop the product-vocabulary guard" \
'    if (GAME_PRODUCT_VOCAB.test(s)) continue;
|||'

mutate "N4: add bare \"the players\" back to the cast form" \
'const META_GAME_CAST = /\b(?:the\s+two\s+players|both\s+players|each\s+player)\b/i;|||const META_GAME_CAST = /\b(?:the\s+two\s+players|both\s+players|each\s+player|the\s+players)\b/i;'

cp /tmp/blue_w6_validator.bak "$F"
echo; echo "=== RESTORED ==="; run

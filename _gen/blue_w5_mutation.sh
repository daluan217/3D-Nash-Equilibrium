#!/bin/bash
# BLUE — WINDOW 5 mutation test. Each new rule must be PROVEN NECESSARY by its
# own fixture: break the rule, and the suite must go red at that specific
# assertion. A fix whose test still passes when the fix is removed is not a
# tested fix — this campaign has already shipped one of those.
#
# Both mutations are the spelling a CARELESS version of the fix would use:
#   M1  `[-\s]+` written back as `\s+`  -> the punctuation hole L10 reopens
#   M2  the big-quantity screen removed -> L7 reopens
#
# Restores the file unconditionally on exit.
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
F=src/utils/nashValidator.ts
cp "$F" /tmp/blue_w5_validator.bak
trap 'cp /tmp/blue_w5_validator.bak "$F"; echo "[restored]"' EXIT

run() { npx tsx src/unit.test.ts 2>&1 | tail -3; }

echo "=== BASELINE (unmutated) ==="
run

echo
echo "=== M1: revert the hyphen fix to the whitespace-only spelling ==="
python3 - <<'PY'
import io
p='src/utils/nashValidator.ts'; s=io.open(p,encoding='utf-8').read()
old=r'\borders?[-\s]+of[-\s]+magnitude\b'
new=r'\borders?\s+of\s+magnitude\b'
assert old in s, 'M1 anchor missing — mutation did not apply, result would be meaningless'
io.open(p,'w',encoding='utf-8').write(s.replace(old,new,1))
print('M1 applied')
PY
run

cp /tmp/blue_w5_validator.bak "$F"
echo
echo "=== M2: delete the big-spelled-quantity screen ==="
python3 - <<'PY'
import io
p='src/utils/nashValidator.ts'; s=io.open(p,encoding='utf-8').read()
old='    if (BIG_SPELLED_QUANTITY.test(raw)) return { ok: false, reason: `${where} cites a large quantity` };\n'
assert old in s, 'M2 anchor missing — mutation did not apply, result would be meaningless'
io.open(p,'w',encoding='utf-8').write(s.replace(old,'',1))
print('M2 applied')
PY
run

cp /tmp/blue_w5_validator.bak "$F"
echo
echo "=== M3: widen to red's D4 as written (\\w+fold, twice, dozens) ==="
python3 - <<'PY'
import io
p='src/utils/nashValidator.ts'; s=io.open(p,encoding='utf-8').read()
old='const BIG_SPELLED_QUANTITY = /\\b(?:hundreds?|thousands?|millions?|billions?|trillions?)\\b/i;'
new='const BIG_SPELLED_QUANTITY = /\\b(?:hundreds?|thousands?|millions?|billions?|dozens?|twice|thrice|\\w+fold)\\b/i;'
assert old in s, 'M3 anchor missing — mutation did not apply, result would be meaningless'
io.open(p,'w',encoding='utf-8').write(s.replace(old,new,1))
print('M3 applied')
PY
run

echo
echo "=== RESTORED — final check ==="
cp /tmp/blue_w5_validator.bak "$F"
run

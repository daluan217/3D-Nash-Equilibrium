#!/bin/bash
# Mutation test for testOracleGateHoles: every mutant must FAIL, and each must
# fail on the assertion that names the property it broke. Run from the repo root.
set -u
cd "$(dirname "$0")/.."
F=src/utils/nashValidator.ts
cp "$F" /tmp/nv.orig
mut () { python3 - "$1" "$2" <<'PY'
import sys
old, new = sys.argv[1], sys.argv[2]
s = open('src/utils/nashValidator.ts').read()
assert s.count(old) == 1, f'anchor matched {s.count(old)} times'
open('src/utils/nashValidator.ts', 'w').write(s.replace(old, new))
PY
}
run () { npx tsx src/unit.test.ts >/tmp/gout 2>&1; local e=$?; echo "  exit=$e"; grep -A2 'Unit test suite failure' /tmp/gout | tail -2
  if [ "$1" = must-fail ] && [ $e -eq 0 ]; then echo "  !! MUTANT SURVIVED"; fi
  if [ "$1" = must-pass ] && [ $e -ne 0 ]; then echo "  !! BASELINE BROKEN"; fi; }

echo "== M0 baseline (must pass)"; cp /tmp/nv.orig "$F"; run must-pass

echo "== M1 cast noun: rule removed"
cp /tmp/nv.orig "$F"; mut "    [META_CAST_CONSTRUCTION, 'the game\\'s cast noun in a game-theoretic construction (\"the row player\", \"the players are…\")']," ""; run must-fail

echo "== M2 cast noun: WIDENED to the bare noun (the refused collision)"
cp /tmp/nv.orig "$F"; mut "const META_CAST_CONSTRUCTION =
  /\\b(?:(?:row|column|col)\\s+player|(?:first|second)\\s+player|the\\s+players\\s+are|are\\s+the\\s+players|players['’]\\s+(?:decisions?|choices?|moves?|actions?)|either\\s+player|any\\s+player|each\\s+of\\s+the\\s+players)\\b/i;" "const META_CAST_CONSTRUCTION = /\\bplayers?\\b/i;"; run must-fail

echo "== M3 bare letter: verb list reverted to the shipped one"
cp /tmp/nv.orig "$F"; mut "|books?|takes?|runs?|schedules?|sets?|opts?|holds?|weighs?|operates?|faces?|uses?|goes?|plans?|manages?|serves?|considers?)\\b/u;" ")\\b/u;"; run must-fail

echo "== M4 bare letter: LOOKBEHIND dropped under the widened list"
cp /tmp/nv.orig "$F"; mut "  /(?<![\\p{L}\\p{N}][ \\t]|[\\p{L}\\p{N}])\\b[AB]\\b\\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|prefers?|is|are|will|must|can|has|have|books?" "  /\\b[AB]\\b\\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|prefers?|is|are|will|must|can|has|have|books?"; run must-fail

echo "== M4b apposition: rule removed"
cp /tmp/nv.orig "$F"; mut '    [META_LETTER_IN_APPOSITION, ' '    [/(?!)/, '; run must-fail

echo "== M4c apposition: LOOKBEHIND dropped"
cp /tmp/nv.orig "$F"; mut 'const META_LETTER_IN_APPOSITION = /(?<![\p{L}\p{N}][ \t]|[\p{L}\p{N}])\b[AB],' 'const META_LETTER_IN_APPOSITION = /\b[AB],'; run must-fail

echo "== M5 same-actor: rule removed"
cp /tmp/nv.orig "$F"; mut "    [theSameActorTakesTheSecondPair, \"a second set of options given back to the same named actor\"]," ""; run must-fail

echo "== M6 same-actor: CLAUSE ANCHOR dropped"
cp /tmp/nv.orig "$F"; mut "  /(?:^|[.;!?]\\s+)the\\s+same\\s+[a-z][\\w'’-]{2,}\\s+(?:chooses|picks|decides|selects|takes|books|opts)\\b/i;" "  /the\\s+same\\s+[a-z][\\w'’-]{2,}\\s+(?:chooses|picks|decides|selects|takes|books|opts)\\b/i;"; run must-fail

echo "== M7 payoff citation: the old lookahead restored"
cp /tmp/nv.orig "$F"; mut "([-−–]?\\d+)(?!\\d)(?![.,]\\d)(?![×x%])/gi" "([-−–]?\\d+)(?![.\\d×x%])/gi"; run must-fail

echo "== M8 payoff citation: lookahead removed ENTIRELY (decimals must break)"
cp /tmp/nv.orig "$F"; mut "([-−–]?\\d+)(?!\\d)(?![.,]\\d)(?![×x%])/gi" "([-−–]?\\d+)/gi"; run must-fail

cp /tmp/nv.orig "$F"; echo "== restored"; run must-pass

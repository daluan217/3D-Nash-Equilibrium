#!/bin/bash
# Mutation test for _gen/verify_screens.ts: every mutant must FAIL the suite,
# and each must fail on the assertion that names the property it broke.
# Run from the repo root.  Output is recorded in _gen/blue/screens_mutation.txt.
set -u
cd "$(dirname "$0")/.."
TS=_gen/trainset_screens.ts
BS=_gen/bank_screens.ts
cp "$TS" /tmp/ts.orig; cp "$BS" /tmp/bs.orig
restore () { cp /tmp/ts.orig "$TS"; cp /tmp/bs.orig "$BS"; }
mut () {  # file old new
  python3 - "$1" "$2" "$3" <<'PY'
import sys
f, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(f).read()
assert s.count(old) == 1, f'anchor matched {s.count(old)} times in {f}'
open(f, 'w').write(s.replace(old, new))
PY
}
run () {
  npx tsx _gen/verify_screens.ts >/tmp/sout 2>&1; local e=$?
  echo "  exit=$e"; grep '✗' /tmp/sout | head -6
  if [ "$1" = "must-fail" ] && [ $e -eq 0 ]; then echo "  !! MUTANT SURVIVED"; fi
  if [ "$1" = "must-pass" ] && [ $e -ne 0 ]; then echo "  !! BASELINE BROKEN"; fi
}

echo "== M0 baseline (must pass)"; restore; run must-pass

echo "== M1 truncated: the ORIGINAL class, straight quote only"
restore; mut "$TS" "!/[.!?][\")'\\]”’]*\$/.test(t)" "!/[.!?\"')\\]]\$/.test(t)"; run must-fail

echo "== M2 truncated: the NAIVE widening — curly quotes added to the class"
restore; mut "$TS" "!/[.!?][\")'\\]”’]*\$/.test(t)" "!/[.!?\"')\\]”’]\$/.test(t)"; run must-fail

echo "== M3 article: the ORIGINAL i-flagged a-half"
restore; mut "$TS" "const A_BEFORE_VOWEL = /(?:\\ba|(?:^|[.!?;:][\"”’']?\\s+)A)\\s+([aeiou][\\w-]*)/g;" "const A_BEFORE_VOWEL = /\\ba\\s+([aeiou][\\w-]*)/gi;"; run must-fail

echo "== M4 article: case-sensitive but NO consonant-sound exception"
restore; mut "$TS" "    if (A_BEFORE_CONSONANT_SOUND.test(w)) continue;" "    if (false) continue;"; run must-fail

echo "== M5 article: the and/or guard removed"
restore; mut "$TS" "const NOT_AN_ARTICLE = new RegExp(\`^(?:and|or|\${LETTER_VERBS})\$\`, 'i');" "const NOT_AN_ARTICLE = new RegExp(\`^(?:\${LETTER_VERBS})\$\`, 'i');"; run must-fail

echo "== M6 article: the an-half deleted"
restore; mut "$TS" "  return /\\ban\\s+(?![aeiouAEIOU]|hour|honest|honou?r)[bcdfgjklmnpqrstvwxyz]\\w/i.test(t);" "  return false;"; run must-fail

echo "== M7 article: the an-half made case-SENSITIVE"
restore; mut "$TS" "[bcdfgjklmnpqrstvwxyz]\\w/i.test(t);" "[bcdfgjklmnpqrstvwxyz]\\w/.test(t);"; run must-fail

echo "== M8 article: the a-half deleted"
restore; mut "$TS" "    if (A_BEFORE_CONSONANT_SOUND.test(w)) continue;
    return true;" "    if (A_BEFORE_CONSONANT_SOUND.test(w)) continue;
    return false;"; run must-fail

echo "== M15 article: the SENTENCE-INITIAL branch removed"
restore; mut "$TS" '(?:\ba|(?:^|' '(?:\ba|(?:\bZZZNEVER'; run must-fail

echo "== M9 meta: the bare cast noun removed"
restore; mut "$TS" "  if (CAST_NOUN.test([s.name, s.row1, s.row2, s.col1, s.col2, t].filter(Boolean).join(' '))) return true;" "  if (false) return true;"; run must-fail

echo "== M10 meta: the cast noun scoped to the description only"
restore; mut "$TS" "CAST_NOUN.test([s.name, s.row1, s.row2, s.col1, s.col2, t].filter(Boolean).join(' '))" "CAST_NOUN.test(t)"; run must-fail

echo "== M11 meta: the cast noun anchored to the word 'play' rather than the noun"
restore; mut "$TS" "const CAST_NOUN = /\\bplayers?\\b/i;" "const CAST_NOUN = /play/i;"; run must-fail

echo "== M12 exposure: the accepted both-parties over-fire NARROWED away"
restore; mut "$BS" "  'at stake',
  'at risk'," "  '(more|less|greater|smaller) at stake',
  'at risk',"; run must-fail

echo "== M13 exposure: the whole screen disabled"
restore; mut "$BS" "  return EXPOSURE_PHRASE.test(s.description ?? '');" "  return false;"; run must-fail

echo "== M14 exposure: 'depends heavily' removed (the no-stake-word asymmetry)"
restore; mut "$BS" "  '(depends?|depend|relies?|rely) heavily'," "  'zzz_never_matches',"; run must-fail

restore
echo "== restored"; run must-pass

#!/usr/bin/env python3
"""BLUE — WINDOW 6 mutation test for the META screen.

Five guards, five mutations. Each guard exists because a MEASURED case needed
it, so each must be provably necessary: break it, and the suite must go red at
that guard's own control.

WHY THIS IS PYTHON AND NOT THE ORIGINAL SHELL SCRIPT. The shell version passed
each mutation as a single-quoted argument containing a ||| separator, and for
N5 — whose replacement text contains single quotes — the separator did not
survive the shell. The python step then raised, the helper printed the
traceback, AND RAN THE SUITE ANYWAY on the unmutated file, which reported "All
unit tests passed". A mutation that never applied read exactly like a guard
that survived deletion.

That is this campaign's own theme landing inside the detector, and it is the
third time this window a test could not fail for the reason it claimed. Here the
mutation data never touches a shell, and a mutation that fails to apply VOIDS
its own result instead of reporting a pass.

    python3 _gen/blue_w6_mutation.py
"""
import io
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
F = os.path.join(ROOT, 'src/utils/nashValidator.ts')
BAK = '/tmp/blue_w6_validator.bak'
ENV = dict(os.environ, PATH='/opt/homebrew/opt/node@22/bin:' + os.environ['PATH'])

MUTATIONS = [
    ('N1: drop the negative lookbehind on the bare-letter form',
     r'  /(?<![\p{L}\p{N}][ \t]|[\p{L}\p{N}])\b[AB]\b\s+(?:chooses?',
     r'  /\b[AB]\b\s+(?:chooses?'),
    ('N2: drop the hyphen boundary on "the game"',
     r"if (!/\bthe\s+game\b(?![-\w])/i.test(s)) continue;",
     r"if (!/\bthe\s+game\b/i.test(s)) continue;"),
    ('N3: drop the product-vocabulary guard',
     "    if (GAME_PRODUCT_VOCAB.test(s)) continue;\n",
     ""),
    ('N4: add bare "the players" back to the cast form',
     r"const META_GAME_CAST = /\b(?:the\s+two\s+players|both\s+players|each\s+player)\b/i;",
     r"const META_GAME_CAST = /\b(?:the\s+two\s+players|both\s+players|each\s+player|the\s+players)\b/i;"),
    ('N5: delete the payoff form',
     "    [META_PAYOFF,",
     "    [/(?!)/,"),
]


def run_suite():
    r = subprocess.run([os.path.join(ROOT, 'node_modules/.bin/tsx'), 'src/unit.test.ts'],
                       cwd=ROOT, env=ENV, capture_output=True, text=True)
    tail = [l for l in (r.stdout + r.stderr).strip().split('\n') if l.strip()][-2:]
    return r.returncode, '\n'.join('    ' + l for l in tail)


original = io.open(F, encoding='utf-8').read()
io.open(BAK, 'w', encoding='utf-8').write(original)
failures = []
try:
    code, tail = run_suite()
    print('=== BASELINE ===')
    print(tail)
    if code != 0:
        print('\nBASELINE IS RED. Every mutation below would be meaningless. Stopping.')
        sys.exit(1)

    for name, old, new in MUTATIONS:
        print('\n=== %s ===' % name)
        if old not in original:
            print('    >>> RESULT VOID — anchor not found, the mutation never applied.')
            failures.append(name + ' (anchor missing)')
            continue
        io.open(F, 'w', encoding='utf-8').write(original.replace(old, new, 1))
        code, tail = run_suite()
        io.open(F, 'w', encoding='utf-8').write(original)
        if code == 0:
            print('    >>> GUARD NOT TESTED — the suite still passes with this guard removed.')
            print(tail)
            failures.append(name + ' (survived)')
        else:
            print('    killed by:')
            print(tail)
finally:
    io.open(F, 'w', encoding='utf-8').write(original)
    print('\n[restored]')

code, tail = run_suite()
print('=== RESTORED ===')
print(tail)
if failures:
    print('\nMUTATIONS THAT PROVED NOTHING: %s' % ', '.join(failures))
    sys.exit(1)
print('\nAll %d guards proven necessary.' % len(MUTATIONS))

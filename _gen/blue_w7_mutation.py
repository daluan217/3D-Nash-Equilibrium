#!/usr/bin/env python3
"""
BLUE — WINDOW 7: mutation test for the new two-chooser rule, one condition at a
time.

Written in the shape W6 had to be rewritten into, for the reason recorded there:
the first mutation harness passed each mutation through a SHELL as a quoted
argument, a replacement containing a quote broke the separator, python raised,
the traceback was printed AND THE SUITE RAN ANYWAY on the unmutated file. A
mutation that never applied read exactly like a guard surviving deletion.

So here: the mutation data never touches a shell, a mutation that fails to apply
VOIDS its own result rather than reporting a pass, and a guard whose removal
changes nothing is reported as GUARD NOT TESTED with a non-zero exit.

    python3 _gen/blue_w7_mutation.py
"""
import subprocess, sys, shutil, pathlib

BLUE = pathlib.Path('/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/'
                    '5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/blue')
TARGET = BLUE / 'src/utils/nashValidator.ts'
SUITE = '/tmp/blue_w7_newrule.mjs'
# CLAUDE.md's homebrew path is stale here: node 22 is the nvm default on this box.
NODE = '/Users/danielluan/.nvm/versions/node/v22.12.0/bin'

MUTATIONS = [
    ('M1 drop condition (a), the one-pair-only test',
     '  if (!((rowsIn === 2 && colsIn === 0) || (colsIn === 2 && rowsIn === 0))) return false;',
     '  void rowsIn; void colsIn;'),
    ('M2 drop condition (b), the collective-subject requirement',
     '  return collective > 0 && specific === 0;',
     '  return specific === 0;'),
    ('M3 drop condition (c), the no-second-specific-chooser guard',
     '  return collective > 0 && specific === 0;',
     '  return collective > 0;'),
    ('M4 drop the "introduced plural" branch (THE BEEKEEPERS must choose)',
     '      || introduced.has(last);',
     '      || false;'),
]


def run_suite() -> subprocess.CompletedProcess:
    import os
    env = dict(os.environ, PATH=f'{NODE}:' + os.environ.get('PATH', ''))
    return subprocess.run([f'{NODE}/npx', 'tsx', SUITE], cwd=BLUE, env=env,
                          capture_output=True, text=True, timeout=300)


original = TARGET.read_text()
backup = TARGET.with_suffix('.ts.w7bak')
shutil.copy(TARGET, backup)

base = run_suite()
if base.returncode != 0:
    print('BASELINE SUITE FAILS BEFORE ANY MUTATION — run void.')
    print(base.stdout, base.stderr)
    sys.exit(1)
print(f'baseline: {base.stdout.strip()}\n')

failures = 0
try:
    for name, anchor, replacement in MUTATIONS:
        if anchor not in original:
            print(f'{name}: VOID — anchor not found in the file. This mutation never applied, '
                  f'so it proves nothing. (This is the exact shape that made W6 report a pass.)')
            failures += 1
            continue
        mutated = original.replace(anchor, replacement, 1)
        if mutated == original:
            print(f'{name}: VOID — replacement changed nothing.')
            failures += 1
            continue
        TARGET.write_text(mutated)
        r = run_suite()
        TARGET.write_text(original)
        if r.returncode == 0:
            print(f'{name}: GUARD NOT TESTED — the suite still passes with this condition removed.')
            print(f'    {r.stdout.strip()}')
            failures += 1
        else:
            killed = [l for l in (r.stdout + r.stderr).splitlines() if 'FALSE POSITIVE' in l or 'NOT CAUGHT' in l]
            print(f'{name}: killed by {len(killed)} fixture(s)')
            for l in killed:
                print(f'    {l.strip()}')
finally:
    TARGET.write_text(original)
    backup.unlink(missing_ok=True)

print()
if failures:
    print(f'{failures} mutation(s) VOID or SURVIVED — the rule is not fully guarded.')
    sys.exit(1)
print(f'all {len(MUTATIONS)} conditions proved necessary: removing each one breaks a fixture.')

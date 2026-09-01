#!/usr/bin/env python3
"""
BLUE — WINDOW 8: mutation test for the three debris rules, one at a time.

Same shape as W7's, for the reason recorded there: a mutation harness that runs
the suite after a mutation FAILED TO APPLY reports a surviving guard as a pass.
Here a mutation that does not apply VOIDS its own result, and a rule whose
removal changes nothing is reported as GUARD NOT TESTED with a non-zero exit.

The isolating fixtures matter as much as the mutations: both observed dirty rows
carry two signals each, so a suite built only from them could not kill any single
rule's deletion.

    python3 _gen/blue_w8_debris_mutation.py
"""
import subprocess, sys, shutil, pathlib, os

ROOT = pathlib.Path(__file__).resolve().parents[1]
TARGET = ROOT / 'src/utils/nashValidator.ts'
NODE = '/Users/danielluan/.nvm/versions/node/v22.12.0/bin'

MUTATIONS = [
    ('M1 delete the foreign-script rule',
     '    const foreign = FOREIGN_SCRIPT.exec(authored);',
     '    const foreign = null as RegExpExecArray | null; void FOREIGN_SCRIPT;'),
    ('M2 delete the brace rule',
     "    if (BRACE_DEBRIS.test(authored)) issues.push('text contains a curly brace — JSON structure leaked into the story');",
     '    void BRACE_DEBRIS;'),
    ('M3 delete the self-talk rule',
     "    const talk = SELF_TALK.exec(sc.description ?? '');",
     '    const talk = null as RegExpExecArray | null; void SELF_TALK;'),
    # Anchors are RAW here. The first draft built them with escaped Python
    # strings and neither matched the file; both were reported VOID rather than
    # as passes, which is the harness doing its job.
    ('M4 drop the curly apostrophe from the self-talk list',
     r"\blet['\u2019]?s formulate\b",
     r"\blet'?s formulate\b"),
    ('M5 widen the script set to any letter (the careless version)',
     r"/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{White_Space}\p{Symbol}\p{Mark}]/u",
     r"/[^\p{L}\p{Number}\p{Punctuation}\p{White_Space}\p{Symbol}\p{Mark}]/u"),
]


def run():
    env = dict(os.environ, PATH=f'{NODE}:' + os.environ.get('PATH', ''))
    return subprocess.run([f'{NODE}/npx', 'tsx', 'src/unit.test.ts'], cwd=ROOT, env=env,
                          capture_output=True, text=True, timeout=300)


original = TARGET.read_text()
base = run()
if base.returncode != 0:
    print('BASELINE FAILS BEFORE ANY MUTATION — run void.')
    print(base.stdout[-2000:], base.stderr[-2000:])
    sys.exit(1)
print('baseline: unit suite green\n')

failures = 0
try:
    for name, anchor, repl in MUTATIONS:
        if anchor not in original:
            print(f'{name}: VOID — anchor not present. The mutation never applied, so it proves nothing.')
            failures += 1
            continue
        mutated = original.replace(anchor, repl, 1)
        if mutated == original:
            print(f'{name}: VOID — replacement changed nothing.')
            failures += 1
            continue
        TARGET.write_text(mutated)
        r = run()
        TARGET.write_text(original)
        if r.returncode == 0:
            print(f'{name}: GUARD NOT TESTED — the suite still passes with this removed.')
            failures += 1
        else:
            killed = [l.strip() for l in (r.stdout + r.stderr).splitlines() if 'DEBRIS' in l]
            print(f'{name}: killed by -> {killed[0] if killed else "(a non-debris assertion; check this)"}')
            if not killed:
                failures += 1
finally:
    TARGET.write_text(original)

print()
if failures:
    print(f'{failures} mutation(s) VOID or SURVIVED — the rules are not fully guarded.')
    sys.exit(1)
print(f'all {len(MUTATIONS)} mutations killed by a debris fixture: every rule and both boundaries are load-bearing.')

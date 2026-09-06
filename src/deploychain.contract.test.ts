/**
 * Deploy-chain contract: the live site is verified BEFORE anything ships from it.
 *
 * Daniel's requirement, in his words: "does the google cloud only build after the
 * checks in actions pass for the live production site? That's the way it should
 * work" and "I don't want the dmg version updated until the live site is verified
 * by the tests." The chain that satisfies it is one door:
 *
 *     PR -> Test (on the up-to-date branch; branch protection requires it)
 *     push to main -> Deploy site (verifies the merged head's checks) -> Cloud Build -> Cloud Run
 *                  -> Live smoke -> Release desktop
 *
 * Branch protection's strict up-to-date rule makes the PR's tested tree the merge
 * commit's tree, so the suite is not rerun on main (2026-09-06: it re-tested the
 * same tree and held every deploy for a CI cycle). What protection cannot do is
 * gate a direct push, so deploy-site.yml refuses any push that is not a merge
 * commit whose PR head carries the six required checks green. The Cloud Build
 * push trigger is disabled; deploy-site.yml dispatches it and waits for it.
 *
 * WHY THESE CHECKS AND NOT A REVIEW: every guard in this repo that was ever
 * "obviously correct by inspection" and unguarded has since been found unable to
 * fire. So each check below carries a KNOWN-POSITIVE FIXTURE it must flag,
 * asserted in this same run. A check that reports a clean negative rate without
 * ever proving it can go positive is the defect class this file exists to stop
 * (see _gen/verify_geom.ts in CLAUDE.md for the first instance).
 *
 * It earned its keep immediately: the first draft of the checkout regex ended its
 * lookahead with `\Z`, which JavaScript does not support — it is a literal "Z".
 * The check still flagged both real workflows (their checkout steps are followed
 * by more content), so a review would have passed it. The fixture, whose checkout
 * is the last line, could not match at all and failed loudly.
 */
import { readFileSync } from 'node:fs';

function fail(msg: string): never {
  console.error(`✗ deploy chain: ${msg}`);
  process.exit(1);
}

const WF = '.github/workflows/';
const read = (f: string) => readFileSync(WF + f, 'utf8');

/* ---------------------------------------------------------------- check 1
 * A workflow_run-triggered job that checks out code must pin the ref.
 *
 * GITHUB_SHA under workflow_run is the DEFAULT BRANCH HEAD, not the commit the
 * upstream run verified. A merge landing between Live smoke finishing and the
 * release starting would be built into the DMG having never been smoke-tested —
 * precisely the hole the chain exists to close, reopened by an omitted input.
 */
function unpinnedCheckout(yaml: string): boolean {
  if (!/^\s*workflow_run:/m.test(yaml)) return false;
  // A checkout pinned to the sha the upstream run RECORDED (deployed-sha artifact → steps.sha) is pinned too.
  if (/name: deployed-sha[\s\S]*ref: \$\{\{ steps\.sha\.outputs\.sha \}\}/.test(yaml)) return false;
  // Each checkout step, plus whatever `with:` block is indented under it.
  for (const m of yaml.matchAll(/^(\s*)-\s*uses:\s*actions\/checkout@[^\s]+\s*$([\s\S]*?)(?=^\1-\s|^\S|(?![\s\S]))/gm)) {
    const withBlock = m[2] ?? '';
    if (!/^\s*ref:\s*\S/m.test(withBlock)) return true;
    if (!/head_sha/.test(withBlock)) return true;
  }
  return false;
}

for (const f of ['release-desktop.yml', 'live-smoke.yml']) {
  if (unpinnedCheckout(read(f))) {
    fail(
      `${f} is triggered by workflow_run and checks out code without ref: `
      + '${{ github.event.workflow_run.head_sha }}. Under workflow_run GITHUB_SHA is the default '
      + 'branch head, so this builds whatever landed on main most recently — NOT the commit the '
      + 'upstream workflow verified.',
    );
  }
}

/* ---------------------------------------------------------------- check 2
 * The DMG waits for the LIVE SITE, not for Test. Test passing means the code is
 * good; it says nothing about whether the deploy reached production intact.
 */
const desktop = read('release-desktop.yml');
const trigger = desktop.match(/workflow_run:[\s\S]*?workflows:\s*(\[[^\]]*\]|(?:\n\s*-\s*.+)+)/);
if (!trigger) fail('release-desktop.yml has no workflow_run.workflows list');
if (!/Live smoke/.test(trigger[1])) {
  fail(
    'release-desktop.yml must trigger on "Live smoke", not "Test". Test green only means the '
    + 'code compiled and passed locally; the DMG must not ship until the deployed site itself '
    + 'answered. (Daniel: "I don\'t want the dmg version updated until the live site is verified '
    + 'by the tests.")',
  );
}
// Live smoke also runs nightly and on dispatch. Without this clause the monitor
// would cut a DMG release every night at 03:41 from an unchanged commit.
if (!/github\.event\.workflow_run\.event\s*==\s*'workflow_run'/.test(desktop)) {
  fail(
    'release-desktop.yml must require github.event.workflow_run.event == \'workflow_run\'. '
    + 'Live smoke runs on a nightly schedule too, and a scheduled monitor pass would otherwise '
    + 'trigger a desktop release.',
  );
}

/* ---------------------------------------------------------------- check 3
 * Cloud Build fires only from Deploy site on a push to main, and Deploy site
 * refuses anything but a merge commit whose PR head carries every required
 * check green (branch protection's strict up-to-date rule makes that head's
 * tested tree the merge's tree). No Test rerun on main: test.yml must not
 * carry a push trigger for main, or the deploy would again wait a CI cycle.
 */
const deploy = read('deploy-site.yml');
const test = read('test.yml');
// ANY push trigger (filtered, block-sequence or bare) would rerun the suite on main.
const testOn = test.slice(test.indexOf('\non:'), test.search(/\n(?:jobs|env|concurrency|permissions):/));
if (/^\s{2}push:/m.test(testOn)) {
  fail('test.yml must not carry a push trigger at all — the PR run already tested this tree; the deploy gate is deploy-site.yml');
}
if (!/^on:\s*\n(?:.*\n)*?\s*push:\s*\n\s*branches:\s*\[\s*['"]?main['"]?\s*\]/m.test(deploy)) {
  fail('deploy-site.yml must be triggered by push to main (branches: [main])');
}
for (const [clause, why] of [
  [/commits\/\$\{GITHUB_SHA\}\/pulls/, 'the gate must ask GitHub which merged PR produced this commit (a hand-made two-parent commit has no record)'],
  [/merged_at != null and \.base\.ref == \\"main\\" and \.merge_commit_sha == \\"\$\{GITHUB_SHA\}\\"/, 'the PR must be merged, into main, and its merge commit must be exactly this sha'],
  [/rev-parse --verify -q HEAD\^2/, 'the second parent must be the PR head the checks were reported on'],
  [/check-runs/, 'the gate reads the PR head\'s check runs from the API'],
  [/REQUIRED: unit build e2e integration container mobile/, 'the six required contexts of branch protection, by name'],
  [/gcloud builds describe .* --format='value\(status\)'/, 'Deploy site must wait for the Cloud Build to finish so Live smoke fires against a deployed site'],
] as const) {
  if (!clause.test(deploy)) fail(`deploy-site.yml is missing ${clause}: ${why}`);
}
/* Live smoke fires on Deploy site (the deploy is finished), not on Test (which no longer runs on main). */
const smoke = read('live-smoke.yml');
if (!/workflows:\s*\[\s*['"]?Deploy site['"]?\s*\]/.test(smoke)) {
  fail('live-smoke.yml must trigger on "Deploy site" — there is no Test run on main to chain from');
}
if (/name: dist\s*\n/.test(smoke) && /download-artifact/.test(smoke) && /name: dist\b/.test(smoke.slice(smoke.indexOf('download-artifact')))) {
  fail('live-smoke.yml must build the bundle for the pinned ref itself; there is no Test artifact on main any more');
}
if (!/name: deployed-sha/.test(smoke) || !/ref: \$\{\{ steps\.sha\.outputs\.sha \}\}/.test(smoke)) {
  fail('live-smoke.yml must check out the sha Deploy site recorded (deployed-sha artifact), not the run head — a dispatch with inputs.sha deploys a different commit');
}
if (!/name: deployed-sha/.test(deploy) || !/printf '%s\\n' "\$sha" > deployed-sha\.txt/.test(deploy)) {
  fail('deploy-site.yml must record the effective deployed sha as the deployed-sha artifact for Live smoke');
}

/* ---------------------------------------------------------------- check 4
 * Every workflow_run trigger in the chain filters to main at the TRIGGER, not
 * only in the job `if:`. Without `branches: [main]` each pull-request run of
 * Test fired Deploy site and Live smoke, whose skipped Live smoke fired the
 * DMG build — three "skipped" rows per PR push that read as failures in the
 * Actions list (Daniel, 2026-09-06). The `if:` clauses above stay the gate;
 * the filter is what keeps the list honest.
 */
function workflowRunFiltersToMain(yaml: string): boolean {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => /^\s*workflow_run:\s*$/.test(l));
  if (at < 0) return false;
  const indent = lines[at].match(/^\s*/)![0].length;
  // The block is exactly the lines indented DEEPER than the `workflow_run:` key
  // (comments and blanks pass through). It ends at the first sibling key —
  // so a `push:` trigger's own `branches: [main]` beside it cannot satisfy
  // this check (CodeRabbit CLI on the first draft).
  const block: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\s*$/.test(l) || /^\s*#/.test(l)) continue;
    if (l.match(/^\s*/)![0].length <= indent) break;
    block.push(l);
  }
  return block.some((l) => /^\s*branches:\s*\[\s*['"]?main['"]?\s*\]/.test(l));
}
for (const f of ['live-smoke.yml', 'release-desktop.yml']) {
  if (!workflowRunFiltersToMain(read(f))) {
    fail(`${f}: its workflow_run trigger must carry branches: [main] — otherwise every PR run of the `
      + 'upstream workflow spawns a skipped run of this one.');
  }
}

/* ------------------------------------------------------- known positives
 * Each check above must actually fire. These are the mutations that matter:
 * the exact shape the real files had before this contract existed.
 */
const MUST_FLAG: Array<[string, () => boolean]> = [
  ['workflow_run trigger without a branches filter', () => !workflowRunFiltersToMain(
    'on:\n  workflow_run:\n    workflows: [Test]\n    types: [completed]\n  workflow_dispatch:\njobs:\n  a:\n    steps:\n      - run: true\n')],
  ['workflow_run trigger without a filter, next to a push trigger that HAS branches: [main]', () => !workflowRunFiltersToMain(
    'on:\n  workflow_run:\n    workflows: [Test]\n    types: [completed]\n  push:\n    branches: [main]\njobs:\n  a:\n    steps:\n      - run: true\n')],
  ['workflow_run trigger filtered to a branch other than main', () => !workflowRunFiltersToMain(
    'on:\n  workflow_run:\n    workflows: [Test]\n    branches: [release]\njobs:\n  a:\n    steps:\n      - run: true\n')],
  // The bare checkout CodeRabbit caught on this very PR.
  ['unpinned checkout', () => unpinnedCheckout(
    'on:\n  workflow_run:\n    workflows: [Test]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n',
  )],
  // A `with:` block that pins something else — the near-miss a looser regex passes.
  ['checkout pinned to the wrong ref', () => unpinnedCheckout(
    'on:\n  workflow_run:\n    workflows: [Test]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          ref: main\n',
  )],
  // A second checkout later in the file, after a correct one.
  ['a later unpinned checkout', () => unpinnedCheckout(
    'on:\n  workflow_run:\n    workflows: [Test]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          ref: ${{ github.event.workflow_run.head_sha }}\n      - uses: actions/checkout@v5\n',
  )],
];
for (const [name, fires] of MUST_FLAG) {
  if (!fires()) fail(`known-positive fixture "${name}" was NOT flagged — the check cannot fire, so its clean result on the real workflows means nothing`);
}
// And it must stay quiet on the correct shape, or it is a check that flags everything.
if (unpinnedCheckout(
  'on:\n  workflow_run:\n    workflows: [Test]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          ref: ${{ github.event.workflow_run.head_sha || github.sha }}\n',
)) fail('the pinned-checkout control was flagged — the check is a false-positive generator');
// A push-triggered workflow is out of scope and must not be flagged.
if (unpinnedCheckout('on:\n  push:\n    branches: [main]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n')) {
  fail('a push-triggered workflow was flagged; only workflow_run resets GITHUB_SHA');
}

console.log(
  `✓ deploy chain: DMG gated on Live smoke (workflow_run only), Cloud Build gated on Deploy site's merged-head check gate (no Test rerun on main), workflow_run triggers filtered to main, `
  + `${MUST_FLAG.length} known-positive fixtures flagged, 2 controls clean`,
);

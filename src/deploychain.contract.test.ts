/**
 * Deploy-chain contract: the live site is verified BEFORE anything ships from it.
 *
 * Daniel's requirement, in his words: "does the google cloud only build after the
 * checks in actions pass for the live production site? That's the way it should
 * work" and "I don't want the dmg version updated until the live site is verified
 * by the tests." The chain that satisfies it is one door:
 *
 *     push to main -> Test -> Deploy site -> Cloud Build -> Cloud Run
 *                                                       -> Live smoke -> Release desktop
 *
 * Branch protection cannot express this. It gates each PR individually, which says
 * nothing about the MERGE COMMIT, and it does not gate a direct push at all. The
 * Cloud Build push trigger used to fire on the push itself, racing the merge
 * commit's own test run; it is disabled now and deploy-site.yml dispatches it.
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
  // Each checkout step, plus whatever `with:` block is indented under it.
  for (const m of yaml.matchAll(/^(\s*)-\s*uses:\s*actions\/checkout@[^\s]+\s*$([\s\S]*?)(?=^\1-\s|^\S|(?![\s\S]))/gm)) {
    const withBlock = m[2] ?? '';
    if (!/^\s*ref:\s*\S/m.test(withBlock)) return true;
    if (!/head_sha/.test(withBlock)) return true;
  }
  return false;
}

for (const f of ['release-desktop.yml', 'deploy-site.yml', 'live-smoke.yml']) {
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
 * Cloud Build fires only from a green Test on main.
 */
const deploy = read('deploy-site.yml');
if (!/workflows:\s*(\[[^\]]*Test[^\]]*\]|(?:\n\s*-\s*['"]?Test['"]?\s*$))/m.test(deploy)) {
  fail('deploy-site.yml must be triggered by the Test workflow');
}
for (const clause of [
  /conclusion\s*==\s*'success'/,
  /head_branch\s*==\s*'main'/,
]) {
  if (!clause.test(deploy)) {
    fail(
      `deploy-site.yml is missing the guard ${clause} — workflow_run fires on FAILURE and on `
      + 'every branch, so without both clauses a red run or a feature branch deploys production.',
    );
  }
}

/* ------------------------------------------------------- known positives
 * Each check above must actually fire. These are the mutations that matter:
 * the exact shape the real files had before this contract existed.
 */
const MUST_FLAG: Array<[string, () => boolean]> = [
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
  `✓ deploy chain: DMG gated on Live smoke (workflow_run only), Cloud Build gated on green Test@main, `
  + `${MUST_FLAG.length} known-positive fixtures flagged, 2 controls clean`,
);

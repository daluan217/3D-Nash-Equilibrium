/**
 * Structural contract for the smoke-suite fan-out. The browser run proves the
 * behavior; this fast test prevents a later workflow edit from silently
 * bypassing a shard, restoring the whole-suite retry, or dropping the exact
 * `e2e` status context required by branch protection.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_REPORT_FETCH_TIMEOUT_MS,
  resolveReportFetchTimeoutMs,
} from './utils/fetchTimeout';
import { selectSmokeSections, assignShards, measuredMs, validateTimings, SHARD_COUNT, SHARD_TIMINGS, SECTION_BUDGET_MS } from './e2e/selection.js';
import { shardsNeedingWebkit, WEBKIT_SECTION_IDS } from './e2e/webkit-shards.mjs';
import { SPLIT_PARTS, WIDEST_PAYOFFS } from './e2e/split-parts.mjs';

const smoke = readFileSync('src/e2e/smoke.mjs', 'utf8');
const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
const liveWorkflow = readFileSync('.github/workflows/live-smoke.yml', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');

function workflowJob(name: string): string {
  const header = `  ${name}:\n`;
  const start = workflow.indexOf(header);
  assert(start >= 0, `workflow job ${name} must remain present`);
  const rest = workflow.slice(start + header.length);
  const nextJobOffset = rest.search(/^  [a-z0-9_]+:\s*$/m);
  const end = nextJobOffset >= 0 ? start + header.length + nextJobOffset : workflow.length;
  return workflow.slice(start, end);
}

const definitions: { id: string; name: string; shard?: number }[] = [...smoke.matchAll(
  /section\('([^']+)',\s*'([^']+)',\s*async\s*\(\)\s*=>/g,
)].map((match) => ({ id: match[1], name: match[2] }));
assert(!/section\('[^']+',\s*'[^']*',\s*\d+,\s*async/.test(smoke),
  'sections no longer name a shard by hand — selection.js packs them from shard-timings.json');

// The parse above is the ONLY census of the suite, so a section written in a
// shape it cannot see registers nowhere and never runs in CI -- green, and
// protecting nothing. Count `section(` CALLS independently of the pattern that
// reads them: the two numbers must agree. (§101/§103 were briefly passed a
// pre-built callback, `section('103', '...', walkTourAt(...))`, which parsed to
// zero sections and would have shipped the landscape guard switched off.)
const sectionCalls = (smoke.match(/^\s*section\('/gm) || []).length;
assert.strictEqual(definitions.length, sectionCalls,
  `${sectionCalls} section() calls but only ${definitions.length} parsed — a section is written in a shape `
  + 'the enumerator cannot see (it must be `section(\'id\', \'name\', async () => ...)`), so it would never run in CI');

const expectedIds = [
  '1', '2', '3', '4', '5', '6', '6b', '7', '8', '9', '10', '11', '12',
  '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23',
  '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35',
  '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47', '50',
  '51', '52', '53', '54', '56', '57', '60', '61', '62', '66', '66b', '67', '68', '69', '70', '71', '74',
  '75', '76', '78', '80', '83', '84', '85', '85b', '86', '87', '88', '89', '90', '91', '91b', '91c', '92', '93', '94', '95', '96',
  '100a', '100b', '100c', '100d', '102a', '102b', '102c', '102d', '102e', '102f',
  '101a', '101b', '101c', '101d', '101e', '101f', '101g', '103a', '103b', '103c', '105', '108', '104', '97',
];

assert.deepStrictEqual(definitions.map(({ id }) => id), expectedIds,
  'every historical smoke section must be registered exactly once and in order');
assert.strictEqual(new Set(definitions.map(({ name }) => name)).size, definitions.length,
  'section names must be unique so retry output identifies one unit unambiguously');
assert.strictEqual(SHARD_COUNT, 35, 'the smoke suite is split into 35 CI shards (test.yml matrix must match) '
  + '-- raised from 28, in two steps, by two branches independently: #164/#165/#166 landed a heavily '
  + 'rewritten §71 (77507ms measured vs the stale 17072ms) plus this branch\'s own §85/85b/86; #168 '
  + '(OPUS-REVIEW-WEBKIT N1) found §70/§75/§83\'s timings had been measured while WebKit was silently '
  + 'skipped (§70 alone: 207,990ms) and raised 28->29 on its own. Merging both onto ONE 29-shard table '
  + 'pushed 6 more multi-section shards over the 200 s headroom line (worst 204,888ms) -- neither branch '
  + 'anticipated the other\'s addition; 30 shards clears every multi-section shard again. '
  + 'struct19-app 2026-09-08: correcting SS90 from a stale 56,000ms to its measured 88,551ms put five '
  + 'multi-section shards back over the line (worst 200,704ms); 31 cleared them (worst 195,221ms) before '
  + 'RED-REGEN-20/001 added measured §91 (175,615ms), which requires 32. '
  + 'The 91 split into 91/91b/91c (5b21f1f) removed the over-budget section; 32 kept every '
  + 'multi-section shard at or under the line. app-loop-21b 2026-09-15: the same two-branch shape '
  + 'again -- merging main\'s \u00a797 (regen) with this branch\'s \u00a7100/\u00a7101 (reflow) put 5 '
  + 'multi-section shards back over the line, worst shard 8 = \u00a742+\u00a794 at 201s, including the '
  + 'long-standing \u00a77+\u00a742 = 200,097ms pair that sits 97ms over on its own; 33 clears every one '
  + '(simulated over the merged table before landing). Re-measuring \u00a793/\u00a794/\u00a7100/\u00a7101 on the final tree (\u00a7100 110839 -> 165141) put shard 9 = \u00a77+\u00a742 back on the line at 200,097ms; 34 clears it. '
  + '2026-09-16: \u00a7100 grew to 224,951ms against the 225,000ms section budget once the payoff checks landed, so they split out as \u00a7102; the table carries 125,000/180,000. Adding three LANDSCAPE conditions to \u00a7101 (the orientation that hid the tour footer) took it to a MEASURED 259,112ms -- over the same per-section budget -- so the trio split out as \u00a7103 behind one shared walker; re-measured alone, \u00a7101 is 104,486ms and \u00a7103 65,779-79,621ms (tabled at 120,000/200,000). 35 is the MINIMUM that clears the 200 s multi-section line: 34 puts four multi-section shards over it (9 = \u00a770+\u00a784 at 205 s, 10 at 203 s, 33 at 205 s, 34 at 204 s). 36 also clears it and leaves no shard empty -- it is simply not needed, and test.yml pins the matrix to whatever this constant says. '
  + 'TASK-18 2026-09-23: three CI runs summed 9,296/8,994/9,317 s of sections against the 7,875 s that '
  + '35 x 225 s allows, so the table could not be honest at 35; the per-job ceiling rose to 420 s and '
  + '\u00a7100-\u00a7103 split along their viewport lists. 35 stays: every run already peaked at 40 concurrent jobs.');

// ── §100-§103 split (TASK-18): the parts cover the pre-split loops exactly ──
// The lists below are the pre-split sections' own literals, verbatim. Each family's parts must
// PARTITION its list: every entry in exactly one part, none added. A part must also be registered
// and run its OWN slice (section('101a', …) calling walkTourAt('101b') would drop 101a silently).
type Row = readonly number[];
const PRE_SPLIT: Record<string, Record<string, Row[]>> = {
  '100': {
    combos: [[280, 3], [280, 2], [320, 3], [360, 2], [390, 3], [390, 2], [390, 1.5], [390, 1.45], [390, 1.63]],
    drawerHeights: [[281], [400], [700]],
  },
  '101': { sizes: [[280, 844, 3], [280, 844, 2], [320, 844, 3], [390, 844, 2], [280, 640, 2], [390, 960, 3], [390, 844, 1]] },
  '102': { viewports: [[280, 1], [320, 1], [390, 1], [430, 1], [768, 1], [768, 1.5], [1024, 1], [1280, 1], [1440, 1], [280, 3], [320, 2], [390, 3]] },
  '103': { sizes: [[844, 390, 1], [667, 375, 1], [740, 360, 1]] },
};
const RUNNERS: Record<string, string> = { '100': 'reflowAt', '101': 'walkTourAt', '102': 'payoffLegibilityAt', '103': 'walkTourAt' };
function splitProblems(parts: Record<string, Record<string, (number | Row)[]>>, registered: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [family, lists] of Object.entries(PRE_SPLIT)) {
    const ids = Object.keys(parts).filter((id) => id.startsWith(family) && /^[a-z]$/.test(id.slice(family.length)));
    if (!ids.length) problems.push(`§${family} has no split parts`);
    for (const [key, original] of Object.entries(lists)) {
      const owner = new Map<string, string[]>();
      for (const id of ids) {
        for (const e of parts[id][key] ?? []) {
          const k = JSON.stringify(Array.isArray(e) ? e : [e]);
          owner.set(k, [...(owner.get(k) ?? []), id]);
        }
      }
      for (const e of original) {
        const k = JSON.stringify(e); const who = owner.get(k) ?? [];
        if (!who.length) problems.push(`§${family} ${key} entry ${k} is in no part`);
        else if (who.length > 1) problems.push(`§${family} ${key} entry ${k} is in ${who.length} parts (${who.join(', ')})`);
      }
      for (const [k, who] of owner) {
        if (!original.some((e) => JSON.stringify(e) === k)) problems.push(`§${family} ${key} entry ${k} (${who.join(', ')}) was not in the pre-split list`);
      }
    }
    for (const id of ids) {
      const body = registered.get(id);
      if (body === undefined) problems.push(`split part ${id} is not registered as a section`);
      else if (!body.includes(`${RUNNERS[family]}('${id}')`)) problems.push(`section ${id} does not run its own slice (${RUNNERS[family]}('${id}'))`);
    }
  }
  return problems;
}
// Section id -> the text up to the next section() call: enough to see which slice it runs.
// The last section ends where the runner starts (`await executeSections();`), not at end of file.
const sectionBodies = new Map([...smoke.slice(0, smoke.indexOf('\nawait executeSections();')).matchAll(/section\('([^']+)',[\s\S]*?(?=\n\s*section\('|$)/g)].map((m) => [m[1], m[0]]));
const realSplit = splitProblems(SPLIT_PARTS, sectionBodies);
assert.deepStrictEqual(realSplit, [], 'the §100-§103 split parts must partition the pre-split loop lists exactly');
assert.deepStrictEqual(WIDEST_PAYOFFS, ['-99.999', '-100', '100', '99.999', '-0.001', '-12.345', '-99.9999', '-100.0000'],
  'every §102 legibility part writes the pre-split value list, unchanged');
// Each runner must iterate the slice it was handed, not a list of its own.
for (const [pattern, why] of [
  [/const \{ combos: COMBOS, drawerHeights = \[\] \} = SPLIT_PARTS\[sid\];/, 'reflowAt reads its part'],
  [/for \(const \[w, z\] of COMBOS\)/, 'reflowAt sweeps its combos'],
  [/for \(const dh of drawerHeights\)/, 'reflowAt walks its drawer heights'],
  [/const LEGIBILITY_VIEWPORTS = SPLIT_PARTS\[sid\]\.viewports;/, 'payoffLegibilityAt reads its part'],
  [/for \(const \[vw, zoom\] of LEGIBILITY_VIEWPORTS\)/, 'payoffLegibilityAt sweeps its viewports'],
  [/for \(const val of WIDEST_PAYOFFS\)/, 'payoffLegibilityAt writes every value'],
  [/const walkTourAt = \(sid, SIZES = SPLIT_PARTS\[sid\]\.sizes\) =>/, 'walkTourAt reads its part'],
  [/for \(const \[w, h, z\] of SIZES\)/, 'walkTourAt walks its sizes'],
] as const) assert.match(smoke, pattern, `smoke.mjs: ${why}`);
// Known positives, one per way the partition can break. Each must fail BY NAME.
{
  const clone = () => JSON.parse(JSON.stringify(SPLIT_PARTS));
  const dropped = clone(); dropped['102b'].viewports = dropped['102b'].viewports.filter(([w, z]: number[]) => !(w === 768 && z === 1.5));
  assert.deepStrictEqual(splitProblems(dropped, sectionBodies), ['§102 viewports entry [768,1.5] is in no part'], 'a viewport dropped from one part');
  const dup = clone(); dup['102b'].viewports.push([280, 1]);
  assert.deepStrictEqual(splitProblems(dup, sectionBodies), ['§102 viewports entry [280,1] is in 2 parts (102a, 102b)'], 'a viewport in two parts');
  const extra = clone(); extra['101g'].sizes.push([400, 800, 1]);
  assert.deepStrictEqual(splitProblems(extra, sectionBodies), ['§101 sizes entry [400,800,1] (101g) was not in the pre-split list'], 'a size that replaces nothing');
  const noDrawer = clone(); delete noDrawer['100c'].drawerHeights;
  assert.deepStrictEqual(splitProblems(noDrawer, sectionBodies), ['§100 drawerHeights entry [281] is in no part', '§100 drawerHeights entry [400] is in no part', '§100 drawerHeights entry [700] is in no part'], 'the drawer phase dropped');
  const unregistered = new Map(sectionBodies); unregistered.delete('101e');
  assert.deepStrictEqual(splitProblems(SPLIT_PARTS, unregistered), ['split part 101e is not registered as a section'], 'a part dropped from the registry');
  const wrongSlice = new Map(sectionBodies); wrongSlice.set('103b', (wrongSlice.get('103b') ?? '').replace("walkTourAt('103b')", "walkTourAt('103a')"));
  assert.deepStrictEqual(splitProblems(SPLIT_PARTS, wrongSlice), ["section 103b does not run its own slice (walkTourAt('103b'))"], 'a part running a sibling\'s slice');
}
// TASK-18 H1: the shared primary page is parked once no §1-§16 section is left. Left open, its
// idle 3D spin cost later sections 4-5x on CI (101a 129 s after §6 vs 101b 35 s alone), and both
// section loops (first pass and retry) must park before each run.
const executeBody = smoke.slice(smoke.indexOf('async function executeSections()'), smoke.indexOf('\nconst $ = {'));
assert.match(smoke, /async function parkSharedPageWhenDone\(remaining\) \{\n  if \(remaining\.some\(\(definition\) => primaryPageSection\(definition\.id\)\)\) return;\n  if \(page\.url\(\) !== 'about:blank'\) await page\.goto\('about:blank'\)/,
  'parkSharedPageWhenDone parks the shared page exactly when no primary section remains');
assert.strictEqual((executeBody.match(/await parkSharedPageWhenDone\((selected|failed)\.slice\(index\)\);\n\s+(?:if \(primaryPageSection\(definition\.id\)\) await gotoHome\(\)\.catch\(\(\) => \{\}\);\n\s+)?const passed = await runSection\(definition, [12]\);/g) || []).length, 2,
  'both section loops park the shared page (from the current index on) right before runSection');
// What H1 could regress: a section after §16 that silently relied on the shared page being
// loaded would now find about:blank. None may touch it (comments and string literals stripped;
// a local `page`/helper of the same name is its own page).
function sharedPageUsers(bodies: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [id, body] of bodies) {
    if (Number.parseInt(id, 10) <= 16) continue;
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    const local = new Set([...code.matchAll(/\b(?:const|let|function)\s+(page|startLine|dismissTour|setSpeed|gotoHome)\b/g)].map((m) => m[1]));
    for (const m of code.matchAll(/(?<![\w.$])(page(?=\s*[.,)])|\$(?=\.[a-z])|startLine(?=\()|dismissTour(?=\()|setSpeed(?=\()|gotoHome(?=\())/g)) {
      if (!local.has(m[1])) { out.push(`section ${id} uses the shared primary page (${m[1]})`); break; }
    }
  }
  return out;
}
assert.deepStrictEqual(sharedPageUsers(sectionBodies), [], 'no section after §16 may use the shared page that the runner parks');
{
  const planted = new Map(sectionBodies).set('104', (sectionBodies.get('104') ?? '') + "\n    await page.goto(BASE);");
  assert.deepStrictEqual(sharedPageUsers(planted), ['section 104 uses the shared primary page (page)'], 'a later section using the shared page is caught by name');
}
// TASK-18 H2: §103c's resting-footer check reads the card only after it settled; a fixed 1.2 s
// sleep read "no Next/Explore control at all" on two CI runs (35671699905, 35689614157).
const footer103 = sectionBodies.get('103c') ?? '';
assert(!/waitForTimeout\(/.test(footer103), '§103c waits on a condition, never a fixed sleep, before reading the card');
assert.match(footer103, /\(body\.scrollHeight > body\.clientHeight \+ 1\) === \(body\.getAttribute\('role'\) === 'region'\)/,
  '§103c waits until the tour body\'s region role agrees with its measured overflow');
assert.match(footer103, /if \(stable >= 10\) resolve\(true\)/, '§103c waits for the card rect to hold 10 frames');
// TASK-18 H3: §39's post-reload row wait is bounded for a loaded runner (a healthy CI run listed
// the row at 10.8 s against the old 8 s bound; 11x CPU throttle measures 12.6 s).
assert.match(sectionBodies.get('39') ?? '', /await flapPage\.reload\(\{ waitUntil: 'networkidle' \}\);[\s\S]{0,420}?getByRole\('button', \{ name: editedName, exact: true \}\)\.first\(\)\n\s+\.waitFor\(\{ state: 'visible', timeout: 30000 \}\)/,
  '§39 waits up to 30 s for the reloaded row before counting it');
// TASK-18 H4 (App.tsx): the play loop's timer may not commit a step over a queued pause, and a
// dropped step advances nothing. §105 is the browser proof; this pins the mechanism.
{
  const runner = app.slice(app.indexOf('// Recursive play runner trigger'), app.indexOf('}, [simState.running, simState.stepCount, speed]);'));
  assert(runner.length > 0, 'the play runner effect is found');
  assert.match(runner, /setSimState\(\(cur\) => \(cur\.running && cur\.stepCount === prev\.stepCount \? next : cur\)\);/,
    'the timer commits its step only if the run is still running on the step it was built from');
  assert(!/setSimState\(next\)|simStateRef\.current = next|scrubPosRef\.current = |setLogEntries\(/.test(runner),
    'the timer advances no ref, position or log line before a commit carries its step');
  assert.match(app, /if \(!step \|\| simState\.pathSegmentsA !== step\.next\.pathSegmentsA\) return;\n\s+pendingStepRef\.current = null;\n\s+simStateRef\.current = simState;\n\s+scrubPosRef\.current = step\.pos;\n\s+if \(step\.logs\.length > 0\) setLogEntries/,
    'a timer step\'s ref, position and log advance only in the layout effect, once its step is committed');
}
// TASK-18 H5: §42/§44 read their hint after the render settles, not within a fixed 3 s (32x
// CPU throttle missed it every time; §93 had the same class, 70f5cec).
for (const id of ['42', '44']) {
  const body = sectionBodies.get(id) ?? '';
  assert(!/timeout: 3000 \}\)\.then\(\(\) => true\)/.test(body), `§${id} does not bound its hint on a fixed 3 s wait`);
  assert.match(body, /requestAnimationFrame\(\(\) => requestAnimationFrame\(r\)\)/, `§${id} reads its hint two frames after the last keystroke`);
}
// TASK-18 sweep 3 (§76 retry, CI 35979484351): a coordinate read after a surface opens waits for
// its entrance animation, or the point lands on the backdrop of a drawer still sliding in.
assert.match(smoke, /async function surfacesSettled\(p\) \{\n  await p\.waitForFunction\(\(\) => document\.getAnimations\(\)\.every/, 'surfacesSettled waits on the page\'s own animations');
for (const [id, read] of [['76', 'const nb = await next.boundingBox();'], ['74', 'const fb = await field.boundingBox();']]) {
  const body = sectionBodies.get(id) ?? '';
  const at = body.indexOf(read);
  assert(at > 0 && body.lastIndexOf('await surfacesSettled(p);', at) > body.lastIndexOf('.click();', at),
    `§${id} waits for the opened surface to settle before reading coordinates in it`);
}
// TASK-18 H8: failure evidence shows the failing section's own page (the shared one is parked at
// about:blank after §16, so every later section's evidence was blank), taken at the first failure.
{
  const cap = smoke.slice(smoke.indexOf('async function captureFailureEvidence()'), smoke.indexOf('function primaryPageSection('));
  assert.match(cap, /const live = \[\.\.\.sectionPages\]\.reverse\(\)\.find\(\(pg\) => !pg\.isClosed\(\)\)\n\s+\?\? \(!activeSection \|\| primaryPageSection\(activeSection\.id\) \? page : null\);/,
    'failure evidence shoots the failing section\'s own live page, the shared page only for §1-§16 or the suite');
  assert(!/await page\.(screenshot|content)\(/.test(cap), 'failure evidence never shoots the parked shared page unconditionally');
  assert.match(smoke, /function record\(name, pass, detail\) \{\n.*\n\s+if \(!pass && activeSection && !failureEvidence\) failureEvidence = captureFailureEvidence\(\);/,
    'evidence is taken at the first failing record, before the section closes its pages');
  assert.match(smoke, /function trackPage\(p\) \{\n\s+if \(activeSection\) sectionPages\.push\(p\);/, 'every page a section opens is a candidate for its evidence');
}
console.log(`✓ §100-§103 split: ${Object.keys(SPLIT_PARTS).length} list-driven parts partition the pre-split lists exactly`);

// ── Packing by measured duration ─────────────────────────────────────────────
// Every section needs a MEASURED entry: an unmeasured one is packed at _default
// and fails here until someone runs scripts/shard-timings-from-run.mjs (or adds
// a local measurement) — the point is that no section is placed by guess.
for (const { id } of definitions) {
  assert(typeof SHARD_TIMINGS[id] === 'number',
    `section ${id} has no entry in src/e2e/shard-timings.json — measure it (SECTION-PASS ms) and add it`);
}
for (const id of Object.keys(SHARD_TIMINGS).filter((k) => !k.startsWith('_'))) {
  assert(definitions.some((d) => d.id === id), `shard-timings.json names section ${id}, which no longer exists — remove it`);
}
assert.deepStrictEqual(validateTimings(definitions.map(({ id }) => id)), [], 'the checked-in timings table must be complete and in budget');
const { totals } = assignShards(definitions);
for (let shard = 1; shard <= SHARD_COUNT; shard++) {
  assert(definitions.some((definition) => definition.shard === shard), `shard ${shard} must own at least one section`);
  assert(totals[shard - 1] <= SECTION_BUDGET_MS,
    `shard ${shard} packs ${Math.round(totals[shard - 1] / 1000)} s of measured sections, over the ${SECTION_BUDGET_MS / 1000} s budget `
    + `(${SHARD_TIMINGS._ceiling_ms / 1000} s job ceiling minus ~${SHARD_TIMINGS._overhead_ms / 1000} s overhead) — split the longest section or raise SHARD_COUNT (and test.yml's matrix)`);
}
// Headroom: CI ran ~5% slower than the table the first 20-shard matrix was packed from (285 s on a
// 207 s-packed shard). Keep every MULTI-section packed shard ≤ 310 s (0.9 x the 345 s budget since
// TASK-18; it was 200 s of 225 s) so that slack cannot reach the budget. A shard holding exactly ONE section is exempted from the 200 s line (bounded instead
// by the per-section SECTION_BUDGET_MS assert above): the 200 s line exists to catch a PILEUP —
// several sections landing on one shard close enough to the ceiling that CI's ~5% slop could tip it
// over — and no amount of splitting into more shards makes one already-isolated section smaller
// (OPUS-REVIEW-WEBKIT N1: §70 alone now measures 207,990 ms after WebKit started actually running
// there). Silently raising the 200 s line instead would have hidden the other 7 shards this same
// repack pushed over it for ordinary multi-section reasons — those are exactly what this must still
// catch.
const HEADROOM_MS = 310000;
assert.strictEqual(SECTION_BUDGET_MS, 345000, 'the per-job section budget is 345 s (420 s ceiling - 75 s overhead, TASK-18)');
const shardMembers = new Map<number, string[]>();
for (const { id, shard } of definitions) {
  if (shard === undefined) continue;
  const list = shardMembers.get(shard) ?? [];
  list.push(id);
  shardMembers.set(shard, list);
}
for (let shard = 1; shard <= SHARD_COUNT; shard++) {
  const members = shardMembers.get(shard) ?? [];
  const total = totals[shard - 1];
  if (members.length <= 1) continue; // a single section is bounded by SECTION_BUDGET_MS above, not this line
  assert(total <= HEADROOM_MS,
    `shard ${shard} packs ${members.length} sections (${members.join(', ')}) totalling ${Math.round(total / 1000)} s `
    + `— over the ${HEADROOM_MS / 1000} s headroom line for a MULTI-section shard; raise SHARD_COUNT`);
}
// A single-section shard is still bounded — just by SECTION_BUDGET_MS (the per-section assert
// above), not the tighter 200 s multi-section line. Restated here as an explicit, separately-named
// check so a shard that quietly grows a SECOND section (no longer "single") is not silently exempted
// from the 200 s line by an earlier, now-stale membership snapshot.
for (let shard = 1; shard <= SHARD_COUNT; shard++) {
  const members = shardMembers.get(shard) ?? [];
  if (members.length !== 1) continue;
  assert(totals[shard - 1] <= SECTION_BUDGET_MS,
    `shard ${shard} holds one section (${members[0]}) at ${Math.round(totals[shard - 1] / 1000)} s — over the ${SECTION_BUDGET_MS / 1000} s per-section budget even alone`);
}
for (const { id } of definitions) {
  assert(measuredMs(id) <= SECTION_BUDGET_MS,
    `section ${id} alone measures ${Math.round(measuredMs(id) / 1000)} s — over the per-job budget; split it (as 66 → 66/66b)`);
}
// Deterministic: the runner in CI and this test must agree on the assignment.
const again = assignShards(definitions.map(({ id, name }) => ({ id, name })));
assert.deepStrictEqual(again.definitions.map((d) => d.shard), definitions.map((d) => d.shard), 'shard assignment must be deterministic');
// Known positives: the budget guard fires on an over-long section and on an over-packed table.
{
  const fake = { _default: 90000, _overhead_ms: 75000, _ceiling_ms: 420000, a: 360000, b: 1000 };
  const packed = assignShards([{ id: 'a' }, { id: 'b' }], fake, 2);
  assert(Math.max(...packed.totals) > SECTION_BUDGET_MS, 'a 360 s section must exceed the 345 s budget (known positive)');
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, 180000]));
  const over = assignShards(Object.keys(many).map((id) => ({ id })), { ...fake, ...many }, 20);
  assert(Math.max(...over.totals) > SECTION_BUDGET_MS, 'forty 180 s sections cannot fit 20 shards under budget (known positive)');
  assert(assignShards([{ id: 'zz' }], fake, 1).totals[0] === 90000, 'an unmeasured section packs at _default');
  // validateTimings (shared with scripts/shard-timings-from-run.mjs) rejects the two bad-table shapes
  // CodeRabbit named on #157: a pre-split run's table (66 at 275 s, no 66b) and an incomplete one.
  const meta = { _default: 90000, _overhead_ms: 75000, _ceiling_ms: 300000 };
  assert.deepStrictEqual(validateTimings(['66', '66b'], { ...meta, '66': 275000 }),
    ['section 66 measures 275 s, over the 225 s per-job section budget — split it', 'section 66b has no measured entry'],
    'a pre-split run\'s table (66 at 275 s, no 66b) must report both problems');
  assert.deepStrictEqual(validateTimings(['1'], { ...meta, '1': 1000, '2': 1000 }), ['timings name section 2, which is not registered']);
  assert.deepStrictEqual(validateTimings(['1'], { ...meta, '1': 1000 }), [], 'a complete, in-budget table is accepted');
}
// A refresh can never again write a section the budget cannot hold (TASK-18: §101 ran 1086 s on CI
// against a 120 s entry because the refresh refused and nobody re-measured). Known positive on the
// REAL budget: one fake 350 s entry for a registered section is refused by name.
assert.deepStrictEqual(validateTimings(['101a'], { ...SHARD_TIMINGS, '101a': 350000 }).filter((p) => /101a/.test(p)),
  ['section 101a measures 350 s, over the 345 s per-job section budget — split it'],
  'a refreshed table carrying a 350 s section must be refused, naming the section');

assert.deepStrictEqual(selectSmokeSections(definitions, {}).selected, definitions,
  'an unset E2E_SHARD/E2E_SECTION must continue to select the complete local suite');
// A shard selector returns exactly the packed assignment's members.
const shard1Now = selectSmokeSections(definitions, { E2E_SHARD: `1/${SHARD_COUNT}` }).selected.map(({ id }) => id);
assert.deepStrictEqual(shard1Now, definitions.filter((d) => d.shard === 1).map(({ id }) => id),
  'E2E_SHARD must select exactly the sections the packing assigned to that shard');
assert.deepStrictEqual(selectSmokeSections(definitions, { E2E_SECTION: '27,28' }).selected.map(({ id }) => id), ['27', '28'],
  'a local section selector must run exactly the requested H1 regressions');
assert.throws(() => selectSmokeSections(definitions, { E2E_SECTION: '999' }), /unknown E2E_SECTION ID/,
  'a local section selector must reject an identifier that does not name a registered section');
assert.throws(() => selectSmokeSections(definitions, { E2E_SHARD: '   ' }), /E2E_SHARD must not be blank/,
  'a whitespace-only shard must not silently become an unset selector');
assert.throws(() => selectSmokeSections(definitions, { E2E_SECTION: '\t' }), /E2E_SECTION must not be blank/,
  'a whitespace-only section list must not silently become an unset selector');
assert.throws(() => selectSmokeSections(definitions, { E2E_SHARD: `1/${SHARD_COUNT}`, E2E_SECTION: '27' }), /Set E2E_SHARD or E2E_SECTION, not both/,
  'local section selection and CI shard selection must remain mutually exclusive');
assert.match(smoke, /failed\.push\(definition\)[\s\S]*for \(const \[index, definition\] of failed\.entries\(\)\)[\s\S]*runSection\(definition, 2\)/,
  'the runner must collect failed sections and retry only that subset once');
assert.match(smoke, /pass-after-section-retry:/,
  'a recovered section retry must be visible in CI output');
assert.match(smoke, /result\.attempt === finalAttemptBySection\.get\(result\.sectionId\)/,
  'the final verdict must use the retry attempt for sections that reran');
assert.match(smoke, /section returned without calling record\(\)/,
  'a retry that accidentally records no checks must fail rather than vanish');
assert.match(smoke, /consoleErrors\.push\(\{[\s\S]*sectionId: activeSection\?\.id \?\? null,[\s\S]*attempt: activeAttempt/,
  'console errors must retain the section attempt that produced them');
assert.match(smoke, /\.filter\(\(error\) => error\.sectionId === null[\s\S]*error\.attempt === finalAttemptBySection\.get\(error\.sectionId\)\)/,
  'console errors from superseded failed attempts must not poison a successful retry');

const resetSection = smoke.match(
  /section\('13', 'reset clears run',[\s\S]*?\n  \}\);/,
)?.[0];
assert(resetSection, 'the Reset section must remain registered');
assert.match(resetSection, /Reset fixture has a completed run to clear/,
  'the Reset section must prove it has non-empty state to clear');
assert.match(resetSection, /for \(let i = 0; i < 40 && !\(lines === 1 && pill === 0\); i\+\+\)/,
  'the Reset section must poll the cleared state instead of relying on a fixed sleep');

assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m,
  'Test must remain manually dispatchable');
assert.match(workflow, /^\s{2}e2e_smoke:\s*$/m,
  'the workflow must retain the smoke matrix job');
const matrixList = Array.from({ length: SHARD_COUNT }, (_, i) => i + 1).join(', ');
assert.match(workflow, new RegExp(`matrix:\\s*\\n\\s*shard:\\s*\\[${matrixList}\\]`),
  `CI must fan smoke out across all ${SHARD_COUNT} declared shards`);
assert.match(workflow, /fail-fast:\s*false/,
  'one failed shard must not cancel its siblings or their evidence');
assert.match(workflow, new RegExp(`E2E_SHARD:\\s*\\$\\{\\{ matrix\\.shard \\}\\}/${SHARD_COUNT}`),
  'each matrix child must pass its shard selector to smoke.mjs');
assert.doesNotMatch(workflow, /elif\s+node\s+src\/e2e\/smoke\.mjs/,
  'CI must never restore the old whole-suite second attempt');
assert.match(workflow, /^\s{2}e2e:\s*\n\s*name:\s*e2e\s*$/m,
  'the exact branch-protection context `e2e` must remain present');
assert.match(workflow, /needs:\s*\[e2e_smoke, e2e_ai_surface\]/,
  'the required e2e context must aggregate both smoke and AI-surface jobs');
assert.match(workflow, new RegExp(`e2e_smoke_failure_shard-\\$\\{\\{ matrix\\.shard \\}\\}-of-${SHARD_COUNT}_section-\\*-attempt-\\*\\.png`),
  'failure evidence must retain every section attempt and remain unique per matrix child');

// ── BLUE-WEBKIT-CI: WebKit must actually run on the runner ──────────────────
// §70/§75/§83 launch WebKit (CodeRabbit outside-diff on #166 — a skipped
// WebKit case must never print PASS). Every registered WebKit section id
// must still exist and be assigned a shard by the CURRENT packing, and the
// e2e_smoke job must install WebKit conditionally FROM webkit-shards.mjs
// (not a hand-named shard list, which would silently go stale the next time
// shard-timings.json is remeasured or a section is added/split).
for (const id of WEBKIT_SECTION_IDS) {
  assert(definitions.some((d) => d.id === id), `webkit-shards.mjs names section ${id}, which no longer exists in smoke.mjs`);
}
// OPUS-REVIEW-WEBKIT N2: WEBKIT_SECTION_IDS is a hand-kept list in
// webkit-shards.mjs — nothing previously asserted it equals the set of
// sections that actually CALL launchWebkitOrSkip in smoke.mjs. A 4th section
// starting to use WebKit without updating that list would install nothing
// extra for its shard (silent — caught only ~25 min later when that shard's
// smoke run fails). Assert set equality between the two, by name, both ways.
const actualWebkitCallSites = [...smoke.matchAll(/launchWebkitOrSkip\('§(\d+)'\)/g)].map((m) => m[1]);
assert.deepStrictEqual([...actualWebkitCallSites].sort(), [...WEBKIT_SECTION_IDS].sort(),
  `webkit-shards.mjs's WEBKIT_SECTION_IDS (${WEBKIT_SECTION_IDS.join(', ')}) must equal the sections that actually call `
  + `launchWebkitOrSkip in smoke.mjs (${actualWebkitCallSites.join(', ')}) — a section added or removed on one side and `
  + `not the other must fail here, not 25 minutes into e2e`);
const webkitShards = shardsNeedingWebkit(smoke);
assert(webkitShards.length > 0, 'at least one shard must be computed as needing WebKit');
for (const shard of webkitShards) {
  assert(shard >= 1 && shard <= SHARD_COUNT, `webkit-shards.mjs computed an out-of-range shard ${shard}`);
}
// Cross-check against the packing computed directly here. OPUS-REVIEW-WEBKIT
// N5: this is NOT a fully independent oracle — both this file's `definitions`
// (parsed above from `expectedIds`, cross-checked against the hand-written
// list) and webkit-shards.mjs's own parse use the character-identical regex,
// and both call the same `assignShards`. It DOES catch a real bug in
// `shardsNeedingWebkit`'s own set/dedup/sort logic (a mistake independent of
// the parse/packing it reuses), so it is not vacuous — but it cannot catch a
// shared parse-drift or packing bug. The `expectedIds`/`assert.deepStrictEqual`
// pair near the top of this file is the actual independent oracle for parsing.
const expectedWebkitShards = [...new Set(
  WEBKIT_SECTION_IDS.map((id) => definitions.find((d) => d.id === id)?.shard),
)].sort((a, b) => (a ?? 0) - (b ?? 0));
assert.deepStrictEqual(webkitShards, expectedWebkitShards,
  'webkit-shards.mjs must compute exactly the shards §70/§75/§83 are packed into — no more, no less');
const e2eSmokeJob = workflowJob('e2e_smoke');
assert.match(e2eSmokeJob, /if ! webkit_shards="\$\(node src\/e2e\/webkit-shards\.mjs\)"; then/,
  'the e2e_smoke job must decide per-shard WebKit installation FROM webkit-shards.mjs, not a hand-written shard list, and must capture its exit code explicitly (a piped `if node ... | grep` reads grep\'s exit code, not node\'s, and silently falls back to chromium-only on a script crash)');
assert.match(e2eSmokeJob, /grep -qx "\$SHARD"/,
  'the shard number must reach the script via env (SHARD), not inline `${{ }}` interpolation into the run body');
// CodeRabbit: the check above only pins that the SCRIPT reads $SHARD — not
// that the step's `env:` block actually assigns it from matrix.shard. A step
// that renamed/dropped that env mapping would still match "grep -qx \"$SHARD\""
// (an always-unset/empty variable) while every shard silently installs
// chromium only.
assert.match(e2eSmokeJob, /id: webkit_need\s*\n\s*env:\s*\n\s*SHARD:\s*\$\{\{ matrix\.shard \}\}/,
  'the webkit_need step\'s env: block must assign SHARD from matrix.shard, not just be read by the script');
// OPUS-REVIEW-WEBKIT N3: the earlier assertions pin the `if !` capture, the
// `grep -qx "$SHARD"` match, and that the install step CONSUMES
// `steps.webkit_need.outputs.browsers` — but never that the POSITIVE branch
// (a shard that DOES need WebKit) actually emits "webkit" in its output.
// Changing `echo "browsers=chromium webkit"` to `echo "browsers=chromium"`
// in that branch slipped every prior check; this pins the literal text of
// both branches so that mutation is caught here, not ~25 min into e2e.
assert.match(e2eSmokeJob, /if printf '%s\\n' "\$webkit_shards" \| grep -qx "\$SHARD"; then\s*\n\s*echo "browsers=chromium webkit" >> "\$GITHUB_OUTPUT"\s*\n\s*else\s*\n\s*echo "browsers=chromium" >> "\$GITHUB_OUTPUT"/,
  'the shard-needs-WebKit branch must echo "browsers=chromium webkit" and the else branch "browsers=chromium" — not both branches emitting the same thing');
assert.match(e2eSmokeJob, /playwright install --with-deps \$\{\{ steps\.webkit_need\.outputs\.browsers \}\}/,
  'the e2e_smoke job must install exactly the browser set webkit_need computed');
assert.doesNotMatch(e2eSmokeJob, /playwright install --with-deps chromium\s*$/m,
  'the e2e_smoke job must not fall back to an unconditional chromium-only install (that would silently skip WebKit again)');

assert.match(workflow, /VITE_E2E_FETCH_TIMEOUT_MS:\s*'5000'/,
  'the throwaway CI artifact must use the short client timeout');
const buildJob = workflow.match(/^  build:\s*$[\s\S]*?(?=^  integration:\s*$)/m)?.[0];
assert(buildJob, 'the build job must remain present');
const productionBuildStep = buildJob.match(
  /      - name: Build production bundle\s*$[\s\S]*?(?=^      - name:)/m,
)?.[0];
assert(productionBuildStep, 'the ordinary production build step must remain present');
assert.doesNotMatch(productionBuildStep, /VITE_E2E_FETCH_TIMEOUT_MS/,
  'the production artifact must retain the shipping timeout so live hash verification matches Cloud Build');
const e2eBuildStep = buildJob.match(
  /      - name: Build short-timeout e2e bundle\s*$[\s\S]*?(?=^      - name:)/m,
)?.[0];
assert(e2eBuildStep, 'the separate short-timeout e2e build step must remain present');
assert.match(e2eBuildStep, /VITE_E2E_FETCH_TIMEOUT_MS:\s*'5000'/,
  'only the dedicated e2e artifact should receive the short client timeout');
assert.match(buildJob, /name:\s*dist\s*$[\s\S]*Build short-timeout e2e bundle[\s\S]*name:\s*dist-e2e\s*$/m,
  'the production artifact must be uploaded before the test-only rebuild overwrites dist');
assert.strictEqual((workflow.match(/name:\s*dist-e2e\s*$/gm) ?? []).length, 3,
  'dist-e2e must have one upload and exactly two browser-e2e downloads');
for (const job of [
  workflowJob('e2e_smoke'),
  workflowJob('e2e_ai_surface'),
]) {
  assert.match(job, /name:\s*dist-e2e\s*$/m,
    'both browser E2E jobs must consume the short-timeout artifact');
}
for (const job of [
  workflowJob('integration'),
  workflowJob('mobile'),
]) {
  assert.match(job, /name:\s*dist\s*$/m,
    'integration and mobile must consume the production-equivalent artifact');
  assert.doesNotMatch(job, /name:\s*dist-e2e\s*$/m,
    'the test-only timeout artifact must not leak into integration or mobile');
}
assert.match(liveWorkflow, /LIVE_WAIT_MINUTES:\s*'5'/,
  'deploy verification must stop waiting for an asset after five minutes');
const timeoutInitializer = app.match(
  /const REPORT_FETCH_TIMEOUT_MS = resolveReportFetchTimeoutMs\(\s*([\s\S]*?)\s*,?\s*\);/,
)?.[1];
assert(timeoutInitializer, 'App.tsx must define the report fetch timeout through the bounded resolver');
assert.match(timeoutInitializer,
  /^typeof import\.meta\.env === 'undefined'\s*\?\s*undefined\s*:\s*import\.meta\.env\.VITE_E2E_FETCH_TIMEOUT_MS$/,
  'the literal Vite access must be the guarded expression passed to the resolver');
assert.strictEqual(resolveReportFetchTimeoutMs('5000'), 5_000,
  'the CI build must be able to select its five-second timeout');
for (const bad of [undefined, '', '0', '99', '22001', '5000ms', '1e3']) {
  assert.strictEqual(resolveReportFetchTimeoutMs(bad), DEFAULT_REPORT_FETCH_TIMEOUT_MS,
    `${JSON.stringify(bad)} must retain the shipping 22-second timeout`);
}

console.log(`✓ e2e sharding contract: ${definitions.length} named sections across ${SHARD_COUNT} shards, required context preserved`);

// ── A double-activation guard dispatches both activations in ONE page task.
//
// WHY (STRUCT-DESKTOP-19). Section 53 held its DELETE on a 1500 ms timer and
// bet that Playwright's second `.click()` would land inside that window. On a
// loaded runner it does not: a probe here measured 2.4 s from `.click()` to
// the request reaching the wire, so the second click arrived after the first
// request had already failed and the section reported two legitimate requests
// and two legitimate alerts as a product defect (it failed exactly that way on
// CI run 34238169411 and locally, on trees whose delete guard was intact).
// The same shape hid the opposite error: the real second click was swallowed
// by the button's `disabled` attribute, so the section stayed GREEN against a
// build with the `deletingGamesRef` check deleted — the very mutation its
// comment claimed would fail it. Both directions vanish when the two
// activations are dispatched inside one `page.evaluate`: React has not
// re-rendered between them, so the second reaches a live handler, and no timer
// can settle the first request underneath it. §29 already worked this way
// after the same discovery; this contract keeps every such section there.
const daCode = (body: string): string =>
  body.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
function daSectionBodies(source: string): Map<string, string> {
  const starts: Array<{ id: string; at: number }> = [];
  for (const m of source.matchAll(/^ {2}section\('([^']+)'/gm)) starts.push({ id: m[1], at: m.index ?? 0 });
  const bodies = new Map<string, string>();
  starts.forEach((s, i) => bodies.set(s.id, source.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : source.length)));
  return bodies;
}
/** Sections whose invariant is "two activations in ONE tick produce one effect". */
const DOUBLE_ACTIVATION_SECTIONS: Record<string, string> = {
  '29': 'regenerate: a double-click issues exactly one request',
  '53': 'delete: a double-click sends one DELETE and shows one alert',
};
const daExactlyOne = (code: string): boolean => /record\(\s*['"`][^'"`]*exactly (?:one|ONE)\b/.test(code);
const daSameTick = (code: string): boolean => /evaluate\([\s\S]{0,600}?\.click\(\);[\s\S]{0,300}?\.click\(\);/.test(code);
const daAwaitedRepeats = (code: string): string[] => {
  const counts = new Map<string, number>();
  for (const m of code.matchAll(/await\s+(\w+)\s*\.click\(/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return [...counts].filter(([, n]) => n >= 2).map(([n]) => n);
};
export function doubleActivationFailures(bodies: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [id, what] of Object.entries(DOUBLE_ACTIVATION_SECTIONS)) {
    const body = bodies.get(id);
    if (body === undefined) { out.push(`section ${id} (${what}) is registered here but no longer exists in the suite`); continue; }
    const code = daCode(body);
    if (!daSameTick(code)) out.push(`section ${id} (${what}) must dispatch both activations inside one page.evaluate, not as two awaited Playwright clicks`);
    const repeats = daAwaitedRepeats(code);
    if (repeats.length > 0) out.push(`section ${id} (${what}) awaits ${repeats.join(', ')}.click() twice — that race is what this contract exists to stop`);
  }
  for (const [id, body] of bodies) {
    if (id in DOUBLE_ACTIVATION_SECTIONS) continue;
    const code = daCode(body);
    if (/double[- ]click/i.test(code) && daExactlyOne(code)) {
      out.push(`section ${id} asserts an "exactly one" invariant about a double-click but is not registered in DOUBLE_ACTIVATION_SECTIONS`);
    }
  }
  return out;
}
const daReal = daSectionBodies(smoke);
assert.deepStrictEqual(doubleActivationFailures(daReal), [],
  'every double-activation guard must dispatch its two activations in one page task');
// The extractor fires, and fires for the right reason. Each mutant below is a
// real edit someone could make to the suite.
const da53 = daReal.get('53') ?? '';
assert.match(da53, /seen\.push\(!b\.disabled\); b\.click\(\);/,
  'section 53 must still read the button state at each of its two same-tick clicks');
const daReverted = new Map(daReal).set('53', da53.replace(
  /const enabledAt = await del\.evaluate\([\s\S]*?\n {6}\}\);/,
  'await del.click();\n      await del.click({ force: true }).catch(() => {});'));
assert(doubleActivationFailures(daReverted).some((f) => f.startsWith('section 53')),
  'reverting section 53 to two awaited Playwright clicks must fail this contract');
const daUnregistered = new Map(daReal).set('999',
  "  section('999', 'a double-click on something new', async () => {\n    await b.click();\n    record('FIX: exactly one request was sent', n === 1);\n  });");
assert(doubleActivationFailures(daUnregistered).some((f) => f.includes('section 999')),
  'a new double-click guard must be registered before it can ship');
const daMissing = new Map(daReal); daMissing.delete('29');
assert(doubleActivationFailures(daMissing).some((f) => f.includes('section 29')),
  'a registered section that disappears must fail this contract, not pass vacuously');
// And it stays quiet on ordinary sections: §50 awaits the same button three
// times and asserts "exactly one POST", but each click is a separate user
// step, not a same-tick pair — the registry, not a heuristic, decides.
assert.strictEqual(doubleActivationFailures(daReal).length, 0, 'no false positives on the real suite');

console.log(`✓ double-activation contract: ${Object.keys(DOUBLE_ACTIVATION_SECTIONS).length} same-tick guards, ${daReal.size} sections scanned`);

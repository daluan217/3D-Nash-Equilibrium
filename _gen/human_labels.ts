/**
 * HUMAN VALIDATION of the discrimination judge.
 *
 * discriminate.ts reports how often an LLM judge picks the human-written passage
 * out of a pair. That number is worthless on its own: an LLM judge is an
 * instrument, and this project has been burned repeatedly by instruments that
 * looked fine. Before any voice figure is reported, the author labels the SAME
 * trials and two things get published together:
 *
 *   1. HUMAN discrimination rate  — the actual finding. 50% means the model's
 *      prose is indistinguishable from the author's; 100% means it is obvious.
 *   2. JUDGE-HUMAN agreement      — whether the cheap instrument tracks the
 *      expensive one. Low agreement invalidates every judge-only number.
 *
 * The human rate is the headline. The judge is the thing being validated, not
 * the thing being measured.
 *
 * OUTPUT. Writes two files:
 *   - _gen/exemplars/trials.json   the trials, ground truth and judge picks.
 *     Lives under exemplars/ because it contains manuscript prose and that
 *     directory's *.json is gitignored.
 *   - <scratchpad>/labeling.html   a local, self-contained labeling sheet.
 *     LOCAL ON PURPOSE: the paper is under double-anonymous review, so these
 *     passages must not be uploaded to any external host.
 *
 * USAGE
 *   npx tsx _gen/human_labels.ts            # generate + judge + write the sheet
 *   open <scratchpad>/labeling.html         # label, then copy the result code
 *   npx tsx _gen/human_labels.ts --score "ABBA..."   # score the labels
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

process.env.ALLOW_STYLE_EXEMPLARS = '1';
import { callProvider } from '../src/utils/providers';
import { generateReport } from '../src/utils/report';
import { validateReport } from '../src/utils/nashValidator';
import { PRESETS } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

const JUDGE = process.env.D_JUDGE || 'gpt-5.6-sol-1';
const DIR = '_gen/exemplars';
const TRIALS = `${DIR}/trials.json`;
const SHEET = process.env.H_SHEET
  || '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad/labeling.html';
const PER_ARM = Number(process.env.H_PER_ARM || 8);

type Arm = 'baseline' | 'few-shot' | 'habits' | 'control';
interface Trial {
  arm: Arm;
  a: string;
  b: string;
  /** Which side is the genuine human passage. For control both are; see below. */
  human: 'A' | 'B';
  judge: 'A' | 'B' | null;
}

const HABITS = `Write in this explanatory voice:
- Give the picture before the algebra. State the intuitive fact in plain words first; numbers arrive only to confirm it. Never open with a computation.
- If the game contains something counterintuitive, state it flatly and deadpan, then resolve it. Do not soften the paradox.
- Second person throughout. The reader is a player, not an observer: "you" choose, "your opponent" responds.
- Put any hedge AFTER the strong claim, as one calm sentence. Never open with a qualification.
- Spell numbers as words — "a third", "two-thirds", "fifty-fifty" — so the prose stays prose.
- Name the equilibrium as a place or a thing, not only as a coordinate.
- Let short sentences carry the turns in the argument.`;

const JUDGE_SYS = `You will see two short passages explaining game theory, labelled A and B.
Exactly one was written by a specific human author; the other was produced by a language model.
Answer with JSON only: {"human":"A"} or {"human":"B"}. Guess if unsure.`;

function loadJson(name: string): string[] {
  const p = `${DIR}/${name}`;
  if (!existsSync(p)) { console.error(`missing ${p} — see _gen/exemplars/README.md`); process.exit(1); }
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function judgeTrial(a: string, b: string): Promise<'A' | 'B' | null> {
  const r = await callProvider({
    model: JUDGE,
    systemPrompt: JUDGE_SYS,
    userPrompt: `Passage A:\n${a}\n\nPassage B:\n${b}`,
    schema: { type: 'object', required: ['human'], properties: { human: { type: 'string', enum: ['A', 'B'] } } },
    maxOutputTokens: 4096,
  });
  if (!r.text) return null;
  try {
    const v = String(JSON.parse(r.text).human).trim().toUpperCase();
    return v === 'A' || v === 'B' ? (v as 'A' | 'B') : null;
  } catch { return null; }
}

// ── scoring mode ───────────────────────────────────────────────────────────
const scoreIdx = process.argv.indexOf('--score');
if (scoreIdx >= 0) {
  const answers = (process.argv[scoreIdx + 1] || '').toUpperCase().replace(/[^AB]/g, '');
  const trials: Trial[] = JSON.parse(readFileSync(TRIALS, 'utf8'));
  if (answers.length !== trials.length) {
    console.error(`expected ${trials.length} labels, got ${answers.length}`);
    process.exit(1);
  }
  const byArm: Record<string, { hOk: number; jOk: number; agree: number; n: number }> = {};
  trials.forEach((t, i) => {
    const s = (byArm[t.arm] ??= { hOk: 0, jOk: 0, agree: 0, n: 0 });
    s.n++;
    if (answers[i] === t.human) s.hOk++;
    if (t.judge === t.human) s.jOk++;
    if (t.judge === answers[i]) s.agree++;
  });
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : 'n/a');
  console.log('arm         n   HUMAN acc   judge acc   judge-human agreement');
  for (const [arm, s] of Object.entries(byArm)) {
    console.log(
      `${arm.padEnd(11)} ${String(s.n).padStart(2)}   ${pct(s.hOk, s.n).padStart(9)}   `
      + `${pct(s.jOk, s.n).padStart(9)}   ${pct(s.agree, s.n).padStart(9)}`,
    );
  }

  /**
   * SIDE-BIAS GUARD. A rater who simply always answers "B" scores whatever
   * fraction of trials happen to have the real passage on the B side — here that
   * is not exactly 50%, so a high score could be an artifact of a fixed habit
   * rather than of discrimination. Comparing each rater's answer distribution
   * against the actual position distribution exposes that; it is the per-position
   * tally discriminate.ts already requires, applied to the human too.
   */
  const nonCtl = trials.map((t, i) => ({ t, a: answers[i] })).filter((r) => r.t.arm !== 'control');
  const share = (xs: string[], v: string) => pct(xs.filter((x) => x === v).length, xs.length);
  const humanAns = nonCtl.map((r) => r.a);
  const judgeAns = nonCtl.map((r) => r.t.judge ?? '?');
  const truthPos = nonCtl.map((r) => r.t.human);
  console.log('\nside-bias check (non-control trials)');
  console.log(`  real passage actually on A: ${share(truthPos, 'A')}`);
  console.log(`  you answered A:             ${share(humanAns, 'A')}`);
  console.log(`  judge answered A:           ${share(judgeAns, 'A')}`);
  console.log('  A rater whose share is far from the truth share is keying on position, not authorship.');
  const alwaysB = pct(truthPos.filter((p) => p === 'B').length, truthPos.length);
  console.log(`  floor for reference: always answering "B" would score ${alwaysB}`);

  console.log('\nHUMAN accuracy is the finding: 50% = indistinguishable, 100% = obvious.');
  console.log('The control row should sit near 50% BY CONSTRUCTION (both passages are real);');
  console.log('a strong control result means the rater is keying on something other than authorship.');
  console.log('If judge-human agreement is low, judge-only numbers cannot be reported at all.');
  process.exit(0);
}

// ── generation mode ────────────────────────────────────────────────────────
const GAMES = (['search', 'spy', 'bos', 'pd'] as const).map((k) => {
  const p = PRESETS[k];
  return {
    name: p.name,
    g: { a11: p.a11!, a12: p.a12!, a21: p.a21!, a22: p.a22!,
         b11: p.b11!, b12: p.b12!, b21: p.b21!, b22: p.b22! } as GamePayoffs,
    scenario: { name: p.name, row1: p.row1Label, row2: p.row2Label,
                col1: p.col1Label, col2: p.col2Label },
  };
});

(async () => {
  const exemplars = loadJson('exemplars.json');
  const heldout = loadJson('heldout.json');

  let seed = 20260812;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  console.log(`generating model passages (${GAMES.length} games x 3 arms)…`);
  const arms: Record<string, string[]> = { baseline: [], 'few-shot': [], habits: [] };
  for (const { name, g, scenario } of GAMES) {
    for (const arm of ['baseline', 'few-shot', 'habits'] as const) {
      const opts = arm === 'few-shot' ? { scenario, styleExemplars: exemplars }
                 : arm === 'habits' ? { scenario, framingGuidance: HABITS }
                 : { scenario };
      const r = await generateReport(g, opts);
      if (!r.report) { console.log(`  ${arm}/${name}: no report (${r.failure})`); continue; }
      // Style work must not cost correctness.
      const v = validateReport(r.report, g);
      if (!v.ok) console.log(`  *** ${arm}/${name}: VALIDATOR FAIL — excluded`);
      else arms[arm].push(r.report.prose);
    }
  }
  console.log(`  baseline=${arms.baseline.length} few-shot=${arms['few-shot'].length} habits=${arms.habits.length}`);

  const trials: Trial[] = [];
  for (const arm of ['baseline', 'few-shot', 'habits'] as const) {
    for (let i = 0; i < PER_ARM; i++) {
      const model = arms[arm][i % Math.max(1, arms[arm].length)];
      if (!model) continue;
      const real = heldout[Math.floor(rng() * heldout.length) % heldout.length];
      const realFirst = rng() < 0.5;
      trials.push({ arm, a: realFirst ? real : model, b: realFirst ? model : real,
                    human: realFirst ? 'A' : 'B', judge: null });
    }
  }
  // Control: two REAL passages. A judge (or human) should be at chance here by
  // construction. "human" is recorded as the first one purely so the arithmetic
  // has something to compare against — near-50% is the pass condition, and any
  // strong result means the rater is keying on something other than authorship.
  for (let i = 0; i + 1 < heldout.length; i += 2) {
    trials.push({ arm: 'control', a: heldout[i], b: heldout[i + 1], human: 'A', judge: null });
  }

  // Shuffle so arms are not presented in blocks — a labeller who notices the
  // grouping starts labelling the group rather than the passage.
  for (let i = trials.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [trials[i], trials[j]] = [trials[j], trials[i]];
  }

  console.log(`judging ${trials.length} trials…`);
  for (const t of trials) t.judge = await judgeTrial(t.a, t.b);

  writeFileSync(TRIALS, JSON.stringify(trials, null, 1));

  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const cards = trials.map((t, i) => `
  <div class="t">
    <h3>${i + 1} of ${trials.length}</h3>
    <label class="p"><input type="radio" name="q${i}" value="A"><div><b>A.</b> ${esc(t.a)}</div></label>
    <label class="p"><input type="radio" name="q${i}" value="B"><div><b>B.</b> ${esc(t.b)}</div></label>
  </div>`).join('');

  writeFileSync(SHEET, `<!doctype html><meta charset="utf-8"><title>Voice labelling</title>
<style>
 body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#111}
 .t{border:1px solid #ddd;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0}
 h3{margin:0 0 .75rem;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:#777}
 .p{display:flex;gap:.75rem;align-items:flex-start;padding:.75rem;border-radius:8px;cursor:pointer}
 .p:hover{background:#f5f5f5}
 #out{position:sticky;bottom:0;background:#111;color:#fff;padding:1rem;border-radius:10px;margin-top:2rem}
 code{font:14px ui-monospace,monospace;word-break:break-all}
 button{font:inherit;padding:.5rem 1rem;border-radius:8px;border:0;background:#fff;cursor:pointer}
</style>
<h1>Which passage is yours?</h1>
<p>Each pair has one passage written by you and one by a model — except a few
where <em>both</em> are yours. Those are deliberate: they check that you are
judging authorship rather than something incidental. Guess when unsure; guessing
is the point of the measurement.</p>
${cards}
<div id="out"><button onclick="go()">Produce result code</button> <code id="c"></code></div>
<script>
function go(){
  let s='';
  for(let i=0;i<${trials.length};i++){
    const el=document.querySelector('input[name=q'+i+']:checked');
    if(!el){document.getElementById('c').textContent='Unanswered: #'+(i+1);return;}
    s+=el.value;
  }
  document.getElementById('c').textContent=s;
}
</script>`);

  console.log(`\ntrials  -> ${TRIALS}`);
  console.log(`sheet   -> ${SHEET}`);
  console.log(`\nOpen the sheet, label all ${trials.length}, then run:`);
  console.log(`  npx tsx _gen/human_labels.ts --score "<code>"`);
})();

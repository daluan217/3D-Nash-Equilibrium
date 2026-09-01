/**
 * BLUE — WINDOW 6: false-positive audit for the META screen.
 *
 * The W5 replay asked "does the change reject anything new?" and required the
 * answer to be zero. That question is WRONG here: META is meant to reject ~14%
 * of local output, so a zero would mean the screen does nothing. The question
 * becomes "is every newly-rejected draw genuinely a defect?", and 450 draws is
 * too many to read one by one without the reading becoming a rubber stamp.
 *
 * So this tabulates the DISTINCT MATCHED SUBSTRING behind every new rejection.
 * If the whole population reduces to "Player A", "Player B", "the two players",
 * "A is", "B chooses" and so on, the rejections are meta by construction. Any
 * unexpected match string is a false-positive candidate and gets read by hand.
 * That turns an unreadable pile into a short list of shapes.
 *
 *   git show <ref>:src/utils/nashValidator.ts > src/utils/nashValidator.PREW6.ts
 *   npx tsx _gen/blue_w6_fpaudit.mjs
 *   rm src/utils/nashValidator.PREW6.ts
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const PRE = await import('../src/utils/nashValidator.PREW6.ts');
const POST = await import('../src/utils/nashValidator.ts');

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const REPO = '/Users/danielluan/Desktop/3D-Nash-Equilibrium';
const files = [];
for (const d of ['/tmp', S, `${REPO}/_gen`, `${REPO}/_gen/results`]) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) if (f.endsWith('.jsonl')) files.push(`${d}/${f}`);
}
files.sort();
const surfaceOf = (r, src) => {
  const t = `${r.src ?? ''} ${r.source ?? ''} ${r.model ?? ''}`.toLowerCase();
  if (/local|qwen|gguf|llama/.test(t)) return 'local';
  if (/cloud|gpt|luna|azure|foundry/.test(t)) return 'cloud';
  if (/_local|local_/.test(src)) return 'local';
  if (/_cloud|cloud_/.test(src)) return 'cloud';
  return 'unknown';
};
const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const rows = []; const seen = new Set();
for (const f of files) {
  const src = f.split('/').pop().replace('.jsonl', '');
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const sc = r.sc ?? r.scenario;
    if (!sc || typeof sc.description !== 'string') continue;
    const key = `${sc.name} ${sc.description} ${sc.row1} ${sc.col1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ src, surface: surfaceOf(r, src), i: r.i ?? r.pair ?? r.line, sc,
      g: r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null) });
  }
}
const verdict = (M, r) => {
  const cf = M.scenarioIsClaimFree(r.sc);
  if (cf.ok === false) return `claim:${cf.reason}`;
  if (!r.g) return 'ok';
  const vs = M.validateScenario(r.sc, r.g);
  return (vs.issues ?? []).length ? `scen:${(vs.issues ?? []).join('|')}` : 'ok';
};
// SELF-CHECK: the modules must be distinguishable, or every delta reads clean
// for the wrong reason.
const probe = { name: 'N', row1: 'A', row2: 'B', col1: 'C', col2: 'D', description: 'Player A chooses an Early Slot. Player B chooses a Shared Window.' };
if (PRE.scenarioIsClaimFree(probe).ok === false || POST.scenarioIsClaimFree(probe).ok !== false) {
  console.error('SELF-CHECK FAILED — baseline already screens META, or the working tree does not. Run void.'); process.exit(1);
}
console.log('self-check: baseline accepts the META probe, working tree rejects it\n');

const allText = (sc) => [sc.name, sc.row1, sc.row2, sc.col1, sc.col2, sc.description].filter((x) => typeof x === 'string').join(' • ');
const FORMS = [
  ['prompt cast', /\bplayers?\s+(?:[AB]|one|two)\b/i],
  ['bare letter', /(?<![\p{L}\p{N}][ \t]|[\p{L}\p{N}])\b[AB]\b\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|prefers?|is|are|will|must|can|has|have)\b/u],
  ['game cast', /\b(?:the\s+two\s+players|both\s+players|each\s+player)\b/i],
  ['the game', /\bthe\s+game\b(?![-\w])/i],
];
let newlyRejected = 0, newlyAccepted = 0, other = 0;
const byForm = new Map(FORMS.map(([t]) => [t, new Map()]));
const unexplained = [];
const surf = { local: 0, cloud: 0, unknown: 0 };
for (const r of rows) {
  const a = verdict(PRE, r), b = verdict(POST, r);
  if (a === b) continue;
  if (a === 'ok' && b !== 'ok') {
    newlyRejected++; surf[r.surface]++;
    const t = allText(r.sc);
    let hit = false;
    for (const [tag, re] of FORMS) {
      const m = t.match(re);
      if (m) { hit = true; const k = m[0].toLowerCase().replace(/\s+/g, ' '); byForm.get(tag).set(k, (byForm.get(tag).get(k) ?? 0) + 1); }
    }
    if (!hit) unexplained.push(r);
  } else if (a !== 'ok' && b === 'ok') { newlyAccepted++; console.log(`  NEWLY ACCEPTED [${r.src}#${r.i}] was: ${a}`); }
  else { other++; }
}
console.log(`${rows.length} draws · newly REJECTED ${newlyRejected} (local ${surf.local}, cloud ${surf.cloud}, unattributed ${surf.unknown}) · newly ACCEPTED ${newlyAccepted} · reason changed ${other}\n`);
console.log('── Every DISTINCT matched substring behind the new rejections ──');
for (const [tag] of FORMS) {
  const m = byForm.get(tag);
  const items = [...m.entries()].sort((x, y) => y[1] - x[1]);
  console.log(`\n  ${tag} — ${items.length} distinct match${items.length === 1 ? '' : 'es'}`);
  for (const [k, n] of items) console.log(`      ${String(n).padStart(4)}x  «${k}»`);
}
console.log(`\n  rejections NOT explained by any of the four forms: ${unexplained.length}`);
for (const r of unexplained.slice(0, 10)) console.log(`      [${r.src}#${r.i}] ${verdict(POST, r)}\n        ${allText(r.sc).replace(/\s+/g, ' ').slice(0, 190)}`);

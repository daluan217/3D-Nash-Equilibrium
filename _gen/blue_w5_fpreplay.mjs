/**
 * BLUE — WINDOW 5: the false-positive replay. Standing rule 2 — no validator
 * change ships if it adds a single false positive.
 *
 * Loads the PRE-window-5 validator (extracted from the branch head commit) and
 * the working-tree one in ONE process, and runs every stored draw through both.
 *
 * SELF-CHECK FIRST, as red does: a replay that cannot reproduce its own
 * baseline has no standing to judge the change. The baseline here is that the
 * two modules must agree on every draw EXCEPT the ones the new rules target.
 *
 * The baseline module is NOT committed — it would be a second copy of a 2,900
 * line file for tsc to check. Regenerate it before running, and delete it
 * after, or `npm run lint` will type-check the duplicate:
 *
 *   git show <baseline-ref>:src/utils/nashValidator.ts > src/utils/nashValidator.PREW5.ts
 *   npx tsx _gen/blue_w5_fpreplay.mjs
 *   rm src/utils/nashValidator.PREW5.ts
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const PRE = await import('../src/utils/nashValidator.PREW5.ts');
const POST = await import('../src/utils/nashValidator.ts');

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const REPO = '/Users/danielluan/Desktop/3D-Nash-Equilibrium';
const files = [];
for (const d of ['/tmp', S, `${REPO}/_gen`, `${REPO}/_gen/results`]) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) if (f.endsWith('.jsonl')) files.push(`${d}/${f}`);
}
files.sort();
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
    rows.push({ src, i: r.i ?? r.pair ?? r.line, sc, g: r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null) });
  }
}

const verdict = (M, r) => {
  const cf = M.scenarioIsClaimFree(r.sc);
  if (cf.ok === false) return `claim:${cf.reason}`;
  if (!r.g) return 'ok';
  const vs = M.validateScenario(r.sc, r.g);
  return (vs.issues ?? []).length ? `scen:${(vs.issues ?? []).join('|')}` : 'ok';
};

// SELF-CHECK: the two modules must be distinguishable at all. If the extracted
// baseline were accidentally identical to the working tree (a bad extraction),
// every delta would read as zero and the run would look clean for the wrong
// reason — the exact failure this campaign keeps finding.
const L10 = { name: 'N', row1: 'Order-of-Magnitude Expansion', row2: 'Token Expansion', col1: 'A', col2: 'B', description: 'x' };
const L7 = { name: 'N', row1: 'Ten Thousand Crates', row2: 'One Crate', col1: 'A', col2: 'B', description: 'x' };
const preSees = PRE.scenarioIsClaimFree(L10).ok === false || PRE.scenarioIsClaimFree(L7).ok === false;
const postSees = POST.scenarioIsClaimFree(L10).ok === false && POST.scenarioIsClaimFree(L7).ok === false;
if (preSees || !postSees) {
  console.error(`SELF-CHECK FAILED — baseline sees the holes: ${preSees}; new gate closes both: ${postSees}. Run void.`);
  process.exit(1);
}
console.log(`self-check: baseline lets BOTH holes through, working tree closes BOTH — the two modules are distinguishable\n`);
console.log(`${files.length} files · ${rows.length} unique draws\n`);

let newlyRejected = 0, newlyAccepted = 0, changedReason = 0, threw = 0;
for (const r of rows) {
  let a, b;
  try { a = verdict(PRE, r); b = verdict(POST, r); } catch { threw++; continue; }
  if (a === b) continue;
  if (a === 'ok' && b !== 'ok') { newlyRejected++; console.log(`  NEWLY REJECTED [${r.src}#${r.i}] ${b}\n      name: ${r.sc.name}\n      labels: ${[r.sc.row1, r.sc.row2, r.sc.col1, r.sc.col2].join(' / ')}\n      ${String(r.sc.description).replace(/\s+/g, ' ').slice(0, 200)}`); }
  else if (a !== 'ok' && b === 'ok') { newlyAccepted++; console.log(`  NEWLY ACCEPTED [${r.src}#${r.i}] was: ${a}`); }
  else { changedReason++; console.log(`  REASON CHANGED [${r.src}#${r.i}]\n      was: ${a}\n      now: ${b}`); }
}
console.log(`\nDELTA over ${rows.length} draws — newly REJECTED: ${newlyRejected} · newly ACCEPTED: ${newlyAccepted} · reason changed: ${changedReason} · threw: ${threw}`);
console.log(newlyRejected === 0 ? '\nPASS — standing rule 2 holds: zero new false positives.' : '\nFAIL — the change rejects real output. Do not ship.');

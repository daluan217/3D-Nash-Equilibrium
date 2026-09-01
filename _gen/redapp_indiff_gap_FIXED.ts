/* RED-APP: how BIG is the visible gap the app labels "indifferent"? */
import {
  computeAllNE, doStep, EA, EB, r3, neTolerancePlayer, resolveProfile,
  indifferenceAt, profileConcept, PRESETS,
} from '../src/utils/gameEngine';
import type { GamePayoffs, SimState } from '../src/types';

function createInitialState(startX: number, startY: number, g: GamePayoffs): SimState {
  return {
    cx: startX, cy: startY, exactX: startX, exactY: startY, calcX: startX, calcY: startY,
    displayX: startX, displayY: startY, startX, startY,
    domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1,
    stratX: startX, stratY: startY, cycleCount: 0, visitedPositions: [], ghostVisitedPositions: [],
    discoveredMixedX: null, discoveredMixedY: null, foundAxis: null,
    running: false, converged: false, stepCount: 0,
    pathSegmentsA: [{ xs: [startX], ys: [startY], zs: [r3(EA(startX, startY, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [startX], ys: [startY], zs: [r3(EB(startX, startY, g))], mover: 'A' }],
    phase1PtsA: null, phase1PtsB: null, ghostPathSegmentsA: [], ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false, bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false, ghostBisectGoodLo: 0, ghostBisectGoodHi: 1,
    ghostBisectBadLo: 0, ghostBisectBadHi: 1,
  } as unknown as SimState;
}
function run(g: GamePayoffs, o: { fm: 'A' | 'B'; step: number; mode: 'shrink' | 'regret' }) {
  const st = createInitialState(0.217, 0.217, g);
  const allNE = computeAllNE(g);
  const pure = allNE.filter(n => n.type === 'pure');
  const committed = pure.length
    ? pure.reduce((b, n) => ((o.fm === 'A' ? n.eA : n.eB) > (o.fm === 'A' ? b.eA : b.eB) ? n : b)) : null;
  for (let i = 0; i < 20000 && !st.converged; i++)
    doStep(g, st, o.fm, o.step, allNE, committed, () => {}, () => {}, () => {}, o.mode);
  return { st, allNE };
}

// RED-APP's probe, with ONE substitution: the line now comes from the SHIPPED
// `indifferenceLines` on branch blue-app instead of RED-APP's copy of main's
// inline render. Everything else — the run loop, the corpora, the counters — is
// RED-APP's, unchanged, so the two numbers are directly comparable.
import { indifferenceLines } from '../src/components/equilibriumPanel';
function renderLine(who: 'A' | 'B', g: GamePayoffs, st: SimState) {
  const res = resolveProfile(g, st);
  const L = indifferenceLines(g, res.x, res.y);
  const l = who === 'A' ? L.a : L.b;
  const l1 = who === 'A' ? 'Row 1' : 'Col 1', l2 = who === 'A' ? 'Row 2' : 'Col 2';
  const rel = l.indifferent ? '\u2248' : (l.p > l.q ? '>' : '<');
  return {
    ind: l.indifferent, p: l.p, q: l.q,
    text: `${who} ${l.indifferent ? 'indifferent' : 'strictly prefers'}:  E[${l1}] = ${l.pStr} ${rel} E[${l2}] = ${l.qStr}`,
    shownGap: l.pStr === l.qStr ? 0 : Math.abs(Number(l.pStr) - Number(l.qStr)),
  };
}

console.log('=== PRESETS (what a reviewer clicks) ===');
for (const key of ['search', 'bos', 'pd', 'cnr', 'spy', 'penalty']) {
  const P: any = (PRESETS as any)[key];
  const g: GamePayoffs = { a11: P.a11, a12: P.a12, a21: P.a21, a22: P.a22, b11: P.b11, b12: P.b12, b21: P.b21, b22: P.b22 };
  for (const mode of ['shrink', 'regret'] as const) {
    for (const fm of ['A', 'B'] as const) {
      const { st } = run(g, { fm, step: 0.01, mode });
      if (!st.converged || (st as any).convergedIsNE === false) continue;
      const resolved = resolveProfile(g, st);
      if (profileConcept(resolved.x, resolved.y) !== 'mixed') continue;
      for (const who of ['A', 'B'] as const) {
        const r = renderLine(who, g, st);
        const bad = (r.ind && r.shownGap > 0) || (!r.ind && r.shownGap === 0);
        if (bad) console.log(`  ${P.name} [${mode}/${fm}]  ${r.text}   (true gap ${(r.p - r.q).toExponential(3)}, tol ${neTolerancePlayer(g, who).toFixed(4)})`);
      }
    }
  }
}

console.log('\n=== random INTEGER games in [-10,10] (the realistic custom case) ===');
const rint = (n: number) => Math.floor(Math.random() * n);
const buckets = { '>=0.001': 0, '>=0.01': 0, '>=0.1': 0, '>=1': 0 };
let mixedRuns = 0, indiffLines = 0, visible = 0, worst = { gap: 0, text: '', g: null as any, o: null as any };
let strictSame = 0;
for (let t = 0; t < 4000; t++) {
  const v = () => rint(21) - 10;
  const g: GamePayoffs = { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() };
  const o = { fm: (['A', 'B'] as const)[rint(2)], step: [0.001, 0.01, 0.1][rint(3)], mode: (['shrink', 'regret'] as const)[rint(2)] };
  let r; try { r = run(g, o); } catch { continue; }
  const st = r.st;
  if (!st.converged || (st as any).convergedIsNE === false) continue;
  const resolved = resolveProfile(g, st);
  if (profileConcept(resolved.x, resolved.y) !== 'mixed') continue;
  mixedRuns++;
  for (const who of ['A', 'B'] as const) {
    const ln = renderLine(who, g, st);
    if (!ln.ind) { if (ln.shownGap === 0) strictSame++; continue; }
    indiffLines++;
    if (ln.shownGap > 0) {
      visible++;
      if (ln.shownGap >= 0.001) buckets['>=0.001']++;
      if (ln.shownGap >= 0.01) buckets['>=0.01']++;
      if (ln.shownGap >= 0.1) buckets['>=0.1']++;
      if (ln.shownGap >= 1) buckets['>=1']++;
      if (ln.shownGap > worst.gap) worst = { gap: ln.shownGap, text: ln.text, g, o };
    }
  }
}
console.log(`mixed-NE runs: ${mixedRuns};  "indifferent" lines rendered: ${indiffLines}`);
console.log(`  lines where the two printed numbers DIFFER: ${visible} (${(100 * visible / Math.max(1, indiffLines)).toFixed(1)}% of indifferent lines)`);
console.log(`  by visible gap: ${JSON.stringify(buckets)}`);
console.log(`  worst: gap ${worst.gap}\n    ${worst.text}\n    game ${JSON.stringify(worst.g)} opts ${JSON.stringify(worst.o)}`);
console.log(`"strictly prefers" with two IDENTICAL printed numbers (the fixed defect, for reference): ${strictSame}`);

console.log('\n=== worst case reachable at the +/-100 clamp ===');
let w2 = { gap: 0, text: '', g: null as any, o: null as any };
for (let t = 0; t < 4000; t++) {
  const v = () => (rint(201) - 100);
  const g: GamePayoffs = { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() };
  const o = { fm: (['A', 'B'] as const)[rint(2)], step: [0.001, 0.01, 0.1][rint(3)], mode: (['shrink', 'regret'] as const)[rint(2)] };
  let r; try { r = run(g, o); } catch { continue; }
  const st = r.st;
  if (!st.converged || (st as any).convergedIsNE === false) continue;
  const resolved = resolveProfile(g, st);
  if (profileConcept(resolved.x, resolved.y) !== 'mixed') continue;
  for (const who of ['A', 'B'] as const) {
    const ln = renderLine(who, g, st);
    if (ln.ind && ln.shownGap > w2.gap) w2 = { gap: ln.shownGap, text: ln.text, g, o };
  }
}
console.log(`  worst: gap ${w2.gap}\n    ${w2.text}\n    game ${JSON.stringify(w2.g)} opts ${JSON.stringify(w2.o)}`);

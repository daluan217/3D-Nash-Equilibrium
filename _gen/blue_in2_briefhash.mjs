/**
 * BLUE-INPUT — byte-identity of `geometryBriefing` across the minimax widening.
 *
 * The claim being proved is NOT "the diff looks small". It is: on every game
 * where the old sentence was already correct, the briefing handed to the model
 * is byte-for-byte what it was before — so every yield and defect number the
 * team holds still describes the shipped prompt. Run in the pristine
 * origin/main worktree and in the candidate worktree, then diff the outputs;
 * the differing line numbers must be EXACTLY the newly-true class.
 *
 *   N=355757 npx tsx _gen/blue_in2_briefhash.mjs > /tmp/brief_<arm>.txt
 */
import { createHash } from 'node:crypto';
import { geometryBriefing } from '../src/utils/geometry.ts';
import { PRESETS, generateRandomGame } from '../src/utils/gameEngine.ts';

const N = Number(process.env.N || 355757);
let seed = Number(process.env.SEED || 2026);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const r3 = (x) => Math.round(x * 1000) / 1000;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

// A mixture of every corpus the product can actually produce, so a byte-identity
// claim is not made only on the distribution the change was written against.
// int[-3,3] is included deliberately and heavily: it is the ONLY corpus where
// the newly-true class has non-zero reach, so a sweep without it would prove
// byte-identity by never testing the branch that moves.
const localNewlyTrue = (g) => {
  const a = [g.a11, g.a12, g.a21, g.a22];
  const b = [g.b11, g.b12, g.b21, g.b22];
  const sums = a.map((v, i) => v + b[i]);
  if (sums.every((x) => Math.abs(x - sums[0]) < 1e-9)) return false; // constant-sum: sentence already true
  const j = a.findIndex((v) => Math.abs(v - a[0]) > 1e-9);
  if (j < 0) return false;
  const k = (b[j] - b[0]) / (a[j] - a[0]);
  if (!(k < -1e-9)) return false;
  const c = b[0] - k * a[0];
  return a.every((ai, i) => Math.abs(b[i] - (k * ai + c)) <= 1e-9 * (1 + Math.abs(b[i])));
};

const out = [];
for (let i = 0; i < N; i++) {
  const m = i % 5;
  const g = m === 0 ? { a11: ri(-9, 9), a12: ri(-9, 9), a21: ri(-9, 9), a22: ri(-9, 9), b11: ri(-9, 9), b12: ri(-9, 9), b21: ri(-9, 9), b22: ri(-9, 9) }
    : m === 1 ? { a11: ri(-3, 3), a12: ri(-3, 3), a21: ri(-3, 3), a22: ri(-3, 3), b11: ri(-3, 3), b12: ri(-3, 3), b21: ri(-3, 3), b22: ri(-3, 3) }
    : m === 2 ? { a11: ri(-100, 100), a12: ri(-100, 100), a21: ri(-100, 100), a22: ri(-100, 100), b11: ri(-100, 100), b12: ri(-100, 100), b21: ri(-100, 100), b22: ri(-100, 100) }
    : m === 3 ? (() => { const p = () => r3((rnd() * 2 - 1) * 100); return { a11: p(), a12: p(), a21: p(), a22: p(), b11: p(), b12: p(), b21: p(), b22: p() }; })()
    : (() => { const a = { a11: ri(-9, 9), a12: ri(-9, 9), a21: ri(-9, 9), a22: ri(-9, 9) }; const k = -(1 + Math.floor(rnd() * 4)); const c = ri(-9, 9);
        return { ...a, b11: k * a.a11 + c, b12: k * a.a12 + c, b21: k * a.a21 + c, b22: k * a.a22 + c }; })();
  out.push(`${i} ${sha(geometryBriefing(g))} ${localNewlyTrue(g) ? 'MOVES' : '.'}`);
}
// The app's own random button uses Math.random and cannot be seeded, so its
// per-game hashes are NOT comparable across two runs. Report the only thing
// that is: how many of its games fall in the class whose sentence moves.
// The predicate is written out locally rather than imported, so the pristine
// worktree — which has no `strictlyCompetitive` field — can run this file too,
// and so the count is an INDEPENDENT check of the shipped predicate rather
// than a restatement of it.

let rb = 0;
for (let i = 0; i < 20000; i++) if (localNewlyTrue(generateRandomGame('mixed'))) rb++;
for (let i = 0; i < 20000; i++) if (localNewlyTrue(generateRandomGame('pure'))) rb++;
out.push(`randombutton-in-moving-class ${rb} / 40000`);
for (const [k, p] of Object.entries(PRESETS)) out.push(`preset:${k} ${sha(geometryBriefing(p))}`);
console.log(out.join('\n'));

/**
 * Validator math claims vs the exact equilibrium set (BLUE-LOOP-MATH-22 sweep 15, S15a-d).
 *
 * The truth here is an oracle that shares no code with equilibriumSet / computeAllNE: equilibrium components have
 * endpoints in {0, 1, interior roots}, so zero-regret tests at breakpoints and midpoints find every component.
 *   npx tsx src/mathvalidator.test.ts
 */
import { readFileSync } from 'node:fs';
import { validateReport, validateProseClaims, validateProseDirections } from './utils/nashValidator';
import { computeAllNE, commitPayoffs, continuumComponents, pointInRect, hasEquilibriumContinuum } from './utils/gameEngine';
import { tieProseFull } from './utils/tieProse';
import { seededRandom } from './testing/prng';
import type { GamePayoffs } from './types';

let checks = 0;
const fails: Record<string, number> = {};
const firstFail: Record<string, string> = {};
const check = (name: string, ok: boolean, detail = ''): void => {
  checks++;
  if (ok) return;
  fails[name] = (fails[name] ?? 0) + 1;
  firstFail[name] ??= detail.slice(0, 400);
};
const L = { name: 'X', row1: 'Cooperate', row2: 'Defect', col1: 'Advance', col2: 'Retreat', description: '' };
const NM: Record<string, string> = { A1: 'Cooperate', A2: 'Defect', B1: 'Advance', B2: 'Retreat' };
const SC: Record<string, number[]> = {
  int9: Array.from({ length: 19 }, (_, i) => i - 9),
  near: [0, 0.001, -0.001, 0.002, 0.1, 1, 3, 99, 100, -100, 99.999, 50, -0.1],
  thou: [0, 0.001, -0.001, 0.002, -0.003, 0.005],
  wide: [100, -100, 50, 0, -37.5, 99.999, 0.001, 1],
};
type Oracle = { ne: [number, number][]; bx: number[]; by: number[] };
function oracle(g: GamePayoffs): Oracle {
  const root = (d1: number, d2: number) => (d1 === d2 ? NaN : -d2 / (d1 - d2));
  const brk = (r: number) => [0, 1, ...(r > 0 && r < 1 ? [r] : [])].sort((p, q) => p - q);
  const bx = brk(root(g.b11 - g.b12, g.b21 - g.b22)), by = brk(root(g.a11 - g.a21, g.a12 - g.a22));
  const pts = (b: number[]) => [...b, ...b.slice(1).map((v, i) => (v + b[i]) / 2)];
  const tol = 1e-12 * Math.max(1, ...Object.values(g).map(Math.abs));
  const ne: [number, number][] = [];
  for (const x of pts(bx)) for (const y of pts(by)) {
    const r1 = y * g.a11 + (1 - y) * g.a12, r2 = y * g.a21 + (1 - y) * g.a22, c1 = x * g.b11 + (1 - x) * g.b21, c2 = x * g.b12 + (1 - x) * g.b22;
    if (Math.max(r1, r2) - (x * r1 + (1 - x) * r2) <= tol && Math.max(c1, c2) - (y * c1 + (1 - y) * c2) <= tol) ne.push([x, y]);
  }
  return { ne, bx, by };
}
/** Probabilities option o of player P takes at the oracle's points, and whether v lies on one of its segments. */
function optionView(o: Oracle, P: 'A' | 'B', opt: 1 | 2) {
  const own = o.ne.map(([x, y]) => (P === 'A' ? x : y)), b = P === 'A' ? o.bx : o.by;
  const ps = own.map((v) => (opt === 1 ? v : 1 - v));
  const onSeg = (v: number) => { const u = opt === 1 ? v : 1 - v; return b.slice(1).some((hi, i) => b[i] < u && u < hi && own.some((q) => Math.abs(q - (b[i] + hi) / 2) < 1e-12)); };
  return { ps, within: (v: number, tol: number) => ps.some((q) => Math.abs(q - v) < tol) || onSeg(v) };
}

// ── S15a verbatim: a mixed NE within COORD_TOL of a pure corner ─────────────────────────────────────────
// Payload says "mixed at x=more than 0.999"; first-match bound the mixed claim to the (1,1) corner → wrong type +
// omitted. The fixture cannot pass by coincidence: the mixed NE is 3.3e-4 from (1,1), inside COORD_TOL = 0.0015.
const S15A = commitPayoffs({ a11: 0.001, a12: 0, a21: 0, a22: 3, b11: 0.001, b12: 0, b21: 0, b22: 3 });
{
  const all = computeAllNE(S15A), mixed = all.find((n) => n.type === 'mixed')!;
  check('S15a fixture shape: a mixed NE sits within 0.0015 of the pure corner (1,1)', !!mixed && 1 - mixed.x < 0.0015 && all.some((n) => n.type === 'pure' && n.x === 1 && n.y === 1), JSON.stringify(all));
  for (const m of [[mixed.x, mixed.y], [0.999, 0.999], [1, 1]]) {
    const claims = [...all.filter((n) => n.type === 'pure').map((n) => ({ type: 'pure' as const, x: n.x, y: n.y })), { type: 'mixed' as const, x: m[0], y: m[1] }];
    for (const order of [claims, [...claims].reverse()]) {
      const r = validateReport({ claimedEquilibria: order, prose: '' } as never, S15A);
      check('S15a a correct report (pure corners + the near-corner mixed NE, either order) validates', r.ok, `${JSON.stringify(order)} :: ${r.checks.filter((c) => /FAIL/.test(c)).join(' | ')}`);
    }
  }
  // Negative controls: the same-type preference must not launder a wrong type or an omission.
  const pures = all.filter((n) => n.type === 'pure').map((n) => ({ type: 'pure' as const, x: n.x, y: n.y }));
  check('S15a control: omitting the near-corner mixed NE still fails', !validateReport({ claimedEquilibria: pures, prose: '' } as never, S15A).ok);
  const dup = [...pures.filter((p) => !(p.x === 1 && p.y === 1)), { type: 'mixed' as const, x: 1, y: 1 }, { type: 'mixed' as const, x: 0.999, y: 0.999 }];
  check('S15a control: two mixed claims at the cluster cannot cover the pure corner', !validateReport({ claimedEquilibria: dup, prose: '' } as never, S15A).ok);
  const PD = commitPayoffs({ a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 });
  check('S15a control: a mixed claim at a lone pure corner is still a wrong type', !validateReport({ claimedEquilibria: [{ type: 'mixed', x: 0, y: 0 }], prose: '' } as never, PD).ok);
}

// ── S15b verbatim: equilibriumActions on a partial tie and at a sub-resolution mix ───────────────────────
{
  // B never plays option 1 here (NE x in [0.5,1], y = 0); the degenerate-only "best reply at an end" rule admitted it.
  const B1 = commitPayoffs({ a11: 3, a12: -7, a21: -3, a22: -7, b11: -7, b12: -5, b21: -4, b22: -6 });
  const act = (g: GamePayoffs, player: 'A' | 'B', option: 1 | 2) => validateProseClaims({ equilibriumActions: [{ player, option }], bestReplies: [] }, '', g, computeAllNE(g), hasEquilibriumContinuum(g)).ok;
  check('S15b fixture shape: B1 is a continuum game', hasEquilibriumContinuum(B1));
  check('S15b a partial-tie continuum refuses an option no equilibrium plays', !act(B1, 'B', 1));
  check('S15b control: and still admits the option it plays', act(B1, 'B', 2) && act(B1, 'A', 1) && act(B1, 'A', 2));
  // x* = 2.0e-5: A plays Cooperate with positive probability; `> 1e-3` refused the true claim.
  const A1 = commitPayoffs({ a11: 50, a12: 0, a21: 0, a22: 99, b11: -0.1, b12: 100, b21: 0.001, b22: -0.001 });
  check('S15b fixture shape: A1 mixes at x* in (0, 1e-3)', (() => { const m = computeAllNE(A1).find((n) => n.type === 'mixed'); return !!m && m.x > 0 && m.x < 1e-3; })());
  check('S15b a sub-resolution mix still counts as played', act(A1, 'A', 1) && act(A1, 'A', 2));
}

// ── S15c/d verbatim: extreme probabilities and percents in the label-aware direction check ───────────────
{
  const dir = (s: string, g: GamePayoffs) => validateProseDirections(s, L, g).length > 0;
  const PURE = commitPayoffs({ a11: 4, a12: -7, a21: 7, a22: -1, b11: 3, b12: -8, b21: -5, b22: -4 });   // NE (Defect, Retreat)
  const A1 = commitPayoffs({ a11: 50, a12: 0, a21: 0, a22: 99, b11: -0.1, b12: 100, b21: 0.001, b22: -0.001 });
  check('S15c "with probability 0" is refused at x* = 2e-5', dir('A plays Cooperate with probability 0.', A1));
  check('S15c control: and stands where it is exact', !dir('A plays Cooperate with probability 0.', PURE));
  for (const s of ['A plays Cooperate 100% of the time.', 'A plays Defect 0% of the time.', 'A plays Defect 0%.', 'A puts 60% on Cooperate.', 'A plays Cooperate 37% of its turns.'])
    check('S15d a false percent claim is refused', dir(s, PURE), s);
  for (const s of ['A plays Defect 100% of the time.', 'A plays Cooperate 0% of the time.', 'A can buy Cooperate at 20% off.', 'A can buy Cooperate at half price.', 'Choosing Cooperate gives a 20% discount on fuel.', 'A plays Defect almost 100% of the time.'])
    check('S15d control: a true or non-mix percent sentence stands', !dir(s, PURE), s);
  check('S15d "0% of the time" is refused at x* = 2e-5 (a mix, not a pure strategy)', dir('A plays Cooperate 0% of the time.', A1));
  check('S15d control: hedged "about 0%" at x* = 2e-5 stands', !dir('A plays Cooperate about 0% of the time.', A1));
  // A continuum ending at 0.5 and a point at 0.5 get ONE verdict at exactly 0.02 off (the continuum branch was
  // inclusive, the point branch strict). B1: NE x in [0.5, 1], y = 0; MP: x* = 0.5.
  const CB1 = commitPayoffs({ a11: 3, a12: -7, a21: -3, a22: -7, b11: -7, b12: -5, b21: -4, b22: -6 });
  const MP = commitPayoffs({ a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 });
  for (const k of [48, 49])
    check('S15d a continuum end and a point agree at the 0.02 boundary', dir(`A plays Cooperate ${k}% of the time.`, CB1) === dir(`A plays Cooperate ${k}% of the time.`, MP) && dir(`A plays Cooperate ${k}% of the time.`, MP) === (k === 48), String(k));
  const X025 = commitPayoffs({ a11: 1, a12: 0, a21: 0, a22: 1, b11: 39, b12: 0, b21: 0, b22: 1 });   // mixed x* = 0.025 exactly
  check('S15d fixture shape: X025 mixes at x* = 0.025', computeAllNE(X025).some((n) => n.type === 'mixed' && n.x === 0.025));
  check('S15d control: "2.5%" is read whole, not as 5%', !dir('A plays Cooperate 2.5% of the time.', X025) && dir('A plays Cooperate 5.5% of the time.', X025));
}

// ── S16 verbatim: a QUALIFIED figure is not a point (bounds, ranges, denials, "no equilibrium") ─────────────
// Once percents parsed (S15d) every bound read as its point: TRUE "puts more than 93% on X" at p = 0.98 flagged,
// FALSE "more than a third" at 0.09 passed. MIX is hand-solved (x* = 0.4, y* = 0.75), so no truth comes from the code.
{
  const dir = (s: string, g: GamePayoffs) => validateProseDirections(s, L, g).length > 0;
  const MIX = commitPayoffs({ a11: 1, a12: 0, a21: 0, a22: 3, b11: 0, b12: 3, b21: 2, b22: 0 });
  const PURE = commitPayoffs({ a11: 4, a12: -7, a21: 7, a22: -1, b11: 3, b12: -8, b21: -5, b22: -4 });   // (Defect, Retreat)
  const ne = computeAllNE(MIX);
  check('S16 fixture shape: MIX has one NE at (0.4, 0.75)', ne.length === 1 && Math.abs(ne[0].x - 0.4) < 1e-12 && Math.abs(ne[0].y - 0.75) < 1e-12, JSON.stringify(ne));
  const S16: [string, boolean, GamePayoffs][] = [
    ['A puts more than 30% on Cooperate.', true, MIX], ['A puts more than 50% on Cooperate.', false, MIX],
    ['A plays Cooperate at most 40% of the time.', true, MIX], ['A plays Cooperate at most 30% of the time.', false, MIX],
    ['A plays Cooperate less than 45% of the time.', true, MIX], ['A plays Cooperate less than 40% of the time.', false, MIX],
    ['A plays Cooperate 40% or more of the time.', true, MIX], ['A plays Cooperate 50% or more of the time.', false, MIX],
    ['A plays Cooperate 35%+ of the time.', true, MIX], ['A plays Cooperate 45%+ of the time.', false, MIX],
    ['A plays Cooperate between 35% and 45% of the time.', true, MIX], ['A plays Cooperate between 50% and 70% of the time.', false, MIX],
    ['A plays Cooperate 35-45% of the time.', true, MIX], ['A plays Cooperate 50-70% of the time.', false, MIX],
    ['A plays Cooperate 35% to 45% of the time.', true, MIX], ['A plays Cooperate 50% – 70% of the time.', false, MIX],
    ['A plays Cooperate from 30 to 45 percent of the time.', true, MIX], ['A plays Cooperate from 50 to 70 percent of the time.', false, MIX],
    ['B plays Advance more than half the time.', true, MIX], ['B plays Advance less than half the time.', false, MIX],
    ['B plays Retreat less than a third of the time.', true, MIX], ['B plays Retreat more than a third of the time.', false, MIX],
    ['B plays Advance between two-thirds and three-quarters of the time.', true, MIX], ['B plays Advance between a fifth and a quarter of the time.', false, MIX],
    ['A does not play Cooperate 60% of the time.', true, MIX], ['A does not play Cooperate 40% of the time.', false, MIX],
    ['A never plays Cooperate more than half the time.', true, MIX], ['A never plays Cooperate less than half the time.', false, MIX],
    ['A never plays Cooperate two-fifths of the time.', false, MIX], ["B doesn't put half on Retreat.", true, MIX],
    ['There is no equilibrium in which A plays Cooperate 70% of the time.', true, MIX], ['No equilibrium has A playing Cooperate 40% of the time.', false, MIX],
    ['A favours Defect over Cooperate 60% of the time.', true, MIX], ['A favours Defect over Cooperate 40% of the time.', false, MIX],
    ['A plays Cooperate a third time after losing.', true, MIX], ['A plays Cooperate in the twenty-fifth round.', true, MIX],
    ['A plays Cooperate 0-10% of the time.', true, PURE], ['A plays Defect 0-10% of the time.', false, PURE],
    ['A does not play Cooperate 100% of the time.', true, PURE], ['A does not play Defect 100% of the time.', false, PURE],
  ];
  for (const [s, truth, g] of S16) check(`S16 a qualified figure is judged as stated (${truth ? 'true stands' : 'false flags'})`, dir(s, g) !== truth, s);
  // A label's own digit is not a range's low end: "from Plan 1 to 90%" read as 1-90% passed the false 0.9.
  const LD = { name: 'X', row1: 'Plan 1', row2: 'Plan 2', col1: 'Route 1', col2: 'Route 2', description: '' };
  for (const [s, truth] of [['A moves from Plan 1 to 90% on Plan 2.', false], ['A moves from Plan 1 to 60% on Plan 2.', true], ['B shifts from Route 2 to 95% on Route 1.', false], ['B shifts from Route 2 to 75% on Route 1.', true]] as const)
    check(`S16 a label digit is not a range end (${truth ? 'true stands' : 'false flags'})`, (validateProseDirections(s, LD, MIX).length > 0) !== truth, s);
}

// ── S17 verbatim: decimals, a/b, idioms and pairs are judged; shelf clauses locate the LEVEL value ──────────
// Before S17 every "with probability 0.733" passed unread, "x = 2/3" was read as x = 2, and "A's surface has a level
// shelf when B uses Advance with probability 0.375" was skipped as a hypothetical. MIX is hand-solved (x* = 0.4,
// y* = 0.75); A is level only at y = 0.75 and B only at x = 0.4, so no verdict can come from the code under test.
{
  const MIX = commitPayoffs({ a11: 1, a12: 0, a21: 0, a22: 3, b11: 0, b12: 3, b21: 2, b22: 0 });
  const dir = (s: string, g: GamePayoffs, l = L) => validateProseDirections(s, l, g).length > 0;
  const S17: [string, boolean][] = [
    ['A uses Cooperate with probability 0.4 and Defect with probability 0.6.', true], ['A uses Cooperate with probability 0.7 and Defect with probability 0.3.', false],
    ['A plays Cooperate with probability 0.733.', false], ['B uses Advance with probability 0.75.', true], ['B uses Advance with probability 0.25.', false],
    ['A assigns 0.4 probability to Cooperate.', true], ['A assigns 0.9 probability to Cooperate.', false],
    ['A puts probability 0.4 on Cooperate.', true], ['A puts probability 0.8 on Cooperate.', false],
    ['A plays Cooperate with probability 2/5.', true], ['A plays Cooperate with probability 4/5.', false],
    ['A uses Cooperate with probability 0.4 and Defect with 0.6.', true], ['A uses Cooperate with probability 0.4 and Defect with 0.9.', false],
    ['B splits fifty-fifty between Advance and Retreat.', false], ['A mixes evenly between Cooperate and Defect.', false], ['A splits equally between Cooperate and Defect.', false],
    ['B uses Advance and Retreat fifty-fifty.', false], ['B mixes evenly.', false], ["B's even split creates A's flat shelf.", false],
    // A pair names no option, so its order is not fixed by the words: either order stands, a wrong pair flags.
    ["A's 0.4/0.6 mix levels B's surface.", true], ["A's 0.6/0.4 mix levels B's surface.", true], ["A's 0.7/0.3 mix levels B's surface.", false], ["A's 40–60 mix levels B.", true], ["A's 70–30 mix levels B.", false],
    // S17c/d: a decimal point is not a clause stop; a shelf clause is judged against where the opponent is level.
    ['When B uses Advance with probability 0.5 and Retreat 50% of the time, A prefers Defect.', true],
    ["A's surface has a level shelf when B uses Advance with probability 0.75.", true], ["A's surface has a level shelf when B uses Advance with probability 0.375.", false],
    ["A's surface has a level shelf when B uses Advance three-quarters of the time.", true], ["A's surface has a level shelf when B uses Advance a quarter of the time.", false],
    ["B's surface is level when A plays Cooperate with probability 0.4.", true], ["B's surface is level when A plays Cooperate with probability 0.6.", false],
    ["When A plays Cooperate with probability 0.6, B's surface is not level.", true],
    ['A has a level shelf when B mixes fifty-fifty.', false], ['B has a level shelf when A mixes fifty-fifty.', false],
  ];
  for (const [s, truth] of S17) check(`S17 a decimal/idiom/shelf figure is judged as stated (${truth ? 'true stands' : 'false flags'})`, dir(s, MIX) !== truth, s);
  // The mixer in "X has a shelf when Y mixes" is X's opponent. H is asymmetric: A is level at y = 0.5, B at x = 0.4.
  const H = commitPayoffs({ a11: 1, a12: 0, a21: 0, a22: 1, b11: 0, b12: 3, b21: 2, b22: 0 });
  // A named mixer ("the retailer") is resolved only through the shelf owner (gold: "A has a level shelf when the retailer mixes fifty-fifty").
  for (const [s, truth] of [['A has a level shelf when B mixes fifty-fifty.', true], ['B has a level shelf when A mixes fifty-fifty.', false],
    ['A has a level shelf when the retailer mixes fifty-fifty.', true], ['B has a level shelf when the retailer mixes fifty-fifty.', false]] as const)
    check(`S17 a shelf owner's opponent is the mixer (${truth ? 'true stands' : 'false flags'})`, dir(s, H) !== truth, s);
  // DPO verbatim, true (pure NE, so only the level value can bear it out): "no interior joint flat spot" in the same
  // clause denies the joint point, not the shelf. B's mix levels A at 3/7.
  const CS = { name: 'X', row1: 'Fast Route', row2: 'Safe Route', col1: 'Early Shift', col2: 'Late Shift', description: '' };
  const CSG = commitPayoffs({ a11: -7, a12: 5, a21: 1, a22: -1, b11: 7, b12: 0, b21: 4, b22: 0 });
  const cs = 'Geometrically, the payoff surfaces interact rather than mirror each other, and while the courier has a level shelf at an Early Shift probability of 0.4286, there is no interior joint flat spot, so the equilibrium lies at a corner.';
  check('S17 dpo: a true shelf beside "no interior joint flat spot" stands', !dir(cs, CSG, CS), cs);
  check('S17 control: the same shelf at a false value flags', dir(cs.replace('0.4286', '0.2'), CSG, CS));
  // Gold verbatim, true: a shelf at the level value with a pure NE (dataset gen:pure) and shared words across players
  // (preset:penalty: "the interceptor covers the Mountain Pass" is B's figure in A's words). Each flagged mid-S17.
  const SU = { name: 'X', row1: 'Full launch', row2: 'Pilot launch', col1: 'Support', col2: 'Withhold', description: '' };
  const PURE = commitPayoffs({ a11: -3, a12: 9, a21: 0, a22: 5, b11: -1, b12: -7, b21: 1, b22: -7 });
  const shelf = 'Geometrically, A’s warped payoff surface has an indifference shelf at support probability 0.5714, but there is no interior joint flat spot, so the equilibrium lies at a corner.';
  check('S17 gold: a true shelf beside a pure NE stands', !dir(shelf, PURE, SU), shelf);
  check('S17 control: the same shelf at a false value flags', dir(shelf.replace('0.5714', '0.3'), PURE, SU));
  const CI = { name: 'X', row1: 'Mountain Pass', row2: 'River Road', col1: 'Cover Mountain', col2: 'Cover River', description: '' };
  const PEN = commitPayoffs({ a11: -12, a12: 8, a21: 2, a22: 0, b11: 12, b12: -8, b21: -2, b22: 0 });
  const pen = 'In the sole equilibrium, the courier uses the Mountain Pass with probability 0.091 and the River Road with probability 0.909, while the interceptor covers the Mountain Pass with probability 0.364 and the River Road with probability 0.636.';
  check('S17 gold: a figure for the other actor in shared words stands', !dir(pen, PEN, CI), pen);
  check('S17 control: a swapped courier mix still flags', dir(pen.replace('0.091', '0.5').replace('0.909', '0.5'), PEN, CI));
  // DPO verbatim, true: "settles" is B's Settle in A's list ("A audits with probability 0.762 and settles with 0.238").
  const AU = { name: 'X', row1: 'Audit', row2: 'Negotiate', col1: 'Contest', col2: 'Settle', description: '' };
  const AUG = commitPayoffs({ a11: 2, a12: 5, a21: -7, a22: 9, b11: -6, b12: -1, b21: 7, b22: -9 });
  const au = 'At the sole equilibrium, A audits with probability 0.762 and settles with 0.238, while B contests with probability 0.308.';
  check('S17 dpo: a list continuing its own player in shared words stands', !dir(au, AUG, AU), au);
  check('S17 control: the same list at a false value flags', dir(au.replace('0.762', '0.5').replace('0.238', '0.5'), AUG, AU));
  // S17b: checkProse reads a/b, percent and tuple citations (x = 2/3 was x = 2; (x, y) = (…) was unread).
  const G23 = commitPayoffs({ a11: 1, a12: 0, a21: 0, a22: 2, b11: 0, b12: 1, b21: 2, b22: 0 });   // x* = y* = 2/3
  for (const [s, truth] of [['A mixes at x = 2/3 and B at y = 2/3.', true], ['A mixes at x = 1/3.', false], ['B mixes at y = 3/4.', false], ['A mixes at x = 0.667.', true], ['A mixes at x = 0.4.', false],
    ['The equilibrium is (x, y) = (2/3, 2/3).', true], ['The equilibrium is (x, y) = (0.25, 0.9).', false], ['A mixes at x = 66.7%.', true], ['A mixes at x = 25%.', false],
    ['Both surfaces are level at the interior point (0.667, 0.667).', true], ['Both surfaces are level at the interior point (0.4, 0.75).', false]] as const)
    check(`S17b a coordinate citation is judged (${truth ? 'true stands' : 'false flags'})`, validateReport({ claimedEquilibria: [{ type: 'mixed', x: 2 / 3, y: 2 / 3 }], prose: s } as never, G23).ok === truth, s);
  // S18: each sentence must stand on HALF (x* = y* = 1/2, hand-solved) and flag on MIX (nothing at 1/2), so neither
  // verdict can come from an unread sentence. S18a: "probability 1/2" was read as probability 1 (TRUE flagged).
  const HALF = commitPayoffs({ a11: 1, a12: 0, a21: 0, a22: 1, b11: 0, b12: 1, b21: 1, b22: 0 });
  const IO = { name: 'X', row1: 'Indoor', row2: 'Outdoor', col1: 'Day', col2: 'Night', description: '' };
  for (const s of ['At equilibrium B chooses Day with probability 1/2.', 'At equilibrium B chooses Day with probability 1 / 2.',
    'The sole equilibrium is therefore mixed: A schedules Indoor and Outdoor fifty-fifty, while B schedules Day and Night fifty-fifty.', // gold verbatim
    'At equilibrium B plays Day and Night with equal probability.', 'At equilibrium B flips a fair coin between Day and Night.', 'At equilibrium B is equally likely to choose Day or Night.',
    'Both players split evenly at the equilibrium: A between Indoor and Outdoor, B between Day and Night.', 'At equilibrium B chooses Day and Night in equal proportions.', 'At equilibrium B chooses Day as often as Night.']) {
    check('S18 a one-half claim stands where the equilibrium is one half', !dir(s, HALF, IO), s);
    check('S18 the same one-half claim flags where no equilibrium is', dir(s, MIX, IO), s);
  }
}

// ── S18c: payoff FIGURES in prose are held to the cell the sentence names ──────────────────────────────────────
// Before S18c only "N against X" and "N rather than M against X" were read: "A gets 5 from Defect", "B earns 9" and
// "Defect and Retreat yields payoffs 7 and 8" passed. Each true sentence has a false twin that differs only in a figure,
// and each figure was read off the hand-written matrix (MIX cells: A 1 0 / 0 3, B 0 3 / 2 0), never off the code.
{
  const MIX = commitPayoffs({ a11: 1, a12: 0, a21: 0, a22: 3, b11: 0, b12: 3, b21: 2, b22: 0 });
  const CA = commitPayoffs({ a11: 4, a12: 1, a21: 4, a22: 1, b11: 0, b12: 3, b21: 2, b22: 0 });     // A ties in each column
  const CON = commitPayoffs({ a11: 2, a12: 2, a21: 2, a22: 2, b11: -1, b12: -1, b21: -1, b22: -1 });
  const HL = commitPayoffs({ a11: -8, a12: -5, a21: 3, a22: -6, b11: 6, b12: 6, b21: 4, b22: 0 });  // gold dataset_ties row
  const LHL = { name: 'X', row1: 'Helicopter', row2: 'Convoy', col1: 'Coastal depot', col2: 'Inland depot', description: '' };
  const LH = { name: 'X', row1: 'Big launch', row2: 'Small launch', col1: 'Advertise', col2: 'Stay quiet', description: '' };
  const H2 = commitPayoffs({ a11: 3, a12: -4, a21: 0, a22: -1, b11: 9, b12: 9, b21: -1, b22: 3 });   // pure NE pay 3,9 and -1,3
  const T: [string, string, GamePayoffs, typeof L?][] = [   // [true, false twin, game, labels]
    ['Against Retreat, A gets 3 from Defect rather than 0 from Cooperate.', 'Against Retreat, A gets 5 from Defect rather than 0 from Cooperate.', MIX],
    ['Once B chooses Retreat, A gets 3 from Defect rather than 0 from Cooperate.', 'Once B chooses Retreat, A gets 3 from Defect rather than 2 from Cooperate.', MIX],
    ['Against Cooperate, B earns 3 from Retreat rather than 0 from Advance.', 'Against Cooperate, B earns 2 from Retreat rather than 0 from Advance.', MIX],
    ['When B plays Retreat, A earns 3 with Defect rather than 0 with Cooperate.', 'When B plays Retreat, A earns 3 with Defect rather than 2 with Cooperate.', MIX],
    ['Against Retreat, A gets three from Defect rather than zero from Cooperate.', 'Against Retreat, A gets five from Defect rather than zero from Cooperate.', MIX],
    ['At Cooperate with Retreat, A receives 0 and B receives 3.', 'At Cooperate with Retreat, A receives 1 and B receives 3.', MIX],
    ['At Cooperate and Advance, A receives 1; at Defect and Retreat, A receives 3.', 'At Cooperate and Advance, A receives 1; at Defect and Retreat, A receives 1.', MIX],
    ["At Defect and Retreat, B's payoff is 0.", "At Defect and Retreat, B's payoff is 3.", MIX],
    ["At Defect, B's payoff is 2 rather than its 0 with Retreat.", "At Defect, B's payoff is 2 rather than its 3 with Retreat.", MIX],
    ['When B plays Retreat, A gets 3, so Cooperate is worse.', 'When B plays Retreat, A gets 1, so Cooperate is worse.', MIX],
    ['If A deviated to Cooperate against Retreat, A would get 0.', 'If A deviated to Cooperate against Retreat, A would get 3.', MIX],
    ['A gets 3 with Defect and Retreat.', 'A gets 7 at Defect and Retreat.', MIX], ['B earns 3 against Cooperate.', 'B earns 9.', MIX],
    ['If both pick Defect and Retreat, the payoffs are 3 and 0.', 'If both pick Defect and Retreat, the payoffs are 3 and 2.', MIX],
    ['The outcome Defect and Retreat yields payoffs 3 and 0.', 'The outcome Defect and Retreat yields payoffs 0 and 3.', MIX],
    ['At the equilibrium A earns 0.75 and B earns 1.2 on average.', 'At the equilibrium A earns 2 and B earns 1.2 on average.', MIX],
    ['At the equilibrium A earns 3/4 on average.', 'At the equilibrium A earns 2/3 on average.', MIX],
    ['When B plays Advance, A receives 4 from either option.', 'When B plays Advance, A receives 1 from either option.', CA],
    ['B earns 3 against Cooperate.', 'When B plays Retreat, A receives 3 from either option.', MIX], // MIX: 3 is ONE of 0 / 3
    ['A always receives 2 and B always receives -1.', 'A always receives 2 and B always receives 1.', CON],
    ['A always receives 2.', 'A always receives 3 and B always receives 0.', CON], ['B earns 3 against Cooperate.', 'A always receives 3.', MIX], // 3 is ONE of A's cells
    ['Once B plays Retreat, A gets 3, leaving Cooperate behind.', 'Once B plays Retreat, A gets 1, leaving Cooperate behind.', MIX], // only the comma ends the clause
    ['Against Retreat, Plan B earns 3.', 'Against Retreat, Plan B earns 2.', MIX, { name: 'X', row1: 'Plan A', row2: 'Plan B', col1: 'Advance', col2: 'Retreat', description: '' }],
    ['A Big launch with Stay quiet gives A a payoff of -4 and B a payoff of 9.', 'A Big launch with Stay quiet gives A a payoff of -1 and B a payoff of 3.', H2, LH],
    ['At one equilibrium, A uses the Helicopter while B runs the Inland depot: A gets -5 rather than -6 by staying with the Helicopter, while B scores 6 at either depot and gains nothing by switching.', // gold verbatim
      'At one equilibrium, A uses the Helicopter while B runs the Inland depot: A gets -5 rather than -7 by staying with the Helicopter.', HL, LHL],
  ];
  for (const [t, f, g, l] of T) {
    const is = validateProseDirections(t, l ?? L, g);
    check('S18c a true payoff figure stands', is.length === 0, `${t} :: ${is.join(' | ')}`);
    check('S18c its false twin flags', validateProseDirections(f, l ?? L, g).length > 0, f);
  }
  // Not payoff claims: a difference, a count, a stated mix (any blend is reachable), an option named "Plan B".
  for (const [s, l] of [['A gets 2 more from Defect than from Cooperate when B plays Retreat.', L], ['A makes 2 moves.', L], ['B mixes, so A earns 0.9 in expectation.', L],
    ['Plan B earns A 3 against Retreat.', { name: 'X', row1: 'Plan A', row2: 'Plan B', col1: 'Advance', col2: 'Retreat', description: '' }]] as [string, typeof L][])
    check('S18c a figure that is no payoff claim stands', validateProseDirections(s, l, MIX).length === 0, s);
  // S18d: an OPTION as subject pays its own player (78 real sentences: "Launch pays 9 rather than -1 against Fund"), a list
  // goes on with the same subject, and "3 points less" / "2 over Cooperate" are differences, never levels.
  const FL = commitPayoffs({ a11: -4, a12: -4, a21: 7, a22: -1, b11: 5, b12: 4, b21: 9, b22: -8 });   // gold dataset row
  const LFL = { name: 'X', row1: 'Pilot Launch', row2: 'Full Launch', col1: 'National Campaign', col2: 'Local Campaign', description: '' };
  const PB = { name: 'X', row1: 'Plan A', row2: 'Plan B', col1: 'Advance', col2: 'Retreat', description: '' };
  for (const [t, f, g, l] of [
    ['Against Retreat, Defect earns 3.', 'Against Retreat, Defect earns 2.', MIX], ['Retreat earns 3 when A plays Cooperate.', 'Retreat earns 2 when A plays Cooperate.', MIX],
    ['Defect earns B 2 against Advance.', 'Defect earns B 3 against Advance.', MIX], ['Against Retreat, Plan B earns 3.', 'Against Retreat, Plan B earns 2.', MIX, PB],
    ['The Convoy pays 3 against Coastal depot.', 'The Convoy pays 4 against Coastal depot.', HL, LHL],
    ['With Defect, A gets 3 against Retreat and 0 against Advance.', 'With Defect, A gets 3 against Retreat and 1 against Advance.', MIX],
    ['Defect earns 0 against Advance and 3 against Retreat.', 'Defect earns 0 against Advance and 2 against Retreat.', MIX],
    ['For A, Full Launch pays 7 against National Campaign and -1 against Local Campaign.', 'For A, Full Launch pays 7 against National Campaign and -4 against Local Campaign.', FL, LFL],
    ['For B, Full Launch pays 9 against National Campaign.', 'For B, Full Launch pays 7 against National Campaign.', FL, LFL],   // 7 is A's, 9 is B's
    ["A's Full Launch pays 7 against National Campaign.", "A's Full Launch pays 9 against National Campaign.", FL, LFL],
    ['Full Launch pays 7 rather than -4 against National Campaign and -1 against Local Campaign.', 'Full Launch pays 7 rather than -4 against National Campaign and -4 against Local Campaign.', FL, LFL],
  ] as [string, string, GamePayoffs, typeof L?][]) {
    const is = validateProseDirections(t, l ?? L, g);
    check('S18d an option or list payoff figure stands', is.length === 0, `${t} :: ${is.join(' | ')}`);
    check('S18d its false twin flags', validateProseDirections(f, l ?? L, g).length > 0, f);
  }
  // Each would flag if read as a level: (C,R) pays A 0, and 2 is no cell of Retreat's column; a second subject ends a list.
  for (const s of ['Against Retreat, A gets 2 points less from Cooperate.', 'Against Retreat, Cooperate earns A 3 points less than Defect.',
    'Against Retreat, A gets 2 over Cooperate by playing Defect.', 'A gets 3 against Retreat and B gets 0 and 2 against Advance.', 'Retreat against Defect earns 0.'])
    check('S18d a difference or foreign figure stands', validateProseDirections(s, L, MIX).length === 0, s);
  // S23: "Retreat against Defect earns 2" stood here unread; B's Retreat pays 0 there (A's Defect 3), so it is false either way.
  check('S23 a frame-interposed figure is judged as its own option', validateProseDirections('Retreat against Defect earns 2.', L, MIX).length > 0, 'Retreat against Defect earns 2.');
}

// ── S19: a stated opponent MIX is judged at that mix; a best reply pairs with the frame in its own segment ────────────
// MIX: A's E[C]-E[D] = 4y-3 (ties only at y = 0.75), B's E[Ad]-E[R] = 2-5x (ties only at x = 0.4), worked by hand from the
// cells, not the code. Twins differ only in the figure or the option, so neither side passes by the other's accident.
{
  const MIX = commitPayoffs({ a11: 1, a12: 0, a21: 0, a22: 3, b11: 0, b12: 3, b21: 2, b22: 0 });
  const L = { name: 'X', row1: 'Cooperate', row2: 'Defect', col1: 'Advance', col2: 'Retreat', description: 'A and B choose.' };
  const dir = (s: string, g = MIX, l: typeof L = L) => validateProseDirections(s, l, g);
  const gate = (prose: string) => {   // server.ts assess + validateReport, as shipped
    const rep: any = { claimedEquilibria: [{ type: 'mixed', x: 0.4, y: 0.75 }], prose, suggestedScenario: L, proseClaims: { equilibriumActions: [], bestReplies: [] } };
    const v = validateReport(rep, MIX), pc = validateProseClaims(rep.proseClaims, prose, MIX, computeAllNE(MIX), hasEquilibriumContinuum(MIX), L);
    return [...(v.ok ? [] : v.checks.filter((c: string) => /FAIL/.test(c))), ...pc.issues, ...dir(prose)];
  };
  // S19a: a preference under a mixed frame. [true, false twin].
  for (const [t, f] of [
    ['If B plays Advance 50% of the time, A prefers Defect.', 'If B plays Advance 50% of the time, A prefers Cooperate.'],
    ['If B plays Advance 90% of the time, A prefers Cooperate.', 'If B plays Advance 90% of the time, A prefers Defect.'],
    ['When B plays Advance with probability 0.5, Defect is better for A.', 'When B plays Advance with probability 0.5, Cooperate is better for A.'],
    ['When B plays Retreat 80% of the time, A prefers Defect.', 'When B plays Retreat 80% of the time, A prefers Cooperate.'],
    ['If A plays Cooperate 20% of the time, B prefers Advance.', 'If A plays Cooperate 20% of the time, B prefers Retreat.'],
    ['If A plays Cooperate 60% of the time, B does better with Retreat.', 'If A plays Cooperate 60% of the time, B does better with Advance.'],
    ['If B plays Advance half the time, A prefers Defect.', 'If B plays Advance half the time, A prefers Cooperate.'],
    ['If B plays Advance more than 80% of the time, A prefers Cooperate.', 'If B plays Advance more than 60% of the time, A prefers Cooperate.'],
    ['If B plays Advance less than 70% of the time, A prefers Defect.', 'If B plays Advance less than 70% of the time, A prefers Cooperate.'],
    ['If B puts 90% on Advance, A prefers Cooperate.', 'If B puts 90% on Advance, A prefers Defect.'],
    ['If B plays Advance three-quarters of the time, A is indifferent.', 'If B plays Advance two-thirds of the time, A is indifferent.'],
    ['Against Advance played with probability 0.9, A prefers Cooperate.', 'Against Advance played with probability 0.9, A prefers Defect.'],
    ['A prefers Defect when B plays Advance 50% of the time.', 'A prefers Cooperate when B plays Advance 50% of the time.'],
    ['A prefers Cooperate when B plays Advance with probability 0.9.', 'A prefers Defect when B plays Advance with probability 0.9.'],
  ]) {
    check('S19a a true preference under a stated mix stands', dir(t).length === 0, `${t} :: ${dir(t).join(' | ')}`);
    check('S19a its false twin flags', dir(f).length > 0, f);
  }
  // S19b: the same claims through the whole production gate, incl. expected-payoff figures and the boundary (y* = 0.75).
  for (const [s, t] of [
    ['If B plays Advance 75% of the time, A prefers Cooperate.', false], ['If B plays Advance 76% of the time, A prefers Cooperate.', true],
    ['If B plays Advance 74% of the time, A prefers Cooperate.', false], ['If B plays Advance 74% of the time, A prefers Defect.', true],
    ['If B plays Advance 75% of the time, A is indifferent.', true], ['If B plays Advance 70% of the time, A is indifferent.', false],
    ['If B plays Advance 75% of the time, Cooperate or Defect suits A equally.', true],
    ['If B plays Advance 50% of the time, A gets 1.5 rather than 0.5 by playing Defect.', true], ['If B plays Advance 50% of the time, A gets 2 rather than 0.5 by playing Defect.', false],
    ['If B plays Advance 50% of the time, A prefers Defect, which pays 1.5 rather than 0.5.', true], ['If B plays Advance 50% of the time, A prefers Defect, which pays 3 rather than 0.', false],
    ['If B plays Advance 50% of the time, A gets 1.5 from Defect.', true], ['If B plays Advance 50% of the time, A gets 0.5 from Cooperate.', true],
    ['If B plays Advance 50% of the time, A gets 1 from Cooperate.', false], ['If A plays Cooperate 50% of the time, B gets 1.5 from Retreat.', true],
    ['If A plays Cooperate 50% of the time, B prefers Retreat.', true], ['If A plays Cooperate 50% of the time, B prefers Advance.', false],
    ['If A plays Cooperate at least 40% of the time, B prefers Retreat.', false], ['If A plays Cooperate more than 40% of the time, B prefers Retreat.', true],
    ['If A plays Cooperate at most 40% of the time, B prefers Advance.', false], ['If A plays Cooperate less than 40% of the time, B prefers Advance.', true],
    ['If A plays Defect 70% of the time, B prefers Advance.', true], ['If A plays Defect 70% of the time, B prefers Retreat.', false],
    ['If B plays Retreat a quarter of the time, A is indifferent.', true], ['If B plays Retreat a third of the time, A is indifferent.', false],
    ['If B plays Advance with probability 3/4, A is indifferent.', true], ['If B plays Advance with probability 0.75, A prefers Cooperate.', false],
    ['If B plays Advance about 75% of the time, A is indifferent.', true], ['If B plays Advance 75.5% of the time, A prefers Cooperate.', true],
    ['If B plays Advance 74.5% of the time, A prefers Cooperate.', false], ['If A plays Cooperate exactly 40% of the time, B prefers Retreat.', false],
  ] as [string, boolean][]) check(`S19b the production gate ${t ? 'passes a true' : 'flags a false'} mixed-frame claim`, (gate(s).length === 0) === t, `${s} :: ${gate(s).join(' | ')}`);
  // S19e: every way real and plausible prose states the frame q(Advance) = 0.5, where Defect is strictly better for A.
  for (const fr of ['If B plays Advance 1 time in 2', 'If B plays Advance one time out of two', 'If B plays Advance in half of the rounds',
    "If B's probability of Advance is 0.5", "If B's probability of playing Advance is 50%", 'If the probability that B plays Advance is 0.5',
    'If B plays Advance with 50% probability', 'If B plays Advance with a probability of 0.5', 'If B chooses Advance with a 50% chance',
    'If there is a 50% chance that B plays Advance', 'If B plays Advance at a rate of 0.5', 'If B puts weight 0.5 on Advance',
    'If B puts probability 0.5 on Advance', 'If B randomizes evenly between Advance and Retreat', 'If B mixes 50-50 between Advance and Retreat',
    'If B splits evenly between Advance and Retreat', 'If B plays Advance and Retreat equally often', 'If B flips a fair coin between Advance and Retreat',
    'If B plays Advance as often as Retreat', 'If B plays Advance 50 percent of the time', 'If B plays Advance fifty percent of the time',
    'If B plays Advance 1/2 of the time', 'If B plays Advance with probability 1/2', 'If B picks Advance in 50% of games',
    'If B plays Retreat with probability 0.5', 'If B uses Advance with odds of one in two', 'If B leans 50/50 between Advance and Retreat',
    'Facing a B who plays Advance half the time', 'Against a 50-50 mix of Advance and Retreat', 'Against an even mix of Advance and Retreat']) {
    check('S19e a true preference under each mix wording stands', dir(`${fr}, A prefers Defect.`).length === 0, `${fr} :: ${dir(`${fr}, A prefers Defect.`).join(' | ')}`);
    for (const tail of ['A prefers Cooperate.', 'A is indifferent.']) check('S19e a false claim under each mix wording flags', dir(`${fr}, ${tail}`).length > 0, `${fr}, ${tail}`);
  }
  // S19f: bare indifference under a mix (point, denial, hedge, bound, several claims, causal and facing-who frames).
  for (const [s, t] of [
    ['A is indifferent when B plays Advance 75% of the time.', true], ['A is indifferent when B plays Advance half the time.', false],
    ['If B plays Advance 1 time in 4, A is not indifferent.', true], ['If B plays Advance 3 times in 4, A is not indifferent.', false],
    ['If B plays Advance about 75% of the time, A is not indifferent.', true],
    ['If B plays Advance more than 60% of the time, A is indifferent.', false], ['If B plays Advance at least 75% of the time, A prefers Cooperate.', false],
    ['If A plays Cooperate 40% of the time, B is indifferent, and if B plays Advance 75% of the time, A is indifferent.', true],
    ['If A plays Cooperate 40% of the time, B is indifferent, and if B plays Advance 50% of the time, A is indifferent.', false],
    ['If A plays Cooperate 50% of the time, B is indifferent, and if B plays Advance 75% of the time, A is indifferent.', false],
    ['B is indifferent when A plays Defect three-fifths of the time.', true], ['B is indifferent when A plays Defect two-fifths of the time.', false],
    ['B’s mix of Advance three-quarters of the time leaves A indifferent.', true], ['B playing Advance one time in two leaves A indifferent.', false],
    ['If the probability that B plays Retreat is 0.25, A is indifferent.', true], ['If the probability that B plays Retreat is 0.5, A is indifferent.', false],
    ['Facing a B who plays Advance three times out of four, A is indifferent.', true], ['Facing a B who plays Advance one time in four, A is indifferent.', false],
    ['A is indifferent between Cooperate and Defect when B plays Advance with probability 3/4.', true],
    ['A is indifferent between Cooperate and Defect when B plays Advance with probability 1/2.', false],
    // S19i: a ", and" sub-clause's shelf word belongs to its own figure; without one it still covers the first.
    ['If B plays Advance 50% of the time, A prefers Defect, and A is indifferent only when B plays Advance 75% of the time.', true],
    ['If B plays Advance 75% of the time, A prefers Defect, and if B plays Advance 50% of the time, A is indifferent.', false],
    ['When B plays Advance half of the time, A gets the same from both options, and A’s surface is a level shelf.', false],
  ] as [string, boolean][]) check(`S19f ${t ? 'a true' : 'a false'} indifference under a mix is judged`, (dir(s).length === 0) === t, `${s} :: ${dir(s).join(' | ')}`);
  // S19j: ranges and "or more" are bounds held throughout; a bare figure qualifying something else ("50% more effort")
  // is no mix; "with 0.9" is; a frame across a claim-free boundary still frames; "unless/except X" names all BUT X.
  for (const [s, t] of [
    ['If B plays Advance with probability 0.9, A prefers Cooperate.', true], ['If B plays Advance with probability 0.9, A prefers Defect.', false],
    ['If B plays Advance with 0.5, A prefers Defect.', true], ['If B plays Advance with 0.5, A prefers Cooperate.', false],
    ['If B plays Advance at 0.9, A prefers Cooperate.', true], ['If B plays Advance at 0.9, A prefers Defect.', false],
    ['If B plays Advance with 0.5 seconds of delay, A prefers Cooperate.', true], ['Against Retreat 0.1 is the margin: A prefers Defect.', true],
    ['If B plays Retreat 0, A prefers Defect.', true], ['When B plays Retreat 0, A prefers Defect.', true],   // a bare figure is no probability
    // The nearest frame before the claim, not the segment's first: the Advance clause states a payoff, the Retreat one frames.
    ['If B plays Advance, A gets 1 from Cooperate, and if B plays Retreat, A prefers Defect.', true],
    ['If B plays Advance, A gets 1 from Cooperate, and if B plays Retreat, A prefers Cooperate.', false],
    ['If B plays Advance with 50% more effort, A prefers Cooperate.', true], ['If B plays Advance at 50% higher cost, A prefers Cooperate.', true],
    ['If B plays Advance for 50% of the payoff, A prefers Cooperate.', true], ['If B plays Advance 50% of the time, A prefers Cooperate.', false],
    ['If B plays Advance 50-60% of the time, A prefers Defect.', true], ['If B plays Advance 50-80% of the time, A prefers Defect.', false],
    ['If B plays Advance between 50% and 60% of the time, A prefers Defect.', true], ['If B plays Advance between 50% and 60% of the time, A prefers Cooperate.', false],
    ['If B plays Advance between a third and a half of the time, A prefers Defect.', true], ['If B plays Advance between a third and a half of the time, A prefers Cooperate.', false],
    ['If B plays Advance 50% to 60% of the time, A prefers Defect.', true], ['If B plays Advance 50% to 60% of the time, A prefers Cooperate.', false],
    ['If B plays Advance 50 to 60% of the time, A prefers Defect.', true], ['If B plays Advance 50 to 60% of the time, A prefers Cooperate.', false],
    ['If B plays Advance from 50% to 60% of the time, A prefers Defect.', true], ['If B plays Advance from 50% to 60% of the time, A prefers Cooperate.', false],
    ['If B plays Advance between 50% and roughly 60% of the time, A prefers Defect.', true], ['If B plays Advance 50 to 60 percent of the time, A prefers Defect.', true],
    ['If B plays Advance 5-6 times in 10, A prefers Defect.', true], ['If B plays Advance 5-9 times in 10, A prefers Defect.', false],
    ['If B plays Advance between 70% and 80% of the time, A is not indifferent.', true], ['If B plays Advance 70-80% of the time, A is indifferent.', false],
    ['If B plays Advance 80% or more of the time, A prefers Cooperate.', true], ['If B plays Advance 75% or more of the time, A is indifferent.', false],
    ['If B plays Advance 70% or less of the time, A prefers Defect.', true], ['If B plays Advance 70% or less of the time, A prefers Cooperate.', false],
    ['If B plays Advance 75% of the time, A prefers Cooperate or Defect.', true], ['If B plays Advance at least 75% of the time, A prefers Cooperate or Defect.', false],
    ['Against Retreat, the payoffs are clear; A prefers Defect.', true], ['Against Retreat, the payoffs are clear; A prefers Cooperate.', false],
    ['Against Retreat: A prefers Defect.', true], ['Against Retreat: A prefers Cooperate.', false],
    ['A is never indifferent unless B plays Advance 75% of the time.', true], ['A is not indifferent except when B plays Advance 75% of the time.', true],
    ['Except when B plays Advance 75% of the time, A is not indifferent.', true], ['Unless B plays Advance, A prefers Defect.', true],
    ['Except against Advance, A prefers Defect.', true], ['A prefers Defect unless B plays Advance.', true], ['Against Advance, A prefers Defect.', false],
    // A range crossing y* fails though its high end alone holds; "8-9 times in 10" is 0.8-0.9, not 0.08-0.9; a hedged
    // high end is still a range end (read as "some mix", the false twin would pass); "with 0 in reserve" is no probability.
    ['If B plays Advance 70-80% of the time, A prefers Cooperate.', false], ['If B plays Advance between 70% and 80% of the time, A prefers Cooperate.', false],
    ['If B plays Advance 8-9 times in 10, A prefers Cooperate.', true], ['If B plays Advance between 50% and roughly 80% of the time, A prefers Defect.', false],
    ['If B plays Retreat with 0 in reserve, A prefers Defect.', true],
    // a change narrative ("from 50% … to 90%") whose far end the range form misses is no claim at its near end
    ['If B shifts Advance from 50% of the time to 90%, A comes to prefer Cooperate.', true], ['If B raises Advance from 50% of the time to nearly always, A prefers Cooperate.', true],
    // A hedged bound is read at its narrower end (0.77 here): the tie at 0.75 is not inside it.
    ['If B plays Advance at least about 75% of the time, A prefers Cooperate.', true], ['If B plays Advance at least about 70% of the time, A prefers Cooperate.', false],
  ] as [string, boolean][]) check(`S19j ${t ? 'a true' : 'a false'} range/bound/complement frame is judged`, (dir(s).length === 0) === t, `${s} :: ${dir(s).join(' | ')}`);
  // A second indifference claim does not reuse the first claim's trailing frame (a pure choice is not 75%).
  for (const s of ['A is indifferent when B plays Advance 75% of the time, and when B plays a pure option, A is not indifferent.',
    'A is indifferent when B plays Advance 75% of the time, and at any pure choice by B, A is not indifferent.'])
    check('S19f a second indifference claim takes no frame from the first', dir(s).length === 0, `${s} :: ${dir(s).join(' | ')}`);
  // A bare fact before an indifference claim is no frame for it: here B's pure equilibrium, then A's mixed one (BoS, 3 NE).
  const BOS = commitPayoffs({ a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 }), LBOS = { name: 'X', row1: 'Opera', row2: 'Ballet', col1: 'Stadium', col2: 'Park', description: '' };
  for (const s of ['In one equilibrium B plays Stadium with probability 1, and in the mixed one A is indifferent.', 'B plays Stadium with probability 1 in one equilibrium, and A is indifferent in the mixed one.'])
    check('S19f a bare fact before an indifference claim does not frame it', dir(s, BOS, LBOS).length === 0, `${s} :: ${dir(s, BOS, LBOS).join(' | ')}`);
  // S19h: real report sentences (verbatim) whose best reply pairs with the frame in its OWN segment. Each true one was
  // flagged by first-frame pairing or by a frame from another segment; each false one is wrong in the matrix shown.
  const G = (a11: number, a12: number, a21: number, a22: number, b11: number, b12: number, b21: number, b22: number) => commitPayoffs({ a11, a12, a21, a22, b11, b12, b21, b22 });
  const Lb = (row1: string, row2: string, col1: string, col2: string) => ({ name: 'X', row1, row2, col1, col2, description: '' });
  const SH: [string, boolean, GamePayoffs, typeof L][] = [
    ["Factory A is trading off Inspect against Waive, but Inspect is better whether B Inspects or Waives; against A's Inspect, B does better with Waive.", true, G(2, 4, -8, -8, -4, 6, -2, -9), Lb('Inspect', 'Waive', 'Inspect', 'Waive')],
    ['Against Open, B does better by choosing Close, and against Close, B does better by choosing Open; against B’s Open, A does better by choosing Close, while against B’s Close, A does better by choosing Close.', true, G(-8, -9, -3, -9, -8, -6, 6, -8), Lb('Open', 'Close', 'Open', 'Close')],
    ['A, however, does better by launching early against Partner, while against Compete, A does better with Launch late.', true, G(6, 1, -9, 4, -1, -2, 8, 6), Lb('Launch early', 'Launch late', 'Partner', 'Compete')],
    ['Against a Full rollout, B does better with Clear than Review, while against Pilot, B does better with Review.', true, G(-4, -3, -4, -3, -4, -9, -3, 5), Lb('Pilot', 'Full rollout', 'Review', 'Clear')],
    ['If B instead runs a Counter-ad, A prefers an Early launch; when B chooses Ignore, however, A gets -9 from either launch date and is indifferent.', true, G(8, -9, 1, -9, -4, 9, -6, 9), Lb('Early launch', 'Late launch', 'Counter-ad', 'Ignore')],
    ['If A chooses Riverside, B’s choice between Morning and Evening is tied; if A chooses Upland, B does better with Morning, while if A chooses Morning, B does better with Morning too.', true, G(4, -4, 4, 2, -8, -8, 1, -3), Lb('Riverside', 'Upland', 'Morning', 'Evening')],
    ['Against Express, B does better with Early Shift, but once A uses Economy, B can use either shift and still receive 0.', true, G(-8, 0, -2, 8, -6, -7, 0, 0), Lb('Express', 'Economy', 'Early Shift', 'Late Shift')],
    ['Firm A is indifferent between Inspect and Ignore against B’s Inspect, but against B’s Ignore A does better with Inspect.', true, G(2, 4, 2, -2, -9, -9, 6, -2), Lb('Inspect', 'Ignore', 'Inspect', 'Ignore')],
    ['Firm A is indifferent between Inspect and Ignore against B’s Inspect, but against B’s Ignore A does better with Ignore.', false, G(2, 4, 2, -2, -9, -9, 6, -2), Lb('Inspect', 'Ignore', 'Inspect', 'Ignore')],
    ['Against A’s Plaza, B prefers the Station, which pays 9 rather than 3 at the Plaza.', false, G(-2, 4, -2, -7, 9, 9, 3, 8), Lb('Plaza', 'Station', 'Plaza', 'Station')],   // 9 vs 9: a tie
    ['Against A’s Station, B prefers the Station.', true, G(-2, 4, -2, -7, 9, 9, 3, 8), Lb('Plaza', 'Station', 'Plaza', 'Station')],
    ['Against A’s Station, B prefers the Plaza.', false, G(-2, 4, -2, -7, 9, 9, 3, 8), Lb('Plaza', 'Station', 'Plaza', 'Station')],
    ['Against A’s Economy Plan, B prefers Premium Plan, while against A’s Premium Plan, B prefers Economy Plan, so each firm’s preferred plan changes with its rival’s choice.', false, G(-3, -4, -3, 6, 3, -8, 5, 9), Lb('Premium Plan', 'Economy Plan', 'Premium Plan', 'Economy Plan')],
    ['Against A’s Economy Plan, B prefers Economy Plan, while against A’s Premium Plan, B prefers Premium Plan.', true, G(-3, -4, -3, 6, 3, -8, 5, 9), Lb('Premium Plan', 'Economy Plan', 'Premium Plan', 'Economy Plan')],
    ['Facing the Rival app, A prefers the Closed suite, which pays 9 rather than 2 for the Open platform.', true, G(9, 2, 0, 9, 0, 2, -2, 9), Lb('Open platform', 'Closed suite', 'Build plugin', 'Rival app')],
    ['Against Pilot, Leo prefers Back, which gives her 2 rather than 1, while against Full Launch he prefers Wait, receiving -6 rather than -9.', true, G(8, 6, 8, -8, 2, 1, -9, -6), Lb('Pilot', 'Full Launch', 'Back', 'Wait')],
    // A frame word in the claim's own segment blocks the earlier frame (verbatim golds; the earlier one pays the other way).
    ['Against Open, A does better with Restriction, while against Restriction A does better with Open; against Open B does better with Restriction, while against Restriction B does better with Open.', true, G(0, 0, 2, -7, 5, 9, 9, -8), Lb('Open', 'Restricted', 'Open', 'Restricted')],
    // A claim-free "while" segment borrows the earlier frame: against A's Bold, B's two campaigns both pay -4 (only this catches it).
    ['Against the Bold campaign, A is indifferent between its campaigns, while B does better by choosing the Bold campaign; against the Conservative campaign, A does better by choosing the Conservative campaign, while B does better by choosing the Conservative campaign.', false, G(-8, 8, -8, 9, -4, -4, 0, 7), Lb('Bold campaign', 'Conservative campaign', 'Bold campaign', 'Conservative campaign')],
  ];
  for (const [s, t, g, l] of SH) check(`S19h ${t ? 'a true' : 'a false'} best reply is judged in its own segment`, (dir(s, g, l).length === 0) === t, `${s} :: ${dir(s, g, l).join(' | ')}`);
  // The frame capture runs on into the claim ("against A’s Full inspection B prefers Open doors"): cut at the subject.
  const DR = G(4, -7, 4, -7, -8, 3, 4, -4), LDR = Lb('Full inspection', 'Light inspection', 'Open doors', 'Close doors');
  for (const [s, t] of [['So against A’s Full inspection B prefers Open doors.', false], ['So against A’s Full inspection B prefers Close doors.', true]] as [string, boolean][])
    check(`S19h a run-on frame still ${t ? 'passes a true' : 'catches a false'} best reply`, t ? dir(s, DR, LDR).length === 0 : dir(s, DR, LDR).some((i) => /best reply/.test(i)), `${s} :: ${dir(s, DR, LDR).join(' | ')}`);

  // S20a: every qualifier on a stated mix or an equilibrium figure. Bounds cross y* = 0.75 (x* = 0.4) on purpose: the
  // figure alone makes each false twin true, so only the bound's direction flags it; a hedged 75% admits the tie.
  const Q: [string, boolean][] = [];
  const GE = ['upwards of', 'upward of', 'no less than', 'not less than', 'a minimum of', 'in excess of', 'well over', 'a little over', 'slightly more than', 'just over', 'well above', 'north of', 'no fewer than', 'greater than', 'beyond', 'at least about', 'over'];
  const LE = ['up to', 'no more than', 'not more than', 'a maximum of', 'just under', 'a little under', 'slightly less than', 'well under', 'well below', 'not over', 'below', 'under', 'south of', 'only up to', 'no higher than'];
  const HD = ['some', 'circa', 'approx.', 'close to', 'near', 'almost', 'about', 'something like', 'on the order of', 'in the region of', 'an estimated', 'a rough', 'just about', 'more or less', 'barely', 'an approximate', 'perhaps', 'on average'];
  for (const q of GE) Q.push([`If B plays Advance ${q} 70% of the time, A prefers Defect.`, false], [`If B plays Advance ${q} 80% of the time, A prefers Cooperate.`, true]);
  for (const q of LE) Q.push([`If B plays Advance ${q} 80% of the time, A prefers Cooperate.`, false], [`If B plays Advance ${q} 70% of the time, A prefers Defect.`, true]);
  for (const q of HD) Q.push([`If B plays Advance ${q} 75% of the time, A is not indifferent.`, true], [`If B plays Advance ${q} 50% of the time, A prefers Cooperate.`, false]);
  for (const [suf, ge] of [['or more', 1], ['or less', 0], ['or above', 1], ['or below', 0], ['and above', 1], ['and below', 0], ['or higher', 1], ['or lower', 0], ['or more often', 1], ['or less often', 0], ['and up', 1], ['or fewer', 0], ['or greater', 1], ['and over', 1], ['and under', 0], ['plus', 1]] as [string, number][])
    for (const fig of [(f: number) => `${f}% ${suf} of the time`, (f: number) => `${f}% of the time ${suf}`])
      Q.push([`If B plays Advance ${fig(ge ? 70 : 80)}, A prefers ${ge ? 'Defect' : 'Cooperate'}.`, false], [`If B plays Advance ${fig(ge ? 80 : 70)}, A prefers ${ge ? 'Cooperate' : 'Defect'}.`, true]);
  for (const h of ['or so', 'give or take', 'or thereabouts', 'more or less', 'ish']) Q.push([`If B plays Advance 75% ${h} of the time, A is not indifferent.`, true], [`If B plays Advance 50% ${h} of the time, A prefers Cooperate.`, false]);
  const SHAPES = [(q: string, f: number) => `If B puts ${q} ${f}% on Advance`, (q: string, f: number) => `If there is ${q} a ${f}% chance that B plays Advance`,
    (q: string, f: number) => `If the probability that B plays Advance is ${q} ${f}%`, (q: string, f: number) => `If B plays Advance with probability ${q} 0.${f}`,
    (q: string, f: number) => `If B plays Advance ${q} ${f}% of the time`, (q: string, f: number) => `If B's weight on Advance is ${q} ${f}%`];
  for (const sh of SHAPES) {
    for (const q of ['upwards of', 'a minimum of', 'no less than']) Q.push([`${sh(q, 70)}, A prefers Defect.`, false], [`${sh(q, 80)}, A prefers Cooperate.`, true], [`${sh(q, 75)}, A is indifferent.`, false]);
    for (const q of ['a maximum of', 'no more than', 'up to']) Q.push([`${sh(q, 80)}, A prefers Cooperate.`, false], [`${sh(q, 70)}, A prefers Defect.`, true], [`${sh(q, 75)}, A is indifferent.`, false]);
    for (const q of ['some', 'circa', 'roughly']) Q.push([`${sh(q, 75)}, A is not indifferent.`, true], [`${sh(q, 50)}, A prefers Cooperate.`, false], [`${sh(q, 50)}, A prefers Defect.`, true]);
  }
  // A loose figure is some mix, not pure Advance (where Defect loses 0 vs 1); where Cooperate dominates, no mix saves it.
  Q.push(['If B plays Advance as little as 70% of the time, A prefers Defect.', true]);
  const DOM = G(1, 3, 0, 0, 0, 3, 2, 0), loose = 'If B plays Advance as little as 70% of the time, A prefers Defect.';
  check('S20a a loose figure still flags a claim false at every mix', dir(loose, DOM).length > 0, loose);
  const EGE = ['upwards of', 'no less than', 'not less than', 'a minimum of', 'in excess of', 'well over', 'just over', 'north of', 'no fewer than', 'greater than', 'over', 'above', 'at least', 'more than'];
  const ELE = ['up to', 'no more than', 'a maximum of', 'just under', 'a little under', 'slightly less than', 'well under', 'well below', 'not over', 'below', 'under', 'south of', 'no higher than', 'at most', 'less than'];
  const eq = (q: string) => `In equilibrium A plays Cooperate ${q}.`;
  for (const q of EGE) Q.push([eq(`${q} 50% of the time`), false], [eq(`${q} 30% of the time`), true]);
  for (const q of ELE) Q.push([eq(`${q} 30% of the time`), false], [eq(`${q} 50% of the time`), true]);
  for (const [sf, ge] of [['or more', 1], ['or above', 1], ['or higher', 1], ['and above', 1], ['and up', 1], ['or greater', 1], ['and over', 1], ['plus', 1], ['or less', 0], ['or below', 0], ['or lower', 0], ['or fewer', 0], ['and below', 0], ['and under', 0]] as [string, number][])
    for (const fig of [(f: number) => `${f}% ${sf} of the time`, (f: number) => `${f}% of the time ${sf}`]) Q.push([eq(fig(ge ? 50 : 30)), false], [eq(fig(ge ? 30 : 50)), true]);
  for (const q of ['some', 'circa', 'close to', 'near', 'almost', 'about', 'something like', 'on the order of', 'in the region of', 'just about', 'more or less']) Q.push([eq(`${q} 40% of the time`), true], [eq(`${q} 60% of the time`), false]);
  for (const q of ['or so', 'give or take', 'or thereabouts', 'more or less']) Q.push([eq(`40% ${q} of the time`), true], [eq(`60% ${q} of the time`), false]);
  Q.push([eq('at least about 42% of the time'), true], [eq('at most roughly 38% of the time'), true], [eq('at least about 50% of the time'), false], [eq('at most roughly 30% of the time'), false]);
  for (const [s, t] of Q) check(`S20a ${t ? 'a true' : 'a false'} qualified figure is judged`, (dir(s).length === 0) === t, `${s} :: ${dir(s).join(' | ')}`);

  // S20b: comparative and denied preferences on MIX (vs Advance, A: Cooperate 1 > Defect 0; vs Retreat, Defect 3 > 0).
  // Each pair differs only in the option, so the polarity (inv: names the worse one; neg: denies) alone decides it.
  const TIE = G(1, 0, 1, 3, 0, 3, 2, 0);   // MIX with a21 = 1: A ties against Advance
  for (const [s, t, g] of [
    ['Against Advance, A earns more from Cooperate.', true], ['Against Advance, A earns more from Defect.', false],
    ['Against Retreat, Defect gives A a higher payoff.', true], ['Against Retreat, Cooperate gives A a higher payoff.', false],
    ['Against Advance, A does worse with Defect.', true], ['Against Advance, A does worse with Cooperate.', false],
    ['Against Retreat, Cooperate pays A less.', true], ['Against Retreat, Defect pays A less.', false],
    ['Against Advance, Defect is worse for A.', true], ['Against Advance, Cooperate is worse for A.', false],
    ['Against Retreat, Defect is more profitable for A.', true], ['Against Retreat, Cooperate is more profitable for A.', false],
    ['Against Retreat, Defect is less costly for A.', true], ['Against Retreat, Cooperate is less costly for A.', false],
    ['Against Advance, A does not prefer Defect.', true], ['Against Advance, A does not prefer Cooperate.', false],
    ['Against Retreat, Cooperate is not better for A.', true], ['Against Retreat, Defect is not better for A.', false],
    ['Against Advance, A never favors Defect.', true], ['Against Advance, A never favors Cooperate.', false],
    ['Against Retreat, A has no reason to choose Cooperate.', true], ['Against Retreat, A has no reason to choose Defect.', false],
    ['Against Advance, A gains nothing by switching to Defect.', true], ['Against Advance, A gains nothing by switching to Cooperate.', false],
    ['Against Advance, A does not lose by switching to Cooperate.', true], ['Against Retreat, A does not lose by switching to Cooperate.', false],
    ['Against Advance, neither Cooperate nor Defect is better for A.', true, TIE], ['Against Advance, neither Cooperate nor Defect is better for A.', false],
    // under a stated mix, and a bound held throughout
    ['If B plays Advance 90% of the time, A does worse with Defect.', true], ['If B plays Advance 90% of the time, A does worse with Cooperate.', false],
    ['If B plays Advance 50% of the time, A does not prefer Cooperate.', true], ['If B plays Advance 50% of the time, A does not prefer Defect.', false],
    ['If B plays Advance at least 80% of the time, A does not prefer Defect.', true], ['If B plays Advance at least 70% of the time, A does not prefer Cooperate.', false],
    // "gives B …" from A's option names B's payoff: no claim about A (read as A's, the first is false: 0 < 1)
    ['Against Advance, Defect gives B a better result.', true], ['Against Advance, Defect gives A a better result.', false],
    // the elided verb keeps its polarity; a contrast after a denial may flip it (not judged); a consequence is no ellipsis
    ['Against Retreat, A does worse with Cooperate, and with Defect against Advance.', true], ['Against Retreat, A does worse with Cooperate, and with Cooperate against Advance.', false],
    ['A does not favor Cooperate against Retreat, and Defect against Advance.', true], ['A does not favor Cooperate against Retreat, and Cooperate against Advance.', false],
    ['Against Retreat, A does not favor Cooperate, but Defect against Advance.', true], ['Against Retreat, A does not favor Cooperate, but Cooperate against Advance.', true],
    ['Against Advance A prefers Cooperate, but Defect against Retreat.', true], ['Against Advance A prefers Cooperate, but Cooperate against Retreat.', false],
  ] as [string, boolean, GamePayoffs?][]) check(`S20b ${t ? 'a true' : 'a false'} comparative or denied preference is judged`, (dir(s, g ?? MIX).length === 0) === t, `${s} :: ${dir(s, g ?? MIX).join(' | ')}`);
  // A consequence naming a (false) equilibrium is judged as one, never as an elliptical preference for its option.
  const EQI = /as an equilibrium/;
  for (const [s, t] of [['A prefers Cooperate against Advance, so the only equilibrium pairs Advance with Defect.', true], ['A prefers Defect against Advance, so the only equilibrium pairs Advance with Defect.', false]] as [string, boolean][])
    check(`S20b a consequence is no ellipsis (${t ? 'only' : 'not only'} the equilibrium issue)`, dir(s).some((i) => EQI.test(i)) && dir(s).every((i) => EQI.test(i)) === t, `${s} :: ${dir(s).join(' | ')}`);

  // S20b/c: real report sentences (verbatim; a twin changes one option). Each was misjudged before; payoffs worked by hand.
  const RR: [string, boolean, GamePayoffs, typeof L][] = [
    // B ties -7/-7 at Audit, so "prefers Waive Review to Audit" is false where the courier takes Express Route (reach-back frame)
    ['The courier does not favor Economy Route against Audit, but when the courier takes Express Route, the regulator prefers Waive Review to Audit; with Audit, the courier does not favor Express Route.', false, G(-1, -4, -1, -7, -7, -7, -9, 5), Lb('Express Route', 'Economy Route', 'Audit', 'Waive Review')],
    ['The courier does not favor Economy Route against Audit, but when the courier takes Economy Route, the regulator prefers Waive Review to Audit; with Audit, the courier does not favor Express Route.', true, G(-1, -4, -1, -7, -7, -7, -9, 5), Lb('Express Route', 'Economy Route', 'Audit', 'Waive Review')],
    ['The coordinator has no reason to favor Full Deployment: Standard Deployment gives it a higher payoff whether the dispatch uses Central Dispatch or Decentralized Dispatch.', true, G(-7, -4, 9, 8, 1, -9, -7, -5), Lb('Full Deployment', 'Standard Deployment', 'Central Dispatch', 'Decentralized Dispatch')],
    ['With the officer’s grant size fixed, the researcher does better with the Full Test than the Quick Test against the Large Grant, but with the Large Grant fixed, the researcher does better with the Quick Test.', false, G(-2, -1, -2, 7, 2, 2, 4, 6), Lb('Quick Test', 'Full Test', 'Basic Grant', 'Large Grant')],
    ['The regulator prefers Audit whether the manager chooses Inspect or Waive, while the manager gains nothing by switching to Inspect against Audit, so the two pure equilibria pair Audit with Waive and Audit with Inspect.', true, G(-2, 4, -2, -6, 7, 2, -7, -9), Lb('Inspect', 'Waive', 'Audit', 'Waive')],
    ['Once the manager chooses Automated, Skip gives the manager a better operational result than Inspect, so Automated with Skip is one equilibrium, while Automated with Inspect is another.', false, G(-1, -8, 5, -5, -2, 0, -6, -6), Lb('Manual', 'Automated', 'Inspect', 'Skip')],
    ['Courier B prefers West to East whether A chooses North or South, while courier A receives a higher score from South than from North when B chooses West.', false, G(-1, 6, 7, 6, 1, 3, 7, 9), Lb('North', 'South', 'East', 'West')],
    ['When A uses the Lean Fleet, B does not lose by switching to the Late Shift, so both equilibria pair A with B on the Early Shift.', false, G(6, -4, 6, 4, -6, -6, 5, -5), Lb('Standard Fleet', 'Lean Fleet', 'Early Shift', 'Late Shift')],
    // S20c: "South" alone is the South route (a12 = a22 = -7 is a tie); against North, Flexible pays 7 vs -6
    ['Once B chooses South, A does better with the Flexible plan.', false, G(-6, -7, 7, -7, -7, -5, -8, -3), Lb('Standard plan', 'Flexible plan', 'North route', 'South route')],
    ['Once B chooses North, A does better with the Flexible plan.', true, G(-6, -7, 7, -7, -7, -5, -8, -3), Lb('Standard plan', 'Flexible plan', 'North route', 'South route')],
    // the tie's own conjunct frames it: A ties -2/-2 at Closed and strictly prefers Deep (7 > 0) at Open
    ['A does better with Deep against Open and ties between its audits against Closed.', true, G(0, -2, 7, -2, 2, 2, -6, -6), Lb('Quick audit', 'Deep audit', 'Open review', 'Closed review')],
    ['A does better with Deep against Closed and ties between its audits against Open.', false, G(0, -2, 7, -2, 2, 2, -6, -6), Lb('Quick audit', 'Deep audit', 'Open review', 'Closed review')],
    // "whether Orion launches Bold or Cautiously" is both ways though only Bold resolves: Late ties -8/-8 against Cautious
    ['Nova does better with a Late response whether Orion launches Bold or Cautiously.', false, G(7, -6, -2, 4, -9, -5, -8, -8), Lb('Bold launch', 'Cautious launch', 'Early response', 'Late response')],
    ['Nova does better with a Late response whether Orion launches Bold or Cautiously.', true, G(7, -6, -2, 4, -9, -5, -8, -6), Lb('Bold launch', 'Cautious launch', 'Early response', 'Late response')],
    ['Nova does better with a Late response whether Orion launches Bold or not.', false, G(7, -6, -2, 4, -9, -5, -8, -8), Lb('Bold launch', 'Cautious launch', 'Early response', 'Late response')],
    // the equilibrium list after "so" is no elliptical claim (read as one, "Rush with Bold" says B prefers Bold at Rush: 7 = 7)
    ['For the studio, Rush and Quiet are equally attractive when the publisher chooses Bold, while Quiet is better against Cautious; for the publisher, Bold is better against Quiet, so the two pure equilibria are Quiet with Bold and Rush with Bold.', true, G(5, 4, 5, 5, 7, 7, 2, -8), Lb('Rush', 'Quiet', 'Bold', 'Cautious')],
  ];
  for (const [s, t, g, l] of RR) check(`S20 ${t ? 'a true' : 'a false'} real report sentence is judged`, (dir(s, g, l).length === 0) === t, `${s} :: ${dir(s, g, l).join(' | ')}`);
  // 7901: B's -7 > -8 at Detour is true; Detour–Split Hub is no equilibrium (A: -9 vs 2), flagged as that and only that.
  const s7901 = 'When A takes the Detour, B does better with Central Hub, so the Detour–Split Hub equilibrium is pinned to one plan rather than balanced.', d7901 = dir(s7901, G(-2, 2, -2, -9, 3, 3, -7, -8), Lb('Direct Route', 'Detour', 'Central Hub', 'Split Hub'));
  check('S20 a consequence is judged as an equilibrium only', d7901.length > 0 && d7901.every((i) => EQI.test(i)), `${s7901} :: ${d7901.join(' | ')}`);
  // The head alias is capitalised only ("heads south" is a direction) and off when the head occurs in another label
  // ("Stay South"): read as the South route, each of these would claim a -7/-7 tie as a preference.
  const RT = G(-6, -7, 7, -7, -7, -5, -8, -3);
  for (const [s, l] of [['Once B heads south, A does better with the Flexible plan.', Lb('Standard plan', 'Flexible plan', 'North route', 'South route')],
    ['Against Go North, A does better with South.', Lb('North route', 'South route', 'Stay South', 'Go North')]] as [string, typeof L][])
    check('S20c a head word that is a direction or another label is no alias', dir(s, RT, l).length === 0, `${s} :: ${dir(s, RT, l).join(' | ')}`);

  // S21: every other way to word a preference on MIX — would rather, best reply/response, the best P can do, switching to X,
  // avoid / never chooses, superior/inferior, leaves P better/worse off, doesn't give, incentive/reason to choose. Twins differ
  // in one option or frame, so only the vocabulary (and its polarity) decides; 41 of the 50 false twins passed before S21.
  for (const [s, t] of [
    ['Against Retreat, A would rather play Defect.', true], ['Against Retreat, A would rather play Cooperate.', false],
    ['Against Advance, A would much rather play Cooperate.', true], ['Against Retreat, A would much rather play Cooperate.', false],
    ['A would rather play Defect than Cooperate when B plays Retreat.', true], ['A would rather play Cooperate than Defect when B plays Retreat.', false],
    ['Against Advance, A would rather not play Defect.', true], ['Against Retreat, A would rather not play Defect.', false],
    ['Against Retreat, A would rather go with Defect.', true], ['Against Retreat, A would rather go with Cooperate.', false],
    ['A would rather Cooperate against Advance and Defect against Retreat.', true], ['A would rather Cooperate against Retreat and Defect against Advance.', false],
    ['A\'s best reply to Advance is Cooperate.', true], ['A\'s best reply to Advance is Defect.', false],
    ['B\'s best response to Defect is Advance.', true], ['B\'s best response to Defect is Retreat.', false],
    ['B\'s best reply to the Defect is Advance.', true], ['B\'s best reply to the Defect is Retreat.', false],
    ['A\'s best response to Retreat would be to play Defect.', true], ['A\'s best response to Retreat would be to play Cooperate.', false],
    ['B\'s best response to Defect is not Retreat.', true], ['B\'s best response to Defect is not Advance.', false],
    ['Defect is A\'s best reply to Retreat.', true], ['Defect is A\'s best reply to Advance.', false],
    ['Cooperate is not A\'s best reply to Retreat.', true], ['Cooperate is not A\'s best reply to Advance.', false],
    ['The best B can do against Cooperate is Retreat.', true], ['The best B can do against Cooperate is Advance.', false],
    ['Against Retreat, the best A can do is Defect.', true], ['Against Retreat, the best A can do is Cooperate.', false],
    ['Against Advance, A gains by switching to Cooperate.', true], ['Against Advance, A gains by switching to Defect.', false],
    ['Against Retreat, A benefits by switching to Defect.', true], ['Against Advance, A benefits by switching to Defect.', false],
    ['Against Retreat, A does better by switching to Defect.', true], ['Against Advance, A does better by switching to Defect.', false],
    ['Against Advance, A has an incentive to switch to Cooperate.', true], ['Against Advance, A has an incentive to switch to Defect.', false],
    ['Against Retreat, A would want to switch to Defect.', true], ['Against Retreat, A would want to switch to Cooperate.', false],
    ['Against Retreat, A is tempted to switch to Defect.', true], ['Against Retreat, A is tempted to switch to Cooperate.', false],
    ['Against Retreat, A would not switch to Cooperate.', true], ['Against Retreat, A would not switch to Defect.', false],
    ['At Cooperate with Retreat, A would switch to Defect.', true], ['At Cooperate with Advance, A would switch to Defect.', false],
    ['Against Retreat, A would move to Defect.', true], ['Against Retreat, A would move to Cooperate.', false],
    ['Against Retreat, switching to Defect helps A.', true], ['Against Retreat, switching to Cooperate helps A.', false],
    ['Against Retreat, switching to Cooperate hurts A.', true], ['Against Advance, switching to Cooperate hurts A.', false],
    ['Against Advance, switching to Defect does not help A.', true], ['Against Retreat, switching to Defect does not help A.', false],
    ['Against Advance, A should avoid Defect.', true], ['Against Advance, A should avoid Cooperate.', false],
    ['Against Advance, A avoids Defect.', true], ['Against Advance, A avoids Cooperate.', false],
    ['Against Retreat, A never plays Cooperate.', true], ['Against Retreat, A never plays Defect.', false],
    ['Against Retreat, A won\'t choose Cooperate.', true], ['Against Retreat, A won\'t choose Defect.', false],
    ['Against Cooperate, B does not choose Advance.', true], ['Against Cooperate, B does not choose Retreat.', false],
    ['Against Advance, Cooperate is superior for A.', true], ['Against Advance, Defect is superior for A.', false],
    ['Against Advance, Defect is inferior for A.', true], ['Against Advance, Cooperate is inferior for A.', false],
    ['Against Advance, Defect is not superior for A.', true], ['Against Retreat, Defect is not superior for A.', false],
    ['Against Retreat, Cooperate is the worse option for A.', true], ['Against Retreat, Defect is the worse option for A.', false],
    ['When A plays Defect, Retreat leaves B worse off.', true], ['When A plays Defect, Advance leaves B worse off.', false],
    ['Against Advance, Cooperate leaves A better off.', true], ['Against Retreat, Cooperate leaves A better off.', false],
    ['Against Retreat, Cooperate does not leave A better off.', true], ['Against Advance, Cooperate does not leave A better off.', false],
    ['Against Advance, Defect does not give A a higher payoff.', true], ['Against Retreat, Defect does not give A a higher payoff.', false],
    ['Against Retreat, Cooperate does not pay A more.', true], ['Against Advance, Cooperate does not pay A more.', false],
    ['Against Advance, A has an incentive to choose Cooperate.', true], ['Against Advance, A has an incentive to choose Defect.', false],
    ['Against Advance, A has every reason to choose Cooperate.', true], ['Against Retreat, A has every reason to choose Cooperate.', false],
    // a wish about the OTHER player's move, or a non-payoff "leaves", is no preference claim (each read as one is false)
    ['When A plays Cooperate, A would rather face Advance.', true], ['When A plays Cooperate, A would rather see Advance.', true],
    ['Against Retreat, A would rather B choose Advance.', true], ['When A plays Cooperate, A prefers Advance.', true],
    ['When B plays Advance, B gains by switching to Defect.', true], ['When A plays Cooperate, A should avoid Retreat.', true],
    ['When A plays Cooperate, A never chooses Retreat.', true], ['Against Retreat, Cooperate leaves A more exposed.', true],
    ['Against Retreat, switching to Defect helps B.', true], ['A plays Cooperate to avoid Defect\'s zero against Advance.', true],
    ['Against Retreat, switching to Cooperate helps B.', true], ['When A plays Cooperate, the attacker would rather face Advance.', true],
    ['The firm’s best reply to Retreat is Defect.', true], ['The firm’s best reply to Retreat is Cooperate.', false],
  ] as [string, boolean][]) check(`S21 ${t ? 'a true' : 'a false'} preference in other words is judged`, (dir(s).length === 0) === t, `${s} :: ${dir(s).join(' | ')}`);
  // "would rather not X" names X the worse option (a strict claim), so on TIE (A: 1 = 1 against Advance) it is false;
  // read as a mere denial it would pass there.
  for (const [s, t] of [['Against Advance, A would rather not play Defect.', false], ['Against Retreat, A would rather not play Cooperate.', true]] as [string, boolean][])
    check(`S21 ${t ? 'a true' : 'a false'} "rather not" on a tie is judged`, (dir(s, TIE).length === 0) === t, `${s} :: ${dir(s, TIE).join(' | ')}`);
  // S21: real report sentences (verbatim), each passed before S21. Worked by hand: B ties -1/-1 against the North Route;
  // B ties 7/7 and A ties 5/5 against the first option; B ties -2/-2 against Standard.
  for (const [s, t, g, l] of [
    ['B, however, gains by switching to the South Depot whether A takes the North or South Route.', false, G(8, -9, -7, -9, -1, -1, 5, 6), Lb('North Route', 'South Route', 'North Depot', 'South Depot')],
    ['B, however, gains by switching to the South Depot whether A takes the North or South Route.', true, G(8, -9, -7, -9, -1, 0, 5, 6), Lb('North Route', 'South Route', 'North Depot', 'South Depot')],
    ['At either equilibrium, A’s payoffs are 5, while B’s are 2 or 7; B would rather Integrate than Stay Separate when A pilots, but A would rather Full Rollout than Pilot when B integrates.', false, G(5, 4, 5, 5, 7, 7, 2, -8), Lb('Pilot', 'Full Rollout', 'Integrate', 'Stay Separate')],
    ['Against Support, Standard does better for the studio than Rapid, while against Rapid the distributor does better with Support than Cut support; Support is thus the distributor’s best response to Standard, so it pins the equilibrium rather than balancing either player.', false, G(-7, 3, -8, 4, -2, -2, 9, -4), Lb('Standard', 'Rapid', 'Support', 'Cut support')],
    ['B\'s best response to Open Plaza is Evening Shift, but A\'s dominant choice eliminates that balancing scenario.', true, G(7, -4, -9, -9, -9, -7, 2, -9), Lb('Open Plaza', 'Private Tent', 'Morning Shift', 'Evening Shift')],
  ] as [string, boolean, GamePayoffs, typeof L][]) check(`S21 ${t ? 'a true' : 'a false'} real report sentence is judged`, (dir(s, g, l).length === 0) === t, `${s} :: ${dir(s, g, l).join(' | ')}`);

  // S22: still more wordings on MIX — leading adverbs, its/their/the best reply, does/is better off with, sticks with, leans toward,
  // answers X with, payoff rises/falls if it switches, pays off, nothing to gain, because-it, "X, which …" / "X: it …", a contrast
  // parenthetical, and RECIPIENT claims ("Defect is better for B" is B's payoff across A's options). Every false twin passed before S22.
  const S22: [string, boolean][] = [
    ['Against Advance, it would rather play Cooperate.', true], ['Against Advance, it would rather play Defect.', false],
    ['Against Advance, A would rather play Cooperate, and against Retreat, Defect.', true], ['Against Advance, A would rather play Defect, and against Retreat, Cooperate.', false],
    ['A would rather play Cooperate against Advance and Defect against Retreat.', true], ['A would rather play Defect against Advance and Cooperate against Retreat.', false],
    ['A would rather play Cooperate against Advance and Cooperate against Retreat.', false], ['B would rather play Retreat against Cooperate but Advance against Defect.', true],
    ['B would rather play Advance against Cooperate but Retreat against Defect.', false], ['If B plays Advance 50% of the time, A\'s best reply is Defect.', true],
    ['If B plays Advance 90% of the time, A\'s best reply is Defect.', false], ['Switching to Defect helps A against Retreat.', true],
    ['Switching to Defect helps A against Advance.', false], ['Against Advance, switching to Defect would hurt A.', true],
    ['Against Retreat, switching to Defect would hurt A.', false], ['A avoids Cooperate against Retreat.', true],
    ['A avoids Cooperate against Advance.', false], ['A would never choose Defect when B plays Advance.', true],
    ['A would never choose Defect when B plays Retreat.', false], ['Its best reply to Advance is Cooperate.', true],
    ['Its best reply to Advance is Defect.', false], ['Their best response to Retreat is Cooperate.', false],
    ['The best reply to Advance is Defect.', false], ['A\'s best reply against Retreat is to play Cooperate.', false],
    ['A\'s best response, against Advance, is Defect.', false], ['The best A can do against Advance is Defect.', false],
    ['Best for A against Advance is Defect.', false], ['A does best with Defect against Advance.', false],
    ['Defect is superior to Cooperate for A against Advance.', false], ['Cooperate is superior to Defect for A against Advance.', true],
    ['Against Advance, Defect leaves A worse off than Cooperate.', true], ['Against Advance, Cooperate leaves A worse off than Defect.', false],
    ['Against Retreat, Defect leaves A better off.', true], ['Against Advance, Defect leaves A better off.', false],
    ['A gains nothing by switching to Defect against Advance.', true], ['A gains nothing by switching to Defect against Retreat.', false],
    ['A has nothing to gain by switching to Defect against Retreat.', false], ['A has nothing to gain by switching to Defect against Advance.', true],
    ['A would gain from switching to Defect against Advance.', false], ['A would gain from switching to Defect against Retreat.', true],
    ['There is no reason for A to choose Defect against Advance.', true], ['There is no reason for A to choose Defect against Retreat.', false],
    ['A has an incentive to deviate to Defect against Advance.', false], ['Deviating to Defect pays off for A against Retreat.', true],
    ['Deviating to Defect pays off for A against Advance.', false], ['A is better off playing Defect against Advance.', false],
    ['A would be better off with Defect against Advance.', false], ['A\'s better option against Advance is Defect.', false],
    ['A\'s preferred reply to Advance is Defect.', false], ['A\'s preferred reply to Advance is Cooperate.', true],
    ['A\'s optimal reply to Advance is Defect.', false], ['Defect is A\'s optimal choice against Advance.', false],
    ['Defect is the optimal response for A against Advance.', false], ['A loses by switching to Defect against Advance.', true],
    ['A loses by switching to Defect against Retreat.', false], ['Switching to Defect costs A against Advance.', true],
    ['Switching to Defect costs A against Retreat.', false], ['Moving to Defect against Advance would cost A a point.', true],
    ['Moving to Defect against Retreat would cost A a point.', false], ['A\'s payoff rises if it switches to Defect against Advance.', false],
    ['A\'s payoff rises if it switches to Defect against Retreat.', true], ['A\'s payoff falls if it switches to Defect against Retreat.', false],
    ['A\'s payoff falls if it switches to Defect against Advance.', true], ['Against Advance, A\'s best bet is Defect.', false],
    ['Against Advance, A\'s best bet is Cooperate.', true], ['Defect is A\'s best bet against Advance.', false],
    ['A should stick with Defect against Advance.', false], ['A should stick with Cooperate against Advance.', true],
    ['A should go with Defect against Advance.', false], ['A is better served by Defect against Advance.', false],
    ['A is better served by Cooperate against Advance.', true], ['Defect serves A better against Advance.', false],
    ['Cooperate serves A better against Advance.', true], ['A comes out ahead with Defect against Advance.', false],
    ['A comes out ahead with Cooperate against Advance.', true], ['A comes out behind with Cooperate against Advance.', false],
    ['Defect is the smarter choice for A against Advance.', false], ['Defect is the wiser move for A against Advance.', false],
    ['Defect is the stronger option for A against Advance.', false], ['Cooperate is the stronger option for A against Advance.', true],
    ['Cooperate is the weaker option for A against Advance.', false], ['A is better off sticking with Defect against Advance.', false],
    ['A does better sticking with Defect against Advance.', false], ['A does better playing Defect against Advance.', false],
    ['A does better playing Cooperate against Advance.', true], ['A is better served playing Defect against Advance.', false],
    ['A should play Defect, not Cooperate, against Advance.', false], ['A should play Cooperate, not Defect, against Advance.', true],
    ['A should not play Cooperate against Advance.', false], ['A should not play Defect against Advance.', true],
    ['A has every incentive to play Defect against Advance.', false], ['A has a strict incentive to choose Defect against Advance.', false],
    ['A is drawn to Defect against Advance.', false], ['Defect dominates for A against Advance.', false],
    ['Against Advance, Defect is the way to go for A.', false], ['A will choose Defect if B plays Advance, since it pays more.', false],
    ['A goes for Defect against Advance.', false], ['A leans toward Defect against Advance.', false],
    ['A picks Defect against Advance because it pays more.', false], ['Against Advance, A is pushed toward Defect.', false],
    ['A gravitates to Defect against Advance.', false], ['Against Advance, A responds with Defect.', false],
    ['Against Advance, A responds with Cooperate.', true], ['A responds to Advance with Defect.', false],
    ['A responds to Advance with Cooperate.', true], ['A\'s reply to Advance is Defect.', false],
    ['A answers Advance with Defect.', false], ['A counters Advance with Defect.', false],
    ['A counters Advance with Cooperate.', true], ['A meets Advance with Defect.', false],
    ['Against Advance, A\'s payoff is higher under Defect.', false], ['Against Advance, A\'s payoff is higher under Cooperate.', true],
    ['A\'s payoff is higher with Defect against Advance.', false], ['A earns more with Defect against Advance.', false],
    ['A ends up better off with Defect against Advance.', false], ['A is happier with Defect against Advance.', false],
    ['A is happier with Cooperate against Advance.', true], ['A is worse off with Cooperate against Advance.', false],
    ['Defect beats Cooperate for A against Advance.', false], ['Defect outscores Cooperate for A against Advance.', false],
    ['Defect outperforms Cooperate for A against Advance.', false], ['Defect does better than Cooperate for A against Advance.', false],
    ['Cooperate does better than Defect for A against Advance.', true], ['Against Advance, Defect is better for B.', true],
    ['Against Advance, Defect is the better outcome for B.', true], ['Against Retreat, Cooperate is better for B.', true],
    ['Against Advance, Defect gives B a higher payoff.', true], ['When A plays Defect, Advance is better for A.', false],
    ['Advance is better for A than Retreat when A plays Defect.', false], ['Against Retreat, Cooperate is worse for B.', false],
    ['Against Advance, Defect is better for A.', false], ['Against Advance, Cooperate is better for A.', true],
    ['Against Advance, Defect is A\'s worst option.', true], ['Against Advance, Cooperate is A\'s worst option.', false],
    ['If A switches to Defect against Advance, its payoff falls.', true], ['If A switches to Defect against Retreat, its payoff falls.', false],
    ['If A switches to Defect against Retreat, its payoff rises.', true], ['If A switches to Defect against Advance, its payoff rises.', false],
    ['Defect is always better for A.', false], ['Defect always does better for A.', false],
    ['Defect is better for A regardless.', false], ['For A, Defect always does better.', false],
    ['Defect likewise does better for A whether B chooses Advance or Retreat.', false], ['Defect is better for A no matter what B does.', false],
    ['A always does better with Defect.', false], ['A always prefers Defect.', false],
    ['Defect is A\'s dominant strategy: it does better whether B chooses Advance or Retreat.', false], ['A weighs Cooperate against Defect: it does better with Defect against Advance.', false],
    ['Defect, which is better against Advance, is A\'s choice.', false], ['A trades off Defect, which does better against Advance, against Cooperate, which does better against Retreat.', false],
    ['A trades off Cooperate, which does better against Advance, against Defect, which does better against Retreat.', true], ['A does better at Defect against Advance.', false],
    ['A does better by Defect than Cooperate against Advance.', false], ['When A plays Defect, Retreat is better for A.', true],
    ['When A plays Cooperate, Advance is better for A.', true], ['Against Advance, Cooperate is better for B.', false],
    ['Against Retreat, Defect is better for B.', false], ['Defect gives B more against Advance.', true],
    ['Cooperate gives B more against Advance.', false], ['Defect is better for B whether A plays Cooperate or Defect.', false],
    ['Retreat is better for A than Advance when A plays Defect.', true], ['Retreat is better for A than Advance whether A plays Defect or Cooperate.', false],
    ['Defect is better for B than Cooperate against Advance.', true], ['Defect pays B 2 rather than 0 against Advance.', true],
    ['Defect pays B 0 rather than 2 against Advance.', false], ['Cooperate pays B 2 rather than 0 against Advance.', false],
    ['Defect pays B 2 rather than 0 against Retreat.', false], ['Cooperate pays A 0 rather than 3 against Retreat.', true],
    ['Cooperate pays A 3 rather than 0 against Retreat.', false], ['Defect pays A 0 rather than 1 against Advance.', true],
    ['Defect pays A 0 rather than 1 against Retreat.', false], ['Defect pays A 3 rather than 0 against Retreat.', true],
    ['Defect pays A 3 rather than 0 against Advance.', false], ['Against Retreat, Defect gives A 3 rather than 0.', true],
    ['Against Advance, Defect gives A 3 rather than 0.', false], ['A plays Cooperate, which pays B 3 rather than 0 against Retreat.', true],
    ['A plays Cooperate, which pays B 0 rather than 3 against Retreat.', false],
    // S22 (sweep 22 second pass): a frame-first ellipsis cut by its own comma, one rejoined after ";", a recipient's
    // ellipsis, an opening "whether … or …," frame; plus facing/also-fares/would-choose wordings.
    ['Against Advance, A prefers Cooperate, and against Retreat, Defect.', true], ['Against Advance, A prefers Cooperate, and against Retreat, Cooperate.', false],
    ['Against Retreat, A prefers Defect, but when B plays Advance, Cooperate.', true], ['Against Retreat, A prefers Defect, but when B plays Advance, Defect.', false],
    ['A prefers Defect against Retreat; against Advance, Cooperate.', true], ['A prefers Defect against Retreat; against Advance, Defect.', false],
    ['A prefers Defect against Retreat; Cooperate against Advance.', true], ['A prefers Defect against Retreat; Defect against Advance.', false],
    ['Against Advance, Defect is better for B, and against Retreat, Cooperate.', true], ['Against Advance, Defect is better for B, and against Retreat, Defect.', false],
    ['Whether B plays Advance or Retreat, A prefers Defect.', false], ['Whether B plays Advance or Retreat, A prefers Cooperate.', false],
    ['A prefers Defect against Retreat, and whether B plays Advance or Retreat, Cooperate.', false],
    ['Whether B plays Advance or not, A prefers Cooperate.', false], ['Whether B plays Retreat or not, A prefers Defect.', false],
    ['Cooperate does better facing Advance.', true], ['Defect does better facing Advance.', false],
    ['Against Advance, Defect also fares worse for A.', true], ['Against Retreat, Defect also fares worse for A.', false],
    ['Against Advance, A would choose Cooperate.', true], ['Against Advance, A would choose Defect.', false],
    ['Defect is better for B when A plays Defect.', false], ['Cooperate is better for B when A plays Defect.', false],
  ];
  for (const [s, t] of S22) check(`S22 ${t ? 'a true' : 'a false'} preference in other words is judged`, (dir(s).length === 0) === t, `${s} :: ${dir(s).join(' | ')}`);
  // Swap metamorphic: MIX has no tie for A, so exchanging A's two labels flips the truth of every claim that names one
  // of them (strict, denial or recipient); a sentence that passes both ways was read as no claim on that label.
  const swapA = (s: string) => s.replace(/Cooperate|Defect/g, (m) => (m === 'Cooperate' ? 'Defect' : 'Cooperate'));
  const blind = S22.filter(([s]) => swapA(s) !== s && dir(s).length === 0 && dir(swapA(s)).length === 0);   // HEAD: 94 of 177 blind
  check('S22 no planted A claim passes with its labels swapped', blind.length === 0, blind.map(([s]) => s).join(' || '));
  // S22: real report sentences (verbatim). Worked by hand: Hold Steady pays A 0 vs 4/6; "B does better by Waive" ties -9/-9;
  // Isolate / Side stage are A's options credited to B and framed by A's choice; Ridge/Valley and Full proposal are true.
  for (const [s, t, g, l] of [
    ['A’s preferred choice is Hold Steady whether B Promotes or Stays Quiet, while B is indifferent between Promote and Stay Quiet against either of A’s choices.', false, G(0, 0, 4, 6, 5, 5, 2, 2), Lb('Hold Steady', 'Expand', 'Promote', 'Stay Quiet')],
    ['When A chooses Steady, B does better by Waive than Inspect.', false, G(-1, -8, 2, -4, -2, 6, -9, -9), Lb('Rush', 'Steady', 'Inspect', 'Waive')],
    ['Isolate is better for B whether A patches immediately or isolates, so B has a dominant strategy and cannot balance probing against the two A options.', false, G(-8, 4, 1, -3, 4, -3, 4, -7), Lb('Patch Now', 'Isolate', 'Probe', 'Flood')],
    ['Side stage is better for B whether A chooses Main stage or Side stage, so B has a dominant strategy.', false, G(5, 2, -5, 6, 0, 7, -6, 1), Lb('Main stage', 'Side stage', 'Day slot', 'Night slot')],
    ['Hold off is B’s dominant choice: it does better whether A makes a Bold pitch or a Cautious pitch, receiving 9 rather than 8 from the Bold pitch or -3 rather than -6 from the Cautious pitch.', false, G(4, -4, -7, 0, 9, 8, -3, -6), Lb('Bold pitch', 'Cautious pitch', 'Back now', 'Hold off')],
    ['The vendor always does better with a Stable Release than a Rapid Release: it is better whether the distributor chooses a Marketing Push or holds back.', true, G(-4, -4, 7, -1, 5, 4, 9, -8), Lb('Rapid Release', 'Stable Release', 'Marketing Push', 'Hold Back')],
    ['The regulator likewise trades off inspection against waiving review: it is better against Aggressive, while waiving review is better against Careful.', true, G(-6, 8, 7, -1, 6, 2, -3, 9), Lb('Aggressive launch', 'Careful launch', 'Inspect', 'Waive review')],
    ['When B takes South, Ridge gives A 9 rather than -5, while against Ridge, South gives B -4 rather than -5; at the other corner, against Valley, North gives B 1 rather than -6, and A gains nothing by switching from Valley to Ridge because either pays -4 against North.', true, G(-4, 9, -4, -5, -5, -4, 1, -6), Lb('Ridge', 'Valley', 'North', 'South')],
    ['The contractor’s Full proposal is better whether the regulator Inspects or Waives, and the regulator’s Inspect option is better whether the contractor submits a Full proposal or a Pilot.', true, G(9, -5, -1, -7, 6, -2, 1, -6), Lb('Full proposal', 'Pilot', 'Inspect', 'Waive')],
    // Sweep 22b: the comma rewind must not swallow a clause that goes on past the label (South Route ties at -9).
    ['A’s tradeoff is that Express does better against North Route than Economy, but against South Route, Express and Economy give A the same payoff.', true, G(8, -9, 1, -9, -4, 9, -6, 9), Lb('Express', 'Economy', 'North Route', 'South Route')],
    ['Express does better against North Route, but against South Route, Economy.', false, G(8, -9, 1, -9, -4, 9, -6, 9), Lb('Express', 'Economy', 'North Route', 'South Route')],
    // Planted on a game with a dominant option (Cooperate 3>0, 1>0; B: Open gate -7>-8, 8>-8): the twin of each MIX row above.
    ['Whether B plays Advance or Retreat, A prefers Cooperate.', true, G(3, 1, 0, 0, 0, 2, 1, 2), L],
    ['Whether B plays Advance or not, A prefers Cooperate.', true, G(3, 1, 0, 0, 0, 2, 1, 2), L],
    ['A prefers Cooperate against Retreat, and, whether B plays Advance or Retreat, Cooperate.', true, G(3, 1, 0, 0, 0, 2, 1, 2), L],
    ['Open gate is the gatekeeper’s dominant strategy.', true, G(-8, 0, 8, -8, -7, -8, 8, -8), Lb('Wait', 'Enter', 'Open gate', 'Keep closed')],
    ['Keep closed is the gatekeeper’s dominant strategy.', false, G(-8, 0, 8, -8, -7, -8, 8, -8), Lb('Wait', 'Enter', 'Open gate', 'Keep closed')],
  ] as [string, boolean, GamePayoffs, typeof L][]) check(`S22 ${t ? 'a true' : 'a false'} real report sentence is judged`, (dir(s, g, l).length === 0) === t, `${s} :: ${dir(s, g, l).join(' | ')}`);
  // S23: 731 twins (ellipses, frame-interposed labels, "it pays N" after a frame, ", earning N rather than M [from Q]",
  // complement frames) in src/fixtures/mathvalidator-s23.txt; its header records how the twins are built. HEAD missed 253.
  // S24: +235 twins (complement frames for every judge, avoidance-verb own claims, ", since it pays N rather than M").
  // S25: +1090 twins (complement parity, exceptive heads, asides, appositive heads, "X, not Y,", dominance nouns, hedges/modals).
  // S26a: +143 twins (degree/hedge words before a comparative, denying degree words, inverted "Never is X better", hedge asides).
  // S26b: +44 twins (an unframed strict claim is false only when strictly false against every opponent option).
  // S26j: +50 twins (labelless and mix-induced indifference; "@ G a11,a12,a21,a22,b11,b12,b21,b22" sets any game).
  // S27a: +25 twins (a claim stating its own mix is the probability judges'; "A should play X 40%…" is a claim, not a frame).
  const DOM23 = G(1, 0, 3, 2, 0, 3, 1, 2);
  let g23 = MIX;
  for (const ln of readFileSync('src/fixtures/mathvalidator-s23.txt', 'utf8').split('\n')) {
    if (ln.startsWith('@ G ')) g23 = G(...(ln.slice(4).split(',').map(Number) as [number, number, number, number, number, number, number, number]));
    else if (ln.startsWith('@ ')) g23 = ln === '@ DOM' ? DOM23 : MIX;
    else if (/^[TF]\t/.test(ln)) check(`S23 ${ln[0] === 'T' ? 'a true' : 'a false'} twin is judged`, (dir(ln.slice(2), g23).length === 0) === (ln[0] === 'T'), `${ln} :: ${dir(ln.slice(2), g23).join(' | ')}`);
  }
  // S23: real report sentences (verbatim). Worked by hand: Economy vs Late pays 5 vs -9; the Light Review figures are the Full
  // Audit column's; Rival app vs Build plugin pays 9 vs -2; Plan West ties 4/4; Inland vs Night pays 8 vs -6. The rest are true.
  for (const [s, t, g, l] of [
    ['Intensive Review is better for the auditor whether the firm chooses Full or Minimal Disclosure: against Full it pays -2 rather than -9, and against Minimal it pays 5 rather than 2.', true, G(-2, 5, -9, 2, 9, 6, 4, 9), Lb('Intensive Review', 'Light Review', 'Full Disclosure', 'Minimal Disclosure')],
    ['The distributor always does better with Express than with Standard: Express does better against Brief and against Detailed.', true, G(-8, -7, -8, -7, 5, 8, -4, 1), Lb('Brief', 'Detailed', 'Standard', 'Express')],
    ['There is no pure equilibrium: against a Long contract, the port prefers Maintain, earning 5 rather than 1, but against the Spot market it prefers Expand, earning -5 rather than -6.', true, G(1, -5, 5, -6, 6, 3, -5, 8), Lb('Expand', 'Maintain', 'Long contract', 'Spot market')],
    ['Birch has a dominant option: Flexible beats Tight whether Aster chooses Bold or Steady, receiving 8 rather than -9 for Bold or -5 rather than -7 for Steady.', true, G(-9, 7, -6, -6, -9, 8, -7, -5), Lb('Bold', 'Steady', 'Tight', 'Flexible')],
    ['Against Late Dispatch, A prefers Economy, receiving 5 rather than 1 from Express, while B prefers Late Dispatch against Economy, receiving 7 rather than -2 from Early Dispatch.', false, G(1, -9, 1, 5, 8, 8, -2, 7), Lb('Express', 'Economy', 'Early Dispatch', 'Late Dispatch')],
    ['Against a Minor Audit, the inspector does better with a Light Review, earning 0 rather than -7; against a Full Audit, the inspector gets 0 from either review.', false, G(-8, 0, -2, 8, -6, -7, 0, 0), Lb('Minor Audit', 'Full Audit', 'Light Review', 'Full Review')],
    ['Once A chooses Closed suite, B does better with Rival app, earning 9 rather than 0 from Build plugin, so the sole equilibrium has A choose Closed suite and B choose Rival app.', false, G(9, 2, 0, 9, 0, 2, -2, 9), Lb('Open platform', 'Closed suite', 'Build plugin', 'Rival app')],
    ['Once A commits to Full Rollout, Plan West does better for B than Plan East, so there are two equilibrium plans.', false, G(-1, -2, 4, 6, -3, 4, 4, 4), Lb('Pilot Program', 'Full Rollout', 'Plan East', 'Plan West')],
    ['Against the Night crew, the dispatcher prefers the Inland route, earning 8 rather than 7; against the Inland route, the manager prefers the Day crew, earning 3 rather than -5.', false, G(7, -6, 7, 8, -8, -8, 3, -5), Lb('Coastal route', 'Inland route', 'Day crew', 'Night crew')],
    // HEAD flagged these two true ones (the "than" object read as the weld's subject): Aggressive 4>2, 1>-3; Central 4>-2, 3>-8.
    ['The project lead always does better with the Aggressive Plan than the Conservative Plan: it pays 4 rather than 2 under Strict Review and 1 rather than -3 under Light Review.', true, G(4, 1, 2, -3, -9, -8, 1, -9), Lb('Aggressive Plan', 'Conservative Plan', 'Strict Review', 'Light Review')],
    ['Firm B likewise does better with Central than Riverside, receiving 4 rather than -2 against Standard and 3 rather than -8 against Express.', true, G(8, -4, 9, 1, 4, -2, 3, -8), Lb('Standard', 'Express', 'Central', 'Riverside')],
    // Bare pairs after a frame label: true as written; its column-swapped twin (not real) passed at HEAD.
    ['A’s operational tradeoff is one-sided: Express beats Economy at East Hub, 4 rather than -2, and at West Hub, 1 rather than -3, so Express is dominant.', true, G(4, 1, -2, -3, -5, 9, 6, 1), Lb('Express', 'Economy', 'East Hub', 'West Hub')],
    ['A’s operational tradeoff is one-sided: Express beats Economy at East Hub, 1 rather than -3, and at West Hub, 4 rather than -2, so Express is dominant.', false, G(4, 1, -2, -3, -5, 9, 6, 1), Lb('Express', 'Economy', 'East Hub', 'West Hub')],
    // A label named "Avoid" is no complement: the first (real, true) was flagged by the S23 complement arm before labels were
    // blanked. Avoid vs Enter: -2 > -7 against Visible patrol; Enter vs Avoid: 2 > -1 against Plainclothes security.
    ...([
      ['The museum is indifferent between Visible patrol and Plainclothes security whether the thief chooses Enter or Avoid, while the thief prefers Avoid against Visible patrol and Enter against Plainclothes security.', true],
      ['The thief prefers Enter against Visible patrol and Avoid against Plainclothes security.', false],
      ['B prefers Avoid unless A plays Plainclothes security.', true], ['B prefers Enter unless A plays Plainclothes security.', false],
      ['B prefers Avoid against anything other than Plainclothes security.', true], ['B prefers Enter against anything other than Plainclothes security.', false],
      ['Apart from that, B prefers Avoid against Visible patrol.', true], ['Apart from that, B prefers Enter against Visible patrol.', false],
    ] as [string, boolean][]).map(([s, t]) => [s, t, G(-1, 0, -1, 0, -7, -2, 2, -1), Lb('Visible patrol', 'Plainclothes security', 'Enter', 'Avoid')]),
    // S26b: an unframed claim is judged across both columns. Convoy pays the officer 4 vs 7 and -5 vs 7 (false); the rest tie in
    // one or both columns ("pinned to X" at an equilibrium) or win one (bold launch), so a non-strict reading would flag them.
    ['Geometrically, A’s warped payoff surface has a level shelf when the officer assigns probability 0.1429 to Airlift, but there is no interior joint flat spot: the equilibrium lies on the edge because the officer is pinned to Convoy.', false, G(-9, -3, 3, -5, 7, 4, 7, -5), Lb('Direct Route', 'Detour', 'Airlift', 'Convoy')],
    ['The firm’s choice is pinned to Economy by the other firm’s network; if Firm B chooses Direct, Firm A does better with Express, while Firm B does better with Hub against Economy.', true, G(9, -4, 9, -7, 4, -1, -5, -9), Lb('Express', 'Economy', 'Hub', 'Direct')],
    ['Geometrically, A’s payoff surface is a flat plane with no level shelf, so there is no interior joint flat spot; the equilibrium lies on the edge at the corner where A is pinned to Indoor.', true, G(1, 8, 1, 8, -2, 2, 9, -5), Lb('Indoor', 'Outdoor', 'Full Crew', 'Lean Crew')],
    ['At Indoor–Day, Indoor is A’s better response to Day and Day is B’s better response to Indoor; at Outdoor–Night, Night is B’s better response to Outdoor, while A gains nothing by switching to Indoor.', true, G(0, 9, -6, 9, 4, -6, -2, 3), Lb('Indoor', 'Outdoor', 'Day', 'Night')],
    ['There is no payoff tradeoff here: neither applicant needs to favor Online filing over Paper filing, nor does the clerk need to favor Automated review over Manual review.', true, G(-2, -2, -2, -2, -3, -3, -3, -3), Lb('Online filing', 'Paper filing', 'Automated review', 'Manual review')],
    ['The product manager prefers a bold launch whether the auditor conducts a full or light review, while the auditor prefers a full review whether the manager chooses a bold or cautious launch.', true, G(1, 8, -3, 7, -4, -9, -4, -8), Lb('Bold launch', 'Cautious launch', 'Full review', 'Light review')],
  ] as [string, boolean, GamePayoffs, typeof L][]) check(`S23 ${t ? 'a true' : 'a false'} real report sentence is judged`, (dir(s, g, l).length === 0) === t, `${s} :: ${dir(s, g, l).join(' | ')}`);
  // S26: verbatim real report sentences with their twins (src/fixtures/mathvalidator-s26-real.tsv; its header has the sources).
  for (const ln of readFileSync('src/fixtures/mathvalidator-s26-real.tsv', 'utf8').split('\n')) {
    const [v, gj, lj, s] = ln.split('\t');
    if (!/^[TF]$/.test(v) || !s) continue;
    const [row1, row2, col1, col2] = JSON.parse(lj) as string[], is = dir(s, commitPayoffs(JSON.parse(gj)), { ...L, row1, row2, col1, col2 });
    check(`S26 ${v === 'T' ? 'a true' : 'a false'} real sentence or twin is judged`, (is.length === 0) === (v === 'T'), `${s} :: ${is.join(' | ')}`);
  }
}

// ── Fuzz: good output must validate, false claims must not (oracle, four scales, fixed seeds) ─────────────
const rnd = seededRandom(0x5715), rnd6 = seededRandom(0x5716), rnd7 = seededRandom(0x5717);   // F6/F7 draw apart: earlier fuzz stays as measured
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const reach = { nearCorner: 0, subMix: 0, partialTie: 0, pctTrue: 0, pctFalse: 0, rendered: 0, qualified: 0, decimal: 0 };
for (const [sc, V] of Object.entries(SC)) for (let i = 0; i < 4000; i++) {
  const g = commitPayoffs({ a11: pick(V), a12: pick(V), a21: pick(V), a22: pick(V), b11: pick(V), b12: pick(V), b21: pick(V), b22: pick(V) });
  const o = oracle(g), all = computeAllNE(g), comps = continuumComponents(g), deg = hasEquilibriumContinuum(g);
  const tag = `${sc} ${JSON.stringify(g)} ne ${JSON.stringify(o.ne)}`;
  // F1 validateReport on the solver's own truth, echoed as the payload reads (exact, r3, or 0.999|1 / 0.001|0).
  const strays = all.filter((t) => !comps.some((r) => pointInRect(r, t.x, t.y)));
  const echo = (v: number) => { const s = Math.round(v * 1000) / 1000; return s === 1 && v !== 1 ? pick([0.999, 1]) : s === 0 && v !== 0 ? pick([0.001, 0]) : pick([v, s]); };
  const claims = [...comps.map((r) => ({ type: 'continuum', x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 })), ...strays.map((t) => ({ type: t.type, x: echo(t.x), y: echo(t.y) }))].sort(() => rnd() - 0.5);
  if (strays.some((m) => m.type === 'mixed' && strays.some((p) => p.type === 'pure' && Math.abs(p.x - m.x) <= 0.0015 && Math.abs(p.y - m.y) <= 0.0015))) reach.nearCorner++;
  const vr = validateReport({ claimedEquilibria: claims, prose: '' } as never, g);
  check('F1 a report echoing the solver truth validates', vr.ok, `${tag} ${JSON.stringify(claims)} :: ${vr.checks.filter((c) => /FAIL/.test(c)).join(' | ')}`);
  // F2 equilibriumActions, F3 "with probability 0/1", F4 percents — both directions against the oracle.
  if (deg && !comps.every((r) => r.x0 === 0 && r.x1 === 1 && r.y0 === 0 && r.y1 === 1)) reach.partialTie++;
  for (const P of ['A', 'B'] as const) for (const opt of [1, 2] as const) {
    const { ps, within } = optionView(o, P, opt), X = NM[P + opt], t = `${P}${opt} ${tag}`;
    if (ps.some((p) => p > 0 && p < 1e-3)) reach.subMix++;
    const played = ps.some((p) => p > 0);
    check('F2 equilibriumActions agrees with the oracle', played === validateProseClaims({ equilibriumActions: [{ player: P, option: opt }], bestReplies: [] }, '', g, all, deg).ok, t);
    for (const [v, words] of [[0, 'with probability 0'], [1, 'with probability 1'], [0, '0% of the time'], [1, '100% of the time']] as const) {
      const holds = ps.some((p) => p === v), flagged = validateProseDirections(`${P} plays ${X} ${words}.`, L, g).length > 0;
      check(`F3 "${words}" is judged exactly`, holds !== flagged, t);
    }
    for (const p of ps) {
      const k = Math.round(p * 100);
      if (!(ps.some((q) => Math.abs(q - k / 100) < 1e-12) || (k > 0 && k < 100))) continue;
      reach.pctTrue++;
      for (const s of [`${P} plays ${X} ${k}% of the time.`, `${P} puts ${k}% on ${X}.`, `${P} plays ${X} ${k} percent of the time.`])
        check('F4 a true percent claim stands', validateProseDirections(s, L, g).length === 0, `${s} ${t}`);
    }
    const truth37 = within(0.37, 0.02 - 1e-9);
    if (!truth37) reach.pctFalse++;
    check('F4 "37% of its turns" is judged against the oracle', truth37 === (validateProseDirections(`${P} plays ${X} 37% of its turns.`, L, g).length === 0), t);
    // F6 (S16) bounds, ranges and denials, true and false, on games whose equilibria are isolated points.
    if (!deg) {
      const a = Math.floor(rnd6() * 101), b = Math.min(100, a + 1 + Math.floor(rnd6() * 40)), A = a / 100, B = b / 100, tl = 0.02 - 1e-9;
      const some = (f: (q: number) => boolean) => ps.some(f);
      const F6: [string, string, boolean, number[]][] = [
        ['more than', `${P} plays ${X} more than ${a}% of the time.`, some((q) => q > A), [A]],
        ['at most', `${P} puts at most ${a}% on ${X}.`, some((q) => q <= A), [A]],
        ['or more', `${P} plays ${X} ${a}% or more of the time.`, some((q) => q >= A), [A]],
        ['range', `${P} plays ${X} between ${a}% and ${b}% of the time.`, some((q) => q > A - tl && q < B + tl), [A - tl, B + tl]],
        ['dash', `${P} plays ${X} ${a}-${b}% of the time.`, some((q) => q > A - tl && q < B + tl), [A - tl, B + tl]],
        ['to', `${P} plays ${X} ${a}% to ${b}% of the time.`, some((q) => q > A - tl && q < B + tl), [A - tl, B + tl]],
        ['denial', `${P} does not play ${X} ${a}% of the time.`, !ps.every((q) => (a % 100 ? Math.abs(q - A) < 0.005 : q === A)), [A - 0.005, A + 0.005]],
        ['none', `No equilibrium has ${P} playing ${X} more than ${a}% of the time.`, !some((q) => q > A), [A]],
      ];
      for (const [k, s, truth, cuts] of F6) {
        if (ps.some((q) => cuts.some((c) => Math.abs(q - c) < 1e-6))) continue;   // at a cut either verdict is defensible
        reach.qualified++;
        check(`F6 a ${k} figure is judged against the oracle`, truth !== (validateProseDirections(s, L, g).length > 0), `${s} ${t}`);
      }
      // F7 (S17) decimals at 1-3 places: true at the oracle value rounded, false at a draw the oracle refutes.
      for (const d of [1, 2, 3]) {
        const q = ps[Math.floor(rnd7() * ps.length)], f = q.toFixed(d), u = 0.5 * 10 ** -d, v = Math.floor(rnd7() * 10 ** d) / 10 ** d;
        if (q > 0 && q < 1 && Number(f) !== 0 && Number(f) !== 1) { reach.decimal++; check('F7 a true decimal stands', !validateProseDirections(`${P} plays ${X} with probability ${f}.`, L, g).length, `${f} ${t}`); }
        if (v > 0 && !ps.some((p) => Math.abs(p - v) <= u + 1e-6)) { reach.decimal++; check('F7 a false decimal flags', validateProseDirections(`${P} plays ${X} with probability ${v.toFixed(d)}.`, L, g).length > 0, `${v} ${t}`); }
      }
    }
  }
  // F5 the shipping renderer's own prose passes every check it is screened by.
  const r = tieProseFull(g, L); reach.rendered++;
  const issues = [...validateProseDirections(r.prose, L, g), ...validateProseClaims(r.claims, r.prose, g, all, deg, L).issues];
  check('F5 the tie-prose renderer passes its own screens', issues.length === 0, `${tag} :: ${issues.join(' | ')}`);
}
// Reach: without these shapes every check above passes by not looking.
check('reach: near-corner mixed NE games (S15a)', reach.nearCorner >= 5, JSON.stringify(reach));
check('reach: sub-resolution mixes (S15b/c)', reach.subMix >= 50, JSON.stringify(reach));
check('reach: partial-tie continua (S15b)', reach.partialTie >= 300, JSON.stringify(reach));
check('reach: true and false percent claims (S15d)', reach.pctTrue >= 20000 && reach.pctFalse >= 20000, JSON.stringify(reach));
check('reach: qualified figures (S16)', reach.qualified >= 50000, JSON.stringify(reach));
check('reach: true and false decimals (S17)', reach.decimal >= 20000, JSON.stringify(reach));

const failed = Object.keys(fails);
if (failed.length) {
  for (const k of failed) console.error(`  ✗ ${k}: ${fails[k]} failure(s); first: ${firstFail[k]}`);
  process.exit(1);
}
console.log(`✓ mathvalidator: ${checks} checks; reach ${JSON.stringify(reach)}`);

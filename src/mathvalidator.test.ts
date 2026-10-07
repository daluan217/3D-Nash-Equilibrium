/**
 * Validator math claims vs the exact equilibrium set (BLUE-LOOP-MATH-22 sweep 15, S15a-d).
 *
 * The truth here is an oracle that shares no code with equilibriumSet / computeAllNE: equilibrium components have
 * endpoints in {0, 1, interior roots}, so zero-regret tests at breakpoints and midpoints find every component.
 *   npx tsx src/mathvalidator.test.ts
 */
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
    'Against Retreat, A gets 2 over Cooperate by playing Defect.', 'A gets 3 against Retreat and B gets 0 and 2 against Advance.', 'Retreat against Defect earns 2.'])
    check('S18d a difference or foreign figure stands', validateProseDirections(s, L, MIX).length === 0, s);
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

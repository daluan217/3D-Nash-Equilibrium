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

// ── Fuzz: good output must validate, false claims must not (oracle, four scales, fixed seeds) ─────────────
const rnd = seededRandom(0x5715), rnd6 = seededRandom(0x5716);   // F6 draws apart: the F1-F5 games stay as measured
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const reach = { nearCorner: 0, subMix: 0, partialTie: 0, pctTrue: 0, pctFalse: 0, rendered: 0, qualified: 0 };
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

const failed = Object.keys(fails);
if (failed.length) {
  for (const k of failed) console.error(`  ✗ ${k}: ${fails[k]} failure(s); first: ${firstFail[k]}`);
  process.exit(1);
}
console.log(`✓ mathvalidator: ${checks} checks; reach ${JSON.stringify(reach)}`);

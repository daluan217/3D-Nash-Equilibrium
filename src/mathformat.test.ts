/**
 * Every number the explainer payload states goes through the one formatter family (BLUE-LOOP-MATH-22 F6).
 *
 * geometryBriefing printed roots with its own 4-dp door and the twist raw, so the "computed, authoritative"
 * briefing said "y = 1" for an interior root the panel calls "more than 0.999", "y = 1, outside [0,1]" for
 * a root just past the edge, "twist = 13.907999999999998", and 0.5882 beside the solver line's 0.588.
 *
 *   npx tsx src/mathformat.test.ts
 */
import { readFileSync } from 'node:fs';
import { geometryBriefing, describeGeometry } from './utils/geometry';
import { buildGroundingPayload } from './utils/report';
import { fmtProb, fmtPayoffProse, commitPayoffs, PRESETS, hasEquilibriumContinuum, computeMixedNE, equilibriumSet } from './utils/gameEngine';
import { tieProse } from './utils/tieProse';
import type { GamePayoffs } from './types';

let checks = 0;
const fails: Record<string, number> = {};
const firstFail: Record<string, string> = {};
const check = (name: string, ok: boolean, detail = ''): void => {
  checks++;
  if (ok) return;
  fails[name] = (fails[name] ?? 0) + 1;
  firstFail[name] ??= detail;
};
const K = ['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const;
const WORD = / \((?:a half|a third|two-thirds|a quarter|three-quarters|a fifth|two-fifths|three-fifths|four-fifths)\)$/;

// ── F6 verbatim (each fixture carries ONE defect signal) ──────────────────────
const F6_IN: GamePayoffs = { a11: 0.001, a21: 0, a12: -100, a22: 99.999, b11: 1, b12: 0, b21: 0, b22: 1 };
const F6_OUT: GamePayoffs = { a11: 0, a21: 0.001, a12: -100, a22: 99.999, b11: 1, b12: 0, b21: 0, b22: 1 };
const F6_TWIST: GamePayoffs = { a11: -46.786, a12: 20.036, a21: -50.759, a22: 29.971, b11: 1.086, b12: 77.947, b21: 79.997, b22: 80.124 };
const yIn = describeGeometry(F6_IN).yStar, yOut = describeGeometry(F6_OUT).yStar, tw = describeGeometry(F6_TWIST).twistA;
check('fixture F6_IN: an interior root within 5e-5 of 1, which the panel prints "more than 0.999"',
  yIn > 0.99995 && yIn < 1 && describeGeometry(F6_IN).yStarInRange && fmtProb(yIn) === 'more than 0.999', String(yIn));
check('fixture F6_OUT: a root within 5e-5 past 1', yOut > 1 && yOut < 1.00005, String(yOut));
check('fixture F6_TWIST: the float twist has more than 3 decimals', /\.\d{4,}/.test(String(tw)), String(tw));
const bIn = geometryBriefing(F6_IN), bOut = geometryBriefing(F6_OUT), bTw = geometryBriefing(F6_TWIST);
check('F6 interior root never "(x = 0.5 (a half), y = 1)" — prints "y = more than 0.999"',
  !bIn.includes('y = 1)') && !bIn.includes('mix y = 1 ') && bIn.includes('y = more than 0.999'), bIn);
check('F6 outside root never "the level point would be at y = 1, outside [0,1]"',
  !bOut.includes('would be at y = 1, outside') && bOut.includes('would be at y = more than 1, outside [0,1]'), bOut);
check('F6 twist never "twist = 13.907999999999998" — prints "twist = 13.908"',
  !bTw.includes('13.907999999999998') && bTw.includes('twist = 13.908)'), bTw);
// Off-grid on purpose (the float root path): on 3dp input a boundary root is exactly 0/1, so only this
// fixture tells "y = 1, which is the edge" from "y = more than 0.999, which is the edge".
const F6_EDGE: GamePayoffs = { a11: 1e-10, a21: 0, a12: -1.0000001, a22: 0, b11: 1, b12: 0, b21: 0, b22: 1 };
const yEdge = describeGeometry(F6_EDGE).yStar;
check('fixture F6_EDGE: a float boundary root 1e-10 below 1', yEdge < 1 && 1 - yEdge < 1e-9, String(yEdge));
check('F6 boundary root never "level only at y = more than 0.999, which is the edge" — prints the edge',
  geometryBriefing(F6_EDGE).includes('level only at y = 1, which is the edge'), geometryBriefing(F6_EDGE));

// ── source gate: geometry.ts has no number door of its own (a sentence the sweep never reaches) ──
const geoSrc = readFileSync(new URL('./utils/geometry.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
check('G1 geometry.ts never rounds or fixes a number for display (Math.round / .toFixed / 1e4)', !/Math\.round\(|\.toFixed\(|\.toPrecision\(|\b1e4\b/.test(geoSrc));
check('G2 geometry.ts never interpolates a raw geometry number (${geo.twistA}, ${geo.yStar} ...)', !/\$\{\s*(?:geo\.(?:twist[AB]|[xy]Star)|aOwnTilt|aOppTilt|g\.[ab][12][12])\s*\}/.test(geoSrc),
  geoSrc.match(/.*\$\{\s*(?:geo\.(?:twist[AB]|[xy]Star)|aOwnTilt|aOppTilt|g\.[ab][12][12])\s*\}.*/)?.[0]);

// ── sweep: every number in the payload, against the family ───────────────────
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry(0xf6);
const cells = (f: () => number) => Object.fromEntries(K.map((k) => [k, f()])) as unknown as GamePayoffs;
const tiny = () => { const d = Math.floor(rnd() * 200) + 1; return (rnd() < 0.5 ? d : -d) / 1000; };
const CORPORA: Record<string, () => GamePayoffs> = {
  int9: () => cells(() => Math.floor(rnd() * 19) - 9),
  dp3: () => cells(() => Math.round((rnd() * 200 - 100) * 1000) / 1000),
  small: () => cells(() => (Math.floor(rnd() * 11) - 5) / 1000),
  // one side's difference tiny, the other near 100: roots within 5e-5 of an edge, both sides of it
  edge: () => {
    const big = Math.round(rnd() * 50000) / 1000 + 50;
    const g: any = { a11: tiny(), a21: 0, a12: -big, a22: Math.round((big + (rnd() < 0.5 ? 0 : tiny())) * 1000) / 1000 };
    if (rnd() < 0.5) [g.a11, g.a21, g.a12, g.a22] = [g.a21, g.a11, g.a22, g.a12];
    for (const k of ['b11', 'b12', 'b21', 'b22']) g[k] = Math.floor(rnd() * 9) - 4;
    if (rnd() < 0.5) [g.a11, g.a12, g.a21, g.a22, g.b11, g.b12, g.b21, g.b22] = [g.b11, g.b21, g.b12, g.b22, g.a11, g.a21, g.a12, g.a22];
    return commitPayoffs(g);   // the shipping condition: every matrix arrives through the door
  },
};
const reach = { subIn: 0, outNear: 0, twistFloat: 0, words: 0, outside: 0 };
const prob = (s: string) => s.replace(WORD, '');
function checkGame(g: GamePayoffs, tag: string): void {
  const geo = describeGeometry(g);
  const brief = geometryBriefing(g);
  const payload = buildGroundingPayload(g);
  check('P0 the payload carries the briefing verbatim', payload.includes(brief), tag);
  check('P1 no number in the payload has more than 3 decimals', !/\d\.\d{4,}/.test(payload), `${tag} ${payload.match(/.*\d\.\d{4,}.*/)?.[0]}`);
  check('P5 no NaN/undefined/Infinity in the payload', !/\b(?:NaN|undefined|Infinity)\b/.test(payload), tag);
  // probabilities: each root sentence prints fmtProb(root)
  const roots: [RegExp, number][] = [
    [/when B plays y = (.+?) — that flat shelf/, geo.yStar],
    [/interior point \(x = (.+?), y = /, geo.xStar],
    [/interior point \(x = .+?, y = (.+?)\) — the joint/, geo.yStar],
    [/A's equilibrium mix x = (.+?) is computed/, geo.xStar],
    [/B's mix y = (.+?) entirely from A's/, geo.yStar],
    [/level when B plays y = (.+?), and B's/, geo.yStar],
    [/level when A plays x = (.+?)\. There is a whole/, geo.xStar],
  ];
  for (const [re, v] of roots) {
    const m = brief.match(re);
    if (!m) continue;
    if (WORD.test(m[1])) reach.words++;
    if (fmtProb(v).includes('than')) reach.subIn++;
    check('P2 an interior root prints as fmtProb(root), the panel\'s digits', prob(m[1]) === fmtProb(v), `${tag} "${m[1]}" vs ${fmtProb(v)} (${v})`);
    check('P4 an interior root never prints as 0 or 1', !/^[01]$/.test(prob(m[1])), `${tag} ${m[0]}`);
  }
  const out = brief.match(/would be at y = (.+?), outside \[0,1\]/);
  if (out) {
    reach.outside++;
    if (Math.abs(geo.yStar - 1) < 5e-4 || Math.abs(geo.yStar) < 5e-4) reach.outNear++;
    const n = Number(out[1]);
    check('P3 a root outside [0,1] never prints a value inside [0,1]',
      out[1] === (geo.yStar > 1 ? 'more than 1' : 'less than 0') || (Number.isFinite(n) && (n < 0 || n > 1)), `${tag} ${out[0]} (${geo.yStar})`);
  }
  const edge = brief.match(/level only at y = (\S+), which is the edge/);
  if (edge) check('P3 a boundary root prints the edge it names', edge[1] === (geo.yStar > 0.5 ? '1' : '0'), `${tag} ${edge[0]}`);
  // payoffs: twist and tilts print as fmtPayoffProse
  const t = brief.match(/twist = (.+?)\)/);
  if (t && t[1] !== '0') {
    if (/\.\d{4,}/.test(String(geo.twistA))) reach.twistFloat++;
    check('P6 the twist prints as fmtPayoffProse(twist)', t[1] === fmtPayoffProse(geo.twistA), `${tag} ${t[0]} (${geo.twistA})`);
  }
  const opp = brief.match(/by (\S+) as B shifts from Col 2 to Col 1/);
  if (opp) check('P6 the opponent tilt prints as fmtPayoffProse', opp[1] === fmtPayoffProse(g.a21 - g.a22), `${tag} ${opp[0]}`);
  const own = brief.match(/better off from Row [12], by (\S+), whatever/);
  if (own) check('P6 the own tilt prints as fmtPayoffProse', own[1] === fmtPayoffProse(Math.abs(g.a12 - g.a22)), `${tag} ${own[0]}`);
}
for (const g of [F6_IN, F6_OUT, F6_TWIST]) checkGame(g, 'fixture');
const N = Number(process.env.MATHFORMAT_N ?? 4000);
for (const [kind, gen] of Object.entries(CORPORA)) for (let i = 0; i < N; i++) { const g = gen(); checkGame(g, `${kind} ${JSON.stringify(g)}`); }
for (const [id, p] of Object.entries(PRESETS)) {
  if (id === 'custom') continue;
  checkGame(Object.fromEntries(K.map((k) => [k, (p as any)[k]])) as unknown as GamePayoffs, `preset ${id}`);
}
// T1 (BLUE-LOOP-MATH-22 sweep 7): the tie paragraph, briefing and payload over a range-edge / near-zero /
// repeating-decimal alphabet with forced ties (continua by construction): no raw float, no NaN, no "-0".
const EDGE = [-100, -99.999, -50.001, -1, -0.002, -0.001, 0, 0.001, 0.002, 1, 3, 7.5, 33.333, 99.998, 99.999, 100];
const NEG0 = /(^|[^\d.])-0(?![.\d])|-0\.0+(?![\d])/;
let tieN = 0;
for (let i = 0; i < 6000; i++) {
  const g = cells(() => EDGE[Math.floor(rnd() * EDGE.length)]), t = i % 4;
  if (t & 1) g.a21 = g.a11; if (t & 2) g.b12 = g.b11;
  const tag = `T1 ${JSON.stringify(g)}`, texts = [buildGroundingPayload(g), ...(hasEquilibriumContinuum(g) ? (tieN++, [tieProse(g)]) : [])];
  for (const s of texts) {
    check('T1 no number in the tie paragraph or payload has more than 3 decimals', !/\d\.\d{4,}/.test(s), `${tag} ${s.match(/.{0,60}\d\.\d{4,}/)?.[0]}`);
    check('T1 no NaN/undefined/Infinity and no negative zero in the tie paragraph or payload', !/\b(?:NaN|undefined|Infinity)\b/.test(s) && !NEG0.test(s), `${tag} ${s.match(/.{0,40}(?:NaN|undefined|Infinity|-0).{0,20}/)?.[0]}`);
  }
}
check('reach: T1 tie paragraphs over the edge alphabet', tieN >= 3000, `${tieN}`);
// T2 (sweep 8): the briefing's flat-spot claims are the solver's. "level at the same interior point (x, y)"
// iff computeMixedNE, at its digits; "interior profiles" only when the set has an interior point; "NO
// interior joint flat spot" never when a mixed NE exists. Ties every 6th/10th game force continua.
const t2 = { joint: 0, none: 0, profiles: 0 };
for (let i = 0; i < 20000; i++) {
  const g = cells(() => (i % 2 ? EDGE[Math.floor(rnd() * EDGE.length)] : Math.floor(rnd() * 7) - 3));
  if (i % 6 === 0) g.a21 = g.a11; if (i % 10 === 0) g.b12 = g.b11;
  const b = geometryBriefing(g), m = computeMixedNE(g), tag = `T2 ${JSON.stringify(g)}`;
  const j = b.match(/level at the same interior point \(x = (.+?), y = (.+?)\) — the joint/), dig = (w: string) => w.replace(/ \(.*\)$/, '');
  if (j) t2.joint++;
  check('T2 "the same interior point (x, y)" is stated iff a mixed NE exists, at fmtProb of its coordinates',
    m ? !!j && dig(j[1]) === fmtProb(m.x) && dig(j[2]) === fmtProb(m.y) : !j, `${tag} ${j?.[0]} vs ${JSON.stringify(m)}`);
  if (/level at the same interior profiles/.test(b)) {
    t2.profiles++;
    check('T2 "interior profiles" only when the equilibrium set has a strictly interior point', equilibriumSet(g).some((q) => q.x1 > 0 && q.x0 < 1 && q.y1 > 0 && q.y0 < 1), tag);
  }
  if (/NO interior joint flat spot/.test(b)) { t2.none++; check('T2 "NO interior joint flat spot" never when a mixed NE exists', !m, `${tag} ${JSON.stringify(m)}`); }
}
check('reach: T2 joint points, interior-profile continua and no-flat-spot games', t2.joint >= 2000 && t2.profiles >= 300 && t2.none >= 10000, JSON.stringify(t2));
// Reach: the sweep must contain the shapes the defect lives in, or P1-P6 pass by not looking.
check('reach: interior roots that are sub-resolution', reach.subIn > 50, JSON.stringify(reach));
check('reach: outside roots within 5e-4 of an edge', reach.outNear > 50, JSON.stringify(reach));
check('reach: twists whose float has more than 3 decimals', reach.twistFloat > 500, JSON.stringify(reach));
check('reach: exact-fraction words', reach.words > 50, JSON.stringify(reach));

const failed = Object.keys(fails);
if (failed.length) {
  for (const k of failed) console.error(`  ✗ ${k}: ${fails[k]} failure(s); first: ${firstFail[k]}`);
  process.exit(1);
}
console.log(`✓ mathformat: ${checks} checks; reach ${JSON.stringify(reach)}`);

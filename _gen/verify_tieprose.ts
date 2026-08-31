/**
 * Independent verification of the deterministic renderer (`tieProse`).
 *
 * The campaign's repeated lesson is that a correctness ARGUMENT about generated
 * text is worth less than a measurement: `tieProse` is "correct by construction"
 * and still shipped a false clause (L7 draw 54 — "equilibria beyond isolated
 * points" on a game whose equilibrium set is one point), because an editorial
 * generalisation was not derived even though everything around it was.
 *
 * So this script does not trust the renderer's internals. It PARSES the English
 * back into claims and checks each against the payoff matrix and `equilibriumSet`
 * independently, and — the property that would have caught L7 — it requires that
 * EVERY CHARACTER of the output be consumed by a recognised, verified pattern.
 * An unverified sentence is a failure even if it happens to be true.
 *
 *   npx tsx _gen/verify_tieprose.ts            # default 200k games
 *   V_N=1000000 npx tsx _gen/verify_tieprose.ts
 */
import { tieProseFull, type TieLabels } from '../src/utils/tieProse.ts';
import { equilibriumSet, kindOf, EA, EB, type Rect } from '../src/utils/gameEngine.ts';
import type { GamePayoffs } from '../src/types.ts';

const N = Number(process.env.V_N || 200000);
const VERBOSE = process.env.V_VERBOSE === '1';

class Fail extends Error {}
const bad = (m: string): never => { throw new Fail(m); };

// --- number parsing mirrors the renderer's DISPLAY precision, not its logic.
// `num` prints 3 decimals; a parsed figure may differ from truth by rounding.
const TOL = 5e-4;
const near = (a: number, b: number) => Math.abs(a - b) <= TOL + 1e-9;   // half-ulp of the 3-dp display, plus FP slack

interface Ctx { g: GamePayoffs; labels: TieLabels | null; text: string; claims: import('../src/types.ts').ProseActionClaims }

/**
 * Resolve a rendered option name back to (side, index). Uses only the VOCABULARY
 * the renderer can emit, never its choice logic — and treats an ambiguous name
 * as a defect, which is the T1 #110 class (two identical labels made two clauses
 * indistinguishable).
 */
function makeResolvers(labels: TieLabels | null): ((name: string, side: 'row' | 'col') => 1 | 2)[] {
  type Cand = { name: string; side: 'row' | 'col'; idx: 1 | 2 };
  const generic: Cand[] = [
    { name: 'Row 1', side: 'row', idx: 1 }, { name: 'Row 2', side: 'row', idx: 2 },
    { name: 'Col 1', side: 'col', idx: 1 }, { name: 'Col 2', side: 'col', idx: 2 },
  ];
  const named: Cand[] = [];
  const t = (k: keyof TieLabels) => labels?.[k]?.trim() || undefined;
  for (const [k, side, idx] of [['row1', 'row', 1], ['row2', 'row', 2], ['col1', 'col', 1], ['col2', 'col', 2]] as const) {
    const n = t(k);
    if (!n) continue;
    named.push({ name: n, side, idx });
    named.push({ name: `${side === 'row' ? 'A' : 'B'}'s ${n}`, side, idx });   // qualified form for shared words
  }
  // The renderer names a paragraph ENTIRELY with labels or ENTIRELY with the
  // generic Row/Col names — it falls back to generics when the labels are
  // unusable (duplicated, digit-bearing, separator-bearing). Rather than
  // re-implement that decision (which would make the check circular), build
  // both regimes and let the caller accept the paragraph if EITHER reading
  // verifies. That is the reader's own situation, and ambiguity WITHIN a
  // regime — the T1 #110 class, two identical labels — is still a defect.
  const table = (tier: Cand[]) => (name: string, wantSide: 'row' | 'col'): 1 | 2 => {
    const hits = tier.filter((c) => c.name === name && c.side === wantSide);
    if (!hits.length) return bad(`unrecognised ${wantSide} name ${JSON.stringify(name)}`);
    if (new Set(hits.map((h) => h.idx)).size > 1) bad(`AMBIGUOUS ${wantSide} name ${JSON.stringify(name)} — resolves to both options`);
    return hits[0].idx;
  };
  const full = ['row1', 'row2', 'col1', 'col2'].every((k) => t(k as keyof TieLabels));
  return full ? [table(named), table(generic)] : [table(generic)];
}

const payA = (g: GamePayoffs, r: 1 | 2, c: 1 | 2) => (r === 1 ? (c === 1 ? g.a11 : g.a12) : c === 1 ? g.a21 : g.a22);
const payB = (g: GamePayoffs, r: 1 | 2, c: 1 | 2) => (r === 1 ? (c === 1 ? g.b11 : g.b12) : c === 1 ? g.b21 : g.b22);

const NUM = String.raw`-?\d+(?:\.\d+)?`;

function verifyOne(ctx: Ctx, resolve: (name: string, side: 'row' | 'col') => 1 | 2): void {
  const { g } = ctx;
  let s = ctx.text;
  const eat = (re: RegExp): RegExpMatchArray | null => {
    const m = s.match(new RegExp('^(?:' + re.source + ')'));
    if (m) s = s.slice(m[0].length);
    return m;
  };

  // ---- ground truth ---------------------------------------------------------
  const trueTies: string[] = [];       // canonical keys
  for (const c of [1, 2] as const) if (payA(g, 1, c) === payA(g, 2, c)) trueTies.push(`A|${c}`);
  for (const r of [1, 2] as const) if (payB(g, r, 1) === payB(g, r, 2)) trueTies.push(`B|${r}`);
  const trueStrict: string[] = [];
  for (const c of [1, 2] as const) if (payA(g, 1, c) !== payA(g, 2, c)) trueStrict.push(`A|${c}`);
  for (const r of [1, 2] as const) if (payB(g, r, 1) !== payB(g, r, 2)) trueStrict.push(`B|${r}`);
  const set = equilibriumSet(g);
  const trueContinuum = set.some((r) => kindOf(r) !== 'point');

  // ---- 1. tie sentence ------------------------------------------------------
  const seenTies = new Set<string>();
  if (eat(/This game contains a payoff tie: /)) {
    for (;;) {
      let m = eat(new RegExp(String.raw`against (.+?), A earns (${NUM}) from either row`));
      if (m) {
        const c = resolve(m[1], 'col');
        if (payA(g, 1, c) !== payA(g, 2, c)) bad(`claims A ties against col ${c} but ${payA(g, 1, c)} != ${payA(g, 2, c)}`);
        if (!near(Number(m[2]), payA(g, 1, c))) bad(`tie value ${m[2]} != A's true ${payA(g, 1, c)} against col ${c}`);
        if (seenTies.has(`A|${c}`)) bad(`duplicate tie clause A|${c}`);
        seenTies.add(`A|${c}`);
      } else {
        m = eat(new RegExp(String.raw`against (.+?), B earns (${NUM}) from either column`));
        if (!m) bad(`unparsed tie clause at: ${JSON.stringify(s.slice(0, 90))}`);
        const r = resolve(m![1], 'row');
        if (payB(g, r, 1) !== payB(g, r, 2)) bad(`claims B ties against row ${r} but ${payB(g, r, 1)} != ${payB(g, r, 2)}`);
        if (!near(Number(m![2]), payB(g, r, 1))) bad(`tie value ${m![2]} != B's true ${payB(g, r, 1)} against row ${r}`);
        if (seenTies.has(`B|${r}`)) bad(`duplicate tie clause B|${r}`);
        seenTies.add(`B|${r}`);
      }
      if (!eat(/; /)) break;
    }
    const both = new Set([...seenTies].map((k) => k[0])).size > 1;
    const who = eat(/ — so each of them is indifferent where its own payoffs tie/)
      ? 'plural' : eat(/ — so that player is indifferent there/) ? 'singular' : bad(`unparsed tie tail: ${JSON.stringify(s.slice(0, 90))}`);
    if (both && who !== 'plural') bad('both players tie but the sentence uses the singular "that player"');
    if (!both && who !== 'singular') bad('one player ties but the sentence uses the plural');
    const cont = !!eat(/, and the tie is what admits equilibria beyond isolated points/);
    if (cont !== trueContinuum) bad(`"beyond isolated points" claimed=${cont} but the equilibrium set ${trueContinuum ? 'HAS' : 'has NO'} non-point component`);
    if (!eat(/\. /) && !eat(/\./)) bad(`tie sentence not terminated: ${JSON.stringify(s.slice(0, 60))}`);
  }
  const missTie = trueTies.filter((k) => !seenTies.has(k));
  if (missTie.length) bad(`INCOMPLETE: real tie(s) ${missTie.join(',')} never stated`);

  // ---- 2. strict sentence ---------------------------------------------------
  const seenStrict = new Set<string>();
  const proseReplies: string[] = [];
  if (eat(/Elsewhere the choice is strict: /) || eat(/Each player has a strict best reply: /)) {
    for (;;) {
      let m = eat(new RegExp(String.raw`against (.+?), A prefers (.+?) \((${NUM}) rather than (${NUM})\)`));
      if (m) {
        const c = resolve(m[1], 'col');
        const better = resolve(m[2], 'row');
        const other = (3 - better) as 1 | 2;
        if (!(payA(g, better, c) > payA(g, other, c))) bad(`A does NOT prefer row ${better} against col ${c} (${payA(g, better, c)} vs ${payA(g, other, c)})`);
        if (!near(Number(m[3]), payA(g, better, c))) bad(`stated better payoff ${m[3]} != ${payA(g, better, c)}`);
        if (!near(Number(m[4]), payA(g, other, c))) bad(`stated worse payoff ${m[4]} != ${payA(g, other, c)}`);
        if (seenStrict.has(`A|${c}`)) bad(`duplicate strict clause A|${c}`);
        seenStrict.add(`A|${c}`);
        proseReplies.push(`A|${c}|${better}|${Number(m[3])}|${Number(m[4])}`);
      } else {
        m = eat(new RegExp(String.raw`against (.+?), B prefers (.+?) \((${NUM}) rather than (${NUM})\)`));
        if (!m) bad(`unparsed strict clause at: ${JSON.stringify(s.slice(0, 90))}`);
        const r = resolve(m![1], 'row');
        const better = resolve(m![2], 'col');
        const other = (3 - better) as 1 | 2;
        if (!(payB(g, r, better) > payB(g, r, other))) bad(`B does NOT prefer col ${better} against row ${r}`);
        if (!near(Number(m![3]), payB(g, r, better))) bad(`stated better payoff ${m![3]} != ${payB(g, r, better)}`);
        if (!near(Number(m![4]), payB(g, r, other))) bad(`stated worse payoff ${m![4]} != ${payB(g, r, other)}`);
        if (seenStrict.has(`B|${r}`)) bad(`duplicate strict clause B|${r}`);
        seenStrict.add(`B|${r}`);
        proseReplies.push(`B|${r}|${better}|${Number(m![3])}|${Number(m![4])}`);
      }
      if (!eat(/; /)) break;
    }
    if (!eat(/\. /) && !eat(/\./)) bad(`strict sentence not terminated: ${JSON.stringify(s.slice(0, 60))}`);
  }
  const missStrict = trueStrict.filter((k) => !seenStrict.has(k));
  if (missStrict.length) bad(`INCOMPLETE: real strict preference(s) ${missStrict.join(',')} never stated`);

  // ---- 3. equilibrium set ---------------------------------------------------
  const parsed: Rect[] = [];
  const proseActions = new Set<string>();
  const prob = (raw: string) => { const v = Number(raw); if (!Number.isFinite(v)) bad(`bad probability ${raw}`); return v; };
  const parseX = (txt: string): { x0: number; x1: number } => {
    let m = txt.match(new RegExp(String.raw`^A plays (.+?) with any probability from (${NUM}) to (${NUM})$`));
    if (m) { if (resolve(m[1], 'row') !== 1) bad('range stated on row 2 rather than row 1'); proseActions.add('A|1'); return { x0: prob(m[2]), x1: prob(m[3]) }; }
    if (txt === 'A plays any mixture at all') return { x0: 0, x1: 1 };
    m = txt.match(new RegExp(String.raw`^A plays (.+?) with probability (less than 0\.001|more than 0\.999)$`));
    if (m) {
      if (resolve(m[1], 'row') !== 1) bad('probability stated on row 2 rather than row 1');
      proseActions.add('A|1');
      // A sub-resolution probability is reported by THRESHOLD rather than as a
      // rounded figure, because rounding it collapsed a mixed equilibrium onto
      // a pure profile that is not an equilibrium. Verify the true value really
      // is inside the stated band.
      // "less than 0.001" asserts the true value is in (0, 0.001); "more than
      // 0.999" asserts (0.999, 1). Carry that as a RANGE so the round-trip can
      // verify the solver's value really lies inside the band.
      // Bounds are STRICTLY interior: the band is the OPEN interval, and encoding
      // its edge as exactly 0 or 1 would trip the "displayed 0/1 must BE 0/1"
      // assertion below, which is about claims of certainty, not bands.
      return m[2].startsWith('less') ? { x0: 1e-12, x1: 0.001 } : { x0: 0.999, x1: 1 - 1e-12 };
    }
    m = txt.match(new RegExp(String.raw`^A plays (.+?) with probability (${NUM})$`));
    if (m) { if (resolve(m[1], 'row') !== 1) bad('probability stated on row 2 rather than row 1'); proseActions.add('A|1'); const v = prob(m[2]); return { x0: v, x1: v }; }
    m = txt.match(/^A plays (.+?)$/);
    if (!m) bad(`unparsed A clause ${JSON.stringify(txt)}`);
    const i = resolve(m![1], 'row');
    proseActions.add(`A|${i}`);
    return i === 1 ? { x0: 1, x1: 1 } : { x0: 0, x1: 0 };
  };
  const parseY = (txt: string): { y0: number; y1: number } => {
    let m = txt.match(new RegExp(String.raw`^B plays (.+?) with any probability from (${NUM}) to (${NUM})$`));
    if (m) { if (resolve(m[1], 'col') !== 1) bad('range stated on col 2 rather than col 1'); proseActions.add('B|1'); return { y0: prob(m[2]), y1: prob(m[3]) }; }
    if (txt === 'B plays any mixture at all') return { y0: 0, y1: 1 };
    m = txt.match(new RegExp(String.raw`^B plays (.+?) with probability (less than 0\.001|more than 0\.999)$`));
    if (m) {
      if (resolve(m[1], 'col') !== 1) bad('probability stated on col 2 rather than col 1');
      proseActions.add('B|1');
      // A sub-resolution probability is reported by THRESHOLD rather than as a
      // rounded figure, because rounding it collapsed a mixed equilibrium onto
      // a pure profile that is not an equilibrium. Verify the true value really
      // is inside the stated band.
      // "less than 0.001" asserts the true value is in (0, 0.001); "more than
      // 0.999" asserts (0.999, 1). Carry that as a RANGE so the round-trip can
      // verify the solver's value really lies inside the band.
      // Bounds are STRICTLY interior: the band is the OPEN interval, and encoding
      // its edge as exactly 0 or 1 would trip the "displayed 0/1 must BE 0/1"
      // assertion below, which is about claims of certainty, not bands.
      return m[2].startsWith('less') ? { y0: 1e-12, y1: 0.001 } : { y0: 0.999, y1: 1 - 1e-12 };
    }
    m = txt.match(new RegExp(String.raw`^B plays (.+?) with probability (${NUM})$`));
    if (m) { if (resolve(m[1], 'col') !== 1) bad('probability stated on col 2 rather than col 1'); proseActions.add('B|1'); const v = prob(m[2]); return { y0: v, y1: v }; }
    m = txt.match(/^B plays (.+?)$/);
    if (!m) bad(`unparsed B clause ${JSON.stringify(txt)}`);
    const i = resolve(m![1], 'col');
    proseActions.add(`B|${i}`);
    return i === 1 ? { y0: 1, y1: 1 } : { y0: 0, y1: 0 };
  };
  const parsePart = (p: string): Rect => {
    if (p === 'every pair of mixtures in the whole strategy space is an equilibrium') return { x0: 0, x1: 1, y0: 0, y1: 1 } as Rect;
    let i = p.indexOf(' while ');
    if (i >= 0) {
      const l = p.slice(0, i), r = p.slice(i + 7);
      return (l.startsWith('A plays')
        ? { ...parseX(l), ...parseY(r) }
        : { ...parseY(l), ...parseX(r) }) as Rect;
    }
    i = p.indexOf(' and ');
    if (i < 0) bad(`unparsed equilibrium component ${JSON.stringify(p)}`);
    return { ...parseX(p.slice(0, i)), ...parseY(p.slice(i + 5)) } as Rect;
  };
  let sawSet = false;
  let m3 = eat(/Every pair of mixtures in the whole strategy space is an equilibrium\./);
  if (m3) { parsed.push({ x0: 0, x1: 1, y0: 0, y1: 1 } as Rect); sawSet = true; }
  else if (eat(/The equilibrium set is /)) {
    sawSet = true;
    const declared = eat(/\d+ components: /);
    const body = s.match(/^(.*?)\.(?= |$)/);
    if (!body) bad(`equilibrium sentence not terminated: ${JSON.stringify(s.slice(0, 120))}`);
    s = s.slice(body![0].length);
    const parts = body![1].split('; ');
    if (declared) {
      const k = Number(declared[0].match(/\d+/)![0]);
      if (k !== parts.length) bad(`declared ${k} components but listed ${parts.length}`);
      if (k === 1) bad('single component announced with a count');
    } else if (parts.length !== 1) bad(`${parts.length} components listed with no count`);
    for (const p of parts) parsed.push(parsePart(p));
  }
  if (sawSet) {
    const cont = !!eat(/ A continuum like this is why the corner-by-corner reading of the game is incomplete here\./);
    if (cont !== trueContinuum) bad(`continuum footnote claimed=${cont}, truth=${trueContinuum}`);
    // round-trip: the described set must BE the solver's set.
    // A threshold band ("less than 0.001") is a CONTAINMENT claim, so compare by
    // whether each solver rect is covered by some rendered rect rather than by
    // exact 3-dp key equality — which cannot represent a sub-resolution value.
    const covers = (r: Rect, t: Rect) =>
      t.x0 >= r.x0 - 5e-4 && t.x1 <= r.x1 + 5e-4 && t.y0 >= r.y0 - 5e-4 && t.y1 <= r.y1 + 5e-4;
    if (parsed.length !== set.length) bad(`component COUNT mismatch: solver ${set.length}, rendered ${parsed.length}`);
    for (const t of set) {
      if (!parsed.some((r) => covers(r, t)))
        bad(`equilibrium set round-trip MISMATCH — solver component [x ${t.x0}..${t.x1}, y ${t.y0}..${t.y1}] not covered by any rendered component`);
    }
    // a probability printed as exactly 0 or 1 must BE 0 or 1 (display rounding
    // would otherwise turn "almost never" into "never").
    for (let i = 0; i < parsed.length; i++) {
      for (const [pv, tv] of [[parsed[i].x0, set[i] && set[i].x0], [parsed[i].y0, set[i] && set[i].y0]] as const) {
        if ((pv === 0 || pv === 1) && tv !== undefined && tv !== pv && near(pv, tv)) bad(`probability displayed as ${pv} but is really ${tv}`);
      }
    }
  } else if (set.length) bad(`INCOMPLETE: equilibrium set never stated (${set.length} components exist)`);

  // ---- 4. expected payoffs --------------------------------------------------
  if (s.length) {
    if (s.startsWith(' ')) s = s.slice(1);
    const m4 = eat(new RegExp(String.raw`(At the first of these|At that equilibrium|At a representative point of the first component|At a representative point of it) the expected payoffs are E\[A\] = (${NUM}) and E\[B\] = (${NUM})\.`));
    if (!m4) bad(`unparsed tail: ${JSON.stringify(s.slice(0, 140))}`);
    const rep = set[0];
    if (!rep) bad('expected-payoff sentence with no equilibrium');
    const x = (rep.x0 + rep.x1) / 2, y = (rep.y0 + rep.y1) / 2;
    if (!near(Number(m4![2]), EA(x, y, g))) bad(`E[A] ${m4![2]} != ${EA(x, y, g)}`);
    if (!near(Number(m4![3]), EB(x, y, g))) bad(`E[B] ${m4![3]} != ${EB(x, y, g)}`);
    const isPoint = kindOf(rep) === 'point', many = set.length > 1;
    const want = isPoint ? (many ? 'At the first of these' : 'At that equilibrium')
      : (many ? 'At a representative point of the first component' : 'At a representative point of it');
    if (m4![1] !== want) bad(`frame "${m4![1]}" wrong: component is ${kindOf(rep)}, ${set.length} component(s) — expected "${want}"`);
  } else if (set.length) bad('INCOMPLETE: no expected-payoff sentence');

  // ---- declarations must say EXACTLY what the prose says --------------------
  // Two surfaces that are supposed to agree will drift unless something checks.
  const decl = ctx.claims;
  const declReplies = decl.bestReplies.map((b) => `${b.player}|${b.opponentOption}|${b.bestOption}|${b.bestPays}|${b.altPays}`).sort();
  const saidReplies = [...proseReplies].sort();
  if (declReplies.length !== saidReplies.length || declReplies.some((k, i) => k !== saidReplies[i]))
    bad(`declared bestReplies do not match the prose\n  declared: ${declReplies.join(' ')}\n  prose:    ${saidReplies.join(' ')}`);
  const declActs = decl.equilibriumActions.map((a) => `${a.player}|${a.option}`).sort();
  const saidActs = [...proseActions].sort();
  if (declActs.length !== saidActs.length || declActs.some((k, i) => k !== saidActs[i]))
    bad(`declared equilibriumActions do not match the options the prose names\n  declared: ${declActs.join(' ')}\n  prose:    ${saidActs.join(' ')}`);

  // ---- the property that would have caught L7 -------------------------------
  if (s.trim().length) bad(`UNVERIFIED TEXT REMAINS: ${JSON.stringify(s.slice(0, 160))}`);
}

// ---------------------------------------------------------------------------
const LABEL_SETS: (TieLabels | null)[] = [
  null,
  { row1: 'Premium launch', row2: 'Budget launch', col1: 'Broad campaign', col2: 'Targeted campaign' },
  { row1: 'Full schedule', row2: 'Light schedule', col1: 'Full schedule', col2: 'Light schedule' },   // shared words -> qualified
  { row1: 'Attack', row2: 'Attack', col1: 'Defend', col2: 'Hold' },                                   // duplicate -> generic fallback
  { row1: 'Bid 12', row2: 'Bid 7', col1: 'Accept', col2: 'Reject' },                                  // digits -> generic fallback
  { row1: 'Wait, then act', row2: 'Act now', col1: 'Yes', col2: 'No' },                               // comma -> generic fallback
  { row1: 'Split; share', row2: 'Keep', col1: 'Trust', col2: 'Doubt' },                               // semicolon -> generic fallback
  { row1: 'Cut and run', row2: 'Stand firm', col1: 'Press and hold', col2: 'Retreat' },               // " and " inside a label
  { row1: 'Wait while ready', row2: 'Go', col1: 'Watch', col2: 'Move' },                              // " while " inside a label
  { row1: 'A', row2: 'B', col1: 'A', col2: 'B' },                                                     // single letters, shared
  { row1: '  ', row2: 'Defect', col1: 'Cooperate', col2: '' },                                        // blank/partial labels
  { row1: 'Row 1', row2: 'Something else', col1: 'Col 2', col2: 'Col 1' },                            // labels COLLIDING with generics
];

// Random games almost never produce the DEGENERATE shapes — only 3 full-space
// equilibrium sets in 20,000 draws — so a renderer bug confined to those is
// invisible to sampling (mutation testing proved exactly that: "full-space
// component described as a single point" was MISSED at N=4,000). Small-integer
// matrices are enumerated exhaustively first, where ties and continua are dense.
function* exhaustive(values: number[]): Generator<GamePayoffs> {
  const k = values.length;
  for (let n = 0; n < k ** 8; n++) {
    let m = n;
    const c: number[] = [];
    for (let i = 0; i < 8; i++) { c.push(values[m % k]); m = Math.floor(m / k); }
    yield { a11: c[0], a12: c[1], a21: c[2], a22: c[3], b11: c[4], b12: c[5], b21: c[6], b22: c[7] };
  }
}

let seed = 20260829;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

let checked = 0, ties = 0, continua = 0, areas = 0, multi = 0;
const failures: { g: GamePayoffs; labels: TieLabels | null; text: string; why: string }[] = [];
const seenWhy = new Set<string>();

function check(g: GamePayoffs, labels: TieLabels | null): void {
  let text = '';
  try {
    const full = tieProseFull(g, labels);
    text = full.prose;
    if (!text.length) { if (equilibriumSet(g).length) throw new Fail('empty output on a game with equilibria'); return; }
    const regimes = makeResolvers(labels);
    let firstErr: unknown = null, okAny = false;
    for (const r of regimes) {
      try { verifyOne({ g, labels, text, claims: full.claims }, r); okAny = true; break; }
      catch (e) { if (firstErr === null) firstErr = e; }
    }
    if (!okAny) throw firstErr;
    checked++;
    const st = equilibriumSet(g);
    if (g.a11 === g.a21 || g.a12 === g.a22 || g.b11 === g.b12 || g.b21 === g.b22) ties++;
    if (st.some((r) => kindOf(r) !== 'point')) continua++;
    if (st.some((r) => kindOf(r) === 'area')) areas++;
    if (st.length > 1) multi++;
  } catch (e) {
    const why = e instanceof Fail ? e.message : `THREW: ${(e as Error).message}`;
    const cls = why.split('\n')[0].replace(/-?\d+(\.\d+)?/g, '#').replace(/".*?"/g, '"…"').slice(0, 110);
    if (!seenWhy.has(cls)) { seenWhy.add(cls); failures.push({ g, labels, text, why }); }
    else failures.push({ g, labels, text: '', why: cls });
  }
}

// Phase 0 — NEAR-BOUNDARY probabilities. The random and exhaustive corpora both
// use INTEGER payoffs, where the smallest interior indifference root is 1/19;
// the display threshold that collapses a probability onto a pure strategy is
// 0.0005, two orders of magnitude away. So the "displayed 0/1 must BE 0/1"
// assertion below could never fire, and a real defect shipped: a red team found
// A=[[3,0],[0,0.001]] rendering y* = 1/3001 as "with probability 0", asserting a
// profile that is not an equilibrium. Construct games whose roots land in and
// around that window, so the assertion is exercised rather than merely present.
{
  let checkedNB = 0;
  // The server clamps every payoff with Math.round(n*1000)/1000 (cleanPayoffs),
  // so only 3-decimal payoffs are reachable. Feeding finer ones manufactures
  // failures that cannot happen in production. PROBABILITIES are derived, not
  // clamped, so they still land arbitrarily close to 0 and 1 — which is why the
  // real defect lives there and not in the payoffs.
  const r3c = (v: number) => Math.round(v * 1000) / 1000;
  const clamp = (g: GamePayoffs): GamePayoffs => ({
    a11: r3c(g.a11), a12: r3c(g.a12), a21: r3c(g.a21), a22: r3c(g.a22),
    b11: r3c(g.b11), b12: r3c(g.b12), b21: r3c(g.b21), b22: r3c(g.b22),
  });
  for (const eps of [1e-2, 5e-3, 2e-3, 1e-3]) {
    for (const big of [1, 3, 7]) {
      // y* = eps/(big+eps) -> tiny;  and the mirrored case -> near 1
      for (const g of [
        { a11: big, a12: 0, a21: 0, a22: eps, b11: 1, b12: 3, b21: 3, b22: 1 } as GamePayoffs,
        { a11: 0, a12: big, a21: eps, a22: 0, b11: 3, b12: 1, b21: 1, b22: 3 } as GamePayoffs,
        { a11: eps, a12: 0, a21: 0, a22: big, b11: 1, b12: 3, b21: 3, b22: 1 } as GamePayoffs,
      ]) {
        for (const labels of LABEL_SETS) { check(clamp(g), labels); checkedNB++; }
      }
    }
  }
  console.log(`near-boundary: ${checkedNB} renderings with equilibrium probabilities in and around the 0.0005 display threshold`);
}

// Phase 1 — EXHAUSTIVE over every 2x2 game whose eight cells come from {0,1}
// and from {0,1,2}: 6,817 matrices, each under every label set.
let exhaustiveGames = 0;
for (const vals of [[0, 1], [0, 1, 2]]) {
  for (const g of exhaustive(vals)) {
    exhaustiveGames++;
    for (const labels of LABEL_SETS) check(g, labels);
  }
}
const exhaustiveChecked = checked, exhaustiveAreas = areas;
console.log(`exhaustive: ${exhaustiveGames.toLocaleString()} matrices x ${LABEL_SETS.length} label sets = ${exhaustiveChecked.toLocaleString()} verified, ${exhaustiveAreas.toLocaleString()} full-space`);

for (let t = 0; t < N; t++) {
  // Mixed generator: small integers make ties and continua common; a wider
  // range and occasional halves exercise the display-rounding paths.
  const wide = t % 7 === 0, half = t % 11 === 0;
  const cell = () => {
    const v = wide ? Math.floor(rnd() * 41) - 20 : Math.floor(rnd() * 7) - 3;
    return half ? v + (rnd() < 0.5 ? 0.5 : 0) : v;
  };
  const g: GamePayoffs = { a11: cell(), a12: cell(), a21: cell(), a22: cell(), b11: cell(), b12: cell(), b21: cell(), b22: cell() };
  check(g, LABEL_SETS[t % LABEL_SETS.length]);
}

console.log(`\nverified ${checked.toLocaleString()} renderings (${exhaustiveChecked.toLocaleString()} exhaustive + ${(checked - exhaustiveChecked).toLocaleString()} of ${N.toLocaleString()} random)`);
console.log(`  ties ${ties.toLocaleString()} · continua ${continua.toLocaleString()} · full-space ${areas.toLocaleString()} · multi-component ${multi.toLocaleString()}`);
console.log(`  FAILURES: ${failures.length.toLocaleString()} (${seenWhy.size} distinct class${seenWhy.size === 1 ? '' : 'es'})`);
for (const f of failures.filter((x) => x.text)) {
  console.log(`\n--- ${f.why}`);
  console.log(`    game   ${JSON.stringify(f.g)}`);
  console.log(`    labels ${JSON.stringify(f.labels)}`);
  console.log(`    TEXT   ${f.text}`);
}
if (VERBOSE) for (const f of failures.filter((x) => !x.text).slice(0, 20)) console.log(`  (dup) ${f.why}`);
process.exit(failures.length ? 1 : 0);

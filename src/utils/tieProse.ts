/**
 * Deterministic explanation for TIE games.
 *
 * On a game with a within-player payoff tie the model's declarations are
 * reliably right and its free prose is not: adversarial round L4 measured 7
 * wrong sentences in 17 tie prose surfaces (41%) while every declared claim in
 * those same reports was exact. The failure is in rendering, not reasoning, so
 * this module renders the mathematical sentences from the solver and leaves the
 * model only the work it does well — inventing a scenario.
 *
 * Every sentence here is generated from `equilibriumSet` and the payoff matrix,
 * so it cannot disagree with them. Option labels are used when the caller has a
 * validated scenario; otherwise the generic Row/Col names are used.
 */
import type { GamePayoffs, ProseActionClaims, ScenarioBestReply } from '../types';
import { equilibriumSet, kindOf, EA, EB, fmtProb, type Rect } from './gameEngine';

export interface TieLabels { row1?: string; row2?: string; col1?: string; col2?: string }

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, ''));

/**
 * Probabilities, which must NEVER collapse onto a pure strategy.
 *
 * `num` prints 3 decimals, so a probability in (0, 0.0005) renders as "0" and
 * one in (0.9995, 1) as "1". `describe()` special-cases EXACT 0 and 1 to switch
 * to pure-strategy wording, so those words were meant to be unreachable for a
 * mixed coordinate — but the rounding produced them anyway, turning a mixed
 * equilibrium into a pure profile that is provably NOT an equilibrium.
 *
 * Found by an adversarial red team on A=[[3,0],[0,0.001]], B=[[1,3],[3,1]]:
 * y* = 1/3001 printed as "B plays Clean Cargo with probability 0", and at y=0
 * A strictly prefers Row 2 (0.001 > 0), so the stated profile is not an
 * equilibrium. Reachable from the UI — the payoff inputs are decimal and the
 * clamp is r3, and r3(0.001) = 0.001.
 *
 * The 1,081,804-rendering fuzz missed it because its corpus samples INTEGER
 * payoffs in [-9,9], where the smallest interior indifference root is 1/19 —
 * two orders of magnitude above the failure threshold. The verifier already
 * contained the "displayed 0/1 must BE 0/1" assertion; it never fired because
 * no input could reach it. The corpus was verified, not the renderer.
 */
const prob = fmtProb;   // the SAME formatter the solver's label uses

/**
 * Prose AND the declarations that back it, derived in ONE pass so they cannot
 * disagree. The template path used to publish `proseClaims: null`, which made
 * the DETERMINISTIC surface less verifiable than the model's: pushed through
 * the production gates its own true output was withheld in 13,200 of 53,512
 * renderings, every one the no-labels case, by the "makes a better-against
 * claim but declares no bestReplies" screen. It is also the channel round L15
 * measured empty from the other side (bestPays/altPays populated 0/46) — and
 * the renderer knows both payoffs exactly, because it prints them.
 */
export function tieProseFull(g: GamePayoffs, labelsIn?: TieLabels | null): { prose: string; claims: ProseActionClaims } {
  let labels: TieLabels | null | undefined = labelsIn;
  const raw = (k: 'row1' | 'row2' | 'col1' | 'col2') => labels?.[k]?.trim() ?? '';
  // Canonical Unicode normalisation before comparing. "Réserve" written as
  // e+U+0301 and as U+00E9 are byte-different but render identically, so a
  // byte comparison saw two distinct labels and skipped the generic fallback —
  // producing "against Réserve, B prefers Left; against Réserve, B prefers
  // Right", two mutually exclusive best replies against what reads as ONE
  // option. That is verbatim the T1 #110 ambiguity this screen exists to block.
  // Found by an adversarial red team; ZWSP and homoglyph variants behave the
  // same way, so the key also strips zero-width characters.
  // NFC does NOT fold confusables: Cyrillic А (U+0410), Greek ο (U+03BF) and
  // Turkish ı (U+0131) survive normalisation and read as their Latin twins, so
  // "Attack" vs "Аttack" still slipped the duplicate screen. My earlier comment
  // claimed homoglyphs were covered; a red team showed they were not. Fold the
  // common confusable ranges to their Latin skeleton for COMPARISON only —
  // display always uses the author's original text.
  const CONFUSABLE: Record<string, string> = {
    '\u0410': 'a', '\u0412': 'b', '\u0421': 'c', '\u0415': 'e', '\u041d': 'h', '\u041a': 'k',
    '\u041c': 'm', '\u041e': 'o', '\u0420': 'p', '\u0422': 't', '\u0425': 'x', '\u0430': 'a',
    '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y',
    '\u0391': 'a', '\u0392': 'b', '\u0395': 'e', '\u0396': 'z', '\u0397': 'h', '\u0399': 'i',
    '\u039a': 'k', '\u039c': 'm', '\u039d': 'n', '\u039f': 'o', '\u03a1': 'p', '\u03a4': 't',
    '\u03bf': 'o', '\u03b1': 'a', '\u0131': 'i', '\u0130': 'i', '\u04cf': 'l', '\u0405': 's',
  };
  const norm = (x?: string) => (x ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\u0000-\u007F]/g, (ch) => CONFUSABLE[ch] ?? ch)
    .trim().toLowerCase();
  // When the two players share an option word ("Light schedule" for both), a
  // bare label cannot say whose option it is; qualify every name with its
  // owner so no sentence is ambiguous.
  const shared = [raw('row1'), raw('row2')].some((r) => r && [raw('col1'), raw('col2')].map(norm).includes(norm(r)));
  // Bare names are used where the subject already names the player ("A prefers
  // Light schedule"); qualified names are used for the OPPONENT's option in an
  // "against X" frame, which is the only place the two could be confused.
  const rowBare = (o: 1 | 2) => raw(o === 1 ? 'row1' : 'row2') || `Row ${o}`;
  const colBare = (o: 1 | 2) => raw(o === 1 ? 'col1' : 'col2') || `Col ${o}`;
  const rowName = (o: 1 | 2) => (raw(o === 1 ? 'row1' : 'row2') && shared ? `A's ${rowBare(o)}` : rowBare(o));
  const colName = (o: 1 | 2) => (raw(o === 1 ? 'col1' : 'col2') && shared ? `B's ${colBare(o)}` : colBare(o));
  const aPay = (r: 1 | 2, c: 1 | 2) => (r === 1 ? (c === 1 ? g.a11 : g.a12) : c === 1 ? g.a21 : g.a22);
  const bPay = (r: 1 | 2, c: 1 | 2) => (r === 1 ? (c === 1 ? g.b11 : g.b12) : c === 1 ? g.b21 : g.b22);
  const sentences: string[] = [];
  const bestReplies: ScenarioBestReply[] = [];
  const equilibriumActions: { player: 'A' | 'B'; option: number }[] = [];
  const nameAction = (player: 'A' | 'B', option: 1 | 2) => {
    if (!equilibriumActions.some((e) => e.player === player && e.option === option)) equilibriumActions.push({ player, option });
  };
  // If a player's two labels are identical the rendered clauses cannot be told
  // apart ("against Comply, B prefers Report; against Comply, B prefers
  // Conceal" — T1 #110), and a label carrying digits collides with the payoff
  // numbers beside it (#101, #104). In either case fall back to the generic
  // names, which are always unambiguous.
  // A label containing ';' or ',' collides with the clause separators below —
  // and so do the WORDS " and " / " while ", which separate the two halves of
  // every equilibrium component ("A plays Cut and run and B plays Retreat" —
  // found by _gen/verify_tieprose.ts, which could not parse its own output).
  // Same screen, one class wider.
  const punct = (x?: string) => /[;,]/.test(x ?? '') || /\s(?:and|while)\s/i.test(x ?? '');
  if ([labels?.row1, labels?.row2, labels?.col1, labels?.col2].some(punct)) labels = null;
  const dup = (x?: string, y?: string) => !!x && norm(x) === norm(y);
  const digity = (x?: string) => /\d/.test(x ?? '');
  // Naming is ALL-OR-NOTHING by design (see the header): a PARTIAL label set
  // made one paragraph mix vocabularies — "against Row 1, B earns -1 from
  // either column ... against Cooperate, A prefers Defect" — because each
  // option fell back on its own. Nothing false, but the reader is handed two
  // naming schemes at once. If any of the four is missing, use generics for all.
  const blank = (x?: string) => !(x ?? '').trim();
  const unusable = dup(labels?.row1, labels?.row2) || dup(labels?.col1, labels?.col2)
    || [labels?.row1, labels?.row2, labels?.col1, labels?.col2].some(digity)
    || (labels != null && [labels.row1, labels.row2, labels.col1, labels.col2].some(blank));
  if (unusable) labels = null;

  // 1. Where the ties are — the fact the model gets wrong most often, stated
  //    against the opponent option it actually holds for.
  const ties: string[] = [];
  for (const c of [1, 2] as const) {
    if (aPay(1, c) === aPay(2, c)) ties.push(`against ${colName(c)}, A earns ${num(aPay(1, c))} from either row`);
  }
  for (const r of [1, 2] as const) {
    if (bPay(r, 1) === bPay(r, 2)) ties.push(`against ${rowName(r)}, B earns ${num(bPay(r, 1))} from either column`);
  }
  // The clause about equilibria "beyond isolated points" is only true when the
  // equilibrium set actually HAS a non-point component. A tie does not always
  // produce one: round L7 draw 54 shipped that claim on a game whose entire
  // equilibrium set is the single point (0, 0). Correct-by-construction only
  // covers what is derived — an editorial generalisation has to be derived too.
  const hasContinuum = equilibriumSet(g).some((r) => kindOf(r) !== 'point');
  if (ties.length) {
    // "that player" is singular; a game can tie for BOTH players (round T1).
    const tiedPlayers = new Set<string>();
    for (const c of [1, 2] as const) if (aPay(1, c) === aPay(2, c)) tiedPlayers.add('A');
    for (const r of [1, 2] as const) if (bPay(r, 1) === bPay(r, 2)) tiedPlayers.add('B');
    const who = tiedPlayers.size > 1 ? 'each of them is indifferent where its own payoffs tie' : 'that player is indifferent there';
    sentences.push(`This game contains a payoff tie: ${ties.join('; ')} — so ${who}${hasContinuum ? ', and the tie is what admits equilibria beyond isolated points' : ''}.`);
  }

  // 2. Strict preferences, one clause per (player, opponent option) that is NOT a tie.
  const strict: string[] = [];
  for (const c of [1, 2] as const) {
    if (aPay(1, c) === aPay(2, c)) continue;
    const better = aPay(1, c) > aPay(2, c) ? 1 : 2;
    const other = (3 - better) as 1 | 2;
    strict.push(`against ${colName(c)}, A prefers ${rowBare(better)} (${num(aPay(better, c))} rather than ${num(aPay(other, c))})`);
    bestReplies.push({ player: 'A', opponentOption: c, bestOption: better, bestPays: aPay(better, c), altPays: aPay(other, c) });
  }
  for (const r of [1, 2] as const) {
    if (bPay(r, 1) === bPay(r, 2)) continue;
    const better = bPay(r, 1) > bPay(r, 2) ? 1 : 2;
    const otherB = (3 - better) as 1 | 2;
    strict.push(`against ${rowName(r)}, B prefers ${colBare(better)} (${num(bPay(r, better))} rather than ${num(bPay(r, otherB))})`);
    bestReplies.push({ player: 'B', opponentOption: r, bestOption: better, bestPays: bPay(r, better), altPays: bPay(r, otherB) });
  }
  if (strict.length) {
    // "Elsewhere" only reads correctly after a tie sentence; on a game with no
    // ties at all it is a dangling reference.
    sentences.push(`${ties.length ? 'Elsewhere the choice is strict' : 'Each player has a strict best reply'}: ${strict.join('; ')}.`);
  }

  // 3. The equilibrium set, continua included.
  const set = equilibriumSet(g);
  const describe = (r: Rect): string => {
    // UNREACHABLE as the code stands: a full-space component cannot have
    // siblings (it contains them), and the single-component case is rendered by
    // the standalone sentence below — mutation testing proved this branch is an
    // equivalent mutant, the third unreachable-clause finding in this codebase
    // after C24/C25. Kept, but worded to read correctly INSIDE the list frame
    // ("The equilibrium set is 2 components: every pair ... qualifies; ...")
    // so that a future change to `equilibriumSet` cannot make it emit nonsense.
    // `testTieProse` asserts the invariant that keeps it unreachable.
    if (kindOf(r) === 'area') return 'every pair of mixtures in the whole strategy space qualifies';
    if (kindOf(r) === 'point') {
      const xPart = r.x0 === 1 ? (nameAction('A', 1), `A plays ${rowBare(1)}`) : r.x0 === 0 ? (nameAction('A', 2), `A plays ${rowBare(2)}`) : (nameAction('A', 1), `A plays ${rowBare(1)} with probability ${prob(r.x0)}`);
      const yPart = r.y0 === 1 ? (nameAction('B', 1), `B plays ${colBare(1)}`) : r.y0 === 0 ? (nameAction('B', 2), `B plays ${colBare(2)}`) : (nameAction('B', 1), `B plays ${colBare(1)} with probability ${prob(r.y0)}`);
      return `${xPart} and ${yPart}`;
    }
    if (r.x1 - r.x0 < 1e-9) {
      const xPart = r.x0 === 1 ? (nameAction('A', 1), `A plays ${rowBare(1)}`) : r.x0 === 0 ? (nameAction('A', 2), `A plays ${rowBare(2)}`) : (nameAction('A', 1), `A plays ${rowBare(1)} with probability ${prob(r.x0)}`);
      const yPart = r.y0 === 0 && r.y1 === 1
        ? 'B plays any mixture at all'
        : (nameAction('B', 1), `B plays ${colBare(1)} with any probability from ${prob(r.y0)} to ${prob(r.y1)}`);
      return `${xPart} while ${yPart}`;
    }
    const yPart = r.y0 === 1 ? (nameAction('B', 1), `B plays ${colBare(1)}`) : r.y0 === 0 ? (nameAction('B', 2), `B plays ${colBare(2)}`) : (nameAction('B', 1), `B plays ${colBare(1)} with probability ${prob(r.y0)}`);
    const xPart = r.x0 === 0 && r.x1 === 1
      ? 'A plays any mixture at all'
      : (nameAction('A', 1), `A plays ${rowBare(1)} with any probability from ${prob(r.x0)} to ${prob(r.x1)}`);
    return `${yPart} while ${xPart}`;
  };
  if (set.length) {
    const parts = set.map(describe);
    const continua = set.filter((r) => kindOf(r) !== 'point').length;
    sentences.push(
      (kindOf(set[0]) === 'area' && set.length === 1
        ? 'Every pair of mixtures in the whole strategy space is an equilibrium.'
        : `The equilibrium set is ${parts.length === 1 ? '' : `${parts.length} components: `}${parts.join('; ')}.`)
      + (continua ? ' A continuum like this is why the corner-by-corner reading of the game is incomplete here.' : ''),
    );
  }

  // 4. Payoffs at one representative equilibrium, from the same solver.
  const rep = set[0];
  if (rep) {
    const x = (rep.x0 + rep.x1) / 2, y = (rep.y0 + rep.y1) / 2;
    const many = set.length > 1;
    const where = kindOf(rep) === 'point'
      ? (many ? 'At the first of these' : 'At that equilibrium')
      : (many ? 'At a representative point of the first component' : 'At a representative point of it');
    sentences.push(`${where} the expected payoffs are E[A] = ${num(EA(x, y, g))} and E[B] = ${num(EB(x, y, g))}.`);
  }
  return { prose: sentences.join(' '), claims: { equilibriumActions, bestReplies } };
}

/** The rendered paragraph alone. */
export function tieProse(g: GamePayoffs, labelsIn?: TieLabels | null): string {
  return tieProseFull(g, labelsIn).prose;
}

/** The declarations backing that paragraph, for the same game and labels. */
export function tieProseClaims(g: GamePayoffs, labelsIn?: TieLabels | null): ProseActionClaims {
  return tieProseFull(g, labelsIn).claims;
}

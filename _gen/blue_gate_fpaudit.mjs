/**
 * BLUE-GATE — WHAT EVERY SCREEN FIRES ON, printed so it can be hand-read.
 *
 * This harness answers ONE question and refuses to summarise it away: for each
 * predicate, WHICH rows does it reject and WHAT TEXT made it fire. Two screens
 * in this repo were 100% false positive for weeks (`truncated` on a curly close
 * quote, `articleDisagreement` on a case-insensitive `\ba` matching the player
 * letter) and neither was caught by reasoning about the regex. They were caught
 * by reading the matches.
 *
 * So: no rate is printed without its matches, and every rule prints the SPAN it
 * matched, not just the row.
 *
 *   npx tsx _gen/blue_gate_fpaudit.mjs [rule-name-substring]
 */
import { loadCorpus, loadBank, describe } from './blue_gate_corpus.mjs';
import { SCREENS, personaLeak, metaLeak, labelCollision, duplicateOptions, articleDisagreement, foreignScript, truncated } from './trainset_screens.ts';
import { exposureAsymmetryClaim } from './bank_screens.ts';
import { scenarioIsClaimFree, validateScenario, validateProseDirections } from '../src/utils/nashValidator.ts';

const filter = process.argv[2] ?? '';
const SHOW = Number(process.env.SHOW ?? 12);

const { rows, stats } = loadCorpus();
console.log(describe(stats));
const bank = loadBank().map((e) => ({ src: 'SHIPPED_BANK', sc: e.s, g: null, domain: e.d }));
console.log(`shipped bank: ${bank.length} rows\n`);

/** Pools a rule is measured over. Every rule is measured over BOTH. */
const POOLS = [['CORPUS', rows], ['SHIPPED_BANK', bank]];

/**
 * A rule reports the SPAN that made it fire, so a hand-read does not require
 * re-deriving the regex. A boolean-only screen returns the description.
 */
const RULES = [
  ['screen/foreign-script', (sc) => (foreignScript(sc) ? spanOf(/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{White_Space}\p{Symbol}\p{Mark}]/u, allFields(sc)) : null)],
  ['screen/persona', (sc) => (personaLeak(sc) ? (spanOf(/\bplayers?\s+[AB]\b/i, sc.description ?? '') ?? spanOf(new RegExp(`(?<![A-Za-z]\\s)\\b[AB]\\s+(is|are|was|chooses|picks|selects|decides|must|will|can|has|holds|runs|operates|plans)\\b`), sc.description ?? '')) : null)],
  ['screen/meta', (sc) => (metaLeak(sc) ? (spanOf(/\bplayers?\b/i, allFields(sc)) ?? spanOf(/\b(the|this) game\b/i, sc.description ?? '') ?? 'META_HARD') : null)],
  ['screen/truncated', (sc) => (truncated(sc) ? `…${(sc.description ?? '').trim().slice(-60)}` : null)],
  ['screen/label-collision', (sc) => (labelCollision(sc) ? `${sc.row1}|${sc.row2} vs ${sc.col1}|${sc.col2}` : null)],
  ['screen/duplicate-options', (sc) => (duplicateOptions(sc) ? `${sc.row1}|${sc.row2} / ${sc.col1}|${sc.col2}` : null)],
  ['screen/article', (sc) => (articleDisagreement(sc) ? articleSpan(sc.description ?? '') : null)],
  ['bank/exposure-asymmetry', (sc) => (exposureAsymmetryClaim(sc) ? exposureSpan(sc.description ?? '') : null)],
  ['gate/claim-free', (sc) => { const r = scenarioIsClaimFree(sc); return r.ok ? null : r.reason; }],
  ['gate/validateScenario', (sc, g) => { if (!g) return null; const v = validateScenario(sc, g); return v.ok ? null : v.issues.join(' | '); }],
  ['gate/directions', (sc, g) => { if (!g) return null; const d = validateProseDirections(sc.description ?? '', { row1: sc.row1, row2: sc.row2, col1: sc.col1, col2: sc.col2 }, g); return d.length ? d[0] : null; }],
];

function allFields(sc) {
  return [sc.name, sc.row1, sc.row2, sc.col1, sc.col2, sc.description].filter(Boolean).join(' • ');
}
function spanOf(re, t) {
  const m = re.exec(t);
  if (!m) return null;
  const i = m.index;
  return `…${t.slice(Math.max(0, i - 45), i)}[[${m[0]}]]${t.slice(i + m[0].length, i + m[0].length + 45)}…`;
}
/** Re-derive which article match fired, so the hit can be read without the regex. */
function articleSpan(t) {
  const A_BEFORE_VOWEL = /(?:\ba|(?:^|[.!?;:]["”’']?\s+)A)\s+([aeiou][\w-]*)/g;
  const NOT_AN_ARTICLE = /^(?:and|or|is|are|was|chooses|picks|selects|decides|must|will|can|has|holds|runs|operates|plans)$/i;
  const CONS = /^(?:uni|unan|usa|use|usu|uti|ute|utop|ubiq|ukul|eu|once|one)/;
  for (const m of t.matchAll(A_BEFORE_VOWEL)) {
    const w = m[1];
    if (w.length < 2 || NOT_AN_ARTICLE.test(w) || CONS.test(w)) continue;
    return spanOf(new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), t);
  }
  return spanOf(/\ban\s+(?![aeiouAEIOU]|hour|honest|honou?r)[bcdfgjklmnpqrstvwxyz]\w/i, t);
}
function exposureSpan(t) {
  // Re-run each alternative separately so the hit names the CLAUSE responsible.
  const alts = ['riding on', 'at stake', 'at risk', 'on the line', 'stands? to (lose|gain|win)',
    '(more|less|greater|little|much|greatest|larger|higher|lower|heavier|most|least)[^.]{0,30}?expos(ure|ed)',
    'expos(ure|ed) [^.]{0,40} than', 'heavily (exposed|tied|dependent|reliant)', 'whose (exposure|stake|risk|position)',
    'matters? (far |much |a lot |significantly |a great deal )?(more|less)\\b',
    '(far|much|considerably|significantly|rather) (more|less) (consequential|important|significant|costly|damaging|serious)',
    'weighs? (more|less|heavil)', '(more|less|little|much|a lot|a great deal) to (lose|gain)',
    '(bears?|carries|carry|carrying) (the |a )?(greater|larger|bigger|brunt|heavier)',
    '(more|less|greater|smaller|larger) (at stake|consequence)', '(smaller|larger|bigger|greater|lesser) \\w+ stake',
    '(more|less) of (the|its|their) \\w+', '(depends?|depend|relies?|rely) heavily', 'tied (closely|heavily)',
    'hinges? (heavily )?on', 'for whom (this|that|the|it)', 'only a (small|minor|modest|slight|brief|short)',
    '(smaller|larger|bigger|greater) (scheduling |financial |commercial |seasonal )?(stake|interest|exposure)',
    '\\b(much|most|the bulk) of its\\b'];
  for (const a of alts) {
    const s = spanOf(new RegExp(a, 'i'), t);
    if (s) return `{${a}} ${s}`;
  }
  return null;
}

for (const [name, fn] of RULES) {
  if (filter && !name.includes(filter)) continue;
  for (const [poolName, pool] of POOLS) {
    const hits = [];
    for (const r of pool) {
      let span = null;
      try { span = fn(r.sc, r.g); } catch (e) { span = `THREW: ${e.message}`; }
      if (span) hits.push({ r, span });
    }
    const pct = pool.length ? (100 * hits.length / pool.length).toFixed(2) : '—';
    console.log(`\n=== ${name} on ${poolName}: ${hits.length}/${pool.length} (${pct}%) ===`);
    // Group by the span shape so a hand-read covers classes, not repetitions.
    const byShape = new Map();
    for (const h of hits) {
      const k = String(h.span).replace(/…[^[]*\[\[/, '[[').replace(/\]\][^…]*…/, ']]').slice(0, 90);
      if (!byShape.has(k)) byShape.set(k, []);
      byShape.get(k).push(h);
    }
    const shapes = [...byShape.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log(`    ${shapes.length} distinct match shapes`);
    for (const [k, hs] of shapes.slice(0, SHOW)) {
      console.log(`  x${String(hs.length).padStart(4)}  ${k}`);
      console.log(`         e.g. [${hs[0].r.src}] ${String(hs[0].span).slice(0, 200)}`);
    }
    if (shapes.length > SHOW) console.log(`  … ${shapes.length - SHOW} more shapes`);
  }
}

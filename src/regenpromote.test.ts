/**
 * BLUE-LOOP-REGEN-21, Amendment 2: the empty-sweep angles that live in PURE
 * predicate space, promoted out of _gen/ so CI protects them. Each block names
 * the probe it replaces and the MUTANT that proves it can fail.
 *
 * Probes promoted here: s3b-keepfill-property, s1-inv1-taxonomy-xprod,
 * s1-inv1b-interp, s1-a4x-allfields (its clamp core), s5b-crossdialog,
 * s6b-blastradius, s11-newangles (L/M/N).
 */
import {
  REGEN_ERROR_MESSAGES, REGEN_SERVER_TEXT_MAX, regenErrorFromResponse,
  REGEN_NAME_MAX, REGEN_LABEL_MAX, REGEN_DESCRIPTION_MAX,
  keepFill, cleanPreview, previewIsUsable, regenKeyEquals, regenResponseIsCurrent,
  type RegenErrorKind, type RegenPreview,
} from './utils/scenarioRegen';
import { termOccursIn, cleanUserColorTerms, USER_TERMS_MAX } from './utils/colorTerms';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const seg = (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);

// ─────────────────────────────────────────────────────────────────────────
// A. keepFill PROPERTY SWEEP (was _gen/blregen-s3b-keepfill-property.mts,
//    4000 cases, 0 violations). Cut to a CI-sized deterministic run: a
//    seeded LCG, 600 cases. That covers every generator branch below many
//    times over (5 clamp regimes x 4 chip regimes x 3 label regimes); the
//    original 4000 found nothing the first 600 did not.
//    MUTANT: make keepFill judge orphans against the RAW description
//    (pre-clamp) and the orphan-honesty property fails.
// ─────────────────────────────────────────────────────────────────────────
let s = 20260915;
// Math.imul, not `*`: s * 1103515245 exceeds MAX_SAFE_INTEGER and JS drops
// the low bits before the mask (reviewer finding, verified).
const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
const CLUSTERS = ['\u{1F1FA}\u{1F1F8}', '\u{1F468}‍\u{1F469}‍\u{1F467}', '\u{1F44D}\u{1F3FD}', 'é', '❤️'];
const NOUNS = ['the dock crew', 'the baker', 'the tug company', 'the night shift', 'a courier'];
const FILLER = 'The two neighboring workshops negotiate a routine scheduling matter. ';

let violations: string[] = [];
const seen = { labelClamped: 0, orphaned: 0, dropped: 0, shadowed: 0 };
for (let i = 0; i < 600; i++) {
  const padTo = pick([0, 100, REGEN_DESCRIPTION_MAX - 3, REGEN_DESCRIPTION_MAX + 50, REGEN_DESCRIPTION_MAX * 2]);
  let desc = '';
  while (desc.length < padTo) desc += FILLER;
  desc = desc.slice(0, padTo);
  const nounA = pick(NOUNS), nounB = pick(NOUNS);
  if (rnd() < 0.5) desc = nounA + ' meets ' + nounB + '. ' + desc;
  if (rnd() < 0.4) desc += pick(CLUSTERS) + 'TAIL';
  const preview: RegenPreview = {
    name: 'Draw ' + i, description: desc,
    // Labels must STRADDLE their own 40-unit budget, or the clamp is never
    // exercised on them (reviewer finding: the old values were <= 16 chars, so
    // only `desc` was ever clamped).
    row1: pick(['Load Now', 'Load the barge early '.repeat(3) + pick(CLUSTERS)]),
    row2: pick(['Load Later', 'Hold the berth until the tide turns ' + pick(CLUSTERS)]),
    col1: pick(['Send Tug', 'Send the harbour tug out at once ' + pick(CLUSTERS)]),
    col2: pick(['Hold Tug', 'Keep the tug alongside the quay ' + pick(CLUSTERS)]),
    actorA: rnd() < 0.7 ? [nounA] : [], actorB: rnd() < 0.7 ? [nounB] : [],
  } as RegenPreview;
  // One arm makes an existing chip a SUBSTRING of the OTHER side's option label,
  // which is what `shadowed` actually requires: the longer span claims those
  // words, so the short chip paints nothing of its own. (Reviewer finding:
  // shadowed was 0 across all 600 cases; colliding with the other side's NOUN
  // is not enough — that reads as 'painted'.)
  const shadowArm = rnd() < 0.3;
  if (shadowArm) { preview.row1 = 'the harbour tug crew'; preview.description = 'The harbour tug crew waits while the barge loads early. ' + desc; }
  const existing = {
    a: rnd() < 0.5 ? ['the old crew'] : [],
    b: shadowArm ? ['tug crew']
      : rnd() < 0.3 ? Array.from({ length: USER_TERMS_MAX }, (_, k) => 'chip ' + k) : [],
  };
  const k = keepFill(preview, rnd() < 0.5, existing);

  // P1. Every stored field is inside its own budget, and no budget cut a
  // grapheme cluster in half (the clamp is grapheme-safe by contract).
  const fields: [string, string, number][] = [
    ['desc', k.desc, REGEN_DESCRIPTION_MAX], ['row1', k.labels.row1, REGEN_LABEL_MAX],
    ['row2', k.labels.row2, REGEN_LABEL_MAX], ['col1', k.labels.col1, REGEN_LABEL_MAX],
    ['col2', k.labels.col2, REGEN_LABEL_MAX],
  ];
  if (k.name !== undefined) fields.push(['name', k.name, REGEN_NAME_MAX]);
  for (const [fname, v, budget] of fields) {
    if (v.length > budget) violations.push(`case ${i} ${fname}: ${v.length} > ${budget}`);
    // A clamp that split a cluster leaves a tail that is NOT a whole cluster
    // of the source: re-segmenting the value must reproduce a prefix of the
    // source's own cluster sequence.
    // Each field is checked against ITS OWN source, not just `desc`.
    const src = fname === 'desc' ? String(preview.description ?? '')
      : fname === 'row1' ? String(preview.row1 ?? '')
      : fname === 'row2' ? String(preview.row2 ?? '')
      : fname === 'col1' ? String(preview.col1 ?? '')
      : fname === 'col2' ? String(preview.col2 ?? '')
      : fname === 'name' ? String(preview.name ?? '') : '';
    if (src) {
      const srcClusters = seg(src), outClusters = seg(v);
      for (let c = 0; c < outClusters.length; c++) {
        if (outClusters[c] !== srcClusters[c]) { violations.push(`case ${i} ${fname}: cluster ${c} split`); break; }
      }
    }
  }
  for (const v of [k.labels.row1, k.labels.row2, k.labels.col1, k.labels.col2]) {
    if (v.length >= REGEN_LABEL_MAX - 2) seen.labelClamped++;
  }
  seen.orphaned += k.orphaned.a.length + k.orphaned.b.length;
  seen.dropped += k.dropped.a.length + k.dropped.b.length;
  seen.shadowed += k.shadowed.a.length + k.shadowed.b.length;
  // P2. ORPHAN HONESTY: a chip reported orphaned must really not occur in the
  // FINAL description, and a kept chip that does occur must not be reported.
  for (const side of ['a', 'b'] as const) {
    for (const t of k.orphaned[side]) {
      if (termOccursIn(k.desc, t)) violations.push(`case ${i}: "${t}" called orphaned but occurs`);
      if (!k.terms[side].includes(t)) violations.push(`case ${i}: "${t}" orphaned but not kept`);
    }
    for (const t of k.terms[side]) {
      if (!termOccursIn(k.desc, t) && !k.orphaned[side].includes(t)
          && !k.shadowed[side].some((x) => x.term === t)) {
        violations.push(`case ${i}: "${t}" kept, absent, and unannounced`);
      }
    }
    // P3. The per-side cap is never exceeded, and a dropped term is never also kept.
    if (k.terms[side].length > USER_TERMS_MAX) violations.push(`case ${i}: ${side} over cap`);
    for (const d of k.dropped[side]) {
      if (k.terms[side].includes(d)) violations.push(`case ${i}: "${d}" both dropped and kept`);
    }
  }
}
check('keepFill property sweep (seed 20260915, 600 cases): clamps are grapheme-safe, orphans are honest, caps hold',
  violations.length === 0, violations.slice(0, 3).join(' | '));
// COVERAGE, not just correctness: "0 violations" is only meaningful if the sweep
// actually reached each announced state. Each of these was silently 0 at some
// point while the sweep still reported success.
check('the sweep really exercised the label clamp, orphaned, dropped AND shadowed states',
  seen.labelClamped > 0 && seen.orphaned > 0 && seen.dropped > 0 && seen.shadowed > 0,
  JSON.stringify(seen));
// CONTROL: the property predicate must FIRE on a deliberately inconsistent
// shape, or "0 violations" could mean it never looks at anything.
{
  const lying = { desc: 'nothing here', terms: { a: ['the baker'] }, orphaned: { a: [] }, shadowed: { a: [] } };
  const caught = !termOccursIn(lying.desc, 'the baker')
    && !lying.orphaned.a.includes('the baker') && !lying.shadowed.a.some(() => true);
  check('control: the orphan-honesty predicate fires on a kept-but-absent-and-unannounced chip', caught);
}

// ─────────────────────────────────────────────────────────────────────────
// B. ERROR TAXONOMY CROSS-PRODUCT (was s1-inv1-taxonomy-xprod + s1-inv1b-interp
//    + s11 L/M/N). Every wire shape maps to a DECLARED kind, and the mapping
//    is total: no status/body pair yields something outside the union.
//    MUTANT: make regenErrorFromResponse return 'game-gone' for a 404 and the
//    client-only row fails.
// ─────────────────────────────────────────────────────────────────────────
const kinds = Object.keys(REGEN_ERROR_MESSAGES) as RegenErrorKind[];
const STATUSES = [0, 200, 400, 401, 403, 404, 408, 409, 418, 429, 500, 502, 503, 504];
const BODIES: unknown[] = [null, {}, { error: 'x' }, { error: '' }, { error: { deep: 1 } },
  { scenario: null }, { scenario: null, failure: 'no-key' }, { scenario: null, failure: 'no-story' },
  { scenario: null, failure: 'wat' }, { scenario: { name: 'n' } }, { failure: 'no-key' }];
let undeclared = 0, threw = 0;
for (const st of STATUSES) for (const b of BODIES) {
  let k: RegenErrorKind;
  try { k = regenErrorFromResponse(st, b as never, null); } catch { threw++; continue; }
  if (!kinds.includes(k)) undeclared++;
}
check(`every (status x body) pair maps to a DECLARED kind (${STATUSES.length * BODIES.length} pairs)`,
  undeclared === 0 && threw === 0, `undeclared=${undeclared} threw=${threw}`);
check("a wire 404 is never reported as 'game-gone' (that kind is routed client-side only)",
  regenErrorFromResponse(404, { error: 'Not enabled.' }, null) !== 'game-gone');
// An AbortError is the ONLY thing that may read as a timeout.
check("an AbortError maps to 'timeout'",
  regenErrorFromResponse(null, null, new DOMException('aborted', 'AbortError')) === 'timeout');
check("an ordinary Error does NOT map to 'timeout'",
  regenErrorFromResponse(null, null, new Error('boom')) !== 'timeout');

// B2. A 200 that carried no usable story is a DRAW failure, not a network one.
//     Telling the user "Couldn't reach the scenario service" about a request
//     that plainly succeeded is a lie they cannot act on (reviewer finding).
//     MUTANT: restore `body.scenario === null` as the test -> these rows fail.
for (const [label, body] of [
  ['non-string description', { scenario: { description: 123 } }],
  ['empty object', { scenario: {} }],
  ['labels lost at the boundary', { scenario: { name: 'N', description: 'A story.', row1: 7 } }],
] as [string, unknown][]) {
  check(`a 200 carrying an unusable scenario (${label}) is 'no-story', never 'network'`,
    regenErrorFromResponse(200, body as never, null) === 'no-story',
    regenErrorFromResponse(200, body as never, null));
}
check("a 200 with scenario:null and failure:'no-key' is still 'no-key' (the permanent kind is not swallowed)",
  regenErrorFromResponse(200, { scenario: null, failure: 'no-key' } as never, null) === 'no-key');
// CONTROLS: a real network failure must STILL be 'network', or the rule above
// could just rename every error and pass for the wrong reason.
check("control: a transport failure is still 'network'",
  regenErrorFromResponse(null, null, new TypeError('fetch failed')) === 'network');
check("control: a 500 is still 'network'", regenErrorFromResponse(500, {} as never, null) === 'network');

// B3. keepFill must LEAVE THE NAME ALONE when the draw has no usable name —
//     its own KeptFill contract. saveFormModel does `action.name ?? state.name`,
//     so an empty string would wipe the user's game name instead of falling back.
//     MUTANT: `out.name = clampGraphemeSafe(cleanText(preview.name ?? ''), ...)`
//     unconditionally -> the absent-name row fails.
{
  const base = { description: 'A real story.', row1: 'a', row2: 'b', col1: 'c', col2: 'd' };
  check('a draw with NO name leaves the name field alone (never blanks it)',
    keepFill({ ...base } as never, true, { a: [], b: [] }).name === undefined);
  check('a draw with a non-string name leaves the name field alone',
    keepFill({ ...base, name: 42 } as never, true, { a: [], b: [] }).name === undefined);
  check('control: a draw WITH a real name still replaces it',
    keepFill({ ...base, name: 'Fresh Story' } as never, true, { a: [], b: [] }).name === 'Fresh Story');
  check('control: replaceName=false never sets a name at all',
    keepFill({ ...base, name: 'Fresh Story' } as never, false, { a: [], b: [] }).name === undefined);
}

// C. Purity: the message functions hold no state (was s11 angle M).
//    MUTANT: memoise serverSaid across calls and the interleaved rounds diverge.
let drift = 0;
for (let i = 0; i < 40; i++) for (const k of kinds) {
  if (REGEN_ERROR_MESSAGES[k]('steady') !== REGEN_ERROR_MESSAGES[k]('steady')) drift++;
  if (REGEN_ERROR_MESSAGES[k]('other') === REGEN_ERROR_MESSAGES[k]('steady') && k === 'rate-limit') drift++;
}
check('every message function is pure: 40 interleaved rounds are identical, and rate-limit still varies with its input',
  drift === 0, `drift=${drift}`);

// D. STALENESS (was s5b-crossdialog + s6b-blastradius, pure core). A response
//    is current only for the generation that asked AND the key it asked for.
//    MUTANT: drop the key comparison from regenResponseIsCurrent and the
//    cross-dialog row fails.
const keyA = { kind: 'edit', gameId: 'g1' } as const;
const keyB = { kind: 'edit', gameId: 'g2' } as const;
check('regenKeyEquals separates two different games', !regenKeyEquals(keyA, keyB));
check('regenKeyEquals matches the same game', regenKeyEquals(keyA, { kind: 'edit', gameId: 'g1' }));
check('a response for ANOTHER dialog key is not current',
  !regenResponseIsCurrent({ myGen: 1, currentGen: 1, requestKey: keyA, currentKey: keyB }));
check('a response from an older generation is not current',
  !regenResponseIsCurrent({ myGen: 1, currentGen: 2, requestKey: keyA, currentKey: keyA }));
check('a response for the same generation AND key IS current',
  regenResponseIsCurrent({ myGen: 2, currentGen: 2, requestKey: keyA, currentKey: keyA }));

// E. cleanPreview is total: no input shape throws, and nothing non-string
//    survives into a field the dialog will render.
let previewBad = 0;
for (const junk of [null, undefined, {}, { name: 1 }, { description: {} }, { row1: [] },
  { actorA: 'not-an-array' }, { actorA: [1, 2] }, { col2: { toString() { throw new Error('x'); } } }]) {
  let out: ReturnType<typeof cleanPreview>;
  try { out = cleanPreview(junk as never); } catch { previewBad++; continue; }
  if (!out) continue;
  for (const v of [out.name, out.description, out.row1, out.row2, out.col1, out.col2]) {
    if (v !== undefined && typeof v !== 'string') previewBad++;
  }
  if (out.actorA !== undefined && !Array.isArray(out.actorA)) previewBad++;
    if (out.actorB !== undefined && !Array.isArray(out.actorB)) previewBad++;
}
check('cleanPreview is total: no shape throws and every rendered field is a string or absent', previewBad === 0, `bad=${previewBad}`);

// E2. A draw that survived the boundary only PARTLY is not usable. Dropping a
//     bad field keeps the rest, so a draw could otherwise keep its story, lose
//     its labels, render "A:  / " and blank all four labels on Keep.
//     MUTANT: weaken previewIsUsable to test the description alone -> row fails.
{
  const partial = cleanPreview({ description: 'A real story about the orchard.', name: 'Ok',
    row1: 123, row2: {}, col1: [], col2: null } as never);
  check('a draw that lost its option labels at the boundary is NOT usable (Keep would blank all four)',
    partial !== null && !previewIsUsable(partial), JSON.stringify(partial));
  // CONTROL: a complete draw must still be usable, or the rule above would just
  // reject everything and the check would pass for the wrong reason.
  const whole = cleanPreview({ description: 'A real story.', name: 'Ok',
    row1: 'a', row2: 'b', col1: 'c', col2: 'd' } as never);
  check('control: a COMPLETE draw is still usable (the rule rejects the partial one, not everything)',
    whole !== null && previewIsUsable(whole));
}

// F. cleanUserColorTerms never returns something the cap/key rules reject.
let termBad = 0;
for (const junk of [null, undefined, 'str', 42, [''], ['  '], ['a'], ['a b'], Array.from({ length: 50 }, (_, i) => 'term ' + i),
  ['x'.repeat(500)], [{ nope: 1 }], ['dup', 'dup', 'DUP']]) {
  const out = cleanUserColorTerms(junk as never);
  if (!Array.isArray(out)) { termBad++; continue; }
  if (out.length > USER_TERMS_MAX) termBad++;
  if (out.some((t) => typeof t !== 'string' || t.trim() === '')) termBad++;
  if (new Set(out.map((t) => t.toLowerCase())).size !== out.length) termBad++;
}
check('cleanUserColorTerms always returns a capped, non-blank, de-duplicated string list', termBad === 0, `bad=${termBad}`);

// G. REGEN_SERVER_TEXT_MAX is the bound the rate-limit note actually applies.
{
  const flooded = REGEN_ERROR_MESSAGES['rate-limit']('y'.repeat(5000));
  const quoted = flooded.replace(/^AI limit reached — /, '');
  // Both halves, or the row passes on a mutant that ignores server text entirely
  // and falls back to the 44-grapheme default (reviewer finding).
  check('the rate-limit note actually QUOTES the server text (not the default) when the server sent some',
    quoted.startsWith('yyy'), JSON.stringify(quoted.slice(0, 20)));
  check('the rate-limit note quotes at most REGEN_SERVER_TEXT_MAX graphemes of server text',
    seg(quoted).length <= REGEN_SERVER_TEXT_MAX, `graphemes=${seg(quoted).length}`);
  check('the quoted tail is not cut mid-cluster',
    seg(REGEN_ERROR_MESSAGES['rate-limit']('\u{1F1FA}\u{1F1F8}'.repeat(300))).every((c) => c !== '�'));
}

if (failures) { console.error(`\n${failures} regenpromote check(s) failed.`); process.exit(1); }
console.log('regenpromote.test.ts: all checks passed.');

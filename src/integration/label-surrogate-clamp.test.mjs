/* INTEGRATION — RED-CLOUD-5/001: server.ts's 40-char option-label clamp must
 * never cut inside a UTF-16 surrogate pair or a multi-codepoint grapheme
 * cluster (emoji straddling the cut).
 *
 * THE DEFECT (live-reproduced against origin/main HEAD `eed34f8`, v0.0.121):
 * `cutAtWordBoundary`'s own `s.slice(0, maxLength)` (server.ts, shared by
 * `cleanScenario`'s `label()` for POST /api/report's `scenario.row1/row2/
 * col1/col2`, and by `cleanLabels` for POST/PATCH /api/games' `row1Label`
 * etc.) operates on raw UTF-16 code units. `"A" + "\u{1F389}".repeat(20)`
 * (41 units) clamped to 40 left an UNPAIRED high surrogate (U+D83C) at
 * index 105 of the rendered `/api/report` prose — a visible mojibake
 * glyph, repeated three times in one paragraph. `cleanText`'s own wider
 * pre-clamp (60 units, so `cutAtWordBoundary` has room to find a real word
 * boundary) had the identical bare-slice hazard independently, for longer
 * strings (an un-rescued clamp also applies to `name`/`description`).
 *
 * THE FIX: `clampGraphemeSafe` (server.ts, ~line 1231) replaces both bare
 * slices. It stays in UTF-16-unit budget (so LABEL_MAX/60/80/1200 keep
 * their existing meaning for plain ASCII/BMP text) but never returns a cut
 * that splits a surrogate pair or a wider grapheme cluster (ZWJ family
 * sequences, flag Regional-Indicator pairs, skin-tone modifiers) — via
 * `Intl.Segmenter` grapheme boundaries.
 *
 * `NASH_PAYOFF_TEMPLATE=1` is required to reach the exact rendering path
 * the finding used (`tieProseFull` on a supplied, USABLE, non-tie
 * scenario) — this is a literal in cloudbuild.yaml on every production
 * deploy (src/cloudbuild.contract.test.ts guards the file); no credentials
 * or REPORT_MODEL are needed because a SUPPLIED usable scenario on a
 * non-tie game never reaches the invent-a-scenario branch.
 *
 *   node src/integration/label-surrogate-clamp.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = process.env.LSC_TEST_PORT || '3140';
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** Any lone (unpaired) UTF-16 surrogate anywhere in a JSON-serializable
 *  value — walked recursively so a corrupted label buried in
 *  `report.suggestedScenario.row1`, `report.prose`, or a saved game's
 *  `row1Label` is caught the same way regardless of where it landed. */
function findLoneSurrogate(value, pathSoFar = '$') {
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        const next = value.charCodeAt(i + 1);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) {
          return { path: pathSoFar, index: i, hex: c.toString(16), value };
        }
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        const prev = i > 0 ? value.charCodeAt(i - 1) : 0;
        if (!(prev >= 0xD800 && prev <= 0xDBFF)) {
          return { path: pathSoFar, index: i, hex: c.toString(16), value, loneLow: true };
        }
      }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findLoneSurrogate(value[i], `${pathSoFar}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const hit = findLoneSurrogate(value[k], `${pathSoFar}.${k}`);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

/** Extract the FIRST occurrence of a clamped label out of the deterministic
 *  template prose, using the fixed phrasing `tieProseFull` renders it in
 *  ("... A prefers <LABEL> (N rather than M)"). The label repeats several
 *  times per paragraph (once per best-reply/equilibrium mention), so a
 *  structural check must look at ONE occurrence, not count a glyph across
 *  the whole paragraph (which multiplies by however many times the label
 *  repeats). */
function extractFirstLabel(prose, prefix, suffixPattern) {
  const start = prose.indexOf(prefix);
  if (start < 0) return null;
  const from = start + prefix.length;
  const m = suffixPattern.exec(prose.slice(from));
  if (!m) return null;
  return prose.slice(from, from + m.index);
}

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

const userData = mkdtempSync(path.join(tmpdir(), 'nash-lsc-'));
const serverDir = path.resolve(import.meta.dirname, '../..');
const server = spawn('node', [path.join(serverDir, 'dist/server.cjs')], {
  cwd: userData,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    ELECTRON_USER_DATA_PATH: userData, // auto-verify signups; db.json in temp dir
    NASH_PAYOFF_TEMPLATE: '1', // rung-3 flag, a literal in cloudbuild.yaml on every deploy
    NASH_LLM_TIES: 'template',
    NASH_DIRECTION_CHECKS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  if (!(await waitReady())) {
    // CodeRabbit (this round): process.exit() here bypassed the `finally`
    // below entirely — the spawned server process and the temp userData
    // directory would both leak on this failure path. Throwing instead
    // lets `finally` run first (JS guarantees it before an uncaught throw
    // propagates); the throw then still exits the process non-zero, same
    // as before, just after cleanup.
    throw new Error(`server never became ready\n${serverLog}`);
  }

  const nonTiePayoffs = { a11: 3, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 };

  // ═══════════════════════════════════════════════════════════════════════
  // 1. THE EXACT KNOWN-POSITIVE FIXTURE from RED-CLOUD-5/001: a common-word
  //    label directly followed by a run of emoji with no space, straddling
  //    the 40-unit cut. Report path (cleanScenario -> label() ->
  //    cutAtWordBoundary).
  // ═══════════════════════════════════════════════════════════════════════
  {
    const row1 = 'A' + '\u{1F389}'.repeat(20); // 41 UTF-16 units
    const r = await call('POST', '/api/report', {
      body: { payoffs: nonTiePayoffs, scenario: { row1, row2: 'AltOption', col1: 'ChoiceOne', col2: 'ChoiceTwo' } },
    });
    const hit = findLoneSurrogate(r.json);
    record('THE DEFECT FIXTURE: "A" + 20 party-popper emoji (41 units) in report prose has NO lone surrogate anywhere in the response',
      r.status === 200 && !hit, `status=${r.status} ${hit ? JSON.stringify(hit) : ''}`);
    // The clamped label itself, wherever it landed, must be a COMPLETE
    // grapheme run — either every emoji that fit whole, or none of the
    // straddling one; never a fragment. Checked on ONE occurrence (the
    // label repeats several times per paragraph, so counting the glyph
    // across the whole prose over-counts by the repeat factor).
    const prose = r.json?.report?.prose ?? '';
    const oneLabel = extractFirstLabel(prose, 'A prefers ', / \(/);
    const emojiCount = oneLabel ? [...oneLabel.matchAll(/\u{1F389}/gu)].length : 0;
    // CodeRabbit (this round): same tightening as the family/flag checks
    // below — this 41-unit input ('A' + 20 copies of the 2-unit emoji)
    // against LABEL_MAX=40 has exactly ONE correct clamp: 'A' + 19 whole
    // emoji (39 units; a 20th would push to 41). "1..20" accepted a
    // regression that kept only a few emoji (or dropped most of them) just
    // as readily as the correct clamp. Require the exact maximal count.
    const expectedEmojiCount = 19;
    record('the label keeps EXACTLY the maximal 19 whole emoji (the one correct clamp of this 41-unit input, never a partial character or a truncated-short count)',
      oneLabel === 'A' + '\u{1F389}'.repeat(expectedEmojiCount),
      `extracted label: ${JSON.stringify(oneLabel)} (emoji count ${emojiCount}, expected ${expectedEmojiCount})`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2. The finding's own suggested regression fixture: "GameOverNow" + 15
  //    party-popper emoji — realistic style (a word directly followed by an
  //    emoji run, no space), which the realism sweep found splits 40% of the
  //    time at random.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const row1 = 'GameOverNow' + '\u{1F389}'.repeat(15);
    const r = await call('POST', '/api/report', {
      body: { payoffs: nonTiePayoffs, scenario: { row1, row2: 'Second', col1: 'First', col2: 'Other' } },
    });
    const hit = findLoneSurrogate(r.json);
    record('"GameOverNow" + 15 emoji: no lone surrogate anywhere in the response',
      r.status === 200 && !hit, `status=${r.status} ${hit ? JSON.stringify(hit) : ''}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Multi-codepoint grapheme clusters that are NOT plain astral
  //    characters: a ZWJ family sequence (man+ZWJ+woman+ZWJ+girl+ZWJ+boy,
  //    4 codepoints/4 surrogate pairs joined by ordinary ZWJ) and a flag
  //    (2 Regional Indicator codepoints, each its own surrogate pair) — both
  //    straddling the 40-unit cut. A codepoint-safe (but not grapheme-safe)
  //    clamp would still produce a WELL-FORMED string here (no lone
  //    surrogate) while visually mangling the glyph (an orphaned half of a
  //    family, or a lone flag letter) — so this checks the family/flag
  //    stays either whole or fully absent, not just UTF-16-well-formed.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
    const row1 = 'X' + family.repeat(4); // 45 units
    const r = await call('POST', '/api/report', {
      body: { payoffs: nonTiePayoffs, scenario: { row1, row2: 'AltOption', col1: 'ChoiceOne', col2: 'ChoiceTwo' } },
    });
    const hit = findLoneSurrogate(r.json);
    const prose = r.json?.report?.prose ?? '';
    const oneLabel = extractFirstLabel(prose, 'A prefers ', / \(/);
    // CodeRabbit (this round): `row1` here is a DETERMINISTIC fixture — 'X'
    // (1 unit) + 4 copies of the 11-unit family sequence = 45 units, against
    // LABEL_MAX=40 — so the grapheme-safe clamp has exactly ONE correct
    // output: 'X' + 3 WHOLE copies (34 units; a 4th partial copy would push
    // past 40). Accepting "any K in 0..4" let a regression that stripped
    // EVERY copy (or kept only 1 or 2) pass this check just as well as the
    // correct clamp — verified empirically against the current build before
    // narrowing this (see the round's notes): the real output is always
    // exactly K=3. Require that exact value, not a range.
    const expectedFamilyLabel = 'X' + family.repeat(3);
    record('ZWJ family emoji sequence: no lone surrogate anywhere in the response',
      r.status === 200 && !hit, `status=${r.status} ${hit ? JSON.stringify(hit) : ''}`);
    record('ZWJ family emoji sequence: the label is exactly X + 3 whole family copies (the one correct clamp of this 45-unit input)',
      oneLabel === expectedFamilyLabel,
      `extracted label: ${JSON.stringify(oneLabel)}, expected: ${JSON.stringify(expectedFamilyLabel)}`);
  }
  {
    const flag = '\u{1F1FA}\u{1F1F8}'; // US flag: 2 Regional Indicators
    const row1 = 'Y' + flag.repeat(10); // 41 units
    const r = await call('POST', '/api/report', {
      body: { payoffs: nonTiePayoffs, scenario: { row1, row2: 'AltOption', col1: 'ChoiceOne', col2: 'ChoiceTwo' } },
    });
    const hit = findLoneSurrogate(r.json);
    const prose = r.json?.report?.prose ?? '';
    // CodeRabbit (this round): a bare EVEN-count check over the WHOLE prose
    // is fooled by the prose repeating the label — one truly-half flag can
    // appear an even number of TOTAL repeats (e.g. two separate mentions,
    // each individually missing its second Regional Indicator) and still
    // pass. Extract ONE label the same way the family-sequence check above
    // does, and require it to equal 'Y' + some whole number of flag copies
    // — the label itself must be well-formed, not just the aggregate count.
    const oneLabel = extractFirstLabel(prose, 'A prefers ', / \(/);
    // CodeRabbit (this round): same tightening as the family case above —
    // this 41-unit input ('Y' + 10 copies of the 4-unit flag) against
    // LABEL_MAX=40 has exactly ONE correct clamp: 'Y' + 9 whole copies (37
    // units; a 10th partial copy would push past 40). "Any K in 0..10"
    // would let a regression that stripped every flag (or kept only a few)
    // pass. Verified empirically against the current build: real output is
    // always exactly K=9. Require that exact value.
    const expectedFlagLabel = 'Y' + flag.repeat(9);
    record('flag (Regional Indicator pair) sequence: no lone surrogate anywhere in the response',
      r.status === 200 && !hit, `status=${r.status} ${hit ? JSON.stringify(hit) : ''}`);
    record('flag sequence: the label is exactly Y + 9 whole flag pairs (the one correct clamp of this 41-unit input)',
      oneLabel === expectedFlagLabel,
      `extracted label: ${JSON.stringify(oneLabel)}, expected: ${JSON.stringify(expectedFlagLabel)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 4. The SAVE path (POST/PATCH /api/games' cleanLabels) — the finding
  //    flagged this as provably the SAME function (cutAtWordBoundary) but
  //    unverified end-to-end. Needs a real account (ELECTRON_USER_DATA_PATH
  //    auto-verifies).
  // ═══════════════════════════════════════════════════════════════════════
  {
    const email = `lsc-${Date.now()}@example.com`;
    const password = 'StrongPass1';
    await call('POST', '/api/auth/register', { body: { username: `lsc${Date.now()}`, email, password } });
    const login = await call('POST', '/api/auth/login', { body: { email, password } });
    const token = login.json?.token;
    record('save-path setup: registered + logged in', typeof token === 'string' && token.length > 0, `status=${login.status}`);

    const row1Label = 'GameOverNow' + '\u{1F389}'.repeat(15);
    const saved = await call('POST', '/api/games', {
      token,
      body: { name: 'surrogate clamp save-path test', payoffs: nonTiePayoffs, row1Label },
    });
    const gameId = saved.json?.game?.id;
    const hitOnWrite = findLoneSurrogate(saved.json);
    record('POST /api/games: no lone surrogate anywhere in the write response',
      saved.status === 200 && !hitOnWrite, `status=${saved.status} ${hitOnWrite ? JSON.stringify(hitOnWrite) : ''}`);

    // Read back from STORAGE, not the write echo (CodeRabbit's own lesson,
    // already applied above in api.test.mjs's sibling block): a handler that
    // only sanitizes the outbound echo while storing raw bytes would pass
    // the write-response check above and still corrupt on every later read.
    const readBack = await call('GET', '/api/games', { token });
    const stored = (readBack.json || []).find((g) => g.id === gameId);
    const hitOnRead = findLoneSurrogate(stored);
    record('the STORED row1Label (fresh GET, not the write echo) has no lone surrogate',
      !!stored && !hitOnRead, hitOnRead ? JSON.stringify(hitOnRead) : `row1Label=${JSON.stringify(stored?.row1Label)}`);
    record('the stored row1Label is at most 40 characters',
      typeof stored?.row1Label === 'string' && stored.row1Label.length <= 40, `len=${stored?.row1Label?.length}`);

    if (gameId) await call('DELETE', `/api/games/${gameId}`, { token });

    // CodeRabbit (this round): the fixture above only exercises a
    // SINGLE-codepoint emoji (no ZWJ join, no Regional Indicator pair) —
    // a regression that made the SAVE path (cleanLabels) codepoint-safe
    // but not grapheme-safe (e.g. a different call site than the report
    // path's cutAtWordBoundary, or one that lost the Intl.Segmenter step)
    // would still pass every check above while splitting a ZWJ family or
    // flag on save. `cleanLabels` calls the SAME `cutAtWordBoundary` with
    // the SAME LABEL_MAX as the report path (server.ts ~1467 vs ~1518), so
    // the SAME deterministic 41-unit flag input must clamp to the SAME
    // exact value here too — verified empirically before writing this.
    const saveFlag = '\u{1F1FA}\u{1F1F8}'; // US flag: 2 Regional Indicators — same fixture as PART 3 above, redeclared: that `flag` const is scoped to PART 3's own block
    const flagRow1Label = 'Y' + saveFlag.repeat(10); // 41 units
    const expectedFlagSaveLabel = 'Y' + saveFlag.repeat(9);
    const savedFlag = await call('POST', '/api/games', {
      token,
      body: { name: 'surrogate clamp save-path multi-codepoint test', payoffs: nonTiePayoffs, row1Label: flagRow1Label },
    });
    const flagGameId = savedFlag.json?.game?.id;
    const hitOnFlagWrite = findLoneSurrogate(savedFlag.json);
    record('SAVE path, multi-codepoint (flag) label: POST /api/games has no lone surrogate in the write response',
      savedFlag.status === 200 && !hitOnFlagWrite, `status=${savedFlag.status} ${hitOnFlagWrite ? JSON.stringify(hitOnFlagWrite) : ''}`);

    const readBackFlag = await call('GET', '/api/games', { token });
    const storedFlag = (readBackFlag.json || []).find((g) => g.id === flagGameId);
    record('SAVE path, multi-codepoint (flag) label: the STORED row1Label (fresh GET) is exactly Y + 9 whole flag pairs',
      storedFlag?.row1Label === expectedFlagSaveLabel,
      `stored=${JSON.stringify(storedFlag?.row1Label)}, expected=${JSON.stringify(expectedFlagSaveLabel)}`);

    if (flagGameId) await call('DELETE', `/api/games/${flagGameId}`, { token });

    // A fixture exercising the 60-unit `cleanText` pre-clamp inside
    // `cleanLabels` (server.ts ~1464-1467, LABEL_MAX+20 before the final
    // 40-unit cut) was tried and REMOVED here, not skipped for lack of
    // effort: mutation-testing it (breaking ONLY the 60-unit stage to a
    // bare, non-grapheme-safe slice, leaving the 40-unit stage correct)
    // found ZERO observable divergence — not for that fixture, not for a
    // 40-emoji-wide ZWJ cluster swept across the 40..60 boundary, not
    // across 20,000 randomly fuzzed strings 61-90 units long. The 40-unit
    // second stage always independently re-segments and only ever needs
    // content from BEFORE its own ~40-unit cutoff, which neither
    // implementation of the first (60-unit) stage ever touches (a broken
    // first stage can only corrupt content at/after unit 60, always past
    // where the second stage already stopped) — so this specific two-stage
    // composition makes a first-stage-only regression structurally
    // unobservable through any end-to-end assertion. A fixture claiming to
    // "cover" that stage while being unable to fail for that reason is
    // exactly the shape this repo's own discipline warns against (a check
    // that cannot fail for the reason it claims), so it was removed rather
    // than kept for a false sense of coverage. If the 60-unit stage's own
    // correctness ever needs to be pinned independently, it would need a
    // direct unit test against a helper it exports on its own — not an
    // end-to-end fixture through this two-stage composition.
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 5. RED-CLOUD-6/001: `clampGraphemeSafe`'s OWN new edge case — a single
  //    grapheme cluster (zalgo/"cursed" text: a base character followed by
  //    an unbounded run of combining marks, all part of ONE cluster under
  //    the same UAX #29 rules `Intl.Segmenter` implements) that by itself
  //    exceeds the whole clamp budget. The pre-fix loop's `break` left `out`
  //    at `""` — a TOTAL WIPE of the label, not a truncation. For
  //    `cleanScenario`, that turned a missing ONE of four labels into
  //    `scenarioIsUsable` failing and the user's entire supplied scenario
  //    (row2/col1/col2 included, all perfectly normal) being silently
  //    discarded and replaced by an invented story. Different failure SHAPE
  //    from part 1 above (that one corrupted a visible character; this one
  //    erases everything with nothing visibly wrong) at the exact same call
  //    site the #93 fix just touched.
  // ═══════════════════════════════════════════════════════════════════════
  {
    // Boundary sweep straight from the finding: at cluster length == 40
    // (LABEL_MAX) the pre-fix code already worked; one mark past it is where
    // the wipe used to start. None of these three may now clamp to "".
    for (const marks of [39, 40, 41]) {
      const row1 = 'H' + '́'.repeat(marks) + 'elpTheUser more text after';
      const r = await call('POST', '/api/report', {
        body: { payoffs: nonTiePayoffs, scenario: { row1, row2: 'AltOption', col1: 'ChoiceOne', col2: 'ChoiceTwo' } },
      });
      record(`zalgo boundary sweep (${marks} combining marks, cluster length ${1 + marks}): the user's OWN scenario is kept, not replaced by invention`,
        r.status === 200 && r.json?.report?.suggestedScenario === undefined,
        `status=${r.status} suggestedScenario=${JSON.stringify(r.json?.report?.suggestedScenario)}`);
      // The weaker check above (suggestedScenario undefined) cannot tell
      // "row1 survived the clamp" apart from "row1 was wiped, invention was
      // attempted but returned nothing (no credentials in this test
      // environment), and the code fell back to rendering the SAME
      // now-corrupted scenario object with an empty row1" — both leave
      // suggestedScenario undefined. The prose itself is the only place
      // that distinguishes them: it must name the user's real row2/col1/
      // col2 labels (proving the scenario used is the SUPPLIED one, not a
      // generic "Row 1"/"Col 1" fallback that a wiped, unusable scenario
      // would render instead — see tieProseFull's own fallback naming).
      const prose = r.json?.report?.prose ?? '';
      record(`zalgo boundary sweep (${marks} marks): report prose names the user's OWN labels (AltOption/ChoiceOne/ChoiceTwo), not a generic Row/Col fallback`,
        typeof prose === 'string' && prose.includes('AltOption') && prose.includes('ChoiceOne') && prose.includes('ChoiceTwo'),
        `prose=${JSON.stringify(prose.slice(0, 120))}`);
      // And row1 itself: the clamped label starts with the base character
      // "H" and is never empty — the fixture at exactly this boundary is
      // RED-CLOUD-6/001's own reproduction of the total wipe.
      record(`zalgo boundary sweep (${marks} marks): the clamped row1 label (starting "H") appears in the prose, never wiped to nothing`,
        typeof prose === 'string' && prose.includes('A prefers H'),
        `prose=${JSON.stringify(prose.slice(0, 160))}`);
    }
  }

  // The finding's own end-to-end repro: a much larger zalgo run (80 marks,
  // 91-unit cluster) straddling every clamp stage in this file (the report
  // path's 60-unit `noTags` pre-clamp AND the 40-unit `cutAtWordBoundary`
  // final clamp), alongside three ordinary labels — before the fix this
  // discarded ALL FOUR labels (not just the zalgo one) because `hasLabels`
  // requires every field.
  {
    const zalgoRow1 = 'H' + '́'.repeat(80) + 'elpTheUser';
    const r = await call('POST', '/api/report', {
      body: {
        payoffs: nonTiePayoffs,
        scenario: { row1: zalgoRow1, row2: 'AltOption', col1: 'ChoiceOne', col2: 'ChoiceTwo' },
      },
    });
    record('80-mark zalgo row1 + 3 normal labels: the scenario is kept (suggestedScenario is undefined — not an invented substitute)',
      r.status === 200 && r.json?.report?.suggestedScenario === undefined,
      `status=${r.status} suggestedScenario=${JSON.stringify(r.json?.report?.suggestedScenario)}`);
    const hit = findLoneSurrogate(r.json);
    record('80-mark zalgo row1: no lone surrogate anywhere in the response (the codepoint-safe fallback never splits a surrogate pair)',
      !hit, hit ? JSON.stringify(hit) : '');
    const prose = r.json?.report?.prose ?? '';
    record('80-mark zalgo row1: the clamped label (starting "H") appears in the rendered prose, not silently dropped',
      prose.includes('H́'), `prose=${JSON.stringify(prose.slice(0, 200))}`);
  }

  // Same clamp, the SAVE path (`cleanLabels` -> `cutAtWordBoundary` ->
  // `clampGraphemeSafe`) — RED-CLOUD-6/001 flagged this as provably the same
  // function but unverified end-to-end, same caveat part 4 above left.
  {
    const email = `lsc6-${Date.now()}@example.com`;
    const password = 'StrongPass1';
    await call('POST', '/api/auth/register', { body: { username: `lsc6${Date.now()}`, email, password } });
    const login = await call('POST', '/api/auth/login', { body: { email, password } });
    const token = login.json?.token;
    record('zalgo save-path setup: registered + logged in', typeof token === 'string' && token.length > 0, `status=${login.status}`);

    const row1Label = 'H' + '́'.repeat(80) + 'elpTheUser';
    const saved = await call('POST', '/api/games', {
      token,
      body: { name: 'zalgo clamp save-path test', payoffs: nonTiePayoffs, row1Label },
    });
    const gameId = saved.json?.game?.id;
    record('SAVE path, zalgo label: POST /api/games succeeds with a NON-EMPTY stored label',
      saved.status === 200 && typeof saved.json?.game?.row1Label === 'string' && saved.json.game.row1Label.length > 0,
      `status=${saved.status} row1Label=${JSON.stringify(saved.json?.game?.row1Label)}`);

    const readBack = await call('GET', '/api/games', { token });
    const stored = (readBack.json || []).find((g) => g.id === gameId);
    record('SAVE path, zalgo label: the STORED row1Label (fresh GET) is non-empty and starts with the base character',
      !!stored && typeof stored.row1Label === 'string' && stored.row1Label.length > 0 && stored.row1Label.startsWith('H'),
      `stored=${JSON.stringify(stored?.row1Label)}`);

    if (gameId) await call('DELETE', `/api/games/${gameId}`, { token });
  }

} finally {
  if (server.exitCode === null) {
    const ended = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 4000);
    await ended;
    clearTimeout(timer);
  }
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}

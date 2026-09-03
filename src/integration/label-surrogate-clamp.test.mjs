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
    console.error(`FAIL server never became ready\n${serverLog}`);
    process.exit(2);
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
    record('the label keeps only WHOLE emoji (one occurrence has a complete count, never a partial character)',
      oneLabel !== null && emojiCount >= 1 && emojiCount <= 20 && oneLabel === 'A' + '\u{1F389}'.repeat(emojiCount),
      `extracted label: ${JSON.stringify(oneLabel)} (emoji count ${emojiCount})`);
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
    // The label must be 'X' followed by exactly K WHOLE copies of the
    // 4-codepoint family sequence, for some K in 0..4 — never a dangling ZWJ
    // or a lone family member sitting right after the last complete copy.
    const validFamilyLabels = [0, 1, 2, 3, 4].map((k) => 'X' + family.repeat(k));
    record('ZWJ family emoji sequence: no lone surrogate anywhere in the response',
      r.status === 200 && !hit, `status=${r.status} ${hit ? JSON.stringify(hit) : ''}`);
    record('ZWJ family emoji sequence: the label is X + only WHOLE family copies (no orphaned ZWJ/member)',
      oneLabel !== null && validFamilyLabels.includes(oneLabel),
      `extracted label: ${JSON.stringify(oneLabel)}`);
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
    const validFlagLabels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => 'Y' + flag.repeat(k));
    record('flag (Regional Indicator pair) sequence: no lone surrogate anywhere in the response',
      r.status === 200 && !hit, `status=${r.status} ${hit ? JSON.stringify(hit) : ''}`);
    record('flag sequence: the label contains only WHOLE flag pairs (no half-flag)',
      oneLabel !== null && validFlagLabels.includes(oneLabel),
      `extracted label: ${JSON.stringify(oneLabel)}`);
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

/**
 * RED TEAM: the local scenario writer, hunted for defects the shipping gates
 * do NOT catch.
 *
 * validateScenario and scenarioIsClaimFree are thorough about CLAIMS — numbers,
 * comparatives, move order, mis-attributed options. They say nothing about
 * whether the sentence is well formed, whether the two players' options can be
 * told apart, or whether the description was cut off mid-thought. Those are the
 * defects a reader sees first, and a 0.6B is exactly where they come from.
 *
 * Every check below is DECIDABLE — no judgement calls, no "seems clumsy" — so a
 * finding is a fact and a fix is verifiable. Findings are reported per class
 * with the offending text, because a rate without an example is not actionable.
 *
 *   LOCAL_URL=http://localhost:8099/v1/chat/completions N=120 npx tsx _gen/redteam_local.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.LOCAL_URL || 'http://localhost:8099/v1/chat/completions';
const N = Number(process.env.N || 120);
const { SCENARIO_SYSTEM_PROMPT, buildGroundingPayload } = await import('../src/utils/report.ts');
const { validateScenario, scenarioIsClaimFree, validateProseDirections } = await import('../src/utils/nashValidator.ts');
const { SCENARIO_DOMAINS } = await import('../src/utils/scenarioDomains.ts');

const rows = readFileSync(join(homedir(), 'Desktop', 'nash-finetune-data', 'data', 'test_raw.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ── adversarial games alongside the held-out ones: degenerate shapes are where
//    a small model's grammar and label discipline break down ──────────────────
const ADVERSARIAL = [
  { name: 'all zeros',        g: { a11:0,a12:0,a21:0,a22:0,b11:0,b12:0,b21:0,b22:0 } },
  { name: 'both rows tie',    g: { a11:2,a12:2,a21:2,a22:2,b11:1,b12:-1,b21:-1,b22:1 } },
  { name: 'extreme range',    g: { a11:100,a12:-100,a21:-100,a22:100,b11:-100,b12:100,b21:100,b22:-100 } },
  { name: 'tiny differences', g: { a11:1,a12:1,a21:1,a22:0,b11:0,b12:1,b21:1,b22:1 } },
  { name: 'one-sided',        g: { a11:5,a12:5,a21:5,a22:5,b11:0,b12:3,b21:-3,b22:1 } },
  { name: 'negative only',    g: { a11:-1,a12:-9,a21:-4,a22:-2,b11:-7,b12:-2,b21:-1,b22:-8 } },
];

const games = [];
for (let i = 0; i < N; i++) {
  if (i % 10 === 9) { const a = ADVERSARIAL[(i / 10 | 0) % ADVERSARIAL.length]; games.push({ g: a.g, tag: a.name }); }
  else { const r = rows[i % rows.length]; games.push({ g: r.game ?? r, tag: 'held-out' }); }
}

const VOWEL_START = /^(?:[aeiou]|hour|honest|honou?r)/i;
/** Letters and digits only — "ski-lift grooming" vs "Skilift Grooming". */
const squash = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const findings = new Map();     // class -> [{tag, domain, text}]
const add = (cls, tag, domain, text) => {
  if (!findings.has(cls)) findings.set(cls, []);
  findings.get(cls).push({ tag, domain, text });
};

let attempted = 0, parsed = 0, gatePass = 0;
const lat = [];
for (let i = 0; i < games.length; i++) {
  const { g, tag } = games[i];
  const domain = SCENARIO_DOMAINS[i % SCENARIO_DOMAINS.length];
  const sys = `${SCENARIO_SYSTEM_PROMPT}\n\nSET THIS SCENARIO IN THIS DOMAIN: ${domain}. Use that domain and no other. Everything else above still applies.`;
  attempted++;
  const t0 = Date.now();
  let sc = null, raw = '';
  try {
    const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'system', content: sys },
        { role: 'user', content: JSON.stringify(buildGroundingPayload(g)) }],
        temperature: 0.8, top_p: 0.95, max_tokens: 700 }) });
    const j = await res.json();
    lat.push(Date.now() - t0);
    raw = j.choices?.[0]?.message?.content ?? '';
    const m = raw.match(/\{[\s\S]*\}/);
    sc = m ? (JSON.parse(m[0]).suggestedScenario ?? null) : null;
  } catch (e) { add('request threw', tag, domain, String(e).slice(0, 90)); continue; }

  if (!sc) { add('unparseable output', tag, domain, raw.slice(0, 120)); continue; }
  parsed++;

  const v = validateScenario(sc, g); const cf = scenarioIsClaimFree(sc);
  const dirs = validateProseDirections(sc.description ?? '', sc, g);
  if (v.ok && cf.ok !== false && dirs.length === 0) gatePass++;
  else add('SHIPPING GATE rejects (no scenario shown to the user)', tag, domain,
    [...(v.ok ? [] : (v.issues ?? [v.reason])), cf.ok === false ? cf.reason : null, ...dirs].filter(Boolean).join(' | ').slice(0, 140));

  const d = (sc.description ?? '').trim();
  const labels = [sc.row1, sc.row2, sc.col1, sc.col2].map((x) => (x ?? '').trim());
  const nm = (sc.name ?? '').trim();

  // ── decidable prose defects the gates never look at ──────────────────────
  for (const m of d.matchAll(/\b(a)\s+([A-Za-z]+)/g)) {
    if (VOWEL_START.test(m[2])) add('article error ("a" before a vowel sound)', tag, domain, `…${m[0]}…`);
  }
  for (const m of d.matchAll(/\ban\s+([A-Za-z]+)/g)) {
    if (!VOWEL_START.test(m[1]) && !/^[aeiou]/i.test(m[1])) add('article error ("an" before a consonant)', tag, domain, `…an ${m[1]}…`);
  }
  for (const l of labels.concat(nm)) {
    const w = l.toLowerCase().split(/\s+/).filter(Boolean);
    for (let k = 1; k < w.length; k++) {
      if (w[k] === w[k - 1] || (w[k].length > 4 && w[k - 1].length > 4 && (w[k].startsWith(w[k - 1]) || w[k - 1].startsWith(w[k]))))
        add('degenerate repetition in a label/name', tag, domain, l);
    }
  }
  const dw = d.toLowerCase().split(/\s+/);
  for (let k = 1; k < dw.length; k++) if (dw[k] === dw[k - 1] && /^[a-z]{3,}$/.test(dw[k])) add('doubled word in the description', tag, domain, `…${dw[k - 1]} ${dw[k]}…`);

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const rowSet = new Set([norm(labels[0]), norm(labels[1])].filter(Boolean));
  for (const c of [norm(labels[2]), norm(labels[3])]) {
    if (c && rowSet.has(c)) add("BOTH PLAYERS share an option name (reader cannot tell whose move it is)", tag, domain, `row:"${labels[0]}"/"${labels[1]}"  col:"${labels[2]}"/"${labels[3]}"`);
  }
  if (d && !/[.!?]$/.test(d)) add('description ends without terminal punctuation (truncated?)', tag, domain, `…${d.slice(-70)}`);
  if (d && d.length < 60) add('description too short to set a scene', tag, domain, d);
  if (!nm) add('scenario has no name', tag, domain, '(empty)');
  if (labels.some((l) => !l)) add('a missing option label', tag, domain, JSON.stringify(labels));
  if (d && !labels.filter(Boolean).some((l) => d.toLowerCase().includes(l.toLowerCase())))
    add('description never mentions any option label', tag, domain, d.slice(0, 110));
  if (/[^\x00-\x7F‐-’…−]/.test(d + nm + labels.join(''))) add('non-ASCII/mojibake character', tag, domain, (d + nm).slice(0, 90));
  const sentences = d.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 15);
  if (new Set(sentences).size !== sentences.length) add('a repeated sentence', tag, domain, d.slice(0, 120));
  // DOMAIN ADHERENCE, MEASURED WHERE THE HARNESS DID NOT PLANT THE ANSWER.
  //
  // This searched (name + description) and consequently never fired once. RED 2
  // found why: the model's name is the injected domain, title-cased, verbatim
  // 92.9% of the time, so the needle was always sitting in a field this harness
  // effectively dictated. Re-measured over red's 84-draw corpus, the check goes
  // from 0% to 10.3% once the name is excluded — and the misses are real, e.g.
  // domain "ferry timetable slots" describing a ferry operator and then a
  // station coordinator with a departing TRAIN.
  //
  // Labels are kept in the haystack: they are the model's own invention and
  // carry the setting legitimately. Excluding the name is not a tightening that
  // risks false positives — the cloud model scores 100% on this same corpus
  // under the same rule, so a compliant writer always names its industry in the
  // body. A check that only the weak model fails is discriminating, not noisy.
  const words = domain.split(/[\s-]+/).filter((w) => w.length > 3);
  const body = (d + ' ' + labels.filter(Boolean).join(' ')).toLowerCase();
  if (words.length && !words.some((w) => body.includes(w))) add('ignored the requested domain (name excluded)', tag, domain, `${nm}: ${d.slice(0, 80)}`);
  // Reported separately so the inflation stays visible rather than being
  // silently swapped out from under the previous numbers.
  if (words.length && squash(nm) === squash(domain)) add('scenario name is just the domain, title-cased', tag, domain, `${domain} -> ${nm}`);
}

lat.sort((a, b) => a - b);
console.log(`\n══════ RED TEAM — local scenario writer ══════`);
console.log(`games ${attempted} (held-out + ${ADVERSARIAL.length} adversarial shapes) · parsed ${parsed} · shipping-gate pass ${gatePass}/${attempted} = ${(100 * gatePass / attempted).toFixed(1)}%`);
console.log(`latency p50 ${(lat[Math.floor(lat.length * .5)] / 1000).toFixed(2)}s  p90 ${(lat[Math.floor(lat.length * .9)] / 1000).toFixed(2)}s\n`);
const sorted = [...findings.entries()].sort((a, b) => b[1].length - a[1].length);
if (!sorted.length) console.log('no findings');
for (const [cls, hits] of sorted) {
  console.log(`${String(hits.length).padStart(4)}x  ${cls}   (${(100 * hits.length / attempted).toFixed(1)}% of draws)`);
  for (const h of hits.slice(0, 3)) console.log(`        [${h.tag}] ${h.text}`);
}

/**
 * BLUE — WINDOW 7: PRICE the candidate screens before proposing any of them.
 *
 * Standing rule: no validator change ships if it adds a single false positive,
 * and a reach number measured only on the corpus a rule was written against is
 * meaningless. So each candidate found by reading v2 output is run over EVERY
 * corpus this repo holds, restricted to draws the SHIPPING GATE ACCEPTS —
 * because a candidate can only cost something on output that reaches the user.
 * Every hit is printed; nothing here quotes a rate that was not hand-read.
 *
 *   npx tsx _gen/blue_w7_price.mjs
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const REPO = '/Users/danielluan/Desktop/3D-Nash-Equilibrium';
const files = [];
for (const d of ['/tmp', S, `${REPO}/_gen`, `${REPO}/_gen/results`, `${S}/blue/_gen`]) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) if (f.endsWith('.jsonl') && !/^blue_w7_(?:out|.*_accepted)/.test(f)) files.push(`${d}/${f}`);
}
files.sort();

const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const rows = []; const seen = new Set();
for (const f of files) {
  const src = f.split('/').pop().replace('.jsonl', '');
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const sc = r.sc ?? r.scenario; if (!sc || typeof sc !== 'object') continue;
    const g = r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null); if (!g) continue;
    const key = `${src}|${sc.name} ${sc.description} ${sc.row1} ${sc.col1}`;
    if (seen.has(key)) continue; seen.add(key);
    rows.push({ src, sc, g });
  }
}
// A candidate can only COST something on draws that currently reach the user.
const gateOk = (r) => V.scenarioIsClaimFree(r.sc).ok && V.validateScenario(r.sc, r.g).issues.length === 0;
const live = rows.filter(gateOk);
console.log(`${files.length} corpora - ${rows.length} unique draws - ${live.length} currently REACH THE USER\n`);

const L = (sc) => [sc.row1, sc.row2, sc.col1, sc.col2].map((x) => (x ?? '').trim());
const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\b(\w{4,})s\b/g, '$1').trim();

const CANDIDATES = [
  // The only candidate whose hits are unambiguously wrong prose rather than a
  // matter of taste: both players are given labels that differ by a plural.
  ['C3 near-colliding label pairs', (sc) => {
    const raw = L(sc).map((x) => x.toLowerCase());
    const [r1, r2, c1, c2] = L(sc).map(norm);
    if (!r1 || !r2 || !c1 || !c2) return false;
    if ([raw[0], raw[1]].some((x) => x && [raw[2], raw[3]].includes(x))) return false; // already caught exactly
    return [r1, r2].some((x) => [c1, c2].includes(x));
  }, P('Early Rotas', 'Late Rotas', 'Early Rota', 'Late Rota')],
  ['C5 chatbot-register option label', (sc) => L(sc).some((l) => /^(?:ask|tell|let|please|yes|no|maybe|sorry|thanks|ok|okay)\s+(?:me|us|you|him|her|them)\b/i.test(l)),
    P('Confirm Order', 'Ask me next', 'Early Slot', 'Late Slot')],
  ['C2 the stakes prompt wording, copied', (sc) => /\bamounts?\s+at\s+stake\b/i.test(sc.description ?? ''),
    P('A', 'B', 'C', 'D', 'Two co-ops share a clamp, with the amounts at stake being a large portion of the schedule.')],
];
function P(row1, row2, col1, col2, description = 'A yard books a berth while a board books a window.') {
  return { name: 'Fixture', row1, row2, col1, col2, description, storyClaims: null };
}

const dump = [];
for (const [name, f, fixture] of CANDIDATES) {
  if (!f(fixture)) { console.error(`KNOWN-POSITIVE FIXTURE DOES NOT FIRE for ${name} — the zero below would be meaningless.`); process.exit(1); }
  const hits = live.filter((r) => f(r.sc));
  const bySrc = new Map();
  for (const h of hits) bySrc.set(h.src, (bySrc.get(h.src) ?? 0) + 1);
  console.log(`${name}`);
  console.log(`   fires on ${hits.length}/${live.length} = ${(100 * hits.length / live.length).toFixed(3)}% of draws that reach the user`);
  console.log(`   sources: ${[...bySrc.entries()].map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  dump.push(`=== ${name} : ${hits.length}/${live.length} ===\n` + hits.map((h) => `  ${h.src}\n    labels: ${L(h.sc).join(' / ')}\n    ${h.sc.description}`).join('\n'));
}
writeFileSync('/tmp/blue_w7_out/price.txt', dump.join('\n\n'));
console.log(`\nEvery hit -> /tmp/blue_w7_out/price.txt. Hand-read all of them before any of these is proposed.`);

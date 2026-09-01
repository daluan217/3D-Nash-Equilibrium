/**
 * BLUE — WINDOW 7: acceptance corpus for the RETRAINED local model.
 *
 * Every gate in this repo was measured against v1. This collects the UNSEEN
 * paired corpus that the re-measurement runs over. Fresh seed, so these are
 * games no rule in this repo has ever been tuned against — the W3 lesson
 * ("0 reach on 890 draws" was true and still hid a shipped false positive)
 * says a reach number measured only on the corpus a rule was written against
 * is meaningless.
 *
 * Goes through `generateScenario` with `model: 'localqwen'` and nothing else,
 * because a harness that hand-rolls the fetch is not measuring the product —
 * that mistake already cost this campaign one retracted 18-point result.
 *
 *   ARM=v2 PORT=8120 N=400 npx tsx _gen/blue_w7_collect.mjs
 */
import 'dotenv/config';
import { appendFileSync, writeFileSync } from 'node:fs';
import { generateScenario } from '../src/utils/report.ts';
import { pickScenarioDomain } from '../src/utils/scenarioDomains.ts';
import { describeStakes } from '../src/utils/scenarioStakes.ts';

const ARM = process.env.ARM || 'v2';
const PORT = Number(process.env.PORT || 8120);
const N = Number(process.env.N || 400);
const SEED = Number(process.env.SEED || 777001);
const OUT = process.env.OUT || `/tmp/blue_w7_${ARM}.jsonl`;
writeFileSync(OUT, '');

process.env.LOCALQWEN_AZURE_FOUNDRY_ENDPOINT = `http://127.0.0.1:${PORT}/v1`;
process.env.LOCALQWEN_AZURE_FOUNDRY_API_KEY = 'local';

// The cells MUST be identical across arms, so they are derived from a seed that
// does not depend on the arm. pickScenarioDomain is random, so it is drawn from
// the SAME deterministic stream rather than called per arm.
let seed = SEED;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const DOMAINS = [];
{ // enumerate the rotation list once, deterministically sampled below
  const s = new Set();
  for (let i = 0; i < 4000 && s.size < 200; i++) s.add(pickScenarioDomain());
  DOMAINS.push(...[...s].sort());
}
const cells = Array.from({ length: N }, (_, i) => {
  const mag = [0.5, 5, 30, 90][i % 4];
  const p = () => r3((rnd() * 2 - 1) * mag);
  const g = { a11: p(), a12: p(), a21: p(), a22: p(), b11: p(), b12: p(), b21: p(), b22: p() };
  return { g, domain: DOMAINS[Math.floor(rnd() * DOMAINS.length)] };
});

const t0 = Date.now();
let produced = 0;
const ms = [];
for (let i = 0; i < cells.length; i++) {
  const { g, domain } = cells[i];
  const t = Date.now();
  let sc = null, failure = null;
  try { const r = await generateScenario(g, { model: 'localqwen', domain, stakes: true }); sc = r.scenario; failure = r.failure; }
  catch (e) { failure = String(e && e.message || e); }
  ms.push(Date.now() - t);
  if (sc) produced++;
  appendFileSync(OUT, JSON.stringify({ arm: ARM, i, domain, game: g, swing: describeStakes(g).swing, scenario: sc, failure }) + '\n');
  if ((i + 1) % 25 === 0) process.stderr.write(`${ARM} ${i + 1}/${N} produced=${produced} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
const s = [...ms].sort((a, b) => a - b);
console.log(`${ARM}: produced ${produced}/${N}  p50 ${(s[Math.floor(s.length / 2)] / 1000).toFixed(2)}s  wall ${((Date.now() - t0) / 1000).toFixed(0)}s  -> ${OUT}`);

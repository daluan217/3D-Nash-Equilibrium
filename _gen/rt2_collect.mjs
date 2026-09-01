/**
 * RED TEAM 2 (prose quality) — corpus collector.
 *
 * Pulls N scenarios from the LOCAL model (or the CLOUD model with MODE=cloud)
 * over the same games + the same rotating domain list, records the raw scenario
 * object plus the shipping-gate verdict, and writes one JSONL row per draw so
 * the analysis can be re-run offline without re-querying.
 *
 *   OUT=/tmp/local.jsonl N=250 npx tsx _gen/rt2_collect.mjs
 *   MODE=cloud OUT=/tmp/cloud.jsonl N=60 npx tsx _gen/rt2_collect.mjs
 */
import 'dotenv/config';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.LOCAL_URL || 'http://localhost:8099/v1/chat/completions';
const N = Number(process.env.N || 120);
const OFFSET = Number(process.env.OFFSET || 0);
const MODE = process.env.MODE || 'local';
const OUT = process.env.OUT || '/tmp/rt2_local.jsonl';

const { SCENARIO_SYSTEM_PROMPT, buildGroundingPayload, generateScenario } = await import('../src/utils/report.ts');
const { validateScenario, scenarioIsClaimFree, validateProseDirections } = await import('../src/utils/nashValidator.ts');
const { SCENARIO_DOMAINS } = await import('../src/utils/scenarioDomains.ts');

const rows = readFileSync(join(homedir(), 'Desktop', 'nash-finetune-data', 'data', 'test_raw.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

writeFileSync(OUT, '');
let n = 0;
for (let i = OFFSET; i < OFFSET + N; i++) {
  const r = rows[i % rows.length];
  const g = r.game ?? r;
  const domain = SCENARIO_DOMAINS[i % SCENARIO_DOMAINS.length];
  const t0 = Date.now();
  let sc = null, raw = '';
  try {
    if (MODE === 'cloud') {
      const res = await generateScenario(g, { model: 'gpt-5.6-luna', reasoning: 'low', domain });
      sc = res.scenario ?? null;
    } else {
      const sys = `${SCENARIO_SYSTEM_PROMPT}\n\nSET THIS SCENARIO IN THIS DOMAIN: ${domain}. Use that domain and no other. Everything else above still applies.`;
      const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'system', content: sys },
          { role: 'user', content: JSON.stringify(buildGroundingPayload(g)) }],
          temperature: 0.8, top_p: 0.95, max_tokens: 700 }) });
      const j = await res.json();
      raw = j.choices?.[0]?.message?.content ?? '';
      const m = raw.match(/\{[\s\S]*\}/);
      sc = m ? (JSON.parse(m[0]).suggestedScenario ?? null) : null;
    }
  } catch (e) { sc = null; raw = String(e).slice(0, 200); }
  const ms = Date.now() - t0;
  let gate = null;
  if (sc) {
    const v = validateScenario(sc, g); const cf = scenarioIsClaimFree(sc);
    const dirs = validateProseDirections(sc.description ?? '', sc, g);
    gate = { ok: !!(v.ok && cf.ok !== false && dirs.length === 0),
      why: [...(v.ok ? [] : (v.issues ?? [v.reason])), cf.ok === false ? cf.reason : null, ...dirs].filter(Boolean).join(' | ') };
  }
  appendFileSync(OUT, JSON.stringify({ i, domain, game: g, ms, sc, gate, raw: sc ? '' : raw.slice(0, 200) }) + '\n');
  n++;
  if (n % 25 === 0) process.stderr.write(`  ${n}/${N}\n`);
}
console.log(`wrote ${n} rows to ${OUT}`);

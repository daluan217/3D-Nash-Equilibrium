/**
 * BLUE-INPUT — capture the EXACT bytes `generateScenario` / `generateReport`
 * put on the wire, by pointing the shipped Foundry adapter at a local stub.
 *
 * Two jobs, and both exist because of specific past failures:
 *
 *  1. PRE-FLIGHT. `_gen/eval_v2.ts` passed `extraRules` to a `generateScenario`
 *     that does not read it; tsx transpiled without checking, the rule was
 *     dropped, and 0/160 was reported by NEVER ASKING. So before any A/B spends
 *     a call, assert the treatment arm's directive is actually IN the request
 *     and the control arm's is not.
 *
 *  2. BYTE-IDENTITY. A prompt edit that moves output on games where nothing was
 *     wrong invalidates every yield number the team holds. This diffs the
 *     assembled prompts of this worktree against a pristine origin/main
 *     worktree over a sweep of games, through the real functions, so "the
 *     report path is untouched" is a measurement rather than a reading of the
 *     diff.
 *
 * Nothing here calls a provider: the stub answers every request locally with a
 * canned, schema-shaped body. Zero generation calls.
 *
 *   MODE=preflight npx tsx _gen/blue_in1_promptcap.mjs
 *   MODE=hashes N=2000 npx tsx _gen/blue_in1_promptcap.mjs > /tmp/hashes_x.txt
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { generateScenario, generateReport, buildGroundingPayload } from '../src/utils/report.ts';

const MODE = process.env.MODE || 'preflight';
const N = Number(process.env.N || 2000);
const SEED = Number(process.env.SEED || 4242);

// ── the stub ────────────────────────────────────────────────────────────────
// A minimal OpenAI-compatible /chat/completions that records what it was sent.
const seen = [];
const BODY = JSON.stringify({
  suggestedScenario: {
    name: 'Stub', row1: 'Alpha Route', row2: 'Beta Route', col1: 'Dawn Slot', col2: 'Dusk Slot',
    description: 'Two carriers share one corridor. Each picks a route and a slot.', storyClaims: null,
  },
  prose: 'stub', claimedEquilibria: [], proseClaims: null, geometryClaims: null,
});
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { seen.push(JSON.parse(raw)); } catch { seen.push({ parseError: raw.slice(0, 200) }); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'stub', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: BODY } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
process.env.STUB_AZURE_FOUNDRY_ENDPOINT = `http://127.0.0.1:${port}/v1`;
process.env.STUB_AZURE_FOUNDRY_API_KEY = 'stub';
const MODEL = 'stub';

const take = () => { const m = seen.pop(); return { system: m.messages[0].content, user: m.messages[1].content }; };
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

let seed = SEED;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const game = (mag) => { const p = () => r3((rnd() * 2 - 1) * mag); return { a11: p(), a12: p(), a21: p(), a22: p(), b11: p(), b12: p(), b21: p(), b22: p() }; };

const G0 = { a11: 3, a12: -1, a21: 0, a22: 2, b11: 1, b12: 2, b21: 3, b22: -2 };

if (MODE === 'preflight') {
  // WHAT THIS ASSERTS NOW. The `requestSuffix` measurement scaffold this file
  // was first written against HAS BEEN REMOVED, because the change it measured
  // was refused (see src/briefingclaims.test.ts section 6). Leaving the old
  // arm-comparison checks behind would have left a file that passes by never
  // asking anything — the exact failure that voided the instruction canary.
  //
  // So what is left is the FINDING, pinned at the wire: the rung-3 paragraph is
  // conditional, its condition is never stated in the request, and the request
  // asks for the numbers the claim-free screen discards. If a future edit makes
  // any of those false, this stops passing and the refusal has to be re-argued.
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

  await generateScenario(G0, { model: MODEL, domain: 'freight routing', stakes: true });
  const ctrl = take();

  check('the system prompt carries the conditional paragraph',
    /if the request says the description must be claim-free/i.test(ctrl.system));
  check('the production request never states the condition',
    !/claim-free/i.test(ctrl.user));
  check('the production request DOES ask for the numbers the gate discards',
    /state that cell's numbers and cite the cell/.test(ctrl.user));
  check('and asks for storyClaims, which scenarioIsClaimFree never reads',
    /storyClaims/.test(ctrl.user) || /storyClaims/.test(ctrl.system));

  // A check that cannot fail is worthless. Prove this instrument can see an
  // absent directive by asking generateScenario for an option it does not have:
  // if a future signature silently accepted and dropped one, this would still
  // report the request as unchanged, which is what the canary failure looked
  // like from the inside.
  await generateScenario(G0, { model: MODEL, domain: 'freight routing', stakes: true, notAnOption: 'MARKER-TEXT' });
  const bogus = take();
  check('MUTATION: an unimplemented option is correctly seen as absent',
    !bogus.user.includes('MARKER-TEXT') && bogus.user === ctrl.user);
  // ...and that it WOULD see a present one, through the channel that does exist.
  await generateScenario(G0, { model: MODEL, domain: 'freight routing MARKER-TEXT', stakes: true });
  const via = take();
  check('MUTATION: a directive that IS delivered is seen', via.system.includes('MARKER-TEXT'));

  console.log(bad ? `\n${bad} FAILED` : '\nall preflight checks passed');
  server.close();
  process.exit(bad ? 1 : 0);
}

if (MODE === 'hashes') {
  // Report path (generateReport) and scenario path (generateScenario) over the
  // same games, plus the six shipped presets, printed as hashes so two
  // worktrees can be diffed line for line.
  const { PRESETS } = await import('../src/utils/gameEngine.ts');
  const lines = [];
  for (let i = 0; i < N; i++) {
    const g = game([0.5, 5, 30, 90][i % 4]);
    await generateScenario(g, { model: MODEL, domain: 'freight routing', stakes: true });
    const s = take();
    await generateReport(g, { model: MODEL });
    const rNoSc = take();
    await generateReport(g, { model: MODEL, scenario: { name: 'X', row1: 'Aa Bb', row2: 'Cc Dd', col1: 'Ee Ff', col2: 'Gg Hh', description: 'A long enough description to be usable by the scenario block gate here.' } });
    const rSc = take();
    lines.push(`${i} scen ${sha(s.system)} ${sha(s.user)} | rep0 ${sha(rNoSc.system)} ${sha(rNoSc.user)} | repSc ${sha(rSc.system)} ${sha(rSc.user)}`);
  }
  console.log(lines.join('\n'));
  if (PRESETS) {
    for (const [k, p] of Object.entries(PRESETS)) {
      const g = p;
      if (!g || typeof g.a11 !== 'number') continue;
      await generateScenario(g, { model: MODEL, domain: 'freight routing', stakes: true });
      const s = take();
      console.log(`preset:${k} scen ${sha(s.system)} ${sha(s.user)}`);
    }
  }
  server.close();
  process.exit(0);
}

if (MODE === 'payload') {
  // buildGroundingPayload is the shipped function itself, so this can sweep far
  // more games than an HTTP round trip allows. Hash both branches.
  const SC = { name: 'X', row1: 'Aa Bb', row2: 'Cc Dd', col1: 'Ee Ff', col2: 'Gg Hh', description: 'A long enough description to be usable by the scenario block gate here.' };
  const h = createHash('sha256');
  let k = 0;
  for (let i = 0; i < N; i++) {
    const g = game([0.5, 5, 30, 90, 1000][i % 5]);
    h.update(buildGroundingPayload(g)); h.update(' ');
    h.update(buildGroundingPayload(g, SC)); h.update(' ');
    k += 2;
  }
  console.log(`payload sweep: ${k} calls over ${N} games — rolling sha256 ${h.digest('hex')}`);
  server.close();
  process.exit(0);
}

console.error(`unknown MODE ${MODE}`);
server.close();
process.exit(2);

// Angle 5, live batch (local shipping server, same underlying Azure Foundry
// resource as production per round5's cost note): random non-tie games, NO
// scenario supplied (forces invention through inventScreenedScenario), timed,
// watching for elevated latency (evidence of >=1 gate-drop-and-reroll) and
// checking every response still has a real scenario or a documented failure.
const BASE = "http://localhost:3111";

function randomNonTieGame() {
  const r = () => Math.round((Math.random() * 18 - 9) * 10) / 10; // [-9,9], 1dp
  let g;
  do {
    g = { a11: r(), a12: r(), a21: r(), a22: r(), b11: r(), b12: r(), b21: r(), b22: r() };
  } while (g.a11 === g.a21 || g.a12 === g.a22 || g.b11 === g.b12 || g.b21 === g.b22);
  return g;
}

async function main() {
  const N = 60;
  const results = [];
  for (let i = 0; i < N; i++) {
    const payoffs = randomNonTieGame();
    const t0 = Date.now();
    const r = await fetch(BASE + "/api/report", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ payoffs }),
    });
    const j = await r.json().catch(() => null);
    const ms = Date.now() - t0;
    const hasScenario = !!j?.report?.suggestedScenario;
    results.push({ i, ms, status: r.status, hasScenario, source: j?.source });
    console.log(`draw ${i}: ${ms}ms status=${r.status} hasScenario=${hasScenario} source=${j?.source}`);
  }
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p90 = times[Math.floor(times.length * 0.9)];
  const noScenario = results.filter((r) => !r.hasScenario);
  const elevated = results.filter((r) => r.ms > p50 * 2.5);
  console.log(`\nN=${N} p50=${p50}ms p90=${p90}ms max=${times[times.length - 1]}ms`);
  console.log(`no-scenario responses: ${noScenario.length}/${N}`, JSON.stringify(noScenario));
  console.log(`elevated-latency (>2.5x p50) responses: ${elevated.length}`, JSON.stringify(elevated));
}
main().catch((e) => { console.error(e); process.exit(1); });

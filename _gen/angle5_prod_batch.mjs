// Angle 5, PRODUCTION: cross-check the local batches' elevated full-exhaustion
// rate (3/120 across two 60-draw local batches, vs the code's own stated
// ~0.04% design target) directly against production. 25 sequential requests,
// random non-tie games, no scenario supplied (forces invention), spaced
// naturally by response latency only (same pattern round5 used, well under
// the 20/min per-IP cap).
const PROD = "https://nash-equilibrium-backend-194708291738.us-east1.run.app";

function randomNonTieGame() {
  const r = () => Math.round((Math.random() * 18 - 9) * 10) / 10;
  let g;
  do {
    g = { a11: r(), a12: r(), a21: r(), a22: r(), b11: r(), b12: r(), b21: r(), b22: r() };
  } while (g.a11 === g.a21 || g.a12 === g.a22 || g.b11 === g.b12 || g.b21 === g.b22);
  return g;
}

async function main() {
  const N = 25;
  const results = [];
  for (let i = 0; i < N; i++) {
    const payoffs = randomNonTieGame();
    const t0 = Date.now();
    const r = await fetch(PROD + "/api/report", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ payoffs }),
    });
    const j = await r.json().catch(() => null);
    const ms = Date.now() - t0;
    const hasScenario = !!j?.report?.suggestedScenario;
    results.push({ i, ms, status: r.status, hasScenario });
    console.log(`draw ${i}: ${ms}ms status=${r.status} hasScenario=${hasScenario}`);
  }
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const noScenario = results.filter((r) => !r.hasScenario);
  console.log(`\nN=${N} p50=${p50}ms max=${times[times.length - 1]}ms`);
  console.log(`no-scenario responses: ${noScenario.length}/${N}`, JSON.stringify(noScenario));
}
main().catch((e) => { console.error(e); process.exit(1); });

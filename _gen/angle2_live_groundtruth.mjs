// Angle 2, live HTTP: verify /api/report's `groundTruth` field (computeAllNE)
// agrees with the prose's own stated equilibrium set/payoffs, for real tie
// and continuum-producing games, through the real server.
const BASE = "http://localhost:3111";
const cases = [
  { name: "row-tie-only", payoffs: { a11: 2, a12: 5, a21: 2, a22: 0, b11: 1, b12: 4, b21: 3, b22: 2 } },
  { name: "col-tie-only", payoffs: { a11: 3, a12: 1, a21: 0, a22: 4, b11: 2, b12: 2, b21: 5, b22: 1 } },
  { name: "both-tie", payoffs: { a11: 2, a12: 5, a21: 2, a22: 0, b11: 1, b12: 1, b21: 3, b22: 4 } },
  { name: "all-equal-area", payoffs: { a11: 3, a12: 3, a21: 3, a22: 3, b11: 2, b12: 2, b21: 2, b22: 2 } },
  { name: "one-sided-continuum-A", payoffs: { a11: 4, a12: 2, a21: 4, a22: 2, b11: 5, b12: 0, b21: 1, b22: 3 } },
];
async function main() {
  for (const c of cases) {
    const r = await fetch(BASE + "/api/report", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ payoffs: c.payoffs }),
    });
    const j = await r.json();
    console.log(`\n=== ${c.name} ===`);
    console.log("status", r.status, "source", j.source);
    console.log("groundTruth:", JSON.stringify(j.groundTruth));
    console.log("claimedEquilibria:", JSON.stringify(j.report?.claimedEquilibria));
    console.log("prose:", j.report?.prose);
    // Sanity: every groundTruth entry's x,y should be plausible probabilities.
    for (const eq of j.groundTruth || []) {
      if (eq.x < 0 || eq.x > 1 || eq.y < 0 || eq.y > 1) console.log("  !! out-of-range NE coordinate:", eq);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });

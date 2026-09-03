// Angle 4: concurrency on PRODUCTION. Two batches, all in parallel (Promise.all):
//   A) 10 concurrent templated-path requests (distinct supplied labels, no LLM
//      call -- cheap, tests concurrent synchronous rendering / shared mutable
//      state under Cloud Run max-instances=1, ALL traffic on ONE process).
//   B) 10 concurrent invention requests (no scenario supplied, forces a real
//      LLM call each -- tests concurrent ASYNC invocation for cross-request
//      leakage, e.g. a module-level variable accidentally shared across
//      concurrent in-flight requests instead of being request-scoped).
// Assert: no response's prose/scenario contains another REQUEST's distinctive
// marker string; report latency envelope; report any 429/500 shape verbatim.
const PROD = "https://nash-equilibrium-backend-194708291738.us-east1.run.app";

function distinctGame(seed) {
  // Vary payoffs slightly per request too, so a mixed-up response is also
  // detectable by payoff mismatch, not just by label string.
  const base = 1 + seed * 0.01;
  return { a11: 3 + base, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 + base };
}

function makeLabels(i) {
  // Each request gets a UNIQUE marker token baked into every label, so any
  // cross-request leakage is trivially detectable by substring search.
  const tag = `Zx${i}Marker`;
  return { row1: `${tag}RowA`, row2: `${tag}RowB`, col1: `${tag}ColA`, col2: `${tag}ColB` };
}

async function callTemplated(i) {
  const payoffs = distinctGame(i);
  const scenario = makeLabels(i);
  const t0 = Date.now();
  const r = await fetch(`${PROD}/api/report`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ payoffs, scenario }),
  });
  const ms = Date.now() - t0;
  const j = await r.json().catch(() => null);
  return { i, kind: "templated", status: r.status, ms, tag: `Zx${i}Marker`, prose: j?.report?.prose ?? "", raw: j };
}

async function callInvention(i) {
  const payoffs = distinctGame(100 + i);
  const t0 = Date.now();
  const r = await fetch(`${PROD}/api/report`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ payoffs }),
  });
  const ms = Date.now() - t0;
  const j = await r.json().catch(() => null);
  const sc = j?.report?.suggestedScenario;
  return {
    i, kind: "invention", status: r.status, ms,
    scenarioName: sc?.name, labels: sc ? [sc.row1, sc.row2, sc.col1, sc.col2] : [],
    prose: j?.report?.prose ?? "", raw: j,
  };
}

async function main() {
  console.log("=== Batch A: 10 concurrent templated requests, distinct marker labels ===");
  const aResults = await Promise.all(Array.from({ length: 10 }, (_, i) => callTemplated(i)));
  for (const r of aResults) console.log(`  #${r.i}: status=${r.status} ms=${r.ms} tag=${r.tag}`);

  console.log("\n=== Cross-contamination check (Batch A): does request i's response mention ANY other request's marker? ===");
  let aLeak = false;
  for (const r of aResults) {
    for (const other of aResults) {
      if (other.i === r.i) continue;
      if (r.prose.includes(other.tag)) {
        aLeak = true;
        console.log(`  !! LEAK: response #${r.i} contains marker "${other.tag}" from request #${other.i}`);
      }
    }
    // Also confirm response #i actually contains ITS OWN marker (sanity: the
    // templated path should always echo the supplied labels back).
    if (!r.prose.includes(r.tag)) {
      console.log(`  ?? response #${r.i} does NOT contain its OWN marker "${r.tag}" -- prose: ${JSON.stringify(r.prose.slice(0, 150))}`);
    }
  }
  console.log("Batch A cross-contamination found:", aLeak);

  console.log("\n=== Batch B: 10 concurrent invention requests (real LLM calls) ===");
  const bResults = await Promise.all(Array.from({ length: 10 }, (_, i) => callInvention(i)));
  for (const r of bResults) console.log(`  #${r.i}: status=${r.status} ms=${r.ms} scenarioName=${JSON.stringify(r.scenarioName)} labels=${JSON.stringify(r.labels)}`);

  console.log("\n=== Cross-contamination check (Batch B): any two responses sharing the IDENTICAL scenario name+labels? (statistically near-impossible unless mixed up) ===");
  let bLeak = false;
  for (let x = 0; x < bResults.length; x++) {
    for (let y = x + 1; y < bResults.length; y++) {
      const A = bResults[x], B = bResults[y];
      if (A.scenarioName && A.scenarioName === B.scenarioName && JSON.stringify(A.labels) === JSON.stringify(B.labels)) {
        bLeak = true;
        console.log(`  !! possible mixup: response #${A.i} and #${B.i} have IDENTICAL scenario+labels`);
      }
    }
  }
  console.log("Batch B duplicate/possible-mixup found:", bLeak);

  const all = [...aResults, ...bResults];
  const statuses = {};
  for (const r of all) statuses[r.status] = (statuses[r.status] || 0) + 1;
  const times = all.map((r) => r.ms).sort((x, y) => x - y);
  console.log("\n=== Summary ===");
  console.log("status codes:", JSON.stringify(statuses));
  console.log(`latency: min=${times[0]} p50=${times[Math.floor(times.length * 0.5)]} max=${times[times.length - 1]}`);
  const non200 = all.filter((r) => r.status !== 200);
  if (non200.length) console.log("non-200 responses:", JSON.stringify(non200.map((r) => ({ i: r.i, kind: r.kind, status: r.status, raw: r.raw }))));
}
main().catch((e) => { console.error("ERROR", e); process.exit(1); });

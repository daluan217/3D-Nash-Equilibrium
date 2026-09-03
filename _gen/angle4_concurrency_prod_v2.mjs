// Angle 4 v2: fixed Batch A -- digits in the marker labels tripped the
// EXISTING digity() screen in tieProseFull (by design, unrelated to
// concurrency), which fell back to generic Row/Col naming for every request
// and made the marker check vacuous. Use alphabetic-only markers this time so
// the templated path actually renders the supplied labels, and the
// cross-contamination check is meaningful. No paid draws (templated path).
const PROD = "https://nash-equilibrium-backend-194708291738.us-east1.run.app";

const WORDS = ["Zulu", "Yankee", "Xray", "Whiskey", "Victor", "Uniform", "Tango", "Sierra", "Romeo", "Quebec"];

function distinctGame(seed) {
  const base = 1 + seed * 0.01;
  return { a11: 3 + base, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 + base };
}

function makeLabels(i) {
  const tag = WORDS[i];
  return { row1: `${tag}RowAlpha`, row2: `${tag}RowBeta`, col1: `${tag}ColAlpha`, col2: `${tag}ColBeta` };
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
  return { i, status: r.status, ms, tag: WORDS[i], prose: j?.report?.prose ?? "", raw: j };
}

async function main() {
  console.log("=== Batch A v2: 10 concurrent templated requests, alphabetic marker labels ===");
  const aResults = await Promise.all(Array.from({ length: 10 }, (_, i) => callTemplated(i)));
  for (const r of aResults) console.log(`  #${r.i}: status=${r.status} ms=${r.ms} tag=${r.tag}`);

  console.log("\n=== Cross-contamination + self-presence check ===");
  let leak = false, missingOwn = 0;
  for (const r of aResults) {
    for (const other of aResults) {
      if (other.i === r.i) continue;
      if (r.prose.includes(other.tag)) {
        leak = true;
        console.log(`  !! LEAK: response #${r.i} contains marker "${other.tag}" from request #${other.i}`);
      }
    }
    if (!r.prose.includes(r.tag)) {
      missingOwn++;
      console.log(`  ?? response #${r.i} missing its OWN marker "${r.tag}" -- prose: ${JSON.stringify(r.prose.slice(0, 200))}`);
    }
  }
  console.log(`Cross-contamination found: ${leak} | responses missing their own marker: ${missingOwn}/10`);
  if (!leak && missingOwn === 0) console.log("CLEAN: every response contains exactly its own labels, no others.");
}
main().catch((e) => { console.error("ERROR", e); process.exit(1); });

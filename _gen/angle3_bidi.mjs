const BASE = "http://localhost:3111";
const payoffs = { a11: 3, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 };
async function report(scenario) {
  const r = await fetch(BASE + "/api/report", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ payoffs, scenario }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function main() {
  // RLO (U+202E) + label text + PDF (U+202C) -- classic bidi-spoof, e.g. to make
  // "evil.exe" look like "exe.live". Also raw control chars (bell, null), all
  // built via \u/\x escapes to avoid literal control bytes in the source file.
  const RLO = "‮";
  const PDF = "‬";
  const BELL = "\x07";
  const NUL = "\x00";
  const rloLabel = "Normal" + RLO + "droWesreveR" + PDF;
  const ctrlLabel = "Has" + BELL + "Bell" + NUL + "Null";
  const r = await report({ row1: rloLabel, row2: ctrlLabel, col1: "Left", col2: "Right" });
  const prose = r.json?.report?.prose || "";
  console.log("status", r.status, "source", r.json?.source);
  console.log("prose contains RLO?", prose.includes(RLO));
  console.log("prose contains PDF?", prose.includes(PDF));
  console.log("prose contains BELL?", prose.includes(BELL));
  console.log("prose contains NUL?", prose.includes(NUL));
  console.log("prose[0..250]", JSON.stringify(prose.slice(0, 250)));
  console.log("suggestedScenario", JSON.stringify(r.json?.report?.suggestedScenario));
}
main().catch(e => { console.error(e); process.exit(1); });

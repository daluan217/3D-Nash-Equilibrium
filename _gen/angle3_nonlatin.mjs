// Angle 3: non-Latin / complex-grapheme labels straddling the 40-unit clamp
// boundary, through the real /api/report path -- verify no split clusters
// reach prose, and try to push each family to/over the boundary.
const BASE = "http://localhost:3111";
const payoffs = { a11: 3, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 };

async function report(scenario) {
  const r = await fetch(BASE + "/api/report", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ payoffs, scenario }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// Build a label of exactly `targetUnits` UTF-16 units by repeating a cluster
// and padding, so the clamp boundary (40) falls INSIDE a cluster repeat
// wherever possible.
function repeatToLength(cluster, targetUnits) {
  let out = "";
  while (out.length < targetUnits) out += cluster;
  return out;
}

const cases = {
  family_zwj: "👨‍👩‍👧‍👦",       // 11 units/cluster
  flags: "🇺🇸🇯🇵🇩🇪🇫🇷",         // 4 units per flag, contiguous flags (segmenter must not merge them)
  skin_tone: "👍🏽",             // 4 units/cluster
  keycap: "1️⃣",                // 3 units/cluster
  devanagari: "क्षत्रिय",        // combining marks, real language text
  arabic_rtl: "مرحبا بكم في هذه اللعبة", // RTL real sentence
  cjk: "紅茶と緑茶を選ぶゲームです", // CJK real sentence
  hebrew_rtl: "שלום עולם זהו משחק",
};

async function main() {
  for (const [name, cluster] of Object.entries(cases)) {
    // Build a label around 38-44 units to straddle the 40 boundary from both sides.
    const label = repeatToLength(cluster, 44).slice === undefined ? cluster : (function() {
      let out = "";
      while (out.length < 44) out += cluster;
      return out;
    })();
    const r = await report({ row1: label, row2: "Alt", col1: "Left", col2: "Right" });
    const prose = r.json?.report?.prose || "";
    const suggested = r.json?.report?.suggestedScenario;
    // Scan for lone surrogates (unpaired high/low) as a mechanical corruption check.
    let loneSurrogate = false;
    for (let i = 0; i < prose.length; i++) {
      const c = prose.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        const next = prose.charCodeAt(i + 1);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) loneSurrogate = true;
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        const prev = prose.charCodeAt(i - 1);
        if (!(prev >= 0xD800 && prev <= 0xDBFF)) loneSurrogate = true;
      }
    }
    console.log(`--- ${name} --- inputLen=${label.length} status=${r.status} source=${r.json?.source} usedUserLabel=${!suggested} loneSurrogate=${loneSurrogate}`);
    console.log(`  raw label (clamped, from suggestedScenario or echoed): n/a (server doesn't echo back cleanScenario output directly)`);
    console.log(`  prose[0..200]: ${JSON.stringify(prose.slice(0, 200))}`);
  }
}
main().catch(e => { console.error("ERROR", e); process.exit(1); });

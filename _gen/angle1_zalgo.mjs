// Angle 1/3: zalgo (combining-mark run) label vs the #93 grapheme-safe clamp.
// A single grapheme cluster (base char + many combining marks) can be LONGER
// than maxLength; clampGraphemeSafe's loop tests
//   if (out.length + segment.length > maxLength) break;
// on the FIRST (and only) segment, so if segment.length > maxLength the whole
// clamp returns "" -- not a truncation, a total wipe.
const BASE = "http://localhost:3111";

function zalgo(n, tail) {
  return "H" + "́".repeat(n) + tail;
}

async function report(body) {
  const r = await fetch(BASE + "/api/report", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}

const payoffs = { a11: 3, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 3 }; // non-tie

async function main() {
  // Test 1: row1 is zalgo (81-unit single grapheme > LABEL_MAX 40), other 3
  // labels normal and non-zalgo. Expect: row1 clamps to "" -> undefined ->
  // hasLabels=false -> scenario "unusable" despite 3 perfectly good labels
  // and a real (if garbled) 4th one.
  const row1zalgo = zalgo(80, "elpTheUser"); // 91 units, one grapheme cluster of 91
  console.log("row1zalgo raw length (UTF-16 units):", row1zalgo.length);
  const r1 = await report({
    payoffs,
    scenario: { row1: row1zalgo, row2: "AltOption", col1: "ChoiceOne", col2: "ChoiceTwo" },
  });
  console.log("TEST1 status", r1.status);
  console.log("TEST1 source", r1.json?.source);
  console.log("TEST1 suggestedScenario", JSON.stringify(r1.json?.report?.suggestedScenario));
  console.log("TEST1 prose[0..300]", JSON.stringify((r1.json?.report?.prose || "").slice(0, 300)));
  console.log("TEST1 full json keys", Object.keys(r1.json || {}));

  // Test 2: same but wrapped as scenarioOnly:true so we ONLY probe cleanScenario's
  // effect on the label, not the whole /api/report branching (avoids invention
  // costs while still exercising the exact clamp function through the real
  // server code path). Actually scenarioOnly still goes through the same
  // cleanScenario() at top; but with scenarioOnly true and isTie false, it
  // returns early per the code around line 2198 (`req.body?.scenarioOnly !== true`)
  // -- so scenarioOnly:true SKIPS the whole rung-3 branch and falls through to
  // tiePolicy checks, which for a NON-tie game do nothing special either --
  // let's see what actually comes back.
  const r2 = await report({
    payoffs,
    scenario: { row1: row1zalgo, row2: "AltOption", col1: "ChoiceOne", col2: "ChoiceTwo" },
    scenarioOnly: true,
  });
  console.log("TEST2 (scenarioOnly) status", r2.status);
  console.log("TEST2 json", JSON.stringify(r2.json).slice(0, 500));

  // Test 3: description zalgo (>=12 words normal + 1 zalgo word) with NO labels
  // at all -- does the whole description get wiped or just clamped safely at
  // 1200 (bigger cap, single 91-unit grapheme still << 1200, should be fine)?
  const zalgoWord = zalgo(80, "");
  const words = Array.from({ length: 11 }, (_, i) => `word${i}`).join(" ");
  const desc = `${words} ${zalgoWord} tail-word-after-zalgo`;
  const r3 = await report({ payoffs, scenario: { description: desc } });
  console.log("TEST3 (long desc, zalgo mid, under 1200 total) status", r3.status);
  console.log("TEST3 source", r3.json?.source);
  console.log("TEST3 suggestedScenario present?", !!r3.json?.report?.suggestedScenario);

  // Test 4: description is JUST the zalgo word repeated to blow past 1200 units
  // in ONE grapheme (single base char + huge combining-mark run, no spaces at
  // all) -- server clamp maxLength=1200 for description. If the grapheme is
  // bigger than 1200, expect total wipe of the description.
  const bigZalgo = "Z" + "́".repeat(1400);
  console.log("bigZalgo raw length:", bigZalgo.length);
  const r4 = await report({
    payoffs,
    scenario: { row1: "Alpha", row2: "Beta", col1: "Gamma", col2: "Delta", description: bigZalgo },
  });
  console.log("TEST4 status", r4.status);
  console.log("TEST4 source", r4.json?.source);
  // description isn't rendered anywhere per tieProse.ts, so this should be
  // silent either way; recorded for completeness.
}
main().catch(e => { console.error("ERROR", e); process.exit(1); });

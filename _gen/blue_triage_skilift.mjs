/* BLUE TRIAGE: is the "Skilift Grooming" mangle deterministic at temp 0.8? */
const { SCENARIO_SYSTEM_PROMPT, buildGroundingPayload } = await import('../src/utils/report.ts');
const URL = 'http://localhost:8123/v1/chat/completions';
const g = { a11:3,a12:0,a21:5,a22:1, b11:3,b12:5,b21:0,b22:1 };
const domain = 'ski-lift grooming';
const sys = `${SCENARIO_SYSTEM_PROMPT}\n\nSET THIS SCENARIO IN THIS DOMAIN: ${domain}. Use that domain and no other. Everything else above still applies.`;
for (let i = 0; i < 5; i++) {
  const res = await fetch(URL, { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ messages:[{role:'system',content:sys},{role:'user',content:JSON.stringify(buildGroundingPayload(g))}],
      temperature:0.8, top_p:0.95, max_tokens:700 }) });
  const j = await res.json();
  const t = j.choices?.[0]?.message?.content ?? '';
  const m = t.match(/\{[\s\S]*\}/);
  const sc = m ? JSON.parse(m[0]).suggestedScenario : null;
  console.log(`draw ${i+1}: name=${JSON.stringify(sc?.name)}  rows=${JSON.stringify([sc?.row1,sc?.row2])}`);
}

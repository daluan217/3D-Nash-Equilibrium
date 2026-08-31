/* RED TEAM: the bundled offline path under conditions the happy path never
 * sees. The mathematics must never depend on the model, so every one of these
 * must degrade to the deterministic report rather than error, hang or crash. */
const { startLocalModel, stopLocalModel, LLAMA_PORT } = require(process.cwd() + '/electron-llama.cjs');
process.env.NODE_ENV='production'; process.env.PORT='14400';
process.env.ELECTRON_USER_DATA_PATH='/tmp/nash-robust';
const G = { a11:-2,a12:1,a21:1,a22:0,b11:1,b12:-2,b21:-2,b22:1 };
const report = async (g=G, ms=120000) => {
  const t0=Date.now();
  const r = await fetch('http://127.0.0.1:14400/api/report',{method:'POST',
    headers:{'content-type':'application/json'}, body:JSON.stringify({payoffs:g}),
    signal: AbortSignal.timeout(ms)});
  const j = await r.json();
  return { ms: Date.now()-t0, status:r.status, source:j.source,
           scenario:j.report?.suggestedScenario?.name ?? null,
           ne: Array.isArray(j.groundTruth) ? j.groundTruth.length : 0 };
};
const pass=[], fail=[];
const check=(name, ok, detail)=> (ok?pass:fail).push(`${name}${detail?' — '+detail:''}`);

(async () => {
  // 1. COLD START — the very first request after launch, model still warming.
  const t0=Date.now();
  const ok = await startLocalModel(console);
  check('bundle starts', ok, `${Date.now()-t0}ms to healthy`);
  require(process.cwd()+'/dist/server.cjs');
  await new Promise(r=>setTimeout(r,2000));
  const first = await report();
  check('first request after cold start succeeds', first.status===200 && first.ne>0, `${first.ms}ms source=${first.source}`);

  // 2. CONCURRENCY — llama-server is single-slot by default; the app must not
  //    deadlock or drop a request when two reports are asked for at once.
  const conc = await Promise.all([report(), report(), report()]);
  check('3 concurrent reports all answer', conc.every(c=>c.status===200 && c.ne>0),
    conc.map(c=>`${c.ms}ms/${c.source}`).join(' '));

  // 3. DEGENERATE GAMES — all-zero and extreme matrices through the full path.
  const degenerate = [
    ['all zeros', {a11:0,a12:0,a21:0,a22:0,b11:0,b12:0,b21:0,b22:0}],
    ['extremes',  {a11:100,a12:-100,a21:-100,a22:100,b11:-100,b12:100,b21:100,b22:-100}],
  ];
  for (const [nm,g] of degenerate) {
    const r = await report(g);
    check(`degenerate game (${nm}) still returns a report`, r.status===200 && r.ne>=0, `source=${r.source}`);
  }

  // 4. MODEL DIES MID-FLIGHT — the failure that matters most. The solver's
  //    answer must still arrive; only the story may go missing.
  stopLocalModel();
  await new Promise(r=>setTimeout(r,1500));
  let afterKill;
  try { afterKill = await report(G, 90000); }
  catch (e) { afterKill = { status:0, source:'THREW: '+String(e).slice(0,60), ne:0, ms:-1 }; }
  check('report still answers after the model is killed', afterKill.status===200 && afterKill.ne>0,
    `source=${afterKill.source} (scenario ${afterKill.scenario ?? 'dropped, as expected'})`);
  check('the mathematics survived the model dying', afterKill.ne>0, `${afterKill.ne} equilibria returned`);

  console.log('\n══════ LOCAL APP ROBUSTNESS ══════');
  for (const p of pass) console.log('  PASS  '+p);
  for (const f of fail) console.log('  FAIL  '+f);
  console.log(`\n${pass.length}/${pass.length+fail.length} passed`);
  process.exit(fail.length?1:0);
})();

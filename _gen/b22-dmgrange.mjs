// INVENTED ANGLE C — the DMG download route (server.ts:3734) under range
// requests and aborts, against LIVE production (the shipping condition for
// this route: the GCS branch only runs on Cloud Run, so a local server cannot
// exercise it at all). Read-only GETs; ranges kept tiny so this costs ~nothing.
// Rate limit is 10/60s, so pace the requests.
const BASE='https://nash-equilibrium-simulator.com/api/download/dmg';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const results=[];
async function probe(label, headers, {expectStatus, readBytes=0, abortAfter=0}={}) {
  const ctl=new AbortController();
  if (abortAfter) setTimeout(()=>ctl.abort(), abortAfter);
  const t0=Date.now();
  try {
    const r=await fetch(BASE,{headers,signal:ctl.signal});
    const h=Object.fromEntries([...r.headers].filter(([k])=>
      /content-length|content-range|accept-ranges|content-type|content-disposition|transfer-encoding|x-powered-by/i.test(k)));
    let got=0;
    if (readBytes>0 && r.body) {
      const rd=r.body.getReader();
      while (got<readBytes) { const {done,value}=await rd.read(); if(done)break; got+=value.length; }
      await rd.cancel().catch(()=>{});
    } else if (!readBytes) { await r.body?.cancel().catch(()=>{}); }
    results.push({label,status:r.status,headers:h,bytes:got,ms:Date.now()-t0});
    console.log(`${label.padEnd(34)} status=${String(r.status).padEnd(3)} ${JSON.stringify(h)} read=${got}B ${Date.now()-t0}ms`);
  } catch(e) {
    results.push({label,error:String(e.name)});
    console.log(`${label.padEnd(34)} ERROR ${e.name}: ${String(e.message).slice(0,70)}`);
  }
}
// 1. HEAD — must not stream, must carry a size.
{ const r=await fetch(BASE,{method:'HEAD'});
  const h=Object.fromEntries([...r.headers].filter(([k])=>/content-length|accept-ranges|content-type|content-disposition/i.test(k)));
  console.log(`${'HEAD'.padEnd(34)} status=${r.status} ${JSON.stringify(h)}`);
  results.push({label:'HEAD',status:r.status,headers:h}); }
await sleep(1500);
await probe('range bytes=0-99',           {Range:'bytes=0-99'},          {readBytes:200});
await sleep(1500);
await probe('range bytes=-64 (suffix)',   {Range:'bytes=-64'},           {readBytes:200});
await sleep(1500);
await probe('range past EOF start',       {Range:'bytes=999999999999-'}, {readBytes:0});
await sleep(1500);
await probe('range end past EOF',         {Range:'bytes=0-999999999999'},{readBytes:128, abortAfter:4000});
await sleep(1500);
await probe('malformed range',            {Range:'bytes=abc-def'},       {readBytes:128, abortAfter:4000});
await sleep(1500);
await probe('negative/inverted range',    {Range:'bytes=500-100'},       {readBytes:128, abortAfter:4000});
await sleep(1500);
await probe('multi-range (unsupported)',  {Range:'bytes=0-9,20-29'},     {readBytes:128, abortAfter:4000});
await sleep(1500);
await probe('abort mid-stream',           {},                            {readBytes:1e9, abortAfter:2500});
await sleep(2000);
// After an abort, is the route still healthy? (a leaked GCS stream / crashed
// instance would show here)
await probe('post-abort HEAD-equivalent', {Range:'bytes=0-9'},           {readBytes:32});
console.log('\n--- verdict checks ---');
const byLabel=Object.fromEntries(results.map(r=>[r.label,r]));
const chk=[];
// Guard the guard: a label that does not exist must ABORT, never quietly read
// as a HIT (or, worse, as an ok).
const need=(k)=>{ if(!(k in byLabel)) throw new Error('check references an unknown probe label: '+k); return byLabel[k]; };
for (const k of ['HEAD','range bytes=0-99','range bytes=-64 (suffix)','range past EOF start',
  'range end past EOF','malformed range','negative/inverted range','multi-range (unsupported)',
  'post-abort HEAD-equivalent']) need(k);
chk.push(['HEAD returns 200 with a Content-Length', byLabel['HEAD']?.status===200 && !!byLabel['HEAD']?.headers['content-length']]);
chk.push(['bytes=0-99 is a 206 with Content-Range', byLabel['range bytes=0-99']?.status===206 && !!byLabel['range bytes=0-99']?.headers['content-range']]);
chk.push(['suffix range is a 206',                  byLabel['range bytes=-64 (suffix)']?.status===206]);
chk.push(['start past EOF is 416, not 200/500',     byLabel['range past EOF start']?.status===416]);
chk.push(['end past EOF is 206 (clamped), not 416', byLabel['range end past EOF']?.status===206]);
chk.push(['malformed range does not 5xx',           (byLabel['malformed range']?.status||0)<500]);
chk.push(['inverted range does not 5xx',            (byLabel['negative/inverted range']?.status||0)<500]);
chk.push(['multi-range does not 5xx',               (byLabel['multi-range (unsupported)']?.status||0)<500]);
chk.push(['route healthy after an abort',           [200,206].includes(byLabel['post-abort HEAD-equivalent']?.status)]);
let bad=0;
for (const [name,ok] of chk) { console.log(`${ok?'ok  ':'HIT '} ${name}`); if(!ok) bad++; }
console.log(bad? `\n>>> ${bad} HIT(s)` : '\nEMPTY: every range/abort shape behaved');
process.exitCode = bad?2:0;

// ANGLE L (new, 2026-09-19) — never attacked on this surface. The renderer is
// hostile-by-assumption (it runs whatever a report/scenario string contains).
// contextBridge is supposed to deep-copy across the isolation boundary, so
// nothing the renderer does to Object.prototype, to the exposed object, or to
// the ARGUMENTS it passes should reach the main process or survive a reload.
// Q1 Can the renderer overwrite/delete the exposed API and break the app?
// Q2 Does polluting Object.prototype leak a property into the IPC payload?
// Q3 Does a getter that throws, or an argument mutated after the call, break main?
// Q4 Does any of it survive a reload (i.e. reach persistent state)?
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
const WT='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22';
const APP=WT+'/dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator';
const INSP=4895, sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const UDD='/tmp/b22-angleL-'+Date.now();
const child=spawn(APP,[`--inspect=${INSP}`,`--user-data-dir=${UDD}`],
  {cwd:'/tmp',env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});
let mlog=''; child.stdout.on('data',d=>mlog+=d); child.stderr.on('data',d=>mlog+=d);
class Insp{constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();
  this.ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&this.p.has(m.id)){this.p.get(m.id)(m);this.p.delete(m.id);}};}
 ready(){return new Promise((r,j)=>{this.ws.onopen=()=>r();this.ws.onerror=j;});}
 send(method,params={}){const id=++this.id;return new Promise(r=>{this.p.set(id,r);this.ws.send(JSON.stringify({id,method,params}));});}
 close(){try{this.ws.close();}catch{}}}
try{
  await sleep(7000);
  const tj=await (await fetch(`http://127.0.0.1:${INSP}/json/list`)).json();
  // Pick the MAIN process target, not a renderer: only main has `require`, and
  // tj[0] is not reliably main (that is why this probe first read 'require is
  // not defined' and every result came back {}).
  const mainT=tj.find((t)=>/node|main/i.test(t.title||'')||/electron-main/.test(t.url||''))||tj[0];
  console.log('inspector target:', JSON.stringify({title:mainT.title,url:(mainT.url||'').slice(0,60)}));
  const insp=new Insp(mainT.webSocketDebuggerUrl); await insp.ready(); await insp.send('Runtime.enable');
  // Drive the RENDERER through the main process's webContents.
  // executeJavaScript resolves a value from ANOTHER context; the inspector's
  // returnByValue flattens that to {}. Stringify inside the renderer so a
  // plain string crosses both boundaries.
  const inRenderer=async(expr)=>{
    const wrapped=`JSON.stringify((()=>{try{return (${expr});}catch(e){return {__err:String(e).slice(0,120)};}})())`;
    const r=await insp.send('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:
      `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(wrapped)})`});
    const raw=r.result?.result?.value;
    if(typeof raw!=='string'){
      const err=r.result?.exceptionDetails?.exception?.description || JSON.stringify(r.result?.result?.value);
      return 'EVAL-ERROR: '+String(err).slice(0,160);
    }
    try{ return JSON.parse(raw); }catch{ return raw; }
  };
  // CONTROL: the channel must carry a known value back, or every {} below is
  // the harness failing rather than the product refusing.
  const ctl=await inRenderer(`({probeAlive:2+2})`);
  if(!ctl || ctl.probeAlive!==4) throw new Error('CONTROL FAILED: renderer eval channel returns '+JSON.stringify(ctl));
  console.log('control ok: renderer eval channel returns real values');
  console.log('Q1 exposed API shape:', JSON.stringify(await inRenderer(
    `({keys:Object.keys(window.nashDesktop||{}),frozen:Object.isFrozen(window.nashDesktop)})`)));
  console.log('Q1 can the renderer REPLACE the bridge?:', JSON.stringify(await inRenderer(
    `(()=>{try{window.nashDesktop.setBackgroundColor=()=>'hijacked';
      return {replaced:window.nashDesktop.setBackgroundColor()==='hijacked'};}catch(e){return {threw:String(e).slice(0,80)};}})()`)));
  console.log('Q1 can it DELETE the bridge?:', JSON.stringify(await inRenderer(
    `(()=>{try{delete window.nashDesktop; return {deleted:typeof window.nashDesktop==='undefined'};}catch(e){return {threw:String(e).slice(0,80)};}})()`)));
  console.log('Q2 prototype pollution reaches main?:', JSON.stringify(await inRenderer(
    `(()=>{Object.prototype.__nashPwned='yes';
      try{window.nashDesktop && window.nashDesktop.setBackgroundColor('#123456');}catch(e){}
      return {polluted:({}).__nashPwned==='yes'};})()`)));
  const mainPolluted=await insp.send('Runtime.evaluate',{returnByValue:true,
    expression:`({mainSees: ({}).__nashPwned === 'yes'})`});
  console.log('Q2 MAIN process sees the pollution?:', JSON.stringify(mainPolluted.result?.result?.value));
  console.log('Q3 throwing getter / exotic args:', JSON.stringify(await inRenderer(
    `(()=>{const out=[];
      const nd=window.nashDesktop; if(!nd||!nd.setBackgroundColor) return 'bridge gone';
      const cases=[['throwingGetter',(()=>{const o={};Object.defineProperty(o,'toString',{get(){throw new Error('boom');}});return o;})()],
                   ['protoPayload',JSON.parse('{"__proto__":{"pwned":true}}')],
                   ['selfRef',(()=>{const a={};a.a=a;return a;})()]];
      for(const [n,v] of cases){ try{ nd.setBackgroundColor(v); out.push([n,'sent']); }catch(e){ out.push([n,'threw']); } }
      return out;})()`)));
  await sleep(600);
  console.log('Q4 main process alive:', (()=>{try{process.kill(child.pid,0);return true;}catch{return false;}})());
  const reloaded=await inRenderer(`(()=>({stillPwned: ({}).__nashPwned==='yes'}))()`);
  console.log('Q4 renderer state before reload:', JSON.stringify(reloaded));
  await insp.send('Runtime.evaluate',{expression:
    `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.reload()`});
  await sleep(3500);
  console.log('Q4 AFTER reload — pollution gone, bridge restored?:', JSON.stringify(await inRenderer(
    `({stillPwned: ({}).__nashPwned==='yes', bridgeBack: typeof window.nashDesktop?.setBackgroundColor})`)));
  console.log('main log clean:', !/uncaught|unhandled/i.test(mlog));
  insp.close();
} finally { try{child.kill('SIGKILL');}catch{} }

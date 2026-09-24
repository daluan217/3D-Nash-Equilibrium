// CONTROL 6: is the in-view EXTERNAL click timeout a PRODUCT hang or
// Playwright's own "wait for scheduled navigation" barrier?
// Discriminator: run the SAME click against a plain chromium page (no Electron,
// no app) serving an external anchor. If the barrier fires there too, it is
// Playwright's, not the app's.
import { chromium } from 'playwright';
import http from 'node:http';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const srv = http.createServer((q,s)=>{ s.writeHead(200,{'Content-Type':'text/html'}); s.end('<html><body><h1>ctl6</h1></body></html>'); });
await new Promise(r=>srv.listen(4894,'127.0.0.1',r));
const b = await chromium.launch();
const page = await b.newPage();
await page.goto('http://127.0.0.1:4894/');
// Arm P1: an external anchor whose navigation the BROWSER will attempt but the
// network cannot complete (no DNS/route here) — the closest plain-Chromium
// analogue of "the click starts a navigation that never commits".
await page.route('https://example.com/**', route => route.abort());
await page.evaluate(()=>{ const a=document.createElement('a'); a.id='x';
  a.href='https://example.com/p1'; a.textContent='x';
  a.style.cssText='position:fixed;top:4px;left:4px;padding:8px;font-size:20px'; document.body.appendChild(a); });
let p1='resolved'; const t0=Date.now();
try{ await page.click('#x',{timeout:5000}); }catch(e){ p1='TIMEOUT'; }
console.log('P1 plain-chromium aborted-external click:', p1, (Date.now()-t0)+'ms', 'url=',page.url());
// Arm P2: an anchor whose click handler preventDefaults — no navigation at all.
await page.evaluate(()=>{ const o=document.getElementById('x'); if(o)o.remove();
  const a=document.createElement('a'); a.id='x'; a.href='https://example.com/p2'; a.textContent='x';
  a.style.cssText='position:fixed;top:4px;left:4px;padding:8px;font-size:20px';
  a.addEventListener('click',e=>e.preventDefault()); document.body.appendChild(a); });
let p2='resolved'; const t1=Date.now();
try{ await page.click('#x',{timeout:5000}); }catch(e){ p2='TIMEOUT'; }
console.log('P2 plain-chromium preventDefault click:', p2, (Date.now()-t1)+'ms', 'url=',page.url());
await b.close(); srv.close();

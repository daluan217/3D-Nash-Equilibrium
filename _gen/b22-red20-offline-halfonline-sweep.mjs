// RED-DESKTOP-20 angle 2 sweep: confirm (empirically, not just by reading
// apiClient.ts) that none of {connection-refused, DNS-fail-shaped, 502, 503,
// 504} ever clears the stored token, for a token that was never actually
// presented-and-refused. Complements the code read of src/utils/apiClient.ts
// (the STALE/unauthorized/sessionDied/sessionCleared verdict machinery).
import { chromium } from 'playwright';
import { startOwnServer, ELECTRON_UA } from './harnesslib.mjs';
import http from 'node:http';

const WT = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22';

function mockWithStatus(port, status) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `synthetic ${status}` }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function runCase(label, mockBase, port) {
  const srv = await startOwnServer(WT, port, { mode: 'desktop', tag: `d20-offline-${label}` });
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: ELECTRON_UA });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((mb) => {
    localStorage.setItem('nash_sim_db_mode', 'cloud');
    localStorage.setItem('nash_sim_api_base', mb);
    localStorage.setItem('nash_sim_token_cloud', 'presumed-valid-token');
  }, mockBase);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const tokenAfter = await page.evaluate(() => localStorage.getItem('nash_sim_token_cloud'));
  const crashed = await page.locator('text=Something went wrong').isVisible().catch(() => false);
  console.log(`[${label}] token survived: ${tokenAfter === 'presumed-valid-token'} | crashed: ${crashed} | pageErrors: ${pageErrors.length}`);
  if (pageErrors.length) console.log(`[${label}] errors:`, pageErrors.slice(0, 3));

  await browser.close();
  srv.child.kill('SIGKILL');
  return { label, tokenSurvived: tokenAfter === 'presumed-valid-token', crashed, errorCount: pageErrors.length };
}

async function main() {
  const results = [];

  // Case A: connection refused (mock never started) -- "DNS fail"-shaped: fetch throws.
  results.push(await runCase('conn-refused', 'http://127.0.0.1:19999', 4890));

  // Cases B..D: the 502/503/504 statuses this probe's own header comment
  // names. The original had a syntax error here (missing `)`) so the file
  // never parsed and only case A was ever written — restored in full.
  const servers = [];
  let port = 4891;
  for (const [status, mockPort] of [[502, 19998], [503, 19997], [504, 19996]]) {
    const srv = await mockWithStatus(mockPort, status);
    servers.push(srv);
    results.push(await runCase(String(status), `http://127.0.0.1:${mockPort}`, port++));
  }
  for (const s of servers) s.close();

  const bad = results.filter((r) => !r.tokenSurvived || r.crashed);
  console.log('RESULTS:', JSON.stringify(results));
  if (bad.length) { console.log('HIT:', JSON.stringify(bad)); process.exitCode = 2; }
  else console.log('EMPTY: every transient-failure shape left the token intact and did not crash');
  return results;
}

main().then((r) => { console.log('DONE'); process.exit(0); }).catch((e) => { console.error('SWEEP FAILED', e); process.exit(1); });

// RED-DESKTOP-20 angle 2 probe: does the DELETE /api/games/:id call site in
// App.tsx treat a 200-with-non-JSON-body (captive portal / MITM proxy /
// misbehaving corporate filter) response as a SUCCESSFUL deletion, unlike
// GET /api/auth/me, GET /api/games, PATCH (edit) and POST (save), which all
// explicitly check `res.dataParsed` before trusting `res.ok`?
//
// Desktop's cloud-mode `apiBaseUrl` is fully user-configurable (App.tsx
// getApiUrl + MenuDrawer's onUpdateApiBaseUrl), so pointing it at an
// attacker/misbehaving server is reachable via the app's own Settings UI —
// no TLS MITM needed. This probe points cloud mode at a local mock server we
// control that answers DELETE with 200 + text/html.
import { chromium } from 'playwright';
import http from 'node:http';
import { startOwnServer, ELECTRON_UA } from './harnesslib.mjs';

// BLUE-LOOP-DESKTOP-22: the recovered copy of this probe referenced MOCK_BASE
// but contained NO mock server, so the app pointed cloud mode at a dead port,
// the saved-games list was always empty, and the probe reported "COULD NOT
// LOCATE the mock game" instead of ever exercising the DELETE call site it
// exists to test. Mock rebuilt to this file's OWN header comment: serves one
// game, and answers DELETE with the captive-portal shape (200 + text/html).
const MOCK_GAME = {
  id: 'g_captive_portal_test', userId: 'u_mock', name: 'Captive Portal Test Game',
  description: 'mock', payoffs: { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 },
  createdAt: new Date().toISOString(),
};
function startMock(port) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'DELETE') {
      // THE ATTACK: a captive portal / filtering proxy answers 200 with an
      // HTML interstitial. Nothing was deleted. Does the client believe it?
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Network sign-in required</h1></body></html>');
      return;
    }
    if (req.url.startsWith('/api/auth/me')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user: { id: 'u_mock', username: 'mockuser', email: 'mock@x.invalid' } }));
      return;
    }
    if (req.url.startsWith('/api/games')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([MOCK_GAME]));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, hits })));
}

const WT = '/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22';
const PORT = 4896;
const MOCK_BASE = 'http://127.0.0.1:4899';

async function main() {
  const srv = await startOwnServer(WT, PORT, { mode: 'desktop', tag: 'd20-delcp' });
  const mock = await startMock(Number(new URL(MOCK_BASE).port));
  console.log('server up:', srv.base, 'bundle', srv.bundle, '| mock up:', MOCK_BASE);

  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: ELECTRON_UA });
  const page = await context.newPage();
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));

  // Seed localStorage BEFORE the app boots so it starts already in cloud mode,
  // pointed at our mock, with a fake (but well-formed) token -- this exercises
  // exactly getApiUrl()/apiClient.ts/handleDeleteGame without needing to drive
  // a full register/login flow through a fake backend.
  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((mockBase) => {
    localStorage.setItem('nash_sim_db_mode', 'cloud');
    localStorage.setItem('nash_sim_api_base', mockBase);
    localStorage.setItem('nash_sim_token_cloud', 'fake.token.value');
  }, MOCK_BASE);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Open the saved-games drawer/list to find the mock game and its Delete button.
  // Try the menu drawer toggle.
  const openers = [
    () => page.getByRole('button', { name: /menu/i }).first().click({ timeout: 2000 }),
    () => page.locator('[aria-label="Open menu"]').click({ timeout: 2000 }),
  ];
  for (const o of openers) { try { await o(); break; } catch {} }
  await page.waitForTimeout(500);

  const gameCard = page.getByText('Captive Portal Test Game', { exact: false }).first();
  const cardVisibleBefore = await gameCard.isVisible().catch(() => false);
  console.log('game card visible before delete:', cardVisibleBefore);

  if (!cardVisibleBefore) {
    console.log('COULD NOT LOCATE the mock game in the UI -- dumping body text for diagnosis');
    console.log((await page.locator('body').innerText()).slice(0, 2000));
    console.log('mock hits:', JSON.stringify(mock.hits));
    // A probe that cannot reach its own call site must FAIL, never quietly
    // report nothing — that is how a vacuous pass ships.
    throw new Error('delete-captiveportal: the mock game never rendered, so the DELETE call site was never exercised');
  } else {
    // The saved-games list renders BOTH in the drawer and in the main panel;
    // the drawer's own backdrop intercepts pointer events for the panel copy,
    // so the original click never landed and the DELETE was never sent (the
    // probe then read "card still visible" as a pass — vacuous). Scope to the
    // row that is actually clickable, and VERIFY the request was issued.
    const deleteRequests = [];
    page.on('request', (r) => { if (r.method() === 'DELETE') deleteRequests.push(r.url()); });
    const rows = page.locator('[data-saved-game]').filter({ hasText: 'Captive Portal Test Game' });
    const rowCount = await rows.count();
    let clicked = false;
    for (let i = 0; i < rowCount && !clicked; i++) {
      const btn = rows.nth(i).locator('button[title*="Delete" i], button[aria-label*="Delete" i]').first();
      if (await btn.count().catch(() => 0) === 0) continue;
      try { await btn.click({ timeout: 3000 }); clicked = true; }
      catch (e) { console.log(`row ${i} click failed:`, e.message.split('\n')[0]); }
    }
    if (!clicked) {
      // Last resort: dismiss the drawer backdrop, then retry the panel copy.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      const btn = page.locator('[data-saved-game]').filter({ hasText: 'Captive Portal Test Game' })
        .locator('button[title*="Delete" i]').first();
      try { await btn.click({ timeout: 3000 }); clicked = true; }
      catch (e) { console.log('post-Escape click failed:', e.message.split('\n')[0]); }
    }
    await page.waitForTimeout(400);
    const confirmBtn = page.getByRole('button', { name: /^(delete|confirm|delete game)$/i });
    if (await confirmBtn.first().isVisible().catch(() => false)) {
      await confirmBtn.first().click().catch(() => {});
    }
    await page.waitForTimeout(1500);
    console.log('DELETE requests actually issued:', JSON.stringify(deleteRequests));
    console.log('mock hits:', JSON.stringify(mock.hits.filter((h) => h.startsWith('DELETE'))));
    if (!deleteRequests.length) {
      throw new Error('delete-captiveportal: no DELETE was ever sent — the call site under test was never exercised, so any verdict here would be vacuous');
    }
    const cardVisibleAfter = await gameCard.first().isVisible().catch(() => false);
    const believesDeleted = !cardVisibleAfter;
    console.log('game card visible AFTER delete click:', cardVisibleAfter);
    console.log('RESULT: client believes delete succeeded =', believesDeleted);
    // THE ASSERTION (unchanged in substance, now reachable): the mock answered
    // 200 + text/html and deleted NOTHING. A client that drops the row is
    // telling the user their game is gone when it is not.
    if (believesDeleted) {
      console.log('HIT: a 200-with-HTML (captive portal) DELETE was treated as a successful deletion');
      process.exitCode = 2;
    } else {
      console.log('EMPTY: the captive-portal DELETE was NOT treated as success');
    }
  }

  console.log('--- console messages (last 20) ---');
  for (const m of consoleMsgs.slice(-20)) console.log(m);

  await browser.close();
  srv.child.kill('SIGKILL');
  mock.server.close();
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });

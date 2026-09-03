import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { computeAllNE, describeContinua, computeMixedNE, fmtProb, fmtPayoff, EA, EB } from '../../src/utils/gameEngine';
import type { GamePayoffs } from '../../src/types';

const PORT = process.env.E2E_PORT || '3199';
const BASE = process.env.E2E_BASE || `http://localhost:${PORT}`;
const lines: string[] = [];
const fails: string[] = [];
function log(s: string) { lines.push(s); }
function check(cond: unknown, msg: string) { if (!cond) { fails.push(msg); lines.push(`FAIL: ${msg}`); } }

let server: ReturnType<typeof spawn> | null = null;
const userData = mkdtempSync(path.join(tmpdir(), 'red7-browser-'));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function killServer() {
  if (!server) return;
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((res) => server!.once('exit', res));
  server.kill('SIGKILL');
  await exited;
}

function toFlat(g: GamePayoffs): string[] {
  return [g.a11, g.a12, g.a21, g.a22, g.b11, g.b12, g.b21, g.b22].map(String);
}

(async () => {
  try {
    if (!(await waitReady())) {
      const serverDir = process.cwd();
      server = spawn('node', [path.join(serverDir, 'dist/server.cjs')], {
        cwd: userData,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          PORT,
          ELECTRON_USER_DATA_PATH: userData,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
      if (!(await waitReady())) throw new Error('server not ready');
    }

    const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(120000);

    async function dismissTour() {
      try {
        await page.locator('[aria-label="Exit tour"]').click({ timeout: 10000 });
      } catch {
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(300);
    }

    async function gotoHome() {
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await dismissTour();
    }

    async function setSpeed(v: number) {
      await page.evaluate((val) => {
        const el = [...document.querySelectorAll('input[type="range"]')].find((e) => (e as HTMLInputElement).min === '1') as HTMLInputElement | undefined;
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(el, String(val));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, v);
    }

    async function setMatrix(g: GamePayoffs) {
      const vals = toFlat(g);
      const matrix = page.locator('input[inputmode="decimal"][class*="text-center"]');
      for (let i = 0; i < 8; i++) {
        await matrix.nth(i).fill(vals[i]);
        await matrix.nth(i).blur();
      }
      await page.waitForTimeout(250);
    }

    async function resetRun() {
      const reset = page.getByRole('button', { name: /^Reset$/ });
      if (await reset.count()) {
        await reset.first().click();
        await page.waitForTimeout(250);
      }
    }

    async function panelLines() {
      return page.locator('[data-tour="ne"] li').allTextContents();
    }

    async function logLines() {
      const arr = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('div[aria-label="Simulation log"] p')];
        return nodes.map((n) => (n.textContent || '').trim()).filter(Boolean);
      });
      return [...new Set(arr)];
    }

    log(`# Browser probe base=${BASE}`);
    await gotoHome();

    const continuaFixtures: Array<{ name: string; g: GamePayoffs }> = [
      { name: 'row-of-ties', g: { a11: 1, a12: 2, a21: 1, a22: 2, b11: 2, b12: 1, b21: 0, b22: 3 } },
      { name: 'column-of-ties', g: { a11: 3, a12: 1, a21: 0, a22: 2, b11: 1, b12: 1, b21: 2, b22: 2 } },
      { name: 'all-equal', g: { a11: 5, a12: 5, a21: 5, a22: 5, b11: -2, b12: -2, b21: -2, b22: -2 } },
    ];

    for (const fx of continuaFixtures) {
      await setMatrix(fx.g);
      const panel = (await panelLines()).map((s) => s.replace(/\s+/g, ' ').trim());
      const panelBlob = panel.join(' | ');
      const expectedNE = computeAllNE(fx.g);
      const expectedCont = describeContinua(fx.g);
      log(`ANGLE1 fixture=${fx.name} panelCount=${panel.length} allNE=${expectedNE.length} continua=${expectedCont.length}`);
      for (const ne of expectedNE) check(panelBlob.includes(ne.label), `${fx.name}: panel missing NE label "${ne.label}"`);
      for (const c of expectedCont) check(panelBlob.includes(c), `${fx.name}: panel missing continuum line "${c}"`);

      await resetRun();
      const run = page.getByRole('button', { name: /^Run$/ }).first();
      await setSpeed(10);
      await run.click();
      await page.waitForFunction(() => {
        const ps = [...document.querySelectorAll('div[aria-label="Simulation log"] p')].map((p) => (p.textContent || '').trim());
        return ps.some((l) => l.startsWith('━━'));
      }, null, { timeout: 90000 });
      const logs = await logLines();
      const headline = [...logs].reverse().find((l) => l.startsWith('━━')) || '';
      check(headline.length > 0, `${fx.name}: no convergence/settled headline in log`);
      log(`ANGLE1 fixture=${fx.name} headline=${headline}`);
      await resetRun();
    }

    // Regret check for browser panel/log parity on mixed game
    const mixed: GamePayoffs = { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 };
    await setMatrix(mixed);
    await page.getByRole('button', { name: 'Opponent Regret' }).first().click();
    await page.waitForTimeout(250);
    await setSpeed(10);
    await page.getByRole('button', { name: /^Run$/ }).first().click();
    await page.waitForFunction(() => {
      const ps = [...document.querySelectorAll('div[aria-label="Simulation log"] p')].map((p) => (p.textContent || '').trim());
      return ps.some((l) => l.startsWith('━━ Mixed NE:'));
    }, null, { timeout: 120000 });

    const logs = await logLines();
    const finalMixed = [...logs].reverse().find((l) => l.startsWith('━━ Mixed NE:')) || '';
    const exact = computeMixedNE(mixed);
    check(!!exact, 'regret fixture must have mixed NE');
    if (exact) {
      const want = `x=${fmtProb(exact.x)}, y=${fmtProb(exact.y)}  E[A]=${fmtPayoff(EA(exact.x, exact.y, mixed))}  E[B]=${fmtPayoff(EB(exact.x, exact.y, mixed))}`;
      check(finalMixed.includes(want), `regret mixed headline mismatch; expected segment "${want}" got "${finalMixed}"`);
      const xDisc = logs.find((l) => l.startsWith('✓ x-coordinate discovered: ')) || '';
      const yDisc = logs.find((l) => l.startsWith('✓ y-coordinate discovered: ')) || '';
      check(xDisc.endsWith(fmtProb(exact.x)), `x-discovery mismatch: "${xDisc}" expected suffix "${fmtProb(exact.x)}"`);
      check(yDisc.endsWith(fmtProb(exact.y)), `y-discovery mismatch: "${yDisc}" expected suffix "${fmtProb(exact.y)}"`);
      log(`ANGLE3/4 regret headline=${finalMixed}`);
      log(`ANGLE4 handover x=${xDisc} ; y=${yDisc}`);
    }

    await browser.close();
  } catch (e) {
    fails.push(`fatal: ${String(e)}`);
    lines.push(`FAIL: fatal ${String(e)}`);
  } finally {
    await killServer();
    rmSync(userData, { recursive: true, force: true });
  }

  const text = lines.join('\n') + '\n';
  writeFileSync('_gen/red7/RED-MATH-7/002-browser-panel-log.out.txt', text, 'utf8');
  console.log(text);
  if (fails.length) {
    console.error(`Total FAILURES: ${fails.length}`);
    process.exit(1);
  }
  console.log('Browser panel/log probe passed.');
})();

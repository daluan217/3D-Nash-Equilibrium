/* RED-APP browser probe. Drives the real production build and scrapes what the
 * SCREEN says, never what the code says. Usage:
 *   node _gen/redapp_browser.mjs <scenarioName|custom> [matrix csv of 8]
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE || 'http://localhost:3041';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
page.setDefaultTimeout(60000);
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message.slice(0, 300)));

async function dismissTour() {
  try { await page.locator('[aria-label="Exit tour"]').click({ timeout: 20000 }); }
  catch { await page.keyboard.press('Escape'); }
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Guided tour"]'), null, { timeout: 10000 });
}
async function gotoHome() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await dismissTour();
  await page.waitForTimeout(400);
}
const $ = {
  run: page.getByRole('button', { name: /^Run$/ }),
  step: page.getByRole('button', { name: /^Step$/ }),
  reset: page.getByRole('button', { name: /^Reset$/ }),
  matrix: page.locator('input[inputmode="decimal"][class*="text-center"]'),
};
async function setSpeed(v) {
  return page.evaluate((val) => {
    const el = [...document.querySelectorAll('input[type="range"]')].find((e) => e.min === '1');
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(el, String(val)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
}
/* Ground truth for "has it converged": the app renders the equilibrium panel
 * heading only after convergence. Poll for it, never for a button label. */
async function runToConvergence(timeout = 120000) {
  await setSpeed(10);
  await $.run.click();
  return page.waitForFunction(() =>
    [...document.querySelectorAll('span')].some((s) => /Nash Equilibrium Reached/.test(s.textContent || ''))
    || [...document.querySelectorAll('p')].some((p) => /^━━/.test((p.textContent || '').trim())),
    null, { timeout }).then(() => true).catch(() => false);
}
/* The TeX SOURCE of every rendered formula, in document order — this is exactly
 * what the reader sees, with none of KaTeX's duplicated a11y text. */
const texts = () => page.evaluate(() => ({
  tex: [...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map((a) => a.textContent),
  labels: [...document.querySelectorAll('span')].filter((s) => /indifferent:|strictly prefers:/.test(s.textContent || '') && s.children.length === 0).map((s) => s.textContent.trim()),
  readout: [...document.querySelectorAll('div')].filter((d) => /P\(A playing Row 1\)|P\(B playing Col 1\)|Expected Payoff E\[/.test(d.textContent || '') && d.querySelectorAll('div').length === 0).map((d) => d.textContent.trim()),
  heading: [...document.querySelectorAll('span')].map((s) => s.textContent.trim()).find((t) => /Nash Equilibrium Reached/.test(t)) || null,
  finalLog: [...document.querySelectorAll('p')].map((p) => (p.textContent || '').trim()).filter((t) => /^━━/.test(t)),
  bodyNaN: /\bNaN\b|\bInfinity\b|\bundefined\b/.test(document.body.innerText),
}));

const arg = process.argv[2] || 'Search Game';
await gotoHome();
await page.getByRole('button', { name: arg, exact: false }).first().click();
await page.waitForTimeout(600);
const conv = await runToConvergence();
await page.waitForTimeout(800);
const t = await texts();

/* ── THE ASSERTION ────────────────────────────────────────────────────────────
 * Read only what is on the SCREEN. The panel prints, in document order:
 *   x^* = ...   y^* = ...   E[A] ...   E[B] ...
 *   E[Row 1] = p  <rel>  E[Row 2] = q
 *   E[Col 1] = p  <rel>  E[Col 2] = q
 * Two things must hold, and both failed on the shipped build:
 *   1. a line labelled "indifferent" must not print two different numbers
 *   2. when A is indifferent, E[A] and E[Row 1] are the same quantity, so the
 *      panel must print the same number for them
 */
const fails = [];
if (!conv) fails.push('did not converge');
const tex = t.tex;
const grab = (re) => tex.find((x) => re.test(x));
// Anchor on the RELATION line, not on the words: the surface legend
// "x = P(\\text{A plays Row 1})" also contains "Row 1", and matching it made the
// probe fail for the wrong reason on the very build it was meant to indict.
const rowLine = grab(/^\\mathbb\{E\}\[\\text\{Row 1\}\] =/);
const colLine = grab(/^\\mathbb\{E\}\[\\text\{Col 1\}\] =/);
// The RELATION is required here too. A bare "\\mathbb{E}[A]" is the
// expected-payoff FUNCTION heading further up the page, not the panel's value.
const eaTex = grab(/^\\mathbb\{E\}\[A\] [=<>]/), ebTex = grab(/^\\mathbb\{E\}\[B\] [=<>]/);
if (!rowLine || !colLine || !eaTex || !ebTex) fails.push(`panel not fully rendered: ${JSON.stringify({ rowLine, colLine, eaTex, ebTex })}`);

const parse = (line) => {
  const m = line.match(/^\\mathbb\{E\}\[\\text\{(?:Row|Col) 1\}\] = (\S+) (\S+) \\mathbb\{E\}\[\\text\{(?:Row|Col) 2\}\] = (\S+)$/);
  if (!m) { fails.push(`unparseable line: ${JSON.stringify(line)}`); return null; }
  return { p: m[1], rel: m[2], q: m[3] };
};
const rhs = (x) => x.replace(/^\\mathbb\{E\}\[[AB]\] /, '');
const R = rowLine && parse(rowLine), C = colLine && parse(colLine);
const aIndiff = (t.labels || []).some((l) => /^A indifferent/.test(l));
const bIndiff = (t.labels || []).some((l) => /^B indifferent/.test(l));

if (R && R.rel === '\\approx' && R.p !== R.q)
  fails.push(`"indifferent" prints two different numbers: E[Row 1] = ${R.p} approx E[Row 2] = ${R.q}`);
if (C && C.rel === '\\approx' && C.p !== C.q)
  fails.push(`"indifferent" prints two different numbers: E[Col 1] = ${C.p} approx E[Col 2] = ${C.q}`);
if (aIndiff !== (R && R.rel === '\\approx')) fails.push(`label "A indifferent" and the relation drawn disagree`);
if (bIndiff !== (C && C.rel === '\\approx')) fails.push(`label "B indifferent" and the relation drawn disagree`);
if (R && R.rel === '\\approx' && eaTex && rhs(eaTex) !== `= ${R.p}`)
  fails.push(`E[A] "${rhs(eaTex)}" and E[Row 1] "= ${R.p}" are the same quantity but print differently`);
if (C && C.rel === '\\approx' && ebTex && rhs(ebTex) !== `= ${C.p}`)
  fails.push(`E[B] "${rhs(ebTex)}" and E[Col 1] "= ${C.p}" are the same quantity but print differently`);
if (/e[+-]\d/.test(rowLine || '') || /e[+-]\d/.test(colLine || ''))
  fails.push('exponential notation reached the panel');
if (t.bodyNaN) fails.push('NaN/Infinity/undefined in body text');
if (consoleErrors.length) fails.push(`console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);

console.log('scenario   :', arg, '| converged:', conv);
console.log('heading    :', t.heading);
console.log('labels     :', JSON.stringify(t.labels));
console.log('panel TeX  :');
for (const x of tex) console.log('    ', JSON.stringify(x));
const shot = `/tmp/blueapp_shot_${arg.replace(/\W+/g, '_')}${process.env.SHOT_TAG || ''}.png`;
const panel = page.locator('div').filter({ hasText: /Nash Equilibrium Reached/ }).last();
try { await panel.screenshot({ path: shot }); } catch { await page.screenshot({ path: shot }); }
console.log('screenshot :', shot);
await browser.close();
if (fails.length) { console.error('\nFAIL (' + fails.length + '):'); for (const f of fails) console.error('  - ' + f); process.exit(1); }
console.log('\nPASS: the panel agrees with itself.');

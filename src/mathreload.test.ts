/**
 * A saved game's card shows the equilibria of the game it loads (BLUE-LOOP-MATH-22 F4).
 *
 * Stored rows are not all 3-dp: POST /api/games stored `payoffs` raw until cleanPayoffs
 * (5272830, 2026-06-17), and GET returns rows as stored. The drawer card solved the RAW
 * row while "Load" committed it through commitPayoffInput, so one game showed two answers:
 *   card  "Mixed NE (x*=0.828, y*=0.545) val (E[A]=-6.922, E[B]=0.058)"
 *   panel "Mixed NE (x*=0.827, y*=0.545) with values E[A]=-6.922, E[B]=0.059"
 * and the explainer request lost the game's story (mergedPresets !== loaded payoffs).
 *
 *   npx tsx src/mathreload.test.ts
 */
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedGamesList, formatSavedGames } from './components/SavedGamesList';
import { neValues } from './components/equilibriumPanel';
import {
  commitPayoffs, commitPayoffInput, splitEquilibriaByContinuum, describeContinua, PRESETS,
} from './utils/gameEngine';
import type { GamePayoffs } from './types';

let checks = 0;
const fails: Record<string, number> = {};
const firstFail: Record<string, string> = {};
const check = (name: string, ok: boolean, detail = ''): void => {
  checks++;
  if (ok) return;
  fails[name] = (fails[name] ?? 0) + 1;
  firstFail[name] ??= detail;
};
const K = ['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const;
const noop = () => {};

/** The drawer card's equilibrium lines, read from the REAL component's markup. */
function cardLines(row: unknown): string[] {
  const html = renderToStaticMarkup(React.createElement(SavedGamesList, {
    games: formatSavedGames([row]), canOwnGames: true, deletingGameIds: [], activePreset: 'none',
    onLoad: noop, onEdit: noop, onDelete: noop, onSignIn: noop, isDark: false, variant: 'drawer',
  }));
  return [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"'));
}
/** The same lines as the panel derives them (App.tsx strayNE/continua/neValues) on a matrix. */
function panelLines(g: GamePayoffs): string[] {
  const stray = splitEquilibriaByContinuum(g).stray.map((ne) => {
    const v = neValues(ne, g);
    return `${ne.label} val (E[A]=${v.a}, E[B]=${v.b})`;
  });
  const lines = [...stray, ...describeContinua(g)];
  return lines.length ? lines : ['No classic NE in real plane'];
}
/** What "Load" commits: handleLoadPreset reads mergedPresets, which reads commitPayoffs(row.payoffs). */
const loaded = (row: { payoffs: unknown }) => commitPayoffs(commitPayoffs(row.payoffs as GamePayoffs));
const rowOf = (payoffs: unknown, i = 0) => ({ id: `g${i}`, name: `Game ${i}`, description: 'd', payoffs });

// ── F4 verbatim ──────────────────────────────────────────────────────────────
const F4 = { a11: -5.3067, a12: -8.854, a21: -9.2666, a22: -4.1166, b11: -0.5135, b12: -1.3647, b21: 2.8025, b22: 6.8882 };
// Preconditions: the row really is off-grid, and the RAW row solves to the defect's answer,
// so a card that went back to reading it raw cannot pass the verbatim check by coincidence.
check('fixture F4: the stored row is not 3-dp', K.some((k) => Math.round(F4[k] * 1000) / 1000 !== F4[k]));
check('fixture F4: the raw row solves to the defect text',
  panelLines(F4 as GamePayoffs).includes('Mixed NE (x*=0.828, y*=0.545) val (E[A]=-6.922, E[B]=0.058)'), JSON.stringify(panelLines(F4 as GamePayoffs)));
const f4Card = cardLines(rowOf(F4));
check('F4 card shows the loaded game: "Mixed NE (x*=0.827, y*=0.545) val (E[A]=-6.922, E[B]=0.059)"',
  f4Card.includes('Mixed NE (x*=0.827, y*=0.545) val (E[A]=-6.922, E[B]=0.059)') && !f4Card.some((l) => l.includes('x*=0.828')),
  JSON.stringify(f4Card));
check('F4 card lines == panel lines after Load', JSON.stringify(f4Card) === JSON.stringify(panelLines(loaded(rowOf(F4)))),
  `${JSON.stringify(f4Card)} vs ${JSON.stringify(panelLines(loaded(rowOf(F4))))}`);

// ── F5: a row with `payoffs: null` crashed the whole app (mergedPresets read g.payoffs.a11) ──
for (const bad of [null, undefined, 'abc', {}, { a11: '3' }]) {
  let lines: string[] | string = [];
  try { lines = cardLines(rowOf(bad)); } catch (e) { lines = String(e); }
  check('F5 a malformed stored row renders a card, never throws', Array.isArray(lines), `${JSON.stringify(bad)}: ${lines}`);
  check('F5 a malformed stored row loads a finite matrix', K.every((k) => Number.isFinite(loaded(rowOf(bad))[k])), JSON.stringify(bad));
}

// ── App's read door: the loaded game and the story match both read the committed row ──
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const merged = app.slice(app.indexOf('const mergedPresets = useMemo'), app.indexOf('}, [userCustomGames]);'));
check('R1 mergedPresets commits the stored row through commitPayoffs', /commitPayoffs\(g\.payoffs\)/.test(merged), merged.slice(0, 300));
check('R1 no stored cell is read raw anywhere in App.tsx (`.payoffs.a11`)', !/\.payoffs\??\.[ab][12][12]\b/.test(app));
check('R1 App.tsx has no private matrix door (one commitPayoffs, from gameEngine)', !/const commitPayoffs\s*=/.test(app));

// ── sweep: card == loaded panel, over every stored-row shape ─────────────────
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry(0xf4);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const CELLS: Record<string, () => unknown> = {
  dp4: () => Math.round((rnd() * 20 - 10) * 1e4) / 1e4,                // the legacy shape (F4)
  dp3: () => Math.round((rnd() * 200 - 100) * 1000) / 1000,            // every row since 06-17
  halfway: () => pick([0.0005, -0.0005, 1.0005, -2.0015, 99.9995, -99.9995, 0.0015]),
  out: () => pick([150, -150, 100.0004, -100.0006, 1e21, -1e-7]),       // pre-clamp rows
  str: () => pick(['3', '-1.25', '0.0005', ' 2', '1e2', 'abc', '']),   // old API stored strings raw
  junk: () => pick([null, undefined, true, [1], {}]),
};
let n = 0, moved = 0;
for (const [kind, cell] of Object.entries(CELLS)) {
  for (let i = 0; i < 400; i++) {
    const p = Object.fromEntries(K.map((k) => [k, rnd() < 0.5 ? cell() : Math.floor(rnd() * 19) - 9]));
    const row = rowOf(p, i);
    const g = loaded(row);
    let card: string[] = [];
    try { card = cardLines(row); } catch (e) { check('S0 a stored row never throws in the card', false, `${kind} ${JSON.stringify(p)}: ${e}`); continue; }
    check('S1 card lines == panel lines after Load', JSON.stringify(card) === JSON.stringify(panelLines(g)),
      `${kind} ${JSON.stringify(p)}\n  card  ${JSON.stringify(card)}\n  panel ${JSON.stringify(panelLines(g))}`);
    check('S2 the loaded matrix is on the grid and in range', K.every((k) => Number.isFinite(g[k]) && Math.abs(g[k]) <= 100 && Math.round(g[k] * 1000) / 1000 === g[k]));
    if (JSON.stringify(panelLines(g)) !== JSON.stringify(panelLines(p as unknown as GamePayoffs))) moved++;
    n++;
  }
}
// Every row the current server can store is a fixed point of the door: its card is unchanged.
for (let i = 0; i < 2000; i++) {
  const g = Object.fromEntries(K.map((k) => [k, Math.round((rnd() * 200 - 100) * 1000) / 1000])) as unknown as GamePayoffs;
  check('S3 a 3-dp row is a fixed point of commitPayoffs', K.every((k) => Object.is(commitPayoffs(g)[k], g[k]) || (g[k] === 0 && commitPayoffs(g)[k] === 0)));
}
for (const [id, p] of Object.entries(PRESETS)) {
  if (id === 'custom') continue;
  const g = Object.fromEntries(K.map((k) => [k, (p as any)[k]])) as unknown as GamePayoffs;
  check('S4 every preset is a fixed point of the door', K.every((k) => commitPayoffInput(String(g[k])) === g[k]), id);
}
// Reach: the sweep must include rows whose raw answer DIFFERS from the loaded one (the F4 class).
check('reach: rows whose raw solve differs from the loaded one', moved > 50, `${moved}/${n}`);
check('reach: sweep size', n === 2400, `${n}`);

const failed = Object.keys(fails);
if (failed.length) {
  for (const k of failed) console.error(`  ✗ ${k}: ${fails[k]} failure(s); first: ${firstFail[k]}`);
  process.exit(1);
}
console.log(`✓ mathreload: ${checks} checks; ${n} stored rows (${moved} whose raw solve differs) show on their card the game Load commits`);

/**
 * REACHABILITY WITHOUT A CALL-PATH ARGUMENT.
 *
 * The claim "an `approx` between two different numbers is unreachable" was
 * resting on a chain about how the RUN behaves: it commits to a corner, so
 * `resolveProfile` projects there, so `profileConcept` returns 'pure', so the
 * mixed branch is never taken. That chain is only as strong as "the run is the
 * only thing that ever sets the profile", which a future edit can break by
 * adding a caller — a saved game, a jumped-to equilibrium, an NE-list click.
 *
 * So ask the question WITHOUT the chain: over ARBITRARY profiles — any point
 * the panel could conceivably be handed, however it got there, including
 * `computeAllNE`'s exact interior coordinates, which reach the panel through no
 * projection at all — can the renderer print `approx` between two different
 * 3dp strings?
 */
import {
  computeAllNE, computeMixedNE, describeContinua, resolveProfile, indifferenceAt,
  neTolerancePlayer,
} from '../src/utils/gameEngine';
import { indifferenceLines } from '../src/components/equilibriumPanel';
import type { GamePayoffs, SimState } from '../src/types';

function mk(s: number) { let a = s >>> 0; return () => {
  a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const profile = (x: number, y: number) => ({ exactX: x, exactY: y } as unknown as SimState);

let considered = 0, mixedPanels = 0, bad = 0, contGames = 0;
const worstExamples: string[] = [];

function check(g: GamePayoffs, x: number, y: number, how: string) {
  considered++;
  const res = resolveProfile(g, profile(x, y));
  if (res.concept !== 'mixed') return;              // the panel renders the PURE branch
  mixedPanels++;
  const L = indifferenceLines(g, res.x, res.y);
  for (const side of ['a', 'b'] as const) {
    const l = L[side];
    if (l.indifferent && l.pStr !== l.qStr) {
      bad++;
      if (worstExamples.length < 6) worstExamples.push(
        `${how} ${JSON.stringify(g)} @(${res.x},${res.y}) ${side}: ${l.pStr} approx ${l.qStr} ` +
        `| exact gap ${Math.abs(l.p - l.q)} | tol ${neTolerancePlayer(g, side === 'a' ? 'A' : 'B')}`);
    }
  }
}

const rnd = mk(20260901);
const SCALES = [1, 3, 9, 100];
const N = Number(process.env.N ?? 40000);
for (const SCALE of SCALES) {
  for (let i = 0; i < N; i++) {
    const v = () => Math.round((rnd() * 2 - 1) * SCALE * 1000) / 1000;
    const g = { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() } as GamePayoffs;
    // Deliberately manufacture continua and near-degeneracy: a flat player, a
    // partial tie, and a near-tie one ulp off flat. These are exactly the games
    // where a player can sit at a pure strategy INSIDE an equilibrium region.
    const shape = i % 5;
    if (shape === 1) { g.a11 = g.a21; g.a12 = g.a22; }                        // A fully flat
    if (shape === 2) { g.b11 = g.b12; }                                        // B partial tie
    if (shape === 3) { g.a11 = g.a21 + 1e-9; g.a12 = g.a22 - 1e-9; }           // A near-flat
    if (shape === 4) { g.b21 = g.b22; g.a12 = g.a22; }                          // both partial
    if (describeContinua(g).length) contGames++;

    // (a) arbitrary profiles — anything the panel could be handed
    check(g, rnd(), rnd(), 'random');
    check(g, 0, rnd(), 'edge-x0');
    check(g, 1, rnd(), 'edge-x1');
    check(g, rnd(), 0, 'edge-y0');
    check(g, rnd(), 1, 'edge-y1');
    // (b) BLUE-MATH's specific worry: computeAllNE's own coordinates, which
    //     reach a renderer through NO projection and NO corner commitment.
    for (const ne of computeAllNE(g)) check(g, ne.x, ne.y, `computeAllNE-${ne.type}`);
    const mn = computeMixedNE(g);
    if (mn) {
      check(g, mn.x, mn.y, 'computeMixedNE');
      // and just off it, where the tolerance has the most room to misfire
      check(g, mn.x + 4e-4, mn.y - 4e-4, 'near-mixed');
    }
  }
}

console.log(JSON.stringify({
  profilesConsidered: considered,
  gamesWithContinua: contGames,
  profilesRenderingTheMIXEDpanel: mixedPanels,
  approxBetweenDifferentNumbers: bad,
  examples: worstExamples,
}, null, 2));

// The tour e2e cases in run order (engine-major), shared by the scripts and e2esharding.test.ts: tour-timings.json
// must name exactly these tags, so a case with no CI timing, or a timing for a case that no longer runs, fails the
// shard-budget guard by name. The tag is the script's own case-line tag.
import { readFileSync } from 'node:fs';
const LAND = [1440, 900], PORTRAIT = [1024, 1366], SHEET = [390, 844];
/** @type {[kind: string, viewport: number[], hogMs: number, a: any, b?: string][]} typed rows: an inferred union broke tsc (CI 36540950287) */
export const WALK_CASES = [
  ...[['away', 'key'], ['away', 'click'], ['in view', 'click']].flatMap(([mode, adv]) => [LAND, PORTRAIT, SHEET].map((v) => ['walk', v, 0, mode, adv])),
  ['flight', LAND, 0, [3, 14]], ['flight', PORTRAIT, 0, [14]], ['flight', SHEET, 0, [3, 14]],
  ...[LAND, PORTRAIT, SHEET].flatMap((v) => [['interrupt', v, 0, v === SHEET ? [4, 14] : [14]], ['long frame', v, 0, [14]], ['slow', v, 550, [14]],
    ['held start', v, 0, [14]]]),
  // The same-target pair (steps s, s+1) held still at that layout in the in-view walk (CI 36533916769).
  // Next's modes (the fixture's NEXT): held 4 frames, in the cut's own task, Enter one frame later.
  ...['page cancels', 'page cancels same task', 'page cancels next frame Enter'].flatMap((k) => [[k, LAND, 0, 4], [k, PORTRAIT, 0, 15], [k, SHEET, 0, 4]]),
];
export const walkTag = (en, [kind, [w, h], hogMs, a, b]) => `[${en} ${w}x${h}${hogMs ? ` ${hogMs} ms frames` : ''} ${kind === 'walk' ? `${a} ${b}` : kind}]`;
export const walkTags = (engines = ['chromium', 'webkit']) => engines.flatMap((en) => WALK_CASES.map((c) => walkTag(en, c)));

// Tour scroll: [label, hogMs, shift (true = mid-scroll re-target, 'half'/'up'/'down' = sub-pixel, 'reopen'), viewport].
export const SCROLL_VIEWPORTS = { LAND: { width: 1440, height: 900 }, PORTRAIT: { width: 1024, height: 1366 }, SHEET: { width: 390, height: 844 }, SHORT: { width: 320, height: 568 } };
const { LAND: L, PORTRAIT: P, SHEET: SH, SHORT } = SCROLL_VIEWPORTS;
const SUBPX = [['half', 'across .5'], ['up', 'up across a whole pixel'], ['down', 'down across a whole pixel']];
/** @type {[label: string, hogMs: number, shift: boolean | string, viewport: { width: number, height: number }][]} */
export const SCROLL_CASES = [['normal frames', 0, false, L], ['550 ms frames', 550, false, L], ['mid-scroll re-target', 0, true, L],
  ['portrait normal frames', 0, false, P], ['portrait 550 ms frames', 550, false, P],
  ['sheet normal frames', 0, false, SH], ['sheet 550 ms frames', 550, false, SH], ['short sheet 550 ms frames', 550, false, SHORT],
  ...SUBPX.flatMap(([k, what]) => [[`sub-pixel re-layout ${what}`, 0, k, L], [`portrait sub-pixel re-layout ${what}`, 550, k, P]]),
  ['mid-scroll re-target 550 ms frames', 550, true, L], ['portrait mid-scroll re-target', 0, true, P],
  ['portrait mid-scroll re-target 550 ms frames', 550, true, P], ['sheet mid-scroll re-target', 0, true, SH],
  ['sheet mid-scroll re-target 550 ms frames', 550, true, SH], ['reopen', 0, 'reopen', L], ['portrait reopen 550 ms frames', 550, 'reopen', P]];
export const scrollTags = (engines = ['chromium', 'webkit']) => engines.flatMap((en) => SCROLL_CASES.map(([label]) => `[${en} ${label}]`));

// Tour shards pack like smoke's: slowest case first (run order on ties) onto the lightest shard, by tour-timings.json's
// CI seconds. Round-robin packed walk shard 2 at 759 s against a 646 s mean, and it ended the e2e gate (sweep 5).
// Returns each shard's tags in run order; a case with no CI time throws (it would otherwise run on no shard).
export function packTour(tags, rows, n) {
  const secs = new Map(rows), load = Array(n).fill(0), shardOf = new Map();
  for (const t of tags) if (typeof secs.get(t) !== 'number') throw new Error(`tour-timings.json has no CI time for ${t}: refresh it with scripts/shard-timings-from-run.mjs`);
  [...tags].sort((a, b) => secs.get(b) - secs.get(a)) // stable: ties keep run order
    .forEach((t) => { const i = load.indexOf(Math.min(...load)); shardOf.set(t, i); load[i] += secs.get(t); });
  return load.map((_, i) => tags.filter((t) => shardOf.get(t) === i));
}
export const TOUR_TIMINGS = JSON.parse(readFileSync(new URL('./tour-timings.json', import.meta.url), 'utf8'));
export const tourShards = (job, n) => packTour(job === 'walk' ? walkTags() : scrollTags(), TOUR_TIMINGS[`tour-${job}`], n);

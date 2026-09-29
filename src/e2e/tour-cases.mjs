// The tour e2e cases in run order (engine-major), shared by the scripts and e2esharding.test.ts: tour-timings.json
// must name exactly these tags, so a case with no CI timing, or a timing for a case that no longer runs, fails the
// shard-budget guard by name. The tag is the script's own case-line tag.
const LAND = [1440, 900], PORTRAIT = [1024, 1366], SHEET = [390, 844];
export const WALK_CASES = [
  ...[['away', 'key'], ['away', 'click'], ['in view', 'click']].flatMap(([mode, adv]) => [LAND, PORTRAIT, SHEET].map((v) => ['walk', v, 0, mode, adv])),
  ['flight', LAND, 0, [3, 14]], ['flight', PORTRAIT, 0, [14]], ['flight', SHEET, 0, [3, 14]],
  ...[LAND, PORTRAIT, SHEET].flatMap((v) => [['interrupt', v, 0, v === SHEET ? [4, 14] : [14]], ['long frame', v, 0, [14]], ['slow', v, 550, [14]],
    ['held start', v, 0, [14]]]),
];
export const walkTag = (en, [kind, [w, h], hogMs, a, b]) => `[${en} ${w}x${h}${hogMs ? ` ${hogMs} ms frames` : ''} ${kind === 'walk' ? `${a} ${b}` : kind}]`;
export const walkTags = (engines = ['chromium', 'webkit']) => engines.flatMap((en) => WALK_CASES.map((c) => walkTag(en, c)));

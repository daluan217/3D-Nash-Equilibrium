/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The settings a scenario invention may be placed in.
 *
 * WHY THIS EXISTS. Left to choose for itself, the model returns the same few
 * worlds. Measured over 60 held-out games, gpt-5.6-luna named "Satellite
 * Scheduling" in 10 of them (16.7%) and produced only 31 distinct names; the
 * local 0.6B distill collapses harder, to 28% on a single name. Two different
 * users with two different games were being told the same story.
 *
 * Diversity turned out not to be something a sampler can be tuned into —
 * raising temperature, top_k and repeat penalty on the local model moved its
 * top-name share from 52% to 27% and then plateaued, nowhere near the target.
 * But WHICH world to use is a free choice: nothing about the mathematics
 * depends on it, so the caller can simply make that choice and rotate it. Top
 * share then becomes roughly 1/|DOMAINS| by construction rather than a
 * property of the model's priors. Measured with this mechanism on the same 60
 * games: 47 distinct names, top share 3.3%, and slightly FASTER (4.52s vs
 * 5.14s p50) — a shorter search for a setting than inventing one unaided.
 *
 * Rules for editing this list:
 *  - Every entry must be a SETTING, never a claim about the game. The solver
 *    states all the mathematics; a domain that implies who should win would
 *    reintroduce exactly the defect rung 3 exists to remove.
 *  - Keep them concrete and mundane. "Vineyard irrigation" gives the model two
 *    parties and a decision; "strategy" or "negotiation" gives it nothing and
 *    it falls back to its priors.
 *  - Keep the list LONG. The top-name share is bounded below by 1/|DOMAINS|,
 *    so a short list caps how good this can get.
 *  - No proper nouns, no real organisations, no places that identify anyone.
 */
export const SCENARIO_DOMAINS: readonly string[] = [
  'vineyard irrigation', 'freight rail scheduling', 'hospital triage staffing',
  'film release timing', 'orchard harvest contracts', 'satellite downlink windows',
  'bakery supply orders', 'fishing quota negotiation', 'stadium concession pricing',
  'wind-farm maintenance', 'textile dyeing shifts', 'courier route bidding',
  'ski-lift grooming', 'coffee roastery sourcing', 'library acquisitions',
  'dairy co-op pricing', 'archive digitisation', 'port dredging windows',
  'pollination contracts', 'microbrewery distribution', 'glacier survey flights',
  'puppet theatre touring', 'saffron harvest labour', 'tidal turbine servicing',
  'antique restoration bids', 'radio telescope time', 'urban beehive siting',
  'ferry timetable slots', 'cheese cave ripening', 'marathon road closures',
  'seed bank exchanges', 'lighthouse relief shifts', 'peat bog restoration',
  'vinyl pressing queues', 'falconry pest control', 'canal lock scheduling',
  'observatory dome time', 'reindeer herding routes', 'kelp farm harvesting',
  'clocktower maintenance', 'greenhouse heat sharing', 'bell foundry casting',
  'salt marsh grazing rights', 'cable ferry crossings', 'herbarium loan requests',
  'quarry blasting windows', 'sawmill kiln booking', 'oyster bed leases',
  'planetarium show slots', 'mountain hut resupply', 'cranberry bog flooding',
  'letterpress print runs', 'avalanche patrol rosters', 'truffle foraging permits',
  'harbour pilot rotations', 'wool scouring capacity', 'mushroom substrate supply',
  'lock-keeper shift swaps', 'bird ringing station slots', 'ice rink resurfacing',
  'cider press bookings', 'telescope mirror recoating', 'rope ferry staffing',
  'hedge laying contracts', 'silage clamp sharing', 'kiln firing schedules',
  'seaweed drying racks', 'apiary winter siting', 'thatching crew rotas',
  'weir maintenance windows', 'bat survey nights', 'charcoal burn scheduling',
  'osier bed cutting', 'stone wall repair bids', 'orchard frost watch',
  'eel pass inspections', 'millpond sluice timing', 'coppice cutting cycles',
  'salt pan harvesting', 'dune fence placement',
];

/**
 * Pick a setting for one invention.
 *
 * Random rather than a counter: the request that most needs a fresh answer is
 * "New AI scenario", pressed repeatedly on the SAME game, where a per-process
 * counter would still march through the list in order and a per-game key would
 * hand back the same domain every time. `pick` is injectable so tests can be
 * deterministic without stubbing global randomness.
 */
export function pickScenarioDomain(pick: () => number = Math.random): string {
  const i = Math.floor(pick() * SCENARIO_DOMAINS.length);
  // Guard the endpoint: Math.random() can in principle return values whose
  // scaling floors to length, and a pick() from a test may be sloppy.
  return SCENARIO_DOMAINS[Math.min(Math.max(i, 0), SCENARIO_DOMAINS.length - 1)];
}

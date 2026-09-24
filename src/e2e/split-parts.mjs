/**
 * The loop lists §100-§103 were split along (TASK-18, 2026-09-23: 378/1086/735/326 s on
 * CI as single sections). Each part runs only its own slice, looked up by its OWN id, and
 * e2esharding.test.ts proves the slices partition the pre-split lists exactly.
 */
export const SPLIT_PARTS = {
  '100a': { combos: [[280, 3], [280, 2], [320, 3]] },
  '100b': { combos: [[360, 2], [390, 3], [390, 2]] },
  '100c': { combos: [[390, 1.5], [390, 1.45], [390, 1.63]], drawerHeights: [281, 400, 700] },
  '101a': { sizes: [[280, 844, 3]] },
  '101b': { sizes: [[280, 844, 2]] },
  '101c': { sizes: [[320, 844, 3]] },
  '101d': { sizes: [[390, 844, 2]] },
  '101e': { sizes: [[280, 640, 2]] },
  '101f': { sizes: [[390, 960, 3]] },
  '101g': { sizes: [[390, 844, 1]] },
  '102a': { viewports: [[280, 1], [320, 1], [390, 1]] },
  '102b': { viewports: [[430, 1], [768, 1], [768, 1.5]] },
  '102c': { viewports: [[1024, 1], [1280, 1], [1440, 1]] },
  '102d': { viewports: [[280, 3], [320, 2], [390, 3]] },
  '103a': { sizes: [[844, 390, 1]] },
  '103b': { sizes: [[667, 375, 1]] },
  '103c': { sizes: [[740, 360, 1]] },
};

// The widest legal payoff strings (enumerated, not sampled): every §102 legibility part
// writes all of them at each of its viewports.
export const WIDEST_PAYOFFS = ['-99.999', '-100', '100', '99.999', '-0.001', '-12.345', '-99.9999', '-100.0000'];

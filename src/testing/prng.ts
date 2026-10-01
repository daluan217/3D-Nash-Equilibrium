/**
 * The seeded PRNG every fuzz in this repo draws from: the classic LCG
 * (1103515245, 12345) in EXACT 32-bit arithmetic, returning [0, 1).
 * `seed * 1103515245` in doubles passes 2^53 and rounds, and that form cycles
 * every 10,466 draws from any seed (verify_tieprose's 300,000 games were
 * 20,185 distinct). src/prng.test.ts holds the period and the static ban.
 */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
}

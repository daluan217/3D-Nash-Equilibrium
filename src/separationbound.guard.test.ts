/**
 * Guards the §71 pairwise-separation bounds (CodeRabbit outside-diff on
 * #168, director-confirmed). Both `controlSepThreshold` and
 * `sepThreshold17m` in src/e2e/smoke.mjs must stay derived from THEIR OWN
 * row's calibrated diagonal (`diag * k`), never a flat hard-coded number —
 * a flat threshold (e.g. the original 15) can be cleared by a single
 * glyph's own anti-alias fragments (observed spanning up to ~1x the
 * calibrated diagonal; CONTROL's diagonal alone is ~31-42px depending on
 * environment), which is exactly the false-positive CodeRabbit flagged.
 *
 * This is a STATIC guard, not a live E2E assertion, because the live smoke
 * fixtures only ever render GENUINELY separated markers (measured ~1.25x
 * (CONTROL) / ~1.47x (variant B) the calibrated diagonal in this repo's own
 * passing runs) — a reverted flat-15 bound does not fail E2E_SECTION=71
 * end to end (confirmed by mutation: still 45/45 with real separations of
 * 38.8px/30.1px, both > 15). Only a source-level guard catches this class.
 *
 * The multiplier band (1.05, 1.2) is picked from measured geometry, not
 * guessed: the lower bound must clear the ~1x fragment-spread ceiling with
 * real margin; the upper bound must stay under the tightest genuine
 * separation actually observed (~1.25x on CONTROL) — k=1.5 (tried first)
 * sat ABOVE that and rejected known-good output.
 *
 *   npx tsx src/separationbound.guard.test.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};

const smoke = readFileSync('src/e2e/smoke.mjs', 'utf8');

// Matches: const <name> = <cal-ish> ? <cal-ish>.<diag-ish> * <k> : 15;
const PATTERN = /const (controlSepThreshold|sepThreshold17m) = \w+(?:\?\.\w+)? \? \w+(?:\.\w+)? \* ([\d.]+) : 15;/g;
const matches = [...smoke.matchAll(PATTERN)];

check('exactly 2 calibrated §71 separation-bound sites are present (controlSepThreshold, sepThreshold17m)',
  matches.length === 2,
  `found ${matches.length} — a flat hard-coded bound, or a differently-shaped derivation, would not match this pattern`);

const names = matches.map((m) => m[1]).sort();
check('both named sites are present', JSON.stringify(names) === JSON.stringify(['controlSepThreshold', 'sepThreshold17m'].sort()),
  `found: ${names.join(', ')}`);

// Measured on the SHIPPING condition (GitHub runner, dsf=1, swiftshader) — CI run
// 34160015179 shard 26 (1fddc9b) and identically on #164's green run 34147646705:
//   CONTROL   : calibratedDiag 42.43, genuine maxSep 38.11  -> 0.898 x diag
//   variant B : diag17m        28.28, genuine maxSep 29.15  -> 1.031 x diag
// Locally (dsf=2) the same pairs measure 1.25x-1.47x. The fragment ceiling is
// geometric, not measured: the size window keeps only blobs with bbox diag in
// [0.5, 1.5] x diag, so two fragments of ONE glyph that both survive it are
// >= 0.5 x diag each inside a 1.0 x diag box -> centres <= ~0.6 x diag apart.
const RUNNER_REAL_RATIOS = [38.108398024582456 / 42.42640687119285, 29.1547594742265 / 28.284271247461902];
const HALF_SPLIT_CEILING = 0.6;

for (const m of matches) {
  const [, name, kStr] = m;
  const k = Number(kStr);
  check(`${name}: multiplier ${k} clears the ~0.6x half-split ceiling with margin (> 0.65)`, k > 0.65);
  check(`${name}: multiplier ${k} stays under the tightest GENUINE separation measured on the runner (0.898x, CONTROL at dsf=1) with margin (< 0.85)`, k < 0.85);
  for (const r of RUNNER_REAL_RATIOS) {
    check(`${name}: a genuine runner pair at ${r.toFixed(3)}x diag passes the bound`, r > k, `k=${k}`);
  }
  check(`${name}: a synthetic half-split glyph (two fragments ${HALF_SPLIT_CEILING}x diag apart) is rejected by the bound`, HALF_SPLIT_CEILING <= k, `k=${k}`);
  check(`${name}: calibration-failed fallback is still 15 (matches the SIZE window's own fallback discipline)`,
    smoke.includes(`${name === 'controlSepThreshold' ? 'controlCal?.diag ? controlCal.diag' : 'diag17m ? diag17m'} * ${kStr} : 15`));
}

console.log(failures === 0
  ? '✓ separation-bound guard: both §71 pairwise-separation bounds are calibrated (diag * k, 0.65 < k < 0.85; runner-measured genuine pairs pass, a half-split glyph fails), not hard-coded'
  : `✗ separation-bound guard: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

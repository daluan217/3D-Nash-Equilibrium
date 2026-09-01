/**
 * BLUE-GATE — the corpus loader every measurement in this window shares.
 *
 * One loader, not one per harness, because the three disagreements this project
 * resolved today were all "a rate without its corpus": two people measuring the
 * same predicate on different pools and neither having a bug. Anything that
 * quotes a number imports THIS and prints the pool size it got.
 *
 * DEDUP IS ON CONTENT, not on (source, content). The same draw sits in more
 * than one file — a census keyed by source once reported 8 rejections where
 * there were 5 distinct draws. The bank raw is loaded FIRST so a shared row is
 * attributed to it.
 *
 * The bank raw at ~/nash-finetune-data/scenario_raw_v2.jsonl is READ-ONLY.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const BANK_RAW = `${process.env.HOME}/nash-finetune-data/scenario_raw_v2.jsonl`;
const SCRATCH = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const REPO = '/Users/danielluan/Desktop/3D-Nash-Equilibrium';

/** A synthetic zero-sum game for rows that record only a spread. */
const sg = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });

/**
 * Files whose rows are DELIBERATELY DEFECTIVE — planted mutants, decoys and
 * negative fixtures. Including them in a false-positive denominator would let a
 * rule score a "hit" on a row someone wrote for it to hit.
 *
 * Named explicitly rather than pattern-matched, so adding a corpus is a visible
 * decision instead of a silent one.
 */
const ADVERSARIAL = /^(mutate2?|neg_|neg2_|rt2d_decoy|blue_w[78]_(out|.*_accepted))/;

export function loadCorpus({ includeAdversarial = false } = {}) {
  const rows = [];
  const seen = new Set();
  const stats = { bankRows: 0, bankNulls: 0, files: 0, fileRows: 0, dupes: 0, adversarialSkipped: 0 };

  if (existsSync(BANK_RAW)) {
    for (const l of readFileSync(BANK_RAW, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      // A generation FAILURE, not a defect: no scenario to gate, cannot ship.
      // `?? ` would collapse null to undefined and silently count zero.
      if (r.scenario === null) { stats.bankNulls++; continue; }
      const sc = r.scenario ?? r.sc; const g = r.game ?? r.g;
      if (!sc || typeof sc !== 'object' || !g) continue;
      const key = `${sc.name} ${sc.description}`;
      if (seen.has(key)) { stats.dupes++; continue; }
      seen.add(key);
      rows.push({ src: 'BANK_RAW', sc, g, domain: r.domain });
      stats.bankRows++;
    }
  }

  // Every directory on this box that a generation harness has written a corpus
  // into. Enumerated rather than globbed: `find /private/tmp` also reaches other
  // agents' HIT DUMPS (red_gate/_rg/hits) and their planted-mutant pools, and a
  // false-positive denominator that contains rows written to be rejected is not
  // a denominator.
  const DIRS = [
    '/tmp', SCRATCH, `${SCRATCH}/rp`, `${SCRATCH}/blue/_gen`, `${SCRATCH}/debris/_gen`,
    '/private/tmp/rt2b', '/private/tmp/redwork', '/private/tmp/blue_w7_out',
    `${REPO}/_gen`, `${REPO}/_gen/results`,
  ];
  const files = [];
  for (const d of DIRS) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.jsonl')) continue;
      if (!includeAdversarial && ADVERSARIAL.test(f)) { stats.adversarialSkipped++; continue; }
      files.push(`${d}/${f}`);
    }
  }
  for (const f of files.sort()) {
    const src = f.split('/').pop().replace('.jsonl', '');
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      const sc = r.sc ?? r.scenario;
      if (!sc || typeof sc !== 'object') continue;
      const g = r.g ?? r.game ?? (r.spread != null ? sg(r.spread) : null);
      if (!g) continue;
      const key = `${sc.name} ${sc.description}`;
      if (seen.has(key)) { stats.dupes++; continue; }
      seen.add(key);
      rows.push({ src, sc, g, domain: r.domain });
      stats.fileRows++;
    }
    stats.files++;
  }
  return { rows, stats };
}

/** The shipped artifact — what a desktop user actually sees. */
export function loadBank(path = `${REPO}/src/data/scenarioBank.json`) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function describe(stats) {
  return `corpus: ${stats.bankRows} bank-raw + ${stats.fileRows} from ${stats.files} files `
    + `(${stats.dupes} content dupes collapsed, ${stats.bankNulls} generation failures excluded, `
    + `${stats.adversarialSkipped} adversarial files skipped)`;
}

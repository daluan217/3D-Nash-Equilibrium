/* FALSE-POSITIVE RATE of this window's three gate changes, replayed over every
 * stored scenario in both red corpora. The rule is absolute: no validator
 * change ships if it adds a SINGLE false positive. A draw that newly fails is
 * a false positive UNLESS it is one of the defects we set out to catch.
 *
 * Pre-step (the pinned pre-fix module is generated, never committed):
 *   git show <pre-fix-sha>:src/utils/nashValidator.ts > src/utils/nashValidator.PREFIX.ts
 *
 * NOTE ON WHAT A ZERO HERE DOES AND DOES NOT PROVE. These two corpora contain
 * none of the three positives — no missing label, no matching-language-on-a-
 * mismatch-game, no letter-form cross-attribution — so a 0 means "adds no false
 * positive", NOT "the checks work". The known-positive fixtures in
 * _gen/blue_fixtures.mjs and src/unit.test.ts carry that half, and RED 1's
 * 341-draw corpus (which does contain the F11 and F12 draws) is where to
 * confirm that exactly those, and only those, newly fail. */
import { readFileSync } from 'node:fs';
const NEW = await import('../src/utils/nashValidator.ts');
const OLD = await import('../src/utils/nashValidator.PREFIX.ts');
for (const [label, path] of [['LOCAL','/tmp/rt2_local.jsonl'],['CLOUD','/tmp/rt2_cloud.jsonl']]) {
  let rows; try { rows = readFileSync(path,'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { continue; }
  const ok = rows.filter(r => r.sc);
  let newlyFails = 0, newlyPasses = 0; const ex = [];
  for (const r of ok) {
    const g = r.game;
    const o = OLD.validateScenario(r.sc, g).ok && OLD.scenarioIsClaimFree(r.sc).ok !== false
      && OLD.validateProseDirections(r.sc.description ?? '', r.sc, g).length === 0;
    const n = NEW.validateScenario(r.sc, g).ok && NEW.scenarioIsClaimFree(r.sc).ok !== false
      && NEW.validateProseDirections(r.sc.description ?? '', r.sc, g).length === 0;
    if (o && !n) { newlyFails++; if (ex.length < 12) ex.push({ dom: r.domain, why: NEW.validateScenario(r.sc, g).issues }); }
    if (!o && n) newlyPasses++;
  }
  console.log(`\n${label}  n=${ok.length}`);
  console.log(`  newly REJECTED by the fix : ${newlyFails}  (${(100*newlyFails/ok.length).toFixed(1)}%)`);
  console.log(`  newly ACCEPTED (must be 0): ${newlyPasses}`);
  for (const e of ex) console.log(`     [${e.dom}] ${JSON.stringify(e.why)}`);
}

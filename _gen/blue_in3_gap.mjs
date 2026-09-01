/**
 * BLUE-INPUT — cost and byte-identity of requiring the two "riding on this"
 * readings to agree before the playerGap line fires.
 *
 * Run in the pristine origin/main worktree and in the candidate worktree and
 * diff. The claim to prove is not "few games change" but the sharper one: the
 * hint is byte-identical on EVERY game where the swing reading and the range
 * reading already named the same party, and the only games that change are the
 * ones where we were telling the model to build the wrong party as exposed.
 *
 *   N=200000 npx tsx _gen/blue_in3_gap.mjs > /tmp/gap_<arm>.txt
 */
import { createHash } from 'node:crypto';
import { stakesHint, describeStakes } from '../src/utils/scenarioStakes.ts';
import { PRESETS, generateRandomGame } from '../src/utils/gameEngine.ts';

const N = Number(process.env.N || 200000);
let seed = Number(process.env.SEED || 555);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const r3 = (x) => Math.round(x * 1000) / 1000;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

// Written out locally so the PRISTINE worktree can run this file unchanged.
const readings = (g) => {
  const s = describeStakes(g);
  const bySwing = s.swingA >= s.swingB ? 'A' : 'B';
  const rA = Math.max(g.a11, g.a12, g.a21, g.a22) - Math.min(g.a11, g.a12, g.a21, g.a22);
  const rB = Math.max(g.b11, g.b12, g.b21, g.b22) - Math.min(g.b11, g.b12, g.b21, g.b22);
  const byRange = rA > rB ? 'A' : rB > rA ? 'B' : null;
  return { fires: s.playerGap >= 4 && s.swing > 0, agree: byRange === bySwing };
};

const CORPORA = {
  'int[-9,9]': () => ({ a11: ri(-9, 9), a12: ri(-9, 9), a21: ri(-9, 9), a22: ri(-9, 9), b11: ri(-9, 9), b12: ri(-9, 9), b21: ri(-9, 9), b22: ri(-9, 9) }),
  'int[-100,100]': () => ({ a11: ri(-100, 100), a12: ri(-100, 100), a21: ri(-100, 100), a22: ri(-100, 100), b11: ri(-100, 100), b12: ri(-100, 100), b21: ri(-100, 100), b22: ri(-100, 100) }),
  'dec[-100,100]': () => { const p = () => r3((rnd() * 2 - 1) * 100); return { a11: p(), a12: p(), a21: p(), a22: p(), b11: p(), b12: p(), b21: p(), b22: p() }; },
};
const out = [];
for (const [name, mk] of Object.entries(CORPORA)) {
  let fires = 0; let conflict = 0;
  for (let i = 0; i < N; i++) {
    const g = mk();
    const r = readings(g);
    if (r.fires) { fires++; if (!r.agree) conflict++; }
    out.push(`${name}:${i} ${sha(stakesHint(g))} ${r.fires ? (r.agree ? 'FIRE-AGREE' : 'FIRE-CONFLICT') : '.'}`);
  }
  out.push(`SUMMARY ${name}: would-fire ${fires}/${N} = ${((fires / N) * 100).toFixed(2)}%, of which readings CONFLICT ${conflict} = ${((conflict / Math.max(fires, 1)) * 100).toFixed(2)}% of firings, ${((conflict / N) * 100).toFixed(3)}% of all games`);
}
// The app's random button (Math.random, unseeded): counts only, not hashes.
let rbFire = 0; let rbConf = 0;
for (let i = 0; i < 20000; i++) { const r = readings(generateRandomGame(i % 2 ? 'mixed' : 'pure')); if (r.fires) { rbFire++; if (!r.agree) rbConf++; } }
out.push(`SUMMARY randombutton: would-fire ${rbFire}/20000, conflicting ${rbConf}`);
for (const [k, p] of Object.entries(PRESETS)) {
  const r = readings(p);
  out.push(`preset:${k} ${sha(stakesHint(p))} ${r.fires ? (r.agree ? 'FIRE-AGREE' : 'FIRE-CONFLICT') : '.'}`);
}
// The game that forced the change (RED-INPUT's, re-derived here).
const FORCED = { a11: -8, a12: 6, a21: -8, a22: 7, b11: 3, b12: 8, b21: 4, b22: 3 };
out.push(`forcedcase ${sha(stakesHint(FORCED))} ${JSON.stringify(readings(FORCED))} names=${/Player [AB] has far more riding/.exec(stakesHint(FORCED))?.[0] ?? 'NO GAP LINE'}`);
console.log(out.join('\n'));

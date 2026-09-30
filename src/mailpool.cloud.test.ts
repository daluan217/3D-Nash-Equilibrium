/**
 * Hosted mail budget (server.ts `takeMail`), run from the real source (sweep 17: nothing capped the site's total
 * mail, so rotated IPs could spend Gmail's ~500/day on sign-ups or feedback and silence recovery; one known address
 * took 1440 codes a day). Rolling 24 h pools, a per-address cap, and the route contract: each pool is taken once,
 * before its route's send and after the route's cheaper refusals.
 *
 *   npx tsx src/mailpool.cloud.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const from = src.indexOf('const MAIL_POOLS = ');
const to = src.indexOf('\n}\n', src.indexOf('function takeMail(')) + 2;
assert(from > 0 && to > from, 'MAIL_POOLS/takeMail are gone from server.ts');
const js = ts.transpileModule(src.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let now = 0;
const load = () => new Function('performance', 'isDesktop', 'process',
  `${js}; return { takeMail, MAIL_POOLS, MAIL_PER_ADDRESS };`)({ now: () => now }, () => false, { env: {} }) as {
  takeMail: (pool: string, to?: string) => number; MAIL_POOLS: Record<string, number>; MAIL_PER_ADDRESS: number };

let n = 0;
const DAY = 86_400_000;
{
  const { takeMail, MAIL_POOLS } = load();
  // The pools together stay under Gmail's ~500/day, and recovery keeps its own share.
  const total = Object.values(MAIL_POOLS).reduce((a, b) => a + b, 0);
  assert(total <= 450 && MAIL_POOLS.recovery >= 100, `pools ${JSON.stringify(MAIL_POOLS)} (sum ${total}) must fit 450 with recovery >= 100`); n++;
  // Rolling, not fixed: fill signup at t = 0..cap-1 ms, then the next frees exactly when the FIRST send is a day old.
  now = 1_000;
  for (let i = 0; i < MAIL_POOLS.signup; i++) { now = 1_000 + i; assert.strictEqual(takeMail('signup', `a${i}@x.test`), 0); }
  now = 1_000 + DAY / 2;
  const w = takeMail('signup', 'late@x.test');
  assert.strictEqual(w, DAY / 2, `signup pool full: the wait is until the oldest send is 24 h old (${w})`); n++;
  now = 1_000 + DAY - 1;
  assert(takeMail('signup', 'late@x.test') > 0, 'a fixed window reset would admit here; a rolling one must not'); n++;
  now = 1_000 + DAY;
  assert.strictEqual(takeMail('signup', 'late@x.test'), 0, 'the oldest send turned 24 h old: one token frees'); n++;
  assert(takeMail('signup', 'late2@x.test') > 0, 'only ONE token freed (the second-oldest is still inside the day)'); n++;
  // Separate pools: a full signup pool leaves recovery, delete and feedback untouched.
  assert(takeMail('recovery', 'r@x.test') === 0 && takeMail('delete', 'd@x.test') === 0 && takeMail('feedback') === 0,
    'a full signup pool must not refuse recovery, delete or feedback'); n++;
}
{
  const { takeMail, MAIL_PER_ADDRESS } = load();
  now = 5_000;
  for (let i = 0; i < MAIL_PER_ADDRESS; i++) { now = 5_000 + i * 60_000; assert.strictEqual(takeMail('recovery', 'k@x.test'), 0); }
  assert(MAIL_PER_ADDRESS <= 5, `one address may take at most 5 mails a day (${MAIL_PER_ADDRESS})`); n++;
  const w = takeMail('recovery', 'k@x.test');
  assert.strictEqual(w, DAY - (MAIL_PER_ADDRESS - 1) * 60_000, `the 6th mail to one address waits for its first to age out (${w})`); n++;
  assert.strictEqual(takeMail('recovery', 'other@x.test'), 0, 'another address is not refused by k@x.test\'s cap'); n++;
  assert.strictEqual(takeMail('signup', 'k@x.test'), 0, 'the per-address cap is per pool'); n++;
}

// Route contract: each mailing route takes its pool once, before its send; register's new-row path takes it
// before the row is written (a refused sign-up must write nothing: that is what filled the store).
const body = (route: string) => { const s = src.indexOf(`app.post("${route}"`); return src.slice(s, src.indexOf('\n  }));', s)); };
for (const [route, pool, send] of [['/api/auth/register', 'signup', 'sendVerificationEmail('], ['/api/auth/forgot-password', 'recovery', 'sendRecoveryEmail('],
  ['/api/auth/delete-request', 'delete', 'sendDeleteEmail('], ['/api/feedback', 'feedback', 'sendFeedbackEmail(']] as const) {
  const b = body(route), takes = [...b.matchAll(new RegExp(`takeMail\\("${pool}"`, 'g'))].map((m) => m.index!), sends = [...b.matchAll(new RegExp(send.replace('(', '\\('), 'g'))].map((m) => m.index!);
  assert(sends.length > 0 && takes.length === sends.length, `${route}: one takeMail("${pool}") per ${send} (${takes.length} vs ${sends.length})`); n++;
  assert(sends.every((s, i) => takes[i] < s && (i === 0 || takes[i] > sends[i - 1])), `${route}: every ${send} is preceded by its own takeMail("${pool}")`); n++;
}
{
  const b = body('/api/auth/register'), take = b.lastIndexOf('takeMail("signup"'), write = b.indexOf('db.users = users;');
  assert(take > 0 && write > take, 'register: the new-row path takes the signup pool BEFORE writing the pending row'); n++;
  const f = body('/api/auth/forgot-password');
  assert(f.indexOf('takeMail("recovery"') > f.indexOf('if (!user || !user.isVerified)'), 'forgot: an unknown address takes no token (it sends nothing)'); n++;
}
assert(/const PENDING_TTL_MS = 60 \* 60 \* 1000;/.test(src), 'PENDING_TTL_MS must stay 1 h: pending rows x TTL is what the signup pool bounds'); n++;
console.log(`mailpool.cloud: ${n} checks passed`);

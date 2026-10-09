/**
 * plotMutationQueue under random interleavings (BLUE-LOOP-MATH-22 sweep 7, empty probe checked in).
 * Ops are sync, async, throwing or rejecting; some enqueue a child from inside (before or after an
 * await); outer enqueues land at random micro/macrotask gaps. Invariants: no two ops run at once,
 * outer ops start in enqueue order, an idle queue starts its op synchronously, a child starts after
 * its parent ends, every op runs once, returned promises never reject, onError sees each failure once,
 * pending returns to 0.   npx tsx src/mathqueue.test.ts
 */
import { enqueuePlotMutation, type PlotMutationQueue } from './utils/plotMutationQueue';
import { seededRandom } from './testing/prng';

const rnd = seededRandom(0x9e);
const fails: Record<string, string> = {};
let checks = 0;
const check = (name: string, ok: boolean, detail = '') => { checks++; if (!ok) fails[name] ??= detail; };
const wait = (k: number) => k === 0 ? Promise.resolve() : k === 1 ? new Promise<void>((r) => setTimeout(r, 0)) : new Promise<void>((r) => queueMicrotask(r));
const reach = { nested: 0, nestedAfterAwait: 0, thrown: 0, rejected: 0, busyEnqueue: 0 };

async function trial(t: number) {
  const q: PlotMutationQueue = { current: Promise.resolve(), pending: 0 };
  let running = 0, id = 0, clock = 0, errs = 0, wantErrs = 0;
  const runs = new Map<number, number>(), startAt = new Map<number, number>(), endAt = new Map<number, number>(), parentOf = new Map<number, number>();
  const started: number[] = [], all: Promise<void>[] = [];
  const track = (p: Promise<void>) => all.push(p.then(() => {}, (e) => check('a returned promise never rejects', false, `trial ${t}: ${e}`)));
  const mk = (depth: number): [number, () => void | Promise<void>] => {
    const me = id++, shape = Math.floor(rnd() * 6), nest = depth < 2 && rnd() < 0.3, late = rnd() < 0.5, w = Math.floor(rnd() * 3);
    if (shape >= 4) wantErrs++;
    return [me, () => {
      runs.set(me, (runs.get(me) ?? 0) + 1);
      check('no two plot mutations ever run at once', running === 0, `trial ${t} op ${me}`);
      running++; started.push(me); startAt.set(me, clock++);
      const end = () => { running--; endAt.set(me, clock++); };
      const child = () => { const [c, op] = mk(depth + 1); parentOf.set(c, me); reach.nested++; track(enqueuePlotMutation(q, op, () => { errs++; })); };
      if (shape === 0 || shape === 4) { if (nest) child(); end(); if (shape === 4) { reach.thrown++; throw new Error('sync throw'); } return; }
      return (async () => {
        if (nest && !late) child();
        await wait(w);
        if (nest && late) { child(); reach.nestedAfterAwait++; }
        if (shape >= 2) await wait(Math.floor(rnd() * 3));
        end();
        if (shape === 5) { reach.rejected++; throw new Error('async reject'); }
      })();
    }];
  };
  const outer: number[] = [];
  for (let i = 0, n = 2 + Math.floor(rnd() * 8); i < n; i++) {
    const [oid, op] = mk(0), idle = q.pending === 0;
    outer.push(oid); if (!idle) reach.busyEnqueue++;
    track(enqueuePlotMutation(q, op, () => { errs++; }));
    if (idle) check('an idle queue starts the op synchronously (Plotly.react initialises the div before returning)', started.includes(oid), `trial ${t} op ${oid}`);
    const gap = Math.floor(rnd() * 4);
    if (gap === 1) await Promise.resolve(); else if (gap === 2) await new Promise((r) => setTimeout(r, 0));
  }
  for (let k = 0; k < 50; k++) { const n = all.length; await Promise.all(all); if (all.length === n) break; }
  await new Promise((r) => setTimeout(r, 0));
  check('pending returns to 0', q.pending === 0, `trial ${t}: ${q.pending}`);
  for (let i = 0; i < id; i++) check('every op runs exactly once', runs.get(i) === 1, `trial ${t} op ${i}: ${runs.get(i) ?? 0}`);
  check('outer ops start in enqueue order', started.filter((s) => outer.includes(s)).join() === outer.join(), `trial ${t}: ${started} vs ${outer}`);
  for (const [c, p] of parentOf) check('a nested op starts after its parent ends', startAt.get(c)! > endAt.get(p)!, `trial ${t} child ${c} parent ${p}`);
  check('onError sees each failure exactly once', errs === wantErrs, `trial ${t}: ${errs} vs ${wantErrs}`);
}

for (let t = 0; t < 2000; t++) await trial(t);
check('reach: nested (incl. after an await), thrown, rejected and busy-queue enqueues all occurred',
  reach.nested >= 500 && reach.nestedAfterAwait >= 150 && reach.thrown >= 500 && reach.rejected >= 500 && reach.busyEnqueue >= 2000, JSON.stringify(reach));
const failed = Object.entries(fails);
if (failed.length) { for (const [n, d] of failed) console.error(`✗ ${n}: ${d}`); process.exit(1); }
console.log(`✓ mathqueue: ${checks} checks over 2000 random interleavings ${JSON.stringify(reach)}`);

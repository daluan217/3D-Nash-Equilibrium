/**
 * Guards §92's drawer-animation readiness oracle. The original expression
 * assigned a height and compared it to itself in the first poll, so it passed
 * before the drawer had finished translating. This check runs the real page
 * predicate through a small polling fake: it must establish a baseline first
 * and must reset when position changes while height stays constant.
 *
 *   npx tsx src/geometrysettling.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { waitForStableGeometry } from './e2e/settled-geometry.mjs';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ' -- ' + detail : ''}`); failures++; }
};

type Rect = { x: number; y: number; width: number; height: number };

const pollRects = async (rects: Rect[], options = {}) => {
  let polls = 0;
  let rect = rects[0];
  const panel = {
    getBoundingClientRect: () => rect,
  } as any;
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { querySelector: (selector: string) => selector === '#drawer' ? panel : null },
  });
  const page = {
    waitForFunction: async (predicate: (arg: any) => boolean, arg: any) => {
      for (const next of rects) {
        rect = next;
        polls++;
        if (predicate(arg)) return;
      }
      throw new Error(`never settled after ${polls} polls`);
    },
  };
  try {
    await waitForStableGeometry(page, '#drawer', options);
    return { settled: true, polls };
  } catch (error) {
    return { settled: false, polls, error: String(error) };
  } finally {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: previousDocument,
    });
  }
};

const still: Rect = { x: 0, y: 0, width: 300, height: 256 };
const translated: Rect = { x: 0, y: -32, width: 300, height: 256 };

const oneSample = await pollRects([still]);
check('a non-zero first rectangle alone never counts as settled',
  !oneSample.settled && oneSample.polls === 1, JSON.stringify(oneSample));

const stable = await pollRects([still, still, still]);
check('two consecutive stable animation-frame observations settle after the baseline',
  stable.settled && stable.polls === 3, JSON.stringify(stable));

const moving = await pollRects([still, translated, translated, translated]);
check('a translating drawer resets stability even when its height never changes',
  moving.settled && moving.polls === 4, JSON.stringify(moving));

const source = readFileSync('src/e2e/settled-geometry.mjs', 'utf8');
const hasBaseline = (candidate: string) =>
  /if \(!previous\) \{[\s\S]*?frames: 0[\s\S]*?return false;[\s\S]*?\}/.test(candidate);
const measuresFullRect = (candidate: string) =>
  /\['x', 'y', 'width', 'height'\]/.test(candidate)
    && /Math\.abs\(current\[key\] - previous\.rect\[key\]\)/.test(candidate);
check('the actual page predicate establishes a baseline before it can settle', hasBaseline(source));
check('the actual page predicate compares position as well as size', measuresFullRect(source));

const firstPollMutant = source.replace('if (!previous) {', 'if (false) {');
check('mutation: allowing the first sample to skip the baseline fails this guard', !hasBaseline(firstPollMutant));
const heightOnlyMutant = source.replace("['x', 'y', 'width', 'height']", "['height']");
check('mutation: restoring a height-only oracle fails this guard', !measuresFullRect(heightOnlyMutant));

if (failures > 0) { console.error(`✗ geometry-settling guard: ${failures} failed`); process.exit(1); }
console.log('✓ geometry-settling guard: baseline + full-rectangle stability are mutation-proven');

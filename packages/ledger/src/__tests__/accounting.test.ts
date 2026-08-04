/**
 * Every activity fed to the builder is accounted for.
 *
 * This is not an algorithm property, it is an honesty property. The exclusion rules are correct
 * -- a treadmill run genuinely covers no ground -- but silently dropping hundreds of them
 * produces a plausible map beside a headline number that is far too low, with nothing to
 * suggest anything is missing. `accepted + rejected` must equal what came in, and every
 * rejection must carry a reason a person can read.
 */

import { describe, expect, it } from 'vitest';
import { createBuilder } from '../ledger.js';
import { DEFAULT_PARAMS } from '../params.js';
import type { LedgerInput } from '../types.js';
import { straightRoad, treadmillShaped } from './synth.js';

/** Every reason the builder is allowed to give. A new one must be added deliberately. */
const KNOWN_REASONS = new Set([
  'trainer',
  'manual',
  'virtual',
  'no-gps',
  'stream-mismatch',
  'treadmill-shaped',
  'too-short',
]);

function feed(acts: LedgerInput[]) {
  const b = createBuilder(DEFAULT_PARAMS);
  for (const a of [...acts].sort((x, y) => x.startTs - y.startTs || x.id - y.id)) b.add(a);
  return b;
}

function at(base: LedgerInput, over: Partial<LedgerInput>): LedgerInput {
  return { ...base, ...over };
}

describe('build accounting', () => {
  const good = straightRoad({ lengthM: 1000, seed: 11, id: 1 });

  it('accounts for every activity, whatever happens to it', () => {
    const acts = [
      at(good, { id: 1, startTs: 100 }),
      at(good, { id: 2, startTs: 200, trainer: true }),
      at(good, { id: 3, startTs: 300, manual: true }),
      at(good, { id: 4, startTs: 400, sportType: 'VirtualRide' }),
      at(good, { id: 5, startTs: 500, latlng: [], time: [] }),
      at(good, { id: 6, startTs: 600, time: [1, 2, 3] }),
      at(treadmillShaped({ seed: 7, reportedDistanceM: 5000 }), { id: 7, startTs: 700 }),
      at(good, { id: 8, startTs: 800 }),
    ];

    const b = feed(acts);
    expect(b.accepted + b.rejected.length).toBe(acts.length);
  });

  it('names a reason for every rejection, and only reasons a person can be shown', () => {
    const acts = [
      at(good, { id: 1, startTs: 100, trainer: true }),
      at(good, { id: 2, startTs: 200, manual: true }),
      at(good, { id: 3, startTs: 300, sportType: 'VirtualRun' }),
      at(good, { id: 4, startTs: 400, latlng: [], time: [] }),
      at(good, { id: 5, startTs: 500, time: [1] }),
    ];

    const b = feed(acts);
    expect(b.rejected).toHaveLength(5);
    for (const r of b.rejected) {
      expect(KNOWN_REASONS.has(r.reason)).toBe(true);
      // The report shows these to the user, so they must be identifiable.
      expect(r.id).toBeGreaterThan(0);
      expect(typeof r.name).toBe('string');
    }
    expect(b.rejected.map((r) => r.reason)).toEqual([
      'trainer',
      'manual',
      'virtual',
      'no-gps',
      'stream-mismatch',
    ]);
  });

  it('rejects nothing when every activity is usable', () => {
    const b = feed([
      at(good, { id: 1, startTs: 100 }),
      at(good, { id: 2, startTs: 200 }),
      at(good, { id: 3, startTs: 300 }),
    ]);
    expect(b.rejected).toEqual([]);
    expect(b.accepted).toBe(3);
  });

  it('catches a treadmill-shaped recording that reports real distance', () => {
    const b = feed([at(treadmillShaped({ seed: 3, reportedDistanceM: 5000 }), { id: 1, startTs: 100 })]);
    expect(b.accepted).toBe(0);
    expect(b.rejected[0].reason).toBe('treadmill-shaped');
  });

  it('excluding an activity does not change what the others are credited', () => {
    const clean = feed([at(good, { id: 1, startTs: 100 }), at(good, { id: 8, startTs: 800 })]);
    const noisy = feed([
      at(good, { id: 1, startTs: 100 }),
      at(good, { id: 2, startTs: 200, trainer: true }),
      at(treadmillShaped({ seed: 7, reportedDistanceM: 5000 }), { id: 7, startTs: 700 }),
      at(good, { id: 8, startTs: 800 }),
    ]);
    expect(noisy.finish().totals.uniqueMeters).toBeCloseTo(
      clean.finish().totals.uniqueMeters,
      6,
    );
  });
});

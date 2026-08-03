/**
 * The adversarial suite from docs/algorithm.md sections 9 and 10.2.
 *
 * THESE TESTS ARE THE SPECIFICATION. If the implementation and a test disagree, the test is
 * right. Several deliberately assert DOCUMENTED FAILURES (A6b, A9c) so that a future change
 * which alters the behavior fails loudly and gets reviewed rather than passing silently.
 */

import { describe, expect, it } from 'vitest';
import { angDiff360, groundDist } from '../geo.js';
import { runLedger } from '../ledger.js';
import { DEFAULT_PARAMS, type Params } from '../params.js';
import type { LedgerInput } from '../types.js';
import {
  closedLoop,
  crossroads,
  fromLocalPath,
  outAndBack,
  straightRoad,
  switchbacks,
  trackLaps,
  treadmillShaped,
  withOffset,
  withOffsetSegment,
  withStationaryBlob,
  withTeleport,
} from './synth.js';

const P = (over: Partial<Params> = {}): Params => ({ ...DEFAULT_PARAMS, ...over });

function unique(acts: LedgerInput[], params: Params = DEFAULT_PARAMS): number {
  return runLedger(acts, params).totals.uniqueMeters;
}

/** Unique metres attributable to a single activity index. */
function uniqueOf(acts: LedgerInput[], idx: number, params: Params = DEFAULT_PARAMS): number {
  const b = runLedger(acts, params);
  return b.activities[idx]?.newGroundM ?? 0;
}

describe('A1 out-and-back', () => {
  it('counts the road once, not twice', () => {
    const a = outAndBack({ lengthM: 2000, sigmaM: 3, seed: 1 });
    const u = unique([a]);
    expect(u).toBeGreaterThan(1950);
    expect(u).toBeLessThan(2150);
  });

  it('is near-exact without noise', () => {
    const u = unique([outAndBack({ lengthM: 2000, sigmaM: 0, seed: 1 })]);
    expect(u).toBeGreaterThan(1980);
    expect(u).toBeLessThan(2020);
  });

  it('A1b: without the U-turn pass the apex sliver survives', () => {
    const a = outAndBack({ lengthM: 2000, sigmaM: 3, seed: 1 });
    const withPass = unique([a], P({ uTurnDedup: true }));
    const without = unique([a], P({ uTurnDedup: false }));
    expect(without).toBeGreaterThanOrEqual(withPass);
    expect(without).toBeLessThan(2200);
  });
});

describe('A1c turns spared', () => {
  it('the U-turn pass does not eat switchback turns', () => {
    const geom = { legs: 6, legLengthM: 100, spacingM: 15, riseM: 30, sigmaM: 3, seed: 5 };
    const on = unique([switchbacks(geom)], P({ uTurnDedup: true }));
    const off = unique([switchbacks(geom)], P({ uTurnDedup: false }));
    // Under 3 percent: the fold-back condition must spare the turns.
    expect(Math.abs(on - off) / off).toBeLessThan(0.03);
  });
});

describe('A2 repeat accretion', () => {
  it('100 passes over the same road do not accrete phantom miles', () => {
    const acts: LedgerInput[] = [];
    for (let i = 0; i < 100; i++) {
      acts.push(
        straightRoad({
          lengthM: 3000,
          sigmaM: 5,
          seed: 100 + i,
          startTs: 1700000000 + i * 86400,
          id: 5000 + i,
        }),
      );
    }
    const total = unique(acts);
    // Measured 3255 m on 3000 m of road: about 8.5 percent of envelope growth over 100
    // passes at 5 m cross-track sigma, and it converges rather than compounding.
    expect(total).toBeLessThan(3400);
    // The hundredth pass adds nothing at all -- this is the property that matters.
    expect(uniqueOf(acts, 99)).toBeLessThan(5);
  });

  it('A2b: a heavy noise tail does not blow up the total', () => {
    const acts: LedgerInput[] = [];
    for (let i = 0; i < 100; i++) {
      acts.push(
        straightRoad({
          lengthM: 3000,
          sigmaM: 8,
          heavyTailFrac: 0.1,
          heavyTailSigmaM: 18,
          seed: 300 + i,
          startTs: 1700000000 + i * 86400,
          id: 6000 + i,
        }),
      );
    }
    expect(unique(acts)).toBeLessThan(4600);
  });
});

describe('A3 divided road', () => {
  it('a carriageway 27 m away falls in the dead zone', () => {
    const a = straightRoad({ lengthM: 1000, sigmaM: 3, seed: 21, id: 7001 });
    const b = straightRoad({
      lengthM: 1000,
      offsetM: 27,
      sigmaM: 3,
      seed: 22,
      id: 7002,
      startTs: 1700086400,
    });
    const second = uniqueOf([a, b], 1);
    expect(second).toBeLessThan(250);
    expect(second).toBeGreaterThanOrEqual(0);
  });

  it('A3b: 35 m apart credits partially, and repetition does not recover it', () => {
    const a = straightRoad({ lengthM: 1000, sigmaM: 8, seed: 31, id: 7101 });
    const b = straightRoad({
      lengthM: 1000,
      offsetM: 35,
      sigmaM: 8,
      seed: 32,
      id: 7102,
      startTs: 1700086400,
    });
    const c = straightRoad({
      lengthM: 1000,
      offsetM: 35,
      sigmaM: 8,
      seed: 33,
      id: 7103,
      startTs: 1700172800,
    });
    const built = runLedger([a, b, c], DEFAULT_PARAMS);
    const secondM = built.activities[1].newGroundM;
    expect(secondM).toBeGreaterThan(300);
    expect(secondM).toBeLessThan(850);
    // The shortfall is permanent, not recovered by a repeat pass.
    expect(built.activities[2].newGroundM).toBeLessThan(50);
  });
});

describe('A4 parallel path', () => {
  it('a path 8 m away merges with the road', () => {
    const a = straightRoad({ lengthM: 1000, sigmaM: 3, seed: 41, id: 7201 });
    const b = straightRoad({
      lengthM: 1000,
      offsetM: 8,
      sigmaM: 3,
      seed: 42,
      id: 7202,
      startTs: 1700086400,
    });
    expect(uniqueOf([a, b], 1)).toBeLessThan(100);
  });
});

describe('A5 track laps', () => {
  it('25 laps of a 400 m track credit about one lap', () => {
    const a = trackLaps({ laps: 25, perimeterM: 400, laneOffsetM: 1.2, sigmaM: 3, seed: 51 });
    const u = unique([a]);
    expect(u).toBeGreaterThan(350);
    expect(u).toBeLessThan(520);
  });
});

describe('A6 switchbacks', () => {
  const geom = { legs: 6, legLengthM: 100, spacingM: 15, riseM: 30, sigmaM: 3, seed: 61 };
  // 6 legs of 100 m plus 5 semicircular turns of radius 7.5 m.
  const trueLen = 6 * 100 + 5 * Math.PI * 7.5;

  it('with barometric altitude, most of the climb is credited', () => {
    expect(unique([switchbacks(geom)])).toBeGreaterThan(0.8 * trueLen);
  });

  it('A6b: without altitude this is a DOCUMENTED FAILURE', () => {
    // Assert the failure. If this starts passing, the algorithm changed -- review it.
    const u = unique([switchbacks({ ...geom, withAltitude: false })]);
    expect(u).toBeLessThan(0.45 * trueLen);
  });
});

describe('A7 teleport', () => {
  it('a 5 km jump contributes nothing', () => {
    const base = straightRoad({ lengthM: 4000, sigmaM: 3, seed: 71 });
    const a = withTeleport(base, { afterM: 2000, jumpM: 5000, dtS: 300 });
    const u = unique([a]);
    expect(u).toBeGreaterThan(3800);
    expect(u).toBeLessThan(4250);
  });
});

describe('A8 stationary jitter', () => {
  it('ten minutes of standing still contributes almost nothing', () => {
    const base = straightRoad({ lengthM: 1000, sigmaM: 3, seed: 81 });
    const withBlob = withStationaryBlob(base, { durationS: 600, radiusM: 10, seed: 82 });
    const plain = unique([base]);
    const blobbed = unique([withBlob]);
    expect(blobbed - plain).toBeLessThan(60);
  });
});

describe('A9 offsets', () => {
  const first = straightRoad({ lengthM: 2000, sigmaM: 4, seed: 91, id: 7301 });
  const excursion = (offsetM: number) =>
    withOffsetSegment(
      straightRoad({ lengthM: 2000, sigmaM: 4, seed: 92, id: 7302, startTs: 1700086400 }),
      { fromFrac: 0.3, toFrac: 0.6, offsetM },
    );

  it('a 25 m excursion is absorbed by the dead zone', () => {
    expect(uniqueOf([first, excursion(25)], 1)).toBeLessThan(150);
  });

  it('A9b: a 40 m excursion is caught by the offset detector', () => {
    expect(uniqueOf([first, excursion(40)], 1, P({ offsetDetector: true }))).toBeLessThan(200);
  });

  it('A9c: with the detector off, the same excursion mints a DOCUMENTED phantom', () => {
    expect(uniqueOf([first, excursion(40)], 1, P({ offsetDetector: false }))).toBeGreaterThan(300);
  });

  it('a rigid whole-trace shift is NOT caught, by design', () => {
    // A pass shifted uniformly with no re-convergence is geometrically indistinguishable
    // from a genuinely new parallel road. The detector must not guess.
    const shifted = withOffset(
      straightRoad({ lengthM: 2000, sigmaM: 4, seed: 93, id: 7304, startTs: 1700172800 }),
      40,
    );
    expect(uniqueOf([first, shifted], 1, P({ offsetDetector: true }))).toBeGreaterThan(1500);
  });
});

describe('A10 sparse recording', () => {
  it('a 35 m-spaced pass over known ground adds almost nothing', () => {
    const dense = straightRoad({ lengthM: 2000, stepM: 8, sigmaM: 3, seed: 101, id: 7401 });
    const sparse = straightRoad({
      lengthM: 2000,
      stepM: 35,
      sigmaM: 3,
      seed: 102,
      id: 7402,
      startTs: 1700086400,
    });
    expect(uniqueOf([dense, sparse], 1)).toBeLessThan(150);
  });
});

describe('A11 perpendicular crossing', () => {
  it('crossing a covered road costs the new road nothing', () => {
    const [ew, ns] = crossroads({ lengthM: 1000, sigmaM: 3, seed: 111 });
    expect(uniqueOf([ew, ns], 1)).toBeGreaterThan(0.95 * 1000);
  });
});

describe('A12 exclusions', () => {
  it('virtual, trainer, manual and treadmill-shaped activities are excluded', () => {
    const virtual = straightRoad({ lengthM: 1000, sportType: 'VirtualRun', seed: 121, id: 7501 });
    const trainer = straightRoad({ lengthM: 1000, trainer: true, seed: 122, id: 7502 });
    const manual = straightRoad({ lengthM: 1000, manual: true, seed: 123, id: 7503 });
    const treadmill = treadmillShaped({ radiusM: 8, reportedDistanceM: 8000, seed: 124, id: 7504 });
    const built = runLedger([virtual, trainer, manual, treadmill], DEFAULT_PARAMS);
    expect(built.activities.length).toBe(0);
    expect(built.totals.uniqueMeters).toBe(0);
  });
});

describe('A14 small closed loops', () => {
  function coincidentPairs(built: ReturnType<typeof runLedger>): number {
    const s = built.sites;
    let pairs = 0;
    for (let i = 0; i < s.n; i++) {
      for (let j = i + 1; j < s.n; j++) {
        const cosLat = Math.cos((37.7749 * Math.PI) / 180);
        if (
          groundDist(s.x[i], s.y[i], s.x[j], s.y[j], cosLat) < 2 &&
          angDiff360(s.bearing[i], s.bearing[j]) <= 20
        ) {
          pairs++;
        }
      }
    }
    return pairs;
  }

  it('a 40 m loop mints no coincident duplicates', () => {
    const built = runLedger([closedLoop({ perimeterM: 40, laps: 1, sigmaM: 0, stepM: 1, seed: 141 })], DEFAULT_PARAMS);
    expect(coincidentPairs(built)).toBe(0);
    // Measured 28 m of 40 m: the last stretch is caught by the wrap-repeat rule once the
    // track has come most of the way round.
    expect(built.totals.uniqueMeters).toBeGreaterThan(20);
    expect(built.totals.uniqueMeters).toBeLessThanOrEqual(40);
  });

  it('A14b: a 94 m loop is partially credited, with no duplicates', () => {
    const built = runLedger([closedLoop({ perimeterM: 94, laps: 1, sigmaM: 0, stepM: 1, seed: 142 })], DEFAULT_PARAMS);
    expect(coincidentPairs(built)).toBe(0);
    expect(built.totals.uniqueMeters).toBeGreaterThan(40);
    expect(built.totals.uniqueMeters).toBeLessThan(80);
  });

  it('A14c: three laps credit the same as one', () => {
    const one = unique([closedLoop({ perimeterM: 40, laps: 1, sigmaM: 0, stepM: 1, seed: 143 })]);
    const three = unique([closedLoop({ perimeterM: 40, laps: 3, sigmaM: 0, stepM: 1, seed: 143 })]);
    expect(Math.abs(three - one)).toBeLessThan(2);
  });
});

describe('determinism', () => {
  it('shuffled input produces identical output', () => {
    const acts = [
      straightRoad({ lengthM: 1000, sigmaM: 3, seed: 201, id: 9001, startTs: 1700000000 }),
      straightRoad({ lengthM: 1000, offsetM: 200, sigmaM: 3, seed: 202, id: 9002, startTs: 1700086400 }),
      outAndBack({ lengthM: 500, sigmaM: 3, seed: 203, id: 9003, startTs: 1700172800 }),
    ];
    const a = runLedger(acts, DEFAULT_PARAMS);
    const b = runLedger([acts[2], acts[0], acts[1]], DEFAULT_PARAMS);
    expect(b.sites.n).toBe(a.sites.n);
    expect(Array.from(b.sites.creditM)).toEqual(Array.from(a.sites.creditM));
    expect(Array.from(b.touches.siteIds)).toEqual(Array.from(a.touches.siteIds));
    expect(b.activities).toEqual(a.activities);
  });
});

describe('credit sums', () => {
  it('resampled credits sum to the true leg length', () => {
    const a = fromLocalPath(
      Array.from({ length: 251 }, (_, i) => ({ e: i * 4, n: 0 })),
      { sigmaM: 0, seed: 1 },
    );
    // 250 segments of 4 m = 1000 m, one leg, so unique should be the full length.
    const u = unique([a]);
    expect(u).toBeGreaterThan(999);
    expect(u).toBeLessThan(1001);
  });
});

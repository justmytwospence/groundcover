/**
 * Every tunable in one place. See docs/algorithm.md section 8 for the justification of each
 * value. Do not change a value without a failing test that motivates it.
 */

/** Fixed order. firstTsByGroup blocks in the artifacts are indexed by this. */
export const SPORT_GROUPS = ['foot', 'ride', 'ski', 'water', 'other'] as const;
export type SportGroup = (typeof SPORT_GROUPS)[number];

export const GROUP_FOOT = 0;
export const GROUP_RIDE = 1;
export const GROUP_SKI = 2;
export const GROUP_WATER = 3;
export const GROUP_OTHER = 4;

/** Instantaneous speed caps per sport group, m/s, deliberately above elite performance. */
export const SPORT_CAPS: readonly number[] = [12.5, 30, 40, 8, 35];

export interface Params {
  RESAMPLE_M: number;
  R_REP: number;
  R_NEW: number;
  BEARING_TOL: number;
  BEARING_BASELINE_SAMPLES: number;
  GUARD_ALONG: number;
  L_MIN: number;
  GAP_SPLIT_M: number;
  GAP_SPLIT_S: number;
  STATION_S: number;
  STATION_D: number;
  ALT_GATE: number;
  CELL_MERC: number;
  FOLDBACK_RATIO: number;
  uTurnDedup: boolean;
  offsetDetector: boolean;
  OFFSET_MIN_RUN: number;
  OFFSET_SEARCH: number;
  OFFSET_MIN_FRAC: number;
  OFFSET_MAX_IQR: number;
  OFFSET_DIR_TOL: number;
}

export const DEFAULT_PARAMS: Params = Object.freeze({
  RESAMPLE_M: 8,
  R_REP: 20,
  R_NEW: 30,
  BEARING_TOL: 45,
  /** Samples either side used for the bearing baseline: 2 x 8 m = +/-16 m. */
  BEARING_BASELINE_SAMPLES: 2,
  GUARD_ALONG: 50,
  L_MIN: 24,
  GAP_SPLIT_M: 60,
  GAP_SPLIT_S: 60,
  STATION_S: 90,
  STATION_D: 24,
  ALT_GATE: 10,
  CELL_MERC: 64,
  FOLDBACK_RATIO: 0.4,
  uTurnDedup: true,
  offsetDetector: true,
  OFFSET_MIN_RUN: 200,
  OFFSET_SEARCH: 50,
  OFFSET_MIN_FRAC: 0.8,
  OFFSET_MAX_IQR: 8,
  OFFSET_DIR_TOL: 30,
});

/** Canonical JSON: keys sorted, so the hash depends only on values. */
function canonical(params: Params): string {
  const keys = Object.keys(params).sort();
  return JSON.stringify(keys.map((k) => [k, (params as unknown as Record<string, unknown>)[k]]));
}

/**
 * FNV-1a, 32 bit. Synchronous and dependency-free, which crypto.subtle is not. Collision
 * resistance is irrelevant here: this only needs to change when the parameters change.
 */
export function hashParams(params: Params): string {
  const s = canonical(params);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, '0')}`;
}

export const PARAMS_HASH = hashParams(DEFAULT_PARAMS);

/** Strava sport_type -> sport group index. Anything unlisted with GPS falls to `other`. */
const GROUP_BY_SPORT: Record<string, number> = {
  Run: GROUP_FOOT,
  TrailRun: GROUP_FOOT,
  Walk: GROUP_FOOT,
  Hike: GROUP_FOOT,
  Snowshoe: GROUP_FOOT,
  Wheelchair: GROUP_FOOT,
  VirtualRun: GROUP_FOOT,

  Ride: GROUP_RIDE,
  GravelRide: GROUP_RIDE,
  MountainBikeRide: GROUP_RIDE,
  EBikeRide: GROUP_RIDE,
  EMountainBikeRide: GROUP_RIDE,
  Handcycle: GROUP_RIDE,
  Velomobile: GROUP_RIDE,
  VirtualRide: GROUP_RIDE,

  NordicSki: GROUP_SKI,
  AlpineSki: GROUP_SKI,
  BackcountrySki: GROUP_SKI,
  RollerSki: GROUP_SKI,
  Snowboard: GROUP_SKI,
  IceSkate: GROUP_SKI,

  Kayaking: GROUP_WATER,
  Canoeing: GROUP_WATER,
  Rowing: GROUP_WATER,
  StandUpPaddling: GROUP_WATER,
  Surfing: GROUP_WATER,
  Swim: GROUP_WATER,
  Sail: GROUP_WATER,
  Kitesurf: GROUP_WATER,
  Windsurf: GROUP_WATER,
};

export function sportGroupOf(sportType: string): number {
  return GROUP_BY_SPORT[sportType] ?? GROUP_OTHER;
}

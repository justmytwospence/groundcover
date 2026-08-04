/** Public types for @um/ledger. See docs/algorithm.md section 3.0. */

export interface LedgerInput {
  /** Strava activity id. */
  id: number;
  name: string;
  /** Unix seconds, from start_date (UTC). Every time filter uses this. */
  startTs: number;
  /** Strava start_date_local, passed straight through to artifacts for calendar bucketing. */
  startDateLocal: string;
  /** Raw Strava sport_type. */
  sportType: string;
  /** Index into SPORT_GROUPS. */
  sportGroup: number;
  trainer: boolean;
  manual: boolean;
  /** Strava's recorded distance in metres; needed by the treadmill backstop. */
  distanceM: number;
  latlng: Array<[number, number]>;
  /** Seconds from activity start. */
  time: number[];
  altitude?: number[];
}

export interface ActivitySummary {
  idx: number;
  stravaId: number;
  name: string;
  startTs: number;
  startDateLocal: string;
  sportType: string;
  group: number;
  distanceM: number;
  newGroundM: number;
  /** minLng, minLat, maxLng, maxLat */
  bbox: [number, number, number, number];
}

export interface BlockRef {
  byteOffset: number;
  length: number;
  type: 'Int32' | 'Uint32' | 'Uint16' | 'Uint8';
}

export interface Manifest {
  formatVersion: number;
  /** Stamped by the calling script, not by buildLedger. */
  builtAt: string;
  paramsHash: string;
  params: Record<string, unknown>;
  sportGroups: readonly string[];
  counts: {
    activities: number;
    sites: number;
    touches: number;
    trackPoints: number;
  };
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  timeRange: { minTs: number; maxTs: number };
  totals: { uniqueMeters: number; totalMeters: number };
  files: {
    sites: {
      path: string;
      byteLength: number;
      blocks: {
        x: BlockRef;
        y: BlockRef;
        bearing: BlockRef;
        creditCm: BlockRef;
        mintTs: BlockRef;
        mintAct: BlockRef;
        firstTsByGroup: BlockRef[];
      };
    };
    touches: {
      path: string;
      byteLength: number;
      blocks: { actOffsets: BlockRef; siteIds: BlockRef; dirs: BlockRef };
    };
    tracks: {
      path: string;
      byteLength: number;
      blocks: { trackOffsets: BlockRef; px: BlockRef; py: BlockRef; flag: BlockRef };
    };
    activities: { path: string };
  };
}

export interface LedgerOutput {
  manifest: Manifest;
  sites: ArrayBuffer;
  touches: ArrayBuffer;
  tracks: ArrayBuffer;
  activities: ActivitySummary[];
}

/** Per-sample label, as stored in the low two bits of tracks.bin `flag`. */
export const LABEL_NEW = 0;
export const LABEL_REPEAT = 1;
export const LABEL_AMBIGUOUS = 2;
export const LABEL_NONE = 3;

/** Bit 2 of `flag`: this sample starts a new leg, so renderers must break the path here. */
export const FLAG_LEG_START = 1 << 2;

/** 2 added per-touch traversal direction bits to touches.bin. */
export const FORMAT_VERSION = 2;

/** touches.bin `dirs` bits: which way the activity travelled past the site. */
export const DIR_ALONG = 1;
export const DIR_AGAINST = 2;

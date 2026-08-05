/** Worker message contract. See docs/data-pipeline.md section 6 step 5. */

import type { ActivitySummary, Manifest } from '@um/ledger';

export type MapMode = 'exploration' | 'heatmap';

export interface Viewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface QueryRequest {
  /** Which validated palette to paint with. Absent means dark, the original default. */
  theme?: 'dark' | 'light';
  /** True while the time-lapse is running, which turns on progressive route reveal. */
  playing?: boolean;
  type: 'query';
  /** Inclusive on both ends, UTC activity start timestamps. */
  t0: number;
  t1: number;
  groups: number[];
  viewport: Viewport | null;
  mode: MapMode;
  /** When true, also compute the drawer extras. Gated so playback never pays for charts. */
  drawer: boolean;
  /** Reuse the previous fold, adding only activities newly inside the window. */
  incremental?: boolean;
}

export interface BucketRow {
  bucketStart: number;
  newM: number;
  totalM: number;
}

export interface GroupRow {
  group: number;
  distinctM: number;
  newM: number;
  totalM: number;
}

export interface QueryExtras {
  perActivityNewM: Array<{ idx: number; newM: number }>;
  byBucket: BucketRow[];
  byGroup: GroupRow[];
}

export interface QueryResult {
  type: 'result';
  slot: 0 | 1;
  colors: ArrayBuffer;
  distinctM: number;
  newM: number;
  /** null when the viewport filter is on: a clipped numerator over an unclipped total is
   *  a meaningless ratio, so the stats card hides it rather than inventing one. */
  totalM: number | null;
  activityCount: number;
  extras?: QueryExtras;
}

/**
 * Find the nearest site to a map position and describe it. The lookup lives here rather than
 * in deck.gl's picking because deck's picking pass returns nothing in this MapLibre setup --
 * see the note at the top of MapView. The worker already holds every site position, so a
 * bounded scan is both simpler and entirely under our control.
 */
export interface SiteAtRequest {
  type: 'siteAt';
  lng: number;
  lat: number;
  /** Search radius in metres, derived from a pixel radius at the current zoom. */
  radiusM: number;
  t0: number;
  t1: number;
  groups: number[];
  /** Echoed back so a stale reply can be discarded. */
  seq: number;
  /** Also return the full list of activities that covered this ground. Click-only: a hover
   *  needs the counts, not a hundred rows. */
  detail?: boolean;
}

export interface SiteVisit {
  idx: number;
  stravaId: number;
  name: string;
  startTs: number;
  startDateLocal: string;
  sportType: string;
  /** Direction bits: 1 along the site's bearing, 2 against, 3 both. */
  dir: number;
}

export interface SiteInfoResult {
  type: 'siteInfoResult';
  seq: number;
  /** -1 when nothing was within the search radius. */
  siteIndex: number;
  /** Distinct activities covering this ground inside the current filters. */
  visits: number;
  /** Split by travel direction. These can sum above `visits`: one out-and-back does both. */
  alongCount: number;
  againstCount: number;
  /** Compass label for each direction, e.g. "NE" and "SW". */
  alongLabel: string;
  againstLabel: string;
  firstTs: number;
  lastTs: number;
  firstActivityName: string;
  /** Visits across the whole history, ignoring the time window and sport filter. */
  visitsAllTime: number;
  /** Present only when the request asked for detail. Newest first. */
  activities?: SiteVisit[];
}

export interface ReleaseBuffer {
  type: 'release';
  slot: 0 | 1;
  colors: ArrayBuffer;
}

export interface LoadProgress {
  type: 'progress';
  loaded: number;
  total: number;
}

export interface ReadyMessage {
  type: 'ready';
  manifest: Manifest;
  activities: ActivitySummary[];
  /** Segment endpoints in lng/lat, ready for a deck.gl LineLayer binary attribute. */
  sourcePositions: Float32Array;
  targetPositions: Float32Array;
  nSites: number;
  /** Site metadata the main thread needs for hover tooltips. */
  siteMintTs: Uint32Array;
  siteMintAct: Uint32Array;
}

export interface ErrorMessage {
  type: 'error';
  kind: 'no-artifacts' | 'format-mismatch' | 'params-mismatch' | 'failed';
  message: string;
}

export interface TracksMessage {
  type: 'tracks';
  trackOffsets: Uint32Array;
  px: Int32Array;
  py: Int32Array;
  flag: Uint8Array;
}

export type WorkerOut =
  | QueryResult
  | ReadyMessage
  | ErrorMessage
  | LoadProgress
  | TracksMessage
  | SiteInfoResult;
export type WorkerIn =
  | QueryRequest
  | ReleaseBuffer
  | SiteAtRequest
  | { type: 'init' }
  | { type: 'loadTracks' };

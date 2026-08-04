/**
 * Pulls a Strava history into the browser. The API is the complete path: this can fetch an
 * entire account from nothing and keep it current forever. The ZIP importer is an accelerator
 * for the slow part, not a prerequisite.
 *
 * Three properties make it usable on a real history rather than a toy one:
 *
 *   Newest first.  The last few months land in the first minute and produce true numbers for
 *                  that window immediately. Older history fills in behind it.
 *   Resumable.     Closing the tab is safe at any moment. Stored activities are themselves the
 *                  resume record, so progress survives even if the status map is lost.
 *   Rate-limit aware. Running out of daily budget is a normal outcome for a large backfill, not
 *                  an error. It stops cleanly and says when to come back.
 */

import {
  RateLimitError,
  StravaHttpError,
  StreamSetSchema,
  pageActivities,
  parseSummaryActivity,
  stravaGet,
  type RateLimit,
  type StreamSet,
  type SummaryActivity,
} from '@um/strava';
import {
  activityIds,
  get,
  isQuotaError,
  put,
  putAll,
  LAT_LNG_SCALE,
  STORE_ACTIVITIES,
  STORE_SYNC,
  type StoredActivity,
} from '../lib/db.js';
import { accessToken } from './creds.js';

/** Strava's short read window aligns to :00, :15, :30 and :45. */
const WINDOW_MS = 15 * 60 * 1000;
const PACE_MS = 300;
/** Assumed only for the first ETA, before any response has reported real headroom. */
const ASSUMED_SHORT_LIMIT = 100;
/** One day of overlap on incremental runs, so a late upload is never missed. */
const AFTER_MARGIN_S = 86_400;
/** The status map is rewritten whole, so it is written on a count rather than every activity. */
const STATUS_FLUSH_EVERY = 20;

const KEY_SUMMARIES = 'summaries';
const KEY_STATUS = 'status';

export interface SummaryRow {
  id: number;
  name: string;
  sportType: string;
  startDateLocal: string;
  startTs: number;
  distance: number;
  trainer: boolean;
  manual: boolean;
}

/** `skipped:*` is permanent and never retried; `error:*` is transient and retried next run. */
type StreamStatus = 'ok' | `skipped:${string}` | `error:${string}`;

interface SummariesRecord {
  k: string;
  fetchedAt: number;
  activities: Record<string, SummaryRow>;
}

interface StatusRecord {
  k: string;
  streams: Record<string, StreamStatus>;
}

export interface SyncWarning {
  activityId: number;
  name: string;
  reason: string;
}

export type SyncPhase =
  | 'starting'
  | 'summaries'
  | 'streams'
  | 'waiting'
  | 'done'
  | 'stopped'
  | 'out-of-budget'
  | 'out-of-space'
  | 'error';

export interface SyncProgress {
  phase: SyncPhase;
  /** Total activities Strava has told us about. */
  known: number;
  /** Activities with GPS now in storage. */
  stored: number;
  /** Still to fetch. */
  remaining: number;
  /** The activity being fetched right now, so progress is legible rather than a bare number. */
  current: string | null;
  etaMs: number;
  rateLimit: RateLimit | null;
  warnings: SyncWarning[];
  /** Set when phase is 'waiting': when the next read window opens. */
  waitUntil: number | null;
  message: string | null;
}

/** Raised when the daily read budget runs out. A normal end to a run, not a failure. */
class DailyBudgetExhausted extends Error {}
/** Raised when the browser's storage is full. Everything already written stays valid. */
class OutOfSpace extends Error {}
/** Raised when the caller aborts. */
class Stopped extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Stopped());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new Stopped());
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function msUntilNextWindow(now = Date.now()): number {
  return WINDOW_MS - (now % WINDOW_MS) + 1000;
}

/** Wall clock left, dominated by the 15-minute windows the remaining reads must wait through. */
export function etaMs(remaining: number, headroom: RateLimit | null): number {
  if (remaining <= 0) return 0;
  const perWindow = headroom?.shortLimit ?? ASSUMED_SHORT_LIMIT;
  const leftNow = headroom ? Math.max(0, headroom.shortLimit - headroom.shortUsage) : perWindow;
  if (remaining <= leftNow) return remaining * PACE_MS;
  const windows = Math.ceil((remaining - leftNow) / perWindow);
  return msUntilNextWindow() + (windows - 1) * WINDOW_MS;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

async function readSummaries(): Promise<SummariesRecord> {
  const r = await get<SummariesRecord>(STORE_SYNC, KEY_SUMMARIES);
  return r ?? { k: KEY_SUMMARIES, fetchedAt: 0, activities: {} };
}

async function readStatus(): Promise<StatusRecord> {
  const r = await get<StatusRecord>(STORE_SYNC, KEY_STATUS);
  return r ?? { k: KEY_STATUS, streams: {} };
}

function toSummaryRow(a: SummaryActivity): SummaryRow | null {
  // Derived from the UTC start_date, never from start_date_local: the ledger orders the whole
  // history on this, and a local-time value would shuffle activities across time zones.
  const startTs = Math.floor(Date.parse(a.start_date) / 1000);
  if (!Number.isFinite(startTs)) return null;
  return {
    id: a.id,
    name: a.name,
    sportType: a.sport_type,
    startDateLocal: a.start_date_local,
    startTs,
    distance: a.distance,
    trainer: a.trainer,
    manual: a.manual,
  };
}

/**
 * The subset of the exclusion rules decidable from a summary alone. `excluded()` in @um/ledger
 * is the authority, but it needs the GPS this decides not to spend a request on. These three
 * remove nearly everything that would fail the full check, and the build applies the real rule
 * to whatever gets through.
 */
function preFetchSkip(a: SummaryRow): string | null {
  if (a.trainer) return 'trainer';
  if (a.manual) return 'manual';
  if (a.sportType.startsWith('Virtual')) return 'virtual';
  return null;
}

function toStored(row: SummaryRow, set: StreamSet): StoredActivity | null {
  const latlng = set.latlng?.data ?? [];
  const time = set.time?.data ?? [];
  const n = Math.min(latlng.length, time.length);
  if (n < 2) return null;

  const lat = new Int32Array(n);
  const lng = new Int32Array(n);
  const t = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    lat[i] = Math.round(latlng[i][0] * LAT_LNG_SCALE);
    lng[i] = Math.round(latlng[i][1] * LAT_LNG_SCALE);
    t[i] = time[i];
  }

  const altData = set.altitude?.data;
  let alt: Int16Array | null = null;
  if (altData && altData.length >= n) {
    alt = new Int16Array(n);
    for (let i = 0; i < n; i++) alt[i] = Math.round(altData[i]);
  }

  return {
    id: row.id,
    name: row.name,
    startTs: row.startTs,
    startDateLocal: row.startDateLocal,
    sportType: row.sportType,
    distanceM: row.distance,
    trainer: row.trainer,
    manual: row.manual,
    source: 'api',
    lat,
    lng,
    t,
    alt,
  };
}

export interface SyncOptions {
  signal: AbortSignal;
  onProgress: (p: SyncProgress) => void;
  /** Called when new activities have landed, so the caller can rebuild the ledger. */
  onBatch?: (storedCount: number) => void;
  /** Activities between rebuild invitations. */
  batchSize?: number;
}

/**
 * Runs a full or incremental sync. Resolves with the final progress rather than throwing for
 * the ordinary stopping conditions -- being out of daily budget or being told to stop are
 * outcomes to report, not exceptions.
 */
export async function runSync(opts: SyncOptions): Promise<SyncProgress> {
  const { signal, onProgress } = opts;
  const batchSize = opts.batchSize ?? 25;

  const warnings: SyncWarning[] = [];
  let rateLimit: RateLimit | null = null;

  const summaries = await readSummaries();
  const status = await readStatus();
  let stored = (await activityIds()).size;

  const progress = (patch: Partial<SyncProgress>): SyncProgress => {
    const p: SyncProgress = {
      phase: 'starting',
      known: Object.keys(summaries.activities).length,
      stored,
      remaining: 0,
      current: null,
      etaMs: 0,
      rateLimit,
      warnings,
      waitUntil: null,
      message: null,
      ...patch,
    };
    onProgress(p);
    return p;
  };

  progress({ phase: 'starting' });

  try {
    const token = await accessToken();

    // ---- Summaries -------------------------------------------------------------------------
    progress({ phase: 'summaries', message: 'Asking Strava what you have done' });

    const newest = Object.values(summaries.activities).reduce((m, a) => Math.max(m, a.startTs), 0);
    const after = newest > 0 ? newest - AFTER_MARGIN_S : undefined;

    for (let attempt = 0; ; attempt++) {
      try {
        for await (const page of pageActivities({ accessToken: token, after })) {
          for (const raw of page) {
            let row: SummaryRow | null = null;
            try {
              row = toSummaryRow(parseSummaryActivity(raw));
            } catch {
              row = null;
            }
            if (row) summaries.activities[String(row.id)] = row;
          }
          progress({ phase: 'summaries', message: 'Asking Strava what you have done' });
        }
        break;
      } catch (err) {
        // Paging is idempotent and costs ~10 reads, so restarting it after a wait is cheap.
        if (err instanceof RateLimitError && attempt < 3) {
          const waitMs = err.retryAfterMs ?? msUntilNextWindow();
          progress({ phase: 'waiting', waitUntil: Date.now() + waitMs, message: 'Rate limited while listing activities' });
          await sleep(waitMs, signal);
          continue;
        }
        throw err;
      }
    }

    summaries.fetchedAt = Math.floor(Date.now() / 1000);
    await put(STORE_SYNC, summaries);

    // ---- Work list -------------------------------------------------------------------------
    const have = await activityIds();
    const pending: SummaryRow[] = [];
    for (const a of Object.values(summaries.activities)) {
      const key = String(a.id);
      if (have.has(a.id)) {
        status.streams[key] = 'ok';
        continue;
      }
      const existing = status.streams[key];
      if (existing?.startsWith('skipped:')) continue;
      const skip = preFetchSkip(a);
      if (skip !== null) {
        status.streams[key] = `skipped:${skip}`;
        continue;
      }
      pending.push(a);
    }
    // Newest first, so a partial backfill leaves the most recent history usable.
    pending.sort((a, b) => b.startTs - a.startTs);
    await put(STORE_SYNC, status);

    if (pending.length === 0) {
      return progress({ phase: 'done', remaining: 0, message: 'Everything is up to date' });
    }

    // ---- Streams ---------------------------------------------------------------------------
    let done = 0;
    let sinceFlush = 0;
    let sinceBatch = 0;
    const buffer: StoredActivity[] = [];

    const flushBuffer = async () => {
      if (buffer.length === 0) return;
      try {
        await putAll(STORE_ACTIVITIES, buffer);
      } catch (err) {
        // Everything written before this point is intact and the map built from it is correct.
        // Stopping here is strictly better than continuing to throw on every activity.
        if (isQuotaError(err)) throw new OutOfSpace();
        throw err;
      }
      stored += buffer.length;
      buffer.length = 0;
    };

    try {
      for (const a of pending) {
        if (signal.aborted) throw new Stopped();

        if (rateLimit && rateLimit.dailyUsage >= rateLimit.dailyLimit) {
          throw new DailyBudgetExhausted();
        }
        if (rateLimit && rateLimit.shortUsage >= rateLimit.shortLimit) {
          await flushBuffer();
          const waitMs = msUntilNextWindow();
          progress({
            phase: 'waiting',
            remaining: pending.length - done,
            waitUntil: Date.now() + waitMs,
            message: 'Strava lets through a fixed number of requests every 15 minutes',
          });
          await sleep(waitMs, signal);
          rateLimit = null;
        } else if (done > 0) {
          await sleep(PACE_MS, signal);
        }

        progress({
          phase: 'streams',
          current: a.name,
          remaining: pending.length - done,
          etaMs: etaMs(pending.length - done, rateLimit),
        });

        const key = String(a.id);
        try {
          const res = await stravaGet<unknown>(`/activities/${a.id}/streams`, {
            accessToken: token,
            query: { keys: 'latlng,time,altitude', key_by_type: 'true' },
          });
          if (res.rateLimit) rateLimit = res.rateLimit;
          const set = StreamSetSchema.parse(res.data);
          const rec = toStored(a, set);
          if (rec === null) {
            // key_by_type omits unavailable streams, so no GPS shows up as an absent latlng.
            status.streams[key] = 'skipped:no-gps';
            warnings.push({ activityId: a.id, name: a.name, reason: 'no GPS recorded' });
          } else {
            buffer.push(rec);
            status.streams[key] = 'ok';
          }
        } catch (err) {
          if (err instanceof Stopped) throw err;
          if (err instanceof RateLimitError) {
            if (err.usage) rateLimit = err.usage;
            if (err.usage && err.usage.dailyUsage >= err.usage.dailyLimit) {
              throw new DailyBudgetExhausted();
            }
            await flushBuffer();
            const waitMs = err.retryAfterMs ?? msUntilNextWindow();
            progress({
              phase: 'waiting',
              remaining: pending.length - done,
              waitUntil: Date.now() + waitMs,
              message: 'Strava asked us to slow down',
            });
            await sleep(waitMs, signal);
            rateLimit = null;
            continue; // Retry this same activity rather than dropping it.
          }
          if (err instanceof StravaHttpError && err.status === 404) {
            status.streams[key] = 'skipped:no-gps';
            warnings.push({ activityId: a.id, name: a.name, reason: 'no GPS recorded' });
          } else {
            status.streams[key] = `error:${err instanceof StravaHttpError ? err.status : 'fetch'}`;
            warnings.push({
              activityId: a.id,
              name: a.name,
              reason: 'could not be fetched; it will be retried next time',
            });
          }
        }

        done++;
        sinceFlush++;
        sinceBatch++;

        if (buffer.length >= 10) await flushBuffer();
        if (sinceFlush >= STATUS_FLUSH_EVERY) {
          await put(STORE_SYNC, status);
          sinceFlush = 0;
        }
        if (sinceBatch >= batchSize && opts.onBatch) {
          await flushBuffer();
          opts.onBatch(stored);
          sinceBatch = 0;
        }
      }
    } catch (err) {
      await flushBuffer();
      await put(STORE_SYNC, status);

      if (err instanceof DailyBudgetExhausted) {
        opts.onBatch?.(stored);
        return progress({
          phase: 'out-of-budget',
          remaining: pending.length - done,
          message:
            `Strava's daily limit is reached after ${done} activities. This is normal for a ` +
            `large history. Come back tomorrow and it will pick up where it stopped.`,
        });
      }
      if (err instanceof OutOfSpace) {
        opts.onBatch?.(stored);
        return progress({
          phase: 'out-of-space',
          remaining: pending.length - done,
          message:
            `This browser is out of storage after ${stored.toLocaleString()} activities. ` +
            `Everything downloaded so far is safe and your map is built from all of it. To go ` +
            `further, free up disk space, or use a browser with more room.`,
        });
      }
      if (err instanceof Stopped) {
        opts.onBatch?.(stored);
        return progress({ phase: 'stopped', remaining: pending.length - done, message: 'Stopped' });
      }
      throw err;
    }

    await flushBuffer();
    await put(STORE_SYNC, status);
    opts.onBatch?.(stored);
    return progress({ phase: 'done', remaining: 0, current: null, message: 'Sync complete' });
  } catch (err) {
    if (err instanceof Stopped) return progress({ phase: 'stopped', message: 'Stopped' });
    if (err instanceof OutOfSpace) {
      return progress({ phase: 'out-of-space', message: 'This browser is out of storage.' });
    }
    return progress({
      phase: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** How many activities Strava knows about that we have not stored yet. */
export async function pendingCount(): Promise<{ known: number; stored: number }> {
  const summaries = await readSummaries();
  const have = await activityIds();
  return { known: Object.keys(summaries.activities).length, stored: have.size };
}

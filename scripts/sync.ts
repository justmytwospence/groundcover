/**
 * Resumable Strava backfill. See docs/data-pipeline.md section 3.
 *
 *   npm run sync [-- --limit N]
 *
 * Writes data/summaries.json, data/streams/{id}.json.gz, and data/sync-state.json. The state
 * file is rewritten after every activity, so an interrupted run resumes exactly where it
 * stopped. A first backfill is expected to take hours and to be run repeatedly; running out of
 * daily read budget is a normal outcome, not an error.
 *
 * Token values are never printed, including in error messages.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sportGroupOf } from '@um/ledger';
import {
  RateLimitError,
  StravaHttpError,
  StreamSetSchema,
  mintAccessToken,
  pageActivities,
  parseSummaryActivity,
  stravaGet,
} from '@um/strava';
import type { Creds, RateLimit, StreamSet, SummaryActivity, TokenState } from '@um/strava';
import pako from 'pako';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env.local');
const TOKEN_PATH = resolve(ROOT, '.strava-token.json');
const DATA_DIR = resolve(ROOT, 'data');
const STREAMS_DIR = resolve(DATA_DIR, 'streams');
const SUMMARIES_PATH = resolve(DATA_DIR, 'summaries.json');
const STATE_PATH = resolve(DATA_DIR, 'sync-state.json');

/** Strava's read windows align to :00, :15, :30 and :45. */
const WINDOW_MS = 15 * 60 * 1000;
const PACE_MS = 300;
const PROGRESS_EVERY = 25;
/** One day of overlap on incremental runs, so a late upload is never missed. */
const AFTER_MARGIN_S = 86_400;
/** Only used for the ETA before the first response has reported real headroom. */
const ASSUMED_SHORT_LIMIT = 100;

interface StoredActivity {
  id: number;
  name: string;
  sportType: string;
  startDate: string;
  startDateLocal: string;
  /** Derived from the UTC start_date, never from start_date_local. */
  startTs: number;
  distance: number;
  trainer: boolean;
  manual: boolean;
  hasHeartrate: boolean;
  startLatlng: [number, number] | null;
  /** Map preview and debugging only. Far too simplified for coverage math. */
  summaryPolyline: string | null;
  /** Index into SPORT_GROUPS, assigned at sync time per section 3.4. */
  sportGroup: number;
}

interface Summaries {
  lastSyncTs: number;
  activities: Record<string, StoredActivity>;
}

/** `skipped:*` is permanent and never retried; `error:*` is transient and retried next run. */
type StreamStatus = 'ok' | `skipped:${string}` | `error:${string}`;

interface SyncState {
  summariesFetchedAt: number;
  streams: Record<string, StreamStatus>;
  lastError: string | null;
}

interface StreamCache {
  id: number;
  fetchedAt: number;
  latlng: Array<[number, number]>;
  /** Seconds from activity start; absolute time is startTs + time[i]. */
  time: number[];
  altitude?: number[];
}

/** Raised when the daily read budget runs out, which ends the run cleanly with exit 0. */
class DailyBudgetExhausted extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function msUntilNextWindow(now = Date.now()): number {
  return WINDOW_MS - (now % WINDOW_MS) + 1000;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Wall clock left, dominated by the 15-minute windows the remaining reads must wait through. */
function etaMs(remaining: number, headroom: RateLimit | null): number {
  if (remaining <= 0) return 0;
  const perWindow = headroom?.shortLimit ?? ASSUMED_SHORT_LIMIT;
  const leftNow = headroom ? Math.max(0, headroom.shortLimit - headroom.shortUsage) : perWindow;
  if (remaining <= leftNow) return remaining * PACE_MS;
  const windows = Math.ceil((remaining - leftNow) / perWindow);
  return msUntilNextWindow() + (windows - 1) * WINDOW_MS;
}

/** Minimal KEY=VALUE parser: dotenv is not worth a dependency for two variables. */
function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.error(`Missing ${path}. Create it with STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.`);
    process.exit(1);
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readTokenState(): TokenState {
  let text: string;
  try {
    text = readFileSync(TOKEN_PATH, 'utf8');
  } catch {
    console.error('No .strava-token.json found. Run `npm run auth` first.');
    process.exit(1);
  }
  const parsed = JSON.parse(text) as TokenState;
  if (typeof parsed.refreshToken !== 'string' || parsed.refreshToken === '') {
    console.error('.strava-token.json has no refreshToken. Re-run `npm run auth`.');
    process.exit(1);
  }
  return parsed;
}

function writeTokenState(state: TokenState): void {
  writeFileSync(TOKEN_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync honours `mode` only when it creates the file.
  chmodSync(TOKEN_PATH, 0o600);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readSummaries(): Summaries {
  if (!existsSync(SUMMARIES_PATH)) return { lastSyncTs: 0, activities: {} };
  return JSON.parse(readFileSync(SUMMARIES_PATH, 'utf8')) as Summaries;
}

function readSyncState(): SyncState {
  if (!existsSync(STATE_PATH)) return { summariesFetchedAt: 0, streams: {}, lastError: null };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as SyncState;
    return {
      summariesFetchedAt: parsed.summariesFetchedAt ?? 0,
      streams: parsed.streams ?? {},
      lastError: parsed.lastError ?? null,
    };
  } catch {
    // Recoverable: already-stored stream files are detected on disk below.
    console.warn('data/sync-state.json is unreadable; rebuilding it from the stream cache.');
    return { summariesFetchedAt: 0, streams: {}, lastError: null };
  }
}

function streamPath(id: number): string {
  return resolve(STREAMS_DIR, `${id}.json.gz`);
}

function toStored(a: SummaryActivity): StoredActivity | null {
  const startTs = Math.floor(Date.parse(a.start_date) / 1000);
  if (!Number.isFinite(startTs)) return null;
  const latlng = a.start_latlng;
  return {
    id: a.id,
    name: a.name,
    sportType: a.sport_type,
    startDate: a.start_date,
    startDateLocal: a.start_date_local,
    startTs,
    distance: a.distance,
    trainer: a.trainer,
    manual: a.manual,
    hasHeartrate: a.has_heartrate ?? false,
    startLatlng: latlng && latlng.length >= 2 ? [latlng[0], latlng[1]] : null,
    summaryPolyline: a.map?.summary_polyline ?? null,
    sportGroup: sportGroupOf(a.sport_type),
  };
}

/**
 * The subset of docs/algorithm.md section 3.1 decidable from a summary alone. `excluded` from
 * @um/ledger is the authority, but it needs the GPS streams this decides not to fetch; these
 * three rules remove almost every activity that would fail the full check, and the build script
 * runs `excluded` over everything anyway.
 */
function preFetchSkip(a: StoredActivity): string | null {
  if (a.trainer) return 'trainer';
  if (a.manual) return 'manual';
  if (a.sportType.startsWith('Virtual')) return 'virtual';
  return null;
}

async function crawlSummaries(accessToken: string, summaries: Summaries): Promise<void> {
  const latest = Object.values(summaries.activities).reduce((max, a) => Math.max(max, a.startTs), 0);
  const after = latest > 0 ? latest - AFTER_MARGIN_S : undefined;
  console.log(
    after === undefined
      ? 'Fetching all activity summaries ...'
      : `Fetching activity summaries after ${new Date(after * 1000).toISOString()} ...`,
  );

  const before = Object.keys(summaries.activities).length;
  let malformed = 0;

  for (let attempt = 0; ; attempt++) {
    try {
      for await (const page of pageActivities({ accessToken, after })) {
        for (const raw of page) {
          let stored: StoredActivity | null = null;
          try {
            stored = toStored(parseSummaryActivity(raw));
          } catch {
            stored = null;
          }
          if (stored === null) {
            malformed++;
            continue;
          }
          summaries.activities[String(stored.id)] = stored;
        }
        process.stdout.write(`  ${Object.keys(summaries.activities).length} activities known\r`);
      }
      break;
    } catch (err) {
      // Paging is idempotent and costs ~10 reads, so restarting it after a wait is cheap.
      if (err instanceof RateLimitError && attempt < 3) {
        const waitMs = err.retryAfterMs ?? msUntilNextWindow();
        console.log(`\nRate limited while paging; sleeping ${formatDuration(waitMs)} ...`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }

  summaries.lastSyncTs = Math.floor(Date.now() / 1000);
  writeJson(SUMMARIES_PATH, summaries);

  const added = Object.keys(summaries.activities).length - before;
  console.log(
    `  ${Object.keys(summaries.activities).length} activities known (${added} new)` +
      (malformed > 0 ? `, ${malformed} skipped as malformed` : ''),
  );
}

/** Returns null when the activity has no streams at all (HTTP 404, typically a manual entry). */
async function fetchStreamSet(
  id: number,
  accessToken: string,
): Promise<{ raw: unknown; rateLimit: RateLimit | null } | null> {
  for (;;) {
    try {
      const { data, rateLimit } = await stravaGet<unknown>(`/activities/${id}/streams`, {
        accessToken,
        query: { keys: 'latlng,time,altitude', key_by_type: 'true' },
      });
      return { raw: data, rateLimit };
    } catch (err) {
      if (err instanceof StravaHttpError && err.status === 404) return null;
      if (err instanceof RateLimitError) {
        if (err.usage && err.usage.dailyUsage >= err.usage.dailyLimit) {
          throw new DailyBudgetExhausted();
        }
        const waitMs = err.retryAfterMs ?? msUntilNextWindow();
        console.log(`\nRate limited; sleeping ${formatDuration(waitMs)} until the next window.`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
}

function writeStreamFile(id: number, set: StreamSet): void {
  const cache: StreamCache = {
    id,
    fetchedAt: Math.floor(Date.now() / 1000),
    latlng: set.latlng?.data ?? [],
    time: set.time?.data ?? [],
  };
  if (set.altitude !== undefined) cache.altitude = set.altitude.data;
  writeFileSync(streamPath(id), pako.gzip(JSON.stringify(cache)));
}

function errorCode(err: unknown): string {
  if (err instanceof StravaHttpError) return String(err.status);
  if (err instanceof Error && err.name === 'ZodError') return 'schema';
  return 'fetch';
}

async function syncStreams(
  accessToken: string,
  summaries: Summaries,
  state: SyncState,
  limit: number | undefined,
): Promise<void> {
  // Newest first, so a partial backfill leaves the most recent history usable.
  const ordered = Object.values(summaries.activities).sort((a, b) => b.startTs - a.startTs);
  const pending: StoredActivity[] = [];

  for (const a of ordered) {
    const key = String(a.id);
    const status = state.streams[key];
    if (status === 'ok' || status?.startsWith('skipped:')) continue;

    const skip = preFetchSkip(a);
    if (skip !== null) {
      state.streams[key] = `skipped:${skip}`;
      continue;
    }
    if (existsSync(streamPath(a.id))) {
      state.streams[key] = 'ok';
      continue;
    }
    pending.push(a);
  }
  writeJson(STATE_PATH, state);

  const work = limit === undefined ? pending : pending.slice(0, limit);
  if (work.length === 0) {
    console.log('All eligible activities already have stream files. Nothing to fetch.');
    return;
  }
  console.log(
    `${pending.length} activities need streams` +
      (limit !== undefined && limit < pending.length ? `; fetching ${work.length} this run` : '') +
      `. Estimated ${formatDuration(etaMs(work.length, null))}.`,
  );

  let headroom: RateLimit | null = null;
  let done = 0;
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (const a of work) {
      if (headroom !== null && headroom.dailyUsage >= headroom.dailyLimit) {
        throw new DailyBudgetExhausted();
      }
      if (headroom !== null && headroom.shortUsage >= headroom.shortLimit) {
        const waitMs = msUntilNextWindow();
        console.log(`\n15-minute read limit reached; sleeping ${formatDuration(waitMs)} ...`);
        await sleep(waitMs);
        headroom = null;
      } else if (done > 0) {
        await sleep(PACE_MS);
      }

      const key = String(a.id);
      try {
        const result = await fetchStreamSet(a.id, accessToken);
        if (result === null) {
          state.streams[key] = 'skipped:no-gps';
          skipped++;
        } else {
          if (result.rateLimit !== null) headroom = result.rateLimit;
          const set = StreamSetSchema.parse(result.raw);
          const latlng = set.latlng?.data ?? [];
          // key_by_type omits unavailable streams, so no GPS shows up as an absent latlng.
          if (latlng.length < 2) {
            state.streams[key] = 'skipped:no-gps';
            skipped++;
          } else {
            writeStreamFile(a.id, set);
            state.streams[key] = 'ok';
            ok++;
          }
        }
        state.lastError = null;
      } catch (err) {
        if (err instanceof DailyBudgetExhausted) throw err;
        state.streams[key] = `error:${errorCode(err)}`;
        state.lastError = err instanceof Error ? err.message : String(err);
        failed++;
      }

      done++;
      writeJson(STATE_PATH, state);

      if (done % PROGRESS_EVERY === 0 || done === work.length) {
        const remaining = work.length - done;
        console.log(
          `  ${done} done, ${remaining} remaining, ETA ${formatDuration(etaMs(remaining, headroom))}` +
            (headroom !== null
              ? ` (reads ${headroom.shortUsage}/${headroom.shortLimit} this window, ` +
                `${headroom.dailyUsage}/${headroom.dailyLimit} today)`
              : ''),
        );
      }
    }
  } catch (err) {
    if (!(err instanceof DailyBudgetExhausted)) throw err;
    writeJson(STATE_PATH, state);
    const remaining = pending.length - done;
    console.log(
      `\nDaily Strava read budget exhausted after ${done} activities. ` +
        `${remaining} still need streams.`,
    );
    console.log('This is normal for a large backfill. Re-run `npm run sync` tomorrow to resume.');
    process.exit(0);
  }

  console.log(`Streams: ${ok} fetched, ${skipped} skipped (no GPS), ${failed} failed.`);
  if (failed > 0) console.log('Failures are transient and will be retried on the next run.');
}

function parseLimit(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const raw = arg.startsWith('--limit=')
      ? arg.slice('--limit='.length)
      : arg === '--limit'
        ? argv[i + 1]
        : undefined;
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      console.error('--limit expects a positive integer.');
      process.exit(1);
    }
    return n;
  }
  return undefined;
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));

  const env = readEnvFile(ENV_PATH);
  const creds: Creds = {
    clientId: env.STRAVA_CLIENT_ID ?? '',
    clientSecret: env.STRAVA_CLIENT_SECRET ?? '',
  };
  if (creds.clientId === '' || creds.clientSecret === '') {
    console.error(`${ENV_PATH} must define both STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.`);
    process.exit(1);
  }

  const stored = readTokenState();
  const minted = await mintAccessToken(creds, stored);
  // Persist the rotation before anything else can fail; losing it means re-running auth.
  writeTokenState({
    refreshToken: minted.refreshToken,
    accessToken: minted.accessToken,
    expiresAt: minted.expiresAt,
    athleteId: stored.athleteId,
  });
  if (minted.rotated) console.log('Refresh token rotated and persisted.');

  mkdirSync(STREAMS_DIR, { recursive: true });

  const summaries = readSummaries();
  const state = readSyncState();

  await crawlSummaries(minted.accessToken, summaries);
  state.summariesFetchedAt = summaries.lastSyncTs;
  writeJson(STATE_PATH, state);

  await syncStreams(minted.accessToken, summaries, state, limit);
}

main().catch((err: unknown) => {
  console.error(`\nsync failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

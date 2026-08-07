/**
 * The nightly refresh, run by Vercel Cron. See SPEC.md section 4.6.
 *
 * One invocation is: mint a token, page whatever is new, fetch those streams, rebuild the whole
 * ledger, publish the artifacts, retire the previous build. Everything it needs lives in blob
 * storage, so the function is stateless and a failed run costs nothing but a day of staleness.
 *
 * THE BUDGET IS THE DESIGN CONSTRAINT. The function is capped at 300 s. A full rebuild of 1,306
 * activities measures 5.9 s at 109 MB peak heap, so compute is not the risk -- I/O is. Hence:
 * the stream corpus is read as ~8 packed shards rather than 1,300 objects, and stream fetching
 * stops at FETCH_DEADLINE_MS so a long catch-up can never crowd out the rebuild and upload that
 * make the run worth anything. Whatever is left is fetched tomorrow.
 *
 * Token values are never logged, including in error messages.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

import { buildLedger, DEFAULT_PARAMS, sportGroupOf, type LedgerInput } from '@um/ledger';
import {
  RateLimitError,
  StravaHttpError,
  StreamSetSchema,
  mintAccessToken,
  pageActivities,
  parseSummaryActivity,
  stravaGet,
  type StreamSet,
} from '@um/strava';

import { decodePack, encodePack, shardFor, shardPath, type PackEntry } from './pack.js';
import {
  CURRENT_PATH,
  SUMMARIES_PATH,
  TOKEN_PATH,
  blobUrl,
  delPaths,
  getJson,
  getBlob,
  listPaths,
  privateStore,
  publicStore,
  putBlob,
  putJson,
  type CurrentPointer,
  type StoredSummary,
  type StoredToken,
  type SummariesFile,
} from './store.js';

/**
 * Stop fetching streams here and go rebuild with what we have. Chosen against the 300 s cap:
 * a rebuild plus a ~58 MB upload has finished in well under a minute in practice, and leaving
 * ~110 s of headroom means a slow upload day still publishes rather than timing out with
 * nothing to show and a day of API budget spent.
 */
const FETCH_DEADLINE_MS = 190_000;

/** One day of overlap, so an activity uploaded late is never missed. Matches scripts/sync.ts. */
const AFTER_MARGIN_S = 86_400;
const PACE_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StreamCache {
  id: number;
  fetchedAt: number;
  latlng: [number, number][];
  time: number[];
  altitude?: number[];
}

/** Identical to scripts/sync.ts: the summary-only subset of docs/algorithm.md section 3.1. */
function preFetchSkip(a: StoredSummary & { sportType: string }): boolean {
  return a.trainer || a.manual || a.sportType.startsWith('Virtual');
}

function toStored(raw: unknown): StoredSummary | null {
  try {
    const a = parseSummaryActivity(raw);
    const startTs = Math.floor(Date.parse(a.start_date) / 1000);
    if (!Number.isFinite(startTs)) return null;
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
    };
  } catch {
    return null;
  }
}

export interface RefreshResult {
  ok: boolean;
  newActivities: number;
  streamsFetched: number;
  streamsRemaining: number;
  activitiesBuilt: number;
  buildId?: string;
  /** The stable current.json URL. What `npm run publish:stage` bakes into the bundle. */
  pointerUrl?: string;
  elapsedMs: number;
  note?: string;
}

export async function runRefresh(log: (s: string) => void = () => {}): Promise<RefreshResult> {
  const t0 = Date.now();
  const priv = privateStore();
  const pub = publicStore();

  // ---- token ---------------------------------------------------------------------------
  const stored = await getJson<StoredToken>(priv, TOKEN_PATH);
  if (!stored?.refreshToken) {
    throw new Error(`${TOKEN_PATH} is missing or empty -- run \`npm run publish:seed\` first`);
  }
  const creds = {
    clientId: process.env.STRAVA_CLIENT_ID ?? '',
    clientSecret: process.env.STRAVA_CLIENT_SECRET ?? '',
  };
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error('STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are not set');
  }

  const minted = await mintAccessToken(creds, stored);
  // Persist FIRST, before anything else can throw. Strava has already invalidated the old
  // refresh token by this point; losing the new one locks the deployment out permanently and
  // the only recovery is re-seeding by hand.
  if (minted.rotated) {
    await putJson(priv, TOKEN_PATH, {
      refreshToken: minted.refreshToken,
      ...(stored.athleteId !== undefined ? { athleteId: stored.athleteId } : {}),
      rotatedAt: new Date().toISOString(),
    } satisfies StoredToken);
    log('refresh token rotated and persisted');
  }
  const accessToken = minted.accessToken;

  // ---- summaries -----------------------------------------------------------------------
  const summariesFile = (await getJson<SummariesFile>(priv, SUMMARIES_PATH)) ?? { activities: {} };
  const known = summariesFile.activities;
  const before = Object.keys(known).length;

  const latest = Object.values(known).reduce((max, a) => Math.max(max, a.startTs), 0);
  const after = latest > 0 ? latest - AFTER_MARGIN_S : undefined;

  for await (const page of pageActivities({ accessToken, after, pace: PACE_MS })) {
    for (const raw of page) {
      const s = toStored(raw);
      if (s) known[String(s.id)] = s;
    }
  }
  const newActivities = Object.keys(known).length - before;
  log(`${Object.keys(known).length} activities known (${newActivities} new)`);

  // ---- stream corpus -------------------------------------------------------------------
  const shardPaths = await listPaths(priv, 'streams/');
  const shards = new Map<string, Map<number, Uint8Array>>();
  let corpusBytes = 0;

  for (const path of shardPaths) {
    const bytes = await getBlob(priv, path);
    if (!bytes) continue;
    corpusBytes += bytes.length;
    const shard = path.slice('streams/'.length, -'.pack'.length);
    const map = new Map<number, Uint8Array>();
    for (const e of decodePack(bytes)) map.set(e.id, e.gz);
    shards.set(shard, map);
  }
  const haveStream = (id: number) => {
    for (const m of shards.values()) if (m.has(id)) return true;
    return false;
  };
  log(`${shardPaths.length} shards, ${(corpusBytes / 1e6).toFixed(1)} MB of GPS loaded`);

  // ---- fetch what is missing -----------------------------------------------------------
  const wanted = Object.values(known)
    .filter((a) => !preFetchSkip(a) && !haveStream(a.id))
    .sort((a, b) => b.startTs - a.startTs);

  const dirtyShards = new Set<string>();
  let fetched = 0;
  let remaining = 0;
  let noStreams = 0;

  for (let i = 0; i < wanted.length; i++) {
    if (Date.now() - t0 > FETCH_DEADLINE_MS) {
      remaining = wanted.length - i;
      log(`fetch deadline reached; ${remaining} streams deferred to the next run`);
      break;
    }
    const a = wanted[i];
    if (i > 0) await sleep(PACE_MS);

    let set: StreamSet | null = null;
    try {
      const { data } = await stravaGet<unknown>(`/activities/${a.id}/streams`, {
        accessToken,
        query: { keys: 'latlng,time,altitude', key_by_type: 'true' },
      });
      set = StreamSetSchema.parse(data);
    } catch (err) {
      if (err instanceof StravaHttpError && err.status === 404) {
        // No streams at all, typically a manual entry. Nothing to store and nothing to retry.
        noStreams++;
        continue;
      }
      if (err instanceof RateLimitError) {
        // Never sleep out a rate limit here the way the local sync does: the window is 15
        // minutes and the whole function is 5. Stop, publish what we have, come back tomorrow.
        remaining = wanted.length - i;
        log(`rate limited; ${remaining} streams deferred to the next run`);
        break;
      }
      throw err;
    }

    if (!set.latlng || !set.time) {
      noStreams++;
      continue;
    }
    const cache: StreamCache = {
      id: a.id,
      fetchedAt: Math.floor(Date.now() / 1000),
      latlng: set.latlng.data,
      time: set.time.data,
      ...(set.altitude ? { altitude: set.altitude.data } : {}),
    };

    const shard = shardFor(a.startTs);
    let bucket = shards.get(shard);
    if (!bucket) {
      bucket = new Map();
      shards.set(shard, bucket);
    }
    bucket.set(a.id, new Uint8Array(gzipSync(Buffer.from(JSON.stringify(cache)))));
    dirtyShards.add(shard);
    fetched++;
  }
  log(`fetched ${fetched} streams` + (noStreams > 0 ? `, ${noStreams} had none` : ''));

  // ---- persist the corpus before rebuilding ----------------------------------------------
  // Written first, and only the shards that changed. A rebuild that fails after this point
  // still leaves the GPS banked, so tomorrow's run does not re-spend the API budget.
  for (const shard of [...dirtyShards].sort()) {
    const map = shards.get(shard)!;
    const entries: PackEntry[] = [...map].sort((a, b) => a[0] - b[0]).map(([id, gz]) => ({ id, gz }));
    await putBlob(priv, shardPath(shard), encodePack(entries), {
      contentType: 'application/octet-stream',
    });
  }
  if (dirtyShards.size > 0 || newActivities > 0) {
    await putJson(priv, SUMMARIES_PATH, summariesFile);
  }

  // Nothing new and something already published: stop before spending a 58 MB upload on an
  // artifact identical to the one already live.
  const current = await getJson<CurrentPointer>(pub, CURRENT_PATH);
  const currentPointerUrl = current ? ((await blobUrl(pub, CURRENT_PATH)) ?? undefined) : undefined;
  if (fetched === 0 && newActivities === 0 && current) {
    return {
      ok: true,
      newActivities: 0,
      streamsFetched: 0,
      streamsRemaining: remaining,
      activitiesBuilt:
        current.manifest && typeof current.manifest === 'object'
          ? ((current.manifest as { counts?: { activities?: number } }).counts?.activities ?? 0)
          : 0,
      buildId: current.buildId,
      pointerUrl: currentPointerUrl,
      elapsedMs: Date.now() - t0,
      note: 'nothing new; kept the current build',
    };
  }

  // ---- rebuild -------------------------------------------------------------------------
  const input: LedgerInput[] = [];
  for (const s of Object.values(known).sort((a, b) => a.startTs - b.startTs || a.id - b.id)) {
    let gz: Uint8Array | undefined;
    for (const m of shards.values()) {
      const hit = m.get(s.id);
      if (hit) {
        gz = hit;
        break;
      }
    }
    if (!gz) continue;
    let st: StreamCache;
    try {
      st = JSON.parse(gunzipSync(Buffer.from(gz)).toString('utf8')) as StreamCache;
    } catch {
      continue;
    }
    if (!st.latlng || !st.time) continue;
    input.push({
      id: s.id,
      name: s.name,
      startTs: s.startTs,
      startDateLocal: s.startDateLocal ?? s.startDate,
      sportType: s.sportType,
      sportGroup: sportGroupOf(s.sportType),
      trainer: s.trainer,
      manual: s.manual,
      distanceM: s.distance,
      latlng: st.latlng,
      time: st.time,
      ...(st.altitude ? { altitude: st.altitude } : {}),
    });
  }

  const tBuild = Date.now();
  const out = buildLedger(input, DEFAULT_PARAMS);
  const builtAt = new Date().toISOString();
  out.manifest.builtAt = builtAt;
  log(`built ${out.manifest.counts.sites} sites from ${input.length} activities in ${((Date.now() - tBuild) / 1000).toFixed(1)}s`);

  // ---- publish -------------------------------------------------------------------------
  // Versioned by build, so every artifact URL is immutable and can be cached for a month. Only
  // the small pointer is ever overwritten, which is why it is the only one with a short TTL.
  const buildId = builtAt.replace(/[:.]/g, '-');
  const prefix = `builds/${buildId}`;
  const bin = { contentType: 'application/octet-stream' };

  const files = {
    sites: await putBlob(pub, `${prefix}/sites.bin`, new Uint8Array(out.sites), bin),
    touches: await putBlob(pub, `${prefix}/touches.bin`, new Uint8Array(out.touches), bin),
    tracks: await putBlob(pub, `${prefix}/tracks.bin`, new Uint8Array(out.tracks), bin),
    activities: await putJson(pub, `${prefix}/activities.json`, out.activities),
  };

  const pointer: CurrentPointer = { buildId, builtAt, manifest: out.manifest, files };
  // 60 s is the SDK floor. The map moves once a day, so a minute of CDN staleness after a
  // build is invisible, and it keeps the pointer from being served from a month-old cache.
  const pointerUrl = await putJson(pub, CURRENT_PATH, pointer, { cacheControlMaxAge: 60 });
  log(`published ${buildId}`);

  // ---- retire older builds --------------------------------------------------------------
  // After the pointer flip, never before: a reader that already has the pointer must still be
  // able to finish fetching what it names.
  const stale = (await listPaths(pub, 'builds/')).filter((p) => !p.startsWith(`${prefix}/`));
  if (stale.length > 0) {
    await delPaths(pub, stale);
    log(`retired ${stale.length} objects from previous builds`);
  }

  return {
    ok: true,
    newActivities,
    streamsFetched: fetched,
    streamsRemaining: remaining,
    activitiesBuilt: input.length,
    buildId,
    pointerUrl,
    elapsedMs: Date.now() - t0,
  };
}

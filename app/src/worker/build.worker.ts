/**
 * Runs the ledger over stored activities and writes the artifacts back to storage.
 *
 * Off the main thread because a full history is tens of seconds of solid arithmetic, and a
 * frozen tab during it would be indistinguishable from a crash.
 *
 * Activities are streamed one at a time out of IndexedDB rather than gathered into an array
 * first. Holding a real history as LedgerInput[] costs ~536 MB before the algorithm even starts,
 * which is survivable on desktop Chrome and fatal on Safari; feeding them through a builder
 * keeps the peak near 190 MB.
 */

import {
  createBuilder,
  serialize,
  sportGroupOf,
  DEFAULT_PARAMS,
  type LedgerInput,
} from '@um/ledger';
import {
  activitiesChronological,
  put,
  LAT_LNG_SCALE,
  STORE_ARTIFACTS,
  type StoredActivity,
} from '../lib/db.js';

export type BuildRequest = { type: 'build' };

export type BuildResponse =
  | { type: 'progress'; accepted: number; seen: number }
  | {
      type: 'done';
      activities: number;
      sites: number;
      uniqueMeters: number;
      totalMeters: number;
      /** Every activity read from storage, so the report can reconcile against it. */
      seen: number;
      /** How many were dropped, by reason. Sums with `activities` to `seen`. */
      excluded: Record<string, number>;
    }
  | { type: 'empty' }
  | { type: 'error'; message: string };

function toLedgerInput(a: StoredActivity): LedgerInput {
  const n = a.lat.length;
  const latlng = new Array<[number, number]>(n);
  for (let i = 0; i < n; i++) {
    latlng[i] = [a.lat[i] / LAT_LNG_SCALE, a.lng[i] / LAT_LNG_SCALE];
  }
  const time = new Array<number>(n);
  for (let i = 0; i < n; i++) time[i] = a.t[i];

  const input: LedgerInput = {
    id: a.id,
    name: a.name,
    startTs: a.startTs,
    startDateLocal: a.startDateLocal,
    sportType: a.sportType,
    sportGroup: sportGroupOf(a.sportType),
    trainer: a.trainer,
    manual: a.manual,
    distanceM: a.distanceM,
    latlng,
    time,
  };
  if (a.alt) {
    const altitude = new Array<number>(n);
    for (let i = 0; i < n; i++) altitude[i] = a.alt[i];
    (input as LedgerInput & { altitude: number[] }).altitude = altitude;
  }
  return input;
}

const post = (m: BuildResponse) => self.postMessage(m);

async function build(): Promise<void> {
  let seen = 0;
  const builder = createBuilder(DEFAULT_PARAMS, (accepted, s) => {
    post({ type: 'progress', accepted, seen: s });
  });

  // activitiesChronological yields in startTs order, which is exactly what the builder requires:
  // credit for new ground belongs to whoever got there first, so the order is the algorithm.
  for await (const a of activitiesChronological()) {
    seen++;
    builder.add(toLedgerInput(a));
  }

  if (seen === 0) {
    post({ type: 'empty' });
    return;
  }

  const out = serialize(builder.finish(), DEFAULT_PARAMS);
  out.manifest.builtAt = new Date().toISOString();

  const excluded: Record<string, number> = {};
  for (const r of builder.rejected) excluded[r.reason] = (excluded[r.reason] ?? 0) + 1;

  // One record per block, matching what ArtifactSource reads, and all of it written before the
  // done message so a caller that reloads immediately finds a complete set.
  //
  // The manifest goes LAST, and that ordering is the whole safety property. Each put() commits
  // its own transaction, so a failure partway through -- a quota error while writing 40 MB of
  // sites is the realistic one -- leaves a partial set behind. Written first, the new manifest
  // would describe blocks that were never written, and the reader would either throw or index
  // the previous build's bytes with this build's offsets and render silent nonsense. Written
  // last, a partial write leaves the old manifest beside old blocks: stale, but consistent, and
  // the map keeps working until a rebuild succeeds.
  await put(STORE_ARTIFACTS, { name: 'sites', data: out.sites });
  await put(STORE_ARTIFACTS, { name: 'touches', data: out.touches });
  await put(STORE_ARTIFACTS, { name: 'tracks', data: out.tracks });
  await put(STORE_ARTIFACTS, { name: 'activities', data: out.activities });
  await put(STORE_ARTIFACTS, { name: 'manifest', data: out.manifest });

  post({
    type: 'done',
    activities: out.manifest.counts.activities,
    sites: out.manifest.counts.sites,
    uniqueMeters: out.manifest.totals.uniqueMeters,
    totalMeters: out.manifest.totals.totalMeters,
    seen,
    excluded,
  });
}

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  if (e.data?.type !== 'build') return;
  build().catch((err: unknown) => {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  });
};

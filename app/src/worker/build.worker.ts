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
  | { type: 'done'; activities: number; sites: number; uniqueMeters: number; totalMeters: number }
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

  // One record per block, matching what ArtifactSource reads. Written before the done message
  // so a caller that reloads the instant it arrives always finds a complete set.
  await put(STORE_ARTIFACTS, { name: 'manifest', data: out.manifest });
  await put(STORE_ARTIFACTS, { name: 'sites', data: out.sites });
  await put(STORE_ARTIFACTS, { name: 'touches', data: out.touches });
  await put(STORE_ARTIFACTS, { name: 'tracks', data: out.tracks });
  await put(STORE_ARTIFACTS, { name: 'activities', data: out.activities });

  post({
    type: 'done',
    activities: out.manifest.counts.activities,
    sites: out.manifest.counts.sites,
    uniqueMeters: out.manifest.totals.uniqueMeters,
    totalMeters: out.manifest.totals.totalMeters,
  });
}

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  if (e.data?.type !== 'build') return;
  build().catch((err: unknown) => {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  });
};

/**
 * Writes a synthetic data/ so the whole pipeline can be exercised without touching the API.
 * Development tool only -- it overwrites data/summaries.json, so never run it on top of a
 * real sync. Useful for demoing the app and for eyeballing algorithm changes end to end.
 *
 *   npx tsx scripts/seed-demo.ts && npm run build:ledger && npm run dev
 */
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { straightRoad, outAndBack, trackLaps, closedLoop } from '../packages/ledger/src/__tests__/synth.js';
import type { LedgerInput } from '../packages/ledger/src/index.js';

const DATA = join(process.cwd(), 'data');
mkdirSync(join(DATA, 'streams'), { recursive: true });

const acts: LedgerInput[] = [];
let id = 100000;
const DAY = 86400;
// A plausible history: a commute repeated many times, some exploration, a track session.
for (let i = 0; i < 60; i++) {
  const ts = 1700000000 + i * DAY * 3;
  acts.push(straightRoad({ lengthM: 5000, sigmaM: 5, seed: i, id: id++, startTs: ts, name: 'Commute' }));
  if (i % 5 === 0) acts.push(straightRoad({ lengthM: 4000, bearingDeg: 90, offsetM: i * 400, sigmaM: 5, seed: 500+i, id: id++, startTs: ts + 3600, name: `Explore ${i}` }));
  if (i % 9 === 0) acts.push(trackLaps({ laps: 12, perimeterM: 400, laneOffsetM: 1.2, sigmaM: 3, seed: 900+i, id: id++, startTs: ts + 7200, name: 'Track workout' }));
  if (i % 7 === 0) acts.push(outAndBack({ lengthM: 3000, bearingDeg: 45, sigmaM: 4, seed: 700+i, id: id++, startTs: ts + 10800, name: 'Out and back', sportType: 'Ride' }));
  if (i % 11 === 0) acts.push(closedLoop({ perimeterM: 2400, laps: 2, sigmaM: 4, seed: 300+i, id: id++, startTs: ts + 14400, name: 'Park loop', sportType: 'Hike' }));
}

const activities: Record<string, unknown> = {};
for (const a of acts) {
  activities[String(a.id)] = {
    id: a.id, name: a.name, sportType: a.sportType,
    startDate: new Date(a.startTs * 1000).toISOString(),
    startDateLocal: new Date(a.startTs * 1000).toISOString(),
    startTs: a.startTs, distance: a.distanceM, trainer: false, manual: false,
  };
  writeFileSync(join(DATA, 'streams', `${a.id}.json.gz`),
    gzipSync(JSON.stringify({ id: a.id, fetchedAt: 0, latlng: a.latlng, time: a.time, altitude: a.altitude })));
}
writeFileSync(join(DATA, 'summaries.json'), JSON.stringify({ lastSyncTs: 0, activities }));
console.log(`seeded ${acts.length} synthetic activities`);

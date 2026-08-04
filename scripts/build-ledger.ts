/**
 * data/ -> app/public/artifacts/
 *
 * Reads the local stream cache, runs @um/ledger, and writes the binary artifacts the web app
 * consumes. Always a full rebuild: that is what makes chronological credit attribution stable
 * when older activities arrive out of order.
 */

import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedger, DEFAULT_PARAMS, sportGroupOf, type LedgerInput } from '@um/ledger';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
// NOT app/public: Vite copies public/ verbatim into dist/, so artifacts living there would
// ride a production build straight onto a CDN. Keeping them outside anywhere the build looks
// makes publishing the owner's home coordinates structurally impossible rather than a habit.
const OUT = join(ROOT, '.local', 'artifacts');

interface SummaryRecord {
  id: number;
  name: string;
  sportType: string;
  startDate: string;
  startDateLocal: string;
  startTs: number;
  distance: number;
  trainer: boolean;
  manual: boolean;
}

function loadSummaries(): SummaryRecord[] {
  const p = join(DATA, 'summaries.json');
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, 'utf8')) as { activities: Record<string, SummaryRecord> };
  return Object.values(raw.activities ?? {});
}

function loadStream(id: number): { latlng?: [number, number][]; time?: number[]; altitude?: number[] } | null {
  const p = join(DATA, 'streams', `${id}.json.gz`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(gunzipSync(readFileSync(p)).toString('utf8'));
  } catch (err) {
    console.warn(`  skipping unreadable stream ${id}: ${(err as Error).message}`);
    return null;
  }
}

function main(): void {
  if (!existsSync(join(DATA, 'summaries.json'))) {
    console.log('no data/ present -- run `npm run sync` first');
    return;
  }

  const t0 = Date.now();
  const summaries = loadSummaries();
  const streamDir = join(DATA, 'streams');
  const haveStreams = existsSync(streamDir) ? readdirSync(streamDir).length : 0;
  console.log(`loaded ${summaries.length} summaries, ${haveStreams} stream files`);

  const input: LedgerInput[] = [];
  for (const s of summaries) {
    const st = loadStream(s.id);
    if (!st || !st.latlng || !st.time) continue;
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
      altitude: st.altitude,
    });
  }
  console.log(`feeding ${input.length} activities with GPS to the ledger`);

  const out = buildLedger(input, DEFAULT_PARAMS);
  out.manifest.builtAt = new Date().toISOString();

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'sites.bin'), Buffer.from(out.sites));
  writeFileSync(join(OUT, 'touches.bin'), Buffer.from(out.touches));
  writeFileSync(join(OUT, 'tracks.bin'), Buffer.from(out.tracks));
  writeFileSync(join(OUT, 'activities.json'), JSON.stringify(out.activities));
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(out.manifest, null, 2));

  const m = out.manifest;
  const mi = (n: number) => (n / 1609.344).toFixed(1);
  console.log(
    `built ${m.counts.sites.toLocaleString()} sites from ${m.counts.activities} activities in ${(
      (Date.now() - t0) / 1000
    ).toFixed(1)}s`,
  );
  console.log(`  unique ${mi(m.totals.uniqueMeters)} mi of ${mi(m.totals.totalMeters)} mi logged`);
  console.log(
    `  artifacts: ${((out.sites.byteLength + out.touches.byteLength + out.tracks.byteLength) / 1e6).toFixed(1)} MB`,
  );
}

main();

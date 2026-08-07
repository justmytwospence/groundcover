/**
 * One-time bootstrap: local data/ -> the publish deployment's private blob store.
 *
 *   npm run publish:seed
 *
 * This exists so the cron function never has to run a first backfill. A cold cloud start would
 * mean 1,300+ stream requests against a 2,000/day read cap from inside a 300 s function -- it
 * could not finish, and would burn the day's budget failing. Seeding hands the cloud a corpus
 * that is already complete; from then on the function only ever fetches what is new.
 *
 * IT ALSO HANDS OVER THE REFRESH TOKEN, AND THAT IS A ONE-WAY DOOR.
 *
 * Strava rotates the refresh token on every refresh, so exactly one consumer can hold it (see
 * CLAUDE.md). After this runs, the cloud is that consumer: the next nightly refresh invalidates
 * the copy in .strava-token.json and `npm run sync` will start failing. That is the intended
 * end state -- the cloud is doing the syncing now. To take it back, re-run `npm run auth` and
 * re-seed, which invalidates the cloud's copy instead.
 *
 * Token values are never printed, including in error messages.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { encodePack, shardFor, shardPath, type PackEntry } from './pack.js';
import {
  SUMMARIES_PATH,
  TOKEN_PATH,
  privateStore,
  putBlob,
  putJson,
  type StoredSummary,
  type StoredToken,
} from './store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'data');
const STREAMS = join(DATA, 'streams');
const TOKEN_FILE = join(ROOT, '.strava-token.json');

interface SummariesFileOnDisk {
  activities: Record<string, StoredSummary>;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

async function confirm(question: string): Promise<boolean> {
  if (process.argv.includes('--yes')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

async function main(): Promise<void> {
  loadEnvFile(join(ROOT, '.env.publish.local'));

  if (!existsSync(join(DATA, 'summaries.json'))) {
    throw new Error('no data/summaries.json -- run `npm run sync` first');
  }
  if (!existsSync(TOKEN_FILE)) {
    throw new Error('no .strava-token.json -- run `npm run auth` first');
  }

  const store = privateStore();

  const raw = JSON.parse(readFileSync(join(DATA, 'summaries.json'), 'utf8')) as SummariesFileOnDisk;
  const summaries = Object.values(raw.activities ?? {});
  const files = existsSync(STREAMS) ? readdirSync(STREAMS).filter((f) => f.endsWith('.json.gz')) : [];

  // Shard by the activity's own start time, not the file's, so the cron function can work out
  // which shard a NEW activity belongs in without reading anything back first.
  const startTsById = new Map<number, number>();
  for (const s of summaries) startTsById.set(s.id, s.startTs);

  const shards = new Map<string, PackEntry[]>();
  let orphans = 0;
  for (const f of files) {
    const id = Number(f.slice(0, -'.json.gz'.length));
    const startTs = startTsById.get(id);
    if (startTs === undefined) {
      // A stream with no summary cannot be fed to the ledger anyway; build-ledger.ts drives
      // off summaries. Carrying it to the cloud would just be dead weight.
      orphans++;
      continue;
    }
    const shard = shardFor(startTs);
    const entry = { id, gz: new Uint8Array(readFileSync(join(STREAMS, f))) };
    const bucket = shards.get(shard);
    if (bucket) bucket.push(entry);
    else shards.set(shard, [entry]);
  }

  const totalBytes = [...shards.values()]
    .flat()
    .reduce((n, e) => n + e.gz.length, 0);

  console.log(`${summaries.length} summaries, ${files.length} stream files`);
  console.log(
    `${shards.size} shards, ${(totalBytes / 1e6).toFixed(1)} MB of GPS` +
      (orphans > 0 ? `  (${orphans} stream files with no summary, skipped)` : ''),
  );
  console.log('');
  console.log('This uploads your raw GPS to a PRIVATE blob store, and hands the Strava refresh');
  console.log('token to the cloud. `npm run sync` on this machine stops working afterwards.');
  console.log('');
  if (!(await confirm('Seed the publish store?'))) {
    console.log('Nothing was uploaded.');
    return;
  }

  for (const [shard, entries] of [...shards].sort()) {
    entries.sort((a, b) => a.id - b.id);
    const packed = encodePack(entries);
    await putBlob(store, shardPath(shard), packed, {
      contentType: 'application/octet-stream',
    });
    console.log(`  ${shardPath(shard)}  ${entries.length} streams, ${(packed.length / 1e6).toFixed(1)} MB`);
  }

  await putJson(store, SUMMARIES_PATH, raw);
  console.log(`  ${SUMMARIES_PATH}  ${summaries.length} activities`);

  const local = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as StoredToken & { athleteId?: number };
  if (!local.refreshToken) throw new Error('.strava-token.json has no refreshToken');
  const token: StoredToken = {
    refreshToken: local.refreshToken,
    ...(local.athleteId !== undefined ? { athleteId: local.athleteId } : {}),
    rotatedAt: new Date().toISOString(),
  };
  await putJson(store, TOKEN_PATH, token);
  console.log(`  ${TOKEN_PATH}  seeded`);

  console.log('');
  console.log('Seeded. The cloud now owns the refresh token.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

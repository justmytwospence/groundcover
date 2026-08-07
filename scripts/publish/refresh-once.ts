/**
 * Runs one refresh from this machine, against the same blob stores the cron uses.
 *
 *   npm run publish:refresh
 *
 * Two jobs. It bootstraps: the very first build has to exist before the app can be staged,
 * because staging needs the pointer URL that this run creates. And it is how you debug the
 * cron without waiting a day or reading function logs -- identical code path, visible output.
 *
 * It does NOT take the handler's lock, and it does publish a new build. Do not run it while a
 * cron run may be in flight; the cron is daily, so in practice that means not within a few
 * minutes of the scheduled hour.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRefresh } from './refresh.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

async function main(): Promise<void> {
  loadEnvFile(join(ROOT, '.env.publish.local'));
  loadEnvFile(join(ROOT, '.env.local'));

  const t0 = Date.now();
  const result = await runRefresh((s) => console.log(`  ${s}`));

  console.log('');
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  new activities   ${result.newActivities}`);
  console.log(`  streams fetched  ${result.streamsFetched}`);
  if (result.streamsRemaining > 0) {
    console.log(`  deferred         ${result.streamsRemaining} (run again)`);
  }
  console.log(`  activities built ${result.activitiesBuilt}`);
  if (result.note) console.log(`  note             ${result.note}`);

  // The pointer URL is what `npm run publish:stage` bakes into the bundle. It is stable across
  // builds -- only the artifact URLs it names change -- so this is a one-time copy.
  if (result.pointerUrl) {
    console.log('');
    console.log(`  PUBLISH_POINTER_URL=${result.pointerUrl}`);
    console.log('');
    console.log('Put that line in .env.publish.local, then run `npm run publish:deploy`.');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

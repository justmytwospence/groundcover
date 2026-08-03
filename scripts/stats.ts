/**
 * Text summary of the current artifacts. Run this after any ledger change: the smoke checks
 * in docs/algorithm.md section 10.3 catch a broken build in seconds.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActivitySummary, Manifest } from '@um/ledger';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'app', 'public', 'artifacts');

const MI = 1609.344;
const mi = (m: number) => (m / MI).toFixed(1);

function main(): void {
  const mp = join(OUT, 'manifest.json');
  if (!existsSync(mp)) {
    console.log('no artifacts -- run `npm run build:ledger` first');
    return;
  }
  const m = JSON.parse(readFileSync(mp, 'utf8')) as Manifest;
  const acts = JSON.parse(readFileSync(join(OUT, 'activities.json'), 'utf8')) as ActivitySummary[];

  const pct = (m.totals.uniqueMeters / m.totals.totalMeters) * 100;
  console.log(`built    ${m.builtAt}`);
  console.log(`params   ${m.paramsHash}`);
  console.log(`activities ${m.counts.activities.toLocaleString()}   sites ${m.counts.sites.toLocaleString()}   touches ${m.counts.touches.toLocaleString()}`);
  console.log(`unique   ${mi(m.totals.uniqueMeters)} mi`);
  console.log(`total    ${mi(m.totals.totalMeters)} mi`);
  console.log(`ratio    ${pct.toFixed(1)}% unique`);
  console.log(
    `span     ${new Date(m.timeRange.minTs * 1000).toISOString().slice(0, 10)} to ${new Date(
      m.timeRange.maxTs * 1000,
    ).toISOString().slice(0, 10)}`,
  );

  const byGroup = new Map<number, { n: number; total: number; nw: number }>();
  for (const a of acts) {
    const g = byGroup.get(a.group) ?? { n: 0, total: 0, nw: 0 };
    g.n++;
    g.total += a.distanceM;
    g.nw += a.newGroundM;
    byGroup.set(a.group, g);
  }
  console.log('\nby sport group');
  for (const [gi, g] of [...byGroup.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${String(m.sportGroups[gi]).padEnd(6)} ${String(g.n).padStart(5)} acts  ${mi(g.total).padStart(9)} mi logged  ${mi(g.nw).padStart(8)} mi new`);
  }

  console.log('\ntop 10 discoveries');
  for (const a of [...acts].sort((x, y) => y.newGroundM - x.newGroundM).slice(0, 10)) {
    const p = a.distanceM > 0 ? ((a.newGroundM / a.distanceM) * 100).toFixed(0) : '0';
    console.log(
      `  ${a.startDateLocal.slice(0, 10)}  ${mi(a.newGroundM).padStart(7)} mi new  ${String(p).padStart(3)}%  ${a.name.slice(0, 44)}`,
    );
  }

  // Smoke checks from docs/algorithm.md 10.3.
  console.log('\nsmoke checks');
  const chrono = [...acts].sort((a, b) => a.startTs - b.startTs);
  const firstPct = chrono.length && chrono[0].distanceM > 0 ? (chrono[0].newGroundM / chrono[0].distanceM) * 100 : 0;
  const check = (ok: boolean, label: string) => console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  check(pct < 90, `unique is well below total (${pct.toFixed(1)}%)`);
  check(firstPct > 80, `first activity chronologically is mostly new (${firstPct.toFixed(0)}%)`);
  check(m.counts.touches <= m.counts.trackPoints, 'touches <= trackPoints');
  check(m.counts.sites > 0, 'sites exist');
}

main();

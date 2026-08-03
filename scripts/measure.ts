/** Diagnostic harness: prints what the algorithm actually does on each synthetic case. */
import { runLedger } from '../packages/ledger/src/ledger.js';
import { DEFAULT_PARAMS } from '../packages/ledger/src/params.js';
import { preprocess } from '../packages/ledger/src/preprocess.js';
import type { LedgerInput, Params } from '../packages/ledger/src/index.js';
import {
  closedLoop,
  outAndBack,
  straightRoad,
  switchbacks,
  trackLaps,
  withOffset,
} from '../packages/ledger/src/__tests__/synth.js';

const P = (o: Partial<Params> = {}): Params => ({ ...DEFAULT_PARAMS, ...o });
const u = (a: LedgerInput[], p: Params = DEFAULT_PARAMS) => runLedger(a, p).totals.uniqueMeters;
const r2 = (n: number) => Math.round(n * 10) / 10;

console.log('--- A14 loop internals ---');
for (const perim of [40, 94]) {
  const act = closedLoop({ perimeterM: perim, laps: 1, sigmaM: 0, stepM: 1, seed: 1 });
  const pre = preprocess(act, DEFAULT_PARAMS)!;
  console.log(
    `perimeter=${perim} samples=${pre.samples.length} totalM=${r2(pre.totalM)} ` +
      `bearings=[${pre.samples.map((s) => s.bearing * 2).join(',')}]`,
  );
  const built = runLedger([act], DEFAULT_PARAMS);
  console.log(
    `  sites=${built.sites.n} unique=${r2(built.totals.uniqueMeters)} ` +
      `credits=[${Array.from(built.sites.creditM).map(r2).join(',')}]`,
  );
  const off = runLedger([act], P({ uTurnDedup: false }));
  console.log(`  with uTurnDedup off: sites=${off.sites.n} unique=${r2(off.totals.uniqueMeters)}`);
  const three = closedLoop({ perimeterM: perim, laps: 3, sigmaM: 0, stepM: 1, seed: 1 });
  console.log(`  three laps: unique=${r2(u([three]))}`);
}

console.log('\n--- A1 out-and-back ---');
for (const sigma of [0, 3, 4, 8]) {
  const a = outAndBack({ lengthM: 2000, sigmaM: sigma, seed: 1 });
  console.log(
    `sigma=${sigma}: on=${r2(u([a]))} off=${r2(u([a], P({ uTurnDedup: false })))}`,
  );
}

console.log('\n--- A2 accretion (3000 m road, 100 passes) ---');
for (const sigma of [3, 5, 8]) {
  const acts: LedgerInput[] = [];
  for (let i = 0; i < 100; i++) {
    acts.push(
      straightRoad({ lengthM: 3000, sigmaM: sigma, seed: 100 + i, startTs: 1700000000 + i * 86400, id: 5000 + i }),
    );
  }
  const b = runLedger(acts, DEFAULT_PARAMS);
  console.log(
    `sigma=${sigma}: total=${r2(b.totals.uniqueMeters)} (${r2((b.totals.uniqueMeters / 3000 - 1) * 100)}% over) ` +
      `last-pass-adds=${r2(b.activities[99].newGroundM)}`,
  );
}

console.log('\n--- A9 whole-trace rigid offset (2000 m) ---');
const first = straightRoad({ lengthM: 2000, sigmaM: 4, seed: 91, id: 7301 });
for (const off of [20, 22, 25, 30, 40]) {
  for (const sigma of [3, 4]) {
    const second = withOffset(
      straightRoad({ lengthM: 2000, sigmaM: sigma, seed: 92, id: 7302, startTs: 1700086400 }),
      off,
    );
    const on = runLedger([first, second], P({ offsetDetector: true }));
    const noDet = runLedger([first, second], P({ offsetDetector: false }));
    console.log(
      `offset=${off} sigma=${sigma}: detector-on adds=${r2(on.activities[1].newGroundM)} ` +
        `detector-off adds=${r2(noDet.activities[1].newGroundM)}`,
    );
  }
}

console.log('\n--- A5 track laps ---');
for (const laps of [1, 25]) {
  const a = trackLaps({ laps, perimeterM: 400, laneOffsetM: 1.2, sigmaM: 3, seed: 51 });
  console.log(`laps=${laps}: unique=${r2(u([a]))}`);
}

console.log('\n--- A6 switchbacks (6x100 m, 15 m apart, 25 m rise) ---');
{
  const geom = { legs: 6, legLengthM: 100, spacingM: 15, riseM: 25, sigmaM: 3, seed: 61 };
  const trueLen = 6 * 100 + 5 * Math.PI * 7.5;
  const alt = u([switchbacks(geom)]);
  const noAlt = u([switchbacks({ ...geom, withAltitude: false })]);
  const noUturn = u([switchbacks(geom)], P({ uTurnDedup: false }));
  console.log(
    `trueLen=${r2(trueLen)} withAlt=${r2(alt)} (${r2((alt / trueLen) * 100)}%) ` +
      `noAlt=${r2(noAlt)} (${r2((noAlt / trueLen) * 100)}%) noUturn=${r2(noUturn)} ` +
      `uturn-delta=${r2((Math.abs(alt - noUturn) / noUturn) * 100)}%`,
  );
}

console.log('\n--- A3 parallel roads ---');
for (const off of [8, 27, 35, 50]) {
  const a = straightRoad({ lengthM: 1000, sigmaM: 3, seed: 21, id: 7001 });
  const b = straightRoad({ lengthM: 1000, offsetM: off, sigmaM: 3, seed: 22, id: 7002, startTs: 1700086400 });
  const built = runLedger([a, b], DEFAULT_PARAMS);
  console.log(`offset=${off}: second adds=${r2(built.activities[1].newGroundM)}`);
}

/**
 * Artifact round trip. Reads the serialized buffers back through the manifest's own byte
 * offsets and checks they reproduce every serialized column. Build-time-only fields
 * (altitude, mintS, alive) are deliberately not serialized and are not compared.
 */

import { describe, expect, it } from 'vitest';
import { buildLedger } from '../index.js';
import { runLedger } from '../ledger.js';
import { DEFAULT_PARAMS, PARAMS_HASH, SPORT_GROUPS } from '../params.js';
import { FORMAT_VERSION, type BlockRef } from '../types.js';
import { outAndBack, straightRoad } from './synth.js';

const acts = [
  straightRoad({ lengthM: 1200, sigmaM: 3, seed: 1, id: 1, startTs: 1700000000 }),
  straightRoad({ lengthM: 900, offsetM: 300, sigmaM: 3, seed: 2, id: 2, startTs: 1700086400, sportType: 'Ride' }),
  outAndBack({ lengthM: 600, sigmaM: 3, seed: 3, id: 3, startTs: 1700172800 }),
];

function viewOf(buf: ArrayBuffer, ref: BlockRef) {
  switch (ref.type) {
    case 'Int32':
      return new Int32Array(buf, ref.byteOffset, ref.length);
    case 'Uint32':
      return new Uint32Array(buf, ref.byteOffset, ref.length);
    case 'Uint16':
      return new Uint16Array(buf, ref.byteOffset, ref.length);
    default:
      return new Uint8Array(buf, ref.byteOffset, ref.length);
  }
}

describe('artifact serialization', () => {
  const built = runLedger(acts, DEFAULT_PARAMS);
  const out = buildLedger(acts, DEFAULT_PARAMS);
  const m = out.manifest;

  it('reports a consistent manifest', () => {
    expect(m.formatVersion).toBe(FORMAT_VERSION);
    expect(m.paramsHash).toBe(PARAMS_HASH);
    expect(m.sportGroups).toEqual(SPORT_GROUPS);
    expect(m.counts.sites).toBe(built.sites.n);
    expect(m.counts.activities).toBe(built.activities.length);
    expect(m.counts.touches).toBeLessThanOrEqual(m.counts.trackPoints);
    expect(m.files.sites.blocks.firstTsByGroup.length).toBe(SPORT_GROUPS.length);
  });

  it('aligns every block to 8 bytes so views are zero-copy', () => {
    const refs: BlockRef[] = [
      ...Object.values(m.files.sites.blocks).flat(),
      ...Object.values(m.files.touches.blocks),
      ...Object.values(m.files.tracks.blocks),
    ] as BlockRef[];
    for (const r of refs) expect(r.byteOffset % 8).toBe(0);
  });

  it('round-trips every serialized site column', () => {
    const b = m.files.sites.blocks;
    const x = viewOf(out.sites, b.x) as Int32Array;
    const y = viewOf(out.sites, b.y) as Int32Array;
    const bearing = viewOf(out.sites, b.bearing) as Uint8Array;
    const creditCm = viewOf(out.sites, b.creditCm) as Uint16Array;
    const mintTs = viewOf(out.sites, b.mintTs) as Uint32Array;
    const mintAct = viewOf(out.sites, b.mintAct) as Uint32Array;

    expect(x.length).toBe(built.sites.n);
    for (let i = 0; i < built.sites.n; i++) {
      // Positions are stored to the centimetre.
      expect(Math.abs(x[i] / 100 - built.sites.x[i])).toBeLessThan(0.01);
      expect(Math.abs(y[i] / 100 - built.sites.y[i])).toBeLessThan(0.01);
      expect(bearing[i]).toBe(built.sites.bearing[i]);
      expect(Math.abs(creditCm[i] / 100 - built.sites.creditM[i])).toBeLessThan(0.01);
      expect(mintTs[i]).toBe(built.sites.mintTs[i]);
      expect(mintAct[i]).toBe(built.sites.mintAct[i]);
    }

    for (let g = 0; g < SPORT_GROUPS.length; g++) {
      const arr = viewOf(out.sites, b.firstTsByGroup[g]) as Uint32Array;
      expect(Array.from(arr)).toEqual(Array.from(built.sites.firstTsByGroup[g]));
    }
  });

  it('round-trips touches, and every id is in range and sorted', () => {
    const tb = m.files.touches.blocks;
    const actOffsets = viewOf(out.touches, tb.actOffsets) as Uint32Array;
    const siteIds = viewOf(out.touches, tb.siteIds) as Uint32Array;
    expect(actOffsets.length).toBe(built.activities.length + 1);
    expect(Array.from(siteIds)).toEqual(Array.from(built.touches.siteIds));

    for (let a = 0; a < built.activities.length; a++) {
      const from = actOffsets[a];
      const to = actOffsets[a + 1];
      expect(to).toBeGreaterThanOrEqual(from);
      for (let k = from; k < to; k++) {
        expect(siteIds[k]).toBeLessThan(m.counts.sites);
        if (k > from) expect(siteIds[k]).toBeGreaterThan(siteIds[k - 1]);
      }
    }
  });

  it('round-trips tracks and marks leg starts', () => {
    const tb = m.files.tracks.blocks;
    const offsets = viewOf(out.tracks, tb.trackOffsets) as Uint32Array;
    const flag = viewOf(out.tracks, tb.flag) as Uint8Array;
    expect(offsets[offsets.length - 1]).toBe(m.counts.trackPoints);
    // The first sample of every activity starts a leg.
    for (let a = 0; a < built.activities.length; a++) expect(flag[offsets[a]] & 0b100).toBe(0b100);
  });

  it('per-activity new ground sums to the unique total', () => {
    const sum = out.activities.reduce((s, a) => s + a.newGroundM, 0);
    expect(Math.abs(sum - m.totals.uniqueMeters)).toBeLessThan(0.5);
  });

  it('carries startDateLocal through to activities.json', () => {
    for (const a of out.activities) expect(typeof a.startDateLocal).toBe('string');
  });
});

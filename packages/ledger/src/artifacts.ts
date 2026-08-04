/**
 * Serialization to the binary artifact layout in docs/data-pipeline.md section 5.
 * Every block is padded to a multiple of 8 bytes so typed-array views are zero-copy.
 */

import type { BuiltLedger } from './ledger.js';
import { DEFAULT_PARAMS, hashParams, SPORT_GROUPS, type Params } from './params.js';
import { FORMAT_VERSION, type BlockRef, type LedgerOutput, type Manifest } from './types.js';

const align8 = (n: number) => (n + 7) & ~7;

type Src = Int32Array | Uint32Array | Uint16Array | Uint8Array;

function typeOf(a: Src): BlockRef['type'] {
  if (a instanceof Int32Array) return 'Int32';
  if (a instanceof Uint32Array) return 'Uint32';
  if (a instanceof Uint16Array) return 'Uint16';
  return 'Uint8';
}

/** Lays blocks out back to back with 8-byte alignment and returns the buffer plus refs. */
function pack(blocks: Src[]): { buffer: ArrayBuffer; refs: BlockRef[] } {
  const refs: BlockRef[] = [];
  let offset = 0;
  for (const b of blocks) {
    refs.push({ byteOffset: offset, length: b.length, type: typeOf(b) });
    offset = align8(offset + b.byteLength);
  }
  const buffer = new ArrayBuffer(offset);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < blocks.length; i++) {
    view.set(new Uint8Array(blocks[i].buffer, blocks[i].byteOffset, blocks[i].byteLength), refs[i].byteOffset);
  }
  return { buffer, refs };
}

export function serialize(built: BuiltLedger, params: Params = DEFAULT_PARAMS): LedgerOutput {
  const s = built.sites;

  // Positions are stored as Mercator centimetres in Int32: +/-20,037,508 m fits in range.
  const xCm = new Int32Array(s.n);
  const yCm = new Int32Array(s.n);
  const creditCm = new Uint16Array(s.n);
  for (let i = 0; i < s.n; i++) {
    xCm[i] = Math.round(s.x[i] * 100);
    yCm[i] = Math.round(s.y[i] * 100);
    creditCm[i] = Math.min(65535, Math.round(s.creditM[i] * 100));
  }

  const siteBlocks: Src[] = [xCm, yCm, s.bearing, creditCm, s.mintTs, s.mintAct, ...s.firstTsByGroup];
  const sitesPacked = pack(siteBlocks);
  const touchesPacked = pack([built.touches.actOffsets, built.touches.siteIds, built.touches.dirs]);
  const tracksPacked = pack([
    built.tracks.trackOffsets,
    built.tracks.px,
    built.tracks.py,
    built.tracks.flag,
  ]);

  const [rx, ry, rb, rc, rt, ra, ...rg] = sitesPacked.refs;
  const [rAct, rSite, rDirs] = touchesPacked.refs;
  const [rTo, rPx, rPy, rFl] = tracksPacked.refs;

  const manifest: Manifest = {
    formatVersion: FORMAT_VERSION,
    builtAt: '',
    paramsHash: hashParams(params),
    params: params as unknown as Record<string, unknown>,
    sportGroups: SPORT_GROUPS,
    counts: {
      activities: built.activities.length,
      sites: s.n,
      touches: built.touches.siteIds.length,
      trackPoints: built.tracks.px.length,
    },
    bounds: built.bounds,
    timeRange: built.timeRange,
    totals: built.totals,
    files: {
      sites: {
        path: 'sites.bin',
        byteLength: sitesPacked.buffer.byteLength,
        blocks: {
          x: rx,
          y: ry,
          bearing: rb,
          creditCm: rc,
          mintTs: rt,
          mintAct: ra,
          firstTsByGroup: rg,
        },
      },
      touches: {
        path: 'touches.bin',
        byteLength: touchesPacked.buffer.byteLength,
        blocks: { actOffsets: rAct, siteIds: rSite, dirs: rDirs },
      },
      tracks: {
        path: 'tracks.bin',
        byteLength: tracksPacked.buffer.byteLength,
        blocks: { trackOffsets: rTo, px: rPx, py: rPy, flag: rFl },
      },
      activities: { path: 'activities.json' },
    },
  };

  if (manifest.counts.touches > manifest.counts.trackPoints) {
    throw new Error(
      `invariant violated: touches (${manifest.counts.touches}) > trackPoints (${manifest.counts.trackPoints})`,
    );
  }

  return {
    manifest,
    sites: sitesPacked.buffer,
    touches: touchesPacked.buffer,
    tracks: tracksPacked.buffer,
    activities: built.activities,
  };
}

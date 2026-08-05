/**
 * The site table and the spatial index used during the build.
 * See docs/algorithm.md sections 4.1 through 4.2.
 */

import { angDiff180, groundDist, mercDist2 } from './geo.js';
import type { Params } from './params.js';
import type { Sample } from './preprocess.js';

const CELL_BITS = 26;
const CELL_OFFSET = 1 << 25;
const CELL_STRIDE = 1 << CELL_BITS; // 2^26

/**
 * Append-only, columnar site table. Grown by doubling typed arrays -- never an array of
 * objects, which is what keeps the build inside its time budget.
 */
export class SiteTable {
  n = 0;
  x: Float64Array;
  y: Float64Array;
  bearing: Uint8Array;
  alt: Float32Array;
  creditM: Float32Array;
  mintTs: Uint32Array;
  mintAct: Uint32Array;
  mintS: Float64Array;
  /** Index of the sample within its activity that minted this site (build-time only). */
  mintSample: Int32Array;
  alive: Uint8Array;

  constructor(capacity = 1 << 16) {
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.bearing = new Uint8Array(capacity);
    this.alt = new Float32Array(capacity);
    this.creditM = new Float32Array(capacity);
    this.mintTs = new Uint32Array(capacity);
    this.mintAct = new Uint32Array(capacity);
    this.mintS = new Float64Array(capacity);
    this.mintSample = new Int32Array(capacity);
    this.alive = new Uint8Array(capacity);
  }

  private grow(): void {
    const cap = this.x.length * 2;
    const gf = (src: Float64Array) => {
      const d = new Float64Array(cap);
      d.set(src);
      return d;
    };
    const g32 = (src: Float32Array) => {
      const d = new Float32Array(cap);
      d.set(src);
      return d;
    };
    const gu32 = (src: Uint32Array) => {
      const d = new Uint32Array(cap);
      d.set(src);
      return d;
    };
    const gi32 = (src: Int32Array) => {
      const d = new Int32Array(cap);
      d.set(src);
      return d;
    };
    const gu8 = (src: Uint8Array) => {
      const d = new Uint8Array(cap);
      d.set(src);
      return d;
    };
    this.x = gf(this.x);
    this.y = gf(this.y);
    this.bearing = gu8(this.bearing);
    this.alt = g32(this.alt);
    this.creditM = g32(this.creditM);
    this.mintTs = gu32(this.mintTs);
    this.mintAct = gu32(this.mintAct);
    this.mintS = gf(this.mintS);
    this.mintSample = gi32(this.mintSample);
    this.alive = gu8(this.alive);
  }

  /**
   * `p.ts` is the sample's own absolute time, not the activity's start.
   *
   * Storing the activity start here gave every site in a ride the same instant, which is what
   * made time-lapse playback pop whole routes into existence at once. Per-sample times let the
   * renderer reveal ground in the order it was actually covered, so a route draws itself.
   */
  push(p: Sample, actIdx: number, sampleIdx: number): number {
    if (this.n === this.x.length) this.grow();
    const i = this.n++;
    this.x[i] = p.x;
    this.y[i] = p.y;
    this.bearing[i] = p.bearing;
    this.alt[i] = p.alt === null ? NaN : p.alt;
    this.creditM[i] = p.creditM;
    this.mintTs[i] = p.ts;
    this.mintAct[i] = actIdx;
    this.mintS[i] = p.s;
    this.mintSample[i] = sampleIdx;
    this.alive[i] = 1;
    return i;
  }
}

/**
 * Uniform grid hash over live sites. The cell key packs two 26-bit indices into an exact
 * float64 integer -- never BigInt or string keys, either of which costs 5-10x in the hot loop.
 */
export class SiteGrid {
  private map = new Map<number, number[]>();
  private cell: number;

  constructor(cellMerc: number) {
    this.cell = cellMerc;
  }

  private key(x: number, y: number): number {
    const cx = Math.floor(x / this.cell) + CELL_OFFSET;
    const cy = Math.floor(y / this.cell) + CELL_OFFSET;
    return cy * CELL_STRIDE + cx;
  }

  insert(x: number, y: number, id: number): void {
    const k = this.key(x, y);
    const bucket = this.map.get(k);
    if (bucket) bucket.push(id);
    else this.map.set(k, [id]);
  }

  /**
   * Visit every site id whose cell lies within `radiusM` ground metres of (x, y). The cell
   * radius adapts to latitude so the candidate set stays complete anywhere on Earth.
   */
  forEachNear(x: number, y: number, cosLat: number, radiusM: number, fn: (id: number) => void): void {
    const r = Math.max(1, Math.ceil(radiusM / (this.cell * cosLat)));
    const cx = Math.floor(x / this.cell) + CELL_OFFSET;
    const cy = Math.floor(y / this.cell) + CELL_OFFSET;
    for (let dy = -r; dy <= r; dy++) {
      const rowBase = (cy + dy) * CELL_STRIDE;
      for (let dx = -r; dx <= r; dx++) {
        const bucket = this.map.get(rowBase + cx + dx);
        if (bucket) for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
      }
    }
  }
}

export interface CandidateOpts {
  applyGuard: boolean;
  currentAct: number;
  params: Params;
}

export interface Candidate {
  id: number;
  dist: number;
}

/**
 * Nearest live site to `p` within `radiusM`, subject to the bearing gate, the optional
 * along-track guard, and the same-activity altitude gate. Ties break to the lowest site id
 * so the build stays deterministic.
 */
export function nearestCandidate(
  p: Sample,
  radiusM: number,
  sites: SiteTable,
  grid: SiteGrid,
  opts: CandidateOpts,
): Candidate | null {
  const { params, currentAct, applyGuard } = opts;
  const cosLat = p.cosLat;
  // Prefilter in squared Mercator units, so the hot path avoids sqrt and cosLat entirely.
  const maxMerc2 = (radiusM / cosLat) * (radiusM / cosLat);
  let bestId = -1;
  let bestD2 = Infinity;

  grid.forEachNear(p.x, p.y, cosLat, radiusM, (id) => {
    if (!sites.alive[id]) return;
    if (angDiff180(sites.bearing[id], p.bearing) > params.BEARING_TOL) return;
    const sameAct = sites.mintAct[id] === currentAct;
    if (sameAct) {
      if (applyGuard && Math.abs(sites.mintS[id] - p.s) < params.GUARD_ALONG) return;
      // Altitude gate is same-activity only: absolute barometric altitude drifts tens of
      // metres between days, so cross-activity comparison would mint phantom routes.
      const sa = sites.alt[id];
      if (p.alt !== null && !Number.isNaN(sa) && Math.abs(sa - p.alt) > params.ALT_GATE) return;
    }
    const d2 = mercDist2(sites.x[id], sites.y[id], p.x, p.y);
    if (d2 > maxMerc2) return;
    if (d2 < bestD2 || (d2 === bestD2 && id < bestId)) {
      bestD2 = d2;
      bestId = id;
    }
  });

  if (bestId < 0) return null;
  return { id: bestId, dist: groundDist(sites.x[bestId], sites.y[bestId], p.x, p.y, cosLat) };
}

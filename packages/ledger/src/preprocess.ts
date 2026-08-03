/**
 * Stage 1: per-activity preprocessing. A pure function of one activity's streams.
 * See docs/algorithm.md sections 3.1 through 3.6. The order of steps matters.
 */

import { bearingBetween, encodeBearing, latToY, lngToX } from './geo.js';
import { SPORT_CAPS, type Params } from './params.js';
import type { LedgerInput } from './types.js';

/** A point in the intermediate (pre-resample) pipeline. */
interface RawPoint {
  x: number;
  y: number;
  t: number;
  alt: number | null;
  cosLat: number;
}

/** One resampled sample: the unit the ledger operates on. */
export interface Sample {
  x: number;
  y: number;
  cosLat: number;
  ts: number;
  /** Cumulative along-track ground metres across the whole activity; gaps contribute zero. */
  s: number;
  creditM: number;
  bearing: number;
  alt: number | null;
  leg: number;
}

export interface Preprocessed {
  samples: Sample[];
  /** True total along-track ground metres over all legs. */
  totalM: number;
}

const DEG = Math.PI / 180;

/** Section 3.1. Returns null when the activity must be excluded entirely. */
export function excluded(a: LedgerInput): string | null {
  if (a.trainer) return 'trainer';
  if (a.manual) return 'manual';
  if (a.sportType.startsWith('Virtual')) return 'virtual';
  if (!a.latlng || a.latlng.length < 2) return 'no-gps';
  if (!a.time || a.time.length !== a.latlng.length) return 'stream-mismatch';

  // Treadmill backstop: a real GPS device that never moved while reporting distance.
  if (a.distanceM > 1000) {
    let sumLat = 0;
    let sumLng = 0;
    for (const [lat, lng] of a.latlng) {
      sumLat += lat;
      sumLng += lng;
    }
    const cLat = sumLat / a.latlng.length;
    const cLng = sumLng / a.latlng.length;
    const cx = lngToX(cLng);
    const cy = latToY(cLat);
    const cosLat = Math.cos(cLat * DEG);
    let within = 0;
    for (const [lat, lng] of a.latlng) {
      const dx = lngToX(lng) - cx;
      const dy = latToY(lat) - cy;
      if (Math.sqrt(dx * dx + dy * dy) * cosLat <= 50) within++;
    }
    if (within / a.latlng.length >= 0.95) return 'treadmill-shaped';
  }
  return null;
}

/** Sections 3.2 and 3.3: timestamp assembly, dedup, and a 3-point median spike filter. */
function toRawPoints(a: LedgerInput): RawPoint[] {
  const lat: number[] = [];
  const lng: number[] = [];
  const t: number[] = [];
  const alt: (number | null)[] = [];

  let prevT = -Infinity;
  let prevLat = NaN;
  let prevLng = NaN;
  for (let i = 0; i < a.latlng.length; i++) {
    const p = a.latlng[i];
    const ti = a.startTs + a.time[i];
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (ti <= prevT) continue;
    if (p[0] === prevLat && p[1] === prevLng && ti === prevT) continue;
    lat.push(p[0]);
    lng.push(p[1]);
    t.push(ti);
    alt.push(a.altitude && Number.isFinite(a.altitude[i]) ? a.altitude[i] : null);
    prevT = ti;
    prevLat = p[0];
    prevLng = p[1];
  }

  const n = lat.length;
  const out: RawPoint[] = new Array(n);
  const med3 = (a0: number, b0: number, c0: number) => Math.max(Math.min(a0, b0), Math.min(Math.max(a0, b0), c0));
  for (let i = 0; i < n; i++) {
    // Median filter kills single-sample spikes that a speed cap alone cannot. Endpoints pass through.
    const la = i === 0 || i === n - 1 ? lat[i] : med3(lat[i - 1], lat[i], lat[i + 1]);
    const lo = i === 0 || i === n - 1 ? lng[i] : med3(lng[i - 1], lng[i], lng[i + 1]);
    out[i] = {
      x: lngToX(lo),
      y: latToY(la),
      t: t[i],
      alt: alt[i],
      cosLat: Math.cos(la * DEG),
    };
  }
  return out;
}

/** Section 3.4: split into legs at teleports, long gaps, and impossible speeds. */
function splitLegs(pts: RawPoint[], sportGroup: number, params: Params): RawPoint[][] {
  const cap = SPORT_CAPS[sportGroup] ?? 35;
  const legs: RawPoint[][] = [];
  let cur: RawPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      cur.push(pts[i]);
      continue;
    }
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const chord = Math.sqrt(dx * dx + dy * dy) * a.cosLat;
    const dt = b.t - a.t;
    const speed = dt > 0 ? chord / dt : Infinity;
    if (chord > params.GAP_SPLIT_M || dt > params.GAP_SPLIT_S || speed > cap) {
      // Split, never delete: deleting the far endpoint merely relocates the jump.
      if (cur.length) legs.push(cur);
      cur = [b];
    } else {
      cur.push(b);
    }
  }
  if (cur.length) legs.push(cur);
  return legs;
}

/**
 * Section 3.5: collapse stationary stretches. Anchor-based greedy scan -- monotone, linear in
 * practice, and it reads from `src` while writing to `out` so indices stay valid.
 */
function collapseStationary(src: RawPoint[], params: Params): RawPoint[] {
  // A leg that never leaves the radius at all is not a stationary stretch within an activity;
  // it is an activity that did not go anywhere -- a treadmill (already caught by the exclusion
  // backstop) or genuine movement on a very small loop. Collapsing it would erase everything,
  // so leave such a leg untouched and let the dead zone and the short-run rule bound it.
  if (src.length > 1) {
    let confined = true;
    for (let i = 1; i < src.length && confined; i++) {
      const dx = src[i].x - src[0].x;
      const dy = src[i].y - src[0].y;
      if (Math.sqrt(dx * dx + dy * dy) * src[0].cosLat > params.STATION_D) confined = false;
    }
    if (confined) return src;
  }

  const out: RawPoint[] = [];
  let i = 0;
  while (i < src.length) {
    let k = i;
    while (k + 1 < src.length) {
      const a = src[i];
      const b = src[k + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.sqrt(dx * dx + dy * dy) * a.cosLat > params.STATION_D) break;
      k++;
    }
    if (k > i && src[k].t - src[i].t >= params.STATION_S) {
      let sx = 0;
      let sy = 0;
      let sa = 0;
      let na = 0;
      for (let j = i; j <= k; j++) {
        sx += src[j].x;
        sy += src[j].y;
        if (src[j].alt !== null) {
          sa += src[j].alt as number;
          na++;
        }
      }
      const m = k - i + 1;
      out.push({
        x: sx / m,
        y: sy / m,
        t: Math.round((src[i].t + src[k].t) / 2),
        alt: na > 0 ? sa / na : null,
        cosLat: src[i].cosLat,
      });
      i = k + 1;
    } else {
      out.push(src[i]);
      i++;
    }
  }
  return out;
}

/** Section 3.6: resample a leg to fixed along-track spacing, interpolating in Mercator. */
function resampleLeg(leg: RawPoint[], startS: number, legIndex: number, params: Params): Sample[] {
  const S = params.RESAMPLE_M;
  const n = leg.length;
  if (n === 0) return [];

  // Cumulative ground distance along the leg.
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = leg[i - 1];
    const b = leg[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy) * a.cosLat;
  }
  const L = cum[n - 1];

  // Positions 0, S, 2S, ..., with the last landing exactly on the leg end.
  const positions: number[] = [];
  if (L <= 0) {
    positions.push(0);
  } else {
    for (let d = 0; d < L; d += S) positions.push(d);
    if (positions[positions.length - 1] !== L) positions.push(L);
  }

  const m = positions.length;
  const out: Sample[] = new Array(m);
  let seg = 0;
  for (let i = 0; i < m; i++) {
    const d = positions[i];
    while (seg < n - 2 && cum[seg + 1] < d) seg++;
    const a = leg[seg];
    const b = leg[Math.min(seg + 1, n - 1)];
    const span = cum[Math.min(seg + 1, n - 1)] - cum[seg];
    const f = span > 0 ? (d - cum[seg]) / span : 0;
    const alt = a.alt !== null && b.alt !== null ? a.alt + (b.alt - a.alt) * f : a.alt;
    out[i] = {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      cosLat: a.cosLat,
      ts: Math.round(a.t + (b.t - a.t) * f),
      s: startS + d,
      creditM: 0,
      bearing: 0,
      alt,
      leg: legIndex,
    };
  }

  // Credit midpoint to midpoint so a leg's credits sum exactly to its length.
  if (m === 1) {
    out[0].creditM = L;
  } else {
    for (let i = 0; i < m; i++) {
      const prev = i === 0 ? positions[0] : (positions[i - 1] + positions[i]) / 2;
      const next = i === m - 1 ? positions[m - 1] : (positions[i] + positions[i + 1]) / 2;
      out[i].creditM = next - prev;
    }
  }

  // Bearing over a +/-BEARING_BASELINE_SAMPLES window; widest available at the ends.
  const w = params.BEARING_BASELINE_SAMPLES;
  for (let i = 0; i < m; i++) {
    const lo = Math.max(0, i - w);
    const hi = Math.min(m - 1, i + w);
    if (lo === hi) {
      out[i].bearing = i > 0 ? out[i - 1].bearing : 0;
    } else {
      out[i].bearing = encodeBearing(bearingBetween(out[lo].x, out[lo].y, out[hi].x, out[hi].y));
    }
  }

  return out;
}

export function preprocess(a: LedgerInput, params: Params): Preprocessed | null {
  if (excluded(a) !== null) return null;

  const pts = toRawPoints(a);
  if (pts.length < 2) return null;

  const legs = splitLegs(pts, a.sportGroup, params);
  const samples: Sample[] = [];
  let s = 0;
  let legIndex = 0;
  for (const raw of legs) {
    const leg = collapseStationary(raw, params);
    if (leg.length < 2) continue;
    const rs = resampleLeg(leg, s, legIndex, params);
    if (rs.length === 0) continue;
    const legLen = rs[rs.length - 1].s - rs[0].s;
    s += legLen;
    for (const p of rs) samples.push(p);
    legIndex++;
  }

  if (samples.length === 0) return null;
  return { samples, totalM: s };
}

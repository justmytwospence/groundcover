/**
 * Reading the URL hash. Split out from the store so it stays pure: it is the one piece of the
 * URL layer worth testing directly, and importing the store would drag in zustand and browser
 * storage to do it.
 */

import type { State } from './store.js';

/**
 * The initial camera, if the link asked for one. Two shapes, in priority order:
 *
 * - `b=minLng,minLat,maxLng,maxLat` -- an exact extent. This is what "share this view" writes,
 *   because an extent survives being opened on a different screen and a centre with a zoom does
 *   not: a link framed on a laptop opens showing more or less ground on a phone.
 * - `map=lng,lat,zoom` -- legacy, still honoured so links shared before `b=` existed keep
 *   landing where they say they land. Never written any more.
 *
 * With neither, the map fits the shared time frame instead (App.tsx), which is the point: a
 * link carrying only a window frames exactly the ground that window covers.
 */
export type InitialView =
  | { kind: 'bounds'; bounds: [number, number, number, number] }
  | { kind: 'center'; center: [number, number]; zoom: number };

const nums = (v: string | null, count: number): number[] | null => {
  if (!v) return null;
  const parts = v.split(',').map(Number);
  return parts.length === count && parts.every(Number.isFinite) ? parts : null;
};

/**
 * A moment, as either unix seconds or an ISO date.
 *
 * Seconds are what the app writes, and they are exact. Dates are accepted because the point of
 * a shareable time frame is that a person can compose one too: `t0=2023-01-01` is a link you
 * can type, and `1672531200` is not. A bare date means midnight UTC, matching `startTs`, which
 * comes from Strava's UTC `start_date` (docs/data-pipeline.md section 3).
 */
function parseMoment(v: string | null): number | undefined {
  if (!v || v.trim() === '') return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

export interface HashState {
  view: Partial<State>;
  camera: InitialView | null;
}

/**
 * Pure, so it can be tested and so the initial read and a later `hashchange` cannot drift apart.
 * Everything is validated: a hash is editable text arriving from someone else's paste, and a
 * single NaN reaching `t0` blanks the map with no error anywhere.
 */
export function parseHash(hash: string): HashState {
  const h = new URLSearchParams(hash.replace(/^#/, ''));
  const out: Partial<State> = {};

  const t0 = parseMoment(h.get('t0'));
  const t1 = parseMoment(h.get('t1'));
  // Ordered rather than trusted: a window with its ends the wrong way round selects nothing,
  // which looks like lost data, and hand-composed links get them the wrong way round.
  if (t0 !== undefined) out.t0 = t1 !== undefined ? Math.min(t0, t1) : t0;
  if (t1 !== undefined) out.t1 = t0 !== undefined ? Math.max(t0, t1) : t1;

  const g = h.get('g');
  if (g) {
    const groups = [...new Set(g.split(',').map(Number))]
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 4)
      .sort((a, b) => a - b);
    // An empty group list renders an empty map, which reads as breakage rather than a filter.
    if (groups.length) out.groups = groups;
  }
  const m = h.get('m');
  if (m === 'heatmap' || m === 'exploration') out.mode = m;
  if (h.get('vp') === '1') out.viewportFilter = true;
  if (h.get('fit') === '1') out.fitToSelection = true;
  if (h.get('fitplay') === '1') out.fitWhilePlaying = true;
  if (h.get('noskip') === '1') out.skipEmptyDays = false;
  if (h.get('inview') === '1') out.skipOutsideBounds = true;
  const u = h.get('u');
  if (u === 'mi' || u === 'km') out.units = u;
  if (h.get('d') === '1') out.drawerOpen = true;

  let camera: InitialView | null = null;
  const b = nums(h.get('b'), 4);
  if (b) {
    // Corners ordered, so a box dragged right to left still frames something.
    const bounds: [number, number, number, number] = [
      Math.min(b[0], b[2]),
      Math.min(b[1], b[3]),
      Math.max(b[0], b[2]),
      Math.max(b[1], b[3]),
    ];
    camera = { kind: 'bounds', bounds };
  } else {
    const mp = nums(h.get('map'), 3);
    if (mp) camera = { kind: 'center', center: [mp[0], mp[1]], zoom: mp[2] };
  }

  return { view: out, camera };
}

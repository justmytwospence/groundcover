/**
 * Deterministic synthetic track generators. See docs/algorithm.md section 10.1.
 * No Math.random anywhere -- failures must reproduce exactly.
 */

import { EARTH_R, xToLng, yToLat, lngToX, latToY } from '../geo.js';
import { sportGroupOf } from '../params.js';
import type { LedgerInput } from '../types.js';

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(1e-12, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface CommonSynthOptions {
  startTs?: number;
  seed?: number;
  sigmaM?: number;
  stepM?: number;
  speedMps?: number;
  sportType?: string;
  trainer?: boolean;
  manual?: boolean;
  withAltitude?: boolean;
  heavyTailFrac?: number;
  heavyTailSigmaM?: number;
  /**
   * Correlation length of the cross-track noise, in metres. Real GPS error drifts over tens
   * of seconds rather than resampling independently every point; independent per-point noise
   * produces a sawtooth path that no real device ever records and that makes every test
   * measure the wrong thing. Default 25 m.
   */
  noiseCorrelationM?: number;
  id?: number;
  name?: string;
}

const BASE_LAT = 37.7749;
const BASE_LNG = -122.4194;
const BASE_X = lngToX(BASE_LNG);
const BASE_Y = latToY(BASE_LAT);
const COS_LAT = Math.cos((BASE_LAT * Math.PI) / 180);

/** Local metres (east, north) relative to the base point -> lat/lng. */
export function localToLatLng(east: number, north: number): [number, number] {
  const x = BASE_X + east / COS_LAT;
  const y = BASE_Y + north / COS_LAT;
  return [yToLat(y), xToLng(x)];
}

export interface LocalPoint {
  e: number;
  n: number;
  alt?: number;
}

let nextId = 1000;

/**
 * Build a LedgerInput from a path expressed in local metres, applying cross-track noise,
 * timing from speed, and the common option defaults.
 */
export function fromLocalPath(path: LocalPoint[], o: CommonSynthOptions = {}): LedgerInput {
  const seed = o.seed ?? 1;
  const sigma = o.sigmaM ?? 0;
  const speed = o.speedMps ?? 3;
  const startTs = o.startTs ?? 1700000000;
  const r = rng(seed);
  const htFrac = o.heavyTailFrac ?? 0;
  const htSigma = o.heavyTailSigmaM ?? sigma;

  // Correlated cross-track noise: an AR(1) walk whose correlation length is set in metres.
  const corr = o.noiseCorrelationM ?? 25;
  const latlng: Array<[number, number]> = [];
  const time: number[] = [];
  const altitude: number[] = [];
  let dist = 0;
  let noise = sigma > 0 ? gauss(r) * sigma : 0;
  let prevDist = 0;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (i > 0) {
      const de = p.e - path[i - 1].e;
      const dn = p.n - path[i - 1].n;
      dist += Math.sqrt(de * de + dn * dn);
    }
    const s = htFrac > 0 && r() < htFrac ? htSigma : sigma;
    if (s > 0) {
      const a = Math.exp(-(dist - prevDist) / corr);
      noise = a * noise + Math.sqrt(Math.max(0, 1 - a * a)) * gauss(r) * s;
    } else {
      noise = 0;
    }
    prevDist = dist;

    // Offset perpendicular to travel; direction taken from the local tangent.
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    let tx = next.e - prev.e;
    let ty = next.n - prev.n;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const e = p.e + -ty * noise;
    const n = p.n + tx * noise;
    latlng.push(localToLatLng(e, n));
    time.push(Math.round(dist / speed));
    altitude.push(p.alt ?? 10);
  }

  // Timestamps must strictly increase; nudge any duplicates forward.
  for (let i = 1; i < time.length; i++) if (time[i] <= time[i - 1]) time[i] = time[i - 1] + 1;

  const sportType = o.sportType ?? 'Run';
  return {
    id: o.id ?? nextId++,
    name: o.name ?? 'synthetic',
    startTs,
    startDateLocal: new Date(startTs * 1000).toISOString(),
    sportType,
    sportGroup: sportGroupOf(sportType),
    trainer: o.trainer ?? false,
    manual: o.manual ?? false,
    distanceM: dist,
    latlng,
    time,
    altitude: (o.withAltitude ?? true) ? altitude : undefined,
  };
}

function sampleLine(
  e0: number,
  n0: number,
  e1: number,
  n1: number,
  stepM: number,
  altFrom = 10,
  altTo = 10,
): LocalPoint[] {
  const len = Math.hypot(e1 - e0, n1 - n0);
  const k = Math.max(1, Math.round(len / stepM));
  const out: LocalPoint[] = [];
  for (let i = 0; i <= k; i++) {
    const f = i / k;
    out.push({ e: e0 + (e1 - e0) * f, n: n0 + (n1 - n0) * f, alt: altFrom + (altTo - altFrom) * f });
  }
  return out;
}

function sampleArc(
  cx: number,
  cy: number,
  radius: number,
  a0: number,
  a1: number,
  stepM: number,
  altFrom = 10,
  altTo = 10,
): LocalPoint[] {
  const arcLen = Math.abs(a1 - a0) * radius;
  const k = Math.max(2, Math.round(arcLen / stepM));
  const out: LocalPoint[] = [];
  for (let i = 0; i <= k; i++) {
    const f = i / k;
    const a = a0 + (a1 - a0) * f;
    out.push({
      e: cx + radius * Math.cos(a),
      n: cy + radius * Math.sin(a),
      alt: altFrom + (altTo - altFrom) * f,
    });
  }
  return out;
}

/** A straight road, optionally offset sideways so two calls make parallel roads. */
export function straightRoad(
  o: CommonSynthOptions & { lengthM: number; bearingDeg?: number; offsetM?: number },
): LedgerInput {
  const step = o.stepM ?? 4;
  const b = ((o.bearingDeg ?? 0) * Math.PI) / 180;
  const ux = Math.sin(b);
  const uy = Math.cos(b);
  const off = o.offsetM ?? 0;
  const ox = -uy * off;
  const oy = ux * off;
  return fromLocalPath(sampleLine(ox, oy, ox + ux * o.lengthM, oy + uy * o.lengthM, step), o);
}

/** The same road traversed out and back in one activity. */
export function outAndBack(
  o: CommonSynthOptions & { lengthM: number; bearingDeg?: number },
): LedgerInput {
  const step = o.stepM ?? 4;
  const b = ((o.bearingDeg ?? 0) * Math.PI) / 180;
  const ux = Math.sin(b);
  const uy = Math.cos(b);
  const out = sampleLine(0, 0, ux * o.lengthM, uy * o.lengthM, step);
  const back = sampleLine(ux * o.lengthM, uy * o.lengthM, 0, 0, step).slice(1);
  return fromLocalPath([...out, ...back], o);
}

/** `laps` circuits of an oval of the given perimeter and lane offset. */
export function trackLaps(
  o: CommonSynthOptions & { laps: number; perimeterM?: number; laneOffsetM?: number },
): LedgerInput {
  const step = o.stepM ?? 4;
  const perim = o.perimeterM ?? 400;
  const lane = o.laneOffsetM ?? 1.2;
  // Oval: two straights plus two semicircles, straight = perimeter/4 each.
  const straight = perim / 4;
  const radius = perim / 4 / Math.PI;
  const path: LocalPoint[] = [];
  for (let l = 0; l < o.laps; l++) {
    const dr = radius + (l % 2 === 0 ? 0 : lane);
    path.push(...sampleLine(0, -dr, straight, -dr, step));
    path.push(...sampleArc(straight, 0, dr, -Math.PI / 2, Math.PI / 2, step).slice(1));
    path.push(...sampleLine(straight, dr, 0, dr, step).slice(1));
    path.push(...sampleArc(0, 0, dr, Math.PI / 2, (3 * Math.PI) / 2, step).slice(1));
  }
  return fromLocalPath(path, o);
}

/** A stack of anti-parallel legs, each rising, connected by semicircular turns. */
export function switchbacks(
  o: CommonSynthOptions & { legs: number; legLengthM: number; spacingM: number; riseM: number },
): LedgerInput {
  const step = o.stepM ?? 4;
  const { legs, legLengthM: L, spacingM: S, riseM: R } = o;
  const path: LocalPoint[] = [];
  let alt = 10;
  for (let i = 0; i < legs; i++) {
    const n = i * S;
    const goingEast = i % 2 === 0;
    const e0 = goingEast ? 0 : L;
    const e1 = goingEast ? L : 0;
    const seg = sampleLine(e0, n, e1, n, step, alt, alt + R);
    path.push(...(i === 0 ? seg : seg.slice(1)));
    alt += R;
    if (i < legs - 1) {
      // Semicircular turn at the far end, connecting to the next leg.
      const cx = e1;
      const cy = n + S / 2;
      const a0 = goingEast ? -Math.PI / 2 : Math.PI / 2;
      const a1 = goingEast ? Math.PI / 2 : (3 * Math.PI) / 2;
      const turn = sampleArc(cx, cy, S / 2, a0, a1, step, alt, alt);
      path.push(...turn.slice(1));
    }
  }
  return fromLocalPath(path, o);
}

/** A straight in, a 180-degree turn of the given radius, and a straight out. */
export function hairpin(o: CommonSynthOptions & { straightM: number; radiusM: number }): LedgerInput {
  const step = o.stepM ?? 4;
  const r = o.radiusM;
  const path: LocalPoint[] = [];
  path.push(...sampleLine(-o.straightM, 0, 0, 0, step));
  path.push(...sampleArc(0, r, r, -Math.PI / 2, Math.PI / 2, step).slice(1));
  path.push(...sampleLine(0, 2 * r, -o.straightM, 2 * r, step).slice(1));
  return fromLocalPath(path, o);
}

/** `laps` circuits of a closed circle of the given perimeter. */
export function closedLoop(o: CommonSynthOptions & { perimeterM: number; laps?: number }): LedgerInput {
  const step = o.stepM ?? 4;
  const laps = o.laps ?? 1;
  const radius = o.perimeterM / (2 * Math.PI);
  const path = sampleArc(0, 0, radius, 0, 2 * Math.PI * laps, step);
  return fromLocalPath(path, o);
}

/** Two straight roads crossing at right angles, returned as two activities. */
export function crossroads(o: CommonSynthOptions & { lengthM: number }): LedgerInput[] {
  const h = o.lengthM / 2;
  const step = o.stepM ?? 4;
  const a = fromLocalPath(sampleLine(-h, 0, h, 0, step), { ...o, id: (o.id ?? 2000) });
  const b = fromLocalPath(sampleLine(0, -h, 0, h, step), {
    ...o,
    id: (o.id ?? 2000) + 1,
    startTs: (o.startTs ?? 1700000000) + 86400,
  });
  return [a, b];
}

/** A trace that never leaves a small radius while reporting a large distance. */
export function treadmillShaped(
  o: CommonSynthOptions & { radiusM?: number; reportedDistanceM?: number; durationS?: number },
): LedgerInput {
  const r = rng(o.seed ?? 7);
  const radius = o.radiusM ?? 8;
  const dur = o.durationS ?? 1800;
  const path: LocalPoint[] = [];
  for (let t = 0; t < dur; t += 5) {
    path.push({ e: (r() - 0.5) * 2 * radius, n: (r() - 0.5) * 2 * radius });
  }
  const a = fromLocalPath(path, { ...o, sigmaM: 0, speedMps: 3 });
  a.distanceM = o.reportedDistanceM ?? 8000;
  a.time = path.map((_, i) => i * 5);
  return a;
}

/** Insert a position jump after a given distance of travel. */
export function withTeleport(
  base: LedgerInput,
  o: { afterM: number; jumpM: number; dtS: number },
): LedgerInput {
  const step = 4;
  const idx = Math.min(base.latlng.length - 1, Math.max(1, Math.round(o.afterM / step)));
  const [lat, lng] = base.latlng[idx];
  const x = lngToX(lng) + o.jumpM / COS_LAT;
  const jLat = lat;
  const jLng = xToLng(x);
  const latlng = [...base.latlng];
  const time = [...base.time];
  const altitude = base.altitude ? [...base.altitude] : undefined;
  for (let i = idx; i < latlng.length; i++) {
    latlng[i] = [jLat + (latlng[i][0] - lat), jLng + (latlng[i][1] - lng)];
    time[i] = time[i] + o.dtS;
  }
  return { ...base, latlng, time, altitude };
}

/** Append stationary jitter with the given scatter radius. */
export function withStationaryBlob(
  base: LedgerInput,
  o: { durationS: number; radiusM: number; seed?: number },
): LedgerInput {
  const r = rng(o.seed ?? 11);
  const last = base.latlng[base.latlng.length - 1];
  const lastT = base.time[base.time.length - 1];
  const bx = lngToX(last[1]);
  const by = latToY(last[0]);
  const latlng = [...base.latlng];
  const time = [...base.time];
  const altitude = base.altitude ? [...base.altitude] : undefined;
  for (let t = 1; t <= o.durationS; t++) {
    const ang = r() * 2 * Math.PI;
    const rad = Math.sqrt(r()) * o.radiusM;
    latlng.push([yToLat(by + (rad * Math.sin(ang)) / COS_LAT), xToLng(bx + (rad * Math.cos(ang)) / COS_LAT)]);
    time.push(lastT + t);
    if (altitude) altitude.push(altitude[altitude.length - 1]);
  }
  return { ...base, latlng, time, altitude };
}

/**
 * Shift an entire activity sideways (east). The generators lay roads out running north, so
 * an eastward shift is genuinely perpendicular to travel -- shifting north would slide the
 * road along its own axis and test nothing.
 */
export function withOffset(base: LedgerInput, offsetM: number): LedgerInput {
  const latlng = base.latlng.map(([lat, lng]): [number, number] => {
    const x = lngToX(lng) + offsetM / COS_LAT;
    return [lat, xToLng(x)];
  });
  return { ...base, latlng };
}

/**
 * Shift a CONTIGUOUS SEGMENT of an activity sideways, ramping in and out. This is the urban
 * canyon signature the offset detector targets: the trace departs from ground it knows and
 * rejoins it. A rigid whole-trace shift (withOffset) is deliberately NOT this -- it is
 * geometrically indistinguishable from a genuinely new parallel road, and the detector is not
 * supposed to catch it.
 */
export function withOffsetSegment(
  base: LedgerInput,
  o: { fromFrac: number; toFrac: number; offsetM: number; rampFrac?: number },
): LedgerInput {
  const n = base.latlng.length;
  const a = Math.round(o.fromFrac * n);
  const b = Math.round(o.toFrac * n);
  const ramp = Math.max(1, Math.round((o.rampFrac ?? 0.04) * n));
  const latlng = base.latlng.map(([lat, lng], i): [number, number] => {
    let f = 0;
    if (i > a && i < b) {
      f = Math.min(1, Math.min(i - a, b - i) / ramp);
    }
    if (f === 0) return [lat, lng];
    const x = lngToX(lng) + (o.offsetM * f) / COS_LAT;
    return [lat, xToLng(x)];
  });
  return { ...base, latlng };
}

export { EARTH_R };

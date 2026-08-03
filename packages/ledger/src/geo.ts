/**
 * Geometry primitives. See docs/algorithm.md section 2.
 *
 * All internal geometry is Web Mercator (EPSG:3857) metres. Mercator distances are inflated
 * by 1/cos(latitude), so true ground distance is the Mercator distance times cos(lat).
 */

export const EARTH_R = 6378137;
const DEG = Math.PI / 180;

export function lngToX(lng: number): number {
  return lng * DEG * EARTH_R;
}

export function latToY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)) * EARTH_R;
}

export function xToLng(x: number): number {
  return x / EARTH_R / DEG;
}

export function yToLat(y: number): number {
  return (2 * Math.atan(Math.exp(y / EARTH_R)) - Math.PI / 2) / DEG;
}

/**
 * True ground distance in metres between two Mercator points. Valid only for nearby points
 * (under ~1 km), which is all the algorithm ever compares.
 */
export function groundDist(x1: number, y1: number, x2: number, y2: number, cosLat: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy) * cosLat;
}

/** Squared Mercator distance -- the cheap prefilter before applying cosLat and a sqrt. */
export function mercDist2(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

/**
 * Encode a compass bearing (degrees, mod 360) into a Uint8 in units of 2 degrees, 0..179.
 */
export function encodeBearing(deg360: number): number {
  const d = ((deg360 % 360) + 360) % 360;
  return Math.round(d / 2) % 180;
}

/** Difference of two encoded bearings modulo 360, in degrees, range [0, 180]. */
export function angDiff360(a: number, b: number): number {
  const d = Math.abs(a - b) * 2;
  return d > 180 ? 360 - d : d;
}

/** Difference of two encoded bearings modulo 180, in degrees, range [0, 90]. */
export function angDiff180(a: number, b: number): number {
  const d = angDiff360(a, b);
  return d > 90 ? 180 - d : d;
}

/**
 * Compass bearing in degrees from Mercator point 1 to point 2. Mercator is conformal, so the
 * angle of the Mercator chord equals the true bearing for nearby points.
 */
export function bearingBetween(x1: number, y1: number, x2: number, y2: number): number {
  return (Math.atan2(x2 - x1, y2 - y1) / DEG + 360) % 360;
}

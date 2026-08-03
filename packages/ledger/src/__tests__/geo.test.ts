import { describe, expect, it } from 'vitest';
import { angDiff180, angDiff360, encodeBearing, groundDist, latToY, lngToX, xToLng, yToLat } from '../geo.js';

describe('mercator round trip', () => {
  it('recovers lng/lat', () => {
    for (const lng of [-179, -122.4194, 0, 12.5, 179]) {
      expect(xToLng(lngToX(lng))).toBeCloseTo(lng, 9);
    }
    for (const lat of [-70, -37.8, 0, 37.7749, 70]) {
      expect(yToLat(latToY(lat))).toBeCloseTo(lat, 9);
    }
  });

  it('groundDist matches a known separation', () => {
    // 0.001 degrees of latitude is about 111.19 m.
    const y0 = latToY(37.7749);
    const y1 = latToY(37.7759);
    const cosLat = Math.cos((37.7754 * Math.PI) / 180);
    const d = groundDist(0, y0, 0, y1, cosLat);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });
});

describe('bearing encoding', () => {
  it('encodes into 0..179 at 2-degree resolution', () => {
    expect(encodeBearing(0)).toBe(0);
    expect(encodeBearing(2)).toBe(1);
    expect(encodeBearing(90)).toBe(45);
    // 2-degree resolution: odd degrees are not representable, so use even test values.
    expect(encodeBearing(358)).toBe(179);
    expect(encodeBearing(359)).toBe(0); // rounds to 180, wraps to 0
    expect(encodeBearing(360)).toBe(0);
    expect(encodeBearing(-2)).toBe(179);
    for (let d = 0; d < 360; d++) {
      const e = encodeBearing(d);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThan(180);
    }
  });

  it('angDiff360 is correct at boundaries and across the wrap', () => {
    expect(angDiff360(encodeBearing(0), encodeBearing(0))).toBe(0);
    expect(angDiff360(encodeBearing(0), encodeBearing(44))).toBe(44);
    expect(angDiff360(encodeBearing(0), encodeBearing(90))).toBe(90);
    expect(angDiff360(encodeBearing(0), encodeBearing(180))).toBe(180);
    expect(angDiff360(encodeBearing(0), encodeBearing(270))).toBe(90);
    expect(angDiff360(encodeBearing(350), encodeBearing(10))).toBe(20);
    expect(angDiff360(encodeBearing(10), encodeBearing(350))).toBe(20);
  });

  it('angDiff180 folds opposite travel to zero', () => {
    expect(angDiff180(encodeBearing(0), encodeBearing(180))).toBe(0);
    expect(angDiff180(encodeBearing(0), encodeBearing(90))).toBe(90);
    expect(angDiff180(encodeBearing(0), encodeBearing(136))).toBe(44);
    expect(angDiff180(encodeBearing(0), encodeBearing(44))).toBe(44);
    expect(angDiff180(encodeBearing(0), encodeBearing(178))).toBe(2);
    // 179 rounds to 180, which is congruent to 0 -- exact opposite travel, same road.
    expect(angDiff180(encodeBearing(0), encodeBearing(179))).toBe(0);
    expect(angDiff180(encodeBearing(30), encodeBearing(210))).toBe(0);
  });

  it('a 216-degree bend is bearing-compatible but a 72-degree one is not', () => {
    // This is the 40 m closed-loop geometry: the pair that the fold-back condition governs.
    expect(angDiff180(encodeBearing(0), encodeBearing(216))).toBeLessThanOrEqual(45);
    expect(angDiff360(encodeBearing(0), encodeBearing(216))).toBeGreaterThan(120);
    expect(angDiff180(encodeBearing(0), encodeBearing(72))).toBeGreaterThan(45);
  });
});

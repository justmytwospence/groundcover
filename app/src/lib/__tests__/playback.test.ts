/**
 * The two clocks of the time-lapse.
 *
 * The timeline crosses years in seconds. An activity occupies an hour or two of that timeline,
 * which at any watchable overall pace is a single frame -- which is why routes used to snap into
 * existence, and why slowing the timeline could never fix it. These tests pin the property that
 * separates the two: a route's draw takes the same wall-clock time no matter how long the
 * activity lasted or how fast the timeline is moving.
 */

import { describe, expect, it } from 'vitest';
import {
  isRevealed,
  routeDrawSpanSeconds,
  traversedSpanSeconds,
  medianGapSeconds,
  MAX_EMPTY_GAP_S,
  PLAYBACK_SECONDS,
  ROUTE_DRAW_MIN_S,
  ROUTE_DRAW_MAX_S,
} from '../playback.js';

const HOUR = 3600;
const DAY = 86400;

describe('medianGapSeconds', () => {
  it('is zero when there is nothing to measure between', () => {
    expect(medianGapSeconds([])).toBe(0);
    expect(medianGapSeconds([1])).toBe(0);
  });

  it('ignores one enormous gap, which is why it is the median and not the mean', () => {
    const t = 1_700_000_000;
    const starts = [t, t + DAY, t + 2 * DAY, t + 3 * DAY, t + 900 * DAY];
    expect(medianGapSeconds(starts)).toBe(DAY);
  });
});

describe('routeDrawSpanSeconds', () => {
  // 557 days swept in PLAYBACK_SECONDS is roughly this history with empty stretches compressed.
  const swept = 557 * DAY;
  const medianGap = DAY;

  it('sizes the draw to the median gap, which is what stops routes overlapping', () => {
    expect(routeDrawSpanSeconds(swept, 1, medianGap)).toBe(medianGap);
  });

  it('never lets a route draw quicker than the floor, however dense the history', () => {
    const perWall = swept / PLAYBACK_SECONDS;
    expect(routeDrawSpanSeconds(swept, 1, 60)).toBeCloseTo(ROUTE_DRAW_MIN_S * perWall, 3);
  });

  it('never lets a route crawl, however sparse the history', () => {
    const perWall = swept / PLAYBACK_SECONDS;
    expect(routeDrawSpanSeconds(swept, 1, 900 * DAY)).toBeCloseTo(ROUTE_DRAW_MAX_S * perWall, 3);
  });

  it('keeps the wall-clock draw steady when the speed changes', () => {
    // At 4x the sweep covers four times as much timeline per second, so the same wall-clock
    // draw must span four times as much timeline. Only reachable via the bounds.
    const fast = routeDrawSpanSeconds(swept, 4, 60);
    const slow = routeDrawSpanSeconds(swept, 1, 60);
    expect(fast).toBeCloseTo(slow * 4, 3);
  });

  it('falls back to the floor when there is no gap to measure', () => {
    const perWall = swept / PLAYBACK_SECONDS;
    expect(routeDrawSpanSeconds(swept, 1, 0)).toBeCloseTo(ROUTE_DRAW_MIN_S * perWall, 3);
  });
});

describe('isRevealed', () => {
  const start = 1_700_000_000;

  it('falls back to the plain timestamp gate when stretching is off', () => {
    expect(isRevealed(start + 10, start, start + HOUR, start + 5, 0)).toBe(false);
    expect(isRevealed(start + 10, start, start + HOUR, start + 20, 0)).toBe(true);
  });

  it('shows everything when there is no playhead, which is the static case', () => {
    expect(isRevealed(start + HOUR, start, start + HOUR, Infinity, 0)).toBe(true);
    expect(isRevealed(start + HOUR, start, start + HOUR, Infinity, DAY)).toBe(true);
  });

  it('reveals a route from its first point to its last, in order', () => {
    const span = 10 * DAY;
    const at = (frac: number) => start + frac * HOUR;
    // A quarter of the way through the stretched draw, only the first quarter is on screen.
    const playhead = start + 0.25 * span;
    expect(isRevealed(at(0.2), start, start + HOUR, playhead, span)).toBe(true);
    expect(isRevealed(at(0.3), start, start + HOUR, playhead, span)).toBe(false);
    expect(isRevealed(at(0.9), start, start + HOUR, playhead, span)).toBe(false);
  });

  it('is the whole point: a short jog and a long ride draw at the same rate', () => {
    const span = 10 * DAY;
    const playhead = start + 0.5 * span;
    // Both activities are half revealed at the same instant, despite one lasting 18x longer.
    const jogEnd = start + 20 * 60;
    const rideEnd = start + 6 * HOUR;
    expect(isRevealed(start + 0.5 * (20 * 60), start, jogEnd, playhead, span)).toBe(true);
    expect(isRevealed(start + 0.6 * (20 * 60), start, jogEnd, playhead, span)).toBe(false);
    expect(isRevealed(start + 0.5 * (6 * HOUR), start, rideEnd, playhead, span)).toBe(true);
    expect(isRevealed(start + 0.6 * (6 * HOUR), start, rideEnd, playhead, span)).toBe(false);
  });

  it('finishes a route once the playhead is a full draw-span past its start', () => {
    const span = 10 * DAY;
    expect(isRevealed(start + HOUR, start, start + HOUR, start + span, span)).toBe(true);
  });

  it('handles an activity that minted a single site, where the span is zero', () => {
    // dur === 0 must not divide by zero; the one point belongs at the start of the draw.
    expect(isRevealed(start, start, start, start - 1, DAY)).toBe(false);
    expect(isRevealed(start, start, start, start, DAY)).toBe(true);
  });

  it('never reveals ground before its activity began', () => {
    const span = 10 * DAY;
    expect(isRevealed(start, start, start + HOUR, start - 1, span)).toBe(false);
  });
});

describe('traversedSpanSeconds', () => {
  const t = 1_700_000_000;

  it('is the plain span when skipping is off', () => {
    expect(traversedSpanSeconds(t, t + 100 * DAY, [t + DAY], false)).toBe(100 * DAY);
  });

  it('compresses an empty stretch rather than deleting it', () => {
    // One activity a year in: without skipping that is 365 days of nothing to sweep through.
    // The activity sits exactly at the end, so there is one gap to compress and no tail.
    const span = traversedSpanSeconds(t, t + 365 * DAY, [t + 365 * DAY], true);
    expect(span).toBe(MAX_EMPTY_GAP_S);
    expect(span).toBeLessThan(365 * DAY);
    expect(span).toBeGreaterThan(0);
  });

  it('leaves a densely active stretch essentially untouched', () => {
    // Activities every six hours, which is under the cap, so nothing is compressed.
    const starts = Array.from({ length: 20 }, (_, i) => t + i * 6 * 3600);
    const dense = traversedSpanSeconds(t, t + 20 * 6 * 3600, starts, true);
    expect(dense).toBe(20 * 6 * 3600);
  });

  it('never returns zero, so the pacing division is always safe', () => {
    expect(traversedSpanSeconds(t, t, [], true)).toBeGreaterThan(0);
    expect(traversedSpanSeconds(t, t, [], false)).toBeGreaterThan(0);
  });
});

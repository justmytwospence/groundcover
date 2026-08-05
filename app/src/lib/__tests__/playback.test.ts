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
import { isRevealed, routeDrawSpanSeconds, PLAYBACK_SECONDS, ROUTE_DRAW_SECONDS } from '../playback.js';

const HOUR = 3600;
const DAY = 86400;
const SIX_YEARS = 2190 * DAY;

describe('routeDrawSpanSeconds', () => {
  it('converts a wall-clock draw into however much timeline that currently is', () => {
    const perWallSecond = SIX_YEARS / PLAYBACK_SECONDS;
    expect(routeDrawSpanSeconds(SIX_YEARS, 1)).toBeCloseTo(ROUTE_DRAW_SECONDS * perWallSecond, 3);
  });

  it('scales with the transport speed, so a route draws in the same wall time at 4x', () => {
    expect(routeDrawSpanSeconds(SIX_YEARS, 4)).toBeCloseTo(routeDrawSpanSeconds(SIX_YEARS, 1) * 4, 3);
  });

  it('shrinks with the timeline span, so a one-year selection draws no faster', () => {
    const year = 365 * DAY;
    const ratio = routeDrawSpanSeconds(SIX_YEARS, 1) / routeDrawSpanSeconds(year, 1);
    expect(ratio).toBeCloseTo(SIX_YEARS / year, 6);
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

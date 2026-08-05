/**
 * The two clocks of the time-lapse.
 *
 * The calendar crosses years in minutes; an activity occupies an hour or two of it, which at any
 * watchable overall pace is a single frame. So the transport does not pace itself to the
 * calendar at all -- it walks the activities one at a time, crawling across each one's own span
 * and skipping what lies between. These pin the arithmetic that decides how long that takes.
 */

import { describe, expect, it } from 'vitest';
import {
  cueAt,
  stepReplay,
  routeDrawSeconds,
  traversedSpanSeconds,
  MAX_EMPTY_GAP_S,
  PLAYBACK_SECONDS,
  ROUTE_DRAW_MIN_S,
  ROUTE_DRAW_MAX_S,
  type Route,
} from '../playback.js';

const DAY = 86400;

describe('routeDrawSeconds', () => {
  it('spreads the budget evenly when that lands between the bounds', () => {
    const n = 300; // 180/300 = 0.6s, comfortably inside
    expect(routeDrawSeconds(n)).toBeCloseTo(PLAYBACK_SECONDS / n, 6);
  });

  it('never draws quicker than the floor, which is what "notice it growing" costs', () => {
    // A whole history: an even split would be a seventh of a second, i.e. a blink.
    expect(PLAYBACK_SECONDS / 1303).toBeLessThan(ROUTE_DRAW_MIN_S);
    expect(routeDrawSeconds(1303)).toBe(ROUTE_DRAW_MIN_S);
  });

  it('never crawls, however short the selection', () => {
    expect(routeDrawSeconds(1)).toBe(ROUTE_DRAW_MAX_S);
    expect(routeDrawSeconds(0)).toBe(ROUTE_DRAW_MAX_S);
  });

  it('is monotone: more routes never means a slower draw', () => {
    let prev = Infinity;
    for (const n of [1, 10, 100, 300, 1000, 5000]) {
      const d = routeDrawSeconds(n);
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
  });

  it('costs what it costs -- the run is routes times the draw', () => {
    // Stated so the trade is visible rather than discovered: one at a time and legible means a
    // long history takes minutes, and the speed chips are how that is shortened.
    expect(1303 * routeDrawSeconds(1303)).toBeCloseTo(1303 * 0.35, 5);
    expect(200 * routeDrawSeconds(200)).toBeCloseTo(PLAYBACK_SECONDS, 5);
  });
});

describe('traversedSpanSeconds', () => {
  const t = 1_700_000_000;

  it('is the plain span when skipping is off', () => {
    expect(traversedSpanSeconds(t, t + 100 * DAY, [t + DAY], false)).toBe(100 * DAY);
  });

  it('compresses an empty stretch rather than deleting it', () => {
    // The activity sits exactly at the end, so there is one gap to compress and no tail.
    expect(traversedSpanSeconds(t, t + 365 * DAY, [t + 365 * DAY], true)).toBe(MAX_EMPTY_GAP_S);
  });

  it('leaves a densely active stretch untouched', () => {
    const starts = Array.from({ length: 20 }, (_, i) => t + i * 6 * 3600);
    expect(traversedSpanSeconds(t, t + 20 * 6 * 3600, starts, true)).toBe(20 * 6 * 3600);
  });

  it('never returns zero, so the pacing division is always safe', () => {
    expect(traversedSpanSeconds(t, t, [], true)).toBeGreaterThan(0);
    expect(traversedSpanSeconds(t, t, [], false)).toBeGreaterThan(0);
  });
});

describe('cueAt', () => {
  const t = 1_700_000_000;
  const reel = [
    { from: t, to: t + 3600 },
    { from: t + 5 * DAY, to: t + 5 * DAY + 1800 },
    { from: t + 9 * DAY, to: t + 9 * DAY + 7200 },
  ];

  it('starts at the first route when there is no playhead yet', () => {
    expect(cueAt(reel, null)).toEqual({ i: 0, t: 0 });
    expect(cueAt([], t)).toEqual({ i: 0, t: 0 });
  });

  it('finds the route the playhead is inside, and how far through', () => {
    expect(cueAt(reel, t + 1800)).toEqual({ i: 0, t: 0.5 });
    expect(cueAt(reel, t + 9 * DAY + 3600)).toEqual({ i: 2, t: 0.5 });
  });

  it('lands on the next route when the playhead is in the gap before it', () => {
    const c = cueAt(reel, t + 2 * DAY);
    expect(c.i).toBe(1);
    expect(c.t).toBe(0);
  });

  it('survives the reel growing at the front, which is how a sync delivers history', () => {
    // A newest-first sync prepends older activities; every index shifts by two.
    const older = [
      { from: t - 40 * DAY, to: t - 40 * DAY + 900 },
      { from: t - 20 * DAY, to: t - 20 * DAY + 900 },
    ];
    const grown = [...older, ...reel];
    const playhead = t + 5 * DAY + 900;
    const before = cueAt(reel, playhead);
    const after = cueAt(grown, playhead);
    // Different index, same route and same position within it -- which is the whole point.
    expect(after.i).toBe(before.i + older.length);
    expect(grown[after.i]).toEqual(reel[before.i]);
    expect(after.t).toBeCloseTo(before.t, 9);
  });

  it('never reports a fraction that would skip a route entirely', () => {
    expect(cueAt(reel, t + 1e9).t).toBeLessThan(1);
    expect(cueAt(reel, t - 1e9).t).toBe(0);
  });

  it('handles a route that minted a single instant', () => {
    expect(cueAt([{ from: t, to: t }], t)).toEqual({ i: 0, t: 0 });
  });
});

describe('stepReplay', () => {
  const t = 1_700_000_000;
  /** Three routes with real gaps, of very different durations. */
  const reel: Route[] = [
    { from: t, to: t + 3600 },
    { from: t + 5 * DAY, to: t + 5 * DAY + 600 },
    { from: t + 9 * DAY, to: t + 9 * DAY + 6 * 3600 },
  ];

  /** Walk the whole reel at a fixed frame rate, collecting every playhead it emits. */
  function run(order: Route[], reverse: boolean, gapS = 0, fps = 60) {
    let cue = { i: 0, t: 0 };
    const heads: number[] = [];
    const visited: number[] = [];
    for (let f = 0; f < 20000; f++) {
      const s = stepReplay(order, cue, 1 / fps, 0.35, gapS, reverse);
      heads.push(s.playhead);
      if (s.cue.i !== cue.i) visited.push(s.cue.i);
      cue = s.cue;
      if (s.done) break;
    }
    return { heads, visited };
  }

  it('emits a monotonically increasing playhead, start to finish', () => {
    const { heads } = run(reel, false);
    for (let i = 1; i < heads.length; i++) {
      expect(heads[i]).toBeGreaterThanOrEqual(heads[i - 1]);
    }
    expect(heads[0]).toBeGreaterThanOrEqual(reel[0].from);
    expect(heads[heads.length - 1]).toBe(reel[2].to);
  });

  it('visits every route exactly once, in order', () => {
    const { visited } = run(reel, false);
    expect(visited).toEqual([1, 2]);
  });

  it('emits a monotonically DEcreasing playhead when run backwards', () => {
    const { heads } = run([...reel].reverse(), true);
    for (let i = 1; i < heads.length; i++) {
      expect(heads[i]).toBeLessThanOrEqual(heads[i - 1]);
    }
    expect(heads[heads.length - 1]).toBe(reel[0].from);
  });

  it('spends the same wall time on a ten-minute route as on a six-hour one', () => {
    // The reason routes are legible at all: pace is per route, not per minute travelled.
    const frames = (r: Route) => {
      let cue = { i: 0, t: 0 };
      let n = 0;
      while (!stepReplay([r], cue, 1 / 60, 0.35, 0, false).done && n < 10000) {
        cue = stepReplay([r], cue, 1 / 60, 0.35, 0, false).cue;
        n++;
      }
      return n;
    };
    expect(frames(reel[1])).toBe(frames(reel[2]));
  });

  it('keeps the playhead consistent with the cue across a seam', () => {
    // A re-derived cue must agree with the playhead, or the replay jumps when the reel changes.
    let cue = { i: 0, t: 0 };
    for (let f = 0; f < 200; f++) {
      const s = stepReplay(reel, cue, 1 / 60, 0.35, 0, false);
      const derived = cueAt(reel, s.playhead);
      if (!s.done) expect(derived.i).toBe(s.cue.i);
      cue = s.cue;
      if (s.done) break;
    }
  });

  it('crosses a gap without skipping the route on its far side', () => {
    const { visited } = run(reel, false, 0.5);
    expect(visited).toEqual([1, 2]);
  });
});

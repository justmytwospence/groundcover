/**
 * How fast the time-lapse runs, and how fast a single route draws itself.
 *
 * These are two different clocks and conflating them is why routes used to snap into existence.
 * The timeline crosses years in seconds; an activity occupies an hour or two of that timeline,
 * which at any watchable overall pace is a single frame. Slowing the timeline cannot fix it,
 * because the route's draw is measured in the same units and slows with it.
 *
 * So the draw gets its own duration, expressed in wall-clock seconds and converted to whatever
 * span of timeline that currently corresponds to.
 */

/** Wall-clock seconds for a full history to play at 1x. */
export const PLAYBACK_SECONDS = 180;

/**
 * Bounds on how long one route takes to draw, in wall-clock seconds.
 *
 * The floor is what "slow enough to notice it growing" costs: below roughly a third of a second
 * a stroke reads as an appearance rather than a movement. The ceiling stops a short selection
 * from crawling.
 */
export const ROUTE_DRAW_MIN_S = 0.35;
export const ROUTE_DRAW_MAX_S = 1.2;

/**
 * The longest empty stretch the sweep will actually traverse, when skipping is on.
 *
 * Gaps are compressed to this rather than removed outright: jumping straight from one activity
 * to the next erases any sense of time passing, and a history with a three-month injury in it
 * should still feel like it had one.
 */
export const MAX_EMPTY_GAP_S = 12 * 3600;

/**
 * The span of timeline, in seconds, that one route's draw should be stretched across.
 *
 * An activity is revealed over this much simulated time regardless of how long it actually
 * took, so a twenty-minute jog and a six-hour ride draw at the same visible rate. Routes
 * therefore trail slightly behind the playhead and several draw at once, which is the intended
 * effect rather than a side effect: a history arriving in overlapping strokes reads as alive,
 * where a strict one-at-a-time queue would read as a progress bar.
 *
 * @param timelineSpanS the span the current playback run covers
 * @param speed the transport's speed multiplier
 */
/**
 * How much timeline the sweep will actually cross between `from` and `to`.
 *
 * With skipping off this is simply the span. With it on, every empty stretch counts for at most
 * MAX_EMPTY_GAP_S -- which is what lets the run keep its wall-clock budget while spending it on
 * the parts where something happens.
 *
 * @param starts activity start times inside the range, ascending
 */
/**
 * Wall-clock seconds one route should take, given how many are in the run.
 *
 * Exactly one draws at a time, so the run costs (routes x this). Those two wishes fight: 1,300
 * activities at a leisurely second each is twenty minutes, while holding the run to three
 * minutes forces a seventh of a second per route, which is the snapping this exists to fix. So
 * it is derived from the count and clamped -- a short selection gets an unhurried draw, a whole
 * history a brisk but still legible one.
 */
export function routeDrawSeconds(routeCount: number): number {
  if (routeCount <= 0) return ROUTE_DRAW_MAX_S;
  const even = PLAYBACK_SECONDS / routeCount;
  return Math.min(ROUTE_DRAW_MAX_S, Math.max(ROUTE_DRAW_MIN_S, even));
}

export function traversedSpanSeconds(
  from: number,
  to: number,
  starts: readonly number[],
  skipEmpty: boolean,
): number {
  if (!skipEmpty) return Math.max(1, to - from);
  let total = 0;
  let cursor = from;
  for (const s of starts) {
    if (s <= cursor) continue;
    if (s > to) break;
    total += Math.min(s - cursor, MAX_EMPTY_GAP_S);
    cursor = s;
  }
  total += Math.min(Math.max(0, to - cursor), MAX_EMPTY_GAP_S);
  return Math.max(1, total);
}



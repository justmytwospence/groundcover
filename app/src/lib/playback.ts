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
 * Bounds on how long one route may take to draw, in wall-clock seconds.
 *
 * The draw is normally sized to the median gap between activities, which makes "one route at a
 * time" the definition rather than something to hope for: if a route finishes in the time it
 * takes the sweep to reach the next one, they cannot overlap. These only bite when that lands
 * somewhere silly -- a history so dense the draw would be a blink, or so sparse it would crawl.
 */
export const ROUTE_DRAW_MIN_S = 0.3;
export const ROUTE_DRAW_MAX_S = 1.5;

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

/**
 * How much timeline one route's draw is stretched across.
 *
 * Sized to `medianGapS` so a route finishes about as the sweep reaches the next one. Where the
 * budget cannot afford that -- skipping switched off leaves most of the run crossing empty
 * ground, so the sweep is fast and routes must overlap to stay visible at all -- the wall-clock
 * bounds take over and some overlap returns. That is the honest trade, not a bug.
 *
 * @param timelineSpanS what the run will actually cross
 * @param speed the transport's speed multiplier
 * @param medianGapS typical timeline distance between consecutive activities
 */
export function routeDrawSpanSeconds(
  timelineSpanS: number,
  speed: number,
  medianGapS: number,
): number {
  const perWallSecond = (timelineSpanS / PLAYBACK_SECONDS) * Math.max(0.01, speed);
  const lo = ROUTE_DRAW_MIN_S * perWallSecond;
  const hi = ROUTE_DRAW_MAX_S * perWallSecond;
  if (!(medianGapS > 0)) return lo;
  return Math.min(hi, Math.max(lo, medianGapS));
}

/** Median distance between consecutive starts, which is what the draw is sized against. */
export function medianGapSeconds(starts: readonly number[]): number {
  if (starts.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) gaps.push(starts[i] - starts[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

/**
 * Whether ground first covered at `mintTs` is visible yet.
 *
 * Extracted from the render loop so the arithmetic can be tested directly: it decides what a
 * viewer sees frame by frame, and it is the kind of thing that looks obviously right and is
 * quietly off by a factor.
 *
 * @param mintTs   when this ground was first covered
 * @param actStart first moment its activity minted anything
 * @param actEnd   last moment its activity minted anything
 * @param revealTs the playhead
 * @param drawSpanS timeline seconds to stretch the activity's draw across; 0 disables stretching
 */
export function isRevealed(
  mintTs: number,
  actStart: number,
  actEnd: number,
  revealTs: number,
  drawSpanS: number,
): boolean {
  if (!(drawSpanS > 0) || !Number.isFinite(revealTs)) return mintTs <= revealTs;
  const dur = actEnd - actStart;
  const frac = dur > 0 ? (mintTs - actStart) / dur : 0;
  return actStart + frac * drawSpanS <= revealTs;
}
